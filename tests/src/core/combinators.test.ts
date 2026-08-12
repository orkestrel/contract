import type { Guard, GuardsShape } from '@src/core'
import {
	andOf,
	arrayOf,
	attempt,
	boundsOf,
	complementOf,
	enumOf,
	GUARD_DEPTH_LIMIT,
	instanceOf,
	intersectionOf,
	isBoolean,
	isEmptyString,
	isFunction,
	isInstance,
	isNull,
	isNumber,
	isRegExp,
	isString,
	keyOf,
	lazyOf,
	literalOf,
	mapOf,
	matchOf,
	notOf,
	nullableOf,
	omitOf,
	optionalOf,
	orOf,
	pickOf,
	recordOf,
	setOf,
	stringShape,
	stringOf,
	transformOf,
	tupleOf,
	unionOf,
	whereOf,
} from '@src/core'
import {
	buildCyclicArray,
	buildCyclicRecord,
	buildDeepNest,
	buildSparseArray,
	buildWideVocabulary,
	captureContractError,
	createHostileKeys,
	createRevokedArrayProxy,
	createRevokedProxy,
	createThrowingGetter,
	replaceIntrinsic,
	throwHostileAccess,
} from '../../setup.js'
import { createForeignPrototype, createForeignRegExp } from '../../setupServer.js'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('element combinators', () => {
	it('validates arrays and tuples', () => {
		const strings = arrayOf(isString)
		expect(strings(['a', 'b'])).toBe(true)
		expect(strings(['a', 1])).toBe(false)
		expect(strings({})).toBe(false)

		const pair = tupleOf(isString, isNumber)
		expect(pair(['a', 1])).toBe(true)
		expect(pair(['a', 'b'])).toBe(false)
		expect(pair(['a'])).toBe(false)
	})

	it('arrayOf and tupleOf reject sparse arrays even when their guards allow undefined', () => {
		const sparse = buildSparseArray()
		expect(arrayOf(optionalOf(isString))(sparse)).toBe(false)
		expect(tupleOf(optionalOf(isString), isString, optionalOf(isString))(sparse)).toBe(false)
	})

	it('arrayOf refuses split index membership and accepts the dense control', () => {
		const split = new Proxy([1, 2], {
			ownKeys() {
				return ['0', 'length']
			},
			getOwnPropertyDescriptor(target, property) {
				return property === '0' ? undefined : Reflect.getOwnPropertyDescriptor(target, property)
			},
		})
		const guard = arrayOf(isNumber)

		expect(guard(split)).toBe(false)
		expect(guard([1, 2])).toBe(true)
	})

	it('tupleOf derives hostile arity and entries from one dense own-index view', () => {
		const value = new Proxy(['a', 1, true], {
			get(target, key, receiver) {
				return key === 'length' ? 1 : Reflect.get(target, key, receiver)
			},
		})

		expect(tupleOf(isString)(value)).toBe(false)
	})

	it('validates maps and sets', () => {
		expect(mapOf(isString, isNumber)(new Map([['a', 1]]))).toBe(true)
		expect(mapOf(isString, isNumber)(new Map([['a', '1']]))).toBe(false)
		expect(setOf(isNumber)(new Set([1, 2]))).toBe(true)
		expect(setOf(isNumber)(new Set([1, '2']))).toBe(false)
	})
})

describe('literal and enum combinators', () => {
	it('validates literal and enum values', () => {
		const literal = literalOf('a', 'b', 1)
		expect(literal('a')).toBe(true)
		expect(literal('b')).toBe(true)
		expect(literal(1)).toBe(true)
		expect(literal('c')).toBe(false)

		const color = enumOf({ Red: 'RED', Blue: 'BLUE' })
		expect(color('RED')).toBe(true)
		expect(color('BLUE')).toBe(true)
		expect(color('GREEN')).toBe(false)
	})

	it('enumOf refuses an unreadable enumeration with a coded read error', () => {
		const enumeration = new Proxy(
			{ a: 1 },
			{
				get() {
					throw new Error('hostile read')
				},
			},
		)
		const error = captureContractError(() => enumOf(enumeration))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('enumOf: enumeration could not be read')
	})

	it('enumOf narrows an inline object literal argument to its literal value union (type-level)', () => {
		const isDirection = enumOf({ Up: 'up', Down: 'down' })
		expectTypeOf(isDirection).toEqualTypeOf<Guard<'up' | 'down'>>()
		const value: unknown = 'up'
		if (isDirection(value)) {
			expectTypeOf(value).toEqualTypeOf<'up' | 'down'>()
		}
	})

	it('enumOf keeps a wide record variable wide (type-level lock)', () => {
		const values: Record<string, string> = { Up: 'up', Down: 'down' }
		const isDirection = enumOf(values)
		expectTypeOf(isDirection).toEqualTypeOf<Guard<string>>()
		expect(isDirection('up')).toBe(true)
		expect(isDirection('left')).toBe(false)
	})

	it('enumOf narrows a native enum argument to its member union (type-level lock)', () => {
		enum Direction {
			Up = 'up',
			Down = 'down',
		}
		const isDirection = enumOf(Direction)
		const value: unknown = Direction.Up
		if (isDirection(value)) {
			expectTypeOf(value).toEqualTypeOf<Direction>()
		}
		expect(isDirection('up')).toBe(true)
		expect(isDirection('left')).toBe(false)
	})

	it('literalOf uses SameValueZero semantics for NaN and signed zero', () => {
		expect(literalOf(Number.NaN)(Number.NaN)).toBe(true)
		expect(literalOf(0)(-0)).toBe(true)
		expect(literalOf(-0)(0)).toBe(true)
		expect(literalOf(-0)(-0)).toBe(true)
	})

	it('literalOf accepts one array of literals as the same guard the listed form builds', () => {
		const vocabulary: readonly ['a', 'b', 1, true] = ['a', 'b', 1, true]
		const listed = literalOf(...vocabulary)
		const collected = literalOf(vocabulary)

		for (const value of [...vocabulary, 'c', 0, false, null, undefined, ['a']]) {
			expect(collected(value)).toBe(listed(value))
		}
		expect(collected('a')).toBe(true)
		expect(collected('c')).toBe(false)
	})

	it('literalOf keeps SameValueZero semantics in the array form', () => {
		expect(literalOf([Number.NaN])(Number.NaN)).toBe(true)
		expect(literalOf([0])(-0)).toBe(true)
		expect(literalOf([-0])(0)).toBe(true)
	})

	it('literalOf array vocabularies ignore caller-defined iteration', () => {
		const vocabulary = ['indexed']
		const iterated = ['iterated']
		Object.defineProperty(vocabulary, Symbol.iterator, {
			value: iterated[Symbol.iterator].bind(iterated),
		})
		const guard = literalOf(vocabulary)

		expect(guard('indexed')).toBe(true)
		expect(guard('iterated')).toBe(false)
	})

	it('literalOf refuses an impossible reported vocabulary length without caller iteration', () => {
		const iterated = ['iterated']
		const vocabulary = new Proxy(['indexed'], {
			get(target, key, receiver) {
				if (key === 'length') return 2 ** 32
				if (key === Symbol.iterator) return iterated[Symbol.iterator].bind(iterated)
				return Reflect.get(target, key, receiver)
			},
		})

		const error = captureContractError(() => literalOf(vocabulary))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('literalOf: literals could not be read')
	})

	it('literalOf narrows the array form to the same literal union as the listed form (type-level)', () => {
		const listed = literalOf('admin', 'member')
		const collected = literalOf(['admin', 'member'])
		expectTypeOf(collected).toEqualTypeOf<typeof listed>()
	})

	it('literalOf takes a vocabulary too large to spread into arguments', () => {
		const vocabulary = buildWideVocabulary()
		const guard = literalOf(vocabulary)

		expect(guard('value0')).toBe(true)
		expect(guard(vocabulary[vocabulary.length - 1])).toBe(true)
		expect(guard('absent')).toBe(false)
	})

	it('refuses unreadable literal vocabularies with the shared coded boundary', () => {
		const error = captureContractError(() =>
			Reflect.apply(literalOf, undefined, [createRevokedArrayProxy()]),
		)

		expect(error.code).toBe('structure')
		expect(error.message).toBe('literalOf: literals could not be read')
	})

	it('classifies a readable malformed literal vocabulary as invalid', () => {
		const error = captureContractError(() =>
			Reflect.apply(literalOf, undefined, [['a', null, 'b']]),
		)

		expect(error.code).toBe('literal')
		expect(error.message).toBe(
			'literalOf: literals must contain only string, number, or boolean values',
		)
		expect(error.context).toEqual({ path: ['literals'], shape: 'literal' })
	})
})

