import type { ContractShape, Fault, Guard, JSONSchema, LiteralValue, RawShape } from '@src/core'
import type { TerminalIntrinsic } from '../../setup.js'
import {
	arrayShape,
	attempt,
	booleanShape,
	cloneShape,
	COMPILE_DEPTH_LIMIT,
	COMPILE_NODE_LIMIT,
	compileAuditor,
	compileGenerator,
	compileGuard,
	compileParser,
	compileReporter,
	compileSchema,
	ContractCompiler,
	ContractError,
	createContract,
	FAULT_LIMIT,
	integerShape,
	isContractError,
	isRecord,
	isRegExp,
	jsonShape,
	literalShape,
	nullableShape,
	nullShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	ownShape,
	preview,
	rawShape,
	recordShape,
	seededRandom,
	ShapeValidator,
	stringShape,
	unionShape,
	validateShapeDepth,
} from '@src/core'
import {
	buildDeepShape,
	buildSharedDagShape,
	buildWideVocabulary,
	captureContractError,
	compileWidenedContract,
	compositeShape,
	createHostileKeys,
	createNativeMaximumSparseArray,
	createProxiedBrandDeclaration,
	createRevokedArrayProxy,
	createNonEnumerableRecord,
	buildSparseArray,
	createRevokedProxy,
	createThrowingGetter,
	ForgedBrandDeclaration,
	LateMutation,
	leafShapeVariations,
	NullBaseDeclaration,
	ObservedShape,
	PatternFixture,
	replaceIntrinsic,
	replaceStringIterator,
	replaceStringSlice,
	redirectIntrinsic,
	SHAPE_SEPARATIONS,
	SOUNDNESS_SAMPLE,
	StrippedBrandDeclaration,
	StringDeclaration,
	TERMINAL_CONSTRUCTORS,
	throwHostileAccess,
} from '../../setup.js'
import {
	createForeignPrototype,
	createForeignRegExp,
	createForeignStringShape,
} from '../../setupServer.js'
import * as core from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'

type ShapeByType<T extends ContractShape['type']> = Extract<ContractShape, { readonly type: T }>

type CompleteShape<T extends ContractShape['type']> = {
	readonly [K in keyof ShapeByType<T>]-?: ShapeByType<T>[K]
}

const COMPLETE_RAW_SCHEMA: JSONSchema = {
	type: 'object',
	description: 'complete',
	enum: ['x', 1, true],
	minLength: 0,
	maxLength: 1,
	pattern: '^x$',
	format: 'custom',
	minimum: 0,
	maximum: 1,
	minItems: 0,
	maxItems: 1,
	items: { type: 'string' },
	properties: { value: { type: 'string' } },
	required: ['value'],
	additionalProperties: { type: 'string' },
	anyOf: [{ type: 'string' }],
	oneOf: [{ type: 'number' }],
}

const COMPLETE_SHAPES = {
	string: {
		type: 'string',
		min: 0,
		max: 1,
		pattern: /^x$/,
		description: 'complete',
	},
	number: { type: 'number', min: 0, max: 1, integer: true, description: 'complete' },
	boolean: { type: 'boolean', description: 'complete' },
	null: { type: 'null', description: 'complete' },
	literal: { type: 'literal', values: ['x', 1, true], description: 'complete' },
	array: {
		type: 'array',
		items: { type: 'string' },
		min: 0,
		max: 1,
		description: 'complete',
	},
	object: {
		type: 'object',
		properties: { value: { type: 'string' } },
		additionalProperties: { type: 'string' },
		description: 'complete',
	},
	union: {
		type: 'union',
		variants: [{ type: 'string' }, { type: 'number' }],
		mode: 'anyOf',
		description: 'complete',
	},
	optional: { type: 'optional', inner: { type: 'string' } },
	nullable: { type: 'nullable', inner: { type: 'string' } },
	json: { type: 'json', description: 'complete' },
	raw: { type: 'raw', schema: COMPLETE_RAW_SCHEMA },
} satisfies { readonly [T in ContractShape['type']]: CompleteShape<T> }

