import { describe, expect, it } from 'vitest'
import {
	canonicalStringify,
	compileSchema,
	integerShape,
	INFER_BREADTH_LIMIT,
	INFER_DEPTH_LIMIT,
	INFER_ENUM_LIMIT,
	isValidISOInstant,
	literalShape,
	objectShape,
	samplesToFormat,
	samplesToSchema,
	schemaToObject,
	schemaToParameters,
	stringShape,
	stringToFormat,
	unifySchemas,
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

describe('inferArray — hostile own-getter / Proxy-over-array totality (C1)', () => {
	it('does not throw when a throwing own-getter sits at array index 0', () => {
		const hostile: unknown[] = [1, 2, 3]
		Object.defineProperty(hostile, 0, {
			get() {
				throw new Error('hostile getter')
			},
			enumerable: true,
			configurable: true,
		})
		expect(() => valueToSchema(hostile)).not.toThrow()
		expect(valueToSchema(hostile)).toEqual({ type: 'array' })
	})

	it('does not throw for a Proxy-over-array (isArray === Array.isArray)', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				if (property === '0') throw new Error('hostile proxy element')
				return Reflect.get(target, property, receiver)
			},
		})
		expect(() => valueToSchema(hostile)).not.toThrow()
		expect(valueToSchema(hostile)).toEqual({ type: 'array' })
	})

	it('does not throw for a hostile element nested inside an array of arrays', () => {
		const inner: unknown[] = [1]
		Object.defineProperty(inner, 0, {
			get() {
				throw new Error('hostile nested getter')
			},
			enumerable: true,
			configurable: true,
		})
		const outer = [inner]
		expect(() => valueToSchema(outer)).not.toThrow()
	})

	it('does not throw for a hostile array element with format: true', () => {
		const hostile: unknown[] = [1]
		Object.defineProperty(hostile, 0, {
			get() {
				throw new Error('hostile getter')
			},
			enumerable: true,
			configurable: true,
		})
		expect(() => valueToSchema(hostile, { format: true })).not.toThrow()
		expect(valueToSchema(hostile, { format: true })).toEqual({ type: 'array' })
	})

	it('does not throw for a hostile array element via samplesToSchema', () => {
		const hostile: unknown[] = [1]
		Object.defineProperty(hostile, 0, {
			get() {
				throw new Error('hostile getter')
			},
			enumerable: true,
			configurable: true,
		})
		expect(() => samplesToSchema([hostile])).not.toThrow()
	})

	it('does not throw for a Proxy-over-array whose `length` getter is hostile', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				if (property === 'length') throw new Error('hostile')
				return Reflect.get(target, property, receiver)
			},
		})
		expect(() => valueToSchema(hostile)).not.toThrow()
		expect(valueToSchema(hostile)).toEqual({ type: 'array' })
	})

	it('does not throw for a hostile-`length` Proxy-over-array nested as an object property', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				if (property === 'length') throw new Error('hostile')
				return Reflect.get(target, property, receiver)
			},
		})
		expect(() => valueToSchema({ items: hostile })).not.toThrow()
	})

	it('does not throw for a hostile-`length` Proxy-over-array nested as an outer array element', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				if (property === 'length') throw new Error('hostile')
				return Reflect.get(target, property, receiver)
			},
		})
		expect(() => valueToSchema([hostile])).not.toThrow()
	})
})

