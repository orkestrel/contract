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
// error. Guards built from a single `typeof` / strict-equality test are
// immediately total — no probe of the value's internals can throw. Every
// OTHER guard here probes the value in some way — a property read through
// `Reflect.get`, a structural walk (`isPromiseLike`, `isIterable`,
// `isAsyncIterable`, `isJSONValue`, `isRecord`), an `instanceof` check (which
// invokes the target's `[Symbol.hasInstance]` / triggers a `getPrototypeOf`
// trap), or an own-key enumeration (`isEmptyObject` / `isNonEmptyObject`) —
// so a hostile getter, a revoked `Proxy`, or an exotic trap can throw
// mid-probe. Totality is NOT automatic for these: each contains its
// probe/walk in `attempt` (see ./helpers.js) and returns `false` on a caught
// throw. Every `instanceof`-based guard in this file routes through the
// shared {@link isInstance} helper, which is the one place that containment
// lives for that family.

// === Primitive guards

/** Determine whether a value is `null`.
 *
 * @example
 * ```ts
 * isNull(null)      // true
 * isNull(undefined) // false
 * ```
 */
export function isNull(value: unknown): value is null {
	return value === null
}

/** Determine whether a value is `undefined`.
 *
 * @example
 * ```ts
 * isUndefined(undefined) // true
 * isUndefined(null)      // false
 * ```
 */
export function isUndefined(value: unknown): value is undefined {
	return value === undefined
}

/** Determine whether a value is defined (neither `null` nor `undefined`).
 *
 * @example
 * ```ts
 * isDefined('hi')     // true
 * isDefined(null)     // false
 * isDefined(undefined) // false
 * ```
 */
export function isDefined<T>(value: T | null | undefined): value is T {
	return value !== null && value !== undefined
}

/** Determine whether a value is a string.
 *
 * @example
 * ```ts
 * isString('hi') // true
 * isString(42)   // false
 * ```
 */
export function isString(value: unknown): value is string {
	return typeof value === 'string'
}

/**
 * Determine whether a value is a number.
 *
 * @remarks
 * Includes `NaN` and `±Infinity` — use {@link isFiniteNumber} to exclude them.
 *
 * @example
 * ```ts
 * isNumber(42)         // true
 * isNumber(Number.NaN) // true — NaN is still a number
 * isNumber('42')       // false
 * ```
 */
export function isNumber(value: unknown): value is number {
	return typeof value === 'number'
}

/** Determine whether a value is a finite number (excludes `NaN` and `±Infinity`).
 *
 * @example
 * ```ts
 * isFiniteNumber(42)         // true
 * isFiniteNumber(Number.NaN) // false
 * isFiniteNumber(Infinity)   // false
 * ```
 */
export function isFiniteNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isFinite(value)
}

/** Determine whether a value is a finite integer (excludes `NaN`, `±Infinity`, and fractional numbers).
 *
 * @example
 * ```ts
 * isInteger(3)   // true
 * isInteger(3.5) // false
 * ```
 */
export function isInteger(value: unknown): value is number {
	return Number.isInteger(value)
}

/** Determine whether a value is a boolean.
 *
 * @example
 * ```ts
 * isBoolean(true) // true
 * isBoolean(1)    // false
 * ```
 */
export function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean'
}

/** Determine whether a value is exactly `true`.
 *
 * @example
 * ```ts
 * isTrue(true)  // true
 * isTrue(false) // false
 * ```
 */
export function isTrue(value: unknown): value is true {
	return value === true
}

/** Determine whether a value is exactly `false`.
 *
 * @example
 * ```ts
 * isFalse(false) // true
 * isFalse(true)  // false
 * ```
 */
export function isFalse(value: unknown): value is false {
	return value === false
}

/** Determine whether a value is a bigint.
 *
 * @example
 * ```ts
 * isBigInt(1n) // true
 * isBigInt(1)  // false
 * ```
 */
export function isBigInt(value: unknown): value is bigint {
	return typeof value === 'bigint'
}

