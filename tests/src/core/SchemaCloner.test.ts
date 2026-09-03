import type { JSONSchema, SchemaClonerInterface } from '@src/core'
import type { TerminalIntrinsic } from '../../setup.js'
import {
	attempt,
	COMPILE_DEPTH_LIMIT,
	ContractError,
	isContractError,
	SchemaCloner,
} from '@src/core'
import {
	ArrayRootSchema,
	captureContractError,
	createRevokedProxy,
	createSchemaRetention,
	pollutePrototype,
	redirectIntrinsic,
} from '../../setup.js'
import { requestWeakReferenceCollection } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('SchemaCloner', () => {
	it('is root-exported, conforms to its interface, and exposes only clone', () => {
		const cloner: SchemaClonerInterface = new SchemaCloner({ type: 'string' })

		expect(cloner.clone()).toEqual({ type: 'string' })
		expect(Reflect.ownKeys(SchemaCloner.prototype)).toEqual(['constructor', 'clone'])
	})

	it('does not observe the retained source during construction', () => {
		const source = Proxy.revocable<JSONSchema>({}, {})
		source.revoke()

		const cloner = new SchemaCloner(source.proxy)

		expect(cloner).toBeInstanceOf(SchemaCloner)
	})

	it('settles success once and replays the exact frozen root without rereading', () => {
		let observations = 0
		const source = new Proxy<JSONSchema>(
			{ anyOf: [{ type: 'string' }] },
			{
				get(target, key, receiver) {
					observations += 1
					return Reflect.get(target, key, receiver)
				},
				getOwnPropertyDescriptor(target, key) {
					observations += 1
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
				ownKeys(target) {
					observations += 1
					return Reflect.ownKeys(target)
				},
			},
		)
		const cloner = new SchemaCloner(source)
		const first = cloner.clone()
		const settled = observations
		const second = cloner.clone()

		expect(second).toBe(first)
		expect(observations).toBe(settled)
		expect(Object.isFrozen(first)).toBe(true)
	})

	it('settles failure once and rethrows the exact owned error without rereading', () => {
		let observations = 0
		const caller = new ContractError('caller', { code: 'clone' })
		const source = new Proxy<JSONSchema>(
			{},
			{
				ownKeys() {
					observations += 1
					throw caller
				},
			},
		)
		const cloner = new SchemaCloner(source)
		const first = captureContractError(() => cloner.clone())
		const settled = observations
		const second = captureContractError(() => cloner.clone())

		expect(second).toBe(first)
		expect(first).not.toBe(caller)
		expect(observations).toBe(settled)
		expect(first.message).toBe('cloneSchema: property enumeration failed')
		expect(first.context).toEqual({ path: [], shape: 'schema' })
		expect(Object.hasOwn(first, 'cause')).toBe(false)
	})

	it('keeps distinct instances independent', () => {
		let observations = 0
		const source = new Proxy<JSONSchema>(
			{ type: 'string' },
			{
				ownKeys(target) {
					observations += 1
					return Reflect.ownKeys(target)
				},
			},
		)
		const first = new SchemaCloner(source).clone()
		const afterFirst = observations
		const second = new SchemaCloner(source).clone()

		expect(second).not.toBe(first)
		expect(second).toEqual(first)
		expect(observations).toBeGreaterThan(afterFirst)
	})

	it('promotes caught reentry followed by apparent success to the shared poison', () => {
		const state: { cloner: SchemaClonerInterface | undefined; nested: unknown } = {
			cloner: undefined,
			nested: undefined,
		}
		const source = new Proxy<JSONSchema>(
			{},
			{
				ownKeys() {
					const cloner = state.cloner
					if (cloner === undefined) throw new Error('cloner must be initialized')
					state.nested = captureContractError(() => cloner.clone())
					return []
				},
			},
		)
		state.cloner = new SchemaCloner(source)

		const outer = captureContractError(() => state.cloner?.clone())
		const later = captureContractError(() => state.cloner?.clone())

		expect(state.nested).toBe(outer)
		expect(later).toBe(outer)
		expect(outer.message).toBe('SchemaCloner.clone: schema cloning may not be reentered')
		expect(outer.code).toBe('clone')
		expect(outer.context).toEqual({ shape: 'schema' })
		expect(Object.hasOwn(outer, 'cause')).toBe(false)
	})

	it('promotes uncaught reentry to the shared terminal poison', () => {
		const state: { cloner: SchemaClonerInterface | undefined } = { cloner: undefined }
		const source = new Proxy<JSONSchema>(
			{},
			{
				ownKeys() {
					if (state.cloner === undefined) throw new Error('cloner must be initialized')
					state.cloner.clone()
					return []
				},
			},
		)
		state.cloner = new SchemaCloner(source)

		const outer = captureContractError(() => state.cloner?.clone())
		const later = captureContractError(() => state.cloner?.clone())

		expect(later).toBe(outer)
		expect(outer.message).toBe('SchemaCloner.clone: schema cloning may not be reentered')
		expect(Object.hasOwn(outer, 'cause')).toBe(false)
	})

	it('keeps caught reentry ahead of a later replacement failure', () => {
		const replacement = new Error('replacement')
		const state: { cloner: SchemaClonerInterface | undefined; nested: unknown } = {
			cloner: undefined,
			nested: undefined,
		}
		const source = new Proxy<JSONSchema>(
			{},
			{
				get(_target, key) {
					if (key === 'first') {
						const cloner = state.cloner
						if (cloner === undefined) throw new Error('cloner must be initialized')
						state.nested = captureContractError(() => cloner.clone())
						return { type: 'string' }
					}
					throw replacement
				},
				getOwnPropertyDescriptor() {
					return { enumerable: true, configurable: true }
				},
				ownKeys() {
					return ['first', 'bad']
				},
			},
		)
		state.cloner = new SchemaCloner(source)

		const outer = captureContractError(() => state.cloner?.clone())
		const later = captureContractError(() => state.cloner?.clone())

		expect(state.nested).toBe(outer)
		expect(later).toBe(outer)
		expect(outer).not.toBe(replacement)
		expect(Object.hasOwn(outer, 'cause')).toBe(false)
	})

	it('keeps enumeration cause-free and retains exact property causes by provenance', () => {
		const caller = new ContractError('caller owned', { code: 'clone' })
		const enumeration = new Proxy<JSONSchema>(
			{},
			{
				ownKeys() {
					throw caller
				},
			},
		)
		const enumerationError = captureContractError(() => new SchemaCloner(enumeration).clone())

		const property = new Proxy<JSONSchema>(
			{},
			{
				get() {
					throw caller
				},
				getOwnPropertyDescriptor() {
					return { enumerable: true, configurable: true }
				},
				ownKeys() {
					return ['type']
				},
			},
		)
		const propertyError = captureContractError(() => new SchemaCloner(property).clone())

		expect(enumerationError).not.toBe(caller)
		expect(Object.hasOwn(enumerationError, 'cause')).toBe(false)
		expect(propertyError).not.toBe(caller)
		expect(propertyError.message).toBe('cloneSchema: property access failed')
		expect(propertyError.context).toEqual({ path: ['type'], shape: 'schema' })
		expect(propertyError.cause).toBe(caller)
	})

	it('retains an explicit thrown undefined as an own cause', () => {
		const source: JSONSchema = {}
		Object.defineProperty(source, 'type', {
			enumerable: true,
			get() {
				throw undefined
			},
		})

		const error = captureContractError(() => new SchemaCloner(source).clone())

		expect(error.message).toBe('cloneSchema: property access failed')
		expect(error.context).toEqual({ path: ['type'], shape: 'schema' })
		expect(Object.hasOwn(error, 'cause')).toBe(true)
		expect(error.cause).toBeUndefined()
	})

	it('reports the exact nested property path', () => {
		const cause = { reason: 'nested' }
		const leaf: JSONSchema = {}
		Object.defineProperty(leaf, 'type', {
			enumerable: true,
			get() {
				throw cause
			},
		})
		const source: JSONSchema = { properties: { field: leaf } }

		const error = captureContractError(() => new SchemaCloner(source).clone())

		expect(error.context).toEqual({
			path: ['properties', 'field', 'type'],
			shape: 'schema',
		})
		expect(error.cause).toBe(cause)
	})

	it('wraps an unexpected foreign failure once with its exact host cause category', () => {
		const revoked = Proxy.revocable<JSONSchema>({}, {})
		revoked.revoke()
		const source = new Proxy<JSONSchema>(
			{},
			{
				get() {
					return revoked.proxy
				},
				getOwnPropertyDescriptor() {
					return { enumerable: true, configurable: true }
				},
				ownKeys() {
					return ['items']
				},
			},
		)

		const error = captureContractError(() => new SchemaCloner(source).clone())

		expect(error.message).toBe('cloneSchema: failed to create an owned schema snapshot')
		expect(error.context).toEqual({ shape: 'schema' })
		expect(error.cause).toBeInstanceOf(TypeError)
	})

	it('deep-clones and freezes a nested schema without touching the source', () => {
		const leaf: JSONSchema = { type: 'string', description: 'source' }
		const items: JSONSchema = { type: 'array', items: leaf }
		const properties: Record<string, JSONSchema> = { values: items }
		const source: JSONSchema = { type: 'object', properties }
		const clone = new SchemaCloner(source).clone()

		expect(clone).toEqual(source)
		expect(clone).not.toBe(source)
		expect(clone.properties).not.toBe(properties)
		expect(clone.properties?.values).not.toBe(items)
		expect(clone.properties?.values?.items).not.toBe(leaf)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(Object.isFrozen(clone.properties)).toBe(true)
		expect(Object.isFrozen(clone.properties?.values)).toBe(true)
		expect(Object.isFrozen(clone.properties?.values?.items)).toBe(true)
		expect(Object.isFrozen(source)).toBe(false)
		expect(Object.isFrozen(properties)).toBe(false)
		expect(Object.isFrozen(items)).toBe(false)
		expect(Object.isFrozen(leaf)).toBe(false)
	})

	it('preserves shared identity and closes cycles onto the clone', () => {
		const child: JSONSchema = { type: 'integer' }
		const shared: JSONSchema = { anyOf: [child, child] }
		const sharedClone = new SchemaCloner(shared).clone()
		expect(sharedClone.anyOf?.[0]).toBe(sharedClone.anyOf?.[1])
		expect(sharedClone.anyOf?.[0]).not.toBe(child)

		const cycle: JSONSchema = {}
		Reflect.set(cycle, 'self', cycle)
		const cycleClone = new SchemaCloner(cycle).clone()
		expect(Reflect.get(cycleClone, 'self')).toBe(cycleClone)
		expect(cycleClone).not.toBe(cycle)
		expect(Object.isFrozen(cycleClone)).toBe(true)
	})

	it('severs prototypes and copies only own enumerable string properties in order', () => {
		const symbol = Symbol('hidden')
		const prototype = { inherited: 'source' }
		const source: JSONSchema = Object.create(prototype)
		Reflect.set(source, '10', 'ten')
		Reflect.set(source, '2', 'two')
		Reflect.set(source, 'first', 'value')
		Object.defineProperty(source, 'explicit', {
			value: undefined,
			enumerable: true,
			configurable: true,
			writable: true,
		})
		Object.defineProperty(source, 'hidden', { value: 'hidden', enumerable: false })
		Object.defineProperty(source, symbol, { value: 'symbol', enumerable: true })
		Reflect.set(source, 'last', 'value')

		const clone = new SchemaCloner(source).clone()

		expect(Object.getPrototypeOf(clone)).toBeNull()
		expect(Reflect.ownKeys(clone)).toEqual(['2', '10', 'first', 'explicit', 'last'])
		expect(Object.hasOwn(clone, 'explicit')).toBe(true)
		expect(Reflect.get(clone, 'explicit')).toBeUndefined()
		expect(Reflect.get(clone, 'inherited')).toBeUndefined()
		expect(Reflect.get(clone, 'hidden')).toBeUndefined()
		expect(Reflect.get(clone, symbol)).toBeUndefined()
		expect(Object.getOwnPropertyDescriptor(clone, 'explicit')).toEqual({
			value: undefined,
			enumerable: true,
			configurable: false,
			writable: false,
		})
	})

	it('preserves sparse and decorated array enumerable-string populations', () => {
		const symbol = Symbol('array')
		const variants: JSONSchema[] = []
		variants.length = 3
		variants[1] = { type: 'string' }
		Object.defineProperty(variants, 'note', {
			value: undefined,
			enumerable: true,
			configurable: true,
			writable: true,
		})
		Object.defineProperty(variants, 'hidden', { value: 'hidden', enumerable: false })
		Object.defineProperty(variants, symbol, { value: 'symbol', enumerable: true })

		const clone = new SchemaCloner({ anyOf: variants }).clone()
		const cloneVariants = clone.anyOf
		if (cloneVariants === undefined) throw new Error('expected cloned variants')

		expect(Array.isArray(cloneVariants)).toBe(true)
		expect(cloneVariants.length).toBe(2)
		expect(Object.hasOwn(cloneVariants, '0')).toBe(false)
		expect(Object.hasOwn(cloneVariants, '1')).toBe(true)
		expect(Object.keys(cloneVariants)).toEqual(['1', 'note'])
		expect(Object.hasOwn(cloneVariants, 'note')).toBe(true)
		expect(Reflect.get(cloneVariants, 'note')).toBeUndefined()
		expect(Reflect.get(cloneVariants, 'hidden')).toBeUndefined()
		expect(Reflect.get(cloneVariants, symbol)).toBeUndefined()
		expect(Object.isFrozen(cloneVariants)).toBe(true)
	})

	it('observes each population once, reads each returned key once, and drains children LIFO', () => {
		const observations: string[] = []
		const first = new Proxy<JSONSchema>(
			{ type: 'string' },
			{
				get(target, key, receiver) {
					observations.push(`first:get:${String(key)}`)
					return Reflect.get(target, key, receiver)
				},
				getOwnPropertyDescriptor(target, key) {
					observations.push(`first:descriptor:${String(key)}`)
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
				ownKeys(target) {
					observations.push('first:keys')
					return Reflect.ownKeys(target)
				},
			},
		)
		const second = new Proxy<JSONSchema>(
			{ type: 'number' },
			{
				get(target, key, receiver) {
					observations.push(`second:get:${String(key)}`)
					return Reflect.get(target, key, receiver)
				},
				getOwnPropertyDescriptor(target, key) {
					observations.push(`second:descriptor:${String(key)}`)
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
				ownKeys(target) {
					observations.push('second:keys')
					return Reflect.ownKeys(target)
				},
			},
		)
		const source = new Proxy<JSONSchema>(
			{},
			{
				get(_target, key) {
					observations.push(`root:get:${String(key)}`)
					return key === 'first' ? first : second
				},
				getOwnPropertyDescriptor(_target, key) {
					observations.push(`root:descriptor:${String(key)}`)
					return { enumerable: true, configurable: true }
				},
				ownKeys() {
					observations.push('root:keys')
					return ['first', 'second']
				},
			},
		)

		new SchemaCloner(source).clone()

		expect(observations).toEqual([
			'root:keys',
			'root:descriptor:first',
			'root:descriptor:second',
			'root:get:first',
			'root:get:second',
			'second:keys',
			'second:descriptor:type',
			'second:get:type',
			'first:keys',
			'first:descriptor:type',
			'first:get:type',
		])
	})

	it('clones to the shared depth limit without recursive call-stack pressure, and refuses past it', () => {
		let legal: JSONSchema = { type: 'string' }
		for (let index = 0; index < COMPILE_DEPTH_LIMIT; index += 1) legal = { items: legal }

		let current: JSONSchema | undefined = new SchemaCloner(legal).clone()
		for (let index = 0; index < COMPILE_DEPTH_LIMIT; index += 1) {
			if (current === undefined) throw new Error(`expected schema at depth ${index}`)
			if (!Object.isFrozen(current)) throw new Error(`expected frozen schema at depth ${index}`)
			current = current.items
		}
		expect(current).toEqual({ type: 'string' })

		// This door carried no depth bound at all while every other public
		// traversal carried one, and its per-key path copy makes the walk
		// quadratic: 16,000 levels of `{ items: … }` — a few hundred kilobytes of
		// text — used to cost tens of seconds. The verdict is now reached in time
		// proportional to the LIMIT, and it is a coded refusal rather than a host
		// `RangeError`.
		let excessive: JSONSchema = { type: 'string' }
		for (let index = 0; index < 20_000; index += 1) excessive = { items: excessive }
		const started = performance.now()
		const error = captureContractError(() => new SchemaCloner(excessive).clone())
		expect(error.code).toBe('depth')
		expect(error.message).toBe('cloneSchema: schema exceeds the compilation depth limit')
		expect(error.context?.limit).toBe(COMPILE_DEPTH_LIMIT)
		expect(performance.now() - started).toBeLessThan(1_000)
	})

	it('refuses an array root rather than republishing it as a record', () => {
		// `#schedule` has always branded a NESTED array as an array, so one
		// construct got two answers depending on position: `cloneSchema([node])`
		// published a null-prototype record whose `Array.isArray` was false, while
		// the same array nested under `anyOf` kept its brand.
		// A genuine `Array` exotic object that also satisfies `JSONSchema`, so the
		// root really is an array rather than a value asserted into position.
		const root = new ArrayRootSchema()
		root[0] = { type: 'string' }
		expect(Array.isArray(root)).toBe(true)

		const error = captureContractError(() => new SchemaCloner(root).clone())
		expect(error.code).toBe('structure')
		expect(error.message).toBe('cloneSchema: a schema root must be a record, not an array')

		const nested = new SchemaCloner({ anyOf: [{ type: 'string' }] }).clone()
		expect(Array.isArray(nested.anyOf)).toBe(true)
	})

	it('settles success and traversal failure before caller-mutated cleanup can run', () => {
		const successfulCloner = new SchemaCloner({ type: 'string' })
		const reason = new Error('schema traversal failed')
		const failingSource = new Proxy<JSONSchema>(
			{},
			{
				get() {
					throw reason
				},
				getOwnPropertyDescriptor() {
					return { configurable: true, enumerable: true }
				},
				ownKeys() {
					return ['bad']
				},
			},
		)
		const failedCloner = new SchemaCloner(failingSource)
		const failure = attempt(() => failedCloner.clone())
		const success = attempt(() => successfulCloner.clone())

		expect(success.success).toBe(true)
		if (!success.success) throw new Error('expected successful schema settlement')
		expect(successfulCloner.clone()).toBe(success.value)
		expect(failure.success).toBe(false)
		if (failure.success) throw new Error('expected failed schema settlement')
		if (!isContractError(failure.error)) throw new Error('expected a ContractError')
		expect({
			cause: failure.error.cause === reason,
			replay: captureContractError(() => failedCloner.clone()) === failure.error,
		}).toEqual({ cause: true, replay: true })
	})

	it('settles atomically while every terminal-path intrinsic is redirected by the caller', () => {
		const reason = new Error('schema traversal failed')
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
			const failingSource = new Proxy<JSONSchema>(
				{},
				{
					get() {
						throw reason
					},
					getOwnPropertyDescriptor() {
						return { configurable: true, enumerable: true }
					},
					ownKeys() {
						return ['bad']
					},
				},
			)
			const cloners = [
				{ name: 'readable', cloner: new SchemaCloner({ type: 'string' }) },
				{ name: 'unreadable', cloner: new SchemaCloner(failingSource) },
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

	it('translates a foreign traversal failure without reading an inherited diagnostic path', () => {
		// The one construction that reads `path` off an options container that
		// carries only `cause`: a failure the engine did NOT create. A revoked
		// child makes `Array.isArray` throw a host `TypeError` out of the walk,
		// which reaches translation as a foreign value.
		const source: JSONSchema = {}
		Reflect.set(source, 'items', createRevokedProxy())
		const cloner = new SchemaCloner(source)
		const first = pollutePrototype(
			Object.prototype,
			'path',
			() => ['polluted'],
			() => attempt(() => cloner.clone()),
		)
		const replay = attempt(() => cloner.clone())

		expect({
			owned: !first.success && isContractError(first.error),
			code: !first.success && isContractError(first.error) ? first.error.code : undefined,
			shape:
				!first.success && isContractError(first.error) ? first.error.context?.shape : undefined,
			path: !first.success && isContractError(first.error) ? first.error.context?.path : undefined,
			caused:
				!first.success && isContractError(first.error) && first.error.cause instanceof TypeError,
			replayed: !first.success && !replay.success && replay.error === first.error,
		}).toEqual({
			owned: true,
			code: 'clone',
			shape: 'schema',
			path: undefined,
			caused: true,
			replayed: true,
		})
	})

	it('releases terminal working state while retaining exact failure and success replay', async () => {
		const control = createSchemaRetention('control', true)
		captureContractError(() => new SchemaCloner(control.fixture.source).clone())
		control.fixture.release()

		const failed = createSchemaRetention('failed', true)
		const failedCloner = new SchemaCloner(failed.fixture.source)
		const terminalError = captureContractError(() => failedCloner.clone())
		failed.fixture.release()

		const successful = createSchemaRetention('success', false)
		const successfulCloner = new SchemaCloner(successful.fixture.source)
		const terminalRoot = successfulCloner.clone()
		successful.fixture.release()

		await requestWeakReferenceCollection([
			control.fixture.reference,
			failed.fixture.reference,
			successful.fixture.reference,
		])

		expect(
			[control.fixture.reference, failed.fixture.reference, successful.fixture.reference].map(
				(reference) => reference.deref() === undefined,
			),
		).toEqual([true, true, true])
		expect(captureContractError(() => failedCloner.clone())).toBe(terminalError)
		expect(successfulCloner.clone()).toBe(terminalRoot)
	})
})
