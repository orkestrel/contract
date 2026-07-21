import { describe, expect, it } from 'vitest'
import type {
	ContractShape,
	Infer,
	InferMutable,
	JSONSchema,
	JSONValue,
	ObjectShape,
	StringShape,
} from '@src/core'
import {
	arrayShape,
	booleanShape,
	compileGuard,
	createContract,
	INFER_BREADTH_LIMIT,
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
	samplesToSchema,
	schemaToShape,
	stringShape,
	unionShape,
	valueToSchema,
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

describe('Infer wide-additionalProperties tuple-guard regression (0.0.4)', () => {
	it('a wide/defaulted A stays shallow — no TS2589 depth error, and resolves to the closed row intersected with the unknown open index (InferOpenIndex)', () => {
		// `ObjectShape<{ id: StringShape }, boolean | ContractShape>` — `A` is the
		// FULL defaulted `additionalProperties` union, not narrowed to a specific
		// `false` / `true` / `ContractShape`. Before the 0.0.4 tuple-A-guard fix, a
		// naked `A extends boolean | ContractShape` here distributed over the wide
		// union and fanned out into a TS2589 excessively-deep-instantiation error.
		// This locks that the tuple-wrapped guard keeps it a single, shallow
		// instantiation that resolves to `unknown` on the `InferOpenIndex` tail —
		// i.e. the closed row `{ id: string }` intersected with `unknown`, so the
		// extra-key index contributes nothing beyond the declared property.
		type Locked = Infer<ObjectShape<{ id: StringShape }, boolean | ContractShape>>
		type Expected = Readonly<{ id: string }>
		type _Lock = Expect<Equal<Locked, Expected>>

		const value: Locked = { id: 'abc' }
		expect(value.id).toBe('abc')
	})
})

describe('schemaToShape — round-trip law: compileGuard(schemaToShape(valueToSchema(v)))(v)', () => {
	// Returns [fromValue, fromSamples] so every `it` calls `expect` directly on
	// the result (never inside this helper) — satisfies the linter's
	// no-hidden-assertions rule while keeping the corpus terse to declare.
	const roundTrips = (value: unknown): readonly [boolean, boolean] => {
		const guardFromValue = compileGuard(schemaToShape(valueToSchema(value)))
		const guardFromSamples = compileGuard(schemaToShape(samplesToSchema([value])))
		return [guardFromValue(value), guardFromSamples(value)]
	}

	it('round-trips every leaf kind', () => {
		for (const value of [null, true, false, 42, -0, 3.14, 'hello']) {
			expect(roundTrips(value)).toEqual([true, true])
		}
	})

	it('round-trips nested objects', () => {
		expect(roundTrips({ id: 1, name: 'Ada', address: { city: 'London', zip: '10001' } })).toEqual([
			true,
			true,
		])
	})

	it('round-trips homogeneous and heterogeneous arrays', () => {
		expect(roundTrips(['a', 'b', 'c'])).toEqual([true, true])
		expect(roundTrips([1, 'x', true, 3.5])).toEqual([true, true])
	})

	it("round-trips a Date — the inferred schema validates the Date's serialized (ISO string) form", () => {
		// valueToSchema infers a Date's JSON-serialized shape ({ type: 'string' }),
		// not the runtime Date instance itself (typeof 'object') — the round-trip
		// law therefore applies to the Date's string representation, mirroring how
		// the value would actually cross a JSON boundary.
		const date = new Date('2024-01-15T10:30:00Z')
		const guard = compileGuard(schemaToShape(valueToSchema(date)))
		expect(guard(date.toISOString())).toBe(true)
	})

	it('round-trips enum-eligible repeated samples', () => {
		const guard = compileGuard(
			schemaToShape(samplesToSchema(['active', 'inactive', 'active'], { enum: true })),
		)
		expect(guard('active')).toBe(true)
		expect(guard('inactive')).toBe(true)
		expect(guard('unknown-status')).toBe(false)
	})

	it('round-trips format-bearing strings without narrowing (format is never asserted)', () => {
		const schema = valueToSchema('ada@example.com', { format: true })
		expect(schema).toEqual({ type: 'string', format: 'email' })
		const guard = compileGuard(schemaToShape(schema))
		expect(guard('ada@example.com')).toBe(true)
		expect(guard('not an email at all')).toBe(true)
	})
})

describe('schemaToShape — keyword semantics', () => {
	it('maps each primitive type keyword to its matching shape', () => {
		expect(schemaToShape({ type: 'string' })).toMatchObject({ type: 'string' })
		expect(schemaToShape({ type: 'number' })).toMatchObject({ type: 'number' })
		expect(schemaToShape({ type: 'integer' })).toMatchObject({ type: 'number', integer: true })
		expect(schemaToShape({ type: 'boolean' })).toMatchObject({ type: 'boolean' })
		expect(schemaToShape({ type: 'null' })).toMatchObject({ type: 'null' })
	})

	it('enum maps to a literal shape that accepts listed values and rejects others', () => {
		const guard = compileGuard(schemaToShape({ enum: ['admin', 'guest'] }))
		expect(guard('admin')).toBe(true)
		expect(guard('guest')).toBe(true)
		expect(guard('owner')).toBe(false)
	})

	it('anyOf compiles to a union accepting any matching variant', () => {
		const guard = compileGuard(schemaToShape({ anyOf: [{ type: 'string' }, { type: 'integer' }] }))
		expect(guard('x')).toBe(true)
		expect(guard(5)).toBe(true)
		expect(guard(true)).toBe(false)
	})

	it('oneOf compiles to a union rejecting a value matching two-or-more variants', () => {
		const guard = compileGuard(schemaToShape({ oneOf: [{ type: 'number' }, { type: 'integer' }] }))
		expect(guard(3.5)).toBe(true) // matches number only
		expect(guard(3)).toBe(false) // matches both number and integer
	})

	it('required keys are mandatory; unlisted keys become optional', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { id: { type: 'integer' }, name: { type: 'string' } },
			required: ['id'],
			additionalProperties: false,
		}
		const guard = compileGuard(schemaToShape(schema))
		expect(guard({ id: 1 })).toBe(true)
		expect(guard({ id: 1, name: 'Ada' })).toBe(true)
		expect(guard({ name: 'Ada' })).toBe(false)
	})

	it('additionalProperties: false rejects extras', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { id: { type: 'integer' } },
			required: ['id'],
			additionalProperties: false,
		}
		const guard = compileGuard(schemaToShape(schema))
		expect(guard({ id: 1 })).toBe(true)
		expect(guard({ id: 1, extra: 'x' })).toBe(false)
	})

	it('additionalProperties: true accepts extras', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { id: { type: 'integer' } },
			required: ['id'],
			additionalProperties: true,
		}
		const guard = compileGuard(schemaToShape(schema))
		expect(guard({ id: 1, extra: 'x' })).toBe(true)
	})

	it('absent additionalProperties accepts extras (open by JSON Schema default)', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { id: { type: 'integer' } },
			required: ['id'],
		}
		const guard = compileGuard(schemaToShape(schema))
		expect(guard({ id: 1, extra: 'x' })).toBe(true)
	})

	it('record-valued additionalProperties validates extras against that shape', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { id: { type: 'integer' } },
			required: ['id'],
			additionalProperties: { type: 'number' },
		}
		const guard = compileGuard(schemaToShape(schema))
		expect(guard({ id: 1, score: 4.5 })).toBe(true)
		expect(guard({ id: 1, score: 'nope' })).toBe(false)
	})

	it('forces additionalProperties open when property count exceeds INFER_BREADTH_LIMIT, even against a closed schema', () => {
		const propertyCount = INFER_BREADTH_LIMIT + 40
		const properties: Record<string, JSONSchema> = {}
		const value: Record<string, string> = {}
		for (let index = 0; index < propertyCount; index += 1) {
			const key = `k${index}`
			properties[key] = { type: 'string' }
			value[key] = `v${index}`
		}
		const schema: JSONSchema = { type: 'object', properties, additionalProperties: false }
		expect(() => createContract(schemaToShape(schema))).not.toThrow()
		const guard = compileGuard(schemaToShape(schema))
		// A key past the INFER_BREADTH_LIMIT sampling cap (e.g. the last one) is
		// dropped from `properties`, so it can only pass if additionalProperties
		// was forced open rather than inheriting the schema's `false`.
		expect(guard(value)).toBe(true)
	})

	it('widens oneOf/anyOf to jsonShape when the record-variant count exceeds INFER_BREADTH_LIMIT, rather than narrowing to a subset union', () => {
		const variantCount = INFER_BREADTH_LIMIT + 10
		const variants: JSONSchema[] = []
		for (let index = 0; index < variantCount; index += 1) {
			variants.push({ enum: [`v${index}`] })
		}
		const schema: JSONSchema = { anyOf: variants }
		const guard = compileGuard(schemaToShape(schema))
		// A variant beyond the sampling cap must still be accepted — proving the
		// walk widened to jsonShape instead of building a narrower subset union.
		expect(guard(`v${INFER_BREADTH_LIMIT + 5}`)).toBe(true)
	})

	it('enforces minLength/maxLength bounds', () => {
		const guard = compileGuard(schemaToShape({ type: 'string', minLength: 2, maxLength: 4 }))
		expect(guard('ab')).toBe(true)
		expect(guard('abcd')).toBe(true)
		expect(guard('a')).toBe(false)
		expect(guard('abcde')).toBe(false)
	})

	it('drops contradictory minLength/maxLength (min > max) to unbounded', () => {
		const guard = compileGuard(schemaToShape({ type: 'string', minLength: 10, maxLength: 1 }))
		expect(guard('')).toBe(true)
		expect(guard('anything at all')).toBe(true)
	})

	it('drops malformed minLength/maxLength (negative, NaN, Infinity, non-integer)', () => {
		expect(compileGuard(schemaToShape({ type: 'string', minLength: -1 }))('')).toBe(true)
		expect(compileGuard(schemaToShape({ type: 'string', minLength: Number.NaN }))('')).toBe(true)
		expect(
			compileGuard(schemaToShape({ type: 'string', maxLength: Number.POSITIVE_INFINITY }))('x'),
		).toBe(true)
		expect(compileGuard(schemaToShape({ type: 'string', minLength: 1.5 }))('')).toBe(true)
	})

	it('enforces minimum/maximum bounds for number and integer', () => {
		const numberGuard = compileGuard(schemaToShape({ type: 'number', minimum: 0, maximum: 10 }))
		expect(numberGuard(0)).toBe(true)
		expect(numberGuard(10)).toBe(true)
		expect(numberGuard(-1)).toBe(false)
		expect(numberGuard(11)).toBe(false)

		const integerGuard = compileGuard(schemaToShape({ type: 'integer', minimum: 0, maximum: 10 }))
		expect(integerGuard(5)).toBe(true)
		expect(integerGuard(5.5)).toBe(false)
	})

	it('drops contradictory minimum/maximum (min > max) to unbounded', () => {
		const guard = compileGuard(schemaToShape({ type: 'number', minimum: 10, maximum: 1 }))
		expect(guard(-1000)).toBe(true)
		expect(guard(1000)).toBe(true)
	})

	it('drops an empty integer range (fractional bounds with no integer between) to unbounded', () => {
		const schema: JSONSchema = { type: 'integer', minimum: 1.2, maximum: 1.8 }
		expect(() => createContract(schemaToShape(schema))).not.toThrow()
		const guard = compileGuard(schemaToShape(schema))
		expect(guard(1)).toBe(true)
		expect(guard(-1000)).toBe(true)
		expect(guard(1000)).toBe(true)
	})

	it('enforces minItems/maxItems bounds and drops contradictory pairs', () => {
		const guard = compileGuard(
			schemaToShape({ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 }),
		)
		expect(guard(['a'])).toBe(true)
		expect(guard(['a', 'b'])).toBe(true)
		expect(guard([])).toBe(false)
		expect(guard(['a', 'b', 'c'])).toBe(false)

		const unbounded = compileGuard(
			schemaToShape({ type: 'array', items: { type: 'string' }, minItems: 5, maxItems: 1 }),
		)
		expect(unbounded([])).toBe(true)
	})

	it('numberShape accepts integer values (integer is a subset of number)', () => {
		const guard = compileGuard(schemaToShape({ type: 'number' }))
		expect(guard(42)).toBe(true)
		expect(guard(3.5)).toBe(true)
	})
})

