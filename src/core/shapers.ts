import type {
	ArrayShape,
	ArrayShapeOptions,
	BooleanShape,
	BooleanShapeOptions,
	ContractShape,
	JSONSchema,
	JSONShape,
	JSONShapeOptions,
	LiteralShape,
	LiteralShapeOptions,
	NullableShape,
	NullShape,
	NullShapeOptions,
	NumberShape,
	NumberShapeOptions,
	ObjectShape,
	ObjectShapeOptions,
	OptionalShape,
	RawShape,
	RecordShapeOptions,
	StringShape,
	StringShapeOptions,
	UnionShape,
} from './types.js'
import { INFER_BREADTH_LIMIT, INFER_DEPTH_LIMIT } from './constants.js'
import { attempt } from './helpers.js'
import { isArray, isBoolean, isFiniteNumber, isInteger, isRecord, isString } from './validators.js'

// The builders return the parameterized types.ts interfaces (e.g. `ArrayShape<S>`,
// `ObjectShape<P>`), never inline object literals — the generic parameter keeps
// `Infer<typeof shape>` exact while the return type still enforces conformance to
// the shared shape interface.

// Shape builders — pure constructors for the `ContractShape` union. Each returns
// a plain descriptor; the compilers (compilers.ts) turn it into a guard, parser,
// schema, and generator. The precise return types (e.g. literal tuples, generic
// `items` / `properties`) are preserved so `Infer<typeof shape>` stays exact.

// === Primitives

/**
 * Build a string {@link StringShape}.
 *
 * @param options - Optional length (`min` / `max`), `pattern`, and `description`
 * @returns A string shape
 *
 * @example
 * ```ts
 * const name = stringShape({ min: 1, max: 80, description: 'Display name' })
 * ```
 */
export function stringShape(options?: StringShapeOptions): StringShape {
	return {
		type: 'string',
		min: options?.min,
		max: options?.max,
		pattern: options?.pattern,
		description: options?.description,
	}
}

/**
 * Build a numeric {@link NumberShape}.
 *
 * @param options - Optional bounds (`min` / `max`), `integer`, and `description`
 * @returns A number shape
 *
 * @example
 * ```ts
 * const age = numberShape({ min: 0, max: 120 })
 * ```
 */
export function numberShape(options?: NumberShapeOptions): NumberShape {
	return {
		type: 'number',
		min: options?.min,
		max: options?.max,
		integer: options?.integer,
		description: options?.description,
	}
}

/**
 * Build an integer {@link NumberShape} — forces `integer: true`.
 *
 * @remarks
 * The emitted JSON Schema uses `"type": "integer"` and the guard rejects
 * fractional numbers.
 *
 * @param options - Optional bounds and `description` (no `integer` key)
 * @returns An integer number shape
 */
export function integerShape(options?: Omit<NumberShapeOptions, 'integer'>): NumberShape {
	return {
		type: 'number',
		integer: true,
		min: options?.min,
		max: options?.max,
		description: options?.description,
	}
}

/**
 * Build a {@link BooleanShape}.
 *
 * @param options - Optional `description`
 * @returns A boolean shape
 *
 * @example
 * ```ts
 * const active = booleanShape({ description: 'Whether the record is active' })
 * ```
 */
export function booleanShape(options?: BooleanShapeOptions): BooleanShape {
	return {
		type: 'boolean',
		description: options?.description,
	}
}

/**
 * Build a {@link NullShape}.
 *
 * @param options - Optional `description`
 * @returns A null shape
 *
 * @example
 * ```ts
 * const empty = nullShape()
 * ```
 */
export function nullShape(options?: NullShapeOptions): NullShape {
	return { type: 'null', description: options?.description }
}

/**
 * Build a literal shape from a fixed set of primitive values.
 *
 * @param values - The permitted literals
 * @param options - Optional `description`
 * @returns A literal shape whose `Infer` is the union of `values`
 *
 * @example
 * ```ts
 * const role = literalShape(['admin', 'member', 'guest'])
 * // Infer<typeof role> = 'admin' | 'member' | 'guest'
 *
 * const via = literalShape(['function', 'tool', 'agent'], { description: 'How to run the step.' })
 * ```
 */
