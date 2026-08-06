import type {
	ArrayRead,
	ContractCode,
	ContractShape,
	FaultKind,
	FieldPath,
	JSONSchema,
	JSONValue,
	RandomFunction,
	ReadValueOptions,
	Result,
} from './types.js'
import { PREVIEW_LIMIT } from './constants.js'
import { ContractError } from './errors.js'
import {
	isBigInt,
	isArray,
	isBoolean,
	isFiniteNumber,
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
 * The sanctioned never-throw boundary for the guards (AGENTS §14). The
 * `whereOf`, `lazyOf`, and `transformOf` combinators invoke caller-supplied
 * callbacks *inside* a guard body, yet a guard must NEVER throw — it returns a
 * `boolean`. This converts a throwing callback into a `Failure` so the
 * surrounding guard can treat it as a non-match instead of propagating the
 * exception, written once and shared rather than copy-pasted as ad-hoc
 * `try`/`catch`. The sole hand-written exception is {@link isContractError},
 * whose local boundary avoids an `errors` → `helpers` dependency inversion.
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
		try {
			const error = reason instanceof Error ? reason : new Error(String(reason))
			return { success: false, error }
		} catch {
			return { success: false, error: new Error('Unknown thrown value') }
		}
	}
}

/**
 * Read a value through the shared containment boundary or refuse it with the
 * contract module's uniform read diagnostic.
 *
 * @remarks
 * Unlike {@link attempt}, this is not an optional-result boundary: a caller
 * has committed to reading the supplied value, so a failed read cannot be
 * represented as absence or another permissive answer. Every reader using
 * this helper throws with the same `<reader>: <subject> could not be read`
 * message shape and retains the normalized host error as its cause. Required
 * structural readers use the defaults; pattern readers supply `pattern` for
 * both the subject and code.
 *
 * @param callback - The read operation to perform
 * @param reader - The public reader name used in the diagnostic
 * @param options - Optional subject, code, and structured context
 * @returns The successfully read value
 * @throws {ContractError} When the read operation fails
 *
 * @example
 * ```ts
 * readValue(() => source.value, 'parseRecord')
 * ```
 */
export function readValue<T>(callback: () => T, reader: string, options?: ReadValueOptions): T {
	const diagnostics = attempt(() => {
		const source = options?.context
		const context =
			source === undefined
				? undefined
				: {
						...(source.path === undefined ? {} : { path: source.path }),
						...(source.shape === undefined ? {} : { shape: source.shape }),
						...(source.limit === undefined ? {} : { limit: source.limit }),
						...(source.received === undefined ? {} : { received: source.received }),
					}
		const requested = options?.code
		const code: ContractCode =
			requested === 'bound' ||
			requested === 'range' ||
			requested === 'empty' ||
			requested === 'placement' ||
			requested === 'structure' ||
			requested === 'literal' ||
			requested === 'cycle' ||
			requested === 'pattern' ||
			requested === 'generate' ||
			requested === 'random' ||
			requested === 'clone' ||
			requested === 'depth'
				? requested
				: 'structure'
		return {
			reader: isString(reader) ? reader : 'readValue',
			subject: isString(options?.subject) ? options.subject : 'value',
			code,
			context,
		}
	})
	if (!diagnostics.success) {
		throw new ContractError('readValue: options could not be read', {
			code: 'structure',
			cause: diagnostics.error,
		})
	}
	const outcome = attempt(callback)
	if (!outcome.success) {
		throw new ContractError(
			`${diagnostics.value.reader}: ${diagnostics.value.subject} could not be read`,
			{
				code: diagnostics.value.code,
				...(diagnostics.value.context === undefined ? {} : { context: diagnostics.value.context }),
				cause: outcome.error,
			},
		)
	}
	return outcome.value
}

/**
 * Invoke a predicate through the sanctioned never-throw boundary.
 *
 * @param callback - The predicate to invoke with no arguments
 * @returns `true` only when the callback returns the boolean value `true`
 *
 * @example
 * ```ts
 * holds(() => value instanceof Widget) // false when inspection throws
 * ```
 */
export function holds(callback: () => boolean): boolean {
	const outcome = attempt(callback)
	return outcome.success && outcome.value === true
}

/**
 * Snapshot an array through its own indexed property view.
 *
 * @remarks
 * Array artifacts deliberately ignore a caller-defined iterator and agree on
 * the native index view. Missing indices are preserved as `undefined` and
 * reflected by `dense: false`. The result fails when length is outside the
 * native array domain, reflection throws, or the array's index views disagree.
 *
 * @param value - The array whose dense entries to read
 * @returns A successful frozen entry snapshot with its dense fact, or the failed read
 *
 * @example
 * ```ts
 * readArrayEntries([1, 2]) // { success: true, value: { entries: [1, 2], dense: true } }
 * ```
 */
