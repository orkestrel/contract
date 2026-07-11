import type {
	AnyAsyncFunction,
	AnyConstructor,
	AnyFunction,
	JSONPrimitive,
	JSONValue,
	ZeroArgAsyncFunction,
	ZeroArgFunction,
} from './types.js'
import { attempt, enumerableSymbolCount } from './helpers.js'

// AGENTS §14: guards are total functions — a guard NEVER throws. Adversarial
// input (hostile getters, exotic objects, cycles) returns `false`, never an
// error. Most guards here are a single structural test with no user callbacks,
// so totality is immediate. The reflective guards — those that probe a
// property through `Reflect.get` or walk a structure (`isPromiseLike`,
// `isIterable`, `isAsyncIterable`, `isJSONValue`, `isRecord`) can hit a hostile
// getter or a revoked `Proxy` that throws mid-probe, so totality is NOT
// automatic for them — each contains its probe/walk in `attempt` (see
// ./helpers.js) and returns `false` on a caught throw.

// === Primitive guards

/** Determine whether a value is `null`. */
export function isNull(value: unknown): value is null {
	return value === null
}

/** Determine whether a value is `undefined`. */
export function isUndefined(value: unknown): value is undefined {
	return value === undefined
}

/** Determine whether a value is defined (neither `null` nor `undefined`). */
export function isDefined<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined
}

/** Determine whether a value is a string. */
export function isString(value: unknown): value is string {
	return typeof value === 'string'
}

/**
 * Determine whether a value is a number.
 *
 * @remarks
 * Includes `NaN` and `±Infinity` — use {@link isFiniteNumber} to exclude them.
 */
export function isNumber(value: unknown): value is number {
	return typeof value === 'number'
}

/** Determine whether a value is a finite number (excludes `NaN` and `±Infinity`). */
export function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

/** Determine whether a value is a finite integer (excludes `NaN`, `±Infinity`, and fractional numbers). */
export function isInteger(value: unknown): value is number {
	return Number.isInteger(value)
}

/** Determine whether a value is a boolean. */
export function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean'
}

/** Determine whether a value is exactly `true`. */
export function isTrue(value: unknown): value is true {
	return value === true
}

/** Determine whether a value is exactly `false`. */
export function isFalse(value: unknown): value is false {
	return value === false
}

/** Determine whether a value is a bigint. */
export function isBigInt(value: unknown): value is bigint {
	return typeof value === 'bigint'
}

/** Determine whether a value is a symbol. */
export function isSymbol(value: unknown): value is symbol {
	return typeof value === 'symbol'
}

/** Determine whether a value is callable. */
export function isFunction(value: unknown): value is AnyFunction {
	return typeof value === 'function'
}

/** Determine whether a value is a string or `null`. */
export function isNullableString(value: unknown): value is string | null {
	return value === null || isString(value)
}

/** Determine whether a value is a number or `null` (the number may be `NaN` / `±Infinity`). */
export function isNullableNumber(value: unknown): value is number | null {
	return value === null || isNumber(value)
}

/** Determine whether a value is a boolean or `null`. */
export function isNullableBoolean(value: unknown): value is boolean | null {
	return value === null || isBoolean(value)
}

// === Built-in guards
//
// The `instanceof`-based guard families below (Date/RegExp/Error/Promise,
// Map/Set/WeakMap/WeakSet, the typed-array guards) are same-realm checks:
// `instanceof` compares against the constructor's prototype in the CURRENT
// realm, so a value built by another realm (a different `vm.Context`, iframe,
// or worker global) fails even when it is structurally identical. This is a
// known, accepted limitation — cross-realm identity would require duck-typing
// every built-in, which trades soundness for portability.

/** Determine whether a value is a `Date`. */
export function isDate(value: unknown): value is Date {
	return value instanceof Date
}

/** Determine whether a value is a `RegExp`. */
export function isRegExp(value: unknown): value is RegExp {
	return value instanceof RegExp
}

/** Determine whether a value is an `Error`. */
export function isError(value: unknown): value is Error {
	return value instanceof Error
}

/** Determine whether a value is a native `Promise` (use {@link isPromiseLike} for any thenable). */
export function isPromise<T = unknown>(value: unknown): value is Promise<T> {
	return value instanceof Promise
}

/**
 * Determine whether a value is promise-like — an object exposing callable
 * `then`, `catch`, and `finally` methods.
 *
 * @remarks
 * Accepts any object with all three methods, not only native `Promise`
 * instances. Use {@link isPromise} when you specifically need `instanceof Promise`.
 */
