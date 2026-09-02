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
	LiteralValue,
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
import { cloneSchema, cloneShape } from './cloners.js'
import { SchemaShaper } from './SchemaShaper.js'
import { ShapeValidator } from './ShapeValidator.js'
import { INTRINSICS } from './constants.js'
import { ContractError } from './errors.js'
import {
	attempt,
	contain,
	matchesRecordBrand,
	preview,
	readArrayEntries,
	readOptions,
	readPatternFlags,
	readPatternSource,
	readValue,
} from './helpers.js'
import { isLiteralValue, isObject, isRegExp } from './validators.js'

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
 * Builds a string {@link StringShape}.
 *
 * @remarks
 * A supplied pattern is captured by source and flags. The shape exposes a fresh
 * frozen zero-state `RegExp` on every `pattern` read, so neither the caller's
 * original nor a value read from the shape can drift later compiled artifacts.
 *
 * @param options - Optional length (`min` / `max`), `pattern`, and `description`
 * @returns A string shape
 * @throws {ContractError} When a present bound is invalid, `pattern` is not a `RegExp`, or `pattern` has flags
 *
 * @example
 * ```ts
 * const name = stringShape({ min: 1, max: 80, description: 'Display name' })
 * ```
 */
export function stringShape(options?: StringShapeOptions): StringShape {
	return contain(() => {
		const safe = readOptions(
			options,
			['min', 'max', 'pattern', 'description'],
			'stringShape',
			'string',
		)
		const pattern = safe?.pattern
		if (safe?.min !== undefined && (!INTRINSICS.safe(safe.min) || safe.min < 0)) {
			throw new ContractError('stringShape: min must be a non-negative safe integer', {
				code: 'bound',
				context: {
					shape: 'string',
					limit: 'non-negative safe integer',
					received: preview(safe.min),
				},
			})
		}
		if (safe?.max !== undefined && (!INTRINSICS.safe(safe.max) || safe.max < 0)) {
			throw new ContractError('stringShape: max must be a non-negative safe integer', {
				code: 'bound',
				context: {
					shape: 'string',
					limit: 'non-negative safe integer',
					received: preview(safe.max),
				},
			})
		}
		if (pattern !== undefined && !isRegExp(pattern)) {
			throw new ContractError('stringShape: pattern must be a RegExp', {
				code: 'pattern',
				context: { shape: 'string', received: typeof pattern },
			})
		}
		const patternSnapshot =
			pattern === undefined
				? undefined
				: readValue(
						() => {
							// Source and flags through the CAPTURED accessors, and the
							// rendered text built from them rather than through
							// `RegExp.prototype.toString`: all three are caller-writable
							// members, and this snapshot decides both the pattern a published
							// shape carries and the text a refusal quotes back.
							const source = readPatternSource(pattern)
							const flags = readPatternFlags(pattern)
							if (source === undefined || flags === undefined) {
								throw new INTRINSICS.error('Pattern source and flags could not be read')
							}
							return { source, flags, text: `/${source}/${flags}` }
						},
						'stringShape',
						{ subject: 'pattern', code: 'pattern', context: { shape: 'string' } },
					)
		if (patternSnapshot !== undefined && patternSnapshot.flags.length > 0) {
			throw new ContractError(
				'stringShape: pattern must not use flags; use inline pattern constructs instead',
				{
					code: 'pattern',
					context: { shape: 'string', received: patternSnapshot.text },
				},
			)
		}
		const shape: StringShape = {
			type: 'string',
			...(safe?.min === undefined ? {} : { min: safe.min }),
			...(safe?.max === undefined ? {} : { max: safe.max }),
			...(patternSnapshot === undefined
				? {}
				: { pattern: new INTRINSICS.pattern(patternSnapshot.source) }),
			...(safe?.description === undefined ? {} : { description: safe.description }),
		}
		new ShapeValidator(shape).validate()
		return cloneShape(shape)
	}, 'stringShape')
}

/**
 * Builds a numeric {@link NumberShape}.
 *
 * @param options - Optional bounds (`min` / `max`), `integer`, and `description`
 * @returns A number shape
 * @throws {ContractError} When a present bound is not finite
 *
 * @example
 * ```ts
 * const age = numberShape({ min: 0, max: 120 })
 * ```
 */
