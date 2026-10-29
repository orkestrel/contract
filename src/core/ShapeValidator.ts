import type { ContractShape, ShapeValidatorInterface } from './types.js'
import { INTRINSICS } from './constants.js'
import { pinMembers } from './helpers.js'
import { ShapePass } from './ShapePass.js'

/**
 * Validates one retained contract-shape source live on every call.
 *
 * @remarks
 * Construction performs no source observation. Every non-overlapping
 * {@link validate} call starts a fresh pass over the source's current state.
 * Reentry poisons the active pass with one shared cause-free structure error;
 * cleanup always restores an idle validator for the next independent call.
 *
 * @example
 * ```ts
 * const validator = new ShapeValidator({ category: 'string', min: 1 })
 * validator.validate()
 * ```
 */
export class ShapeValidator implements ShapeValidatorInterface {
	readonly #source: ContractShape
	readonly #passes = new INTRINSICS.set<ShapePass>()
	#expansion: number | undefined

	/**
	 * Retains a shape source without observing it.
	 *
	 * @param shape - The live shape source validated by each call
	 */
	constructor(shape: ContractShape) {
		this.#source = shape
	}

	/**
	 * Reports the number of nodes the last successful {@link validate} found the
	 * source expands into.
	 *
	 * @remarks
	 * One per node per INCOMING EDGE, summed bottom-up — the size of the tree a
	 * compiler would build from this DAG, which a node count of the declaration
	 * itself does not describe. `undefined` before the first successful pass and
	 * after a failed one, because a failed pass has no expansion to report and
	 * `0` is a measurement no declaration produces.
	 */
	get expansion(): number | undefined {
		return this.#expansion
	}

	/**
	 * Validates the retained source's current declaration.
	 *
	 * @remarks
	 * The whole traversal is contained, and a failure this class did not author
	 * is translated into `validateShape: shape reflection failed` carrying
	 * the exact thrown value. Containment is what makes that claim hold for
	 * dispatch nobody enumerated — including the recognition of an authored error,
	 * which is why that recognition is no longer answerable by any member a caller
	 * can write. The sentence this replaces asserted the same conclusion from the
	 * absence of reachable dispatch, and the absence was not established.
	 *
	 * @returns Nothing when the declaration is valid
	 * @throws {ContractError} When the declaration is malformed, cyclic, too deep, unreadable, or reentered
	 */
	validate(): void {
		INTRINSICS.reflect.apply(INTRINSICS.sweep, this.#passes, [
			(pass: ShapePass) => pass.interrupt(),
		])
		const pass = new ShapePass(this.#source)
		INTRINSICS.reflect.apply(INTRINSICS.admit, this.#passes, [pass])
		this.#expansion = undefined
		try {
			this.#expansion = pass.validate()
		} finally {
			INTRINSICS.reflect.apply(INTRINSICS.remove, this.#passes, [pass])
		}
	}

	static {
		pinMembers(ShapeValidator.prototype, 'ShapeValidator')
	}
}
