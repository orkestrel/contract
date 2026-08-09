import type { JSONRecord, JSONValue, LiteralValue } from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'
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
	isBoundedJSONRecord,
	isBoundedJSONValue,
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
	isInstance,
	isInt16Array,
	isInt32Array,
	isInt8Array,
	isInteger,
	isIterable,
	isJSONPrimitive,
	isJSONValue,
	isLiteralValue,
	isMap,
	isNonEmptyArray,
	isNonEmptyMap,
	isNonEmptyObject,
	isNonEmptySet,
	isNonEmptyString,
	isNonNegativeInteger,
	isNonNegativeNumber,
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
	recordOf,
	GUARD_DEPTH_LIMIT,
} from '@src/core'
import {
	buildCyclicArray,
	buildCyclicRecord,
	buildDeepNest,
	buildSparseArray,
	createHostileKeys,
	createProxiedBrandDeclaration,
	createRevokedArrayProxy,
	createRevokedProxy,
	createThrowingGetter,
	ForgedBrandDeclaration,
	NullBaseDeclaration,
	ProxiedBrandDeclaration,
	StrippedBrandDeclaration,
} from '../../setup.js'
import { createForeignRecord, createForeignRegExp } from '../../setupServer.js'

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

	it('narrows the total literal domain without applying finiteness policy', () => {
		const values: readonly unknown[] = [
			'',
			0,
			-0,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			true,
			false,
		]
		for (const value of values) {
			expect(isLiteralValue(value)).toBe(true)
			if (isLiteralValue(value)) expectTypeOf(value).toEqualTypeOf<LiteralValue>()
		}
		for (const value of [null, undefined, 1n, Symbol('literal'), () => 1, [], {}]) {
			expect(isLiteralValue(value)).toBe(false)
		}
		expect(Object.is(-0, 0)).toBe(false)
		expect(isLiteralValue(-0)).toBe(true)
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

	it('recognizes genuine local and foreign RegExp brands through their native slot', () => {
		expect(isRegExp(/local/)).toBe(true)
		expect(isRegExp(createForeignRegExp('foreign'))).toBe(true)
	})

	it('rejects RegExp lookalikes and proxies without reading advertised accessors', () => {
		let reads = 0
		const accessor = {}
		for (const field of ['source', 'flags']) {
			Object.defineProperty(accessor, field, {
				get() {
					reads += 1
					throw new Error('advertised RegExp field')
				},
			})
		}
		const forged = { source: 'forged', flags: '' }
		Object.defineProperty(forged, Symbol.toStringTag, { value: 'RegExp' })
		const transparent = new Proxy(/proxied/, {})
		const revoked = Proxy.revocable(/revoked/, {})
		revoked.revoke()

		for (const value of [
			{ source: 'duck', flags: '', test() {} },
			forged,
			accessor,
			transparent,
			revoked.proxy,
		]) {
			expect(() => isRegExp(value)).not.toThrow()
			expect(isRegExp(value)).toBe(false)
		}
		expect(reads).toBe(0)
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

	it('counts every own key for object emptiness, of any kind and any enumerability', () => {
		// The H9 tier-3 carrier. Counting only ENUMERABLE keys made the
		// `Record<string | symbol, never>` narrowing unsound: a record carrying an
		// own non-enumerable `hidden: 1` answered `isEmptyObject === true` while
		// `recordOf({})` saw the key and rejected the same value, and the
		// non-enumerable STRING and enumerable SYMBOL cases disagreed with each
		// other for no stated reason.
		const hidden = Symbol('hidden')
		const visible = Symbol('visible')
		const hiddenSymbol = Object.defineProperty({}, hidden, { value: true, enumerable: false })
		const hiddenString = Object.defineProperty({}, 'hidden', { value: 1, enumerable: false })
		const visibleSymbol = { [visible]: true }

		expect(Object.getOwnPropertyNames(hiddenString)).toEqual(['hidden'])
		expect(isEmptyObject(hiddenSymbol)).toBe(false)
		expect(isNonEmptyObject(hiddenSymbol)).toBe(true)
		expect(isEmptyObject(hiddenString)).toBe(false)
		expect(isNonEmptyObject(hiddenString)).toBe(true)
		expect(isEmptyObject(visibleSymbol)).toBe(false)
		expect(isNonEmptyObject(visibleSymbol)).toBe(true)
		// It now agrees with the guard that already saw the key.
		expect(recordOf({})(hiddenString)).toBe(false)
		// Controls: a genuinely empty record, of both shapes the guard accepts.
		expect(isEmptyObject({})).toBe(true)
		expect(isNonEmptyObject({})).toBe(false)
		expect(isEmptyObject(Object.create(null))).toBe(true)
	})

	it('isEmptyString is exact-empty — whitespace-only strings are NOT empty (AGENTS §14 fix)', () => {
		// Regression: isEmptyString previously used `.trim().length === 0`, which
		// classified '  ' as empty and directly contradicted isNonEmptyString
		// (which uses raw `.length > 0` and correctly calls '  ' non-empty). The
		// pair must be disjoint and exhaustive over every string.
		expect(isEmptyString('  ')).toBe(false)
		expect(isNonEmptyString('  ')).toBe(true)
		expect(isEmptyString('')).toBe(true)
		expect(isNonEmptyString('')).toBe(false)
		expect(isEmptyString('\t\n')).toBe(false)
		expect(isNonEmptyString('\t\n')).toBe(true)
	})

	describe('emptiness pairs are disjoint and exhaustive', () => {
		it('string pair', () => {
			const values = ['', 'value', '  ', 'a', ' ']
			for (const value of values) {
				expect(isEmptyString(value)).toBe(!isNonEmptyString(value))
			}
		})

		it('array pair', () => {
			const values: readonly unknown[][] = [[], [1], [undefined], [1, 2, 3]]
			for (const value of values) {
				expect(isEmptyArray(value)).toBe(!isNonEmptyArray(value))
			}
		})

		it('object pair', () => {
			const values: unknown[] = [{}, { a: 1 }, Object.create(null), { [Symbol('s')]: 1 }]
			for (const value of values) {
				expect(isEmptyObject(value)).toBe(!isNonEmptyObject(value))
			}
		})

		it('map pair', () => {
			const values = [
				new Map(),
				new Map([['a', 1]]),
				new Map([
					['a', 1],
					['b', 2],
				]),
			]
			for (const value of values) {
				expect(isEmptyMap(value)).toBe(!isNonEmptyMap(value))
			}
		})

		it('set pair', () => {
			const values = [new Set(), new Set([1]), new Set([1, 2])]
			for (const value of values) {
				expect(isEmptySet(value)).toBe(!isNonEmptySet(value))
			}
		})

		it('non-applicable types both report false (not a boolean partition outside their domain)', () => {
			expect(isEmptyString(42)).toBe(false)
			expect(isNonEmptyString(42)).toBe(false)
			expect(isEmptyArray({})).toBe(false)
			expect(isNonEmptyArray({})).toBe(false)
			expect(isEmptyObject([])).toBe(false)
			expect(isNonEmptyObject([])).toBe(false)
			expect(isEmptyMap(new Set())).toBe(false)
			expect(isNonEmptyMap(new Set())).toBe(false)
			expect(isEmptySet(new Map())).toBe(false)
			expect(isNonEmptySet(new Map())).toBe(false)
		})
	})
})

describe('reflective guards contain hostile getter/Proxy throws (AGENTS §14)', () => {
	it('isPromiseLike returns false, never throws, on a throwing then getter', () => {
		const hostile: unknown = {
			get then() {
				throw new Error('boom')
			},
		}
		expect(() => isPromiseLike(hostile)).not.toThrow()
		expect(isPromiseLike(hostile)).toBe(false)
	})

	it('isPromiseLike returns false, never throws, on throwing catch/finally getters', () => {
		const hostileCatch: unknown = {
			then() {
				return undefined
			},
			get catch() {
				throw new Error('boom')
			},
		}
		expect(() => isPromiseLike(hostileCatch)).not.toThrow()
		expect(isPromiseLike(hostileCatch)).toBe(false)

		const hostileFinally: unknown = {
			then() {
				return undefined
			},
			catch() {
				return undefined
			},
			get finally() {
				throw new Error('boom')
			},
		}
		expect(() => isPromiseLike(hostileFinally)).not.toThrow()
		expect(isPromiseLike(hostileFinally)).toBe(false)
	})

	it('isIterable returns false, never throws, on a throwing Symbol.iterator getter', () => {
		const hostile: unknown = {
			get [Symbol.iterator]() {
				throw new Error('boom')
			},
		}
		expect(() => isIterable(hostile)).not.toThrow()
		expect(isIterable(hostile)).toBe(false)
	})

	it('isAsyncIterable returns false, never throws, on a throwing Symbol.asyncIterator getter', () => {
		const hostile: unknown = {
			get [Symbol.asyncIterator]() {
				throw new Error('boom')
			},
		}
		expect(() => isAsyncIterable(hostile)).not.toThrow()
		expect(isAsyncIterable(hostile)).toBe(false)
	})

	it('isJSONValue returns false, never throws, on a throwing property getter', () => {
		const hostile: unknown = {
			get a() {
				throw new Error('boom')
			},
		}
		expect(() => isJSONValue(hostile)).not.toThrow()
		expect(isJSONValue(hostile)).toBe(false)
	})

	it('isJSONValue returns false, never throws, on a throwing getter nested inside an array', () => {
		const hostile: unknown = [
			1,
			{
				get b() {
					throw new Error('boom')
				},
			},
		]
		expect(() => isJSONValue(hostile)).not.toThrow()
		expect(isJSONValue(hostile)).toBe(false)
	})

	it('a revoked Proxy never throws — isRecord, isJSONValue, isObject all return false', () => {
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(() => isRecord(proxy)).not.toThrow()
		expect(isRecord(proxy)).toBe(false)
		expect(() => isJSONValue(proxy)).not.toThrow()
		expect(isJSONValue(proxy)).toBe(false)
		expect(() => isObject(proxy)).not.toThrow()
		// isObject is a plain typeof check with no reflective probe, so a revoked
		// Proxy — still an object at typeof-level — reports true; only the
		// probing guards (isRecord/isJSONValue) are exercised against a throw.
		expect(isObject(proxy)).toBe(true)
	})

	it('a revoked Proxy inside a JSON structure is caught by isJSONValue', () => {
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(() => isJSONValue({ nested: proxy })).not.toThrow()
		expect(isJSONValue({ nested: proxy })).toBe(false)
	})
})

describe('instanceof-family guards are total against hostile Proxy input (AGENTS §14)', () => {
	it('a revoked Proxy never throws — isDate, isMap, isPromise, a typed-array guard, isEmptyMap', () => {
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(() => isDate(proxy)).not.toThrow()
		expect(isDate(proxy)).toBe(false)
		expect(() => isMap(proxy)).not.toThrow()
		expect(isMap(proxy)).toBe(false)
		expect(() => isPromise(proxy)).not.toThrow()
		expect(isPromise(proxy)).toBe(false)
		expect(() => isUint8Array(proxy)).not.toThrow()
		expect(isUint8Array(proxy)).toBe(false)
		expect(() => isEmptyMap(proxy)).not.toThrow()
		expect(isEmptyMap(proxy)).toBe(false)
	})

	it('isInstance is total against a revoked Proxy and a getPrototypeOf-throwing Proxy', () => {
		const { proxy: revoked, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(() => isInstance(revoked, Date)).not.toThrow()
		expect(isInstance(revoked, Date)).toBe(false)

		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw new Error('boom')
				},
			},
		)
		expect(() => isInstance(hostile, Date)).not.toThrow()
		expect(isInstance(hostile, Date)).toBe(false)
		expect(isInstance(new Date(), Date)).toBe(true)
	})
})