export function numberShape(options?: NumberShapeOptions): NumberShape {
	return contain(() => {
		const safe = readOptions(
			options,
			['min', 'max', 'integer', 'description'],
			'numberShape',
			'number',
		)
		const shape = safe?.integer === true ? 'integer' : 'number'
		if (safe?.min !== undefined && !INTRINSICS.finite(safe.min)) {
			throw new ContractError('numberShape: min must be finite', {
				code: 'bound',
				context: { shape, limit: 'finite number', received: preview(safe.min) },
			})
		}
		if (safe?.max !== undefined && !INTRINSICS.finite(safe.max)) {
			throw new ContractError('numberShape: max must be finite', {
				code: 'bound',
				context: { shape, limit: 'finite number', received: preview(safe.max) },
			})
		}
		const result: NumberShape = {
			type: 'number',
			...(safe?.min === undefined ? {} : { min: safe.min }),
			...(safe?.max === undefined ? {} : { max: safe.max }),
			...(safe?.integer === undefined ? {} : { integer: safe.integer }),
			...(safe?.description === undefined ? {} : { description: safe.description }),
		}
		new ShapeValidator(result).validate()
		return INTRINSICS.freeze(result)
	}, 'numberShape')
}

/**
 * Builds an integer {@link NumberShape} — forces `integer: true`.
 *
 * @remarks
 * The emitted JSON Schema uses `"type": "integer"` and the guard rejects
 * fractional numbers.
 *
 * @param options - Optional bounds and `description` (no `integer` key)
 * @returns An integer number shape
 * @throws {ContractError} When a present bound is not finite
 */
export function integerShape(options?: Omit<NumberShapeOptions, 'integer'>): NumberShape {
	return contain(() => {
		const safe = readOptions(options, ['min', 'max', 'description'], 'integerShape', 'integer')
		return numberShape({ ...safe, integer: true })
	}, 'integerShape')
}

