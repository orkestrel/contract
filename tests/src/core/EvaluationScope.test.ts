import { createContract } from '@src/core'
import { createRecorder } from '@orkestrel/test'
import { EvaluationScope } from '../../../src/core/EvaluationScope.js'
import { buildCleanPlan, buildCountedStore, STORE_DECLARATION } from '../../setup.js'
import { describe, expect, it } from 'vitest'

describe('EvaluationScope', () => {
	it.each([
		['an object', {}],
		['a function', encodeURI],
	])('opens a scope for %s that recalls a clean answer', (_name, value) => {
		const asked = createRecorder<readonly [unknown]>()
		const plan = buildCleanPlan(asked.handler)
		const answers = EvaluationScope.run(
			(subject) => [
				EvaluationScope.run(plan, subject, [], true),
				EvaluationScope.run(plan, subject, ['again'], true),
			],
			value,
		)
		expect(answers).toEqual([[], []])
		expect(asked.calls).toEqual([[value]])
	})

	it('asks the plan every time about a primitive, which no scope can hold', () => {
		const asked = createRecorder<readonly [unknown]>()
		const plan = buildCleanPlan(asked.handler)
		EvaluationScope.run(
			(subject) => [
				EvaluationScope.run(plan, subject, [], true),
				EvaluationScope.run(plan, subject, [], true),
			],
			'session',
		)
		expect(asked.calls).toEqual([['session'], ['session']])
	})

	it.each(['prototype', 'function'] as const)(
		'reads each declared member of a %s implementation one time across an audit and a parse in one scope',
		(form) => {
			const contract = createContract(STORE_DECLARATION)
			const reads = createRecorder<readonly [string]>()
			const store = buildCountedStore(form, reads.handler)
			const answers = EvaluationScope.run(
				(subject) => [contract.audit(subject), contract.parse(subject)],
				store,
			)
			expect(answers[0]).toEqual([])
			expect(answers[1]).toBe(store)
			expect(reads.calls).toEqual([['get'], ['set'], ['delete']])
			reads.clear()
			contract.audit(store)
			contract.parse(store)
			expect(reads.calls).toEqual([['get'], ['set'], ['delete'], ['get'], ['set'], ['delete']])
		},
	)
})
