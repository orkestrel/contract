// `SampleInferer` is interned: it carries no barrel row, `tests/guides.test.ts` names it
// in `INTERNAL`, and this suite therefore reaches the class by relative source path.
// `samplesToSchema` is the only door that constructs it, so the per-walk memo the
// readings below hit and miss is reachable from here alone.
import type { JSONSchema } from '@src/core'
import { INFER_DEPTH_LIMIT, INFER_BREADTH_LIMIT } from '@src/core'
import { describe, expect, it } from 'vitest'
import { SampleInferer } from '../../../src/core/SampleInferer.js'

describe('SampleInferer — the ordered row-prefix memo', () => {
	it('serves a second slot collecting the same rows in the same order', () => {
		const child: Record<string, unknown> = { count: 1 }
		const rows: readonly unknown[] = [
			{ first: child, second: child },
			{ first: child, second: child },
		]
		const schema = new SampleInferer(
			rows,
			INFER_DEPTH_LIMIT,
			INFER_BREADTH_LIMIT,
			true,
			false,
			false,
		).infer()

		const first = schema.properties?.['first']
		const second = schema.properties?.['second']
		expect(first).toEqual({
			type: 'object',
			properties: { count: { type: 'integer' } },
			required: ['count'],
			additionalProperties: false,
		})
		// Both slots follow the same row identities in the same order, so the second
		// lands on the node the first recorded and is served that exact schema.
		expect(second).toBe(first)
	})

	it('serves no second slot whose rows arrive in a different order', () => {
		const alpha: Record<string, unknown> = { count: 1 }
		const beta: Record<string, unknown> = { label: 'Ada' }
		const rows: readonly unknown[] = [
			{ first: alpha, second: beta },
			{ first: beta, second: alpha },
		]
		const schema = new SampleInferer(
			rows,
			INFER_DEPTH_LIMIT,
			INFER_BREADTH_LIMIT,
			true,
			false,
			false,
		).infer()

		const first = schema.properties?.['first']
		const second = schema.properties?.['second']
		// The row list is the key, followed one row at a time, so a reversed list is a
		// different node and the second slot computes its own answer.
		expect(second).toEqual(first)
		expect(second).not.toBe(first)
	})

	it('serves no second slot reaching the same node at a different remaining depth', () => {
		const child: Record<string, unknown> = { count: 1 }
		const nested: Record<string, unknown> = { inner: child }
		const rows: readonly unknown[] = [
			{ shallow: child, deep: nested },
			{ shallow: child, deep: nested },
		]
		const schema = new SampleInferer(
			rows,
			INFER_DEPTH_LIMIT,
			INFER_BREADTH_LIMIT,
			true,
			false,
			false,
		).infer()

		const shallow = schema.properties?.['shallow']
		const inner = schema.properties?.['deep']?.properties?.['inner']
		// Both slots reach the node keyed by the row list `[child, child]`, one level
		// apart. Remaining depth is part of the recorded signature, so the deeper slot
		// computes its own answer rather than reading the shallower one's.
		expect(inner).toEqual(shallow)
		expect(inner).not.toBe(shallow)
	})

	it('carries no memo across two walks over one row list', () => {
		const child: Record<string, unknown> = { count: 1 }
		const rows: readonly unknown[] = [{ first: child }, { first: child }]
		const budgets = [INFER_DEPTH_LIMIT, INFER_BREADTH_LIMIT, true, false, false] as const
		const firstWalk = new SampleInferer(rows, ...budgets).infer()
		const secondWalk = new SampleInferer(rows, ...budgets).infer()

		// The memo is built in the constructor, so one walk can never be handed
		// another walk's answer however identical the rows are.
		expect(secondWalk).toEqual(firstWalk)
		expect(secondWalk.properties?.['first']).not.toBe(firstWalk.properties?.['first'])
	})
})

describe('SampleInferer — the recorded flags', () => {
	it('reports a different opening for each closed flag over one row list', () => {
		const rows: readonly unknown[] = [{ count: 1 }, { count: 2 }]
		const closed: JSONSchema = new SampleInferer(
			rows,
			INFER_DEPTH_LIMIT,
			INFER_BREADTH_LIMIT,
			true,
			false,
			false,
		).infer()
		const open: JSONSchema = new SampleInferer(
			rows,
			INFER_DEPTH_LIMIT,
			INFER_BREADTH_LIMIT,
			false,
			false,
			false,
		).infer()

		expect(closed.additionalProperties).toBe(false)
		expect(open.additionalProperties).toBe(true)
	})
})
