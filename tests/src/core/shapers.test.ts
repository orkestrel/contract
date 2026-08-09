import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
	ContractShape,
	Infer,
	InferMutable,
	JSONSchema,
	JSONValue,
	LiteralValue,
	NumberShape,
	ObjectShape,
	Result,
	StringShapeOptions,
	StringShape,
} from '@src/core'
import {
	arrayShape,
	attempt,
	booleanShape,
	buildObjectShape,
	buildShapeFromNode,
	compileGenerator,
	compileGuard,
	compileParser,
	compileReporter,
	compileSchema,
	ContractError,
	createContract,
	INFER_BREADTH_LIMIT,
	INFER_DEPTH_LIMIT,
	integerShape,
	isContractError,
	isRegExp,
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
	schemaNodeToShape,
	schemaToShape,
	seededRandom,
	stringShape,
	unionShape,
	valueToSchema,
} from '@src/core'
import type { Equal, Expect } from '../../setup.js'
import {
	buildCyclicArray,
	buildCyclicRecord,
	buildDeepNest,
	buildSparseArray,
	captureContractError,
	createClassInstance,
	createRevokedArrayProxy,
	createRevokedProxy,
	createHostileKeys,
	createNonEnumerableRecord,
	createStatefulGetter,
	createThrowingGetter,
	createUndefinedSchema,
	createUnstableArray,
	NullBaseDeclaration,
	SOUNDNESS_SAMPLE,
} from '../../setup.js'
import { createForeignRegExp } from '../../setupServer.js'

type BuilderRole = 'options' | 'shape' | 'properties' | 'values' | 'schema'

interface BuilderCase {
	readonly name: string
	readonly valid: readonly (readonly unknown[])[]
	readonly positions: Readonly<Record<number, BuilderRole>>
	readonly options?: Readonly<Record<number, readonly string[]>>
	run(args: readonly unknown[]): unknown
}

const BUILDER_CASES: readonly BuilderCase[] = [
	{
		name: 'stringShape',
		valid: [
			[],
			[{}],
			[{ description: 'value' }],
			[{ min: 0 }],
			[{ max: 4 }],
			[{ min: 1, max: 4 }],
			[{ pattern: /^x$/ }],
			[{ min: 1, pattern: /^x$/ }],
			[{ max: 4, description: 'value' }],
		],
		positions: { 0: 'options' },
		options: { 0: ['description', 'min', 'max', 'pattern'] },
		run: (args) => Reflect.apply(stringShape, undefined, [...args]),
	},
	{
		name: 'numberShape',
		valid: [
			[],
			[{}],
			[{ description: 'value' }],
			[{ min: -1 }],
			[{ max: 1 }],
			[{ min: -1, max: 1 }],
			[{ integer: false }],
			[{ integer: true, min: 0, max: 1 }],
		],
		positions: { 0: 'options' },
		options: { 0: ['description', 'min', 'max', 'integer'] },
		run: (args) => Reflect.apply(numberShape, undefined, [...args]),
	},
	{
		name: 'integerShape',
		valid: [
			[],
			[{}],
			[{ description: 'value' }],
			[{ min: -1 }],
			[{ max: 1 }],
			[{ min: 0, max: 1 }],
		],
		positions: { 0: 'options' },
		options: { 0: ['description', 'min', 'max'] },
		run: (args) => Reflect.apply(integerShape, undefined, [...args]),
	},
	{
		name: 'booleanShape',
		valid: [[], [{ description: 'value' }]],
		positions: { 0: 'options' },
		options: { 0: ['description'] },
		run: (args) => Reflect.apply(booleanShape, undefined, [...args]),
	},
	{
		name: 'nullShape',
		valid: [[], [{ description: 'value' }]],
		positions: { 0: 'options' },
		options: { 0: ['description'] },
		run: (args) => Reflect.apply(nullShape, undefined, [...args]),
	},
	{
		name: 'literalShape',
		valid: [[['x']], [[1]], [[true]], [['x', 1, true], { description: 'value' }]],
		positions: { 0: 'values', 1: 'options' },
		options: { 1: ['description'] },
		run: (args) => Reflect.apply(literalShape, undefined, [...args]),
	},
	{
		name: 'arrayShape',
		valid: [
			[stringShape()],
			[stringShape(), {}],
			[stringShape(), { description: 'value' }],
			[stringShape(), { min: 0 }],
			[stringShape(), { max: 2 }],
			[stringShape(), { min: 0, max: 2 }],
			[nullableShape(stringShape()), { max: 1 }],
		],
		positions: { 0: 'shape', 1: 'options' },
		options: { 1: ['description', 'min', 'max'] },
		run: (args) => Reflect.apply(arrayShape, undefined, [...args]),
	},
	{
		name: 'objectShape',
		valid: [
			[{}],
			[{ value: stringShape() }],
			[{ value: optionalShape(stringShape()) }],
			[{}, { description: 'value' }],
			[{}, { additionalProperties: true }],
			[{}, { additionalProperties: false }],
			[{}, { additionalProperties: stringShape(), description: 'value' }],
		],
		positions: { 0: 'properties', 1: 'options' },
		options: { 1: ['description', 'additionalProperties'] },
		run: (args) => Reflect.apply(objectShape, undefined, [...args]),
	},
	{
		name: 'recordShape',
		valid: [[stringShape()], [numberShape(), {}], [booleanShape(), { description: 'value' }]],
		positions: { 0: 'shape', 1: 'options' },
		options: { 1: ['description'] },
		run: (args) => Reflect.apply(recordShape, undefined, [...args]),
	},
	{
		name: 'unionShape',
		valid: [
			[stringShape()],
			[stringShape(), numberShape()],
			[stringShape(), numberShape(), nullShape()],
		],
		positions: { 0: 'shape', 1: 'shape' },
		run: (args) => Reflect.apply(unionShape, undefined, [...args]),
	},
	{
		name: 'oneOfShape',
		valid: [[stringShape()], [stringShape(), numberShape()]],
		positions: { 0: 'shape', 1: 'shape' },
		run: (args) => Reflect.apply(oneOfShape, undefined, [...args]),
	},
	{
		name: 'optionalShape',
		valid: [[stringShape()], [nullableShape(stringShape())]],
		positions: { 0: 'shape' },
		run: (args) => Reflect.apply(optionalShape, undefined, [...args]),
	},
	{
		name: 'nullableShape',
		valid: [[stringShape()], [arrayShape(stringShape())]],
		positions: { 0: 'shape' },
		run: (args) => Reflect.apply(nullableShape, undefined, [...args]),
	},
	{
		name: 'jsonShape',
		valid: [[], [{ description: 'value' }]],
		positions: { 0: 'options' },
		options: { 0: ['description'] },
		run: (args) => Reflect.apply(jsonShape, undefined, [...args]),
	},
	{
		name: 'rawShape',
		valid: [[{}], [{ type: 'string' }], [{ anyOf: [{ type: 'string' }] }]],
		positions: { 0: 'schema' },
		run: (args) => Reflect.apply(rawShape, undefined, [...args]),
	},
]