describe('recordOf, pickOf, omitOf', () => {
	it('validates exact object shapes with optional keys', () => {
		const user = recordOf({ id: isString, age: isNumber })
		expect(user({ id: 'u1', age: 1 })).toBe(true)
		expect(user({ id: 'u1' })).toBe(false)
		expect(user({ id: 'u1', age: 1, extra: true })).toBe(false)

		const optionalUser = recordOf({ id: isString, note: isString }, ['note'])
		expect(optionalUser({ id: 'u1' })).toBe(true)
		expect(optionalUser({ id: 'u1', note: 'hi' })).toBe(true)
		expect(optionalUser({ id: 'u1', note: 1 })).toBe(false)
		expect(optionalUser({ id: 'u1', note: undefined })).toBe(false)

		const partialUser = recordOf({ id: isString, age: isNumber }, true)
		expect(partialUser({})).toBe(true)
		expect(partialUser({ id: 'x' })).toBe(true)
		expect(partialUser({ id: 1 })).toBe(false)
		expect(partialUser({ id: undefined })).toBe(false)
	})

	it('ignores extra symbol keys but rejects extra string keys', () => {
		const symbolKey = Symbol('record')
		const recordWithSymbol: unknown = { id: 'u1', [symbolKey]: 123 }
		expect(recordOf({ id: isString })(recordWithSymbol)).toBe(true)
		expect(recordOf({ id: isString })({ id: 'u1', extra: true })).toBe(false)
	})

	it('rejects non-enumerable extra own string keys', () => {
		const value = Object.defineProperty({ id: 'u1' }, 'hidden', {
			value: true,
			enumerable: false,
		})
		expect(recordOf({ id: isString })(value)).toBe(false)
	})

	it('returns false for non-record inputs without throwing', () => {
		const guard = recordOf({ id: isString })
		expect(() => guard(null)).not.toThrow()
		expect(guard(null)).toBe(false)
		expect(guard(['x'])).toBe(false)
		expect(guard(42)).toBe(false)
	})

	it('supports pick and omit', () => {
		const shape = { id: isString, age: isNumber, name: isString }
		const picked = pickOf(shape, ['id', 'name'])
		const omitted = omitOf(shape, ['age'])

		expect(recordOf(picked)({ id: 'x', name: 'y' })).toBe(true)
		expect(recordOf(picked)({ id: 'x' })).toBe(false)
		expect(recordOf(omitted)({ id: 'x', name: 'y' })).toBe(true)
		expect(recordOf(omitted)({ id: 'x', name: 'y', age: 1 })).toBe(false)
	})

	it('refuses unreadable factory containers at every shape-derived sibling', () => {
		const hostile = createHostileKeys()
		for (const [reader, run] of [
			['recordOf', () => Reflect.apply(recordOf, undefined, [hostile])],
			['pickOf', () => Reflect.apply(pickOf, undefined, [hostile, ['id']])],
			['omitOf', () => Reflect.apply(omitOf, undefined, [hostile, ['id']])],
		] satisfies ReadonlyArray<readonly [string, () => unknown]>) {
			const error = captureContractError(run)
			expect(error.code).toBe('structure')
			expect(error.message).toBe(`${reader}: shape could not be read`)
		}
	})

	it('recordOf owns every consumed guard once at construction', () => {
		let reads = 0
		const source: { a: Guard<unknown> } = { a: isString }
		const shape = new Proxy(source, {
			get(target, key, receiver) {
				if (key === 'a') reads += 1
				return Reflect.get(target, key, receiver)
			},
		})
		const guard = recordOf(shape)

		expect(reads).toBe(1)
		expect(guard({ a: 'value' })).toBe(true)
		expect(guard({ a: 1 })).toBe(false)
		expect(reads).toBe(1)
	})

	it('recordOf guard meaning cannot drift after construction', () => {
		const shape: { a: Guard<unknown> } = { a: isString }
		const guard = recordOf(shape)
		shape.a = isNumber

		expect(guard({ a: 'value' })).toBe(true)
		expect(guard({ a: 1 })).toBe(false)
	})

	it('recordOf requires own non-enumerable string declarations only', () => {
		const symbol = Symbol('guard')
		const shape: GuardsShape = {}
		Object.setPrototypeOf(shape, { inherited: isNumber })
		Object.defineProperty(shape, symbol, { value: isBoolean })
		Object.defineProperty(shape, 'hidden', {
			value: isString,
			enumerable: false,
		})
		const guard = recordOf(shape)

		expect(guard({})).toBe(false)
		expect(guard({ hidden: 'value' })).toBe(true)
		expect(guard({ hidden: 1 })).toBe(false)
		expect(guard({ hidden: 'value', inherited: 1 })).toBe(false)
		expect(guard({ hidden: 'value', [symbol]: true })).toBe(true)
	})

	it('recordOf owns optional membership before caller-list mutation', () => {
		const optional: Array<'note'> = ['note']
		const guard = recordOf({ id: isString, note: isString }, optional)
		optional.length = 0

		expect(guard({ id: 'u1' })).toBe(true)
		expect(guard({ note: 'hello' })).toBe(false)
		expect(guard({ id: 'u1', note: 'hello' })).toBe(true)
		expect(guard({ id: 'u1', note: 1 })).toBe(false)
	})

	it('recordOf refuses an unreadable optional-key list at construction', () => {
		const error = captureContractError(() =>
			recordOf({ a: isString }, createRevokedArrayProxy<'a'>()),
		)

		expect(error.code).toBe('structure')
		expect(error.message).toBe('recordOf: optional could not be read')
	})

	it('pickOf and omitOf both require the complete own-key population', () => {
		const shape = new Proxy(
			{ a: isString },
			{
				ownKeys() {
					throw new Error('hostile own keys')
				},
			},
		)

		for (const [reader, run] of [
			['pickOf', () => pickOf(shape, ['a'])],
			['omitOf', () => omitOf(shape, [])],
		] satisfies ReadonlyArray<readonly [string, () => unknown]>) {
			const error = captureContractError(run)
			expect(error.code).toBe('structure')
			expect(error.message).toBe(`${reader}: shape could not be read`)
		}
	})

	it('pickOf and omitOf do not read an unrelated prototype', () => {
		const shape = new Proxy(
			{ a: isString, b: isNumber },
			{
				getPrototypeOf() {
					throw new Error('prototype must not be read')
				},
			},
		)

		expect(pickOf(shape, ['a'])).toEqual({ a: isString })
		expect(omitOf(shape, ['b'])).toEqual({ a: isString })
	})

	it('pickOf and omitOf preserve own non-enumerable string declarations', () => {
		const shape: GuardsShape = {}
		Object.defineProperty(shape, 'hidden', {
			value: isString,
			enumerable: false,
		})

		const picked = pickOf(shape, ['hidden'])
		const omitted = omitOf(shape, [])
		expect(Object.hasOwn(picked, 'hidden')).toBe(true)
		expect(Object.hasOwn(omitted, 'hidden')).toBe(true)
		expect(picked.hidden).toBe(isString)
		expect(omitted.hidden).toBe(isString)
	})

	it('lock: recordOf with an inline literal shape and bare optional literal marks only the listed key optional', () => {
		const optionalUser = recordOf({ id: isString, note: isString }, ['note'])
		expectTypeOf(optionalUser).toEqualTypeOf<Guard<Readonly<{ id: string; note?: string }>>>()
		const value: unknown = { id: 'u1' }
		if (optionalUser(value)) {
			expectTypeOf(value.id).toEqualTypeOf<string>()
			expectTypeOf(value.note).toEqualTypeOf<string | undefined>()
		}
	})

	it('lock: recordOf with optional: true marks every key as a true optional member', () => {
		const partialUser = recordOf({ id: isString, age: isNumber }, true)
		expectTypeOf(partialUser).toEqualTypeOf<Guard<Readonly<{ id?: string; age?: number }>>>()
	})

	it("lock: recordOf with a wide GuardsShape variable and bare ['a'] infers K as readonly ['a']", () => {
		const wideShape: GuardsShape = { a: isString, b: isNumber }
		const guard = recordOf(wideShape, ['a'])
		const value: unknown = { a: 'x', b: 1 }
		// A record missing the unlisted key `b` must still be rejected at runtime —
		// proof that only 'a' was inferred as optional, not the whole wide shape.
		expect(guard(value)).toBe(true)
		expect(guard({ a: 'x' })).toBe(false)
	})

	it('lock: pickOf/omitOf preserve bare-literal key inference', () => {
		const shape = { id: isString, age: isNumber, name: isString }
		const picked = pickOf(shape, ['id', 'name'])
		const omitted = omitOf(shape, ['age'])
		expectTypeOf(picked).toEqualTypeOf<Pick<typeof shape, 'id' | 'name'>>()
		expectTypeOf(omitted).toEqualTypeOf<Omit<typeof shape, 'age'>>()
	})

	it("lock (runtime): recordOf(wide, ['a']) rejects a record missing required 'b'", () => {
		const wideShape: GuardsShape = { a: isString, b: isNumber }
		const guard = recordOf(wideShape, ['a'])
		expect(guard({ a: 'x', b: 1 })).toBe(true)
		expect(guard({ a: 'x' })).toBe(false)
		expect(guard({})).toBe(false)
	})

	describe('inherited-key semantics (own-property only)', () => {
		it('rejects a shape key satisfied only by an inherited prototype member', () => {
			expect(recordOf({ toString: isFunction })({})).toBe(false)
			expect(recordOf({ constructor: isFunction })({})).toBe(false)
			expect(recordOf({ valueOf: isFunction })({})).toBe(false)
			expect(recordOf({ hasOwnProperty: isFunction })({})).toBe(false)
		})

		it('accepts a genuine own property that shadows a prototype name', () => {
			const own = { toString() {} }
			expect(recordOf({ toString: isFunction })(own)).toBe(true)
			expect(recordOf({ toString: isString })({ toString: 'x' })).toBe(true)
			expect(recordOf({ toString: isString })({ toString: 1 })).toBe(false)
		})

		it('treats an inherited-named optional key as absent, not present-via-prototype', () => {
			const optList = recordOf({ id: isString, toString: isString }, ['toString'])
			expect(optList({ id: 'u1' })).toBe(true)
			expect(optList({ id: 'u1', toString: 'hi' })).toBe(true)
			expect(optList({ id: 'u1', toString: 1 })).toBe(false)

			const allOpt = recordOf({ toString: isString }, true)
			expect(allOpt({})).toBe(true)
		})
	})
})

