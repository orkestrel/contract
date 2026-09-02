import type { ContractShape, JSONSchema, LiteralValue } from './types.js'
import { INFER_BREADTH_LIMIT, INFER_DEPTH_LIMIT, INTRINSICS } from './constants.js'
import {
	admitMember,
	admitVisited,
	collectMembers,
	deriveLengthBounds,
	deriveRangeBounds,
	limitEntries,
	matchesMember,
	matchesRecordBrand,
	matchesVisited,
	omitVisited,
	retainDepth,
} from './helpers.js'
import { isArray, isFiniteNumber, isLiteralValue, isRecord, isString } from './validators.js'
import {
	arrayShape,
	booleanShape,
	integerShape,
	literalShape,
	nullShape,
	numberShape,
	oneOfShape,
	optionalShape,
	rawShape,
	stringShape,
	unionShape,
} from './shapers.js'

/**
 * Owns the state of one schema-inversion walk.
 *
 * @remarks
 * The engine behind `schemaToShape`, which is the only door that constructs it.
 * The walk's cycle set and its `(node, remaining depth)` memo are `#` fields
 * rather than parameters, so no caller can pre-populate either and change what
 * the conversion widens. Construction observes nothing; `shape` runs the whole
 * walk and every refusal it raises is published by that door under the door's
 * own name.
 *
 * The recursion is `#` private for the same reason it is bounded: it is the
 * class's defining spine, and its state has no meaning outside one call. The
 * collection constructors are captured while this module evaluates, so a caller
 * who replaces `globalThis.WeakSet` or `globalThis.WeakMap` before the door runs
 * cannot make construction throw a raw value out of a door documented to refuse
 * with a `ContractError`.
 *
 * The class is not published and no instance escapes its door, so its prototype
 * carries nothing a caller can reach and it needs no member pinning.
 */
export class SchemaShaper {
	// Captured while this module evaluates, exactly as the cloners capture theirs:
	// the constructor runs outside every containment this class has, so reaching
	// `globalThis` there would leave the door open one call earlier than any
	// boundary can see.
	static readonly #weakSet = WeakSet
	static readonly #weakMap = WeakMap
	readonly #source: JSONSchema
	readonly #visited: WeakSet<object>
	readonly #memo: WeakMap<object, Map<number, ContractShape>>

	constructor(schema: JSONSchema) {
		this.#source = schema
		this.#visited = new SchemaShaper.#weakSet()
		this.#memo = new SchemaShaper.#weakMap()
	}

	/**
	 * Converts the retained schema into a validating contract shape.
	 *
	 * @returns The built shape, widened wherever the schema is inexpressible
	 * @throws {ContractError} When schema traversal fails
	 */
	shape(): ContractShape {
		return this.#convert(this.#source, INFER_DEPTH_LIMIT)
	}