export function literalShape<const T extends readonly (string | number | boolean)[]>(
	values: T,
	options?: LiteralShapeOptions,
): LiteralShape<T> {
	return { type: 'literal', values, description: options?.description }
}

// === Collections

/**
 * Build an {@link ArrayShape} from an element shape.
 *
 * @param items - The element shape
 * @param options - Optional length bounds and `description`
 * @returns An array shape
 *
 * @example
 * ```ts
 * const tags = arrayShape(stringShape(), { max: 10 })
 * ```
 */
export function arrayShape<S extends ContractShape>(
	items: S,
	options?: ArrayShapeOptions,
): ArrayShape<S> {
	return {
		type: 'array',
		items,
		min: options?.min,
		max: options?.max,
		description: options?.description,
	}
}

/**
 * Build an {@link ObjectShape} from a property map.
 *
 * @remarks
 * Wrap any property in {@link optionalShape} to allow its absence. By default
 * the compiled guard rejects unknown keys; pass `additionalProperties` to open
 * the object.
 *
 * @param properties - Map of property names to child shapes
 * @param options - Optional `additionalProperties` and `description`
 * @returns An object shape
 *
 * @example
 * ```ts
 * const user = objectShape({
 * 	name: stringShape({ min: 1 }),
 * 	age: integerShape({ min: 0, max: 120 }),
 * 	bio: optionalShape(stringShape()),
 * })
 * ```
 */
export function objectShape<
	P extends Readonly<Record<string, ContractShape>>,
	const A extends boolean | ContractShape = false,
>(properties: P, options?: ObjectShapeOptions<A>): ObjectShape<P, A> {
	return {
		type: 'object',
		properties,
		additionalProperties: options?.additionalProperties,
		description: options?.description,
	}
}

/**
 * Build an open {@link ObjectShape} with no fixed properties — a dictionary.
 *
 * @remarks
 * Every value is validated against `values`; keys are unconstrained. Equivalent
 * to `objectShape({}, { additionalProperties: values })`.
 *
 * @param values - The shape every value must match
 * @param options - Optional `description`
 * @returns An open object shape
 *
 * @example
 * ```ts
 * const bindings = recordShape(numberShape()) // ~ Record<string, number>
 * ```
 */
export function recordShape<S extends ContractShape>(
	values: S,
	options?: RecordShapeOptions,
): ObjectShape<Record<never, never>, S> {
	return {
		type: 'object',
		properties: {},
		additionalProperties: values,
		description: options?.description,
	}
}

// === Composition

/**
 * Build a {@link UnionShape} from a list of variant shapes (`anyOf` in JSON Schema).
 *
 * @param variants - The candidate shapes; the first match wins at runtime
 * @returns A union shape whose `Infer` is the union of the variants
 *
 * @example
 * ```ts
 * const id = unionShape(stringShape(), integerShape())
 * // Infer<typeof id> = string | number
 * ```
 */
export function unionShape<V extends readonly ContractShape[]>(...variants: V): UnionShape<V> {
	return { type: 'union', variants }
}

/**
 * Build a {@link UnionShape} that emits `oneOf` (exactly one match) in JSON Schema.
 *
 * @remarks
 * Unlike {@link unionShape} (`anyOf` — at least one variant matches),
 * `oneOfShape`'s compiled guard and parser enforce EXACTLY one match:
 *
 * - **Guard**: accepts the value only when exactly one variant's guard
 *   accepts it. A value matching two-or-more variants — which would violate
 *   the emitted `oneOf` schema — is rejected, even though it would pass
 *   {@link unionShape}'s guard.
 * - **Parser**: judged on the RAW input's guard matches only, with NO
 *   coercion fallback for an ambiguous input. When exactly one variant's
 *   guard accepts the raw value, that variant's parser runs. Zero matches or
 *   two-or-more matches both parse to `undefined` — a value ambiguous
 *   between variants has no well-defined coercion target.
 *
 * Prefer {@link unionShape} when a value may legitimately satisfy more than
 * one variant (e.g. overlapping shapes) and any match is acceptable. Prefer
 * `oneOfShape` when overlap between variants indicates malformed input that
 * must be rejected.
 *
 * @param variants - The candidate shapes
 * @returns A union shape with `mode: 'oneOf'`
 *
 * @example
 * ```ts
 * const id = oneOfShape(numberShape(), integerShape())
 * // 3   fails — matches both numberShape and integerShape
 * // 3.5 passes — matches numberShape only
 * ```
 */
