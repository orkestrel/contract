import type { JSONSchema } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	attempt,
	canonicalStringify,
	classifyFormat,
	compileSchema,
	compileGuard,
	encodeLeaf,
	inferPrimitiveEnum,
	integerShape,
	INFER_BREADTH_LIMIT,
	INFER_DEPTH_LIMIT,
	INFER_ENUM_LIMIT,
	isContractError,
	matchesISOInstant,
	literalShape,
	objectShape,
	samplesToFormat,
	samplesToSchema,
	schemaToObject,
	schemaToShape,
	schemaToParameters,
	stringShape,
	stringToFormat,
	unifySchemas,
	valueToSchema,
} from '@src/core'
import {
	buildCyclicArray,
	buildCyclicRecord,
	buildSparseArray,
	captureContractError,
	createClassInstance,
	createHostileKeys,
	createNativeMaximumSparseArray,
	createRevokedArrayProxy,
	createThrowingGetter,
	createThrowingPrototype,
	NullBaseDeclaration,
	replaceIntrinsic,
	SOUNDNESS_SAMPLE,
} from '../../setup.js'
import { createForeignPrototype } from '../../setupServer.js'

describe('valueToSchema — leaf kinds', () => {
	it('infers null', () => {
		expect(valueToSchema(null)).toEqual({ type: 'null' })
	})

	it('infers boolean', () => {
		expect(valueToSchema(true)).toEqual({ type: 'boolean' })
		expect(valueToSchema(false)).toEqual({ type: 'boolean' })
	})

	it('infers integer (Number.isInteger semantics, -0 included)', () => {
		expect(valueToSchema(42)).toEqual({ type: 'integer' })
		expect(valueToSchema(-1)).toEqual({ type: 'integer' })
		expect(valueToSchema(-0)).toEqual({ type: 'integer' })
	})

	it('infers finite non-integer number', () => {
		expect(valueToSchema(3.14)).toEqual({ type: 'number' })
	})

	it('widens non-finite numbers to {} — JSON carries no NaN / ±Infinity, so no type keyword is truthful', () => {
		expect(valueToSchema(Number.NaN)).toEqual({})
		expect(valueToSchema(Number.POSITIVE_INFINITY)).toEqual({})
		expect(valueToSchema(Number.NEGATIVE_INFINITY)).toEqual({})
	})

	it('infers string', () => {
		expect(valueToSchema('hello')).toEqual({ type: 'string' })
	})

	it('infers {} for function, symbol, and bigint leaves', () => {
		expect(valueToSchema(() => 1)).toEqual({})
		expect(valueToSchema(Symbol('x'))).toEqual({})
		expect(valueToSchema(10n)).toEqual({})
	})

	it('infers {} for undefined at the top level', () => {
		expect(valueToSchema(undefined)).toEqual({})
	})

	it('infers {} for non-plain, non-Date objects (Map, Set)', () => {
		expect(valueToSchema(new Map())).toEqual({})
		expect(valueToSchema(new Set())).toEqual({})
	})

	it('infers { type: string } for a Date by default (correctness fix over dropping it)', () => {
		expect(valueToSchema(new Date())).toEqual({ type: 'string' })
	})
})

describe('valueToSchema — arrays', () => {
	it('infers an empty array with no items', () => {
		expect(valueToSchema([])).toEqual({ type: 'array' })
	})

	it('infers a homogeneous array', () => {
		expect(valueToSchema(['a', 'b', 'c'])).toEqual({
			type: 'array',
			items: { type: 'string' },
		})
	})

	it('uses the own-index lens when a Proxy has trap contradicts its indices', () => {
		const value = new Proxy([1, 2, 3], {
			has() {
				return false
			},
		})
		expect(valueToSchema(value)).toEqual({
			type: 'array',
			items: { type: 'integer' },
		})
	})

	it('collapses integer + number into number ([1, 2.5])', () => {
		expect(valueToSchema([1, 2.5])).toEqual({
			type: 'array',
			items: { type: 'number' },
		})
	})

	it('infers a heterogeneous array as items: { anyOf: [...] } sorted deterministically', () => {
		const result = valueToSchema(['a', true, 1.5])
		expect(result.items).toBeDefined()
		const items = result.items
		expect(items?.anyOf).toBeDefined()
		expect(items?.anyOf).toHaveLength(3)
		// Deterministic ordering: two independently-built structurally-equal
		// arrays produce byte-identical anyOf ordering.
		const other = valueToSchema([1.5, true, 'a'])
		expect(JSON.stringify(result)).toBe(JSON.stringify(other))
	})
})

describe('valueToSchema — objects', () => {
	it('infers an empty object', () => {
		expect(valueToSchema({})).toEqual({ type: 'object', additionalProperties: false })
	})

	it('preserves readable empty, frozen, null-prototype, inherited, and class-instance controls', () => {
		expect(valueToSchema(Object.freeze({ a: 1 }))).toEqual(valueToSchema({ a: 1 }))
		const nullPrototype = Object.assign(Object.create(null), { a: 1 })
		expect(valueToSchema(nullPrototype)).toEqual(valueToSchema({ a: 1 }))
		const inherited = Object.create({ inherited: 1 })
		expect(valueToSchema(inherited)).toEqual({})
		expect(valueToSchema(createClassInstance())).toEqual({})
	})

	it('refuses the exact advertised-key throwing-read probe instead of inferring {}', () => {
		const hostile = new Proxy(
			{ a: 1 },
			{
				get() {
					throw new Error('hostile read')
				},
			},
		)
		const error = captureContractError(() => valueToSchema(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it('names an unreadable options argument instead of blaming the value', () => {
		const options = new Proxy(
			{},
			{
				get() {
					throw new Error('hostile options')
				},
			},
		)
		const error = captureContractError(() =>
			Reflect.apply(valueToSchema, undefined, [{ id: 1 }, options]),
		)

		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: options could not be read')
	})

	it('carries inherited and non-enumerable inference options', () => {
		const prototype = createForeignPrototype()
		Object.defineProperty(prototype, 'format', {
			value: true,
			enumerable: true,
			configurable: true,
		})
		const inherited: { readonly format?: boolean } = Object.create(prototype)
		const hidden: { readonly enum?: boolean } = {}
		Object.defineProperty(hidden, 'enum', { value: true, enumerable: false })

		expect(valueToSchema('2024-01-01', inherited)).toEqual({
			type: 'string',
			format: 'date',
		})
		expect(samplesToSchema(['active', 'inactive', 'active'], hidden)).toEqual({
			enum: ['active', 'inactive'],
		})
	})

	it('rejects array and class-instance inference options as non-record containers', () => {
		class Options {
			readonly format = true
		}
		for (const options of [[], new Options()]) {
			for (const [reader, run] of [
				['valueToSchema', () => Reflect.apply(valueToSchema, undefined, ['value', options])],
				['samplesToSchema', () => Reflect.apply(samplesToSchema, undefined, [['value'], options])],
			] satisfies ReadonlyArray<readonly [string, () => unknown]>) {
				const error = captureContractError(run)
				expect(error.code).toBe('structure')
				expect(error.message).toBe(`${reader}: options must be a plain record`)
			}
		}
	})

	it('infers properties/required/additionalProperties, matching compileSchema round-trip parity', () => {
		const shape = objectShape({
			age: integerShape(),
			name: stringShape(),
		})
		const expected = compileSchema(shape)
		const inferred = valueToSchema({ name: 'Ada', age: 36 })
		expect(inferred).toEqual(expected)
	})

	it('drops an undefined-valued property and opens the schema (a closed schema would reject its own source object)', () => {
		const inferred = valueToSchema({ a: 1, b: undefined })
		expect(inferred).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' } },
			required: ['a'],
			additionalProperties: true,
		})
	})

	it('flips additionalProperties via the closed option', () => {
		expect(valueToSchema({ a: 1 }, { closed: false })).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' } },
			required: ['a'],
			additionalProperties: true,
		})
	})

	it('is deterministic — sorted property keys produce identical output regardless of insertion order', () => {
		const first = valueToSchema({ b: 1, a: 2, c: 3 })
		const second: Record<string, unknown> = {}
		second.c = 3
		second.a = 2
		second.b = 1
		const other = valueToSchema(second)
		expect(JSON.stringify(first)).toBe(JSON.stringify(other))
	})
})

describe('valueToSchema — cycles', () => {
	it('does not hang or throw on a self-referential object, emitting {} at the back-edge', () => {
		const node: Record<string, unknown> = { name: 'root' }
		node.self = node
		expect(() => valueToSchema(node)).not.toThrow()
		const schema = valueToSchema(node)
		expect(schema.type).toBe('object')
		expect(schema.properties?.self).toEqual({})
	})

	it('does not hang or throw on a self-referential array', () => {
		const arr: unknown[] = [1]
		arr.push(arr)
		expect(() => valueToSchema(arr)).not.toThrow()
	})
})

describe('valueToSchema — hostile input', () => {
	it('does not drop an own "__proto__" key behind the Object.prototype setter', () => {
		const node: unknown = JSON.parse('{"__proto__":1,"a":2}')
		const schema = valueToSchema(node)
		expect(schema.properties).toHaveProperty('__proto__')
		expect(schema.properties).toHaveProperty('a')
		expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['__proto__', 'a'])
		expect(schema.required).toEqual(['__proto__', 'a'])
		expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...(schema.required ?? [])].sort())
	})

	it('refuses when Object.keys throws (hostile ownKeys trap)', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		const error = captureContractError(() => valueToSchema(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})
})

