import type { EvaluationFunction } from './types.js'
import { INTRINSICS } from './constants.js'
import { readSetEntries } from './helpers.js'
import { isObject } from './validators.js'

/** Owns compiled-node memo entries for one synchronous evaluation. */
export class EvaluationScope {
	static readonly #active = new INTRINSICS.set<EvaluationScope>()
	static readonly #path: readonly string[] = INTRINSICS.freeze([])
	readonly #answers = new INTRINSICS.weakMap<object, WeakMap<object, unknown>>()

	/** Evaluates a node within the active call, disposing a newly opened scope on settlement. */
	static run<T>(
		plan: EvaluationFunction<T>,
		value: unknown,
		path: readonly string[] = EvaluationScope.#path,
		clean = false,
	): T {
		if (!isObject(value)) return plan(value, path)
		const entries = readSetEntries(EvaluationScope.#active)
		if (!entries.success) throw entries.error
		const active = entries.value[0]
		if (active instanceof EvaluationScope) return active.#evaluate(plan, value, path, clean)
		if (active !== undefined) throw new INTRINSICS.error('Evaluation scope is unavailable')
		const scope = new EvaluationScope()
		INTRINSICS.reflect.apply(INTRINSICS.admit, EvaluationScope.#active, [scope])
		try {
			return scope.#evaluate(plan, value, path, clean)
		} finally {
			INTRINSICS.reflect.apply(INTRINSICS.remove, EvaluationScope.#active, [scope])
		}
	}

	#evaluate<T>(
		plan: EvaluationFunction<T>,
		value: object,
		path: readonly string[],
		clean: boolean,
	): T {
		const cached: WeakMap<object, unknown> | undefined = INTRINSICS.reflect.apply(
			INTRINSICS.recall,
			this.#answers,
			[plan],
		)
		const memo = cached ?? new INTRINSICS.weakMap<object, unknown>()
		if (cached === undefined) {
			INTRINSICS.reflect.apply(INTRINSICS.retain, this.#answers, [plan, memo])
		}
		const recalled: T | undefined = INTRINSICS.reflect.apply(INTRINSICS.recall, memo, [value])
		if (recalled !== undefined) return recalled
		const answer = plan(value, path)
		if (!clean || (INTRINSICS.array(answer) && answer.length === 0)) {
			INTRINSICS.reflect.apply(INTRINSICS.retain, memo, [value, answer])
		}
		return answer
	}
}
