import type { JSONSchema, SchemaFormat, ValueToSchemaOptions } from './types.js'
import {
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
import { attempt } from './helpers.js'

// The inferers walk an UNKNOWN, possibly adversarial runtime value (or a set
// of example values) and emit a JSONSchema — the reverse direction of
// compileSchema (compilers.ts), which walks a finite, developer-authored
// ContractShape tree. Recursion here is runtime-only and bounded on three
// axes: a WeakSet of ancestor objects/arrays (cycle safety), a decrementing
// depth budget (INFER_DEPTH_LIMIT default), and a per-container sampling cap
// (INFER_BREADTH_LIMIT default) — every branch stays total, per AGENTS §14.

// === Canonicalization

/**
 * Render a value as a deterministic, key-sorted JSON string.
 *
 * @remarks
 * The stable-stringify backing {@link unifySchemas}'s de-duplication and
 * ordering: unlike `JSON.stringify`, object keys are sorted before encoding
 * (recursively, at every nesting level), so two structurally-equal
 * `JSONSchema` fragments built independently always canonicalize to the same
 * string. Pure ECMAScript — no `structuredClone`, no `node:*` import.
 *
 * @param value - The value to canonicalize (a `JSONSchema` fragment, or any
 *                nested piece of one)
 * @returns A deterministic string encoding of `value`
 *
 * @example
 * ```ts
 * canonicalStringify({ type: 'object', properties: {} }) ===
 * 	canonicalStringify({ properties: {}, type: 'object' }) // true
 * ```
 */
export function canonicalStringify(value: unknown): string {
	if (isArray(value)) {
		return `[${value.map((entry) => canonicalStringify(entry)).join(',')}]`
	}
	if (isRecord(value)) {
		const keys = Object.keys(value).sort()
		const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalStringify(value[key])}`)
		return `{${parts.join(',')}}`
	}
	return JSON.stringify(value)
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
	if (schemas.length === 0) return {}
	const seen = new Map<string, JSONSchema>()
	for (const schema of schemas) {
		const key = canonicalStringify(schema)
		if (!seen.has(key)) seen.set(key, schema)
	}
	const integerKey = canonicalStringify({ type: 'integer' })
	const numberKey = canonicalStringify({ type: 'number' })
	if (seen.has(integerKey) && seen.has(numberKey)) {
		seen.delete(integerKey)
	}
	const distinct = [...seen.entries()]
		.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
		.map(([, schema]) => schema)
	if (distinct.length <= 1) {
		const [only] = distinct
		return only ?? {}
	}
	return { anyOf: distinct }
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
 * ```
 */
export function stringToFormat(value: string): SchemaFormat | undefined {
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
	if (/^\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(value)) {
		const suffixed = /(Z|[+-]\d{2}:\d{2})$/.test(value) ? value : `${value}Z`
		if (isValidISOInstant(`1970-01-01T${suffixed}`)) return 'time'
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
	if (values.length === 0 || !values.every((value) => isString(value))) return undefined
	const formats = values.map((value) => stringToFormat(value))
	const [first, ...rest] = formats
	if (first === undefined) return undefined
	return rest.every((format) => format === first) ? first : undefined
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
	if (values.length < 2) return undefined
	const allString = values.every((value) => isString(value))
	const allNumber = !allString && values.every((value) => isFiniteNumber(value))
	if (!allString && !allNumber) return undefined
	const distinct = new Map<string, string | number>()
	for (const value of values) {
		if (isString(value) || isFiniteNumber(value)) distinct.set(canonicalStringify(value), value)
	}
	if (distinct.size >= values.length || distinct.size > limit) return undefined
	const sorted = [...distinct.entries()].sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	)
	return { enum: sorted.map(([, value]) => value) }
}

// === Single-value inference

/**
 * Infer a `JSONSchema` fragment for one runtime value — the recursive spine
 * shared by {@link valueToSchema} and, per collected property/element, by
 * {@link inferArray} / {@link inferObject}.
 *
 * @remarks
 * Total: never throws, and terminates on cyclic input via `visited`. Leaf
 * classification order: `null`, boolean, integer (`Number.isInteger`
 * semantics — `-0` counts), finite non-integer number, non-finite number
 * (`NaN` / `±Infinity`, widened to `{ type: 'number' }`), string (gaining a
 * `format` keyword when `format` is on and {@link stringToFormat} matches),
 * array (recurse), plain record (recurse), `Date` (`{ type: 'string' }`,
 * plus `format: 'date-time'` when `format` is on); everything else
 * (function, symbol, bigint, `undefined`, and other non-plain objects such as
 * `Map` / `Set`) is the empty accept-anything schema `{}`.
 *
 * @param value - The value to classify
 * @param depth - Remaining descent budget (0 halts recursion with `{}`)
 * @param breadth - The per-container sampling cap passed through to children
 * @param closed - Whether descended objects emit `additionalProperties: false`
 * @param format - Whether a string/`Date` leaf gains a `format` keyword
 * @param visited - The ancestor set guarding against cycles
 * @returns The inferred schema fragment for `value`
 *
 * @example
 * ```ts
 * inferValue(42, 32, 256, true, false, new WeakSet()) // { type: 'integer' }
 * ```
 */
export function inferValue(
	value: unknown,
	depth: number,
	breadth: number,
	closed: boolean,
	format: boolean,
	visited: WeakSet<object>,
): JSONSchema {
	if (isNull(value)) return { type: 'null' }
	if (isBoolean(value)) return { type: 'boolean' }
	if (isInteger(value)) return { type: 'integer' }
	if (isFiniteNumber(value)) return { type: 'number' }
	if (isNumber(value)) return { type: 'number' }
	if (isString(value)) {
		if (format) {
			const detected = stringToFormat(value)
			if (detected) return { type: 'string', format: detected }
		}
		return { type: 'string' }
	}
	if (isArray(value)) return inferArray(value, depth, breadth, closed, format, visited)
	if (isRecord(value)) return inferObject(value, depth, breadth, closed, format, visited)
	if (isDate(value)) return format ? { type: 'string', format: 'date-time' } : { type: 'string' }
	return {}
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
 * `value` both yield the empty schema `{}` instead of descending.
 *
 * @param value - The array to infer from
 * @param depth - Remaining descent budget
 * @param breadth - The maximum number of elements sampled
 * @param closed - Threaded through to nested object elements
 * @param format - Threaded through to nested string/`Date` elements
 * @param visited - The ancestor set guarding against cycles
 * @returns The inferred array schema
 *
 * @example
 * ```ts
 * inferArray([1, 2.5], 32, 256, true, false, new WeakSet())
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
): JSONSchema {
	if (value.length === 0) return { type: 'array' }
	if (depth <= 0 || visited.has(value)) return {}
	visited.add(value)
	const sampled = value.slice(0, breadth)
	const itemSchemas = sampled.map((entry) =>
		inferValue(entry, depth - 1, breadth, closed, format, visited),
	)
	visited.delete(value)
	return { type: 'array', items: unifySchemas(itemSchemas) }
}

/**
 * Infer a `JSONSchema` object fragment from a plain record's sampled
 * properties.
 *
 * @remarks
 * Own enumerable string keys via `Object.keys`, sorted lexicographically for
 * deterministic output, capped at `breadth`. Each property value is read
 * through {@link attempt} so a hostile getter cannot escape as a thrown
 * error; a property whose value is `undefined` (hostile-getter failure
 * included) is treated as ABSENT — it contributes neither a `properties`
 * entry nor a `required` entry. Every other present key is required (single-
 * value mode). Emits `additionalProperties: false` when `closed`, `true`
 * otherwise — mirroring {@link compileSchema}'s object-emission convention.
 * Depth exhaustion or a cyclic re-encounter of `value` both yield `{}`.
 *
 * @param value - The record to infer from
 * @param depth - Remaining descent budget
 * @param breadth - The maximum number of properties sampled
 * @param closed - Whether the emitted schema closes to unknown keys
 * @param format - Threaded through to nested string/`Date` properties
 * @param visited - The ancestor set guarding against cycles
 * @returns The inferred object schema
 *
 * @example
 * ```ts
 * inferObject({ id: 1 }, 32, 256, true, false, new WeakSet())
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
): JSONSchema {
	if (depth <= 0 || visited.has(value)) return {}
	visited.add(value)
	// Contain the whole key-enumeration + value-read walk — a hostile ownKeys
	// trap or property getter on `value` must yield {} for this object, never
	// throw (AGENTS §14) — mirroring compileGuard's object branch
	// (compilers.ts).
	const outcome = attempt(() => {
		const keys = Object.keys(value).sort().slice(0, breadth)
		// Honest typing: a null-prototype accumulator so a property literally
		// named '__proto__' becomes an own data key instead of mutating the
		// prototype — the same pattern compileGuard / compileParser use
		// (compilers.ts).
		const properties: Record<string, JSONSchema> = Object.create(null)
		const required: string[] = []
		for (const key of keys) {
			const propertyValue = value[key]
			if (propertyValue === undefined) continue
			properties[key] = inferValue(propertyValue, depth - 1, breadth, closed, format, visited)
			required.push(key)
		}
		return { properties, required }
	})
	visited.delete(value)
	if (!outcome.success) return {}
	const { properties, required } = outcome.value
	return {
		type: 'object',
		...(Object.keys(properties).length > 0 ? { properties } : {}),
		...(required.length > 0 ? { required } : {}),
		additionalProperties: !closed,
	}
}

/**
 * Infer a `JSONSchema` for one unknown value — the reverse direction of
 * {@link compileSchema}.
 *
 * @remarks
 * Total: never throws, and is cycle/depth/breadth-bounded (see
 * {@link inferValue} / {@link inferArray} / {@link inferObject}). Nested
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
 * @param value - The value to infer a schema from
 * @param options - Optional `maxDepth` / `maxProperties` / `closed` / `format` bounds
 * @returns The inferred `JSONSchema`
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
	const maxDepth = options?.maxDepth ?? INFER_DEPTH_LIMIT
	const maxProperties = options?.maxProperties ?? INFER_BREADTH_LIMIT
	const closed = options?.closed ?? true
	const format = options?.format ?? false
	return inferValue(value, maxDepth, maxProperties, closed, format, new WeakSet())
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
	if (samples.length === 0) return {}
	if (samples.every((sample) => isRecord(sample))) {
		return inferRecordSamples(samples, depth, breadth, closed, format, enumOn)
	}
	if (enumOn) {
		const enumSchema = inferPrimitiveEnum(samples, INFER_ENUM_LIMIT)
		if (enumSchema) return enumSchema
	}
	const schemas = samples.map((sample) =>
		inferValue(sample, depth, breadth, closed, false, new WeakSet()),
	)
	const unified = unifySchemas(schemas)
	if (format && unified.type === 'string' && Object.keys(unified).length === 1) {
		const detected = samplesToFormat(samples)
		if (detected) return { type: 'string', format: detected }
	}
	return unified
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
 * @param samples - The plain-record samples
 * @param depth - Remaining descent budget
 * @param breadth - The maximum number of properties sampled
 * @param closed - Whether the emitted schema closes to unknown keys
 * @param format - Whether a unanimous string column gains a `format` keyword
 * @param enumOn - Whether a low-cardinality column may emit `enum`
 * @returns The inferred object schema
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
	if (depth <= 0) return {}
	// Contain the whole key-enumeration walk — a hostile ownKeys trap on any
	// sample must yield an empty key set for this branch, never throw
	// (AGENTS §14).
	const keysOutcome = attempt(() => {
		const keySet = new Set<string>()
		for (const sample of samples) {
			for (const key of Object.keys(sample)) keySet.add(key)
		}
		return [...keySet].sort().slice(0, breadth)
	})
	const keys = keysOutcome.success ? keysOutcome.value : []
	// Honest typing: a null-prototype accumulator so a key literally named
	// '__proto__' becomes an own data key instead of mutating the prototype —
	// the same pattern compileGuard / compileParser use (compilers.ts).
	const properties: Record<string, JSONSchema> = Object.create(null)
	const required: string[] = []
	// Bounded by depth alone: unlike inferObject/inferArray, this record-
	// sample path carries no `visited` WeakSet. A shared reference across
	// sample rows is legitimate data (not a cycle back to an ancestor), so
	// the decrementing depth budget is the sole termination guarantee here.
	for (const key of keys) {
		// Contain the per-sample value read — a hostile getter on any sample
		// must yield an empty value list for this key, never throw
		// (AGENTS §14).
		const valuesOutcome = attempt(() => {
			const values: unknown[] = []
			for (const sample of samples) {
				const propertyValue = sample[key]
				if (propertyValue !== undefined) values.push(propertyValue)
			}
			return values
		})
		const values = valuesOutcome.success ? valuesOutcome.value : []
		if (values.length > 0) {
			properties[key] = inferSamples(values, depth - 1, breadth, closed, format, enumOn)
		}
		if (values.length === samples.length) required.push(key)
	}
	return {
		type: 'object',
		...(Object.keys(properties).length > 0 ? { properties } : {}),
		...(required.length > 0 ? { required } : {}),
		additionalProperties: !closed,
	}
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
 * precedence and the multi-sample format-disabling seam.
 *
 * @param samples - The example values to infer a schema from
 * @param options - Optional `maxDepth` / `maxProperties` / `closed` / `format` / `enum` bounds
 * @returns The inferred `JSONSchema`
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
	const maxDepth = options?.maxDepth ?? INFER_DEPTH_LIMIT
	const maxProperties = options?.maxProperties ?? INFER_BREADTH_LIMIT
	const closed = options?.closed ?? true
	const format = options?.format ?? false
	const enumOn = options?.enum ?? false
	return inferSamples(samples, maxDepth, maxProperties, closed, format, enumOn)
}