describe('valueToSchema — depth and breadth caps', () => {
	it('emits {} once the depth budget is exhausted', () => {
		const deeplyNested: Record<string, unknown> = { value: 1 }
		let current = deeplyNested
		for (let level = 0; level < 5; level += 1) {
			const next: Record<string, unknown> = { child: current }
			current = next
		}
		const shallow = valueToSchema(current, { limits: { depth: 1 } })
		expect(shallow).toEqual({
			type: 'object',
			properties: { child: {} },
			required: ['child'],
			additionalProperties: false,
		})
	})

	it('caps sampled object properties at the properties limit', () => {
		const wide: Record<string, unknown> = { a: 1, b: 2, c: 3, d: 4 }
		const capped = valueToSchema(wide, { limits: { properties: 2 } })
		expect(Object.keys(capped.properties ?? {})).toHaveLength(2)
		expect(Object.keys(capped.properties ?? {})).toEqual(['a', 'b'])
	})

	it('caps sampled array elements at the properties limit', () => {
		const wide = valueToSchema([1, 'x', true, 3.5], { limits: { properties: 2 } })
		// Only the first 2 elements (1, 'x') are sampled → integer + string.
		expect(wide.items?.anyOf).toHaveLength(2)
	})

	it('uses the default limits when options are omitted', () => {
		expect(INFER_DEPTH_LIMIT).toBeGreaterThan(0)
		expect(INFER_BREADTH_LIMIT).toBeGreaterThan(0)
	})
})

describe('samplesToSchema — records', () => {
	it('marks a key required only when present (non-undefined) in every sample', () => {
		const result = samplesToSchema([{ a: 1 }, { a: 1, b: 2 }])
		expect(result).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' }, b: { type: 'integer' } },
			required: ['a'],
			additionalProperties: false,
		})
	})

	it('unions keys across all samples', () => {
		const result = samplesToSchema([{ a: 1 }, { b: 'x' }])
		expect(result.properties).toHaveProperty('a')
		expect(result.properties).toHaveProperty('b')
		expect(result.required).toBeUndefined()
	})

	it('returns {} for an empty samples array', () => {
		expect(samplesToSchema([])).toEqual({})
	})

	it('unifies per-key value schemas the same way a single-value array does', () => {
		const result = samplesToSchema([{ n: 1 }, { n: 2.5 }])
		expect(result.properties?.n).toEqual({ type: 'number' })
	})

	it('does not drop an own "__proto__" key behind the Object.prototype setter', () => {
		const row: unknown = JSON.parse('{"__proto__":1,"a":2}')
		const schema = samplesToSchema([row])
		expect(schema.properties).toHaveProperty('__proto__')
		expect(schema.properties).toHaveProperty('a')
		expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['__proto__', 'a'])
		expect(schema.required).toEqual(['__proto__', 'a'])
		expect(Object.keys(schema.properties ?? {}).sort()).toEqual([...(schema.required ?? [])].sort())
	})

	it('refuses when a sample row throws on key enumeration (hostile ownKeys trap)', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		const error = captureContractError(() => samplesToSchema([hostile]))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('samplesToSchema: samples could not be read')
	})

	it('terminates on a cyclic sample row, bounded by depth alone', () => {
		const row: Record<string, unknown> = { name: 'root' }
		row.self = row
		expect(() => samplesToSchema([row])).not.toThrow()
		const schema = samplesToSchema([row])
		expect(schema.type).toBe('object')
	})
})

describe('samplesToSchema — mixed / non-object samples', () => {
	it('unifies via anyOf when samples are not all plain records', () => {
		const result = samplesToSchema(['a', 1, true])
		expect(result.anyOf).toBeDefined()
		expect(result.anyOf).toHaveLength(3)
	})

	it('unifies a single-kind non-object sample set without anyOf', () => {
		expect(samplesToSchema(['a', 'b', 'c'])).toEqual({ type: 'string' })
	})
})

describe('seam — schemaToParameters(valueToSchema(...))', () => {
	it('returns a defined record for an inferred object schema', () => {
		const schema = valueToSchema({ id: 1, name: 'Ada' })
		const parameters = schemaToParameters(schema)
		expect(parameters).toBeDefined()
		expect(parameters?.type).toBe('object')
	})

	it('returns a defined record even for a non-object root schema (MCP caveat: wrap it)', () => {
		const schema = valueToSchema('hello')
		const parameters = schemaToParameters(schema)
		expect(parameters).toBeDefined()
		expect(parameters?.type).toBe('string')
	})
})

describe('stringToFormat — direct classification', () => {
	it('matches a UUID', () => {
		expect(stringToFormat('550e8400-e29b-41d4-a716-446655440000')).toBe('uuid')
	})

	it('does not match an almost-UUID (wrong segment length)', () => {
		expect(stringToFormat('550e8400-e29b-41d4-a716-44665544000')).toBeUndefined()
	})

	it('matches a date-time', () => {
		expect(stringToFormat('2024-01-15T10:30:00Z')).toBe('date-time')
		expect(stringToFormat('2024-01-15T10:30:00.123+02:00')).toBe('date-time')
	})

	it('matches a date', () => {
		expect(stringToFormat('2024-01-15')).toBe('date')
	})

	it('rejects an impossible date (shape-plausible but invalid)', () => {
		expect(stringToFormat('2020-13-45')).toBeUndefined()
	})

	it('requires an offset for a time (RFC 3339 full-time) — offset-less falls through', () => {
		expect(stringToFormat('10:30:00')).toBeUndefined()
	})

	it('matches a time with a Z offset', () => {
		expect(stringToFormat('10:30:00Z')).toBe('time')
	})

	it('matches a time with a numeric offset', () => {
		expect(stringToFormat('10:30:00+02:00')).toBe('time')
	})

	it('rejects an impossible time even with a valid offset shape', () => {
		expect(stringToFormat('25:61:61Z')).toBeUndefined()
	})

	it('matches an email', () => {
		expect(stringToFormat('ada@example.com')).toBe('email')
	})

	it('does not match an almost-email (no domain dot)', () => {
		expect(stringToFormat('ada@example')).toBeUndefined()
	})

	it('matches a URI', () => {
		expect(stringToFormat('https://example.com/path')).toBe('uri')
	})

	it('returns undefined for a plain string and the empty string', () => {
		expect(stringToFormat('hello world')).toBeUndefined()
		expect(stringToFormat('')).toBeUndefined()
	})

	it('prefers uuid over date/email/uri when the shape overlaps', () => {
		// A UUID's hex layout never matches the other patterns, but precedence
		// still checks uuid first per the fixed classification order.
		expect(stringToFormat('550e8400-e29b-41d4-a716-446655440000')).toBe('uuid')
	})

	it('accepts real leap dates and rejects normalized calendar overflow', () => {
		expect(stringToFormat('2024-02-29')).toBe('date')
		expect(stringToFormat('2000-02-29')).toBe('date')
		expect(stringToFormat('2023-02-29')).toBeUndefined()
		expect(stringToFormat('1900-02-29')).toBeUndefined()
		expect(stringToFormat('2024-04-31')).toBeUndefined()
		expect(stringToFormat('2024-02-30')).toBeUndefined()
		expect(stringToFormat('2024-02-30T00:00:00Z')).toBeUndefined()
	})

	it('rejects normalized hour 24 while retaining the valid clock boundary', () => {
		expect(stringToFormat('2024-01-15T23:59:59Z')).toBe('date-time')
		expect(stringToFormat('2024-01-15T24:00:00Z')).toBeUndefined()
	})

	it('keeps format classification on the complete ISO grammar', () => {
		expect(stringToFormat('2024-01-15T23:59:59.123Z')).toBe('date-time')
		expect(stringToFormat('2024-01-15T23:59:59+23:59')).toBe('date-time')
		expect(stringToFormat('2024-01-15T23:59:59-23:59')).toBe('date-time')
		expect(stringToFormat('2024-01-15T24:00Z')).toBeUndefined()
		expect(stringToFormat('2024-01-15 24:00:00Z')).toBeUndefined()
		expect(stringToFormat('2024-01-15t24:00:00z')).toBeUndefined()
		expect(stringToFormat('2024-01-15junk')).toBeUndefined()
	})

	it('returns undefined for runtime non-strings without inspecting or coercing them', () => {
		const accesses: PropertyKey[] = []
		const poisoned = new Proxy(
			{},
			{
				get(_target, property) {
					accesses.push(property)
					throw new Error('format coercion')
				},
			},
		)
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()
		const values: readonly unknown[] = [
			undefined,
			null,
			false,
			0,
			42n,
			Symbol('format'),
			{},
			[],
			() => 'date',
			poisoned,
			revoked.proxy,
		]

		for (const value of values) {
			expect(Reflect.apply(stringToFormat, undefined, [value])).toBeUndefined()
		}
		expect(accesses).toEqual([])
	})
})

describe('samplesToFormat — unanimity', () => {
	it('returns the shared format when every value maps to the same one', () => {
		expect(samplesToFormat(['2024-01-01', '2024-02-02', '2024-03-03'])).toBe('date')
	})

	it('returns undefined on disagreement', () => {
		expect(samplesToFormat(['2024-01-01', 'not a date'])).toBeUndefined()
	})

	it('returns undefined when no value matches any format', () => {
		expect(samplesToFormat(['hello', 'world'])).toBeUndefined()
	})

	it('returns undefined for a non-string value in the list', () => {
		expect(samplesToFormat(['2024-01-01', 42])).toBeUndefined()
	})

	it('returns undefined for an empty list', () => {
		expect(samplesToFormat([])).toBeUndefined()
	})
})

describe('valueToSchema — format option', () => {
	it('does not emit format when the option is off', () => {
		expect(valueToSchema('2024-01-01')).toEqual({ type: 'string' })
	})

	it('emits format on a matching leaf when the option is on', () => {
		expect(valueToSchema('2024-01-01', { format: true })).toEqual({
			type: 'string',
			format: 'date',
		})
	})

	it('omits format on a non-matching leaf even when the option is on', () => {
		expect(valueToSchema('hello world', { format: true })).toEqual({ type: 'string' })
	})

	it('applies format to a nested string property', () => {
		expect(valueToSchema({ id: '550e8400-e29b-41d4-a716-446655440000' }, { format: true })).toEqual(
			{
				type: 'object',
				properties: { id: { type: 'string', format: 'uuid' } },
				required: ['id'],
				additionalProperties: false,
			},
		)
	})
})