describe('validator consolidation (R6-A)', () => {
	it('publishes one eager shape-validation function over the public ShapeValidator', () => {
		const surface: object = core

		expect(Object.hasOwn(surface, 'ShapeValidator')).toBe(true)
		expect(Object.hasOwn(surface, 'validateShapeDepth')).toBe(true)
		// The deprecated second door is gone, with no alias behind it. Its whole
		// body re-ran rules the shared gate already enforces, and a second name for
		// one rule set is a second contract waiting to drift apart from the first.
		expect(Object.hasOwn(surface, 'validateShape')).toBe(false)
	})

	it('keeps every rule the removed prepass rechecked, at the remaining door', () => {
		// The three the removed body walked the graph a second time for.
		expect(
			captureContractError(() => validateShapeDepth(buildDeepShape(COMPILE_DEPTH_LIMIT + 1))),
		).toMatchObject({
			code: 'depth',
			message: 'validateShapeDepth: a shape exceeds the compilation depth limit',
		})
		expect(
			captureContractError(() =>
				validateShapeDepth({ type: 'number', integer: true, min: 2.5, max: 2.6 }),
			),
		).toMatchObject({
			code: 'range',
			message: 'validateShapeDepth: an integer number shape has an empty integer range',
		})
		expect(
			captureContractError(() =>
				validateShapeDepth({ type: 'array', items: optionalShape(stringShape()) }),
			),
		).toMatchObject({
			code: 'placement',
			message:
				'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		})
	})

	it('keeps every rule the removed prepass rechecked, at createContract', () => {
		// `createContract` ran the prepass on its OWNED snapshot, so the snapshot is
		// where the loss would show if the gate were now weaker than the prepass.
		expect(
			captureContractError(() => createContract(buildDeepShape(COMPILE_DEPTH_LIMIT + 1))).code,
		).toBe('depth')
		expect(
			captureContractError(() =>
				createContract({ type: 'number', integer: true, min: 2.5, max: 2.6 }),
			).code,
		).toBe('range')
		expect(
			captureContractError(() =>
				createContract({ type: 'array', items: optionalShape(stringShape()) }),
			).code,
		).toBe('placement')
		// Control: the legal placement still compiles, so the rule above is a
		// placement rule rather than a ban on `optionalShape`.
		expect(() => createContract(objectShape({ bio: optionalShape(stringShape()) }))).not.toThrow()
	})
})

describe('validateShapeDepth', () => {
	it.each([
		[
			'cloneShape',
			(shape: ContractShape) => cloneShape(shape),
			'validateShapeDepth: every structural child must be a shape',
		],
		[
			'ownShape',
			(shape: ContractShape) => ownShape(shape),
			'validateShapeDepth: every structural child must be a shape',
		],
		[
			'validateShapeDepth',
			(shape: ContractShape) => validateShapeDepth(shape),
			'validateShapeDepth: every structural child must be a shape',
		],
		[
			'compileSchema',
			(shape: ContractShape) => compileSchema(shape),
			'validateShapeDepth: every structural child must be a shape',
		],
		[
			'compileGuard',
			(shape: ContractShape) => compileGuard(shape),
			'validateShapeDepth: every structural child must be a shape',
		],
		[
			'compileParser',
			(shape: ContractShape) => compileParser(shape),
			'validateShapeDepth: every structural child must be a shape',
		],
		[
			'compileGenerator',
			(shape: ContractShape) => compileGenerator(shape, () => 0),
			'validateShapeDepth: every structural child must be a shape',
		],
		[
			'compileReporter',
			(shape: ContractShape) => compileReporter(shape, undefined),
			'validateShapeDepth: every structural child must be a shape',
		],
		[
			'compileAuditor',
			(shape: ContractShape) => compileAuditor(shape, undefined),
			'validateShapeDepth: every structural child must be a shape',
		],
		[
			'createContract',
			(shape: ContractShape) => createContract(shape),
			'validateShapeDepth: every structural child must be a shape',
		],
	] satisfies ReadonlyArray<readonly [string, (shape: ContractShape) => unknown, string]>)(
		'%s refuses an accessor-backed property entry without invoking it',
		(_name, entry, message) => {
			let reads = 0
			const properties: Record<string, ContractShape> = {}
			Object.defineProperty(properties, 'value', {
				enumerable: true,
				get() {
					reads += 1
					return stringShape()
				},
			})
			const error = captureContractError(() => entry({ type: 'object', properties }))

			expect(reads).toBe(0)
			expect(error.code).toBe('structure')
			expect(error.message).toBe(message)
			expect(error.context?.path).toEqual(['properties', 'value'])
		},
	)

	it.each([
		['cloneShape', (shape: ContractShape) => cloneShape(shape), true],
		['ownShape', (shape: ContractShape) => ownShape(shape), true],
		['validateShapeDepth', (shape: ContractShape) => validateShapeDepth(shape), false],
		['compileSchema', (shape: ContractShape) => compileSchema(shape), true],
		['compileGuard', (shape: ContractShape) => compileGuard(shape), true],
		['compileParser', (shape: ContractShape) => compileParser(shape), true],
		['compileGenerator', (shape: ContractShape) => compileGenerator(shape, () => 0), true],
		['compileReporter', (shape: ContractShape) => compileReporter(shape, undefined), true],
		['compileAuditor', (shape: ContractShape) => compileAuditor(shape, undefined), true],
		// `createContract` reaches the declaration through OWNERSHIP now, exactly
		// like the six standalone compilers beside it. It used to gate the caller's
		// live source first and answer in the gate's vocabulary; that pass was
		// discarded work over a population the artifacts never saw, and removing it
		// leaves one population with one refusal vocabulary at every entry.
		['createContract', (shape: ContractShape) => createContract(shape), true],
	] satisfies ReadonlyArray<readonly [string, (shape: ContractShape) => unknown, boolean]>)(
		'%s applies descriptor-first accessor policy across all 38 node fields',
		(_name, entry, ownership) => {
			let fields = 0
			for (const source of Object.values(COMPLETE_SHAPES)) {
				const category = source.type
				for (const field of Object.keys(source)) {
					fields += 1
					let reads = 0
					let root: ContractShape = structuredClone(source)
					let node = root
					if (category === 'optional') {
						root = { type: 'object', properties: { value: root } }
						if (root.type === 'object') {
							const child = root.properties.value
							if (child !== undefined) node = child
						}
					}
					const captured: unknown = Reflect.get(source, field)
					Object.defineProperty(node, field, {
						enumerable: true,
						configurable: true,
						get() {
							reads += 1
							return field === 'pattern' ? Object.freeze(new RegExp('')) : captured
						},
					})

					const outcome = attempt(() => entry(root))
					expect(outcome.success, `${category}.${field}`).toBe(field === 'pattern')
					expect(field === 'pattern' ? reads >= 2 : reads === 0, `${category}.${field}`).toBe(true)
					if (outcome.success) continue
					expect(isContractError(outcome.error), `${category}.${field}`).toBe(true)
					if (!isContractError(outcome.error)) continue
					const prefix = category === 'optional' ? ['properties', 'value'] : []
					const path = field === 'type' ? prefix : [...prefix, field]
					const message =
						field === 'type'
							? ownership
								? 'cloneShape: every node needs an own data discriminant'
								: 'validateShapeDepth: every node must be a recognized shape'
							: ownership
								? 'cloneShape: shape accessors cannot be owned faithfully'
								: 'validateShapeDepth: every node must be a recognized shape'
					expect(outcome.error.code, `${category}.${field}`).toBe('structure')
					expect(outcome.error.message, `${category}.${field}`).toBe(message)
					expect(outcome.error.context?.path, `${category}.${field}`).toEqual(path)
				}
			}
			expect(fields).toBe(38)
		},
	)

	it.each([
		['cloneShape', (shape: ContractShape) => cloneShape(shape)],
		['ownShape', (shape: ContractShape) => ownShape(shape)],
		['compileSchema', (shape: ContractShape) => compileSchema(shape)],
		['compileGuard', (shape: ContractShape) => compileGuard(shape)],
		['compileParser', (shape: ContractShape) => compileParser(shape)],
		['compileGenerator', (shape: ContractShape) => compileGenerator(shape, () => 0)],
		['compileReporter', (shape: ContractShape) => compileReporter(shape, undefined)],
		['compileAuditor', (shape: ContractShape) => compileAuditor(shape, undefined)],
	] satisfies ReadonlyArray<readonly [string, (shape: ContractShape) => unknown]>)(
		'%s performs two present-data node-field reads and none after capture',
		(_name, entry) => {
			let reads = 0
			const source = new Proxy({ type: 'string', min: 1 } satisfies ContractShape, {
				get(target, property, receiver) {
					if (property !== 'min') return Reflect.get(target, property, receiver)
					reads += 1
					return reads <= 2 ? 1 : 3
				},
			})

			entry(source)

			expect(reads).toBe(2)
		},
	)

	it('compiles the one population createContract captured, in ownership reads alone', () => {
		// The single-population contract, bound by a source that would ANSWER
		// differently on a later read. `createContract` used to gate the caller's
		// live declaration, throw that reading away, and then capture a second,
		// possibly different one — so a shape's own schema could describe a
		// population no walk had validated. It now performs exactly ownership's
		// reads and compiles exactly what ownership captured, so the phase this
		// source would have offered a third and fourth reader is never reached and
		// cannot appear in an artifact.
		let reads = 0
		let descriptors = 0
		const source = new Proxy({ type: 'string', min: 1 } satisfies ContractShape, {
			get(target, property, receiver) {
				if (property !== 'min') return Reflect.get(target, property, receiver)
				reads += 1
				if (reads <= 2) return 1
				return 3
			},
			getOwnPropertyDescriptor(target, property) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, property)
				if (property !== 'min' || descriptor === undefined) return descriptor
				descriptors += 1
				return { ...descriptor, value: descriptors === 1 ? 1 : 3 }
			},
		})

		const contract = createContract(source)

		expect(contract.schema.minLength).toBe(1)
		expect(contract.is('x')).toBe(true)
		expect(contract.is('')).toBe(false)
		expect(reads).toBe(2)
		expect(descriptors).toBe(1)
	})

	it.each([
		['cloneShape', (shape: ContractShape) => cloneShape(shape)],
		['ownShape', (shape: ContractShape) => ownShape(shape)],
		['compileSchema', (shape: ContractShape) => compileSchema(shape)],
		['compileGuard', (shape: ContractShape) => compileGuard(shape)],
		['compileParser', (shape: ContractShape) => compileParser(shape)],
		['compileGenerator', (shape: ContractShape) => compileGenerator(shape, () => 0)],
		['compileReporter', (shape: ContractShape) => compileReporter(shape, undefined)],
		['compileAuditor', (shape: ContractShape) => compileAuditor(shape, undefined)],
		// The row this table gained when `createContract`'s discarded pre-ownership
		// walk was removed: it now reads a property entry exactly as often as the
		// eight doors above it, because it reaches the declaration the same way.
		['createContract', (shape: ContractShape) => createContract(shape)],
	] satisfies ReadonlyArray<readonly [string, (shape: ContractShape) => unknown]>)(
		'%s retains the two-read property-entry population without a third read',
		(_name, entry) => {
			const captured = numberShape()
			const later = stringShape()
			let reads = 0
			const properties = new Proxy(
				{ value: captured },
				{
					get(target, property, receiver) {
						if (property !== 'value') return Reflect.get(target, property, receiver)
						reads += 1
						return reads <= 2 ? captured : later
					},
				},
			)

			entry({ type: 'object', properties })

			expect(reads).toBe(2)
		},
	)

	it('compiles every artifact from the two-read createContract property population', () => {
		// The control for the refusal below, and the positive half of the
		// single-population claim: whatever the entry answers on a THIRD read
		// cannot appear in a schema, a guard, or a parser, because no reader
		// arrives to ask.
		const captured = numberShape()
		const later = stringShape()
		let reads = 0
		const properties = new Proxy(
			{ value: captured },
			{
				get(target, property, receiver) {
					if (property !== 'value') return Reflect.get(target, property, receiver)
					reads += 1
					return reads <= 2 ? captured : later
				},
			},
		)

		const contract = createContract({ type: 'object', properties })

		expect(contract.schema.properties?.value).toEqual({ type: 'number' })
		expect(contract.is({ value: 1 })).toBe(true)
		expect(contract.is({ value: 'x' })).toBe(false)
		expect(contract.parse({ value: 1 })).toEqual({ value: 1 })
		expect(contract.parse({ value: 'x' })).toBeUndefined()
		expect(reads).toBe(2)
	})

	it('refuses an invalid captured property population rather than compiling it', () => {
		// The population ownership CAPTURES is the population that is validated —
		// one walk, one verdict. The earlier two-population arrangement could
		// validate a legal entry and then capture an illegal one, which is why this
		// case needed a fourth-read instrument to reach at all; it is now reachable
		// on the entry's own first reads and refused there.
		const invalid: ContractShape = JSON.parse('{"type":"string","min":"invalid"}')
		let reads = 0
		const properties = new Proxy(
			{ value: invalid },
			{
				get(target, property, receiver) {
					if (property !== 'value') return Reflect.get(target, property, receiver)
					reads += 1
					return invalid
				},
			},
		)

		const error = captureContractError(() => createContract({ type: 'object', properties }))

		expect(reads).toBe(2)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('validateShapeDepth: string min must be a number')
		expect(error.context?.path).toEqual(['properties', 'value', 'min'])
	})

	it('carries every exhaustive category-field population and certifies membership', () => {
		const alternates = new Map<string, unknown>([
			['string.type', 'boolean'],
			['string.min', 1],
			['string.max', 2],
			['string.pattern', /^y$/],
			['string.description', 'alternate'],
			['number.type', 'boolean'],
			['number.min', -1],
			['number.max', 2],
			['number.integer', false],
			['number.description', 'alternate'],
			['boolean.type', 'null'],
			['boolean.description', 'alternate'],
			['null.type', 'boolean'],
			['null.description', 'alternate'],
			['literal.type', 'boolean'],
			['literal.values', ['alternate']],
			['literal.description', 'alternate'],
			['array.type', 'boolean'],
			['array.items', { type: 'number' }],
			['array.min', 1],
			['array.max', 2],
			['array.description', 'alternate'],
			['object.type', 'boolean'],
			['object.properties', { alternate: { type: 'number' } }],
			['object.additionalProperties', { type: 'number' }],
			['object.description', 'alternate'],
			['union.type', 'boolean'],
			['union.variants', [{ type: 'boolean' }, { type: 'null' }]],
			['union.mode', 'oneOf'],
			['union.description', 'alternate'],
			['optional.type', 'nullable'],
			['optional.inner', { type: 'number' }],
			['nullable.type', 'boolean'],
			['nullable.inner', { type: 'number' }],
			['json.type', 'boolean'],
			['json.description', 'alternate'],
			['raw.type', 'boolean'],
			['raw.schema', { type: 'number' }],
		])
		const members: string[] = []

		for (const source of Object.values(COMPLETE_SHAPES)) {
			const category = source.type
			for (const field of Object.keys(source)) {
				const name = `${category}.${field}`
				members.push(name)
				expect(alternates.has(name)).toBe(true)
				const alternate = alternates.get(name)

				let stableRoot: ContractShape = structuredClone(source)
				if (category === 'optional') {
					stableRoot = { type: 'object', properties: { value: stableRoot } }
				}
				const stableSchema = compileSchema(stableRoot)

				let laterRoot: ContractShape = structuredClone(source)
				let laterNode = laterRoot
				if (category === 'optional') {
					laterRoot = { type: 'object', properties: { value: laterRoot } }
					if (laterRoot.type === 'object') {
						const child = laterRoot.properties.value
						if (child !== undefined) laterNode = child
					}
				}
				Reflect.set(laterNode, field, alternate)
				const laterSchema = compileSchema(laterRoot)
				expect(laterSchema, `${name} observable opposite`).not.toEqual(stableSchema)

				const target: ContractShape = structuredClone(source)
				const captured: unknown = Reflect.get(target, field)
				let reads = 0
				const changing = new Proxy(target, {
					get(current, property, receiver) {
						if (property !== field) return Reflect.get(current, property, receiver)
						reads += 1
						return reads <= 2 ? captured : alternate
					},
				})
				let changingRoot: ContractShape = changing
				if (category === 'optional') {
					changingRoot = { type: 'object', properties: { value: changing } }
				}

				const clone = cloneShape(changingRoot)
				expect(compileSchema(clone), `${name} carried population`).toEqual(stableSchema)
				expect(reads, `${name} read schedule`).toBe(2)

				const prefix = category === 'optional' ? ['properties', 'value'] : []
				const path = field === 'type' ? prefix : [...prefix, field]
				const disagreementMessage =
					field === 'type'
						? 'cloneShape: every node needs an own data discriminant'
						: 'cloneShape: shape fields must be stable data'

				const describedTarget: ContractShape = structuredClone(source)
				const described = new Proxy(describedTarget, {
					get(current, property, receiver) {
						if (property !== field) return Reflect.get(current, property, receiver)
						return alternate
					},
				})
				let describedRoot: ContractShape = described
				if (category === 'optional') {
					describedRoot = { type: 'object', properties: { value: described } }
				}
				const describedError = captureContractError(() => cloneShape(describedRoot))
				expect(describedError.code, `${name} descriptor disagreement`).toBe('structure')
				expect(describedError.message, `${name} descriptor disagreement`).toBe(disagreementMessage)
				expect(describedError.context?.path, `${name} descriptor disagreement`).toEqual(path)

				let disagreementReads = 0
				const repeatedTarget: ContractShape = structuredClone(source)
				const repeatedCaptured: unknown = Reflect.get(repeatedTarget, field)
				const repeated = new Proxy(repeatedTarget, {
					get(current, property, receiver) {
						if (property !== field) return Reflect.get(current, property, receiver)
						disagreementReads += 1
						return disagreementReads === 1 ? repeatedCaptured : alternate
					},
				})
				let repeatedRoot: ContractShape = repeated
				if (category === 'optional') {
					repeatedRoot = { type: 'object', properties: { value: repeated } }
				}
				const repeatedError = captureContractError(() => cloneShape(repeatedRoot))
				expect(repeatedError.code, `${name} repeated disagreement`).toBe('structure')
				expect(repeatedError.message, `${name} repeated disagreement`).toBe(disagreementMessage)
				expect(repeatedError.context?.path, `${name} repeated disagreement`).toEqual(path)

				const inheritedNode: ContractShape = structuredClone(source)
				Reflect.deleteProperty(inheritedNode, field)
				let inheritedReads = 0
				// A genuine foreign realm's own `Object.prototype`, polluted only in
				// that realm: the node stays a plain record whose declared field is
				// reachable but inherited, which is the population this case exists
				// to refuse.
				const prototype = createForeignPrototype()
				Object.defineProperty(prototype, field, {
					get() {
						inheritedReads += 1
						return captured
					},
				})
				Object.setPrototypeOf(inheritedNode, prototype)
				let inheritedRoot: ContractShape = inheritedNode
				if (category === 'optional') {
					inheritedRoot = { type: 'object', properties: { value: inheritedNode } }
				}
				const inheritedError = captureContractError(() => cloneShape(inheritedRoot))
				expect(inheritedReads, `${name} inherited invocation`).toBe(0)
				expect(inheritedError.code, `${name} inherited code`).toBe('structure')
				expect(inheritedError.message, `${name} inherited message`).toBe(
					field === 'type'
						? 'cloneShape: every node needs an own data discriminant'
						: 'cloneShape: inherited shape fields cannot be owned',
				)
				expect(inheritedError.context?.path, `${name} inherited path`).toEqual(path)

				const absentNode: ContractShape = structuredClone(source)
				Reflect.deleteProperty(absentNode, field)
				let absentRoot: ContractShape = absentNode
				if (category === 'optional') {
					absentRoot = { type: 'object', properties: { value: absentNode } }
				}
				const required =
					field === 'type' ||
					(category === 'literal' && field === 'values') ||
					(category === 'array' && field === 'items') ||
					(category === 'object' && field === 'properties') ||
					(category === 'union' && field === 'variants') ||
					((category === 'optional' || category === 'nullable') && field === 'inner') ||
					(category === 'raw' && field === 'schema')
				const absentOutcome = attempt(() => cloneShape(absentRoot))
				const absentError = absentOutcome.success ? undefined : absentOutcome.error
				expect(absentOutcome.success, `${name} absence`).toBe(!required)
				expect(isContractError(absentError), `${name} absence`).toBe(required)
				expect(isContractError(absentError) ? absentError.code : undefined).toBe(
					required ? 'structure' : undefined,
				)
				expect(isContractError(absentError) ? absentError.context?.path : undefined).toEqual(
					required ? path : undefined,
				)

				const descriptorTarget: ContractShape = structuredClone(source)
				const descriptorTrap = new Proxy(descriptorTarget, {
					getOwnPropertyDescriptor(current, property) {
						if (property === field) throw new Error('descriptor trap')
						return Reflect.getOwnPropertyDescriptor(current, property)
					},
				})
				let descriptorRoot: ContractShape = descriptorTrap
				if (category === 'optional') {
					descriptorRoot = { type: 'object', properties: { value: descriptorTrap } }
				}
				const descriptorError = captureContractError(() => cloneShape(descriptorRoot))
				expect(descriptorError.code, `${name} descriptor trap`).toBe('clone')
				expect(descriptorError.message, `${name} descriptor trap`).toBe(
					'cloneShape: failed to create an owned shape snapshot',
				)

				const getTarget: ContractShape = structuredClone(source)
				const getTrap = new Proxy(getTarget, {
					get(current, property, receiver) {
						if (property === field) throw new Error('get trap')
						return Reflect.get(current, property, receiver)
					},
				})
				let getRoot: ContractShape = getTrap
				if (category === 'optional') {
					getRoot = { type: 'object', properties: { value: getTrap } }
				}
				const getError = captureContractError(() => cloneShape(getRoot))
				expect(getError.code, `${name} get trap`).toBe('clone')
				expect(getError.message, `${name} get trap`).toBe(
					'cloneShape: failed to create an owned shape snapshot',
				)

				const presenceErrors: ContractError[] = []
				if (field !== 'type') {
					const presenceTarget: ContractShape = structuredClone(source)
					Reflect.deleteProperty(presenceTarget, field)
					const presenceTrap = new Proxy(presenceTarget, {
						has(current, property) {
							if (property === field) throw new Error('presence trap')
							return Reflect.has(current, property)
						},
					})
					let presenceRoot: ContractShape = presenceTrap
					if (category === 'optional') {
						presenceRoot = { type: 'object', properties: { value: presenceTrap } }
					}
					presenceErrors.push(captureContractError(() => cloneShape(presenceRoot)))
				}
				expect(presenceErrors.map((error) => error.code)).toEqual(field === 'type' ? [] : ['clone'])
				expect(presenceErrors.map((error) => error.message)).toEqual(
					field === 'type' ? [] : ['cloneShape: failed to create an owned shape snapshot'],
				)
			}
		}

		expect(members).toHaveLength(38)
		expect([...alternates.keys()].sort()).toEqual([...members].sort())
		const incomplete = new Set(members)
		const omitted = incomplete.values().next().value
		if (omitted !== undefined) incomplete.delete(omitted)
		expect([...incomplete].sort()).not.toEqual([...alternates.keys()].sort())
	})

	it('refuses explicit raw populations and flagged patterns at all twelve declaration doors', () => {
		const properties: Record<string, JSONSchema> = {}
		Reflect.set(properties, 'value', undefined)
		const anyOf: JSONSchema[] = []
		Reflect.set(anyOf, '0', undefined)
		const oneOf: JSONSchema[] = []
		Reflect.set(oneOf, '0', undefined)
		const entries: ReadonlyArray<{
			readonly name: string
			readonly shape: ContractShape
			readonly message: string
			readonly code: 'structure' | 'pattern'
			readonly context: Readonly<Record<string, unknown>>
		}> = [
			{
				name: 'raw properties undefined',
				shape: { type: 'raw', schema: { properties } },
				message: 'validateShapeDepth: every raw schema child must be a plain record',
				code: 'structure',
				context: { path: ['schema'] },
			},
			{
				name: 'raw anyOf undefined',
				shape: { type: 'raw', schema: { anyOf } },
				message: 'validateShapeDepth: every raw schema child must be a plain record',
				code: 'structure',
				context: { path: ['schema'] },
			},
			{
				name: 'raw oneOf undefined',
				shape: { type: 'raw', schema: { oneOf } },
				message: 'validateShapeDepth: every raw schema child must be a plain record',
				code: 'structure',
				context: { path: ['schema'] },
			},
			{
				name: 'flagged string',
				shape: { type: 'string', pattern: /a/i },
				message:
					'validateShapeDepth: a string shape pattern must not use flags; use inline pattern constructs instead',
				code: 'pattern',
				context: { path: [], shape: 'string', received: '/a/i' },
			},
		]
		let randomReads = 0

		for (const entry of entries) {
			const outcomes = [
				{ name: 'ownShape', outcome: attempt(() => ownShape(entry.shape)) },
				{ name: 'cloneShape', outcome: attempt(() => cloneShape(entry.shape)) },
				{
					name: 'ShapeValidator.validate',
					outcome: attempt(() => new ShapeValidator(entry.shape).validate()),
				},
				{
					name: 'validateShapeDepth',
					outcome: attempt(() => validateShapeDepth(entry.shape)),
				},
				{ name: 'compileSchema', outcome: attempt(() => compileSchema(entry.shape)) },
				{ name: 'compileGuard', outcome: attempt(() => compileGuard(entry.shape)) },
				{ name: 'compileParser', outcome: attempt(() => compileParser(entry.shape)) },
				{
					name: 'compileGenerator',
					outcome: attempt(() =>
						compileGenerator(entry.shape, () => {
							randomReads += 1
							return 0
						}),
					),
				},
				{
					name: 'compileReporter',
					outcome: attempt(() => compileReporter(entry.shape, undefined)),
				},
				{
					name: 'compileAuditor',
					outcome: attempt(() => compileAuditor(entry.shape, undefined)),
				},
				{ name: 'createContract', outcome: attempt(() => createContract(entry.shape)) },
			]
			expect(outcomes.map((result) => result.name)).toEqual([
				'ownShape',
				'cloneShape',
				'ShapeValidator.validate',
				'validateShapeDepth',
				'compileSchema',
				'compileGuard',
				'compileParser',
				'compileGenerator',
				'compileReporter',
				'compileAuditor',
				'createContract',
			])
			for (const result of outcomes) {
				expect(result.outcome.success, `${entry.name} at ${result.name}`).toBe(false)
				if (result.outcome.success) continue
				expect(isContractError(result.outcome.error), `${entry.name} at ${result.name}`).toBe(true)
				if (!isContractError(result.outcome.error)) continue
				expect(result.outcome.error.message, `${entry.name} at ${result.name}`).toBe(entry.message)
				expect(result.outcome.error.code, `${entry.name} at ${result.name}`).toBe(entry.code)
				expect(result.outcome.error.context, `${entry.name} at ${result.name}`).toEqual(
					entry.context,
				)
				expect(Object.hasOwn(result.outcome.error, 'cause')).toBe(false)
			}
		}
		expect(randomReads).toBe(0)

		for (const schema of [
			{},
			{ properties: {} },
			{ properties: { value: {} } },
			{ anyOf: [{}] },
			{ oneOf: [{}] },
		]) {
			const error = captureContractError(() =>
				compileGenerator({ type: 'raw', schema }, () => {
					randomReads += 1
					return 0
				}),
			)
			expect(error.code).toBe('generate')
			expect(error.message).toContain('cannot be auto-generated')
		}
		expect(randomReads).toBe(0)

		const plain = { type: 'string', pattern: /a/ } satisfies ContractShape
		const inline = { type: 'string', pattern: /[aA]/ } satisfies ContractShape
		expect(compileSchema(plain).pattern).toBe('a')
		expect(compileGuard(plain)('A')).toBe(false)
		expect(compileParser(plain)('A')).toBeUndefined()
		expect(compileSchema(inline).pattern).toBe('[aA]')
		expect(compileGuard(inline)('A')).toBe(true)
		expect(compileParser(inline)('A')).toBe('A')
	})

	it('reports an unrecognized shape identically at the root and every structural slot', () => {
		const unknown: ContractShape = structuredClone(COMPLETE_SHAPES.string)
		Reflect.set(unknown, 'type', 'nope')
		const shapes = [
			unknown,
			{ type: 'array', items: unknown },
			{ type: 'object', properties: { value: unknown } },
			{ type: 'object', properties: {}, additionalProperties: unknown },
			{ type: 'union', variants: [unknown] },
			{ type: 'optional', inner: unknown },
			{ type: 'nullable', inner: unknown },
		] satisfies readonly ContractShape[]
		for (const shape of shapes) {
			const outcomes = [
				attempt(() => ownShape(shape)),
				attempt(() => cloneShape(shape)),
				attempt(() => validateShapeDepth(shape)),
				attempt(() => compileSchema(shape)),
				attempt(() => compileGuard(shape)),
				attempt(() => compileParser(shape)),
				attempt(() => compileGenerator(shape, () => 0)),
				attempt(() => compileReporter(shape, undefined)),
				attempt(() => compileAuditor(shape, undefined)),
				attempt(() => createContract(shape)),
			]
			expect(outcomes).toHaveLength(10)
			for (const outcome of outcomes) {
				expect(outcome.success).toBe(false)
				if (outcome.success) continue
				expect(isContractError(outcome.error)).toBe(true)
				if (!isContractError(outcome.error)) continue
				expect(outcome.error.code).toBe('structure')
				expect(outcome.error.message).toBe(
					'validateShapeDepth: every node must be a recognized shape',
				)
			}
		}
	})

	it('rejects the six measured laundering inputs while accepting their controls', () => {
		const literalString = structuredClone(COMPLETE_SHAPES.literal)
		Reflect.set(literalString, 'values', 'abc')
		const literalObject = structuredClone(COMPLETE_SHAPES.literal)
		Reflect.set(literalObject, 'values', new String('ab'))
		const literalTyped = structuredClone(COMPLETE_SHAPES.literal)
		Reflect.set(literalTyped, 'values', new Uint8Array([1, 2]))
		const rawProperties = structuredClone(COMPLETE_SHAPES.raw)
		Reflect.set(rawProperties.schema, 'properties', new Date())
		const rawItems = structuredClone(COMPLETE_SHAPES.raw)
		Reflect.set(rawItems.schema, 'items', new Date())
		const rawAdditional = structuredClone(COMPLETE_SHAPES.raw)
		Reflect.set(rawAdditional.schema, 'additionalProperties', new Map())
		const cases: ReadonlyArray<{
			readonly malformed: ContractShape
			readonly control: ContractShape
		}> = [
			{
				malformed: literalString,
				control: { type: 'literal', values: ['a', 'b', 'c'] },
			},
			{
				malformed: literalObject,
				control: { type: 'literal', values: ['a', 'b'] },
			},
			{
				malformed: literalTyped,
				control: { type: 'literal', values: [1, 2] },
			},
			{
				malformed: rawProperties,
				control: {
					type: 'union',
					variants: [{ type: 'raw', schema: { properties: {} } }, { type: 'string' }],
				},
			},
			{
				malformed: rawItems,
				control: {
					type: 'union',
					variants: [{ type: 'raw', schema: { items: {} } }, { type: 'string' }],
				},
			},
			{
				malformed: rawAdditional,
				control: {
					type: 'union',
					variants: [{ type: 'raw', schema: { additionalProperties: {} } }, { type: 'string' }],
				},
			},
		]
		for (const entry of cases) {
			const malformed = [
				attempt(() => ownShape(entry.malformed)),
				attempt(() => cloneShape(entry.malformed)),
				attempt(() => validateShapeDepth(entry.malformed)),
				attempt(() => compileSchema(entry.malformed)),
				attempt(() => compileGuard(entry.malformed)),
				attempt(() => compileParser(entry.malformed)),
				attempt(() => compileGenerator(entry.malformed, () => 0)),
				attempt(() => compileReporter(entry.malformed, undefined)),
				attempt(() => compileAuditor(entry.malformed, undefined)),
				attempt(() => createContract(entry.malformed)),
			]
			const controls = [
				attempt(() => ownShape(entry.control)),
				attempt(() => cloneShape(entry.control)),
				attempt(() => validateShapeDepth(entry.control)),
				attempt(() => compileSchema(entry.control)),
				attempt(() => compileGuard(entry.control)),
				attempt(() => compileParser(entry.control)),
				attempt(() => compileGenerator(entry.control, () => 0)),
				attempt(() => compileReporter(entry.control, undefined)),
				attempt(() => compileAuditor(entry.control, undefined)),
				attempt(() => createContract(entry.control)),
			]
			expect(malformed.every((outcome) => !outcome.success)).toBe(true)
			expect(controls.every((outcome) => outcome.success)).toBe(true)
		}
	})

	it('rejects integer-empty ranges and misplaced optionals at all eleven shape entries', () => {
		const malformed: ReadonlyArray<{
			readonly shape: ContractShape
			readonly code: 'range' | 'placement'
		}> = [
			{
				shape: JSON.parse('{"type":"number","integer":true,"min":1.2,"max":1.8}'),
				code: 'range',
			},
			{
				shape: JSON.parse('{"type":"optional","inner":{"type":"string"}}'),
				code: 'placement',
			},
		]

		for (const entry of malformed) {
			const outcomes = [
				{ name: 'ownShape', outcome: attempt(() => ownShape(entry.shape)) },
				{ name: 'cloneShape', outcome: attempt(() => cloneShape(entry.shape)) },
				{
					name: 'validateShapeDepth',
					outcome: attempt(() => validateShapeDepth(entry.shape)),
				},
				{ name: 'compileSchema', outcome: attempt(() => compileSchema(entry.shape)) },
				{ name: 'compileGuard', outcome: attempt(() => compileGuard(entry.shape)) },
				{ name: 'compileParser', outcome: attempt(() => compileParser(entry.shape)) },
				{
					name: 'compileGenerator',
					outcome: attempt(() => compileGenerator(entry.shape, () => 0)),
				},
				{
					name: 'compileReporter',
					outcome: attempt(() => compileReporter(entry.shape, undefined)),
				},
				{
					name: 'compileAuditor',
					outcome: attempt(() => compileAuditor(entry.shape, undefined)),
				},
				{ name: 'createContract', outcome: attempt(() => createContract(entry.shape)) },
			]

			expect(outcomes.map((result) => result.name)).toEqual([
				'ownShape',
				'cloneShape',
				'validateShapeDepth',
				'compileSchema',
				'compileGuard',
				'compileParser',
				'compileGenerator',
				'compileReporter',
				'compileAuditor',
				'createContract',
			])
			for (const result of outcomes) {
				expect(result.outcome.success, `${result.name} accepted ${entry.code}`).toBe(false)
				if (result.outcome.success) continue
				expect(isContractError(result.outcome.error)).toBe(true)
				if (!isContractError(result.outcome.error)) continue
				expect(result.outcome.error.code).toBe(entry.code)
			}
		}

		const controls: readonly ContractShape[] = [
			integerShape({ min: 1.2, max: 2 }),
			objectShape({ value: optionalShape(stringShape()) }),
		]
		for (const control of controls) {
			const outcomes = [
				attempt(() => ownShape(control)),
				attempt(() => cloneShape(control)),
				attempt(() => validateShapeDepth(control)),
				attempt(() => compileSchema(control)),
				attempt(() => compileGuard(control)),
				attempt(() => compileParser(control)),
				attempt(() => compileGenerator(control, () => 0)),
				attempt(() => compileReporter(control, undefined)),
				attempt(() => compileAuditor(control, undefined)),
				attempt(() => createContract(control)),
			]
			expect(outcomes).toHaveLength(10)
			expect(outcomes.every((outcome) => outcome.success)).toBe(true)
		}
	})

	it('rejects malformed raw-schema keywords recursively before emission', () => {
		const malformedSchemas: readonly JSONSchema[] = JSON.parse(`[
			{"enum":[]},
			{"pattern":"["},
			{"type":"bogus"},
			{"description":5},
			{"minLength":-1},
			{"maxLength":1.5},
			{"format":5},
			{"minimum":null},
			{"maximum":"x"},
			{"minItems":-1},
			{"maxItems":1.5},
			{"items":[]},
			{"properties":[]},
			{"required":"x"},
			{"required":["x","x"]},
			{"additionalProperties":1},
			{"anyOf":[]},
			{"oneOf":[]}
		]`)

		for (const schema of malformedSchemas) {
			const shape: RawShape = { type: 'raw', schema }
			const compilation = captureContractError(() => compileSchema(shape))
			const construction = captureContractError(() => rawShape(schema))
			expect(compilation.code).toBe('structure')
			expect(construction.code).toBe('structure')
		}

		const nested: JSONSchema = JSON.parse(
			'{"type":"object","properties":{"value":{"items":{"type":"bogus"}}}}',
		)
		expect(captureContractError(() => compileSchema({ type: 'raw', schema: nested })).code).toBe(
			'structure',
		)
		const unsupported: JSONSchema = JSON.parse('{"const":"x"}')
		expect(
			captureContractError(() => compileSchema({ type: 'raw', schema: unsupported })).code,
		).toBe('structure')

		const control: JSONSchema = {
			type: 'object',
			description: 'supported vocabulary',
			properties: {
				value: {
					type: 'array',
					minItems: 0,
					maxItems: 2,
					items: {
						type: 'string',
						minLength: 1,
						maxLength: 3,
						pattern: '^x+$',
						format: 'custom',
					},
				},
			},
			required: ['value'],
			additionalProperties: {
				anyOf: [{ enum: ['x', 1, true] }, { oneOf: [{ type: 'null' }] }],
			},
		}
		expect(() => compileSchema(rawShape(control))).not.toThrow()
	})

	it('rejects every malformed string and array length bound before contract compilation', () => {
		const shapes: readonly ContractShape[] = [
			{ type: 'string', min: Number.NaN },
			{ type: 'string', max: Number.POSITIVE_INFINITY },
			{ type: 'string', min: -1 },
			{ type: 'string', max: 1.5 },
			{ type: 'array', items: stringShape(), min: Number.NaN },
			{
				type: 'array',
				items: stringShape(),
				max: Number.POSITIVE_INFINITY,
			},
			{ type: 'array', items: stringShape(), min: -1 },
			{ type: 'array', items: stringShape(), max: 1.5 },
		]

		for (const shape of shapes) {
			const error = captureContractError(() => createContract(shape))
			expect(error.code).toBe('bound')
			expect(error.context?.limit).toBe('non-negative safe integer')
		}
	})

	it('throws coded ContractError categories for every malformed-shape policy', () => {
		const malformedInteger: ContractShape = JSON.parse(
			'{"type":"number","integer":true,"min":2.5,"max":2.6}',
		)
		const cases: ReadonlyArray<{
			readonly shape: ContractShape
			readonly code: 'range' | 'empty' | 'placement' | 'literal'
		}> = [
			{ shape: { type: 'string', min: 5, max: 1 }, code: 'range' },
			{ shape: malformedInteger, code: 'range' },
			{ shape: JSON.parse('{"type":"literal","values":[]}'), code: 'empty' },
			{ shape: JSON.parse('{"type":"union","variants":[]}'), code: 'empty' },
			{ shape: optionalShape(stringShape()), code: 'placement' },
			{ shape: { type: 'literal', values: [Number.NaN] }, code: 'literal' },
		]

		for (const entry of cases) {
			expect(() => validateShapeDepth(entry.shape)).toThrowError(ContractError)
			const error = captureContractError(() => validateShapeDepth(entry.shape))
			expect(isContractError(error)).toBe(true)
			expect(error.code).toBe(entry.code)
		}
	})

	it('raises a cycle ContractError with the item path for a self-referential array shape', () => {
		const raw = JSON.parse('{"type":"array","items":{"type":"string"}}')
		raw.items = raw
		const shape: ContractShape = raw

		expect(() => validateShapeDepth(shape)).toThrowError(ContractError)
		const error = captureContractError(() => validateShapeDepth(shape))
		expect(error).toBeInstanceOf(ContractError)
		expect(error.code).toBe('cycle')
		expect(error.message).toBe('validateShapeDepth: a shape graph may not contain a cycle')
		expect(error.context?.path).toEqual(['items'])
	})

	it('raises a cycle ContractError with the property path for a self-referential object shape', () => {
		const raw = JSON.parse('{"type":"object","properties":{}}')
		raw.properties.self = raw
		const shape: ContractShape = raw

		expect(() => validateShapeDepth(shape)).toThrowError(ContractError)
		const error = captureContractError(() => validateShapeDepth(shape))
		expect(error).toBeInstanceOf(ContractError)
		expect(error.code).toBe('cycle')
		expect(error.context?.path).toEqual(['properties', 'self'])
	})

	it('raises a cycle ContractError with the variant path for a self-referential union shape', () => {
		const raw = JSON.parse('{"type":"union","variants":[]}')
		raw.variants.push(raw)
		const shape: ContractShape = raw

		expect(() => validateShapeDepth(shape)).toThrowError(ContractError)
		const error = captureContractError(() => validateShapeDepth(shape))
		expect(error).toBeInstanceOf(ContractError)
		expect(error.code).toBe('cycle')
		expect(error.context?.path).toEqual(['variants', '0'])
	})

	it('allows a shared child reached through separate non-cyclic paths', () => {
		const child = objectShape({ value: stringShape() })
		expect(() => validateShapeDepth(objectShape({ first: child, second: child }))).not.toThrow()
	})

	it('throws on an optional shape used as an array item', () => {
		expect(() => validateShapeDepth(arrayShape(optionalShape(stringShape())))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as a union variant', () => {
		expect(() =>
			validateShapeDepth(unionShape(optionalShape(stringShape()), integerShape())),
		).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as a nullable inner', () => {
		expect(() => validateShapeDepth(nullableShape(optionalShape(stringShape())))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as another optional inner', () => {
		expect(() => validateShapeDepth(optionalShape(optionalShape(stringShape())))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as additionalProperties', () => {
		expect(() =>
			validateShapeDepth(objectShape({}, { additionalProperties: optionalShape(stringShape()) })),
		).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on a top-level optional shape', () => {
		expect(() => validateShapeDepth(optionalShape(stringShape()))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an empty union', () => {
		expect(() => validateShapeDepth(unionShape())).toThrow(
			'validateShapeDepth: a union shape needs at least one variant',
		)
	})

	it('throws on an empty literal', () => {
		expect(() => validateShapeDepth(literalShape([]))).toThrow(
			'validateShapeDepth: a literal shape needs at least one value',
		)
	})

	it('refuses an impossible literal length before indexed work', () => {
		let reads = 0
		const values = new Proxy(['value'], {
			get(target, key, receiver) {
				if (key === 'length') return 2 ** 32
				return Reflect.get(target, key, receiver)
			},
			getOwnPropertyDescriptor(target, key) {
				if (key === '0') {
					reads += 1
					throw new Error('index descriptor must not be read')
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			},
		})
		const shape: ContractShape = { type: 'literal', values }

		const error = captureContractError(() => validateShapeDepth(shape))

		expect(error.code).toBe('structure')
		expect(error.message).toContain('validateShapeDepth: values must be a finite literal array')
		expect(reads).toBe(0)
	})

	it('refuses an impossible union length before indexed work', () => {
		let reads = 0
		const variants = new Proxy([stringShape()], {
			get(target, key, receiver) {
				if (key === 'length') return 2 ** 32
				return Reflect.get(target, key, receiver)
			},
			getOwnPropertyDescriptor(target, key) {
				if (key === '0') {
					reads += 1
					throw new Error('index descriptor must not be read')
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			},
		})
		const shape: ContractShape = { type: 'union', variants }

		const error = captureContractError(() => validateShapeDepth(shape))

		expect(error.code).toBe('structure')
		expect(error.message).toContain('validateShapeDepth: variants must be a finite array')
		expect(reads).toBe(0)
	})

	it('refuses sparse literal and union populations at the shared declaration gate', () => {
		const values: LiteralValue[] = []
		values.length = 2
		values[0] = 'present'
		const literalError = captureContractError(() => validateShapeDepth({ type: 'literal', values }))
		expect(literalError.code).toBe('structure')
		expect(literalError.message).toBe('validateShapeDepth: values must be a dense data array')

		const variants: ContractShape[] = []
		variants.length = 2
		variants[0] = stringShape()
		const unionError = captureContractError(() => validateShapeDepth({ type: 'union', variants }))
		expect(unionError.code).toBe('structure')
		expect(unionError.message).toBe('validateShapeDepth: variants must be a dense data array')
		expect(unionError.context?.path).toEqual(['variants'])
	})

	it('throws on a literal shape containing a non-finite number value', () => {
		expect(() => validateShapeDepth(literalShape([Number.NaN]))).toThrow(
			'validateShapeDepth: a literal shape may not contain non-finite number values',
		)
		expect(() => validateShapeDepth(literalShape([Number.POSITIVE_INFINITY]))).toThrow(
			'validateShapeDepth: a literal shape may not contain non-finite number values',
		)
		expect(() => validateShapeDepth(literalShape([Number.NEGATIVE_INFINITY]))).toThrow(
			'validateShapeDepth: a literal shape may not contain non-finite number values',
		)
		// A finite number literal alongside other values still passes.
		expect(() => validateShapeDepth(literalShape([1, 'a', 2.5]))).not.toThrow()
	})

	it('throws on a string shape with min greater than max', () => {
		expect(() => validateShapeDepth({ type: 'string', min: 5, max: 1 })).toThrow(
			'validateShapeDepth: a string shape has min greater than max',
		)
	})

	it('throws on a number shape with min greater than max', () => {
		expect(() => validateShapeDepth(numberShape({ min: 5, max: 1 }))).toThrow(
			'validateShapeDepth: a number shape has min greater than max',
		)
	})

	it('rejects non-finite hand-authored number and integer bounds with bound errors', () => {
		const shapes: readonly ContractShape[] = [
			{ type: 'number', min: Number.NaN },
			{ type: 'number', integer: true, max: Number.POSITIVE_INFINITY },
		]

		for (const shape of shapes) {
			const error = captureContractError(() => validateShapeDepth(shape))
			expect(error.code).toBe('bound')
			expect(error.context?.limit).toBe('finite number')
		}
	})

	it('accepts the compilation depth boundary and rejects the next level without RangeError', () => {
		expect(() => createContract(buildDeepShape(COMPILE_DEPTH_LIMIT))).not.toThrow()

		const error = captureContractError(() =>
			createContract(buildDeepShape(COMPILE_DEPTH_LIMIT + 1)),
		)
		expect(error.code).toBe('depth')
		expect(error).not.toBeInstanceOf(RangeError)
		expect(error.context?.limit).toBe(COMPILE_DEPTH_LIMIT)
	})

	it('publishes the established compilation depth limit', () => {
		expect(COMPILE_DEPTH_LIMIT).toBe(512)
	})

	it('reports depth from the structural gate before validateShapeDepth reaches its duplicate branch', () => {
		const error = captureContractError(() =>
			validateShapeDepth(buildDeepShape(COMPILE_DEPTH_LIMIT + 1)),
		)

		expect(error.code).toBe('depth')
		expect(error.message).toBe('validateShapeDepth: a shape exceeds the compilation depth limit')
	})

	it('rejects excessive depth at every standalone compiler entry before recursion', () => {
		let shape: ContractShape = stringShape()
		for (let level = 0; level < 5_000; level += 1) shape = { type: 'array', items: shape }
		const schemaError = captureContractError(() => compileSchema(shape))
		const guardError = captureContractError(() => compileGuard(shape))
		const parserError = captureContractError(() => compileParser(shape))
		const generatorError = captureContractError(() => compileGenerator(shape, () => 0))
		const reporterError = captureContractError(() => compileReporter(shape, undefined))

		for (const error of [schemaError, guardError, parserError, generatorError, reporterError]) {
			expect(error.code).toBe('depth')
			expect(error).not.toBeInstanceOf(RangeError)
			expect(error.context?.limit).toBe(COMPILE_DEPTH_LIMIT)
		}
	})

	it('publishes the established compilation node limit', () => {
		expect(COMPILE_NODE_LIMIT).toBe(16_384)
	})

	it('refuses a declaration whose compiled expansion exceeds the node limit, at every compiler entry', () => {
		// The bound is on the EMITTED tree, not on the authored graph: fourteen
		// shared-child object nodes over one leaf are fifteen authored nodes and
		// 2 ** 15 - 1 emitted ones. The level below it is the control that makes
		// this instrument discriminating rather than uniformly refusing — it
		// expands to 2 ** 14 - 1, one under the cap, and must COMPILE.
		const accepted = buildSharedDagShape(13)
		const measured = new ShapeValidator(accepted)
		measured.validate()
		expect(measured.expansion).toBe(16_383)
		expect(() => createContract(accepted)).not.toThrow()

		const refused = buildSharedDagShape(14)
		const doors = [
			() => compileSchema(refused),
			() => compileGuard(refused),
			() => compileParser(refused),
			() => compileGenerator(refused, () => 0),
			() => compileReporter(refused, undefined),
			() => compileAuditor(refused, undefined),
			() => validateShapeDepth(refused),
			() => validateShapeDepth(refused),
			() => createContract(refused),
		]
		for (const door of doors) {
			const error = captureContractError(door)
			expect(error.code).toBe('expansion')
			expect(error.message).toBe(
				'validateShapeDepth: a shape expands past the compilation node limit',
			)
			expect(error.context?.limit).toBe(COMPILE_NODE_LIMIT)
			expect(error.context?.received).toBe('32767')
			expect(error.context?.path).toEqual([])
		}
	})

	it('leaves ownership unbounded by the node limit, so a wide DAG still clones', () => {
		// The stated asymmetry: ownership preserves shared-child identity, so it
		// costs authored nodes and keeps answering far above the emitted-node cap
		// that stops compilation. Thirty levels expand to 2 ** 31 - 1 emitted
		// nodes; the clone is thirty-one nodes and returns immediately.
		const wide = buildSharedDagShape(30)
		const started = Date.now()
		const owned = ownShape(wide)

		expect(Date.now() - started).toBeLessThan(1_000)
		expect(owned.type).toBe('object')
		expect(Object.isFrozen(owned)).toBe(true)
		expect(captureContractError(() => compileSchema(owned)).code).toBe('expansion')
	})

	it('throws on an array shape with min greater than max', () => {
		expect(() => validateShapeDepth(arrayShape(stringShape(), { min: 5, max: 1 }))).toThrow(
			'validateShapeDepth: an array shape has min greater than max',
		)
	})

	it('throws on an integer shape with an empty integer range', () => {
		expect(() => validateShapeDepth(integerShape({ min: 2.5, max: 2.6 }))).toThrow(
			'validateShapeDepth: an integer number shape has an empty integer range',
		)
	})

	it('does not throw on legal placements', () => {
		// optional as a direct object property
		expect(() =>
			validateShapeDepth(objectShape({ bio: optionalShape(stringShape()) })),
		).not.toThrow()
		// bounds where min === max
		expect(() => validateShapeDepth(stringShape({ min: 3, max: 3 }))).not.toThrow()
		expect(() => validateShapeDepth(numberShape({ min: 3, max: 3 }))).not.toThrow()
		expect(() => validateShapeDepth(arrayShape(stringShape(), { min: 2, max: 2 }))).not.toThrow()
		expect(() => validateShapeDepth(integerShape({ min: 2, max: 3 }))).not.toThrow()
		// null / json / raw / boolean leaves
		expect(() => validateShapeDepth(nullShape())).not.toThrow()
		expect(() => validateShapeDepth(jsonShape())).not.toThrow()
		expect(() => validateShapeDepth(rawShape({}))).not.toThrow()
		expect(() => validateShapeDepth(booleanShape())).not.toThrow()
		// nested legal composites
		expect(() =>
			validateShapeDepth(
				objectShape({
					tags: arrayShape(
						objectShape({
							id: stringShape(),
							note: optionalShape(stringShape()),
						}),
					),
					kind: unionShape(nullShape(), jsonShape(), rawShape({})),
					meta: nullableShape(objectShape({ value: optionalShape(integerShape()) })),
					extra: optionalShape(recordShape(jsonShape())),
				}),
			),
		).not.toThrow()
	})
})

describe('malformed shape children', () => {
	it('contains a revoked Proxy root at every compiler and contract entry point', () => {
		const source: { readonly shape: ContractShape } = JSON.parse('{}')
		Object.defineProperty(source, 'shape', { value: createRevokedProxy() })
		const shape = source.shape
		const errors = [
			() => compileSchema(shape),
			() => compileGuard(shape),
			() => compileParser(shape),
			() => compileGenerator(shape, () => 0),
			() => compileReporter(shape, undefined),
			() => compileAuditor(shape, undefined),
			() => createContract(shape),
		].map((operation) => captureContractError(operation).code)

		// Seven doors, one code. `createContract` used to answer `structure` here
		// because a discarded pre-ownership walk met the revoked proxy first; it now
		// meets it where the other six do, so an unreadable root is an ownership
		// refusal at every entry rather than at six of seven.
		expect(errors).toEqual(['clone', 'clone', 'clone', 'clone', 'clone', 'clone', 'clone'])
	})

	it('contains hostile roots across ownership, validation, compilation, and contracts', () => {
		const revokedSource: { readonly shape: ContractShape } = JSON.parse('{}')
		Object.defineProperty(revokedSource, 'shape', {
			value: createRevokedProxy(),
		})

		const throwing: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(throwing, 'type', {
			enumerable: true,
			get() {
				throw 'caller getter'
			},
		})

		const revokedCodes = [
			() => ownShape(revokedSource.shape),
			() => cloneShape(revokedSource.shape),
			() => validateShapeDepth(revokedSource.shape),
			() => validateShapeDepth(revokedSource.shape),
		].map((operation) => captureContractError(operation).code)

		expect(revokedCodes).toEqual(['clone', 'clone', 'structure', 'structure'])

		const throwingCodes = [
			() => ownShape(throwing),
			() => cloneShape(throwing),
			() => validateShapeDepth(throwing),
			() => validateShapeDepth(throwing),
			() => compileSchema(throwing),
			() => compileGuard(throwing),
			() => compileParser(throwing),
			() => compileGenerator(throwing, () => 0),
			() => compileReporter(throwing, undefined),
			() => compileAuditor(throwing, undefined),
			() => createContract(throwing),
		].map((operation) => captureContractError(operation).code)

		expect(throwingCodes).toEqual([
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
		])

		const primitive: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(primitive, Symbol.toPrimitive, {
			value() {
				throw new Error('primitive trap')
			},
		})
		expect(() => String(primitive)).toThrow('primitive trap')
		const outcomes = [
			attempt(() => ownShape(primitive)),
			attempt(() => cloneShape(primitive)),
			attempt(() => validateShapeDepth(primitive)),
			attempt(() => compileSchema(primitive)),
			attempt(() => compileGuard(primitive)),
			attempt(() => compileParser(primitive)),
			attempt(() => compileGenerator(primitive, () => 0)),
			attempt(() => compileReporter(primitive, '')),
			attempt(() => compileAuditor(primitive, '')),
			attempt(() => createContract(primitive)),
		]

		expect(outcomes.every((outcome) => outcome.success)).toBe(true)
	})

	it('rejects non-primitive scalar fields before any standalone compiler uses them', () => {
		const trap = Object.freeze({
			[Symbol.toPrimitive]() {
				throw new Error('symbol trap')
			},
		})
		const fields: ReadonlyArray<{
			readonly shape: ContractShape
			readonly field: string
			readonly path: readonly string[]
		}> = [
			{
				shape: JSON.parse('{"type":"string"}'),
				field: 'min',
				path: ['min'],
			},
			{
				shape: JSON.parse('{"type":"string"}'),
				field: 'max',
				path: ['max'],
			},
			{
				shape: JSON.parse('{"type":"string"}'),
				field: 'pattern',
				path: ['pattern'],
			},
			{
				shape: JSON.parse('{"type":"number"}'),
				field: 'min',
				path: ['min'],
			},
			{
				shape: JSON.parse('{"type":"number"}'),
				field: 'max',
				path: ['max'],
			},
			{
				shape: JSON.parse('{"type":"number"}'),
				field: 'integer',
				path: ['integer'],
			},
			{
				shape: JSON.parse('{"type":"array","items":{"type":"string"}}'),
				field: 'min',
				path: ['min'],
			},
			{
				shape: JSON.parse('{"type":"array","items":{"type":"string"}}'),
				field: 'max',
				path: ['max'],
			},
			{
				shape: JSON.parse('{"type":"union","variants":[{"type":"string"}]}'),
				field: 'mode',
				path: ['mode'],
			},
			{
				shape: JSON.parse('{"type":"string"}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"number"}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"boolean"}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"null"}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"literal","values":["ok"]}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"array","items":{"type":"string"}}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"object","properties":{}}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"union","variants":[{"type":"string"}]}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"json"}'),
				field: 'description',
				path: ['description'],
			},
		]

		for (const entry of fields) {
			Object.defineProperty(entry.shape, entry.field, {
				value: trap,
				enumerable: true,
			})
			Object.freeze(entry.shape)
			const errors = [
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, '')),
				captureContractError(() => compileAuditor(entry.shape, '')),
				captureContractError(() => createContract(entry.shape)),
			]
			for (const error of errors) {
				expect(error.code).toBe('structure')
				expect(error.context?.path).toEqual(entry.path)
			}
		}

		const literal: ContractShape = JSON.parse('{"type":"literal","values":[null]}')
		if (literal.type !== 'literal') throw new Error('test setup: expected a literal shape')
		Object.defineProperty(literal.values, '0', {
			value: trap,
			enumerable: true,
		})
		Object.freeze(literal.values)
		Object.freeze(literal)
		for (const error of [
			captureContractError(() => validateShapeDepth(literal)),
			captureContractError(() => compileSchema(literal)),
			captureContractError(() => compileGuard(literal)),
			captureContractError(() => compileParser(literal)),
			captureContractError(() => compileGenerator(literal, () => 0)),
			captureContractError(() => compileReporter(literal, '')),
			captureContractError(() => compileAuditor(literal, '')),
			captureContractError(() => createContract(literal)),
		]) {
			expect(error.code).toBe('structure')
			expect(error.context?.path).toEqual(['values', '0'])
		}
	})

	it('distinguishes corrupt nodes, structural children, property maps, and variant arrays', () => {
		const missing: { readonly child: ContractShape } = JSON.parse('{}')
		const cases: ReadonlyArray<{
			readonly shape: ContractShape
			readonly message: string
		}> = [
			{
				shape: JSON.parse('{}'),
				message: 'validateShapeDepth: every node must be a recognized shape',
			},
			{
				shape: { type: 'array', items: missing.child },
				message: 'validateShapeDepth: every structural child must be a shape',
			},
			{
				shape: JSON.parse('{"type":"object"}'),
				message: 'validateShapeDepth: properties must be a plain property map',
			},
			{
				shape: JSON.parse('{"type":"union"}'),
				message: 'validateShapeDepth: variants must be a finite array',
			},
		]

		for (const entry of cases) {
			const error = captureContractError(() => validateShapeDepth(entry.shape))
			expect(error.code).toBe('structure')
			expect(error.message).toBe(entry.message)
		}
	})

	it('contains hostile structural reflection and rejects inherited discriminants', () => {
		const revocable = Proxy.revocable({}, {})
		revocable.revoke()
		const revokedSource: { readonly child: ContractShape } = JSON.parse('{}')
		Object.defineProperty(revokedSource, 'child', {
			value: revocable.proxy,
		})

		const throwing: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(throwing, 'type', {
			get() {
				throw new Error('boom from getter')
			},
		})

		const inheritedSource: { readonly child: ContractShape } = JSON.parse('{}')
		Object.setPrototypeOf(inheritedSource, {
			child: Object.freeze(Object.create({ type: 'string' })),
		})
		const revokedArray: ContractShape = { type: 'array', items: revokedSource.child }
		const throwingArray: ContractShape = { type: 'array', items: throwing }
		const cases: readonly ContractShape[] = [
			Object.freeze(revokedArray),
			Object.freeze(throwingArray),
			inheritedSource.child,
		]

		for (const shape of cases) {
			const errors = [
				captureContractError(() => validateShapeDepth(shape)),
				captureContractError(() => compileSchema(shape)),
				captureContractError(() => compileGuard(shape)),
				captureContractError(() => compileParser(shape)),
				captureContractError(() => compileGenerator(shape, () => 0)),
				captureContractError(() => compileReporter(shape, undefined)),
				captureContractError(() => compileAuditor(shape, undefined)),
			]
			for (const error of errors) {
				expect(error.code).toBe('structure')
				expect(error).not.toBeInstanceOf(TypeError)
			}
		}
	})

	it('contains hostile fields and revoked proxies in every structural slot at depth', () => {
		let reads = 0
		const secondRead: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(secondRead, 'description', {
			enumerable: true,
			get() {
				reads += 1
				if (reads % 2 === 0) throw new Error('second read')
				return 'stable once'
			},
		})
		Object.freeze(secondRead)

		// A genuine pattern with a throwing OWN `source` accessor is NOT in the
		// refusal corpus any more: source and flags are read through the accessor
		// captured from `RegExp.prototype`, which answers from the internal slots, so
		// the own decoy is never consulted and the honest schema is available.
		const pattern = /safe/
		Object.defineProperty(pattern, 'source', {
			get() {
				throw new Error('pattern source')
			},
		})
		Object.freeze(pattern)
		const hostilePattern: ContractShape = Object.freeze({
			type: 'string',
			pattern,
		})
		expect(compileSchema(hostilePattern)).toEqual({ type: 'string', pattern: 'safe' })
		expect(compileGuard(hostilePattern)('safe')).toBe(true)
		expect(compileGuard(hostilePattern)('other')).toBe(false)

		const hostileProperties = new Proxy<Record<string, ContractShape>>(
			{},
			{
				ownKeys() {
					throw new Error('property keys')
				},
			},
		)
		const propertiesShape: ContractShape = Object.freeze({
			type: 'object',
			properties: hostileProperties,
		})

		const pollutedSource: { readonly child: ContractShape } = JSON.parse('{}')
		Object.defineProperty(pollutedSource, 'child', {
			value: Object.freeze(Object.create({ type: 'string' })),
		})

		const items = Proxy.revocable<ContractShape>(JSON.parse('{"type":"string"}'), {})
		const properties = Proxy.revocable<Record<string, ContractShape>>({}, {})
		const additional = Proxy.revocable<ContractShape>(JSON.parse('{"type":"string"}'), {})
		const variants = Proxy.revocable<ContractShape[]>([stringShape()], {})
		const values = Proxy.revocable<LiteralValue[]>(['ok'], {})
		const optional = Proxy.revocable<ContractShape>(JSON.parse('{"type":"string"}'), {})
		const nullable = Proxy.revocable<ContractShape>(JSON.parse('{"type":"string"}'), {})
		const schema = Proxy.revocable<JSONSchema>({}, {})
		items.revoke()
		properties.revoke()
		additional.revoke()
		variants.revoke()
		values.revoke()
		optional.revoke()
		nullable.revoke()
		schema.revoke()

		const revokedShapes: ContractShape[] = [
			Object.freeze({ type: 'array', items: items.proxy }),
			Object.freeze({ type: 'object', properties: properties.proxy }),
			Object.freeze({
				type: 'object',
				properties: Object.freeze({}),
				additionalProperties: additional.proxy,
			}),
			Object.freeze({ type: 'union', variants: variants.proxy }),
			Object.freeze({ type: 'literal', values: values.proxy }),
			Object.freeze({ type: 'optional', inner: optional.proxy }),
			Object.freeze({ type: 'nullable', inner: nullable.proxy }),
			Object.freeze({ type: 'raw', schema: schema.proxy }),
		]
		const nested: ContractShape = {
			type: 'object',
			properties: {
				outer: {
					type: 'array',
					items: {
						type: 'object',
						properties: { inner: revokedShapes[0] ?? stringShape() },
					},
				},
			},
		}
		Object.freeze(nested)
		const polluted: ContractShape = { type: 'array', items: pollutedSource.child }
		const cases = [secondRead, propertiesShape, Object.freeze(polluted), nested, ...revokedShapes]

		for (const shape of cases) {
			for (const error of [
				captureContractError(() => validateShapeDepth(shape)),
				captureContractError(() => compileSchema(shape)),
				captureContractError(() => compileGuard(shape)),
				captureContractError(() => compileParser(shape)),
				captureContractError(() => compileGenerator(shape, () => 0)),
				captureContractError(() => compileReporter(shape, undefined)),
				captureContractError(() => compileAuditor(shape, undefined)),
				captureContractError(() => createContract(shape)),
			]) {
				expect(error.code).toBe('structure')
				expect(error).not.toBeInstanceOf(TypeError)
				expect(error).not.toBeInstanceOf(RangeError)
			}
		}
	})

	it('rejects a structural array whose reported length is not finite', () => {
		const shape: ContractShape = JSON.parse('{"type":"union","variants":[]}')
		const variants = new Proxy([], {
			get(target, key, receiver) {
				return key === 'length' ? Number.POSITIVE_INFINITY : Reflect.get(target, key, receiver)
			},
		})
		Object.defineProperty(shape, 'variants', { value: variants })

		const error = captureContractError(() => validateShapeDepth(shape))
		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['variants'])
	})

	it('reports structural corruption before cycles regardless of property insertion order', () => {
		const codes: string[] = []
		for (const order of [
			['cycle', 'bad'],
			['bad', 'cycle'],
		]) {
			const cycle: ContractShape = JSON.parse('{"type":"array","items":{}}')
			Object.defineProperty(cycle, 'items', { value: cycle })
			const properties: Record<string, ContractShape> = Object.create(null)
			const missing: { readonly child: ContractShape } = JSON.parse('{}')
			for (const key of order) properties[key] = key === 'cycle' ? cycle : missing.child
			const error = captureContractError(() => validateShapeDepth({ type: 'object', properties }))
			codes.push(error.code)
		}

		expect(codes).toEqual(['structure', 'structure'])
	})

	it('rejects every non-shape child with a structure ContractError at every entry point', () => {
		const source: { readonly child: ContractShape } = JSON.parse('{}')
		const child = source.child
		const cases: ReadonlyArray<{
			readonly shape: ContractShape
			readonly path: readonly string[]
		}> = [
			{
				shape: { type: 'object', properties: { k: child } },
				path: ['properties', 'k'],
			},
			{ shape: { type: 'array', items: child }, path: ['items'] },
			{
				shape: { type: 'union', variants: [stringShape(), child] },
				path: ['variants', '1'],
			},
			{
				shape: { type: 'union', variants: [stringShape(), child], mode: 'oneOf' },
				path: ['variants', '1'],
			},
			{ shape: { type: 'optional', inner: child }, path: ['inner'] },
			{ shape: { type: 'nullable', inner: child }, path: ['inner'] },
		]

		for (const entry of cases) {
			const depth = captureContractError(() => validateShapeDepth(entry.shape))
			const schema = captureContractError(() => compileSchema(entry.shape))
			const guard = captureContractError(() => compileGuard(entry.shape))
			const parser = captureContractError(() => compileParser(entry.shape))
			const generator = captureContractError(() => compileGenerator(entry.shape, () => 0))
			const reporter = captureContractError(() => compileReporter(entry.shape, undefined))
			const auditor = captureContractError(() => compileAuditor(entry.shape, undefined))

			for (const error of [depth, schema, guard, parser, generator, reporter, auditor]) {
				expect(error.code).toBe('structure')
				expect(error.context?.path).toEqual(entry.path)
				expect(error).not.toBeInstanceOf(TypeError)
			}
		}
	})

	it('rejects every structural slot before ownership can erase an unfrozen malformed child', () => {
		const missing: ContractShape = JSON.parse('{"type":"object","properties":{}}')
		if (missing.type !== 'object') throw new Error('test setup: expected an object shape')
		Object.defineProperty(missing.properties, 'missing', {
			value: undefined,
			enumerable: true,
		})
		const cases: ReadonlyArray<{
			readonly shape: ContractShape
			readonly path: readonly string[]
		}> = [
			{
				shape: JSON.parse('{"type":"array","items":42}'),
				path: ['items'],
			},
			{
				shape: JSON.parse('{"type":"object","properties":{"value":42}}'),
				path: ['properties', 'value'],
			},
			{
				shape: missing,
				path: ['properties', 'missing'],
			},
			{
				shape: JSON.parse('{"type":"object","properties":{},"additionalProperties":42}'),
				path: ['additionalProperties'],
			},
			{
				shape: JSON.parse('{"type":"union","variants":[{"type":"string"},42]}'),
				path: ['variants', '1'],
			},
			{
				shape: JSON.parse('{"type":"optional","inner":42}'),
				path: ['inner'],
			},
			{
				shape: JSON.parse('{"type":"nullable","inner":42}'),
				path: ['inner'],
			},
		]

		for (const entry of cases) {
			const errors = [
				captureContractError(() => cloneShape(entry.shape)),
				captureContractError(() => ownShape(entry.shape)),
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, undefined)),
				captureContractError(() => compileAuditor(entry.shape, undefined)),
				captureContractError(() => createContract(entry.shape)),
			]

			for (const error of errors) {
				expect(error.code).toBe('structure')
				expect(error.context?.path).toEqual(entry.path)
			}
			const frozen = captureContractError(() => ownShape(Object.freeze(entry.shape)))
			expect(frozen.code).toBe('structure')
			expect(frozen.context?.path).toEqual(entry.path)
		}
	})

	it('rejects every declared bound domain at all eleven shape entry points', () => {
		const integral = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			-1,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
		]
		const finite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
		const cases: Array<{ readonly shape: ContractShape; readonly code: 'bound' | 'range' }> = []

		for (const boundary of ['min', 'max']) {
			for (const value of integral) {
				const string: ContractShape = { type: 'string', [boundary]: value }
				const array: ContractShape = {
					type: 'array',
					items: { type: 'string' },
					[boundary]: value,
				}
				cases.push({ shape: string, code: 'bound' }, { shape: array, code: 'bound' })
			}
			for (const value of finite) {
				const number: ContractShape = { type: 'number', [boundary]: value }
				cases.push({ shape: number, code: 'bound' })
			}
		}
		cases.push(
			{ shape: { type: 'string', min: 2, max: 1 }, code: 'range' },
			{
				shape: { type: 'array', items: { type: 'string' }, min: 2, max: 1 },
				code: 'range',
			},
			{ shape: { type: 'number', min: 2, max: 1 }, code: 'range' },
		)

		for (const entry of cases) {
			const errors = [
				captureContractError(() => cloneShape(entry.shape)),
				captureContractError(() => ownShape(entry.shape)),
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, undefined)),
				captureContractError(() => compileAuditor(entry.shape, undefined)),
				captureContractError(() => createContract(entry.shape)),
			]

			for (const error of errors) expect(error.code).toBe(entry.code)
			expect(captureContractError(() => ownShape(Object.freeze(entry.shape))).code).toBe(entry.code)
		}
	})

	it('rejects malformed scalar snapshots instead of normalizing them', () => {
		const cases: ReadonlyArray<{
			readonly shape: ContractShape
			readonly path: readonly string[]
		}> = [
			{ shape: JSON.parse('{"type":"string","pattern":"x"}'), path: ['pattern'] },
			{ shape: JSON.parse('{"type":"raw","schema":[]}'), path: ['schema'] },
		]

		for (const entry of cases) {
			const errors = [
				captureContractError(() => cloneShape(entry.shape)),
				captureContractError(() => ownShape(entry.shape)),
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, undefined)),
				captureContractError(() => compileAuditor(entry.shape, undefined)),
				captureContractError(() => createContract(entry.shape)),
			]

			for (const error of errors) {
				expect(error.code).toBe('structure')
				expect(error.context?.path).toEqual(entry.path)
			}
			const frozen = captureContractError(() => ownShape(Object.freeze(entry.shape)))
			expect(frozen.code).toBe('structure')
			expect(frozen.context?.path).toEqual(entry.path)
		}
	})

	it('gives one declaration rule one message at every door, across every policy family', () => {
		// The prefix rule, swept rather than sampled. The corpus above asserts a
		// message only where a case supplies one, so it could not see a door that
		// answered a shared-gate rule under its OWN name — and five did, all in the
		// declaration-POLICY families that corpus never reaches. Every code family
		// the shared gate owns is drawn here, and every message is compared against
		// the first door's rather than against itself.
		const cyclic: ContractShape = { type: 'array', items: { type: 'string' } }
		Reflect.set(cyclic, 'items', cyclic)
		let deep: ContractShape = { type: 'string' }
		for (let level = 0; level <= COMPILE_DEPTH_LIMIT + 1; level += 1) {
			deep = { type: 'array', items: deep }
		}
		const cases: ReadonlyArray<{ readonly name: string; readonly shape: ContractShape }> = [
			{ name: 'optional placement', shape: { type: 'array', items: optionalShape(stringShape()) } },
			{ name: 'integer range', shape: { type: 'number', integer: true, min: 0.2, max: 0.8 } },
			{ name: 'string min domain', shape: { type: 'string', min: -1 } },
			{ name: 'string range', shape: { type: 'string', min: 3, max: 1 } },
			{ name: 'array min domain', shape: { type: 'array', items: { type: 'string' }, min: -1 } },
			{ name: 'number min domain', shape: { type: 'number', min: Number.POSITIVE_INFINITY } },
			{ name: 'flagged pattern', shape: { type: 'string', pattern: /a/i } },
			{ name: 'empty union', shape: { type: 'union', variants: [] } },
			{ name: 'empty literal', shape: { type: 'literal', values: [] } },
			{
				name: 'non-finite literal',
				shape: { type: 'literal', values: [Number.POSITIVE_INFINITY] },
			},
			{ name: 'union mode', shape: JSON.parse('{"type":"union","variants":[],"mode":"allOf"}') },
			{ name: 'raw keyword', shape: { type: 'raw', schema: JSON.parse('{"nope":1}') } },
			{ name: 'cycle', shape: cyclic },
			{ name: 'depth', shape: deep },
		]
		const disobedient: string[] = []

		for (const entry of cases) {
			const doors = [
				{ name: 'cloneShape', outcome: attempt(() => cloneShape(entry.shape)) },
				{ name: 'ownShape', outcome: attempt(() => ownShape(entry.shape)) },
				{ name: 'validateShapeDepth', outcome: attempt(() => validateShapeDepth(entry.shape)) },
				{
					name: 'ShapeValidator.validate',
					outcome: attempt(() => new ShapeValidator(entry.shape).validate()),
				},
				{ name: 'compileSchema', outcome: attempt(() => compileSchema(entry.shape)) },
				{ name: 'compileGuard', outcome: attempt(() => compileGuard(entry.shape)) },
				{ name: 'compileParser', outcome: attempt(() => compileParser(entry.shape)) },
				{
					name: 'compileGenerator',
					outcome: attempt(() => compileGenerator(entry.shape, () => 0)),
				},
				{ name: 'compileReporter', outcome: attempt(() => compileReporter(entry.shape, '')) },
				{ name: 'compileAuditor', outcome: attempt(() => compileAuditor(entry.shape, '')) },
				{ name: 'createContract', outcome: attempt(() => createContract(entry.shape)) },
			]
			const observed = doors.map((door) => {
				if (door.outcome.success) return `${door.name}: accepted`
				if (!isContractError(door.outcome.error)) return `${door.name}: not a ContractError`
				return `${door.name}: ${door.outcome.error.code} ${door.outcome.error.message}`
			})
			const first = observed[0] ?? ''
			const rule = first.slice(first.indexOf(': ') + 2)
			for (const line of observed) {
				if (line.slice(line.indexOf(': ') + 2) !== rule) disobedient.push(`${entry.name} — ${line}`)
			}
			// The prefix names the boundary that OWNS the rule: every case here is a
			// declaration rule the shared gate enforces.
			if (!rule.includes('validateShapeDepth: ')) {
				disobedient.push(`${entry.name} — wrong owner: ${rule}`)
			}
		}

		expect(disobedient).toEqual([])
	})

	it('refuses under one vocabulary when a live source changes between ownership enumerations', () => {
		// One population does not mean one READ. Ownership enumerates a property
		// map twice, because two equal ordered key populations are what make the
		// capture faithful, and a live source can still make those two enumerations
		// disagree — this is the only instrument that reaches the disagreement.
		// Every disagreement must land on the SHARED rule vocabulary, named by the
		// boundary that owns the rule rather than by whichever enumeration tripped
		// on it: a rewrite the capture cannot copy is an ownership refusal, and one
		// that lands in the captured graph is a declaration refusal from the gate
		// that owns the rule.
		const misplaced: Record<string, unknown> = { type: 'string' }
		const misplacedHost: Record<string, unknown> = { type: 'array', items: misplaced }
		const placement = new LateMutation({ a: misplacedHost }, () => {
			Reflect.set(misplaced, 'type', 'optional')
			Reflect.set(misplaced, 'inner', { type: 'string' })
		})
		const looped: Record<string, unknown> = { type: 'string' }
		const loopedHost: Record<string, unknown> = { type: 'array', items: looped }
		const cycle = new LateMutation({ a: loopedHost }, () => {
			Reflect.set(looped, 'type', 'array')
			Reflect.set(looped, 'items', loopedHost)
		})
		const narrowed: Record<string, unknown> = { type: 'number' }
		const range = new LateMutation({ a: narrowed }, () => {
			Reflect.set(narrowed, 'integer', true)
			Reflect.set(narrowed, 'min', 0.2)
			Reflect.set(narrowed, 'max', 0.8)
		})
		const unreadableHost: Record<string, unknown> = { type: 'array', items: { type: 'string' } }
		const unreadable = new LateMutation({ a: unreadableHost }, () => {
			Reflect.set(unreadableHost, 'items', createRevokedProxy())
		})
		let tower: ContractShape = { type: 'string' }
		for (let level = 0; level <= COMPILE_DEPTH_LIMIT; level += 1) {
			tower = { type: 'array', items: tower }
		}
		const deepHost: Record<string, unknown> = { type: 'array', items: { type: 'string' } }
		const depth = new LateMutation({ a: deepHost }, () => {
			Reflect.set(deepHost, 'items', tower)
		})
		const observed = [placement, cycle, range, unreadable, depth].map((late) => {
			const error = captureContractError(() => createContract(late.shape))
			return { walks: late.walks, code: error.code, message: error.message }
		})

		expect(observed).toEqual([
			{
				walks: 2,
				code: 'placement',
				message:
					'validateShapeDepth: an optional shape may only appear as a direct object-property value',
			},
			{
				walks: 2,
				code: 'cycle',
				message: 'validateShapeDepth: a shape graph may not contain a cycle',
			},
			{
				walks: 2,
				code: 'range',
				message: 'validateShapeDepth: an integer number shape has an empty integer range',
			},
			// The one whose rewrite lands where the capture cannot copy it: the
			// refusal belongs to ownership and says so, rather than borrowing the
			// gate's vocabulary for a rule the gate never evaluated.
			{ walks: 2, code: 'clone', message: 'cloneShape: failed to create an owned shape snapshot' },
			// The tower arrives inside the captured graph, so the rule that refuses
			// it is the gate's and the third enumeration is ownership's own depth
			// diagnosis re-walking what it captured.
			{
				walks: 3,
				code: 'depth',
				message: 'validateShapeDepth: a shape exceeds the compilation depth limit',
			},
		])

		// The control the observation above is worthless without: a source that does
		// NOT change between enumerations compiles, so the five findings are the
		// mutation's doing rather than the instrument's.
		const stable = new LateMutation({ a: { type: 'string' } }, () => undefined)
		expect(() => createContract(stable.shape)).not.toThrow()
	})

	it('refuses every launderable declaration at all eleven named shape entry points', () => {
		const mapped: ContractShape = JSON.parse('{"type":"object","properties":{}}')
		Object.defineProperty(mapped, 'properties', { value: new Map(), enumerable: true })
		const inherited: ContractShape = JSON.parse('{}')
		Object.setPrototypeOf(inherited, { type: 'string' })
		const accessorType: ContractShape = JSON.parse('{}')
		Object.defineProperty(accessorType, 'type', {
			enumerable: true,
			get() {
				return 'string'
			},
		})
		const accessorMin: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(accessorMin, 'min', {
			enumerable: true,
			get() {
				return 1
			},
		})
		const dataSource = new PatternFixture('source', false)
		const dataFlags = new PatternFixture('flags', false)
		const accessorSource = new PatternFixture('source', true)
		const accessorFlags = new PatternFixture('flags', true)
		const cases: ReadonlyArray<{
			readonly name: string
			readonly shape: ContractShape
			readonly path?: readonly string[]
			readonly message?: string
		}> = [
			{
				name: 'array properties',
				shape: JSON.parse('{"type":"object","properties":[]}'),
			},
			{ name: 'Map properties', shape: mapped },
			{ name: 'record variants', shape: JSON.parse('{"type":"union","variants":{}}') },
			{
				name: 'array-like variants',
				shape: JSON.parse('{"type":"union","variants":{"length":0}}'),
			},
			{ name: 'inherited type', shape: inherited },
			{ name: 'accessor type', shape: accessorType },
			{ name: 'accessor min', shape: accessorMin },
			{
				name: 'class root',
				shape: new StringDeclaration(),
				path: [],
				message: 'validateShapeDepth: every structural child must be a shape',
			},
			{
				name: 'class child',
				shape: { type: 'array', items: new StringDeclaration() },
				path: ['items'],
				message: 'validateShapeDepth: every structural child must be a shape',
			},
			{
				name: 'reparented class root',
				shape: new NullBaseDeclaration(),
				path: [],
				message: 'validateShapeDepth: every structural child must be a shape',
			},
			{
				name: 'reparented class child',
				shape: { type: 'array', items: new NullBaseDeclaration() },
				path: ['items'],
				message: 'validateShapeDepth: every structural child must be a shape',
			},
		]
		// The four RegExp-scalar decoys are no longer launderable declarations,
		// because there is no longer anything to launder: a pattern's source and
		// flags are read through the captured `RegExp.prototype` accessors, so an
		// own data property or accessor carrying a `PatternCarrier` is never
		// consulted and never coerced. Asserted here, beside the corpus they left,
		// so their removal is a recorded outcome rather than a quiet deletion.
		for (const decoy of [dataSource, dataFlags, accessorSource, accessorFlags]) {
			expect(compileSchema(decoy.shape)).toEqual({ type: 'string', pattern: 'a' })
			expect(decoy.carrier.count).toBe(0)
		}

		for (const entry of cases) {
			const outcomes = [
				{ name: 'cloneShape', outcome: attempt(() => cloneShape(entry.shape)) },
				{ name: 'ownShape', outcome: attempt(() => ownShape(entry.shape)) },
				{
					name: 'validateShapeDepth',
					outcome: attempt(() => validateShapeDepth(entry.shape)),
				},
				{ name: 'compileSchema', outcome: attempt(() => compileSchema(entry.shape)) },
				{ name: 'compileGuard', outcome: attempt(() => compileGuard(entry.shape)) },
				{ name: 'compileParser', outcome: attempt(() => compileParser(entry.shape)) },
				{
					name: 'compileGenerator',
					outcome: attempt(() => compileGenerator(entry.shape, () => 0)),
				},
				{
					name: 'compileReporter',
					outcome: attempt(() => compileReporter(entry.shape, '')),
				},
				{
					name: 'compileAuditor',
					outcome: attempt(() => compileAuditor(entry.shape, '')),
				},
				{ name: 'createContract', outcome: attempt(() => createContract(entry.shape)) },
			]

			expect(outcomes.map((outcome) => outcome.name)).toEqual([
				'cloneShape',
				'ownShape',
				'validateShapeDepth',
				'compileSchema',
				'compileGuard',
				'compileParser',
				'compileGenerator',
				'compileReporter',
				'compileAuditor',
				'createContract',
			])
			for (const result of outcomes) {
				expect(result.outcome.success, `${entry.name} at ${result.name}`).toBe(false)
				if (result.outcome.success) continue
				expect(isContractError(result.outcome.error), `${entry.name} at ${result.name}`).toBe(true)
				if (!isContractError(result.outcome.error)) continue
				expect(result.outcome.error.code, `${entry.name} at ${result.name}`).toBe('structure')
				expect(result.outcome.error.context?.path, `${entry.name} at ${result.name}`).toEqual(
					entry.path ?? result.outcome.error.context?.path,
				)
				// One declaration rule, one diagnostic, at every door: the reader
				// prefix names the boundary that OWNS the rule, not the engine that
				// happened to run it, so a caller reads the same message whichever
				// entry point they called.
				expect(result.outcome.error.message, `${entry.name} at ${result.name}`).toBe(
					entry.message ?? result.outcome.error.message,
				)
			}
		}

		const nullPrototype: ContractShape = { type: 'string' }
		Object.setPrototypeOf(nullPrototype, null)
		const stable = /a/
		Object.defineProperties(stable, {
			flags: { get: () => '' },
			source: { get: () => 'a' },
		})
		const foreignPattern = createForeignRegExp('a')
		if (!isRegExp(foreignPattern)) throw new Error('expected a genuine foreign RegExp')
		for (const control of [
			stringShape(),
			nullPrototype,
			createForeignStringShape(),
			{ type: 'string', pattern: /a/ },
			{ type: 'string', pattern: stable },
			{ type: 'string', pattern: foreignPattern },
			stringShape({ pattern: /a/ }),
		]) {
			const controls = [
				attempt(() => Reflect.apply(cloneShape, undefined, [control])),
				attempt(() => Reflect.apply(ownShape, undefined, [control])),
				attempt(() => Reflect.apply(validateShapeDepth, undefined, [control])),
				attempt(() => Reflect.apply(compileSchema, undefined, [control])),
				attempt(() => Reflect.apply(compileGuard, undefined, [control])),
				attempt(() => Reflect.apply(compileParser, undefined, [control])),
				attempt(() => Reflect.apply(compileGenerator, undefined, [control, () => 0])),
				attempt(() => Reflect.apply(compileReporter, undefined, [control, ''])),
				attempt(() => Reflect.apply(compileAuditor, undefined, [control, ''])),
				attempt(() => Reflect.apply(createContract, undefined, [control])),
			]
			expect(controls.every((outcome) => outcome.success)).toBe(true)
		}
	})

	it('refuses a malformed declaration as a ContractError at every door under every redirection', () => {
		// The repaired-claim re-ask. The declaration gate was fixed where the
		// defect arrived — `ShapeValidator` — so the same claim is asked again at
		// every entry point that reaches the same rule, with the same corpus, and
		// with a declaration that must be refused BEFORE any artifact recursion
		// begins, so what is measured is the gate rather than a compiler's own
		// array work.
		const intrinsics: readonly TerminalIntrinsic[] = [
			...TERMINAL_CONSTRUCTORS,
			{ label: 'WeakSet.prototype.has', target: WeakSet.prototype, key: 'has', via: 'replacement' },
			{ label: 'WeakSet.prototype.add', target: WeakSet.prototype, key: 'add', via: 'replacement' },
			{
				label: 'WeakSet.prototype.delete',
				target: WeakSet.prototype,
				key: 'delete',
				via: 'replacement',
			},
			{ label: 'Array.prototype.push', target: Array.prototype, key: 'push', via: 'replacement' },
			{ label: 'Array.prototype.pop', target: Array.prototype, key: 'pop', via: 'replacement' },
			{ label: 'Object.hasOwn', target: Object, key: 'hasOwn', via: 'replacement' },
			{ label: 'Object.prototype.cause', target: Object.prototype, key: 'cause', via: 'pollution' },
			{
				label: 'Object.prototype.context',
				target: Object.prototype,
				key: 'context',
				via: 'pollution',
			},
			{ label: 'Object.prototype.path', target: Object.prototype, key: 'path', via: 'pollution' },
			// The symbol-keyed row the corpus could not previously express: a
			// protocol hook is a caller-writable member exactly as `Object.hasOwn`
			// is, and error recognition runs on every one of these doors.
			{
				label: 'ContractError[Symbol.hasInstance]',
				target: ContractError,
				key: Symbol.hasInstance,
				via: 'pollution',
			},
		]
		const malformed: ContractShape = { type: 'object', properties: {} }
		Reflect.set(malformed.type === 'object' ? malformed.properties : {}, 'name', null)
		const escaped: string[] = []

		for (const intrinsic of intrinsics) {
			const sentinel = Object.freeze({ stage: intrinsic.label })
			const outcomes = redirectIntrinsic(intrinsic, sentinel, (armed) => {
				if (!armed) return [{ name: 'armed', outcome: attempt(throwHostileAccess) }]
				return [
					{ name: 'cloneShape', outcome: attempt(() => cloneShape(malformed)) },
					{ name: 'ownShape', outcome: attempt(() => ownShape(malformed)) },
					{ name: 'validateShapeDepth', outcome: attempt(() => validateShapeDepth(malformed)) },
					{
						name: 'ShapeValidator',
						outcome: attempt(() => new ShapeValidator(malformed).validate()),
					},
					{ name: 'compileSchema', outcome: attempt(() => compileSchema(malformed)) },
					{ name: 'compileGuard', outcome: attempt(() => compileGuard(malformed)) },
					{ name: 'compileParser', outcome: attempt(() => compileParser(malformed)) },
					{
						name: 'compileGenerator',
						outcome: attempt(() => compileGenerator(malformed, () => 0)),
					},
					{ name: 'compileReporter', outcome: attempt(() => compileReporter(malformed, '')) },
					{ name: 'compileAuditor', outcome: attempt(() => compileAuditor(malformed, '')) },
					{ name: 'createContract', outcome: attempt(() => createContract(malformed)) },
				]
			})
			for (const door of outcomes) {
				if (door.outcome.success) escaped.push(`${intrinsic.label} accepted at ${door.name}`)
				else if (!isContractError(door.outcome.error)) {
					escaped.push(`${intrinsic.label} at ${door.name}`)
				}
			}
		}

		expect(escaped).toEqual([])
	})

	it('accepts a forged record brand at every named shape entry point while owning only plain data', () => {
		// The residual, on the record, at every door it reaches. The brand is a
		// STRUCTURAL rule, so a forged prototype satisfies it and every documented
		// refusal of a class instance is qualified rather than universal. What the
		// pass buys is acceptance and nothing else: the published snapshot is an
		// owned frozen plain record built from captured data, and no class
		// instance, class behavior, or forged prototype survives into it.
		const subjects: ReadonlyArray<{ readonly name: string; readonly value: ContractShape }> = [
			{ name: 'stamped prototype', value: new ForgedBrandDeclaration() },
			{ name: 'stripped prototype', value: new StrippedBrandDeclaration() },
			{ name: 'proxied prototype', value: createProxiedBrandDeclaration() },
		]
		const refused: string[] = []

		for (const subject of subjects) {
			const shape = subject.value
			const doors = [
				{
					name: 'cloneShape',
					outcome: attempt(() => Reflect.apply(cloneShape, undefined, [shape])),
				},
				{ name: 'ownShape', outcome: attempt(() => Reflect.apply(ownShape, undefined, [shape])) },
				{
					name: 'validateShapeDepth',
					outcome: attempt(() => Reflect.apply(validateShapeDepth, undefined, [shape])),
				},
				{
					name: 'compileSchema',
					outcome: attempt(() => Reflect.apply(compileSchema, undefined, [shape])),
				},
				{
					name: 'compileGuard',
					outcome: attempt(() => Reflect.apply(compileGuard, undefined, [shape])),
				},
				{
					name: 'compileParser',
					outcome: attempt(() => Reflect.apply(compileParser, undefined, [shape])),
				},
				{
					name: 'compileGenerator',
					outcome: attempt(() => Reflect.apply(compileGenerator, undefined, [shape, () => 0])),
				},
				{
					name: 'compileReporter',
					outcome: attempt(() => Reflect.apply(compileReporter, undefined, [shape, ''])),
				},
				{
					name: 'compileAuditor',
					outcome: attempt(() => Reflect.apply(compileAuditor, undefined, [shape, ''])),
				},
				{
					name: 'createContract',
					outcome: attempt(() => Reflect.apply(createContract, undefined, [shape])),
				},
				{ name: 'ShapeValidator', outcome: attempt(() => new ShapeValidator(shape).validate()) },
			]
			for (const door of doors) {
				if (!door.outcome.success) refused.push(`${subject.name} at ${door.name}`)
			}

			const owned = cloneShape(shape)
			if (Object.getPrototypeOf(owned) !== Object.prototype) {
				refused.push(`${subject.name} published a forged prototype`)
			}
			if (Object.hasOwn(owned, 'escape')) refused.push(`${subject.name} published class behavior`)
			if (!Object.isFrozen(owned)) refused.push(`${subject.name} published an unfrozen root`)
			expect(owned).toEqual({ type: 'string', min: 1 })
		}

		expect(refused).toEqual([])
	})

	it('carries a genuine foreign pattern through validation, all six compilers, and contract ownership', () => {
		const pattern = createForeignRegExp('^a+$')
		if (!isRegExp(pattern)) throw new Error('expected a genuine foreign RegExp')
		const shape: ContractShape = { type: 'string', pattern }

		expect(() => validateShapeDepth(shape)).not.toThrow()
		const schema = compileSchema(shape)
		const guard = compileGuard(shape)
		const parser = compileParser(shape)
		const generated = compileGenerator(shape, () => 0)
		const report = compileReporter(shape, 'aaa')
		const audit = compileAuditor(shape, 'aaa')
		const contract = createContract(shape)

		Reflect.apply(RegExp.prototype.compile, pattern, ['^b+$'])

		expect(schema.pattern).toBe('^a+$')
		expect(guard('aaa')).toBe(true)
		expect(guard('bbb')).toBe(false)
		expect(parser('aaa')).toBe('aaa')
		expect(parser('bbb')).toBeUndefined()
		expect(generated).toMatch(/^a+$/)
		expect(report).toEqual([])
		expect(audit).toEqual([])
		expect(contract.schema.pattern).toBe('^a+$')
		expect(contract.is('aaa')).toBe(true)
		expect(contract.is('bbb')).toBe(false)
		expect(contract.parse('aaa')).toBe('aaa')
		expect(contract.generate(() => 0)).toMatch(/^a+$/)
	})

	it('rejects forged and proxied patterns at validator, cloner, compiler, and contract doors', () => {
		let reads = 0
		const accessor = {}
		for (const field of ['source', 'flags']) {
			Object.defineProperty(accessor, field, {
				get() {
					reads += 1
					throw new Error('advertised pattern field')
				},
			})
		}
		const forged = { source: '^a+$', flags: '' }
		Object.defineProperty(forged, Symbol.toStringTag, { value: 'RegExp' })
		const revoked = Proxy.revocable(/revoked/, {})
		revoked.revoke()

		for (const pattern of [
			{ source: '^a+$', flags: '', test() {} },
			forged,
			accessor,
			new Proxy(/proxied/, {}),
			revoked.proxy,
		]) {
			const shape: ContractShape = JSON.parse('{"type":"string"}')
			Object.defineProperty(shape, 'pattern', { value: pattern, enumerable: true })
			const validation = captureContractError(() => validateShapeDepth(shape))
			const clone = captureContractError(() => cloneShape(shape))
			const compiler = captureContractError(() => compileSchema(shape))
			const contract = captureContractError(() => createContract(shape))

			expect(validation.code).toBe('structure')
			expect(validation.message).toBe('validateShapeDepth: string pattern must be a RegExp')
			expect(clone.code).toBe('structure')
			expect(clone.message).toBe('validateShapeDepth: string pattern must be a RegExp')
			expect(compiler.code).toBe('structure')
			expect(compiler.message).toBe('validateShapeDepth: string pattern must be a RegExp')
			expect(contract.code).toBe('structure')
			expect(contract.message).toBe('validateShapeDepth: string pattern must be a RegExp')
		}
		expect(reads).toBe(0)
	})

	it('refuses only an unfrozen accessor result among valid pattern declaration forms', () => {
		const data: ContractShape = { type: 'string', pattern: /^[a-z0-9]*$/ }
		const ownedAccessor: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(ownedAccessor, 'pattern', {
			enumerable: true,
			get() {
				return Object.freeze(/^[a-z0-9]*$/)
			},
		})
		const unownedAccessor: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(unownedAccessor, 'pattern', {
			enumerable: true,
			get() {
				return /^unowned$/
			},
		})

		for (const shape of [data, ownedAccessor]) {
			const outcomes = [
				attempt(() => cloneShape(shape)),
				attempt(() => ownShape(shape)),
				attempt(() => validateShapeDepth(shape)),
				attempt(() => compileSchema(shape)),
				attempt(() => compileGuard(shape)),
				attempt(() => compileParser(shape)),
				attempt(() => compileGenerator(shape, () => 0)),
				attempt(() => compileReporter(shape, 'owned')),
				attempt(() => compileAuditor(shape, 'owned')),
				attempt(() => createContract(shape)),
			]
			expect(outcomes.every((outcome) => outcome.success)).toBe(true)
		}

		const errors = [
			captureContractError(() => cloneShape(unownedAccessor)),
			captureContractError(() => ownShape(unownedAccessor)),
			captureContractError(() => validateShapeDepth(unownedAccessor)),
			captureContractError(() => compileSchema(unownedAccessor)),
			captureContractError(() => compileGuard(unownedAccessor)),
			captureContractError(() => compileParser(unownedAccessor)),
			captureContractError(() => compileGenerator(unownedAccessor, () => 0)),
			captureContractError(() => compileReporter(unownedAccessor, 'unowned')),
			captureContractError(() => compileAuditor(unownedAccessor, 'unowned')),
			captureContractError(() => createContract(unownedAccessor)),
		]
		for (const error of errors) {
			expect(error.code).toBe('structure')
			expect(error.context?.path).toEqual(['pattern'])
		}
	})

	it('rejects malformed children nested under legal parents and additional properties', () => {
		const source: { readonly child: ContractShape } = JSON.parse('{}')
		const missing = source.child
		const malformed: ContractShape = JSON.parse('{}')
		const malformedObject: ContractShape = JSON.parse('{"type":"object"}')
		const malformedUnion: ContractShape = JSON.parse('{"type":"union"}')
		let deep: ContractShape = { type: 'nullable', inner: missing }
		for (let level = 0; level < 64; level += 1) deep = { type: 'array', items: deep }

		const nested = captureContractError(() =>
			compileGuard({
				type: 'object',
				properties: { values: { type: 'array', items: missing } },
			}),
		)
		const additional = captureContractError(() =>
			compileAuditor({ type: 'object', properties: {}, additionalProperties: malformed }, {}),
		)
		const discriminant = captureContractError(() =>
			compileParser({ type: 'object', properties: { value: malformed } }),
		)
		const properties = captureContractError(() =>
			compileSchema({ type: 'object', properties: { value: malformedObject } }),
		)
		const variants = captureContractError(() =>
			compileGenerator({ type: 'object', properties: { value: malformedUnion } }, () => 0),
		)
		const depth = captureContractError(() => compileReporter(deep, undefined))

		expect(nested.code).toBe('structure')
		expect(nested.context?.path).toEqual(['properties', 'values', 'items'])
		expect(additional.code).toBe('structure')
		expect(additional.context?.path).toEqual(['additionalProperties'])
		expect(discriminant.code).toBe('structure')
		expect(discriminant.context?.path).toEqual(['properties', 'value'])
		expect(properties.code).toBe('structure')
		expect(properties.context?.path).toEqual(['properties', 'value', 'properties'])
		expect(variants.code).toBe('structure')
		expect(variants.context?.path).toEqual(['properties', 'value', 'variants'])
		expect(depth.code).toBe('structure')
		expect(depth.context?.path).toEqual([...Array.from({ length: 64 }, () => 'items'), 'inner'])
		const undefinedAdditional = captureContractError(() => recordShape(missing))
		expect(undefinedAdditional.code).toBe('structure')
		expect(undefinedAdditional.context?.path).toEqual(['additionalProperties'])
		expect(() => validateShapeDepth(objectShape({}))).not.toThrow()
	})
})

