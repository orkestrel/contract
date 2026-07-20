import { describe, expect, it } from 'vitest'
import {
	compileSchema,
	integerShape,
	INFER_BREADTH_LIMIT,
	INFER_DEPTH_LIMIT,
	INFER_ENUM_LIMIT,
	literalShape,
	objectShape,
	samplesToFormat,
	samplesToSchema,
	schemaToParameters,
	stringShape,
	stringToFormat,
	valueToSchema,
} from '@src/core'

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

	it('widens non-finite numbers to number', () => {
		expect(valueToSchema(Number.NaN)).toEqual({ type: 'number' })
		expect(valueToSchema(Number.POSITIVE_INFINITY)).toEqual({ type: 'number' })
		expect(valueToSchema(Number.NEGATIVE_INFINITY)).toEqual({ type: 'number' })
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

	it('infers properties/required/additionalProperties, matching compileSchema round-trip parity', () => {
		const shape = objectShape({
			age: integerShape(),
			name: stringShape(),
		})
		const expected = compileSchema(shape)
		const inferred = valueToSchema({ name: 'Ada', age: 36 })
		expect(inferred).toEqual(expected)
	})

	it('treats an undefined-valued property as absent', () => {
		const inferred = valueToSchema({ a: 1, b: undefined })
		expect(inferred).toEqual({
			type: 'object',
			properties: { a: { type: 'integer' } },
			required: ['a'],
			additionalProperties: false,
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

	it('is total when Object.keys throws (hostile ownKeys trap)', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		expect(() => valueToSchema(hostile)).not.toThrow()
		const schema = valueToSchema(hostile)
		expect(typeof schema).toBe('object')
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
		const shallow = valueToSchema(current, { maxDepth: 1 })
		expect(shallow).toEqual({
			type: 'object',
			properties: { child: {} },
			required: ['child'],
			additionalProperties: false,
		})
	})

	it('caps sampled object properties at maxProperties', () => {
		const wide: Record<string, unknown> = { a: 1, b: 2, c: 3, d: 4 }
		const capped = valueToSchema(wide, { maxProperties: 2 })
		expect(Object.keys(capped.properties ?? {})).toHaveLength(2)
		expect(Object.keys(capped.properties ?? {})).toEqual(['a', 'b'])
	})

	it('caps sampled array elements at maxProperties', () => {
		const wide = valueToSchema([1, 'x', true, 3.5], { maxProperties: 2 })
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

	it('is total when a sample row throws on key enumeration (hostile ownKeys trap)', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		expect(() => samplesToSchema([hostile])).not.toThrow()
		const schema = samplesToSchema([hostile])
		expect(schema.type).toBe('object')
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

	it('matches a time', () => {
		expect(stringToFormat('10:30:00')).toBe('time')
		expect(stringToFormat('10:30:00Z')).toBe('time')
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
		expect(samplesToSchema([1, 1, Number.NaN], { enum: true })).toEqual({ type: 'number' })
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
	it('is total when Object.keys throws (hostile ownKeys trap), format enabled', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		expect(() => valueToSchema(hostile, { format: true })).not.toThrow()
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
	it('is total when a sample row throws on key enumeration (hostile ownKeys trap)', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		expect(() => samplesToSchema([hostile], { enum: true, format: true })).not.toThrow()
	})

	it('terminates on a cyclic sample row with enum/format enabled', () => {
		const row: Record<string, unknown> = { name: 'root' }
		row.self = row
		expect(() => samplesToSchema([row], { enum: true, format: true })).not.toThrow()
	})
})
