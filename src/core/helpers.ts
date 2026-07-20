import type {
	ContractShape,
	FaultKind,
	FieldPath,
	JSONSchema,
	RandomFunction,
	Result,
} from './types.js'
import { PREVIEW_LIMIT } from './constants.js'
import {
	isBigInt,
	isBoolean,
	isNumber,
	isObject,
	isRecord,
	isString,
	isSymbol,
} from './validators.js'

// === Result helpers

/**
 * Invoke a callback and capture its outcome as a {@link Result}, never letting
 * a throw escape.
 *
 * @remarks
 * The single sanctioned never-throw boundary for the guards (AGENTS §14). The
 * `whereOf`, `lazyOf`, and `transformOf` combinators invoke caller-supplied
 * callbacks *inside* a guard body, yet a guard must NEVER throw — it returns a
 * `boolean`. This converts a throwing callback into a `Failure` so the
 * surrounding guard can treat it as a non-match instead of propagating the
 * exception, written once and shared rather than copy-pasted as ad-hoc
 * `try`/`catch`.
 *
 * @param callback - The callback to invoke with no arguments
 * @returns A `Success` carrying the return value, or a `Failure` carrying the
 *          thrown reason normalised to an `Error`
 *
 * @example
 * ```ts
 * const outcome = attempt(() => predicate(value))
 * return outcome.success && outcome.value
 * ```
 */
export function attempt<T>(callback: () => T): Result<T> {
	try {
		return { success: true, value: callback() }
	} catch (reason) {
		if (reason instanceof Error) {
			return { success: false, error: reason }
		}
		// A thrown non-Error value's own `toString` may itself throw (a hostile
		// object) — contain that conversion too so normalization never escapes.
		let message = 'Unknown thrown value'
		try {
			message = String(reason)
		} catch {
			// keep the fallback message
		}
		return { success: false, error: new Error(message) }
	}
}

// === Record-field access

/**
 * Resolve a (possibly nested) field value from a record by a key or key path.
 *
 * @remarks
 * A single `string` is ONE key (never split on `.`, so dotted keys are safe); a
 * string array descends left-to-right through nested objects. Intermediates may
 * be any object — records, class instances, or arrays indexed by string. Returns
 * `undefined` the moment a segment is missing or lands on a non-object, so the
 * lookup is total — even against a hostile getter or Proxy trap that throws on
 * read, contained via {@link attempt} so the throw never escapes.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns The resolved value, or `undefined`
 *
 * @example
 * ```ts
 * resolveField({ user: { name: 'Ada' } }, ['user', 'name']) // 'Ada'
 * resolveField({ 'a.b': 1 }, 'a.b')                          // 1 (one key)
 * resolveField({ a: 1 }, ['a', 'b'])                         // undefined
 * ```
 */
export function resolveField(record: Readonly<Record<string, unknown>>, path: FieldPath): unknown {
	const keys = isString(path) ? [path] : path
	let current: unknown = record
	for (const key of keys) {
		if (!isObject(current)) return undefined
		const container = current
		const outcome = attempt(() => Reflect.get(container, key))
		if (!outcome.success) return undefined
		current = outcome.value
	}
	return current
}

// === Random

/**
 * Build a deterministic pseudo-random source seeded from a single number.
 *
 * @remarks
 * A mulberry32 generator — the same seed always yields the same sequence, so
 * generated seed data is reproducible across runs. Used as the default random
 * source for {@link compileGenerator}, seeded from the wall clock so casual
 * callers still get varied output without passing a source themselves.
 *
 * @param seed - The seed for the sequence
 * @returns A {@link RandomFunction} returning values in `[0, 1)`
 *
 * @example
 * ```ts
 * const random = seededRandom(42)
 * random() // always the same first value for seed 42
 * ```
 */
export function seededRandom(seed: number): RandomFunction {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
	}
}

