import type {
	ContractShape,
	JSONSchema,
	LiteralValue,
	Result,
	ShapeValidatorInterface,
} from '@src/core'
import {
	attempt,
	COMPILE_DEPTH_LIMIT,
	optionalShape,
	stringShape,
	ContractError,
	createContract,
	isContractError,
	rawShape,
	seededRandom,
	ShapeValidator,
	validateShape,
} from '@src/core'
import type { TerminalIntrinsic } from '../../setup.js'
import {
	buildSharedDagShape,
	buildStaircaseShape,
	captureContractError,
	createNativeMaximumSparseArray,
	createShapeValidationCase,
	createUndefinedSchema,
	denyRecognition,
	NullBaseDeclaration,
	pollutePrototype,
	ObservedShape,
	redirectIntrinsic,
	replaceIntrinsic,
	StringDeclaration,
	TERMINAL_CONSTRUCTORS,
} from '../../setup.js'
import { describe, expect, it } from 'vitest'

describe('ShapeValidator', () => {
	it('exposes only the accepted interface and prototype behavior', () => {
		const validator: ShapeValidatorInterface = new ShapeValidator({ category: 'string' })

		expect(Object.getOwnPropertyNames(ShapeValidator.prototype).sort()).toEqual([
			'constructor',
			'expansion',
			'validate',
		])
		expect(validator.expansion).toBeUndefined()
		validator.validate()
		expect(validator.expansion).toBe(1)
	})

	it('refuses a class instance at every depth whether or not its prototype is reparented', () => {
		for (const declaration of [new StringDeclaration(), new NullBaseDeclaration()]) {
			const root = captureContractError(() => new ShapeValidator(declaration).validate())
			expect(root.message).toBe('validateShape: every structural child must be a shape')
			expect(root.code).toBe('structure')
			expect(root.context?.path).toEqual([])
			expect(Object.hasOwn(root, 'cause')).toBe(false)

			const child = captureContractError(() =>
				new ShapeValidator({ category: 'array', items: declaration }).validate(),
			)
			expect(child.message).toBe('validateShape: every structural child must be a shape')
			expect(child.code).toBe('structure')
			expect(child.context?.path).toEqual(['items'])
		}
	})

	it('performs zero observation during construction', () => {
		let observations = 0
		const source = new Proxy({ category: 'string' } satisfies ContractShape, {
			get(target, property, receiver) {
				observations += 1
				return Reflect.get(target, property, receiver)
			},
			getOwnPropertyDescriptor(target, property) {
				observations += 1
				return Reflect.getOwnPropertyDescriptor(target, property)
			},
			has(target, property) {
				observations += 1
				return Reflect.has(target, property)
			},
			ownKeys(target) {
				observations += 1
				return Reflect.ownKeys(target)
			},
		})

		const validator = new ShapeValidator(source)

		expect(validator).toBeInstanceOf(ShapeValidator)
		expect(observations).toBe(0)
	})

	it('rechecks one mutable source independently after failure and repair', () => {
		const source: ContractShape = { category: 'string', min: 1 }
		const validator = new ShapeValidator(source)

		validator.validate()
		Reflect.set(source, 'min', -1)
		expect(captureContractError(() => validator.validate()).code).toBe('bound')
		Reflect.set(source, 'min', 1)
		validator.validate()
	})

	it('shares one caught reentrancy poison with every nested and outer call, then recovers', () => {
		const source: ContractShape = { category: 'string' }
		const nested: unknown[] = []
		let reenter = true
		const validator = new ShapeValidator(source)
		Object.defineProperty(source, 'pattern', {
			enumerable: true,
			configurable: true,
			get() {
				if (reenter) {
					const outcome = attempt(() => validator.validate())
					if (!outcome.success) nested.push(outcome.error)
				}
				return Object.freeze(/x/)
			},
		})
		const outer = attempt(() => validator.validate())

		expect(outer.success).toBe(false)
		if (outer.success) return
		expect(nested.length).toBeGreaterThan(1)
		for (const error of nested) expect(error).toBe(outer.error)
		expect(isContractError(outer.error)).toBe(true)
		if (!isContractError(outer.error)) return
		expect(outer.error.message).toBe(
			'ShapeValidator.validate: shape validation may not be reentered',
		)
		expect(outer.error.code).toBe('structure')
		expect(outer.error.context).toEqual({ path: [] })
		expect(Object.hasOwn(outer.error, 'cause')).toBe(false)

		reenter = false
		validator.validate()
	})

	it('preserves an uncaught nested poison by exact identity', () => {
		const source: ContractShape = { category: 'string' }
		let nested: unknown
		const validator = new ShapeValidator(source)
		Object.defineProperty(source, 'pattern', {
			enumerable: true,
			configurable: true,
			get() {
				const outcome = attempt(() => validator.validate())
				if (!outcome.success) {
					nested = outcome.error
					throw outcome.error
				}
				return Object.freeze(/x/)
			},
		})
		const outer = attempt(() => validator.validate())

		expect(outer.success).toBe(false)
		expect(outer.success ? undefined : outer.error).toBe(nested)
	})

	it('keeps the eager wrapper fresh and error-identical to the class', () => {
		const source: ContractShape = { category: 'string', min: -1 }
		const classError = captureContractError(() => new ShapeValidator(source).validate())
		const wrapperError = captureContractError(() => validateShape(source))

		expect(wrapperError.message).toBe(classError.message)
		expect(wrapperError.code).toBe(classError.code)
		expect(wrapperError.context).toEqual(classError.context)
		expect(Object.hasOwn(wrapperError, 'cause')).toBe(Object.hasOwn(classError, 'cause'))

		Reflect.set(source, 'min', 1)
		validateShape(source)
	})

	it('retains the recognized-node fallback across hostile node observation', () => {
		const descriptor = new Proxy({ category: 'string' } satisfies ContractShape, {
			getOwnPropertyDescriptor(target, property) {
				if (property === 'category') throw new Error('category descriptor')
				return Reflect.getOwnPropertyDescriptor(target, property)
			},
		})
		let reads = 0
		const field = new Proxy({ category: 'string', min: 1 } satisfies ContractShape, {
			get(target, property, receiver) {
				if (property !== 'min') return Reflect.get(target, property, receiver)
				reads += 1
				if (reads > 2) throw new Error('post-scan field read')
				return 1
			},
		})

		for (const source of [descriptor, field]) {
			reads = 0
			const direct = captureContractError(() => new ShapeValidator(source).validate())
			reads = 0
			const depth = captureContractError(() => validateShape(source))

			for (const error of [direct, depth]) {
				expect(error.message).toBe('validateShape: every node must be a recognized shape')
				expect(error.code).toBe('structure')
				expect(error.context).toEqual({ path: [] })
				expect(Object.hasOwn(error, 'cause')).toBe(false)
			}
		}

		// `createContract` meets these two sources through OWNERSHIP, and the two
		// answers differ for a reason worth stating. A refusal to reveal the `category`
		// descriptor stops the capture, so the contract refuses in ownership's own
		// vocabulary. A field that lies from its THIRD read is never asked a third
		// time, because one population needs two agreeing reads and no more — so
		// the contract compiles the population it captured, and the phase this
		// source kept in reserve is unreachable rather than merely unused.
		reads = 0
		const refused = captureContractError(() => createContract(descriptor))

		expect(refused.message).toBe('cloneShape: failed to create an owned shape snapshot')
		expect(refused.code).toBe('clone')
		expect(refused.context).toEqual({ shape: 'shape' })

		reads = 0
		const compiled = createContract(field)

		expect(reads).toBe(2)
		expect(compiled.schema).toEqual({ type: 'string', minLength: 1 })
		expect(compiled.is('x')).toBe(true)
		expect(compiled.is('')).toBe(false)
	})

	it('does not retain a stale fallback after a valid raw pattern', () => {
		const schema: JSONSchema = { pattern: 'valid' }
		Object.defineProperty(schema, 'minLength', {
			enumerable: true,
			configurable: true,
			get() {
				throw new Error('later raw read')
			},
		})

		const error = captureContractError(() =>
			new ShapeValidator({ category: 'raw', schema }).validate(),
		)

		expect(error.message).toBe('validateShape: every node must be a recognized shape')
		expect(error.code).toBe('structure')
		expect(error.context).toEqual({ path: ['schema'] })
		expect(Object.hasOwn(error, 'cause')).toBe(false)
	})

	it('does not retain a stale fallback across shape nodes', () => {
		const sibling = new Proxy({ category: 'string' } satisfies ContractShape, {
			getOwnPropertyDescriptor(target, property) {
				if (property === 'category') throw new Error('later sibling descriptor')
				return Reflect.getOwnPropertyDescriptor(target, property)
			},
		})
		const source: ContractShape = {
			category: 'object',
			properties: {
				pattern: { category: 'raw', schema: { pattern: 'valid' } },
				sibling,
			},
		}

		const error = captureContractError(() => new ShapeValidator(source).validate())

		expect(error.message).toBe('validateShape: every node must be a recognized shape')
		expect(error.code).toBe('structure')
		expect(error.context).toEqual({ path: ['properties', 'sibling'] })
		expect(Object.hasOwn(error, 'cause')).toBe(false)
	})

	it('translates thrown validation regions to their exact structure paths', () => {
		let propertiesReads = 0
		const object = new Proxy({ category: 'object', properties: {} } satisfies ContractShape, {
			get(target, property, receiver) {
				if (property !== 'properties') return Reflect.get(target, property, receiver)
				propertiesReads += 1
				if (propertiesReads > 2) throw new Error('properties read')
				return target.properties
			},
		})
		let variantsReads = 0
		const union = new Proxy(
			{ category: 'union', variants: [{ category: 'string' }] } satisfies ContractShape,
			{
				get(target, property, receiver) {
					if (property !== 'variants') return Reflect.get(target, property, receiver)
					variantsReads += 1
					if (variantsReads > 2) throw new Error('variants read')
					return target.variants
				},
			},
		)
		let valuesReads = 0
		const literal = new Proxy({ category: 'literal', values: ['value'] } satisfies ContractShape, {
			get(target, property, receiver) {
				if (property !== 'values') return Reflect.get(target, property, receiver)
				valuesReads += 1
				if (valuesReads > 2) throw new Error('values read')
				return target.values
			},
		})
		const schema = new Proxy<JSONSchema>(
			{},
			{
				ownKeys() {
					throw new Error('raw keys')
				},
			},
		)
		const entries: ReadonlyArray<readonly [ContractShape, readonly string[]]> = [
			[object, ['properties']],
			[union, ['variants']],
			[literal, ['values']],
			[{ category: 'raw', schema }, ['schema']],
		]

		for (const [source, path] of entries) {
			const error = captureContractError(() => new ShapeValidator(source).validate())
			expect(error.message).toBe('validateShape: every node must be a recognized shape')
			expect(error.code).toBe('structure')
			expect(error.context).toEqual({ path })
			expect(Object.hasOwn(error, 'cause')).toBe(false)
		}

		const pattern = captureContractError(() =>
			new ShapeValidator({ category: 'raw', schema: { pattern: '[' } }).validate(),
		)
		expect(pattern.message).toBe('validateShape: raw schema pattern must be valid')
		expect(pattern.code).toBe('structure')
		expect(pattern.context).toEqual({ path: ['schema'] })
		expect(Object.hasOwn(pattern, 'cause')).toBe(false)
	})

	it('refuses impossible raw populations before indexed work', () => {
		for (const entry of [
			{
				keyword: 'enum',
				message: 'validateShape: raw schema enum must be a non-empty array',
			},
			{
				keyword: 'required',
				message: 'validateShape: raw schema required must be an array',
			},
			{
				keyword: 'anyOf',
				message: 'validateShape: raw schema unions must be non-empty arrays',
			},
			{
				keyword: 'oneOf',
				message: 'validateShape: raw schema unions must be non-empty arrays',
			},
		]) {
			let reads = 0
			const population = new Proxy<unknown[]>([], {
				get(target, property, receiver) {
					if (property === 'length') return 2 ** 32
					return Reflect.get(target, property, receiver)
				},
				getOwnPropertyDescriptor(target, property) {
					if (property === '0') {
						reads += 1
						throw new Error('index descriptor must not be read')
					}
					return Reflect.getOwnPropertyDescriptor(target, property)
				},
			})
			const schema: JSONSchema = {}
			Reflect.set(schema, entry.keyword, population)

			const error = captureContractError(() =>
				new ShapeValidator({ category: 'raw', schema }).validate(),
			)

			expect(error.message).toBe(entry.message)
			expect(error.code).toBe('structure')
			expect(error.context?.path).toEqual(['schema'])
			expect(reads).toBe(0)
		}

		new ShapeValidator({ category: 'raw', schema: { enum: ['value'] } }).validate()
		new ShapeValidator({ category: 'raw', schema: { required: ['value'] } }).validate()
		new ShapeValidator({ category: 'raw', schema: { anyOf: [{}] } }).validate()
		new ShapeValidator({ category: 'raw', schema: { oneOf: [{}] } }).validate()
	})

	it('refuses native-maximum direct union and literal populations at their container paths', () => {
		const directUnion = createNativeMaximumSparseArray<ContractShape>()
		const directUnionError = captureContractError(() =>
			new ShapeValidator({ category: 'union', variants: directUnion.value }).validate(),
		)
		expect(directUnionError.code).toBe('structure')
		expect(directUnionError.message).toBe('validateShape: variants must be a dense data array')
		expect(directUnionError.context?.path).toEqual(['variants'])
		expect(Object.hasOwn(directUnionError, 'cause')).toBe(false)
		expect(directUnion.probes).toEqual([])

		const eagerUnion = createNativeMaximumSparseArray<ContractShape>()
		const eagerUnionError = captureContractError(() =>
			validateShape({ category: 'union', variants: eagerUnion.value }),
		)
		expect(eagerUnionError.message).toBe('validateShape: variants must be a dense data array')
		expect(eagerUnionError.context?.path).toEqual(['variants'])
		expect(Object.hasOwn(eagerUnionError, 'cause')).toBe(false)
		expect(eagerUnion.probes).toEqual([])

		const directLiteral = createNativeMaximumSparseArray<LiteralValue>()
		const directLiteralError = captureContractError(() =>
			new ShapeValidator({ category: 'literal', values: directLiteral.value }).validate(),
		)
		expect(directLiteralError.code).toBe('structure')
		expect(directLiteralError.message).toBe('validateShape: values must be a dense data array')
		expect(directLiteralError.context?.path).toEqual(['values'])
		expect(Object.hasOwn(directLiteralError, 'cause')).toBe(false)
		expect(directLiteral.probes).toEqual([])

		const eagerLiteral = createNativeMaximumSparseArray<LiteralValue>()
		const eagerLiteralError = captureContractError(() =>
			validateShape({ category: 'literal', values: eagerLiteral.value }),
		)
		expect(eagerLiteralError.message).toBe('validateShape: values must be a dense data array')
		expect(eagerLiteralError.context?.path).toEqual(['values'])
		expect(Object.hasOwn(eagerLiteralError, 'cause')).toBe(false)
		expect(eagerLiteral.probes).toEqual([])
	})

	it('bounds native-maximum raw array populations with their existing density rules', () => {
		for (const entry of [
			{ keyword: 'enum', message: 'validateShape: raw schema enum must be dense' },
			{ keyword: 'required', message: 'validateShape: raw schema required must be dense' },
			{ keyword: 'anyOf', message: 'validateShape: raw schema unions must be dense arrays' },
			{ keyword: 'oneOf', message: 'validateShape: raw schema unions must be dense arrays' },
		]) {
			const fixture = createNativeMaximumSparseArray<unknown>()
			const schema: JSONSchema = {}
			Reflect.set(schema, entry.keyword, fixture.value)
			const error = captureContractError(() =>
				new ShapeValidator({ category: 'raw', schema }).validate(),
			)

			expect(error.code).toBe('structure')
			expect(error.message).toBe(entry.message)
			expect(error.context?.path).toEqual(['schema'])
			expect(fixture.probes).toEqual([])
		}
	})

	it('allows shared DAG children while rejecting shape and raw-schema cycles in their old channels', () => {
		const shared: ContractShape = { category: 'string' }
		new ShapeValidator({
			category: 'object',
			properties: { first: shared, second: shared },
		}).validate()

		const shapeCycle: ContractShape = { category: 'array', items: shared }
		Reflect.set(shapeCycle, 'items', shapeCycle)
		const cycleError = captureContractError(() => new ShapeValidator(shapeCycle).validate())
		expect(cycleError.code).toBe('cycle')
		expect(cycleError.context?.path).toEqual(['items'])

		const schema: Record<string, unknown> = {}
		Reflect.set(schema, 'items', schema)
		const rawError = captureContractError(() =>
			new ShapeValidator({ category: 'raw', schema }).validate(),
		)
		expect(rawError.code).toBe('structure')
		expect(rawError.message).toBe('validateShape: a raw schema may not contain a cycle')
		expect(rawError.context?.path).toEqual(['schema'])
	})

	it.each([
		['domain-cycle-structure', ['domain', 'cycle', 'structure']],
		['structure-domain-cycle', ['structure', 'domain', 'cycle']],
	] satisfies ReadonlyArray<readonly [string, ReadonlyArray<'domain' | 'cycle' | 'structure'>]>)(
		'keeps structure before cycle before domain for %s insertion order',
		(_name, order) => {
			const source = createShapeValidationCase(order)
			const structure = captureContractError(() => new ShapeValidator(source).validate())
			expect(structure.code).toBe('structure')

			if (source.category !== 'object') return
			Reflect.deleteProperty(source.properties, 'structure')
			const cycle = captureContractError(() => new ShapeValidator(source).validate())
			expect(cycle.code).toBe('cycle')

			Reflect.deleteProperty(source.properties, 'cycle')
			const domain = captureContractError(() => new ShapeValidator(source).validate())
			expect(domain.code).toBe('bound')
		},
	)

	it('lets a later immediate depth failure outrank earlier deferred faults', () => {
		const source = createShapeValidationCase(['domain', 'cycle', 'structure'])
		if (source.category !== 'object') return
		let deep: ContractShape = { category: 'string' }
		for (let level = 0; level <= COMPILE_DEPTH_LIMIT; level += 1) {
			deep = { category: 'array', items: deep }
		}
		Reflect.set(source.properties, 'depth', deep)

		const error = captureContractError(() => new ShapeValidator(source).validate())

		expect(error.code).toBe('depth')
	})

	it('validates present raw population members even when their captured value is undefined', () => {
		const propertyMembers: Record<string, JSONSchema> = {}
		Reflect.set(propertyMembers, 'value', undefined)
		const anyOf: JSONSchema[] = []
		Reflect.set(anyOf, '0', undefined)
		const oneOf: JSONSchema[] = []
		Reflect.set(oneOf, '0', undefined)
		const nullProperties: Record<string, JSONSchema> = {}
		Reflect.set(nullProperties, 'value', null)
		const nullAnyOf: JSONSchema[] = []
		Reflect.set(nullAnyOf, '0', null)
		const nullOneOf: JSONSchema[] = []
		Reflect.set(nullOneOf, '0', null)

		for (const schema of [
			{ properties: propertyMembers },
			{ anyOf },
			{ oneOf },
			{ properties: nullProperties },
			{ anyOf: nullAnyOf },
			{ oneOf: nullOneOf },
		] satisfies readonly JSONSchema[]) {
			const shape = { category: 'raw', schema } satisfies ContractShape
			const errors = [
				captureContractError(() => new ShapeValidator(shape).validate()),
				captureContractError(() => validateShape(shape)),
			]
			for (const error of errors) {
				expect(error.message).toBe('validateShape: every raw schema child must be a plain record')
				expect(error.code).toBe('structure')
				expect(error.context).toEqual({ path: ['schema'] })
				expect(Object.hasOwn(error, 'cause')).toBe(false)
			}
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
			new ShapeValidator({ category: 'raw', schema }).validate()
			validateShape({ category: 'raw', schema })
		}

		for (const keyword of ['anyOf', 'oneOf']) {
			const sparse: JSONSchema[] = []
			sparse.length = 1
			const schema: JSONSchema = {}
			Reflect.set(schema, keyword, sparse)
			const error = captureContractError(() =>
				new ShapeValidator({ category: 'raw', schema }).validate(),
			)
			expect(error.message).toBe('validateShape: raw schema unions must be dense arrays')
			expect(error.code).toBe('structure')
			expect(error.context).toEqual({ path: ['schema'] })
		}
	})

	it('refuses flagged declarations while never observing an own pattern accessor', () => {
		// The pattern is genuinely flagged; its own `source` / `flags` accessors are
		// decoys the gate never consults, because both are read through the
		// accessors captured from `RegExp.prototype`. The zero tallies are the
		// proof — and `toString` stays unobserved as before, since the quoted text
		// is composed from the captured scalars.
		const pattern = /a/i
		let sourceReads = 0
		let flagsReads = 0
		let stringReads = 0
		Object.defineProperty(pattern, 'source', {
			get() {
				sourceReads += 1
				return 'a'
			},
		})
		Object.defineProperty(pattern, 'flags', {
			get() {
				flagsReads += 1
				return 'i'
			},
		})
		Object.defineProperty(pattern, 'toString', {
			get() {
				stringReads += 1
				throw new Error('pattern stringification must not be observed')
			},
		})

		const error = captureContractError(() =>
			new ShapeValidator({ category: 'string', pattern }).validate(),
		)

		expect(error.message).toBe(
			'validateShape: a string shape pattern must not use flags; use inline pattern constructs instead',
		)
		expect(error.code).toBe('pattern')
		expect(error.context).toEqual({ path: [], shape: 'string', received: '/a/i' })
		expect(error.context?.limit).toBeUndefined()
		expect(Object.hasOwn(error, 'cause')).toBe(false)
		expect(sourceReads).toBe(0)
		expect(flagsReads).toBe(0)
		expect(stringReads).toBe(0)

		const nested = captureContractError(() =>
			new ShapeValidator({
				category: 'object',
				properties: { value: { category: 'string', pattern: /a/i } },
			}).validate(),
		)
		expect(nested.context).toEqual({
			path: ['properties', 'value'],
			shape: 'string',
			received: '/a/i',
		})

		new ShapeValidator({ category: 'string', pattern: /a/ }).validate()
		new ShapeValidator({ category: 'string', pattern: /[aA]/ }).validate()
	})

	it('keeps bound, flag, range, and global validation tiers in declaration order', () => {
		const min = captureContractError(() =>
			new ShapeValidator({ category: 'string', min: -1, pattern: /a/i }).validate(),
		)
		expect(min.code).toBe('bound')
		expect(min.message).toContain('string shape min')

		const max = captureContractError(() =>
			new ShapeValidator({ category: 'string', max: -1, pattern: /a/i }).validate(),
		)
		expect(max.code).toBe('bound')
		expect(max.message).toContain('string shape max')

		const flags = captureContractError(() =>
			new ShapeValidator({ category: 'string', min: 2, max: 1, pattern: /a/i }).validate(),
		)
		expect(flags.code).toBe('pattern')
		expect(flags.message).toContain('must not use flags')

		const range = captureContractError(() =>
			new ShapeValidator({ category: 'string', min: 2, max: 1, pattern: /a/ }).validate(),
		)
		expect(range.code).toBe('range')

		const properties: Record<string, ContractShape> = {
			domain: { category: 'string', pattern: /a/i },
		}
		const cycle: ContractShape = { category: 'array', items: { category: 'string' } }
		Reflect.set(cycle, 'items', cycle)
		Reflect.set(properties, 'cycle', cycle)
		Reflect.set(properties, 'structure', null)
		const source = { category: 'object', properties } satisfies ContractShape

		expect(captureContractError(() => new ShapeValidator(source).validate()).code).toBe('structure')
		Reflect.deleteProperty(properties, 'structure')
		expect(captureContractError(() => new ShapeValidator(source).validate()).code).toBe('cycle')
		Reflect.deleteProperty(properties, 'cycle')
		expect(captureContractError(() => new ShapeValidator(source).validate()).code).toBe('pattern')

		let deep: ContractShape = { category: 'string' }
		for (let level = 0; level <= COMPILE_DEPTH_LIMIT; level += 1) {
			deep = { category: 'array', items: deep }
		}
		Reflect.set(properties, 'depth', deep)
		expect(captureContractError(() => new ShapeValidator(source).validate()).code).toBe('depth')
	})

	it('exposes a ContractError at every validator door while each dispatch on its path is redirected', () => {
		// `validate` contains its whole traversal, but a contained failure it did
		// not author was rethrown verbatim, so the caller's raw value left a door
		// whose documented contract is a ContractError. The corpus covers both
		// reaches: a replaced member the intrinsic owns, and a polluted name it
		// does not, which an unqualified diagnostic read consults.
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
			// The symbol-keyed row the corpus could not previously express: the
			// containment below asks whether this package authored a contained
			// failure, and that question used to run through a caller-writable hook.
			{
				label: 'ContractError[Symbol.hasInstance]',
				target: ContractError,
				key: Symbol.hasInstance,
				via: 'pollution',
			},
		]
		// Both populations matter: a declaration that validates never constructs a
		// diagnostic, so only a REFUSED declaration reaches the reads a polluted
		// prototype answers.
		const valid: ContractShape = {
			category: 'object',
			properties: { name: { category: 'string', min: 1 } },
		}
		const malformed: ContractShape = { category: 'object', properties: {} }
		Reflect.set(malformed.category === 'object' ? malformed.properties : {}, 'name', null)
		const doors: ReadonlyArray<{
			readonly name: string
			readonly open: (shape: ContractShape) => void
		}> = [
			{ name: 'ShapeValidator.validate', open: (shape) => new ShapeValidator(shape).validate() },
			{ name: 'validateShape', open: (shape) => validateShape(shape) },
		]
		const escaped: string[] = []
		// A row that never armed is reported rather than skipped: the escape check
		// below sees a non-`ContractError` and names the row, so an instrument that
		// silently failed to install cannot be read as a clean sweep.
		const unarmed: Result<unknown> = { success: false, error: 'not armed' }

		for (const intrinsic of intrinsics) {
			const sentinel = Object.freeze({ stage: intrinsic.label })
			for (const door of doors) {
				for (const subject of [
					{ name: 'valid', shape: valid },
					{ name: 'malformed', shape: malformed },
				]) {
					const outcome = redirectIntrinsic(intrinsic, sentinel, (armed) =>
						armed ? attempt(() => door.open(subject.shape)) : unarmed,
					)
					if (outcome.success) continue
					if (!isContractError(outcome.error)) {
						escaped.push(`${intrinsic.label} at ${door.name} (${subject.name})`)
					}
				}
			}
		}

		expect(escaped).toEqual([])
	})

	it('keeps its authored diagnostic while the caller poisons ContractError recognition', () => {
		// The traversal is contained, and the containment asks ONE question about
		// the contained failure: did this package author it? Answering that with
		// `instanceof` routes the question through `Symbol.hasInstance`, a
		// caller-writable hook — so a caller who simply answers `false` makes the
		// validator fail to recognize its OWN error, rewrap it as an unreadable
		// reflection failure, and lose the path that names the defect.
		const source: ContractShape = {
			category: 'object',
			properties: { a: { category: 'string', min: -1 } },
		}
		const clean = captureContractError(() => new ShapeValidator(source).validate())
		const poisoned = pollutePrototype(
			ContractError,
			Symbol.hasInstance,
			() => denyRecognition,
			() => attempt(() => new ShapeValidator(source).validate()),
		)

		expect(clean.context?.path).toEqual(['properties', 'a'])
		expect(poisoned.success).toBe(false)
		if (poisoned.success) throw new Error('expected the poisoned validation to refuse')
		const refusal = poisoned.error
		expect(isContractError(refusal)).toBe(true)
		if (!isContractError(refusal)) throw new Error('expected a ContractError')
		expect({
			path: refusal.context?.path,
			code: refusal.code,
			message: refusal.message,
			cause: refusal.cause,
		}).toEqual({
			path: ['properties', 'a'],
			code: clean.code,
			message: clean.message,
			cause: undefined,
		})
	})

	it('rechecks and accepts a repaired flagged declaration on the same validator', () => {
		const source: ContractShape = { category: 'string', pattern: /a/i }
		const validator = new ShapeValidator(source)

		expect(captureContractError(() => validator.validate()).code).toBe('pattern')
		Reflect.set(source, 'pattern', /a/)
		validator.validate()
		Reflect.set(source, 'pattern', /[aA]/)
		validator.validate()
	})
})