/** Determine whether a value is a symbol.
 *
 * @example
 * ```ts
 * isSymbol(Symbol('x')) // true
 * isSymbol('x')         // false
 * ```
 */
export function isSymbol(value: unknown): value is symbol {
	return typeof value === 'symbol'
}

/** Determine whether a value is callable.
 *
 * @example
 * ```ts
 * isFunction(() => {}) // true
 * isFunction({})       // false
 * ```
 */
export function isFunction(value: unknown): value is AnyFunction {
	return typeof value === 'function'
}

/** Determine whether a value is a string or `null`.
 *
 * @example
 * ```ts
 * isNullableString('hi') // true
 * isNullableString(null) // true
 * isNullableString(42)   // false
 * ```
 */
export function isNullableString(value: unknown): value is string | null {
	return value === null || isString(value)
}

/** Determine whether a value is a number or `null` (the number may be `NaN` / `±Infinity`).
 *
 * @example
 * ```ts
 * isNullableNumber(42)   // true
 * isNullableNumber(null) // true
 * isNullableNumber('hi') // false
 * ```
 */
export function isNullableNumber(value: unknown): value is number | null {
	return value === null || isNumber(value)
}

/** Determine whether a value is a boolean or `null`.
 *
 * @example
 * ```ts
 * isNullableBoolean(true) // true
 * isNullableBoolean(null) // true
 * isNullableBoolean(1)    // false
 * ```
 */
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

/**
 * Determine whether a value is an instance of a constructor, contained against
 * a throwing `instanceof` check.
 *
 * @remarks
 * The low-level total helper every `instanceof`-based guard in this file (and
 * the `instanceOf` combinator) routes through. A bare `value instanceof X` is
 * NOT total (AGENTS §14): it invokes `getPrototypeOf` on `value` — which a
 * revoked `Proxy` or a `getPrototypeOf`-trap `Proxy` throws from — and, when
 * `X[Symbol.hasInstance]` is user-defined, can throw from arbitrary code. This
 * wraps the check in {@link attempt} (see ./helpers.js) so any such throw
 * yields `false` instead of escaping.
 *
 * @param value - The value to test
 * @param ctor - The constructor to test against
 * @returns `true` when `value instanceof ctor`, `false` on a non-match or a
 *          contained throw
 *
 * @example
 * ```ts
 * isInstance(new Date(), Date) // true
 * isInstance({}, Date)          // false
 * ```
 */
export function isInstance<C>(
	value: unknown,
	ctor: C,
): value is InstanceType<C & AnyConstructor<object>> {
	// `ctor` is narrowed to a function through `isFunction` before the `instanceof`
	// check — an unconstrained generic RHS loses TS's built-in instanceof leniency
	// once nested inside another generic call (the `attempt` callback), so the
	// narrowing keeps this call legal without a constraint that would reject
	// combinators.ts's `instanceOf`, which validates `ctor` separately.
	const target: unknown = ctor
	const outcome = attempt(() => isFunction(target) && value instanceof target)
	return outcome.success && outcome.value
}

/** Determine whether a value is a `Date`.
 *
 * @example
 * ```ts
 * isDate(new Date()) // true
 * isDate('2024-01-01') // false
 * ```
 */
export function isDate(value: unknown): value is Date {
	return isInstance(value, Date)
}

/** Determine whether a value is a `RegExp`.
 *
 * @example
 * ```ts
 * isRegExp(/a/) // true
 * isRegExp('a') // false
 * ```
 */
export function isRegExp(value: unknown): value is RegExp {
	return isInstance(value, RegExp)
}

/** Determine whether a value is an `Error`.
 *
 * @example
 * ```ts
 * isError(new Error('boom')) // true
 * isError('boom')             // false
 * ```
 */
export function isError(value: unknown): value is Error {
	return isInstance(value, Error)
}

/** Determine whether a value is a native `Promise` (use {@link isPromiseLike} for any thenable).
 *
 * @example
 * ```ts
 * isPromise(Promise.resolve()) // true
 * isPromise({ then() {} })     // false
 * ```
 */
