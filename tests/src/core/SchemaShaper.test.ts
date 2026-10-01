// `SchemaShaper` is interned: it carries no barrel row, `tests/guides.test.ts` names it
// in `INTERNAL`, and this suite therefore reaches the class by relative source path.
// `schemaToShape` is the only door that constructs it, and that door stamps its own
// name onto every refusal, so the walk's raw readings are reachable from here alone.
import type { ContractShape, JSONSchema } from '@src/core'
import {
	attempt,
	compileGuard,
	compileSchema,
	INFER_BREADTH_LIMIT,
	INFER_DEPTH_LIMIT,
	isContractError,
	isError,
	JSON_SCHEMA_TYPES,
	schemaToShape,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import { captureContractError } from '../../setup.js'
import { SchemaShaper } from '../../../src/core/SchemaShaper.js'

describe('SchemaShaper — type arrays', () => {
	it('accepts array and string edits and refuses numeric edits', () => {
		const schema: Record<string, unknown> = {
			type: 'object',
			properties: { edits: { type: ['array', 'string'], items: { type: 'string' } } },
			required: ['edits'],
		}
		const guard = compileGuard(schemaToShape(schema))
		expect(guard({ edits: ['replace'] })).toBe(true)
		expect(guard({ edits: 'replace' })).toBe(true)
		expect(guard({ edits: 3 })).toBe(false)
		expect(guard({ edits: [3] })).toBe(false)
	})

	it.each(JSON_SCHEMA_TYPES)('converts a singleton %s like its bare name', (type) => {
		const schema: Record<string, unknown> = {
			type: [type],
			items: { type: 'string' },
			properties: { title: { type: 'string' } },
			required: ['title'],
			additionalProperties: false,
			minLength: 1,
			maxLength: 3,
			minItems: 1,
			maxItems: 2,
			minimum: 1,
			maximum: 3,
			description: 'bounded member',
		}
		expect(schemaToShape(schema)).toEqual(schemaToShape({ ...schema, type }))
	})

	it.each([
		{ label: 'empty', type: [] },
		{ label: 'unrecognized', type: ['unknown'] },
		{ label: 'mixed', type: ['string', 'unknown'] },
		{ label: 'unknown first', type: ['unknown', 'string'] },
		{ label: 'non-string member', type: ['string', 3] },
		{ label: 'undefined member', type: Array.from({ length: 1 }) },
	])('widens a $label type array even with properties', ({ type }) => {
		const schema: Record<string, unknown> = {
			type,
			properties: { title: { type: 'string' } },
			description: 'unexpressible',
		}
		const shape = schemaToShape(schema)
		expect(shape).toEqual({ category: 'raw', schema: { description: 'unexpressible' } })
		expect(compileGuard(shape)(3)).toBe(true)
	})

	it('keeps items, bounds, and description on each member', () => {
		const schema: Record<string, unknown> = {
			type: ['array', 'string', 'number'],
			items: { type: 'string', minLength: 2 },
			minItems: 1,
			maxItems: 2,
			minLength: 2,
			maxLength: 3,
			minimum: 4,
			maximum: 5,
			description: 'bounded alternatives',
		}
		const shape = schemaToShape(schema)
		const guard = compileGuard(shape)
		for (const value of [['ab'], ['ab', 'cd'], 'ab', 'abc', 4, 5]) {
			expect(guard(value)).toBe(true)
		}
		for (const value of [[], ['a'], [3], ['ab', 'cd', 'ef'], 'a', 'abcd', 3, 6, null]) {
			expect(guard(value)).toBe(false)
		}
		expect(compileSchema(shape)).toEqual({
			description: 'bounded alternatives',
			anyOf: [
				{
					type: 'array',
					items: { type: 'string', minLength: 2 },
					minItems: 1,
					maxItems: 2,
					description: 'bounded alternatives',
				},
				{ type: 'string', minLength: 2, maxLength: 3, description: 'bounded alternatives' },
				{ type: 'number', minimum: 4, maximum: 5, description: 'bounded alternatives' },
			],
		})
	})

	it('keeps object properties, required names, and closed extras', () => {
		const schema: Record<string, unknown> = {
			type: ['object', 'null'],
			properties: { title: { type: 'string' } },
			required: ['title'],
			additionalProperties: false,
		}
		const guard = compileGuard(schemaToShape(schema))
		expect(guard(null)).toBe(true)
		expect(guard({ title: 'draft' })).toBe(true)
		expect(guard({})).toBe(false)
		expect(guard({ title: 3 })).toBe(false)
		expect(guard({ title: 'draft', extra: true })).toBe(false)
	})

	it('deduplicates before the breadth limit and uses inclusive union semantics', () => {
		const schema: Record<string, unknown> = {
			type: [...Array.from({ length: INFER_BREADTH_LIMIT + 1 }, () => 'integer'), 'number'],
		}
		const shape = schemaToShape(schema)
		expect(compileSchema(shape)).toEqual({ anyOf: [{ type: 'integer' }, { type: 'number' }] })
		const guard = compileGuard(shape)
		expect(guard(1)).toBe(true)
		expect(guard(1.5)).toBe(true)
		expect(guard('1')).toBe(false)
		const repeated: Record<string, unknown> = { type: ['string', 'string'] }
		expect(schemaToShape(repeated)).toEqual(schemaToShape({ type: 'string' }))
	})

	it.each([{ enum: ['chosen'] }, { oneOf: [{ type: 'string' }] }, { anyOf: [{ type: 'string' }] }])(
		'keeps earlier keyword precedence for %j',
		(keywords) => {
			const schema: Record<string, unknown> = { ...keywords, type: ['number', 'boolean'] }
			const guard = compileGuard(schemaToShape(schema))
			expect(guard('chosen')).toBe(true)
			expect(guard(3)).toBe(false)
			expect(guard(true)).toBe(false)
		},
	)

	it('does not spend structural depth on a singleton type array', () => {
		let schema: Record<string, unknown> = { type: ['array'], items: { type: 'string' } }
		let bare: JSONSchema = { type: 'array', items: { type: 'string' } }
		for (let depth = 0; depth < INFER_DEPTH_LIMIT - 2; depth += 1) {
			schema = { type: 'array', items: schema }
			bare = { type: 'array', items: bare }
		}
		expect(schemaToShape(schema)).toEqual(schemaToShape(bare))
	})

	it('widens a cycle through a type-array member', () => {
		const schema: Record<string, unknown> = { type: ['array', 'string'] }
		schema['items'] = schema
		expect(compileSchema(schemaToShape(schema))).toEqual({
			anyOf: [{ type: 'array', items: {} }, { type: 'string' }],
		})
	})
})

describe('SchemaShaper — a shared node', () => {
	it('converts a node two branches share exactly once', () => {
		const shared: JSONSchema = { type: 'string', minLength: 1 }
		const shape = new SchemaShaper({
			type: 'object',
			properties: { first: shared, second: shared },
			required: ['first', 'second'],
		}).shape()

		expect(shape.category).toBe('object')
		if (shape.category !== 'object') throw new Error('expected an object shape')
		const first = shape.properties['first']
		const second = shape.properties['second']
		expect(first).toEqual({ category: 'string', min: 1 })
		// The memo is keyed by node and remaining depth, so the second branch is
		// served the first branch's shape rather than a re-converted equal one.
		expect(second).toBe(first)
	})

	it('re-converts the same node at a different remaining depth', () => {
		const shared: JSONSchema = { type: 'string', minLength: 1 }
		const shape = new SchemaShaper({
			type: 'object',
			properties: {
				shallow: shared,
				deep: { type: 'object', properties: { inner: shared }, required: ['inner'] },
			},
			required: ['shallow', 'deep'],
		}).shape()

		if (shape.category !== 'object') throw new Error('expected an object shape')
		const shallow = shape.properties['shallow']
		const deep = shape.properties['deep']
		if (deep === undefined || deep.category !== 'object') {
			throw new Error('expected a nested object shape')
		}
		const inner = deep.properties['inner']
		expect(inner).toEqual(shallow)
		// Remaining depth is part of the memo key, so the two readings of one node
		// are equal values rather than one shared value.
		expect(inner).not.toBe(shallow)
	})
})

describe('SchemaShaper — a cyclic schema', () => {
	it('widens the re-encountered node instead of recursing into it', () => {
		const cyclic: Record<string, unknown> = { type: 'object', properties: {} }
		const properties: Record<string, unknown> = { self: cyclic }
		cyclic['properties'] = properties
		const outcome = attempt(() => new SchemaShaper(cyclic).shape())

		expect(outcome.success).toBe(true)
		if (!outcome.success) throw new Error('expected the cycle to widen rather than throw')
		const shape: ContractShape = outcome.value
		if (shape.category !== 'object') throw new Error('expected an object shape')
		const self = shape.properties['self']
		// `required` is absent, so the property is optional; the ancestor set turns the
		// second encounter into the accept-anything raw shape.
		if (self === undefined || self.category !== 'optional') {
			throw new Error('expected an optional property shape')
		}
		expect(self.inner).toEqual({ category: 'raw', schema: {} })
	})
})

describe('SchemaShaper — an unreadable keyword', () => {
	it('lets the read failure escape the walk carrying no door name of its own', () => {
		const hostile: JSONSchema = { type: 'object' }
		Object.defineProperty(hostile, 'properties', {
			get(): never {
				throw new Error('keyword read refused')
			},
			enumerable: true,
			configurable: true,
		})

		const outcome = attempt(() => new SchemaShaper(hostile).shape())

		expect(outcome.success).toBe(false)
		if (outcome.success) throw new Error('expected the hostile keyword to refuse')
		expect(isError(outcome.error)).toBe(true)
		if (!isError(outcome.error)) throw new Error('expected an Error')
		expect(outcome.error.message).toBe('keyword read refused')
		// The walk publishes no name of its own; the door is what names the refusal.
		expect(isContractError(outcome.error)).toBe(false)

		const published = captureContractError(() => schemaToShape(hostile))
		expect(published.message.startsWith('schemaToShape:')).toBe(true)
	})
})