describe('keyOf', () => {
	it('accepts own keys and rejects missing ones', () => {
		expect(keyOf({ a: 1, b: 2 })('a')).toBe(true)
		expect(keyOf({ a: 1, b: 2 })('c')).toBe(false)
	})

	it('rejects inherited Object.prototype keys (own-property semantics, not `in`)', () => {
		const guard = keyOf({ a: 1 })
		expect(guard('toString')).toBe(false)
		expect(guard('constructor')).toBe(false)
		expect(guard('hasOwnProperty')).toBe(false)
		expect(guard('valueOf')).toBe(false)
		expect(guard('__proto__')).toBe(false)
		expect(guard('a')).toBe(true)
	})

	it('accepts an own key that shadows a prototype name', () => {
		expect(keyOf({ toString: 1 })('toString')).toBe(true)
		expect(keyOf({ constructor: 'x' })('constructor')).toBe(true)
	})

	it('handles symbol and numeric keys', () => {
		const sym = Symbol('key')
		expect(keyOf({ [sym]: 42 })(sym)).toBe(true)
		expect(keyOf({ a: 1 })(Symbol('absent'))).toBe(false)
		const numeric = keyOf({ 0: 'zero', 1: 'one' })
		expect(numeric(0)).toBe(true)
		expect(numeric(2)).toBe(false)
	})

	it('returns false for non-key-typed input rather than throwing', () => {
		const guard = keyOf({ a: 1 })
		expect(guard(null)).toBe(false)
		expect(guard(undefined)).toBe(false)
		expect(guard({})).toBe(false)
		expect(guard(true)).toBe(false)
	})

	it('owns all own property keys and remains stable after source mutation', () => {
		const symbol = Symbol('owned')
		const source: Record<PropertyKey, unknown> = { 0: 'zero', a: 1, [symbol]: 2 }
		const guard = keyOf(source)
		delete source.a
		source.b = 3

		expect(guard('a')).toBe(true)
		expect(guard('b')).toBe(false)
		expect(guard(symbol)).toBe(true)
		expect(guard(0)).toBe(true)
	})

	it('refuses an unreadable key source at construction', () => {
		const error = captureContractError(() =>
			Reflect.apply(keyOf, undefined, [createRevokedProxy()]),
		)

		expect(error.code).toBe('structure')
		expect(error.message).toBe('keyOf: value could not be read')
	})
})

