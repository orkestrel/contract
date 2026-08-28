import type { JSONSchema, SampleMemo, SchemaFormat, ValueToSchemaOptions } from './types.js'
import {
	FORMAT_MAX_LENGTH,
	INFER_BREADTH_LIMIT,
	INFER_ENUM_LIMIT,
	INTRINSICS,
} from './constants.js'
import { ContractError } from './errors.js'
import {
	isArray,
	isBoolean,
	isDate,
	isFiniteNumber,
	isInteger,
	isNull,
	isNumber,
	isRecord,
	isString,
} from './validators.js'
import {
	admitMember,
	admitVisited,
	appendEntries,
	attempt,
	buildSampleMemo,
	canonicalStringify,
	classifyFormat,
	collectMembers,
	contain,
	enumerableKeys,
	limitEntries,
	matchesMember,
	matchesVisited,
	omitVisited,
	readArrayEntries,
	readOptions,
	readSampleMemo,
	readValue,
	retainDepth,
	sanitizeBudget,
	sanitizeDepth,
	sortValues,
} from './helpers.js'

// The inferers walk an UNKNOWN, possibly adversarial runtime value (or a set
// of example values) and emit a JSONSchema — the reverse direction of
// compileSchema (compilers.ts), which walks a finite, developer-authored
// ContractShape tree. Recursion here is runtime-only and bounded on three
// axes: a WeakSet of ancestor objects/arrays (cycle safety), a decrementing
// depth budget held at the INFER_DEPTH_LIMIT ceiling, and a per-container sampling cap
// (INFER_BREADTH_LIMIT default). Readable unsupported values widen only where
// documented; failed traversal is a coded refusal, never a permissive schema.

/**
 * Unify a list of inferred `JSONSchema` fragments into one schema.
 *
 * @remarks
 * De-duplicates by {@link canonicalStringify}, then applies the one
 * special-case subsumption inference performs: a bare `{ type: 'integer' }`
 * alongside a bare `{ type: 'number' }` collapses to just `{ type: 'number' }`
 * (an integer sample is also a valid `number` sample). A single surviving
 * distinct schema is returned directly; two or more are wrapped as
 * `{ anyOf: [...] }`, sorted by their canonical key for deterministic output.
 * An empty input list returns the empty accept-anything schema `{}`.
 *
 * Every captured member must first be a non-null object record. This runtime
 * requirement is realm-agnostic and admits ordinary and null-prototype schema
 * records while refusing primitives and callables before canonicalization.
 *
 * A readable member {@link canonicalStringify} cannot key — a cyclic or
 * otherwise JSON-inexpressible fragment, which only a direct caller can supply
 * since the inferers always build plain encodable fragments — has NO
 * de-duplication key, so it can participate in neither de-duplication nor the
 * canonical-key ordering. It is KEPT (dropping a variant would narrow the
 * union, and unification only ever widens), appended in input order after the
 * sorted keyed members. A failed member read propagates the canonicalizer's
 * coded refusal instead of participating in the union.
 *
 * @param schemas - The schemas to unify
 * @returns The unified schema
 *
 * @example
 * ```ts
 * unifySchemas([{ type: 'integer' }, { type: 'number' }]) // { type: 'number' }
 * unifySchemas([{ type: 'string' }, { type: 'boolean' }])
 * // { anyOf: [{ type: 'boolean' }, { type: 'string' }] }
 * ```
 */
export function unifySchemas(schemas: readonly JSONSchema[]): JSONSchema {
	return contain(() => {
		return readValue(
			() => {
				const snapshot = readArrayEntries(schemas)
				if (!snapshot.success) throw snapshot.error
				if (!snapshot.value.dense) throw new INTRINSICS.error('unifySchemas: schemas must be dense')
				const owned = snapshot.value.entries
				if (owned.length === 0) return {}
				// A key list plus a null-prototype table, walked by index — not a `Map`
				// spread into `.sort().map()`. Every one of those is a caller-writable
				// member on the path that decides the PUBLISHED union: an emptying
				// `sort` truncated the answer and a substituted `map` replaced it
				// wholesale, both without throwing.
				const keys: string[] = []
				const collected = collectMembers([])
				const byKey: Record<string, JSONSchema> = INTRINSICS.create(null)
				const unkeyed: JSONSchema[] = []
				for (let index = 0; index < owned.length; index += 1) {
					const schema = owned[index]
					if (schema === undefined || !isRecord(schema)) {
						throw new INTRINSICS.error('unifySchemas: schemas must be records')
					}
					const key = canonicalStringify(schema)
					if (key === undefined) {
						unkeyed[unkeyed.length] = schema
						continue
					}
					if (matchesMember(collected, key)) continue
					admitMember(collected, key)
					keys[keys.length] = key
					byKey[key] = schema
				}
				// Both literals always canonicalize; the explicit checks keep the
				// subsumption total against `canonicalStringify`'s optional result.
				const integerKey = canonicalStringify({ type: 'integer' })
				const numberKey = canonicalStringify({ type: 'number' })
				const subsumed =
					integerKey !== undefined &&
					numberKey !== undefined &&
					matchesMember(collected, integerKey) &&
					matchesMember(collected, numberKey)
						? integerKey
						: undefined
				const ordered = sortValues(keys)
				const members: JSONSchema[] = []
				for (let index = 0; index < ordered.length; index += 1) {
					const key = ordered[index]
					if (key === undefined || key === subsumed) continue
					const schema = byKey[key]
					if (schema === undefined) continue
					members[members.length] = schema
				}
				appendEntries(members, unkeyed)
				if (members.length <= 1) {
					const only = members[0]
					return only ?? {}
				}
				return { anyOf: members }
			},
			'unifySchemas',
			{ subject: 'schemas' },
		)
	}, 'unifySchemas')
}

// === Format inference