describe('valueToSchema — Date inference', () => {
	it('infers { type: string } for a Date without the format option', () => {
		expect(valueToSchema(new Date('2024-01-01T00:00:00Z'))).toEqual({ type: 'string' })
	})

	it('infers { type: string, format: date-time } for a Date with the format option', () => {
		expect(valueToSchema(new Date('2024-01-01T00:00:00Z'), { format: true })).toEqual({
			type: 'string',
			format: 'date-time',
		})
	})

	it('infers a nested Date field within an object', () => {
		const schema = valueToSchema({ createdAt: new Date() }, { format: true })
		expect(schema.properties?.createdAt).toEqual({ type: 'string', format: 'date-time' })
	})
})

describe('valueToSchema — exotic values still infer {}', () => {
	it('infers {} for Map, Set, bigint, typed array, function, symbol, undefined', () => {
		expect(valueToSchema(new Map())).toEqual({})
		expect(valueToSchema(new Set())).toEqual({})
		expect(valueToSchema(10n)).toEqual({})
		expect(valueToSchema(new Uint8Array([1, 2]))).toEqual({})
		expect(valueToSchema(() => 1)).toEqual({})
		expect(valueToSchema(Symbol('x'))).toEqual({})
		expect(valueToSchema(undefined)).toEqual({})
	})

	it('infers {} for a nested Map/Set/bigint/typed-array field', () => {
		const schema = valueToSchema({ tags: new Set(['a']), big: 10n })
		expect(schema.properties?.tags).toEqual({})
		expect(schema.properties?.big).toEqual({})
	})
})

describe('samplesToSchema — format across multiple samples', () => {
	it('emits a single { type: string, format } for a unanimous flat string list', () => {
		expect(samplesToSchema(['2024-01-01', '2024-02-02'], { format: true })).toEqual({
			type: 'string',
			format: 'date',
		})
	})

	it('emits a bare { type: string } (not anyOf) when samples disagree on format', () => {
		const result = samplesToSchema(['2024-01-01', 'not a date'], { format: true })
		expect(result).toEqual({ type: 'string' })
		expect(result.anyOf).toBeUndefined()
	})

	it('applies format per-key across record samples', () => {
		const result = samplesToSchema(
			[
				{ id: '550e8400-e29b-41d4-a716-446655440000' },
				{ id: 'e29b41d4-a716-4466-5544-0000550e8400' },
			],
			{ format: true },
		)
		expect(result.properties?.id).toEqual({ type: 'string', format: 'uuid' })
	})

	it('does not emit format when the option is off, even with unanimous samples', () => {
		expect(samplesToSchema(['2024-01-01', '2024-02-02'])).toEqual({ type: 'string' })
	})
})

describe('samplesToSchema — enum inference', () => {
	it('fires on a low-cardinality repeated string slot', () => {
		expect(samplesToSchema(['active', 'inactive', 'active'], { enum: true })).toEqual({
			enum: ['active', 'inactive'],
		})
	})

	it('fires on a low-cardinality repeated number slot', () => {
		expect(samplesToSchema([1, 2, 1, 3, 2], { enum: true })).toEqual({ enum: [1, 2, 3] })
	})

	it('does not fire without repetition (N distinct values across N samples)', () => {
		expect(samplesToSchema(['a', 'b', 'c'], { enum: true })).toEqual({ type: 'string' })
	})

	it('does not fire over the cardinality cap', () => {
		const values = Array.from({ length: INFER_ENUM_LIMIT + 1 }, (_, index) => `v${index}`)
		const repeated = [...values, values[0]]
		expect(samplesToSchema(repeated, { enum: true })).toEqual({ type: 'string' })
	})

	it('does not fire on a heterogeneous / mixed-null slot', () => {
		expect(samplesToSchema(['active', null, 'active'], { enum: true }).enum).toBeUndefined()
		expect(samplesToSchema(['active', true, 'active'], { enum: true }).enum).toBeUndefined()
	})

	it('does not fire on a number slot containing NaN (non-finite disqualifies)', () => {
		// The slot is enum-ineligible, and the NaN sample itself infers `{}` (no
		// JSON Schema type describes a non-finite number), so the unified result
		// keeps both members rather than claiming every sample is a number.
		expect(samplesToSchema([1, 1, Number.NaN], { enum: true })).toEqual({
			anyOf: [{ type: 'integer' }, {}],
		})
	})

	it('does not fire under default options (enum off)', () => {
		expect(samplesToSchema(['active', 'inactive', 'active'])).toEqual({ type: 'string' })
	})

	it('fires with a single distinct value repeated (D=1, V>=2)', () => {
		expect(samplesToSchema(['x', 'x'], { enum: true })).toEqual({ enum: ['x'] })
	})

	it('round-trips: an inferred enum matches compileSchema of the equivalent literalShape', () => {
		const inferred = samplesToSchema(['active', 'inactive', 'active'], { enum: true })
		const compiled = compileSchema(literalShape(['active', 'inactive']))
		expect(inferred).toEqual(compiled)
	})

	it('precedence: enum wins over format when both fire', () => {
		const result = samplesToSchema(['2024-01-01', '2024-01-01'], { enum: true, format: true })
		expect(result).toEqual({ enum: ['2024-01-01'] })
	})

	it('applies per-key across record samples', () => {
		const result = samplesToSchema(
			[{ status: 'active' }, { status: 'inactive' }, { status: 'active' }],
			{ enum: true },
		)
		expect(result.properties?.status).toEqual({ enum: ['active', 'inactive'] })
	})
})

describe('determinism — format and enum resolution across insertion order', () => {
	it('produces identical output for two structurally-equal sample sets built in different order', () => {
		const first = samplesToSchema(['b', 'a', 'b', 'c'], { enum: true, format: true })
		const second = samplesToSchema(['c', 'b', 'a', 'b'], { enum: true, format: true })
		expect(JSON.stringify(first)).toBe(JSON.stringify(second))
	})

	it('sorts enum members deterministically regardless of first-seen order', () => {
		const first = samplesToSchema([3, 1, 2, 1], { enum: true })
		const second = samplesToSchema([1, 2, 3, 1], { enum: true })
		expect(JSON.stringify(first)).toBe(JSON.stringify(second))
	})
})

describe('valueToSchema — hostile input with format on', () => {
	it('refuses when Object.keys throws (hostile ownKeys trap), format enabled', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		const error = captureContractError(() => valueToSchema(hostile, { format: true }))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it('does not drop an own "__proto__" key with format enabled', () => {
		const node: unknown = JSON.parse('{"__proto__":"2024-01-01","a":"hi"}')
		const schema = valueToSchema(node, { format: true })
		expect(schema.properties).toHaveProperty('__proto__')
		expect(schema.properties).toHaveProperty('a')
	})

	it('terminates on a cyclic object with format enabled', () => {
		const node: Record<string, unknown> = { name: 'root' }
		node.self = node
		expect(() => valueToSchema(node, { format: true })).not.toThrow()
	})
})

describe('samplesToSchema — hostile input with enum/format on', () => {
	it('refuses when a sample row throws on key enumeration (hostile ownKeys trap)', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		const error = captureContractError(() =>
			samplesToSchema([hostile], { enum: true, format: true }),
		)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('samplesToSchema: samples could not be read')
	})

	it('terminates on a cyclic sample row with enum/format enabled', () => {
		const row: Record<string, unknown> = { name: 'root' }
		row.self = row
		expect(() => samplesToSchema([row], { enum: true, format: true })).not.toThrow()
	})
})

