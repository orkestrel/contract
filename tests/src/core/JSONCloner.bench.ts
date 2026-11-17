// Times the JSON clone door on a wide record, a small record, a deep chain, a refusal at a deep
// path, and a list of small records, and bounds the wide record against a native JSON round trip
// of the same record. Each answer is asserted before its cell is timed.
import { cloneJSONValue } from '@src/core'
import {
	buildDeepNest,
	buildRowPool,
	buildWideRecord,
	captureContractError,
	CLONE_BENCH_ROW,
} from '../../setup.js'
import { expect, it } from 'vitest'

const WIDE = buildWideRecord(1000)
const DEEP = buildDeepNest(2000)
const REFUSED = buildDeepNest(500, Math.max)
const POOL = buildRowPool(200)
const ROUNDS = 5
// Six runs of this bench on 2026-11-17 read the wide clone at 2.11 to 2.19 times a native JSON
// round trip of the same record, and three runs with the per-member `define` restored read 2.77 to
// 2.84 times, so the bound sits between the two ranges.
const WIDE_OVER_NATIVE = 2.5
const WIDE_CELLS = [
	{ key: 'clone', name: 'clones a wide record', run: () => cloneJSONValue(WIDE) },
	{
		key: 'native',
		name: 'round-trips the wide record through JSON text',
		run: () => JSON.parse(JSON.stringify(WIDE)),
	},
] as const

function readMedian(values: readonly number[]): number {
	return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0
}

it('clones a wide record within a bound of a native JSON round trip', async ({
	bench,
	annotate,
}) => {
	expect(cloneJSONValue(WIDE)).toEqual(JSON.parse(JSON.stringify(WIDE)))
	const readings: Record<string, number[]> = { clone: [], native: [] }
	for (const round of Array.from({ length: ROUNDS }).keys()) {
		expect(round).toBeLessThan(ROUNDS)
		for (const { key, name, run } of WIDE_CELLS) {
			const result = await bench(name, {}, run).run({ time: 500 })
			expect(result.state).toBe('completed')
			if (result.state === 'completed') readings[key]?.push(result.latency.p50)
		}
	}
	const [clone, native] = WIDE_CELLS.map(({ key }) => readMedian(readings[key] ?? []))
	await annotate(`readings ${JSON.stringify(readings)}`, 'reading')
	await annotate(`clone over native ${(clone ?? 0) / (native ?? 1)}`, 'reading')
	expect((clone ?? 0) / (native ?? 1)).toBeLessThanOrEqual(WIDE_OVER_NATIVE)
})

it('clones a small record', async ({ bench }) => {
	expect(cloneJSONValue(CLONE_BENCH_ROW)).toEqual(CLONE_BENCH_ROW)
	const result = await bench('clones a small record', {}, () =>
		cloneJSONValue(CLONE_BENCH_ROW),
	).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('clones a deep chain', async ({ bench }) => {
	expect(cloneJSONValue(DEEP)).toEqual(DEEP)
	const result = await bench('clones a deep chain', {}, () => cloneJSONValue(DEEP)).run({
		time: 1000,
	})
	expect(result.state).toBe('completed')
})

it('refuses a function at a deep path', async ({ bench }) => {
	const refusal = captureContractError(() => cloneJSONValue(REFUSED))
	expect(refusal.context?.path).toHaveLength(500)
	const result = await bench('refuses a function at a deep path', {}, () =>
		captureContractError(() => cloneJSONValue(REFUSED)),
	).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('clones a list of small records', async ({ bench }) => {
	expect(cloneJSONValue(POOL)).toEqual(POOL)
	const result = await bench('clones a list of small records', {}, () => cloneJSONValue(POOL)).run({
		time: 1000,
	})
	expect(result.state).toBe('completed')
})