/**
 * Classify a string against the {@link SchemaFormat} vocabulary.
 *
 * @remarks
 * Total, pure, and deterministic. Fixed precedence, most specific first:
 * `'uuid'`, `'date-time'`, `'date'`, `'time'`, `'email'`, `'uri'` — the first
 * match wins. The `date-time` / `date` / `time` branches require BOTH a
 * strict ISO-8601 shape match AND a real {@link isValidISOInstant} validity
 * check, so a shape-plausible but impossible date (`2020-13-45`) is rejected.
 * Returns `undefined` when no format matches (including the empty string).
 *
 * @param value - The string to classify
 * @returns The matched {@link SchemaFormat}, or `undefined`
 *
 * @example
 * ```ts
 * stringToFormat('550e8400-e29b-41d4-a716-446655440000') // 'uuid'
 * stringToFormat('2024-01-15')                             // 'date'
 * stringToFormat('2020-13-45')                             // undefined — invalid date
 * stringToFormat('ada@example.com')                        // 'email'
 * stringToFormat('10:30:00')                                // undefined — RFC 3339 time requires an offset
 * stringToFormat('10:30:00+02:00')                          // 'time'
 * ```
 */
export function stringToFormat(value: string): SchemaFormat | undefined {
	if (!isString(value)) return undefined
	if (value.length > FORMAT_MAX_LENGTH) return undefined
	// Total by containment at the door: every classification below dispatches
	// through `RegExp.prototype.test`/`.exec`, caller-writable members reached by
	// name, and this reader is documented to answer `SchemaFormat | undefined`
	// with no `@throws` at all.
	const outcome = attempt(() => classifyFormat(value))
	return outcome.success ? outcome.value : undefined
}

/**
 * Classify a list of sample values against the {@link SchemaFormat}
 * vocabulary, requiring unanimity.
 *
 * @remarks
 * A format is returned ONLY IF every value is a string AND every one maps to
 * the SAME {@link stringToFormat} result (including all mapping to
 * `undefined`, which itself returns `undefined` here). A single disagreeing
 * value, a non-string value, or an empty list all yield `undefined` — the
 * multi-sample seam ({@link samplesToSchema} / {@link inferRecordSamples})
 * relies on this unanimity so a slot with mixed string shapes emits a bare
 * `{ type: 'string' }` rather than an `anyOf` of formats.
 *
 * @param values - The sample values to classify
 * @returns The unanimous {@link SchemaFormat}, or `undefined`
 *
 * @example
 * ```ts
 * samplesToFormat(['2024-01-01', '2024-02-02']) // 'date'
 * samplesToFormat(['2024-01-01', 'not a date'])  // undefined
 * samplesToFormat([])                            // undefined
 * ```
 */
export function samplesToFormat(values: readonly unknown[]): SchemaFormat | undefined {
	return contain(() => {
		return readValue(
			() => {
				const snapshot = readArrayEntries(values)
				if (!snapshot.success) throw snapshot.error
				if (!snapshot.value.dense)
					throw new INTRINSICS.error('samplesToFormat: values must be dense')
				const owned = snapshot.value.entries
				if (owned.length === 0) return undefined
				let first: SchemaFormat | undefined
				for (let index = 0; index < owned.length; index += 1) {
					const value = owned[index]
					if (!isString(value)) return undefined
					const format = stringToFormat(value)
					if (format === undefined) return undefined
					if (index === 0) first = format
					else if (format !== first) return undefined
				}
				return first
			},
			'samplesToFormat',
			{ subject: 'values' },
		)
	}, 'samplesToFormat')
}

// === Enum inference

/**
 * Infer an `{ enum: [...] }` fragment for a low-cardinality, repeated
 * primitive slot — the multi-sample-only counterpart to
 * {@link stringToFormat} ({@link valueToSchema} never emits `enum`).
 *
 * @remarks
 * Fires only when ALL of: every value is the same primitive kind (all string
 * or all FINITE number via {@link isFiniteNumber} — any `null`/boolean/mixed
 * slot never qualifies, and a slot containing `NaN` / `±Infinity` never
 * qualifies either, since {@link canonicalStringify} collapses `NaN` to
 * `'null'` and would otherwise risk an invalid-JSON `enum`); at least 2
 * values are given; the distinct-by-{@link canonicalStringify} count is LESS
 * than the value count (repetition required — separates a categorical column
 * from an ID column); and the distinct count is at most `limit`. The emitted
 * schema carries `enum` with NO `type` key, byte-matching `compileSchema`'s
 * `literalShape` emission. Members are sorted by canonical key for
 * deterministic output.
 *
 * A member {@link canonicalStringify} cannot key has no identity to
 * de-duplicate against, so the whole slot is enum-INELIGIBLE and returns
 * `undefined` — widening to the caller's bare `type` rather than emitting an
 * `enum` that might silently omit a value. (A string or finite number always
 * canonicalizes, so this only guards the total contract.)
 *
 * @param values - The collected slot values
 * @param limit - The maximum distinct-value count before giving up
 * @returns The `{ enum: [...] }` fragment, or `undefined` when ineligible
 *
 * @example
 * ```ts
 * inferPrimitiveEnum(['active', 'inactive', 'active'], 12)
 * // { enum: ['active', 'inactive'] }
 * inferPrimitiveEnum(['a', 'b', 'c'], 12) // undefined — no repetition
 * ```
 */
