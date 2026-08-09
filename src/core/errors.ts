import type { ContractErrorContext, ContractErrorOptions, Guard } from './types.js'

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
	// Captured while this module evaluates — the qualification matters, because
	// "before any caller code runs" is false for a consumer module ordered
	// earlier, which is the limit `constants.ts` states and does not defend. So no
	// caller code that runs AFTER this module can replace
	// `Object.hasOwn`. An ownership engine constructs its terminal error on the
	// settlement path, so a redirected intrinsic here would throw the caller's
	// value out of a settlement that had already committed, and the replayed
	// result would disagree with what the first call observed. It is also what
	// makes every optional read below an OWN read: an unqualified `options.cause`
	// on an internal literal that carries no own `cause` is an ordinary `Get`
	// that walks to `Object.prototype`, which every caller can write, so the
	// caller would choose both whether the construction throws and what an
	// error documented as cause-free carries. `code` needs no such test because
	// `ContractErrorOptions` requires it, so it is always own.
	static readonly #hasOwn = Object.hasOwn
	override readonly name = 'ContractError'
	readonly code
	readonly context: ContractErrorContext | undefined
	// The construction brand. A private field is installed by this constructor
	// and by nothing else, so the FIELD cannot be forged, deleted, or copied onto
	// a lookalike. That sentence used to run on to "or denied", which conflated
	// the brand with the test: an unforgeable field tested through a writable
	// member is a deniable answer, and one assignment to that member reproduced
	// the whole defect. Denial is closed by where the TEST lives and by pinning
	// the one member that reaches it — see `guard` below — not by this field.
	// The field exists because the obvious spelling of the same question,
	// `value instanceof ContractError`, consults
	// `ContractError[Symbol.hasInstance]`, a member every caller can write.
	readonly #brand = true

	/**
	 * Create a contract error.
	 *
	 * @param message - Human-readable error description
	 * @param options - Machine-readable category, optional context, and optional cause
	 */
	constructor(message: string, options: ContractErrorOptions) {
		super(message, ContractError.#hasOwn(options, 'cause') ? { cause: options.cause } : undefined)
		this.code = options.code
		this.context = ContractError.#hasOwn(options, 'context') ? options.context : undefined
	}

	/**
	 * Hand the module the branded recognition test.
	 *
	 * @remarks
	 * The bootstrap seam, and deliberately NOT a spelling of the recognition
	 * question. Private-name membership is legal only inside this class body, so
	 * something must bridge the class to the module — and the previous bridge was
	 * a static that ANSWERED the question, `ContractError.owns(value)`. That
	 * reintroduced, verbatim, the poisonable surface the private brand was chosen
	 * to remove: one assignment made the package fail to recognize its own errors,
	 * so an engine rewrapped an error it had authored as an unreadable failure,
	 * and a throwing assignment put the caller's raw value through fifteen public
	 * doors.
	 *
	 * This hands over the CLOSURE instead: {@link isContractError} calls it and
	 * applies the result, so the only member on the recognition path hands the
	 * test over rather than answering with it. That per-call read is not a seam,
	 * because the static block below pins this member as a non-writable,
	 * non-configurable own data property.
	 *
	 * An earlier round argued the pin needed no further defence, because a static
	 * block runs during class definition and no order — this module's, an
	 * importer's, or a module that evaluated first — reaches `ContractError.guard`
	 * before the block runs. That is true and it answers the wrong question.
	 * INSTALLING IS NOT READING. The concern was never that something reads the
	 * member unpinned; it was whether the pin installs at all, and the pin is one
	 * live dispatch through `Object.defineProperty`. A module that evaluated
	 * first can replace it with a selective no-op, after which the block runs,
	 * returns, installs nothing, and every later read finds a writable member
	 * again — the whole `owns` defect restored, invisibly, in a realm where every
	 * shipped test still passes.
	 *
	 * So the block VERIFIES its own work and refuses to define the class when the
	 * pin did not take. A silent failure becomes a loud one at import. The
	 * residual is named rather than denied: an adversary who also answers the
	 * verifying descriptor read defeats it, and that adversary already chose what
	 * every capture in this package holds.
	 *
	 * @returns The total recognition guard `isContractError` publishes
	 *
	 * @example
	 * ```ts
	 * ContractError.guard()(new ContractError('x', { code: 'clone' })) // true
	 * ```
	 */
	static guard(): Guard<ContractError> {
		return ContractError.#recognizes
	}

	// The brand test itself, reachable only from inside this class body.
	static #recognizes(value: unknown): value is ContractError {
		if (typeof value !== 'object' || value === null) return false
		try {
			// Membership proves this constructor ran on the value; the value read
			// that follows keeps the brand a field the class genuinely consults
			// rather than a declaration only an `in` test ever mentions.
			return #brand in value && value.#brand === true
		} catch {
			// Totality rests on this `catch`, not on an argument that nothing inside
			// can throw. That argument was made once, was false, and is what
			// justified deleting the containment the committed baseline had.
			return false
		}
	}

	static {
		// Pinned while this class is DEFINED — not "before any caller code runs",
		// which is false in exactly the case the load-order limit in `constants.ts`
		// names — so the one member on the recognition path is a permanent own data
		// property rather than a redirectable one. This is the whole difference from the static that
		// preceded it: `owns` was writable AND answered the question, so a single
		// assignment both denied recognition at every door and, as a thrower, put
		// the caller's raw value through fifteen of them.
		//
		// Written inline rather than through the shared `pinMembers` helper because
		// `errors.ts` cannot import `helpers.ts` without inverting the dependency —
		// the same reason `isContractError` carries its own `try`/`catch`.
		Object.defineProperty(this, 'guard', { writable: false, configurable: false })
		const guard = Object.getOwnPropertyDescriptor(this, 'guard')
		// The verification the previous round's argument left out. The line above is
		// a live dispatch, so an installation that silently did not happen is
		// indistinguishable from one that did until something asks.
		if (guard?.writable !== false || guard.configurable !== false) {
			throw new ContractError('ContractError: the recognition pin could not be installed', {
				code: 'structure',
			})
		}
		// The prototype gets the same treatment, walked by index rather than with
		// `map` or a spread: both are caller-writable members, and a verification
		// that dispatches through the surface it is verifying proves nothing.
		const members = Reflect.ownKeys(this.prototype)
		for (let index = 0; index < members.length; index += 1) {
			const key = members[index]
			if (key === undefined) continue
			Object.defineProperty(this.prototype, key, { writable: false, configurable: false })
			const pinned = Object.getOwnPropertyDescriptor(this.prototype, key)
			if (pinned?.writable !== false || pinned.configurable !== false) {
				throw new ContractError('ContractError: a prototype member could not be pinned', {
					code: 'structure',
				})
			}
		}
	}
}