describe('logical combinators', () => {
	it('combines guards with andOf / orOf / notOf', () => {
		const nonEmptyString = andOf(isString, (value: string): value is string => value.length > 0)
		expect(nonEmptyString('x')).toBe(true)
		expect(nonEmptyString('')).toBe(false)

		const ab = orOf(literalOf('a'), literalOf('b'))
		expect(ab('a')).toBe(true)
		expect(ab('b')).toBe(true)
		expect(ab('c')).toBe(false)

		const notString = notOf(isString)
		expect(notString('x')).toBe(false)
		expect(notString(1)).toBe(true)
	})

	it('excludes a subset with complementOf', () => {
		const circle = recordOf({ kind: literalOf('circle'), r: isNumber })
		const shape = orOf(circle, recordOf({ kind: literalOf('rect'), w: isNumber, h: isNumber }))
		const notCircle = complementOf(shape, circle)
		expect(notCircle({ kind: 'rect', w: 1, h: 2 })).toBe(true)
		expect(notCircle({ kind: 'circle', r: 3 })).toBe(false)
	})

	it('combines variadically with unionOf / intersectionOf', () => {
		const union = unionOf(literalOf('a'), literalOf('b'))
		expect(union('a')).toBe(true)
		expect(union('b')).toBe(true)
		expect(union('c')).toBe(false)

		const intersection = intersectionOf(
			(value: unknown): value is string => isString(value) && /^[A-Za-z]+$/.test(value),
			(value: unknown): value is string => isString(value) && value.length === 2,
		)
		expect(intersection('ab')).toBe(true)
		expect(intersection('a1')).toBe(false)
		expect(intersection('abc')).toBe(false)
	})
})

describe('refinement, laziness, transforms, nullability', () => {
	it('refines a base guard with whereOf', () => {
		const nonEmpty = whereOf(isString, (value) => value.length > 0)
		expect(nonEmpty('a')).toBe(true)
		expect(nonEmpty('')).toBe(false)
	})

	it('whereOf narrows the result type with a type-guard predicate', () => {
		// A narrowing predicate refines Guard<number> → Guard<5>; the runtime guard
		// passes only when the value is genuinely 5.
		const isFive = whereOf(isNumber, (n): n is 5 => n === 5)
		expect(isFive(5)).toBe(true)
		expect(isFive(4)).toBe(false)
		expect(isFive('5')).toBe(false)
		// Type-level: the narrowed value is usable as a literal `5`.
		const value: unknown = 5
		const five: number | undefined = isFive(value) ? value : undefined
		expect(five).toBe(5)
	})

	it('defers guard resolution with lazyOf on every call', () => {
		let buildCount = 0
		const lazyString = lazyOf(() => {
			buildCount += 1
			return isString
		})
		expect(buildCount).toBe(0)
		expect(lazyString('tree')).toBe(true)
		expect(lazyString(1)).toBe(false)
		expect(buildCount).toBe(2)
	})

	it('supports self-referential recursive guards via lazyOf', () => {
		interface Tree {
			readonly value: number
			readonly children: readonly Tree[]
		}
		// Hold the guard in a mutable cell so the thunk reads the final guard
		// after assignment — the canonical lazyOf recursion pattern, without a
		// self-referential `let` binding.
		const cell: { guard: Guard<Tree> } = {
			guard: (_value: unknown): _value is Tree => false,
		}
		cell.guard = recordOf({ value: isNumber, children: arrayOf(lazyOf(() => cell.guard)) })
		const isTree = cell.guard

		expect(isTree({ value: 1, children: [] })).toBe(true)
		expect(isTree({ value: 1, children: [{ value: 2, children: [] }] })).toBe(true)
		expect(isTree({ value: 'x', children: [] })).toBe(false)
		expect(isTree({ value: 1, children: [{ value: 'y', children: [] }] })).toBe(false)
	})

	it('bounds lazyOf-rooted recursion by design and resets after each call', () => {
		const cell: { guard: Guard<unknown> } = {
			guard: (_value: unknown): _value is unknown => false,
		}
		const lazy = lazyOf(() => cell.guard)
		cell.guard = unionOf(isString, arrayOf(lazy), recordOf({ value: lazy }))

		expect(GUARD_DEPTH_LIMIT).toBe(512)
		expect(() => cell.guard(buildDeepNest(10_000))).not.toThrow()
		expect(cell.guard(buildDeepNest(10_000))).toBe(false)
		expect(cell.guard(buildDeepNest(100))).toBe(true)
		expect(cell.guard('leaf')).toBe(true)
	})

	it('guards a projected value with transformOf', () => {
		const positiveLength = transformOf(
			isString,
			(value) => value.length,
			(value: unknown): value is number => isNumber(value) && value > 0,
		)
		expect(positiveLength('abc')).toBe(true)
		expect(positiveLength('')).toBe(false)
		expect(positiveLength(42)).toBe(false)
	})

	it('extends a guard with null tolerance via nullableOf', () => {
		const maybeString = nullableOf(isString)
		expect(maybeString(null)).toBe(true)
		expect(maybeString('x')).toBe(true)
		expect(maybeString(1)).toBe(false)
		// Adds null, NOT undefined.
		expect(maybeString(undefined)).toBe(false)
	})
})

