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
	nullableShape,
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
	buildClosedKeyword,
	buildSharedSchema,
	buildWideSchema,
	findAgreementViolations,
	FOREIGN_SCHEMA_ROWS,
	LENIENT_DEFAULT_DROPS,
	polluteArrayConstruction,
	pollutePrototype,
	captureContractError,
	STRICT_SCHEMA_ANNOTATIONS,
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
			{ anyOf: [{ type: 'string' }, { type: 'integer' }] },
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

describe('SchemaShaper — a value its schema accepts', () => {
	it.each(FOREIGN_SCHEMA_ROWS)('answers for %s', (_name, schema, value, admits) => {
		const contract = createContract(schemaToShape(schema))

		expect(contract.is(value)).toBe(admits)
		expect(contract.audit(value).length === 0).toBe(admits)
		expect(contract.explain(value).length === 0).toBe(admits)
		expect(contract.parse(value)).toEqual(admits ? value : undefined)
	})

	it.each(FOREIGN_SCHEMA_ROWS)('keeps the laws for %s', (_name, schema, value) => {
		expect(findAgreementViolations(schemaToShape(schema), undefined, [value])).toEqual([])
	})

	it('names every row it expects a shape to refuse', () => {
		const refused = FOREIGN_SCHEMA_ROWS.filter(([, , , admits]) => !admits).map(([name]) => name)

		expect(refused).toEqual([
			'null on a string property',
			'an object for a string',
			'a missing required key',
		])
	})
})

describe('SchemaShaper — lenient oneOf', () => {
	const discriminated: Readonly<Record<string, unknown>> = {
		oneOf: [
			{ type: 'object', properties: { kind: { const: 'a' } }, required: ['kind'] },
			{ type: 'object', properties: { kind: { const: 'b' } }, required: ['kind'] },
		],
	}

	it('builds an inclusive union, so arms it widened cannot overlap into a refusal', () => {
		const shape = schemaToShape(discriminated)
		const contract = createContract(shape)

		expect(shape.category === 'union' ? shape.mode : 'not a union').toBeUndefined()
		expect(contract.is({ kind: 'a' })).toBe(true)
		expect(contract.parse({ kind: 'a' })).toEqual({ kind: 'a' })
		expect(contract.explain({ kind: 'a' })).toEqual([])
		expect(contract.is({})).toBe(false)
	})

	it('accepts a value two widened arms both match', () => {
		const schema: Readonly<Record<string, unknown>> = {
			oneOf: [{ type: 'number' }, { type: 'integer' }],
		}
		const guard = compileGuard(schemaToShape(schema))

		expect(guard(3)).toBe(true)
		expect(guard(3.5)).toBe(true)
		expect(guard('x')).toBe(false)
	})

	it('keeps exactly-one in a strict conversion', () => {
		const schema: Readonly<Record<string, unknown>> = {
			oneOf: [{ type: 'number' }, { type: 'integer' }],
		}
		const shape = schemaToShape(schema, { strict: true })
		const guard = compileGuard(shape)

		expect(shape.category === 'union' ? shape.mode : 'not a union').toBe('oneOf')
		expect(guard(3.5)).toBe(true)
		expect(guard(3)).toBe(false)
	})

	it('compiles a strict oneOf of closed objects', () => {
		const contract = createContract(
			schemaToShape(
				{
					oneOf: [
						{
							type: 'object',
							properties: { kind: { enum: ['a'] } },
							required: ['kind'],
							additionalProperties: false,
						},
						{
							type: 'object',
							properties: { kind: { enum: ['b'] } },
							required: ['kind'],
							additionalProperties: false,
						},
					],
				},
				{ strict: true },
			),
		)

		expect(contract.is({ kind: 'a' })).toBe(true)
		expect(contract.is({ kind: 'c' })).toBe(false)
	})
})

describe('SchemaShaper — boolean arms', () => {
	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['anyOf', { anyOf: [true, { type: 'string' }] }],
		['oneOf', { oneOf: [true, { type: 'string' }] }],
	])('reads a true arm of %s as accepting anything', (_label, schema) => {
		const contract = createContract(schemaToShape(schema))

		expect(contract.is(5)).toBe(true)
		expect(contract.parse(5)).toBe(5)
	})

	it('keeps a true arm in declaration order', () => {
		const anyOf: Readonly<Record<string, unknown>> = { anyOf: [{ type: 'string' }, true] }

		expect(compileSchema(schemaToShape(anyOf))).toEqual({ anyOf: [{ type: 'string' }, {}] })
	})

	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['anyOf', { anyOf: [false, { type: 'string' }] }],
		['oneOf', { oneOf: [false, { type: 'string' }] }],
	])('drops a false arm of %s, which admits nothing', (_label, schema) => {
		const guard = compileGuard(schemaToShape(schema))

		expect(guard('x')).toBe(true)
		expect(guard(5)).toBe(false)
	})

	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['anyOf', { anyOf: [false] }],
		['oneOf', { oneOf: [false, false] }],
	])('widens %s when its false arms leave the list empty', (_label, schema) => {
		expect(schemaToShape(schema).category).toBe('raw')
	})

	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['anyOf', { type: 'string', anyOf: [false] }],
		['oneOf', { type: 'string', oneOf: [false] }],
	])('widens past a type beside %s when its false arms leave the list empty', (_label, schema) => {
		const shape = schemaToShape(schema)

		expect(shape.category).toBe('raw')
		expect(compileGuard(shape)(5)).toBe(true)
	})

	it('leaves an empty list and a beside type as they were', () => {
		const empty: Readonly<Record<string, unknown>> = { type: 'string', anyOf: [] }

		expect(schemaToShape(empty).category).toBe('string')
	})
})

