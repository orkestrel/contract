import { describe, expect, it } from 'vitest'
import type { Infer, JSONValue } from '@src/core'
import {
	arrayShape,
	booleanShape,
	integerShape,
	jsonShape,
	literalShape,
	nullableShape,
	nullShape,
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
		expect(literalShape(['admin', 'guest'])).toMatchObject({
			type: 'literal',
			values: ['admin', 'guest'],
		})
	})

	it('literalShape attaches the description via options', () => {
		expect(literalShape(['admin', 'guest'], { description: 'the user role' })).toEqual({
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

	it('nullShape returns a bare null shape and threads its description', () => {
		expect(nullShape()).toEqual({ type: 'null', description: undefined })
		expect(nullShape({ description: 'nothing' })).toEqual({
			type: 'null',
			description: 'nothing',
		})
	})

	it('jsonShape returns a bare json shape and threads its description', () => {
		expect(jsonShape()).toEqual({ type: 'json', description: undefined })
		expect(jsonShape({ description: 'any JSON value' })).toEqual({
			type: 'json',
			description: 'any JSON value',
		})
	})
})

describe('Infer', () => {
	it('derives the static type a shape describes (compile-time)', () => {
		const user = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape(),
			role: literalShape(['admin', 'guest']),
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
		// @ts-expect-error — Infer must narrow role to the exact literal union, not string
		const widened: Infer<typeof user> = { ...value, role: 'owner' }
		expect(widened).toBeDefined()
	})

	it('derives null for a nullShape (compile-time)', () => {
		const shape = nullShape()
		const value: Infer<typeof shape> = null
		expect(value).toBeNull()
		// @ts-expect-error — Infer<NullShape> must be exactly `null`, not `string`
		const wrong: Infer<typeof shape> = 'not null'
		expect(wrong).toBeDefined()
	})

	it('derives JSONValue for a jsonShape (compile-time)', () => {
		const shape = jsonShape()
		const value: Infer<typeof shape> = { nested: [1, 'x', null] }
		expect(value).toEqual({ nested: [1, 'x', null] })
		const primitive: Infer<typeof shape> = 'a JSON value'
		expect(primitive).toBe('a JSON value')
		// @ts-expect-error — Infer<JSONShape> must be JSONValue, not a function
		const wrong: Infer<typeof shape> = () => 1
		expect(wrong).toBeDefined()
		const check: JSONValue = value
		expect(check).toBeDefined()
	})
})
