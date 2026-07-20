import { describe, expect, it } from 'vitest'
import {
	compileSchema,
	integerShape,
	INFER_BREADTH_LIMIT,
	INFER_DEPTH_LIMIT,
	objectShape,
	samplesToSchema,
	schemaToParameters,
	stringShape,
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

	it('infers {} for non-plain objects (Date, Map, Set)', () => {
		expect(valueToSchema(new Date())).toEqual({})
		expect(valueToSchema(new Map())).toEqual({})
		expect(valueToSchema(new Set())).toEqual({})
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