describe('JSON Schema vocabulary safety', () => {
	it('refuses empty applicator vocabularies and non-finite literal members at the shared gate', () => {
		const cases: ReadonlyArray<{
			readonly shape: ContractShape
			readonly code: 'empty' | 'literal'
		}> = [
			{ shape: JSON.parse('{"type":"union","variants":[]}'), code: 'empty' },
			{ shape: JSON.parse('{"type":"union","variants":[],"mode":"oneOf"}'), code: 'empty' },
			{ shape: JSON.parse('{"type":"literal","values":[]}'), code: 'empty' },
			{ shape: { type: 'literal', values: [Number.NaN] }, code: 'literal' },
			{ shape: { type: 'literal', values: [Number.POSITIVE_INFINITY] }, code: 'literal' },
			{ shape: { type: 'literal', values: [Number.NEGATIVE_INFINITY] }, code: 'literal' },
		]

		for (const entry of cases) {
			const errors = [
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, undefined)),
				captureContractError(() => compileAuditor(entry.shape, undefined)),
				captureContractError(() => createContract(entry.shape)),
			]
			for (const error of errors) expect(error.code).toBe(entry.code)
		}
	})

	it('emits applicator, enum, and numeric keywords inside their vocabulary domains', () => {
		const anyOf = compileSchema(unionShape(stringShape()))
		const oneOf = compileSchema(oneOfShape(booleanShape()))
		const enumeration = compileSchema(literalShape(['ready', 1, true]))
		const bounded = compileSchema(numberShape({ min: 0, max: 1 }))

		expect(Array.isArray(anyOf.anyOf) && anyOf.anyOf.length >= 1).toBe(true)
		expect(Array.isArray(oneOf.oneOf) && oneOf.oneOf.length >= 1).toBe(true)
		expect(
			enumeration.enum?.every((value) => typeof value !== 'number' || Number.isFinite(value)),
		).toBe(true)
		expect(bounded.minimum).toBe(0)
		expect(bounded.maximum).toBe(1)
		expect(JSON.stringify(bounded)).not.toContain('null')
	})
})

