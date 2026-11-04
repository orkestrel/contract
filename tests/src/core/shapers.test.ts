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
	OptionalShape,
	OptionalShapeOptions,
	Result,
	StringShapeOptions,
	StringShape,
} from '@src/core'
import {
	arrayShape,
	auditFaultShape,
	isAuditFault,
	FAULT_KINDS,
	FAULT_CONSTRAINTS,
	attempt,
	booleanShape,
	cloneShape,
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
	shapeShape,
	literalShape,
	nullableShape,
	nullShape,
	numberShape,
	objectShape,
	ownShape,
	oneOfShape,
	optionalShape,
	rawShape,
	recordShape,
	samplesToSchema,
	schemaToShape,
	seededRandom,
	stringShape,
	unionShape,
	validateShape,
	valueToSchema,
} from '@src/core'
import type { Equal, Expect } from '../../setup.js'
import {
	buildNonJSONValues,
	polluteArrayConstruction,
	buildCycle,
	ObservationCounter,
	buildCyclicArray,
	buildCyclicRecord,
	buildDeepNest,
	buildSparseArray,
	captureContractError,
	buildDeepShape,
	buildHandNest,
	buildSchemaNest,
	buildSharedDagShape,
	measureWalks,
	readVerdict,
	replaceAccessor,
	replaceIntrinsic,
	throwReplacement,
	createClassInstance,
	createRevokedArrayProxy,
	createRevokedProxy,
	createHostileKeys,
	createNonEnumerableRecord,
	createStatefulGetter,
	createThrowingGetter,
	createUndefinedDefault,
	createUndefinedSchema,
	createUnstableArray,
	NullBaseDeclaration,
	pollutePrototype,
	SOUNDNESS_SAMPLE,
} from '../../setup.js'
import { createForeignRegExp } from '../../setupServer.js'

type BuilderRole = 'options' | 'shape' | 'properties' | 'values' | 'schema'

interface BuilderCase {
	readonly name: string
	readonly valid: ReadonlyArray<readonly unknown[]>
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
		valid: [
			[stringShape()],
			[nullableShape(stringShape())],
			[stringShape(), {}],
			[numberShape(), { default: 3 }],
		],
		positions: { 0: 'shape', 1: 'options' },
		options: { 1: ['default'] },
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
	{
		name: 'shapeShape',
		valid: [[], [{ description: 'value' }]],
		positions: { 0: 'options' },
		options: { 0: ['description'] },
		run: (args) => Reflect.apply(shapeShape, undefined, [...args]),
	},
]

