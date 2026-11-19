import type { EvaluationFunction } from './types.js'
import { INTRINSICS } from './constants.js'
import { isFailure, readSetEntries } from './helpers.js'
import { isFunction, isObject } from './validators.js'

/** Owns compiled-node memo entries for one synchronous evaluation. */
export class EvaluationScope {
	static readonly #active = new INTRINSICS.set<EvaluationScope>()
	static readonly #path: readonly string[] = INTRINSICS.freeze([])
	#answers: WeakMap<object, WeakMap<object, unknown>> | undefined

	/** Evaluates a node within the active call, disposing a newly opened scope on settlement. */
	static run<T>(
		plan: EvaluationFunction<T>,
		value: unknown,
		path: readonly string[] = EvaluationScope.#path,
		clean = false,
	): T {
		if (!isObject(value) && !isFunction(value)) return plan(value, path)
		const active = EvaluationScope.#read()
		if (active instanceof EvaluationScope) return active.#evaluate(plan, value, path, clean)
		if (active !== undefined) throw new INTRINSICS.error('Evaluation scope is unavailable')
		const scope = new EvaluationScope()
		INTRINSICS.reflect.apply(INTRINSICS.admit, EvaluationScope.#active, [scope])
		try {
			// The opening answer is stored only after its walk returns, and the scope settles
			// right after, so no read could recall it: the opening call asks the plan alone.
			return plan(value, path)
		} finally {
			INTRINSICS.reflect.apply(INTRINSICS.remove, EvaluationScope.#active, [scope])
		}
	}

	// Reads the registry's sole entry, or `undefined` while it is empty.
	static #read(): unknown {
		const count = INTRINSICS.count
		if (count !== undefined && INTRINSICS.reflect.apply(count, EvaluationScope.#active, []) === 0) {
			return undefined
		}
		const entries = readSetEntries(EvaluationScope.#active)
		if (isFailure(entries)) throw entries.error
		return entries.value[0]
	}

	#evaluate<T>(
		plan: EvaluationFunction<T>,
		value: object,
		path: readonly string[],
		clean: boolean,
	): T {
		// A root call that reaches no nested node never builds the per-plan table.
		const answers = (this.#answers ??= new INTRINSICS.weakMap<object, WeakMap<object, unknown>>())
		const cached: WeakMap<object, unknown> | undefined = INTRINSICS.reflect.apply(
			INTRINSICS.recall,
			answers,
			[plan],
		)
		const memo = cached ?? new INTRINSICS.weakMap<object, unknown>()
		if (cached === undefined) {
			INTRINSICS.reflect.apply(INTRINSICS.retain, answers, [plan, memo])
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