describe('null / json compileSchema', () => {
	it('emits { type: "null" } with optional description', () => {
		expect(compileSchema(nullShape())).toEqual({ type: 'null' })
		expect(compileSchema(nullShape({ description: 'nothing' }))).toEqual({
			type: 'null',
			description: 'nothing',
		})
	})

	it('emits the empty schema for json, with optional description', () => {
		expect(compileSchema(jsonShape())).toEqual({})
		expect(compileSchema(jsonShape({ description: 'any JSON value' }))).toEqual({
			description: 'any JSON value',
		})
	})
})

describe('compileSchema', () => {
	it('emits string / number constraints', () => {
		expect(
			compileSchema(
				stringShape({
					min: 1,
					max: 8,
					pattern: /^a+$/,
					description: 'd',
				}),
			),
		).toEqual({
			type: 'string',
			minLength: 1,
			maxLength: 8,
			pattern: '^a+$',
			description: 'd',
		})
		expect(compileSchema(integerShape({ min: 0 }))).toEqual({
			type: 'integer',
			minimum: 0,
		})
		expect(compileSchema(numberShape({ max: 9 }))).toEqual({
			type: 'number',
			maximum: 9,
		})
	})

	it('emits literals as enum and arrays with items + bounds', () => {
		expect(compileSchema(literalShape(['a', 'b']))).toEqual({
			enum: ['a', 'b'],
		})
		expect(compileSchema(arrayShape(stringShape(), { max: 2 }))).toEqual({
			type: 'array',
			items: { type: 'string' },
			maxItems: 2,
		})
	})

	it('emits objects with required (optional excluded) + additionalProperties:false', () => {
		expect(
			compileSchema(
				objectShape({
					name: stringShape(),
					bio: optionalShape(stringShape()),
				}),
			),
		).toEqual({
			type: 'object',
			properties: { name: { type: 'string' }, bio: { type: 'string' } },
			required: ['name'],
			additionalProperties: false,
		})
		expect(compileSchema(recordShape(numberShape()))).toEqual({
			type: 'object',
			additionalProperties: { type: 'number' },
		})
	})

	it('emits union anyOf / oneOf, nullable anyOf+null, and raw passthrough', () => {
		expect(compileSchema(unionShape(stringShape(), integerShape()))).toEqual({
			anyOf: [{ type: 'string' }, { type: 'integer' }],
		})
		expect(compileSchema(oneOfShape(stringShape(), booleanShape()))).toEqual({
			oneOf: [{ type: 'string' }, { type: 'boolean' }],
		})
		expect(compileSchema(nullableShape(stringShape()))).toEqual({
			anyOf: [{ type: 'string' }, { type: 'null' }],
		})
		expect(compileSchema(rawShape({ type: 'string', description: 'x' }))).toEqual({
			type: 'string',
			description: 'x',
		})
	})

	it('emits a __proto__ property as schema data', () => {
		const properties: Record<string, ContractShape> = Object.create(null)
		properties['__proto__'] = integerShape()
		const schema = compileSchema(objectShape(properties))

		expect(schema.properties).toBeDefined()
		expect(Object.hasOwn(schema.properties ?? {}, '__proto__')).toBe(true)
		expect(schema.properties?.['__proto__']).toEqual({ type: 'integer' })
		expect(schema.required).toEqual(['__proto__'])
	})

	it('owns and deeply freezes a raw schema even when the root shape is caller-frozen', () => {
		const child: JSONSchema = { type: 'string' }
		const schema: JSONSchema = {
			type: 'object',
			properties: { value: child },
		}
		const shape: RawShape = Object.freeze({ type: 'raw', schema })
		const compiled = compileSchema(shape)

		Reflect.set(schema, 'type', 'number')
		Reflect.set(child, 'type', 'integer')
		expect(compiled).not.toBe(schema)
		expect(compiled).toEqual({
			type: 'object',
			properties: { value: { type: 'string' } },
		})
		expect(Object.isFrozen(compiled)).toBe(true)
		expect(Object.isFrozen(compiled.properties)).toBe(true)
		expect(Object.isFrozen(compiled.properties?.value)).toBe(true)
	})
})