describe('array inference — hostile own-getter / Proxy-over-array refusal (C1)', () => {
	it('refuses when a throwing own-getter sits at array index 0', () => {
		const hostile: unknown[] = [1, 2, 3]
		Object.defineProperty(hostile, 0, {
			get() {
				throw new Error('hostile getter')
			},
			enumerable: true,
			configurable: true,
		})
		const error = captureContractError(() => valueToSchema(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it('refuses a Proxy-over-array whose element read fails', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				if (property === '0') throw new Error('hostile proxy element')
				return Reflect.get(target, property, receiver)
			},
		})
		const error = captureContractError(() => valueToSchema(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it('refuses a hostile element nested inside an array of arrays', () => {
		const inner: unknown[] = [1]
		Object.defineProperty(inner, 0, {
			get() {
				throw new Error('hostile nested getter')
			},
			enumerable: true,
			configurable: true,
		})
		const outer = [inner]
		const error = captureContractError(() => valueToSchema(outer))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it('refuses a hostile array element with format: true', () => {
		const hostile: unknown[] = [1]
		Object.defineProperty(hostile, 0, {
			get() {
				throw new Error('hostile getter')
			},
			enumerable: true,
			configurable: true,
		})
		const error = captureContractError(() => valueToSchema(hostile, { format: true }))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it('refuses a hostile array element via samplesToSchema', () => {
		const hostile: unknown[] = [1]
		Object.defineProperty(hostile, 0, {
			get() {
				throw new Error('hostile getter')
			},
			enumerable: true,
			configurable: true,
		})
		const error = captureContractError(() => samplesToSchema([hostile]))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('samplesToSchema: samples could not be read')
	})

	it('refuses a Proxy-over-array whose `length` getter is hostile', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				if (property === 'length') throw new Error('hostile')
				return Reflect.get(target, property, receiver)
			},
		})
		const error = captureContractError(() => valueToSchema(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it('refuses a hostile-`length` Proxy-over-array nested as an object property', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				if (property === 'length') throw new Error('hostile')
				return Reflect.get(target, property, receiver)
			},
		})
		const error = captureContractError(() => valueToSchema({ items: hostile }))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it('refuses a hostile-`length` Proxy-over-array nested as an outer array element', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				if (property === 'length') throw new Error('hostile')
				return Reflect.get(target, property, receiver)
			},
		})
		const error = captureContractError(() => valueToSchema([hostile]))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})
})

describe('valueToSchema / samplesToSchema — option sanitization (C2)', () => {
	it('does not hang on a 40000-deep array chain with a valid budget', () => {
		let current: unknown = 'leaf'
		for (let level = 0; level < 40000; level += 1) current = [current]
		expect(() => valueToSchema(current)).not.toThrow()
	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e9, -1, 2.5])(
		'never hangs or throws for a hostile depth limit of %s',
		(depth) => {
			let current: unknown = 'leaf'
			for (let level = 0; level < 500; level += 1) current = { child: current }
			expect(() => valueToSchema(current, { limits: { depth } })).not.toThrow()
		},
	)

	it.each([Number.NaN, -1, -5])(
		'keeps properties/required in sync under a hostile properties limit of %s (no dropped-required leak)',
		(properties) => {
			const wide: Record<string, unknown> = { a: 1, b: 2, c: 3, d: 4, e: 5 }
			const schema = valueToSchema(wide, { limits: { properties } })
			expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
				[...(schema.required ?? [])].sort(),
			)
		},
	)

	it('a negative properties limit never drops the last sorted key (sanitized back to the default budget)', () => {
		const wide: Record<string, unknown> = { a: 1, b: 2, c: 3, d: 4, e: 5 }
		const schema = valueToSchema(wide, { limits: { properties: -5 } })
		// -5 sanitizes to INFER_BREADTH_LIMIT (no truncation for 5 keys), so
		// every key survives and the schema stays closed — the pre-fix bug was
		// slice(0, -5) silently dropping the last sorted keys.
		expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
		expect(schema.additionalProperties).toBe(false)
	})

	it('falls back to INFER_DEPTH_LIMIT / INFER_BREADTH_LIMIT for a hostile budget (sanitizeBudget)', () => {
		const shallow = valueToSchema({ a: { b: { c: 1 } } }, { limits: { depth: Number.NaN } })
		const withDefault = valueToSchema({ a: { b: { c: 1 } } })
		expect(shallow).toEqual(withDefault)
	})
})

describe('valueToSchema — truncation opens the schema (C3)', () => {
	it('does not close additionalProperties when the properties limit truncates the key list', () => {
		const schema = valueToSchema({ a: 1, b: 2, c: 3, d: 4 }, { limits: { properties: 2 } })
		expect(schema.additionalProperties).not.toBe(false)
		expect(schema.additionalProperties).toBe(true)
		const properties = Object.keys(schema.properties ?? {})
		for (const key of schema.required ?? []) {
			expect(properties).toContain(key)
		}
	})

	it('keeps additionalProperties: false when the object is NOT truncated', () => {
		const schema = valueToSchema({ a: 1, b: 2 }, { limits: { properties: 2 } })
		expect(schema.additionalProperties).toBe(false)
	})
})

describe('samplesToSchema — truncation opens the schema for record samples (C3)', () => {
	it('does not close additionalProperties when the sample key union is truncated', () => {
		const schema = samplesToSchema([{ a: 1, b: 2, c: 3, d: 4 }], { limits: { properties: 2 } })
		expect(schema.additionalProperties).not.toBe(false)
		expect(schema.additionalProperties).toBe(true)
		const properties = Object.keys(schema.properties ?? {})
		for (const key of schema.required ?? []) {
			expect(properties).toContain(key)
		}
	})

	it('keeps additionalProperties: false when the sample key union is NOT truncated', () => {
		const schema = samplesToSchema([{ a: 1 }, { b: 2 }], { limits: { properties: 2 } })
		expect(schema.additionalProperties).toBe(false)
	})
})

describe('valueToSchema — shared-subtree DAG (C4)', () => {
	it('resolves a depth-24 diamond DAG quickly with a deterministic schema', () => {
		let node: unknown = { leaf: 1 }
		for (let level = 0; level < 24; level += 1) {
			node = { a: node, b: node }
		}
		const start = Date.now()
		const schema = valueToSchema(node)
		const elapsed = Date.now() - start
		expect(elapsed).toBeLessThan(5000)
		expect(schema.type).toBe('object')
		// The memo dedupes identical (object, remaining-depth) re-inference: the
		// 'a' and 'b' branches share the same child object at the same depth, so
		// their computed schemas are the SAME reference, not merely equal —
		// this is what keeps a fan-2/depth-24 DAG from costing 2^24 re-inferences.
		expect(schema.properties?.a).toBe(schema.properties?.b)
	})

	it('resolves a fan-3 shared-reference DAG quickly', () => {
		let node: unknown = { leaf: 1 }
		for (let level = 0; level < 16; level += 1) {
			node = { a: node, b: node, c: node }
		}
		const start = Date.now()
		expect(() => valueToSchema(node)).not.toThrow()
		expect(Date.now() - start).toBeLessThan(5000)
	})
})

describe('stringToFormat — length bound (C5)', () => {
	it('returns undefined for a multi-MB almost-email string', () => {
		const huge = `${'a'.repeat(5_000_000)}@example.com`
		expect(stringToFormat(huge)).toBeUndefined()
	})

	it('still classifies a real UUID, date, and email within the bound', () => {
		expect(stringToFormat('550e8400-e29b-41d4-a716-446655440000')).toBe('uuid')
		expect(stringToFormat('2024-01-15')).toBe('date')
		expect(stringToFormat('ada@example.com')).toBe('email')
	})
})

describe('valueToSchema — sparse arrays (C7, H10-C)', () => {
	it('widens a sparse array to {} so the emitted schema accepts its own source', () => {
		// Red before green: this emitted `{"type":"array","items":{"anyOf":[{"type":
		// "integer"},{}]}}`, and the guard compiled from that schema answered FALSE
		// for the very array it was inferred from — the one direction the round-trip
		// law forbids. A hole is an absent own property everywhere else in the
		// package, so a non-dense array has no JSON expression and widens.
		const sparse = [1, undefined, 3]
		delete sparse[1]

		expect(valueToSchema(sparse)).toEqual({})
		expect(compileGuard(schemaToShape(valueToSchema(sparse)))(sparse)).toBe(true)
		expect(compileGuard(schemaToShape(valueToSchema({ rows: sparse })))({ rows: sparse })).toBe(
			true,
		)
		// The dense control must still infer a real array schema and still round-trip.
		expect(valueToSchema([1, 3])).toEqual({ type: 'array', items: { type: 'integer' } })
		expect(compileGuard(schemaToShape(valueToSchema([1, 3])))([1, 3])).toBe(true)
	})
})

describe('unifySchemas — direct', () => {
	it('refuses an unreadable schema list at its own public boundary', () => {
		const error = captureContractError(() =>
			Reflect.apply(unifySchemas, undefined, [createRevokedArrayProxy()]),
		)

		expect(error.code).toBe('structure')
		expect(error.message).toBe('unifySchemas: schemas could not be read')
	})

	it('returns {} for an empty list', () => {
		expect(unifySchemas([])).toEqual({})
	})

	it('subsumes integer into number alongside a third distinct schema', () => {
		const result = unifySchemas([{ type: 'integer' }, { type: 'number' }, { type: 'string' }])
		expect(result).toEqual({
			anyOf: [{ type: 'number' }, { type: 'string' }],
		})
	})

	it('de-duplicates structurally-equal schemas regardless of key order', () => {
		const result = unifySchemas([
			{ type: 'object', properties: {} },
			{ properties: {}, type: 'object' },
		])
		expect(result).toEqual({ type: 'object', properties: {} })
	})

	it('sorts a multi-member anyOf deterministically', () => {
		const first = unifySchemas([{ type: 'string' }, { type: 'boolean' }, { type: 'null' }])
		const second = unifySchemas([{ type: 'null' }, { type: 'boolean' }, { type: 'string' }])
		expect(JSON.stringify(first)).toBe(JSON.stringify(second))
		expect(first.anyOf).toHaveLength(3)
	})

	it.each([
		['number', 42],
		['null', null],
		['callable', () => undefined],
		['mixed valid and invalid', [{ type: 'string' }, 42]],
	])('rejects a runtime-invalid %s member', (_label, member) => {
		const schemas = Array.isArray(member) ? member : [member]
		const error = captureContractError(() => Reflect.apply(unifySchemas, undefined, [schemas]))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('unifySchemas: schemas could not be read')
	})

	it('accepts ordinary, null-prototype, and realm-shaped plain records deterministically', () => {
		const ordinary = { type: 'string' }
		const nullPrototype: Record<string, unknown> = Object.create(null)
		nullPrototype.type = 'boolean'
		const foreignPlain: Record<string, unknown> = Object.create(createForeignPrototype())
		foreignPlain.type = 'null'
		const schemas = [ordinary, nullPrototype, foreignPlain]

		const first = Reflect.apply(unifySchemas, undefined, [schemas])
		const second = Reflect.apply(unifySchemas, undefined, [[foreignPlain, ordinary, nullPrototype]])
		expect(first).toEqual(second)
		expect(first).toEqual({
			anyOf: [{ type: 'boolean' }, { type: 'null' }, { type: 'string' }],
		})
	})
})

describe('encodeLeaf — the leaf half of canonicalStringify', () => {
	it('answers JSON’s own encoding for a leaf and undefined where JSON has none', () => {
		// Shipped public with no test of its own. The contract is JSON's, not this
		// package's: whatever `JSON.stringify` returns for a non-container.
		expect(encodeLeaf('hi')).toBe('"hi"')
		expect(encodeLeaf(42)).toBe('42')
		expect(encodeLeaf(true)).toBe('true')
		expect(encodeLeaf(null)).toBe('null')
		// A non-finite number has no JSON number form, so JSON writes `null` — a
		// string result, which is why it is a canonical KEY rather than an absence.
		expect(encodeLeaf(Number.NaN)).toBe('null')
		expect(encodeLeaf(Number.POSITIVE_INFINITY)).toBe('null')
		expect(encodeLeaf(-0)).toBe('0')

		// The three values `JSON.stringify` itself answers `undefined` for.
		expect(encodeLeaf(undefined)).toBeUndefined()
		expect(encodeLeaf(() => 1)).toBeUndefined()
		expect(encodeLeaf(Symbol('s'))).toBeUndefined()
	})

	it('refuses a bigint BEFORE the call instead of through it', () => {
		// `JSON.stringify(1n)` throws a TypeError. The guard is what keeps this a
		// total leaf encoder rather than one that raises on a JSON-inexpressible
		// primitive its siblings answer for.
		expect(encodeLeaf(10n)).toBeUndefined()
		expect(attempt(() => JSON.stringify(10n)).success).toBe(false)
	})

	it('keeps a toJSON member’s ordinary meaning for a non-record object', () => {
		const date = new Date('2024-01-15T10:30:00Z')
		expect(encodeLeaf(date)).toBe('"2024-01-15T10:30:00.000Z"')
		expect(encodeLeaf(new Map([['a', 1]]))).toBe('{}')
	})
})

describe('canonicalStringify — direct', () => {
	it('sorts nested object keys recursively at every level', () => {
		const value = { b: { d: 1, c: 2 }, a: 1 }
		expect(canonicalStringify(value)).toBe('{"a":1,"b":{"c":2,"d":1}}')
	})

	it('preserves array element order', () => {
		expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]')
	})

	it('refuses a non-native advertised array length', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				return property === 'length' ? -1 : Reflect.get(target, property, receiver)
			},
		})
		const error = captureContractError(() => canonicalStringify(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('canonicalStringify: value could not be read')
	})

	it('renders NaN as null (JSON.stringify semantics)', () => {
		expect(canonicalStringify(Number.NaN)).toBe('null')
	})
})

