import type { JSONSchema, SchemaFormat, ValueToSchemaOptions } from './types.js'
import {
	FORMAT_MAX_LENGTH,
	FORMAT_PATTERNS,
	INFER_BREADTH_LIMIT,
	INFER_DEPTH_LIMIT,
	INFER_ENUM_LIMIT,
} from './constants.js'
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
	attempt,
	enumerableKeys,
	readArrayEntries,
	readOptions,
	readValue,
	sanitizeBudget,
} from './helpers.js'

// The inferers walk an UNKNOWN, possibly adversarial runtime value (or a set
// of example values) and emit a JSONSchema — the reverse direction of
// compileSchema (compilers.ts), which walks a finite, developer-authored
// ContractShape tree. Recursion here is runtime-only and bounded on three
// axes: a WeakSet of ancestor objects/arrays (cycle safety), a decrementing
// depth budget (INFER_DEPTH_LIMIT default), and a per-container sampling cap
// (INFER_BREADTH_LIMIT default). Readable unsupported values widen only where
// documented; failed traversal is a coded refusal, never a permissive schema.

// === Canonicalization

/**
 * Encode one value as a deterministic, key-sorted JSON string — the recursive
 * spine of {@link canonicalStringify}.
 *
 * @remarks
 * Arrays keep their element order through the shared dense own-index lens;
 * records sort their own keys before encoding, recursively at every nesting
 * level. Every other value is encoded by
 * `JSON.stringify`, so `NaN` / `±Infinity` collapse to `'null'` and `-0`
 * encodes as `'0'` — the same lossy-but-deterministic mapping real JSON makes.
 *
 * Returns `undefined` for anything JSON cannot encode: `undefined` itself, a
 * function, a symbol, an array hole, or a cyclic back-edge to an ancestor. A
 * container carrying such a member is itself un-encodable and returns
 * `undefined` too, so the result is either a faithful encoding of the WHOLE
 * value or nothing — a partially-encoded key is never emitted. A hostile
 * getter or `Proxy` trap is refused through this function's own required-read
 * boundary, including when this recursive spine is called directly.
 *
 * @param value - The value to encode
 * @param ancestors - Objects on the active traversal path, guarding cycles
 * @returns The deterministic encoding, or `undefined` when JSON cannot encode
 *          `value`
 *
 * @example
 * ```ts
 * canonicalizeValue({ b: 1, a: 2 }, new WeakSet()) // '{"a":2,"b":1}'
 * canonicalizeValue(undefined, new WeakSet())      // undefined
 * ```
 */
export function canonicalizeValue(value: unknown, ancestors: WeakSet<object>): string | undefined {
	return readValue(() => {
		if (isArray(value)) {
			if (ancestors.has(value)) return undefined
			const snapshot = readArrayEntries(value)
			if (!snapshot.success) throw snapshot.error
			if (!snapshot.value.dense) return undefined
			ancestors.add(value)
			try {
				const parts: string[] = []
				for (const entry of snapshot.value.entries) {
					const part = canonicalizeValue(entry, ancestors)
					if (part === undefined) return undefined
					parts.push(part)
				}
				return `[${parts.join(',')}]`
			} finally {
				ancestors.delete(value)
			}
		}
		if (isRecord(value)) {
			if (ancestors.has(value)) return undefined
			ancestors.add(value)
			const parts: string[] = []
			for (const key of Object.keys(value).sort()) {
				const part = canonicalizeValue(value[key], ancestors)
				if (part === undefined) {
					ancestors.delete(value)
					return undefined
				}
				parts.push(`${JSON.stringify(key)}:${part}`)
			}
			ancestors.delete(value)
			return `{${parts.join(',')}}`
		}
		if (typeof value === 'bigint') return undefined
		// `JSON.stringify` returns `undefined` (never a string) for `undefined`, a
		// function, and a symbol — exactly the values with no JSON encoding.
		return JSON.stringify(value)
	}, 'canonicalizeValue')
}