describe('valueToSchema / samplesToSchema — option sanitization (C2)', () => {
	it('does not hang on a 40000-deep array chain with a valid budget', () => {
		let current: unknown = 'leaf'
		for (let level = 0; level < 40000; level += 1) current = [current]
		expect(() => valueToSchema(current)).not.toThrow()
	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, 1e9, -1, 2.5])(
		'never hangs or throws for a hostile maxDepth of %s',
		(maxDepth) => {
			let current: unknown = 'leaf'
			for (let level = 0; level < 500; level += 1) current = { child: current }
			expect(() => valueToSchema(current, { maxDepth })).not.toThrow()
		},
	)

	it.each([Number.NaN, -1, -5])(
		'keeps properties/required in sync under a hostile maxProperties of %s (no dropped-required leak)',
		(maxProperties) => {
			const wide: Record<string, unknown> = { a: 1, b: 2, c: 3, d: 4, e: 5 }
			const schema = valueToSchema(wide, { maxProperties })
			expect(Object.keys(schema.properties ?? {}).sort()).toEqual(
				[...(schema.required ?? [])].sort(),
			)
		},
	)

	it('a negative maxProperties never drops the last sorted key (sanitized back to the default budget)', () => {
		const wide: Record<string, unknown> = { a: 1, b: 2, c: 3, d: 4, e: 5 }
		const schema = valueToSchema(wide, { maxProperties: -5 })
		// -5 sanitizes to INFER_BREADTH_LIMIT (no truncation for 5 keys), so
		// every key survives and the schema stays closed — the pre-fix bug was
		// slice(0, -5) silently dropping the last sorted keys.
		expect(Object.keys(schema.properties ?? {}).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
		expect(schema.additionalProperties).toBe(false)
	})

	it('falls back to INFER_DEPTH_LIMIT / INFER_BREADTH_LIMIT for a hostile budget (sanitizeBudget)', () => {
		const shallow = valueToSchema({ a: { b: { c: 1 } } }, { maxDepth: Number.NaN })
		const withDefault = valueToSchema({ a: { b: { c: 1 } } })
		expect(shallow).toEqual(withDefault)
	})
})

describe('valueToSchema — truncation opens the schema (C3)', () => {
	it('does not close additionalProperties when maxProperties truncates the key list', () => {
		const schema = valueToSchema({ a: 1, b: 2, c: 3, d: 4 }, { maxProperties: 2 })
		expect(schema.additionalProperties).not.toBe(false)
		expect(schema.additionalProperties).toBe(true)
		const properties = Object.keys(schema.properties ?? {})
		for (const key of schema.required ?? []) {
			expect(properties).toContain(key)
		}
	})

	it('keeps additionalProperties: false when the object is NOT truncated', () => {
		const schema = valueToSchema({ a: 1, b: 2 }, { maxProperties: 2 })
		expect(schema.additionalProperties).toBe(false)
	})
})

describe('samplesToSchema — truncation opens the schema for record samples (C3)', () => {
	it('does not close additionalProperties when the sample key union is truncated', () => {
		const schema = samplesToSchema([{ a: 1, b: 2, c: 3, d: 4 }], { maxProperties: 2 })
		expect(schema.additionalProperties).not.toBe(false)
		expect(schema.additionalProperties).toBe(true)
		const properties = Object.keys(schema.properties ?? {})
		for (const key of schema.required ?? []) {
			expect(properties).toContain(key)
		}
	})

	it('keeps additionalProperties: false when the sample key union is NOT truncated', () => {
		const schema = samplesToSchema([{ a: 1 }, { b: 2 }], { maxProperties: 2 })
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

describe('valueToSchema — sparse arrays (C7)', () => {
	it('emits a valid items schema (no undefined/null anyOf member) for a sparse array', () => {
		const sparse = [1, undefined, 3]
		delete sparse[1]
		const schema = valueToSchema(sparse)
		expect(schema).toEqual({
			type: 'array',
			items: { anyOf: [{ type: 'integer' }, {}] },
		})
	})
})

describe('unifySchemas — direct', () => {
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
})

describe('canonicalStringify — direct', () => {
	it('sorts nested object keys recursively at every level', () => {
		const value = { b: { d: 1, c: 2 }, a: 1 }
		expect(canonicalStringify(value)).toBe('{"a":1,"b":{"c":2,"d":1}}')
	})

	it('preserves array element order', () => {
		expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]')
	})

	it('renders NaN as null (JSON.stringify semantics)', () => {
		expect(canonicalStringify(Number.NaN)).toBe('null')
	})
})

describe('isValidISOInstant — direct', () => {
	it('returns true for a valid date string', () => {
		expect(isValidISOInstant('2024-01-15')).toBe(true)
	})

	it('returns false for an impossible date', () => {
		expect(isValidISOInstant('2020-13-45')).toBe(false)
	})

	it('is total (never throws) for a hostile string', () => {
		expect(() => isValidISOInstant(' '.repeat(1000))).not.toThrow()
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
	it('returns {} for samplesToSchema with maxDepth: 0', () => {
		expect(samplesToSchema([{ a: 1 }], { maxDepth: 0 })).toEqual({})
	})

	it('returns an object schema with no properties for maxProperties: 0', () => {
		const result = samplesToSchema([{ a: 1 }], { maxProperties: 0 })
		expect(result).toEqual({ type: 'object', additionalProperties: true })
	})

	it('threads closed: false through record samples', () => {
		const result = samplesToSchema([{ a: 1 }], { closed: false })
		expect(result.additionalProperties).toBe(true)
	})

	it('returns {} for valueToSchema with maxDepth: 0 on an object root', () => {
		expect(valueToSchema({ a: 1 }, { maxDepth: 0 })).toEqual({})
	})

	it('returns {} for valueToSchema with maxDepth: 0 on an array root', () => {
		expect(valueToSchema([1, 2], { maxDepth: 0 })).toEqual({})
	})
})

describe('samplesToSchema — nested containers and mixed sample shapes', () => {
	it('locks the actual behavior for a nested array-of-dates column: per-row arrays unify without a re-attached format', () => {
		// Each row's `dates` array is itself a sample column value, inferred via
		// inferSamples' non-record branch — which forces `format` OFF for each
		// row's array (the multi-sample format-disabling seam applies one level
		// down too, since the unified result is `{ type: 'array', ... }`, not
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
		// Top-level samples are arrays, not records, so inferSamples takes the
		// non-record branch: each row's array is classified independently via
		// inferValue and the results are unified with anyOf — unlike
		// inferRecordSamples' per-key merge for record-shaped rows.
		const result = samplesToSchema([[{ a: 1 }], [{ a: 2, b: 'x' }]])
		// The two rows infer distinct array schemas (different item shapes), so
		// unifySchemas wraps them as a top-level anyOf rather than merging their
		// item shapes the way inferRecordSamples merges record rows.
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

	it('is total for a hostile ownKeys Proxy used as an array element', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		expect(() => valueToSchema([hostile])).not.toThrow()
		expect(() => samplesToSchema([[hostile]])).not.toThrow()
	})

	it('includes an own "__proto__" key inside a heterogeneous array element via anyOf unification', () => {
		const node: unknown = JSON.parse('[{"__proto__":1,"a":2},"text"]')
		const schema = valueToSchema(node)
		const objectMember = schema.items?.anyOf?.find((member) => member.type === 'object')
		expect(objectMember?.properties).toHaveProperty('__proto__')
	})

	it('one hostile-getter row drops that key for ALL rows (all-or-nothing scope)', () => {
		const good = { a: 1, b: 2 }
		const hostile: Record<string, unknown> = { a: 1 }
		Object.defineProperty(hostile, 'b', {
			get() {
				throw new Error('hostile getter')
			},
			enumerable: true,
			configurable: true,
		})
		const schema = samplesToSchema([good, hostile])
		expect(schema.properties).toHaveProperty('a')
		expect(schema.properties).not.toHaveProperty('b')
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
			{ maxDepth: 1, format: true },
		)
		expect(schema.properties?.createdAt).toEqual({ type: 'string', format: 'date-time' })
	})

	it('emits {} for a Date leaf one level beyond the depth boundary', () => {
		const schema = valueToSchema(
			{ nested: { createdAt: new Date() } },
			{
				maxDepth: 1,
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
