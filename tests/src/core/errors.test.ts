import type { ContractCode, ContractErrorContext } from '@src/core'
import { createRevokedProxy } from '../../setup.js'
import { describe, expect, it } from 'vitest'
import { ContractError, isContractError } from '@src/core'

describe('error exports', () => {
	it('exports ContractError from the core barrel', async () => {
		const contract: object = await import('@src/core')
		expect(Reflect.has(contract, 'ContractError')).toBe(true)
	})
})

describe('ContractError', () => {
	it('constructs without context or an own cause property', () => {
		const error = new ContractError('Invalid bound', { code: 'bound' })

		expect(error).toBeInstanceOf(Error)
		expect(error).toBeInstanceOf(ContractError)
		expect(error.name).toBe('ContractError')
		expect(error.message).toBe('Invalid bound')
		expect(error.code).toBe('bound')
		expect(error.context).toBeUndefined()
		expect(Object.hasOwn(error, 'cause')).toBe(false)
	})

	it('preserves context and cause references', () => {
		const context: ContractErrorContext = {
			path: ['properties', 'age'],
			shape: 'number',
			limit: 120,
			received: '121',
		}
		const cause = new Error('origin')
		const error = new ContractError('Invalid range', {
			code: 'range',
			context,
			cause,
		})

		expect(error.context).toBe(context)
		expect(error.cause).toBe(cause)
	})

	it('accepts and preserves every ContractCode', () => {
		const codes: readonly ContractCode[] = [
			'bound',
			'range',
			'empty',
			'placement',
			'literal',
			'cycle',
			'pattern',
			'generate',
			'random',
			'clone',
			'depth',
		]

		for (const code of codes) {
			expect(new ContractError(code, { code }).code).toBe(code)
		}
	})
})

describe('isContractError', () => {
	it('accepts a ContractError', () => {
		expect(isContractError(new ContractError('Invalid shape', { code: 'placement' }))).toBe(true)
	})

	it('rejects an ordinary Error and a plain lookalike', () => {
		expect(isContractError(new Error('Invalid shape'))).toBe(false)
		expect(
			isContractError({
				name: 'ContractError',
				message: 'Invalid shape',
				code: 'placement',
			}),
		).toBe(false)
	})

	it('rejects primitives', () => {
		expect(isContractError(null)).toBe(false)
		expect(isContractError(undefined)).toBe(false)
		expect(isContractError('ContractError')).toBe(false)
		expect(isContractError(1)).toBe(false)
		expect(isContractError(true)).toBe(false)
		expect(isContractError(Symbol('ContractError'))).toBe(false)
	})

	it('returns false without throwing for a revoked Proxy', () => {
		const hostile = createRevokedProxy()
		expect(() => isContractError(hostile)).not.toThrow()
		expect(isContractError(hostile)).toBe(false)
	})
})