describe('SchemaShaper — enum partition', () => {
	it('wraps literals in a nullable when the list holds null', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: ['string', 'null'],
			enum: ['c', 'f', null],
		}
		const guard = compileGuard(schemaToShape(schema))

		expect(guard(null)).toBe(true)
		expect(guard('c')).toBe(true)
		expect(guard('x')).toBe(false)
	})

	it('builds a null shape from null alone', () => {
		const schema: Readonly<Record<string, unknown>> = { enum: [null] }
		const shape = schemaToShape(schema)

		expect(shape.category).toBe('null')
		expect(compileGuard(shape)(null)).toBe(true)
		expect(compileGuard(shape)('x')).toBe(false)
	})

	it.each<readonly [string, readonly unknown[]]>([
		['an object', [{ a: 1 }, 'x']],
		['an array', [[1], 'x']],
		['a non-finite number', [Number.POSITIVE_INFINITY, 'x']],
	])('widens the node when the list holds %s', (_label, members) => {
		const schema: Readonly<Record<string, unknown>> = { enum: members }

		expect(schemaToShape(schema).category).toBe('raw')
	})

	it('accepts an object entry the list names', () => {
		const schema: Readonly<Record<string, unknown>> = { enum: [{ a: 1 }, 'x'] }

		expect(compileGuard(schemaToShape(schema))({ a: 1 })).toBe(true)
	})

	it('keeps literals alone exactly as they converted', () => {
		const schema: Readonly<Record<string, unknown>> = { enum: ['a', 'a', 1] }

		expect(compileSchema(schemaToShape(schema))).toEqual({ enum: ['a', 1] })
	})

	it('falls through an empty list to the next keyword', () => {
		const schema: Readonly<Record<string, unknown>> = { enum: [], type: 'string' }

		expect(schemaToShape(schema).category).toBe('string')
	})
})

describe('SchemaShaper — nullable keyword', () => {
	it('wraps the converted node when the keyword is true', () => {
		const schema: Readonly<Record<string, unknown>> = { type: 'string', nullable: true }
		const guard = compileGuard(schemaToShape(schema))

		expect(guard(null)).toBe(true)
		expect(guard('x')).toBe(true)
		expect(guard(5)).toBe(false)
	})

	it('ignores any other value', () => {
		const values: readonly unknown[] = [false, 'true', 1, null]
		const shapes = values.map((nullable) => {
			const schema: Readonly<Record<string, unknown>> = { type: 'string', nullable }
			return schemaToShape(schema).category
		})

		expect(shapes).toEqual(values.map(() => 'string'))
	})

	it('wraps a type list once', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: ['string', 'number'],
			nullable: true,
		}
		const shape = schemaToShape(schema)

		expect(shape.category).toBe('nullable')
		expect(shape.category === 'nullable' ? shape.inner.category : undefined).toBe('union')
	})

	it('wraps an object and keeps its fields', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: 'object',
			nullable: true,
			properties: { a: { type: 'string' } },
			required: ['a'],
		}
		const guard = compileGuard(schemaToShape(schema))

		expect(guard(null)).toBe(true)
		expect(guard({ a: 'x' })).toBe(true)
		expect(guard({})).toBe(false)
	})
})

describe('SchemaShaper — patternProperties', () => {
	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		[
			'patternProperties beside a closed object',
			{ patternProperties: {}, additionalProperties: false },
		],
		[
			'patternProperties beside a tail',
			{ patternProperties: {}, additionalProperties: { type: 'number' } },
		],
		['patternProperties with no additionalProperties', { patternProperties: {} }],
	])('reads the object open under %s', (_label, keywords) => {
		const schema: Readonly<Record<string, unknown>> = { type: 'object', ...keywords }
		const shape = schemaToShape(schema)

		expect(shape.category === 'object' ? shape.additionalProperties : 'not an object').toBe(true)
		expect(compileGuard(shape)({ 'x-a': 'b' })).toBe(true)
	})

	it('leaves the declared properties constrained', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: 'object',
			properties: { a: { type: 'string' } },
			patternProperties: { '^x-': {} },
			additionalProperties: false,
		}
		const guard = compileGuard(schemaToShape(schema))

		expect(guard({ a: 'x', 'x-b': 1 })).toBe(true)
		expect(guard({ a: 5 })).toBe(false)
	})

	it('drops a default beside them, on the object they open', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: 'object',
			properties: { a: { type: 'number', default: 3 } },
			patternProperties: { '^x-': {} },
			additionalProperties: false,
		}

		expect(compileParser(schemaToShape(schema))({})).toEqual({})
	})
})