describe('schemaToShape — format and pattern are never asserted', () => {
	it('a format keyword never narrows validation', () => {
		const guard = compileGuard(schemaToShape({ type: 'string', format: 'email' }))
		expect(guard('not an email at all')).toBe(true)
	})

	it('a pattern keyword is ignored and never compiled into a RegExp (instant, any string accepted)', () => {
		// A classic ReDoS-shaped pattern — if this were ever compiled, a hostile
		// input would hang the process. Construction and validation must be instant.
		const start = Date.now()
		const guard = compileGuard(schemaToShape({ type: 'string', pattern: '^(a+)+$' }))
		expect(guard(`${'a'.repeat(40)}!`)).toBe(true)
		expect(Date.now() - start).toBeLessThan(100)
	})
})

describe('schemaToShape — hostile schema triad', () => {
	it('does not stack-overflow or throw on a cyclic schema graph (self-referential properties)', () => {
		// JSON.parse returns an untyped structure; mutate it before pinning the
		// declared type to JSONSchema — no type assertion needed (AGENTS §1).
		const raw = JSON.parse('{"type":"object","properties":{"child":{"type":"string"}}}')
		raw.properties.child = raw
		const schema: JSONSchema = raw
		expect(() => createContract(schemaToShape(schema))).not.toThrow()
	})

	it('does not stack-overflow or throw on a cyclic schema graph (self-referential items)', () => {
		const raw = JSON.parse('{"type":"array"}')
		raw.items = raw
		const schema: JSONSchema = raw
		expect(() => createContract(schemaToShape(schema))).not.toThrow()
	})

	it('completes and widens deep subtrees to jsonShape at the depth limit', () => {
		let node: JSONSchema = { type: 'string' }
		for (let level = 0; level < 100; level += 1) {
			node = { type: 'object', properties: { child: node }, required: ['child'] }
		}
		expect(() => createContract(schemaToShape(node))).not.toThrow()
		const contract = createContract(schemaToShape(node))
		expect(contract.is).toBeDefined()
	})

	it('does not let a throwing-getter Proxy schema escape, falling back to jsonShape', () => {
		// A generic Proxy<JSONSchema> is JSONSchema-typed directly — no cast needed.
		const hostile = new Proxy<JSONSchema>(
			{ type: 'object' },
			{
				get() {
					throw new Error('hostile getter')
				},
				has() {
					return true
				},
			},
		)
		expect(() => createContract(schemaToShape(hostile))).not.toThrow()
	})

	it('does not let a throwing-getter Proxy nested keyword escape', () => {
		const hostileProperties = new Proxy<Record<string, JSONSchema>>(
			{},
			{
				ownKeys() {
					throw new Error('hostile ownKeys')
				},
			},
		)
		const schema: JSONSchema = { type: 'object', properties: hostileProperties }
		expect(() => createContract(schemaToShape(schema))).not.toThrow()
	})

	it('handles structurally-junk schemas arriving via JSON.parse of hostile text', () => {
		const schema: JSONSchema = JSON.parse('{"type":123,"enum":"not an array","properties":"nope"}')
		expect(() => createContract(schemaToShape(schema))).not.toThrow()
	})
})