export function isPromise<T = unknown>(value: unknown): value is Promise<T> {
	return isInstance(value, Promise)
}

/**
 * Determine whether a value is promise-like — an object exposing callable
 * `then`, `catch`, and `finally` methods.
 *
 * @remarks
 * Accepts any object with all three methods, not only native `Promise`
 * instances. Use {@link isPromise} when you specifically need `instanceof Promise`.
 *
 * @example
 * ```ts
 * isPromiseLike(Promise.resolve())                                // true
 * isPromiseLike({ then() {}, catch() {}, finally() {} }) // true
 * isPromiseLike({ then() {} })                            // false
 * ```
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

/** Determine whether a value is an `ArrayBuffer`.
 *
 * @example
 * ```ts
 * isArrayBuffer(new ArrayBuffer(8)) // true
 * isArrayBuffer([])                 // false
 * ```
 */
export function isArrayBuffer(value: unknown): value is ArrayBuffer {
	return isInstance(value, ArrayBuffer)
}

/**
 * Determine whether a value is a `SharedArrayBuffer`.
 *
 * @remarks
 * Guards the global existence of `SharedArrayBuffer` first — safe where it is
 * absent or disabled (e.g. a context that is not cross-origin isolated).
 *
 * @example
 * ```ts
 * isSharedArrayBuffer(new SharedArrayBuffer(8)) // true
 * isSharedArrayBuffer(new ArrayBuffer(8))       // false
 * ```
 */
export function isSharedArrayBuffer(value: unknown): value is SharedArrayBuffer {
	return typeof SharedArrayBuffer !== 'undefined' && isInstance(value, SharedArrayBuffer)
}

// === Protocol guards

/**
 * Determine whether a value implements the iterable protocol (`Symbol.iterator`).
 *
 * @remarks
 * Strings are explicitly included: a string has a callable `Symbol.iterator`
 * but is not an object, so the generic object path alone would miss it.
 *
 * @example
 * ```ts
 * isIterable([1, 2])       // true
 * isIterable('abc')        // true
 * isIterable({ a: 1 })     // false
 * ```
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

/** Determine whether a value implements the async iterable protocol (`Symbol.asyncIterator`).
 *
 * @example
 * ```ts
 * isAsyncIterable({ [Symbol.asyncIterator]() {} }) // true
 * isAsyncIterable([1, 2])                          // false
 * ```
 */
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
 *
 * @example
 * ```ts
 * isObject({})   // true
 * isObject([])   // true
 * isObject(null) // false
 * ```
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
 *
 * @example
 * ```ts
 * isRecord({ a: 1 })         // true
 * isRecord(Object.create(null)) // true
 * isRecord([])               // false
 * isRecord(new Date())       // false
 * ```
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

/** Determine whether a value is a `Map`.
 *
 * @example
 * ```ts
 * isMap(new Map()) // true
 * isMap({})        // false
 * ```
 */
export function isMap<K = unknown, V = unknown>(value: unknown): value is ReadonlyMap<K, V> {
	return isInstance(value, Map)
}

/** Determine whether a value is a `Set`.
 *
 * @example
 * ```ts
 * isSet(new Set()) // true
 * isSet([])        // false
 * ```
 */
export function isSet<T = unknown>(value: unknown): value is ReadonlySet<T> {
	return isInstance(value, Set)
}

/** Determine whether a value is a `WeakMap`.
 *
 * @example
 * ```ts
 * isWeakMap(new WeakMap()) // true
 * isWeakMap({})            // false
 * ```
 */
export function isWeakMap(value: unknown): value is WeakMap<object, unknown> {
	return isInstance(value, WeakMap)
}

/** Determine whether a value is a `WeakSet`.
 *
 * @example
 * ```ts
 * isWeakSet(new WeakSet()) // true
 * isWeakSet({})            // false
 * ```
 */
