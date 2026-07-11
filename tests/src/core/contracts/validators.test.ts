import { describe, expect, it } from 'vitest'
import {
	isArray,
	isArrayBuffer,
	isArrayBufferView,
	isAsyncFunction,
	isAsyncGeneratorFunction,
	isAsyncIterable,
	isBigInt,
	isBigInt64Array,
	isBigUint64Array,
	isBoolean,
	isConstructor,
	isDataView,
	isDate,
	isDefined,
	isEmptyArray,
	isEmptyMap,
	isEmptyObject,
	isEmptySet,
	isEmptyString,
	isError,
	isFalse,
	isFiniteNumber,
	isFloat32Array,
	isFloat64Array,
	isFunction,
	isGeneratorFunction,
	isInt16Array,
	isInt32Array,
	isInt8Array,
	isInteger,
	isIterable,
	isJSONPrimitive,
	isJSONValue,
	isMap,
	isNonEmptyArray,
	isNonEmptyMap,
	isNonEmptyObject,
	isNonEmptySet,
	isNonEmptyString,
	isNull,
	isNullableBoolean,
	isNullableNumber,
	isNullableString,
	isNumber,
	isObject,
	isPromise,
	isPromiseLike,
	isRecord,
	isRegExp,
	isSet,
	isSharedArrayBuffer,
	isString,
	isSymbol,
	isTrue,
	isUint16Array,
	isUint32Array,
	isUint8Array,
	isUint8ClampedArray,
	isUndefined,
	isWeakMap,
	isWeakSet,
	isZeroArg,
	isZeroArgAsync,
	isZeroArgAsyncGenerator,
	isZeroArgGenerator,
} from '@src/core'

class JSONExample {
	readonly value = 1
}

describe('primitive validators', () => {
	it('detects null and undefined values', () => {
		expect(isNull(null)).toBe(true)
		expect(isNull(undefined)).toBe(false)
		expect(isUndefined(undefined)).toBe(true)
		expect(isUndefined(null)).toBe(false)
	})

	it('detects defined values', () => {
		expect(isDefined(0)).toBe(true)
		expect(isDefined('')).toBe(true)
		expect(isDefined(false)).toBe(true)
		expect(isDefined(null)).toBe(false)
		expect(isDefined(undefined)).toBe(false)
	})

	it('detects primitive runtime types', () => {
		expect(isString('value')).toBe(true)
		expect(isNullableString('value')).toBe(true)
		expect(isNullableString(null)).toBe(true)
		expect(isNullableString(1)).toBe(false)
		expect(isString(1)).toBe(false)
		expect(isNumber(1)).toBe(true)
		expect(isNullableNumber(1)).toBe(true)
		expect(isNullableNumber(null)).toBe(true)
		expect(isNullableNumber('1')).toBe(false)
		expect(isBoolean(true)).toBe(true)
		expect(isNullableBoolean(true)).toBe(true)
		expect(isNullableBoolean(null)).toBe(true)
		expect(isNullableBoolean('true')).toBe(false)
		expect(isTrue(true)).toBe(true)
		expect(isTrue(false)).toBe(false)
		expect(isFalse(false)).toBe(true)
		expect(isFalse(true)).toBe(false)
		expect(isBoolean(0)).toBe(false)
		expect(isBigInt(1n)).toBe(true)
		expect(isBigInt(1)).toBe(false)
		expect(isSymbol(Symbol('x'))).toBe(true)
		expect(isSymbol('x')).toBe(false)
	})

	it('treats NaN / ±Infinity as numbers but not as nullable-number rejections', () => {
		// Canonical isNumber: typeof === 'number' (NaN and ±Infinity included).
		expect(isNumber(NaN)).toBe(true)
		expect(isNumber(Number.POSITIVE_INFINITY)).toBe(true)
		expect(isNumber('1')).toBe(false)
		expect(isNullableNumber(NaN)).toBe(true)
	})

	it('detects functions and common built-ins', () => {
		const fn = (value: unknown) => value
		expect(isFunction(fn)).toBe(true)
		expect(isFunction({})).toBe(false)
		expect(isDate(new Date())).toBe(true)
		expect(isDate({})).toBe(false)
		expect(isRegExp(/a/)).toBe(true)
		expect(isRegExp('a')).toBe(false)
		expect(isError(new Error('boom'))).toBe(true)
		expect(isError({ message: 'boom' })).toBe(false)
	})

	it('detects iterables and async iterables', async () => {
		async function* createAsyncGenerator(): AsyncGenerator<number, void, unknown> {
			yield 1
		}

		expect(isIterable([1, 2, 3])).toBe(true)
		expect(isIterable('abc')).toBe(true)
		expect(isIterable(new Set([1, 2]))).toBe(true)
		expect(isIterable({})).toBe(false)
		expect(isAsyncIterable(createAsyncGenerator())).toBe(true)
		expect(isAsyncIterable([1, 2, 3])).toBe(false)

		await Promise.resolve()
	})

	it('detects promises and promise-like objects', () => {
		const promise = Promise.resolve(1)
		const promiseLike: unknown = {
			then() {
				return undefined
			},
			catch() {
				return undefined
			},
			finally() {
				return undefined
			},
		}
		const incompletePromiseLike: unknown = {
			then() {
				return undefined
			},
		}

		expect(isPromise(promise)).toBe(true)
		expect(isPromise(promiseLike)).toBe(false)
		expect(isPromiseLike(promise)).toBe(true)
		expect(isPromiseLike(promiseLike)).toBe(true)
		expect(isPromiseLike(incompletePromiseLike)).toBe(false)
	})

	it('detects array buffers', () => {
		expect(isArrayBuffer(new ArrayBuffer(8))).toBe(true)
		expect(isArrayBuffer(new Uint8Array(4))).toBe(false)

		const supported = typeof SharedArrayBuffer !== 'undefined'
		const sharedBuffer = supported ? new SharedArrayBuffer(8) : undefined
		expect(isSharedArrayBuffer(sharedBuffer)).toBe(supported)
		expect(isSharedArrayBuffer(new ArrayBuffer(8))).toBe(false)
	})
})