/**
 * Count the enumerable own-symbol keys on a value.
 *
 * @remarks
 * String keys are ignored — only `Object.getOwnPropertySymbols` entries whose
 * descriptor is `enumerable` are counted. Backs the object-emptiness guards
 * (`isEmptyObject` / `isNonEmptyObject`) so a record keyed only by an
 * enumerable symbol is not mistaken for empty.
 *
 * @param value - The object to inspect
 * @returns The number of enumerable own-symbol keys
 *
 * @example
 * ```ts
 * const flag = Symbol('flag')
 * enumerableSymbolCount(Object.defineProperty({}, flag, { value: 1, enumerable: true })) // 1
 * enumerableSymbolCount({}) // 0
 * ```
 */
export function enumerableSymbolCount(value: object): number {
	let count = 0
	for (const symbol of Object.getOwnPropertySymbols(value)) {
		if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable) {
			count += 1
		}
	}
	return count
}

/**
 * Narrow a compiled {@link JSONSchema} down to the open `Readonly<Record<string, unknown>>` shape
 * tool definitions advertise as `parameters` — through the {@link isRecord} boundary guard, never
 * an assertion (AGENTS §14).
 *
 * @remarks
 * A `JSONSchema` is the closed contract-compiler fragment (it has no index signature), whereas a
 * tool advertises its `parameters` as an open record. The two are structurally compatible but not
 * assignable, so the schema crosses that boundary through `isRecord` — a compiled contract schema
 * is always a record, so the guard passes; the `undefined` fallback only satisfies the type's
 * optionality. This is the single sanctioned narrowing from a compiled contract schema to the open
 * tool-parameters record, so the crossing lives once rather than being copy-pasted per call site.
 *
 * @param schema - The compiled JSON Schema (a contract's `schema`)
 * @returns The schema as the open tool-parameters record, or `undefined` when it is not a record
 *
 * @example
 * ```ts
 * import { createContract, schemaToParameters } from '@src/core'
 *
 * const contract = createContract(shape)
 * const parameters = schemaToParameters(contract.schema) // the open record a tool advertises
 * ```
 */
export function schemaToParameters(
	schema: JSONSchema,
): Readonly<Record<string, unknown>> | undefined {
	return isRecord(schema) ? schema : undefined
}

/**
 * Wrap a non-object `JSONSchema` root in a single-property object schema, so
 * an inferred primitive/array/union schema can flow into {@link schemaToParameters}
 * as an MCP-compatible `inputSchema`.
 *
 * @remarks
 * Total and deterministic. `schema.type === 'object'` passes through
 * unchanged; every other root (a primitive/array `type`, an `anyOf`/`enum`-only
 * schema with no `type`, or the empty `{}`) is wrapped as a single required
 * `value` property: `{ type: 'object', properties: { value: schema },
 * required: ['value'], additionalProperties: false }`. Composition:
 * `schemaToParameters(schemaToObject(valueToSchema(payload)))`.
 *
 * @param schema - The schema to wrap
 * @returns `schema` unchanged when object-rooted, otherwise the wrapped object schema
 *
 * @example
 * ```ts
 * schemaToObject({ type: 'string' })
 * // { type: 'object', properties: { value: { type: 'string' } },
 * //   required: ['value'], additionalProperties: false }
 * schemaToObject({ type: 'object', properties: {} }) // unchanged
 * ```
 */
export function schemaToObject(schema: JSONSchema): JSONSchema {
	if (schema.type === 'object') return schema
	return {
		type: 'object',
		properties: { value: schema },
		required: ['value'],
		additionalProperties: false,
	}
}

// === Inference option sanitization