describe('boundsOf', () => {
	it('accepts finite numbers within inclusive bounds', () => {
		const inRange = boundsOf(1, 3)
		expect(inRange(1)).toBe(true) // lower edge
		expect(inRange(2)).toBe(true)
		expect(inRange(3)).toBe(true) // upper edge
		expect(inRange(0)).toBe(false) // below min
		expect(inRange(4)).toBe(false) // above max
	})

	it('treats an absent bound as unconstrained on that side', () => {
		const atLeastTwo = boundsOf(2)
		expect(atLeastTwo(2)).toBe(true)
		expect(atLeastTwo(1_000_000)).toBe(true)
		expect(atLeastTwo(1)).toBe(false)

		const atMostTen = boundsOf(undefined, 10)
		expect(atMostTen(-1_000)).toBe(true)
		expect(atMostTen(10)).toBe(true)
		expect(atMostTen(11)).toBe(false)

		const unbounded = boundsOf()
		expect(unbounded(0)).toBe(true)
		expect(unbounded(-5)).toBe(true)
		expect(unbounded(5)).toBe(true)
	})

	it('rejects non-finite numbers and non-numbers (refines isFiniteNumber)', () => {
		const inRange = boundsOf(0, 10)
		expect(inRange(Number.NaN)).toBe(false)
		expect(inRange(Number.POSITIVE_INFINITY)).toBe(false)
		expect(inRange(Number.NEGATIVE_INFINITY)).toBe(false)
		// NaN is rejected even when the range is unbounded — the base guard excludes it.
		expect(boundsOf()(Number.NaN)).toBe(false)
		expect(inRange('5')).toBe(false)
		expect(inRange(null)).toBe(false)
	})
})

describe('matchOf', () => {
	it('accepts strings that match the pattern and rejects misses', () => {
		const isHex = matchOf(/^[0-9a-f]+$/)
		expect(isHex('1a2f')).toBe(true)
		expect(isHex('xyz')).toBe(false)
		expect(isHex('')).toBe(false) // requires at least one char
	})

	it('rejects non-strings without throwing (refines isString)', () => {
		const guard = matchOf(/^a+$/)
		expect(guard(42)).toBe(false)
		expect(guard(null)).toBe(false)
		expect(guard(['a'])).toBe(false)
	})

	it('clones a global pattern into a stateless guard without mutating the caller', () => {
		const pattern = /^a+$/g
		pattern.lastIndex = 1
		const guard = matchOf(pattern)

		expect(guard('aaa')).toBe(true)
		expect(guard('aaa')).toBe(true)
		expect(pattern.lastIndex).toBe(1)
	})

	it('owns a genuine foreign pattern and strips its stateful flags', () => {
		const pattern = createForeignRegExp('^a+$', 'gy')
		if (!isRegExp(pattern)) throw new Error('expected a genuine foreign RegExp')
		pattern.lastIndex = 1
		const direct = matchOf(pattern)
		const composed = stringOf({ pattern })

		Reflect.apply(RegExp.prototype.compile, pattern, ['^b+$'])

		for (const guard of [direct, composed]) {
			expect(guard('aaa')).toBe(true)
			expect(guard('bbb')).toBe(false)
			expect(guard('aaa')).toBe(true)
		}
	})
})

describe('stringOf', () => {
	it('returns bare isString behavior when unconstrained', () => {
		const guard = stringOf()
		expect(guard('')).toBe(true)
		expect(guard('anything')).toBe(true)
		expect(guard(42)).toBe(false)
		// The fast path returns the very same isString reference.
		expect(stringOf()).toBe(isString)
		expect(stringOf({})).toBe(isString)
	})

	it('refuses unreadable options with the shared coded read error', () => {
		const options = new Proxy(
			{},
			{
				get() {
					throw new Error('hostile read')
				},
			},
		)
		const error = captureContractError(() => stringOf(options))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('stringOf: options could not be read')
	})

	it('enforces length bounds via boundsOf on .length', () => {
		const guard = stringOf({ min: 2, max: 4 })
		expect(guard('ab')).toBe(true) // lower edge
		expect(guard('abcd')).toBe(true) // upper edge
		expect(guard('a')).toBe(false) // below min
		expect(guard('abcde')).toBe(false) // above max
	})

	it('enforces a pattern', () => {
		const guard = stringOf({ pattern: /^[a-z]+$/ })
		expect(guard('hello')).toBe(true)
		expect(guard('Hello')).toBe(false)
		expect(guard('h3llo')).toBe(false)
	})

	it('clones a sticky pattern into a stateless guard without mutating the caller', () => {
		const pattern = /^a+$/y
		pattern.lastIndex = 1
		const guard = stringOf({ pattern })

		expect(guard('aaa')).toBe(true)
		expect(guard('aaa')).toBe(true)
		expect(pattern.lastIndex).toBe(1)
	})

	it('combines length and pattern (both must hold)', () => {
		const guard = stringOf({ min: 2, max: 4, pattern: /^a+$/ })
		expect(guard('aa')).toBe(true)
		expect(guard('aaaa')).toBe(true)
		expect(guard('a')).toBe(false) // below min, even though pattern matches
		expect(guard('aaaaa')).toBe(false) // above max, even though pattern matches
		expect(guard('abc')).toBe(false) // pattern miss, even though length fits
	})

	it('rejects non-strings without throwing', () => {
		const guard = stringOf({ min: 1 })
		expect(guard(42)).toBe(false)
		expect(guard(null)).toBe(false)
	})
})

