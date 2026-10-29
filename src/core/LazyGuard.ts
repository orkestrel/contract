import type { Guard } from './types.js'
import { GUARD_DEPTH_LIMIT } from './constants.js'
import { holds } from './helpers.js'

/** Owns the active depth shared by calls to one deferred guard. */
export class LazyGuard<T> {
	readonly #thunk: () => Guard<T>
	#depth = 0

	constructor(thunk: () => Guard<T>) {
		this.#thunk = thunk
	}

	/** Tests one value within the guard's shared recursion allowance. */
	test(value: unknown): value is T {
		if (this.#depth >= GUARD_DEPTH_LIMIT) return false
		this.#depth += 1
		try {
			return holds(() => this.#thunk()(value))
		} finally {
			this.#depth -= 1
		}
	}
}
