import type { ContractErrorContext, ContractErrorOptions } from './types.js'
import { CONTRACT_CODES, CONTRACT_ERROR_BRAND, INTRINSICS } from './constants.js'

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
		// The `pinMembers` body, inlined for the reason that helper's `@remarks`
		// records: `helpers.ts` imports this module, so calling it here would invert
		// the dependency. It stays aligned with that helper, accessor branch and
		// answering `declare` included, so the two copies cannot pin differently.
		const members = INTRINSICS.members(this.prototype)
		for (let index = 0; index < members.length; index += 1) {
			const key = members[index]
			if (key === undefined) continue
			const declared = INTRINSICS.describe(this.prototype, key)
			const accessor = declared !== undefined && !INTRINSICS.own(declared, 'value')
			INTRINSICS.declare(
				this.prototype,
				key,
				accessor ? { configurable: false } : { writable: false, configurable: false },
			)
			const pinned = INTRINSICS.describe(this.prototype, key)
			if (pinned?.configurable !== false || (!accessor && pinned.writable !== false)) {
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
		// Indexed over the one declared vocabulary. `collectMembers` /
		// `matchesMember` express the same membership everywhere else in the
		// package, and this file cannot reach them: `helpers.ts` imports this
		// module, so asking it would invert the dependency — the same reason this
		// guard carries its own `try` / `catch`.
		for (let index = 0; index < CONTRACT_CODES.length; index += 1) {
			if (code === CONTRACT_CODES[index]) return true
		}
		return false
	} catch {
		return false
	}
}