export function isPromiseLike<T = unknown>(
	value: unknown,
): value is Promise<T> | (PromiseLike<T> & { catch: unknown; finally: unknown }) {
	if (!isObject(value)) {
		return false
	}
	const outcome = attempt(() => {
		const thenValue = Reflect.get(value, 'then')
		const catchValue = Reflect.get(value, 'catch')
		const finallyValue = Reflect.get(value, 'finally')
		return isFunction(thenValue) && isFunction(catchValue) && isFunction(finallyValue)
	})
	return outcome.success && outcome.value
}

/** Determine whether a value is an `ArrayBuffer`. */
export function isArrayBuffer(value: unknown): value is ArrayBuffer {
	return value instanceof ArrayBuffer
}

/**
 * Determine whether a value is a `SharedArrayBuffer`.
 *
 * @remarks
 * Guards the global existence of `SharedArrayBuffer` first — safe where it is
 * absent or disabled (e.g. a context that is not cross-origin isolated).
 */
export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
	return typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer
}

// === Protocol guards

/**
 * Determine whether a value implements the iterable protocol (`Symbol.iterator`).
 *
 * @remarks
 * Strings are explicitly included: a string has a callable `Symbol.iterator`
 * but is not an object, so the generic object path alone would miss it.
 */
export function isIterable<T = unknown>(value: unknown): value is Iterable<T> {
	if (isString(value)) {
		return true
	}
	if (!isObject(value)) {
		return false
	}
	const outcome = attempt(() => isFunction(Reflect.get(value, Symbol.iterator)))
	return outcome.success && outcome.value
}

/** Determine whether a value implements the async iterable protocol (`Symbol.asyncIterator`). */
export function isAsyncIterable<T = unknown>(value: unknown): value is AsyncIterable<T> {
	if (!isObject(value)) {
		return false
	}
	const outcome = attempt(() => isFunction(Reflect.get(value, Symbol.asyncIterator)))
	return outcome.success && outcome.value
}

// === Object & collection guards

/**
 * Determine whether a value is a non-null object.
 *
 * @remarks
 * `true` for arrays, class instances, plain objects, `Map`, `Set`, etc. — use
 * {@link isRecord} when you need a plain-record check.
 */
export function isObject(value: unknown): value is object {
	return typeof value === 'object' && value !== null
}

/**
 * Determine whether a value is a plain record (object literal or null-prototype),
 * not an array or class instance.
 *
 * @remarks
 * Use instead of {@link isObject} to distinguish a plain `{}` /
 * `Object.create(null)` from arrays, `Date`, `Map`, etc. The prototype-chain
 * test is realm-agnostic: rather than comparing against the current realm's
 * `Object.prototype` (which a plain object from another `vm.Context`, iframe,
 * or worker would fail), it accepts any value whose prototype is `null`, OR
 * whose prototype's own prototype is `null` — the shape every plain object
 * has in every realm, since `Object.prototype` itself always sits one step
 * above `null`. Arrays and class instances are still rejected: an array's
 * prototype chain runs through `Array.prototype` before `null`, and a class
 * instance's runs through the class's own prototype. The whole body runs
 * inside `attempt` (AGENTS §14) so a revoked `Proxy` or a hostile
 * `getPrototypeOf` trap cannot escape as a thrown error.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	const outcome = attempt(() => {
		if (!isObject(value) || isArray(value)) {
			return false
		}
		const prototype = Object.getPrototypeOf(value)
		return prototype === null || Object.getPrototypeOf(prototype) === null
	})
	return outcome.success && outcome.value
}

/** Determine whether a value is a `Map`. */
export function isMap<K = unknown, V = unknown>(value: unknown): value is ReadonlyMap<K, V> {
	return value instanceof Map
}

/** Determine whether a value is a `Set`. */
export function isSet<T = unknown>(value: unknown): value is ReadonlySet<T> {
	return value instanceof Set
}

/** Determine whether a value is a `WeakMap`. */
export function isWeakMap(value: unknown): value is WeakMap<object, unknown> {
	return value instanceof WeakMap
}

/** Determine whether a value is a `WeakSet`. */
export function isWeakSet(value: unknown): value is WeakSet<object> {
	return value instanceof WeakSet
}

// === Array & typed-array guards

/** Determine whether a value is an array. */
export function isArray<T = unknown>(value: unknown): value is readonly T[] {
	return Array.isArray(value)
}

/** Determine whether a value is a `DataView`. */
export function isDataView(value: unknown): value is DataView<ArrayBufferLike> {
	return value instanceof DataView
}

/** Determine whether a value is an `ArrayBufferView` (any typed array or `DataView`). */
export function isArrayBufferView(value: unknown): value is ArrayBufferView {
	return ArrayBuffer.isView(value)
}

/** Determine whether a value is an `Int8Array`. */
export function isInt8Array(value: unknown): value is Int8Array {
	return value instanceof Int8Array
}