describe('SchemaShaper — prefixItems', () => {
	it('reads every element as unconstrained', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: 'array',
			prefixItems: [{ type: 'string' }],
			items: { type: 'number' },
		}
		const shape = schemaToShape(schema)

		expect(shape.category === 'array' ? shape.items.category : 'not an array').toBe('raw')
		expect(compileGuard(shape)(['a', 1])).toBe(true)
		expect(compileGuard(shape)('a')).toBe(false)
	})

	it('keeps the length bounds', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: 'array',
			prefixItems: [{ type: 'string' }],
			minItems: 1,
			maxItems: 2,
		}
		const guard = compileGuard(schemaToShape(schema))

		expect(guard([])).toBe(false)
		expect(guard(['a', 1])).toBe(true)
		expect(guard(['a', 1, 2])).toBe(false)
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
				properties: { plain: shared, joined: { anyOf: [shared, { type: 'string' }] } },
				additionalProperties: false,
			},
			{
				type: 'object',
				properties: { joined: { anyOf: [shared, { type: 'string' }] }, plain: shared },
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

	it('keeps the two positions apart when both reach a node at one depth', () => {
		const shared = closedOf({ type: 'number', default: 3 })
		const plain = { type: 'object', properties: { plain: shared }, additionalProperties: false }
		const joined = { anyOf: [shared, { type: 'string' }] }
		const orders: ReadonlyArray<Readonly<Record<string, unknown>>> = [
			{
				type: 'object',
				properties: { wrap: plain, joined },
				additionalProperties: false,
			},
			{
				type: 'object',
				properties: { joined, wrap: plain },
				additionalProperties: false,
			},
		]
		const parsed = orders.map((schema) =>
			createContract(schemaToShape(schema)).parse({ wrap: { plain: {} }, joined: {} }),
		)

		expect(parsed).toEqual([
			{ wrap: { plain: { a: 3 } }, joined: {} },
			{ wrap: { plain: { a: 3 } }, joined: {} },
		])
	})

	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['oneOf', { oneOf: [closedOf({ type: 'number', default: 3 })] }],
		['anyOf', { anyOf: [closedOf({ type: 'number', default: 3 })] }],
		[
			'a type list of three',
			{
				type: ['object', 'string', 'null'],
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
			{ anyOf: [{ type: 'string' }, { type: 'number' }] },
		]

		expect(
			accepted.map((schema) =>
				JSON.stringify(compileSchema(schemaToShape(schema, { strict: true }))),
			),
		).toEqual(
			accepted.map((schema) =>
				JSON.stringify(compileSchema(schemaToShape({ ...schema, ...buildClosedKeyword(schema) }))),
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

	it.each<readonly [string, Readonly<Record<string, unknown>>, readonly string[]]>([
		[
			'under a root union',
			{ anyOf: [closedOf({ type: 'number', default: 3 })] },
			['anyOf', '0', 'properties', 'a', 'default'],
		],
		[
			'under a nested union',
			{
				type: 'object',
				properties: {
					o: {
						type: 'array',
						items: { oneOf: [closedOf({ type: 'number', default: 3 }), { type: 'string' }] },
					},
				},
			},
			['properties', 'o', 'items', 'oneOf', '0', 'properties', 'a', 'default'],
		],
		[
			'under an exactly-one union with a null arm',
			{ oneOf: [closedOf({ type: 'number', default: 3 }), { type: 'null' }] },
			['oneOf', '0', 'properties', 'a', 'default'],
		],
		[
			'on a root open object',
			{
				type: 'object',
				properties: { a: { type: 'number', default: 3 } },
				additionalProperties: true,
			},
			['properties', 'a', 'default'],
		],
		[
			'on a nested open object',
			{
				type: 'object',
				properties: {
					o: {
						type: 'object',
						properties: { a: { type: 'number', default: 3 } },
						additionalProperties: true,
					},
				},
			},
			['properties', 'o', 'properties', 'a', 'default'],
		],
		[
			'on an object with a tail',
			{
				type: 'object',
				properties: { a: { type: 'number', default: 3 } },
				additionalProperties: { type: 'string' },
			},
			['properties', 'a', 'default'],
		],
	])('refuses a default %s with placement at its schema path', (_label, schema, path) => {
		const error = captureContractError(() => schemaToShape(schema, { strict: true }))

		expect(error.code).toBe('placement')
		expect(error.context?.path).toEqual(path)
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

	it.each(STRICT_SCHEMA_ANNOTATIONS)('accepts the annotation %s', (keyword, value) => {
		const schema: Readonly<Record<string, unknown>> = { type: 'string', [keyword]: value }

		expect(schemaToShape(schema, { strict: true }).category).toBe('string')
	})

	it('converts the annotated object a schema generator emits', () => {
		const schema: Readonly<Record<string, unknown>> = {
			$schema: 'https://json-schema.org/draft/2020-12/schema',
			title: 'Member',
			type: 'object',
			properties: { name: { title: 'Name', type: 'string', examples: ['Ada'] } },
			required: ['name'],
		}
		const contract = createContract(schemaToShape(schema, { strict: true }))

		expect(contract.is({ name: 'Ada' })).toBe(true)
		expect(contract.is({ name: 'Ada', z: 1 })).toBe(false)
		expect(contract.schema).toEqual({
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
			additionalProperties: false,
		})
	})

	it('refuses a schema past the compile limit with expansion, at the compiler', () => {
		const shape = schemaToShape(buildWideSchema(91, 91), { strict: true })

		expect(captureContractError(() => createContract(shape)).code).toBe('expansion')
	})
})

describe('SchemaShaper — a large schema', () => {
	it('widens a tree past the compile limit, so a lenient contract always compiles', () => {
		const shape = schemaToShape(buildWideSchema(91, 91))
		const contract = createContract(shape)

		expect(shape.category).toBe('object')
		expect(contract.is({ k0: { p0: 'x' } })).toBe(true)
		expect(contract.is({ k0: 5 })).toBe(true)
		expect(contract.parse(5)).toBeUndefined()
	})

	it('keeps a tree at the compile limit typed', () => {
		const shape = schemaToShape(buildWideSchema(90, 90))
		const contract = createContract(shape)

		expect(shape.category).toBe('object')
		expect(contract.is({ k0: { p0: 'x' } })).toBe(true)
		expect(contract.is({ k0: 5 })).toBe(false)
	})

	it('widens a small schema whose shared node expands past the limit', () => {
		const shape = schemaToShape(buildSharedSchema(100, 200))

		expect(shape.category).toBe('object')
		expect(createContract(shape).is(5)).toBe(false)
		expect(createContract(shape).is({ k0: 5 })).toBe(true)
	})

	it('keeps a shared node that stays inside the limit typed', () => {
		const shape = schemaToShape(buildSharedSchema(3, 3))

		expect(shape.category).toBe('object')
		expect(createContract(shape).is({ k0: 5 })).toBe(false)
	})
})

describe('SchemaShaper — typeless properties', () => {
	const schema: Readonly<Record<string, unknown>> = {
		properties: { a: { type: 'string' } },
		required: ['a'],
	}

	it('admits what properties and required never constrain', () => {
		const guard = compileGuard(schemaToShape(schema))

		expect([5, 'x', true, null, [1]].map((value) => guard(value))).toEqual([
			true,
			true,
			true,
			true,
			true,
		])
	})

	it('keeps validating an object', () => {
		const contract = createContract(schemaToShape(schema))

		expect(contract.is({ a: 'x' })).toBe(true)
		expect(contract.is({})).toBe(false)
		expect(contract.is({ a: 5 })).toBe(false)
		expect(contract.parse({ a: 'x' })).toEqual({ a: 'x' })
		expect(contract.parse({ a: {} })).toBeUndefined()
		expect(contract.parse(5)).toBe(5)
	})

	it('builds the object arm first', () => {
		const emitted = compileSchema(schemaToShape(schema))

		expect(emitted.anyOf?.map((arm) => arm.type)).toEqual([
			'object',
			'string',
			'number',
			'boolean',
			'null',
			'array',
		])
	})

	it('drops a default under it, because the object sits in a union', () => {
		const closed: Readonly<Record<string, unknown>> = {
			properties: { a: { type: 'number', default: 3 } },
			additionalProperties: false,
		}

		expect(compileParser(schemaToShape(closed))({})).toEqual({})
	})

	it('stays an object in a strict conversion', () => {
		expect(schemaToShape(schema, { strict: true }).category).toBe('object')
	})
})

describe('SchemaShaper — a two-arm union with null', () => {
	const shape = objectShape({
		n: nullableShape(objectShape({ a: optionalShape(numberShape(), { default: 1 }) })),
	})

	it('survives its own schema in a strict conversion', () => {
		const schema = compileSchema(shape)
		const converted = schemaToShape(schema, { strict: true })

		expect(compileSchema(converted)).toEqual(schema)
		expect(compileParser(converted)({ n: {} })).toEqual({ n: { a: 1 } })
		expect(compileParser(converted)({ n: null })).toEqual({ n: null })
	})

	it('fills under it in a lenient conversion', () => {
		const parse = compileParser(schemaToShape(compileSchema(shape)))

		expect(parse({ n: {} })).toEqual({ n: { a: 1 } })
		expect(parse({ n: null })).toEqual({ n: null })
	})

	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['anyOf with null last', { anyOf: [{ type: 'string' }, { type: 'null' }] }],
		['anyOf with null first', { anyOf: [{ type: 'null' }, { type: 'string' }] }],
		['oneOf with null last', { oneOf: [{ type: 'string' }, { type: 'null' }] }],
		[
			'a described null arm',
			{ anyOf: [{ type: 'string' }, { type: 'null', description: 'none' }] },
		],
	])('reads %s as a nullable', (_label, schema) => {
		const converted = schemaToShape(schema)

		expect(converted.category).toBe('nullable')
		expect(converted.category === 'nullable' ? converted.inner.category : undefined).toBe('string')
		expect(compileGuard(converted)(null)).toBe(true)
		expect(compileGuard(converted)('x')).toBe(true)
		expect(compileGuard(converted)(5)).toBe(false)
	})

	it('reads an anyOf as a nullable in a strict conversion', () => {
		const schema: Readonly<Record<string, unknown>> = {
			anyOf: [{ type: 'string' }, { type: 'null' }],
		}

		expect(schemaToShape(schema, { strict: true }).category).toBe('nullable')
	})

	it('keeps a oneOf exactly-one in a strict conversion', () => {
		const schema: Readonly<Record<string, unknown>> = {
			oneOf: [{ type: 'string' }, { type: 'null' }],
		}
		const converted = schemaToShape(schema, { strict: true })

		expect(converted.category === 'union' ? converted.mode : 'not a union').toBe('oneOf')
	})

	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['three arms', { anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'null' }] }],
		['two null arms', { anyOf: [{ type: 'null' }, { type: 'null' }] }],
		['a true arm', { anyOf: [true, { type: 'null' }] }],
		['a null arm an enum outranks', { anyOf: [{ type: 'string' }, { type: 'null', enum: ['a'] }] }],
		['no null arm', { anyOf: [{ type: 'string' }, { type: 'number' }] }],
		[
			'a null arm a nested anyOf outranks',
			{ anyOf: [{ type: 'string' }, { type: 'null', anyOf: [{ type: 'number' }] }] },
		],
		[
			'a null arm a nested oneOf outranks',
			{ anyOf: [{ type: 'string' }, { type: 'null', oneOf: [{ type: 'number' }] }] },
		],
	])('leaves %s a union', (_label, schema) => {
		expect(schemaToShape(schema).category).toBe('union')
	})

	it('still inspects the null arm in a strict conversion', () => {
		const schema: Readonly<Record<string, unknown>> = {
			anyOf: [{ type: 'string' }, { type: 'null', bogus: 1 }],
		}
		const error = captureContractError(() => schemaToShape(schema, { strict: true }))

		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['anyOf', '1', 'bogus'])
	})
})