/**
 * Builds a {@link BooleanShape}.
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
	return contain(() => {
		const safe = readOptions(options, ['description'], 'booleanShape', 'boolean')
		const shape: BooleanShape = {
			type: 'boolean',
			...(safe?.description === undefined ? {} : { description: safe.description }),
		}
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze(shape)
	}, 'booleanShape')
}

/**
 * Builds a {@link NullShape}.
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
	return contain(() => {
		const safe = readOptions(options, ['description'], 'nullShape', 'null')
		const shape: NullShape = {
			type: 'null',
			...(safe?.description === undefined ? {} : { description: safe.description }),
		}
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze(shape)
	}, 'nullShape')
}

/**
 * Builds a literal shape from a fixed set of primitive values.
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
export function literalShape<const T extends readonly LiteralValue[]>(
	values: T,
	options?: LiteralShapeOptions,
): LiteralShape<Readonly<T>>
export function literalShape(
	values: readonly LiteralValue[],
	options?: LiteralShapeOptions,
): LiteralShape {
	return contain(() => {
		const input: unknown = values
		const array = attempt(() => INTRINSICS.array(input))
		if (!array.success || !array.value) {
			throw new ContractError('literalShape: values must be an array', {
				code: 'structure',
				context: { path: ['values'], shape: 'literal' },
				...(!array.success ? { cause: array.error } : {}),
			})
		}
		const safe = readOptions(options, ['description'], 'literalShape', 'literal')
		const snapshot = readArrayEntries(values)
		if (!snapshot.success) {
			throw new ContractError('literalShape: values could not be copied', {
				code: 'structure',
				context: { path: ['values'], shape: 'literal' },
				cause: snapshot.error,
			})
		}
		if (!snapshot.value.dense) {
			throw new ContractError('validateShape: values must be a dense data array', {
				code: 'structure',
				context: { path: ['values'], shape: 'literal' },
			})
		}
		const literals: LiteralValue[] = []
		for (let index = 0; index < snapshot.value.entries.length; index += 1) {
			const value = snapshot.value.entries[index]
			if (!isLiteralValue(value)) {
				throw new ContractError(
					'validateShape: every literal value must be a string, number, or boolean',
					{
						code: 'structure',
						context: { path: ['values', INTRINSICS.text(index)], shape: 'literal' },
					},
				)
			}
			literals[literals.length] = value
		}
		const owned = INTRINSICS.freeze(literals)
		const shape: LiteralShape = {
			type: 'literal',
			values: owned,
			...(safe?.description === undefined ? {} : { description: safe.description }),
		}
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze(shape)
	}, 'literalShape')
}

// === Collections

/**
 * Builds an {@link ArrayShape} from an element shape.
 *
 * @param items - The element shape
 * @param options - Optional length bounds and `description`
 * @returns An array shape
 * @throws {ContractError} When a present bound is not a non-negative safe integer
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
	return contain(() => {
		const safe = readOptions(options, ['min', 'max', 'description'], 'arrayShape', 'array')
		if (safe?.min !== undefined && (!INTRINSICS.safe(safe.min) || safe.min < 0)) {
			throw new ContractError('arrayShape: min must be a non-negative safe integer', {
				code: 'bound',
				context: {
					shape: 'array',
					limit: 'non-negative safe integer',
					received: preview(safe.min),
				},
			})
		}
		if (safe?.max !== undefined && (!INTRINSICS.safe(safe.max) || safe.max < 0)) {
			throw new ContractError('arrayShape: max must be a non-negative safe integer', {
				code: 'bound',
				context: {
					shape: 'array',
					limit: 'non-negative safe integer',
					received: preview(safe.max),
				},
			})
		}
		const shape: ArrayShape<S> = {
			type: 'array',
			items,
			...(safe?.min === undefined ? {} : { min: safe.min }),
			...(safe?.max === undefined ? {} : { max: safe.max }),
			...(safe?.description === undefined ? {} : { description: safe.description }),
		}
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze(shape)
	}, 'arrayShape')
}

/**
 * Builds an {@link ObjectShape} from a property map.
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
	return contain(() => {
		const input: unknown = properties
		if (!isObject(input)) {
			throw new ContractError('objectShape: properties must be a plain record', {
				code: 'structure',
				context: { path: ['properties'], shape: 'object' },
			})
		}
		const safe = readOptions(
			options,
			['additionalProperties', 'description'],
			'objectShape',
			'object',
		)
		const copied = readValue(
			() => {
				const record = matchesRecordBrand(input)
				const snapshot: { [K in keyof P]: P[K] } = INTRINSICS.create(null)
				const keyList = INTRINSICS.keys(input)
				for (let keyIndex = 0; keyIndex < keyList.length; keyIndex += 1) {
					const key = keyList[keyIndex]
					if (key === undefined) continue
					INTRINSICS.reflect.define(snapshot, key, {
						value: INTRINSICS.reflect.read(input, key),
						enumerable: true,
						configurable: true,
						writable: true,
					})
				}
				return { record, snapshot: INTRINSICS.freeze(snapshot) }
			},
			'objectShape',
			{ subject: 'properties', context: { path: ['properties'], shape: 'object' } },
		)
		if (!copied.record) {
			throw new ContractError('objectShape: properties must be a plain record', {
				code: 'structure',
				context: { path: ['properties'], shape: 'object' },
			})
		}
		const shape: ObjectShape<P, A> = {
			type: 'object',
			properties: copied.snapshot,
			...(safe?.additionalProperties === undefined
				? {}
				: { additionalProperties: safe.additionalProperties }),
			...(safe?.description === undefined ? {} : { description: safe.description }),
		}
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze(shape)
	}, 'objectShape')
}

/**
 * Builds an open {@link ObjectShape} with no fixed properties — a dictionary.
 *
 * @remarks
 * Every value is validated against `values`; keys are unconstrained. Equivalent
 * to `objectShape({}, { additionalProperties: values })`.
 *
 * @param values - The shape every value must match
 * @param options - Optional `description`
 * @returns An open object shape
 * @throws {ContractError} When `values` is absent at runtime
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
	return contain(() => {
		const value: unknown = values
		if (value === undefined || value === null || value === true || value === false) {
			throw new ContractError('recordShape: values must be a shape', {
				code: 'structure',
				context: { path: ['additionalProperties'], shape: 'object' },
			})
		}
		const safe = readOptions(options, ['description'], 'recordShape', 'object')
		const shape: ObjectShape<Record<never, never>, S> = {
			type: 'object',
			properties: INTRINSICS.freeze({}),
			additionalProperties: values,
			...(safe?.description === undefined ? {} : { description: safe.description }),
		}
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze(shape)
	}, 'recordShape')
}

// === Composition

/**
 * Builds a {@link UnionShape} from a list of variant shapes (`anyOf` in JSON Schema).
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
export function unionShape<V extends readonly ContractShape[]>(
	...variants: V
): UnionShape<Readonly<V>> {
	return contain(() => {
		const shape: UnionShape<V> = { type: 'union', variants }
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze({ type: 'union', variants: INTRINSICS.freeze(variants) })
	}, 'unionShape')
}

/**
 * Builds a {@link UnionShape} that emits `oneOf` (exactly one match) in JSON Schema.
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
export function oneOfShape<V extends readonly ContractShape[]>(
	...variants: V
): UnionShape<Readonly<V>> {
	return contain(() => {
		const shape: UnionShape<V> = {
			type: 'union',
			variants,
			mode: 'oneOf',
		}
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze({ ...shape, variants: INTRINSICS.freeze(variants) })
	}, 'oneOfShape')
}

/**
 * Wraps a shape so it may be absent (`undefined`).
 *
 * @remarks
 * As an {@link objectShape} property, the field becomes a true optional property
 * in the inferred type.
 *
 * @param inner - The wrapped shape
 * @returns An optional shape
 */
