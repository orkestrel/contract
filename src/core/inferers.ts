import type { JSONSchema, ValueToSchemaOptions } from './types.js'
import { INFER_BREADTH_LIMIT, INFER_DEPTH_LIMIT } from './constants.js'
import {
	isArray,
	isBoolean,
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
 * (`NaN` / `±Infinity`, widened to `{ type: 'number' }`), string, array
 * (recurse), plain record (recurse); everything else (function, symbol,
 * bigint, `undefined`, and non-plain objects such as `Date` / `Map` / `Set`)
 * is the empty accept-anything schema `{}`.
 *
 * @param value - The value to classify
 * @param depth - Remaining descent budget (0 halts recursion with `{}`)
 * @param breadth - The per-container sampling cap passed through to children
 * @param closed - Whether descended objects emit `additionalProperties: false`
 * @param visited - The ancestor set guarding against cycles
 * @returns The inferred schema fragment for `value`
 *
 * @example
 * ```ts
 * inferValue(42, 32, 256, true, new WeakSet()) // { type: 'integer' }
 * ```
 */
export function inferValue(
	value: unknown,
	depth: number,
	breadth: number,
	closed: boolean,
	visited: WeakSet<object>,
): JSONSchema {
	if (isNull(value)) return { type: 'null' }
	if (isBoolean(value)) return { type: 'boolean' }
	if (isInteger(value)) return { type: 'integer' }
	if (isFiniteNumber(value)) return { type: 'number' }
	if (isNumber(value)) return { type: 'number' }
	if (isString(value)) return { type: 'string' }
	if (isArray(value)) return inferArray(value, depth, breadth, closed, visited)
	if (isRecord(value)) return inferObject(value, depth, breadth, closed, visited)
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
 * @param visited - The ancestor set guarding against cycles
 * @returns The inferred array schema
 *
 * @example
 * ```ts
 * inferArray([1, 2.5], 32, 256, true, new WeakSet())
 * // { type: 'array', items: { type: 'number' } }
 * ```
 */
export function inferArray(
	value: readonly unknown[],
	depth: number,
	breadth: number,
	closed: boolean,
	visited: WeakSet<object>,
): JSONSchema {
	if (value.length === 0) return { type: 'array' }
	if (depth <= 0 || visited.has(value)) return {}
	visited.add(value)
	const sampled = value.slice(0, breadth)
	const itemSchemas = sampled.map((entry) => inferValue(entry, depth - 1, breadth, closed, visited))
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
 * @param visited - The ancestor set guarding against cycles
 * @returns The inferred object schema
 *
 * @example
 * ```ts
 * inferObject({ id: 1 }, 32, 256, true, new WeakSet())
 * // { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'],
 * //   additionalProperties: false }
 * ```
 */
export function inferObject(
	value: Record<string, unknown>,
	depth: number,
	breadth: number,
	closed: boolean,
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
			properties[key] = inferValue(propertyValue, depth - 1, breadth, closed, visited)
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
 * pass `closed: false` to open them. Structurally-equal inputs infer
 * byte-identical schemas (object keys and `anyOf` members are sorted).
 *
 * A non-object root — e.g. `valueToSchema('hi')` yielding `{ type: 'string'
 * }` — is structurally accepted by `schemaToParameters`, but MCP clients
 * expect an object-shaped `inputSchema`; wrap a non-object payload in an
 * object before advertising it as a tool's parameters.
 *
 * @param value - The value to infer a schema from
 * @param options - Optional `maxDepth` / `maxProperties` / `closed` bounds
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
	return inferValue(value, maxDepth, maxProperties, closed, new WeakSet())
}

// === Multi-sample inference

/**
 * Infer a `JSONSchema` object fragment from a set of plain-record samples
 * (e.g. database rows) — the record-specialized branch of
 * {@link samplesToSchema}.
 *
 * @remarks
 * `properties` is the union of every sample's own keys (sorted, capped at
 * `breadth`); a key is `required` only when present (and non-`undefined`) in
 * EVERY sample. Each key's schema is inferred over the collected values for
 * that key via {@link samplesToSchema} itself (one less depth), so a
 * property that is itself an array/object of varying shape across rows is
 * unified the same way the top level is. Unlike {@link inferObject}/
 * {@link inferArray}, this path carries no `visited` `WeakSet` — a value
 * shared by reference across multiple sample rows is legitimate (not a
 * cycle back to an ancestor), so termination on cyclic row data relies on
 * the decrementing `depth` budget alone.
 *
 * @param samples - The plain-record samples
 * @param depth - Remaining descent budget
 * @param breadth - The maximum number of properties sampled
 * @param closed - Whether the emitted schema closes to unknown keys
 * @returns The inferred object schema
 *
 * @example
 * ```ts
 * inferRecordSamples([{ id: 1 }, { id: 2, name: 'Ada' }], 32, 256, true)
 * // { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } },
 * //   required: ['id'], additionalProperties: false }
 * ```
 */
export function inferRecordSamples(
	samples: readonly Record<string, unknown>[],
	depth: number,
	breadth: number,
	closed: boolean,
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
			properties[key] = samplesToSchema(values, {
				maxDepth: depth - 1,
				maxProperties: breadth,
				closed,
			})
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
 * required iff present and non-`undefined` in every sample. Otherwise each
 * sample is inferred independently via {@link valueToSchema} and the results
 * are unified with {@link unifySchemas} (the same de-duplication and `anyOf`
 * ordering {@link inferArray} applies to element schemas).
 *
 * @param samples - The example values to infer a schema from
 * @param options - Optional `maxDepth` / `maxProperties` / `closed` bounds
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
	if (samples.length === 0) return {}
	const maxDepth = options?.maxDepth ?? INFER_DEPTH_LIMIT
	const maxProperties = options?.maxProperties ?? INFER_BREADTH_LIMIT
	const closed = options?.closed ?? true
	if (samples.every((sample) => isRecord(sample))) {
		return inferRecordSamples(samples, maxDepth, maxProperties, closed)
	}
	const schemas = samples.map((sample) => valueToSchema(sample, options))
	return unifySchemas(schemas)
}