describe('SchemaShaper — a two-member type list with null', () => {
	const closed: Readonly<Record<string, unknown>> = {
		type: ['object', 'null'],
		properties: { a: { type: 'number', default: 1 } },
		additionalProperties: false,
	}

	it.each<readonly [string, boolean]>([
		['lenient', false],
		['strict', true],
	])('reads as a nullable in a %s conversion', (_label, strict) => {
		const listed: Readonly<Record<string, unknown>> = { type: ['integer', 'null'] }
		const reversed: Readonly<Record<string, unknown>> = { type: ['null', 'integer'] }
		const shapes = [schemaToShape(listed, { strict }), schemaToShape(reversed, { strict })]

		expect(shapes.map((shape) => shape.category)).toEqual(['nullable', 'nullable'])
		expect(
			shapes.map((shape) => (shape.category === 'nullable' ? shape.inner.category : undefined)),
		).toEqual(['number', 'number'])
	})

	it.each<readonly [string, boolean]>([
		['lenient', false],
		['strict', true],
	])('answers as the anyOf spelling does in a %s conversion', (_label, strict) => {
		const listed: Readonly<Record<string, unknown>> = { type: ['integer', 'null'] }
		const spelled: Readonly<Record<string, unknown>> = {
			anyOf: [{ type: 'integer' }, { type: 'null' }],
		}
		const lists = createContract(schemaToShape(listed, { strict }))
		const arms = createContract(schemaToShape(spelled, { strict }))
		const values: readonly unknown[] = ['5', 5, null, 'x', 1.5, {}]

		expect(values.map((value) => lists.parse(value))).toEqual(
			values.map((value) => arms.parse(value)),
		)
		expect(values.map((value) => lists.audit(value))).toEqual(
			values.map((value) => arms.audit(value)),
		)
		expect(lists.parse('5')).toBe(5)
		expect(lists.audit('5').map((fault) => fault.reason)).toEqual(['type'])
		expect(lists.schema).toEqual(arms.schema)
	})

	it('fills a default under it in both modes', () => {
		const lenient = createContract(schemaToShape(closed))
		const strict = createContract(schemaToShape(closed, { strict: true }))

		expect(lenient.parse({})).toEqual({ a: 1 })
		expect(strict.parse({})).toEqual({ a: 1 })
		expect(lenient.parse(null)).toBeNull()
		expect(strict.parse(null)).toBeNull()
	})

	it('keeps the keywords of the member beside the null', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: ['string', 'null'],
			minLength: 2,
			description: 'd',
		}
		const shape = schemaToShape(schema)
		const guard = compileGuard(shape)

		expect(guard(null)).toBe(true)
		expect(guard('xy')).toBe(true)
		expect(guard('x')).toBe(false)
		expect(shape.category === 'nullable' ? shape.inner : undefined).toMatchObject({
			category: 'string',
			description: 'd',
		})
	})

	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['three members', { type: ['string', 'number', 'null'] }],
		['two members with no null', { type: ['string', 'number'] }],
	])('leaves %s a union', (_label, schema) => {
		expect(schemaToShape(schema).category).toBe('union')
	})

	it('reads a duplicate list by its distinct names in a lenient conversion', () => {
		const schema: Readonly<Record<string, unknown>> = { type: ['string', 'string', 'null'] }

		expect(schemaToShape(schema).category).toBe('nullable')
	})

	it('reads a lone null as null', () => {
		const schema: Readonly<Record<string, unknown>> = { type: ['null'] }

		expect(schemaToShape(schema).category).toBe('null')
	})
})