export function optionalShape<S extends ContractShape>(inner: S): OptionalShape<S> {
	return contain(() => {
		const shape: OptionalShape<S> = { type: 'optional', inner }
		new ShapeValidator({ type: 'object', properties: { value: shape } }).validate()
		return INTRINSICS.freeze(shape)
	}, 'optionalShape')
}

/**
 * Wraps a shape so it may be `null`.
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
	return contain(() => {
		const shape: NullableShape<S> = { type: 'nullable', inner }
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze(shape)
	}, 'nullableShape')
}

// === Escape hatch

/**
 * Builds a {@link JSONShape}.
 *
 * @remarks
 * The sound counterpart of {@link rawShape}: `rawShape` embeds an arbitrary
 * schema fragment and accepts every defined value at runtime, while `jsonShape`
 * validates that a value is real JSON (via {@link isJSONValue}). Its emitted
 * schema is the empty accept-anything `{}`, so here the schema claims MORE than
 * the compiled guard accepts — `NaN`, a `Map`, and a class instance all satisfy
 * `{}` and all fail `isJSONValue`.
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
	return contain(() => {
		const safe = readOptions(options, ['description'], 'jsonShape', 'json')
		const shape: JSONShape = {
			type: 'json',
			...(safe?.description === undefined ? {} : { description: safe.description }),
		}
		new ShapeValidator(shape).validate()
		return INTRINSICS.freeze(shape)
	}, 'jsonShape')
}

/**
 * Builds a {@link RawShape} from a supported JSON Schema fragment.
 *
 * @remarks
 * For values the shape DSL can't express. The fragment is recursively checked
 * against the lean {@link JSONSchema} vocabulary before ownership is taken;
 * malformed or unsupported keywords throw a coded {@link ContractError}. The
 * compiled guard accepts every
 * DEFINED value — `undefined` alone fails, because it is the parser's failure
 * sentinel; wrap the shape in {@link optionalShape} to admit absence. The
 * parser passes a defined value through unchanged, and the fragment is
 * deep-cloned into an owned frozen snapshot ({@link cloneSchema}), so
 * `rawShape(fragment).schema !== fragment` and later edits to the caller's
 * fragment cannot reach the shape. `compileSchema` re-emits that snapshot
 * structurally verbatim, so here the schema claims LESS than the compiled guard
 * accepts — `rawShape({ type: 'string' })` emits `{ type: 'string' }` and its
 * guard still accepts `42`, the mirror of {@link jsonShape}'s looseness.
 * `compileGenerator` throws, since an arbitrary embedded schema has no
 * auto-generatable sample.
 *
 * @param schema - The JSON Schema fragment to embed
 * @returns A raw shape owning a frozen copy of the fragment
 *
 * @example
 * ```ts
 * const custom = rawShape({ type: 'string', format: 'uuid' })
 * ```
 */