export function oneOfShape<V extends readonly ContractShape[]>(...variants: V): UnionShape<V> {
	return { type: 'union', variants, mode: 'oneOf' }
}

/**
 * Wrap a shape so it may be absent (`undefined`).
 *
 * @remarks
 * As an {@link objectShape} property, the field becomes a true optional property
 * in the inferred type.
 *
 * @param inner - The wrapped shape
 * @returns An optional shape
 */
export function optionalShape<S extends ContractShape>(inner: S): OptionalShape<S> {
	return { type: 'optional', inner }
}

/**
 * Wrap a shape so it may be `null`.
 *
 * @param inner - The wrapped shape
 * @returns A nullable shape
 *
 * @example
 * ```ts
 * const bio = nullableShape(stringShape())
 * // Infer<typeof bio> = string | null
 * ```
 */
export function nullableShape<S extends ContractShape>(inner: S): NullableShape<S> {
	return { type: 'nullable', inner }
}

// === Escape hatch

/**
 * Build a {@link JSONShape}.
 *
 * @remarks
 * The sound counterpart of {@link rawShape}: `rawShape` embeds an arbitrary
 * schema fragment and accepts anything at runtime, while `jsonShape` validates
 * that a value is real JSON (via {@link isJSONValue}).
 *
 * @param options - Optional `description`
 * @returns A JSON passthrough shape
 *
 * @example
 * ```ts
 * const payload = jsonShape({ description: 'Arbitrary JSON payload' })
 * ```
 */
export function jsonShape(options?: JSONShapeOptions): JSONShape {
	return { type: 'json', description: options?.description }
}

/**
 * Build a {@link RawShape} from a JSON Schema fragment.
 *
 * @remarks
 * For values the shape DSL can't express. The compiled guard accepts any value;
 * the parser passes it through; the schema is emitted verbatim.
 *
 * @param schema - The JSON Schema fragment to embed
 * @returns A raw shape
 *
 * @example
 * ```ts
 * const custom = rawShape({ type: 'string', format: 'uuid' })
 * ```
 */
export function rawShape(schema: JSONSchema): RawShape {
	return { type: 'raw', schema }
}

// === Schema inversion

// schemaToShape walks an UNKNOWN, possibly adversarial runtime JSONSchema value
// (a hand-written schema, or one produced by valueToSchema / samplesToSchema)
// and emits a validating ContractShape — the reverse direction of
// compileSchema (compilers.ts), which walks a finite, developer-authored
// ContractShape tree and emits a JSONSchema. Recursion here is runtime-only
// and bounded on three axes, mirroring the inferers: a WeakSet of ancestor
// schema nodes (cycle safety), a decrementing depth budget (INFER_DEPTH_LIMIT
// default), and a per-container sampling cap (INFER_BREADTH_LIMIT) on
// properties/oneOf/anyOf entries — every branch stays total, per AGENTS §14.
// Every keyword read is type-guarded: a malformed keyword is IGNORED, falling
// through to the next rule, never thrown. `format` and `pattern` are NEVER
// asserted — `format` is annotation-only, and compiling an attacker-supplied
// `pattern` into a `RegExp` is a ReDoS vector — so neither keyword narrows the
// compiled guard; the returned shape is always one `validateShape` accepts.

/**
 * Derive `min`/`max` shape bounds from a pair of non-negative-integer JSON
 * Schema length keywords (`minLength`/`maxLength`, `minItems`/`maxItems`).
 *
 * @remarks
 * Total and pure. Either keyword is used only when it is a non-negative
 * integer (`isInteger` + `>= 0`); a malformed value (a string, a negative
 * number, `NaN`, `Infinity`, a fraction) is dropped as if absent. When both
 * bounds are present and `min` exceeds `max`, the PAIR is dropped entirely
 * (an unbounded shape is always a legal widening of a contradictory schema).
 *
 * @param min - The raw `minLength` / `minItems` keyword value
 * @param max - The raw `maxLength` / `maxItems` keyword value
 * @returns The derived `min` / `max` pair, either possibly `undefined`
 *
 * @example
 * ```ts
 * deriveLengthBounds(1, 10)     // { min: 1, max: 10 }
 * deriveLengthBounds(10, 1)     // {} — contradictory, dropped
 * deriveLengthBounds(-1, 10)    // { max: 10 } — negative min dropped
 * ```
 */