/**
 * Render a value as a deterministic, key-sorted JSON string — or `undefined`
 * when it has no faithful JSON encoding.
 *
 * @remarks
 * The stable-stringify backing {@link unifySchemas}'s de-duplication and
 * ordering: unlike `JSON.stringify`, object keys are sorted before encoding
 * (recursively, at every nesting level), so two structurally-equal
 * `JSONSchema` fragments built independently always canonicalize to the same
 * string. Pure host-independent ECMAScript with no environment-specific imports.
 *
 * For READABLE input it returns `undefined` — never a partial or invalid
 * encoding — for every value JSON cannot faithfully encode:
 *
 * - `undefined` itself, a function, a symbol, or an array hole (JSON encodes
 *   none of them), at the top level or anywhere inside a container;
 * - a bigint (`JSON.stringify` throws on one);
 * - cyclic input, tracked with the same ancestor-{@link WeakSet} discipline
 *   {@link inferArray} / {@link inferObject} use, so a shared (non-cyclic)
 *   reference reached twice through different paths still encodes;
 * A hostile traversal is categorically different: a throwing own-getter,
 * hostile `ownKeys` trap, or revoked `Proxy` throws a `structure`
 * {@link ContractError} through {@link readValue}. A caller can therefore
 * distinguish "not JSON-encodable" from "could not be read".
 *
 * A caller therefore treats `undefined` as "this value has no canonical key",
 * never as an encoding: see {@link unifySchemas} (an un-keyed member cannot
 * participate in de-duplication or ordering) and {@link inferPrimitiveEnum} (an
 * un-keyed member makes the slot enum-ineligible).
 *
 * @param value - The value to canonicalize (a `JSONSchema` fragment, or any
 *                nested piece of one)
 * @returns A deterministic string encoding of `value`, or `undefined` when JSON
 *          cannot encode it
 * @throws {ContractError} When the value cannot be read
 *
 * @example
 * ```ts
 * canonicalStringify({ type: 'object', properties: {} }) ===
 * 	canonicalStringify({ properties: {}, type: 'object' }) // true
 * canonicalStringify(Number.NaN)  // 'null' — JSON.stringify semantics
 * canonicalStringify(undefined)   // undefined
 * canonicalStringify(cyclicValue) // undefined
 * ```
 */
export function canonicalStringify(value: unknown): string | undefined {
	return readValue(() => canonicalizeValue(value, new WeakSet()), 'canonicalStringify')
}

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
	return readValue(
		() => {
			if (schemas.length === 0) return {}
			const seen = new Map<string, JSONSchema>()
			const unkeyed: JSONSchema[] = []
			for (const schema of schemas) {
				const key = canonicalStringify(schema)
				if (key === undefined) {
					unkeyed.push(schema)
					continue
				}
				if (!seen.has(key)) seen.set(key, schema)
			}
			// Both literals always canonicalize; the explicit checks keep the
			// subsumption total against `canonicalStringify`'s optional result.
			const integerKey = canonicalStringify({ type: 'integer' })
			const numberKey = canonicalStringify({ type: 'number' })
			if (
				integerKey !== undefined &&
				numberKey !== undefined &&
				seen.has(integerKey) &&
				seen.has(numberKey)
			) {
				seen.delete(integerKey)
			}
			const distinct = [...seen.entries()]
				.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
				.map(([, schema]) => schema)
			const members = [...distinct, ...unkeyed]
			if (members.length <= 1) {
				const [only] = members
				return only ?? {}
			}
			return { anyOf: members }
		},
		'unifySchemas',
		{ subject: 'schemas' },
	)
}

// === Format inference

/**
 * Determine whether an ISO-8601-shaped string parses to a valid instant.
 *
 * @remarks
 * A pure, attempt-guarded `Date` validity probe: `new Date(value)` never
 * throws on a string input, but a value like `2020-13-45` parses to an
 * `Invalid Date` whose `getTime()` is `NaN` — this is the real validation
 * step behind {@link stringToFormat}'s `date` / `date-time` / `time`
 * branches, which pattern-match the shape first and confirm validity here.
 *
 * @param value - The candidate ISO-8601 string
 * @returns `true` when `value` parses to a real instant
 *
 * @example
 * ```ts
 * isValidISOInstant('2020-01-01') // true
 * isValidISOInstant('2020-13-45') // false
 * ```
 */
