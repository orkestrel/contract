// `SchemaShaper` is interned: it carries no barrel row, `tests/guides.test.ts` names it
// in `INTERNAL`, and this suite therefore reaches the class by relative source path.
// `schemaToShape` is the only door that constructs it, and that door stamps its own
// name onto every refusal, so the walk's raw readings are reachable from here alone.
import type { ContractShape, JSONSchema } from '@src/core'
import {
	arrayShape,
	attempt,
	compileGuard,
	compileParser,
	compileSchema,
	createContract,
	INFER_BREADTH_LIMIT,
	INFER_DEPTH_LIMIT,
	isContractError,
	isError,
	JSON_SCHEMA_TYPES,
	literalShape,
	nullShape,
	numberShape,
	objectShape,
	optionalShape,
	schemaToShape,
	stringShape,
	unionShape,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	buildCycle,
	closedOf,
	closedWhenObject,
	LENIENT_DEFAULT_DROPS,
	polluteArrayConstruction,
	pollutePrototype,
	captureContractError,
	STRICT_SCHEMA_REFUSALS,
} from '../../setup.js'
import { SchemaShaper } from '../../../src/core/SchemaShaper.js'

describe('SchemaShaper — type arrays', () => {
	it('keeps HEAD schema alternatives under polluted array construction', () => {
		const schemas: ReadonlyArray<Readonly<Record<string, unknown>>> = [
			{ enum: ['x', 'x', 1] },
			{ oneOf: [{ type: 'string' }, { type: 'integer' }] },
			{ anyOf: [{ type: 'string' }, { type: 'integer' }] },
			{ type: ['string', 'null'] },
			{ type: 'object', properties: { age: { type: 'integer' } }, required: ['age'] },
		]
		const actual = schemas.map((schema) =>
			polluteArrayConstruction(() => compileSchema(new SchemaShaper(schema).shape())),
		)
		// HEAD SchemaShaper.ts:157 and :324 retain enum/type alternatives and declared properties.
		expect(actual).toEqual([
			{ enum: ['x', 1] },
			{ oneOf: [{ type: 'string' }, { type: 'integer' }] },
			{ anyOf: [{ type: 'string' }, { type: 'integer' }] },
			{ anyOf: [{ type: 'string' }, { type: 'null' }] },
			{
				type: 'object',
				properties: { age: { type: 'integer' } },
				required: ['age'],
				additionalProperties: true,
			},
		])
	})

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
		const schema = Array.from({ length: INFER_DEPTH_LIMIT - 2 }).reduce<Record<string, unknown>>(
			(node) => ({ type: 'array', items: node }),
			{ type: ['array'], items: { type: 'string' } },
		)
		const bare = Array.from({ length: INFER_DEPTH_LIMIT - 2 }).reduce<JSONSchema>(
			(node) => ({ type: 'array', items: node }),
			{ type: 'array', items: { type: 'string' } },
		)
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

describe('SchemaShaper — lenient default', () => {
	const carried: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>, unknown]> = [
		['a number', { type: 'number', default: 3 }, 3],
		['a bounded number', { type: 'number', minimum: 0, maximum: 9, default: 3 }, 3],
		['an integer', { type: 'integer', default: 3 }, 3],
		['a string', { type: 'string', minLength: 1, maxLength: 3, default: 'xy' }, 'xy'],
		['a boolean', { type: 'boolean', default: false }, false],
		['null', { type: 'null', default: null }, null],
		['an enum member', { enum: ['a', 'b'], default: 'b' }, 'b'],
		['a singleton type list', { type: ['number'], default: 3 }, 3],
	]

	it.each(carried)('carries a valid default on %s', (_label, property, value) => {
		const contract = createContract(schemaToShape(closedOf(property)))

		expect(contract.parse({})).toEqual({ a: value })
		expect(contract.schema.properties?.a?.default).toEqual(value)
		expect(contract.is({})).toBe(true)
	})

	it('carries a valid default and drops a text default on a number', () => {
		const valid = compileSchema(schemaToShape(closedOf({ type: 'number', default: 3 })))
		const text = compileSchema(schemaToShape(closedOf({ type: 'number', default: 'x' })))

		expect(valid.properties?.a?.default).toBe(3)
		expect(text.properties?.a?.default).toBeUndefined()
	})

	it.each(LENIENT_DEFAULT_DROPS)('drops the default on %s and stays total', (_label, schema) => {
		const contract = createContract(schemaToShape(schema))

		expect(contract.schema.properties?.a?.default).toBeUndefined()
		expect(contract.parse({})).not.toEqual({ a: 3 })
	})

	it('drops a default below a union and keeps the one beside it', () => {
		const shared = closedOf({ type: 'number', default: 3 })
		const orders: readonly JSONSchema[] = [
			{
				type: 'object',
				properties: { plain: shared, joined: { anyOf: [shared, { type: 'null' }] } },
				additionalProperties: false,
			},
			{
				type: 'object',
				properties: { joined: { anyOf: [shared, { type: 'null' }] }, plain: shared },
				additionalProperties: false,
			},
		]
		const parsed = orders.map((schema) =>
			createContract(schemaToShape(schema)).parse({ plain: {}, joined: {} }),
		)

		expect(parsed).toEqual([
			{ plain: { a: 3 }, joined: {} },
			{ plain: { a: 3 }, joined: {} },
		])
	})

	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['oneOf', { oneOf: [closedOf({ type: 'number', default: 3 })] }],
		['anyOf', { anyOf: [closedOf({ type: 'number', default: 3 })] }],
		[
			'a type list',
			{
				type: ['object', 'null'],
				properties: { a: { type: 'number', default: 3 } },
				additionalProperties: false,
			},
		],
		[
			'a nested array',
			{ anyOf: [{ type: 'array', items: closedOf({ type: 'number', default: 3 }) }] },
		],
	])('drops a default below %s', (_label, schema) => {
		const emitted = JSON.stringify(compileSchema(schemaToShape(schema)))

		expect(emitted.includes('"default"')).toBe(false)
	})

	it('publishes a refusal when a default cannot be read', () => {
		const property: Readonly<Record<string, unknown>> = { type: 'number' }
		Object.defineProperty(property, 'default', {
			enumerable: true,
			get() {
				throw new Error('default read refused')
			},
		})

		expect(
			captureContractError(() => schemaToShape(closedOf(property))).message.startsWith(
				'schemaToShape:',
			),
		).toBe(true)
	})

	it('carries a default through the round trip of a compiled schema', () => {
		const shape = objectShape({ a: optionalShape(numberShape({ min: 0 }), { default: 3 }) })
		const schema = compileSchema(shape)

		expect(compileSchema(schemaToShape(schema))).toEqual(schema)
	})

	it('keeps a schema with no default exactly as it converted before', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { a: { type: 'number' } },
		}

		expect(compileSchema(schemaToShape(schema))).toEqual({
			type: 'object',
			properties: { a: { type: 'number' } },
			additionalProperties: true,
		})
		expect(compileGuard(schemaToShape(schema))({ z: 1 })).toBe(true)
	})
})