describe('isEmptyObject / isNonEmptyObject are total against an ownKeys-throwing Proxy (AGENTS §14)', () => {
	it('returns false, never throws, when Object.keys throws via an ownKeys trap', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('boom')
				},
			},
		)
		expect(() => isEmptyObject(hostile)).not.toThrow()
		expect(isEmptyObject(hostile)).toBe(false)
		expect(() => isNonEmptyObject(hostile)).not.toThrow()
		expect(isNonEmptyObject(hostile)).toBe(false)
	})
})

describe('isRecord — realm-agnostic plain-object test', () => {
	it('accepts a null-prototype object', () => {
		const record: Record<string, unknown> = Object.create(null)
		record['id'] = 'plain'
		expect(isRecord(record)).toBe(true)
	})

	it('accepts a plain object from a genuine foreign realm', () => {
		// A real second realm, not a simulation of one: its direct prototype is
		// that realm's own `Object.prototype`, which carries the members every
		// conformant realm's `Object.prototype` carries.
		expect(isRecord(createForeignRecord())).toBe(true)
	})

	it('rejects an object whose prototype carries none of the realm object-prototype members', () => {
		// The construct a two-link prototype test cannot separate from a class
		// prototype reparented to `null`: no realm produces this chain for a plain
		// object, and accepting it accepted the class instance below with it.
		const bareIntermediate: object = Object.create(null)
		const simulatedPlain: unknown = Object.create(bareIntermediate)
		expect(isRecord(simulatedPlain)).toBe(false)
	})

	it('accepts an ordinary object literal', () => {
		expect(isRecord({})).toBe(true)
		expect(isRecord({ a: 1 })).toBe(true)
	})

	it('rejects a class instance (its prototype chain runs through the class prototype, not directly to null)', () => {
		class Example {
			readonly value = 1
		}
		expect(isRecord(new Example())).toBe(false)
	})

	it('rejects a class instance whose class prototype is reparented to null', () => {
		expect(isRecord(new NullBaseDeclaration())).toBe(false)
		expect(isRecord({ type: 'string', min: 1 })).toBe(true)
	})

	it('accepts a class instance whose prototype is forged into a realm prototype', () => {
		// The exact limit of the refusal above, kept honest. Reparenting alone
		// fails; reparenting AND stamping the mandated realm members passes, and
		// so does a Proxy in prototype position that answers the same questions
		// without touching the class at all. Nothing observable from outside a
		// realm separates a forged prototype from a genuine one, so this guard
		// answers `true` for a value that is still a live class instance.
		const proxied = createProxiedBrandDeclaration()

		expect(isRecord(new ProxiedBrandDeclaration())).toBe(false)
		expect(isRecord(new ForgedBrandDeclaration())).toBe(true)
		expect(isRecord(new StrippedBrandDeclaration())).toBe(true)
		expect(isRecord(proxied)).toBe(true)
		expect(typeof Reflect.get(proxied, 'escape')).toBe('function')
	})

	it('rejects an array', () => {
		expect(isRecord([])).toBe(false)
		expect(isRecord([1, 2, 3])).toBe(false)
	})

	it('rejects a Date', () => {
		expect(isRecord(new Date())).toBe(false)
	})

	it('rejects null and non-objects', () => {
		expect(isRecord(null)).toBe(false)
		expect(isRecord(undefined)).toBe(false)
		expect(isRecord('record')).toBe(false)
		expect(isRecord(42)).toBe(false)
	})
})

