import type {
	DeferredInterface,
	Failure,
	FieldPath,
	JSONSchema,
	RandomFunction,
	Result,
	Success,
} from './types.js'
import { PLACEHOLDER_PATTERN } from './constants.js'
import { isObject, isRecord, isString } from './validators'

// === Result guards

/** Narrow a {@link Result} to its success branch. */
export function isSuccess<T, E>(result: Result<T, E>): result is Success<T> {
	return result.success
}

/** Narrow a {@link Result} to its failure branch. */
export function isFailure<T, E>(result: Result<T, E>): result is Failure<E> {
	return !result.success
}

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
		return {
			success: false,
			error: reason instanceof Error ? reason : new Error(String(reason)),
		}
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
 * lookup is total.
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
		current = Reflect.get(current, key)
	}
	return current
}

/**
 * Format a {@link FieldPath} for display — the single string key itself, or the
 * array segments joined with `.`.
 *
 * @remarks
 * Display-only: the joined form is how a field appears in traces and derived
 * overlays; it is NOT re-parsed into a path (a string stays ONE key).
 *
 * @param field - The field path to format
 * @returns The display string
 *
 * @example
 * ```ts
 * import { formatField } from '@src/core'
 *
 * formatField('age')               // 'age'
 * formatField(['address', 'city']) // 'address.city'
 * ```
 */
export function formatField(field: FieldPath): string {
	return isString(field) ? field : field.join('.')
}

/**
 * Set a field value on a mutable working record.
 *
 * @remarks
 * A single `string` is ONE key and is never split on `.`, matching
 * {@link resolveField}; pass an array path to descend through nested records.
 * Array paths create missing intermediate records and overwrite non-record
 * intermediates with records so the final segment can be written. An empty
 * array path is a no-op. This mutates the supplied record by design: it is the
 * primitive for building a working record copy.
 *
 * Prototype-pollution defense: an array path whose segments name `__proto__`,
 * `constructor`, or `prototype` — and a single-string `__proto__` write — are
 * refused (a no-op), so no prototype object can ever be reached or mutated. A
 * legitimate data field is never named these keys, so every real write is
 * unaffected.
 *
 * @param record - The mutable working record to update
 * @param field - A literal key or nested key path to write
 * @param value - The value to place at the field
 * @returns Nothing
 *
 * @example
 * ```ts
 * const record: Record<string, unknown> = {}
 * setField(record, ['user', 'name'], 'Ada')
 * setField(record, 'flat.key', 7)
 * // record === { user: { name: 'Ada' }, 'flat.key': 7 }
 * ```
 */
export function setField(record: Record<string, unknown>, field: FieldPath, value: unknown): void {
	// Prototype-pollution defense. Descending an array path can walk INTO a prototype
	// object (e.g. `['__proto__', k]` reaches `Object.prototype`), so any segment naming
	// `__proto__` / `constructor` / `prototype` refuses the whole write. A single-string
	// key is a leaf write, so only `__proto__` (whose accessor mutates the record's own
	// prototype) is refused; `constructor` / `prototype` there are inert own properties.
	if (isString(field)) {
		if (field === '__proto__') return
		record[field] = value
		return
	}
	if (field.includes('__proto__') || field.includes('constructor') || field.includes('prototype')) {
		return
	}
	let current: Record<string, unknown> = record
	for (let index = 0; index < field.length; index += 1) {
		const key = field[index]
		if (key === undefined) continue
		if (index === field.length - 1) {
			current[key] = value
			continue
		}
		const next = current[key]
		if (isRecord(next)) {
			current = next
		} else {
			const created: Record<string, unknown> = {}
			current[key] = created
			current = created
		}
	}
}

/**
 * Copy a record while omitting keys whose value is `undefined`.
 *
 * @remarks
 * The input is never mutated. `null` is preserved because only `undefined`
 * represents an absent optional field for these record-shaping helpers. An
 * absent input returns a fresh empty object.
 *
 * @param value - The optional source record to copy
 * @returns A new record containing every defined entry
 *
 * @example
 * ```ts
 * omitUndefined({ a: 1, b: undefined, c: null }) // { a: 1, c: null }
 * omitUndefined()                                // {}
 * ```
 */