describe('the raw-schema gate decides through captured operations', () => {
	// Two documented refusals of `rawShape` / `validateShape` were decided by
	// a live global read and by a caller-writable membership test, so a caller
	// could make a malformed schema compile clean without anything throwing.
	const answerFalse = (): boolean => false

	it('refuses an invalid pattern while globalThis.RegExp is a non-throwing stub', () => {
		const stub = (): object => ({})
		const outcome = replaceIntrinsic(globalThis, 'RegExp', stub, () =>
			attempt(() => rawShape({ type: 'string', pattern: '(' })),
		)

		expect(outcome.success).toBe(false)
		expect(!outcome.success && isContractError(outcome.error)).toBe(true)
	})

	it('accepts a valid pattern while globalThis.RegExp is a non-throwing stub', () => {
		// The control the refusal probe is worthless without: the captured read has
		// to keep ACCEPTING too, or the test would pass for a gate that refuses
		// everything.
		const stub = (): object => ({})
		const outcome = replaceIntrinsic(globalThis, 'RegExp', stub, () =>
			attempt(() => rawShape({ type: 'string', pattern: '^a+$' })),
		)

		expect(outcome.success).toBe(true)
	})

	it('refuses a duplicated raw enum while Set.prototype.has answers false', () => {
		const outcome = replaceIntrinsic(Set.prototype, 'has', answerFalse, () =>
			attempt(() => rawShape({ type: 'string', enum: ['a', 'a'] })),
		)

		expect(outcome.success).toBe(false)
		expect(!outcome.success && isContractError(outcome.error)).toBe(true)
	})

	it('refuses a duplicated required list while Set.prototype.has answers false', () => {
		const outcome = replaceIntrinsic(Set.prototype, 'has', answerFalse, () =>
			attempt(() => rawShape({ type: 'object', required: ['a', 'a'] })),
		)

		expect(outcome.success).toBe(false)
	})

	it('accepts a distinct raw enum while Set.prototype.has answers true', () => {
		const answerTrue = (): boolean => true
		const outcome = replaceIntrinsic(Set.prototype, 'has', answerTrue, () =>
			attempt(() => rawShape({ type: 'string', enum: ['a', 'b'] })),
		)

		expect(outcome.success).toBe(true)
	})
})