describe('SchemaShaper — a description beside a union', () => {
	it.each<readonly [string, Readonly<Record<string, unknown>>, boolean]>([
		[
			'a lenient anyOf',
			{ description: 'd', anyOf: [{ type: 'string' }, { type: 'number' }] },
			false,
		],
		['a strict anyOf', { description: 'd', anyOf: [{ type: 'string' }, { type: 'number' }] }, true],
		[
			'a lenient oneOf',
			{ description: 'd', oneOf: [{ type: 'string' }, { type: 'number' }] },
			false,
		],
		['a strict oneOf', { description: 'd', oneOf: [{ type: 'string' }, { type: 'number' }] }, true],
	])('carries on %s', (_label, schema, strict) => {
		const converted = schemaToShape(schema, { strict })

		expect(converted.category === 'union' ? converted.description : 'not a union').toBe('d')
		expect(compileSchema(converted).description).toBe('d')
	})

	it('carries onto the arm of a two-arm union with null, the arm its own text gives way to', () => {
		const schema: Readonly<Record<string, unknown>> = {
			description: 'd',
			anyOf: [{ type: 'string', description: 'arm' }, { type: 'null' }],
		}
		const converted = schemaToShape(schema)

		expect(converted.category === 'nullable' ? converted.inner : undefined).toMatchObject({
			category: 'string',
			description: 'd',
		})
	})

	it('carries onto a raw arm of a two-arm union with null', () => {
		const schema: Readonly<Record<string, unknown>> = {
			description: 'd',
			anyOf: [{}, { type: 'null' }],
		}

		expect(compileSchema(schemaToShape(schema)).anyOf?.[0]?.description).toBe('d')
	})

	it('carries onto a nullable arm of a two-arm union with null', () => {
		const schema: Readonly<Record<string, unknown>> = {
			description: 'd',
			anyOf: [{ type: 'string', nullable: true }, { type: 'null' }],
		}
		const outer = schemaToShape(schema)
		const inner = outer.category === 'nullable' ? outer.inner : undefined

		expect(inner?.category === 'nullable' ? inner.inner : undefined).toMatchObject({
			category: 'string',
			description: 'd',
		})
	})

	it('carries on a typeless object union', () => {
		const schema: Readonly<Record<string, unknown>> = {
			description: 'd',
			properties: { a: { type: 'string' } },
		}

		expect(compileSchema(schemaToShape(schema)).description).toBe('d')
	})

	it('leaves a union with no description without one', () => {
		const schema: Readonly<Record<string, unknown>> = {
			anyOf: [{ type: 'string' }, { type: 'number' }],
		}

		expect(Object.hasOwn(schemaToShape(schema), 'description')).toBe(false)
	})
})