describe('shape builders', () => {
	it('infers a contract declaration from a shape-valued builder', () => {
		const shape = shapeShape()
		expectTypeOf<Infer<typeof shape>>().toEqualTypeOf<ContractShape>()
		expect(shape).toEqual({ category: 'shape' })
		expect(Object.isFrozen(shape)).toBe(true)
	})
	it('keeps HEAD literal and object declarations under polluted array construction', () => {
		const actual = polluteArrayConstruction(() => {
			return objectShape({ choice: literalShape(['x', 1]) })
		})
		// HEAD shapers.ts:285 and :413 copy the literal vocabulary and each property by index.
		expect(actual).toEqual({
			category: 'object',
			properties: { choice: { category: 'literal', values: ['x', 1] } },
		})
	})

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

		const hostile: Array<{
			readonly builder: string
			readonly position: number
			readonly outcome: Result<unknown>
		}> = []
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
		// A key the builder reads may hold `undefined`, which reads as absent. A door that
		// refuses unknown keys has no `description`, so this control belongs to the others.
		const described = { ...{ description: undefined } }

		for (const builder of BUILDER_CASES) {
			const base = builder.valid[0] ?? []
			for (const [positionText, keys] of Object.entries(builder.options ?? {})) {
				const position = Number(positionText)
				for (const options of keys.includes('description') ? [...controls, described] : controls) {
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
		expect(() => stringShape({ min: -1 })).toThrow(ContractError)
		expect(() => stringShape({ max: 1.5 })).toThrow(ContractError)
		expect(() => arrayShape(stringShape(), { min: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
			ContractError,
		)
		expect(() => numberShape({ max: Number.POSITIVE_INFINITY })).toThrow(ContractError)
		expect(() => stringShape({ pattern: /^value$/g })).toThrow(ContractError)

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

		for (const [schema, path] of [
			[{ properties }, ['schema', 'properties', 'value']],
			[{ anyOf }, ['schema', 'anyOf', '0']],
			[{ oneOf }, ['schema', 'oneOf', '0']],
			[{ properties: nullProperties }, ['schema', 'properties', 'value']],
		] satisfies ReadonlyArray<readonly [JSONSchema, readonly string[]]>) {
			const error = captureContractError(() => rawShape(schema))
			expect(error.message).toBe('validateShape: every raw schema child must be a plain record')
			expect(error.code).toBe('structure')
			expect(error.context).toEqual({ path })
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
			expect(rawShape(schema).category).toBe('raw')
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
		const poison = Object.freeze({
			[Symbol.toPrimitive]() {
				throw new Error('poisoned')
			},
		})
		const cases: ReadonlyArray<readonly [string, () => unknown]> = Object.freeze([
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
		])

		for (const [position, run] of cases) {
			const error = captureContractError(run)
			expect({ position, code: error.code }).toEqual({ position, code: 'bound' })
		}
	})

	it('enumerates a caller-owned property declaration once and carries that snapshot', () => {
		const reads = new ObservationCounter()
		const properties = new Proxy(
			{ a: stringShape(), b: stringShape() },
			{
				ownKeys(target) {
					reads.increment()
					return reads.value === 1 ? Reflect.ownKeys(target) : ['a']
				},
			},
		)
		const contract = createContract(objectShape(properties))

		expect(reads.value).toBe(1)
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
		expect(() => shape.pattern?.compile('^owned-drift$')).toThrow(TypeError)
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
		expect(() => generated.pattern?.compile('^owned-drift$')).toThrow(TypeError)
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
		expect(stringShape()).toMatchObject({ category: 'string' })
		const pattern = /^a+$/
		expect(stringShape({ min: 1, max: 8, pattern, description: 'name' })).toMatchObject({
			category: 'string',
			min: 1,
			max: 8,
			pattern,
			description: 'name',
		})
	})

	it('numberShape and integerShape set the integer flag appropriately', () => {
		expect(numberShape({ min: 0, max: 10 })).toMatchObject({ category: 'number', min: 0, max: 10 })
		expect(numberShape().integer).toBeUndefined()
		expect(integerShape({ min: 0 })).toMatchObject({ category: 'number', integer: true, min: 0 })
	})

	it('booleanShape carries its description', () => {
		expect(booleanShape({ description: 'flag' })).toMatchObject({
			category: 'boolean',
			description: 'flag',
		})
	})

	it('literalShape preserves the value tuple', () => {
		expect(literalShape(['admin', 'guest'])).toMatchObject({
			category: 'literal',
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
		expect(error.message).toBe('validateShape: values must be a dense data array')
	})

	it('literalShape attaches the description via options', () => {
		expect(literalShape(['admin', 'guest'], { description: 'the user role' })).toEqual({
			category: 'literal',
			values: ['admin', 'guest'],
			description: 'the user role',
		})
	})

	it('arrayShape wraps an element shape with bounds', () => {
		const shape = arrayShape(stringShape(), { max: 3 })
		expect(shape.category).toBe('array')
		expect(shape.items).toMatchObject({ category: 'string' })
		expect(shape.max).toBe(3)
	})

	it('objectShape carries properties + additionalProperties', () => {
		const shape = objectShape({ name: stringShape() }, { additionalProperties: false })
		expect(shape.category).toBe('object')
		expect(shape.properties.name).toMatchObject({ category: 'string' })
		expect(shape.additionalProperties).toBe(false)
	})

	it('recordShape is an open object validated by its value shape', () => {
		const shape = recordShape(numberShape())
		expect(shape.category).toBe('object')
		expect(shape.properties).toEqual({})
		expect(shape.additionalProperties).toMatchObject({ category: 'number' })
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
			category: 'optional',
			inner: { category: 'string' },
		})
		expect(nullableShape(numberShape())).toMatchObject({
			category: 'nullable',
			inner: { category: 'number' },
		})
	})

	it('rawShape embeds a schema fragment verbatim', () => {
		expect(rawShape({ type: 'string', description: 'any' })).toEqual({
			category: 'raw',
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
		const reads = new ObservationCounter()
		const schema = new Proxy({ type: 'string', minLength: 1 } satisfies JSONSchema, {
			get(target, property, receiver) {
				if (property !== 'minLength') return Reflect.get(target, property, receiver)
				reads.increment()
				return reads.value === 1 ? 1 : -5
			},
		})

		const error = captureContractError(() => rawShape(schema))
		expect(reads.value).toBe(2)
		expect(error.code).toBe('structure')
		expect(error.message).toBe(
			'validateShape: raw schema length bounds must be non-negative safe integers',
		)
		expect(error.context?.path).toEqual(['schema', 'minLength'])
	})

	it('returns the one valid captured raw population and preserves earlier diagnostics', () => {
		const reads = new ObservationCounter()
		const schema = new Proxy({ type: 'string', minLength: 1 } satisfies JSONSchema, {
			get(target, property, receiver) {
				if (property !== 'minLength') return Reflect.get(target, property, receiver)
				reads.increment()
				return reads.value === 1 ? 1 : 3
			},
		})
		const shape = rawShape(schema)

		expect(reads.value).toBe(2)
		expect(shape.schema).not.toBe(schema)
		expect(shape.schema.minLength).toBe(3)
		expect(Object.isFrozen(shape.schema)).toBe(true)

		const invalidReads = new ObservationCounter()
		const invalid = new Proxy({ type: 'string', minLength: -5 } satisfies JSONSchema, {
			get(target, property, receiver) {
				if (property === 'minLength') invalidReads.increment()
				return Reflect.get(target, property, receiver)
			},
		})
		const invalidError = captureContractError(() => rawShape(invalid))
		expect(invalidReads.value).toBe(1)
		expect(invalidError.code).toBe('structure')

		const hostileReads = new ObservationCounter()
		const hostile = new Proxy({ type: 'string', minLength: 1 } satisfies JSONSchema, {
			get(target, property, receiver) {
				if (property !== 'minLength') return Reflect.get(target, property, receiver)
				hostileReads.increment()
				if (hostileReads.value > 1) throw new Error('clone read')
				return 1
			},
		})
		const hostileError = captureContractError(() => rawShape(hostile))
		expect(hostileReads.value).toBe(2)
		expect(hostileError.code).toBe('clone')
		expect(hostileError.message).toBe('cloneSchema: property access failed')
	})

	it('nullShape returns a bare null shape and threads its description', () => {
		expect(nullShape()).toEqual({ category: 'null' })
		expect(nullShape({ description: 'nothing' })).toEqual({
			category: 'null',
			description: 'nothing',
		})
	})

	it('jsonShape returns a bare json shape and threads its description', () => {
		expect(jsonShape()).toEqual({ category: 'json' })
		expect(jsonShape({ description: 'any JSON value' })).toEqual({
			category: 'json',
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
		const lock: Expect<Equal<Infer<typeof empty>, Readonly<Record<never, never>>>> = true
		expect(lock).toBe(true)
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
			readonly messages: ReadonlyArray<UserMessage | AssistantMessage>
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
		const lock: Expect<Equal<Snapshot, Expected>> = true
		expect(lock).toBe(true)

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
		// array rule, because a fix verified only where it was found ships the
		// defect at every other door.
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
		expect(schemaToShape({ type: 'string' })).toMatchObject({ category: 'string' })
		expect(schemaToShape({ type: 'number' })).toMatchObject({ category: 'number' })
		expect(schemaToShape({ type: 'integer' })).toMatchObject({ category: 'number', integer: true })
		expect(schemaToShape({ type: 'boolean' })).toMatchObject({ category: 'boolean' })
		expect(schemaToShape({ type: 'null' })).toMatchObject({ category: 'null' })
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

	it('oneOf compiles to a union accepting a value matching two-or-more variants', () => {
		const guard = compileGuard(schemaToShape({ oneOf: [{ type: 'number' }, { type: 'integer' }] }))
		expect(guard(3.5)).toBe(true) // matches number only
		expect(guard(3)).toBe(true) // matches both, and a lenient conversion never narrows
		expect(guard('x')).toBe(false) // matches neither
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
		const properties: Record<string, JSONSchema> = Object.fromEntries(
			Array.from({ length: propertyCount }, (_, index) => [`k${index}`, { type: 'string' }]),
		)
		const value = Object.fromEntries(
			Array.from({ length: propertyCount }, (_, index) => [`k${index}`, `v${index}`]),
		)
		const schema: JSONSchema = { type: 'object', properties, additionalProperties: false }
		expect(() => createContract(schemaToShape(schema))).not.toThrow()
		const guard = compileGuard(schemaToShape(schema))
		// A key past the INFER_BREADTH_LIMIT sampling cap (for example the last
		// one) is dropped from `properties`, so it can only pass if
		// additionalProperties was forced open rather than inheriting the schema's
		// `false`.
		expect(guard(value)).toBe(true)
	})

	it('widens oneOf/anyOf to rawShape when the record-variant count exceeds INFER_BREADTH_LIMIT, rather than narrowing to a subset union', () => {
		const variantCount = INFER_BREADTH_LIMIT + 10
		const variants = Array.from({ length: variantCount }, (_, index) => ({ enum: [`v${index}`] }))
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
		const start = performance.now()
		const guard = compileGuard(schemaToShape({ type: 'string', pattern: '^(a+)+$' }))
		expect(guard(`${'a'.repeat(40)}!`)).toBe(true)
		expect(performance.now() - start).toBeLessThan(100)
	})
})

describe('schemaToShape — hostile schema triad', () => {
	it('does not stack-overflow or throw on a cyclic schema graph (self-referential properties)', () => {
		// JSON.parse returns an untyped structure; mutate it before pinning the
		// declared type to JSONSchema — no type assertion needed, as
		// `AGENTS.md` § Non-negotiable rules requires.
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
		const node = Array.from({ length: 100 }).reduce<JSONSchema>(
			(child) => ({ type: 'object', properties: { child: child }, required: ['child'] }),
			{ type: 'string' },
		)
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
		// The object branch, the keyword switch and the per-node entry are all
		// reached through this one door now, so the door is where the refusal is
		// asked for — at the root, inside `properties`, and inside `items`.
		const runs = Object.freeze([
			() => schemaToShape(hostile),
			() => schemaToShape({ type: 'object', properties: { nested: hostile } }),
			() => schemaToShape({ type: 'array', items: hostile }),
		])
		for (const run of runs) {
			const error = captureContractError(run)
			expect(error.code).toBe('structure')
			expect(error.context).toEqual({ shape: 'schema' })
			expect(error.message).toBe('schemaToShape: schema could not be read')
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
	// Each entry is built through JSON.parse (untyped) then pinned to JSONSchema
	// on assignment — deliberately malformed keyword values with no type
	// assertion.
	const malformedSchemas: ReadonlyArray<{ readonly label: string; readonly schema: JSONSchema }> = [
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
		const node = Array.from({ length: 20 }).reduce<JSONSchema>(
			(child) => ({ type: 'object', properties: { a: child, b: child }, required: ['a', 'b'] }),
			{ type: 'string' },
		)
		const start = performance.now()
		const widened = schemaToShape(node)
		expect(performance.now() - start).toBeLessThan(5000)
		// The conversion stays fast, and a shape this DAG expands past the compile limit
		// keeps only its root, so `createContract` over it answers instead of refusing.
		expect(widened.category).toBe('object')

		const small = Array.from({ length: 10 }).reduce<JSONSchema>(
			(child) => ({ type: 'object', properties: { a: child, b: child }, required: ['a', 'b'] }),
			{ type: 'string' },
		)
		const shape = schemaToShape(small)
		expect(shape.category).toBe('object')
		// Both keys are `required`, so neither is optionalShape-wrapped — the
		// memoized inner shape is returned by reference for both, proving the
		// conversion dedupes the shared subtree instead of re-building it.
		const properties = shape.category === 'object' ? shape.properties : undefined
		expect(properties?.a).toBe(properties?.b)
	})

	it('resolves an INFER_BREADTH_LIMIT-wide properties record quickly', () => {
		const properties: Record<string, JSONSchema> = Object.fromEntries(
			Array.from({ length: 300 }, (_, index) => [`key${index}`, { type: 'string' }]),
		)
		const schema: JSONSchema = { type: 'object', properties }
		const start = performance.now()
		expect(() => createContract(schemaToShape(schema))).not.toThrow()
		expect(performance.now() - start).toBeLessThan(5000)
	})
})

describe('shape builders — reparented class brands', () => {
	it('refuses a null-base class instance at every building door', () => {
		// `rawShape` takes a JSON Schema rather than a declaration, so that one door is driven
		// reflectively and the corpus still puts one instance through every building door.
		const doors: ReadonlyArray<{ readonly name: string; readonly operation: () => unknown }> =
			Object.freeze([
				{ name: 'arrayShape', operation: () => arrayShape(new NullBaseDeclaration()) },
				{ name: 'objectShape', operation: () => objectShape({ value: new NullBaseDeclaration() }) },
				{ name: 'recordShape', operation: () => recordShape(new NullBaseDeclaration()) },
				{ name: 'unionShape', operation: () => unionShape(new NullBaseDeclaration()) },
				{ name: 'oneOfShape', operation: () => oneOfShape(new NullBaseDeclaration()) },
				{ name: 'optionalShape', operation: () => optionalShape(new NullBaseDeclaration()) },
				{ name: 'nullableShape', operation: () => nullableShape(new NullBaseDeclaration()) },
				{
					name: 'rawShape',
					operation: () => Reflect.apply(rawShape, undefined, [new NullBaseDeclaration()]),
				},
			])

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

		// A declaration is not a JSON Schema, so the inversion door is driven reflectively.
		const widened: ContractShape = Reflect.apply(schemaToShape, undefined, [node])
		const nested: ContractShape = Reflect.apply(schemaToShape, undefined, [
			{ type: 'object', properties: { nested: node } },
		])

		expect(widened).toEqual(rawShape({}))
		expect(nested).toEqual(
			objectShape({ nested: optionalShape(rawShape({})) }, { additionalProperties: true }),
		)
	})
})

describe('schemaToShape — readable malformed vocabulary (H9)', () => {
	it('de-duplicates a repeated enum instead of refusing it as unreadable', () => {
		// JSON Schema requires `enum` members to be unique, so a repeat is malformed
		// VOCABULARY, and this conversion's stated rule for malformed vocabulary is
		// to ignore it and widen — never to throw, and never to misattribute a data
		// defect to a hostile host. `literalShape`'s uniqueness gate refused the
		// duplicate and `readValue` republished that refusal as a read failure.
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
		expect(error.message).toBe('schemaToShape: schema could not be read')
	})

	it('serves its memo per (node, remaining depth), so a cyclic path widens a shared node earlier', () => {
		// A KNOWN and documented limit rather than a repaired defect: the
		// `(node, depth)` memo does not carry the active-ancestor set, so a node
		// first reached through a cyclic path is served its cycle-truncated shape on
		// a later acyclic path. Every observed difference is a WIDENING — an
		// accept-anything `rawShape` — so nothing is wrongly rejected and the
		// round-trip law is unaffected; what it costs is determinism across two
		// graphs that differ only in which sibling holds the cyclic node.

		const cyclicFirst = compileSchema(schemaToShape(buildCycle(true)))
		const plainFirst = compileSchema(schemaToShape(buildCycle(false)))

		// Both siblings inherit whichever conversion reached the shared node first.
		expect(JSON.stringify(cyclicFirst)).not.toBe(JSON.stringify(plainFirst))
		// Both remain sound: each accepts the document the other's shape describes.
		const value = { a: { q: [{ q: [] }] }, b: { q: [{ q: [] }] } }
		expect(compileGuard(schemaToShape(buildCycle(true)))(value)).toBe(true)
		expect(compileGuard(schemaToShape(buildCycle(false)))(value)).toBe(true)
		// And each conversion is deterministic for its own input.
		expect(JSON.stringify(compileSchema(schemaToShape(buildCycle(true))))).toBe(
			JSON.stringify(cyclicFirst),
		)
	})
})

describe('optionalShape — default', () => {
	it('carries a default on the frozen node', () => {
		const shape = optionalShape(numberShape(), { default: 3 })

		expect(shape).toMatchObject({ category: 'optional', inner: { category: 'number' }, default: 3 })
		expect(Object.isFrozen(shape)).toBe(true)
	})

	it('carries null and other falsy defaults', () => {
		const values: readonly JSONValue[] = [null, 0, '', false]
		const carried = values.map((value) => optionalShape(jsonShape(), { default: value }).default)

		expect(carried).toEqual(values)
	})

	it('owns a frozen copy of a container default', () => {
		const value = { tags: ['x'] }
		const shape = optionalShape(jsonShape(), { default: value })

		expect(shape.default).not.toBe(value)
		expect(shape.default).toEqual(value)
		expect(Object.isFrozen(shape.default)).toBe(true)
		value.tags.push('y')
		expect(shape.default).toEqual({ tags: ['x'] })
	})

	it('carries no key without a default option', () => {
		expect(Object.hasOwn(optionalShape(stringShape()), 'default')).toBe(false)
		expect(Object.hasOwn(optionalShape(stringShape(), {}), 'default')).toBe(false)
	})

	it('refuses a present undefined default with structure', () => {
		const error = captureContractError(() => optionalShape(stringShape(), createUndefinedDefault()))

		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['default'])
	})

	it('refuses a default that is not JSON with structure', () => {
		const values = buildNonJSONValues()
		const codes = values.map(
			(value) =>
				captureContractError(() =>
					Reflect.apply(optionalShape, undefined, [stringShape(), { default: value }]),
				).code,
		)

		expect(codes).toEqual(values.map(() => 'structure'))
	})

	it('refuses rather than carries a default the options only inherit', () => {
		const options: OptionalShapeOptions = {}
		const error = captureContractError(() =>
			pollutePrototype(
				Object.prototype,
				'default',
				() => 3,
				() => optionalShape(stringShape(), options),
			),
		)

		expect(error.code).toBe('structure')
	})

	it('types a defaulted key as a key that may be absent', () => {
		const shape = objectShape({ a: optionalShape(numberShape(), { default: 3 }) })

		expectTypeOf<Infer<typeof shape>>().toEqualTypeOf<{ readonly a?: number }>()
		expectTypeOf(shape.properties.a.inner).toEqualTypeOf<NumberShape>()
	})

	it('refuses a misspelled option, naming it', () => {
		const options: Readonly<Record<string, unknown>> = { defalt: 1 }
		const error = captureContractError(() =>
			Reflect.apply(optionalShape, undefined, [numberShape(), options]),
		)

		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['defalt'])
		expect(error.message).toContain('default')
	})

	it('refuses an extra key beside a real one', () => {
		const options: Readonly<Record<string, unknown>> = { default: 1, extra: 2 }
		const error = captureContractError(() =>
			Reflect.apply(optionalShape, undefined, [numberShape(), options]),
		)

		expect(error.context?.path).toEqual(['extra'])
	})

	it('refuses a default it cannot copy, with structure at its path', () => {
		const value: Record<string, unknown> = {}
		Object.defineProperty(value, 'x', { enumerable: true, get: () => 1 })
		const error = captureContractError(() =>
			Reflect.apply(optionalShape, undefined, [jsonShape(), { default: value }]),
		)

		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['default'])
	})
})

describe('shape builders — a built child answers as a walked one does', () => {
	it.each<{
		readonly label: string
		readonly built: () => ContractShape
		readonly hand: () => ContractShape
		readonly wrap: (child: ContractShape) => unknown
		readonly path: readonly string[]
	}>([
		{
			label: 'an optional node as array items',
			built: () => optionalShape(stringShape()),
			hand: () => ({ category: 'optional', inner: { category: 'string' } }),
			wrap: (child) => arrayShape(child),
			path: ['items'],
		},
		{
			label: 'an optional node under a nullable',
			built: () => optionalShape(stringShape()),
			hand: () => ({ category: 'optional', inner: { category: 'string' } }),
			wrap: (child) => nullableShape(child),
			path: ['inner'],
		},
		{
			label: 'an optional node as a union variant',
			built: () => optionalShape(stringShape()),
			hand: () => ({ category: 'optional', inner: { category: 'string' } }),
			wrap: (child) => unionShape(child),
			path: ['variants', '0'],
		},
		{
			label: 'an optional node as the additional value',
			built: () => optionalShape(stringShape()),
			hand: () => ({ category: 'optional', inner: { category: 'string' } }),
			wrap: (child) => recordShape(child),
			path: ['additionalProperties'],
		},
		{
			label: 'an optional node under an optional',
			built: () => optionalShape(stringShape()),
			hand: () => ({ category: 'optional', inner: { category: 'string' } }),
			wrap: (child) => optionalShape(child),
			path: ['properties', 'value', 'inner'],
		},
		{
			label: 'a default one level below a union',
			built: () => objectShape({ a: optionalShape(stringShape(), { default: 'x' }) }),
			hand: () => ({
				category: 'object',
				properties: {
					a: { category: 'optional', inner: { category: 'string' }, default: 'x' },
				},
			}),
			wrap: (child) => unionShape(nullShape(), child),
			path: ['variants', '1', 'properties', 'a'],
		},
		{
			label: 'a default deep below a union',
			built: () => arrayShape(objectShape({ a: optionalShape(stringShape(), { default: 'x' }) })),
			hand: () => ({
				category: 'array',
				items: {
					category: 'object',
					properties: {
						a: { category: 'optional', inner: { category: 'string' }, default: 'x' },
					},
				},
			}),
			wrap: (child) => oneOfShape(child),
			path: ['variants', '0', 'items', 'properties', 'a'],
		},
		{
			label: 'a default beside additional properties',
			built: () => optionalShape(stringShape(), { default: 'x' }),
			hand: () => ({ category: 'optional', inner: { category: 'string' }, default: 'x' }),
			wrap: (child) => objectShape({ a: child }, { additionalProperties: true }),
			path: ['properties', 'a'],
		},
	])('refuses $label at the same path', ({ built, hand, wrap, path }) => {
		const refused = captureContractError(() => wrap(built()))

		expect(refused.code).toBe('placement')
		expect(refused.context?.path).toEqual(path)
		expect(readVerdict(() => wrap(built()))).toBe(readVerdict(() => wrap(hand())))
	})

	it('accepts a default a closed object carries below an open one', () => {
		const inner = objectShape({ a: optionalShape(stringShape(), { default: 'x' }) })

		expect(readVerdict(() => objectShape({ inner }, { additionalProperties: true }))).toBe(
			'accepted',
		)
	})

	it('refuses an optional root at every compiling door', () => {
		const built = optionalShape(stringShape())
		const hand: OptionalShape<StringShape> = {
			category: 'optional',
			inner: { category: 'string' },
		}
		const verdict = readVerdict(() => createContract(built))

		expect(verdict).toContain('placement')
		expect(verdict).toBe(readVerdict(() => createContract(hand)))
		expect(readVerdict(() => compileGuard(built))).toBe(verdict)
	})

	it.each<{
		readonly label: string
		readonly wrap: (child: ContractShape) => unknown
		readonly deepest: number
	}>([
		{ label: 'an array', wrap: (child) => arrayShape(child), deepest: 511 },
		{ label: 'a nullable', wrap: (child) => nullableShape(child), deepest: 511 },
		{ label: 'a property', wrap: (child) => objectShape({ deep: child }), deepest: 511 },
		{ label: 'a variant', wrap: (child) => unionShape(child), deepest: 511 },
		{ label: 'an optional', wrap: (child) => optionalShape(child), deepest: 510 },
		{
			label: 'an optional property',
			wrap: (child) => objectShape({ deep: optionalShape(child) }),
			deepest: 510,
		},
	])('stops $label at the depth limit as a walk does', ({ wrap, deepest }) => {
		const legal = readVerdict(() => wrap(buildDeepShape(deepest)))
		const past = readVerdict(() => wrap(buildDeepShape(deepest + 1)))

		expect(legal).toBe('accepted')
		expect(past).toContain('exceeds the compilation depth limit')
		expect(legal).toBe(readVerdict(() => wrap(buildHandNest(deepest))))
		expect(past).toBe(readVerdict(() => wrap(buildHandNest(deepest + 1))))
	})

	it.each<{
		readonly label: string
		readonly wrap: (child: ContractShape) => unknown
		readonly highest: number
	}>([
		{ label: 'an array', wrap: (child) => arrayShape(child), highest: 511 },
		{ label: 'two arrays', wrap: (child) => arrayShape(arrayShape(child)), highest: 510 },
		{ label: 'an optional', wrap: (child) => optionalShape(child), highest: 510 },
	])('counts a raw schema toward the depth limit below $label', ({ wrap, highest }) => {
		const legal = readVerdict(() => wrap(rawShape(buildSchemaNest(highest))))
		const past = readVerdict(() => wrap(rawShape(buildSchemaNest(highest + 1))))

		expect(legal).toBe('accepted')
		expect(past).toContain('raw schema exceeds the compilation depth limit')
		expect(past).toBe(
			readVerdict(() => wrap({ category: 'raw', schema: buildSchemaNest(highest + 1) })),
		)
	})

	it('measures a built declaration at the node limit as a walk does', () => {
		const base = buildSharedDagShape(13)
		const atLimit = objectShape({ base })
		const past = objectShape({ base, extra: booleanShape() })
		const refused = readVerdict(() => createContract(past))

		expect(readVerdict(() => createContract(atLimit))).toBe('accepted')
		expect(refused).toContain('expands past the compilation node limit')
		expect(refused).toBe(readVerdict(() => createContract(cloneShape(past))))
	})

	it('walks a hand-written child again, since it can still change', () => {
		const child: ContractShape = { category: 'string' }
		const parent = arrayShape(child)
		Object.defineProperty(child, 'min', { value: 'late', enumerable: true })
		const refusal = 'structure: validateShape: string min must be a number'

		expect(readVerdict(() => arrayShape(parent))).toContain(refusal)
		expect(readVerdict(() => createContract(parent))).toContain(refusal)
		expect(readVerdict(() => createContract(arrayShape(arrayShape(parent))))).toContain(refusal)
	})

	it('walks a child a caller froze, whose accessor can still answer', () => {
		const reads = new ObservationCounter()
		const hand: StringShape = Object.freeze({
			category: 'string',
			get pattern() {
				reads.increment()
				return Object.freeze(/a/)
			},
		})
		const parent = arrayShape(hand)
		reads.clear()
		const again = arrayShape(parent)

		expect(reads.value).toBeGreaterThan(0)
		reads.clear()
		createContract(again)
		expect(reads.value).toBeGreaterThan(0)
	})

	it.each([
		'min',
		'max',
		'pattern',
		'description',
		'integer',
		'additionalProperties',
		'mode',
		'default',
	])('refuses an inherited %s on a built declaration, then recovers', (field) => {
		const built = objectShape({
			text: stringShape(),
			count: numberShape(),
			either: unionShape(booleanShape(), nullShape()),
			maybe: optionalShape(jsonShape()),
			pick: literalShape(['a']),
			list: arrayShape(nullableShape(stringShape())),
			raw: rawShape({ type: 'string' }),
		})
		const verdicts = pollutePrototype(
			Object.prototype,
			field,
			() => 'inherited',
			() => ({
				wrapped: readVerdict(() => arrayShape(built)),
				walked: readVerdict(() => validateShape({ category: 'array', items: built })),
				compiled: readVerdict(() => createContract(built)),
				cloned: readVerdict(() => cloneShape(built)),
			}),
		)

		expect(verdicts.wrapped).toContain('structure')
		expect(verdicts.wrapped).toBe(verdicts.walked)
		expect(verdicts.compiled).toContain('structure')
		expect(verdicts.compiled).toBe(verdicts.cloned)
		expect(readVerdict(() => arrayShape(built))).toBe('accepted')
		expect(readVerdict(() => createContract(built))).toBe('accepted')
	})

	it.each<{
		readonly label: string
		readonly arm: (operation: () => readonly string[]) => readonly string[]
	}>([
		{
			label: 'a replaced array pop',
			arm: (operation) => replaceIntrinsic(Array.prototype, 'pop', throwReplacement, operation),
		},
		{
			label: 'a replaced array iterator next',
			arm: (operation) =>
				replaceIntrinsic(
					Object.getPrototypeOf([][Symbol.iterator]()),
					'next',
					throwReplacement,
					operation,
				),
		},
		{
			label: 'a throwing flag getter',
			arm: (operation) => replaceAccessor(RegExp.prototype, 'global', throwReplacement, operation),
		},
		{
			label: 'the first index on Object.prototype',
			arm: (operation) => pollutePrototype(Object.prototype, '0', () => 1, operation),
		},
		{
			label: 'a later index on Object.prototype',
			arm: (operation) => pollutePrototype(Object.prototype, '3', () => 1, operation),
		},
		{
			label: 'an index on Array.prototype',
			arm: (operation) => {
				try {
					return pollutePrototype(Array.prototype, '0', () => 1, operation)
				} finally {
					// An index raises `length`, and removing it does not lower it.
					Reflect.set(Array.prototype, 'length', 0)
				}
			},
		},
	])('takes the walk under $label, whose refusal a seal would skip', ({ arm }) => {
		const built = objectShape({
			text: stringShape({ pattern: /^a/ }),
			list: arrayShape(numberShape()),
			raw: rawShape({ type: 'string' }),
		})
		const [wrapped, walked, leaf, leafWalked, compiled, owned] = arm(() => [
			readVerdict(() => arrayShape(built)),
			readVerdict(() => validateShape({ category: 'array', items: built })),
			readVerdict(() => numberShape()),
			readVerdict(() => validateShape({ category: 'number' })),
			readVerdict(() => createContract(built)),
			readVerdict(() => ownShape(built)),
		])

		expect(wrapped).toBe(walked)
		expect(leaf).toBe(leafWalked)
		expect(compiled).toBe(owned)
		expect(readVerdict(() => arrayShape(built))).toBe('accepted')
		expect(readVerdict(() => createContract(built))).toBe('accepted')
	})

	it.each(['min', 'max', 'pattern', 'description'])(
		'refuses a string field %s inherited as undefined, which only the snapshot sees',
		(field) => {
			const verdict = pollutePrototype(
				Object.prototype,
				field,
				() => undefined,
				() => readVerdict(() => stringShape()),
			)

			expect(verdict).toContain('cloneShape: inherited shape fields cannot be owned')
			expect(readVerdict(() => stringShape())).toBe('accepted')
		},
	)

	it('refuses a default its shape refuses when the contract is created', () => {
		const built = objectShape({
			retries: optionalShape(integerShape({ min: 0 }), { default: -5 }),
		})
		const refused = captureContractError(() => createContract(built))

		expect(refused.code).toBe('structure')
		expect(refused.context?.path).toEqual(['properties', 'retries', 'default'])
		expect(readVerdict(() => createContract(built))).toBe(
			readVerdict(() => createContract(cloneShape(built))),
		)
	})

	it('compiles a built declaration to what its unsealed copy compiles to', () => {
		const built = objectShape({
			text: stringShape({ min: 1, max: 3, pattern: /^a/ }),
			count: integerShape({ min: 0 }),
			either: unionShape(booleanShape(), nullShape()),
			maybe: optionalShape(stringShape(), { default: 'x' }),
			pick: literalShape(['a', 'b']),
			list: arrayShape(nullableShape(numberShape()), { max: 2 }),
			raw: rawShape({ type: 'string' }),
		})
		const sealed = createContract(built)
		const copied = createContract(cloneShape(built))
		const values = [
			undefined,
			null,
			{},
			{ text: 'a', count: 1, either: true, pick: 'a', list: [], raw: 1 },
			{ text: 'ab', count: '2', either: null, pick: 'b', list: ['3', null], raw: 'r', maybe: 'y' },
			{ text: 'b', count: -1, either: 'no', pick: 'c', list: [1, 2, 3], raw: undefined },
		]

		expect(sealed.schema).toEqual(copied.schema)
		expect(values.map((value) => sealed.is(value))).toEqual(values.map((value) => copied.is(value)))
		expect(values.map((value) => sealed.parse(value))).toEqual(
			values.map((value) => copied.parse(value)),
		)
		expect(values.map((value) => sealed.audit(value))).toEqual(
			values.map((value) => copied.audit(value)),
		)
		expect(values.map((value) => sealed.explain(value))).toEqual(
			values.map((value) => copied.explain(value)),
		)
		expect(readVerdict(() => sealed.generate(seededRandom(7)))).toBe(
			readVerdict(() => copied.generate(seededRandom(7))),
		)
	})

	it('opens no walk over a built child, and one over a hand-written twin', async () => {
		const { floor, wrapBuilt, wrapHand, compileBuilt, compileHand } = await measureWalks()

		expect(floor).toBeGreaterThan(0)
		expect(wrapBuilt).toBe(floor)
		expect(wrapHand).toBeGreaterThan(wrapBuilt)
		// The one raw node's schema copy, which every compile emits.
		expect(compileBuilt).toBe(1)
		expect(compileHand).toBeGreaterThan(0)
	})
})

describe('auditFaultShape() counts', () => {
	it.each([-1, 1.5, 0, 2])('matches the guard for count %s', (count) => {
		const contract = createContract(auditFaultShape())
		for (const fault of [
			{ reason: 'variant', path: [], variants: count },
			{ reason: 'oneOf', path: [], matched: count },
		]) {
			expect(contract.is(fault)).toBe(isAuditFault(fault))
		}
	})
})

describe('auditFaultShape() parity', () => {
	it.each(['variant', 'oneOf'])('checks hinted and plain %s counts independently', (reason) => {
		const contract = createContract(auditFaultShape())
		for (const count of [-1, 1.5, 0, 2, Infinity, Number.NaN]) {
			for (const hint of [{}, { key: 'kind', expected: ['a'] }]) {
				const fault = {
					reason,
					path: [],
					...(reason === 'variant' ? { variants: count } : { matched: count }),
					...hint,
				}
				expect(contract.is(fault)).toBe(isAuditFault(fault))
			}
		}
	})

	it.each([
		{ path: '', accepted: true },
		{ path: 'pick', accepted: true },
		{ path: [], accepted: true },
		{ path: ['pick', 'kind'], accepted: true },
		{ path: [-1], accepted: false },
		{ path: [1.5], accepted: false },
		{ path: ['pick', 0], accepted: false },
		{ path: [Number.NaN], accepted: false },
		{ path: [Symbol('key')], accepted: false },
		{
			path: buildSparseArray(),
			accepted: false,
		},
	])('agrees on path $path', ({ path, accepted }) => {
		const fault = { reason: 'extra', path }
		expect(isAuditFault(fault)).toBe(accepted)
		expect(createContract(auditFaultShape()).is(fault)).toBe(accepted)
	})

	it('admits the dependency vocabulary for type, missing, and constraint faults', () => {
		const contract = createContract(auditFaultShape())
		for (const expected of FAULT_KINDS) {
			for (const fault of [
				{ reason: 'type', path: [], expected, received: 'x' },
				{ reason: 'missing', path: [], expected },
				...FAULT_CONSTRAINTS.flatMap((constraint) => [
					{ reason: 'constraint', path: [], expected, constraint, received: 'x' },
					{ reason: 'constraint', path: [], expected, constraint, received: 'x', limit: 1 },
					{ reason: 'constraint', path: [], expected, constraint, received: 'x', limit: 'x' },
				]),
			]) {
				expect(isAuditFault(fault)).toBe(true)
				expect(contract.is(fault)).toBe(true)
			}
		}
	})

	it('refuses malformed fault fields in both directions', () => {
		const contract = createContract(auditFaultShape())
		for (const fault of [
			null,
			{},
			{ reason: 'unknown', path: [] },
			{ reason: 'extra', path: [], extra: true },
			{ reason: 'type', path: [], expected: 'unknown', received: 'x' },
			{ reason: 'missing', expected: 'string' },
			{ reason: 'constraint', path: [], expected: 'number', constraint: 'unknown', received: 'x' },
			{
				reason: 'variant',
				path: [],
				variants: 2,
				key: 'kind',
				expected: buildSparseArray(),
			},
		]) {
			expect(isAuditFault(fault)).toBe(false)
			expect(contract.is(fault)).toBe(false)
		}
	})

	it.each([Infinity, -Infinity, Number.NaN])(
		'refuses a non-finite limit in both artifacts: %s',
		(limit) => {
			const fault = {
				reason: 'constraint',
				path: [],
				expected: 'number',
				constraint: 'min',
				received: '0',
				limit,
			}
			expect(isAuditFault(fault)).toBe(false)
			expect(createContract(auditFaultShape()).is(fault)).toBe(false)
			expect(() => numberShape({ min: limit })).toThrow(/finite/)
		},
	)

	it.each([Infinity, -Infinity, Number.NaN])(
		'refuses non-finite literal declarations and JSON hints for %s',
		(value) => {
			expect(() => literalShape([value])).toThrow(/non-finite/)
			for (const fault of [
				{ reason: 'variant', path: [], variants: 2, key: 'kind', expected: [value] },
				{ reason: 'oneOf', path: [], matched: 0, key: 'kind', expected: [value] },
			]) {
				expect(isAuditFault(fault)).toBe(false)
				expect(createContract(auditFaultShape()).is(fault)).toBe(false)
			}
		},
	)

	it('generates reproducible faults admitted by the guard', () => {
		const contract = createContract(auditFaultShape())
		for (const seed of Array.from({ length: 200 }, (_, index) => index)) {
			const fault = contract.generate(seededRandom(seed))
			expect(fault).toEqual(contract.generate(seededRandom(seed)))
			expect(contract.is(fault)).toBe(true)
			expect(isAuditFault(fault)).toBe(true)
		}
	})
})

describe('auditFaultShape() hints', () => {
	it.each([
		{ hint: {}, accepted: true },
		{ hint: { key: 'kind', expected: ['a', 1, true] }, accepted: true },
		{ hint: { key: '', expected: [] }, accepted: true },
		{ hint: { key: 'kind' }, accepted: false },
		{ hint: { expected: ['a'] }, accepted: false },
		{ hint: { key: 1, expected: ['a'] }, accepted: false },
		{ hint: { key: 'kind', expected: [null] }, accepted: false },
	])('requires a complete literal hint: $hint', ({ hint, accepted }) => {
		const contract = createContract(auditFaultShape())
		for (const fault of [
			{ reason: 'variant', path: ['pick'], variants: 2, ...hint },
			{ reason: 'oneOf', path: ['pick'], matched: 0, ...hint },
		]) {
			expect(isAuditFault(fault)).toBe(accepted)
			expect(contract.is(fault)).toBe(accepted)
		}
	})
})