describe('one observation per unique node per call (R6-A)', () => {
	it('observes a shared node no more often than a node reached through one edge', () => {
		// The baseline the counts below are meaningful against: one node, one
		// incoming edge, one observation.
		const alone = new ObservedShape()
		validateShape(buildStaircaseShape(alone.shape, 1))
		const once = alone.reads
		expect(once).toBeGreaterThan(0)

		// The same node reached through sixteen edges, each one level deeper than
		// the last — the order that used to force a fresh observation per edge,
		// because a subtree cleared from a shallow start says nothing about a
		// deeper one under a per-depth memo.
		const shared = new ObservedShape()
		validateShape(buildStaircaseShape(shared.shape, 16))
		expect(shared.reads).toBe(once)

		// Declaration order must not decide it either: deepest edge first is the
		// arrangement the old memo happened to handle well.
		const reversed = new ObservedShape()
		const properties: Record<string, ContractShape> = {}
		for (let level = 16; level > 0; level -= 1) {
			let node: ContractShape = reversed.shape
			for (let step = 0; step < level; step += 1) node = { category: 'array', items: node }
			properties[`k${String(level)}`] = node
		}
		validateShape({ category: 'object', properties })
		expect(reversed.reads).toBe(once)
	})

	it('starts a fresh observation for every new call, so a live source is re-read', () => {
		const live = new ObservedShape()
		const shape = buildStaircaseShape(live.shape, 4)
		validateShape(shape)
		const first = live.reads
		expect(first).toBeGreaterThan(0)

		live.clear()
		validateShape(shape)
		expect(live.reads).toBe(first)

		// And through a fresh validator, which is what every eager door builds.
		live.clear()
		new ShapeValidator(shape).validate()
		expect(live.reads).toBe(first)
	})

	it('inspects every incoming edge even though it observes the node once', () => {
		// Placement is a property of the SLOT, so the capture may not answer it. The
		// legal first edge must not license the illegal second one.
		const inner = stringShape()
		const misplaced = optionalShape(inner)
		const error = captureContractError(() =>
			validateShape({
				category: 'object',
				properties: {
					legal: misplaced,
					host: { category: 'array', items: misplaced },
				},
			}),
		)

		expect(error.code).toBe('placement')
		expect(error.context?.path).toEqual(['properties', 'host', 'items'])

		// Control: the same node in two legal slots still compiles, so the rule is
		// about placement rather than about reuse.
		expect(() =>
			validateShape({ category: 'object', properties: { a: misplaced, b: misplaced } }),
		).not.toThrow()
	})

	it('still refuses a later edge that reaches a corrupt node', () => {
		// A shared parent whose SECOND incoming edge is the one that reaches the
		// corruption: capturing the parent once must not make the walk stop looking
		// at what its edges lead to.
		const corrupt: ContractShape = { category: 'string' }
		const host: ContractShape = { category: 'array', items: corrupt }
		Reflect.set(corrupt, 'category', 'not-a-category')

		const error = captureContractError(() =>
			validateShape({
				category: 'object',
				properties: { first: stringShape(), second: host, third: host },
			}),
		)
		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['properties', 'second', 'items'])
	})
})