export function deriveLengthBounds(
	min: unknown,
	max: unknown,
): { readonly min?: number; readonly max?: number } {
	const lo = isInteger(min) && min >= 0 ? min : undefined
	const hi = isInteger(max) && max >= 0 ? max : undefined
	if (lo !== undefined && hi !== undefined && lo > hi) return {}
	return { min: lo, max: hi }
}

/**
 * Derive `min`/`max` shape bounds from a pair of finite-number JSON Schema
 * range keywords (`minimum`/`maximum`).
 *
 * @remarks
 * Total and pure. Either keyword is used only when it is a finite number
 * ({@link isFiniteNumber} — rejects `NaN` / `±Infinity` / non-numbers); when
 * both bounds are present and `min` exceeds `max`, the PAIR is dropped
 * entirely, the same contradiction rule {@link deriveLengthBounds} applies.
 *
 * @param min - The raw `minimum` keyword value
 * @param max - The raw `maximum` keyword value
 * @returns The derived `min` / `max` pair, either possibly `undefined`
 *
 * @example
 * ```ts
 * deriveRangeBounds(0, 120)   // { min: 0, max: 120 }
 * deriveRangeBounds(5, 1)     // {} — contradictory, dropped
 * ```
 */
export function deriveRangeBounds(
	min: unknown,
	max: unknown,
): { readonly min?: number; readonly max?: number } {
	const lo = isFiniteNumber(min) ? min : undefined
	const hi = isFiniteNumber(max) ? max : undefined
	if (lo !== undefined && hi !== undefined && lo > hi) return {}
	return { min: lo, max: hi }
}

/**
 * Build an {@link ObjectShape} from a JSON Schema object node's `properties` /
 * `required` / `additionalProperties` keywords — the object-specialized branch
 * of {@link buildShapeFromNode}.
 *
 * @remarks
 * `properties` (when a record) contributes one child shape per own key, capped
 * at {@link INFER_BREADTH_LIMIT}; a key is wrapped in {@link optionalShape}
 * unless it appears as a string entry of `required`. A property whose value is
 * not itself a record widens to {@link jsonShape}. `additionalProperties`:
 * `false` closes the object; a record value recurses into it (`objectShape`
 * validates extras against that shape); anything else — `true`, absent, or
 * malformed — leaves the object OPEN (`true`), matching JSON Schema's own
 * absent-means-open default and the fact that {@link valueToSchema} /
 * {@link samplesToSchema} always emit the keyword explicitly, so an absent
 * value only arises from a hand-written schema. When `properties` has MORE
 * keys than {@link INFER_BREADTH_LIMIT}, the schema's own
 * `additionalProperties` is OVERRIDDEN and forced to `true` (fully open) —
 * a dropped key's value could otherwise fail a `false` or record-valued rest
 * shape it was never checked against — mirroring `inferObject`'s
 * `truncated ? true : !closed` rule (inferers.ts:485). The accumulator uses a
 * null-prototype record so a property literally named `__proto__` becomes an
 * own data key rather than mutating the prototype, mirroring
 * {@link inferObject} (inferers.ts).
 *
 * @param schema - The object schema node
 * @param depth - Remaining descent budget passed to child properties
 * @param visited - The ancestor set guarding against cycles — recursion
 *   state owned by the {@link schemaToShape} entry point; passing a shared or
 *   pre-populated `WeakSet` changes cycle-detection behavior and is not
 *   supported usage
 * @param memo - A per-call `(schema node, remaining depth) → shape` cache —
 *   recursion state owned by the {@link schemaToShape} entry point; passing
 *   a shared or pre-populated `WeakMap` changes caching behavior and is not
 *   supported usage
 * @param description - The node's already-extracted `description`, if any
 * @returns The built object shape
 *
 * @example
 * ```ts
 * buildObjectShape(
 * 	{ type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
 * 	INFER_DEPTH_LIMIT,
 * 	new WeakSet(),
 * 	new WeakMap(),
 * 	undefined,
 * )
 * // objectShape({ id: integerShape() }, { additionalProperties: true })
 * ```
 */
