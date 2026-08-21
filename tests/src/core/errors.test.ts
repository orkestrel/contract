import type { ContractCode } from '@src/core'
import { ContractError, isConstructor, isContractError, isFunction, isRecord } from '@src/core'
import { describe, expect, it } from 'vitest'

describe('contract error', () => {
	it('refuses a transparent proxy over a genuine error', () => {
		const error = new ContractError('proxied', { code: 'structure' })

		expect(isContractError(new Proxy(error, {}))).toBe(false)
	})

	it('refuses a subclass instance after its brand is removed', () => {
		const error = Reflect.construct(
			ContractError,
			['stripped', { code: 'structure' }],
			class extends ContractError {},
		)

		expect(Reflect.deleteProperty(error, Symbol.for('@orkestrel/contract.error'))).toBe(true)
		expect(Reflect.get(error, 'name')).toBe('ContractError')
		expect(Reflect.get(error, 'code')).toBe('structure')
		expect(isContractError(error)).toBe(false)
	})

	it('admits a complete forgery carrying its own identity brand', () => {
		const forgery = Reflect.construct(Error, ['forged'], class extends Error {})
		Reflect.set(forgery, 'name', 'ContractError')
		Reflect.set(forgery, 'code', 'structure')
		Object.defineProperty(forgery, Symbol.for('@orkestrel/contract.error'), {
			value: forgery,
		})

		expect(isContractError(forgery)).toBe(true)
	})

	it('admits every declared code and refuses one the type does not declare', () => {
		const codes: Readonly<Record<ContractCode, ContractCode>> = {
			bound: 'bound',
			range: 'range',
			empty: 'empty',
			placement: 'placement',
			structure: 'structure',
			literal: 'literal',
			cycle: 'cycle',
			pattern: 'pattern',
			generate: 'generate',
			random: 'random',
			clone: 'clone',
			depth: 'depth',
			expansion: 'expansion',
		}

		for (const code of Object.values(codes)) {
			expect(isContractError(new ContractError('declared', { code }))).toBe(true)
		}
		const undeclared = new ContractError('undeclared', { code: 'structure' })
		Reflect.set(undeclared, 'code', 'unknown')
		expect(isContractError(undeclared)).toBe(false)
	})

	it('recognizes genuine errors across package copies', () => {
		const firstModules = import.meta.glob('../../../src/core/errors.ts', {
			eager: true,
			query: '?copy=first',
		})
		const secondModules = import.meta.glob('../../../src/core/errors.ts', {
			eager: true,
			query: '?copy=second',
		})
		const first: unknown = Object.values(firstModules)[0]
		const second: unknown = Object.values(secondModules)[0]
		if (!isRecord(first) || !isRecord(second)) throw new Error('source error copies did not load')
		const firstGuard = first.isContractError
		const FirstConstructor = first.ContractError
		const SecondConstructor = second.ContractError
		if (
			!isFunction(firstGuard) ||
			!isConstructor(FirstConstructor) ||
			!isConstructor(SecondConstructor)
		) {
			throw new Error('source error exports did not load')
		}
		const other: unknown = Reflect.construct(SecondConstructor, [
			'invalid contract',
			{ code: 'placement' },
		])
		const lookalike = Object.defineProperty(
			new Error('invalid contract'),
			Symbol.for('@orkestrel/contract.error'),
			{ value: true },
		)

		expect(FirstConstructor).not.toBe(SecondConstructor)
		expect(firstGuard(other)).toBe(true)
		expect(firstGuard(new Error('invalid contract'))).toBe(false)
		expect(firstGuard(lookalike)).toBe(false)
	})
})