describe('schemaToShape — option keys', () => {
	it('refuses a misspelled option, naming it', () => {
		const schema: JSONSchema = { type: 'string' }
		const options: Readonly<Record<string, unknown>> = { strct: true }
		const error = captureContractError(() =>
			Reflect.apply(schemaToShape, undefined, [schema, options]),
		)

		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['strct'])
		expect(error.message).toContain('strict')
	})

	it('refuses an extra key beside a real one', () => {
		const options: Readonly<Record<string, unknown>> = { strict: true, extra: 1 }

		expect(
			captureContractError(() => Reflect.apply(schemaToShape, undefined, [{}, options])).context
				?.path,
		).toEqual(['extra'])
	})
})

describe('SchemaShaper — an unresolved reference', () => {
	it.each<readonly [string, Readonly<Record<string, unknown>>]>([
		['enum', { enum: ['a'] }],
		['type', { type: 'string' }],
		['a type list', { type: ['string', 'null'] }],
		['an object', { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] }],
		['a union', { oneOf: [{ type: 'string' }] }],
	])('widens before it reads %s beside the reference', (_label, siblings) => {
		const schema: Readonly<Record<string, unknown>> = {
			$ref: '#/definitions/Value',
			definitions: { Value: { type: 'number' } },
			...siblings,
		}
		const shape = schemaToShape(schema)

		expect(shape.category).toBe('raw')
		expect(compileGuard(shape)(5)).toBe(true)
	})

	it('keeps a description beside the reference', () => {
		const schema: Readonly<Record<string, unknown>> = { $ref: '#/x', description: 'd', enum: ['a'] }

		expect(compileSchema(schemaToShape(schema))).toEqual({ description: 'd' })
	})

	it('reads no null arm from a reference that names a null type', () => {
		const schema: Readonly<Record<string, unknown>> = {
			anyOf: [{ $ref: '#/x', type: 'null' }, { type: 'string' }],
		}

		expect(compileGuard(schemaToShape(schema))(5)).toBe(true)
	})

	it('refuses a reference in a strict conversion', () => {
		const schema: Readonly<Record<string, unknown>> = { $ref: '#/x', enum: ['a'] }
		const refused = captureContractError(() => schemaToShape(schema, { strict: true }))

		expect(refused.code).toBe('structure')
		expect(refused.context?.path).toEqual(['$ref'])
	})
})