export function buildObjectShape(
	schema: JSONSchema,
	depth: number,
	visited: WeakSet<object>,
	memo: WeakMap<object, Map<number, ContractShape>>,
	description: string | undefined,
): ContractShape {
	const propertiesSource = isRecord(schema.properties) ? schema.properties : undefined
	const requiredSource = isArray(schema.required)
		? schema.required.filter((entry): entry is string => isString(entry))
		: []
	// Honest typing: a null-prototype accumulator so a property literally
	// named '__proto__' becomes an own data key instead of mutating the
	// prototype — the same pattern inferObject uses (inferers.ts).
	const properties: Record<string, ContractShape> = Object.create(null)
	let truncated = false
	if (propertiesSource) {
		const allKeys = Object.keys(propertiesSource)
		truncated = allKeys.length > INFER_BREADTH_LIMIT
		const keys = allKeys.slice(0, INFER_BREADTH_LIMIT)
		for (const key of keys) {
			const child = propertiesSource[key]
			const childShape = isRecord(child)
				? schemaNodeToShape(child, depth - 1, visited, memo)
				: jsonShape()
			properties[key] = requiredSource.includes(key) ? childShape : optionalShape(childShape)
		}
	}
	const extra = schema.additionalProperties
	const additionalProperties: boolean | ContractShape = truncated
		? true
		: extra === false
			? false
			: isRecord(extra)
				? schemaNodeToShape(extra, depth - 1, visited, memo)
				: true
	return objectShape(properties, { additionalProperties, description })
}

/**
 * Build a {@link ContractShape} for one JSON Schema node — the recursive
 * spine of {@link schemaToShape}, shared with per-child recursion via
 * {@link schemaNodeToShape}.
 *
 * @remarks
 * Every keyword is read defensively (the node's static `JSONSchema` type is
 * NOT trusted at runtime — a caller-supplied node may be adversarial), so a
 * malformed keyword falls through to the next rule instead of throwing.
 * Precedence, top-down:
 *
 * 1. `enum` — an array with at least one string/number/boolean entry (finite
 *    numbers only) becomes a {@link literalShape} over the filtered entries.
 *    Non-primitive / non-finite entries are dropped; an empty result falls
 *    through.
 * 2. `oneOf` — an array with at least one record entry becomes an
 *    {@link oneOfShape} over the recursively-built variants, provided the
 *    record-entry count is at or under {@link INFER_BREADTH_LIMIT}; OVER the
 *    limit, building a subset union would be strictly narrower than the
 *    schema's full union (a value matching only a dropped variant would be
 *    wrongly rejected), so the whole node widens to {@link jsonShape} instead
 *    of sampling a subset.
 * 3. `anyOf` — identically, via {@link unionShape}.
 * 4. `type: 'string'` / `'number'` / `'integer'` / `'boolean'` / `'null'` —
 *    the matching primitive shape, with length/range bounds derived via
 *    {@link deriveLengthBounds} / {@link deriveRangeBounds}. An integer node
 *    additionally drops its bounds when they describe an EMPTY integer range
 *    (e.g. `minimum: 1.5, maximum: 1.6`) — the same emptiness `validateShape`
 *    rejects — so the result is always a valid shape.
 * 5. `type: 'array'` — an {@link arrayShape} whose element shape recurses into
 *    a record-valued `items` (widening to {@link jsonShape} otherwise), with
 *    bounds from `minItems` / `maxItems`.
 * 6. `type: 'object'`, OR no `type` / `enum` / `oneOf` / `anyOf` but a
 *    record-valued `properties` — delegates to {@link buildObjectShape}.
 * 7. Everything else — an empty schema, an unrecognized/absent `type`,
 *    exhausted depth/breadth, or an attempt failure — widens to
 *    {@link jsonShape} (the exact inverse of `compileSchema(jsonShape())`,
 *    and where the inferers themselves bottom out at their own limits).
 *
 * `format` and `pattern` are NEVER read into the compiled shape — `format` is
 * annotation-only and `pattern` compiling an attacker-supplied string into a
 * `RegExp` is a ReDoS vector. `description`, when a string, carries through to
 * the produced shape's `description` option.
 *
 * @param schema - The schema node to convert
 * @param depth - Remaining descent budget (0 halts recursion with `jsonShape()`)
 * @param visited - The ancestor set guarding against cycles — recursion
 *   state owned by the {@link schemaToShape} entry point; passing a shared or
 *   pre-populated `WeakSet` changes cycle-detection behavior and is not
 *   supported usage
 * @param memo - A per-call `(schema node, remaining depth) → shape` cache
 *               guarding against exponential re-conversion of a
 *               shared-reference schema DAG — recursion state owned by the
 *               {@link schemaToShape} entry point; passing a shared or
 *               pre-populated `WeakMap` changes caching behavior and is not
 *               supported usage
 * @returns The built shape for `schema`
 *
 * @example
 * ```ts
 * buildShapeFromNode({ type: 'string', minLength: 1 }, INFER_DEPTH_LIMIT, new WeakSet(), new WeakMap())
 * // stringShape({ min: 1 })
 * ```
 */