describe('canonicalStringify — encoding and read refusal', () => {
	it('returns undefined for a value JSON cannot encode at the top level', () => {
		expect(canonicalStringify(undefined)).toBeUndefined()
		expect(canonicalStringify(() => 1)).toBeUndefined()
		expect(canonicalStringify(Symbol('x'))).toBeUndefined()
		expect(canonicalStringify(10n)).toBeUndefined()
	})

	it('returns undefined for a container carrying a value JSON cannot encode', () => {
		expect(canonicalStringify({ a: undefined })).toBeUndefined()
		expect(canonicalStringify([1, undefined])).toBeUndefined()
		expect(canonicalStringify({ a: { b: 10n } })).toBeUndefined()
		expect(canonicalStringify(buildSparseArray())).toBeUndefined()
	})

	it('returns undefined for cyclic input, at every nesting level', () => {
		expect(canonicalStringify(buildCyclicRecord())).toBeUndefined()
		expect(canonicalStringify(buildCyclicArray())).toBeUndefined()
		expect(canonicalStringify({ nested: buildCyclicRecord() })).toBeUndefined()
	})

	it('accepts a shared (non-cyclic) reference reached twice through different paths', () => {
		const shared = { a: 1 }
		expect(canonicalStringify({ left: shared, right: shared })).toBe(
			'{"left":{"a":1},"right":{"a":1}}',
		)
		expect(canonicalStringify([shared, shared])).toBe('[{"a":1},{"a":1}]')
	})

	it('refuses hostile traversal while retaining undefined for JSON-inexpressible values', () => {
		const hostileGetter = createThrowingGetter()
		const hostileKeys = createHostileKeys()
		for (const hostile of [hostileGetter, hostileKeys, { nested: hostileGetter }]) {
			const error = captureContractError(() => canonicalStringify(hostile))
			expect(error.code).toBe('structure')
			expect(error.message).toBe('canonicalStringify: value could not be read')
		}
	})

	it('returns normally or gives the shared coded read refusal for every sample in the corpus', () => {
		const raw: unknown[] = []
		for (const value of SOUNDNESS_SAMPLE) {
			const outcome = attempt(() => canonicalStringify(value))
			if (
				!outcome.success &&
				(!isContractError(outcome.error) || outcome.error.code !== 'structure')
			) {
				raw.push(value)
			}
		}
		expect(raw).toEqual([])
	})
})

describe('canonicalStringify — the walk at its door', () => {
	it('contains failed record classification at the door boundary', () => {
		const sentinel = new Error('prototype read')

		const outer = captureContractError(() => canonicalStringify(createThrowingPrototype(sentinel)))
		expect(outer.code).toBe('structure')
		expect(outer.message).toBe('canonicalStringify: value could not be read')
		// The walk is interned, so the door's own name is the only one published and
		// the caller reaches the host failure through one `cause` rather than two.
		expect(outer.cause).toBe(sentinel)
	})

	it('sorts readable record realms but leaves readable exotics on native JSON fallback', () => {
		const realmRecord = Object.create(createForeignPrototype())
		Reflect.set(realmRecord, 'b', 1)
		Reflect.set(realmRecord, 'a', 2)
		class Exotic {
			readonly b = 1
			readonly a = 2
		}

		expect(canonicalStringify(realmRecord)).toBe('{"a":2,"b":1}')
		expect(canonicalStringify(new Exotic())).toBe('{"b":1,"a":2}')
		// A class whose prototype a caller reparented to `null` is an exotic too:
		// the shared record brand refuses it, so it keeps declaration order
		// instead of being canonicalized as a plain record.
		expect(canonicalStringify(new NullBaseDeclaration())).toBe('{"type":"string","min":1}')
		expect(canonicalStringify(new Map([['b', 1]]))).toBe('{}')
	})

	it('refuses hostile traversal', () => {
		const error = captureContractError(() => canonicalStringify(createHostileKeys()))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('canonicalStringify: value could not be read')
	})

	it('sorts record keys, preserves array order, and encodes leaves as JSON', () => {
		expect(canonicalStringify({ b: 1, a: [3, 1] })).toBe('{"a":[3,1],"b":1}')
		expect(canonicalStringify(-0)).toBe('0')
		expect(canonicalStringify(Number.NaN)).toBe('null')
	})

	it('reports an un-encodable value as undefined without throwing', () => {
		expect(canonicalStringify(undefined)).toBeUndefined()
		expect(canonicalStringify(buildSparseArray())).toBeUndefined()
	})

	it('treats only the ACTIVE traversal path as a cycle, so a repeated alias still encodes', () => {
		// The ancestor set is walk-owned now, so a caller cannot seed it. What it
		// guards is unchanged: the set unwinds after each subtree, so one node
		// reached twice through two noncyclic paths encodes both times, while a
		// back-edge to a node on the ACTIVE path abandons the whole encoding.
		const node = { a: 1 }
		expect(canonicalStringify(node)).toBe('{"a":1}')
		expect(canonicalStringify({ first: node, second: node })).toBe(
			'{"first":{"a":1},"second":{"a":1}}',
		)

		const cyclic: Record<string, unknown> = { a: 1 }
		cyclic.self = cyclic
		expect(canonicalStringify(cyclic)).toBeUndefined()
	})
})

describe('unifySchemas / inferPrimitiveEnum — un-canonicalizable members', () => {
	it('propagates a classification failure reached after the consumer record gate', () => {
		const sentinel = new Error('second prototype read')
		let reads = 0
		const schema = new Proxy({ type: 'string' } satisfies JSONSchema, {
			getPrototypeOf(target) {
				reads += 1
				if (reads === 2) throw sentinel
				return Reflect.getPrototypeOf(target)
			},
		})

		const error = captureContractError(() => unifySchemas([schema]))
		expect(reads).toBe(2)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('unifySchemas: schemas could not be read')
		expect(isContractError(error.cause)).toBe(true)
		if (!isContractError(error.cause)) throw new Error('expected the canonical stringify error')
		expect(error.cause.message).toBe('canonicalStringify: value could not be read')
	})

	it('keeps an un-canonicalizable member in the union instead of dropping it (never narrows)', () => {
		const cyclic: Record<string, unknown> = { type: 'object' }
		cyclic.self = cyclic
		const result = unifySchemas([{ type: 'string' }, cyclic, { type: 'string' }])
		// The two structurally-equal string fragments de-duplicate; the cyclic one
		// has no canonical key, so it cannot be de-duplicated or ordered — it is
		// appended in input order rather than dropped.
		expect(result.anyOf).toHaveLength(2)
		expect(result.anyOf?.[0]).toEqual({ type: 'string' })
		expect(result.anyOf?.[1]).toBe(cyclic)
	})

	it('returns the lone un-canonicalizable member directly', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(unifySchemas([cyclic])).toBe(cyclic)
	})

	it('is deterministic across repeated calls with un-canonicalizable members', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const first = unifySchemas([{ type: 'string' }, cyclic, { type: 'null' }])
		const second = unifySchemas([{ type: 'string' }, cyclic, { type: 'null' }])
		expect(first).toEqual(second)
	})

	it('never throws for a hostile enum slot and stays ineligible', () => {
		const hostile = createThrowingGetter()
		expect(() => inferPrimitiveEnum([hostile, hostile], INFER_ENUM_LIMIT)).not.toThrow()
		expect(inferPrimitiveEnum([hostile, hostile], INFER_ENUM_LIMIT)).toBeUndefined()
	})
})