export function inferPrimitiveEnum(
	values: readonly unknown[],
	limit: number,
): JSONSchema | undefined {
	return contain(() => {
		return readValue(
			() => {
				const snapshot = readArrayEntries(values)
				if (!snapshot.success) throw snapshot.error
				if (!snapshot.value.dense)
					throw new INTRINSICS.error('inferPrimitiveEnum: values must be dense')
				const owned = snapshot.value.entries
				if (owned.length < 2) return undefined
				let strings = 0
				let numbers = 0
				for (let index = 0; index < owned.length; index += 1) {
					const value = owned[index]
					if (isString(value)) strings += 1
					else if (isFiniteNumber(value)) numbers += 1
				}
				const allString = strings === owned.length
				const allNumber = !allString && numbers === owned.length
				if (!allString && !allNumber) return undefined
				// A key list plus a null-prototype table, ordered through the captured
				// sort: `Map` iteration, array spread, `.sort` and `.map` are four
				// caller-writable dispatches deciding a published `enum`.
				const keys: string[] = []
				const collected = collectMembers([])
				const byKey: Record<string, string | number> = INTRINSICS.create(null)
				for (let index = 0; index < owned.length; index += 1) {
					const value = owned[index]
					if (!isString(value) && !isFiniteNumber(value)) continue
					const key = canonicalStringify(value)
					if (key === undefined) return undefined
					if (!matchesMember(collected, key)) {
						admitMember(collected, key)
						keys[keys.length] = key
					}
					byKey[key] = value
				}
				if (keys.length >= owned.length || keys.length > limit) return undefined
				const ordered = sortValues(keys)
				const population: Array<string | number> = []
				for (let index = 0; index < ordered.length; index += 1) {
					const key = ordered[index]
					if (key === undefined) continue
					const value = byKey[key]
					if (value === undefined) continue
					population[population.length] = value
				}
				return { enum: population }
			},
			'inferPrimitiveEnum',
			{ subject: 'values' },
		)
	}, 'inferPrimitiveEnum')
}

// === Single-value inference

/**
 * Infer a `JSONSchema` fragment for one runtime value — the recursive spine
 * shared by {@link valueToSchema} and, per collected property/element, by
 * {@link inferArray} / {@link inferObject}.
 *
 * @remarks
 * Terminates on cyclic readable input via `visited`; failed traversal is
 * refused by the containing public reader. Leaf
 * classification order: `null`, boolean, integer (`Number.isInteger`
 * semantics — `-0` counts), finite non-integer number, string (gaining a
 * `format` keyword when `format` is on and {@link stringToFormat} matches),
 * array (recurse), plain record (recurse), `Date` (`{ type: 'string' }`,
 * plus `format: 'date-time'` when `format` is on); everything else — a
 * NON-FINITE number (`NaN` / `±Infinity`), a function, a symbol, a bigint,
 * `undefined`, and other non-plain objects such as `Map` / `Set` — is the
 * empty accept-anything schema `{}`.
 *
 * A non-finite number bottoms out with the other JSON-inexpressible values on
 * purpose: JSON carries no `NaN` / `±Infinity` (`JSON.stringify(Number.NaN)`
 * is `'null'`), so `{ type: 'number' }` would ASSERT something a JSON Schema
 * validator rejects — and the shape {@link schemaToShape} builds from it would
 * reject the very sample it was inferred from. `{}` is the truthful
 * description, and it inverts to an accept-anything shape, keeping
 * `compileGuard(schemaToShape(valueToSchema(v)))(v)` true.
 *
 * @param value - The value to classify
 * @param depth - Remaining descent budget (0 halts recursion with `{}`)
 * @param breadth - The per-container sampling cap passed through to children
 * @param closed - Whether descended objects emit `additionalProperties: false`
 * @param format - Whether a string/`Date` leaf gains a `format` keyword
 * @param visited - The ancestor set guarding against cycles
 * @param memo - A per-call `(object, remaining depth) → schema` cache guarding
 *               against exponential re-inference of a shared-reference DAG
 * @returns The inferred schema fragment for `value`
 * @throws {ContractError} When a traversed container cannot be read
 *
 * @example
 * ```ts
 * inferValue(42, 32, 256, true, false, new WeakSet(), new WeakMap()) // { type: 'integer' }
 * ```
 */
export function inferValue(
	value: unknown,
	depth: number,
	breadth: number,
	closed: boolean,
	format: boolean,
	visited: WeakSet<object>,
	memo: WeakMap<object, Map<number, JSONSchema>>,
): JSONSchema {
	return contain(() => {
		return readValue(() => {
			if (isNull(value)) return { type: 'null' }
			if (isBoolean(value)) return { type: 'boolean' }
			if (isInteger(value)) return { type: 'integer' }
			if (isFiniteNumber(value)) return { type: 'number' }
			// A non-finite number has no JSON representation at all, so it widens to
			// `{}` with the other inexpressible values rather than claiming a `number`
			// type no validator would accept it under.
			if (isNumber(value)) return {}
			if (isString(value)) {
				if (format) {
					const detected = stringToFormat(value)
					if (detected) return { type: 'string', format: detected }
				}
				return { type: 'string' }
			}
			if (isArray(value)) return inferArray(value, depth, breadth, closed, format, visited, memo)
			if (isRecord(value)) return inferObject(value, depth, breadth, closed, format, visited, memo)
			if (isDate(value))
				return format ? { type: 'string', format: 'date-time' } : { type: 'string' }
			return {}
		}, 'inferValue')
	}, 'inferValue')
}