export function buildShapeFromNode(
	schema: JSONSchema,
	depth: number,
	visited: WeakSet<object>,
	memo: WeakMap<object, Map<number, ContractShape>>,
): ContractShape {
	const description = isString(schema.description) ? schema.description : undefined

	if (isArray(schema.enum)) {
		const literals = schema.enum.filter(
			(entry): entry is string | number | boolean =>
				isString(entry) || isFiniteNumber(entry) || isBoolean(entry),
		)
		if (literals.length > 0) return literalShape(literals, { description })
	}

	if (isArray(schema.oneOf)) {
		const records = schema.oneOf.filter((entry): entry is JSONSchema => isRecord(entry))
		if (records.length > INFER_BREADTH_LIMIT) return jsonShape({ description })
		const variants = records.map((entry) => schemaNodeToShape(entry, depth - 1, visited, memo))
		if (variants.length > 0) return oneOfShape(...variants)
	}

	if (isArray(schema.anyOf)) {
		const records = schema.anyOf.filter((entry): entry is JSONSchema => isRecord(entry))
		if (records.length > INFER_BREADTH_LIMIT) return jsonShape({ description })
		const variants = records.map((entry) => schemaNodeToShape(entry, depth - 1, visited, memo))
		if (variants.length > 0) return unionShape(...variants)
	}

	const type = isString(schema.type) ? schema.type : undefined

	if (type === 'string') {
		const bounds = deriveLengthBounds(schema.minLength, schema.maxLength)
		return stringShape({ min: bounds.min, max: bounds.max, description })
	}
	if (type === 'number') {
		const bounds = deriveRangeBounds(schema.minimum, schema.maximum)
		return numberShape({ min: bounds.min, max: bounds.max, description })
	}
	if (type === 'integer') {
		const bounds = deriveRangeBounds(schema.minimum, schema.maximum)
		const emptyRange =
			Math.ceil(bounds.min ?? Number.NEGATIVE_INFINITY) >
			Math.floor(bounds.max ?? Number.POSITIVE_INFINITY)
		return integerShape(
			emptyRange ? { description } : { min: bounds.min, max: bounds.max, description },
		)
	}
	if (type === 'boolean') return booleanShape({ description })
	if (type === 'null') return nullShape({ description })

	if (type === 'array') {
		const items = isRecord(schema.items)
			? schemaNodeToShape(schema.items, depth - 1, visited, memo)
			: jsonShape()
		const bounds = deriveLengthBounds(schema.minItems, schema.maxItems)
		return arrayShape(items, { min: bounds.min, max: bounds.max, description })
	}

	if (type === 'object' || (type === undefined && isRecord(schema.properties))) {
		return buildObjectShape(schema, depth, visited, memo, description)
	}

	return jsonShape({ description })
}

