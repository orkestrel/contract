import type { JSONSchema } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	createContract,
	enumerableSymbolCount,
	objectShape,
	schemaToParameters,
	seededRandom,
	stringShape,
} from '@src/core'

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
