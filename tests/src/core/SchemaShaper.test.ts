// `SchemaShaper` is interned: it carries no barrel row, `tests/guides.test.ts` names it
// in `INTERNAL`, and this suite therefore reaches the class by relative source path.
// `schemaToShape` is the only door that constructs it, and that door stamps its own
// name onto every refusal, so the walk's raw readings are reachable from here alone.
import type { ContractShape, JSONSchema } from '@src/core'
import { attempt, isContractError, isError, schemaToShape } from '@src/core'
import { describe, expect, it } from 'vitest'
import { captureContractError } from '../../setup.js'
import { SchemaShaper } from '../../../src/core/SchemaShaper.js'

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