/**
 * Convert one JSON Schema node into a {@link ContractShape} — the recursion
 * entry point {@link schemaToShape} and {@link buildShapeFromNode} share for
 * every child (`items`, `properties` values, `additionalProperties`,
 * `oneOf` / `anyOf` variants).
 *
 * @remarks
 * Total: never throws. Guards depth exhaustion, a non-record node (the
 * node's static `JSONSchema` type is not trusted at runtime), and a cyclic
 * re-encounter of `schema` — all three widen to {@link jsonShape}. The
 * ancestor set is added to and removed from around the WHOLE subtree
 * conversion (not permanently), so a DAG-shaped schema reached twice via two
 * different, non-cyclic paths does not false-positive as a cycle. The
 * subtree conversion itself runs inside {@link attempt}, so a hostile
 * throwing getter/Proxy anywhere in `schema` cannot escape as a thrown error
 * — it degrades to {@link jsonShape} instead. A same-node re-conversion at
 * the same remaining `depth` is served from `memo` (guards a
 * shared-reference schema DAG against exponential blowup), mirroring
 * {@link inferObject} / {@link inferArray} (inferers.ts).
 *
 * @param schema - The schema node to convert
 * @param depth - Remaining descent budget
 * @param visited - The ancestor set guarding against cycles — recursion
 *   state owned by the {@link schemaToShape} entry point; passing a shared or
 *   pre-populated `WeakSet` changes cycle-detection behavior and is not
 *   supported usage
 * @param memo - A per-call `(schema node, remaining depth) → shape` cache —
 *   recursion state owned by the {@link schemaToShape} entry point; passing
 *   a shared or pre-populated `WeakMap` changes caching behavior and is not
 *   supported usage
 * @returns The built shape for `schema`, or {@link jsonShape} on any failure
 *
 * @example
 * ```ts
 * schemaNodeToShape({ type: 'boolean' }, INFER_DEPTH_LIMIT, new WeakSet(), new WeakMap())
 * // booleanShape()
 * ```
 */
export function schemaNodeToShape(
	schema: JSONSchema,
	depth: number,
	visited: WeakSet<object>,
	memo: WeakMap<object, Map<number, ContractShape>>,
): ContractShape {
	if (!(depth > 0) || !isRecord(schema) || visited.has(schema)) return jsonShape()
	const cached = memo.get(schema)?.get(depth)
	if (cached) return cached
	visited.add(schema)
	const outcome = attempt(() => buildShapeFromNode(schema, depth, visited, memo))
	visited.delete(schema)
	const shape = outcome.success ? outcome.value : jsonShape()
	let depths = memo.get(schema)
	if (!depths) {
		depths = new Map()
		memo.set(schema, depths)
	}
	depths.set(depth, shape)
	return shape
}

/**
 * Convert a runtime `JSONSchema` value into a validating {@link ContractShape}
 * — the inverse of {@link compileSchema}, and the validating sibling of
 * {@link rawShape} (which embeds a schema fragment WITHOUT validating it).
 *
 * @remarks
 * Total: NEVER throws, for any input — a malformed, cyclic, deeply-nested, or
 * outright hostile (throwing-getter Proxy) `schema` value all degrade to
 * {@link jsonShape} rather than escaping as an error, so
 * `createContract(schemaToShape(x))` is safe to call for any `x`. See
 * {@link buildShapeFromNode} for the exact per-keyword precedence.
 *
 * `format` and `pattern` are NEVER asserted by the compiled shape — `format`
 * is annotation-only (per the JSON Schema spec, it never narrows validation
 * on its own) and compiling an attacker-controlled `pattern` string into a
 * `RegExp` is a ReDoS vector; both keywords are read only far enough to be
 * ignored. Any node the walk cannot express — an empty `{}`, an
 * unrecognized `type`, a schema past {@link INFER_DEPTH_LIMIT} deep, or a
 * cyclic re-encounter — widens to {@link jsonShape} (accept any JSON), never
 * narrows: the round trip `compileGuard(schemaToShape(valueToSchema(v)))(v)`
 * holds for every `v`, with widening as the only source of looseness.
 *
 * @param schema - The JSON Schema value to convert
 * @returns The built {@link ContractShape}
 *
 * @example
 * ```ts
 * const schema = samplesToSchema([{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }])
 * const contract = createContract(schemaToShape(schema))
 * contract.parse({ id: 3, name: 'Alan' }) // { id: 3, name: 'Alan' }
 * contract.parse({ id: 'nope' })          // undefined
 * ```
 */
export function schemaToShape(schema: JSONSchema): ContractShape {
	return schemaNodeToShape(schema, INFER_DEPTH_LIMIT, new WeakSet(), new WeakMap())
}