export function isWeakSet(value: unknown): value is WeakSet<object> {
	return isInstance(value, WeakSet)
}

// === Array & typed-array guards

/** Determine whether a value is an array.
 *
 * @example
 * ```ts
 * isArray([1, 2]) // true
 * isArray('12')   // false
 * ```
 */
export function isArray<T = unknown>(value: unknown): value is readonly T[] {
	return Array.isArray(value)
}

/** Determine whether a value is a `DataView`.
 *
 * @example
 * ```ts
 * isDataView(new DataView(new ArrayBuffer(8))) // true
 * isDataView(new ArrayBuffer(8))                // false
 * ```
 */
export function isDataView(value: unknown): value is DataView<ArrayBufferLike> {
	return isInstance(value, DataView)
}

/** Determine whether a value is an `ArrayBufferView` (any typed array or `DataView`).
 *
 * @example
 * ```ts
 * isArrayBufferView(new Uint8Array(4)) // true
 * isArrayBufferView([1, 2, 3, 4])       // false
 * ```
 */
export function isArrayBufferView(value: unknown): value is ArrayBufferView {
	return ArrayBuffer.isView(value)
}

/** Determine whether a value is an `Int8Array`.
 *
 * @example
 * ```ts
 * isInt8Array(new Int8Array(2)) // true
 * isInt8Array(new Uint8Array(2)) // false
 * ```
 */
export function isInt8Array(value: unknown): value is Int8Array {
	return isInstance(value, Int8Array)
}

/** Determine whether a value is a `Uint8Array`.
 *
 * @example
 * ```ts
 * isUint8Array(new Uint8Array(2)) // true
 * isUint8Array(new Int8Array(2))  // false
 * ```
 */
export function isUint8Array(value: unknown): value is Uint8Array {
	return isInstance(value, Uint8Array)
}

/** Determine whether a value is a `Uint8ClampedArray`.
 *
 * @example
 * ```ts
 * isUint8ClampedArray(new Uint8ClampedArray(2)) // true
 * isUint8ClampedArray(new Uint8Array(2))         // false
 * ```
 */
export function isUint8ClampedArray(value: unknown): value is Uint8ClampedArray {
	return isInstance(value, Uint8ClampedArray)
}

/** Determine whether a value is an `Int16Array`.
 *
 * @example
 * ```ts
 * isInt16Array(new Int16Array(2)) // true
 * isInt16Array(new Int8Array(2))  // false
 * ```
 */
export function isInt16Array(value: unknown): value is Int16Array {
	return isInstance(value, Int16Array)
}

/** Determine whether a value is a `Uint16Array`.
 *
 * @example
 * ```ts
 * isUint16Array(new Uint16Array(2)) // true
 * isUint16Array(new Int16Array(2))   // false
 * ```
 */
export function isUint16Array(value: unknown): value is Uint16Array {
	return isInstance(value, Uint16Array)
}

/** Determine whether a value is an `Int32Array`.
 *
 * @example
 * ```ts
 * isInt32Array(new Int32Array(2)) // true
 * isInt32Array(new Int16Array(2)) // false
 * ```
 */
export function isInt32Array(value: unknown): value is Int32Array {
	return isInstance(value, Int32Array)
}

/** Determine whether a value is a `Uint32Array`.
 *
 * @example
 * ```ts
 * isUint32Array(new Uint32Array(2)) // true
 * isUint32Array(new Int32Array(2))   // false
 * ```
 */
export function isUint32Array(value: unknown): value is Uint32Array {
	return isInstance(value, Uint32Array)
}

/** Determine whether a value is a `Float32Array`.
 *
 * @example
 * ```ts
 * isFloat32Array(new Float32Array(2)) // true
 * isFloat32Array(new Float64Array(2))  // false
 * ```
 */
export function isFloat32Array(value: unknown): value is Float32Array {
	return isInstance(value, Float32Array)
}

/** Determine whether a value is a `Float64Array`.
 *
 * @example
 * ```ts
 * isFloat64Array(new Float64Array(2)) // true
 * isFloat64Array(new Float32Array(2))  // false
 * ```
 */