describe('instanceOf', () => {
	it('validates instances and rejects non-constructors', () => {
		class Box {
			readonly value: number
			constructor(value: number) {
				this.value = value
			}
		}
		const isBox = instanceOf(Box)
		expect(isBox(new Box(1))).toBe(true)
		expect(isBox({})).toBe(false)
		expect(instanceOf(Date)(new Date(0))).toBe(true)
		expect(instanceOf(Date)('1970-01-01')).toBe(false)
	})

	it('is total against a revoked Proxy — never throws (AGENTS §14)', () => {
		const isDateValue = instanceOf(Date)
		const { proxy, revoke } = Proxy.revocable({}, {})
		revoke()
		expect(() => isDateValue(proxy)).not.toThrow()
		expect(isDateValue(proxy)).toBe(false)
	})

	it('preserves the concrete instance type at the type level', () => {
		expectTypeOf(instanceOf(Date)).toEqualTypeOf<Guard<Date>>()
		expectTypeOf(instanceOf(Map)).toEqualTypeOf<Guard<Map<unknown, unknown>>>()
	})
})

describe('empty-collection and zero-guard edge cases', () => {
	it('element combinators are vacuously true on empty collections', () => {
		expect(arrayOf(isString)([])).toBe(true)
		expect(arrayOf(isNumber)([])).toBe(true)
		expect(setOf(isString)(new Set())).toBe(true)
		expect(mapOf(isString, isNumber)(new Map())).toBe(true)
	})

	it('tupleOf() (zero guards) matches only the empty array', () => {
		const guard = tupleOf()
		expect(guard([])).toBe(true)
		expect(guard([1])).toBe(false)
		expect(guard(['a', 'b'])).toBe(false)
	})

	it('unionOf() (no guards) is always false; intersectionOf() (no guards) is always true', () => {
		expect(unionOf()('anything')).toBe(false)
		expect(unionOf()(42)).toBe(false)
		expect(intersectionOf()('anything')).toBe(true)
		expect(intersectionOf()(null)).toBe(true)
	})

	it('orOf with two simple primitive guards', () => {
		const stringOrBoolean = orOf(isString, isBoolean)
		expect(stringOrBoolean('hi')).toBe(true)
		expect(stringOrBoolean(false)).toBe(true)
		expect(stringOrBoolean(42)).toBe(false)
	})

	it('complementOf narrows with a primitive base', () => {
		const nonEmpty = complementOf(isString, isEmptyString)
		expect(nonEmpty('hi')).toBe(true)
		expect(nonEmpty('')).toBe(false)
		expect(nonEmpty(42)).toBe(false)
	})

	it('notOf negates a primitive guard', () => {
		const notNull = notOf(isNull)
		expect(notNull('hello')).toBe(true)
		expect(notNull(null)).toBe(false)
	})
})

describe('user-callback throw containment (AGENTS §14)', () => {
	it('logical, refinement, and nullish combinators contain every callback throw', () => {
		// A throwing member is a NON-MATCH, and the answer that follows from that
		// differs by combinator: a conjunction fails, a disjunction still passes on
		// a sibling that accepts, and a negation of a non-match passes. The whole
		// row set used to be pinned at `false`, which is what let `orOf`, `unionOf`,
		// `notOf` and `complementOf` contain each throw and still answer wrongly.
		const guards: ReadonlyArray<readonly [Guard<unknown>, unknown, boolean]> = [
			[andOf(isString, throwHostileAccess), 'value', false],
			[orOf(throwHostileAccess, isString), 'value', true],
			[notOf(throwHostileAccess), 'value', true],
			[
				complementOf(isString, (_value: string): _value is never => throwHostileAccess()),
				'value',
				true,
			],
			[unionOf(throwHostileAccess, isString), 'value', true],
			[intersectionOf(isString, throwHostileAccess), 'value', false],
			[whereOf(isString, throwHostileAccess), 'value', false],
			[lazyOf(throwHostileAccess), 'value', false],
			[transformOf(isString, throwHostileAccess, isString), 'value', false],
			[nullableOf((_value: unknown): _value is string => throwHostileAccess()), 'value', false],
			[optionalOf((_value: unknown): _value is string => throwHostileAccess()), 'value', false],
		]

		for (const [guard, value, expected] of guards) {
			expect(() => guard(value)).not.toThrow()
			expect(guard(value)).toBe(expected)
		}
	})

	it('keeps disjunction commutative and the excluded middle intact under a throwing member', () => {
		// The H9 tier-3 carrier. An ordinary caller predicate that assumes an
		// object throws on `null`; one `holds` around the WHOLE disjunction let it
		// erase every later passing member, so the same union answered differently
		// depending on argument order.
		const naive = (value: unknown): boolean => {
			// The ordinary shape of a caller predicate that assumes an object: reading
			// `value.kind` off `null` is a TypeError, and nothing about that makes
			// `null` a member of every other guard in the union.
			if (value === null || typeof value !== 'object') {
				throw new TypeError('cannot read properties of a non-object')
			}
			return 'kind' in value && value.kind === 'x'
		}

		expect(unionOf(isNull, naive)(null)).toBe(true)
		expect(unionOf(naive, isNull)(null)).toBe(true)
		expect(orOf(isNull, naive)(null)).toBe(true)
		expect(orOf(naive, isNull)(null)).toBe(true)
		// `g` and `notOf(g)` may not both reject the same value.
		expect(notOf(naive)(null)).toBe(true)
		expect(orOf(naive, notOf(naive))(null)).toBe(true)
		expect(notOf(notOf(naive))(null)).toBe(false)
		const naiveExclusion = (value: null): value is never => {
			if (value === null) throw new TypeError('cannot read properties of null')
			return false
		}
		expect(complementOf(isNull, naiveExclusion)(null)).toBe(true)
		// Control: conjunction is unchanged — a throwing member genuinely did not
		// pass, so `false` was already the right answer there.
		expect(andOf(isNull, naive)(null)).toBe(false)
		expect(intersectionOf(isNull, naive)(null)).toBe(false)
	})

	it('accepts a callable instance, agreeing with the helper it is built on', () => {
		// `instanceOf` carried an `isObject` pre-filter, and `typeof fn` is
		// 'function', so it rejected every callable instance while `isInstance`
		// accepted the identical pair.
		const callable = (): void => {}
		expect(isInstance(callable, Function)).toBe(true)
		expect(instanceOf(Function)(callable)).toBe(true)
		// Controls: a non-instance and a non-constructor still answer false.
		expect(instanceOf(Function)({})).toBe(false)
		expect(instanceOf(Date)(new Date())).toBe(true)
		expect(instanceOf(Date)({})).toBe(false)
	})

	it('whereOf: a throwing refinement predicate is contained as a non-match', () => {
		const throwingRefine = whereOf(isString, (_value: string): boolean => {
			throw new Error('refinement error')
		})
		expect(() => throwingRefine('hello')).not.toThrow()
		expect(throwingRefine('hello')).toBe(false)
		// Base-guard rejection short-circuits before the predicate runs.
		expect(throwingRefine(42)).toBe(false)
	})

	it('lazyOf: a throwing thunk is contained as a non-match', () => {
		const throwingThunk = lazyOf<string>(() => {
			throw new Error('thunk error')
		})
		expect(() => throwingThunk('hello')).not.toThrow()
		expect(throwingThunk('hello')).toBe(false)
	})

	it('lazyOf: a resolved guard that throws is contained as a non-match', () => {
		const throwingResolved = lazyOf<string>(() => (_value: unknown): _value is string => {
			throw new Error('resolved guard error')
		})
		expect(() => throwingResolved('hello')).not.toThrow()
		expect(throwingResolved('hello')).toBe(false)
	})

	it('transformOf: a throwing projector is contained as a non-match', () => {
		const throwingGuard = transformOf(
			isString,
			(_value: string) => {
				throw new Error('projection error')
			},
			isNumber,
		)
		expect(() => throwingGuard('hello')).not.toThrow()
		expect(throwingGuard('hello')).toBe(false)
		expect(throwingGuard(42)).toBe(false)
	})
})