/** Determine whether a value is a `Uint8Array`. */
export function isUint8Array(value: unknown): value is Uint8Array {
	return value instanceof Uint8Array
}

/** Determine whether a value is a `Uint8ClampedArray`. */
export function isUint8ClampedArray(value: unknown): value is Uint8ClampedArray {
	return value instanceof Uint8ClampedArray
}

/** Determine whether a value is an `Int16Array`. */
export function isInt16Array(value: unknown): value is Int16Array {
	return value instanceof Int16Array
}

/** Determine whether a value is a `Uint16Array`. */
export function isUint16Array(value: unknown): value is Uint16Array {
	return value instanceof Uint16Array
}

/** Determine whether a value is an `Int32Array`. */
export function isInt32Array(value: unknown): value is Int32Array {
	return value instanceof Int32Array
}

/** Determine whether a value is a `Uint32Array`. */
export function isUint32Array(value: unknown): value is Uint32Array {
	return value instanceof Uint32Array
}

/** Determine whether a value is a `Float32Array`. */
export function isFloat32Array(value: unknown): value is Float32Array {
	return value instanceof Float32Array
}

/** Determine whether a value is a `Float64Array`. */
export function isFloat64Array(value: unknown): value is Float64Array {
	return value instanceof Float64Array
}

/**
 * Determine whether a value is a `BigInt64Array`.
 *
 * @remarks
 * Guards the global existence of `BigInt64Array` first — safe in environments
 * that pre-date the BigInt typed-array additions.
 */
export function isBigInt64Array(value: unknown): value is BigInt64Array {
	return typeof BigInt64Array !== 'undefined' && value instanceof BigInt64Array
}

/**
 * Determine whether a value is a `BigUint64Array`.
 *
 * @remarks
 * Guards the global existence of `BigUint64Array` first — safe in environments
 * that pre-date the BigInt typed-array additions.
 */
export function isBigUint64Array(value: unknown): value is BigUint64Array {
	return typeof BigUint64Array !== 'undefined' && value instanceof BigUint64Array
}

// === Emptiness guards

/** Determine whether a value is the empty string `''`. */
export function isEmptyString(value: unknown): value is '' {
	return isString(value) && value.length === 0
}

/** Determine whether a value is an empty array. */
export function isEmptyArray(value: unknown): value is readonly [] {
	return isArray(value) && value.length === 0
}

/** Determine whether a value is an empty plain object (no own string or enumerable symbol keys). */
export function isEmptyObject(value: unknown): value is Record<string | symbol, never> {
	if (!isRecord(value)) {
		return false
	}
	return Object.keys(value).length === 0 && enumerableSymbolCount(value) === 0
}

/** Determine whether a value is an empty `Map`. */
export function isEmptyMap(value: unknown): value is ReadonlyMap<never, never> {
	return value instanceof Map && value.size === 0
}

/** Determine whether a value is an empty `Set`. */
export function isEmptySet(value: unknown): value is ReadonlySet<never> {
	return value instanceof Set && value.size === 0
}

/** Determine whether a value is a non-empty string (at least one character). */
export function isNonEmptyString(value: unknown): value is string {
	return isString(value) && value.length > 0
}

/** Determine whether a value is a non-empty array (at least one element). */
export function isNonEmptyArray<T = unknown>(value: unknown): value is readonly [T, ...T[]] {
	return isArray(value) && value.length > 0
}

/** Determine whether a value is a non-empty plain object (at least one own string or enumerable symbol key). */
export function isNonEmptyObject(value: unknown): value is Record<string | symbol, unknown> {
	if (!isRecord(value)) {
		return false
	}
	return Object.keys(value).length > 0 || enumerableSymbolCount(value) > 0
}

/** Determine whether a value is a non-empty `Map` (at least one entry). */
export function isNonEmptyMap<K = unknown, V = unknown>(
	value: unknown,
): value is ReadonlyMap<K, V> {
	return value instanceof Map && value.size > 0
}

/** Determine whether a value is a non-empty `Set` (at least one element). */
export function isNonEmptySet<T = unknown>(value: unknown): value is ReadonlySet<T> {
	return value instanceof Set && value.size > 0
}

// === Function guards

/** Determine whether a value is a function that declares zero parameters (`Function.length === 0`). */
export function isZeroArg(value: unknown): value is ZeroArgFunction {
	return isFunction(value) && value.length === 0
}

/**
 * Determine whether a value is a native `async function`.
 *
 * @remarks
 * Uses `constructor.name === 'AsyncFunction'` — not `instanceof`, which is
 * unreliable across realms. The `?.` keeps the guard total (§14): a function
 * whose `constructor` was nulled yields `undefined`, never a thrown `null.name`.
 */
export function isAsyncFunction(value: unknown): value is AnyAsyncFunction {
	return isFunction(value) && value.constructor?.name === 'AsyncFunction'
}