export function isFloat64Array(value: unknown): value is Float64Array {
	return isInstance(value, Float64Array)
}

/**
 * Determine whether a value is a `BigInt64Array`.
 *
 * @remarks
 * Guards the global existence of `BigInt64Array` first — safe in environments
 * that pre-date the BigInt typed-array additions.
 *
 * @example
 * ```ts
 * isBigInt64Array(new BigInt64Array(2)) // true
 * isBigInt64Array(new Float64Array(2))   // false
 * ```
 */
export function isBigInt64Array(value: unknown): value is BigInt64Array {
	return typeof BigInt64Array !== 'undefined' && isInstance(value, BigInt64Array)
}

/**
 * Determine whether a value is a `BigUint64Array`.
 *
 * @remarks
 * Guards the global existence of `BigUint64Array` first — safe in environments
 * that pre-date the BigInt typed-array additions.
 *
 * @example
 * ```ts
 * isBigUint64Array(new BigUint64Array(2)) // true
 * isBigUint64Array(new BigInt64Array(2))   // false
 * ```
 */
export function isBigUint64Array(value: unknown): value is BigUint64Array {
	return typeof BigUint64Array !== 'undefined' && isInstance(value, BigUint64Array)
}

// === Emptiness guards

/** Determine whether a value is the empty string `''`.
 *
 * @example
 * ```ts
 * isEmptyString('')  // true
 * isEmptyString('a') // false
 * ```
 */
export function isEmptyString(value: unknown): value is '' {
	return isString(value) && value.length === 0
}

/** Determine whether a value is an empty array.
 *
 * @example
 * ```ts
 * isEmptyArray([])    // true
 * isEmptyArray([1])   // false
 * ```
 */
export function isEmptyArray(value: unknown): value is readonly [] {
	return isArray(value) && value.length === 0
}

/** Determine whether a value is an empty plain object (no own string or enumerable symbol keys).
 *
 * @example
 * ```ts
 * isEmptyObject({})      // true
 * isEmptyObject({ a: 1 }) // false
 * ```
 */
export function isEmptyObject(value: unknown): value is Record<string | symbol, never> {
	if (!isRecord(value)) {
		return false
	}
	// Object.keys / getOwnPropertySymbols read the object's own-key list, which
	// an `ownKeys` Proxy trap can throw from — contained via `attempt` (AGENTS §14).
	const outcome = attempt(
		() => Object.keys(value).length === 0 && enumerableSymbolCount(value) === 0,
	)
	return outcome.success && outcome.value
}

/** Determine whether a value is an empty `Map`.
 *
 * @example
 * ```ts
 * isEmptyMap(new Map())            // true
 * isEmptyMap(new Map([['a', 1]]))  // false
 * ```
 */
export function isEmptyMap(value: unknown): value is ReadonlyMap<never, never> {
	return isMap(value) && value.size === 0
}

/** Determine whether a value is an empty `Set`.
 *
 * @example
 * ```ts
 * isEmptySet(new Set())    // true
 * isEmptySet(new Set([1])) // false
 * ```
 */
export function isEmptySet(value: unknown): value is ReadonlySet<never> {
	return isSet(value) && value.size === 0
}

/** Determine whether a value is a non-empty string (at least one character).
 *
 * @example
 * ```ts
 * isNonEmptyString('a') // true
 * isNonEmptyString('')  // false
 * ```
 */
export function isNonEmptyString(value: unknown): value is string {
	return isString(value) && value.length > 0
}

/** Determine whether a value is a non-empty array (at least one element).
 *
 * @example
 * ```ts
 * isNonEmptyArray([1]) // true
 * isNonEmptyArray([])  // false
 * ```
 */
export function isNonEmptyArray<T = unknown>(value: unknown): value is readonly [T, ...T[]] {
	return isArray(value) && value.length > 0
}

