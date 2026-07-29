import type { ContractShape, JSONRecord, JSONSchema } from '@src/core'
import {
	arrayShape,
	cloneJSONRecord,
	cloneJSONValue,
	cloneSchema,
	cloneShape,
	compileGuard,
	compileSchema,
	ContractError,
	createContract,
	isRecord,
	objectShape,
	ownShape,
	stringShape,
	unionShape,
} from '@src/core'
import { captureContractError } from '../../setup.js'
import { describe, expect, it } from 'vitest'

describe('cloneJSONValue', () => {
	it('keeps finite primitives, exposes one-argument functions, and narrows record roots', () => {
		expect(cloneJSONValue.length).toBe(1)
		expect(cloneJSONRecord.length).toBe(1)

		for (const value of [
			null,
			'',
			'value',
			true,
			false,
			0,
			-0,
			Number.MIN_VALUE,
			Number.MAX_VALUE,
		]) {
			expect(Object.is(cloneJSONValue(value), value)).toBe(true)
		}

		const record: JSONRecord = cloneJSONRecord({ attempt: 1 })
		expect(record).toEqual({ attempt: 1 })
		expect(Object.getPrototypeOf(record)).toBeNull()
		expect(Object.isFrozen(record)).toBe(true)

		const emptyArray = cloneJSONValue(Object.freeze([]))
		expect(emptyArray).toEqual([])
		expect(Object.getPrototypeOf(emptyArray)).toBe(Array.prototype)
		expect(Object.isFrozen(emptyArray)).toBe(true)

		const emptySource: Record<string, unknown> = Object.create(null)
		const emptyRecord = cloneJSONRecord(emptySource)
		expect(Reflect.ownKeys(emptyRecord)).toEqual([])
		expect(Object.getPrototypeOf(emptyRecord)).toBeNull()
		expect(Object.isFrozen(emptyRecord)).toBe(true)

		for (const value of [null, [], 'record']) {
			const error = captureContractError(() => cloneJSONRecord(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}

		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const error = captureContractError(() => cloneJSONValue(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}
	})

	it('creates a deeply frozen caller-independent graph with normalized prototypes', () => {
		const source = { nested: [{ value: 'stable' }] }
		const clone = cloneJSONValue(source)

		const first = source.nested[0]
		if (first === undefined) throw new Error('expected source child')
		first.value = 'mutated'
		source.nested.push({ value: 'added' })
		expect(clone).toEqual({ nested: [{ value: 'stable' }] })
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(Object.getPrototypeOf(clone)).toBeNull()
		if (!isRecord(clone)) return

		const nested: unknown = clone.nested
		expect(Array.isArray(nested)).toBe(true)
		if (!Array.isArray(nested)) return
		expect(nested).not.toBe(source.nested)
		expect(Object.getPrototypeOf(nested)).toBe(Array.prototype)
		expect(Object.isFrozen(nested)).toBe(true)

		const child: unknown = nested[0]
		expect(isRecord(child)).toBe(true)
		if (!isRecord(child)) return
		expect(child).not.toBe(source.nested[0])
		expect(Object.getPrototypeOf(child)).toBeNull()
		expect(Object.isFrozen(child)).toBe(true)
	})

	it('preserves __proto__ as own data in deterministic key order', () => {
		const special: Record<string, unknown> = Object.create(null)
		special.first = 1
		Object.defineProperty(special, '__proto__', {
			value: 'data',
			enumerable: true,
			configurable: true,
			writable: true,
		})
		special.last = 2
		const clone = cloneJSONRecord(special)

		expect(Object.getPrototypeOf(clone)).toBeNull()
		expect(Object.prototype.hasOwnProperty.call(clone, '__proto__')).toBe(true)
		expect(Reflect.get(clone, '__proto__')).toBe('data')
		expect(Reflect.ownKeys(clone)).toEqual(['first', '__proto__', 'last'])
	})

	it('duplicates repeated noncyclic aliases as independent JSON tree branches', () => {
		const shared = { nested: [1, 2, 3] }
		const clone = cloneJSONRecord({ first: shared, second: shared })

		expect(clone.first).toEqual(clone.second)
		expect(clone.first).not.toBe(clone.second)
		if (!isRecord(clone.first) || !isRecord(clone.second)) {
			throw new Error('expected cloned records')
		}
		expect(clone.first.nested).not.toBe(clone.second.nested)
		expect(Object.isFrozen(clone.first)).toBe(true)
		expect(Object.isFrozen(clone.second)).toBe(true)
	})

	it('rejects direct and indirect cycles', () => {
		const direct: unknown[] = []
		direct.push(direct)
		const first: Record<string, unknown> = {}
		const second: Record<string, unknown> = { first }
		first.second = second

		for (const value of [direct, first]) {
			const error = captureContractError(() => cloneJSONValue(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}
	})

	it('accepts realm-agnostic record and array brands but rejects custom records', () => {
		const foreignPrototype = Object.create(null)
		const foreignRecord: Record<string, unknown> = Object.create(foreignPrototype)
		foreignRecord.value = 1
		const foreignArray: unknown[] = [foreignRecord]
		Object.setPrototypeOf(foreignArray, null)

		expect(isRecord(foreignRecord)).toBe(true)
		expect(Array.isArray(foreignArray)).toBe(true)
		expect(foreignArray instanceof Array).toBe(false)

		const clone = cloneJSONValue(foreignArray)
		expect(Array.isArray(clone)).toBe(true)
		if (!Array.isArray(clone)) throw new Error('expected cloned array')
		expect(Object.getPrototypeOf(clone)).toBe(Array.prototype)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(isRecord(clone[0])).toBe(true)
		if (!isRecord(clone[0])) throw new Error('expected cloned record')
		expect(Object.getPrototypeOf(clone[0])).toBeNull()

		const frozen = Object.freeze([7])
		const frozenDescriptor = Reflect.getOwnPropertyDescriptor(frozen, '0')
		expect(frozenDescriptor?.writable).toBe(false)
		expect(frozenDescriptor?.configurable).toBe(false)
		const frozenClone = cloneJSONValue(frozen)
		expect(frozenClone).toEqual([7])
		expect(frozenClone).not.toBe(frozen)
		expect(Object.isFrozen(frozenClone)).toBe(true)

		class Value {
			readonly value = 1
		}
		const custom = Object.create({})
		for (const value of [new Value(), custom]) {
			expect(isRecord(value)).toBe(false)
			const error = captureContractError(() => cloneJSONValue(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}
	})

	it('rejects inexact properties and unsupported values without invoking accessors', () => {
		let accesses = 0
		const sparse = new Array<unknown>(2)
		sparse[0] = 'present'

		const extra: unknown[] = []
		Object.defineProperty(extra, 'extra', {
			value: true,
			enumerable: true,
			configurable: true,
			writable: true,
		})

		const arrayAccessor: unknown[] = []
		Object.defineProperty(arrayAccessor, '0', {
			enumerable: true,
			configurable: true,
			get() {
				accesses += 1
				return 'unsafe'
			},
		})

		const hiddenIndex: unknown[] = ['hidden']
		Object.defineProperty(hiddenIndex, '0', {
			value: 'hidden',
			enumerable: false,
			configurable: true,
			writable: true,
		})

		const recordAccessor: Record<string, unknown> = {}
		Object.defineProperty(recordAccessor, 'value', {
			enumerable: true,
			configurable: true,
			get() {
				accesses += 1
				return 'unsafe'
			},
		})

		const hiddenRecord: Record<string, unknown> = {}
		Object.defineProperty(hiddenRecord, 'value', {
			value: 'hidden',
			enumerable: false,
			configurable: true,
			writable: true,
		})

		const symbolRecord: Record<string, unknown> = {}
		Object.defineProperty(symbolRecord, Symbol('value'), {
			value: 'symbol',
			enumerable: true,
			configurable: true,
			writable: true,
		})

		const symbolArray: unknown[] = []
		Object.defineProperty(symbolArray, Symbol('value'), {
			value: 'symbol',
			enumerable: false,
			configurable: true,
			writable: true,
		})

		const invalid: readonly unknown[] = [
			sparse,
			extra,
			arrayAccessor,
			hiddenIndex,
			recordAccessor,
			hiddenRecord,
			symbolRecord,
			symbolArray,
			undefined,
			Math.max,
			Symbol('unsupported'),
			1n,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]

		for (const value of invalid) {
			const error = captureContractError(() => cloneJSONValue(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}
		expect(accesses).toBe(0)
	})

	it('rejects an array proxy that substitutes a decoration for a canonical index key', () => {
		const source = [7]
		Object.defineProperty(source, 'decoration', {
			value: true,
			enumerable: true,
			configurable: true,
			writable: true,
		})
		const substituted = new Proxy(source, {
			ownKeys() {
				return ['length', 'decoration']
			},
		})

		const first = captureContractError(() => cloneJSONValue(substituted))
		const second = captureContractError(() => cloneJSONValue(substituted))
		expect(first).not.toBe(second)
		expect(first.code).toBe('clone')
		expect(first.context?.shape).toBe('json')
		expect(Object.hasOwn(first, 'cause')).toBe(false)
	})

	it('replaces hostile reflective throws with distinct cause-free clone errors', () => {
		const callerObject = { caller: true }
		const callerError = new ContractError('caller', { code: 'clone' })
		const primitiveTrap = new Proxy(
			{},
			{
				ownKeys() {
					throw 'primitive'
				},
			},
		)
		const objectTrap = new Proxy(
			{ value: 1 },
			{
				getOwnPropertyDescriptor() {
					throw callerObject
				},
			},
		)
		const errorTrap = new Proxy(
			{},
			{
				ownKeys() {
					throw callerError
				},
			},
		)
		const revoked = Proxy.revocable<Record<string, unknown>>({}, {})
		revoked.revoke()

		for (const value of [primitiveTrap, objectTrap, errorTrap, revoked.proxy]) {
			const first = captureContractError(() => cloneJSONValue(value))
			const second = captureContractError(() => cloneJSONValue(value))
			expect(first).not.toBe(second)
			expect(first).not.toBe(callerError)
			expect(first.code).toBe('clone')
			expect(first.context?.shape).toBe('json')
			expect(Object.hasOwn(first, 'cause')).toBe(false)
		}

		const recordError = new ContractError('record caller', { code: 'clone' })
		const recordTrap = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw recordError
				},
			},
		)
		const contained = captureContractError(() => cloneJSONRecord(recordTrap))
		expect(contained).not.toBe(recordError)
		expect(contained.code).toBe('clone')
		expect(contained.context?.shape).toBe('json')
		expect(Object.hasOwn(contained, 'cause')).toBe(false)
	})

	it('clones deeply nested input without recursive call-stack pressure', () => {
		const depth = 20_000
		let source: unknown = 'leaf'
		for (let index = 0; index < depth; index += 1) source = [source]

		const clone = cloneJSONValue(source)
		let current: unknown = clone
		for (let index = 0; index < depth; index += 1) {
			if (!Array.isArray(current)) throw new Error(`expected array at depth ${index}`)
			if (!Object.isFrozen(current)) throw new Error(`expected frozen array at depth ${index}`)
			current = current[0]
		}
		expect(current).toBe('leaf')
	})
})

describe('cloneSchema', () => {
	it('deep-clones and freezes a nested schema without touching the source', () => {
		const leaf: JSONSchema = { type: 'string', description: 'source' }
		const items: JSONSchema = { type: 'array', items: leaf }
		const properties: Record<string, JSONSchema> = { values: items }
		const source: JSONSchema = { type: 'object', properties }
		const clone = cloneSchema(source)

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

	it('preserves shared child identity in the owned schema graph', () => {
		const child: JSONSchema = { type: 'integer' }
		const source: JSONSchema = { anyOf: [child, child] }
		const clone = cloneSchema(source)

		expect(clone.anyOf?.[0]).toBe(clone.anyOf?.[1])
		expect(clone.anyOf?.[0]).not.toBe(child)
		expect(Object.isFrozen(clone.anyOf)).toBe(true)
	})

	it('tolerates a cycle and closes it onto the cloned schema', () => {
		const raw = JSON.parse('{"type":"object","properties":{}}')
		raw.properties.self = raw
		const source: JSONSchema = raw
		const clone = cloneSchema(source)

		expect(clone.properties?.self).toBe(clone)
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(Object.isFrozen(clone.properties)).toBe(true)
		expect(Object.isFrozen(source)).toBe(false)
	})

	it('severs caller prototypes and excludes inherited behavior from the clone', () => {
		const prototype = { marker: 'source' }
		Object.defineProperty(prototype, 'danger', {
			get() {
				throw new Error('inherited getter')
			},
		})
		const source: JSONSchema = Object.create(prototype)
		const clone = cloneSchema(source)

		prototype.marker = 'mutated'
		expect(Object.getPrototypeOf(clone)).toBeNull()
		expect(Reflect.get(clone, 'marker')).toBeUndefined()
		expect(() => Reflect.get(clone, 'danger')).not.toThrow()
	})

	it('contains a throwing own getter as a clone ContractError', () => {
		const source: JSONSchema = {}
		Object.defineProperty(source, 'type', {
			enumerable: true,
			get() {
				throw new Error('own getter')
			},
		})

		expect(() => cloneSchema(source)).toThrowError(ContractError)
	})
})

describe('cloneShape', () => {
	it('deep-clones a shape into a frozen, deeply-equal snapshot', () => {
		const source = objectShape({
			name: stringShape({ min: 1 }),
			tags: arrayShape(stringShape()),
		})
		const clone = cloneShape(source)

		expect(clone).toEqual(source)
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(clone.type).toBe('object')
		if (clone.type !== 'object') return
		expect(clone.properties).not.toBe(source.properties)
		expect(Object.isFrozen(clone.properties)).toBe(true)
		expect(Object.isFrozen(clone.properties.name)).toBe(true)
		expect(Object.isFrozen(clone.properties.tags)).toBe(true)
	})

	it('keeps a cloned pattern stable after compile mutation through the clone', () => {
		const clone = cloneShape(stringShape({ pattern: /^stable$/ }))

		expect(clone.type).toBe('string')
		if (clone.type !== 'string') return
		expect(clone.pattern).not.toBe(clone.pattern)
		expect(Object.isFrozen(clone.pattern)).toBe(true)
		expect(() => clone.pattern?.compile('^owned-drift$')).toThrowError(TypeError)
		expect(clone.pattern?.source).toBe('^stable$')
		expect(clone.pattern?.lastIndex).toBe(0)
		expect(compileSchema(clone).pattern).toBe('^stable$')

		const guard = compileGuard(clone)
		expect(guard('stable')).toBe(true)
		expect(guard('owned-drift')).toBe(false)
	})

	it('preserves shared-child identity in a cloned DAG', () => {
		const child = arrayShape(stringShape())
		const source = objectShape({ first: child, second: child })
		const clone = cloneShape(source)

		expect(clone.type).toBe('object')
		if (clone.type !== 'object') return
		expect(clone.properties.first).toBe(clone.properties.second)
		expect(clone.properties.first).not.toBe(child)
	})

	it('tolerates cycles and closes the cloned edge onto the clone', () => {
		const raw = JSON.parse('{"type":"array","items":{"type":"string"}}')
		raw.items = raw
		const source: ContractShape = raw
		const clone = cloneShape(source)

		expect(clone.type).toBe('array')
		if (clone.type !== 'array') return
		expect(clone.items).toBe(clone)
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
	})

	it('preserves sharing across union variants', () => {
		const child = objectShape({ value: stringShape() })
		const source = unionShape(child, child)
		const clone = cloneShape(source)

		expect(clone.type).toBe('union')
		if (clone.type !== 'union') return
		expect(clone.variants[0]).toBe(clone.variants[1])
		expect(Object.isFrozen(clone.variants)).toBe(true)
	})

	it('contains hostile raw-schema edges as a clone ContractError', () => {
		const raw = JSON.parse('{"type":"raw","schema":{"type":"string"}}')
		Object.defineProperty(raw, 'schema', {
			enumerable: true,
			get() {
				throw new Error('raw schema getter')
			},
		})
		const shape: ContractShape = raw

		expect(() => cloneShape(shape)).toThrowError(ContractError)
	})

	it('contains every hostile shape-graph read as a clone-coded ContractError', () => {
		const revokedSource: ContractShape = JSON.parse('{"type":"string"}')
		const revoked = Proxy.revocable(revokedSource, {})
		revoked.revoke()

		const getterSource = JSON.parse('{"type":"number"}')
		Object.defineProperty(getterSource, 'min', {
			enumerable: true,
			get() {
				throw new ContractError('hostile getter', { code: 'bound' })
			},
		})
		const getterShape: ContractShape = getterSource

		const properties = Proxy.revocable<Record<string, ContractShape>>({ value: stringShape() }, {})
		const propertiesShape: ContractShape = {
			type: 'object',
			properties: properties.proxy,
		}
		properties.revoke()

		for (const shape of [revoked.proxy, getterShape, propertiesShape]) {
			const cloneError = captureContractError(() => cloneShape(shape))
			const contractError = captureContractError(() => createContract(shape))
			expect(cloneError.code).toBe('clone')
			expect(contractError.code).toBe('clone')
		}
	})
})

describe('ownShape', () => {
	it('returns a builder-produced shape unchanged — frozen means owned', () => {
		const shape = objectShape({ name: stringShape({ min: 1 }) })

		expect(ownShape(shape)).toBe(shape)
	})

	it('snapshots an unfrozen caller-owned shape so later edits cannot reach it', () => {
		const values: (string | number | boolean)[] = ['stable']
		const shape: ContractShape = { type: 'literal', values }
		const owned = ownShape(shape)

		values[0] = 'drift'
		expect(owned).not.toBe(shape)
		expect(Object.isFrozen(owned)).toBe(true)
		expect(owned.type).toBe('literal')
		if (owned.type !== 'literal') return
		expect(owned.values).toEqual(['stable'])
	})

	it('owns an unfrozen graph deeply, including a shared child', () => {
		const child: ContractShape = { type: 'string' }
		const shape: ContractShape = { type: 'object', properties: { first: child, second: child } }
		const owned = ownShape(shape)

		expect(owned.type).toBe('object')
		if (owned.type !== 'object') return
		expect(owned.properties.first).not.toBe(child)
		expect(owned.properties.first).toBe(owned.properties.second)
		expect(Object.isFrozen(owned.properties)).toBe(true)
	})

	it('leaves an unfrozen child of a frozen node to be owned at its own level', () => {
		const child: ContractShape = { type: 'string' }
		const shape = Object.freeze({ type: 'array', items: child }) satisfies ContractShape
		const owned = ownShape(shape)

		expect(owned).toBe(shape)
		expect(owned.type).toBe('array')
		if (owned.type !== 'array') return
		expect(ownShape(owned.items)).not.toBe(child)
		expect(Object.isFrozen(ownShape(owned.items))).toBe(true)
	})
})