describe('shape builders', () => {
	it('generates the builder argument matrix with hostile and legitimate controls', () => {
		const throwingGet = new Proxy(
			{ value: 1 },
			{
				get() {
					throw new Error('hostile get')
				},
			},
		)
		const throwingKeys = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile keys')
				},
			},
		)
		const throwingDescriptor = new Proxy(
			{ value: 1 },
			{
				getOwnPropertyDescriptor() {
					throw new Error('hostile descriptor')
				},
			},
		)
		const sparse = ['x', 'y']
		Reflect.deleteProperty(sparse, '1')
		const malformed = {
			options: [
				null,
				false,
				true,
				0,
				'x',
				[],
				new Date(),
				new Map(),
				throwingGet,
				throwingKeys,
				throwingDescriptor,
				createRevokedProxy(),
			],
			shape: [
				undefined,
				null,
				false,
				true,
				0,
				'x',
				[],
				{},
				new Date(),
				new Map(),
				createRevokedProxy(),
			],
			properties: [
				undefined,
				null,
				false,
				0,
				'x',
				[],
				new Date(),
				new Map(),
				{ value: null },
				throwingGet,
				throwingKeys,
				throwingDescriptor,
				createRevokedProxy(),
			],
			values: [
				undefined,
				null,
				false,
				0,
				'x',
				new String('x'),
				new Uint8Array([1]),
				{},
				new Date(),
				createRevokedArrayProxy(),
				['x', 'x'],
				[null],
				sparse,
			],
			schema: [
				undefined,
				null,
				false,
				true,
				0,
				'x',
				[],
				new Date(),
				new Map(),
				createRevokedProxy(),
				{ const: 'x' },
				{ properties: new Date() },
			],
		} satisfies Readonly<Record<BuilderRole, readonly unknown[]>>

		const legitimate = BUILDER_CASES.flatMap((builder) =>
			builder.valid.map((args) => ({
				builder: builder.name,
				outcome: attempt(() => builder.run(args)),
			})),
		)
		for (const result of legitimate) {
			expect(result.outcome.success, `${result.builder} rejected a legitimate call`).toBe(true)
		}

		const hostile: {
			readonly builder: string
			readonly position: number
			readonly outcome: Result<unknown>
		}[] = []
		for (const builder of BUILDER_CASES) {
			const base = builder.valid[0] ?? []
			for (const [positionText, role] of Object.entries(builder.positions)) {
				const position = Number(positionText)
				for (const value of malformed[role]) {
					const args = [...base]
					args[position] = value
					hostile.push({
						builder: builder.name,
						position,
						outcome: attempt(() => builder.run(args)),
					})
				}
			}
		}
		for (const result of hostile) {
			expect(
				result.outcome.success,
				`${result.builder} accepted malformed argument ${result.position}`,
			).toBe(false)
			if (result.outcome.success) continue
			expect(isContractError(result.outcome.error)).toBe(true)
		}

		const control = attempt(() => stringShape())
		const negative = attempt(() => Reflect.apply(stringShape, undefined, [null]))
		expect(control.success).toBe(true)
		expect(negative.success).toBe(false)
	})

	it('rejects every explicitly declared options read trap and accepts plain controls', () => {
		const nullPrototype: object = Object.create(null)
		const controls: readonly object[] = [
			{},
			Object.freeze({}),
			{ ...{ description: undefined } },
			nullPrototype,
			new Proxy(
				{},
				{
					get() {
						return undefined
					},
				},
			),
		]

		for (const builder of BUILDER_CASES) {
			const base = builder.valid[0] ?? []
			for (const [positionText, keys] of Object.entries(builder.options ?? {})) {
				const position = Number(positionText)
				for (const options of controls) {
					const args = [...base]
					args[position] = options
					expect(attempt(() => builder.run(args)).success).toBe(true)
				}

				for (const key of keys) {
					const getArgs = [...base]
					getArgs[position] = new Proxy(
						{},
						{
							get(_target, property) {
								if (property === key) throw new Error(`hostile get ${key}`)
								return undefined
							},
						},
					)
					const hasArgs = [...base]
					hasArgs[position] = new Proxy(
						{},
						{
							has(_target, property) {
								if (property === key) throw new Error(`hostile has ${key}`)
								return false
							},
						},
					)
					const descriptorArgs = [...base]
					descriptorArgs[position] = new Proxy(
						{},
						{
							getOwnPropertyDescriptor(_target, property) {
								if (property === key) throw new Error(`hostile descriptor ${key}`)
								return undefined
							},
						},
					)

					for (const args of [getArgs, hasArgs, descriptorArgs]) {
						const error = captureContractError(() => builder.run(args))
						expect(error.code).toBe('structure')
						expect(error.message).toBe(`${builder.name}: options could not be read`)
					}
				}

				const hostileKeys = [...base]
				hostileKeys[position] = new Proxy(
					{},
					{
						ownKeys() {
							throw new Error('hostile ownKeys')
						},
					},
				)
				const revoked = [...base]
				revoked[position] = createRevokedProxy()
				for (const args of [hostileKeys, revoked]) {
					const error = captureContractError(() => builder.run(args))
					expect(error.code).toBe('structure')
					expect(error.message).toBe(`${builder.name}: options could not be read`)
				}

				for (const primitive of [null, 0, 'x']) {
					const args = [...base]
					args[position] = primitive
					const error = captureContractError(() => builder.run(args))
					expect(error.message).toBe(`${builder.name}: options must be a plain record`)
				}
			}
		}
	})

	it('rejects the audit malformed-argument corpus with coded errors', () => {
		const errors = [
			captureContractError(() => Reflect.apply(stringShape, undefined, [null])),
			captureContractError(() => Reflect.apply(stringShape, undefined, [{ description: 5 }])),
			captureContractError(() => Reflect.apply(stringShape, undefined, [{ min: '1' }])),
			captureContractError(() => Reflect.apply(stringShape, undefined, [{ pattern: 'x' }])),
			captureContractError(() => Reflect.apply(numberShape, undefined, [null])),
			captureContractError(() => Reflect.apply(numberShape, undefined, [{ description: 5 }])),
			captureContractError(() => Reflect.apply(numberShape, undefined, [{ min: '1' }])),
			captureContractError(() => Reflect.apply(numberShape, undefined, [{ integer: 'yes' }])),
			captureContractError(() => Reflect.apply(integerShape, undefined, [{ description: 5 }])),
			captureContractError(() => Reflect.apply(integerShape, undefined, [{ min: '1' }])),
			captureContractError(() => Reflect.apply(booleanShape, undefined, [null])),
			captureContractError(() => Reflect.apply(booleanShape, undefined, [{ description: 5 }])),
			captureContractError(() => Reflect.apply(nullShape, undefined, [null])),
			captureContractError(() => Reflect.apply(nullShape, undefined, [{ description: 5 }])),
			captureContractError(() => Reflect.apply(literalShape, undefined, [undefined])),
			captureContractError(() => Reflect.apply(literalShape, undefined, [{ 0: 'x', length: 1 }])),
			captureContractError(() => Reflect.apply(literalShape, undefined, [[null]])),
			captureContractError(() =>
				Reflect.apply(literalShape, undefined, [['x'], { description: 5 }]),
			),
			captureContractError(() => Reflect.apply(arrayShape, undefined, [null])),
			captureContractError(() =>
				Reflect.apply(arrayShape, undefined, [stringShape(), { description: 5 }]),
			),
			captureContractError(() =>
				Reflect.apply(arrayShape, undefined, [stringShape(), { min: '1' }]),
			),
			captureContractError(() => Reflect.apply(objectShape, undefined, [null])),
			captureContractError(() => Reflect.apply(objectShape, undefined, [[]])),
			captureContractError(() =>
				Reflect.apply(objectShape, undefined, [{}, { additionalProperties: 1 }]),
			),
			captureContractError(() => Reflect.apply(objectShape, undefined, [{}, { description: 5 }])),
			captureContractError(() => Reflect.apply(recordShape, undefined, [undefined])),
			captureContractError(() => Reflect.apply(recordShape, undefined, [null])),
			captureContractError(() =>
				Reflect.apply(recordShape, undefined, [stringShape(), { description: 5 }]),
			),
			captureContractError(() => Reflect.apply(unionShape, undefined, [null])),
			captureContractError(() => Reflect.apply(unionShape, undefined, [])),
			captureContractError(() => Reflect.apply(oneOfShape, undefined, [null])),
			captureContractError(() => Reflect.apply(oneOfShape, undefined, [])),
			captureContractError(() => Reflect.apply(optionalShape, undefined, [null])),
			captureContractError(() => Reflect.apply(nullableShape, undefined, [null])),
			captureContractError(() => Reflect.apply(jsonShape, undefined, [null])),
			captureContractError(() => Reflect.apply(jsonShape, undefined, [{ description: 5 }])),
			captureContractError(() => Reflect.apply(rawShape, undefined, [[]])),
			captureContractError(() => Reflect.apply(rawShape, undefined, [null])),
			captureContractError(() => Reflect.apply(rawShape, undefined, [{ type: 'bogus' }])),
		]

		expect(errors.length).toBeGreaterThan(0)
		for (const error of errors) expect(typeof error.code).toBe('string')
	})

	it('rejects invalid string, array, and number bounds plus stateful patterns at construction', () => {
		expect(() => stringShape({ min: -1 })).toThrowError(ContractError)
		expect(() => stringShape({ max: 1.5 })).toThrowError(ContractError)
		expect(() => arrayShape(stringShape(), { min: Number.MAX_SAFE_INTEGER + 1 })).toThrowError(
			ContractError,
		)
		expect(() => numberShape({ max: Number.POSITIVE_INFINITY })).toThrowError(ContractError)
		expect(() => stringShape({ pattern: /^value$/g })).toThrowError(ContractError)

		const bound = captureContractError(() => stringShape({ min: -1 }))
		expect(bound).toBeInstanceOf(ContractError)
		expect(bound.code).toBe('bound')

		const pattern = captureContractError(() => stringShape({ pattern: /^value$/g }))
		expect(pattern).toBeInstanceOf(ContractError)
		expect(pattern.code).toBe('pattern')
		expect(pattern.message).toContain('inline pattern constructs')
	})

	it('applies the raw population and unflagged pattern declaration rules at builder doors', () => {
		const properties: Record<string, JSONSchema> = {}
		Reflect.set(properties, 'value', undefined)
		const anyOf: JSONSchema[] = []
		Reflect.set(anyOf, '0', undefined)
		const oneOf: JSONSchema[] = []
		Reflect.set(oneOf, '0', undefined)
		const nullProperties: Record<string, JSONSchema> = {}
		Reflect.set(nullProperties, 'value', null)

		for (const schema of [
			{ properties },
			{ anyOf },
			{ oneOf },
			{ properties: nullProperties },
		] satisfies readonly JSONSchema[]) {
			const error = captureContractError(() => rawShape(schema))
			expect(error.message).toBe(
				'validateShapeDepth: every raw schema child must be a plain record',
			)
			expect(error.code).toBe('structure')
			expect(error.context).toEqual({ path: ['schema'] })
			expect(Object.hasOwn(error, 'cause')).toBe(false)
		}

		for (const schema of [
			{},
			{ properties: {} },
			{ properties: { value: {} } },
			{ anyOf: [{}] },
			{ oneOf: [{}] },
			createUndefinedSchema('items'),
			createUndefinedSchema('additionalProperties'),
		] satisfies readonly JSONSchema[]) {
			expect(rawShape(schema).type).toBe('raw')
		}

		const flagged = captureContractError(() => stringShape({ min: 2, max: 1, pattern: /a/i }))
		expect(flagged.message).toBe(
			'stringShape: pattern must not use flags; use inline pattern constructs instead',
		)
		expect(flagged.code).toBe('pattern')
		expect(flagged.context).toEqual({ shape: 'string', received: '/a/i' })
		expect(Object.hasOwn(flagged, 'cause')).toBe(false)

		const plain = stringShape({ pattern: /a/ })
		const inline = stringShape({ pattern: /[aA]/ })
		expect(compileGuard(plain)('A')).toBe(false)
		expect(compileGuard(inline)('A')).toBe(true)
	})

	it('rejects non-RegExp string patterns with a coded ContractError', () => {
		for (const value of ['x', {}]) {
			const options: StringShapeOptions = JSON.parse('{}')
			Object.defineProperty(options, 'pattern', { value, enumerable: true })
			const error = captureContractError(() => stringShape(options))
			expect(error.code).toBe('pattern')
			expect(error.context?.shape).toBe('string')
		}
	})

	it('carries a consumed non-enumerable option into the built shape', () => {
		const options: { readonly min?: number } = {}
		Object.defineProperty(options, 'min', { value: 5, enumerable: false })
		const shape = stringShape(options)

		expect(Reflect.get(options, 'min')).toBe(5)
		expect(shape.min).toBe(5)
	})

	it('contains diagnostic coercion for every builder bound position', () => {
		const poison = {
			[Symbol.toPrimitive]() {
				throw new Error('poisoned')
			},
		}
		const cases: readonly (readonly [string, () => unknown])[] = [
			['stringShape.min', () => Reflect.apply(stringShape, undefined, [{ min: poison }])],
			['stringShape.max', () => Reflect.apply(stringShape, undefined, [{ max: poison }])],
			['numberShape.min', () => Reflect.apply(numberShape, undefined, [{ min: poison }])],
			['numberShape.max', () => Reflect.apply(numberShape, undefined, [{ max: poison }])],
			['integerShape.min', () => Reflect.apply(integerShape, undefined, [{ min: poison }])],
			['integerShape.max', () => Reflect.apply(integerShape, undefined, [{ max: poison }])],
			[
				'arrayShape.min',
				() => Reflect.apply(arrayShape, undefined, [stringShape(), { min: poison }]),
			],
			[
				'arrayShape.max',
				() => Reflect.apply(arrayShape, undefined, [stringShape(), { max: poison }]),
			],
		]

		for (const [position, run] of cases) {
			const error = captureContractError(run)
			expect({ position, code: error.code }).toEqual({ position, code: 'bound' })
		}
	})

	it('enumerates a caller-owned property declaration once and carries that snapshot', () => {
		let reads = 0
		const properties = new Proxy(
			{ a: stringShape(), b: stringShape() },
			{
				ownKeys(target) {
					reads += 1
					return reads === 1 ? Reflect.ownKeys(target) : ['a']
				},
			},
		)
		const contract = createContract(objectShape(properties))

		expect(reads).toBe(1)
		expect(Object.keys(contract.schema.properties ?? {})).toEqual(['a', 'b'])
		expect(contract.is({ a: 'a', b: 'b' })).toBe(true)
		expect(contract.is({ a: 'a' })).toBe(false)
	})

	it('integerShape rejects non-finite bounds like numberShape', () => {
		for (const bound of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const error = captureContractError(() => integerShape({ min: bound }))
			expect(error.code).toBe('bound')
			expect(error.context?.shape).toBe('integer')
		}
	})

	it('freezes every built shape and snapshots caller-owned collections', () => {
		const values = ['admin', 'guest']
		const literal = literalShape(values)
		const properties: Record<string, ContractShape> = { role: literal }
		const object = objectShape(properties)
		const variants: ContractShape[] = [object, nullShape()]
		const union = unionShape(...variants)

		values.push('owner')
		properties.extra = stringShape()
		variants.push(booleanShape())

		expect(literal.values).toEqual(['admin', 'guest'])
		expect(Object.hasOwn(object.properties, 'extra')).toBe(false)
		expect(union.variants).toHaveLength(2)
		expect(Object.isFrozen(values)).toBe(false)
		expect(Object.isFrozen(properties)).toBe(false)
		expect(Object.isFrozen(variants)).toBe(false)
		expect(Object.isFrozen(literal.values)).toBe(true)
		expect(Object.isFrozen(object.properties)).toBe(true)
		expect(Object.isFrozen(union.variants)).toBe(true)
		expect(Object.isFrozen(literal)).toBe(true)
		expect(Object.isFrozen(object)).toBe(true)
		expect(Object.isFrozen(union)).toBe(true)
		expect(Object.isFrozen(object.properties.role)).toBe(true)
	})

	it('snapshots a caller-owned RegExp so post-build compile mutation cannot drift artifacts', () => {
		const pattern = /^stable$/
		const shape = stringShape({ pattern })
		const guard = compileGuard(shape)
		const schema = compileSchema(shape)
		const contract = createContract(shape)

		pattern.compile('^drift$')

		expect(shape.pattern?.source).toBe('^stable$')
		expect(schema.pattern).toBe('^stable$')
		expect(guard('stable')).toBe(true)
		expect(guard('drift')).toBe(false)
		expect(contract.is('stable')).toBe(true)
		expect(contract.schema.pattern).toBe('^stable$')
	})

	it('accepts and owns an unflagged foreign RegExp while retaining the flag policy', () => {
		const pattern = createForeignRegExp('^foreign$')
		if (!isRegExp(pattern)) throw new Error('expected a genuine foreign RegExp')
		const shape = stringShape({ pattern })
		const guard = compileGuard(shape)

		Reflect.apply(RegExp.prototype.compile, pattern, ['^changed$'])

		expect(shape.pattern?.source).toBe('^foreign$')
		expect(guard('foreign')).toBe(true)
		expect(guard('changed')).toBe(false)

		const flagged = createForeignRegExp('^foreign$', 'i')
		if (!isRegExp(flagged)) throw new Error('expected a genuine flagged foreign RegExp')
		const error = captureContractError(() => stringShape({ pattern: flagged }))
		expect(error.code).toBe('pattern')
		expect(error.message).toBe(
			'stringShape: pattern must not use flags; use inline pattern constructs instead',
		)
	})

	it('keeps its owned pattern stable after compile mutation through the shape', () => {
		const shape = stringShape({ pattern: /^stable$/ })

		expect(shape.pattern).not.toBe(shape.pattern)
		expect(Object.isFrozen(shape.pattern)).toBe(true)
		expect(() => shape.pattern?.compile('^owned-drift$')).toThrowError(TypeError)
		expect(shape.pattern?.source).toBe('^stable$')
		expect(shape.pattern?.lastIndex).toBe(0)
		expect(compileSchema(shape).pattern).toBe('^stable$')

		const guard = compileGuard(shape)
		expect(guard('stable')).toBe(true)
		expect(guard('owned-drift')).toBe(false)
		expect(compileParser(shape)('stable')).toBe('stable')
		expect(compileParser(shape)('owned-drift')).toBeUndefined()
		expect(compileReporter(shape, 'stable')).toEqual([])
		expect(compileReporter(shape, 'owned-drift')).toEqual([
			expect.objectContaining({ reason: 'constraint', constraint: 'pattern', limit: '^stable$' }),
		])

		const generated = stringShape({ min: 1, max: 1, pattern: /^[a-z0-9]$/ })
		expect(() => generated.pattern?.compile('^owned-drift$')).toThrowError(TypeError)
		expect(compileGenerator(generated, () => 0)).toBe('a')
	})

	it('freezes roots from every shape builder', () => {
		const shapes: readonly ContractShape[] = [
			stringShape(),
			numberShape(),
			integerShape(),
			booleanShape(),
			nullShape(),
			literalShape(['value']),
			arrayShape(stringShape()),
			objectShape({ value: stringShape() }),
			recordShape(stringShape()),
			unionShape(stringShape()),
			oneOfShape(stringShape()),
			optionalShape(stringShape()),
			nullableShape(stringShape()),
			jsonShape(),
			rawShape({ type: 'string' }),
		]

		for (const shape of shapes) {
			expect(Object.isFrozen(shape)).toBe(true)
		}
	})

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

	it('literalShape copies primitive values before freezing them', () => {
		const values: LiteralValue[] = ['stable', 1, true]
		const shape = literalShape(values)

		values[0] = 'changed'
		expect(shape.values).toEqual(['stable', 1, true])
		expect(shape.values).not.toBe(values)
		expect(Object.isFrozen(shape.values)).toBe(true)
		expect(Object.isFrozen(values)).toBe(false)
	})

	it('literalShape validates and publishes the same indexed population', () => {
		const values = ['indexed-a', 'indexed-b']
		const substituted = ['iterated']
		Object.defineProperty(values, Symbol.iterator, {
			value: substituted[Symbol.iterator].bind(substituted),
		})

		const shape = literalShape(values)
		expect(shape.values).toEqual(['indexed-a', 'indexed-b'])
		expect(Object.isFrozen(shape.values)).toBe(true)
	})

	it('literalShape refuses a sparse indexed population', () => {
		const values: LiteralValue[] = []
		values.length = 2
		values[0] = 'present'

		const error = captureContractError(() => literalShape(values))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('validateShapeDepth: values must be a dense data array')
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

	it('rejects a missing record value shape instead of building a closed empty object', () => {
		const source: { readonly value: ContractShape } = JSON.parse('{}')
		const error = captureContractError(() => recordShape(source.value))

		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['additionalProperties'])
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

	it('rawShape owns and freezes nested schema state against caller mutation', () => {
		const child = { type: 'string', description: 'before' } satisfies JSONSchema
		const properties: Record<string, JSONSchema> = { value: child }
		const schema = { type: 'object', properties } satisfies JSONSchema
		const shape = rawShape(schema)

		child.description = 'after'
		properties.extra = { type: 'boolean' }
		expect(shape.schema.properties?.value?.description).toBe('before')
		expect(shape.schema.properties?.extra).toBeUndefined()
		expect(Object.isFrozen(shape.schema)).toBe(true)
		expect(Object.isFrozen(shape.schema.properties)).toBe(true)
		expect(Object.isFrozen(shape.schema.properties?.value)).toBe(true)
		expect(Object.isFrozen(schema)).toBe(false)
		expect(Object.isFrozen(properties)).toBe(false)
		expect(Object.isFrozen(child)).toBe(false)
	})

	it('validates the exact owned raw population after its caller precheck', () => {
		let reads = 0
		const schema = new Proxy({ type: 'string', minLength: 1 } satisfies JSONSchema, {
			get(target, property, receiver) {
				if (property !== 'minLength') return Reflect.get(target, property, receiver)
				reads += 1
				return reads === 1 ? 1 : -5
			},
		})

		const error = captureContractError(() => rawShape(schema))
		expect(reads).toBe(2)
		expect(error.code).toBe('structure')
		expect(error.message).toBe(
			'validateShapeDepth: raw schema length bounds must be non-negative safe integers',
		)
		expect(error.context?.path).toEqual(['schema'])
	})

	it('returns the one valid captured raw population and preserves earlier diagnostics', () => {
		let reads = 0
		const schema = new Proxy({ type: 'string', minLength: 1 } satisfies JSONSchema, {
			get(target, property, receiver) {
				if (property !== 'minLength') return Reflect.get(target, property, receiver)
				reads += 1
				return reads === 1 ? 1 : 3
			},
		})
		const shape = rawShape(schema)

		expect(reads).toBe(2)
		expect(shape.schema).not.toBe(schema)
		expect(shape.schema.minLength).toBe(3)
		expect(Object.isFrozen(shape.schema)).toBe(true)

		let invalidReads = 0
		const invalid = new Proxy({ type: 'string', minLength: -5 } satisfies JSONSchema, {
			get(target, property, receiver) {
				if (property === 'minLength') invalidReads += 1
				return Reflect.get(target, property, receiver)
			},
		})
		const invalidError = captureContractError(() => rawShape(invalid))
		expect(invalidReads).toBe(1)
		expect(invalidError.code).toBe('structure')

		let hostileReads = 0
		const hostile = new Proxy({ type: 'string', minLength: 1 } satisfies JSONSchema, {
			get(target, property, receiver) {
				if (property !== 'minLength') return Reflect.get(target, property, receiver)
				hostileReads += 1
				if (hostileReads > 1) throw new Error('clone read')
				return 1
			},
		})
		const hostileError = captureContractError(() => rawShape(hostile))
		expect(hostileReads).toBe(2)
		expect(hostileError.code).toBe('clone')
		expect(hostileError.message).toBe('cloneSchema: property access failed')
	})

	it('nullShape returns a bare null shape and threads its description', () => {
		expect(nullShape()).toEqual({ type: 'null' })
		expect(nullShape({ description: 'nothing' })).toEqual({
			type: 'null',
			description: 'nothing',
		})
	})

	it('jsonShape returns a bare json shape and threads its description', () => {
		expect(jsonShape()).toEqual({ type: 'json' })
		expect(jsonShape({ description: 'any JSON value' })).toEqual({
			type: 'json',
			description: 'any JSON value',
		})
	})
})

describe('Infer', () => {
	it('bails the widened ContractShape union out to unknown without recursive type explosion', () => {
		expectTypeOf<Infer<ContractShape>>().toEqualTypeOf<unknown>()

		const registry: Record<string, ContractShape> = {
			user: objectShape({ name: stringShape({ min: 1 }) }),
		}
		const contract = createContract(registry['user'] ?? stringShape())
		expect(contract.is({ name: 'Ada' })).toBe(true)
		expect(contract.parse({ name: 'Ada' })).toEqual({ name: 'Ada' })
		expect(
			contract.is(createContract(registry['user'] ?? stringShape()).generate(seededRandom(11))),
		).toBe(true)
	})

	it('distributes partial unions exactly', () => {
		expectTypeOf<Infer<StringShape | NumberShape>>().toEqualTypeOf<string | number>()
	})

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
		expectTypeOf<Infer<typeof user>['role']>().toEqualTypeOf<'admin' | 'guest'>()
	})

	it('derives null for a nullShape (compile-time)', () => {
		const shape = nullShape()
		const value: Infer<typeof shape> = null
		expect(value).toBeNull()
		expectTypeOf<Infer<typeof shape>>().toEqualTypeOf<null>()
	})

	it('derives JSONValue for a jsonShape (compile-time)', () => {
		const shape = jsonShape()
		const value: Infer<typeof shape> = { nested: [1, 'x', null] }
		expect(value).toEqual({ nested: [1, 'x', null] })
		const primitive: Infer<typeof shape> = 'a JSON value'
		expect(primitive).toBe('a JSON value')
		expectTypeOf<Infer<typeof shape>>().toEqualTypeOf<JSONValue>()
		const check: JSONValue = value
		expect(check).toBeDefined()
	})

	it('derives an index signature for recordShape values', () => {
		const rec = recordShape(numberShape())
		const v: Infer<typeof rec> = { a: 1 }
		const n = v.a
		if (n === undefined) throw new Error('recordShape omitted the seeded property')
		const checked: number = n
		expect(checked).toBe(1)
		expectTypeOf<Infer<typeof rec>>().toEqualTypeOf<Readonly<Record<string, number>>>()
	})

	it('mixed shape keeps named props at their declared types and infers extras as unknown', () => {
		const mixed = objectShape({ id: stringShape() }, { additionalProperties: numberShape() })
		const v: Infer<typeof mixed> = { id: 'x', extra: 42 }
		const id: string = v.id
		expect(id).toBe('x')
		const extra: unknown = v.extra
		expect(extra).toBe(42)
		expectTypeOf(v.extra).toEqualTypeOf<unknown>()
	})

	it('additionalProperties: true widens to an open unknown index', () => {
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
		expectTypeOf<InferMutable<typeof shape>>().toEqualTypeOf<{
			name: string
			profile: Readonly<{ bio: string }>
		}>()
		expect(value.profile.bio).toBe('hi')
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
					readonly args: { readonly [k: string]: LiteralValue }
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
					readonly value: LiteralValue
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

describe('Infer with widened additional properties', () => {
	it('keeps declared properties when additional properties use the full union', () => {
		expectTypeOf<Infer<ObjectShape<{ id: StringShape }, boolean | ContractShape>>>().toEqualTypeOf<
			Readonly<{ id: string }>
		>()

		const value = { id: 'abc' }
		expect(value.id).toBe('abc')
	})
})

describe('schemaToShape — round-trip law: compileGuard(schemaToShape(valueToSchema(v)))(v)', () => {
	it('round-trips every leaf kind', () => {
		for (const value of [null, true, false, 42, -0, 3.14, 'hello']) {
			for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
				expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
			}
		}
	})

	it('round-trips nested objects', () => {
		const value = { id: 1, name: 'Ada', address: { city: 'London', zip: '10001' } }
		for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
			expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
		}
	})

	it('round-trips homogeneous and heterogeneous arrays', () => {
		for (const value of [
			['a', 'b', 'c'],
			[1, 'x', true, 3.5],
		]) {
			for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
				expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
			}
		}
	})

	it('round-trips a sparse array at the root and at every nested entry point', () => {
		// `valueToSchema([1, , 3])` used to emit `{ type: 'array', items: { anyOf:
		// [{ type: 'integer' }, {}] } }`, whose own compiled guard REJECTED
		// `[1, , 3]` — the package published a schema that refused the value it was
		// derived from. A hole is an absent own property, so the node widens to the
		// accept-anything `{}` instead of reading a present `undefined` member.
		// The repair is re-asked at the two other entry points that reach the same
		// `inferArray` rule, because a fix verified only where it was found ships
		// the defect at every other door.
		const sparse = buildSparseArray()
		expect(valueToSchema(sparse)).toEqual({})
		for (const value of [sparse, { row: sparse }, [sparse]]) {
			expect(compileGuard(schemaToShape(valueToSchema(value)))(value)).toBe(true)
		}

		// The control that keeps this from passing vacuously: the DENSE sibling
		// still infers a real array schema — so the widening belongs to the hole,
		// not to arrays — and still round-trips.
		const dense = ['value', 'value', 'value']
		expect(valueToSchema(dense)).toEqual({ type: 'array', items: { type: 'string' } })
		for (const value of [dense, { row: dense }, [dense]]) {
			expect(compileGuard(schemaToShape(valueToSchema(value)))(value)).toBe(true)
		}
		expect(compileGuard(schemaToShape(valueToSchema(dense)))(sparse)).toBe(false)
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

	it('round-trips non-finite numbers (NaN / ±Infinity), which no JSON Schema type describes', () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
				expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
			}
		}
	})

	it('round-trips exotic originals (Map, Set, class instance, function, symbol, bigint)', () => {
		for (const value of [
			new Map([['a', 1]]),
			new Set([1, 2]),
			createClassInstance(),
			createClassInstance,
			Symbol('s'),
			10n,
		]) {
			for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
				expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
			}
		}
	})

	it('round-trips a record carrying an explicitly-undefined property (the schema opens instead of closing over a dropped key)', () => {
		const value = { a: 1, b: undefined }
		for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
			expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
		}
	})

	it('round-trips a record carrying only a non-enumerable own property', () => {
		const value = createNonEnumerableRecord('hidden', 'value')
		for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
			expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
		}
	})

	it('refuses unreadable hosts and still round-trips readable cycles', () => {
		for (const value of [createThrowingGetter(), createHostileKeys()]) {
			const fromValue = captureContractError(() => valueToSchema(value))
			const fromSamples = captureContractError(() => samplesToSchema([value]))
			expect(fromValue.code).toBe('structure')
			expect(fromValue.message).toBe('valueToSchema: value could not be read')
			expect(fromSamples.code).toBe('structure')
			expect(fromSamples.message).toBe('samplesToSchema: samples could not be read')
		}
		for (const value of [buildCyclicRecord(), buildCyclicArray()]) {
			for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
				expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
			}
		}
	})

	it('round-trips a nest deeper than INFER_DEPTH_LIMIT (both walks bottom out at the same budget)', () => {
		const value = buildDeepNest(INFER_DEPTH_LIMIT + 8)
		for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
			expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
		}
	})

	it('limits the round-trip law to stable advertised reads and ignores unrelated array readers', () => {
		// The third documented limit: inference samples the value once and the
		// compiled guard reads it again, so a property whose getter drifts describes
		// no single schema. A caller-defined slice is outside the shared own-index
		// lens and cannot make the two array walks disagree.
		const drifting = createStatefulGetter()
		expect(compileGuard(schemaToShape(valueToSchema(drifting)))(drifting)).toBe(false)
		const value = createUnstableArray()
		for (const schema of [valueToSchema(value), samplesToSchema([value])]) {
			expect(compileGuard(schemaToShape(schema))(value)).toBe(true)
		}
	})

	// The whole-corpus invariant: the guard inferred from ANY sample accepts that
	// sample. The exceptions are asserted EXPLICITLY (rather than filtered out of
	// the corpus) so a NEW dishonesty cannot hide behind them — each one is a
	// documented, deliberate limit of the inference direction, not an oversight.
	it('accepts every readable SOUNDNESS_SAMPLE member except the documented limits', () => {
		const rejected: unknown[] = []
		const refused: string[] = []
		for (const value of SOUNDNESS_SAMPLE) {
			const outcome = attempt(() => valueToSchema(value))
			if (!outcome.success) {
				refused.push(isContractError(outcome.error) ? outcome.error.message : 'raw')
				continue
			}
			if (!compileGuard(schemaToShape(outcome.value))(value)) rejected.push(value)
		}
		// In corpus order: `undefined` is absence, not a value — no compiled guard
		// accepts it (`rawShape` reserves it as the parser failure sentinel); and a
		// `Date`'s inferred schema describes its JSON SERIALIZATION, never the
		// runtime instance. A SPARSE array used to sit here as a third limit,
		// because inference read its holes as present `undefined` leaves and emitted
		// an array schema its own guard refused; it now widens to `{}` and
		// round-trips like every other JSON-inexpressible value.
		expect(rejected).toHaveLength(2)
		expect(rejected[0]).toBeUndefined()
		expect(rejected[1]).toBeInstanceOf(Date)
		expect(compileGuard(schemaToShape(valueToSchema(buildSparseArray())))(buildSparseArray())).toBe(
			true,
		)
		expect(refused).toEqual([
			'valueToSchema: value could not be read',
			'valueToSchema: value could not be read',
		])
	})

	it('accepts every readable SOUNDNESS_SAMPLE member for a samples-derived guard', () => {
		const rejected: unknown[] = []
		const refused: string[] = []
		for (const value of SOUNDNESS_SAMPLE) {
			const outcome = attempt(() => samplesToSchema([value]))
			if (!outcome.success) {
				refused.push(isContractError(outcome.error) ? outcome.error.message : 'raw')
				continue
			}
			if (!compileGuard(schemaToShape(outcome.value))(value)) rejected.push(value)
		}
		expect(rejected).toHaveLength(2)
		expect(rejected[0]).toBeUndefined()
		expect(rejected[1]).toBeInstanceOf(Date)
		expect(refused).toEqual([
			'samplesToSchema: samples could not be read',
			'samplesToSchema: samples could not be read',
		])
	})
})

