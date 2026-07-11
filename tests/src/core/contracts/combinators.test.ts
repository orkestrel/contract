import { describe, expect, it } from 'vitest'
import {
	andOf,
	arrayOf,
	boundsOf,
	complementOf,
	enumOf,
	instanceOf,
	intersectionOf,
	isBoolean,
	isEmptyString,
	isFunction,
	isNull,
	isNumber,
	isString,
	iterableOf,
	keyOf,
	lazyOf,
	literalOf,
	mapOf,
	matchOf,
	notOf,
	nullableOf,
	omitOf,
	orOf,
	pickOf,
	recordOf,
	setOf,
	stringOf,
	transformOf,
	tupleOf,
	unionOf,
	whereOf,
} from '@src/core'
import type { Guard } from '@src/core'

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

	it('validates maps, sets, and iterables', () => {
		expect(mapOf(isString, isNumber)(new Map([['a', 1]]))).toBe(true)
		expect(mapOf(isString, isNumber)(new Map([['a', '1']]))).toBe(false)
		expect(setOf(isNumber)(new Set([1, 2]))).toBe(true)
		expect(setOf(isNumber)(new Set([1, '2']))).toBe(false)
		expect(iterableOf(isNumber)(new Set([1, 2]))).toBe(true)
		expect(iterableOf(isNumber)([1, 2, '3'])).toBe(false)
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

	it('literalOf uses Object.is semantics', () => {
		expect(literalOf(Number.NaN)(Number.NaN)).toBe(true)
		expect(literalOf(0)(-0)).toBe(false)
		expect(literalOf(-0)(0)).toBe(false)
		expect(literalOf(-0)(-0)).toBe(true)
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

		const partialUser = recordOf({ id: isString, age: isNumber }, true)
		expect(partialUser({})).toBe(true)
		expect(partialUser({ id: 'x' })).toBe(true)
		expect(partialUser({ id: 1 })).toBe(false)
	})

	it('ignores extra symbol keys but rejects extra string keys', () => {
		const symbolKey = Symbol('record')
		const recordWithSymbol: unknown = { id: 'u1', [symbolKey]: 123 }
		expect(recordOf({ id: isString })(recordWithSymbol)).toBe(true)
		expect(recordOf({ id: isString })({ id: 'u1', extra: true })).toBe(false)
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