export function omitUndefined(value?: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const output: Record<string, unknown> = {}
	if (!value) return output
	for (const key of Object.keys(value)) {
		const entry = value[key]
		if (entry !== undefined) output[key] = entry
	}
	return output
}

// === Immutability

/**
 * Clone records and arrays without relying on host globals.
 *
 * @remarks
 * This is the ESNext-pure replacement for host cloning inside strict core.
 * Plain records and arrays are rebuilt recursively. Primitives and non-record
 * objects such as functions, class instances, and `Date`s are returned by
 * reference. Cyclic structures throw a `TypeError`; shared DAG subtrees are
 * cloned independently and do not count as cycles.
 *
 * @param value - The value to clone
 * @returns The cloned value, or the original reference for primitives and
 *          non-record objects
 *
 * @example
 * ```ts
 * cloneValue({ nested: [1] }) // { nested: [1] }
 * cloneValue(new Date())      // the same Date reference
 * ```
 */
export function cloneValue(value: unknown): unknown {
	const ancestors = new WeakSet<object>()
	const clone = (entry: unknown): unknown => {
		if (Array.isArray(entry)) {
			if (ancestors.has(entry)) throw new TypeError('Cannot clone cyclic value')
			ancestors.add(entry)
			const output = entry.map(clone)
			ancestors.delete(entry)
			return output
		}
		if (isRecord(entry)) {
			if (ancestors.has(entry)) throw new TypeError('Cannot clone cyclic value')
			ancestors.add(entry)
			const output: Record<string, unknown> = {}
			for (const key of Object.keys(entry)) output[key] = clone(entry[key])
			ancestors.delete(entry)
			return output
		}
		return entry
	}
	return clone(value)
}

/**
 * Deep-freeze an object graph in place and return the same value.
 *
 * @remarks
 * Every reachable object is frozen with `Object.freeze`; the argument itself is
 * mutated when it is an object. A WeakSet tracks the active ancestor chain and
 * throws a `TypeError` for true cycles, while shared DAG subtrees are allowed.
 * Callers that need the original input untouched should clone first, for
 * example `freezeValue(cloneValue(value))`.
 *
 * @param value - The value whose object graph should be frozen
 * @returns The same value reference after freezing
 *
 * @example
 * ```ts
 * const value = { nested: { count: 1 } }
 * freezeValue(value) === value // true
 * Object.isFrozen(value.nested) // true
 * ```
 */
export function freezeValue<T>(value: T): T {
	const ancestors = new WeakSet<object>()
	const freeze = (entry: unknown): void => {
		if (!isObject(entry)) return
		if (ancestors.has(entry)) throw new TypeError('Cannot freeze cyclic value')
		ancestors.add(entry)
		Object.freeze(entry)
		for (const child of Object.values(entry)) freeze(child)
		ancestors.delete(entry)
	}
	freeze(value)
	return value
}

// === Pattern matching

/**
 * Escape every regex metacharacter in a string so its literal parts stay literal
 * when embedded in a `RegExp`.
 *
 * @remarks
 * Replaces each of `. * + ? ^ $ { } ( ) | [ ] \` with its backslash-escaped form
 * (`text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')`), so a value supplied by a caller
 * can be spliced into a pattern without being interpreted as regex syntax. Used
 * wherever a wildcard pattern (SQL `LIKE`, `GLOB`) compiles to a `RegExp` and its
 * non-wildcard characters must match verbatim.
 *
 * @param text - The string whose regex metacharacters to escape
 * @returns The string with every regex metacharacter backslash-escaped
 *
 * @example
 * ```ts
 * escapeRegExp('a.b*c')          // 'a\\.b\\*c'
 * new RegExp(escapeRegExp('1+1')) // matches the literal '1+1'
 * ```
 */
export function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// === Deferred

