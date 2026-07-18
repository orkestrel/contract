import { describe, expect, it } from 'vitest'
import type { Infer, InferMutable, JSONValue } from '@src/core'
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
import type { Equal, Expect } from '../../setup.js'

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

	it('derives an index signature for recordShape values (finding #1)', () => {
		const rec = recordShape(numberShape())
		const v: Infer<typeof rec> = { a: 1 }
		const n: number = v.a
		expect(n).toBe(1)
		// @ts-expect-error — recordShape values are number, string rejected
		const bad: Infer<typeof rec> = { a: 'x' }
		expect(bad).toBeDefined()
	})

	it('mixed shape keeps named props at their declared types and infers extras as unknown', () => {
		const mixed = objectShape({ id: stringShape() }, { additionalProperties: numberShape() })
		const v: Infer<typeof mixed> = { id: 'x', extra: 42 }
		const id: string = v.id
		expect(id).toBe('x')
		const extra: unknown = v.extra
		expect(extra).toBe(42)
		// @ts-expect-error — an extra key must infer as unknown, not number
		const bad: number = v.extra
		expect(bad).toBeDefined()
	})

	it('additionalProperties: true widens to an open unknown index (finding #2)', () => {
		const o = objectShape({ id: stringShape() }, { additionalProperties: true })
		const v: Infer<typeof o> = { id: 'x', whatever: 42 }
		expect(v.id).toBe('x')
	})

	it('objectShape({}) infers a closed empty object, not unknown', () => {
		const empty = objectShape({})
		const value: Infer<typeof empty> = {}
		expect(value).toEqual({})
		type _Lock = Expect<Equal<Infer<typeof empty>, Readonly<Record<never, never>>>>
	})
})

describe('InferMutable', () => {
	it('strips top-level readonly but leaves nested readonly unchanged', () => {
		const shape = objectShape({
			name: stringShape(),
			profile: objectShape({ bio: stringShape() }),
		})
		const value: InferMutable<typeof shape> = { name: 'Ada', profile: { bio: 'hi' } }
		// Top-level readonly is stripped — direct assignment compiles.
		value.name = 'Grace'
		expect(value.name).toBe('Grace')
		// @ts-expect-error — nested readonly is unchanged; `profile.bio` stays readonly
		value.profile.bio = 'bye'
		expect(value.profile.bio).toBe('bye')
	})
})

describe('Infer depth-robustness tripwire', () => {
	it('infers a deeply-nested (6+ level) realistic snapshot shape by exact identity', () => {
		const textPart = objectShape({ via: literalShape(['text']), text: stringShape() })
		const toolPart = objectShape({
			via: literalShape(['tool']),
			name: stringShape(),
			args: recordShape(unionShape(stringShape(), numberShape(), booleanShape())),
		})
		const part = unionShape(textPart, toolPart)

		const userMessage = objectShape({
			role: literalShape(['user']),
			parts: arrayShape(part),
			at: numberShape(),
		})
		const assistantMessage = objectShape({
			role: literalShape(['assistant']),
			parts: arrayShape(part),
			usage: optionalShape(objectShape({ input: numberShape(), output: numberShape() })),
			stop: nullableShape(literalShape(['end', 'length', 'tool'])),
		})
		const message = unionShape(userMessage, assistantMessage)

		const snapshot = objectShape({
			id: stringShape(),
			title: optionalShape(stringShape()),
			messages: arrayShape(message),
			metadata: recordShape(
				objectShape({
					key: stringShape(),
					value: unionShape(stringShape(), numberShape(), booleanShape()),
					tags: arrayShape(stringShape()),
				}),
			),
			settings: objectShape({
				model: stringShape(),
				limits: objectShape({
					tokens: objectShape({ input: numberShape(), output: numberShape() }),
					nested: objectShape({ deep: objectShape({ deeper: stringShape() }) }),
				}),
			}),
		})

		type Snapshot = Infer<typeof snapshot>

		type Part =
			| { readonly via: 'text'; readonly text: string }
			| {
					readonly via: 'tool'
					readonly name: string
					readonly args: { readonly [k: string]: string | number | boolean }
			  }
		type UserMessage = {
			readonly role: 'user'
			readonly parts: readonly Part[]
			readonly at: number
		}
		type AssistantMessage = {
			readonly role: 'assistant'
			readonly parts: readonly Part[]
			readonly usage?: { readonly input: number; readonly output: number }
			readonly stop: 'end' | 'length' | 'tool' | null
		}
		type Expected = {
			readonly id: string
			readonly title?: string
			readonly messages: readonly (UserMessage | AssistantMessage)[]
			readonly metadata: {
				readonly [k: string]: {
					readonly key: string
					readonly value: string | number | boolean
					readonly tags: readonly string[]
				}
			}
			readonly settings: {
				readonly model: string
				readonly limits: {
					readonly tokens: { readonly input: number; readonly output: number }
					readonly nested: { readonly deep: { readonly deeper: string } }
				}
			}
		}
		type _Lock = Expect<Equal<Snapshot, Expected>>

		const value: Snapshot = {
			id: 'abc',
			messages: [],
			metadata: {},
			settings: {
				model: 'x',
				limits: { tokens: { input: 0, output: 0 }, nested: { deep: { deeper: 'y' } } },
			},
		}
		expect(value.id).toBe('abc')
	})
})