describe('hand-authored shapes keep their strict semantics — only inference widens', () => {
	it('a user-declared numberShape still rejects NaN and ±Infinity', () => {
		const guard = compileGuard(numberShape())
		expect(guard(1.5)).toBe(true)
		expect(guard(Number.NaN)).toBe(false)
		expect(guard(Number.POSITIVE_INFINITY)).toBe(false)
		expect(guard(Number.NEGATIVE_INFINITY)).toBe(false)
	})

	it('a user-declared jsonShape still rejects non-JSON values', () => {
		const guard = compileGuard(jsonShape())
		expect(guard({ a: [1, 'x', null] })).toBe(true)
		expect(guard(new Map())).toBe(false)
		expect(guard(Number.NaN)).toBe(false)
		expect(guard(() => 1)).toBe(false)
	})

	it('widens to rawShape, never jsonShape, while emitting the identical schema', () => {
		expect(schemaToShape({})).toEqual(rawShape({}))
		expect(schemaToShape({ description: 'anything' })).toEqual(
			rawShape({ description: 'anything' }),
		)
		// Emission parity: the widened shape re-emits exactly what jsonShape did,
		// so compileSchema(schemaToShape(s)) is unchanged by the widening target.
		expect(compileSchema(schemaToShape({}))).toEqual({})
		expect(compileSchema(schemaToShape({ description: 'anything' }))).toEqual({
			description: 'anything',
		})
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

	it('widens oneOf/anyOf to rawShape when the record-variant count exceeds INFER_BREADTH_LIMIT, rather than narrowing to a subset union', () => {
		const variantCount = INFER_BREADTH_LIMIT + 10
		const variants: JSONSchema[] = []
		for (let index = 0; index < variantCount; index += 1) {
			variants.push({ enum: [`v${index}`] })
		}
		const schema: JSONSchema = { anyOf: variants }
		const guard = compileGuard(schemaToShape(schema))
		// A variant beyond the sampling cap must still be accepted — proving the
		// walk widened to rawShape instead of building a narrower subset union.
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

	it('completes and widens deep subtrees to rawShape at the depth limit', () => {
		let node: JSONSchema = { type: 'string' }
		for (let level = 0; level < 100; level += 1) {
			node = { type: 'object', properties: { child: node }, required: ['child'] }
		}
		expect(() => createContract(schemaToShape(node))).not.toThrow()
		const contract = createContract(schemaToShape(node))
		expect(contract.is).toBeDefined()
	})

	it('refuses a throwing-getter Proxy at every schema recursion entry', () => {
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
		const runs = [
			() => buildObjectShape(hostile, INFER_DEPTH_LIMIT, new WeakSet(), new WeakMap(), undefined),
			() => buildShapeFromNode(hostile, INFER_DEPTH_LIMIT, new WeakSet(), new WeakMap()),
			() => schemaNodeToShape(hostile, INFER_DEPTH_LIMIT, new WeakSet(), new WeakMap()),
			() => schemaToShape(hostile),
		]
		for (const run of runs) {
			const error = captureContractError(run)
			expect(error.code).toBe('structure')
			expect(error.context).toEqual({ shape: 'schema' })
		}
	})

	it('refuses a throwing traversal at a nested schema keyword', () => {
		const hostileProperties = new Proxy<Record<string, JSONSchema>>(
			{},
			{
				ownKeys() {
					throw new Error('hostile ownKeys')
				},
			},
		)
		const schema: JSONSchema = { type: 'object', properties: hostileProperties }
		const error = captureContractError(() => schemaToShape(schema))
		expect(error.code).toBe('structure')
		expect(error.context).toEqual({ shape: 'schema' })
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
		{
			label: 'unsafe string length bound',
			schema: { type: 'string', minLength: Number.MAX_SAFE_INTEGER + 1 },
		},
		{
			label: 'unsafe array length bound',
			schema: { type: 'array', minItems: Number.MAX_SAFE_INTEGER + 1 },
		},
		{
			label: 'empty fractional integer range',
			schema: { type: 'integer', minimum: 1.2, maximum: 1.8 },
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

describe('shape builders — reparented class brands', () => {
	it('refuses a null-base class instance at every building door', () => {
		const doors = [
			{ name: 'arrayShape', operation: () => arrayShape(new NullBaseDeclaration()) },
			{ name: 'objectShape', operation: () => objectShape({ value: new NullBaseDeclaration() }) },
			{ name: 'recordShape', operation: () => recordShape(new NullBaseDeclaration()) },
			{ name: 'unionShape', operation: () => unionShape(new NullBaseDeclaration()) },
			{ name: 'oneOfShape', operation: () => oneOfShape(new NullBaseDeclaration()) },
			{ name: 'optionalShape', operation: () => optionalShape(new NullBaseDeclaration()) },
			{ name: 'nullableShape', operation: () => nullableShape(new NullBaseDeclaration()) },
			{ name: 'rawShape', operation: () => rawShape(new NullBaseDeclaration()) },
		]

		const observed = doors.map((door) => {
			const error = captureContractError(door.operation)
			return { name: door.name, code: error.code, caused: Object.hasOwn(error, 'cause') }
		})

		expect(observed).toEqual([
			{ name: 'arrayShape', code: 'structure', caused: false },
			{ name: 'objectShape', code: 'structure', caused: false },
			{ name: 'recordShape', code: 'structure', caused: false },
			{ name: 'unionShape', code: 'structure', caused: false },
			{ name: 'oneOfShape', code: 'structure', caused: false },
			{ name: 'optionalShape', code: 'structure', caused: false },
			{ name: 'nullableShape', code: 'structure', caused: false },
			{ name: 'rawShape', code: 'structure', caused: false },
		])
	})

	it('refuses a null-base class instance as an object property map', () => {
		const error = captureContractError(() =>
			Reflect.apply(objectShape, undefined, [new NullBaseDeclaration()]),
		)

		expect(error.message).toBe('objectShape: properties must be a plain record')
		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['properties'])
	})

	it('widens a null-base class instance to an accept-anything raw shape during inversion', () => {
		const node = new NullBaseDeclaration()

		expect(schemaToShape(node)).toEqual(rawShape({}))
		expect(schemaNodeToShape(node, INFER_DEPTH_LIMIT, new WeakSet(), new WeakMap())).toEqual(
			rawShape({}),
		)
	})
})

describe('schemaToShape — readable malformed vocabulary (H9)', () => {
	it('de-duplicates a repeated enum instead of refusing it as unreadable', () => {
		// JSON Schema requires `enum` members to be unique, so a repeat is malformed
		// VOCABULARY, and this conversion's stated rule for malformed vocabulary is
		// to ignore it and widen — never to throw, and never to misattribute a data
		// defect to a hostile host. `literalShape`'s uniqueness gate refused the
		// duplicate and `readValue` republished that refusal as
		// `schemaNodeToShape: schema could not be read`.
		expect(schemaToShape({ enum: ['a', 'a'] })).toEqual(literalShape(['a']))
		expect(schemaToShape({ enum: ['a', 'a', 'b'] })).toEqual(literalShape(['a', 'b']))
		// SameValueZero, the package-wide membership rule: `-0` and `0` are one
		// member, and first occurrence keeps its place.
		expect(schemaToShape({ enum: [0, -0] })).toEqual(literalShape([0]))
		expect(
			schemaToShape({
				type: 'object',
				properties: { role: { enum: ['a', 'a'] } },
				required: ['role'],
			}),
		).toEqual(objectShape({ role: literalShape(['a']) }, { additionalProperties: true }))

		const contract = createContract(schemaToShape({ enum: ['a', 'a', 'b'] }))
		expect(contract.is('a')).toBe(true)
		expect(contract.is('c')).toBe(false)
		expect(contract.schema).toEqual({ enum: ['a', 'b'] })

		// Control: a genuinely unreadable node is still refused as unreadable.
		const hostile: JSONSchema = {}
		Object.defineProperty(hostile, 'enum', {
			enumerable: true,
			get() {
				throw new Error('hostile keyword')
			},
		})
		const error = captureContractError(() => schemaToShape(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('schemaNodeToShape: schema could not be read')
	})

	it('serves its memo per (node, remaining depth), so a cyclic path widens a shared node earlier', () => {
		// A KNOWN and documented limit rather than a repaired defect: the
		// `(node, depth)` memo does not carry the active-ancestor set, so a node
		// first reached through a cyclic path is served its cycle-truncated shape on
		// a later acyclic path. Every observed difference is a WIDENING — an
		// accept-anything `rawShape` — so nothing is wrongly rejected and the
		// round-trip law is unaffected; what it costs is determinism across two
		// graphs that differ only in which sibling holds the cyclic node.
		const build = (cyclicFirst: boolean): JSONSchema => {
			const cyclic: JSONSchema = { type: 'object' }
			const wrapper: JSONSchema = { type: 'array', items: cyclic }
			// Only the back edge needs reflection: everything else is expressible,
			// and `properties` cannot name `wrapper` until `wrapper` names `cyclic`.
			Reflect.set(cyclic, 'properties', { q: wrapper })
			Reflect.set(cyclic, 'required', ['q'])
			const plain: JSONSchema = {
				type: 'object',
				properties: { q: wrapper },
				required: ['q'],
			}
			const properties = cyclicFirst ? { a: cyclic, b: plain } : { a: plain, b: cyclic }
			return { type: 'object', properties, required: ['a', 'b'] }
		}

		const cyclicFirst = compileSchema(schemaToShape(build(true)))
		const plainFirst = compileSchema(schemaToShape(build(false)))

		// Both siblings inherit whichever conversion reached the shared node first.
		expect(JSON.stringify(cyclicFirst)).not.toBe(JSON.stringify(plainFirst))
		// Both remain sound: each accepts the document the other's shape describes.
		const value = { a: { q: [{ q: [] }] }, b: { q: [{ q: [] }] } }
		expect(compileGuard(schemaToShape(build(true)))(value)).toBe(true)
		expect(compileGuard(schemaToShape(build(false)))(value)).toBe(true)
		// And each conversion is deterministic for its own input.
		expect(JSON.stringify(compileSchema(schemaToShape(build(true))))).toBe(
			JSON.stringify(cyclicFirst),
		)
	})
})
