import type { ContractInterface, ContractShape } from '@src/core'
import {
	arrayShape,
	attempt,
	booleanShape,
	compileGuard,
	createContract,
	integerShape,
	objectShape,
	optionalShape,
	stringShape,
	unionShape,
	validateShape,
} from '@src/core'
import { captureContractError } from '../../setup.js'
import { describe, expect, it } from 'vitest'

const ROOTS = ['schema', 'is', 'parse', 'audit', 'explain', 'generate'] as const

describe('createContract — eager bundle', () => {
	it('publishes plain data properties rather than getters', () => {
		const contract = createContract(objectShape({ name: stringShape() }))

		for (const root of ROOTS) {
			const descriptor = Object.getOwnPropertyDescriptor(contract, root)
			expect(descriptor, root).toBeDefined()
			expect(Object.hasOwn(descriptor ?? {}, 'value'), root).toBe(true)
			expect(descriptor?.get, root).toBeUndefined()
		}
	})

	it('carries the same artifact identities through destructuring and through a spread', () => {
		const contract = createContract(objectShape({ name: stringShape() }))
		const { is, parse } = contract
		const spread = { ...contract }

		expect(is).toBe(contract.is)
		expect(parse).toBe(contract.parse)
		for (const root of ROOTS) expect(spread[root], root).toBe(contract[root])
	})
})

describe('createContract — both declared overloads', () => {
	it('answers every root through the generic overload', () => {
		const contract = createContract(
			objectShape({ name: stringShape({ min: 1 }), age: integerShape({ min: 0 }) }),
		)

		expect(contract.schema.type).toBe('object')
		expect(contract.is({ name: 'Ada', age: 36 })).toBe(true)
		expect(contract.parse({ name: 'Ada', age: '36' })).toEqual({ name: 'Ada', age: 36 })
		expect(contract.audit({ name: 'Ada', age: 36 })).toEqual([])
		expect(contract.explain({ name: 'Ada', age: 36 })).toEqual([])
		expect(contract.is(contract.generate(() => 0.5))).toBe(true)
	})

	it('answers every root through the widened ContractShape overload', () => {
		const widened: ContractShape = objectShape({ name: stringShape({ min: 1 }) })
		const contract: ContractInterface<unknown> = createContract(widened)

		expect(contract.schema.type).toBe('object')
		expect(contract.is({ name: 'Ada' })).toBe(true)
		expect(contract.parse({ name: 'Ada' })).toEqual({ name: 'Ada' })
		expect(contract.audit({ name: 1 }).length).toBeGreaterThan(0)
		expect(contract.explain({ name: 1 }).length).toBeGreaterThan(0)
		expect(contract.is(contract.generate(() => 0.5))).toBe(true)
	})
})

describe('createContract — refusal', () => {
	it('refuses a malformed declaration at the call rather than at a member read', () => {
		const malformed: ContractShape = { category: 'string', min: 5, max: 1 }
		const outcome = attempt(() => createContract(malformed))

		// The refusal arrives with no bundle, so no member read can be the trigger.
		expect(outcome.success).toBe(false)
	})

	it('adopts the authoring door’s own diagnosis instead of rewrapping it', () => {
		const malformed: ContractShape = { category: 'string', min: 5, max: 1 }
		const published = captureContractError(() => createContract(malformed))
		const authored = captureContractError(() => validateShape(malformed))

		expect(published.message).toBe(authored.message)
		expect(published.code).toBe(authored.code)
		expect(published.context).toEqual(authored.context)
		// A rewrap would prefix the door that adopted the diagnosis and retain the
		// original as a cause; this door does neither.
		expect(published.message.startsWith('createContract:')).toBe(false)
		expect(Object.hasOwn(published, 'cause')).toBe(false)
	})
})

describe('createContract — door and getter agreement', () => {
	it('answers a corpus exactly as compileGuard answers it', () => {
		const shapes: readonly ContractShape[] = [
			stringShape({ min: 1, max: 3 }),
			integerShape({ min: 0, max: 9 }),
			booleanShape(),
			arrayShape(stringShape(), { min: 1 }),
			objectShape({ name: stringShape(), bio: optionalShape(stringShape()) }),
			unionShape(stringShape(), integerShape()),
		]
		const corpus: readonly unknown[] = [
			undefined,
			null,
			'',
			'ab',
			0,
			36,
			true,
			[],
			['a'],
			{},
			{ name: 'Ada' },
			{ name: 'Ada', bio: 'x' },
			{ name: 1 },
		]

		for (const shape of shapes) {
			const door = createContract(shape).is
			const getter = compileGuard(shape)
			for (const value of corpus) {
				expect(door(value), `${shape.category} ${String(value)}`).toBe(getter(value))
			}
		}
	})
})
