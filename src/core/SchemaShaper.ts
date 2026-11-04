import type {
	ContractShape,
	JSONSchema,
	JSONSchemaType,
	LiteralValue,
	OptionalShape,
} from './types.js'
import {
	COMPILE_NODE_LIMIT,
	INFER_BREADTH_LIMIT,
	INFER_DEPTH_LIMIT,
	INTRINSICS,
	JSON_SCHEMA_TYPES,
	STRICT_SCHEMA_KEYWORDS,
} from './constants.js'
import { ContractError } from './errors.js'
import {
	readIndexView,
	admitMember,
	admitVisited,
	collectMembers,
	deriveLengthBounds,
	deriveRangeBounds,
	isFailure,
	limitEntries,
	iterateIndices,
	matchesMember,
	matchesRecordBrand,
	matchesVisited,
	omitVisited,
	pathOf,
	readArrayEntries,
	retainDepth,
} from './helpers.js'
import {
	isArray,
	isBoolean,
	isFiniteNumber,
	isInteger,
	isJSONValue,
	isLiteralValue,
	isRecord,
	isString,
} from './validators.js'
import { parseEnumValues } from './parsers.js'
import { ContractCompiler } from './ContractCompiler.js'
import { ShapeValidator } from './ShapeValidator.js'
import {
	arrayShape,
	booleanShape,
	integerShape,
	literalShape,
	nullableShape,
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
 * own name. A strict walk refuses where a lenient one widens, through the one
 * `#widen` both share, and its per-node `#inspect` refuses every keyword the
 * lenient precedence would read past.
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
	readonly #strict: boolean
	readonly #visited: WeakSet<object>
	readonly #memo: WeakMap<object, Map<number, ContractShape>>
	// A second memo for the nodes reached below a union, because a default that fills
	// beside a union must drop inside one, so one node converts to two different shapes.
	readonly #enclosed: WeakMap<object, Map<number, ContractShape>>
	readonly #path: string[]
	// The steps that built a shape node, and whether a memo served a node twice, so a tree
	// too small to overflow the compile limit pays for no second count.
	#built: number
	#shared: boolean

	constructor(schema: JSONSchema, strict = false) {
		this.#source = schema
		this.#strict = strict
		this.#visited = new SchemaShaper.#weakSet()
		this.#memo = new SchemaShaper.#weakMap()
		this.#enclosed = new SchemaShaper.#weakMap()
		this.#path = []
		this.#built = 0
		this.#shared = false
	}

	/**
	 * Converts the retained schema into a validating contract shape.
	 *
	 * @returns The built shape, widened wherever a lenient schema is inexpressible
	 * @throws {ContractError} When schema traversal fails, or when a strict conversion refuses
	 */
	shape(): ContractShape {
		if (this.#strict && isRecord(this.#source) && INTRINSICS.own(this.#source, 'default')) {
			throw this.#refusal('a default needs an optional property to fill', 'default')
		}
		const shape = this.#convert(this.#source, INFER_DEPTH_LIMIT, false)
		return !this.#strict && this.#exceeds(shape) ? rawShape({}) : shape
	}

	// A lenient schema must always compile, so one past the compile limit widens whole. No
	// step builds more than nine shape nodes, so a sharing-free walk of a sixteenth of the
	// limit cannot overflow it and pays for no second count. A memo hit means the walk
	// built less than the shape expands into, so it always asks the validator.
	#exceeds(shape: ContractShape): boolean {
		if (!this.#shared && this.#built <= COMPILE_NODE_LIMIT / 16) return false
		const validator = new ShapeValidator(shape)
		validator.validate()
		return (validator.expansion ?? 0) > COMPILE_NODE_LIMIT
	}

	// The per-node entry point the root and every child recursion share. Guards
	// depth exhaustion, a readable non-record node (the node's static `JSONSchema`
	// type is not trusted at runtime), and a cyclic re-encounter — all three widen
	// to `rawShape`. The ancestor set is added to and removed from around the
	// WHOLE subtree conversion, so a DAG-shaped schema reached twice through two
	// different noncyclic paths does not false-positive as a cycle. A same-node
	// re-conversion at the same remaining depth is served from the memo, which
	// guards a shared-reference schema DAG against exponential blowup.
	#convert(schema: JSONSchema, depth: number, enclosed: boolean): ContractShape {
		if (!(depth > 0)) return this.#widen('a schema may not nest past the depth limit', undefined)
		if (!matchesRecordBrand(schema)) {
			return this.#widen('every schema node must be a plain record', undefined)
		}
		if (matchesVisited(this.#visited, schema)) {
			return this.#widen('a schema may not contain a cycle', undefined)
		}
		// The memo read is dispatched through the captured `Map.prototype.get`
		// too: a substitute answering a decoy would put a shape this package
		// never built into one it publishes as its own.
		const memo = enclosed ? this.#enclosed : this.#memo
		const depthMemo = INTRINSICS.reflect.apply(INTRINSICS.recall, memo, [schema])
		const cached =
			depthMemo === undefined
				? undefined
				: INTRINSICS.reflect.apply(INTRINSICS.fetch, depthMemo, [depth])
		if (cached) {
			this.#shared = true
			return cached
		}
		admitVisited(this.#visited, schema)
		try {
			if (this.#strict) this.#inspect(schema)
			const built = this.#build(schema, depth, enclosed)
			// Read here rather than in `#build`, which a type list re-enters per member. The
			// OpenAPI keyword stays out of `JSONSchema`, and a strict walk has refused it.
			const nullable = INTRINSICS.reflect.read(schema, 'nullable') === true
			const shape = nullable ? nullableShape(built) : built
			retainDepth(memo, schema, depth, shape)
			return shape
		} finally {
			omitVisited(this.#visited, schema)
		}
	}

	// One step down the schema, carrying the path a strict refusal names. Only a
	// property's optional wrapper can hold a default, so every other child refuses one.
	#descend(
		schema: JSONSchema,
		depth: number,
		enclosed: boolean,
		first: string,
		second?: string,
	): ContractShape {
		this.#path[this.#path.length] = first
		if (second !== undefined) this.#path[this.#path.length] = second
		if (
			this.#strict &&
			first !== 'properties' &&
			isRecord(schema) &&
			INTRINSICS.own(schema, 'default')
		) {
			throw this.#refusal('a default needs an optional property to fill', 'default')
		}
		const shape = this.#convert(schema, depth, enclosed)
		this.#path.length -= second === undefined ? 1 : 2
		return shape
	}

	// What the lenient walk widens, the strict walk refuses. The widening keeps the
	// node's description, as it always has.
	#widen(
		message: string,
		description: string | undefined,
		first?: string,
		second?: string,
	): ContractShape {
		if (this.#strict) throw this.#refusal(message, first, second)
		this.#built += 1
		return rawShape(description === undefined ? {} : { description })
	}

	// Sets a description on a shape that has a place for one, overriding its own: a keyword
	// beside a union describes the field, which outranks what one arm says of itself.
	#describe(shape: ContractShape, description: string | undefined): ContractShape {
		if (description === undefined) return shape
		switch (shape.category) {
			case 'optional':
				return shape
			case 'nullable':
				return nullableShape(this.#describe(shape.inner, description))
			case 'raw':
				return rawShape({ ...shape.schema, description })
			default:
				return INTRINSICS.freeze({ ...shape, description })
		}
	}

	#refusal(message: string, first?: string, second?: string, third?: string): ContractError {
		return new ContractError(`schemaToShape: ${message}`, {
			code: 'structure',
			context: { path: pathOf(this.#path, first, second, third), shape: 'schema' },
		})
	}

	// The per-node keyword check of a strict conversion. It refuses every keyword the
	// lenient walk would read past, so `#build` never drops an assertion: a malformed
	// value, a keyword outside the vocabulary, a keyword the node's type never reads,
	// and a pair of keywords only one of which the walk would keep.
	#inspect(schema: JSONSchema): void {
		const keys = INTRINSICS.keys(schema)
		for (const index of iterateIndices(() => keys.length)) {
			const key = keys[index]
			if (key === undefined) continue
			const known = INTRINSICS.reflect.apply(INTRINSICS.some, STRICT_SCHEMA_KEYWORDS, [
				(keyword: string) => keyword === key,
			])
			if (!known) throw this.#refusal('a strict conversion refuses a keyword it cannot honour', key)
		}
		this.#inspectAnnotations(schema)
		if (INTRINSICS.own(schema, 'default') && !isJSONValue(schema.default)) {
			throw this.#refusal('a default must be a JSON value', 'default')
		}
		const types = this.#inspectType(schema)
		this.#inspectForm(schema, types)
		const hasForm =
			INTRINSICS.own(schema, 'enum') ||
			INTRINSICS.own(schema, 'oneOf') ||
			INTRINSICS.own(schema, 'anyOf')
		const object = types.length === 0 && INTRINSICS.own(schema, 'properties') ? ['object'] : types
		const effective: readonly string[] = hasForm ? [] : object
		this.#confine(schema, ['minLength', 'maxLength'], this.#names(effective, 'string'))
		this.#confine(schema, ['minimum', 'maximum'], this.#names(effective, 'number', 'integer'))
		this.#confine(schema, ['items', 'minItems', 'maxItems'], this.#names(effective, 'array'))
		this.#confine(
			schema,
			['properties', 'required', 'additionalProperties'],
			this.#names(effective, 'object'),
		)
		this.#inspectLength(schema.minLength, schema.maxLength, 'minLength', 'maxLength')
		this.#inspectLength(schema.minItems, schema.maxItems, 'minItems', 'maxItems')
		this.#inspectRange(schema, this.#names(effective, 'integer'))
		this.#inspectObject(schema)
	}

	#inspectAnnotations(schema: JSONSchema): void {
		const texts = ['title', 'description', '$schema', '$id', '$comment']
		for (const index of iterateIndices(() => texts.length)) {
			const keyword = texts[index]
			if (keyword === undefined) continue
			const value: unknown = INTRINSICS.reflect.read(schema, keyword)
			if (value !== undefined && !isString(value)) {
				throw this.#refusal(`${keyword} must be a string`, keyword)
			}
		}
		const flags = ['deprecated', 'readOnly', 'writeOnly']
		for (const index of iterateIndices(() => flags.length)) {
			const keyword = flags[index]
			if (keyword === undefined) continue
			const value: unknown = INTRINSICS.reflect.read(schema, keyword)
			if (value !== undefined && !isBoolean(value)) {
				throw this.#refusal(`${keyword} must be a boolean`, keyword)
			}
		}
		const examples: unknown = INTRINSICS.reflect.read(schema, 'examples')
		if (examples !== undefined && !isArray(examples)) {
			throw this.#refusal('examples must be an array', 'examples')
		}
	}

	// The node's type names, an absent keyword reading as none.
	#inspectType(schema: JSONSchema): readonly string[] {
		const declared: unknown = schema.type
		if (declared === undefined) return []
		const names = isArray(declared) ? this.#entries(declared, 'type') : [declared]
		const known = names.length > 0 && this.#unique(names)
		const types: readonly string[] = INTRINSICS.reflect.apply(
			INTRINSICS.select,
			readIndexView(JSON_SCHEMA_TYPES),
			[
				(type: JSONSchemaType) =>
					INTRINSICS.reflect.apply(INTRINSICS.some, names, [(name: unknown) => name === type]),
			],
		)
		if (!known || types.length !== names.length) {
			throw this.#refusal('type must name the supported types', 'type')
		}
		return types
	}

	#inspectForm(schema: JSONSchema, types: readonly string[]): void {
		if (INTRINSICS.own(schema, 'enum')) {
			const members = this.#entries(schema.enum, 'enum')
			const malformed = INTRINSICS.reflect.apply(INTRINSICS.some, members, [
				(entry: unknown) =>
					!isLiteralValue(entry) || (typeof entry === 'number' && !isFiniteNumber(entry)),
			])
			if (members.length === 0 || malformed || !this.#unique(members)) {
				throw this.#refusal('enum must list unique finite primitives', 'enum')
			}
			const contradicted = INTRINSICS.reflect.apply(INTRINSICS.some, members, [
				(entry: unknown) => types.length > 0 && !this.#fits(entry, types),
			])
			if (contradicted) throw this.#refusal('an enum member contradicts the type', 'enum')
			if (INTRINSICS.own(schema, 'oneOf')) {
				throw this.#refusal('a strict conversion refuses oneOf beside enum', 'oneOf')
			}
			if (INTRINSICS.own(schema, 'anyOf')) {
				throw this.#refusal('a strict conversion refuses anyOf beside enum', 'anyOf')
			}
			return
		}
		const keywords = ['oneOf', 'anyOf']
		for (const index of iterateIndices(() => keywords.length)) {
			const keyword = keywords[index]
			if (keyword === undefined || !INTRINSICS.own(schema, keyword)) continue
			const variants = this.#entries(INTRINSICS.reflect.read(schema, keyword), keyword)
			if (variants.length === 0) throw this.#refusal(`${keyword} needs a variant`, keyword)
			for (const variantIndex of iterateIndices(() => variants.length)) {
				if (!isRecord(variants[variantIndex])) {
					throw this.#refusal(
						'every variant must be a schema',
						keyword,
						INTRINSICS.text(variantIndex),
					)
				}
			}
		}
		const union = INTRINSICS.own(schema, 'oneOf') || INTRINSICS.own(schema, 'anyOf')
		if (INTRINSICS.own(schema, 'oneOf') && INTRINSICS.own(schema, 'anyOf')) {
			throw this.#refusal('a strict conversion refuses anyOf beside oneOf', 'anyOf')
		}
		if (union && types.length > 0) {
			throw this.#refusal('a strict conversion refuses type beside a union', 'type')
		}
	}

	#inspectLength(min: unknown, max: unknown, minKey: string, maxKey: string): void {
		if (min !== undefined && !(INTRINSICS.safe(min) && INTRINSICS.numeric(min) >= 0)) {
			throw this.#refusal('a length bound must be a non-negative safe integer', minKey)
		}
		if (max !== undefined && !(INTRINSICS.safe(max) && INTRINSICS.numeric(max) >= 0)) {
			throw this.#refusal('a length bound must be a non-negative safe integer', maxKey)
		}
		if (isFiniteNumber(min) && isFiniteNumber(max) && min > max) {
			throw this.#refusal('a length range may not be contradictory', minKey)
		}
	}

	#inspectRange(schema: JSONSchema, integer: boolean): void {
		const min: unknown = schema.minimum
		const max: unknown = schema.maximum
		if (min !== undefined && !isFiniteNumber(min)) {
			throw this.#refusal('a range bound must be a finite number', 'minimum')
		}
		if (max !== undefined && !isFiniteNumber(max)) {
			throw this.#refusal('a range bound must be a finite number', 'maximum')
		}
		if (isFiniteNumber(min) && isFiniteNumber(max)) {
			if (min > max) throw this.#refusal('a range may not be contradictory', 'minimum')
			if (integer && INTRINSICS.ceil(min) > INTRINSICS.floor(max)) {
				throw this.#refusal('an integer range may not be empty', 'minimum')
			}
		}
	}

	#inspectObject(schema: JSONSchema): void {
		const properties: unknown = schema.properties
		if (properties !== undefined && !isRecord(properties)) {
			throw this.#refusal('properties must be a plain record', 'properties')
		}
		const extra: unknown = schema.additionalProperties
		if (extra !== undefined && !isBoolean(extra) && !isRecord(extra)) {
			throw this.#refusal(
				'additionalProperties must be a boolean or a schema',
				'additionalProperties',
			)
		}
		if (!INTRINSICS.own(schema, 'required')) return
		const names = this.#entries(schema.required, 'required')
		const undeclared = INTRINSICS.reflect.apply(INTRINSICS.some, names, [
			(name: unknown) =>
				!isString(name) || !isRecord(properties) || !INTRINSICS.own(properties, name),
		])
		if (undeclared || !this.#unique(names)) {
			throw this.#refusal('required must list unique declared properties', 'required')
		}
	}

	#confine(schema: JSONSchema, keywords: readonly string[], applies: boolean): void {
		if (applies) return
		for (const index of iterateIndices(() => keywords.length)) {
			const keyword = keywords[index]
			if (keyword !== undefined && INTRINSICS.own(schema, keyword)) {
				throw this.#refusal('a strict conversion refuses a keyword this node never reads', keyword)
			}
		}
	}

	#names(types: readonly string[], ...names: readonly string[]): boolean {
		return INTRINSICS.reflect.apply(INTRINSICS.some, types, [
			(type: string) =>
				INTRINSICS.reflect.apply(INTRINSICS.some, names, [(name: string) => name === type]),
		])
	}

	#fits(entry: unknown, types: readonly string[]): boolean {
		if (isString(entry)) return this.#names(types, 'string')
		if (isBoolean(entry)) return this.#names(types, 'boolean')
		return isInteger(entry) ? this.#names(types, 'number', 'integer') : this.#names(types, 'number')
	}

	#entries(value: unknown, keyword: string): readonly unknown[] {
		if (!isArray(value)) throw this.#refusal(`${keyword} must be an array`, keyword)
		const snapshot = readArrayEntries(value)
		if (isFailure(snapshot)) throw snapshot.error
		if (!snapshot.value.dense) throw this.#refusal(`${keyword} must be a dense array`, keyword)
		return snapshot.value.entries
	}

	#unique(entries: readonly unknown[]): boolean {
		const seen = collectMembers([])
		for (const index of iterateIndices(() => entries.length)) {
			const entry = entries[index]
			if (matchesMember(seen, entry)) return false
			admitMember(seen, entry)
		}
		return true
	}

	// The per-keyword precedence switch. Every keyword is read defensively — the
	// node's static `JSONSchema` type is NOT trusted at runtime — so a malformed
	// keyword falls through to the next rule instead of throwing. Precedence,
	// top-down:
	//
	// 1. `enum` — finite string/number/boolean entries become a literal shape, a
	//    `null` entry wraps it in a nullable, and `null` alone becomes a null shape.
	//    Any other entry widens the node, because dropping it would narrow. An empty
	//    list falls through.
	// 2. `oneOf` — an array with at least one arm becomes a union over the
	//    recursively-built arms, provided the arm count is at or under
	//    `INFER_BREADTH_LIMIT`; OVER the limit, building a subset union would be
	//    strictly narrower than the schema's full union (a value matching only a
	//    dropped variant would be wrongly rejected), so the whole node widens to
	//    `rawShape` instead of sampling a subset. The union is inclusive, because a
	//    keyword this walk does not read can make two arms overlap that the schema
	//    keeps apart, and exactly-one over those arms refuses a value the schema
	//    accepts. A strict walk reads every keyword, so it keeps exactly-one.
	// 3. `anyOf` — identically. In both, a `true` arm admits anything and a `false`
	//    arm admits nothing, so `true` is a raw variant in declaration order and
	//    `false` is dropped; a list its `false` arms leave empty widens. Two arms, one
	//    of them `{ type: 'null' }`, read as a nullable of the other, which stays
	//    outside a union, except under a strict `oneOf`. A description carries.
	// 4. Array-valued `type` — distinct recognized names become an inclusive
	//    union, or a single shape for one name. Two names, one of them `null`, read
	//    as a nullable of the other, in both modes: the list means what the `anyOf`
	//    spelling means, and it has no exactly-one to keep. An empty list or any
	//    unrecognized member widens the whole node; dropping a member would narrow it.
	// 5. `type: 'string'` / `'number'` / `'integer'` / `'boolean'` / `'null'` —
	//    the matching primitive shape, with length/range bounds derived through
	//    `deriveLengthBounds` / `deriveRangeBounds`. An integer node additionally
	//    drops its bounds when they describe an EMPTY integer range (for example
	//    `minimum: 1.5, maximum: 1.6`) — the same emptiness `validateShape`
	//    rejects — so the result is always a valid shape.
	// 6. `type: 'array'` — an array shape whose element shape recurses into a
	//    record-valued `items`, widening to `rawShape` otherwise, with bounds from
	//    `minItems` / `maxItems`. A present `prefixItems` widens the elements too,
	//    because `items` then applies only past the prefix.
	// 7. `type: 'object'` — delegates to the object branch. No `type` / `enum` /
	//    `oneOf` / `anyOf` but a record-valued `properties` — `properties` and
	//    `required` constrain only an object, so a lenient walk builds a union of
	//    that object first, for field validation, and every other JSON type. A strict
	//    walk reads it as an object.
	// 8. Everything else — an empty schema, an unrecognized/absent `type`, or
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
	#build(schema: JSONSchema, depth: number, enclosed: boolean): ContractShape {
		this.#built += 1
		const description = isString(schema.description) ? schema.description : undefined

		if (isArray(schema.enum)) {
			const observed = INTRINSICS.from(
				iterateIndices(
					() =>
						INTRINSICS.reflect.apply(INTRINSICS.reflect.read, undefined, [schema, 'enum']).length,
				),
				(index) =>
					INTRINSICS.reflect.apply(INTRINSICS.reflect.read, undefined, [schema, 'enum'])[index],
			)
			const widened = INTRINSICS.reflect.apply(INTRINSICS.some, observed, [
				(entry: unknown) =>
					entry !== null &&
					(!isLiteralValue(entry) || (typeof entry === 'number' && !isFiniteNumber(entry))),
			])
			if (widened) return this.#widen('an enum entry has no literal form', description, 'enum')
			const valid: readonly LiteralValue[] = INTRINSICS.reflect.apply(
				INTRINSICS.select,
				readIndexView(observed),
				[(entry: unknown) => entry !== null],
			)
			const nullable = valid.length < observed.length
			const pairs = INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(valid), [
				(entry: LiteralValue, index: number) => [
					`${typeof entry}:${INTRINSICS.text(entry)}`,
					index,
				],
			])
			const reversed = INTRINSICS.reflect.apply(INTRINSICS.flip, pairs, [])
			const first = INTRINSICS.record<number>({
				[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [
					reversed,
				]),
			})
			const literals: readonly LiteralValue[] = INTRINSICS.reflect.apply(
				INTRINSICS.select,
				readIndexView(valid),
				[
					(entry: LiteralValue, index: number) =>
						first[`${typeof entry}:${INTRINSICS.text(entry)}`] === index,
				],
			)
			if (literals.length > 0) {
				const literal = literalShape(
					literals,
					description === undefined ? undefined : { description },
				)
				return nullable ? nullableShape(literal) : literal
			}
			if (nullable) return nullShape(description === undefined ? undefined : { description })
		}

		if (isArray(schema.oneOf)) {
			const union = this.#buildUnion(schema.oneOf, 'oneOf', depth, description, enclosed)
			if (union !== undefined) return union
		}

		if (isArray(schema.anyOf)) {
			const union = this.#buildUnion(schema.anyOf, 'anyOf', depth, description, enclosed)
			if (union !== undefined) return union
		}

		const category = schema.type
		if (isArray(category)) {
			const observed = INTRINSICS.from(parseEnumValues(category, JSON_SCHEMA_TYPES))
			if (
				INTRINSICS.reflect.apply(INTRINSICS.some, observed, [
					(entry: JSONSchemaType | undefined) => entry === undefined,
				])
			) {
				return this.#widen('type must name the supported types', description, 'type')
			}
			const members: readonly JSONSchemaType[] = INTRINSICS.reflect.apply(
				INTRINSICS.select,
				readIndexView(observed),
				[
					(member: JSONSchemaType, index: number) =>
						INTRINSICS.reflect.apply(INTRINSICS.find, observed, [
							(entry: unknown) => entry === member,
						]) === index,
				],
			)
			if (members.length === 0 || members.length > INFER_BREADTH_LIMIT) {
				return this.#widen('type must name the supported types', description, 'type')
			}
			const others: readonly JSONSchemaType[] = INTRINSICS.reflect.apply(
				INTRINSICS.select,
				readIndexView(members),
				[(member: JSONSchemaType) => member !== 'null'],
			)
			const other = others[0]
			if (members.length === 2 && others.length === 1 && other !== undefined) {
				return nullableShape(this.#build({ ...schema, type: other }, depth, enclosed))
			}
			const variants: readonly ContractShape[] = INTRINSICS.reflect.apply(
				INTRINSICS.project,
				readIndexView(members),
				[
					(member: JSONSchemaType) =>
						this.#build({ ...schema, type: member }, depth, enclosed || members.length > 1),
				],
			)
			const first = variants[0]
			if (variants.length === 1 && first !== undefined) return first
			const union = INTRINSICS.reflect.apply(unionShape, undefined, variants)
			return description === undefined ? union : INTRINSICS.freeze({ ...union, description })
		}

		const type = isString(category) ? schema.type : undefined

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
			const items = INTRINSICS.own(schema, 'prefixItems')
				? rawShape({})
				: isRecord(schema.items)
					? this.#descend(schema.items, depth - 1, enclosed, 'items')
					: this.#widen('an array needs an items schema', undefined, 'items')
			const bounds = deriveLengthBounds(schema.minItems, schema.maxItems)
			return arrayShape(items, {
				...bounds,
				...(description === undefined ? {} : { description }),
			})
		}

		if (type === 'object' || (this.#strict && type === undefined && isRecord(schema.properties))) {
			return this.#buildObject(schema, depth, description, enclosed)
		}
		if (type === undefined && isRecord(schema.properties)) {
			return this.#describe(
				unionShape(
					this.#buildObject(schema, depth, undefined, true),
					stringShape(),
					numberShape(),
					booleanShape(),
					nullShape(),
					arrayShape(rawShape({})),
				),
				description,
			)
		}

		return this.#widen('a schema must name a type, an enum, or a union', description)
	}

	// One union keyword's arms, in declaration order. Answers `undefined` for a list
	// with no arm and no `false` entry, so a malformed keyword falls through.
	#buildUnion(
		list: readonly unknown[],
		keyword: 'oneOf' | 'anyOf',
		depth: number,
		description: string | undefined,
		enclosed: boolean,
	): ContractShape | undefined {
		const observed = INTRINSICS.from(
			iterateIndices(() => list.length),
			(index) => list[index],
		)
		const arms: ReadonlyArray<JSONSchema | true> = INTRINSICS.reflect.apply(
			INTRINSICS.select,
			readIndexView(observed),
			[(entry: unknown) => entry === true || isRecord(entry)],
		)
		if (arms.length > INFER_BREADTH_LIMIT) {
			return this.#widen(`${keyword} exceeds the breadth limit`, description, keyword)
		}
		const nulls: ReadonlyArray<JSONSchema | true> = INTRINSICS.reflect.apply(
			INTRINSICS.select,
			readIndexView(arms),
			[
				(entry: JSONSchema | true) =>
					entry !== true &&
					entry.type === 'null' &&
					!INTRINSICS.own(entry, 'enum') &&
					!INTRINSICS.own(entry, 'oneOf') &&
					!INTRINSICS.own(entry, 'anyOf'),
			],
		)
		const hasTrue = INTRINSICS.reflect.apply(INTRINSICS.some, arms, [
			(entry: JSONSchema | true) => entry === true,
		])
		const paired =
			arms.length === 2 && nulls.length === 1 && !hasTrue && !(this.#strict && keyword === 'oneOf')
		const variants: readonly ContractShape[] = INTRINSICS.reflect.apply(
			INTRINSICS.project,
			readIndexView(arms),
			[
				(entry: JSONSchema | true, index: number) => {
					if (entry !== true) {
						const position = paired ? enclosed : true
						return this.#descend(entry, depth - 1, position, keyword, INTRINSICS.text(index))
					}
					this.#built += 1
					return rawShape({})
				},
			],
		)
		const other = variants[arms[0] === nulls[0] ? 1 : 0]
		if (paired && other !== undefined) {
			return nullableShape(this.#describe(other, description))
		}
		// `Reflect.apply` reads its argument list by index, where a spread call
		// would dispatch through the caller-writable array iterator.
		if (variants.length > 0) {
			const build = this.#strict && keyword === 'oneOf' ? oneOfShape : unionShape
			return this.#describe(INTRINSICS.reflect.apply(build, undefined, variants), description)
		}
		const dropped = INTRINSICS.reflect.apply(INTRINSICS.some, observed, [
			(entry: unknown) => entry === false,
		])
		return dropped ? this.#widen(`${keyword} admits nothing`, description, keyword) : undefined
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
	// own data key rather than mutating the prototype. A present `patternProperties`
	// or `propertyNames` opens the object whatever its own `additionalProperties` says,
	// because a key that keyword admits is unread here. A strict conversion refuses
	// the truncation and closes an object whose schema is silent.
	#buildObject(
		schema: JSONSchema,
		depth: number,
		description: string | undefined,
		enclosed: boolean,
	): ContractShape {
		const propertiesSource = isRecord(schema.properties) ? schema.properties : undefined
		const requiredSource = isArray(schema.required)
			? INTRINSICS.from(
					iterateIndices(
						() =>
							INTRINSICS.reflect.apply(INTRINSICS.reflect.read, undefined, [schema, 'required'])
								.length,
					),
					(index) =>
						INTRINSICS.reflect.apply(INTRINSICS.reflect.read, undefined, [schema, 'required'])[
							index
						],
				)
			: []
		const allKeys = propertiesSource === undefined ? [] : INTRINSICS.keys(propertiesSource)
		const truncated = allKeys.length > INFER_BREADTH_LIMIT
		if (this.#strict && truncated) {
			throw this.#refusal('properties exceeds the breadth limit', 'properties')
		}
		const keys = limitEntries(allKeys, INFER_BREADTH_LIMIT)
		const extra = schema.additionalProperties
		const unread =
			truncated ||
			INTRINSICS.own(schema, 'patternProperties') ||
			INTRINSICS.own(schema, 'propertyNames')
		const open = unread || (extra !== false && (!this.#strict || extra !== undefined))
		const pairs = INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(keys), [
			(key: string) => {
				const child = propertiesSource?.[key]
				const childShape = isRecord(child)
					? this.#descend(child, depth - 1, enclosed, 'properties', key)
					: this.#widen(
							'every property schema must be a plain record',
							undefined,
							'properties',
							key,
						)
				const required = INTRINSICS.reflect.apply(INTRINSICS.some, requiredSource, [
					(entry: unknown) => isString(entry) && entry === key,
				])
				if (!required) return [key, this.#wrap(key, child, childShape, open || enclosed)]
				if (this.#strict && isRecord(child) && INTRINSICS.own(child, 'default')) {
					throw this.#refusal(
						'a default needs an optional property to fill',
						'properties',
						key,
						'default',
					)
				}
				return [key, childShape]
			},
		])
		const properties = INTRINSICS.rebase(
			INTRINSICS.record<ContractShape>({
				[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [pairs]),
			}),
			null,
		)
		const additionalProperties: boolean | ContractShape = unread
			? true
			: isRecord(extra)
				? this.#descend(extra, depth - 1, enclosed, 'additionalProperties')
				: open
		return INTRINSICS.freeze({
			category: 'object',
			properties: INTRINSICS.freeze(properties),
			additionalProperties,
			...(description === undefined ? {} : { description }),
		})
	}

	// The one place a schema's `default` becomes a shape's. The lenient walk stays total
	// by carrying only what can compile: a primitive or literal the property's guard
	// accepts, in a slot that can fill. The strict walk carries any default, and refuses
	// one the guard refuses or a slot that cannot fill, naming the path in the schema.
	#wrap(
		key: string,
		child: JSONSchema | undefined,
		shape: ContractShape,
		sealed: boolean,
	): OptionalShape {
		this.#built += 1
		if (!isRecord(child) || !INTRINSICS.own(child, 'default')) return optionalShape(shape)
		const value = child.default
		if (!isJSONValue(value)) return optionalShape(shape)
		if (this.#strict) {
			if (sealed) {
				throw new ContractError(
					'schemaToShape: a default cannot fill under a union or on a property of an open object; close the object or remove the default',
					{
						code: 'placement',
						context: { path: pathOf(this.#path, 'properties', key, 'default'), shape: 'schema' },
					},
				)
			}
			if (new ContractCompiler(shape).guard(value)) return optionalShape(shape, { default: value })
			throw this.#refusal('a default must satisfy its schema', 'properties', key, 'default')
		}
		const leaf =
			shape.category === 'string' ||
			shape.category === 'number' ||
			shape.category === 'boolean' ||
			shape.category === 'null' ||
			shape.category === 'literal'
		return !sealed && leaf && new ContractCompiler(shape).guard(value)
			? optionalShape(shape, { default: value })
			: optionalShape(shape)
	}
}
