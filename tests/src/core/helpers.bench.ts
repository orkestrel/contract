// Times the field read a database pays per condition per row, and the presence mask every
// compiled object guard derives per call. Each answer is asserted before its cell is timed.
import { buildPositions, readPresence, resolveField } from '@src/core'
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