describe('isJSONValue — JSON data contract', () => {
	it('accepts JSON primitives, arrays, and records with finite numbers', () => {
		expect(isJSONValue(null)).toBe(true)
		expect(isJSONValue('x')).toBe(true)
		expect(isJSONValue(1)).toBe(true)
		expect(isJSONValue(false)).toBe(true)
		expect(isJSONValue({ nested: [1, 'x', null, { ok: true }] })).toBe(true)
	})

	it('rejects cycles, functions, dates, class instances, and non-finite numbers without hanging', () => {
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		const array: unknown[] = []
		array.push(array)
		expect(isJSONValue(cycle)).toBe(false)
		expect(isJSONValue(array)).toBe(false)
		expect(isJSONValue(() => 1)).toBe(false)
		expect(isJSONValue(new Date())).toBe(false)
		expect(isJSONValue(new JSONExample())).toBe(false)
		expect(isJSONValue(Number.NaN)).toBe(false)
		expect(isJSONValue(Number.POSITIVE_INFINITY)).toBe(false)
	})
})

describe('collection and typed-array validators', () => {
	it('detects maps, sets, objects, and records', () => {
		class RecordLike {
			readonly value = 1
		}

		const nullPrototypeRecord: Record<string, unknown> = Object.create(null)
		nullPrototypeRecord['id'] = 'plain'

		expect(isMap(new Map())).toBe(true)
		expect(isMap(new Set())).toBe(false)
		expect(isSet(new Set())).toBe(true)
		expect(isSet(new Map())).toBe(false)
		expect(isWeakMap(new WeakMap())).toBe(true)
		expect(isWeakMap(new Map())).toBe(false)
		expect(isWeakSet(new WeakSet())).toBe(true)
		expect(isWeakSet(new Set())).toBe(false)
		expect(isObject({})).toBe(true)
		expect(isObject([])).toBe(true)
		expect(isObject(null)).toBe(false)
		expect(isRecord({})).toBe(true)
		expect(isRecord(nullPrototypeRecord)).toBe(true)
		expect(isRecord([])).toBe(false)
		expect(isRecord(null)).toBe(false)
		expect(isRecord(new Date())).toBe(false)
		expect(isRecord(new RecordLike())).toBe(false)
	})

	describe('isObject — non-null object discrimination', () => {
		it('a plain object → true', () => {
			expect(isObject({})).toBe(true)
			expect(isObject({ a: 1 })).toBe(true)
		})

		it('an array → true', () => {
			expect(isObject([])).toBe(true)
			expect(isObject([1, 2, 3])).toBe(true)
		})

		it('a class instance → true', () => {
			class Example {}
			expect(isObject(new Example())).toBe(true)
		})

		it('a Map / Set / Date / RegExp instance → true', () => {
			expect(isObject(new Map())).toBe(true)
			expect(isObject(new Set())).toBe(true)
			expect(isObject(new Date())).toBe(true)
			expect(isObject(/x/)).toBe(true)
		})

		it('an object with a null prototype → true', () => {
			expect(isObject(Object.create(null))).toBe(true)
		})

		it('null → false (the classic typeof null === "object" trap)', () => {
			expect(isObject(null)).toBe(false)
		})

		it('primitives → false', () => {
			expect(isObject(undefined)).toBe(false)
			expect(isObject(42)).toBe(false)
			expect(isObject(Number.NaN)).toBe(false)
			expect(isObject('object')).toBe(false)
			expect(isObject(true)).toBe(false)
			expect(isObject(Symbol('s'))).toBe(false)
			expect(isObject(10n)).toBe(false)
		})

		it('a function → false (typeof is "function", not "object")', () => {
			expect(isObject(() => undefined)).toBe(false)
			expect(isObject(class Example {})).toBe(false)
		})

		it('narrows to object when true', () => {
			const value: unknown = { key: 'value' }
			const narrowed: object | undefined = isObject(value) ? value : undefined
			expect(narrowed === undefined ? [] : Object.keys(narrowed)).toEqual(['key'])
		})
	})

	it('detects arrays and array buffer views', () => {
		const buffer = new ArrayBuffer(8)
		expect(isArray([])).toBe(true)
		expect(isArray([1, 2, 3])).toBe(true)
		expect(isArray({})).toBe(false)
		expect(isArray('value')).toBe(false)
		expect(isDataView(new DataView(buffer))).toBe(true)
		expect(isDataView(new Uint8Array(buffer))).toBe(false)
		expect(isArrayBufferView(new DataView(buffer))).toBe(true)
		expect(isArrayBufferView(new Uint8Array(buffer))).toBe(true)
		expect(isArrayBufferView({})).toBe(false)
	})

	it('detects integer and floating typed arrays', () => {
		expect(isInt8Array(new Int8Array(1))).toBe(true)
		expect(isInt8Array(new Uint8Array(1))).toBe(false)
		expect(isUint8Array(new Uint8Array(1))).toBe(true)
		expect(isUint8Array(new Uint8ClampedArray(1))).toBe(false)
		expect(isUint8ClampedArray(new Uint8ClampedArray(1))).toBe(true)
		expect(isUint8ClampedArray(new Uint8Array(1))).toBe(false)
		expect(isInt16Array(new Int16Array(1))).toBe(true)
		expect(isInt16Array(new Uint16Array(1))).toBe(false)
		expect(isUint16Array(new Uint16Array(1))).toBe(true)
		expect(isUint16Array(new Int16Array(1))).toBe(false)
		expect(isInt32Array(new Int32Array(1))).toBe(true)
		expect(isInt32Array(new Uint32Array(1))).toBe(false)
		expect(isUint32Array(new Uint32Array(1))).toBe(true)
		expect(isUint32Array(new Int32Array(1))).toBe(false)
		expect(isFloat32Array(new Float32Array(1))).toBe(true)
		expect(isFloat32Array(new Float64Array(1))).toBe(false)
		expect(isFloat64Array(new Float64Array(1))).toBe(true)
		expect(isFloat64Array(new Float32Array(1))).toBe(false)
	})

	it('detects bigint typed arrays when supported', () => {
		const supported = typeof BigInt64Array !== 'undefined' && typeof BigUint64Array !== 'undefined'
		const intArray = supported ? new BigInt64Array(1) : undefined
		const uintArray = supported ? new BigUint64Array(1) : undefined

		expect(isBigInt64Array(intArray)).toBe(supported)
		expect(isBigInt64Array(uintArray)).toBe(false)
		expect(isBigUint64Array(uintArray)).toBe(supported)
		expect(isBigUint64Array(intArray)).toBe(false)
	})
})

