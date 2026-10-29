import type { RandomFunction } from './types.js'
import { ContractError } from './errors.js'
import { preview } from './helpers.js'
import { RandomSource } from './RandomSource.js'
import { isNumber } from './validators.js'

/**
 * Builds a deterministic pseudo-random source seeded from a single number.
 *
 * @remarks
 * A mulberry32 generator — the same seed always yields the same sequence, so
 * generated seed data is reproducible across runs. Used as the default random
 * source for {@link compileGenerator}, seeded from the wall clock so casual
 * callers still get varied output without passing a source themselves.
 *
 * @param seed - The seed for the sequence
 * @returns A {@link RandomFunction} returning values in `[0, 1)`
 *
 * @example
 * ```ts
 * const random = seededRandom(42)
 * random() // always the same first value for seed 42
 * ```
 */
export function seededRandom(seed: number): RandomFunction {
	if (!isNumber(seed)) {
		throw new ContractError('seededRandom: seed must be a number', {
			code: 'random',
			context: { limit: 'number', received: preview(seed) },
		})
	}
	const source = new RandomSource(seed)
	return () => source.next()
}
