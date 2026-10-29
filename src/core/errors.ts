import type { ContractErrorContext, ContractErrorOptions } from './types.js'
import { CONTRACT_CODES, CONTRACT_ERROR_BRAND, INTRINSICS } from './constants.js'

/**
 * Carries a machine-readable contract category, optional context, and an exact optional
 * cause.
 *
 * @remarks
 * Omitting `cause` omits the own property; explicitly supplying `cause: undefined`
 * retains an own property with that value. Both optional options are read as OWN
 * properties, so a construction never consults the caller-writable prototype chain of
 * the container it was handed.
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
	override readonly name: string = 'ContractError'
	readonly code
	readonly context: ContractErrorContext | undefined

	/**
	 * Creates a contract error.
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
		// answering `declare` included, so this body and `pinMembers` cannot pin
		// differently.
		const members = INTRINSICS.reflect.members(this.prototype)
		for (const key of members) {
			if (key === undefined) continue
			const declared = INTRINSICS.describe(this.prototype, key)
			const accessor = declared !== undefined && !INTRINSICS.own(declared, 'value')
			INTRINSICS.reflect.define(
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
 * base, a subclass prototype, an own declared contract code, and valid context.
 * Context may be a class instance or callable object; paths are checked by index.
 * Optional context fields are read only when owned; inherited fields are ignored.
 * A subclass may replace its name without changing recognition.
 * The brand stores the error itself and recognition requires that exact
 * identity. A transparent proxy is therefore refused because its forwarded
 * descriptor still stores the target, not the proxy.
 * The brand is recognized across duplicate installations and ESM/CommonJS
 * module copies at 0.0.13 or later. A copy earlier than 0.0.13 stamps no brand,
 * so an error it throws stays outside the type, and so does a plain or
 * property-only lookalike.
 *
 * @param value - The value to inspect
 * @returns True if the value is a `ContractError` instance; false otherwise
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
		if (!INTRINSICS.own(value, 'code')) return false
		const descriptor = INTRINSICS.describe(value, CONTRACT_ERROR_BRAND)
		if (descriptor?.value !== value) return false
		const code: unknown = INTRINSICS.reflect.read(value, 'code')
		if (
			!INTRINSICS.reflect.apply(INTRINSICS.some, CONTRACT_CODES, [
				(candidate: unknown) => candidate === code,
			])
		) {
			return false
		}
		const context: unknown = INTRINSICS.own(value, 'context')
			? INTRINSICS.reflect.read(value, 'context')
			: undefined
		if (context === undefined) return true
		if ((typeof context !== 'object' || context === null) && typeof context !== 'function') {
			return false
		}
		const path: unknown = INTRINSICS.own(context, 'path')
			? INTRINSICS.reflect.read(context, 'path')
			: undefined
		if (path !== undefined && typeof path !== 'string') {
			if (!INTRINSICS.array(path)) return false
			if (
				INTRINSICS.reflect.apply(INTRINSICS.find, path, [
					(segment: unknown) => typeof segment !== 'string',
				]) !== -1
			) {
				return false
			}
		}
		const shape: unknown = INTRINSICS.own(context, 'shape')
			? INTRINSICS.reflect.read(context, 'shape')
			: undefined
		if (shape !== undefined && typeof shape !== 'string') return false
		const limit: unknown = INTRINSICS.own(context, 'limit')
			? INTRINSICS.reflect.read(context, 'limit')
			: undefined
		if (limit !== undefined && typeof limit !== 'number' && typeof limit !== 'string') return false
		const received: unknown = INTRINSICS.own(context, 'received')
			? INTRINSICS.reflect.read(context, 'received')
			: undefined
		return received === undefined || typeof received === 'string'
	} catch {
		return false
	}
}