describe('matchesISOInstant — direct', () => {
	it('returns true for a valid date string', () => {
		expect(matchesISOInstant('2024-01-15')).toBe(true)
	})

	it('returns false for an impossible date', () => {
		expect(matchesISOInstant('2020-13-45')).toBe(false)
	})

	it('accepts real leap dates and rejects normalized calendar overflow', () => {
		expect(matchesISOInstant('2024-02-29')).toBe(true)
		expect(matchesISOInstant('2000-02-29')).toBe(true)
		expect(matchesISOInstant('2023-02-29')).toBe(false)
		expect(matchesISOInstant('1900-02-29')).toBe(false)
		expect(matchesISOInstant('2024-04-31')).toBe(false)
		expect(matchesISOInstant('2024-02-30')).toBe(false)
		expect(matchesISOInstant('2024-02-30T00:00:00Z')).toBe(false)
	})

	it('rejects normalized hour 24 while retaining the valid clock boundary', () => {
		expect(matchesISOInstant('2024-01-15T23:59:59Z')).toBe(true)
		expect(matchesISOInstant('2024-01-15T24:00:00Z')).toBe(false)
	})

	it('accepts the complete date and offset date-time grammar', () => {
		expect(matchesISOInstant('2024-01-15')).toBe(true)
		expect(matchesISOInstant('2024-01-15T23:59:59Z')).toBe(true)
		expect(matchesISOInstant('2024-01-15T23:59:59.123Z')).toBe(true)
		expect(matchesISOInstant('2024-01-15T23:59:59+23:59')).toBe(true)
		expect(matchesISOInstant('2024-01-15T23:59:59-23:59')).toBe(true)
	})

	it('rejects incomplete clocks instead of validating only the date prefix', () => {
		expect(matchesISOInstant('2024-01-15T24:00Z')).toBe(false)
		expect(matchesISOInstant('2024-01-15T23:59Z')).toBe(false)
	})

	it('rejects space and lowercase separators instead of validating only the date prefix', () => {
		expect(matchesISOInstant('2024-01-15 24:00:00Z')).toBe(false)
		expect(matchesISOInstant('2024-01-15t24:00:00z')).toBe(false)
	})

	it('rejects a junk suffix instead of validating only the date prefix', () => {
		expect(matchesISOInstant('2024-01-15junk')).toBe(false)
		expect(matchesISOInstant('2024-01-15T00:00:00Zjunk')).toBe(false)
	})

	it('rejects complete clock and offset boundaries outside the supported range', () => {
		expect(matchesISOInstant('2024-01-15T24:00:00Z')).toBe(false)
		expect(matchesISOInstant('2024-01-15T23:60:00Z')).toBe(false)
		expect(matchesISOInstant('2024-01-15T23:59:60Z')).toBe(false)
		expect(matchesISOInstant('2024-01-15T23:59:59+24:00')).toBe(false)
		expect(matchesISOInstant('2024-01-15T23:59:59+23:60')).toBe(false)
	})

	it('is total (never throws) for a hostile string', () => {
		expect(() => matchesISOInstant(' '.repeat(1000))).not.toThrow()
	})
})

describe('samplesToSchema — enum boundary and ordering', () => {
	it('fires exactly at the INFER_ENUM_LIMIT distinct-value boundary', () => {
		const values = Array.from({ length: INFER_ENUM_LIMIT }, (_, index) => `v${index}`)
		const repeated = [...values, values[0]]
		const result = samplesToSchema(repeated, { enum: true })
		expect(result.enum).toBeDefined()
		expect(result.enum).toHaveLength(INFER_ENUM_LIMIT)
	})

	it('orders a numeric enum lexicographically by canonical string key, not ascending', () => {
		const result = samplesToSchema([2, 10, 1, 2], { enum: true })
		expect(result).toEqual({ enum: [1, 10, 2] })
	})
})

describe('samplesToSchema / valueToSchema — depth and property boundary coverage', () => {
	it('returns {} for samplesToSchema with a depth limit of 0', () => {
		expect(samplesToSchema([{ a: 1 }], { limits: { depth: 0 } })).toEqual({})
	})

	it('returns an object schema with no properties for a properties limit of 0', () => {
		const result = samplesToSchema([{ a: 1 }], { limits: { properties: 0 } })
		expect(result).toEqual({ type: 'object', additionalProperties: true })
	})

	it('threads closed: false through record samples', () => {
		const result = samplesToSchema([{ a: 1 }], { closed: false })
		expect(result.additionalProperties).toBe(true)
	})

	it('returns {} for valueToSchema with a depth limit of 0 on an object root', () => {
		expect(valueToSchema({ a: 1 }, { limits: { depth: 0 } })).toEqual({})
	})

	it('returns {} for valueToSchema with a depth limit of 0 on an array root', () => {
		expect(valueToSchema([1, 2], { limits: { depth: 0 } })).toEqual({})
	})
})

describe('samplesToSchema — nested containers and mixed sample shapes', () => {
	it('locks the actual behavior for a nested array-of-dates column: per-row arrays unify without a re-attached format', () => {
		// Each row's `dates` array is itself a sample column value, taken through
		// the walk's non-record branch — which forces `format` OFF for each row's
		// array (the multi-sample format-disabling seam applies one level down too,
		// since the unified result is `{ type: 'array', ... }`, not
		// `{ type: 'string' }`, so samplesToFormat reattachment never triggers).
		const result = samplesToSchema(
			[{ dates: ['2024-01-01', '2024-02-02'] }, { dates: ['2024-03-03'] }],
			{ format: true },
		)
		expect(result.properties?.dates).toEqual({
			type: 'array',
			items: { type: 'string' },
		})
	})

	it('unifies arrays-of-records as samples independently per row (no per-key row merge)', () => {
		// Top-level samples are arrays, not records, so the walk takes the
		// non-record branch: each row's array is classified independently as one
		// value and the results are unified with anyOf — unlike the per-key merge
		// record-shaped rows get.
		const result = samplesToSchema([[{ a: 1 }], [{ a: 2, b: 'x' }]])
		// The two rows infer distinct array schemas (different item shapes), so
		// unifySchemas wraps them as a top-level anyOf rather than merging their
		// item shapes the way the record branch merges record rows.
		expect(result.anyOf).toBeDefined()
		expect(result.anyOf).toHaveLength(2)
		for (const member of result.anyOf ?? []) {
			expect(member.type).toBe('array')
			expect(member.items?.type).toBe('object')
		}
	})

	it('combines closed / format / enum through a nested object column', () => {
		const result = samplesToSchema(
			[
				{ profile: { status: 'active' } },
				{ profile: { status: 'inactive' } },
				{ profile: { status: 'active' } },
			],
			{ closed: false, format: true, enum: true },
		)
		expect(result.properties?.profile).toEqual({
			type: 'object',
			properties: { status: { enum: ['active', 'inactive'] } },
			required: ['status'],
			additionalProperties: true,
		})
	})

	it('refuses a hostile ownKeys Proxy used as an array element', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		const singleError = captureContractError(() => valueToSchema([hostile]))
		expect(singleError.code).toBe('structure')
		expect(singleError.message).toBe('valueToSchema: value could not be read')
		const sampleError = captureContractError(() => samplesToSchema([[hostile]]))
		expect(sampleError.code).toBe('structure')
		expect(sampleError.message).toBe('samplesToSchema: samples could not be read')
	})

	it('includes an own "__proto__" key inside a heterogeneous array element via anyOf unification', () => {
		const node: unknown = JSON.parse('[{"__proto__":1,"a":2},"text"]')
		const schema = valueToSchema(node)
		const objectMember = schema.items?.anyOf?.find((member) => member.type === 'object')
		expect(objectMember?.properties).toHaveProperty('__proto__')
	})

	it('one hostile-getter row refuses the whole sample claim', () => {
		const good = { a: 1, b: 2 }
		const hostile: Record<string, unknown> = { a: 1 }
		Object.defineProperty(hostile, 'b', {
			get() {
				throw new Error('hostile getter')
			},
			enumerable: true,
			configurable: true,
		})
		const error = captureContractError(() => samplesToSchema([good, hostile]))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('samplesToSchema: samples could not be read')
	})
})

describe('composition seam — schemaToParameters(schemaToObject(samplesToSchema(...)))', () => {
	it('wraps a non-object enum root as { value: { enum: [...] } }', () => {
		const schema = samplesToSchema(['a', 'a', 'b'], { enum: true })
		const wrapped = schemaToObject(schema)
		const parameters = schemaToParameters(wrapped)
		expect(parameters).toEqual({
			type: 'object',
			properties: { value: { enum: ['a', 'b'] } },
			required: ['value'],
			additionalProperties: false,
		})
	})
})

describe('valueToSchema — Date leaf at the depth boundary under format: true', () => {
	it('infers a Date leaf when it lands exactly at the last usable depth', () => {
		const schema = valueToSchema(
			{ createdAt: new Date('2024-01-01T00:00:00Z') },
			{ limits: { depth: 1 }, format: true },
		)
		expect(schema.properties?.createdAt).toEqual({ type: 'string', format: 'date-time' })
	})

	it('emits {} for a Date leaf one level beyond the depth boundary', () => {
		const schema = valueToSchema(
			{ nested: { createdAt: new Date() } },
			{
				limits: { depth: 1 },
				format: true,
			},
		)
		expect(schema.properties?.nested).toEqual({})
	})
})

describe('samplesToFormat — single-sample unanimity', () => {
	it('classifies a single-element date list', () => {
		expect(samplesToFormat(['2024-01-01'])).toBe('date')
	})
})