/** Determine whether a value is a generator function (`function*`). */
export function isGeneratorFunction(
	value: unknown,
): value is (...args: unknown[]) => Generator<unknown, unknown, unknown> {
	return isFunction(value) && value.constructor?.name === 'GeneratorFunction'
}

/** Determine whether a value is an async generator function (`async function*`). */
export function isAsyncGeneratorFunction(
	value: unknown,
): value is (...args: unknown[]) => AsyncGenerator<unknown, unknown, unknown> {
	return isFunction(value) && value.constructor?.name === 'AsyncGeneratorFunction'
}

/** Determine whether a value is a zero-argument async function. */
export function isZeroArgAsync(value: unknown): value is ZeroArgAsyncFunction {
	return isZeroArg(value) && isAsyncFunction(value)
}

/** Determine whether a value is a zero-argument generator function. */
export function isZeroArgGenerator(
	value: unknown,
): value is () => Generator<unknown, unknown, unknown> {
	return isZeroArg(value) && isGeneratorFunction(value)
}

/** Determine whether a value is a zero-argument async generator function. */
export function isZeroArgAsyncGenerator(
	value: unknown,
): value is () => AsyncGenerator<unknown, unknown, unknown> {
	return isZeroArg(value) && isAsyncGeneratorFunction(value)
}

/**
 * Determine whether a value can be used as a `new`-target constructor.
 *
 * @remarks
 * Probes with `Reflect.construct(String, [], value)`: a real constructor
 * succeeds, while arrow functions, plain functions, and non-functions throw
 * and yield `false`. Never throws. Backs the `instanceOf` combinator.
 */
export function isConstructor(value: unknown): value is AnyConstructor<object> {
	if (!isFunction(value)) {
		return false
	}
	try {
		Reflect.construct(String, [], value)
		return true
	} catch {
		return false
	}
}

// === JSON

/**
 * Determine whether a value is a cycle-safe JSON value.
 *
 * @remarks
 * Total guard: never throws, returns `false` for cycles, functions, `Date`
 * instances, class instances, `NaN`, and `±Infinity`. Arrays and plain records
 * are walked with an ancestor set so recursive input fails instead of hanging.
 * The whole walk runs inside `attempt` (AGENTS §14): a hostile getter on a
 * record property, or a revoked `Proxy` anywhere in the structure, is caught
 * and yields `false` instead of escaping as a thrown error.
 *
 * @param value - The value to test
 * @returns `true` when the value has a JSON representation
 *
 * @example
 * ```ts
 * isJSONValue({ nested: [1, 'x', null] }) // true
 * isJSONValue(Number.NaN)                 // false
 * ```
 */
export function isJSONValue(value: unknown): value is JSONValue {
	const ancestors = new WeakSet<object>()
	const check = (entry: unknown): entry is JSONValue => {
		if (entry === null || isString(entry) || isBoolean(entry) || isFiniteNumber(entry)) return true
		if (Array.isArray(entry)) {
			if (ancestors.has(entry)) return false
			ancestors.add(entry)
			const valid = entry.every(check)
			ancestors.delete(entry)
			return valid
		}
		if (!isRecord(entry)) return false
		if (ancestors.has(entry)) return false
		ancestors.add(entry)
		const valid = Object.values(entry).every(check)
		ancestors.delete(entry)
		return valid
	}
	const outcome = attempt(() => check(value))
	return outcome.success && outcome.value
}

/**
 * Determine whether a value is a primitive JSON value.
 *
 * @remarks
 * The flat leaf of any JSON document: `null`, a string, a **finite** number, or
 * a boolean. Uses {@link isFiniteNumber} (not {@link isNumber}) because real JSON
 * carries no `NaN` / `±Infinity` — `JSON.stringify(NaN)` is `'null'`.
 *
 * The recursive {@link isJSONValue} guard is shipped and stays total with
 * cycle-safe walking. Dedicated `isJSONObject` / `isJSONSchema` validators and
 * the broad `JSONSchemaDefinition` remain omitted; compose narrower shapes with
 * the combinators and gate untrusted strings with `parseJSON` / `parseJSONAs`.
 *
 * @param value - The value to test
 * @returns `true` when `value` is `null`, a string, a finite number, or a boolean
 *
 * @example
 * ```ts
 * isJSONPrimitive(null)        // true
 * isJSONPrimitive('hi')        // true
 * isJSONPrimitive(42)          // true
 * isJSONPrimitive(Number.NaN)  // false — not representable in JSON
 * isJSONPrimitive({})          // false
 * ```
 */
export function isJSONPrimitive(value: unknown): value is JSONPrimitive {
	return isNull(value) || isString(value) || isFiniteNumber(value) || isBoolean(value)
}