/**
 * Sanitize a user-supplied inference budget (`maxDepth` / `maxProperties`) to
 * a finite non-negative integer, falling back to a default for anything else.
 *
 * @remarks
 * Guards {@link valueToSchema} / {@link samplesToSchema} against a hostile or
 * malformed budget: an unclamped `NaN` defeats every `depth <= 0` guard
 * (`NaN <= 0` is `false`, so recursion never halts), and a negative
 * `maxProperties` makes `slice(0, -1)` silently drop the LAST sorted key
 * instead of capping the list (a fractional value has a similarly undefined
 * `slice` bound). `Infinity` is rejected too — `Number.isInteger(Infinity)`
 * is `false` — since an unbounded budget is exactly the adversarial case the
 * caps exist to prevent. A valid finite non-negative integer passes through
 * unchanged.
 *
 * @param value - The candidate budget value
 * @param fallback - The default to use when `value` is not a finite
 *                    non-negative integer
 * @returns A finite non-negative integer budget
 *
 * @example
 * ```ts
 * sanitizeBudget(Number.NaN, INFER_DEPTH_LIMIT) // INFER_DEPTH_LIMIT
 * sanitizeBudget(-1, INFER_BREADTH_LIMIT)       // INFER_BREADTH_LIMIT
 * sanitizeBudget(4, INFER_DEPTH_LIMIT)          // 4
 * ```
 */
export function sanitizeBudget(value: number | undefined, fallback: number): number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : fallback
}

// === Reporting

/**
 * Render a short, safe, TOTAL preview of an unknown value for a {@link Fault}'s
 * `received` field.
 *
 * @remarks
 * A primitive renders as its literal: a string is `JSON.stringify`-escaped and
 * clipped to {@link PREVIEW_LIMIT} characters (with a trailing `…` when
 * clipped); a number / boolean / bigint / symbol renders via `String`; `null`
 * and `undefined` render as their own name. Everything else — a plain object,
 * an array, a function, a class instance, a `Map` — is NEVER traversed or
 * stringified; it renders as its bare `typeof` tag (`'object'` / `'function'`),
 * so a hostile or enormous structure can never blow up the preview.
 *
 * @param value - The value to preview
 * @returns A short descriptive string, always safe to embed in a diagnostic
 *
 * @example
 * ```ts
 * preview('hi')        // '"hi"'
 * preview(42)           // '42'
 * preview(null)         // 'null'
 * preview({ a: 1 })     // 'object'
 * preview([1, 2, 3])    // 'object'
 * ```
 */
export function preview(value: unknown): string {
	if (value === null) return 'null'
	if (value === undefined) return 'undefined'
	if (isString(value)) {
		const text = JSON.stringify(value)
		return text.length > PREVIEW_LIMIT ? `${text.slice(0, PREVIEW_LIMIT)}…` : text
	}
	if (isNumber(value) || isBoolean(value)) return String(value)
	if (isBigInt(value)) return `${value}n`
	if (isSymbol(value)) return value.toString()
	return typeof value
}

/**
 * Project a {@link ContractShape} to the {@link FaultKind} it describes.
 *
 * @remarks
 * A structural mapping used by {@link compileReporter} to fill a `Fault`'s
 * `expected` field: most shapes map to their own `type` (`numberShape` maps to
 * `'integer'` when `integer: true`, else `'number'`); `optionalShape` /
 * `nullableShape` project through to their inner shape's kind, and `rawShape`
 * (an arbitrary embedded schema with no fixed kind) projects to `'json'`.
 *
 * @param shape - The shape to project
 * @returns The shape's {@link FaultKind}
 *
 * @example
 * ```ts
 * shapeToKind(stringShape())            // 'string'
 * shapeToKind(integerShape())           // 'integer'
 * shapeToKind(optionalShape(nullShape())) // 'null'
 * ```
 */
export function shapeToKind(shape: ContractShape): FaultKind {
	switch (shape.type) {
		case 'string':
			return 'string'
		case 'number':
			return shape.integer === true ? 'integer' : 'number'
		case 'boolean':
			return 'boolean'
		case 'null':
			return 'null'
		case 'literal':
			return 'literal'
		case 'array':
			return 'array'
		case 'object':
			return 'object'
		case 'union':
			return 'union'
		case 'json':
			return 'json'
		case 'optional':
			return shapeToKind(shape.inner)
		case 'nullable':
			return shapeToKind(shape.inner)
		case 'raw':
			return 'json'
	}
}
