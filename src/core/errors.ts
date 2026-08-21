import type { ContractErrorContext, ContractErrorOptions } from './types.js'
import { CONTRACT_ERROR_BRAND, INTRINSICS } from './constants.js'

/**
 * Error carrying a machine-readable contract category, optional context, and
 * an exact optional cause. Omitting `cause` omits the own property; explicitly
 * supplying `cause: undefined` retains an own property with that value. Both
 * optional options are read as OWN properties, so a construction never consults
 * the caller-writable prototype chain of the container it was handed.
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
		super(message, INTRINSICS.own(options, 'cause') ? { cause: options.cause } : undefined)
		INTRINSICS.define(this, CONTRACT_ERROR_BRAND, { value: this, configurable: true })
		this.code = options.code
		this.context = INTRINSICS.own(options, 'context') ? options.context : undefined
	}

	static {
		const members = INTRINSICS.members(this.prototype)
		for (let index = 0; index < members.length; index += 1) {
			const key = members[index]
			if (key === undefined) continue
			INTRINSICS.define(this.prototype, key, { writable: false, configurable: false })
			const pinned = INTRINSICS.describe(this.prototype, key)
			if (pinned?.writable !== false || pinned.configurable !== false) {
				throw new ContractError('ContractError: a prototype member could not be pinned', {
					code: 'structure',
				})
			}
		}
	}
}

/**
 * Checks whether an unknown value is a {@link ContractError}.
 *
 * @remarks
 * Recognition combines a global own-property brand with the native `Error`
 * base, a subclass prototype, the fixed name, and a declared contract code.
 * The brand stores the error itself and recognition requires that exact
 * identity. A transparent proxy is therefore refused because its forwarded
 * descriptor still stores the target, not the proxy.
 * The brand is recognized across duplicate installations and ESM/CommonJS
 * module copies at 0.0.13 or later. A copy earlier than 0.0.13 stamps no brand,
 * so an error it throws stays outside the type, and so does a plain or
 * property-only lookalike.
 *
 * @param value - The value to inspect
 * @returns True only for a `ContractError` instance; false otherwise
 *
 * @example
 * ```ts
 * isContractError(new ContractError('Invalid shape', { code: 'placement' })) // true
 * isContractError(new Error('Invalid shape')) // false
 * ```
 */
export function isContractError(value: unknown): value is ContractError {
	if (typeof value !== 'object' || value === null) return false
	try {
		if (
			!(value instanceof INTRINSICS.error) ||
			INTRINSICS.prototype(value) === INTRINSICS.error.prototype
		) {
			return false
		}
		if (value.name !== 'ContractError' || !('code' in value)) return false
		const descriptor = INTRINSICS.describe(value, CONTRACT_ERROR_BRAND)
		if (descriptor?.value !== value) return false
		const code: unknown = value.code
		return (
			code === 'bound' ||
			code === 'range' ||
			code === 'empty' ||
			code === 'placement' ||
			code === 'structure' ||
			code === 'literal' ||
			code === 'cycle' ||
			code === 'pattern' ||
			code === 'generate' ||
			code === 'random' ||
			code === 'clone' ||
			code === 'depth' ||
			code === 'expansion'
		)
	} catch {
		return false
	}
}
