import { describe, expect, it } from 'vitest'
import {
	arrayOf,
	isArray,
	isBoolean,
	isFiniteNumber,
	isInteger,
	isJSONPrimitive,
	isJSONValue,
	isNull,
	isNumber,
	isRecord,
	isString,
	JSON_SCHEMA_TYPES,
	literalOf,
	parseArray,
	parseArrayField,
	parseBoolean,
	parseBooleanField,
	parseEnum,
	parseEnumField,
	parseInteger,
	parseIntegerField,
	parseJSON,
	parseJSONAs,
	parseJSONValue,
	parseJSONValueField,
	parseNull,
	parseNullField,
	parseNumber,
	parseNumberField,
	parseRecord,
	parseRecordField,
	parseString,
	parseStringField,
	recordOf,
} from '@src/core'
import { soundnessViolations } from '../../../setup.js'

describe('primitive parsers', () => {
	it('parseString returns strings as-is and coerces finite numbers', () => {
		expect(parseString('hi')).toBe('hi')
		expect(parseString('')).toBe('')
		expect(parseString(42)).toBe('42')
		expect(parseString(-3.5)).toBe('-3.5')
		expect(parseString(Number.NaN)).toBeUndefined()
		expect(parseString(Number.POSITIVE_INFINITY)).toBeUndefined()
		expect(parseString(true)).toBeUndefined()
		expect(parseString({})).toBeUndefined()
		expect(parseString(null)).toBeUndefined()
	})

	it('parseNumber accepts finite numbers and numeric strings', () => {
		expect(parseNumber(42)).toBe(42)
		expect(Object.is(parseNumber(-0), -0)).toBe(true)
		expect(parseNumber('42')).toBe(42)
		expect(parseNumber(' 3.14 ')).toBe(3.14)
		expect(parseNumber('  42')).toBe(42)
		expect(parseNumber('')).toBeUndefined()
		expect(parseNumber('   ')).toBeUndefined()
		expect(parseNumber('abc')).toBeUndefined()
		expect(parseNumber(Number.NaN)).toBeUndefined()
		expect(parseNumber(Number.POSITIVE_INFINITY)).toBeUndefined()
		expect(parseNumber(true)).toBeUndefined()
		// Clause-A edge sweep: JS numeric-literal quirks Number(...) honors.
		expect(parseNumber('0x10')).toBe(16)
		expect(parseNumber('.5')).toBe(0.5)
		expect(parseNumber('5.')).toBe(5)
		expect(parseNumber('1e999')).toBeUndefined()
		expect(parseNumber('1_000')).toBeUndefined()
	})

	it('parseInteger rejects fractional numbers', () => {
		expect(parseInteger(42)).toBe(42)
		expect(Object.is(parseInteger(-0), -0)).toBe(true)
		expect(parseInteger('42')).toBe(42)
		expect(parseInteger(3.14)).toBeUndefined()
		expect(parseInteger('3.14')).toBeUndefined()
		expect(parseInteger('abc')).toBeUndefined()
		expect(parseInteger(2 ** 53)).toBe(2 ** 53)
	})

	it('parseBoolean accepts booleans and their string/number spellings', () => {
		expect(parseBoolean(true)).toBe(true)
		expect(parseBoolean(false)).toBe(false)
		expect(parseBoolean('true')).toBe(true)
		expect(parseBoolean('false')).toBe(false)
		expect(parseBoolean('1')).toBe(true)
		expect(parseBoolean('0')).toBe(false)
		expect(parseBoolean(1)).toBe(true)
		expect(parseBoolean(0)).toBe(false)
		expect(parseBoolean('yes')).toBeUndefined()
		expect(parseBoolean(2)).toBeUndefined()
		expect(parseBoolean(null)).toBeUndefined()
	})

	it('parseNull accepts only null, returning null (not undefined) on success', () => {
		expect(parseNull(null)).toBeNull()
		expect(parseNull('null')).toBeUndefined()
		expect(parseNull(undefined)).toBeUndefined()
		expect(parseNull(0)).toBeUndefined()
	})
})