export function isValidISOInstant(value: string): boolean {
	const outcome = attempt(() => {
		const date = new Date(value)
		return !Number.isNaN(date.getTime())
	})
	return outcome.success && outcome.value
}

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
	if (value.length > FORMAT_MAX_LENGTH) return undefined
	if (FORMAT_PATTERNS.uuid.test(value)) return 'uuid'
	if (
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
		isValidISOInstant(value)
	) {
		return 'date-time'
	}
	if (/^\d{4}-\d{2}-\d{2}$/.test(value) && isValidISOInstant(value)) {
		return 'date'
	}
	if (
		/^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value) &&
		isValidISOInstant(`1970-01-01T${value}`)
	) {
		return 'time'
	}
	if (FORMAT_PATTERNS.email.test(value)) return 'email'
	if (FORMAT_PATTERNS.uri.test(value)) return 'uri'
	return undefined
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
	return readValue(
		() => {
			if (values.length === 0 || !values.every((value) => isString(value))) return undefined
			const formats = values.map((value) => stringToFormat(value))
			const [first, ...rest] = formats
			if (first === undefined) return undefined
			return rest.every((format) => format === first) ? first : undefined
		},
		'samplesToFormat',
		{ subject: 'values' },
	)
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
	return readValue(
		() => {
			if (values.length < 2) return undefined
			const allString = values.every((value) => isString(value))
			const allNumber = !allString && values.every((value) => isFiniteNumber(value))
			if (!allString && !allNumber) return undefined
			const distinct = new Map<string, string | number>()
			for (const value of values) {
				if (!isString(value) && !isFiniteNumber(value)) continue
				const key = canonicalStringify(value)
				if (key === undefined) return undefined
				distinct.set(key, value)
			}
			if (distinct.size >= values.length || distinct.size > limit) return undefined
			const sorted = [...distinct.entries()].sort(([left], [right]) =>
				left < right ? -1 : left > right ? 1 : 0,
			)
			return { enum: sorted.map(([, value]) => value) }
		},
		'inferPrimitiveEnum',
		{ subject: 'values' },
	)
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
		if (isDate(value)) return format ? { type: 'string', format: 'date-time' } : { type: 'string' }
		return {}
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
 * `value` both yield the empty schema `{}` instead of descending. A sparse
 * array (holes, e.g. `[1, , 3]`) is densified via `Array.from` before
 * sampling so every slot — including a hole — is visited as an explicit
 * `undefined` leaf (which {@link inferValue} maps to `{}`), rather than left
 * as a hole that would otherwise reach {@link unifySchemas} as `undefined`.
 *
 * ALL reads of `value` — including its `length` — happen inside
 * {@link attempt}, then cross {@link readValue}: a hostile `length` getter,
 * throwing own-getter element, or hostile element access raises the shared
 * coded refusal instead of returning the empty-array schema. A genuinely
 * empty sampled/classified list still returns `{ type: 'array' }` with no
 * `items`. A same-object
 * re-inference at the same remaining `depth` is served from `memo` instead
 * of recomputing (guards a shared-reference DAG against exponential blowup).
 *
 * @param value - The array to infer from
 * @param depth - Remaining descent budget
 * @param breadth - The maximum number of elements sampled
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
	return readValue(() => {
		if (!(depth > 0) || visited.has(value)) return {}
		// At a node reached through a cycle at the SAME remaining depth via two
		// different paths, the memo may serve the first traversal's already
		// cycle-truncated fragment (`{}`) to the second path instead of a fully
		// re-descended schema — a sound, deterministic over-approximation, never
		// a false-reject (a schema too permissive, never too strict).
		const cached = memo.get(value)?.get(depth)
		if (cached) return cached
		visited.add(value)
		const outcome = attempt(() => {
			const snapshot = readArrayEntries(value)
			if (!snapshot.success) throw snapshot.error
			return snapshot.value.entries
				.slice(0, breadth)
				.map((entry) => inferValue(entry, depth - 1, breadth, closed, format, visited, memo))
		})
		visited.delete(value)
		const sampled = readValue(() => {
			if (!outcome.success) throw outcome.error
			return outcome.value
		}, 'inferArray')
		const schema: JSONSchema =
			sampled.length > 0 ? { type: 'array', items: unifySchemas(sampled) } : { type: 'array' }
		let depths = memo.get(value)
		if (!depths) {
			depths = new Map()
			memo.set(value, depths)
		}
		depths.set(depth, schema)
		return schema
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
	return readValue(() => {
		if (!(depth > 0) || visited.has(value)) return {}
		const cached = memo.get(value)?.get(depth)
		if (cached) return cached
		visited.add(value)
		// Contain the whole key-enumeration + value-read walk before converting a
		// failed advertised read to the shared coded refusal below. Readable depth
		// or cycle exhaustion widens to `{}`; unreadability never does.
		const outcome = attempt(() => {
			const snapshot = enumerableKeys(value)
			if (snapshot === undefined) throw new Error('inferObject: property enumeration failed')
			const allKeys = [...snapshot].sort()
			const keys = allKeys.slice(0, breadth)
			const truncated = allKeys.length > breadth
			// Honest typing: a null-prototype accumulator so a property literally
			// named '__proto__' becomes an own data key instead of mutating the
			// prototype — the same pattern compileGuard / compileParser use
			// (compilers.ts).
			const properties: Record<string, JSONSchema> = Object.create(null)
			const required: string[] = []
			let dropped = false
			for (const key of keys) {
				const propertyValue = value[key]
				if (propertyValue === undefined) {
					dropped = true
					continue
				}
				properties[key] = inferValue(
					propertyValue,
					depth - 1,
					breadth,
					closed,
					format,
					visited,
					memo,
				)
				required.push(key)
			}
			return { properties, required, partial: truncated || dropped }
		})
		visited.delete(value)
		const readable = readValue(() => {
			if (!outcome.success) throw outcome.error
			return outcome.value
		}, 'inferObject')
		const { properties, required, partial } = readable
		const schema: JSONSchema = {
			type: 'object',
			...(Object.keys(properties).length > 0 ? { properties } : {}),
			...(required.length > 0 ? { required } : {}),
			additionalProperties: partial ? true : !closed,
		}
		let depths = memo.get(value)
		if (!depths) {
			depths = new Map()
			memo.set(value, depths)
		}
		depths.set(depth, schema)
		return schema
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
 * `maxDepth` / `maxProperties` are sanitized via {@link sanitizeBudget} to a
 * finite non-negative integer, falling back to {@link INFER_DEPTH_LIMIT} /
 * {@link INFER_BREADTH_LIMIT} for anything else (`NaN`, `Infinity`, negative,
 * fractional) — a hostile or malformed budget can never defeat the depth
 * guard or corrupt the sampled key/element list.
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
	const optionsSnapshot = readOptions(
		options,
		['maxDepth', 'maxProperties', 'closed', 'format', 'enum'],
		'valueToSchema',
		'schema',
	)
	const maxDepth = sanitizeBudget(optionsSnapshot?.maxDepth, INFER_DEPTH_LIMIT)
	const maxProperties = sanitizeBudget(optionsSnapshot?.maxProperties, INFER_BREADTH_LIMIT)
	const closed = optionsSnapshot?.closed ?? true
	const format = optionsSnapshot?.format ?? false
	return readValue(
		() => inferValue(value, maxDepth, maxProperties, closed, format, new WeakSet(), new WeakMap()),
		'valueToSchema',
	)
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
 * @returns The inferred schema for the slot
 *
 * @example
 * ```ts
 * inferSamples(['2024-01-01', '2024-02-02'], 32, 256, true, true, false)
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
): JSONSchema {
	return readValue(
		() => {
			if (samples.length === 0) return {}
			if (samples.every((sample) => isRecord(sample))) {
				return inferRecordSamples(samples, depth, breadth, closed, format, enumOn)
			}
			if (enumOn) {
				const enumSchema = inferPrimitiveEnum(samples, INFER_ENUM_LIMIT)
				if (enumSchema) return enumSchema
			}
			const schemas = samples.map((sample) =>
				inferValue(sample, depth, breadth, closed, false, new WeakSet(), new WeakMap()),
			)
			const unified = unifySchemas(schemas)
			if (format && unified.type === 'string' && Object.keys(unified).length === 1) {
				const detected = samplesToFormat(samples)
				if (detected) return { type: 'string', format: detected }
			}
			return unified
		},
		'inferSamples',
		{ subject: 'samples' },
	)
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
 * the decrementing `depth` budget alone.
 *
 * `additionalProperties` is forced to `true` regardless of `closed` when the
 * key union exceeds `breadth`, or a readable row carries a key as an own
 * property holding `undefined`. A hostile getter or failed KEY walk throws the
 * shared coded refusal instead of dropping a key or widening the whole slot.
 *
 * @param samples - The plain-record samples
 * @param depth - Remaining descent budget
 * @param breadth - The maximum number of properties sampled
 * @param closed - Whether the emitted schema closes to unknown keys
 * @param format - Whether a unanimous string column gains a `format` keyword
 * @param enumOn - Whether a low-cardinality column may emit `enum`
 * @returns The inferred object schema
 * @throws {ContractError} When a sample row cannot be read
 *
 * @example
 * ```ts
 * inferRecordSamples([{ id: 1 }, { id: 2, name: 'Ada' }], 32, 256, true, false, false)
 * // { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } },
 * //   required: ['id'], additionalProperties: false }
 * ```
 */
export function inferRecordSamples(
	samples: readonly Record<string, unknown>[],
	depth: number,
	breadth: number,
	closed: boolean,
	format: boolean,
	enumOn: boolean,
): JSONSchema {
	return readValue(
		() => {
			if (!(depth > 0)) return {}
			// Refuse the whole key-enumeration claim when any row cannot be read.
			const keySet = new Set<string>()
			for (const sample of samples) {
				const sampleKeys = readValue(() => {
					const keys = enumerableKeys(sample)
					if (keys === undefined) {
						throw new Error('inferRecordSamples: property enumeration failed')
					}
					return keys
				}, 'inferRecordSamples')
				for (const key of sampleKeys) keySet.add(key)
			}
			const allKeys = [...keySet].sort()
			const keys = allKeys.slice(0, breadth)
			const truncated = allKeys.length > breadth
			// Honest typing: a null-prototype accumulator so a key literally named
			// '__proto__' becomes an own data key instead of mutating the prototype —
			// the same pattern compileGuard / compileParser use (compilers.ts).
			const properties: Record<string, JSONSchema> = Object.create(null)
			const required: string[] = []
			let partial = truncated
			// Bounded by depth alone: unlike inferObject/inferArray, this record-
			// sample path carries no `visited` WeakSet. A shared reference across
			// sample rows is legitimate data (not a cycle back to an ancestor), so
			// the decrementing depth budget is the sole termination guarantee here.
			for (const key of keys) {
				// Refuse the whole per-key claim when any sample value cannot be read.
				const valuesOutcome = attempt(() => {
					const values: unknown[] = []
					let dropped = false
					for (const sample of samples) {
						const propertyValue = sample[key]
						if (propertyValue === undefined) {
							if (Object.hasOwn(sample, key)) dropped = true
							continue
						}
						values.push(propertyValue)
					}
					return { values, dropped }
				})
				const readable = readValue(() => {
					if (!valuesOutcome.success) throw valuesOutcome.error
					return valuesOutcome.value
				}, 'inferRecordSamples')
				const { values, dropped } = readable
				if (dropped) {
					partial = true
					continue
				}
				if (values.length > 0) {
					properties[key] = inferSamples(values, depth - 1, breadth, closed, format, enumOn)
				}
				if (values.length === samples.length) required.push(key)
			}
			return {
				type: 'object',
				...(Object.keys(properties).length > 0 ? { properties } : {}),
				...(required.length > 0 ? { required } : {}),
				additionalProperties: partial ? true : !closed,
			}
		},
		'inferRecordSamples',
		{ subject: 'samples' },
	)
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
 * `maxProperties` are sanitized via {@link sanitizeBudget} the same way
 * {@link valueToSchema} sanitizes them — see there for why.
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
	const optionsSnapshot = readOptions(
		options,
		['maxDepth', 'maxProperties', 'closed', 'format', 'enum'],
		'samplesToSchema',
		'schema',
	)
	const maxDepth = sanitizeBudget(optionsSnapshot?.maxDepth, INFER_DEPTH_LIMIT)
	const maxProperties = sanitizeBudget(optionsSnapshot?.maxProperties, INFER_BREADTH_LIMIT)
	const closed = optionsSnapshot?.closed ?? true
	const format = optionsSnapshot?.format ?? false
	const enumOn = optionsSnapshot?.enum ?? false
	return readValue(
		() => inferSamples(samples, maxDepth, maxProperties, closed, format, enumOn),
		'samplesToSchema',
		{ subject: 'samples' },
	)
}