describe('null / json compileGuard', () => {
	it('null guard accepts only null', () => {
		const guard = compileGuard(nullShape())
		expect(guard(null)).toBe(true)
		expect(guard(undefined)).toBe(false)
		expect(guard(0)).toBe(false)
		expect(guard('null')).toBe(false)
	})

	it('json guard accepts nested JSON trees and rejects functions, NaN, Infinity, cycles, Date', () => {
		const guard = compileGuard(jsonShape())
		expect(guard(null)).toBe(true)
		expect(guard(42)).toBe(true)
		expect(guard('hello')).toBe(true)
		expect(guard(true)).toBe(true)
		expect(guard({ a: [1, 'x', { b: null }] })).toBe(true)
		expect(guard(() => 1)).toBe(false)
		expect(guard(Number.NaN)).toBe(false)
		expect(guard(Number.POSITIVE_INFINITY)).toBe(false)
		expect(guard(new Date())).toBe(false)
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(guard(cyclic)).toBe(false)
	})
})

describe('compileGuard', () => {
	it('enforces string and number constraints', () => {
		const name = compileGuard(stringShape({ min: 2, max: 4 }))
		expect(name('abc')).toBe(true)
		expect(name('a')).toBe(false)
		expect(name('abcde')).toBe(false)
		expect(name(5)).toBe(false)
		const age = compileGuard(integerShape({ min: 0 }))
		expect(age(3)).toBe(true)
		expect(age(-1)).toBe(false)
		expect(age(3.5)).toBe(false)
	})

	it('validates a closed object with an optional field', () => {
		const guard = compileGuard(
			objectShape({
				name: stringShape(),
				bio: optionalShape(stringShape()),
			}),
		)
		expect(guard({ name: 'Ada' })).toBe(true)
		expect(guard({ name: 'Ada', bio: 'hi' })).toBe(true)
		expect(guard({ name: 'Ada', extra: 1 })).toBe(false)
		expect(guard({ bio: 'hi' })).toBe(false)
	})

	it('validates an open object (recordShape)', () => {
		const guard = compileGuard(recordShape(numberShape()))
		expect(guard({ a: 1, b: 2 })).toBe(true)
		expect(guard({ a: 1, b: 'x' })).toBe(false)
		expect(guard({})).toBe(true)
	})

	it('handles union / nullable / literal / array', () => {
		const id = compileGuard(unionShape(stringShape(), integerShape()))
		expect(id('x')).toBe(true)
		expect(id(3)).toBe(true)
		expect(id(true)).toBe(false)
		expect(compileGuard(nullableShape(stringShape()))(null)).toBe(true)
		expect(compileGuard(literalShape(['a', 'b']))('a')).toBe(true)
		expect(compileGuard(literalShape(['a', 'b']))('c')).toBe(false)
		const arr = compileGuard(arrayShape(integerShape(), { min: 1 }))
		expect(arr([1, 2])).toBe(true)
		expect(arr([])).toBe(false)
		expect(arr([1, 'x'])).toBe(false)
	})

	it('uses SameValueZero for a compiled signed-zero literal round trip', () => {
		const shape = literalShape([-0])
		const guard = compileGuard(shape)
		const parse = compileParser(shape)
		const parsed = parse(+0)

		expect(guard(+0)).toBe(true)
		expect(parsed).toBe(0)
		expect(parsed !== undefined && guard(parsed)).toBe(true)
	})

	it('compiles a machine-scale literal vocabulary that no spread could carry', () => {
		// An untrusted schema's `enum` converts to a literalShape of whatever size
		// it declares, so every compiled literal artifact must match membership
		// without spreading the vocabulary into arguments.
		const vocabulary = buildWideVocabulary()
		const shape = literalShape(vocabulary)
		const contract = createContract(shape)

		expect(contract.is('value0')).toBe(true)
		expect(contract.is('absent')).toBe(false)
		expect(contract.parse(' value1 ')).toBe('value1')
		expect(contract.explain('absent')).toHaveLength(1)
		expect(contract.schema.enum).toHaveLength(vocabulary.length)
	})

	it('rejects top-level undefined for a raw shape in guard/parser agreement', () => {
		const shape = rawShape({})
		const guard = compileGuard(shape)
		const parse = compileParser(shape)

		expect(guard(undefined)).toBe(false)
		expect(parse(undefined)).toBeUndefined()
	})

	it('oneOfShape rejects a value matching more than one variant (exactly-one semantics)', () => {
		const guard = compileGuard(oneOfShape(numberShape(), integerShape()))
		// 3 is guard-valid against BOTH numberShape and integerShape — the emitted
		// JSON Schema `oneOf` requires EXACTLY one match, so the compiled guard
		// must reject it even though unionShape's anyOf semantics would accept it.
		expect(guard(3)).toBe(false)
		expect(guard(3.5)).toBe(true) // matches numberShape only
		expect(guard('x')).toBe(false) // matches neither
	})

	it('raw accepts defined values and the guard stays total on adversarial input', () => {
		expect(compileGuard(rawShape({}))(Symbol('x'))).toBe(true)
		const guard = compileGuard(objectShape({ name: stringShape() }))
		expect(() => guard(null)).not.toThrow()
		expect(guard(null)).toBe(false)
	})

	it('an open object guard is total on hostile keys (__proto__, constructor) — no pollution', () => {
		const guard = compileGuard(recordShape(integerShape()))
		const parse = compileParser(recordShape(integerShape()))
		const fromJSON: unknown = JSON.parse('{"__proto__":1}')
		// The '__proto__' key is validated like any other own key (value 1 passes
		// integerShape) — no throw, and guard/parse agree.
		expect(() => guard(fromJSON)).not.toThrow()
		expect(guard(fromJSON)).toBe(true)
		expect(parse(fromJSON)).not.toBeUndefined()
		// Object.prototype itself must be untouched by the walk.
		expect(Object.getPrototypeOf({})).toBe(Object.prototype)

		// 'constructor' is likewise just another own key — its value ('x') fails
		// integerShape, so the object is rejected, not treated specially.
		expect(guard({ constructor: 'x' })).toBe(false)
		expect(parse({ constructor: 'x' })).toBeUndefined()

		// A throwing getter remains false for the total guard, while the parser
		// distinguishes unreadability from an honest invalid result.
		const hostile: Record<string, unknown> = {}
		Object.defineProperty(hostile, 'bad', {
			enumerable: true,
			get() {
				throw new Error('hostile getter')
			},
		})
		expect(() => guard(hostile)).not.toThrow()
		expect(guard(hostile)).toBe(false)
		const error = captureContractError(() => parse(hostile))
		expect(error.code).toBe('structure')
		// The compiled object parser owns this refusal: it no longer routes through
		// `parseRecord`, whose eager whole-record probe read keys the shape drops.
		expect(error.message).toBe('compileParser: object could not be read')
	})

	it('an open object guard/parse agree that a __proto__ own key round-trips faithfully', () => {
		const parse = compileParser(recordShape(integerShape()))
		const fromJSON: unknown = JSON.parse('{"__proto__":5}')
		const parsed = parse(fromJSON)
		expect(isRecord(parsed)).toBe(true)
		const record = isRecord(parsed) ? parsed : {}
		expect(Object.hasOwn(record, '__proto__')).toBe(true)
		expect(record['__proto__']).toBe(5)
		expect(JSON.stringify(record)).toBe('{"__proto__":5}')
	})

	it('compiled object artifacts share the own-enumerable-string property view', () => {
		const shape = objectShape({ x: booleanShape() }, { additionalProperties: true })
		const value = createNonEnumerableRecord('x', 'bad')
		const guard = compileGuard(shape)
		const parse = compileParser(shape)

		expect(guard(value)).toBe(false)
		expect(parse(value)).toBeUndefined()
		expect(compileReporter(shape, value)).toEqual([
			{ reason: 'missing', path: ['x'], expected: 'boolean' },
		])
	})

	it('round-trips a __proto__-keyed object through schema, guard, parser, and generator', () => {
		const properties: Record<string, ContractShape> = Object.create(null)
		properties['__proto__'] = literalShape(['safe'])
		const shape = objectShape(properties)
		const schema = compileSchema(shape)
		const guard = compileGuard(shape)
		const parse = compileParser(shape)
		const generated = compileGenerator(shape, seededRandom(1))
		const input: unknown = JSON.parse('{"__proto__":"safe"}')

		expect(Object.hasOwn(schema.properties ?? {}, '__proto__')).toBe(true)
		expect(guard(input)).toBe(true)
		expect(parse(input)).toEqual(input)
		expect(Object.hasOwn(generated, '__proto__')).toBe(true)
		expect(guard(generated)).toBe(true)
	})
})

describe('compileAuditor — strict soundness matrix', () => {
	const shapes: ReadonlyArray<readonly [string, ContractShape]> = [
		...leafShapeVariations(),
		['composite', compositeShape(2)],
	]

	it('audit(v).length === 0 iff guard(v), across every leaf/composite shape and sample', () => {
		const violations: string[] = []
		let comparisons = 0
		let refusals = 0
		let uncoded = 0
		for (const [label, shape] of shapes) {
			const guard = compileGuard(shape)
			for (let index = 0; index < SOUNDNESS_SAMPLE.length; index += 1) {
				const value = SOUNDNESS_SAMPLE[index]
				const audited = attempt(() => compileAuditor(shape, value))
				if (!audited.success) {
					if (!isContractError(audited.error)) uncoded += 1
					refusals += 1
					continue
				}
				const empty = audited.value.length === 0
				if (empty !== guard(value)) violations.push(`${label}@${String(index)}`)
				comparisons += 1
			}
		}
		expect(violations).toEqual([])
		expect(uncoded).toBe(0)
		expect(refusals).toBeGreaterThan(0)
		expect(comparisons + refusals).toBe(shapes.length * SOUNDNESS_SAMPLE.length)
	})
})

describe('compileAuditor — object exactness', () => {
	it('reports nested closed-object extras at the offending key without reading the value', () => {
		const shape = objectShape({ nested: objectShape({ id: stringShape() }) })
		const nested: Record<string, unknown> = { id: 'a' }
		Object.defineProperty(nested, 'extra', {
			get() {
				throw new Error('must not read an extra value')
			},
			enumerable: true,
		})

		expect(compileAuditor(shape, { nested })).toEqual([
			{ reason: 'extra', path: ['nested', 'extra'] },
		])
	})

	it('accepts a readable unconstrained extra and adds no fault for it', () => {
		const shape = objectShape({ id: stringShape() }, { additionalProperties: true })
		expect(compileAuditor(shape, { id: 'a', extra: { anything: [1, 2] } })).toEqual([])
		expect(compileGuard(shape)({ id: 'a', extra: { anything: [1, 2] } })).toBe(true)
	})

	it('reads an open object unconstrained extra, because the parser copies it', () => {
		// The carrier of the H9 tier-1 soundness defect, re-pinned. `is`, `audit`
		// and `explain` all certified this value clean while `parse` threw, because
		// only the parser read the extra it copies. `additionalProperties: true`
		// declares an undeclared key unconstrained, not unobserved.
		const shape = objectShape({ id: stringShape() }, { additionalProperties: true })
		const value: Record<string, unknown> = { id: 'a' }
		Object.defineProperty(value, 'extra', {
			get() {
				throw new Error('unreadable unconstrained extra')
			},
			enumerable: true,
		})

		expect(compileGuard(shape)(value)).toBe(false)
		expect(captureContractError(() => compileAuditor(shape, value)).code).toBe('structure')
		expect(compileReporter(shape, value)).not.toEqual([])
		expect(captureContractError(() => compileParser(shape)(value)).code).toBe('structure')
	})

	it('recurses through a shape-valued tail and record shapes', () => {
		const tailed = objectShape(
			{ id: stringShape() },
			{ additionalProperties: integerShape({ min: 0 }) },
		)
		expect(compileAuditor(tailed, { id: 'a', count: 1 })).toEqual([])
		expect(compileAuditor(tailed, { id: 'a', count: -1 })).toEqual([
			{
				reason: 'constraint',
				path: ['count'],
				expected: 'integer',
				constraint: 'min',
				limit: 0,
				received: '-1',
			},
		])

		const record = recordShape(integerShape())
		expect(compileAuditor(record, { first: 1, second: 2 })).toEqual([])
		expect(compileAuditor(record, { first: 1, second: '2' })).toEqual([
			{ reason: 'type', path: ['second'], expected: 'integer', received: '"2"' },
		])
	})
})

describe('compileAuditor — strict coercion delta', () => {
	it('faults every coercive leaf while explain stays clean and parse succeeds', () => {
		const cases: ReadonlyArray<readonly [string, ContractShape, unknown]> = [
			['string-number', stringShape(), 42],
			['number-string', numberShape(), '42'],
			['boolean-word', booleanShape(), 'true'],
			['boolean-digit', booleanShape(), '0'],
			['literal-trim', literalShape(['ready']), ' ready '],
			['array-element', arrayShape(numberShape()), ['1']],
			[
				'nested-field',
				objectShape({ nested: objectShape({ count: numberShape() }) }),
				{
					nested: { count: '1' },
				},
			],
			['optional-inner', objectShape({ count: optionalShape(numberShape()) }), { count: '1' }],
			['nullable-inner', nullableShape(numberShape()), '1'],
		]

		for (const [label, shape, value] of cases) {
			const contract = compileWidenedContract(shape)
			expect([
				label,
				contract.is(value),
				contract.audit(value).length > 0,
				contract.explain(value).length,
				contract.parse(value) !== undefined,
			]).toEqual([label, false, true, 0, true])
		}
	})
})

describe('compileAuditor — strict unions', () => {
	it('anyOf is empty when one strict variant accepts the value', () => {
		const shape = unionShape(
			objectShape({ name: stringShape() }),
			objectShape({ name: stringShape(), count: integerShape() }),
		)
		const value = { name: 'a', count: 1 }

		expect(compileAuditor(shape, value)).toEqual([])
		expect(compileGuard(shape)(value)).toBe(true)
	})

	it('oneOf is empty only for exactly one strict match', () => {
		const exclusive = oneOfShape(stringShape(), booleanShape())
		expect(compileAuditor(exclusive, 'a')).toEqual([])
		expect(compileAuditor(exclusive, 1).length).toBeGreaterThan(0)

		const overlapping = oneOfShape(stringShape(), stringShape({ min: 0 }))
		expect(compileAuditor(overlapping, 'a')).toEqual([{ reason: 'oneOf', path: [], matched: 2 }])
	})
})

