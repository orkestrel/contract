import type { JSONSchema } from '@src/core'
import {
	buildSparseArray,
	captureContractError,
	createRevokedProxy,
	createThrowingGetter,
} from '../../setup.js'
import { describe, expect, it } from 'vitest'
import {
	attempt,
	createContract,
	drawRandom,
	enumerableKeys,
	enumerableSymbolCount,
	holds,
	matchesJSONValue,
	objectShape,
	readOptions,
	readValue,
	resolveField,
	schemaToObject,
	schemaToParameters,
	seededRandom,
	stringShape,
	valueToSchema,
} from '@src/core'

describe('attempt', () => {
	it('captures a successful return value as a Success', () => {
		const outcome = attempt(() => 42)
		expect(outcome).toEqual({ success: true, value: 42 })
	})

	it('preserves an Error reason as-is (by reference)', () => {
		const error = new Error('boom')
		const outcome = attempt(() => {
			throw error
		})
		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBeInstanceOf(Error)
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

	it('normalizes a Symbol reason into an Error via String()', () => {
		const outcome = attempt(() => {
			throw Symbol('symbol reason')
		})
		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBeInstanceOf(Error)
		expect(!outcome.success && outcome.error.message).toBe('Symbol(symbol reason)')
	})

	it('normalizes a null reason into an Error via String()', () => {
		const outcome = attempt(() => {
			throw null
		})
		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBeInstanceOf(Error)
		expect(!outcome.success && outcome.error.message).toBe('null')
	})

	it('returns a fallback Error when inspecting a revoked Proxy reason throws', () => {
		const hostile = createRevokedProxy()
		const outcome = attempt(() => {
			throw hostile
		})
		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBeInstanceOf(Error)
		expect(!outcome.success && outcome.error.message).toBe('Unknown thrown value')
	})

	it('falls back to a fixed message when the thrown value cannot be stringified', () => {
		const hostile: object = Object.create(null)
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

describe('readValue', () => {
	it('returns a successful read and gives every failed read one code and message shape', () => {
		expect(readValue(() => 42, 'example')).toBe(42)
		const error = captureContractError(() =>
			readValue(() => {
				throw new Error('hostile read')
			}, 'example'),
		)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('example: value could not be read')
	})
})

describe('holds', () => {
	it('returns false when the callback throws', () => {
		expect(
			holds(() => {
				throw new Error('boom')
			}),
		).toBe(false)
	})

	it('returns true when the callback returns true', () => {
		expect(holds(() => true)).toBe(true)
	})

	it('returns false when the callback returns false', () => {
		expect(holds(() => false)).toBe(false)
	})

	it('returns false when the callback returns a truthy non-boolean at runtime', () => {
		const callback = new Proxy(() => true, { apply: String })
		expect(holds(callback)).toBe(false)
	})
})

describe('matchesJSONValue', () => {
	it('refuses a failed direct traversal through the shared coded boundary', () => {
		const hostile = createThrowingGetter()
		const error = captureContractError(() => matchesJSONValue(hostile, new WeakSet()))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('matchesJSONValue: value could not be read')
	})
})

describe('enumerableKeys', () => {
	it('returns a frozen owned snapshot of only own enumerable string keys', () => {
		const symbol = Symbol('symbol')
		const value = Object.create({ inherited: true })
		Object.defineProperty(value, 'hidden', { value: true, enumerable: false })
		Object.defineProperty(value, symbol, { value: true, enumerable: true })
		value.visible = true
		const keys = enumerableKeys(value)

		expect(keys).toEqual(['visible'])
		expect(Object.isFrozen(keys)).toBe(true)
	})

	it('returns undefined for hostile property enumeration', () => {
		expect(enumerableKeys(createRevokedProxy())).toBeUndefined()
	})
})

describe('readOptions', () => {
	it('returns an owned snapshot after probing every consumed key', () => {
		const source = { min: 1, max: 4 }
		const snapshot = readOptions(source, ['min', 'max'], 'stringShape', 'string')
		source.min = 2

		expect(snapshot).toEqual({ min: 1, max: 4 })
	})

	it('reads a consumed enumerable accessor once and snapshots that same value', () => {
		let reads = 0
		const source = {
			get min() {
				reads += 1
				return reads
			},
		}
		const snapshot = readOptions(source, ['min'], 'stringShape', 'string')

		expect(reads).toBe(1)
		expect(snapshot).toEqual({ min: 1 })
	})

	it('refuses a readable consumed property when the snapshot cannot carry it', () => {
		const source: { readonly min?: number } = {}
		Object.defineProperty(source, 'min', { value: 1, enumerable: false })
		const error = captureContractError(() => readOptions(source, ['min'], 'stringShape', 'string'))

		expect(Reflect.get(source, 'min')).toBe(1)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('stringShape: min must be an own enumerable option')
		expect(error.context?.path).toEqual(['min'])
	})

	it('refuses an inherited consumed property by the same snapshot-view rule', () => {
		const prototype: { min?: number } = Object.create(null)
		prototype.min = 1
		const source: { readonly min?: number } = Object.create(prototype)
		const error = captureContractError(() => readOptions(source, ['min'], 'stringShape', 'string'))

		expect(Reflect.get(source, 'min')).toBe(1)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('stringShape: min must be an own enumerable option')
	})

	it('rejects a primitive before reflection with the precise plain-record message', () => {
		const error = captureContractError(() =>
			Reflect.apply(readOptions<{ readonly min?: number }>, undefined, [
				null,
				['min'],
				'stringShape',
				'string',
			]),
		)

		expect(error.code).toBe('structure')
		expect(error.message).toBe('stringShape: options must be a plain record')
		expect(error.cause).toBeUndefined()
	})

	it('rejects a key-hiding hostile host with the uniform unreadable-options message', () => {
		const source: { readonly min?: number; readonly max?: number } = new Proxy(
			{},
			{
				get(_target, key) {
					if (key === 'min') throw new Error('hostile min')
					return undefined
				},
			},
		)
		const error = captureContractError(() =>
			readOptions(source, ['min', 'max'], 'stringShape', 'string'),
		)

		expect(error.code).toBe('structure')
		expect(error.message).toBe('stringShape: options could not be read')
		expect(error.cause).toBeInstanceOf(Error)
	})
})

describe('drawRandom', () => {
	it('returns finite samples inside the random-source range', () => {
		expect(drawRandom(() => 0, 'number')).toBe(0)
		expect(drawRandom(() => 0.999, 'number')).toBe(0.999)
	})

	it('throws a random ContractError with drawRandom diagnostics for invalid or throwing sources', () => {
		const invalid = captureContractError(() => drawRandom(() => 1, 'union'))
		const throwing = captureContractError(() =>
			drawRandom(() => {
				throw new Error('source')
			}, 'union'),
		)

		expect(invalid.code).toBe('random')
		expect(invalid.message).toContain('drawRandom:')
		expect(throwing.code).toBe('random')
		expect(throwing.message).toContain('drawRandom:')
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
		const hostile = createThrowingGetter()
		expect(() => resolveField(hostile, 'value')).not.toThrow()
		expect(resolveField(hostile, 'value')).toBeUndefined()
	})

	it('returns undefined against a hostile getter mid-path without throwing', () => {
		const hostile = { user: createThrowingGetter() }
		expect(() => resolveField(hostile, ['user', 'value'])).not.toThrow()
		expect(resolveField(hostile, ['user', 'value'])).toBeUndefined()
	})
})

describe('matchesJSONValue', () => {
	it('accepts JSON leaves and nested structures', () => {
		expect(matchesJSONValue(null, new WeakSet())).toBe(true)
		expect(matchesJSONValue('value', new WeakSet())).toBe(true)
		expect(matchesJSONValue(false, new WeakSet())).toBe(true)
		expect(matchesJSONValue(0, new WeakSet())).toBe(true)
		expect(
			matchesJSONValue(
				{
					array: [1, 'two', null, { nested: true }],
					record: { empty: {} },
				},
				new WeakSet(),
			),
		).toBe(true)
	})

	it('rejects non-finite numbers and non-JSON leaves', () => {
		expect(matchesJSONValue(Number.NaN, new WeakSet())).toBe(false)
		expect(matchesJSONValue(Number.POSITIVE_INFINITY, new WeakSet())).toBe(false)
		expect(matchesJSONValue(Number.NEGATIVE_INFINITY, new WeakSet())).toBe(false)
		expect(matchesJSONValue(() => 1, new WeakSet())).toBe(false)
		expect(matchesJSONValue(Symbol('value'), new WeakSet())).toBe(false)
		expect(matchesJSONValue(undefined, new WeakSet())).toBe(false)
	})

	it('rejects direct and nested cycles', () => {
		const direct: unknown[] = []
		direct.push(direct)
		expect(matchesJSONValue(direct, new WeakSet())).toBe(false)

		const nested: { child?: unknown } = {}
		nested.child = { parent: nested }
		expect(matchesJSONValue(nested, new WeakSet())).toBe(false)
	})

	it('rejects sparse arrays', () => {
		expect(matchesJSONValue(buildSparseArray(), new WeakSet())).toBe(false)
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

	it('refuses an unreadable record schema with the shared coded read error', () => {
		const error = captureContractError(() => schemaToParameters(createThrowingGetter()))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('schemaToParameters: value could not be read')
	})
})

describe('schemaToObject', () => {
	it('passes an object-rooted schema through unchanged', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
			additionalProperties: false,
		}
		expect(schemaToObject(schema)).toBe(schema)
	})

	it('refuses an unreadable schema root with the shared coded read error', () => {
		const hostile = new Proxy<JSONSchema>(
			{},
			{
				get() {
					throw new Error('hostile read')
				},
			},
		)
		const error = captureContractError(() => schemaToObject(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('schemaToObject: value could not be read')
	})

	it('wraps a string-rooted schema as a single required "value" property', () => {
		expect(schemaToObject({ type: 'string' })).toEqual({
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('wraps a number-rooted schema', () => {
		expect(schemaToObject({ type: 'number' })).toEqual({
			type: 'object',
			properties: { value: { type: 'number' } },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('wraps an array-rooted schema', () => {
		const schema: JSONSchema = { type: 'array', items: { type: 'string' } }
		expect(schemaToObject(schema)).toEqual({
			type: 'object',
			properties: { value: schema },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('wraps an anyOf/enum-only schema with no type', () => {
		const anyOf: JSONSchema = { anyOf: [{ type: 'string' }, { type: 'number' }] }
		expect(schemaToObject(anyOf)).toEqual({
			type: 'object',
			properties: { value: anyOf },
			required: ['value'],
			additionalProperties: false,
		})
		const literal: JSONSchema = { enum: ['a', 'b'] }
		expect(schemaToObject(literal)).toEqual({
			type: 'object',
			properties: { value: literal },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('wraps the empty schema {}', () => {
		expect(schemaToObject({})).toEqual({
			type: 'object',
			properties: { value: {} },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('is deterministic — same input yields byte-identical output', () => {
		const schema: JSONSchema = { type: 'string', format: 'uuid' }
		expect(JSON.stringify(schemaToObject(schema))).toBe(JSON.stringify(schemaToObject(schema)))
	})

	it('composes with schemaToParameters(schemaToObject(valueToSchema(...))) for a non-object payload', () => {
		const schema = valueToSchema('hello')
		const parameters = schemaToParameters(schemaToObject(schema))
		expect(parameters).toEqual({
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
			additionalProperties: false,
		})
	})
})
