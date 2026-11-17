// Times the field read a database pays per condition per row, the presence mask every compiled
// object guard derives per call, and the preview a refusal carries. Each answer is asserted before
// its cell is timed, and each preview cell annotates its median latency in milliseconds.
import { buildPositions, ContractError, preview, readPresence, resolveField } from '@src/core'
import { ROW_BENCH_VALUE } from '../../setup.js'
import { expect, it } from 'vitest'

const NAMES = Object.freeze(Object.keys(ROW_BENCH_VALUE))
const POSITIONS = buildPositions(['id', 'organization', 'rank', 'body', 'active'])

it('resolves a one-key path', async ({ bench }) => {
	expect(resolveField(ROW_BENCH_VALUE, 'organization')).toBe('o1')
	const result = await bench('resolves a one-key path', {}, () => {
		resolveField(ROW_BENCH_VALUE, 'organization')
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('derives a presence mask over six names', async ({ bench }) => {
	expect(readPresence(NAMES, POSITIONS)).toBe(31)
	const result = await bench('derives a presence mask over six names', {}, () => {
		readPresence(NAMES, POSITIONS)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

const SHORT = 'x'.repeat(40)
const LONG = `${'line "quoted" \\ end\n'.repeat(12)}\u2028${'x'.repeat(20_000)}`
const ROUNDS = 5
// A long preview encodes one window of at most `PREVIEW_LIMIT` units where a short one encodes its
// whole text, so the two sit in one cost class. Three runs read the long median at 2.13 to 2.16
// times the short median, each run's five rounds within 5% of their own median, so the bound is 3,
// which leaves the spread room and keeps a per-code-point recursion far outside it.
const LONG_OVER_SHORT = 3
// The error that carries a preview costs more than the preview, as the same three runs read the
// long median at 0.28 to 0.29 of the construction median; the bound is the construction itself.
const LONG_OVER_ERROR = 1

function readMedian(values: readonly number[]): number {
	return [...values].sort((left, right) => left - right)[Math.floor(values.length / 2)] ?? 0
}

function buildError(): ContractError {
	return new ContractError('door: value must be a string', {
		code: 'structure',
		context: { path: ['id'], received: SHORT },
	})
}

const CELLS = [
	{ key: 'short', name: 'previews a short string', run: () => preview(SHORT) },
	{ key: 'long', name: 'previews a long string', run: () => preview(LONG) },
	{ key: 'error', name: 'constructs the error that carries a preview', run: buildError },
] as const

it('previews a long string in the cost class of a short one', async ({ bench, annotate }) => {
	expect(preview(SHORT)).toBe(`"${SHORT}"`)
	expect(preview(LONG).endsWith('…')).toBe(true)
	const readings: Record<string, number[]> = { short: [], long: [], error: [] }
	for (const round of Array.from({ length: ROUNDS }).keys()) {
		expect(round).toBeLessThan(ROUNDS)
		for (const { key, name, run } of CELLS) {
			const result = await bench(name, {}, run).run({ time: 500 })
			expect(result.state).toBe('completed')
			if (result.state === 'completed') readings[key]?.push(result.latency.p50)
		}
	}
	const [short, long, error] = CELLS.map(({ key }) => readMedian(readings[key] ?? []))
	await annotate(`readings ${JSON.stringify(readings)}`, 'reading')
	await annotate(`long over short ${(long ?? 0) / (short ?? 1)}`, 'reading')
	await annotate(`long over error ${(long ?? 0) / (error ?? 1)}`, 'reading')
	expect((long ?? 0) / (short ?? 1)).toBeLessThanOrEqual(LONG_OVER_SHORT)
	expect(long ?? 0).toBeLessThanOrEqual((error ?? 0) * LONG_OVER_ERROR)
})