/**
 * Determine whether an unknown value is a {@link ContractError}.
 *
 * @remarks
 * The ONLY spelling of the recognition question this package publishes. The test
 * itself is a private static of the class, because private-name membership is
 * legal only inside a class body; the one member on the path,
 * {@link ContractError.guard}, hands that test over and is pinned non-writable
 * and non-configurable while the class is defined. So there is no property a
 * caller can point somewhere else, and no member that ANSWERS the recognition
 * question — which is exactly what the static that preceded it did.
 *
 * A function declaration rather than a `const` holding the retrieved closure.
 * The retrieved form was tried and was wrong twice over: a module-scope binding
 * bound to a computed value is module DATA, which belongs in a data kind file
 * and not in the file that owns the error classes and their guards; and the
 * single read it bought guarded a window that does not exist, since the pin is
 * installed during class definition and no code can observe this member before
 * it. Reading a permanently pinned own data property per call buys the caller
 * nothing, so the guard is spelled as what it is.
 *
 * Recognition is realm-local and identity-based: a value from another copy of
 * this module is not this class's error, exactly as `instanceof` reported; a
 * `Proxy` over a genuine error is refused, because a proxy holds no private
 * field of its target; and `Reflect.construct(ContractError, args, Foreign)` IS
 * recognized, because that construction genuinely ran this constructor and only
 * the prototype was the caller's choice. That last consequence is a widening
 * rather than a narrowing, and it is named rather than left to be discovered.
 *
 * @param value - The value to inspect
 * @returns `true` only for a value this class's constructor branded
 *
 * @example
 * ```ts
 * isContractError(new ContractError('Invalid shape', { code: 'placement' })) // true
 * isContractError(new Error('Invalid shape')) // false
 * ```
 */
export function isContractError(value: unknown): value is ContractError {
	return ContractError.guard()(value)
}
