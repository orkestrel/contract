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
	resolveField,
	schemaToObject,
	schemaToParameters,
	sanitizeURL,
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

describe('sanitizeURL', () => {
	it('keeps allowlisted schemes, including mixed-case input', () => {
		const schemes = new Set(['http', 'https'])
		expect(sanitizeURL('http://example.com', schemes)).toBe('http://example.com')
		expect(sanitizeURL('https://example.com', schemes)).toBe('https://example.com')
		expect(sanitizeURL('HtTp://example.com', schemes)).toBe('HtTp://example.com')
	})

	it('rejects an unlisted scheme', () => {
		expect(sanitizeURL('ftp://example.com', ['http', 'https'])).toBe('')
	})

	it('keeps relative, anchor, and query URLs and accepts empty input', () => {
		const schemes = new Set(['https'])
		expect(sanitizeURL('docs/index.html', schemes)).toBe('docs/index.html')
		expect(sanitizeURL('#section', schemes)).toBe('#section')
		expect(sanitizeURL('?page=2', schemes)).toBe('?page=2')
		expect(sanitizeURL('', schemes)).toBe('')
	})

	it('strips C0 and C1 controls before applying the scheme allowlist', () => {
		expect(sanitizeURL('\u0000 h\nt\rt\tp\u007f\u0080\u009f://example.com', ['http'])).toBe(
			'http://example.com',
		)
		expect(sanitizeURL('java\tscript:x', ['https'])).toBe('')
		expect(sanitizeURL('java\tscript:x', ['javascript'])).toBe('javascript:x')
	})

	it('rejects all four protocol-relative slash forms', () => {
		const schemes = new Set(['https'])
		expect(sanitizeURL('//example.com', schemes)).toBe('')
		expect(sanitizeURL('\\\\example.com', schemes)).toBe('')
		expect(sanitizeURL('/\\example.com', schemes)).toBe('')
		expect(sanitizeURL('\\/example.com', schemes)).toBe('')
	})

	it('produces identical results for Set and array allowlists', () => {
		const set = new Set(['http', 'https'])
		const array = ['http', 'https']
		expect(sanitizeURL('https://example.com', set)).toBe(sanitizeURL('https://example.com', array))
		expect(sanitizeURL('mailto:user@example.com', set)).toBe(
			sanitizeURL('mailto:user@example.com', array),
		)
		expect(sanitizeURL('../relative', set)).toBe(sanitizeURL('../relative', array))
	})

	it('treats a duplicate-bearing array like the equivalent Set', () => {
		const set = new Set(['https'])
		const duplicates = ['https', 'https']
		expect(sanitizeURL('https://example.com', duplicates)).toBe(
			sanitizeURL('https://example.com', set),
		)
		expect(sanitizeURL('http://example.com', duplicates)).toBe(
			sanitizeURL('http://example.com', set),
		)
	})

	it('fails closed when a Set has a throwing has method', () => {
		const schemes = new (class extends Set<string> {
			override has(_value: string): boolean {
				throw new Error('hostile has')
			}
		})(['https'])
		expect(() => sanitizeURL('https://example.com', schemes)).not.toThrow()
		expect(sanitizeURL('https://example.com', schemes)).toBe('')
	})

	it('fails closed when membership reaches a throwing iterator', () => {
		const schemes = new (class extends Set<string> {
			override has(value: string): boolean {
				return this[Symbol.iterator]().next().value === value
			}

			override [Symbol.iterator](): SetIterator<string> {
				throw new Error('hostile iterator')
			}
		})(['https'])
		expect(() => sanitizeURL('https://example.com', schemes)).not.toThrow()
		expect(sanitizeURL('https://example.com', schemes)).toBe('')
	})

	it('fails closed when a Proxy throws on property access', () => {
		const schemes = new Proxy(new Set(['https']), {
			get(): never {
				throw new Error('hostile get')
			},
		})
		expect(() => sanitizeURL('https://example.com', schemes)).not.toThrow()
		expect(sanitizeURL('https://example.com', schemes)).toBe('')
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