describe('SchemaShaper — an object below a strict oneOf', () => {
	const refusal = 'declare additionalProperties'

	it.each<readonly [string, Readonly<Record<string, unknown>>, readonly string[]]>([
		[
			'an object arm',
			{
				oneOf: [
					{ type: 'object', properties: { a: { type: 'string' } } },
					{ type: 'object', properties: { b: { type: 'string' } } },
				],
			},
			['oneOf', '0', 'additionalProperties'],
		],
		[
			'a typeless arm',
			{ oneOf: [{ properties: { a: { type: 'string' } } }, { type: 'null' }] },
			['oneOf', '0', 'additionalProperties'],
		],
		[
			'a later arm',
			{
				oneOf: [
					{ type: 'object', properties: {}, additionalProperties: false },
					{ type: 'object', properties: { b: { type: 'string' } } },
				],
			},
			['oneOf', '1', 'additionalProperties'],
		],
		[
			'an object nested in an arm',
			{
				oneOf: [
					{ type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } },
					{ type: 'null' },
				],
			},
			['oneOf', '0', 'items', 'additionalProperties'],
		],
	])('refuses %s that leaves additionalProperties unsaid', (_label, schema, path) => {
		const refused = captureContractError(() => schemaToShape(schema, { strict: true }))

		expect(refused.code).toBe('structure')
		expect(refused.message).toContain(refusal)
		expect(refused.context?.path).toEqual(path)
	})

	it('refuses a node it already converted outside the oneOf', () => {
		const shared = { type: 'object', properties: { a: { type: 'string' } } }
		const schema: Readonly<Record<string, unknown>> = {
			type: 'object',
			properties: { plain: shared, pick: { oneOf: [shared, { type: 'null' }] } },
			additionalProperties: false,
		}
		const refused = captureContractError(() => schemaToShape(schema, { strict: true }))

		expect(refused.message).toContain(refusal)
		expect(refused.context?.path).toEqual([
			'properties',
			'pick',
			'oneOf',
			'0',
			'additionalProperties',
		])
	})

	it('refuses a node it already converted under an anyOf at the same depth', () => {
		const shared = { type: 'object', properties: { a: { type: 'string' } } }
		const schema: Readonly<Record<string, unknown>> = {
			type: 'object',
			properties: {
				either: { anyOf: [shared, { type: 'null' }, { type: 'string' }] },
				pick: { oneOf: [shared, { type: 'null' }] },
			},
			additionalProperties: false,
		}
		const refused = captureContractError(() => schemaToShape(schema, { strict: true }))

		expect(refused.context?.path).toEqual([
			'properties',
			'pick',
			'oneOf',
			'0',
			'additionalProperties',
		])
	})

	it('closes a silent object beside a oneOf, which it is not below', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: 'object',
			properties: {
				pick: { oneOf: [{ type: 'string' }, { type: 'null' }] },
				after: { type: 'object', properties: { a: { type: 'string' } } },
			},
			required: ['pick', 'after'],
			additionalProperties: false,
		}
		const guard = compileGuard(schemaToShape(schema, { strict: true }))

		expect(guard({ pick: null, after: { a: 'x' } })).toBe(true)
		expect(guard({ pick: null, after: { a: 'x', z: 1 } })).toBe(false)
	})

	it('keeps exactly-one over arms that overlap by what they declare', () => {
		const schema: Readonly<Record<string, unknown>> = {
			oneOf: [
				{ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true },
				{ type: 'object', properties: { b: { type: 'string' } }, additionalProperties: true },
			],
		}
		const guard = compileGuard(schemaToShape(schema, { strict: true }))

		expect(guard({ a: 'x' })).toBe(false)
		expect(guard({ a: 'x', b: 5 })).toBe(true)
	})

	it('keeps closing a silent object under a strict anyOf', () => {
		const schema: Readonly<Record<string, unknown>> = {
			anyOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'null' }],
		}
		const guard = compileGuard(schemaToShape(schema, { strict: true }))

		expect(guard({ a: 'x' })).toBe(true)
		expect(guard({ a: 'x', z: 1 })).toBe(false)
	})

	it('leaves a lenient oneOf inclusive and open', () => {
		const schema: Readonly<Record<string, unknown>> = {
			oneOf: [
				{ type: 'object', properties: { a: { type: 'string' } } },
				{ type: 'object', properties: { b: { type: 'string' } } },
			],
		}

		expect(compileGuard(schemaToShape(schema))({ a: 'x' })).toBe(true)
	})
})

