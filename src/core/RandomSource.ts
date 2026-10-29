import { INTRINSICS } from './constants.js'

/** Owns the changing state projected by one seeded random function. */
export class RandomSource {
	#state: number

	constructor(seed: number) {
		this.#state = seed >>> 0
	}

	/** Advances the generator and returns its next unit-interval value. */
	next(): number {
		this.#state = (this.#state + 0x6d2b79f5) >>> 0
		const mixed = INTRINSICS.imul(this.#state ^ (this.#state >>> 15), this.#state | 1)
		const final = mixed ^ (mixed + INTRINSICS.imul(mixed ^ (mixed >>> 7), mixed | 61))
		return ((final ^ (final >>> 14)) >>> 0) / 4_294_967_296
	}
}