export function readArrayEntries(value: readonly unknown[]): Result<ArrayRead> {
	return attempt(() => {
		const length = value.length
		if (!Number.isSafeInteger(length) || length < 0 || length > 2 ** 32 - 1) {
			throw new Error('Array length is outside the native array domain')
		}
		let indices = 0
		for (const key of Reflect.ownKeys(value)) {
			if (!isString(key)) continue
			const index = Number(key)
			if (Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && String(index) === key) {
				indices += 1
			}
		}
		const entries: unknown[] = []
		let present = 0
		for (let index = 0; index < length; index += 1) {
			if (Object.hasOwn(value, index)) {
				present += 1
				entries.push(value[index])
			} else {
				entries.push(undefined)
			}
		}
		if (indices !== present) throw new Error('Array index views disagree')
		return Object.freeze({ entries: Object.freeze(entries), dense: present === length })
	})
}

/**
 * Snapshot an object's own enumerable string keys through a total boundary.
 *
 * @remarks
 * This is the package-wide runtime property view used by compiled object
 * guards, parsers, reporters, schema inference, and owned schema cloning. It
 * matches the object-key view serialized by `JSON.stringify`: inherited,
 * symbol, and non-enumerable properties are excluded. A hostile Proxy trap
 * returns `undefined` rather than escaping.
 *
 * @param value - The object whose keys to snapshot
 * @returns A frozen owned key list, or `undefined` when enumeration throws
 *
 * @example
 * ```ts
 * enumerableKeys({ visible: 1 }) // ['visible']
 * ```
 */
export function enumerableKeys(value: object): readonly string[] | undefined {
	const outcome = attempt(() => Object.keys(value))
	return outcome.success ? Object.freeze([...outcome.value]) : undefined
}

/**
 * Validate and snapshot a shape-builder options record through every reflective
 * operation the builder relies on.
 *
 * @remarks
 * Primitive inputs are rejected before reflection so ordinary caller mistakes
 * retain the reader's precise plain-record diagnostic. For an object, every
 * consumed key is read exactly once, checked for presence, and inspected for an
 * own descriptor while the container is enumerated once. Every successfully
 * read non-`undefined` consumed value enters the fresh own-enumerable snapshot,
 * including an inherited or non-enumerable option. A hostile host is reported
 * uniformly as an unreadable options record, while a readable array or class
 * instance retains the plain-record diagnostic.
 *
 * @param source - The optional builder options value
 * @param keys - Every option key consumed by that builder
 * @param builder - The builder name used in diagnostics
 * @param shape - The shape category used in structured error context
 * @returns An owned options snapshot, or `undefined` when options are absent
 * @throws {ContractError} When the value is not a plain record or reflection fails
 *
 * @example
 * ```ts
 * const options = readOptions(source, ['min', 'max'], 'numberShape', 'number')
 * ```
 */
