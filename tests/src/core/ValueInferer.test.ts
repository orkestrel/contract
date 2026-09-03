// `ValueInferer` is interned: it carries no barrel row, `tests/guides.test.ts` names it
// in `INTERNAL`, and this suite therefore reaches the class by relative source path.
// Its doors sanitize every budget through `sanitizeDepth` and `sanitizeBudget` before
// construction, so an unsanitized budget — the state the class documents itself as
// assuming away — is reachable from here and nowhere else.
import type { JSONSchema } from '@src/core'
import { INFER_DEPTH_LIMIT, valueToSchema } from '@src/core'
import { describe, expect, it } from 'vitest'
import { ValueInferer } from '../../../src/core/ValueInferer.js'

describe('ValueInferer — an unsanitized depth budget', () => {
	it('widens a container root for every budget that is not above zero', () => {
		// `NaN` reaches the same branch as zero because the guard is written
		// `!(depth > 0)` rather than `depth <= 0`, which `NaN` would pass through.
		const budgets = [0, -1, -0.5, Number.NaN, Number.NEGATIVE_INFINITY]
		const readings = budgets.map((depth) => ({
			budget: String(depth),
			record: new ValueInferer({ name: 'Ada' }, depth, 8, true, false).infer(),
			list: new ValueInferer(['Ada'], depth, 8, true, false).infer(),
		}))

		expect(readings).toEqual(
			budgets.map((depth) => ({ budget: String(depth), record: {}, list: {} })),
		)
	})

	it('classifies a leaf root without consulting the budget', () => {
		expect(new ValueInferer('Ada', Number.NaN, 8, true, false).infer()).toEqual({
			type: 'string',
		})
		expect(new ValueInferer(7, -3, 8, true, false).infer()).toEqual({ type: 'integer' })
		expect(new ValueInferer(null, Number.NEGATIVE_INFINITY, 8, true, false).infer()).toEqual({
			type: 'null',
		})
	})

	it('descends exactly one level on a fractional budget', () => {
		const schema = new ValueInferer({ nested: { leaf: 1 } }, 0.5, 8, true, false).infer()

		// One level is emitted for the 0.5 budget; the child is walked at -0.5 and widens.
		expect(schema).toEqual({
			type: 'object',
			properties: { nested: {} },
			required: ['nested'],
			additionalProperties: false,
		})
	})

	it('descends past the cap the door imposes', () => {
		let deep: Record<string, unknown> = { leaf: 1 }
		for (let level = 0; level < INFER_DEPTH_LIMIT * 2; level += 1) deep = { nested: deep }

		let direct = 0
		let node: JSONSchema | undefined = new ValueInferer(
			deep,
			INFER_DEPTH_LIMIT + 4,
			8,
			false,
			false,
		).infer()
		while (node !== undefined) {
			direct += 1
			node = node.properties?.nested
		}

		let capped = 0
		let doorNode: JSONSchema | undefined = valueToSchema(deep, { closed: false })
		while (doorNode !== undefined) {
			capped += 1
			doorNode = doorNode.properties?.nested
		}

		expect(capped).toBe(INFER_DEPTH_LIMIT + 1)
		expect(direct).toBe(INFER_DEPTH_LIMIT + 5)
	})
})

describe('ValueInferer — an unsanitized breadth budget', () => {
	it('samples no key and forces the object open when the budget is negative', () => {
		const schema = new ValueInferer({ first: 1, second: 2 }, 4, -1, true, false).infer()

		// Every key is truncated away, and a closed schema built from an empty key
		// list would reject the object it was inferred from.
		expect(schema).toEqual({ type: 'object', additionalProperties: true })
	})

	it('samples no element and reports a bare array when the budget is negative', () => {
		expect(new ValueInferer([1, 2, 3], 4, -1, true, false).infer()).toEqual({ type: 'array' })
	})

	it('samples one key on a fractional budget below one', () => {
		const schema = new ValueInferer({ first: 1, second: 2 }, 4, 0.5, true, false).infer()

		// The bound is compared per index, so a budget of 0.5 admits index 0 alone.
		expect(schema).toEqual({
			type: 'object',
			properties: { first: { type: 'integer' } },
			required: ['first'],
			additionalProperties: true,
		})
	})
})
