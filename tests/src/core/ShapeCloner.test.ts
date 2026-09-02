import type {
	ContractShape,
	JSONSchema,
	LiteralValue,
	ShapeClonerInterface,
	StringShape,
} from '@src/core'
import type { TerminalIntrinsic } from '../../setup.js'
import {
	attempt,
	cloneShape,
	COMPILE_DEPTH_LIMIT,
	compileGuard,
	compileSchema,
	ContractError,
	createContract,
	integerShape,
	isContractError,
	isRegExp,
	objectShape,
	optionalShape,
	arrayShape,
	ShapeCloner,
	stringShape,
	validateShape,
} from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	captureContractError,
	createNativeMaximumSparseArray,
	createShapeRetention,
	createVariantRetention,
	NullBaseDeclaration,
	PatternFixture,
	pollutePrototype,
	redirectIntrinsic,
	replaceIntrinsic,
	SingleReadPattern,
	StringDeclaration,
} from '../../setup.js'
import {
	createForeignRegExp,
	createForeignStringShape,
	requestWeakReferenceCollection,
} from '../../setupServer.js'

describe('ShapeCloner', () => {
	it('is root-exported, conforms to its interface, and exposes only clone', () => {
		const cloner: ShapeClonerInterface = new ShapeCloner({ type: 'string' })

		expect(cloner.clone()).toEqual({ type: 'string' })
		expect(Reflect.ownKeys(ShapeCloner.prototype)).toEqual(['constructor', 'clone'])
	})

	it('does not observe the retained source during construction', () => {
		const source = Proxy.revocable<ContractShape>({ type: 'string' }, {})
		source.revoke()

		const cloner = new ShapeCloner(source.proxy)

		expect(cloner).toBeInstanceOf(ShapeCloner)
	})

	it('refuses non-record nodes before discriminant observation without narrowing valid realms', () => {
		const root = captureContractError(() => new ShapeCloner(new StringDeclaration()).clone())
		expect(root.message).toBe('validateShape: every structural child must be a shape')
		expect(root.code).toBe('structure')
		expect(root.context?.path).toEqual([])
		expect(Object.hasOwn(root, 'cause')).toBe(false)

		const reparentedRoot = captureContractError(() =>
			new ShapeCloner(new NullBaseDeclaration()).clone(),
		)
		expect(reparentedRoot.message).toBe('validateShape: every structural child must be a shape')
		expect(reparentedRoot.code).toBe('structure')
		expect(reparentedRoot.context?.path).toEqual([])
		expect(Object.hasOwn(reparentedRoot, 'cause')).toBe(false)

		const reparentedChild = captureContractError(() =>
			new ShapeCloner({ type: 'array', items: new NullBaseDeclaration() }).clone(),
		)
		expect(reparentedChild.message).toBe('validateShape: every structural child must be a shape')
		expect(reparentedChild.code).toBe('structure')
		expect(reparentedChild.context?.path).toEqual(['items'])

		const nested = captureContractError(() =>
			new ShapeCloner({ type: 'array', items: new StringDeclaration() }).clone(),
		)
		expect(nested.message).toBe('validateShape: every structural child must be a shape')
		expect(nested.code).toBe('structure')
		expect(nested.context?.path).toEqual(['items'])
		expect(Object.hasOwn(nested, 'cause')).toBe(false)

		const plain = new ShapeCloner({ type: 'string' }).clone()
		const nullPrototype: StringShape = { type: 'string' }
		Object.setPrototypeOf(nullPrototype, null)
		const nullOwned = new ShapeCloner(nullPrototype).clone()
		const foreign = createForeignStringShape()
		const foreignCloner: unknown = Reflect.construct(ShapeCloner, [foreign])
		if (!(foreignCloner instanceof ShapeCloner)) throw new Error('expected a ShapeCloner')
		const foreignOwned = foreignCloner.clone()
		expect([plain.type, nullOwned.type, foreignOwned.type]).toEqual(['string', 'string', 'string'])

		const reason = Object.freeze({ stage: 'prototype' })
		let discriminants = 0
		const hostile = new Proxy<ContractShape>(
			{ type: 'string' },
			{
				getOwnPropertyDescriptor(target, key) {
					if (key === 'type') discriminants += 1
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
				getPrototypeOf() {
					throw reason
				},
			},
		)
		const hostileCloner = new ShapeCloner(hostile)
		const hostileError = captureContractError(() => hostileCloner.clone())
		expect(hostileError.message).toBe('cloneShape: failed to create an owned shape snapshot')
		expect(hostileError.code).toBe('clone')
		expect(hostileError.context).toEqual({ shape: 'shape' })
		expect(hostileError.cause).toBe(reason)
		expect(discriminants).toBe(0)
		expect(captureContractError(() => hostileCloner.clone())).toBe(hostileError)
	})

	it('settles success once and replays the exact frozen root without rereading', () => {
		let observations = 0
		const source = new Proxy<StringShape>(
			{ type: 'string', min: 1 },
			{
				get(target, key, receiver) {
					observations += 1
					return Reflect.get(target, key, receiver)
				},
				getOwnPropertyDescriptor(target, key) {
					observations += 1
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
				has(target, key) {
					observations += 1
					return Reflect.has(target, key)
				},
			},
		)
		const cloner = new ShapeCloner(source)
		const first = cloner.clone()
		const settled = observations
		const second = cloner.clone()

		expect(second).toBe(first)
		expect(observations).toBe(settled)
		expect(Object.isFrozen(first)).toBe(true)
	})

	it('settles failure once without nominally adopting a caller error or rereading', () => {
		let observations = 0
		const caller = new ContractError('caller', { code: 'clone' })
		const source = new Proxy<StringShape>(
			{ type: 'string' },
			{
				getOwnPropertyDescriptor() {
					observations += 1
					throw caller
				},
			},
		)
		const cloner = new ShapeCloner(source)
		const first = captureContractError(() => cloner.clone())
		const settled = observations
		const second = captureContractError(() => cloner.clone())

		expect(second).toBe(first)
		expect(first).not.toBe(caller)
		expect(first.message).toBe('cloneShape: failed to create an owned shape snapshot')
		expect(first.cause).toBe(caller)
		expect(observations).toBe(settled)
	})

	it('wraps every foreign thrown category once with its exact cause', () => {
		for (const reason of [
			undefined,
			'primitive',
			Object.freeze({ caller: true }),
			new Error('caller error'),
			new ContractError('caller contract error', { code: 'clone' }),
		]) {
			const source = new Proxy<StringShape>(
				{ type: 'string' },
				{
					getOwnPropertyDescriptor() {
						throw reason
					},
				},
			)
			const error = captureContractError(() => new ShapeCloner(source).clone())

			expect(error.message).toBe('cloneShape: failed to create an owned shape snapshot')
			expect(error.code).toBe('clone')
			expect(error.context).toEqual({ shape: 'shape' })
			expect(Object.hasOwn(error, 'cause')).toBe(true)
			expect(error.cause).toBe(reason)
			expect(error).not.toBe(reason)
		}
	})

	it('keeps distinct instances independent', () => {
		let observations = 0
		const source = new Proxy<StringShape>(
			{ type: 'string' },
			{
				getOwnPropertyDescriptor(target, key) {
					observations += 1
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
			},
		)
		const first = new ShapeCloner(source).clone()
		const afterFirst = observations
		const second = new ShapeCloner(source).clone()

		expect(second).not.toBe(first)
		expect(second).toEqual(first)
		expect(observations).toBeGreaterThan(afterFirst)
	})

	it('promotes caught reentry followed by apparent success to the shared poison', () => {
		const state: { cloner: ShapeClonerInterface | undefined; nested: unknown } = {
			cloner: undefined,
			nested: undefined,
		}
		const source = new Proxy<StringShape>(
			{ type: 'string' },
			{
				getOwnPropertyDescriptor(target, key) {
					if (key === 'min') {
						const cloner = state.cloner
						if (cloner === undefined) throw new Error('cloner must be initialized')
						state.nested = captureContractError(() => cloner.clone())
					}
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
			},
		)
		state.cloner = new ShapeCloner(source)

		const outer = captureContractError(() => state.cloner?.clone())
		const later = captureContractError(() => state.cloner?.clone())

		expect(state.nested).toBe(outer)
		expect(later).toBe(outer)
		expect(outer.message).toBe('ShapeCloner.clone: shape cloning may not be reentered')
		expect(outer.code).toBe('clone')
		expect(outer.context).toEqual({ shape: 'shape' })
		expect(Object.hasOwn(outer, 'cause')).toBe(false)
	})

	it('promotes uncaught reentry and caught reentry before replacement failure', () => {
		for (const replacement of [undefined, new Error('replacement')]) {
			const state: { cloner: ShapeClonerInterface | undefined; nested: unknown } = {
				cloner: undefined,
				nested: undefined,
			}
			const source = new Proxy<StringShape>(
				{ type: 'string' },
				{
					getOwnPropertyDescriptor(target, key) {
						if (key === 'min') {
							const cloner = state.cloner
							if (cloner === undefined) throw new Error('cloner must be initialized')
							if (replacement === undefined) cloner.clone()
							state.nested = captureContractError(() => cloner.clone())
							throw replacement
						}
						return Reflect.getOwnPropertyDescriptor(target, key)
					},
				},
			)
			state.cloner = new ShapeCloner(source)

			const outer = captureContractError(() => state.cloner?.clone())
			const later = captureContractError(() => state.cloner?.clone())

			expect(later).toBe(outer)
			expect(state.nested).toBe(replacement === undefined ? undefined : outer)
			expect(Object.hasOwn(outer, 'cause')).toBe(false)
		}
	})

	it('captures every category and observes present and absent fields through one table', () => {
		const leaf: StringShape = { type: 'string', description: 'leaf' }
		const rows: ReadonlyArray<{
			readonly source: ContractShape
			readonly fields: readonly string[]
			readonly absent?: readonly string[]
			readonly wrapped?: boolean
		}> = [
			{
				source: {
					type: 'string',
					min: 1,
					max: 3,
					pattern: /x/,
					description: 'string',
				},
				fields: ['type', 'min', 'max', 'pattern', 'description'],
			},
			{
				source: {
					type: 'number',
					integer: true,
					min: 1,
					max: 3,
					description: 'number',
				},
				fields: ['type', 'integer', 'min', 'max', 'description'],
			},
			{
				source: { type: 'boolean', description: 'boolean' },
				fields: ['type', 'description'],
			},
			{
				source: { type: 'null', description: 'null' },
				fields: ['type', 'description'],
			},
			{
				source: { type: 'literal', values: ['x'], description: 'literal' },
				fields: ['type', 'values', 'description'],
			},
			{
				source: { type: 'array', items: leaf, min: 1, max: 3, description: 'array' },
				fields: ['type', 'items', 'min', 'max', 'description'],
			},
			{
				source: {
					type: 'object',
					properties: { value: leaf },
					additionalProperties: false,
					description: 'object',
				},
				fields: ['type', 'properties', 'additionalProperties', 'description'],
			},
			{
				source: { type: 'union', variants: [leaf], mode: 'oneOf', description: 'union' },
				fields: ['type', 'variants', 'mode', 'description'],
			},
			{
				source: { type: 'optional', inner: leaf },
				fields: ['type', 'inner'],
				wrapped: true,
			},
			{
				source: { type: 'nullable', inner: leaf },
				fields: ['type', 'inner'],
			},
			{
				source: { type: 'json', description: 'json' },
				fields: ['type', 'description'],
			},
			{
				source: { type: 'raw', schema: { type: 'string' } },
				fields: ['type', 'schema'],
			},
			{
				source: { type: 'string' },
				fields: ['type'],
				absent: ['min', 'max', 'pattern', 'description'],
			},
		]

		expect(rows.map((row) => row.source.type)).toEqual([
			'string',
			'number',
			'boolean',
			'null',
			'literal',
			'array',
			'object',
			'union',
			'optional',
			'nullable',
			'json',
			'raw',
			'string',
		])
		for (const row of rows) {
			const reads = new Map<string, number>()
			const descriptors = new Map<string, number>()
			const presence = new Map<string, number>()
			const observed = new Proxy(row.source, {
				get(target, key, receiver) {
					if (typeof key === 'string') reads.set(key, (reads.get(key) ?? 0) + 1)
					return Reflect.get(target, key, receiver)
				},
				getOwnPropertyDescriptor(target, key) {
					if (typeof key === 'string') {
						descriptors.set(key, (descriptors.get(key) ?? 0) + 1)
					}
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
				has(target, key) {
					if (typeof key === 'string') presence.set(key, (presence.get(key) ?? 0) + 1)
					return Reflect.has(target, key)
				},
			})
			const root: ContractShape =
				row.wrapped === true ? { type: 'object', properties: { value: observed } } : observed
			const clone = new ShapeCloner(root).clone()
			expect(Object.isFrozen(clone)).toBe(true)
			for (const field of row.fields) {
				expect(reads.get(field), `${row.source.type}.${field} reads`).toBe(2)
				expect(descriptors.get(field), `${row.source.type}.${field} descriptors`).toBe(1)
				expect(presence.get(field) ?? 0, `${row.source.type}.${field} presence`).toBe(0)
			}
			for (const field of row.absent ?? []) {
				expect(descriptors.get(field), `${row.source.type}.${field} descriptors`).toBe(1)
				expect(presence.get(field), `${row.source.type}.${field} presence`).toBe(1)
				expect(reads.get(field) ?? 0, `${row.source.type}.${field} reads`).toBe(0)
			}
		}
	})

	it('refuses inherited or accessor ordinary fields without invocation', () => {
		let inheritedReads = 0
		const inheritedPrototype = Object.create(null)
		Object.defineProperty(inheritedPrototype, 'min', {
			get() {
				inheritedReads += 1
				return 1
			},
		})
		const inherited: StringShape = Object.create(inheritedPrototype)
		Object.defineProperty(inherited, 'type', { value: 'string', enumerable: true })
		const inheritedEngine = new ShapeCloner(inherited)
		const inheritedError = captureContractError(() => inheritedEngine.clone())
		expect(inheritedError).toBeInstanceOf(ContractError)
		expect(inheritedReads).toBe(0)

		let accessorReads = 0
		const accessor: StringShape = { type: 'string' }
		Object.defineProperty(accessor, 'description', {
			get() {
				accessorReads += 1
				return 'unsafe'
			},
		})
		const accessorEngine = new ShapeCloner(accessor)
		expect(() => accessorEngine.clone()).toThrow(
			'cloneShape: shape accessors cannot be owned faithfully',
		)
		expect(accessorReads).toBe(0)
	})

	it('owns the two-read pattern exception and completes collection observations during capture', () => {
		let patternReads = 0
		const source: StringShape = {
			type: 'string',
			get pattern() {
				patternReads += 1
				return Object.freeze(new RegExp('x'))
			},
		}
		const clone = new ShapeCloner(source).clone()
		expect(patternReads).toBe(2)
		if (clone.type !== 'string') throw new Error('expected string clone')
		const first = clone.pattern
		const second = clone.pattern
		expect(first).not.toBe(second)
		expect(first?.source).toBe('x')
		expect(first?.lastIndex).toBe(0)
		expect(Object.isFrozen(first)).toBe(true)

		let valueReads = 0
		let valueDescriptors = 0
		const values = new Proxy(['x'], {
			get(target, key, receiver) {
				if (key === '0') valueReads += 1
				return Reflect.get(target, key, receiver)
			},
			getOwnPropertyDescriptor(target, key) {
				if (key === '0') valueDescriptors += 1
				return Reflect.getOwnPropertyDescriptor(target, key)
			},
		})
		new ShapeCloner({ type: 'literal', values }).clone()
		expect(valueReads).toBe(2)
		expect(valueDescriptors).toBe(2)

		let variantReads = 0
		let variantDescriptors = 0
		const variants = new Proxy<readonly ContractShape[]>([{ type: 'string' }], {
			get(target, key, receiver) {
				if (key === '0') variantReads += 1
				return Reflect.get(target, key, receiver)
			},
			getOwnPropertyDescriptor(target, key) {
				if (key === '0') variantDescriptors += 1
				return Reflect.getOwnPropertyDescriptor(target, key)
			},
		})
		new ShapeCloner({ type: 'union', variants }).clone()
		expect(variantReads).toBe(2)
		expect(variantDescriptors).toBe(2)

		let keyReads = 0
		let childReads = 0
		const properties = new Proxy<Readonly<Record<string, ContractShape>>>(
			{ value: { type: 'string' } },
			{
				ownKeys(target) {
					keyReads += 1
					return Reflect.ownKeys(target)
				},
				get(target, key, receiver) {
					if (key === 'value') childReads += 1
					return Reflect.get(target, key, receiver)
				},
			},
		)
		new ShapeCloner({ type: 'object', properties }).clone()
		expect(keyReads).toBe(2)
		expect(childReads).toBe(2)
	})

	it('refuses native-maximum sparse union and literal populations before indexed work', () => {
		const union = createNativeMaximumSparseArray<ContractShape>()
		const unionError = captureContractError(() =>
			new ShapeCloner({ type: 'union', variants: union.value }).clone(),
		)
		expect(unionError.code).toBe('structure')
		expect(unionError.message).toBe('validateShape: variants must be a dense data array')
		expect(unionError.context?.path).toEqual(['variants'])
		expect(Object.hasOwn(unionError, 'cause')).toBe(false)
		expect(union.probes).toEqual([])

		const literal = createNativeMaximumSparseArray<LiteralValue>()
		const literalError = captureContractError(() =>
			new ShapeCloner({ type: 'literal', values: literal.value }).clone(),
		)
		expect(literalError.code).toBe('structure')
		expect(literalError.message).toBe('validateShape: values must be a dense data array')
		expect(literalError.context?.path).toEqual(['values'])
		expect(Object.hasOwn(literalError, 'cause')).toBe(false)
		expect(literal.probes).toEqual([])
	})

	it('orders literal fidelity reads and stops after the first invalid captured entry', () => {
		const reads = new Map<string, number>()
		const descriptors = new Map<string, number>()
		const values = new Proxy(['first', 'second', 'third'], {
			get(target, key, receiver) {
				if (key === '0' || key === '1' || key === '2') {
					reads.set(key, (reads.get(key) ?? 0) + 1)
					if (key === '1') return { invalid: true }
				}
				return Reflect.get(target, key, receiver)
			},
			getOwnPropertyDescriptor(target, key) {
				if (key === '0' || key === '1' || key === '2') {
					descriptors.set(key, (descriptors.get(key) ?? 0) + 1)
				}
				return Reflect.getOwnPropertyDescriptor(target, key)
			},
		})
		const error = captureContractError(() => new ShapeCloner({ type: 'literal', values }).clone())

		expect(error.message).toBe(
			'validateShape: every literal value must be a string, number, or boolean',
		)
		expect(error.context?.path).toEqual(['values', '1'])
		expect([...descriptors.entries()]).toEqual([
			['0', 2],
			['1', 2],
			['2', 1],
		])
		expect([...reads.entries()]).toEqual([
			['0', 2],
			['1', 2],
			['2', 1],
		])
	})

	it('preserves sharing, declaration-order paths, placement, and deep freezing while refusing cycles', () => {
		const shared: StringShape = { type: 'string' }
		const graph = new ShapeCloner({
			type: 'object',
			properties: { first: shared, second: shared },
		}).clone()
		if (graph.type !== 'object') throw new Error('expected object clone')
		expect(graph.properties.first).toBe(graph.properties.second)
		expect(Object.isFrozen(graph.properties)).toBe(true)
		expect(Object.isFrozen(graph.properties.first)).toBe(true)

		const cycle: { readonly type: 'array'; readonly items: ContractShape } = {
			type: 'array',
			items: shared,
		}
		Reflect.set(cycle, 'items', cycle)
		const cyclicError = captureContractError(() => new ShapeCloner(cycle).clone())
		expect(cyclicError.code).toBe('cycle')
		expect(cyclicError.context?.path).toEqual(['items'])

		const invalid: StringShape = { type: 'string', min: -1 }
		const declaration: ContractShape = {
			type: 'object',
			properties: { first: invalid, second: invalid },
		}
		const pathError = captureContractError(() => new ShapeCloner(declaration).clone())
		expect(pathError).toBeInstanceOf(ContractError)
		// DECLARATION order, not capture order: the LIFO drain this replaced named
		// the LAST offending sibling while `validateShape` named the first, so one
		// declaration produced two different `context.path` values.
		expect(pathError.context?.path).toEqual(['properties', 'first'])
		const validated = captureContractError(() => validateShape(declaration))
		expect(validated.code).toBe(pathError.code)
		expect(validated.message).toBe(pathError.message)
		expect(validated.context?.path).toEqual(pathError.context?.path)

		const optional: ContractShape = { type: 'optional', inner: shared }
		const placementEngine = new ShapeCloner({ type: 'array', items: optional })
		expect(() => placementEngine.clone()).toThrow(
			'validateShape: an optional shape may only appear as a direct object-property value',
		)
	})

	it('owns raw schemas, validates the completed root, and contains hostile failures itself', () => {
		const schema: JSONSchema = { type: 'object', properties: { value: { type: 'string' } } }
		const raw = new ShapeCloner({ type: 'raw', schema }).clone()
		if (raw.type !== 'raw') throw new Error('expected raw clone')
		expect(raw.schema).not.toBe(schema)
		expect(Object.isFrozen(raw.schema)).toBe(true)

		const malformed: StringShape = { type: 'string' }
		Reflect.set(malformed, 'description', 7)
		const validation = captureContractError(() => new ShapeCloner(malformed).clone())
		expect(validation.code).toBe('structure')
		expect(validation.message).toContain('validateShape')

		const sentinel = Object.freeze({ sentinel: true })
		const hostile = new Proxy<StringShape>(
			{ type: 'string' },
			{
				getOwnPropertyDescriptor() {
					throw sentinel
				},
			},
		)
		const engine = new ShapeCloner(hostile)
		const boundary = captureContractError(() => engine.clone())
		expect(boundary).toBeInstanceOf(ContractError)
		expect(boundary).not.toBe(sentinel)
		expect(boundary.code).toBe('clone')
		expect(boundary.cause).toBe(sentinel)
		expect(captureContractError(() => engine.clone())).toBe(boundary)
	})

	it('validates the completed root before applying the exact first fidelity error', () => {
		const valid: ContractShape = { type: 'string' }
		const replacement: ContractShape = { type: 'number' }
		let reads = 0
		const stableVariants = new Proxy<readonly ContractShape[]>([valid], {
			get(target, key, receiver) {
				if (key !== '0') return Reflect.get(target, key, receiver)
				reads += 1
				return reads === 1 ? valid : replacement
			},
		})
		const fidelityCloner = new ShapeCloner({ type: 'union', variants: stableVariants })
		const fidelity = captureContractError(() => fidelityCloner.clone())
		expect(fidelity.message).toBe('validateShape: every structural child must be a shape')
		expect(captureContractError(() => fidelityCloner.clone())).toBe(fidelity)

		const cycle: { readonly type: 'array'; readonly items: ContractShape } = {
			type: 'array',
			items: valid,
		}
		Reflect.set(cycle, 'items', cycle)
		let cycleReads = 0
		const cyclicVariants = new Proxy<readonly ContractShape[]>([cycle], {
			get(target, key, receiver) {
				if (key !== '0') return Reflect.get(target, key, receiver)
				cycleReads += 1
				return cycleReads === 1 ? cycle : replacement
			},
		})
		const validation = captureContractError(() =>
			new ShapeCloner({ type: 'union', variants: cyclicVariants }).clone(),
		)
		expect(validation.code).toBe('cycle')
	})

	it('applies bound then flags then range while ignoring own pattern accessors', () => {
		// The pattern is genuinely flagged, and its OWN `source` / `flags` accessors
		// are decoys the capture never consults: both are read through the accessors
		// captured from `RegExp.prototype`, which answer from the internal slots.
		// The read tallies are the proof — they stay at zero while the diagnostic
		// still quotes the pattern's real text.
		const pattern = /a/i
		pattern.lastIndex = 4
		let sourceReads = 0
		let flagsReads = 0
		let stringReads = 0
		Object.defineProperties(pattern, {
			flags: {
				get() {
					flagsReads += 1
					return 'i'
				},
			},
			source: {
				get() {
					sourceReads += 1
					return 'a'
				},
			},
			toString: {
				get() {
					stringReads += 1
					throw new Error('pattern stringification must not be observed')
				},
			},
		})
		const engine = new ShapeCloner({ type: 'string', min: 2, max: 1, pattern })
		const reason = captureContractError(() => engine.clone())
		expect(reason).toBeInstanceOf(ContractError)
		expect(reason.message).toBe(
			'validateShape: a string shape pattern must not use flags; use inline pattern constructs instead',
		)
		expect(reason.code).toBe('pattern')
		expect(reason.context).toEqual({ path: [], shape: 'string', received: '/a/i' })
		expect(reason.context?.limit).toBeUndefined()
		expect(Object.hasOwn(reason, 'cause')).toBe(false)
		expect(sourceReads).toBe(0)
		expect(flagsReads).toBe(0)
		expect(stringReads).toBe(0)

		const min = captureContractError(() =>
			new ShapeCloner({ type: 'string', min: -1, pattern: /a/i }).clone(),
		)
		expect(min.code).toBe('bound')
		expect(min.message).toContain('validateShape: a string shape min')
		const max = captureContractError(() =>
			new ShapeCloner({ type: 'string', max: -1, pattern: /a/i }).clone(),
		)
		expect(max.code).toBe('bound')
		expect(max.message).toContain('validateShape: a string shape max')
		const range = captureContractError(() =>
			new ShapeCloner({ type: 'string', min: 2, max: 1, pattern: /a/ }).clone(),
		)
		expect(range.code).toBe('range')

		const stable = /stable/
		stable.lastIndex = 3
		const clone = new ShapeCloner({ type: 'string', pattern: stable }).clone()
		if (clone.type !== 'string') throw new Error('expected string clone')
		const first = clone.pattern
		const second = clone.pattern
		expect(first).not.toBe(second)
		expect(first?.source).toBe('stable')
		expect(first?.flags).toBe('')
		expect(first?.lastIndex).toBe(0)
		expect(Object.isFrozen(first)).toBe(true)
	})

	it('ignores object-valued RegExp scalar decoys without coercion or caller retention', () => {
		// The decoy is an own `source` / `flags` property whose value is a mutable
		// carrier. It used to force a refusal because an ordinary `.source` read
		// returned the carrier; now the captured accessor answers from the internal
		// slots, so the clone publishes the pattern's REAL source and the carrier is
		// still never coerced — which was the guarantee the refusal was protecting.
		for (const fixture of [
			new PatternFixture('source', false),
			new PatternFixture('flags', false),
			new PatternFixture('source', true),
			new PatternFixture('flags', true),
		]) {
			const cloner = new ShapeCloner(fixture.shape)
			const clone = cloner.clone()
			if (clone.type !== 'string') throw new Error('expected a string clone')
			expect(clone.pattern?.source).toBe('a')
			expect(clone.pattern?.flags).toBe('')
			expect(fixture.carrier.count).toBe(0)
			fixture.carrier.change('b')
			expect(cloner.clone()).toBe(clone)
			expect(fixture.carrier.count).toBe(0)
		}

		const stable = /a/
		Object.defineProperties(stable, {
			flags: { get: () => '' },
			source: { get: () => 'a' },
		})
		const foreign = createForeignRegExp('a')
		if (!isRegExp(foreign)) throw new Error('expected a genuine foreign RegExp')
		const controls = [
			new ShapeCloner({ type: 'string', pattern: /a/ }).clone(),
			new ShapeCloner({ type: 'string', pattern: foreign }).clone(),
			new ShapeCloner({ type: 'string', pattern: stable }).clone(),
			new ShapeCloner(stringShape({ pattern: /a/ })).clone(),
		]
		for (const control of controls) {
			if (control.type !== 'string') throw new Error('expected a string clone')
			expect(control.pattern?.source).toBe('a')
			expect(Object.isFrozen(control.pattern)).toBe(true)
		}
	})

	it('never observes an own pattern accessor, so a single-read decoy is inert', () => {
		// The population that used to separate a capture schedule from a reread. It
		// separates nothing now: the own `source` accessor is never entered at all,
		// so its read tally stays at zero and the clone settles on the pattern's
		// genuine source. The fixture is retained as the control proving that.
		for (const accessor of [false, true]) {
			const fixture = new SingleReadPattern(accessor)
			const cloner = new ShapeCloner(fixture.shape)

			const clone = cloner.clone()

			if (clone.type !== 'string') throw new Error('expected a string clone')
			expect(clone.pattern?.source, `accessor ${String(accessor)}`).toBe('a')
			expect(fixture.reads, `accessor ${String(accessor)}`).toBe(0)
			expect(cloner.clone(), `accessor ${String(accessor)}`).toBe(clone)
		}
	})

	it('settles success and traversal failure before caller-mutated cleanup can run', () => {
		const successfulCloner = new ShapeCloner({ type: 'string' })
		const reason = new Error('shape traversal failed')
		const failingSource = new Proxy<StringShape>(
			{ type: 'string' },
			{
				getOwnPropertyDescriptor() {
					throw reason
				},
			},
		)
		const failedCloner = new ShapeCloner(failingSource)
		const failure = attempt(() => failedCloner.clone())
		const success = attempt(() => successfulCloner.clone())

		expect(success.success).toBe(true)
		if (!success.success) throw new Error('expected successful shape settlement')
		expect(successfulCloner.clone()).toBe(success.value)
		expect(failure.success).toBe(false)
		if (failure.success) throw new Error('expected failed shape settlement')
		expect(isContractError(failure.error)).toBe(true)
		if (!isContractError(failure.error)) throw new Error('expected a ContractError')
		expect(failure.error.cause).toBe(reason)
		expect(captureContractError(() => failedCloner.clone())).toBe(failure.error)
	})

	it('settles atomically while every terminal-path intrinsic is redirected by the caller', () => {
		const reason = new Error('shape traversal failed')
		const intrinsics: readonly TerminalIntrinsic[] = [
			{ label: 'WeakSet.prototype.has', target: WeakSet.prototype, key: 'has', via: 'replacement' },
			{ label: 'WeakSet.prototype.add', target: WeakSet.prototype, key: 'add', via: 'replacement' },
			{ label: 'Object.hasOwn', target: Object, key: 'hasOwn', via: 'replacement' },
			{ label: 'Object.prototype.cause', target: Object.prototype, key: 'cause', via: 'pollution' },
			{
				label: 'Object.prototype.context',
				target: Object.prototype,
				key: 'context',
				via: 'pollution',
			},
			{ label: 'Object.prototype.path', target: Object.prototype, key: 'path', via: 'pollution' },
		]
		const settled = { redirected: true, escaped: false, owned: true, caused: true, replayed: true }
		const observed: unknown[] = []

		for (const intrinsic of intrinsics) {
			const sentinel = Object.freeze({ stage: intrinsic.label })
			const failingSource = new Proxy<StringShape>(
				{ type: 'string' },
				{
					getOwnPropertyDescriptor() {
						throw reason
					},
				},
			)
			const cloners = [
				{ name: 'readable', cloner: new ShapeCloner({ type: 'string' }) },
				{ name: 'unreadable', cloner: new ShapeCloner(failingSource) },
			]

			for (const subject of cloners) {
				let redirected = false
				const first = redirectIntrinsic(intrinsic, sentinel, (armed) => {
					redirected = armed
					return attempt(() => subject.cloner.clone())
				})
				const replay = attempt(() => subject.cloner.clone())

				observed.push({
					intrinsic: intrinsic.label,
					source: subject.name,
					redirected,
					escaped: !first.success && first.error === sentinel,
					owned: first.success || isContractError(first.error),
					caused:
						first.success ||
						(isContractError(first.error) &&
							(first.error.cause === reason || first.error.cause === sentinel)),
					replayed: first.success
						? replay.success && replay.value === first.value
						: !replay.success && replay.error === first.error,
				})
			}
		}

		expect(observed).toEqual([
			{ intrinsic: 'WeakSet.prototype.has', source: 'readable', ...settled },
			{ intrinsic: 'WeakSet.prototype.has', source: 'unreadable', ...settled },
			{ intrinsic: 'WeakSet.prototype.add', source: 'readable', ...settled },
			{ intrinsic: 'WeakSet.prototype.add', source: 'unreadable', ...settled },
			{ intrinsic: 'Object.hasOwn', source: 'readable', ...settled },
			{ intrinsic: 'Object.hasOwn', source: 'unreadable', ...settled },
			{ intrinsic: 'Object.prototype.cause', source: 'readable', ...settled },
			{ intrinsic: 'Object.prototype.cause', source: 'unreadable', ...settled },
			{ intrinsic: 'Object.prototype.context', source: 'readable', ...settled },
			{ intrinsic: 'Object.prototype.context', source: 'unreadable', ...settled },
			{ intrinsic: 'Object.prototype.path', source: 'readable', ...settled },
			{ intrinsic: 'Object.prototype.path', source: 'unreadable', ...settled },
		])
	})

	it('keeps a cause-free structural refusal cause-free while the caller supplies an inherited cause', () => {
		const baseline = captureContractError(() => new ShapeCloner(new StringDeclaration()).clone())
		const polluted = pollutePrototype(
			Object.prototype,
			'cause',
			() => 'polluted',
			() => captureContractError(() => new ShapeCloner(new StringDeclaration()).clone()),
		)

		expect({
			baseline: Object.hasOwn(baseline, 'cause'),
			polluted: Object.hasOwn(polluted, 'cause'),
			code: polluted.code,
			message: polluted.message === baseline.message,
		}).toEqual({ baseline: false, polluted: false, code: 'structure', message: true })
	})

	it('refuses excessive iterative depth without leaking a recursive stack failure', () => {
		let source: ContractShape = { type: 'string' }
		for (let level = 0; level < 600; level += 1) source = { type: 'array', items: source }

		const error = captureContractError(() => new ShapeCloner(source).clone())

		expect(error.code).toBe('depth')
		expect(error).not.toBeInstanceOf(RangeError)
	})

	it('releases terminal working state while retaining exact failure and success replay', async () => {
		const control = createShapeRetention('control', true)
		captureContractError(() => new ShapeCloner(control.source).clone())
		control.release()

		const failed = createShapeRetention('failed', true)
		const failedCloner = new ShapeCloner(failed.source)
		const terminalError = captureContractError(() => failedCloner.clone())
		failed.release()

		const successful = createShapeRetention('success', false)
		const successfulCloner = new ShapeCloner(successful.source)
		const terminalRoot = successfulCloner.clone()
		successful.release()

		await requestWeakReferenceCollection([
			control.reference,
			failed.reference,
			successful.reference,
		])

		expect(
			[control.reference, failed.reference, successful.reference].map(
				(reference) => reference.deref() === undefined,
			),
		).toEqual([true, true, true])
		expect(captureContractError(() => failedCloner.clone())).toBe(terminalError)
		expect(successfulCloner.clone()).toBe(terminalRoot)
	})

	it('releases the variant population that no property population can reach', async () => {
		const control = createVariantRetention('control', true)
		captureContractError(() => new ShapeCloner(control.source).clone())
		control.release()

		const failed = createVariantRetention('failed', true)
		const failedCloner = new ShapeCloner(failed.source)
		const terminalError = captureContractError(() => failedCloner.clone())
		failed.release()

		const successful = createVariantRetention('success', false)
		const successfulCloner = new ShapeCloner(successful.source)
		const terminalRoot = successfulCloner.clone()
		successful.release()

		await requestWeakReferenceCollection([
			control.reference,
			failed.reference,
			successful.reference,
		])

		expect(
			[control.reference, failed.reference, successful.reference].map(
				(reference) => reference.deref() === undefined,
			),
		).toEqual([true, true, true])
		expect(captureContractError(() => failedCloner.clone())).toBe(terminalError)
		expect(successfulCloner.clone()).toBe(terminalRoot)
	})
})

describe('the property snapshot survives an arity-preserving iterator lie', () => {
	// The refinement that defeated the previous round: a lie need not ADD. The
	// corpus's only iterator row PREPENDS, which changes arity and lands a marker
	// where a shape is expected, so every downstream structural check catches it.
	// A SUBSTITUTION of the same arity passes all of them and reaches publication
	// — here, renaming a property inside a frozen snapshot the package publishes
	// as exact.
	const shape = objectShape({
		name: stringShape({ min: 1 }),
		age: optionalShape(integerShape({ min: 0 })),
		tags: arrayShape(stringShape()),
	})

	it('publishes the declared property names, not the caller substitution', () => {
		const genuine = Array.prototype[Symbol.iterator]
		function* substituteFirst(this: readonly unknown[]): Generator<unknown> {
			if (this.length === 2 && this[0] === 'name') {
				yield 'ghost'
				yield this[1]
				return
			}
			const inner: unknown = Reflect.apply(genuine, this, [])
			if (inner === null || typeof inner !== 'object') return
			for (;;) {
				const next: unknown = Reflect.get(inner, 'next')
				if (typeof next !== 'function') return
				const step: unknown = Reflect.apply(next, inner, [])
				if (step === null || typeof step !== 'object') return
				if (Reflect.get(step, 'done') === true) return
				yield Reflect.get(step, 'value')
			}
		}
		const published = replaceIntrinsic(Array.prototype, Symbol.iterator, substituteFirst, () =>
			attempt(() => JSON.stringify(cloneShape(shape))),
		)

		expect(published.success).toBe(true)
		expect(published.success ? String(published.value) : '').not.toContain('ghost')
		expect(published.success ? String(published.value) : '').toContain('"name"')
	})

	it('carries the same guarantee into the compiled schema', () => {
		const genuine = Array.prototype[Symbol.iterator]
		function* substituteFirst(this: readonly unknown[]): Generator<unknown> {
			if (this.length === 2 && this[0] === 'name') {
				yield 'ghost'
				yield this[1]
				return
			}
			const inner: unknown = Reflect.apply(genuine, this, [])
			if (inner === null || typeof inner !== 'object') return
			for (;;) {
				const next: unknown = Reflect.get(inner, 'next')
				if (typeof next !== 'function') return
				const step: unknown = Reflect.apply(next, inner, [])
				if (step === null || typeof step !== 'object') return
				if (Reflect.get(step, 'done') === true) return
				yield Reflect.get(step, 'value')
			}
		}
		const published = replaceIntrinsic(Array.prototype, Symbol.iterator, substituteFirst, () =>
			attempt(() => JSON.stringify(compileSchema(shape))),
		)

		expect(published.success).toBe(true)
		expect(published.success ? String(published.value) : '').not.toContain('ghost')
	})
})

describe('ShapeCloner — one arbiter, one verdict (H9)', () => {
	it('names the same rule at the same path as validateShape for one declaration', () => {
		// The guide names `cloneShape`, `ownShape`, `validateShape`, `compileSchema`,
		// `compileGuard` and `createContract` in one sentence as agreeing. They did
		// not: capture-time domain refusals fired in LIFO capture order, before the
		// validator's structure -> cycle -> domain precedence could apply.
		// Each unrecognized discriminant is a real declaration corrupted
		// reflectively rather than an assertion: the point of the case is that the
		// walk meets a node whose `type` it does not know, and an assertion would
		// have moved that fact out of the value and into the type system.
		const bogus: ContractShape = { type: 'string' }
		Reflect.set(bogus, 'type', 'bogus')
		const bogusA: ContractShape = { type: 'string' }
		Reflect.set(bogusA, 'type', 'bogusA')
		const bogusB: ContractShape = { type: 'string' }
		Reflect.set(bogusB, 'type', 'bogusB')

		const declarations: readonly ContractShape[] = [
			{
				type: 'object',
				properties: {
					b: bogus,
					a: { type: 'number', min: 5, max: 1 },
				},
			},
			{
				type: 'object',
				properties: {
					first: { type: 'number', min: 5, max: 1 },
					second: { type: 'number', min: 9, max: 2 },
				},
			},
			{ type: 'union', variants: [bogusA, bogusB] },
			{ type: 'array', items: { type: 'string', min: -1 } },
			{ type: 'array', items: optionalShape(stringShape()) },
		]

		for (const declaration of declarations) {
			const reference = captureContractError(() => validateShape(declaration))
			for (const door of [cloneShape, compileSchema, compileGuard, createContract]) {
				const observed = captureContractError(() => door(declaration))
				expect([observed.code, observed.message, observed.context?.path]).toEqual([
					reference.code,
					reference.message,
					reference.context?.path,
				])
			}
		}
	})

	it('reaches the depth verdict in time proportional to the limit, not to the declaration', () => {
		// Capture materialised the ENTIRE over-limit graph — wiring and freezing a
		// declaration certain to be refused — before the depth gate ever ran, and
		// every child registration copies its whole path, so the cost was quadratic:
		// 4,000 levels took 142 ms against `validateShape`'s 2 ms for the identical
		// verdict.
		let declaration: ContractShape = { type: 'string' }
		for (let index = 0; index < 8_000; index += 1) {
			declaration = { type: 'array', items: declaration }
		}

		const reference = captureContractError(() => validateShape(declaration))
		const started = Date.now()
		const observed = captureContractError(() => cloneShape(declaration))
		const elapsed = Date.now() - started

		expect(observed.code).toBe('depth')
		expect(observed.message).toBe(reference.message)
		expect(observed.context?.path).toEqual(reference.context?.path)
		expect(elapsed).toBeLessThan(500)

		// Control: the boundary itself is unmoved — the last legal depth still
		// clones, and the first illegal one still refuses.
		let legal: ContractShape = { type: 'string' }
		for (let index = 0; index < COMPILE_DEPTH_LIMIT; index += 1) {
			legal = { type: 'array', items: legal }
		}
		expect(() => cloneShape(legal)).not.toThrow()
		expect(captureContractError(() => cloneShape({ type: 'array', items: legal })).code).toBe(
			'depth',
		)
	})
})