describe('isJSONValue — cycles, NaN/Infinity, and deep nesting', () => {
	it('rejects a self-referencing record', () => {
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		expect(isJSONValue(cycle)).toBe(false)
	})

	it('rejects a self-referencing array', () => {
		const cycle: unknown[] = []
		cycle.push(cycle)
		expect(isJSONValue(cycle)).toBe(false)
	})

	it('rejects NaN and ±Infinity anywhere in the structure', () => {
		expect(isJSONValue(Number.NaN)).toBe(false)
		expect(isJSONValue(Number.POSITIVE_INFINITY)).toBe(false)
		expect(isJSONValue(Number.NEGATIVE_INFINITY)).toBe(false)
		expect(isJSONValue({ n: Number.NaN })).toBe(false)
		expect(isJSONValue([1, Number.POSITIVE_INFINITY])).toBe(false)
	})

	it('accepts deeply nested valid JSON structures', () => {
		const deep = {
			a: {
				b: {
					c: [1, 2, { d: ['x', 'y', { e: null }] }],
				},
			},
		}
		expect(isJSONValue(deep)).toBe(true)
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

describe('validator totality sweep', () => {
	it('every exported is* guard returns a boolean for every hostile fixture', () => {
		const guards: readonly ((value: unknown) => boolean)[] = [
			isNull,
			isUndefined,
			isDefined,
			isString,
			isNumber,
			isFiniteNumber,
			isInteger,
			isBoolean,
			isTrue,
			isFalse,
			isBigInt,
			isSymbol,
			isFunction,
			isNullableString,
			isNullableNumber,
			isNullableBoolean,
			isDate,
			isRegExp,
			isError,
			isPromise,
			isPromiseLike,
			isArrayBuffer,
			isSharedArrayBuffer,
			isIterable,
			isAsyncIterable,
			isObject,
			isRecord,
			isMap,
			isSet,
			isWeakMap,
			isWeakSet,
			isArray,
			isDataView,
			isArrayBufferView,
			isInt8Array,
			isUint8Array,
			isUint8ClampedArray,
			isInt16Array,
			isUint16Array,
			isInt32Array,
			isUint32Array,
			isFloat32Array,
			isFloat64Array,
			isBigInt64Array,
			isBigUint64Array,
			isEmptyString,
			isEmptyArray,
			isEmptyObject,
			isEmptyMap,
			isEmptySet,
			isNonEmptyString,
			isNonEmptyArray,
			isNonEmptyObject,
			isNonEmptyMap,
			isNonEmptySet,
			isZeroArg,
			isAsyncFunction,
			isGeneratorFunction,
			isAsyncGeneratorFunction,
			isZeroArgAsync,
			isZeroArgGenerator,
			isZeroArgAsyncGenerator,
			isConstructor,
			isJSONValue,
			isJSONPrimitive,
		]
		const hostile: readonly unknown[] = [
			createRevokedProxy(),
			createRevokedArrayProxy(),
			createThrowingGetter(),
			createHostileKeys(),
			buildDeepNest(10_000),
			buildCyclicRecord(),
			buildCyclicArray(),
			buildSparseArray(),
		]

		for (const value of hostile) {
			for (const guard of guards) {
				expect(() => guard(value)).not.toThrow()
				expect(typeof guard(value)).toBe('boolean')
			}
			expect(() => isInstance(value, Date)).not.toThrow()
			expect(typeof isInstance(value, Date)).toBe('boolean')
		}
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

describe('non-negative numeric guards', () => {
	it('accepts only finite primitive positive numbers and positive zero', () => {
		const values: readonly unknown[] = [0, 0.5, 1, Number.MAX_SAFE_INTEGER + 1]
		for (const value of values) {
			expect(isNonNegativeNumber(value)).toBe(true)
			if (isNonNegativeNumber(value)) expectTypeOf(value).toEqualTypeOf<number>()
		}

		for (const value of [
			-0,
			-0.5,
			-1,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			new Number(1),
			{ valueOf: Number },
			'1',
			1n,
			null,
			undefined,
			Symbol('number'),
			{},
			[],
			() => 1,
		]) {
			expect(isNonNegativeNumber(value)).toBe(false)
		}
		expect(Object.is(-0, 0)).toBe(false)
	})

	it('adds integer shape without imposing safe-integer policy', () => {
		for (const value of [0, 1, Number.MAX_SAFE_INTEGER + 1]) {
			expect(isNonNegativeInteger(value)).toBe(true)
			if (isNonNegativeInteger(value)) expectTypeOf(value).toEqualTypeOf<number>()
		}
		for (const value of [-0, 0.5, -1, Number.NaN, Number.POSITIVE_INFINITY, '1', 1n]) {
			expect(isNonNegativeInteger(value)).toBe(false)
		}
	})
})

describe('bounded JSON guards', () => {
	it('narrows valid JSON values and requires a plain-record root for records', () => {
		const value: unknown = { nested: [1, 'two', null] }
		const array: unknown = [1, 2, 3]

		expect(isBoundedJSONValue(value)).toBe(true)
		if (isBoundedJSONValue(value)) expectTypeOf(value).toEqualTypeOf<JSONValue>()
		expect(isBoundedJSONRecord(value)).toBe(true)
		if (isBoundedJSONRecord(value)) expectTypeOf(value).toEqualTypeOf<JSONRecord>()
		expect(isBoundedJSONValue(array)).toBe(true)
		expect(isBoundedJSONRecord(array)).toBe(false)
	})

	it('accepts ordinary, null-prototype, and genuine foreign-realm records', () => {
		const nullPrototype: Record<string, unknown> = Object.create(null)
		nullPrototype['value'] = 1

		for (const value of [{ value: 1 }, nullPrototype, createForeignRecord()]) {
			expect(isBoundedJSONValue(value)).toBe(true)
			expect(isBoundedJSONRecord(value)).toBe(true)
		}
	})

	it('distinguishes depth readability from JSON validity', () => {
		const sparse = buildSparseArray()
		const shallowCycle: unknown[] = []
		shallowCycle.push(shallowCycle)
		const boundaryCycle: unknown[] = []
		let cursor = boundaryCycle
		for (let depth = 1; depth < GUARD_DEPTH_LIMIT; depth += 1) {
			const child: unknown[] = []
			cursor.push(child)
			cursor = child
		}
		cursor.push(boundaryCycle)

		for (const value of [sparse, shallowCycle, boundaryCycle, new Date(), new Map()]) {
			expect(isBoundedJSONValue(value)).toBe(false)
		}
	})

	it('short-circuits the depth pass before JSON validation', () => {
		let reads = 0
		const deep = buildDeepNest(GUARD_DEPTH_LIMIT)
		const value = Object.defineProperty({}, 'nested', {
			get() {
				reads += 1
				return deep
			},
			enumerable: true,
		})

		expect(isBoundedJSONValue(value)).toBe(false)
		expect(reads).toBe(1)
	})

	it('performs sequential total observations rather than promising one atomic snapshot', () => {
		let reads = 0
		const value = Object.defineProperty({}, 'state', {
			get() {
				reads += 1
				return reads === 1 ? 1 : () => 1
			},
			enumerable: true,
		})

		expect(isBoundedJSONValue(value)).toBe(false)
		expect(reads).toBe(2)
	})

	it('stays total for hostile records and arrays', () => {
		for (const value of [
			createThrowingGetter(),
			createHostileKeys(),
			createRevokedProxy(),
			createRevokedArrayProxy(),
		]) {
			expect(() => isBoundedJSONValue(value)).not.toThrow()
			expect(isBoundedJSONValue(value)).toBe(false)
			expect(() => isBoundedJSONRecord(value)).not.toThrow()
			expect(isBoundedJSONRecord(value)).toBe(false)
		}
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