/**
 * Infer a `JSONSchema` array fragment from an array's sampled elements.
 *
 * @remarks
 * An empty array infers `{ type: 'array' }` with no `items`. Otherwise the
 * first `breadth` elements are classified via {@link inferValue} (one less
 * depth) and unified with {@link unifySchemas}: a single distinct element
 * schema becomes `items` directly; multiple distinct schemas become
 * `items: { anyOf: [...] }`. Depth exhaustion or a cyclic re-encounter of
 * `value` both yield the empty schema `{}` instead of descending. A SPARSE
 * array (holes, e.g. `[1, , 3]`) has no JSON expression and widens to the
 * accept-anything `{}`, the same treatment `NaN`, a function, a symbol, a
 * `Map` and a `Set` receive — it is not read as a list of present `undefined`
 * leaves, because the array schema that reading produced was rejected by its
 * own compiled guard, which is the one direction the round-trip law forbids.
 * Invalid direct depth and breadth budgets use {@link sanitizeBudget} with the
 * package defaults, matching the higher-level inference boundaries.
 *
 * ALL reads of `value` — including its `length` — happen inside
 * {@link attempt}, then cross {@link readValue}: a hostile `length` getter,
 * throwing own-getter element, or hostile element access raises the shared
 * coded refusal instead of returning the empty-array schema. A genuinely
 * empty sampled/classified list still returns `{ type: 'array' }` with no
 * `items`. A same-object re-inference at the same remaining `depth` is served
 * from `memo` instead of recomputing (guards a shared-reference DAG against
 * exponential blowup).
 *
 * @param value - The array to infer from
 * @param depth - Remaining descent budget; invalid values use the package default
 * @param breadth - Maximum elements sampled; invalid values use the package default
 * @param closed - Threaded through to nested object elements
 * @param format - Threaded through to nested string/`Date` elements
 * @param visited - The ancestor set guarding against cycles
 * @param memo - A per-call `(object, remaining depth) → schema` cache guarding
 *               against exponential re-inference of a shared-reference DAG
 * @returns The inferred array schema
 * @throws {ContractError} When the array cannot be read
 *
 * @example
 * ```ts
 * inferArray([1, 2.5], 32, 256, true, false, new WeakSet(), new WeakMap())
 * // { type: 'array', items: { type: 'number' } }
 * ```
 */
export function inferArray(
	value: readonly unknown[],
	depth: number,
	breadth: number,
	closed: boolean,
	format: boolean,
	visited: WeakSet<object>,
	memo: WeakMap<object, Map<number, JSONSchema>>,
): JSONSchema {
	return contain(() => {
		const maxDepth = sanitizeDepth(depth)
		const maxBreadth = sanitizeBudget(breadth, INFER_BREADTH_LIMIT)
		return readValue(() => {
			if (!(maxDepth > 0) || matchesVisited(visited, value)) return {}
			// At a node reached through a cycle at the SAME remaining depth via two
			// different paths, the memo may serve the first traversal's already
			// cycle-truncated fragment (`{}`) to the second path instead of a fully
			// re-descended schema — a sound, deterministic over-approximation, never
			// a false-reject (a schema too permissive, never too strict).
			const cached = INTRINSICS.apply(INTRINSICS.recall, memo, [value])?.get(maxDepth)
			if (cached) return cached
			admitVisited(visited, value)
			const outcome = attempt(() => {
				const snapshot = readArrayEntries(value)
				if (!snapshot.success) throw snapshot.error
				// A HOLE is an absent own property, and that is the lens every other
				// door in this package applies: `arrayOf`, `parseArray`, `isJSONValue`,
				// `cloneJSONValue`, `canonicalStringify` and the compiled array guard
				// all refuse a sparse array. Reading a hole as a PRESENT `undefined`
				// leaf made this door the one dissenter, and the disagreement was not
				// cosmetic: `valueToSchema([1, , 3])` emitted an array schema whose
				// guard REJECTED `[1, , 3]`, so the package published a schema that
				// refused the value it was inferred from. A non-dense snapshot has no
				// JSON expression, so it widens to `{}` alongside `NaN`, a function, a
				// symbol, a `Map` and a `Set` — which restores the round-trip law
				// rather than adding a fourth exception to it.
				if (!snapshot.value.dense) return undefined
				const entries = snapshot.value.entries
				const sampled: JSONSchema[] = []
				const length = INTRINSICS.min(entries.length, maxBreadth)
				for (let index = 0; index < length; index += 1) {
					sampled[sampled.length] = inferValue(
						entries[index],
						maxDepth - 1,
						maxBreadth,
						closed,
						format,
						visited,
						memo,
					)
				}
				return sampled
			})
			omitVisited(visited, value)
			const sampled = readValue(() => {
				if (!outcome.success) throw outcome.error
				return outcome.value
			}, 'inferArray')
			const schema: JSONSchema =
				sampled === undefined
					? {}
					: sampled.length > 0
						? { type: 'array', items: unifySchemas(sampled) }
						: { type: 'array' }
			retainDepth(memo, value, maxDepth, schema)
			return schema
		}, 'inferArray')
	}, 'inferArray')
}

/**
 * Infer a `JSONSchema` object fragment from a plain record's sampled
 * properties.
 *
 * @remarks
 * Own enumerable string keys via {@link enumerableKeys}, sorted
 * lexicographically for deterministic output, capped at `breadth`. This is the
 * same property view compiled object guards, parsers, and reporters use. Each
 * property value is read through {@link attempt} and {@link readValue}; a
 * hostile getter raises the shared coded refusal. A readable property whose
 * value is `undefined` is DROPPED
 * — JSON encodes no such property (`JSON.stringify({ a: undefined })` is
 * `'{}'`), so it contributes neither a `properties` entry nor a `required`
 * entry. Every other present key is required (single-value mode).
 *
 * Emits `additionalProperties: false` when `closed`, `true` otherwise —
 * mirroring {@link compileSchema}'s object-emission convention — EXCEPT when
 * the sampled key list no longer describes every key `value` actually carries,
 * which happens two ways: the own-key list exceeds `breadth` (truncation), or
 * a key was dropped for holding `undefined`. Either way `additionalProperties`
 * is forced to `true` regardless of `closed`, because a CLOSED schema built
 * from an incomplete key list would reject the very object it was inferred
 * from (`recordOf` rejects any own key the shape does not declare).
 *
 * Depth exhaustion or a cyclic re-encounter of `value` both yield `{}`. A
 * same-object re-inference at the same remaining `depth` is served from `memo`
 * instead of recomputing (guards a shared-reference DAG against exponential
 * blowup).
 *
 * @param value - The record to infer from
 * @param depth - Remaining descent budget
 * @param breadth - The maximum number of properties sampled
 * @param closed - Whether the emitted schema closes to unknown keys
 * @param format - Threaded through to nested string/`Date` properties
 * @param visited - The ancestor set guarding against cycles
 * @param memo - A per-call `(object, remaining depth) → schema` cache guarding
 *               against exponential re-inference of a shared-reference DAG
 * @returns The inferred object schema
 * @throws {ContractError} When the record cannot be read
 *
 * @example
 * ```ts
 * inferObject({ id: 1 }, 32, 256, true, false, new WeakSet(), new WeakMap())
 * // { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'],
 * //   additionalProperties: false }
 * ```
 */