describe('structural parsers', () => {
	it('parseRecord narrows a plain record by reference', () => {
		const record = { a: 1 }
		expect(parseRecord(record)).toBe(record)
		expect(parseRecord([])).toBeUndefined()
		expect(parseRecord(null)).toBeUndefined()
		expect(parseRecord(new Date())).toBeUndefined()
	})

	it('parseArray narrows an array by reference, optionally guarding elements', () => {
		const numbers = [1, 2, 3]
		expect(parseArray(numbers)).toBe(numbers)
		expect(parseArray(numbers, isNumber)).toBe(numbers)
		expect(parseArray([1, '2'], isNumber)).toBeUndefined()
		expect(parseArray('x')).toBeUndefined()
		expect(parseArray({})).toBeUndefined()
	})

	it('parseEnum matches one of the allowed literals', () => {
		const allowed: readonly ['a', 'b'] = ['a', 'b']
		expect(parseEnum('a', allowed)).toBe('a')
		expect(parseEnum('b', allowed)).toBe('b')
		expect(parseEnum('c', allowed)).toBeUndefined()
		expect(parseEnum(1, allowed)).toBeUndefined()
	})

	it('parseEnum widens to number and boolean literals, matching by identity only', () => {
		expect(parseEnum(1, [1, 2])).toBe(1)
		expect(parseEnum(true, [true, false])).toBe(true)
		// No cross-type coercion — a numeric-looking string never matches a number literal.
		expect(parseEnum('1', [1])).toBeUndefined()
		// Object.is semantics: NaN matches its own literal (unlike ===).
		expect(parseEnum(Number.NaN, [Number.NaN])).toBe(Number.NaN)
	})

	it('parseJSONValue narrows a cycle-safe JSON tree by reference', () => {
		const tree = { nested: [1, 'x', null] }
		expect(parseJSONValue(tree)).toBe(tree)
		expect(parseJSONValue(Number.NaN)).toBeUndefined()
		expect(parseJSONValue(Number.POSITIVE_INFINITY)).toBeUndefined()
		expect(parseJSONValue(() => 1)).toBeUndefined()
		expect(parseJSONValue(new Date())).toBeUndefined()

		const cyclic: Record<string, unknown> = { a: 1 }
		cyclic.self = cyclic
		expect(parseJSONValue(cyclic)).toBeUndefined()
	})
})

describe('record-field parsers', () => {
	it('read and parse fields by key', () => {
		const record: Record<string, unknown> = {
			name: 'Ada',
			count: '42',
			ratio: 3.5,
			active: 'true',
			meta: { nested: 1 },
			tags: [1, 2],
			role: 'admin',
		}
		const allowed: readonly ['admin', 'guest'] = ['admin', 'guest']

		expect(parseStringField(record, 'name')).toBe('Ada')
		expect(parseNumberField(record, 'count')).toBe(42)
		expect(parseIntegerField(record, 'ratio')).toBeUndefined()
		expect(parseBooleanField(record, 'active')).toBe(true)
		expect(parseRecordField(record, 'meta')).toEqual({ nested: 1 })
		expect(parseArrayField(record, 'tags', isNumber)).toEqual([1, 2])
		expect(parseEnumField(record, 'role', allowed)).toBe('admin')
		expect(parseStringField(record, 'missing')).toBeUndefined()
	})

	it('read and parse nested fields by key path', () => {
		const record: Record<string, unknown> = {
			user: {
				profile: { name: 'Ada', age: '36', admin: 'true' },
				roles: ['admin', 'editor'],
			},
		}
		const allowed: readonly ['admin', 'guest'] = ['admin', 'guest']

		expect(parseStringField(record, ['user', 'profile', 'name'])).toBe('Ada')
		expect(parseNumberField(record, ['user', 'profile', 'age'])).toBe(36)
		expect(parseBooleanField(record, ['user', 'profile', 'admin'])).toBe(true)
		expect(parseRecordField(record, ['user', 'profile'])).toEqual({
			name: 'Ada',
			age: '36',
			admin: 'true',
		})
		expect(parseArrayField(record, ['user', 'roles'], isString)).toEqual(['admin', 'editor'])
		// An array element reached by string index along the path.
		expect(parseEnumField(record, ['user', 'roles', '0'], allowed)).toBe('admin')
	})

	it('parseNullField and parseJSONValueField read present, absent, and nested paths', () => {
		const record: Record<string, unknown> = {
			flag: null,
			present: 'not null',
			tree: { nested: [1, 'x', null] },
			user: { profile: { setting: null } },
		}

		expect(parseNullField(record, 'flag')).toBeNull()
		expect(parseNullField(record, 'present')).toBeUndefined()
		expect(parseNullField(record, 'missing')).toBeUndefined()
		expect(parseNullField(record, ['user', 'profile', 'setting'])).toBeNull()

		expect(parseJSONValueField(record, 'tree')).toEqual({ nested: [1, 'x', null] })
		expect(parseJSONValueField(record, 'missing')).toBeUndefined()
		expect(parseJSONValueField(record, ['user', 'profile', 'setting'])).toBeNull()
	})

	it('parseNullField and parseJSONValueField never throw against a hostile getter', () => {
		const hostile = {
			get a(): unknown {
				throw new Error('hostile getter')
			},
		}
		expect(() => parseNullField(hostile, 'a')).not.toThrow()
		expect(parseNullField(hostile, 'a')).toBeUndefined()
		expect(() => parseJSONValueField(hostile, 'a')).not.toThrow()
		expect(parseJSONValueField(hostile, 'a')).toBeUndefined()
	})
})