describe('emptiness validators', () => {
	it('detects empty primitive and collection values', () => {
		expect(isEmptyString('')).toBe(true)
		expect(isEmptyString('value')).toBe(false)
		expect(isEmptyArray([])).toBe(true)
		expect(isEmptyArray([1])).toBe(false)
		expect(isEmptyMap(new Map())).toBe(true)
		expect(isEmptyMap(new Map([['a', 1]]))).toBe(false)
		expect(isEmptySet(new Set())).toBe(true)
		expect(isEmptySet(new Set([1]))).toBe(false)
		expect(isEmptyObject({})).toBe(true)
		expect(isEmptyObject({ id: '1' })).toBe(false)
	})

	it('detects non-empty primitive and collection values', () => {
		expect(isNonEmptyString('value')).toBe(true)
		expect(isNonEmptyString('')).toBe(false)
		expect(isNonEmptyArray([1])).toBe(true)
		expect(isNonEmptyArray([])).toBe(false)
		expect(isNonEmptyMap(new Map([['a', 1]]))).toBe(true)
		expect(isNonEmptyMap(new Map())).toBe(false)
		expect(isNonEmptySet(new Set([1]))).toBe(true)
		expect(isNonEmptySet(new Set())).toBe(false)
		expect(isNonEmptyObject({ id: '1' })).toBe(true)
		expect(isNonEmptyObject({})).toBe(false)
	})

	it('counts enumerable symbol keys for object emptiness checks', () => {
		const hidden = Symbol('hidden')
		const visible = Symbol('visible')
		const emptyObject = {}
		const nonEmptyObject = { [visible]: true }

		Object.defineProperty(emptyObject, hidden, {
			value: true,
			enumerable: false,
		})

		expect(isEmptyObject(emptyObject)).toBe(true)
		expect(isNonEmptyObject(emptyObject)).toBe(false)
		expect(isEmptyObject(nonEmptyObject)).toBe(false)
		expect(isNonEmptyObject(nonEmptyObject)).toBe(true)
	})
})