export function inferObject(
	value: Record<string, unknown>,
	depth: number,
	breadth: number,
	closed: boolean,
	format: boolean,
	visited: WeakSet<object>,
	memo: WeakMap<object, Map<number, JSONSchema>>,
): JSONSchema {
	return contain(() => {
		// The BREADTH budget passes through `sanitizeBudget`, as `inferArray`'s
		// already did. Without it `limitEntries(keys, NaN)` returned the EMPTY key
		// list while `allKeys.length > NaN` left `truncated` false, so a public
		// export emitted `{ type: 'object', additionalProperties: false }` — a
		// CLOSED schema that rejects the very record it was inferred from, the one
		// direction the schema-inversion law forbids. The DEPTH budget is left
		// exactly as it was in one respect — `!(maxDepth > 0)` still fails safe by
		// widening to `{}` — but it now passes through `sanitizeDepth` as well, so a
		// direct caller cannot hand this door a budget deeper than the walk survives.
		// `inferArray` already sanitized its depth and this one did not, so the two
		// containers answered a hostile budget differently at the same level.
		const maxBreadth = sanitizeBudget(breadth, INFER_BREADTH_LIMIT)
		const maxDepth = sanitizeDepth(depth)
		return readValue(() => {
			if (!(maxDepth > 0) || matchesVisited(visited, value)) return {}
			const cached = INTRINSICS.apply(INTRINSICS.recall, memo, [value])?.get(maxDepth)
			if (cached) return cached
			admitVisited(visited, value)
			// Contain the whole key-enumeration + value-read walk before converting a
			// failed advertised read to the shared coded refusal below. Readable depth
			// or cycle exhaustion widens to `{}`; unreadability never does.
			const outcome = attempt(() => {
				const snapshot = enumerableKeys(value)
				if (snapshot === undefined)
					throw new INTRINSICS.error('inferObject: property enumeration failed')
				const allKeys = sortValues(snapshot)
				const keys = limitEntries(allKeys, maxBreadth)
				const truncated = allKeys.length > maxBreadth
				// Honest typing: a null-prototype accumulator so a property literally
				// named '__proto__' becomes an own data key instead of mutating the
				// prototype — the same pattern compileGuard / compileParser use
				// (compilers.ts).
				const properties: Record<string, JSONSchema> = INTRINSICS.create(null)
				const required: string[] = []
				let dropped = false
				for (let index = 0; index < keys.length; index += 1) {
					const key = keys[index]
					if (key === undefined) continue
					const propertyValue = value[key]
					if (propertyValue === undefined) {
						dropped = true
						continue
					}
					properties[key] = inferValue(
						propertyValue,
						maxDepth - 1,
						maxBreadth,
						closed,
						format,
						visited,
						memo,
					)
					required[required.length] = key
				}
				return { properties, required, partial: truncated || dropped }
			})
			omitVisited(visited, value)
			const readable = readValue(() => {
				if (!outcome.success) throw outcome.error
				return outcome.value
			}, 'inferObject')
			const { properties, required, partial } = readable
			const schema: JSONSchema = {
				type: 'object',
				...(INTRINSICS.keys(properties).length > 0 ? { properties } : {}),
				...(required.length > 0 ? { required } : {}),
				additionalProperties: partial ? true : !closed,
			}
			retainDepth(memo, value, maxDepth, schema)
			return schema
		}, 'inferObject')
	}, 'inferObject')
}

/**
 * Infer a `JSONSchema` for one unknown value — the reverse direction of
 * {@link compileSchema}.
 *
 * @remarks
 * Cycle/depth/breadth-bounded (see {@link inferValue} / {@link inferArray} /
 * {@link inferObject}). A failed traversal throws a `structure`
 * {@link ContractError}; it never becomes `{}` or another permissive schema. Nested
 * objects close to unknown keys (`additionalProperties: false`) by default;
 * pass `closed: false` to open them. `format` (default `false`) opts a
 * string/`Date` leaf into the `format` keyword. Structurally-equal inputs
 * infer byte-identical schemas (object keys and `anyOf` members are sorted).
 *
 * A non-object root — e.g. `valueToSchema('hi')` yielding `{ type: 'string'
 * }` — is structurally accepted by `schemaToParameters`, but MCP clients
 * expect an object-shaped `inputSchema`; wrap a non-object payload with
 * {@link schemaToObject} before advertising it as a tool's parameters.
 *
 * `maxProperties` is sanitized via {@link sanitizeBudget} to a finite
 * non-negative integer, falling back to {@link INFER_BREADTH_LIMIT} for anything
 * else (`NaN`, `Infinity`, negative, fractional), so a malformed breadth cannot
 * corrupt the sampled key/element list.
 *
 * `maxDepth` goes through {@link sanitizeDepth}, which does the same and then caps
 * at {@link INFER_DEPTH_LIMIT}, so the option NARROWS the walk and cannot widen
 * it. The cap is what makes the depth guard unbreakable: depth is the recursing
 * axis, and a large-but-valid budget used to descend until the call STACK failed
 * rather than until the guard said stop.
 *
 * @param value - The value to infer a schema from
 * @param options - Optional `maxDepth` / `maxProperties` / `closed` / `format` bounds
 * @returns The inferred `JSONSchema`
 * @throws {ContractError} When the value or options cannot be read
 *
 * @example
 * ```ts
 * valueToSchema({ id: 1, name: 'Ada', tags: ['a', 'b'] })
 * // { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' },
 * //   tags: { type: 'array', items: { type: 'string' } } },
 * //   required: ['id', 'name', 'tags'], additionalProperties: false }
 * ```
 */