describe('SchemaShaper — strict', () => {
	it.each(STRICT_SCHEMA_REFUSALS)('refuses %s with structure', (_label, schema, path) => {
		const error = captureContractError(() => schemaToShape(schema, { strict: true }))

		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(path)
	})

	it('leaves every row of that table accepted by the lenient conversion', () => {
		const rows = STRICT_SCHEMA_REFUSALS.filter(
			([_label, schema]) => attempt(() => createContract(schemaToShape(schema))).success,
		)

		expect(rows.length).toBe(STRICT_SCHEMA_REFUSALS.length)
	})

	it('closes an object with no additionalProperties', () => {
		const contract = createContract(
			schemaToShape(
				{ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
				{ strict: true },
			),
		)

		expect(contract.schema.additionalProperties).toBe(false)
		expect(contract.is({ a: 'x' })).toBe(true)
		expect(contract.is({ a: 'x', licenced: false })).toBe(false)
		expect(contract.audit({ a: 'x', licenced: false }).map((fault) => fault.reason)).toEqual([
			'extra',
		])
	})

	it('closes a nested object and one with no type keyword', () => {
		const contract = createContract(
			schemaToShape(
				{ properties: { a: { type: 'object', properties: { b: { type: 'string' } } } } },
				{ strict: true },
			),
		)

		expect(contract.is({ a: { b: 'x' } })).toBe(true)
		expect(contract.is({ z: 1 })).toBe(false)
		expect(contract.is({ a: { z: 1 } })).toBe(false)
	})

	it('keeps an object its schema opens', () => {
		const open = createContract(
			schemaToShape({ type: 'object', additionalProperties: true }, { strict: true }),
		)
		const tail = createContract(
			schemaToShape({ type: 'object', additionalProperties: { type: 'number' } }, { strict: true }),
		)

		expect(open.is({ z: 'x' })).toBe(true)
		expect(tail.is({ z: 1 })).toBe(true)
		expect(tail.is({ z: 'x' })).toBe(false)
	})

	it('accepts the vocabulary it can honour', () => {
		const accepted: readonly JSONSchema[] = [
			{ type: 'string', minLength: 1, maxLength: 3, description: 'text' },
			{ type: 'number', minimum: 0, maximum: 9 },
			{ type: 'integer', minimum: 0, maximum: 9 },
			{ type: 'boolean' },
			{ type: 'null' },
			{ enum: ['a', 1, true] },
			{ enum: ['a', 'b'], description: 'text' },
			{ type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 2 },
			{ type: 'object' },
			{ oneOf: [{ type: 'string' }, { type: 'number' }] },
			{ anyOf: [{ type: 'string' }, { type: 'number' }] },
		]

		expect(
			accepted.map((schema) =>
				JSON.stringify(compileSchema(schemaToShape(schema, { strict: true }))),
			),
		).toEqual(
			accepted.map((schema) =>
				JSON.stringify(compileSchema(schemaToShape({ ...schema, ...closedWhenObject(schema) }))),
			),
		)
	})

	it('accepts an enum beside the type every member satisfies', () => {
		const schemas: ReadonlyArray<Readonly<Record<string, unknown>>> = [
			{ type: 'string', enum: ['a', 'b'] },
			{ type: 'number', enum: [1, 2.5] },
			{ type: 'integer', enum: [1, 2] },
			{ type: 'boolean', enum: [true] },
			{ type: ['string', 'number'], enum: ['a', 1] },
		]

		expect(schemas.map((schema) => schemaToShape(schema, { strict: true }).category)).toEqual(
			schemas.map(() => 'literal'),
		)
		expect(
			captureContractError(() => schemaToShape({ type: 'integer', enum: [1.5] }, { strict: true }))
				.context?.path,
		).toEqual(['enum'])
	})

	it('accepts bounds that apply to a member of a type list', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: ['string', 'number'],
			minLength: 2,
			minimum: 5,
		}
		const guard = compileGuard(schemaToShape(schema, { strict: true }))

		expect(guard('xy')).toBe(true)
		expect(guard('x')).toBe(false)
		expect(guard(5)).toBe(true)
		expect(guard(4)).toBe(false)
	})

	it('carries a default of any inner, the full guard judging it at compile', () => {
		const schema = closedOf({
			type: 'object',
			properties: { b: { type: 'number' } },
			required: ['b'],
			default: { b: 2 },
		})
		const bad = closedOf({
			type: 'object',
			properties: { b: { type: 'number' } },
			required: ['b'],
			default: { b: 'x' },
		})

		expect(compileParser(schemaToShape(schema, { strict: true }))({})).toEqual({ a: { b: 2 } })
		expect(
			captureContractError(() => createContract(schemaToShape(bad, { strict: true }))).code,
		).toBe('structure')
	})

	it('refuses a default where it cannot fill, with placement', () => {
		const schemas: readonly JSONSchema[] = [
			{ anyOf: [closedOf({ type: 'number', default: 3 })] },
			{
				type: 'object',
				properties: { a: { type: 'number', default: 3 } },
				additionalProperties: true,
			},
		]

		expect(
			schemas.map(
				(schema) => captureContractError(() => schemaToShape(schema, { strict: true })).code,
			),
		).toEqual(['placement', 'placement'])
	})

	it('refuses breadth past the limit', () => {
		const wide = Array.from({ length: INFER_BREADTH_LIMIT + 1 }, () => ({ type: 'string' }))
		const properties = Object.fromEntries(
			Array.from({ length: INFER_BREADTH_LIMIT + 1 }, (_entry, index) => [
				`k${String(index)}`,
				{ type: 'string' },
			]),
		)
		const schemas: ReadonlyArray<Readonly<Record<string, unknown>>> = [
			{ oneOf: wide },
			{ anyOf: wide },
			{ type: 'object', properties },
		]
		const refusals = schemas.map(
			(schema) => captureContractError(() => schemaToShape(schema, { strict: true })).code,
		)

		expect(refusals).toEqual(['structure', 'structure', 'structure'])
	})

	it('refuses depth past the limit and a cycle', () => {
		const deep = Array.from({ length: INFER_DEPTH_LIMIT + 2 }).reduce<JSONSchema>(
			(items) => ({ type: 'array', items }),
			{ type: 'string' },
		)
		const refusals = [deep, buildCycle(true)].map(
			(schema) => captureContractError(() => schemaToShape(schema, { strict: true })).code,
		)

		expect(refusals).toEqual(['structure', 'structure'])
	})

	it('refuses a root that is not a record', () => {
		const roots: readonly unknown[] = [null, 3, 'x', [], undefined]
		const codes = roots.map(
			(root) =>
				captureContractError(() =>
					Reflect.apply(schemaToShape, undefined, [root, { strict: true }]),
				).code,
		)

		expect(codes).toEqual(roots.map(() => 'structure'))
	})

	it('publishes a hostile read under the door name', () => {
		const hostile: JSONSchema = { type: 'string' }
		Object.defineProperty(hostile, 'description', {
			enumerable: true,
			get() {
				throw new Error('keyword read refused')
			},
		})
		const error = captureContractError(() => schemaToShape(hostile, { strict: true }))

		expect(error.message).toBe('schemaToShape: schema could not be read')
		expect(error.code).toBe('structure')
	})

	it('refuses a strict option that is not a boolean', () => {
		const options: readonly unknown[] = [{ strict: 'yes' }, { strict: 1 }, { strict: null }, []]
		const codes = options.map(
			(option) =>
				captureContractError(() =>
					Reflect.apply(schemaToShape, undefined, [{ type: 'string' }, option]),
				).code,
		)

		expect(codes).toEqual(options.map(() => 'structure'))
	})

	it('stays lenient when strict is false or absent', () => {
		expect(schemaToShape({}, { strict: false }).category).toBe('raw')
		expect(schemaToShape({}, {}).category).toBe('raw')
		expect(schemaToShape({}).category).toBe('raw')
	})

	it('stays lenient when strict is only inherited', () => {
		const category = pollutePrototype(
			Object.prototype,
			'strict',
			() => true,
			() => schemaToShape({}, {}).category,
		)

		expect(category).toBe('raw')
	})

	it('round-trips a compiled defaulted schema', () => {
		const shape = objectShape({
			a: optionalShape(numberShape({ min: 0 }), { default: 3 }),
			b: optionalShape(arrayShape(stringShape()), { default: ['x'] }),
			c: literalShape(['low', 'high']),
			d: unionShape(stringShape(), nullShape()),
		})
		const schema = compileSchema(shape)

		expect(compileSchema(schemaToShape(schema, { strict: true }))).toEqual(schema)
	})
})