describe('combinator totality sweep', () => {
	it('carries inherited and non-enumerable string options into its guard', () => {
		const prototype = createForeignPrototype()
		Object.defineProperty(prototype, 'min', { value: 2, enumerable: true, configurable: true })
		const inherited: { readonly min?: number } = Object.create(prototype)
		const hidden: { readonly min?: number } = {}
		Object.defineProperty(hidden, 'min', { value: 2, enumerable: false })

		for (const options of [inherited, hidden]) {
			const guard = stringOf(options)
			expect(guard('a')).toBe(false)
			expect(guard('ab')).toBe(true)
		}
	})

	it('rejects array and class-instance string options as non-record containers', () => {
		class Options {
			readonly min = 2
		}
		for (const options of [[2], new Options()]) {
			const error = captureContractError(() => Reflect.apply(stringOf, undefined, [options]))
			expect(error.code).toBe('structure')
			expect(error.message).toBe('stringOf: options must be a plain record')
		}
	})

	it('reads a genuine pattern from its internal slots and refuses a non-brand proxy', () => {
		// A genuine pattern with a hostile OWN `source` accessor. Every read of a
		// pattern's source and flags now goes through the accessor CAPTURED from
		// `RegExp.prototype`, which answers from the pattern's internal slots, so an
		// own decoy — throwing, object-valued, or answering once — decides nothing.
		// The refusal these three doors used to publish existed only because an
		// ordinary `.source` read ran whatever accessor the value carried; with the
		// genuine source in hand the honest answer is available, and publishing it
		// is more faithful than refusing.
		const hostile = /value/
		Object.defineProperty(hostile, 'source', {
			get() {
				throw new Error('hostile pattern')
			},
		})

		expect(matchOf(hostile)('value')).toBe(true)
		expect(matchOf(hostile)('other')).toBe(false)
		expect(stringOf({ pattern: hostile })('value')).toBe(true)
		expect(stringOf({ pattern: hostile })('other')).toBe(false)
		expect(stringShape({ pattern: hostile }).pattern?.source).toBe('value')

		const proxy = new Proxy(/value/, {})
		for (const [reader, run] of [
			['matchOf', () => matchOf(proxy)],
			['stringOf', () => stringOf({ pattern: proxy })],
			['stringShape', () => stringShape({ pattern: proxy })],
		] satisfies ReadonlyArray<readonly [string, () => unknown]>) {
			const error = captureContractError(run)
			expect(error.code).toBe('pattern')
			expect(error.message).toBe(`${reader}: pattern must be a RegExp`)
		}
	})

	it('a guard from every combinator factory returns a boolean for every hostile fixture', () => {
		let recursive: Guard<unknown> = isString
		recursive = unionOf(isString, arrayOf(lazyOf(() => recursive)))
		const shape = { id: isString, count: isNumber }
		const guards: ReadonlyArray<Guard<unknown>> = [
			arrayOf(isString),
			tupleOf(isString),
			literalOf('value'),
			instanceOf(Date),
			enumOf({ Value: 'value' }),
			setOf(isString),
			mapOf(isString, isNumber),
			recordOf({ id: isString }),
			keyOf({ id: true }),
			recordOf(pickOf(shape, ['id'])),
			recordOf(omitOf(shape, ['count'])),
			andOf(isString, isString),
			orOf(isString, isNumber),
			notOf(isString),
			complementOf(isString, isEmptyString),
			unionOf(isString, isNumber),
			intersectionOf(isString, isString),
			whereOf(isString, (value) => value.length > 0),
			recursive,
			transformOf(isString, (value) => value.length, isNumber),
			boundsOf(0, 10),
			matchOf(/^value$/),
			stringOf({ min: 1, max: 10, pattern: /^value$/ }),
			nullableOf(isString),
			optionalOf(isString),
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
		}
	})
})

describe('optionalOf', () => {
	it('extends a guard with undefined tolerance', () => {
		const maybeString = optionalOf(isString)
		expect(maybeString(undefined)).toBe(true)
		expect(maybeString('x')).toBe(true)
		expect(maybeString(null)).toBe(false)
		expect(maybeString(1)).toBe(false)
	})
})