describe('depth is measured over the captured graph (R6-A)', () => {
	it('finds a violation that only the longest path through a shared node reaches', () => {
		// Every individual edge is legal; only the composition overshoots. A walk
		// that skipped a node because a shallower edge had cleared it would report
		// nothing here.
		const half = Math.floor(COMPILE_DEPTH_LIMIT / 2) + 1
		let tail: ContractShape = stringShape()
		for (let level = 0; level < half; level += 1) tail = { category: 'array', items: tail }
		let shape: ContractShape = tail
		for (let level = 0; level < half; level += 1) shape = { category: 'array', items: shape }

		const error = captureContractError(() => validateShape(shape))
		expect(error.code).toBe('depth')
		expect(error.message).toBe('validateShape: a shape exceeds the compilation depth limit')
		expect(error.context?.limit).toBe(COMPILE_DEPTH_LIMIT)

		// Control: one level shallower is accepted, so the bound is the bound and
		// not an artifact of the measurement.
		let inside: ContractShape = stringShape()
		for (let level = 0; level < COMPILE_DEPTH_LIMIT; level += 1) {
			inside = { category: 'array', items: inside }
		}
		expect(() => validateShape(inside)).not.toThrow()
	})

	it('names the earliest offending path in declaration order', () => {
		// Two properties both overshoot; the diagnosis must name the first one a
		// pre-order walk would have reached, not whichever the measurement visited.
		// The tower is written out rather than built, because every builder runs
		// this same gate and would refuse it before the test could hand it over.
		let tower: ContractShape = { category: 'string' }
		for (let level = 0; level < COMPILE_DEPTH_LIMIT; level += 1) {
			tower = { category: 'array', items: tower }
		}
		const error = captureContractError(() =>
			validateShape({ category: 'object', properties: { alpha: tower, beta: tower } }),
		)

		expect(error.code).toBe('depth')
		const path = error.context?.path
		expect(Array.isArray(path)).toBe(true)
		if (!Array.isArray(path)) return
		expect(path[0]).toBe('properties')
		expect(path[1]).toBe('alpha')
		expect(path.length).toBe(COMPILE_DEPTH_LIMIT + 2)
	})

	it('reconstructs a witness whose deepest step is a slot holding no shape at all', () => {
		// The reconstruction descends through captured nodes, and the last step of
		// this path has nothing captured behind it: the offending slot holds a
		// number. Depth still outranks the structural refusal the same slot earns,
		// and the path still names every level it took to get there.
		const deepest: ContractShape = { category: 'array', items: { category: 'string' } }
		Reflect.set(deepest, 'items', 42)
		let tower: ContractShape = deepest
		for (let level = 0; level < COMPILE_DEPTH_LIMIT; level += 1) {
			tower = { category: 'array', items: tower }
		}
		const error = captureContractError(() => validateShape(tower))

		expect(error.code).toBe('depth')
		const path = error.context?.path
		expect(Array.isArray(path) ? path.length : 0).toBe(COMPILE_DEPTH_LIMIT + 1)

		// Control: the same corrupt slot one level shallower is a STRUCTURE refusal,
		// so the verdict above is the depth rule outranking it rather than the only
		// rule that could fire.
		const slot: ContractShape = { category: 'array', items: { category: 'string' } }
		Reflect.set(slot, 'items', 42)
		let shallow: ContractShape = slot
		for (let level = 0; level < COMPILE_DEPTH_LIMIT - 1; level += 1) {
			shallow = { category: 'array', items: shallow }
		}
		expect(captureContractError(() => validateShape(shallow)).code).toBe('structure')
	})

	it('lets depth outrank a cycle reached beyond the limit and lose to one inside it', () => {
		const looped: ContractShape = { category: 'array', items: { category: 'string' } }
		Reflect.set(looped, 'items', looped)
		const near = captureContractError(() => validateShape(looped))
		expect(near.code).toBe('cycle')

		let buried: ContractShape = looped
		for (let level = 0; level < COMPILE_DEPTH_LIMIT + 1; level += 1) {
			buried = { category: 'array', items: buried }
		}
		expect(captureContractError(() => validateShape(buried)).code).toBe('depth')
	})

	it('answers a cyclic declaration without re-reading the caller source', () => {
		// The cyclic fallback walks the CAPTURED graph. Its instrument is the read
		// count: a fallback that re-walked the source would multiply it, and the
		// leaf is placed at two different depths so a per-edge walk cannot match the
		// baseline by accident.
		const observed = new ObservedShape()
		const looped: ContractShape = { category: 'object', properties: {} }
		Reflect.set(looped, 'properties', {
			near: observed.shape,
			far: { category: 'array', items: { category: 'array', items: observed.shape } },
			back: looped,
		})
		const error = captureContractError(() => validateShape(looped))
		expect(error.code).toBe('cycle')
		const cyclic = observed.reads

		observed.clear()
		validateShape({ category: 'object', properties: { leaf: observed.shape } })
		expect(cyclic).toBe(observed.reads)
	})

	it('still finds a depth violation the cyclic walk first met through a truncated branch', () => {
		// A node whose subtree walk was cut short by the ACTIVE path has not been
		// cleared: the walk that ended at it never followed the edge back through
		// the cycle, so reaching the same node again from a shallower position
		// opens a route the first visit never took. Memoising that visit as a
		// clearance discarded the route, and the verdict then depended on how long
		// the alias chain was — SHORTENING the declaration turned a depth violation
		// into a cycle, which no rule can justify.
		for (const links of [1, 2, 3]) {
			let deep: ContractShape = { category: 'string' }
			for (let level = 0; level < 510; level += 1) {
				deep = { category: 'object', properties: { k0: deep } }
			}
			const loopedProperties: Record<string, ContractShape> = {}
			const looped: ContractShape = { category: 'object', properties: loopedProperties }
			const fork: ContractShape = {
				category: 'object',
				properties: { p: { category: 'object', properties: { x: looped } }, q: deep },
			}
			loopedProperties.back = fork
			let alias: ContractShape = looped
			for (let level = 0; level < links; level += 1) {
				alias = { category: 'object', properties: { k0: alias } }
			}
			const root: ContractShape = { category: 'object', properties: { a: fork, b: alias } }
			const error = captureContractError(() => validateShape(root))
			expect(error.code).toBe('depth')
			expect(error.message).toBe('validateShape: a shape exceeds the compilation depth limit')
			// The rule lives in one engine, but a repair proven at one door is a
			// hypothesis at the others, so the typed entry point is asked too.
			expect(captureContractError(() => createContract(root)).code).toBe('depth')
		}

		// Control one: the same graph with the back edge pointing at a distinct
		// structural twin instead of the ancestor. It is acyclic, so the ordered
		// measurement rather than the fallback answers it — and it reports depth at
		// every alias length, proving the route really does overshoot.
		for (const links of [1, 2, 3]) {
			let deep: ContractShape = { category: 'string' }
			for (let level = 0; level < 510; level += 1) {
				deep = { category: 'object', properties: { k0: deep } }
			}
			const twin: ContractShape = {
				category: 'object',
				properties: {
					p: { category: 'object', properties: { x: { category: 'object', properties: {} } } },
					q: deep,
				},
			}
			const looped: ContractShape = { category: 'object', properties: { back: twin } }
			const fork: ContractShape = {
				category: 'object',
				properties: { p: { category: 'object', properties: { x: looped } }, q: deep },
			}
			let alias: ContractShape = looped
			for (let level = 0; level < links; level += 1) {
				alias = { category: 'object', properties: { k0: alias } }
			}
			expect(
				captureContractError(() =>
					validateShape({ category: 'object', properties: { a: fork, b: alias } }),
				).code,
			).toBe('depth')
		}

		// Control two: the same cycle with the deep chain removed. Nothing
		// overshoots, so the cycle is the only diagnosis left and it is reported at
		// every alias length — the fallback still detects the back edge.
		for (const links of [1, 2, 3]) {
			const loopedProperties: Record<string, ContractShape> = {}
			const looped: ContractShape = { category: 'object', properties: loopedProperties }
			const fork: ContractShape = {
				category: 'object',
				properties: { p: { category: 'object', properties: { x: looped } } },
			}
			loopedProperties.back = fork
			let alias: ContractShape = looped
			for (let level = 0; level < links; level += 1) {
				alias = { category: 'object', properties: { k0: alias } }
			}
			expect(
				captureContractError(() =>
					validateShape({ category: 'object', properties: { a: fork, b: alias } }),
				).code,
			).toBe('cycle')
		}
	})

	it('keeps the cyclic verdict independent of the order two sibling keys are declared in', () => {
		// The minimized shape a differential fuzz shrank the same defect down to.
		// Its longest node-repeat-free declaration path is 513 edges, one past the
		// limit, and the branch that reaches it is only walked in full when the
		// other branch has not already memoised a truncated clearance. Dropping the
		// first key, or swapping the two, must not change the answer.
		const verdicts: string[] = []
		for (const variant of ['both', 'second', 'swapped']) {
			const loopProperties: Record<string, ContractShape> = {}
			const hubProperties: Record<string, ContractShape> = {}
			const midProperties: Record<string, ContractShape> = {}
			const tailProperties: Record<string, ContractShape> = {}
			const loop: ContractShape = { category: 'object', properties: loopProperties }
			const hub: ContractShape = { category: 'object', properties: hubProperties }
			const mid: ContractShape = { category: 'object', properties: midProperties }
			const tail: ContractShape = { category: 'object', properties: tailProperties }
			let toMid: ContractShape = mid
			for (let level = 0; level < 60; level += 1) {
				toMid = { category: 'object', properties: { k0: toMid } }
			}
			loopProperties.k0 = toMid
			let toHub: ContractShape = hub
			for (let level = 0; level < 196; level += 1) {
				toHub = { category: 'object', properties: { k0: toHub } }
			}
			midProperties.k0 = toHub
			hubProperties.k0 = tail
			let toLoop: ContractShape = loop
			for (let level = 0; level < 186; level += 1) {
				toLoop = { category: 'object', properties: { k0: toLoop } }
			}
			hubProperties.k1 = toLoop
			let toLoopShort: ContractShape = loop
			for (let level = 0; level < 2; level += 1) {
				toLoopShort = { category: 'object', properties: { k0: toLoopShort } }
			}
			tailProperties.k0 = toLoopShort
			let toTail: ContractShape = tail
			for (let level = 0; level < 64; level += 1) {
				toTail = { category: 'object', properties: { k0: toTail } }
			}
			const properties: Record<string, ContractShape> =
				variant === 'second'
					? { k1: toTail }
					: variant === 'swapped'
						? { k1: toTail, k0: loop }
						: { k0: loop, k1: toTail }
			const error = captureContractError(() => validateShape({ category: 'object', properties }))
			const path = error.context?.path
			verdicts[verdicts.length] =
				`${error.code}:${Array.isArray(path) ? String(path.length) : 'unknown'}`
		}
		expect(verdicts).toEqual(['depth:1026', 'depth:1026', 'depth:1026'])
	})

	it('answers a cycle beneath a shared tower in the size of the declaration', () => {
		// Twenty-six shared levels over one self-referencing leaf: twenty-seven
		// authored nodes and sixty-seven million distinct paths. The fallback walks
		// paths, so it can only answer this by NOT re-walking a node it already
		// cleared — and every node here was stopped by the leaf's own back edge,
		// which is re-met identically on every arrival and therefore costs the
		// clearance nothing. A fallback that treated any stop as a poisoned
		// clearance would walk all sixty-seven million: measured at twenty levels it
		// took 897 ms, so at twenty-six it cannot finish inside the test timeout.
		// The timeout is the instrument; no wall-clock assertion is needed.
		const loopProperties: Record<string, ContractShape> = {}
		const loop: ContractShape = { category: 'object', properties: loopProperties }
		loopProperties.self = loop
		let tower: ContractShape = loop
		for (let level = 0; level < 26; level += 1) {
			tower = { category: 'object', properties: { left: tower, right: tower } }
		}
		expect(captureContractError(() => validateShape(tower)).code).toBe('cycle')
	})

	it('counts emitted expansion over the shared graph exactly as before', () => {
		const validator = new ShapeValidator(buildSharedDagShape(4))
		validator.validate()
		// 2^(levels+1) - 1 emitted nodes for a binary alias tower of four levels.
		expect(validator.expansion).toBe(31)

		const refused = new ShapeValidator(buildSharedDagShape(20))
		expect(captureContractError(() => validateShape(buildSharedDagShape(20))).code).toBe(
			'expansion',
		)
		expect(refused.expansion).toBeUndefined()
	})
})