describe('SchemaShaper — propertyNames', () => {
	it('leaves a closed object closed, since it exempts no key', () => {
		const schema: Readonly<Record<string, unknown>> = {
			type: 'object',
			propertyNames: { pattern: '^[a-z]+$' },
			additionalProperties: false,
		}
		const guard = compileGuard(schemaToShape(schema))

		expect(guard({ typo: 1 })).toBe(false)
		expect(guard({})).toBe(true)
	})

	it('leaves a tail applied, and a silent object open', () => {
		const tail: Readonly<Record<string, unknown>> = {
			type: 'object',
			propertyNames: {},
			additionalProperties: { type: 'number' },
		}
		const silent: Readonly<Record<string, unknown>> = { type: 'object', propertyNames: {} }

		expect(compileGuard(schemaToShape(tail))({ a: 1 })).toBe(true)
		expect(compileGuard(schemaToShape(tail))({ a: 'x' })).toBe(false)
		expect(compileGuard(schemaToShape(silent))({ a: 'x' })).toBe(true)
	})
})

describe('SchemaShaper — the root of a schema past the compile limit', () => {
	const closed = Array.from({ length: 14 }).reduce<Readonly<Record<string, unknown>>>(
		(child) => ({
			type: 'object',
			properties: { left: child, right: child },
			required: ['left', 'right'],
			additionalProperties: false,
		}),
		{ type: 'string' },
	)

	it('keeps a closed root, its type and its required keys, with raw values', () => {
		const contract = createContract(schemaToShape(closed))

		expect(contract.is(null)).toBe(false)
		expect(contract.is({})).toBe(false)
		expect(contract.is('wrong')).toBe(false)
		expect(contract.is({ left: 1 })).toBe(false)
		expect(contract.is({ left: 1, right: 2, extra: 3 })).toBe(false)
		expect(contract.is({ left: 1, right: 'x' })).toBe(true)
		expect(contract.audit({}).length).toBeGreaterThan(0)
		expect(contract.explain({ left: 1, right: 2 })).toEqual([])
	})

	it('keeps an optional key optional, and an open root open', () => {
		const contract = createContract(schemaToShape(buildWideSchema(91, 91)))

		expect(contract.is({})).toBe(true)
		expect(contract.is({ k0: 5, other: 1 })).toBe(true)
		expect(contract.is(5)).toBe(false)
	})

	it('widens a tail to raw and keeps the description', () => {
		const schema: Readonly<Record<string, unknown>> = {
			description: 'd',
			type: 'object',
			properties: { big: closed },
			required: ['big'],
			additionalProperties: closed,
		}
		const contract = createContract(schemaToShape(schema))

		expect(contract.schema.description).toBe('d')
		expect(contract.is({ big: 1, other: 2 })).toBe(true)
		expect(contract.is({})).toBe(false)
	})

	it('keeps a nullable root, and the bounds of an array root', () => {
		const nullable: Readonly<Record<string, unknown>> = { ...closed, nullable: true }
		const list: Readonly<Record<string, unknown>> = {
			type: 'array',
			items: closed,
			minItems: 1,
			maxItems: 2,
			description: 'd',
		}
		const lists = createContract(schemaToShape(list))

		expect(createContract(schemaToShape(nullable)).is(null)).toBe(true)
		expect(createContract(schemaToShape(nullable)).is({})).toBe(false)
		expect(lists.is([5])).toBe(true)
		expect(lists.is([])).toBe(false)
		expect(lists.is('x')).toBe(false)
		expect(lists.schema.description).toBe('d')
	})

	it('widens a root it cannot keep', () => {
		const schema: Readonly<Record<string, unknown>> = { anyOf: [closed, { type: 'string' }] }
		const shape = schemaToShape(schema)

		expect(shape.category).toBe('raw')
		expect(createContract(shape).is(5)).toBe(true)
	})

	it('keeps a strict conversion refusing at the compiler', () => {
		const shape = schemaToShape(buildWideSchema(91, 91), { strict: true })

		expect(captureContractError(() => createContract(shape)).code).toBe('expansion')
	})
})

describe('SchemaShaper — a null enum in a strict conversion', () => {
	it.each<
		readonly [string, Readonly<Record<string, unknown>>, readonly unknown[], readonly unknown[]]
	>([
		['a null type', { type: 'null', enum: [null] }, [null], ['a', 0, false]],
		['no type', { enum: [null] }, [null], ['a', 0]],
		['a literal beside it', { enum: ['a', null] }, ['a', null], ['b', 0]],
		['a type list', { type: ['string', 'null'], enum: ['a', null] }, ['a', null], ['b', 0]],
	])('reads %s as the lenient walk does', (_label, schema, accepted, refused) => {
		const guard = compileGuard(schemaToShape(schema, { strict: true }))

		expect(accepted.map((value) => guard(value))).toEqual(accepted.map(() => true))
		expect(refused.map((value) => guard(value))).toEqual(refused.map(() => false))
	})

	it('refuses a null a type leaves out, and a repeated null', () => {
		const excluded: Readonly<Record<string, unknown>> = { type: 'string', enum: ['a', null] }
		const repeated: Readonly<Record<string, unknown>> = { enum: [null, null] }

		expect(captureContractError(() => schemaToShape(excluded, { strict: true })).message).toContain(
			'contradicts the type',
		)
		expect(captureContractError(() => schemaToShape(repeated, { strict: true })).message).toContain(
			'unique',
		)
	})
})
