import { describe, expect, it } from 'vitest'
import type { Infer } from '@src/core'
import {
	arrayShape,
	booleanShape,
	describedLiteral,
	integerShape,
	literalShape,
	nullableShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	rawShape,
	recordShape,
	stringShape,
	unionShape,
} from '@src/core'

describe('shape builders', () => {
	it('stringShape carries length / pattern / description', () => {
		expect(stringShape()).toMatchObject({ type: 'string' })
		const pattern = /^a+$/
		expect(stringShape({ min: 1, max: 8, pattern, description: 'name' })).toMatchObject({
			type: 'string',
			min: 1,
			max: 8,
			pattern,
			description: 'name',
		})
	})

	it('numberShape and integerShape set the integer flag appropriately', () => {
		expect(numberShape({ min: 0, max: 10 })).toMatchObject({ type: 'number', min: 0, max: 10 })
		expect(numberShape().integer).toBeUndefined()
		expect(integerShape({ min: 0 })).toMatchObject({ type: 'number', integer: true, min: 0 })
	})

	it('booleanShape carries its description', () => {
		expect(booleanShape({ description: 'flag' })).toMatchObject({
			type: 'boolean',
			description: 'flag',
		})
	})

	it('literalShape preserves the value tuple', () => {
		expect(literalShape('admin', 'guest')).toMatchObject({
			type: 'literal',
			values: ['admin', 'guest'],
		})
	})

	it('describedLiteral preserves the value tuple and attaches the description', () => {
		expect(describedLiteral('the user role', 'admin', 'guest')).toEqual({
			type: 'literal',
			values: ['admin', 'guest'],
			description: 'the user role',
		})
	})

	it('arrayShape wraps an element shape with bounds', () => {
		const shape = arrayShape(stringShape(), { max: 3 })
		expect(shape.type).toBe('array')
		expect(shape.items).toMatchObject({ type: 'string' })
		expect(shape.max).toBe(3)
	})

	it('objectShape carries properties + additionalProperties', () => {
		const shape = objectShape({ name: stringShape() }, { additionalProperties: false })
		expect(shape.type).toBe('object')
		expect(shape.properties.name).toMatchObject({ type: 'string' })
		expect(shape.additionalProperties).toBe(false)
	})

	it('recordShape is an open object validated by its value shape', () => {
		const shape = recordShape(numberShape())
		expect(shape.type).toBe('object')
		expect(shape.properties).toEqual({})
		expect(shape.additionalProperties).toMatchObject({ type: 'number' })
	})

	it('unionShape / oneOfShape collect variants; only oneOf sets the mode', () => {
		expect(unionShape(stringShape(), integerShape()).variants).toHaveLength(2)
		expect(unionShape(stringShape()).mode).toBeUndefined()
		expect(oneOfShape(stringShape(), booleanShape()).mode).toBe('oneOf')
	})

	it('optionalShape / nullableShape wrap an inner shape', () => {
		expect(optionalShape(stringShape())).toMatchObject({
			type: 'optional',
			inner: { type: 'string' },
		})
		expect(nullableShape(numberShape())).toMatchObject({
			type: 'nullable',
			inner: { type: 'number' },
		})
	})

	it('rawShape embeds a schema fragment verbatim', () => {
		expect(rawShape({ type: 'string', description: 'any' })).toEqual({
			type: 'raw',
			schema: { type: 'string', description: 'any' },
		})
	})
})

describe('Infer', () => {
	it('derives the static type a shape describes (compile-time)', () => {
		const user = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape(),
			role: literalShape('admin', 'guest'),
			bio: optionalShape(stringShape()),
			avatar: nullableShape(stringShape()),
			tags: arrayShape(stringShape()),
		})
		// This must satisfy Infer<typeof user> — `bio` optional, `role` a literal
		// union, `avatar` nullable. A wrong Infer fails the typecheck gate.
		const value: Infer<typeof user> = {
			name: 'Ada',
			age: 36,
			role: 'admin',
			avatar: null,
			tags: ['ts'],
		}
		expect(value.name).toBe('Ada')
		expect(value.role).toBe('admin')
		expect(value.avatar).toBeNull()
	})
})