describe('compileAuditor — totality and cap', () => {
	it('refuses hostile reads with their container context', () => {
		const shape = objectShape({ value: stringShape() })
		for (const value of [createThrowingGetter(), createHostileKeys(), createRevokedProxy()]) {
			const error = captureContractError(() => compileAuditor(shape, value))
			expect(error.code).toBe('structure')
			expect(error.context).toEqual({ path: [], shape: 'object' })
		}

		const arrayError = captureContractError(() =>
			compileAuditor(arrayShape(stringShape()), createRevokedArrayProxy()),
		)
		expect(arrayError.code).toBe('structure')
		expect(arrayError.context).toEqual({ path: [], shape: 'array' })
	})

	it('bounds native-maximum owned holes without reading source indices', () => {
		const fixture = createNativeMaximumSparseArray<unknown>()
		const faults = compileAuditor(arrayShape(stringShape()), fixture.value)

		expect(faults).toHaveLength(FAULT_LIMIT)
		expect(faults[0]).toEqual({
			reason: 'type',
			path: ['0'],
			expected: 'string',
			received: 'undefined',
		})
		expect(fixture.probes).toEqual([])
	})

	it('reports an honest array as an array when an object shape rejects it', () => {
		expect(compileAuditor(objectShape({}), [])).toEqual([
			{ reason: 'type', path: [], expected: 'object', received: 'array' },
		])
	})

	it('caps non-empty faults at every nesting level without truncating to empty', () => {
		const properties = Object.fromEntries(
			Array.from({ length: FAULT_LIMIT * 2 }, (_, index) => [
				`field${String(index)}`,
				stringShape(),
			]),
		)
		const object = objectShape(properties)
		const array = arrayShape(object)
		const nested = arrayShape(array)

		for (const [shape, value] of [
			[object, {}],
			[array, [{}]],
			[nested, [[{}]]],
		] satisfies ReadonlyArray<readonly [ContractShape, unknown]>) {
			const faults = compileAuditor(shape, value)
			expect(faults.length).toBe(FAULT_LIMIT)
			expect(faults.length).toBeGreaterThan(0)
		}

		const extras = Object.fromEntries(
			Array.from({ length: FAULT_LIMIT * 2 }, (_, index) => [`extra${String(index)}`, index]),
		)
		expect(compileAuditor(objectShape({}), extras).length).toBe(FAULT_LIMIT)
		expect(compileAuditor(arrayShape(stringShape()), ['valid'])).toEqual([])
	})
})

describe('createContract — audit wiring', () => {
	it('delegates audit to the strict auditor independently of explain', () => {
		const shape = objectShape({ count: integerShape() })
		const contract = compileWidenedContract(shape)
		const coercive = { count: '1' }
		const extra = { count: 1, extra: true }

		expect(contract.audit(coercive)).toEqual(compileAuditor(shape, coercive))
		expect(contract.audit(coercive).length).toBeGreaterThan(0)
		expect(contract.explain(coercive)).toEqual([])
		expect(contract.audit(extra)).toEqual([{ reason: 'extra', path: ['extra'] }])
		expect(contract.explain(extra)).toEqual([])
	})
})

describe('null / json compileParser', () => {
	it('null parser is an identity on null, undefined otherwise', () => {
		const parse = compileParser(nullShape())
		expect(parse(null)).toBeNull()
		expect(parse('null')).toBeUndefined()
		expect(parse(undefined)).toBeUndefined()
	})

	it('json parser is an identity for valid JSON, undefined for invalid', () => {
		const parse = compileParser(jsonShape())
		expect(parse({ a: 1 })).toEqual({ a: 1 })
		expect(parse(42)).toBe(42)
		expect(parse(() => 1)).toBeUndefined()
		expect(parse(Number.NaN)).toBeUndefined()
		expect(parse(undefined)).toBeUndefined()
	})
})

describe('compileParser', () => {
	it('refuses failed dense-index reads at the root and through object parsing', () => {
		const hostile = new Proxy([1, 2], {
			get(target, key, receiver) {
				if (key === '1') throw new Error('hostile index')
				return Reflect.get(target, key, receiver)
			},
		})
		const direct = createContract(arrayShape(numberShape()))
		const nested = createContract(objectShape({ values: arrayShape(numberShape()) }))

		for (const callback of [() => direct.parse(hostile), () => nested.parse({ values: hostile })]) {
			const error = captureContractError(callback)
			expect(error.code).toBe('structure')
			expect(error.message).toBe('compileParser: array could not be read')
			expect(error.context).toEqual({ shape: 'array' })
		}
	})

	it('parses array indices consistently with is, audit, and explain', () => {
		const iteratorThrow = [1, 2]
		Object.defineProperty(iteratorThrow, Symbol.iterator, {
			value() {
				throw new Error('iterator must not run')
			},
		})
		const divergent = [1, 2, 3]
		Object.defineProperty(divergent, Symbol.iterator, {
			value: () => ['x', 'y', 'z'][Symbol.iterator](),
		})
		const contract = createContract(arrayShape(numberShape()))

		expect(contract.is(iteratorThrow)).toBe(true)
		expect(contract.parse(iteratorThrow)).toEqual([1, 2])
		expect(contract.audit(iteratorThrow)).toEqual([])
		expect(contract.explain(iteratorThrow)).toEqual([])
		expect(contract.parse(divergent)).toEqual([1, 2, 3])
		expect(contract.explain(divergent)).toEqual([])
	})

	it('refuses a malformed array length instead of accepting an empty view', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, key, receiver) {
				return key === 'length' ? -1 : Reflect.get(target, key, receiver)
			},
		})
		const contract = createContract(arrayShape(numberShape()))

		expect(contract.is(hostile)).toBe(false)
		expect(captureContractError(() => contract.parse(hostile)).code).toBe('structure')
		expect(captureContractError(() => contract.audit(hostile)).code).toBe('structure')
	})

	it('refuses an unreadable json leaf instead of returning honest invalidity', () => {
		const hostile = new Proxy(
			{ value: 1 },
			{
				getOwnPropertyDescriptor() {
					throw new Error('hostile descriptor')
				},
			},
		)
		const error = captureContractError(() => createContract(jsonShape()).parse(hostile))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('parseJSONValue: value could not be read')
		expect(error.context).toEqual({ shape: 'json' })
	})

	it('coerces whole objects and fails on a missing required field', () => {
		const parse = compileParser(objectShape({ name: stringShape(), age: integerShape() }))
		expect(parse({ name: 'Ada', age: '36' })).toEqual({
			name: 'Ada',
			age: 36,
		})
		expect(parse({ name: 'Ada' })).toBeUndefined()
	})

	it('skips absent optional fields and coerces nullable', () => {
		const parse = compileParser(
			objectShape({
				name: stringShape(),
				bio: optionalShape(stringShape()),
			}),
		)
		expect(parse({ name: 'Ada' })).toEqual({ name: 'Ada' })
		expect(compileParser(nullableShape(integerShape()))(null)).toBeNull()
		expect(compileParser(nullableShape(integerShape()))('7')).toBe(7)
	})

	it('union returns the first variant that both parses and guards', () => {
		const parse = compileParser(unionShape(integerShape(), stringShape()))
		// '36' is already guard-valid as a string (clause A), so it is returned
		// unchanged rather than coerced by the integer variant.
		expect(parse('36')).toBe('36')
		expect(parse('hello')).toBe('hello')
	})

	it('union returns a guard-valid value unchanged rather than coerced by an earlier variant', () => {
		const parse = compileParser(unionShape(stringShape(), integerShape()))
		expect(parse(37)).toBe(37) // guard-valid via integer variant — not coerced to '37'
		expect(parse('37')).toBe('37') // already guard-valid via string variant — unchanged
		expect(parse(true)).toBeUndefined() // guard-invalid against every variant
	})

	it('oneOfShape parse rejects an input matching more than one variant', () => {
		const parse = compileParser(oneOfShape(numberShape(), integerShape()))
		expect(parse(3)).toBeUndefined() // matches both variants — ambiguous, rejected
		expect(parse(3.5)).toBe(3.5) // matches numberShape only
		expect(parse('x')).toBeUndefined() // matches neither
	})

	it('union returns a guard-valid object by reference through the identity pass', () => {
		const parse = compileParser(
			unionShape(
				objectShape({ name: stringShape() }),
				objectShape({ name: stringShape(), age: integerShape() }),
			),
		)
		const input = { name: 'Ada', age: 36 }
		expect(parse(input)).toBe(input)
	})

	it('enforces string length + pattern refinements (rejects out-of-bounds)', () => {
		const parse = compileParser(stringShape({ min: 1, max: 3, pattern: /^a+$/ }))
		expect(parse('aa')).toBe('aa') // in-bounds
		expect(parse('')).toBeUndefined() // empty under min:1
		expect(parse('aaaa')).toBeUndefined() // over max:3
		expect(parse('xy')).toBeUndefined() // pattern miss
	})

	it('enforces number bounds, even on a coerced numeric string', () => {
		const parse = compileParser(integerShape({ min: 1, max: 5 }))
		expect(parse(3)).toBe(3) // in-bounds
		expect(parse('4')).toBe(4) // coerced and in-bounds
		expect(parse(0)).toBeUndefined() // under min:1
		expect(parse(6)).toBeUndefined() // over max:5
		expect(parse('0')).toBeUndefined() // coerces, then fails min:1
	})

	it('enforces array length bounds after coercing elements', () => {
		const parse = compileParser(arrayShape(integerShape(), { min: 1, max: 2 }))
		expect(parse(['1', '2'])).toEqual([1, 2]) // coerces + in-bounds
		expect(parse([])).toBeUndefined() // under min:1
		expect(parse([1, 2, 3])).toBeUndefined() // over max:2
	})

	it('enforces a refinement on a leaf nested inside an object', () => {
		const parse = compileParser(
			objectShape({
				name: stringShape({ min: 1 }),
				age: integerShape({ min: 0 }),
			}),
		)
		expect(parse({ name: 'Ada', age: '36' })).toEqual({
			name: 'Ada',
			age: 36,
		})
		expect(parse({ name: '', age: 36 })).toBeUndefined() // name under min:1
		expect(parse({ name: 'Ada', age: -1 })).toBeUndefined() // age under min:0
	})

	// AGENTS §14 parse↔guard soundness for REFINED leaves: the compiled guard and
	// parser are derived from one combinator source (`stringOf` / `boundsOf`), so every non-`undefined` parse
	// must satisfy the guard — refinements included. (Clause B of soundness; the
	// compiler intentionally rebuilds containers to coerce contents, so the leaf
	// parsers' by-identity clause A does not apply to compiled array/object parsers —
	// hence the focused B-only check rather than `soundnessViolations`.) Violations
	// are gathered into one array and asserted empty (no conditional `expect`).
	it('refined leaves: every non-undefined compiled parse satisfies the guard', () => {
		const shapes = [
			stringShape({ min: 2, max: 4, pattern: /^[a-z]+$/ }),
			numberShape({ min: -1, max: 1 }),
			integerShape({ min: 0, max: 10 }),
			arrayShape(integerShape(), { min: 1, max: 2 }),
			objectShape({
				tag: stringShape({ min: 1 }),
				score: integerShape({ min: 0, max: 100 }),
			}),
		]
		const violations: string[] = []
		for (const [shapeIndex, shape] of shapes.entries()) {
			const parse = compileParser(shape)
			const guard = compileGuard(shape)
			for (let index = 0; index < SOUNDNESS_SAMPLE.length; index += 1) {
				const outcome = attempt(() => parse(SOUNDNESS_SAMPLE[index]))
				if (!outcome.success) {
					if (!isContractError(outcome.error)) violations.push(`raw@shape${shapeIndex}@${index}`)
					continue
				}
				const parsed = outcome.value
				if (parsed !== undefined && !guard(parsed)) violations.push(`shape${shapeIndex}@${index}`)
			}
		}
		expect(violations).toEqual([])
	})

	it('an in-bounds value round-trips through createContract.parse and is', () => {
		const contract = createContract(
			objectShape({
				name: stringShape({ min: 1, max: 5 }),
				age: integerShape({ min: 0 }),
			}),
		)
		const parsed = contract.parse({ name: 'Ada', age: '36' })
		expect(parsed).toEqual({ name: 'Ada', age: 36 })
		expect(parsed !== undefined && contract.is(parsed)).toBe(true)
		// An out-of-bounds field makes the whole contract parse fail.
		expect(contract.parse({ name: '', age: 36 })).toBeUndefined()
	})
})

describe('compileReporter — soundness matrix', () => {
	const shapes: ReadonlyArray<readonly [string, ContractShape]> = [
		...leafShapeVariations(),
		['composite', compositeShape(2)],
	]

	it('explain(v).length === 0 iff parse(v) is defined across the readable sample corpus', () => {
		const violations: string[] = []
		for (const [label, shape] of shapes) {
			const parse = compileParser(shape)
			for (let index = 0; index < SOUNDNESS_SAMPLE.length; index += 1) {
				const value = SOUNDNESS_SAMPLE[index]
				const empty = compileReporter(shape, value).length === 0
				const outcome = attempt(() => parse(value))
				if (!outcome.success) {
					if (!isContractError(outcome.error)) violations.push(`raw@${label}@${index}`)
					continue
				}
				const defined = outcome.value !== undefined
				if (empty !== defined) violations.push(`${label}@${index}`)
			}
		}
		expect(violations).toEqual([])
	})
})

describe('compileReporter — object faults', () => {
	it('reports a nested deep path for a failing nested-object leaf', () => {
		const shape = objectShape({
			profile: objectShape({ name: stringShape({ min: 1 }) }),
		})
		const faults = compileReporter(shape, { profile: { name: '' } })
		expect(faults).toEqual([
			{
				reason: 'constraint',
				path: ['profile', 'name'],
				expected: 'string',
				constraint: 'min',
				limit: 1,
				received: '""',
			},
		])
	})

	it('reports one missing fault per absent required key', () => {
		const shape = objectShape({ name: stringShape(), age: integerShape() })
		const faults = compileReporter(shape, {})
		expect(faults).toEqual([
			{ reason: 'missing', path: ['name'], expected: 'string' },
			{ reason: 'missing', path: ['age'], expected: 'integer' },
		])
	})

	it('an absent optional key produces no fault', () => {
		const shape = objectShape({ bio: optionalShape(stringShape()) })
		expect(compileReporter(shape, {})).toEqual([])
	})

	it('reports per-key faults for a record shape', () => {
		const shape = recordShape(integerShape({ min: 0 }))
		const faults = compileReporter(shape, { a: -1, b: 'x', c: 5 })
		expect(faults).toEqual([
			{
				reason: 'constraint',
				path: ['a'],
				expected: 'integer',
				constraint: 'min',
				limit: 0,
				received: '-1',
			},
			{ reason: 'type', path: ['b'], expected: 'integer', received: '"x"' },
		])
	})

	it('a closed object never faults on extra keys (parse silently drops them)', () => {
		const shape = objectShape({ id: stringShape() })
		const faults = compileReporter(shape, { id: 'a', extra: 1, another: 2 })
		expect(faults).toEqual([])
		expect(compileParser(shape)({ id: 'a', extra: 1 })).toEqual({ id: 'a' })
	})

	it('a constraining additionalProperties shape recurses extras and faults', () => {
		const shape = objectShape({ id: stringShape() }, { additionalProperties: integerShape() })
		const faults = compileReporter(shape, { id: 'a', extra: 'not-a-number' })
		expect(faults).toEqual([
			{ reason: 'type', path: ['extra'], expected: 'integer', received: '"not-a-number"' },
		])
	})
})

describe('compileReporter — array faults', () => {
	it('reports owned holes without reading native-maximum source indices', () => {
		const fixture = createNativeMaximumSparseArray<unknown>()
		const faults = compileReporter(arrayShape(stringShape()), fixture.value)

		expect(faults).toHaveLength(FAULT_LIMIT)
		expect(faults[0]).toEqual({
			reason: 'type',
			path: ['0'],
			expected: 'string',
			received: 'undefined',
		})
		expect(fixture.probes).toEqual([])
	})

	it('reports per-index faults with the index in the path', () => {
		const shape = arrayShape(stringShape())
		// A finite number coerces to a string (parseString mirrors bidirectional
		// number<->string coercion), so only the genuinely non-coercible entries
		// (a boolean) fault — index 1 ('1' via coercion) stays clean.
		const faults = compileReporter(shape, ['a', 1, 'c', true])
		expect(faults).toEqual([{ reason: 'type', path: ['3'], expected: 'string', received: 'true' }])
	})

	it('reports length constraint faults', () => {
		const shape = arrayShape(stringShape(), { min: 2, max: 3 })
		expect(compileReporter(shape, ['a'])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'array',
				constraint: 'min',
				limit: 2,
				received: '1',
			},
		])
		expect(compileReporter(shape, ['a', 'b', 'c', 'd'])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'array',
				constraint: 'max',
				limit: 3,
				received: '4',
			},
		])
	})
})

describe('compileReporter — string constraint faults', () => {
	it('reports min / max / pattern faults with their limits', () => {
		const shape = stringShape({ min: 3, max: 5, pattern: /^[a-z]+$/ })
		expect(compileReporter(shape, 'ab')).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'min',
				limit: 3,
				received: '"ab"',
			},
		])
		expect(compileReporter(shape, 'abcdef')).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'max',
				limit: 5,
				received: '"abcdef"',
			},
		])
		expect(compileReporter(shape, 'AB')).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'min',
				limit: 3,
				received: '"AB"',
			},
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'pattern',
				limit: '^[a-z]+$',
				received: '"AB"',
			},
		])
	})

	it('a coercible number-as-string reports no fault (mirrors parse, not is)', () => {
		const shape = stringShape({ min: 1 })
		expect(compileReporter(shape, 42)).toEqual([])
		expect(compileParser(shape)(42)).toBe('42')
	})
})

describe('compileReporter — number/integer faults', () => {
	it('a coercible numeric string reports no fault', () => {
		const shape = integerShape({ min: 0, max: 10 })
		expect(compileReporter(shape, '42' /* out of range but coerces */)).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'integer',
				constraint: 'max',
				limit: 10,
				received: '42',
			},
		])
		expect(compileReporter(integerShape(), '7')).toEqual([])
		expect(compileParser(integerShape())('7')).toBe(7)
	})

	it('a fractional value against an integer shape reports an integer constraint fault', () => {
		expect(compileReporter(integerShape(), 3.5)).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'integer',
				constraint: 'integer',
				received: '3.5',
			},
		])
	})
})

describe('compileReporter — union / oneOf', () => {
	it('anyOf: any matching variant reports empty', () => {
		const shape = unionShape(stringShape(), integerShape())
		expect(compileReporter(shape, 'x')).toEqual([])
		expect(compileReporter(shape, 5)).toEqual([])
	})

	it('anyOf: no matching variant reports a variant summary plus the closest variant faults', () => {
		const shape = unionShape(stringShape({ min: 10 }), integerShape({ min: 0 }))
		const faults = compileReporter(shape, -1)
		expect(faults[0]).toEqual({ reason: 'variant', path: [], variants: 2 })
		// The integer variant is closer (a type fault vs. a constraint fault would
		// tie on count here, so this asserts against the actual closest — the
		// number variant, since -1 fails string's type check and integer's min
		// constraint: 1 fault each, ties broken by lowest index — string wins the
		// tie, so its type fault follows.
		expect(faults.length).toBe(2)
	})

	it('oneOf: zero matches reports matched:0 plus the closest variant faults', () => {
		const shape = oneOfShape(stringShape({ pattern: /^a/ }), stringShape({ pattern: /^b/ }))
		const faults = compileReporter(shape, 'x')
		expect(faults[0]).toEqual({ reason: 'oneOf', path: [], matched: 0 })
		expect(faults.length).toBeGreaterThan(1)
	})

	it('oneOf: exactly one match reports empty', () => {
		const shape = oneOfShape(stringShape({ pattern: /^a/ }), stringShape({ pattern: /^b/ }))
		expect(compileReporter(shape, 'apple')).toEqual([])
	})

	it('oneOf: two-or-more matches reports matched >= 2 alone', () => {
		const shape = oneOfShape(stringShape(), stringShape({ min: 0 }))
		expect(compileReporter(shape, 'x')).toEqual([{ reason: 'oneOf', path: [], matched: 2 }])
	})
})

describe('compileReporter — hostile input containment', () => {
	it('bounds a cyclic object value against a finite shape and JSON.stringify(faults) succeeds', () => {
		const shape = objectShape({ id: stringShape() })
		// The shape tree is finite (never cyclic per AGENTS §14), so recursion
		// depth follows the SHAPE, not the value — a self-referencing value poses
		// no infinite-recursion risk. `id` is a non-coercible object, so it faults.
		const cyclic: Record<string, unknown> = { id: {} }
		cyclic.self = cyclic
		const faults = compileReporter(shape, cyclic)
		expect(faults).toEqual([
			{ reason: 'type', path: ['id'], expected: 'string', received: 'object' },
		])
		expect(() => JSON.stringify(faults)).not.toThrow()
	})

	it('caps a 5000-element hostile array at FAULT_LIMIT', () => {
		const shape = arrayShape(stringShape())
		// Objects never coerce to a string, so every element faults.
		const hostile = new Array(5000).fill({})
		const faults = compileReporter(shape, hostile)
		expect(faults.length).toBeLessThanOrEqual(64)
		expect(faults.length).toBeGreaterThan(0)
	})

	it('clips a giant string preview', () => {
		const shape = stringShape({ pattern: /^a+$/ })
		const giant = 'b'.repeat(1000)
		const faults = compileReporter(shape, giant)
		expect(faults.length).toBe(1)
		const fault = faults[0]
		expect(fault !== undefined && fault.reason === 'constraint').toBe(true)
		expect(fault?.reason === 'constraint' && fault.received.length).toBeLessThanOrEqual(65) // PREVIEW_LIMIT + ellipsis
	})

	it('contains a throwing Proxy getter — returns faults, never throws', () => {
		const hostile = new Proxy(
			{ id: 'x' },
			{
				get() {
					throw new Error('hostile getter')
				},
			},
		)
		const shape = objectShape({ id: stringShape() })
		expect(() => compileReporter(shape, hostile)).not.toThrow()
		const faults = compileReporter(shape, hostile)
		expect(faults.length).toBeGreaterThan(0)
	})

	it('is deterministic — two runs over the same input produce identical faults', () => {
		const shape = objectShape({
			id: stringShape({ min: 1 }),
			tags: arrayShape(stringShape()),
		})
		const value = { id: '', tags: ['a', 1, 'c'] }
		const first = compileReporter(shape, value)
		const second = compileReporter(shape, value)
		expect(first).toEqual(second)
	})
})

describe('createContract — explain wiring', () => {
	it('present-but-undefined optional property: explain matches parse (accept)', () => {
		const shape = objectShape({ bio: optionalShape(stringShape()) })
		const value = { bio: undefined }
		const faults = compileReporter(shape, value)
		const parsed = compileParser(shape)(value)
		expect(faults).toEqual([])
		expect(parsed).toBeDefined()
	})

	it('present-but-undefined required raw property: explain matches parse (reject as missing)', () => {
		const shape = objectShape({ k: rawShape({}) })
		const value = { k: undefined }
		const faults = compileReporter(shape, value)
		const parsed = compileParser(shape)(value)
		expect(parsed).toBeUndefined()
		expect(faults.length).toBeGreaterThan(0)
		expect(faults[0]).toMatchObject({ reason: 'missing', path: ['k'] })
	})

	it('top-level raw undefined reports the parser failure sentinel', () => {
		const shape = rawShape({})

		expect(compileParser(shape)(undefined)).toBeUndefined()
		expect(compileReporter(shape, undefined)).toEqual([
			{ reason: 'type', path: [], expected: 'json', received: 'undefined' },
		])
	})

	it('caps total faults at FAULT_LIMIT even across nested union variant concatenation', () => {
		const wide = objectShape(
			Object.fromEntries(
				Array.from({ length: FAULT_LIMIT }, (_, index) => [
					`f${String(index)}`,
					stringShape({ min: 1 }),
				]),
			),
		)
		const badRecord = Object.fromEntries(
			Array.from({ length: FAULT_LIMIT }, (_, index) => [`f${String(index)}`, '']),
		)
		const shape = unionShape(wide, wide)
		const faults = compileReporter(shape, badRecord)
		expect(faults.length).toBeLessThanOrEqual(FAULT_LIMIT)
	})

	it('explain(v) delegates to compileReporter(shape, v)', () => {
		const shape = objectShape({ name: stringShape({ min: 1 }) })
		const contract = createContract(shape)
		expect(contract.explain({ name: '' })).toEqual(compileReporter(shape, { name: '' }))
		expect(contract.explain({ name: 'Ada' })).toEqual([])
	})

	it('explain empty iff parse defined, on the compiled contract', () => {
		const shape = objectShape({ id: stringShape(), age: integerShape({ min: 0 }) })
		const contract = createContract(shape)
		const good = { id: 'x', age: 5 }
		const bad = { id: 'x', age: -1 }
		expect(contract.explain(good).length === 0).toBe(contract.parse(good) !== undefined)
		expect(contract.explain(bad).length === 0).toBe(contract.parse(bad) !== undefined)
	})
})

describe('Fault reason type', () => {
	it('covers every fault discriminant without a suppression', () => {
		expectTypeOf<Fault['reason']>().toEqualTypeOf<
			'type' | 'missing' | 'constraint' | 'variant' | 'oneOf'
		>()
	})
})

describe('null / json compileGenerator', () => {
	it('null generator always emits null and passes the null guard', () => {
		const guard = compileGuard(nullShape())
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(nullShape(), seededRandom(seed))
			expect(value).toBeNull()
			expect(guard(value)).toBe(true)
		}
	})

	it('json generator output always passes the json guard, across many seeds', () => {
		const guard = compileGuard(jsonShape())
		for (let seed = 0; seed < 30; seed += 1) {
			const value = compileGenerator(jsonShape(), seededRandom(seed))
			expect(guard(value)).toBe(true)
		}
	})

	it('json generator is deterministic for a given seed', () => {
		expect(compileGenerator(jsonShape(), seededRandom(99))).toEqual(
			compileGenerator(jsonShape(), seededRandom(99)),
		)
	})
})