/** Determine whether a value is a non-empty plain object (at least one own string or enumerable symbol key).
 *
 * @example
 * ```ts
 * isNonEmptyObject({ a: 1 }) // true
 * isNonEmptyObject({})       // false
 * ```
 */
export function isNonEmptyObject(value: unknown): value is Record<string | symbol, unknown> {
	if (!isRecord(value)) {
		return false
	}
	// Same containment as isEmptyObject — an `ownKeys` Proxy trap can throw.
	const outcome = attempt(() => Object.keys(value).length > 0 || enumerableSymbolCount(value) > 0)
	return outcome.success && outcome.value
}

/** Determine whether a value is a non-empty `Map` (at least one entry).
 *
 * @example
 * ```ts
 * isNonEmptyMap(new Map([['a', 1]])) // true
 * isNonEmptyMap(new Map())            // false
 * ```
 */
export function isNonEmptyMap<K = unknown, V = unknown>(
	value: unknown,
): value is ReadonlyMap<K, V> {
	return isMap(value) && value.size > 0
}

/** Determine whether a value is a non-empty `Set` (at least one element).
 *
 * @example
 * ```ts
 * isNonEmptySet(new Set([1])) // true
 * isNonEmptySet(new Set())    // false
 * ```
 */
export function isNonEmptySet<T = unknown>(value: unknown): value is ReadonlySet<T> {
	return isSet(value) && value.size > 0
}

// === Function guards

/** Determine whether a value is a function that declares zero parameters (`Function.length === 0`).
 *
 * @example
 * ```ts
 * isZeroArg(() => {})    // true
 * isZeroArg((a) => a)    // false
 * ```
 */
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
 *
 * @example
 * ```ts
 * isAsyncFunction(async () => {}) // true
 * isAsyncFunction(() => {})       // false
 * ```
 */
export function isAsyncFunction(value: unknown): value is AnyAsyncFunction {
	return isFunction(value) && value.constructor?.name === 'AsyncFunction'
}

/** Determine whether a value is a generator function (`function*`).
 *
 * @example
 * ```ts
 * isGeneratorFunction(function* () {}) // true
 * isGeneratorFunction(() => {})        // false
 * ```
 */
export function isGeneratorFunction(
	value: unknown,
): value is (...args: unknown[]) => Generator<unknown, unknown, unknown> {
	return isFunction(value) && value.constructor?.name === 'GeneratorFunction'
}

/** Determine whether a value is an async generator function (`async function*`).
 *
 * @example
 * ```ts
 * isAsyncGeneratorFunction(async function* () {}) // true
 * isAsyncGeneratorFunction(function* () {})       // false
 * ```
 */
export function isAsyncGeneratorFunction(
	value: unknown,
): value is (...args: unknown[]) => AsyncGenerator<unknown, unknown, unknown> {
	return isFunction(value) && value.constructor?.name === 'AsyncGeneratorFunction'
}

/** Determine whether a value is a zero-argument async function.
 *
 * @example
 * ```ts
 * isZeroArgAsync(async () => {}) // true
 * isZeroArgAsync(async (a) => a) // false
 * ```
 */
export function isZeroArgAsync(value: unknown): value is ZeroArgAsyncFunction {
	return isZeroArg(value) && isAsyncFunction(value)
}

/** Determine whether a value is a zero-argument generator function.
 *
 * @example
 * ```ts
 * isZeroArgGenerator(function* () {})  // true
 * isZeroArgGenerator(function* (a) {}) // false
 * ```
 */
export function isZeroArgGenerator(
	value: unknown,
): value is () => Generator<unknown, unknown, unknown> {
	return isZeroArg(value) && isGeneratorFunction(value)
}

/** Determine whether a value is a zero-argument async generator function.
 *
 * @example
 * ```ts
 * isZeroArgAsyncGenerator(async function* () {})  // true
 * isZeroArgAsyncGenerator(async function* (a) {}) // false
 * ```
 */
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
 *
 * @example
 * ```ts
 * isConstructor(class X {}) // true
 * isConstructor(() => {})    // false
 * ```
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
