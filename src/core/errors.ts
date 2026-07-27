import type { ContractErrorContext, ContractErrorOptions } from './types.js'

/**
 * Error carrying a machine-readable contract category and optional context.
 *
 * @example
 * ```ts
 * const error = new ContractError('Minimum exceeds maximum', {
 * 	code: 'range',
 * 	context: { path: ['properties', 'age'] },
 * })
 * ```
 */
export class ContractError extends Error {
	override readonly name = 'ContractError'
	readonly code
	readonly context: ContractErrorContext | undefined

	/**
	 * Create a contract error.
	 *
	 * @param message - Human-readable error description
	 * @param options - Machine-readable category, optional context, and optional cause
	 */
	constructor(message: string, options: ContractErrorOptions) {
		const cause = options.cause
		super(message, cause === undefined ? undefined : { cause })
		this.code = options.code
		this.context = options.context
	}
}

/**
 * Determine whether an unknown value is a {@link ContractError}.
 *
 * @param value - The value to inspect
 * @returns `true` only when the value is a `ContractError`
 *
 * @example
 * ```ts
 * isContractError(new ContractError('Invalid shape', { code: 'placement' })) // true
 * isContractError(new Error('Invalid shape')) // false
 * ```
 */
export function isContractError(value: unknown): value is ContractError {
	try {
		return value instanceof ContractError
	} catch {
		return false
	}
}
