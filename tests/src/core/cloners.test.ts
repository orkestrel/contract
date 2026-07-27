import type { ContractShape } from '@src/core'
import {
	arrayShape,
	cloneShape,
	objectShape,
	stringShape,
	unionShape,
} from '@src/core'
import { describe, expect, it } from 'vitest'

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