describe('parse ↔ guard soundness (AGENTS §14)', () => {
	it('parseString ↔ isString', () => {
		expect(soundnessViolations(isString, parseString)).toEqual([])
	})

	it('parseNumber ↔ isFiniteNumber', () => {
		expect(soundnessViolations(isFiniteNumber, parseNumber)).toEqual([])
	})

	it('parseInteger ↔ isInteger', () => {
		expect(soundnessViolations(isInteger, parseInteger)).toEqual([])
	})

	it('parseBoolean ↔ isBoolean', () => {
		expect(soundnessViolations(isBoolean, parseBoolean)).toEqual([])
	})

	it('parseRecord ↔ isRecord', () => {
		expect(soundnessViolations(isRecord, parseRecord)).toEqual([])
	})

	it('parseArray (guarded) ↔ arrayOf(isNumber)', () => {
		expect(soundnessViolations(arrayOf(isNumber), (value) => parseArray(value, isNumber))).toEqual(
			[],
		)
	})

	it('parseArray (unguarded) ↔ isArray', () => {
		expect(soundnessViolations(isArray, (value) => parseArray(value))).toEqual([])
	})

	it('parseEnum ↔ literalOf', () => {
		const allowed: readonly ['hello', 'abc'] = ['hello', 'abc']
		expect(
			soundnessViolations(literalOf(...allowed), (value) => parseEnum(value, allowed)),
		).toEqual([])
	})

	it('parseEnum ↔ literalOf with mixed numeric/boolean literals', () => {
		const allowed: readonly [1, 2, true] = [1, 2, true]
		expect(
			soundnessViolations(literalOf(...allowed), (value) => parseEnum(value, allowed)),
		).toEqual([])
	})

	it('parseNull ↔ isNull', () => {
		expect(soundnessViolations(isNull, parseNull)).toEqual([])
	})

	it('parseJSONValue ↔ isJSONValue', () => {
		expect(soundnessViolations(isJSONValue, parseJSONValue)).toEqual([])
	})
})

describe('JSON parsers', () => {
	it('parseJSON returns parsed values and undefined on malformed input', () => {
		expect(parseJSON('{"a":1}')).toEqual({ a: 1 })
		expect(parseJSON('[1,2,3]')).toEqual([1, 2, 3])
		expect(parseJSON('"hi"')).toBe('hi')
		expect(parseJSON('42')).toBe(42)
		expect(parseJSON('true')).toBe(true)
		expect(parseJSON('null')).toBeNull()
		expect(parseJSON('not json')).toBeUndefined()
		expect(parseJSON('{bad}')).toBeUndefined()
		expect(parseJSON('')).toBeUndefined()
	})

	it('parseJSONAs validates the parsed value with the supplied guard', () => {
		const isConfig = recordOf({ host: isString, tags: arrayOf(isString) })
		expect(parseJSONAs('{"host":"localhost","tags":["a","b"]}', isConfig)).toEqual({
			host: 'localhost',
			tags: ['a', 'b'],
		})
		// Parsed, but the guard rejects it (tags missing).
		expect(parseJSONAs('{"host":"localhost"}', isConfig)).toBeUndefined()
		// Never throws on malformed input.
		expect(parseJSONAs('not json', isConfig)).toBeUndefined()
	})

	it('parseJSONAs composes with isJSONPrimitive', () => {
		expect(parseJSONAs('42', isJSONPrimitive)).toBe(42)
		expect(parseJSONAs('"hi"', isJSONPrimitive)).toBe('hi')
		expect(parseJSONAs('null', isJSONPrimitive)).toBeNull()
		expect(parseJSONAs('{"a":1}', isJSONPrimitive)).toBeUndefined()
	})

	it('JSON_SCHEMA_TYPES drives the schema-type vocabulary via the shipped primitives', () => {
		expect(parseEnum('object', JSON_SCHEMA_TYPES)).toBe('object')
		expect(parseEnum('integer', JSON_SCHEMA_TYPES)).toBe('integer')
		expect(parseEnum('widget', JSON_SCHEMA_TYPES)).toBeUndefined()
		// literalOf over the same vocabulary is the schema-type guard.
		const isSchemaType = literalOf(...JSON_SCHEMA_TYPES)
		expect(isSchemaType('string')).toBe(true)
		expect(isSchemaType('Date')).toBe(false)
	})
})