describe('raw schema records are inspected once per call (R6-A)', () => {
	it('validates a schema shared by two raw nodes once and still refuses it', () => {
		const shared: JSONSchema = { type: 'object', properties: { value: { type: 'string' } } }
		expect(() =>
			validateShape({
				category: 'object',
				properties: {
					a: { category: 'raw', schema: shared },
					b: { category: 'raw', schema: shared },
				},
			}),
		).not.toThrow()

		const broken: JSONSchema = { type: 'string', minLength: -1 }
		const error = captureContractError(() =>
			validateShape({
				category: 'object',
				properties: {
					a: { category: 'raw', schema: broken },
					b: { category: 'raw', schema: broken },
				},
			}),
		)
		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['properties', 'a', 'schema'])
	})

	it('refuses a raw node whose schema nesting overshoots from its own position', () => {
		let schema: JSONSchema = { type: 'string' }
		for (let level = 0; level < COMPILE_DEPTH_LIMIT + 1; level += 1) {
			schema = { type: 'array', items: schema }
		}
		const error = captureContractError(() => validateShape({ category: 'raw', schema }))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('validateShape: raw schema exceeds the compilation depth limit')
		expect(error.context?.path).toEqual(['schema'])

		// A schema that fits at the root but not once the node is nested: the same
		// record, refused from the deeper position and accepted from the shallow one.
		let modest: JSONSchema = { type: 'string' }
		for (let level = 0; level < COMPILE_DEPTH_LIMIT - 2; level += 1) {
			modest = { type: 'array', items: modest }
		}
		const node: ContractShape = { category: 'raw', schema: modest }
		expect(() => validateShape(node)).not.toThrow()
		expect(
			captureContractError(() =>
				validateShape({
					category: 'array',
					items: { category: 'array', items: { category: 'array', items: node } },
				}),
			).message,
		).toBe('validateShape: raw schema exceeds the compilation depth limit')
	})

	it('names an overshooting occurrence of a shared raw node, whichever edge is declared first', () => {
		// A raw node's schema height is a property of the NODE, but whether it fits
		// is a property of the POSITION. Sharing one raw node between a shallow slot
		// that fits and a deep slot that does not therefore has exactly one honest
		// diagnosis: the deep slot. The refusal used to carry the path of whichever
		// occurrence discovery met FIRST, so the same graph accused a different slot
		// depending on which key was written first — and in one of the two orders it
		// accused a slot the control below proves is legal on its own.
		let schema: JSONSchema = { type: 'string' }
		for (let level = 0; level < 8; level += 1) schema = { type: 'array', items: schema }
		const shared: ContractShape = { category: 'raw', schema }
		let deep: ContractShape = shared
		for (let level = 0; level < 504; level += 1) deep = { category: 'array', items: deep }

		// Control: the shallow slot alone is accepted, so it is not the violation.
		expect(() => validateShape({ category: 'object', properties: { a: shared } })).not.toThrow()

		for (const properties of [
			{ a: shared, b: deep },
			{ b: deep, a: shared },
		]) {
			const error = captureContractError(() => validateShape({ category: 'object', properties }))
			expect(error.code).toBe('structure')
			expect(error.message).toBe('validateShape: raw schema exceeds the compilation depth limit')
			const path = error.context?.path
			expect(Array.isArray(path)).toBe(true)
			if (!Array.isArray(path)) return
			expect(path.length).toBe(507)
			expect(path.slice(0, 3)).toEqual(['properties', 'b', 'items'])
			expect(path[506]).toBe('schema')

			// The same declaration through the typed entry point, because a repair
			// proven at one door is only a hypothesis at the next one.
			expect(
				captureContractError(() => createContract({ category: 'object', properties })).context
					?.path,
			).toEqual(path)
		}
	})

	it('still refuses a cyclic raw schema and a shared acyclic one', () => {
		const cyclic: JSONSchema = { type: 'object', properties: {} }
		Reflect.set(cyclic, 'properties', { back: cyclic })
		const error = captureContractError(() => validateShape({ category: 'raw', schema: cyclic }))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('validateShape: a raw schema may not contain a cycle')

		// The control that separates sharing from cycling: the same record in two
		// sibling slots is legal and must not be mistaken for a back edge.
		const leaf: JSONSchema = { type: 'string' }
		expect(() =>
			validateShape({
				category: 'raw',
				schema: { type: 'object', properties: { a: leaf, b: leaf } },
			}),
		).not.toThrow()
	})
})