export function valueToSchema(value: unknown, options?: ValueToSchemaOptions): JSONSchema {
	return contain(() => {
		const optionsSnapshot = readOptions(
			options,
			['maxDepth', 'maxProperties', 'closed', 'format', 'enum'],
			'valueToSchema',
			'schema',
		)
		const maxDepth = sanitizeDepth(optionsSnapshot?.maxDepth)
		const maxProperties = sanitizeBudget(optionsSnapshot?.maxProperties, INFER_BREADTH_LIMIT)
		const closed = optionsSnapshot?.closed ?? true
		const format = optionsSnapshot?.format ?? false
		return readValue(
			() =>
				inferValue(
					value,
					maxDepth,
					maxProperties,
					closed,
					format,
					new INTRINSICS.weakSet(),
					new INTRINSICS.weakMap(),
				),
			'valueToSchema',
		)
	}, 'valueToSchema')
}

// === Multi-sample inference

/**
 * Infer a `JSONSchema` for a collected slot of sample values — the shared
 * non-record recursion step behind {@link samplesToSchema} (top level) and
 * {@link inferRecordSamples} (per collected property).
 *
 * @remarks
 * When every value is itself a plain record, delegates to
 * {@link inferRecordSamples}. Otherwise: enum inference runs FIRST when
 * `enumOn` — {@link inferPrimitiveEnum} fires only for a low-cardinality,
 * repeated, single-primitive-kind slot, and its `{ enum: [...] }` result wins
 * outright (ENUM > FORMAT > bare string). Failing that, each value is
 * classified independently via {@link inferValue} with `format` FORCED OFF
 * (the multi-sample seam: nested formats never compound into an `anyOf`) and
 * unified with {@link unifySchemas}; only when that unified result is exactly
 * `{ type: 'string' }` and the outer `format` flag is on does
 * {@link samplesToFormat} run to (maybe) reattach a unanimous `format`.
 *
 * @param samples - The collected slot values
 * @param depth - Remaining descent budget
 * @param breadth - The maximum number of properties/elements sampled per nested container
 * @param closed - Whether nested objects close to unknown keys
 * @param format - Whether a unanimous string slot gains a `format` keyword
 * @param enumOn - Whether low-cardinality primitive slots may emit `enum`
 * @param memo - The walk's {@link SampleMemo}, shared with
 *               {@link inferRecordSamples} so a row list reached through
 *               several slots is inferred once; build one with
 *               {@link buildSampleMemo}
 * @returns The inferred schema for the slot
 * @throws {ContractError} When the samples or the memo cannot be read
 *
 * @example
 * ```ts
 * inferSamples(['2024-01-01', '2024-02-02'], 32, 256, true, true, false, buildSampleMemo())
 * // { type: 'string', format: 'date' }
 * ```
 */
export function inferSamples(
	samples: readonly unknown[],
	depth: number,
	breadth: number,
	closed: boolean,
	format: boolean,
	enumOn: boolean,
	memo: SampleMemo,
): JSONSchema {
	return contain(() => {
		const maxBreadth = sanitizeBudget(breadth, INFER_BREADTH_LIMIT)
		const read = readValue(
			() => {
				const snapshot = readArrayEntries(samples)
				if (!snapshot.success) throw snapshot.error
				return snapshot.value
			},
			'inferSamples',
			{ subject: 'samples' },
		)
		// A HOLE is not an unreadable value, and saying so was a true refusal with a
		// false diagnosis: every read succeeded. This door requires a dense sample
		// list — the same own-index lens `arrayOf` and `parseArray` apply — and now
		// says that instead.
		if (!read.dense) {
			throw new ContractError('inferSamples: samples must be a dense array', {
				code: 'structure',
			})
		}
		// The memo is the one argument position whose failure used to be published
		// as `samples could not be read` — a true refusal naming the wrong
		// argument, and the only position these doors never checked. It is checked
		// here, under its own name and its own path, AFTER the sample list it
		// follows in the signature.
		const cache = readSampleMemo(memo, 'inferSamples')
		return readValue(
			() => {
				const owned = read.entries
				if (owned.length === 0) return {}
				// Indexed rather than `every`, and the narrowed rows are collected as they
				// are recognized so the record branch keeps its honest typing without an
				// assertion.
				const records: Array<Record<string, unknown>> = []
				for (let index = 0; index < owned.length; index += 1) {
					const sample = owned[index]
					if (isRecord(sample)) records[records.length] = sample
				}
				if (records.length === owned.length) {
					return inferRecordSamples(records, depth, maxBreadth, closed, format, enumOn, cache)
				}
				if (enumOn) {
					const enumSchema = inferPrimitiveEnum(owned, INFER_ENUM_LIMIT)
					if (enumSchema) return enumSchema
				}
				const schemas: JSONSchema[] = []
				for (let index = 0; index < owned.length; index += 1) {
					schemas[schemas.length] = inferValue(
						owned[index],
						depth,
						maxBreadth,
						closed,
						false,
						new INTRINSICS.weakSet(),
						new INTRINSICS.weakMap(),
					)
				}
				const unified = unifySchemas(schemas)
				if (format && unified.type === 'string' && INTRINSICS.keys(unified).length === 1) {
					const detected = samplesToFormat(owned)
					if (detected) return { type: 'string', format: detected }
				}
				return unified
			},
			'inferSamples',
			{ subject: 'samples' },
		)
	}, 'inferSamples')
}

