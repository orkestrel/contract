import type { ContractCode, ContractErrorContext } from '@src/core'
import { ContractError, isConstructor, isContractError, isFunction, isRecord } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	DetailedContractError,
	JSONExample,
	ObservationCounter,
	pollutePrototype,
} from '../../setup.js'

describe('contract error', () => {
	it('accepts a class-instance context and preserves its identity', () => {
		const context: ContractErrorContext = Object.assign(new JSONExample(), {
			path: ['properties', 'age'],
			shape: 'number',
			limit: Number.POSITIVE_INFINITY,
			received: 'age',
		})
		const error = new ContractError('class context', { code: 'structure', context, cause: context })
		expect(context).toBeInstanceOf(JSONExample)
		expect(error.context).toBe(context)
		expect(error.cause).toBe(context)
		expect(isContractError(error)).toBe(true)
	})

	it('accepts a callable context without invoking it and checks its own fields', () => {
		const context: ContractErrorContext = Object.assign(
			() => {
				throw new Error('context must not be invoked')
			},
			{ path: ['properties', 'age'], shape: 'number', limit: -1.5, received: 'age' },
		)
		const error = new ContractError('callable context', {
			code: 'structure',
			context,
			cause: context,
		})
		expect(typeof context).toBe('function')
		expect(error.context).toBe(context)
		expect(error.cause).toBe(context)
		expect(isContractError(error)).toBe(true)
		expect(Reflect.set(context, 'received', 42)).toBe(true)
		expect(isContractError(error)).toBe(false)
	})

	it('checks path indices without retrieving a caller iterator', () => {
		const reads = new ObservationCounter()
		const path = Object.defineProperty(['properties', 'age'], Symbol.iterator, {
			get() {
				reads.increment()
				throw new Error('path iterator must not be read')
			},
		})
		const context: ContractErrorContext = { path }
		const error = new ContractError('indexed path', { code: 'structure', context })
		expect(isContractError(error)).toBe(true)
		expect(Reflect.set(path, '1', 42)).toBe(true)
		expect(isContractError(error)).toBe(false)
		expect(reads.value).toBe(0)
	})

	it('does not inspect a cause whose declared type is unknown', () => {
		const reads = new ObservationCounter()
		const error = new ContractError('unread cause', { code: 'structure' })
		Object.defineProperty(error, 'cause', {
			get() {
				reads.increment()
				throw new Error('cause must not be read')
			},
		})
		expect(isContractError(error)).toBe(true)
		expect(reads.value).toBe(0)
	})

	it('refuses an inherited data code on a genuine branded error', () => {
		const error = new ContractError('inherited code', { code: 'structure' })
		expect(Reflect.deleteProperty(error, 'code')).toBe(true)
		Object.setPrototypeOf(
			error,
			Object.create(ContractError.prototype, {
				code: { value: 'structure', configurable: true },
			}),
		)
		expect(isContractError(error)).toBe(false)
	})

	it('refuses an inherited getter code without reading it', () => {
		const reads = new ObservationCounter()
		const error = new ContractError('inherited getter', { code: 'structure' })
		expect(Reflect.deleteProperty(error, 'code')).toBe(true)
		Object.setPrototypeOf(
			error,
			Object.create(ContractError.prototype, {
				code: {
					get() {
						reads.increment()
						return 'structure'
					},
					configurable: true,
				},
			}),
		)
		expect(isContractError(error)).toBe(false)
		expect(reads.value).toBe(0)
	})

	it('does not read an omitted context field from a polluted prototype', () => {
		for (const field of ['path', 'shape', 'limit', 'received']) {
			const reads = new ObservationCounter()
			const context = field === 'shape' ? { path: ['kept'] } : { shape: 'kept' }
			const error = new ContractError('owned context', { code: 'structure', context })
			const recognized = pollutePrototype(
				Object.prototype,
				field,
				() => {
					reads.increment()
					throw new Error('inherited context field')
				},
				() => isContractError(error),
			)

			expect(recognized).toBe(true)
			expect(reads.value).toBe(0)
		}
	})

	it('accepts a subclass with its own name and retains the identity brand', () => {
		const error = new DetailedContractError('detail', { code: 'structure' })
		expect(isContractError(error)).toBe(true)
		expect(
			Object.getOwnPropertyDescriptor(error, Symbol.for('@orkestrel/contract.ContractError')),
		).toEqual({
			value: error,
			writable: false,
			enumerable: false,
			configurable: true,
		})
	})

	it('refuses malformed declared context members', () => {
		const context = new ContractError('context', { code: 'structure' })
		Reflect.set(context, 'context', null)
		expect(isContractError(context)).toBe(false)
		const path = new ContractError('path', { code: 'structure' })
		Reflect.set(path, 'context', { path: [42] })
		expect(isContractError(path)).toBe(false)
		const sparse = new ContractError('sparse', { code: 'structure' })
		Reflect.set(sparse, 'context', { path: new Array(1) })
		expect(isContractError(sparse)).toBe(false)
		const shape = new ContractError('shape', { code: 'structure' })
		Reflect.set(shape, 'context', { shape: 42 })
		expect(isContractError(shape)).toBe(false)
		const limit = new ContractError('limit', { code: 'structure' })
		Reflect.set(limit, 'context', { limit: true })
		expect(isContractError(limit)).toBe(false)
		const received = new ContractError('received', { code: 'structure' })
		Reflect.set(received, 'context', { received: [] })
		expect(isContractError(received)).toBe(false)
	})

	it('accepts the declared context domain without narrowing numeric limits', () => {
		expect(
			isContractError(
				new ContractError('context', {
					code: 'structure',
					context: { path: ['properties', 'name'], shape: 'string', limit: NaN, received: 'x' },
				}),
			),
		).toBe(true)
		expect(
			isContractError(
				new ContractError('path', { code: 'structure', context: { path: 'name', limit: 'max' } }),
			),
		).toBe(true)
	})

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

		expect(Reflect.deleteProperty(error, Symbol.for('@orkestrel/contract.ContractError'))).toBe(
			true,
		)
		expect(Reflect.get(error, 'name')).toBe('ContractError')
		expect(Reflect.get(error, 'code')).toBe('structure')
		expect(isContractError(error)).toBe(false)
	})

	it('admits a complete forgery carrying its own identity brand', () => {
		const forgery = Reflect.construct(Error, ['forged'], class extends Error {})
		Reflect.set(forgery, 'name', 'ContractError')
		Reflect.set(forgery, 'code', 'structure')
		Object.defineProperty(forgery, Symbol.for('@orkestrel/contract.ContractError'), {
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
			Symbol.for('@orkestrel/contract.ContractError'),
			{ value: true },
		)

		expect(FirstConstructor).not.toBe(SecondConstructor)
		expect(firstGuard(other)).toBe(true)
		expect(firstGuard(new Error('invalid contract'))).toBe(false)
		expect(firstGuard(lookalike)).toBe(false)
	})
})