describe('compileGenerator', () => {
	it('is deterministic for a given seed', () => {
		const shape = objectShape({
			name: stringShape(),
			age: integerShape({ min: 0, max: 100 }),
		})
		expect(compileGenerator(shape, seededRandom(42))).toEqual(
			compileGenerator(shape, seededRandom(42)),
		)
	})

	it('produces values that satisfy the compiled guard', () => {
		const shape = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape({ min: 0, max: 120 }),
			role: literalShape(['admin', 'guest']),
			tags: arrayShape(stringShape(), { min: 1, max: 3 }),
		})
		const guard = compileGuard(shape)
		const random = seededRandom(7)
		for (let index = 0; index < 20; index += 1) {
			expect(guard(compileGenerator(shape, random))).toBe(true)
		}
	})

	it('produces bounded strings that satisfy the compiled guard', () => {
		const shapes = [
			stringShape({ min: 2, max: 4 }),
			stringShape({ max: 6 }),
			stringShape({ min: 0, max: 0 }),
			objectShape({ tag: stringShape({ min: 2, max: 4 }) }),
			arrayShape(stringShape({ min: 2, max: 4 }), { min: 1, max: 3 }),
		]
		for (const shape of shapes) {
			const guard = compileGuard(shape)
			const random = seededRandom(11)
			for (let index = 0; index < 20; index += 1) {
				expect(guard(compileGenerator(shape, random))).toBe(true)
			}
		}
	})

	it('generates the empty string when min and max are both 0', () => {
		const shape = stringShape({ min: 0, max: 0 })
		expect(compileGenerator(shape, seededRandom(1))).toBe('')
	})

	it('throws on a degenerate empty literal / union (programmer error)', () => {
		expect(() => compileGenerator(literalShape([]), seededRandom(1))).toThrow('at least one value')
		expect(() => compileGenerator(unionShape(), seededRandom(1))).toThrow('at least one variant')
	})

	it('throws on a pattern-constrained string shape it cannot satisfy (programmer error)', () => {
		const shape = stringShape({ min: 4, max: 6, pattern: /^ZZZZZZ$/ })
		expect(() => compileGenerator(shape, seededRandom(1))).toThrow('cannot be auto-generated')
	})

	it('falls back to the default random source when none is supplied', () => {
		const shape = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape({ min: 0, max: 9 }),
		})
		const guard = compileGuard(shape)
		expect(guard(compileGenerator(shape))).toBe(true)
	})

	it('generates an empty array when max:0 and passes the guard', () => {
		const shape = arrayShape(stringShape(), { max: 0 })
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(shape, seededRandom(seed))
			expect(value).toEqual([])
			expect(guard(value)).toBe(true)
		}
	})

	it('generates within a fractional-bounds integer range and passes the guard', () => {
		const shape = integerShape({ min: 2.5, max: 3.4 })
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(shape, seededRandom(seed))
			expect(value).toBe(3)
			expect(guard(value)).toBe(true)
		}
	})

	it('honors a one-sided negative maximum across one thousand seeds', () => {
		const shape = numberShape({ max: -1 })
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 1000; seed += 1) {
			expect(guard(compileGenerator(shape, seededRandom(seed)))).toBe(true)
		}
	})

	it('draws bounded number and integer values across their effective ranges', () => {
		const number = numberShape({ min: 10, max: 20 })
		const integer = integerShape({ min: 10, max: 20 })

		expect(compileGenerator(number, () => 0)).toBe(10)
		expect(compileGenerator(number, () => 0.5)).toBe(15)
		expect(compileGenerator(integer, () => 0)).toBe(10)
		expect(compileGenerator(integer, () => 0.5)).toBe(15)
	})

	it('generates guard-valid finite values across extreme numeric bounds without overflow', () => {
		const shapes = [
			numberShape({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE }),
			integerShape({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE }),
			numberShape({ min: Number.MAX_VALUE }),
			integerShape({ max: -Number.MAX_VALUE }),
		]

		for (const shape of shapes) {
			const guard = compileGuard(shape)
			const value = compileGenerator(shape, () => 0.5)
			expect(Number.isFinite(value)).toBe(true)
			expect(guard(value)).toBe(true)
		}
	})

	it('uses a span-relative synthetic range for one-sided number and integer bounds', () => {
		const shapes = [numberShape({ min: 500 }), integerShape({ max: -500 })]

		for (const shape of shapes) {
			const first = compileGenerator(shape, () => 0)
			const second = compileGenerator(shape, () => 0.5)
			expect(first).not.toBe(second)
			expect(compileGuard(shape)(first)).toBe(true)
			expect(compileGuard(shape)(second)).toBe(true)
		}
	})

	it('rotates through union and oneOf variants so an ungeneratable first variant cannot starve siblings', () => {
		expect(compileGenerator(unionShape(rawShape({}), literalShape(['ok'])), () => 0)).toBe('ok')
		expect(
			compileGenerator(
				oneOfShape(stringShape({ min: 1, pattern: /^z$/ }), literalShape([1])),
				() => 0,
			),
		).toBe(1)
	})

	it('reports an out-of-range random source distinctly from union exhaustion', () => {
		const error = captureContractError(() =>
			compileGenerator(unionShape(stringShape(), integerShape()), () => 1),
		)

		expect(error.code).toBe('random')
		expect(error.context).toEqual({
			shape: 'union',
			limit: '[0, 1)',
			received: '1',
		})
	})

	it('reports hostile invalid samples through number, union, and contract generators', () => {
		const accesses: PropertyKey[] = []
		const sample = new Proxy(
			{},
			{
				get(target, property, receiver) {
					if (
						property === Symbol.toPrimitive ||
						property === 'valueOf' ||
						property === 'toString'
					) {
						accesses.push(property)
						throw new Error('sample coercion')
					}
					return Reflect.get(target, property, receiver)
				},
			},
		)
		const contract = createContract(numberShape())
		const errors = [
			captureContractError(() =>
				Reflect.apply(compileGenerator, undefined, [numberShape(), () => sample]),
			),
			captureContractError(() =>
				Reflect.apply(compileGenerator, undefined, [
					unionShape(numberShape(), integerShape()),
					() => sample,
				]),
			),
			captureContractError(() => Reflect.apply(contract.generate, contract, [() => sample])),
		]

		expect(errors.map((error) => error.message)).toEqual([
			'drawRandom: the random source must return a value in [0, 1)',
			'drawRandom: the random source must return a value in [0, 1)',
			'drawRandom: the random source must return a value in [0, 1)',
		])
		expect(errors.map((error) => error.code)).toEqual(['random', 'random', 'random'])
		expect(errors.map((error) => error.context)).toEqual([
			{ shape: 'number', limit: '[0, 1)', received: 'object' },
			{ shape: 'union', limit: '[0, 1)', received: 'object' },
			{ shape: 'number', limit: '[0, 1)', received: 'object' },
		])
		expect(accesses).toEqual([])
	})

	it('reports primitive symbols through number, union, and contract generators', () => {
		const calls: string[] = []
		const contract = createContract(numberShape())
		const errors = replaceIntrinsic(
			Symbol.prototype,
			'toString',
			() => {
				calls.push('toString')
				throw new Error('symbol formatting')
			},
			() => [
				captureContractError(() =>
					Reflect.apply(compileGenerator, undefined, [numberShape(), () => Symbol('number')]),
				),
				captureContractError(() =>
					Reflect.apply(compileGenerator, undefined, [
						unionShape(numberShape(), integerShape()),
						() => Symbol('union'),
					]),
				),
				captureContractError(() =>
					Reflect.apply(contract.generate, contract, [() => Symbol('contract')]),
				),
			],
		)

		expect(errors.map((error) => error.message)).toEqual([
			'drawRandom: the random source must return a value in [0, 1)',
			'drawRandom: the random source must return a value in [0, 1)',
			'drawRandom: the random source must return a value in [0, 1)',
		])
		expect(errors.map((error) => error.code)).toEqual(['random', 'random', 'random'])
		expect(errors.map((error) => error.context)).toEqual([
			{ shape: 'number', limit: '[0, 1)', received: 'Symbol(number)' },
			{ shape: 'union', limit: '[0, 1)', received: 'Symbol(union)' },
			{ shape: 'number', limit: '[0, 1)', received: 'Symbol(contract)' },
		])
		expect(errors.every((error) => !Object.hasOwn(error, 'cause'))).toBe(true)
		expect(calls).toEqual([])
	})

	it('propagates one atomic escape-boundary preview through every generator entry', () => {
		const sample = Symbol(`${'x'.repeat(56)}\\tail`)
		const received = preview(sample)
		const contract = createContract(numberShape())
		const errors = [
			captureContractError(() =>
				Reflect.apply(compileGenerator, undefined, [numberShape(), () => sample]),
			),
			captureContractError(() =>
				Reflect.apply(compileGenerator, undefined, [
					unionShape(numberShape(), integerShape()),
					() => sample,
				]),
			),
			captureContractError(() => Reflect.apply(contract.generate, contract, [() => sample])),
		]

		expect(received).toBe(`Symbol(${'x'.repeat(56)}…`)
		expect(received).not.toMatch(/\\…$/)
		expect(errors.map((error) => error.code)).toEqual(['random', 'random', 'random'])
		expect(errors.map((error) => error.context)).toEqual([
			{ shape: 'number', limit: '[0, 1)', received },
			{ shape: 'union', limit: '[0, 1)', received },
			{ shape: 'number', limit: '[0, 1)', received },
		])
		expect(errors.every((error) => !Object.hasOwn(error, 'cause'))).toBe(true)
	})

	it('does not retrieve the mutable string iterator through generator entries', () => {
		const calls: string[] = []
		const sample = Symbol('sample')
		const contract = createContract(numberShape())
		const errors = replaceStringIterator(
			() => {
				calls.push('iterator')
				throw Object.freeze({ source: 'string iterator' })
			},
			() => [
				captureContractError(() =>
					Reflect.apply(compileGenerator, undefined, [numberShape(), () => sample]),
				),
				captureContractError(() =>
					Reflect.apply(compileGenerator, undefined, [
						unionShape(numberShape(), integerShape()),
						() => sample,
					]),
				),
				captureContractError(() => Reflect.apply(contract.generate, contract, [() => sample])),
			],
		)

		expect(errors.map((error) => error.code)).toEqual(['random', 'random', 'random'])
		expect(errors.map((error) => error.context?.received)).toEqual([
			'Symbol(sample)',
			'Symbol(sample)',
			'Symbol(sample)',
		])
		expect(calls).toEqual([])
	})

	it('does not retrieve a throwing string-slice getter through generator entries', () => {
		let getters = 0
		const reason = Object.freeze({ source: 'string slice' })
		const sample = Symbol('sample')
		const contract = createContract(numberShape())
		const errors = replaceStringSlice(
			() => {
				getters += 1
				throw reason
			},
			() => [
				captureContractError(() =>
					Reflect.apply(compileGenerator, undefined, [numberShape(), () => sample]),
				),
				captureContractError(() =>
					Reflect.apply(compileGenerator, undefined, [
						unionShape(numberShape(), integerShape()),
						() => sample,
					]),
				),
				captureContractError(() => Reflect.apply(contract.generate, contract, [() => sample])),
			],
		)

		expect(errors.map((error) => error.code)).toEqual(['random', 'random', 'random'])
		expect(errors.map((error) => error.context)).toEqual([
			{ shape: 'number', limit: '[0, 1)', received: 'Symbol(sample)' },
			{ shape: 'union', limit: '[0, 1)', received: 'Symbol(sample)' },
			{ shape: 'number', limit: '[0, 1)', received: 'Symbol(sample)' },
		])
		expect(errors.every((error) => !Object.hasOwn(error, 'cause'))).toBe(true)
		expect(getters).toBe(0)
	})

	it('does not call a hostile string-slice replacement through generator entries', () => {
		let getters = 0
		let calls = 0
		const sample = Symbol('sample')
		const contract = createContract(numberShape())
		const errors = replaceStringSlice(
			() => {
				getters += 1
				return () => {
					calls += 1
					return '\n'
				}
			},
			() => [
				captureContractError(() =>
					Reflect.apply(compileGenerator, undefined, [numberShape(), () => sample]),
				),
				captureContractError(() =>
					Reflect.apply(compileGenerator, undefined, [
						unionShape(numberShape(), integerShape()),
						() => sample,
					]),
				),
				captureContractError(() => Reflect.apply(contract.generate, contract, [() => sample])),
			],
		)

		expect(errors.map((error) => error.code)).toEqual(['random', 'random', 'random'])
		expect(errors.map((error) => error.context)).toEqual([
			{ shape: 'number', limit: '[0, 1)', received: 'Symbol(sample)' },
			{ shape: 'union', limit: '[0, 1)', received: 'Symbol(sample)' },
			{ shape: 'number', limit: '[0, 1)', received: 'Symbol(sample)' },
		])
		expect(errors.every((error) => !Object.hasOwn(error, 'cause'))).toBe(true)
		expect(getters).toBe(0)
		expect(calls).toBe(0)
	})

	it('propagates invalid and throwing random samples from inside a union variant', () => {
		let invalidDraw = 0
		const invalid = captureContractError(() =>
			compileGenerator(unionShape(stringShape(), nullShape()), () => {
				invalidDraw += 1
				return invalidDraw === 1 ? 0 : 1
			}),
		)
		let throwingDraw = 0
		const throwing = captureContractError(() =>
			compileGenerator(unionShape(stringShape(), nullShape()), () => {
				throwingDraw += 1
				if (throwingDraw > 1) throw new Error('later draw')
				return 0
			}),
		)

		expect(invalid.code).toBe('random')
		expect(invalid.context?.shape).toBe('string')
		expect(throwing.code).toBe('random')
		expect(throwing.context?.shape).toBe('string')
	})

	it('distinguishes shared-gate failures from direct generator failures', () => {
		const generation: readonly ContractShape[] = [
			stringShape({ min: 1, pattern: /^z$/ }),
			rawShape({}),
		]

		for (const shape of generation) {
			const error = captureContractError(() => compileGenerator(shape, () => 0))
			expect(error.code).toBe('generate')
			expect(error.context?.shape).toBe(shape.type)
		}
		const malformed: readonly ContractShape[] = [
			JSON.parse('{"type":"literal","values":[]}'),
			JSON.parse('{"type":"union","variants":[]}'),
		]
		for (const shape of malformed) {
			const error = captureContractError(() => compileGenerator(shape, () => 0))
			expect(error.code).toBe('empty')
			expect(error.context?.shape).toBe(shape.type)
		}
	})

	it('throws generate when no oneOf candidate can satisfy the compiled guard', () => {
		const shape = oneOfShape(literalShape(['same']), literalShape(['same']))

		expect(() => compileGenerator(shape, seededRandom(1))).toThrowError(ContractError)
		const error = captureContractError(() => compileGenerator(shape, seededRandom(1)))
		expect(isContractError(error)).toBe(true)
		expect(error.code).toBe('generate')
	})

	it('throws on a raw shape (cannot be auto-generated)', () => {
		expect(() => compileGenerator(rawShape({ type: 'string' }), seededRandom(1))).toThrow(
			'compileGenerator: a raw shape embeds an arbitrary JSON Schema and cannot be auto-generated — supply values another way',
		)
	})

	it('an open recordShape generates at least one synthetic entry and passes its own guard', () => {
		const shape = recordShape(integerShape())
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(shape, seededRandom(seed))
			expect(isRecord(value)).toBe(true)
			const record = isRecord(value) ? value : {}
			expect(Object.keys(record).length).toBeGreaterThan(0)
			expect(guard(value)).toBe(true)
		}
	})
})

describe('createContract fail-fast', () => {
	it('throws at creation time for a degenerate shape, not at use', () => {
		expect(() => createContract({ type: 'string', min: 5, max: 1 })).toThrow(
			'validateShapeDepth: a string shape has min greater than max',
		)
		expect(() => createContract(JSON.parse('{"type":"union","variants":[]}'))).toThrow(
			'validateShapeDepth: a union shape needs at least one variant',
		)
		expect(() => createContract(JSON.parse('{"type":"literal","values":[]}'))).toThrow(
			'validateShapeDepth: a literal shape needs at least one value',
		)
		expect(() => createContract(integerShape({ min: 2.5, max: 2.6 }))).toThrow(
			'validateShapeDepth: an integer number shape has an empty integer range',
		)
		expect(() => createContract(arrayShape(optionalShape(stringShape())))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})
})

describe('createContract', () => {
	it('bundles schema / is / parse / generate from one shape', () => {
		const contract = createContract(
			objectShape({ name: stringShape({ min: 1 }), age: integerShape() }),
		)
		expect(contract.schema).toEqual({
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1 },
				age: { type: 'integer' },
			},
			required: ['name', 'age'],
			additionalProperties: false,
		})
		expect(contract.is({ name: 'Ada', age: 36 })).toBe(true)
		expect(contract.is({ name: 'Ada', age: 36.5 })).toBe(false)
		expect(contract.parse({ name: 'Ada', age: '36' })).toEqual({
			name: 'Ada',
			age: 36,
		})
		// The generator's output satisfies the contract's own guard.
		expect(contract.is(contract.generate(seededRandom(3)))).toBe(true)
	})

	it('owns one immutable snapshot of a hand-authored mutable shape graph', () => {
		const values: LiteralValue[] = ['stable']
		const items = { type: 'literal', values } satisfies ContractShape
		const array = { type: 'array', items } satisfies ContractShape
		const variants: ContractShape[] = [array]
		const shape: ContractShape = { type: 'union', variants }
		const contract = createContract<ContractShape>(shape)
		const schema = contract.schema

		values[0] = 'drift'
		array.items = { type: 'literal', values: ['drift'] }
		variants[0] = { type: 'number' }

		expect(contract.schema).toBe(schema)
		expect(contract.schema).toEqual({
			anyOf: [{ type: 'array', items: { enum: ['stable'] } }],
		})
		expect(contract.is(['stable'])).toBe(true)
		expect(contract.is(['drift'])).toBe(false)
		expect(contract.parse(['stable'])).toEqual(['stable'])
		expect(contract.parse(['drift'])).toBeUndefined()
		expect(contract.is(contract.generate(seededRandom(4)))).toBe(true)
		expect(contract.generate(seededRandom(4))).toEqual(['stable'])
	})

	it('exposes a deeply frozen schema artifact that cannot drift from compiled behavior', () => {
		const contract = createContract(objectShape({ value: stringShape() }))

		expect(Object.isFrozen(contract.schema)).toBe(true)
		expect(Object.isFrozen(contract.schema.properties)).toBe(true)
		expect(Object.isFrozen(contract.schema.properties?.value)).toBe(true)
		expect(Reflect.set(contract.schema, 'type', 'number')).toBe(false)
		expect(contract.schema.type).toBe('object')
		expect(contract.is({ value: 'stable' })).toBe(true)
	})

	it('carries record-shape inference end-to-end through a compiled contract', () => {
		const c = createContract(recordShape(numberShape()))
		const parsed = c.parse({})
		expect(parsed).toBeDefined()
		const record = parsed ?? {}
		const one: number | undefined = record.k
		expect(one).toBeUndefined()
		expectTypeOf(c.generate).returns.toEqualTypeOf<Readonly<Record<string, number>>>()
	})
})

describe('compiler shape ownership', () => {
	it('owns an unfrozen caller graph at every compiler entry point', () => {
		const values: LiteralValue[] = ['stable']
		const items: ContractShape = { type: 'literal', values }
		const shape: ContractShape = { type: 'array', items }

		const schema = compileSchema(shape)
		const guard = compileGuard(shape)
		const parse = compileParser(shape)
		const generated = compileGenerator(shape, seededRandom(7))
		const faults = compileReporter(shape, ['drift'])

		values[0] = 'drift'

		expect(schema).toEqual({ type: 'array', items: { enum: ['stable'] } })
		expect(guard(['stable'])).toBe(true)
		expect(guard(['drift'])).toBe(false)
		expect(parse(['stable'])).toEqual(['stable'])
		expect(parse(['drift'])).toBeUndefined()
		expect(guard(generated)).toBe(true)
		expect(faults).toHaveLength(1)
	})
})

describe('compileGuard generic inference', () => {
	it('narrows a Guard<Infer<S>> when the shape is a specific literal type', () => {
		const g = compileGuard(objectShape({ name: stringShape() }))
		const x: unknown = { name: 'Ada' }
		expect(g(x)).toBe(true)
		const guarded = g(x) ? x : { name: '' }
		const nm: string = guarded.name
		expect(nm).toBe('Ada')
	})
})

describe('compileParser generic inference', () => {
	it('narrows a Parser<Infer<S>> when the shape is a specific literal type', () => {
		const p = compileParser(recordShape(numberShape()))
		const r = p({})
		const val: Readonly<Record<string, number>> | undefined = r
		expect(val).toBeDefined()
		expectTypeOf(r).toEqualTypeOf<Readonly<Record<string, number>> | undefined>()
	})
})

describe('compileGenerator generic inference', () => {
	it('narrows to Infer<S> when the shape is a specific literal type', () => {
		const gen = compileGenerator(objectShape({ age: integerShape() }))
		const a: number = gen.age
		expect(a).toBeDefined()
	})
})

describe('shape separation registry', () => {
	it('demonstrates every declared parser-versus-guard separation', () => {
		let count = 0
		for (const separation of Object.values(SHAPE_SEPARATIONS)) {
			if (separation.witness === undefined) continue
			count += 1
			const parse = compileParser(separation.shape)
			const guard = compileGuard(separation.shape)

			expect(parse(separation.witness)).not.toBeUndefined()
			expect(guard(separation.witness)).toBe(false)
			expect(compileAuditor(separation.shape, separation.witness).length).toBeGreaterThan(0)
			expect(compileReporter(separation.shape, separation.witness)).toHaveLength(0)
		}
		expect(count).toBe(9)
	})

	it('finds no corpus witness for source-argued coincident domains', () => {
		let count = 0
		let refusals = 0
		let uncoded = 0
		for (const separation of Object.values(SHAPE_SEPARATIONS)) {
			if (separation.witness !== undefined) continue
			count += 1
			const parse = compileParser(separation.shape)
			const guard = compileGuard(separation.shape)
			const witnesses: unknown[] = []
			for (const value of SOUNDNESS_SAMPLE) {
				const parsed = attempt(() => parse(value))
				if (!parsed.success) {
					if (!isContractError(parsed.error)) uncoded += 1
					refusals += 1
					continue
				}
				if (parsed.value !== undefined && !guard(value)) witnesses.push(value)
			}
			expect(witnesses).toEqual([])
		}
		expect(count).toBe(3)
		expect(uncoded).toBe(0)
		expect(refusals).toBeGreaterThan(0)
	})

	it('validates and compiles representatives for all twelve shape kinds', () => {
		expect(Object.keys(SHAPE_SEPARATIONS)).toHaveLength(12)
		for (const separation of Object.values(SHAPE_SEPARATIONS)) {
			expect(() => validateShapeDepth(separation.shape)).not.toThrow()
			expect(() => validateShapeDepth(separation.shape)).not.toThrow()
			const schema = compileSchema(separation.shape)
			const guard = compileGuard(separation.shape)
			const parse = compileParser(separation.shape)
			expect(schema).toBeDefined()
			expect(guard).toBeTypeOf('function')
			expect(parse).toBeTypeOf('function')
			expect(compileAuditor(separation.shape, null)).toBeInstanceOf(Array)
			expect(compileReporter(separation.shape, null)).toBeInstanceOf(Array)
		}

		const raw = SHAPE_SEPARATIONS.raw
		const rawGuard = compileGuard(raw.shape)
		const rawParse = compileParser(raw.shape)
		expect(rawGuard(null)).toBe(true)
		expect(rawParse(null)).toBeNull()
		expect(compileAuditor(raw.shape, null)).toHaveLength(0)
		expect(compileReporter(raw.shape, null)).toHaveLength(0)
		const error = captureContractError(() => compileGenerator(raw.shape, seededRandom(7)))
		expect(error.code).toBe('generate')

		const generatedEntries = Object.entries(SHAPE_SEPARATIONS).filter(([type]) => type !== 'raw')
		for (const [, separation] of generatedEntries) {
			const guard = compileGuard(separation.shape)
			const parse = compileParser(separation.shape)
			const generated = compileGenerator(separation.shape, seededRandom(7))
			expect(generated).not.toBeUndefined()
			expect(guard(generated)).toBe(true)
			expect(parse(generated)).not.toBeUndefined()
			expect(compileAuditor(separation.shape, generated)).toHaveLength(0)
			expect(compileReporter(separation.shape, generated)).toHaveLength(0)
		}
	})
})