/**
 * Infer a `JSONSchema` object fragment from a set of plain-record samples
 * (e.g. database rows) — the record-specialized branch of
 * {@link samplesToSchema}.
 *
 * @remarks
 * `properties` is the union of every sample's own keys (sorted, capped at
 * `breadth`); a key is `required` only when present (and non-`undefined`) in
 * EVERY sample. Each key's schema is inferred over the collected values for
 * that key via {@link inferSamples} itself (one less depth), so a
 * property that is itself an array/object of varying shape across rows is
 * unified the same way the top level is, and the same `format` / `enum`
 * gating applies per key. Unlike {@link inferObject}/
 * {@link inferArray}, this path carries no `visited` `WeakSet` — a value
 * shared by reference across multiple sample rows is legitimate (not a
 * cycle back to an ancestor), so termination on cyclic row data relies on
 * the decrementing `depth` budget and the shared {@link SampleMemo}.
 *
 * `additionalProperties` is forced to `true` regardless of `closed` when the
 * key union exceeds `breadth`, or a readable row carries a key as an own
 * property holding `undefined`. A hostile getter or failed KEY walk throws the
 * shared coded refusal instead of dropping a key or widening the whole slot.
 *
 * The memo is keyed by the slot's ORDERED row identities, not by a single row.
 * Keying only the one-row slot left every MULTI-row slot — the shape this door
 * exists for — re-inferring a shared child once per path: two rows sharing one
 * `{ a: child, b: child }` detail cost `2^depth` inferences, the identical
 * denial of service the one-row memo was added to remove, through the same
 * public door.
 *
 * @param samples - The plain-record samples
 * @param depth - Remaining descent budget
 * @param breadth - The maximum number of properties sampled
 * @param closed - Whether the emitted schema closes to unknown keys
 * @param format - Whether a unanimous string column gains a `format` keyword
 * @param enumOn - Whether a low-cardinality column may emit `enum`
 * @param memo - The walk's {@link SampleMemo}, shared with
 *               {@link inferSamples}; build one with {@link buildSampleMemo}
 * @returns The inferred object schema
 * @throws {ContractError} When a sample row or the memo cannot be read
 *
 * @example
 * ```ts
 * inferRecordSamples([{ id: 1 }, { id: 2, name: 'Ada' }], 32, 256, true, false, false, buildSampleMemo())
 * // { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } },
 * //   required: ['id'], additionalProperties: false }
 * ```
 */
export function inferRecordSamples(
	samples: ReadonlyArray<Record<string, unknown>>,
	depth: number,
	breadth: number,
	closed: boolean,
	format: boolean,
	enumOn: boolean,
	memo: SampleMemo,
): JSONSchema {
	return contain(() => {
		// Breadth hygiene, for the reason `inferObject` states: `limitEntries(keys,
		// NaN)` returned the EMPTY key list while `allKeys.length > NaN` left
		// `truncated` false, so this door emitted a CLOSED empty object schema that
		// rejects the very row it was inferred from. The depth budget keeps its
		// established meaning, including the no-read exhaustion check below.
		const maxBreadth = sanitizeBudget(breadth, INFER_BREADTH_LIMIT)
		if (!(depth > 0)) return {}
		const read = readValue(
			() => {
				const snapshot = readArrayEntries(samples)
				if (!snapshot.success) throw snapshot.error
				return snapshot.value
			},
			'inferRecordSamples',
			{ subject: 'samples' },
		)
		if (!read.dense) {
			throw new ContractError('inferRecordSamples: samples must be a dense array', {
				code: 'structure',
			})
		}
		const cache = readSampleMemo(memo, 'inferRecordSamples')
		const owned = read.entries
		// The slot's ROW LIST is the key, followed one row at a time through the
		// memo's prefix chain, and the recorded schema is keyed by every budget and
		// flag the emission depends on. A multi-row list is a fresh array on every
		// call, but its rows are not: following their identities lands on the same
		// node whichever array carried them.
		let node = cache
		for (let index = 0; index < owned.length; index += 1) {
			const row = owned[index]
			if (!isRecord(row)) break
			const next = INTRINSICS.apply(INTRINSICS.recall, node.rows, [row])
			if (next !== undefined) {
				node = readSampleMemo(next, 'inferRecordSamples')
				continue
			}
			const fresh = buildSampleMemo()
			INTRINSICS.apply(INTRINSICS.retain, node.rows, [row, fresh])
			node = fresh
		}
		const signature = `${depth}|${maxBreadth}|${closed}|${format}|${enumOn}`
		const cached = INTRINSICS.apply(INTRINSICS.fetch, node.schemas, [signature])
		if (cached !== undefined) return cached
		return readValue(
			() => {
				// Refuse the whole key-enumeration claim when any row cannot be read.
				const seen = collectMembers([])
				const collected: string[] = []
				for (let sampleIndex = 0; sampleIndex < owned.length; sampleIndex += 1) {
					const sample = owned[sampleIndex]
					if (!isRecord(sample))
						throw new INTRINSICS.error('inferRecordSamples: every sample must be a record')
					const sampleKeys = readValue(() => {
						const keys = enumerableKeys(sample)
						if (keys === undefined) {
							throw new INTRINSICS.error('inferRecordSamples: property enumeration failed')
						}
						return keys
					}, 'inferRecordSamples')
					for (let keyIndex = 0; keyIndex < sampleKeys.length; keyIndex += 1) {
						const key = sampleKeys[keyIndex]
						if (key === undefined || matchesMember(seen, key)) continue
						admitMember(seen, key)
						collected[collected.length] = key
					}
				}
				const allKeys = sortValues(collected)
				const keys = limitEntries(allKeys, maxBreadth)
				const truncated = allKeys.length > maxBreadth
				// Honest typing: a null-prototype accumulator so a key literally named
				// '__proto__' becomes an own data key instead of mutating the prototype —
				// the same pattern compileGuard / compileParser use (compilers.ts).
				const properties: Record<string, JSONSchema> = INTRINSICS.create(null)
				const required: string[] = []
				let partial = truncated
				// Bounded by depth alone: unlike inferObject/inferArray, this record-
				// sample path carries no `visited` WeakSet. A shared reference across
				// sample rows is legitimate data (not a cycle back to an ancestor), so
				// the decrementing depth budget is the sole termination guarantee here.
				for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
					const key = keys[keyIndex]
					if (key === undefined) continue
					// Refuse the whole per-key claim when any sample value cannot be read.
					const valuesOutcome = attempt(() => {
						const values: unknown[] = []
						let dropped = false
						for (let sampleIndex = 0; sampleIndex < owned.length; sampleIndex += 1) {
							const sample = owned[sampleIndex]
							if (!isRecord(sample)) {
								throw new INTRINSICS.error('inferRecordSamples: every sample must be a record')
							}
							const propertyValue = sample[key]
							if (propertyValue === undefined) {
								if (INTRINSICS.own(sample, key)) dropped = true
								continue
							}
							values[values.length] = propertyValue
						}
						return { values, dropped }
					})
					const readable = readValue(() => {
						if (!valuesOutcome.success) throw valuesOutcome.error
						return valuesOutcome.value
					}, 'inferRecordSamples')
					const { values, dropped } = readable
					// A row holding `undefined` for this key OPENS the schema; it does not
					// delete the column. Skipping the key entirely discarded a property two
					// of three rows carried as a real integer, and neither the TSDoc nor the
					// guide ever promised more than the opening.
					if (dropped) partial = true
					if (values.length > 0) {
						properties[key] = inferSamples(
							values,
							depth - 1,
							maxBreadth,
							closed,
							format,
							enumOn,
							cache,
						)
					}
					if (!dropped && values.length === owned.length) required[required.length] = key
				}
				const schema: JSONSchema = {
					type: 'object',
					...(INTRINSICS.keys(properties).length > 0 ? { properties } : {}),
					...(required.length > 0 ? { required } : {}),
					additionalProperties: partial ? true : !closed,
				}
				INTRINSICS.apply(INTRINSICS.store, node.schemas, [signature, schema])
				return schema
			},
			'inferRecordSamples',
			{ subject: 'samples' },
		)
	}, 'inferRecordSamples')
}