export function readOptions<T extends object>(
	source: T | undefined,
	keys: readonly (keyof T & string)[],
	builder: string,
	shape: string,
): T | undefined {
	if (source === undefined) return undefined
	const input: unknown = source
	if (!isObject(input)) {
		throw new ContractError(`${builder}: options must be a plain record`, {
			code: 'structure',
			context: { shape },
		})
	}
	const result = readValue(
		() => {
			const values = new Map<PropertyKey, unknown>()
			for (const key of keys) {
				values.set(key, Reflect.get(input, key))
				Reflect.has(input, key)
				Reflect.getOwnPropertyDescriptor(input, key)
			}
			Reflect.ownKeys(input)
			const array = Array.isArray(input)
			const prototype = Reflect.getPrototypeOf(input)
			const record = !array && (prototype === null || Reflect.getPrototypeOf(prototype) === null)
			const snapshot: T = Object.create(Object.prototype)
			for (const key of keys) {
				const value = values.get(key)
				if (value === undefined) continue
				Reflect.defineProperty(snapshot, key, {
					value,
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}
			return { snapshot, record }
		},
		builder,
		{ subject: 'options', context: { shape } },
	)
	if (!result.record) {
		throw new ContractError(`${builder}: options must be a plain record`, {
			code: 'structure',
			context: { shape },
		})
	}
	return result.snapshot
}

/**
 * Draw and validate one generator random sample.
 *
 * @param random - The caller-supplied random source
 * @param shape - The shape category consuming the sample
 * @returns A finite sample in `[0, 1)`
 * @throws {ContractError} When the source throws or returns outside `[0, 1)`
 *
 * @example
 * ```ts
 * drawRandom(() => 0.5, 'number') // 0.5
 * ```
 */
export function drawRandom(random: RandomFunction, shape: string): number {
	const outcome = attempt(random)
	if (!outcome.success) {
		throw new ContractError('drawRandom: the random source threw', {
			code: 'random',
			context: { shape, limit: '[0, 1)', received: 'threw' },
			cause: outcome.error,
		})
	}
	const sample = outcome.value
	if (!isFiniteNumber(sample) || sample < 0 || sample >= 1) {
		throw new ContractError('drawRandom: the random source must return a value in [0, 1)', {
			code: 'random',
			context: { shape, limit: '[0, 1)', received: String(sample) },
		})
	}
	return sample
}

// === Record-field access

/**
 * Resolve a (possibly nested) field value from a record by a key or key path.
 *
 * @remarks
 * A single `string` is ONE key (never split on `.`, so dotted keys are safe); a
 * string array descends left-to-right through own properties of nested objects.
 * The root must satisfy {@link isRecord}; inherited properties are never fields.
 * Intermediates may be objects or arrays indexed by string. Returns `undefined`
 * the moment a segment is missing or lands on a non-object, so the lookup is
 * total — even against a hostile getter or Proxy trap that throws on read,
 * contained via {@link attempt} so the throw never escapes.
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
	const outcome = attempt(() => {
		if (!isRecord(record)) return undefined
		const keys = isString(path) ? [path] : path
		let current: unknown = record
		for (const key of keys) {
			if (!isObject(current) || !Object.hasOwn(current, key)) return undefined
			current = Reflect.get(current, key)
		}
		return current
	})
	return outcome.success ? outcome.value : undefined
}

/**
 * Match an unknown value against the recursive JSON value structure.
 *
 * @remarks
 * The caller-owned ancestor set tracks only the active traversal path, so
 * cycles fail while shared references across sibling branches remain valid.
 * The set belongs to one traversal from one entry point; passing a shared or
 * pre-populated set is unsupported. Arrays recurse through the shared dense
 * own-index lens and plain records recurse by values; class instances and
 * non-finite numbers are rejected.
 *
 * @param entry - The value to inspect
 * @param ancestors - Objects on the active traversal path
 * @returns `true` when the value is a cycle-free JSON value
 *
 * @example
 * ```ts
 * matchesJSONValue({ nested: [1, 'x', null] }, new WeakSet()) // true
 * matchesJSONValue(Number.NaN, new WeakSet())                 // false
 * ```
 */
export function matchesJSONValue(entry: unknown, ancestors: WeakSet<object>): entry is JSONValue {
	return readValue(
		() => {
			if (entry === null || isString(entry) || isBoolean(entry) || isFiniteNumber(entry))
				return true
			if (Array.isArray(entry)) {
				if (ancestors.has(entry)) return false
				const snapshot = readArrayEntries(entry)
				if (!snapshot.success) throw snapshot.error
				if (!snapshot.value.dense) return false
				ancestors.add(entry)
				try {
					for (const value of snapshot.value.entries) {
						if (!matchesJSONValue(value, ancestors)) return false
					}
					return true
				} finally {
					ancestors.delete(entry)
				}
			}
			if (!isRecord(entry)) return false
			if (ancestors.has(entry)) return false
			ancestors.add(entry)
			const valid = Object.values(entry).every((value) => matchesJSONValue(value, ancestors))
			ancestors.delete(entry)
			return valid
		},
		'matchesJSONValue',
		{ context: { shape: 'json' } },
	)
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
	return readValue(() => {
		let count = 0
		for (const symbol of Object.getOwnPropertySymbols(value)) {
			if (Object.getOwnPropertyDescriptor(value, symbol)?.enumerable) {
				count += 1
			}
		}
		return count
	}, 'enumerableSymbolCount')
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
 * @throws {ContractError} When the schema cannot be read
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
	readValue(() => Object.values(schema), 'schemaToParameters')
	return isRecord(schema) ? schema : undefined
}

/**
 * Wrap a non-object `JSONSchema` root in a single-property object schema, so
 * an inferred primitive/array/union schema can flow into {@link schemaToParameters}
 * as an MCP-compatible `inputSchema`.
 *
 * @remarks
 * Deterministic for readable input. `schema.type === 'object'` passes through
 * unchanged; every other root (a primitive/array `type`, an `anyOf`/`enum`-only
 * schema with no `type`, or the empty `{}`) is wrapped as a single required
 * `value` property: `{ type: 'object', properties: { value: schema },
 * required: ['value'], additionalProperties: false }`. Composition:
 * `schemaToParameters(schemaToObject(valueToSchema(payload)))`.
 *
 * @param schema - The schema to wrap
 * @returns `schema` unchanged when object-rooted, otherwise the wrapped object schema
 * @throws {ContractError} When the schema root cannot be read
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
	return readValue(
		() => {
			Object.values(schema)
			if (schema.type === 'object') return schema
			return {
				type: 'object',
				properties: { value: schema },
				required: ['value'],
				additionalProperties: false,
			}
		},
		'schemaToObject',
		{ subject: 'schema' },
	)
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
	if (isArray(value)) return 'array'
	return typeof value
}

/**
 * Project a {@link ContractShape} to the {@link FaultKind} it describes.
 *
 * @remarks
 * A structural mapping used by {@link compileReporter} to fill a `Fault`'s
 * `expected` field and by {@link compileAuditor} to fill an `AuditFault`'s:
 * most shapes map to their own `type` (`numberShape` maps to
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
	return readValue(
		() => {
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
		},
		'shapeToKind',
		{ subject: 'shape' },
	)
}
