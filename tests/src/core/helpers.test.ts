import type { JSONSchema } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	attempt,
	createContract,
	enumerableSymbolCount,
	objectShape,
	resolveField,
	schemaToParameters,
	seededRandom,
	stringShape,
} from '@src/core'

describe('attempt', () => {
	it('captures a successful return value as a Success', () => {
		const outcome = attempt(() => 42)
		expect(outcome).toEqual({ success: true, value: 42 })
	})

	it('rethrows an Error reason as-is (by reference)', () => {
		const error = new Error('boom')
		const outcome = attempt(() => {
			throw error
		})
		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBe(error)
	})

	it('normalizes a non-Error thrown value into an Error via String()', () => {
		const outcome = attempt(() => {
			throw 'plain string reason'
		})
		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBeInstanceOf(Error)
		expect(!outcome.success && outcome.error.message).toBe('plain string reason')
	})

	it("falls back to a fixed message when the thrown value's own toString throws", () => {
		const hostile = {
			toString() {
				throw new Error('hostile toString')
			},
		}
		const outcome = attempt(() => {
			throw hostile
		})
		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBeInstanceOf(Error)
		expect(!outcome.success && outcome.error.message).toBe('Unknown thrown value')
	})

	it('never throws, regardless of what the callback throws', () => {
		expect(() =>
			attempt(() => {
				throw new Error('anything')
			}),
		).not.toThrow()
	})
})

describe('resolveField', () => {
	it('resolves a single key, including a dotted key treated as one segment', () => {
		expect(resolveField({ a: 1 }, 'a')).toBe(1)
		expect(resolveField({ 'a.b': 1 }, 'a.b')).toBe(1)
	})

	it('resolves a nested path left-to-right', () => {
		expect(resolveField({ user: { name: 'Ada' } }, ['user', 'name'])).toBe('Ada')
	})

	it('returns undefined for an off-path key', () => {
		expect(resolveField({ a: 1 }, ['a', 'b'])).toBeUndefined()
		expect(resolveField({}, 'missing')).toBeUndefined()
	})

	it('returns undefined when an intermediate segment is not an object', () => {
		expect(resolveField({ a: 1 }, ['a', 'b'])).toBeUndefined()
		expect(resolveField({ a: null }, ['a', 'b'])).toBeUndefined()
		expect(resolveField({ a: 'x' }, ['a', 'b'])).toBeUndefined()
	})

	it('returns undefined against a hostile getter without throwing', () => {
		const hostile = {
			get a() {
				throw new Error('hostile getter')
			},
		}
		expect(() => resolveField(hostile, 'a')).not.toThrow()
		expect(resolveField(hostile, 'a')).toBeUndefined()
	})

	it('returns undefined against a hostile getter mid-path without throwing', () => {
		const hostile = {
			user: {
				get name() {
					throw new Error('hostile nested getter')
				},
			},
		}
		expect(() => resolveField(hostile, ['user', 'name'])).not.toThrow()
		expect(resolveField(hostile, ['user', 'name'])).toBeUndefined()
	})
})

describe('seededRandom', () => {
	it('is deterministic — the same seed yields the same sequence', () => {
		const a = seededRandom(42)
		const b = seededRandom(42)
		const first = [a(), a(), a()]
		const second = [b(), b(), b()]
		expect(first).toEqual(second)
	})

	it('produces different sequences for different seeds', () => {
		expect(seededRandom(1)()).not.toBe(seededRandom(2)())
	})

	it('returns values within the [0, 1) range', () => {
		const random = seededRandom(7)
		for (let index = 0; index < 100; index += 1) {
			const value = random()
			expect(value).toBeGreaterThanOrEqual(0)
			expect(value).toBeLessThan(1)
		}
	})
})

describe('enumerableSymbolCount', () => {
	it('counts only enumerable own symbols', () => {
		const visible = Symbol('visible')
		const hidden = Symbol('hidden')
		const value = { [visible]: 1 }
		Object.defineProperty(value, hidden, { value: 2, enumerable: false })

		expect(enumerableSymbolCount(value)).toBe(1)
		expect(enumerableSymbolCount({})).toBe(0)
		expect(enumerableSymbolCount({ stringKey: 1 })).toBe(0)
	})
})

describe('schemaToParameters', () => {
	it('passes a record schema through by reference (a compiled contract schema is always a record)', () => {
		// The production case: a compiled contract's `schema` is a plain object, so the guard passes
		// and the same reference comes back as the open tool-parameters record.
		const schema = createContract(objectShape({ name: stringShape() })).schema
		expect(schemaToParameters(schema)).toBe(schema)

		const literal: JSONSchema = { type: 'object', properties: { id: { type: 'string' } } }
		expect(schemaToParameters(literal)).toBe(literal)
	})

	it('returns undefined for a non-record schema (the defensive optionality fallback)', () => {
		// A class INSTANCE structurally satisfies the all-optional `JSONSchema` interface yet is NOT a
		// plain record (its prototype is the class, not `Object.prototype`), so the `isRecord` boundary
		// guard rejects it and the helper yields its `undefined` fallback — the §14 narrowing in action.
		class FakeSchema {
			type: 'object' = 'object'
		}
		const notRecord: JSONSchema = new FakeSchema()
		expect(schemaToParameters(notRecord)).toBeUndefined()
	})
})