/**
 * Infer a `JSONSchema` from a set of example values — the multi-example
 * counterpart of {@link valueToSchema} (e.g. inferring one schema from
 * several database rows).
 *
 * @remarks
 * An empty `samples` array infers the empty accept-anything schema `{}`.
 * When every sample is a plain record, properties/required are unified
 * per-key across all samples (see {@link inferRecordSamples}) — a key
 * required iff present and non-`undefined` in every sample. Otherwise the
 * slot is inferred via {@link inferSamples} (independent {@link valueToSchema}
 * per sample, unified with {@link unifySchemas} — the same de-duplication and
 * `anyOf` ordering {@link inferArray} applies to element schemas). `format`
 * and `enum` (both default `false`) opt a low-cardinality/unanimous-format
 * slot into the corresponding keyword — see {@link inferSamples} for the
 * precedence and the multi-sample format-disabling seam. `maxDepth` /
 * `maxProperties` are resolved exactly as {@link valueToSchema} resolves them —
 * breadth through {@link sanitizeBudget}, depth through {@link sanitizeDepth},
 * which also caps at {@link INFER_DEPTH_LIMIT}; see there for why.
 *
 * @param samples - The example values to infer a schema from
 * @param options - Optional `maxDepth` / `maxProperties` / `closed` / `format` / `enum` bounds
 * @returns The inferred `JSONSchema`
 * @throws {ContractError} When the samples or options cannot be read
 *
 * @example
 * ```ts
 * samplesToSchema([{ id: 1 }, { id: 2, name: 'Ada' }])
 * // { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } },
 * //   required: ['id'], additionalProperties: false }
 * samplesToSchema([]) // {}
 * ```
 */
export function samplesToSchema(
	samples: readonly unknown[],
	options?: ValueToSchemaOptions,
): JSONSchema {
	return contain(() => {
		const optionsSnapshot = readOptions(
			options,
			['maxDepth', 'maxProperties', 'closed', 'format', 'enum'],
			'samplesToSchema',
			'schema',
		)
		const maxDepth = sanitizeDepth(optionsSnapshot?.maxDepth)
		const maxProperties = sanitizeBudget(optionsSnapshot?.maxProperties, INFER_BREADTH_LIMIT)
		const closed = optionsSnapshot?.closed ?? true
		const format = optionsSnapshot?.format ?? false
		const enumOn = optionsSnapshot?.enum ?? false
		const read = readValue(
			() => {
				const snapshot = readArrayEntries(samples)
				if (!snapshot.success) throw snapshot.error
				return snapshot.value
			},
			'samplesToSchema',
			{ subject: 'samples' },
		)
		// A hole is READABLE. Reporting it as `samples could not be read` paired a
		// true refusal with a false diagnosis and contradicted the guide's own
		// attribution of that message to "a hostile getter or failed key walk".
		if (!read.dense) {
			throw new ContractError('samplesToSchema: samples must be a dense array', {
				code: 'structure',
			})
		}
		// The recursion stays inside this door's own read boundary, so a failed read
		// anywhere below is still published as `samplesToSchema: samples could not
		// be read` rather than under the name of an internal spine function.
		return readValue(
			() =>
				inferSamples(
					read.entries,
					maxDepth,
					maxProperties,
					closed,
					format,
					enumOn,
					buildSampleMemo(),
				),
			'samplesToSchema',
			{ subject: 'samples' },
		)
	}, 'samplesToSchema')
}