	// The per-node entry point the root and every child recursion share. Guards
	// depth exhaustion, a readable non-record node (the node's static `JSONSchema`
	// type is not trusted at runtime), and a cyclic re-encounter — all three widen
	// to `rawShape`. The ancestor set is added to and removed from around the
	// WHOLE subtree conversion, so a DAG-shaped schema reached twice through two
	// different noncyclic paths does not false-positive as a cycle. A same-node
	// re-conversion at the same remaining depth is served from the memo, which
	// guards a shared-reference schema DAG against exponential blowup.
	#convert(schema: JSONSchema, depth: number): ContractShape {
		if (!(depth > 0)) return rawShape({})
		if (!matchesRecordBrand(schema)) return rawShape({})
		if (matchesVisited(this.#visited, schema)) return rawShape({})
		// The memo read is dispatched through the captured `Map.prototype.get`
		// too: a substitute answering a decoy would put a shape this package
		// never built into one it publishes as its own.
		const depthMemo = INTRINSICS.reflect.apply(INTRINSICS.recall, this.#memo, [schema])
		const cached =
			depthMemo === undefined
				? undefined
				: INTRINSICS.reflect.apply(INTRINSICS.fetch, depthMemo, [depth])
		if (cached) return cached
		admitVisited(this.#visited, schema)
		try {
			const shape = this.#build(schema, depth)
			retainDepth(this.#memo, schema, depth, shape)
			return shape
		} finally {
			omitVisited(this.#visited, schema)
		}
	}

	// The per-keyword precedence switch. Every keyword is read defensively — the
	// node's static `JSONSchema` type is NOT trusted at runtime — so a malformed
	// keyword falls through to the next rule instead of throwing. Precedence,
	// top-down:
	//
	// 1. `enum` — an array with at least one string/number/boolean entry (finite
	//    numbers only) becomes a literal shape over the filtered entries.
	//    Non-primitive / non-finite entries are dropped; an empty result falls
	//    through.
	// 2. `oneOf` — an array with at least one record entry becomes a one-of shape
	//    over the recursively-built variants, provided the record-entry count is
	//    at or under `INFER_BREADTH_LIMIT`; OVER the limit, building a subset
	//    union would be strictly narrower than the schema's full union (a value
	//    matching only a dropped variant would be wrongly rejected), so the whole
	//    node widens to `rawShape` instead of sampling a subset.
	// 3. `anyOf` — identically, through `unionShape`.
	// 4. `type: 'string'` / `'number'` / `'integer'` / `'boolean'` / `'null'` —
	//    the matching primitive shape, with length/range bounds derived through
	//    `deriveLengthBounds` / `deriveRangeBounds`. An integer node additionally
	//    drops its bounds when they describe an EMPTY integer range (for example
	//    `minimum: 1.5, maximum: 1.6`) — the same emptiness `validateShape`
	//    rejects — so the result is always a valid shape.
	// 5. `type: 'array'` — an array shape whose element shape recurses into a
	//    record-valued `items`, widening to `rawShape` otherwise, with bounds from
	//    `minItems` / `maxItems`.
	// 6. `type: 'object'`, OR no `type` / `enum` / `oneOf` / `anyOf` but a
	//    record-valued `properties` — delegates to the object branch.
	// 7. Everything else — an empty schema, an unrecognized/absent `type`, or
	//    exhausted depth/breadth — widens to `rawShape`, whose guard accepts every
	//    defined value and whose emitted schema is the same `{}` (plus
	//    `description`) the node carried. That is the exact inverse of `{}`, JSON
	//    Schema's accept-anything schema, and where the inferers themselves bottom
	//    out at their own limits.
	//
	// `format` and `pattern` are NEVER read into the compiled shape — `format` is
	// annotation-only and compiling an attacker-supplied `pattern` into a `RegExp`
	// is a ReDoS vector. `description`, when a string, carries through to the
	// produced shape's `description` option.
	#build(schema: JSONSchema, depth: number): ContractShape {
		const description = isString(schema.description) ? schema.description : undefined

		if (isArray(schema.enum)) {
			const literals: LiteralValue[] = []
			// De-duplicated in the same pass that already drops non-literal and
			// non-finite entries, by the package's own SameValueZero membership.
			// `literalShape` refuses a repeated vocabulary, and that refusal was
			// republished as `schema could not be read` — a data defect reported as
			// unreadability, for a schema every keyword of which was read. JSON
			// Schema requires `enum` members to be unique, so a repeat is malformed
			// vocabulary, and this conversion's stated rule for malformed vocabulary
			// is to ignore it and widen, never to throw. First occurrence wins, so
			// the emitted order still follows the source.
			const seen = collectMembers([])
			for (let index = 0; index < schema.enum.length; index += 1) {
				const entry = schema.enum[index]
				if (isLiteralValue(entry) && (typeof entry !== 'number' || isFiniteNumber(entry))) {
					if (matchesMember(seen, entry)) continue
					admitMember(seen, entry)
					literals[literals.length] = entry
				}
			}
			if (literals.length > 0) {
				return literalShape(literals, description === undefined ? undefined : { description })
			}
		}

		if (isArray(schema.oneOf)) {
			const records: JSONSchema[] = []
			for (let index = 0; index < schema.oneOf.length; index += 1) {
				const entry = schema.oneOf[index]
				if (isRecord(entry)) records[records.length] = entry
			}
			if (records.length > INFER_BREADTH_LIMIT) {
				return rawShape(description === undefined ? {} : { description })
			}
			const variants: ContractShape[] = []
			for (let index = 0; index < records.length; index += 1) {
				const entry = records[index]
				if (entry === undefined) continue
				variants[variants.length] = this.#convert(entry, depth - 1)
			}
			// `Reflect.apply` reads its argument list by index, where a spread call
			// would dispatch through the caller-writable array iterator.
			if (variants.length > 0) return INTRINSICS.reflect.apply(oneOfShape, undefined, variants)
		}

		if (isArray(schema.anyOf)) {
			const records: JSONSchema[] = []
			for (let index = 0; index < schema.anyOf.length; index += 1) {
				const entry = schema.anyOf[index]
				if (isRecord(entry)) records[records.length] = entry
			}
			if (records.length > INFER_BREADTH_LIMIT) {
				return rawShape(description === undefined ? {} : { description })
			}
			const variants: ContractShape[] = []
			for (let index = 0; index < records.length; index += 1) {
				const entry = records[index]
				if (entry === undefined) continue
				variants[variants.length] = this.#convert(entry, depth - 1)
			}
			if (variants.length > 0) return INTRINSICS.reflect.apply(unionShape, undefined, variants)
		}

		const type = isString(schema.type) ? schema.type : undefined

		if (type === 'string') {
			const bounds = deriveLengthBounds(schema.minLength, schema.maxLength)
			return stringShape({
				...bounds,
				...(description === undefined ? {} : { description }),
			})
		}
		if (type === 'number') {
			const bounds = deriveRangeBounds(schema.minimum, schema.maximum)
			return numberShape({
				...bounds,
				...(description === undefined ? {} : { description }),
			})
		}
		if (type === 'integer') {
			const bounds = deriveRangeBounds(schema.minimum, schema.maximum)
			const emptyRange =
				INTRINSICS.ceil(bounds.min ?? Number.NEGATIVE_INFINITY) >
				INTRINSICS.floor(bounds.max ?? Number.POSITIVE_INFINITY)
			return integerShape(
				emptyRange
					? description === undefined
						? undefined
						: { description }
					: {
							...bounds,
							...(description === undefined ? {} : { description }),
						},
			)
		}
		if (type === 'boolean') {
			return booleanShape(description === undefined ? undefined : { description })
		}
		if (type === 'null') {
			return nullShape(description === undefined ? undefined : { description })
		}

		if (type === 'array') {
			const items = isRecord(schema.items) ? this.#convert(schema.items, depth - 1) : rawShape({})
			const bounds = deriveLengthBounds(schema.minItems, schema.maxItems)
			return arrayShape(items, {
				...bounds,
				...(description === undefined ? {} : { description }),
			})
		}

		if (type === 'object' || (type === undefined && isRecord(schema.properties))) {
			return this.#buildObject(schema, depth, description)
		}

		return rawShape(description === undefined ? {} : { description })
	}

	// The object-specialized branch. `properties` (when a record) contributes one
	// child shape per own key, capped at `INFER_BREADTH_LIMIT`; a key is wrapped
	// in `optionalShape` unless it appears as a string entry of `required`. A
	// property whose value is not itself a record widens to `rawShape`.
	// `additionalProperties`: `false` closes the object; a record value recurses
	// into it (`objectShape` validates extras against that shape); anything else —
	// `true`, absent, or malformed — leaves the object OPEN (`true`), matching
	// JSON Schema's own absent-means-open default and the fact that the inference
	// doors always emit the keyword explicitly, so an absent value only arises
	// from a hand-written schema. When `properties` has MORE keys than
	// `INFER_BREADTH_LIMIT`, the schema's own `additionalProperties` is OVERRIDDEN
	// and forced to `true` (fully open) — a dropped key's value could otherwise
	// fail a `false` or record-valued rest shape it was never checked against —
	// mirroring the record inference's partial-key handling. The accumulator uses
	// a null-prototype record so a property literally named `__proto__` becomes an
	// own data key rather than mutating the prototype.
	#buildObject(schema: JSONSchema, depth: number, description: string | undefined): ContractShape {
		const propertiesSource = isRecord(schema.properties) ? schema.properties : undefined
		// Indexed rather than `filter` / `includes`: this list decides which
		// properties the published shape marks required, and both are
		// caller-writable members.
		const requiredSource = collectMembers([])
		if (isArray(schema.required)) {
			for (let index = 0; index < schema.required.length; index += 1) {
				const entry = schema.required[index]
				if (isString(entry)) admitMember(requiredSource, entry)
			}
		}
		// Honest typing: a null-prototype accumulator so a property literally
		// named '__proto__' becomes an own data key instead of mutating the
		// prototype — the same pattern the record inference uses.
		const properties: Record<string, ContractShape> = INTRINSICS.create(null)
		let truncated = false
		if (propertiesSource) {
			const allKeys = INTRINSICS.keys(propertiesSource)
			truncated = allKeys.length > INFER_BREADTH_LIMIT
			const keys = limitEntries(allKeys, INFER_BREADTH_LIMIT)
			for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
				const key = keys[keyIndex]
				if (key === undefined) continue
				const child = propertiesSource[key]
				const childShape = isRecord(child) ? this.#convert(child, depth - 1) : rawShape({})
				properties[key] = matchesMember(requiredSource, key)
					? childShape
					: optionalShape(childShape)
			}
		}
		const extra = schema.additionalProperties
		const additionalProperties: boolean | ContractShape = truncated
			? true
			: extra === false
				? false
				: isRecord(extra)
					? this.#convert(extra, depth - 1)
					: true
		return INTRINSICS.freeze({
			type: 'object',
			properties: INTRINSICS.freeze(properties),
			additionalProperties,
			...(description === undefined ? {} : { description }),
		})
	}
}