describe('function validators', () => {
	it('detects zero-argument functions', () => {
		const zeroArg = () => 1
		const withArg = (value: unknown) => value
		expect(isZeroArg(zeroArg)).toBe(true)
		expect(isZeroArg(withArg)).toBe(false)
		expect(isZeroArg('not a function')).toBe(false)
	})

	it('detects async functions', () => {
		const asyncFn = async () => 1
		const promiseFn = () => Promise.resolve(1)
		expect(isAsyncFunction(asyncFn)).toBe(true)
		expect(isAsyncFunction(promiseFn)).toBe(false)
	})

	it('detects generator functions', () => {
		function* generator(): Generator<number, void, unknown> {
			yield 1
		}
		expect(isGeneratorFunction(generator)).toBe(true)
		expect(isGeneratorFunction(() => 1)).toBe(false)
	})

	it('detects async generator functions', () => {
		async function* asyncGenerator(): AsyncGenerator<number, void, unknown> {
			yield 1
		}
		expect(isAsyncGeneratorFunction(asyncGenerator)).toBe(true)
		expect(isAsyncGeneratorFunction(async () => 1)).toBe(false)
	})

	it('detects zero-argument async, generator, and async generator functions', () => {
		const zeroArgAsync = async () => 1
		const oneArgAsync = async (value: unknown) => value

		function* zeroArgGenerator(): Generator<number, void, unknown> {
			yield 1
		}

		function* oneArgGenerator(value: unknown): Generator<unknown, void, unknown> {
			yield value
		}

		async function* zeroArgAsyncGenerator(): AsyncGenerator<number, void, unknown> {
			yield 1
		}

		async function* oneArgAsyncGenerator(value: unknown): AsyncGenerator<unknown, void, unknown> {
			yield value
		}

		expect(isZeroArgAsync(zeroArgAsync)).toBe(true)
		expect(isZeroArgAsync(oneArgAsync)).toBe(false)
		expect(isZeroArgGenerator(zeroArgGenerator)).toBe(true)
		expect(isZeroArgGenerator(oneArgGenerator)).toBe(false)
		expect(isZeroArgAsyncGenerator(zeroArgAsyncGenerator)).toBe(true)
		expect(isZeroArgAsyncGenerator(oneArgAsyncGenerator)).toBe(false)
	})

	it('detects constructor functions', () => {
		expect(isConstructor(class Example {})).toBe(true)
		expect(isConstructor(Date)).toBe(true)
		expect(isConstructor(() => undefined)).toBe(false)
		expect(isConstructor('not a function')).toBe(false)
	})

	it('stays total when a function constructor is nulled (AGENTS §14)', () => {
		// A passive hostile input: `value.constructor` is null, so a bare
		// `.constructor.name` would throw `null.name`. The guard must return
		// `false`, never throw.
		const fn = async () => 1
		Object.defineProperty(fn, 'constructor', { value: null, configurable: true })
		expect(() => isAsyncFunction(fn)).not.toThrow()
		expect(isAsyncFunction(fn)).toBe(false)
		expect(() => isGeneratorFunction(fn)).not.toThrow()
		expect(isGeneratorFunction(fn)).toBe(false)
	})
})