describe('container-combinator throw containment (AGENTS §14)', () => {
	it('recordOf: a hostile getter on a value read is contained as a non-match', () => {
		const hostile: unknown = {
			get a() {
				throw new Error('hostile getter')
			},
		}
		const guard = recordOf({ a: isString })
		expect(() => guard(hostile)).not.toThrow()
		expect(guard(hostile)).toBe(false)
	})

	it('arrayOf and tupleOf: a Proxy with a throwing get trap is contained as a non-match', () => {
		const target = ['a', 'b']
		const hostile = new Proxy(target, {
			get() {
				throw new Error('hostile trap')
			},
		})
		const arrayGuard = arrayOf(isString)
		expect(() => arrayGuard(hostile)).not.toThrow()
		expect(arrayGuard(hostile)).toBe(false)

		const tupleGuard = tupleOf(isString, isString)
		expect(() => tupleGuard(hostile)).not.toThrow()
		expect(tupleGuard(hostile)).toBe(false)
	})

	it('setOf: a hostile iterator no longer decides the answer, the genuine contents do', () => {
		// A real Set whose iterator is overridden to throw. The guard reads
		// `[[SetData]]` through the CAPTURED `Set.prototype.forEach`, so the
		// iterator is never entered: the verdict is about what the set genuinely
		// holds, which is the only verdict a consumer can act on. The old answer —
		// `false`, because the walk threw — let a replaced iterator that merely
		// SKIPPED the non-member answer `true` for a set holding one.
		const strings = new Set(['a', 'b'])
		const mixed = new Set<unknown>(['a', 42])
		for (const set of [strings, mixed]) {
			Object.defineProperty(set, Symbol.iterator, {
				value: () => {
					throw new Error('hostile iterator')
				},
			})
		}
		const guard = setOf(isString)
		expect(() => guard(strings)).not.toThrow()
		expect(guard(strings)).toBe(true)
		expect(guard(mixed)).toBe(false)
	})

	it('mapOf: a hostile iterator no longer decides the answer, the genuine entries do', () => {
		const numbers = new Map<unknown, unknown>([['a', 1]])
		const mixed = new Map<unknown, unknown>([['a', 'not-a-number']])
		for (const map of [numbers, mixed]) {
			Object.defineProperty(map, Symbol.iterator, {
				value: () => {
					throw new Error('hostile iterator')
				},
			})
		}
		const guard = mapOf(isString, isNumber)
		expect(() => guard(numbers)).not.toThrow()
		expect(guard(numbers)).toBe(true)
		expect(guard(mixed)).toBe(false)
	})

	it('arrayOf: a throwing predicate is contained as a non-match', () => {
		const guard = arrayOf((_value: unknown): boolean => {
			throw new Error('predicate error')
		})
		expect(() => guard(['a'])).not.toThrow()
		expect(guard(['a'])).toBe(false)
	})

	it('tupleOf: a throwing predicate is contained as a non-match', () => {
		const guard = tupleOf((_value: unknown): boolean => {
			throw new Error('predicate error')
		})
		expect(() => guard(['a'])).not.toThrow()
		expect(guard(['a'])).toBe(false)
	})

	it('setOf: a throwing predicate is contained as a non-match', () => {
		const guard = setOf((_value: unknown): boolean => {
			throw new Error('predicate error')
		})
		expect(() => guard(new Set(['a']))).not.toThrow()
		expect(guard(new Set(['a']))).toBe(false)
	})

	it('mapOf: a throwing predicate is contained as a non-match', () => {
		const guard = mapOf(
			(_value: unknown): boolean => {
				throw new Error('key predicate error')
			},
			() => true,
		)
		expect(() => guard(new Map([['a', 1]]))).not.toThrow()
		expect(guard(new Map([['a', 1]]))).toBe(false)
	})

	it('recordOf: a throwing predicate is contained as a non-match', () => {
		const guard = recordOf({
			a: (_value: unknown): _value is unknown => {
				throw new Error('predicate error')
			},
		})
		expect(() => guard({ a: 1 })).not.toThrow()
		expect(guard({ a: 1 })).toBe(false)
	})
})

describe('membership answered through an unredirectable vocabulary', () => {
	// The highest-severity defect of the campaign, asked at every combinator that
	// answers a membership question: a caller who rewrites `Set.prototype.has`
	// changed what these guards ANSWER — no throw, no diagnostic, a wrong yes.
	// The lie is installed for the whole call, so both the build and the read run
	// under it.
	const answerTrue = (): boolean => true
	const answerFalse = (): boolean => false

	it('literalOf rejects a non-member while Set.prototype.has answers true', () => {
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			member: literalOf('a', 'b')('a'),
			stranger: literalOf('a', 'b')('NOT-A-MEMBER'),
			listed: literalOf(['a', 'b'])('NOT-A-MEMBER'),
		}))

		expect(answers).toEqual({ member: true, stranger: false, listed: false })
	})

	it('literalOf accepts a member while Set.prototype.has answers false', () => {
		const answers = replaceIntrinsic(Set.prototype, 'has', answerFalse, () =>
			literalOf('a', 'b')('a'),
		)

		expect(answers).toBe(true)
	})

	it('enumOf rejects a non-member while Set.prototype.has answers true', () => {
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			member: enumOf({ red: 'r', blue: 'b' })('r'),
			stranger: enumOf({ red: 'r', blue: 'b' })('NOT-A-MEMBER'),
		}))

		expect(answers).toEqual({ member: true, stranger: false })
	})

	it('enumOf answers false instead of throwing while Set.prototype.has throws', () => {
		// A guard never throws for adversarial input. Its sibling `literalOf` had
		// this right one screen away, which is exactly how the gap survived.
		const thrower = (): boolean => {
			throw new Error('sethas')
		}
		const answers = replaceIntrinsic(Set.prototype, 'has', thrower, () =>
			attempt(() => enumOf({ red: 'r' })('r')),
		)

		expect(answers.success).toBe(true)
		expect(answers.success && answers.value).toBe(true)
	})

	it('recordOf still rejects an undeclared key while Set.prototype.has answers true', () => {
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			exact: recordOf({ name: isString })({ name: 'Ada' }),
			extra: recordOf({ name: isString })({ name: 'Ada', ghost: 1 }),
			missing: recordOf({ name: isString })({}),
		}))

		expect(answers).toEqual({ exact: true, extra: false, missing: false })
	})

	it('recordOf still requires a non-optional key while Set.prototype.has answers true', () => {
		const guard = recordOf({ name: isString, age: isNumber }, ['age'])
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			optionalAbsent: guard({ name: 'Ada' }),
			requiredAbsent: guard({ age: 1 }),
		}))

		expect(answers).toEqual({ optionalAbsent: true, requiredAbsent: false })
	})

	it('keyOf rejects a key the object does not own while Set.prototype.has answers true', () => {
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			member: keyOf({ red: 1, green: 2 })('red'),
			stranger: keyOf({ red: 1, green: 2 })('purple'),
		}))

		expect(answers).toEqual({ member: true, stranger: false })
	})

	it('pickOf and omitOf keep their selections while Set.prototype.has answers true', () => {
		const shape: GuardsShape = { name: isString, age: isNumber }
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			picked: Object.keys(pickOf(shape, ['name'])),
			omitted: Object.keys(omitOf(shape, ['age'])),
		}))

		expect(answers).toEqual({ picked: ['name'], omitted: ['name'] })
	})
})