describe('schemaToShape — hostile validated values', () => {
	it('flows __proto__ / constructor keys via JSON.parse input through parse without pollution', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { __proto__: { type: 'integer' }, a: { type: 'integer' } },
			required: ['__proto__', 'a'],
			additionalProperties: false,
		}
		const contract = createContract(schemaToShape(schema))
		const hostileValue: unknown = JSON.parse('{"__proto__":1,"a":2}')
		const parsed = contract.parse(hostileValue)
		expect(parsed).toBeDefined()
		expect(Object.prototype.hasOwnProperty.call({}, 'polluted')).toBe(false)
	})

	it('parse returns undefined, never throws, for a throwing-getter value', () => {
		const contract = createContract(
			schemaToShape({
				type: 'object',
				properties: { name: { type: 'string' } },
				required: ['name'],
			}),
		)
		const hostileValue = new Proxy(
			{},
			{
				get() {
					throw new Error('hostile getter')
				},
				has() {
					return true
				},
			},
		)
		expect(() => contract.parse(hostileValue)).not.toThrow()
		expect(contract.parse(hostileValue)).toBeUndefined()
	})
})

describe('schemaToShape — createContract never throws (malformed schema sweep)', () => {
	// Each entry is built via JSON.parse (untyped) then pinned to JSONSchema on
	// assignment — deliberately malformed keyword values with no type assertion.
	const malformedSchemas: readonly { readonly label: string; readonly schema: JSONSchema }[] = [
		{ label: 'enum with only object entries', schema: JSON.parse('{"enum":[{"nested":true}]}') },
		{ label: 'empty enum', schema: JSON.parse('{"enum":[]}') },
		{
			label: 'minLength of wrong type',
			schema: JSON.parse('{"type":"string","minLength":"not a number"}'),
		},
		{
			label: 'minimum of wrong type',
			schema: JSON.parse('{"type":"number","minimum":"not a number"}'),
		},
		{ label: 'unknown type string', schema: JSON.parse('{"type":"wat"}') },
		{ label: 'empty schema', schema: {} },
	]

	it.each(malformedSchemas)(
		'wraps malformed schema ($label) without throwing, with parse/is/explain total',
		({ schema }) => {
			expect(() => createContract(schemaToShape(schema))).not.toThrow()
			const contract = createContract(schemaToShape(schema))
			expect(() => contract.parse('anything')).not.toThrow()
			expect(() => contract.is('anything')).not.toThrow()
			expect(() => contract.explain('anything')).not.toThrow()
		},
	)
})

