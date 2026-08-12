import type { ContractShape, JSONRecord, JSONSchema, StringShape } from '@src/core'
import {
	attempt,
	cloneJSONRecord,
	cloneJSONValue,
	cloneSchema,
	cloneShape,
	ContractError,
	isRecord,
	objectShape,
	ownShape,
	SchemaCloner,
	ShapeCloner,
	stringShape,
	unionShape,
} from '@src/core'
import { captureContractError, ForgedBrandDeclaration, NullBaseDeclaration } from '../../setup.js'
import { createForeignRecord } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('cloneJSONValue', () => {
	it('keeps finite primitives, exposes one-argument functions, and narrows record roots', () => {
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

	it('creates a fresh composite snapshot for every eager call', () => {
		let observations = 0
		const source = new Proxy(
			{ nested: [1] },
			{
				ownKeys(target) {
					observations += 1
					return Reflect.ownKeys(target)
				},
			},
		)

		const first = cloneJSONValue(source)
		const afterFirst = observations
		const second = cloneJSONValue(source)

		expect(second).not.toBe(first)
		expect(second).toEqual(first)
		expect(observations).toBeGreaterThan(afterFirst)
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
		const foreignRecord = createForeignRecord()
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
		const simulated = Object.create(Object.create(null))
		for (const value of [new Value(), custom, simulated, new NullBaseDeclaration()]) {
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
	it('creates fresh eager successes and rereads the source', () => {
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

		const first = cloneSchema(source)
		const afterFirst = observations
		const second = cloneSchema(source)

		expect(second).not.toBe(first)
		expect(second).toEqual(first)
		expect(observations).toBeGreaterThan(afterFirst)
	})

	it('creates fresh eager failures while retaining the exact property cause', () => {
		const cause = new Error('property failure')
		const source: JSONSchema = {}
		Object.defineProperty(source, 'type', {
			enumerable: true,
			get() {
				throw cause
			},
		})

		const first = captureContractError(() => cloneSchema(source))
		const second = captureContractError(() => cloneSchema(source))

		expect(second).not.toBe(first)
		expect(first.message).toBe(second.message)
		expect(first.context).toEqual(second.context)
		expect(first.cause).toBe(cause)
		expect(second.cause).toBe(cause)
	})

	it('matches the class for shared cycles and hostile property reads', () => {
		const child: JSONSchema = { type: 'integer' }
		const source: JSONSchema = { anyOf: [child, child] }
		Reflect.set(source, 'self', source)
		const direct = new SchemaCloner(source).clone()
		const eager = cloneSchema(source)

		expect(direct).toEqual(eager)
		expect(direct.anyOf?.[0]).toBe(direct.anyOf?.[1])
		expect(eager.anyOf?.[0]).toBe(eager.anyOf?.[1])
		expect(Reflect.get(direct, 'self')).toBe(direct)
		expect(Reflect.get(eager, 'self')).toBe(eager)

		const cause = { reason: 'hostile' }
		const hostile: JSONSchema = {}
		Object.defineProperty(hostile, 'type', {
			enumerable: true,
			get() {
				throw cause
			},
		})
		const directError = captureContractError(() => new SchemaCloner(hostile).clone())
		const eagerError = captureContractError(() => cloneSchema(hostile))

		expect(directError).not.toBe(eagerError)
		expect(directError.message).toBe(eagerError.message)
		expect(directError.context).toEqual(eagerError.context)
		expect(directError.cause).toBe(cause)
		expect(eagerError.cause).toBe(cause)
	})
})

describe('cloneShape', () => {
	it('preserves the string overload while returning a frozen runtime snapshot', () => {
		const source = stringShape({ min: 1 })
		const clone: StringShape = cloneShape(source)

		expect(clone).toEqual(source)
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
	})

	it('creates fresh roots and re-observes the source on every eager call', () => {
		const child: { type: 'string'; min?: number } = { type: 'string', min: 1 }
		const source: ContractShape = { type: 'object', properties: { child } }

		const first = cloneShape(source)
		child.min = 2
		const second = cloneShape(source)

		expect(first).not.toBe(second)
		if (first.type !== 'object' || second.type !== 'object') {
			throw new Error('expected object snapshots')
		}
		expect(first.properties.child).not.toBe(second.properties.child)
		expect(first.properties.child).toEqual({ type: 'string', min: 1 })
		expect(second.properties.child).toEqual({ type: 'string', min: 2 })
	})

	it('creates a fresh contained failure on every eager call', () => {
		const cause = new Error('hostile minimum')
		const target: ContractShape = { type: 'number' }
		const source = new Proxy(target, {
			getOwnPropertyDescriptor() {
				throw cause
			},
		})

		const first = captureContractError(() => cloneShape(source))
		const second = captureContractError(() => cloneShape(source))

		expect(first).not.toBe(second)
		expect(first.code).toBe('clone')
		expect(first.message).toBe('cloneShape: failed to create an owned shape snapshot')
		expect(first.cause).toBe(cause)
		expect(second.cause).toBe(cause)
	})

	it('matches fresh direct-class snapshots across a compact shape corpus', () => {
		const shared = stringShape({ min: 1 })
		const shapes: readonly ContractShape[] = [
			stringShape({ pattern: /^stable$/ }),
			objectShape({ first: shared, second: shared }),
			unionShape(stringShape(), { type: 'raw', schema: { type: 'number' } }),
		]

		for (const shape of shapes) {
			const eager = cloneShape(shape)
			const direct = new ShapeCloner(shape).clone()

			expect(eager).toEqual(direct)
			expect(eager).not.toBe(direct)
		}
	})
})

describe('ownShape', () => {
	it('prefers a frozen source validation ContractError over the original clone failure', () => {
		const cause = new Error('first minimum read')
		let reads = 0
		const target: ContractShape = { type: 'number' }
		Object.defineProperty(target, 'min', {
			enumerable: true,
			get() {
				return 'invalid'
			},
		})
		Object.freeze(target)
		const source = new Proxy(target, {
			getOwnPropertyDescriptor(sourceTarget, property) {
				if (property === 'min') {
					reads += 1
					if (reads === 2) throw cause
				}
				return Reflect.getOwnPropertyDescriptor(sourceTarget, property)
			},
		})

		const error = captureContractError(() => ownShape(source))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('validateShapeDepth: every node must be a recognized shape')
		expect(Object.hasOwn(error, 'cause')).toBe(false)
	})

	it('keeps an unfrozen eager clone failure unchanged', () => {
		const cause = new Error('hostile minimum')
		const target: ContractShape = { type: 'number' }
		const source = new Proxy(target, {
			getOwnPropertyDescriptor() {
				throw cause
			},
		})

		const error = captureContractError(() => ownShape(source))

		expect(error.code).toBe('clone')
		expect(error.cause).toBe(cause)
	})

	it('returns independent successful snapshots for frozen and unfrozen sources', () => {
		const child: ContractShape = { type: 'string' }
		const unfrozen: ContractShape = {
			type: 'object',
			properties: { first: child, second: child },
		}
		const frozen = Object.freeze({
			type: 'object',
			properties: { first: child, second: child },
		}) satisfies ContractShape

		for (const source of [unfrozen, frozen]) {
			const first = ownShape(source)
			const second = ownShape(source)

			expect(first).not.toBe(source)
			expect(first).not.toBe(second)
			if (first.type !== 'object' || second.type !== 'object') {
				throw new Error('expected object snapshots')
			}
			expect(first.properties.first).toBe(first.properties.second)
			expect(first.properties.first).not.toBe(child)
			expect(first.properties.first).not.toBe(second.properties.first)
		}
	})
})

describe('eager ownership boundaries — reparented class brands', () => {
	it('refuses a null-base class instance at every eager shape and JSON door', () => {
		const doors = [
			{ name: 'cloneShape', operation: () => cloneShape(new NullBaseDeclaration()) },
			{ name: 'ownShape', operation: () => ownShape(new NullBaseDeclaration()) },
			{ name: 'cloneJSONValue', operation: () => cloneJSONValue(new NullBaseDeclaration()) },
			{ name: 'cloneJSONRecord', operation: () => cloneJSONRecord(new NullBaseDeclaration()) },
		]

		const observed = doors.map((door) => {
			const error = captureContractError(door.operation)
			return { name: door.name, code: error.code, caused: Object.hasOwn(error, 'cause') }
		})

		expect(observed).toEqual([
			{ name: 'cloneShape', code: 'structure', caused: false },
			{ name: 'ownShape', code: 'structure', caused: false },
			{ name: 'cloneJSONValue', code: 'clone', caused: false },
			{ name: 'cloneJSONRecord', code: 'clone', caused: false },
		])
	})

	it('accepts a forged record brand at every eager shape and JSON door, owning only plain data', () => {
		// The counterpart of the refusal above, and the exact limit of it: a
		// reparented class prototype is refused, and the SAME prototype stamped
		// with the mandated realm members is not, because nothing observable from
		// outside a realm separates the two. The forgery buys acceptance, and the
		// snapshots published are still owned plain data.
		const doors: ReadonlyArray<{ readonly name: string; readonly operation: () => unknown }> = [
			{ name: 'cloneShape', operation: () => cloneShape(new ForgedBrandDeclaration()) },
			{ name: 'ownShape', operation: () => ownShape(new ForgedBrandDeclaration()) },
			{ name: 'cloneJSONValue', operation: () => cloneJSONValue(new ForgedBrandDeclaration()) },
			{ name: 'cloneJSONRecord', operation: () => cloneJSONRecord(new ForgedBrandDeclaration()) },
		]

		const observed = doors.map((door) => {
			const outcome = attempt(door.operation)
			return {
				name: door.name,
				accepted: outcome.success,
				value: outcome.success ? outcome.value : undefined,
			}
		})

		expect(observed).toEqual([
			{ name: 'cloneShape', accepted: true, value: { type: 'string', min: 1 } },
			{ name: 'ownShape', accepted: true, value: { type: 'string', min: 1 } },
			{ name: 'cloneJSONValue', accepted: true, value: { type: 'string', min: 1 } },
			{ name: 'cloneJSONRecord', accepted: true, value: { type: 'string', min: 1 } },
		])
	})

	it('owns a reparented class instance as schema data because no brand rule governs a schema graph', () => {
		// cloneSchema is the one ownership door that never consults the record
		// brand: it snapshots an arbitrary readable graph, and its output is
		// already an owned null-prototype record, so nothing class-branded
		// survives the call.
		const owned = cloneSchema(new NullBaseDeclaration())

		expect(owned).toEqual({ type: 'string', min: 1 })
		expect(Object.getPrototypeOf(owned)).toBeNull()
		expect(Object.isFrozen(owned)).toBe(true)
	})
})