describe('the cyclic fallback agrees with an unmemoized walk (R6-A-fix)', () => {
	it('returns the memo-free verdict on four hundred seeded cyclic declarations', () => {
		// The instrument that settled the memo's soundness, kept as its guard. Four
		// hundred randomly wired hub-and-chain graphs, deterministic from one seed,
		// each carrying enough chain length that both `cycle` and `depth` are
		// reachable. The tally below is what the SAME corpus produces with the memo
		// disabled entirely — the reference arm, sound by construction because it
		// walks every path.
		//
		// The instrument is proven falsifiable rather than assumed so: run with the
		// memo written unconditionally, as it was before this repair, and the corpus
		// reports 286 cycle / 68 depth — three declarations whose depth violation is
		// lost. A pin that could not report a wrong memo would be measuring nothing.
		const draw = seededRandom(20260808)
		const tally = { accepted: 0, cycle: 0, depth: 0, other: 0 }
		for (let round = 0; round < 400; round += 1) {
			const hubCount = 3 + Math.floor(draw() * 4)
			const hubProperties: Array<Record<string, ContractShape>> = []
			const hubs: ContractShape[] = []
			for (let hub = 0; hub < hubCount; hub += 1) {
				const properties: Record<string, ContractShape> = {}
				hubProperties[hub] = properties
				hubs[hub] = { category: 'object', properties }
			}
			for (let hub = 0; hub < hubCount; hub += 1) {
				const properties = hubProperties[hub]
				if (properties === undefined) continue
				const edges = 1 + Math.floor(draw() * 3)
				for (let edge = 0; edge < edges; edge += 1) {
					const target = Math.floor(draw() * (hubCount + 1))
					const chosen = hubs[target]
					let tail: ContractShape = chosen === undefined ? { category: 'string' } : chosen
					const links = 20 + Math.floor(draw() * 180)
					for (let level = 0; level < links; level += 1) {
						tail = { category: 'object', properties: { k0: tail } }
					}
					properties[`e${String(edge)}`] = tail
				}
			}
			const root = hubs[0]
			if (root === undefined) continue
			const outcome = attempt(() => validateShape(root))
			if (outcome.success) {
				tally.accepted += 1
				continue
			}
			const error = outcome.error
			if (!isContractError(error)) tally.other += 1
			else if (error.code === 'cycle') tally.cycle += 1
			else if (error.code === 'depth') tally.depth += 1
			else tally.other += 1
		}
		expect(tally).toEqual({ accepted: 46, cycle: 283, depth: 71, other: 0 })
	})
})