describe('schemaToShape — seam composition: samplesToSchema -> schemaToShape -> createContract', () => {
	it('parses an in-shape value and reports non-empty faults for an out-of-shape value', () => {
		const schema = samplesToSchema([
			{ id: 1, name: 'Ada' },
			{ id: 2, name: 'Grace' },
		])
		const contract = createContract(schemaToShape(schema))
		expect(contract.parse({ id: 3, name: 'Alan' })).toEqual({ id: 3, name: 'Alan' })
		expect(contract.parse({ id: 'nope' })).toBeUndefined()
		const faults = contract.explain({ id: 'nope' })
		expect(faults.length).toBeGreaterThan(0)
	})
})

describe('schemaToShape — performance guard', () => {
	it('resolves a diamond/shared-subtree schema DAG quickly (the conversion itself is memoized)', () => {
		// The memo dedupes identical (schema node, remaining depth) re-conversion:
		// the 'a' and 'b' branches share the same child node at the same depth, so
		// their built shapes are the SAME reference, not merely equal — this is
		// what keeps a fan-2/depth-20 DAG from costing 2^20 re-conversions. (A
		// downstream createContract/compileGuard walk of the RESULTING shape is
		// its own, unrelated concern — compileGuard recurses the shape's tree
		// structure, which legitimately revisits a shared subtree per path.)
		let node: JSONSchema = { type: 'string' }
		for (let level = 0; level < 20; level += 1) {
			node = { type: 'object', properties: { a: node, b: node }, required: ['a', 'b'] }
		}
		const start = Date.now()
		const shape = schemaToShape(node)
		expect(Date.now() - start).toBeLessThan(5000)
		expect(shape.type).toBe('object')
		// Both keys are `required`, so neither is optionalShape-wrapped — the
		// memoized inner shape is returned by reference for both, proving the
		// conversion dedupes the shared subtree instead of re-building it.
		const properties = shape.type === 'object' ? shape.properties : undefined
		expect(properties?.a).toBe(properties?.b)
	})

	it('resolves an INFER_BREADTH_LIMIT-wide properties record quickly', () => {
		const properties: Record<string, JSONSchema> = {}
		for (let index = 0; index < 300; index += 1) {
			properties[`key${index}`] = { type: 'string' }
		}
		const schema: JSONSchema = { type: 'object', properties }
		const start = Date.now()
		expect(() => createContract(schemaToShape(schema))).not.toThrow()
		expect(Date.now() - start).toBeLessThan(5000)
	})
})