export function rawShape(schema: JSONSchema): RawShape {
	return contain(() => {
		new ShapeValidator({ type: 'raw', schema }).validate()
		const owned = cloneSchema(schema)
		new ShapeValidator({ type: 'raw', schema: owned }).validate()
		return INTRINSICS.freeze({ type: 'raw', schema: owned })
	}, 'rawShape')
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
//
// Every widening — an empty/unrecognized node, an exhausted budget, a cycle —
// lands on `rawShape`, NOT `jsonShape`. A hostile throw is NOT a widening: a
// keyword access, enumeration, or recursive traversal that throws is not
// malformed schema vocabulary, so `schemaToShape` runs the whole walk inside
// `readValue` and refuses it as `ContractError { code: 'structure', context: {
// shape: 'schema' } }` instead of inventing an accept-anything node for a
// schema nobody could read. `{}` is JSON Schema's
// accept-anything schema, and `rawShape` is its exact inverse: its compiled
// guard accepts every defined value, and it re-emits `{}` verbatim. `jsonShape`
// also emits `{}` but its guard is the strictly narrower `isJSONValue`, so
// widening through it would REJECT the exotic originals (`Map`, `Set`, a class
// instance, a function, `NaN`) whose inferred schema is exactly `{}` — the
// round trip below would then be a false claim. `jsonShape` remains the shape a
// user AUTHORS to mean "any JSON value"; it is never inferred.

/**
 * Converts a runtime `JSONSchema` value into a validating {@link ContractShape}
 * — the inverse of {@link compileSchema}. Unlike direct {@link rawShape}
 * construction, which rejects malformed supported-vocabulary keywords, this
 * conversion is total and widens an inexpressible input to a valid raw `{}`.
 *
 * @remarks
 * Readable malformed, cyclic, or deeply nested schema nodes widen to
 * {@link rawShape}; a failed traversal raises the shared coded refusal because
 * an unreadable value is not a schema. `createContract(schemaToShape(x))`
 * therefore remains safe for every readable `x`. The per-keyword precedence is
 * `enum`, then `oneOf`, then `anyOf`, then `type`, then a record-valued
 * `properties`, then the accept-anything widening.
 *
 * `format` and `pattern` are NEVER asserted by the compiled shape — `format`
 * is annotation-only (per the JSON Schema spec, it never narrows validation
 * on its own) and compiling an attacker-controlled `pattern` string into a
 * `RegExp` is a ReDoS vector; both keywords are read only far enough to be
 * ignored. Any node the walk cannot express — an empty `{}`, an
 * unrecognized `type`, a schema past {@link INFER_DEPTH_LIMIT} deep, or a
 * cyclic re-encounter — widens to {@link rawShape} (accept any defined
 * value), never narrows.
 *
 * ROUND TRIP: for every readable `v`,
 * `compileGuard(schemaToShape(valueToSchema(v)))(v)` is `true` — including
 * values no JSON Schema keyword describes (`NaN`, `±Infinity`, a `Map`, a
 * `Set`, a class instance, a function, a symbol, a bigint, and readable cyclic
 * hosts), which infer `{}` and widen back to an accept-anything
 * {@link rawShape}. An unreadable host is refused by {@link valueToSchema}
 * before this law produces a schema; direct hostile input to
 * {@link schemaToShape} receives the same coded refusal.
 * Widening is the only source of looseness. The law has three explicit host
 * limits:
 *
 * - **Absence.** `undefined` is not a value: no compiled guard accepts it
 *   (`rawShape` reserves it as the parser failure sentinel). So `undefined`
 *   itself, an array element holding it, and an array HOLE (`arrayOf` requires
 *   every index to be an own property, the same rule `isJSONValue` applies)
 *   all fall outside the law. An OBJECT property holding `undefined` does not:
 *   `valueToSchema` drops the key and opens the object, so the source object
 *   is still accepted.
 * - **`Date` serialization.** A `Date` infers the schema of its JSON form
 *   (`{ type: 'string' }`, plus `format: 'date-time'` when `format` is on), so
 *   the law applies to `date.toISOString()` rather than the runtime instance.
 * - **Stateful access.** A getter whose result changes between inference and
 *   guard evaluation can invalidate the sampled fact. Likewise, an array that
 *   overrides iteration behavior can present different elements to the two
 *   phases. The law applies only while the sampled host's observable own
 *   enumerable string properties and array iteration remain stable.
 *
 * A widened node cannot be auto-generated: `rawShape` embeds an arbitrary
 * schema fragment, so `createContract(schemaToShape(x)).generate()` throws
 * when the conversion widened anywhere — `schema` / `is` / `parse` / `explain`
 * stay total.
 *
 * @param schema - The JSON Schema value to convert
 * @returns The built {@link ContractShape}
 * @throws {ContractError} When schema traversal fails
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
	return contain(() => {
		// The whole walk runs inside this door's own read boundary, so a hostile
		// keyword, enumeration, or recursion anywhere below it is published under
		// this door's name rather than under the name of an engine method no
		// consumer can call. The engine captures its own collection constructors
		// while ITS module evaluates — a module function cannot — so a caller who
		// replaces `globalThis.WeakSet` or `globalThis.WeakMap` can no longer make
		// construction throw a raw value out of a door documented to refuse with a
		// `ContractError`.
		return readValue(() => new SchemaShaper(schema).shape(), 'schemaToShape', {
			subject: 'schema',
			context: { shape: 'schema' },
		})
	}, 'schemaToShape')
}