describe('compiled artifacts answer through unredirectable dispatch', () => {
	// Every compiled artifact reaches the same two organs the sixth round broke:
	// a membership test that decides the published answer, and a publication walk
	// that decides the published value. Each is asked here at the artifact door
	// rather than only at the primitive it was fixed in.
	const answerTrue = (): boolean => true
	const shape = objectShape({
		name: stringShape({ min: 1 }),
		age: optionalShape(integerShape({ min: 0 })),
	})

	it('contract.is rejects a non-member literal while Set.prototype.has answers true', () => {
		const contract = createContract(literalShape(['a', 'b']))
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			member: contract.is('a'),
			stranger: contract.is('NOT-A-MEMBER'),
		}))

		expect(answers).toEqual({ member: true, stranger: false })
	})

	it('compileGuard still rejects an extra and a missing key while Set.prototype.has answers true', () => {
		const guard = compileGuard(shape)
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			exact: guard({ name: 'Ada' }),
			extra: guard({ name: 'Ada', ghost: 1 }),
			missing: guard({}),
		}))

		expect(answers).toEqual({ exact: true, extra: false, missing: false })
	})

	it('compileParser still refuses a missing required key while Set.prototype.has answers true', () => {
		const parse = compileParser(shape)
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			complete: parse({ name: 'Ada' }),
			missing: parse({}),
		}))

		expect(answers).toEqual({ complete: { name: 'Ada' }, missing: undefined })
	})

	it('compileReporter and compileAuditor still fault a missing key while Set.prototype.has answers true', () => {
		const answers = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			reported: compileReporter(shape, {}),
			audited: compileAuditor(shape, {}),
		}))

		expect(answers.reported).toEqual([{ reason: 'missing', path: ['name'], expected: 'string' }])
		expect(answers.audited).toEqual([{ reason: 'missing', path: ['name'], expected: 'string' }])
	})

	it('compileGenerator publishes a coded refusal while Date.now throws', () => {
		// The fifth shape in its purest form: `random = seededRandom(Date.now())`
		// was a DEFAULT PARAMETER, evaluated in the function environment before the
		// first statement of the body, so no at-the-door boundary could reach it at
		// any door count. The read moved into the body and onto the captured clock.
		const sentinel = Object.freeze({ stage: 'date' })
		const thrower = (): never => {
			throw sentinel
		}
		const outcome = replaceIntrinsic(Date, 'now', thrower, () =>
			attempt(() => compileGenerator(stringShape())),
		)

		expect(outcome.success).toBe(true)
		expect(typeof (outcome.success ? outcome.value : undefined)).toBe('string')
	})

	it('contract.generate publishes a coded refusal while Date.now throws', () => {
		const sentinel = Object.freeze({ stage: 'date' })
		const thrower = (): never => {
			throw sentinel
		}
		const contract = createContract(stringShape())
		const outcome = replaceIntrinsic(Date, 'now', thrower, () => attempt(() => contract.generate()))

		expect(outcome.success).toBe(true)
		expect(typeof (outcome.success ? outcome.value : undefined)).toBe('string')
	})

	it('compileGenerator publishes a coded refusal while globalThis.Date is foreign', () => {
		const outcome = replaceIntrinsic(
			globalThis,
			'Date',
			() => ({}),
			() => attempt(() => compileGenerator(stringShape())),
		)

		expect(outcome.success).toBe(true)
	})

	it('compileSchema publishes its own union while Array.prototype.map lies', () => {
		// `Array.prototype.map = () => ['INJECTED']` made this door SUCCEED and
		// answer `{"anyOf":["INJECTED"]}` — the caller's content inside the
		// package's own published schema.
		const lie = (): readonly string[] => ['INJECTED']
		const published = replaceIntrinsic(Array.prototype, 'map', lie, () =>
			compileSchema(unionShape(stringShape(), integerShape())),
		)

		expect(published).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] })
	})

	it('compileReporter publishes a marker-free diagnostic path while the array iterator injects', () => {
		function* injectLeading(this: readonly unknown[]): Generator<unknown> {
			yield 'INJECTED'
			for (let index = 0; index < this.length; index += 1) yield this[index]
		}
		const outcomes = replaceIntrinsic(Array.prototype, Symbol.iterator, injectLeading, () => ({
			reported: attempt(() => compileReporter(shape, { name: 1 })),
			audited: attempt(() => compileAuditor(shape, { name: 1 })),
		}))

		expect(JSON.stringify(outcomes.reported)).not.toContain('INJECTED')
		expect(JSON.stringify(outcomes.audited)).not.toContain('INJECTED')
		for (const outcome of [outcomes.reported, outcomes.audited]) {
			if (outcome.success) continue
			expect(isContractError(outcome.error)).toBe(true)
			if (!isContractError(outcome.error)) continue
			expect(JSON.stringify(outcome.error.context)).not.toContain('INJECTED')
		}
	})

	it('bounds a report through an owned walk while Array.prototype.slice lies', () => {
		const lie = (): readonly Fault[] => []
		const wide = objectShape({ name: stringShape({ min: 1 }) })
		const published = replaceIntrinsic(Array.prototype, 'slice', lie, () =>
			compileReporter(wide, {}),
		)

		expect(published).toEqual([{ reason: 'missing', path: ['name'], expected: 'string' }])
	})
})

describe('four-door agreement (H9 soundness)', () => {
	// AGENTS §14: guard-valid input is never rejected by its parser. The guide adds
	// `audit(v).length === 0 ⟺ is(v)` and `explain(v).length === 0 ⟺ parse(v) !== undefined`.
	// The direction that matters is the false clean: no door may CERTIFY a value
	// another door then refuses.
	it('never certifies an open object whose undeclared key cannot be read', () => {
		const contract = createContract(
			objectShape({ a: stringShape() }, { additionalProperties: true }),
		)
		const value = {
			a: 'x',
			get b(): unknown {
				throw new Error('unreadable extra')
			},
		}

		expect(contract.is(value)).toBe(false)
		expect(captureContractError(() => contract.audit(value)).code).toBe('structure')
		expect(contract.explain(value)).not.toEqual([])
		expect(captureContractError(() => contract.parse(value)).code).toBe('structure')
	})

	it('agrees on a closed object whose dropped extra cannot be read', () => {
		// `parse` used to route through `parseRecord`, whose eager whole-record
		// probe read a key the shape drops, so `explain` published the empty report
		// — its documented "parse will succeed" signal — while `parse` threw.
		const contract = createContract(objectShape({}))
		const value = {
			get a(): unknown {
				throw new Error('unreadable extra')
			},
		}

		expect(contract.is(value)).toBe(false)
		expect(contract.audit(value)).toEqual([{ reason: 'extra', path: ['a'] }])
		expect(contract.explain(value)).toEqual([])
		expect(contract.parse(value)).toEqual({})
	})

	it('gives one jsonShape verdict for one document, at every call position and depth', () => {
		// `matchesJSONValue` was the only recursive walk left in the package, so the
		// REMAINING CALL STACK decided the answer: the same readable 3,737-deep
		// document answered true at a root call site and false as a nested field,
		// and past ~4k `parse` republished the resulting RangeError as
		// `parseJSONValue: value could not be read` for a value every read of which
		// succeeded.
		let payload: unknown = 1
		for (let index = 0; index < 5_000; index += 1) payload = { a: payload }

		const flat = createContract(jsonShape())
		expect(flat.is(payload)).toBe(true)
		expect(flat.audit(payload)).toEqual([])
		expect(flat.explain(payload)).toEqual([])
		expect(flat.parse(payload)).toBe(payload)

		let nested: ContractShape = jsonShape()
		let wrapped: unknown = payload
		for (let index = 0; index < 400; index += 1) {
			nested = objectShape({ a: nested })
			wrapped = { a: wrapped }
		}
		const deep = createContract(nested)
		expect(deep.is(wrapped)).toBe(true)
		expect(deep.audit(wrapped)).toEqual([])
		expect(deep.explain(wrapped)).toEqual([])
		expect(deep.parse(wrapped)).not.toBeUndefined()

		// Control: an honestly invalid deep document is still refused as invalid,
		// not as unreadable, at both call positions.
		let invalid: unknown = Number.NaN
		for (let index = 0; index < 5_000; index += 1) invalid = { a: invalid }
		expect(flat.is(invalid)).toBe(false)
		expect(flat.parse(invalid)).toBeUndefined()
		expect(flat.explain(invalid)).toEqual([
			{ reason: 'type', path: [], expected: 'json', received: 'object' },
		])
	})
})

describe('four-door agreement — the whole matrix (H9)', () => {
	// The instrument that settled the tier-1 findings, adopted as a gate. It sweeps
	// every shape category against every sample and asks the only question that
	// matters for soundness: may any door CERTIFY a value another door refuses?
	const shapes: ReadonlyArray<readonly [string, ContractShape]> = [
		...leafShapeVariations(),
		['composite', compositeShape(2)],
		['object:closed', objectShape({ a: stringShape() })],
		['object:open', objectShape({ a: stringShape() }, { additionalProperties: true })],
		['object:tail', objectShape({ a: stringShape() }, { additionalProperties: integerShape() })],
		['object:empty', objectShape({})],
		['record', recordShape(integerShape())],
		['array', arrayShape(stringShape())],
		['union', unionShape(stringShape(), integerShape())],
		['oneOf', oneOfShape(stringShape(), booleanShape())],
		['nullable', nullableShape(stringShape())],
		['raw', rawShape({ type: 'string' })],
		['json', jsonShape()],
	]

	function hostileValues(): readonly unknown[] {
		const declaredThrows: Record<string, unknown> = {}
		Object.defineProperty(declaredThrows, 'a', {
			enumerable: true,
			get() {
				throw new Error('declared key')
			},
		})
		const extraThrows: Record<string, unknown> = { a: 'x' }
		Object.defineProperty(extraThrows, 'b', {
			enumerable: true,
			get() {
				throw new Error('undeclared key')
			},
		})
		const cyclic: Record<string, unknown> = { a: 'x' }
		cyclic.self = cyclic
		let deep: unknown = 1
		for (let index = 0; index < 3_000; index += 1) deep = { a: deep }
		return [declaredThrows, extraThrows, cyclic, buildSparseArray(), createRevokedProxy(), deep]
	}

	function agreementViolations(
		shape: ContractShape,
		foreign: Guard<unknown> | undefined,
	): readonly string[] {
		const guard = foreign ?? compileGuard(shape)
		const parse = compileParser(shape)
		const violations: string[] = []
		const values = [...SOUNDNESS_SAMPLE, ...hostileValues()]
		for (let index = 0; index < values.length; index += 1) {
			const value = values[index]
			const guarded = attempt(() => guard(value))
			const audited = attempt(() => compileAuditor(shape, value))
			const explained = attempt(() => compileReporter(shape, value))
			const parsed = attempt(() => parse(value))
			if (!guarded.success) {
				violations[violations.length] = `guard threw @${String(index)}`
				continue
			}
			const byGuard = guarded.value === true
			const byAudit = audited.success && audited.value.length === 0
			const byReport = explained.success && explained.value.length === 0
			// The soundness question: a certification is a promise that `parse`
			// succeeds, so no certifying door may sit beside a refusing parser.
			if ((byGuard || byAudit || byReport) && !parsed.success) {
				violations[violations.length] = `certified but refused @${String(index)}`
			}
			if (audited.success && byAudit !== byGuard) {
				violations[violations.length] = `L1 @${String(index)}`
			}
			if (explained.success && parsed.success && byReport !== (parsed.value !== undefined)) {
				violations[violations.length] = `L2 @${String(index)}`
			}
			if (parsed.success && parsed.value !== undefined && !guard(parsed.value)) {
				violations[violations.length] = `L3 @${String(index)}`
			}
			if (byGuard && parsed.success && parsed.value === undefined) {
				violations[violations.length] = `L4 @${String(index)}`
			}
			if (byAudit && explained.success && !byReport) {
				violations[violations.length] = `L5 @${String(index)}`
			}
		}
		return violations
	}

	it('lets no door certify a value another door refuses, across every shape category', () => {
		const violations: string[] = []
		for (const [label, shape] of shapes) {
			for (const entry of agreementViolations(shape, undefined)) {
				violations[violations.length] = `${label}: ${entry}`
			}
		}
		expect(violations).toEqual([])
	})

	it('reports violations when the doors genuinely disagree (negative control)', () => {
		// The control this checker is worthless without: pairing one shape's report
		// with another shape's guard must produce findings under the same run, or an
		// empty verdict above would mean only that nothing was compared.
		expect(
			agreementViolations(objectShape({ a: stringShape() }), compileGuard(integerShape())),
		).not.toEqual([])
	})

	it('reports violations for a certifying door this package never compiled (outside-the-rule control)', () => {
		// The control above is drawn from INSIDE the checker's membership rule —
		// "an artifact this package compiled from some valid declaration" — so it
		// proves only that the checker discriminates among compiled artifacts. It
		// says nothing about a certifying door the rule does not describe. This one
		// is drawn from outside it: a hand-written total guard that certifies
		// everything and was never compiled from a declaration at all. The checker
		// must still find it, or its clean verdict above would mean only that
		// compiled artifacts agree with compiled artifacts.
		//
		// The assertion names the violation CLASS rather than asking for any
		// finding. `not.toEqual([])` alone did not bind this claim: a door
		// certifying NOTHING also produces findings here, because any foreign guard
		// disagrees with the compiled auditor somewhere, so the empty-check passed
		// in both directions and measured disagreement rather than certification.
		const certifyEverything: Guard<unknown> = (_value: unknown): _value is unknown => true
		const certified = agreementViolations(objectShape({ a: stringShape() }), certifyEverything)

		expect(certified.some((entry) => entry.startsWith('certified but refused'))).toBe(true)

		// The control on the control, from the opposite edge of the same outside
		// population: a hand-written total guard that certifies nothing is equally
		// uncompiled and equally in disagreement, and must produce no FALSE
		// CERTIFICATION at all. That is what makes the assertion above about
		// certification rather than about being foreign.
		const certifyNothing: Guard<unknown> = (_value: unknown): _value is unknown => false
		const refusing = agreementViolations(objectShape({ a: stringShape() }), certifyNothing)

		expect(refusing).not.toEqual([])
		expect(refusing.some((entry) => entry.startsWith('certified but refused'))).toBe(false)
	})
})

describe('R3 — the canonical door matrix', () => {
	// R3 rebuilds the compiler/contract closure proof as public BEHAVIOR after the
	// AST/body pin strategy was retired: a door is bound here when a change to its
	// documented answer fails a test, never because the call returned without
	// throwing. What follows is what the matrix was missing after R6 — the rest of
	// the matrix is bound by the suites above and is not restated here.
	const MATRIX_SHAPE = objectShape({
		id: stringShape({ min: 1, max: 4 }),
		age: integerShape({ min: 0, max: 9 }),
		bio: optionalShape(stringShape()),
	})

	it('answers every one of the seven getters on a compiler asked for nothing else', () => {
		// Requested-family-only laziness has no caller-observable effect — R6-B
		// established that and both blind lenses failed to break it — so what CAN be
		// bound is the half that is observable: each of the seven roots is complete
		// on its own, on a compiler that was never asked for a sibling, and each is
		// the exact artifact the door of that name publishes.
		const shape = MATRIX_SHAPE
		const accepted = { id: 'ada', age: 3 }
		const coercible = { id: 'ada', age: '3', extra: true }

		expect(new ContractCompiler(shape).schema).toEqual({
			type: 'object',
			properties: {
				id: { type: 'string', minLength: 1, maxLength: 4 },
				age: { type: 'integer', minimum: 0, maximum: 9 },
				bio: { type: 'string' },
			},
			required: ['id', 'age'],
			additionalProperties: false,
		})
		expect(new ContractCompiler(shape).guard(accepted)).toBe(true)
		expect(new ContractCompiler(shape).guard(coercible)).toBe(false)
		expect(new ContractCompiler(shape).parser(coercible)).toEqual(accepted)
		expect(new ContractCompiler(shape).auditor(coercible)).toEqual([
			{ reason: 'type', path: ['age'], expected: 'integer', received: '"3"' },
			{ reason: 'extra', path: ['extra'] },
		])
		expect(new ContractCompiler(shape).reporter(coercible)).toEqual([])
		expect(new ContractCompiler(shape).generator(seededRandom(5))).toEqual(
			compileGenerator(shape, seededRandom(5)),
		)
		expect(new ContractCompiler(shape).contract.schema).toEqual(new ContractCompiler(shape).schema)

		// Each standalone door is the same artifact reached by its own name.
		expect(compileSchema(shape)).toEqual(new ContractCompiler(shape).schema)
		expect(compileGuard(shape)(accepted)).toBe(true)
		expect(compileParser(shape)(coercible)).toEqual(accepted)
		expect(compileAuditor(shape, coercible)).toEqual(new ContractCompiler(shape).auditor(coercible))
		expect(compileReporter(shape, coercible)).toEqual([])
		const contract = createContract(shape)
		expect(contract.schema).toEqual(compileSchema(shape))
		expect(contract.is(accepted)).toBe(true)
		expect(contract.parse(coercible)).toEqual(accepted)
		expect(contract.audit(coercible)).toEqual(compileAuditor(shape, coercible))
		expect(contract.explain(coercible)).toEqual([])
		expect(contract.generate(seededRandom(5))).toEqual(compileGenerator(shape, seededRandom(5)))
	})

	it('observes the declaration exactly once per compiler however many families are requested', () => {
		// The deterministic half of the laziness claim. Family construction reads the
		// OWNED graph, so a family that re-owned or re-gated the caller's declaration
		// would show up here as extra reads of the one field a walk is allowed to
		// observe through an accessor. Reading all seven roots must cost exactly what
		// reading one costs.
		const single = new ObservedShape()
		const every = new ObservedShape()
		const separate = new ObservedShape()

		expect(new ContractCompiler(single.shape).schema).toBeDefined()

		const compiler = new ContractCompiler(every.shape)
		const roots: readonly unknown[] = [
			compiler.schema,
			compiler.guard,
			compiler.parser,
			compiler.auditor,
			compiler.reporter,
			compiler.generator,
			compiler.contract,
		]

		expect(new ContractCompiler(separate.shape).schema).toBeDefined()
		expect(new ContractCompiler(separate.shape).contract).toBeDefined()

		expect(roots).toHaveLength(7)
		expect(single.reads).toBeGreaterThan(0)
		expect(every.reads).toBe(single.reads)
		// Control: the counter does move. Two compilers over one declaration own it
		// twice, so an equal count above is a statement about families rather than
		// about an instrument that cannot count.
		expect(separate.reads).toBe(single.reads * 2)
	})

	it('refuses a declaration that is not a record at all, at every door', () => {
		// The outside-the-rule control for every malformed-declaration instrument in
		// this file. Their membership rule is "a record-branded declaration node with
		// a corrupt field", and a control drawn from inside it — another corrupt
		// field — can only show that the doors discriminate among corrupt records.
		// These roots sit outside that rule entirely: they are not records, so no
		// field of theirs is what makes them illegal. Each must still arrive as a
		// coded ContractError rather than a raw host error or an acceptance.
		const roots: readonly ContractShape[] = [
			JSON.parse('42'),
			JSON.parse('"string"'),
			JSON.parse('null'),
			JSON.parse('true'),
			JSON.parse('[]'),
			JSON.parse('[{"type":"string"}]'),
		]

		const messages: string[] = []
		for (const root of roots) {
			const errors = [
				captureContractError(() => validateShapeDepth(root)),
				captureContractError(() => compileSchema(root)),
				captureContractError(() => compileGuard(root)),
				captureContractError(() => compileParser(root)),
				captureContractError(() => compileGenerator(root, () => 0)),
				captureContractError(() => compileReporter(root, undefined)),
				captureContractError(() => compileAuditor(root, undefined)),
				captureContractError(() => createContract(root)),
			]

			for (const error of errors) {
				expect(isContractError(error)).toBe(true)
				expect(error.code).toBe('structure')
				expect(error.context?.path).toEqual([])
				expect(error).not.toBeInstanceOf(TypeError)
			}
			// One root, one diagnosis: the eight doors must agree on the message as
			// well as the code, so a door that refused for a different reason than
			// its siblings shows up here rather than passing as "it threw".
			messages[messages.length] = errors[0]?.message ?? 'missing'
			for (const error of errors) expect(error.message).toBe(messages[messages.length - 1])
		}

		expect(messages).toEqual([
			'validateShapeDepth: every structural child must be a shape',
			'validateShapeDepth: every structural child must be a shape',
			'validateShapeDepth: every structural child must be a shape',
			'validateShapeDepth: every structural child must be a shape',
			'validateShapeDepth: every structural child must be a shape',
			'validateShapeDepth: every structural child must be a shape',
		])
	})

	it('rebuilds an object parse on a null prototype and an array parse as a fresh array', () => {
		// The guide states this as an observable difference between `is` and `parse`:
		// `contract.parse(v) !== v` holds even for a value `is` already accepted, and
		// the rebuilt record carries a null prototype so a key literally named
		// `__proto__` lands as own data rather than mutating a prototype.
		const contract = createContract(objectShape({ age: integerShape() }))
		const input = { age: 36 }

		expect(contract.is(input)).toBe(true)
		const parsed = contract.parse(input)
		if (parsed === undefined) throw new Error('expected the guard-valid input to parse')
		expect(parsed).not.toBe(input)
		expect(parsed).toEqual(input)
		expect(Object.getPrototypeOf(parsed)).toBeNull()
		expect(Object.isFrozen(parsed)).toBe(false)
		expect(contract.is(parsed)).toBe(true)

		// An array shape likewise rebuilds, into an ordinary array.
		const list = createContract(arrayShape(integerShape()))
		const source: readonly number[] = Object.freeze([1, 2])
		const copied = list.parse(source)
		if (copied === undefined) throw new Error('expected the guard-valid list to parse')
		expect(copied).not.toBe(source)
		expect(copied).toEqual([1, 2])
		expect(Object.getPrototypeOf(copied)).toBe(Array.prototype)

		// A leaf returns its input by identity — the rebuild belongs to the object
		// and array branches, not to every parse.
		const leaf = createContract(stringShape())
		const text = 'ada'
		expect(leaf.parse(text)).toBe(text)
	})

	it('re-emits an embedded raw schema without making it a runtime rule', () => {
		// The exact limit the package documents rather than hides: `rawShape` embeds
		// an arbitrary JSON Schema fragment and no bundled evaluator applies it. The
		// fragment reaches `schema` verbatim while every runtime door accepts any
		// DEFINED value, `undefined` alone failing as the parser's sentinel.
		const shape = rawShape({ type: 'string', minLength: 4 })
		const contract = createContract(shape)

		expect(contract.schema).toEqual({ type: 'string', minLength: 4 })
		expect(contract.is(42)).toBe(true)
		expect(contract.audit(42)).toEqual([])
		expect(contract.explain(42)).toEqual([])
		expect(contract.parse(42)).toBe(42)
		expect(contract.is(undefined)).toBe(false)
		expect(contract.audit(undefined)).not.toEqual([])
		expect(contract.parse(undefined)).toBeUndefined()
		// And it cannot be generated from, because there is nothing to read it with.
		expect(captureContractError(() => contract.generate(seededRandom(1))).code).toBe('generate')

		// Control: `jsonShape` is the other end of the same limit — one empty emitted
		// document, but a guard that really is a runtime rule.
		const json = createContract(jsonShape())
		expect(json.schema).toEqual({})
		expect(json.is(42)).toBe(true)
		expect(json.is(Number.NaN)).toBe(false)
	})

	it('governs all six contract members from the one population ownership captured', () => {
		// Row 8 in its strongest form. The property entry answers a DIFFERENT child
		// from its third read onward, so any member compiled from a later reading
		// would disagree with the members compiled from the captured one. The whole
		// bundle is asked here, not just schema/is/parse: one ownership population
		// governs the whole contract or none of it does.
		const captured = integerShape({ min: 0, max: 9 })
		const later = stringShape({ min: 8 })
		let reads = 0
		const properties = new Proxy(
			{ value: captured },
			{
				get(target, property, receiver) {
					if (property !== 'value') return Reflect.get(target, property, receiver)
					reads += 1
					return reads <= 2 ? captured : later
				},
			},
		)

		const contract = createContract({ type: 'object', properties })
		const generated = contract.generate(seededRandom(3))

		expect(reads).toBe(2)
		expect(contract.schema).toEqual({
			type: 'object',
			properties: { value: { type: 'integer', minimum: 0, maximum: 9 } },
			required: ['value'],
			additionalProperties: false,
		})
		expect(contract.is({ value: 3 })).toBe(true)
		expect(contract.is({ value: 'aaaaaaaa' })).toBe(false)
		expect(contract.audit({ value: 'aaaaaaaa' })).toEqual([
			{ reason: 'type', path: ['value'], expected: 'integer', received: '"aaaaaaaa"' },
		])
		expect(contract.explain({ value: 'aaaaaaaa' })).toEqual([
			{ reason: 'type', path: ['value'], expected: 'integer', received: '"aaaaaaaa"' },
		])
		expect(contract.parse({ value: 'aaaaaaaa' })).toBeUndefined()
		expect(isRecord(generated) && typeof generated.value).toBe('number')
		expect(contract.is(generated)).toBe(true)
		expect(reads).toBe(2)
	})
})