describe('caller-owned inference arrays', () => {
	it('samples only a native-maximum sparse prefix without source index reads', () => {
		const fixture = createNativeMaximumSparseArray<unknown>()
		const schema = valueToSchema(fixture.value, { limits: { depth: 8, properties: 3 } })
		const fallback = valueToSchema(fixture.value, { limits: { depth: 8, properties: Infinity } })

		// A non-dense source has no JSON expression, so it widens rather than being
		// read as a list of present `undefined` leaves — and the walk still performs
		// no index read on the source.
		expect(schema).toEqual({})
		expect(fallback).toEqual({})
		expect(fixture.probes).toEqual([])

		const sparse = [1, undefined, 3]
		Reflect.deleteProperty(sparse, '1')
		expect(valueToSchema(sparse, { limits: { depth: 8, properties: 3 } })).toEqual({})
		// The dense control at the same door still samples and still unifies.
		expect(valueToSchema([1, 'x'], { limits: { depth: 8, properties: 3 } })).toEqual({
			type: 'array',
			items: { anyOf: [{ type: 'integer' }, { type: 'string' }] },
		})
	})

	it('normalizes an invalid fractional breadth through the shared fallback', () => {
		const values = [1, 'value', true, null]
		const expected = valueToSchema(values, {
			limits: { depth: INFER_DEPTH_LIMIT, properties: INFER_BREADTH_LIMIT },
		})

		// Anchored to a literal, not only to the canonical call's own answer: two
		// calls agreeing on a degenerate `{}` would satisfy an equality alone, and
		// this row is about the fractional budget being normalized rather than
		// about both budgets failing identically.
		expect(expected).toEqual({
			type: 'array',
			items: {
				anyOf: [{ type: 'boolean' }, { type: 'integer' }, { type: 'null' }, { type: 'string' }],
			},
		})
		expect(
			valueToSchema(values, { limits: { depth: INFER_DEPTH_LIMIT, properties: 2.5 } }),
		).toEqual(expected)
	})

	it('bounds an infinite direct breadth before a hostile child', () => {
		// The list is DENSE. Built with `new Array(INFER_BREADTH_LIMIT + 1)` it was
		// sparse, so both calls answered `{}` for sparseness and the hostile child
		// at the last index was never reached by either — the row compared one
		// degenerate answer with another and could not have failed if the budget
		// were ignored.
		const values: unknown[] = []
		for (let index = 0; index < INFER_BREADTH_LIMIT; index += 1) values[index] = 1
		values[INFER_BREADTH_LIMIT] = new Proxy([], {
			get() {
				throw new Error('breadth exceeded')
			},
		})
		const expected = valueToSchema(values, {
			limits: { depth: INFER_DEPTH_LIMIT, properties: INFER_BREADTH_LIMIT },
		})

		// The canonical budget stops one element short of the hostile child, so the
		// answer is a real schema rather than an abandonment.
		expect(expected).toEqual({ type: 'array', items: { type: 'integer' } })
		expect(
			valueToSchema(values, { limits: { depth: INFER_DEPTH_LIMIT, properties: Infinity } }),
		).toEqual(expected)
	})

	it('bounds an infinite direct depth before a hostile descendant', () => {
		const hostile = new Proxy([], {
			get() {
				throw new Error('depth exceeded')
			},
		})
		let values: readonly unknown[] = [hostile]
		for (let level = 0; level < INFER_DEPTH_LIMIT; level += 1) values = [values]
		const expected = valueToSchema(values, {
			limits: { depth: INFER_DEPTH_LIMIT, properties: 1 },
		})

		// The canonical budget produces a real nested schema rather than an
		// abandonment, so the equality below is about the infinite budget being
		// normalized and not about both calls giving up in the same way.
		expect(expected).not.toEqual({})
		expect(expected.type).toBe('array')
		expect(valueToSchema(values, { limits: { depth: Infinity, properties: 1 } })).toEqual(expected)
	})

	it('refuses an array whose membership is split between its own keys', () => {
		const split = new Proxy([1, 2], {
			ownKeys() {
				return ['0', 'length']
			},
			getOwnPropertyDescriptor(target, property) {
				return property === '0' ? undefined : Reflect.getOwnPropertyDescriptor(target, property)
			},
		})
		const error = captureContractError(() =>
			valueToSchema(split, { limits: { depth: 8, properties: 8 } }),
		)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it("refuses canonical indices outside an array's advertised length", () => {
		const shortened = new Proxy([1, 2], {
			get(target, property, receiver) {
				return property === 'length' ? 1 : Reflect.get(target, property, receiver)
			},
		})

		const error = captureContractError(() =>
			valueToSchema(shortened, { limits: { depth: 8, properties: 8 } }),
		)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('valueToSchema: value could not be read')
	})

	it('unifySchemas ignores caller iteration and keeps every indexed schema', () => {
		const schemas: JSONSchema[] = [{ type: 'string' }, { type: 'boolean' }]
		const substituted: JSONSchema[] = [{ type: 'string' }]
		Object.defineProperty(schemas, Symbol.iterator, {
			value: substituted[Symbol.iterator].bind(substituted),
		})

		expect(unifySchemas(schemas)).toEqual({
			anyOf: [{ type: 'boolean' }, { type: 'string' }],
		})
	})

	it('samplesToFormat ignores contradictory membership for indexed strings', () => {
		const values = new Proxy(['2024-01-01', '2024-02-02'], {
			has() {
				return false
			},
		})

		expect(samplesToFormat(values)).toBe('date')
	})

	it('inferPrimitiveEnum does not narrow away mixed indexed primitives through has', () => {
		const values = new Proxy(['a', 'a', true], {
			has() {
				return false
			},
		})

		expect(inferPrimitiveEnum(values, INFER_ENUM_LIMIT)).toBeUndefined()
	})

	it('keeps every indexed mixed sample despite contradictory membership', () => {
		const samples = new Proxy([1, true], {
			has() {
				return false
			},
		})

		expect(samplesToSchema(samples, { limits: { depth: 8, properties: 8 } })).toEqual({
			anyOf: [{ type: 'boolean' }, { type: 'integer' }],
		})
	})

	it('samplesToSchema keeps every indexed sample despite contradictory membership', () => {
		const samples = new Proxy([1, 2, 3], {
			has() {
				return false
			},
		})

		expect(samplesToSchema(samples)).toEqual({ type: 'integer' })
	})

	it('samplesToSchema ignores an iterator that hides indexed record rows', () => {
		const samples = [{ a: 1 }, { b: 'value' }]
		const substituted = [samples[0]]
		Object.defineProperty(samples, Symbol.iterator, {
			value: substituted[Symbol.iterator].bind(substituted),
		})

		expect(samplesToSchema(samples)).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' }, b: { type: 'string' } },
			additionalProperties: false,
		})
	})

	it('refuses sparse schema and record populations through their existing read boundaries', () => {
		const schemas: JSONSchema[] = []
		schemas.length = 2
		schemas[0] = { type: 'string' }
		const schemaError = captureContractError(() => unifySchemas(schemas))
		expect(schemaError.code).toBe('structure')
		expect(schemaError.message).toBe('unifySchemas: schemas could not be read')

		const rows: Array<Record<string, unknown>> = []
		rows.length = 2
		rows[0] = { value: 1 }
		const rowError = captureContractError(() =>
			samplesToSchema(rows, { limits: { depth: 8, properties: 8 } }),
		)
		expect(rowError.code).toBe('structure')
		// A HOLE is readable — every advertised read succeeded — so the refusal is
		// true but its old diagnosis was not. The guide attributes `could not be
		// read` to "a hostile getter or failed key walk"; a hole is neither.
		expect(rowError.message).toBe('samplesToSchema: samples must be a dense array')
	})

	it('performs no row read when record depth is exhausted', () => {
		let reads = 0
		const hostile = new Proxy([{ value: 1 }], {
			get() {
				reads += 1
				throw new Error('sample read')
			},
			getOwnPropertyDescriptor() {
				reads += 1
				throw new Error('sample descriptor')
			},
			has() {
				reads += 1
				throw new Error('sample membership')
			},
			ownKeys() {
				reads += 1
				throw new Error('sample keys')
			},
		})
		const samples = [{ nested: hostile }]

		// The door reads its own sample CONTAINER before the walk starts, so the
		// budget under test is the one the record branch applies to the ROWS: an
		// exhausted depth answers without touching a single row.
		expect(samplesToSchema(samples, { limits: { depth: 0, properties: 8 } })).toEqual({})
		expect(reads).toBe(0)

		// One level in, the row is read and the hostile column widens without being
		// descended into — the budget stops the walk one step short of it.
		expect(samplesToSchema(samples, { limits: { depth: 1, properties: 8 } })).toEqual({
			type: 'object',
			properties: { nested: {} },
			required: ['nested'],
			additionalProperties: false,
		})
		expect(reads).toBe(0)

		// Two levels in, the same column IS descended into and the hostile reads
		// refuse the whole call — the control that proves the rows above were
		// reachable and the budget is what stopped them.
		const error = captureContractError(() =>
			samplesToSchema(samples, { limits: { depth: 2, properties: 8 } }),
		)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('samplesToSchema: samples could not be read')
		expect(reads).toBeGreaterThan(0)
	})
})

describe('classifyFormat', () => {
	// The pattern-only classifier `stringToFormat` delegates to once a candidate
	// is inside the length bound. It was shipped public and untested.
	it('classifies each supported format', () => {
		expect(classifyFormat('123e4567-e89b-12d3-a456-426614174000')).toBe('uuid')
		expect(classifyFormat('2024-01-15T10:30:00Z')).toBe('date-time')
		expect(classifyFormat('2024-01-15T10:30:00.500+02:00')).toBe('date-time')
		expect(classifyFormat('2024-01-15')).toBe('date')
		expect(classifyFormat('10:30:00Z')).toBe('time')
		expect(classifyFormat('ada@example.com')).toBe('email')
		expect(classifyFormat('https://example.com/a')).toBe('uri')
	})

	it('answers undefined for text that matches no format', () => {
		expect(classifyFormat('')).toBeUndefined()
		expect(classifyFormat('plain text')).toBeUndefined()
		expect(classifyFormat('123e4567-e89b-12d3-a456')).toBeUndefined()
	})

	it('rejects a well-formed but calendar-invalid instant', () => {
		expect(classifyFormat('2024-02-31')).toBeUndefined()
		expect(classifyFormat('2024-13-01T00:00:00Z')).toBeUndefined()
	})

	it('agrees with stringToFormat inside the length bound', () => {
		const samples = ['2024-01-15', 'ada@example.com', 'https://example.com/a', 'plain']
		for (const sample of samples) {
			expect(classifyFormat(sample)).toBe(stringToFormat(sample))
		}
	})
})