/**
 * Create a manually-settled promise handle: a {@link DeferredInterface} whose
 * `resolve` / `reject` are lifted out of the promise executor.
 *
 * @remarks
 * The standard captured-resolver pattern — the executor runs synchronously, so
 * the two settle functions are captured before construction returns. They start
 * as no-op defaults purely so the bindings type as functions without a
 * non-null assertion; the executor overwrites both immediately. Use this when an
 * operation must settle a promise from outside the executor body (a pump that
 * resolves on completion, a count-based completion gate). The promise obeys
 * native settle-once semantics: the first `resolve` / `reject` wins and later
 * calls are no-ops on the promise.
 *
 * @returns A handle exposing the `promise` plus its `resolve` / `reject`
 *
 * @example
 * ```ts
 * const gate = createDeferred<number>()
 * setTimeout(() => gate.resolve(42), 10)
 * const value = await gate.promise // 42
 * ```
 */
export function createDeferred<T>(): DeferredInterface<T> {
	let resolve: (value: T) => void = () => {}
	let reject: (error: unknown) => void = () => {}
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

// === String utilities

/**
 * Substitute `{{ name }}` markers in a message template from a record.
 *
 * @remarks
 * Markers are whitespace-tolerant inside the braces and capture identifier
 * paths, so `{{ location.zone }}` descends through nested records. Missing or
 * undeclared values are left literal, and non-identifier content such as
 * `{{not valid}}` never matches. Repeated markers substitute every occurrence.
 * Dotted markers always address nested fields — a top-level key that itself
 * contains a dot is not addressable through this marker grammar. A finite
 * numeric value renders with thousands separators on its integer part
 * (`2000000` → `2,000,000`), locale-independent, so large interpolated numbers
 * and counts read naturally.
 *
 * @param template - The message template containing zero or more markers
 * @param record - The record used to resolve marker paths
 * @returns The template with resolvable markers substituted
 *
 * @example
 * ```ts
 * interpolateMessage('Value {{ value }}', { value: 42 }) // 'Value 42'
 * interpolateMessage('{{ missing }}', {})                // '{{ missing }}'
 * ```
 */
export function interpolateMessage(
	template: string,
	record: Readonly<Record<string, unknown>>,
): string {
	// A fresh RegExp resets `lastIndex` so global `replace` starts clean each call.
	const pattern = new RegExp(PLACEHOLDER_PATTERN.source, PLACEHOLDER_PATTERN.flags)
	return template.replace(pattern, (marker: string, path: string): string => {
		const value = resolveField(record, path.includes('.') ? path.split('.') : path)
		if (value === undefined) return marker
		// Finite numbers render with thousands separators on the integer part
		// (locale-independent, pure ECMAScript) so a large value interpolated
		// into a message reads as `2,000,000`, not `2000000`. Sub-thousand values
		// (small counts, codes) group to themselves, so no existing message changes.
		if (typeof value === 'number' && Number.isFinite(value)) {
			const [integer, fraction] = Math.abs(value).toString().split('.')
			const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
			return `${value < 0 ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`
		}
		return String(value)
	})
}

/**
 * Slugify a name into a URL-safe id — lowercased, runs of non-alphanumerics
 * collapsed to a single hyphen, leading / trailing hyphens trimmed.
 *
 * @remarks
 * A pure, deterministic string transform (`'Show Opens Dialog'` →
 * `'show-opens-dialog'`), environment-agnostic so it lives in the shared core
 * layer rather than any one environment: lowercase, hyphen-separated, edge-trimmed
 * output suitable for URL fragments and anchor ids. An all-separator input yields
 * the empty string; the caller supplies any fallback.
 *
 * @param name - The human name to slugify
 * @returns The slug — lowercase, hyphen-separated, edge-trimmed
 *
 * @example
 * ```ts
 * slugify('Turn On!')   // 'turn-on'
 * slugify('a   b___c')  // 'a-b-c'
 * slugify('   ')        // ''
 * ```
 */
export function slugify(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
}

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
