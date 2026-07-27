import type { ContractShape, JSONSchema } from '@src/core'
import {
	arrayShape,
	cloneSchema,
	cloneShape,
	objectShape,
	stringShape,
	unionShape,
} from '@src/core'
import { describe, expect, it } from 'vitest'

describe('cloneSchema', () => {
	it('deep-clones and freezes a nested schema without touching the source', () => {
		const leaf: JSONSchema = { type: 'string', description: 'source' }
		const items: JSONSchema = { type: 'array', items: leaf }
		const properties: Record<string, JSONSchema> = { values: items }
		const source: JSONSchema = { type: 'object', properties }
		const clone = cloneSchema(source)

		expect(clone).toEqual(source)
		expect(clone).not.toBe(source)
		expect(clone.properties).not.toBe(properties)
		expect(clone.properties?.values).not.toBe(items)
		expect(clone.properties?.values?.items).not.toBe(leaf)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(Object.isFrozen(clone.properties)).toBe(true)
		expect(Object.isFrozen(clone.properties?.values)).toBe(true)
		expect(Object.isFrozen(clone.properties?.values?.items)).toBe(true)
		expect(Object.isFrozen(source)).toBe(false)
		expect(Object.isFrozen(properties)).toBe(false)
		expect(Object.isFrozen(items)).toBe(false)
		expect(Object.isFrozen(leaf)).toBe(false)
	})

	it('preserves shared child identity in the owned schema graph', () => {
		const child: JSONSchema = { type: 'integer' }
		const source: JSONSchema = { anyOf: [child, child] }
		const clone = cloneSchema(source)

		expect(clone.anyOf?.[0]).toBe(clone.anyOf?.[1])
		expect(clone.anyOf?.[0]).not.toBe(child)
		expect(Object.isFrozen(clone.anyOf)).toBe(true)
	})

	it('tolerates a cycle and closes it onto the cloned schema', () => {
		const raw = JSON.parse('{"type":"object","properties":{}}')
		raw.properties.self = raw
		const source: JSONSchema = raw
		const clone = cloneSchema(source)

		expect(clone.properties?.self).toBe(clone)
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(Object.isFrozen(clone.properties)).toBe(true)
		expect(Object.isFrozen(source)).toBe(false)
	})
})

describe('cloneShape', () => {
	it('deep-clones a shape into a frozen, deeply-equal snapshot', () => {
		const source = objectShape({
			name: stringShape({ min: 1 }),
			tags: arrayShape(stringShape()),
		})
		const clone = cloneShape(source)

		expect(clone).toEqual(source)
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(clone.type).toBe('object')
		if (clone.type !== 'object') return
		expect(clone.properties).not.toBe(source.properties)
		expect(Object.isFrozen(clone.properties)).toBe(true)
		expect(Object.isFrozen(clone.properties.name)).toBe(true)
		expect(Object.isFrozen(clone.properties.tags)).toBe(true)
	})

	it('preserves shared-child identity in a cloned DAG', () => {
		const child = arrayShape(stringShape())
		const source = objectShape({ first: child, second: child })
		const clone = cloneShape(source)

		expect(clone.type).toBe('object')
		if (clone.type !== 'object') return
		expect(clone.properties.first).toBe(clone.properties.second)
		expect(clone.properties.first).not.toBe(child)
	})

	it('tolerates cycles and closes the cloned edge onto the clone', () => {
		const raw = JSON.parse('{"type":"array","items":{"type":"string"}}')
		raw.items = raw
		const source: ContractShape = raw
		const clone = cloneShape(source)

		expect(clone.type).toBe('array')
		if (clone.type !== 'array') return
		expect(clone.items).toBe(clone)
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
	})

	it('preserves sharing across union variants', () => {
		const child = objectShape({ value: stringShape() })
		const source = unionShape(child, child)
		const clone = cloneShape(source)

		expect(clone.type).toBe('union')
		if (clone.type !== 'union') return
		expect(clone.variants[0]).toBe(clone.variants[1])
		expect(Object.isFrozen(clone.variants)).toBe(true)
	})
})