describe('isFiniteNumber', () => {
	it('accepts finite numbers and rejects NaN / ±Infinity / non-numbers', () => {
		expect(isFiniteNumber(42)).toBe(true)
		expect(isFiniteNumber(-0)).toBe(true)
		expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false)
		expect(isFiniteNumber(-Infinity)).toBe(false)
		expect(isFiniteNumber(NaN)).toBe(false)
		expect(isFiniteNumber('42')).toBe(false)
	})
})

describe('isInteger', () => {
	it('accepts finite integers and rejects fractions / NaN / ±Infinity / non-numbers', () => {
		expect(isInteger(42)).toBe(true)
		expect(isInteger(-7)).toBe(true)
		expect(isInteger(-0)).toBe(true)
		expect(isInteger(3.14)).toBe(false)
		expect(isInteger(NaN)).toBe(false)
		expect(isInteger(Number.POSITIVE_INFINITY)).toBe(false)
		expect(isInteger('42')).toBe(false)
		expect(isInteger(42n)).toBe(false)
	})
})

describe('isJSONPrimitive', () => {
	it('accepts JSON leaves: null, string, finite number, boolean', () => {
		expect(isJSONPrimitive(null)).toBe(true)
		expect(isJSONPrimitive('')).toBe(true)
		expect(isJSONPrimitive('hi')).toBe(true)
		expect(isJSONPrimitive(0)).toBe(true)
		expect(isJSONPrimitive(42)).toBe(true)
		expect(isJSONPrimitive(-3.14)).toBe(true)
		expect(isJSONPrimitive(true)).toBe(true)
		expect(isJSONPrimitive(false)).toBe(true)
	})

	it('rejects NaN / ±Infinity — not representable in JSON (uses isFiniteNumber)', () => {
		expect(isJSONPrimitive(NaN)).toBe(false)
		expect(isJSONPrimitive(Number.POSITIVE_INFINITY)).toBe(false)
		expect(isJSONPrimitive(-Infinity)).toBe(false)
	})

	it('rejects undefined, objects, arrays, and other non-JSON values', () => {
		expect(isJSONPrimitive(undefined)).toBe(false)
		expect(isJSONPrimitive({})).toBe(false)
		expect(isJSONPrimitive([])).toBe(false)
		expect(isJSONPrimitive(Symbol('s'))).toBe(false)
		expect(isJSONPrimitive(10n)).toBe(false)
		expect(isJSONPrimitive(() => 1)).toBe(false)
		expect(isJSONPrimitive(new Date())).toBe(false)
	})
})