describe('inference publishes its own answer under a lying publication walk', () => {
	// Every emitted schema is ordered and assembled through array operations the
	// caller can rewrite. A `sort` that empties its receiver TRUNCATED a published
	// schema and a substituted `map` replaced one wholesale, both silently.
	function emptySort(this: unknown[]): unknown[] {
		this.length = 0
		return this
	}

	it('valueToSchema publishes every property while Array.prototype.sort empties', () => {
		const published = replaceIntrinsic(Array.prototype, 'sort', emptySort, () =>
			valueToSchema({ b: 1, a: 2 }),
		)

		expect(published).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' }, b: { type: 'integer' } },
			required: ['a', 'b'],
			additionalProperties: false,
		})
	})

	it('valueToSchema publishes its own items while Array.prototype.map lies', () => {
		const lie = (): readonly string[] => ['INJECTED']
		const published = replaceIntrinsic(Array.prototype, 'map', lie, () =>
			valueToSchema({ a: [1, 2] }),
		)

		expect(JSON.stringify(published)).not.toContain('INJECTED')
	})

	it('samplesToSchema publishes every sampled key while Array.prototype.sort empties', () => {
		const published = replaceIntrinsic(Array.prototype, 'sort', emptySort, () =>
			samplesToSchema([
				{ b: 1, a: 2 },
				{ b: 3, a: 4 },
			]),
		)

		expect(JSON.stringify(published)).toContain('"a"')
		expect(JSON.stringify(published)).toContain('"b"')
	})

	it('unifySchemas publishes its own members while Array.prototype.sort empties', () => {
		const published = replaceIntrinsic(Array.prototype, 'sort', emptySort, () =>
			unifySchemas([{ type: 'string' }, { type: 'boolean' }]),
		)

		expect(published).toEqual({ anyOf: [{ type: 'boolean' }, { type: 'string' }] })
	})

	it('canonicalStringify publishes a marker-free key while the array iterator injects', () => {
		function* injectLeading(this: readonly unknown[]): Generator<unknown> {
			yield 'INJECTED'
			for (let index = 0; index < this.length; index += 1) yield this[index]
		}
		const published = replaceIntrinsic(Array.prototype, Symbol.iterator, injectLeading, () =>
			attempt(() => canonicalStringify({ a: [1, 2] })),
		)

		expect(published.success).toBe(true)
		expect(published.success ? String(published.value) : '').not.toContain('INJECTED')
	})

	it('inferPrimitiveEnum publishes its own vocabulary while Set.prototype.has answers true', () => {
		const answerTrue = (): boolean => true
		const published = replaceIntrinsic(Set.prototype, 'has', answerTrue, () =>
			inferPrimitiveEnum(['b', 'a', 'b'], INFER_ENUM_LIMIT),
		)

		expect(published).toEqual({ enum: ['a', 'b'] })
	})
})

describe('samplesToSchema — bounded work on shared references (H9, H10-B)', () => {
	// MEMBERSHIP RULE of the instrument below: a slot whose collected values are
	// MORE THAN ONE row. The H9 instrument drew every case from `owned.length ===
	// 1`, which was exactly the population its own fix handled, so it certified a
	// memo that covered one row and missed every multi-row slot — the shape this
	// door exists for. Each case here is drawn from OUTSIDE that population, and
	// the one-row case is kept only as the inside-the-population control.
	it('reads a shared leaf a bounded number of times for a MULTI-ROW slot', () => {
		// Red before green: `samplesToSchema([{id:1,detail:c},{id:2,detail:c}])` over
		// an 18-level shared-child DAG took 6.5 s and read the shared leaf 32,768
		// times at 14 levels, because the memo keyed only the one-row slot.
		let reads = 0
		const leaf: Record<string, unknown> = {}
		Object.defineProperty(leaf, 'v', {
			enumerable: true,
			get() {
				reads += 1
				return 1
			},
		})
		let node: unknown = leaf
		for (let index = 0; index < 18; index += 1) node = { a: node, b: node }

		// Outside the fixed population, case 1: two DISTINCT rows sharing one child.
		const started = Date.now()
		const distinct = samplesToSchema([
			{ id: 1, detail: node },
			{ id: 2, detail: node },
		])
		const elapsed = Date.now() - started

		expect(reads).toBeLessThanOrEqual(INFER_DEPTH_LIMIT)
		expect(elapsed).toBeLessThan(1_000)
		expect(distinct.type).toBe('object')

		// Outside the fixed population, case 2: the same row repeated.
		reads = 0
		expect(samplesToSchema([node, node]).type).toBe('object')
		expect(reads).toBeLessThanOrEqual(INFER_DEPTH_LIMIT)

		// Outside the fixed population, case 3: rows whose per-key value LISTS
		// differ at every level, so no slot is ever a repeated single object. This
		// is the case a first-row-only memo would still miss.
		let left: Record<string, unknown> = { leaf: 1 }
		let right: Record<string, unknown> = { leaf: 2 }
		for (let index = 0; index < 16; index += 1) {
			const nextLeft = { a: left, b: right }
			const nextRight = { a: right, b: left }
			left = nextLeft
			right = nextRight
		}
		const swapped = Date.now()
		expect(samplesToSchema([left, right]).type).toBe('object')
		expect(Date.now() - swapped).toBeLessThan(1_000)

		// Inside the population, kept as the control the H9 round had: one row.
		reads = 0
		expect(samplesToSchema([node]).type).toBe('object')
		expect(reads).toBeLessThanOrEqual(INFER_DEPTH_LIMIT)

		// The negative control the counter needs: the same instrument reports the
		// LINEAR sibling truthfully, so it discriminates a bounded walk from an
		// unbounded one rather than failing uniformly.
		reads = 0
		valueToSchema(node)
		expect(reads).toBe(1)
	})

	it('serves no answer across a differing budget or flag from one walk to the next', () => {
		// The memo used to key `(row, remaining depth)` only, so two calls over one
		// memo disagreed: `closed: true` then `closed: false` returned the FIRST
		// call's `additionalProperties: false`. The memo is walk-owned now, so the
		// claim is asked of the door: one row, four budget-and-flag combinations,
		// four answers that each match a fresh walk's.
		const row = { a: 1, b: 2 }
		const closed = samplesToSchema([row], { limits: { properties: 256 } })
		const open = samplesToSchema([row], { limits: { properties: 256 }, closed: false })
		const narrow = samplesToSchema([row], { limits: { properties: 1 }, closed: false })

		expect(closed).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' }, b: { type: 'integer' } },
			required: ['a', 'b'],
			additionalProperties: false,
		})
		expect(open.additionalProperties).toBe(true)
		expect(narrow).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' } },
			required: ['a'],
			additionalProperties: true,
		})
	})

	it('terminates on a self-referencing row in bounded time', () => {
		const row: Record<string, unknown> = {}
		row.a = row
		row.b = row

		const started = Date.now()
		const schema = samplesToSchema([row])
		expect(Date.now() - started).toBeLessThan(1_000)
		expect(schema.type).toBe('object')

		// Outside the one-row population: the same cycle reached as a multi-row slot.
		const pair = Date.now()
		expect(samplesToSchema([row, row]).type).toBe('object')
		expect(
			samplesToSchema([
				{ id: 1, r: row },
				{ id: 2, r: row },
			]).type,
		).toBe('object')
		expect(Date.now() - pair).toBeLessThan(1_000)
	})

	it('keeps a column two rows carry when one row holds undefined', () => {
		// The key was skipped entirely, discarding a property two of three rows
		// carried as a real integer. Both the TSDoc and the guide promise only that
		// the schema OPENS.
		expect(
			samplesToSchema([
				{ a: 1, b: 2 },
				{ a: 2, b: undefined },
				{ a: 3, b: 4 },
			]),
		).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' }, b: { type: 'integer' } },
			required: ['a'],
			additionalProperties: true,
		})
	})

	it('sanitizes a NaN breadth budget instead of emitting a schema that rejects its own source', () => {
		// `limitEntries(keys, NaN)` returned the EMPTY key list while
		// `allKeys.length > NaN` left `truncated` false, so these doors emitted
		// `{ type: 'object', additionalProperties: false }` — the one direction the
		// schema-inversion law forbids.
		const source = { a: 1, b: 2 }
		const expected: JSONSchema = {
			type: 'object',
			properties: { a: { type: 'integer' }, b: { type: 'integer' } },
			required: ['a', 'b'],
			additionalProperties: false,
		}

		const budget = { limits: { depth: 32, properties: Number.NaN } }
		expect(samplesToSchema([source], budget)).toEqual(expected)
		expect(valueToSchema(source, budget)).toEqual(expected)
		expect(compileGuard(schemaToShape(samplesToSchema([source], budget)))(source)).toBe(true)

		// Control: a valid budget is used verbatim, so sanitization did not simply
		// discard the caller's number.
		expect(samplesToSchema([source], { limits: { depth: 32, properties: 1 } })).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' } },
			required: ['a'],
			additionalProperties: true,
		})
	})

	it('refuses a sparse sample list with an honest diagnosis', () => {
		// A hole is READABLE — every advertised read succeeds, and `valueToSchema`
		// answers for it — so `samples could not be read` was a true refusal with a
		// false reason. `samplesToSchema` requires density of its SAMPLE LIST;
		// `valueToSchema` widens a sparse VALUE, and neither reads a hole as a
		// present member.
		const sparse = buildSparseArray()
		const error = captureContractError(() => samplesToSchema(sparse))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('samplesToSchema: samples must be a dense array')
		expect(valueToSchema(sparse)).toEqual({})

		// Control: a genuinely unreadable sample list still reports unreadability.
		const unreadable = captureContractError(() => samplesToSchema(createRevokedArrayProxy()))
		expect(unreadable.message).toBe('samplesToSchema: samples could not be read')
	})
})
