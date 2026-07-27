import type { ContractShape, JSONSchema } from '@src/core'
import {
	arrayShape,
	cloneSchema,
	cloneShape,
	compileGuard,
	compileSchema,
	ContractError,
	createContract,
	objectShape,
	ownShape,
	stringShape,
	unionShape,
} from '@src/core'
import { captureContractError } from '../../setup.js'
import { describe, expect, it } from 'vitest'

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
