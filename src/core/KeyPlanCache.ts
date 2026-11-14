import type { Guard, KeyStep } from './types.js'
import { INTRINSICS, KEY_PLAN_LIMIT } from './constants.js'
import { buildKeyPlan, matchesKeyPlan } from './helpers.js'

/**
 * Keeps the key plans one compiled closed-object guard learned from the key orders it accepted.
 *
 * @remarks
 * Its constructor takes the declared member guards of one object node. The guard calls the
 * {@link recall} method before its full walk and the {@link retain} method after a walk that
 * accepted. The cache learns only through the `retain` method, never evicts, and stops at
 * {@link KEY_PLAN_LIMIT} plans. Each plan is unfrozen and lives in the `#plans` field alone.
 * The `retain` method copies the plan list by index through the captured `Array.from`
 * function, so no array species is consulted.
 */
export class KeyPlanCache {
	readonly #guards: Readonly<Record<string, Guard<unknown> | undefined>>
	#plans: ReadonlyArray<readonly KeyStep[]>

	constructor(guards: Readonly<Record<string, Guard<unknown> | undefined>>) {
		this.#guards = guards
		this.#plans = []
	}

	/** Returns the plan kept for a key order, or `undefined` when none answers it. */
	recall(keys: readonly string[]): readonly KeyStep[] | undefined {
		const found: number = INTRINSICS.reflect.apply(INTRINSICS.find, this.#plans, [
			matchesKeyPlan,
			keys,
		])
		return found === -1 ? undefined : this.#plans[found]
	}

	/** Keeps the plan for an accepted key order while room remains and every key is declared. */
	retain(keys: readonly string[]): void {
		const plans = this.#plans
		if (plans.length >= KEY_PLAN_LIMIT || this.recall(keys) !== undefined) return
		const plan = buildKeyPlan(keys, this.#guards)
		if (plan === undefined) return
		// A prototype-free array-like reaches no iterator and no species, as the `readArrayEntries` helper copies.
		const indices = { __proto__: null, length: plans.length + 1 }
		this.#plans = INTRINSICS.from(indices, (_entry: unknown, index: number) =>
			index < plans.length ? (plans[index] ?? plan) : plan,
		)
	}
}
