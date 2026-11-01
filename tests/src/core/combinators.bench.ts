// Times the container combinators' guard bodies over retained fixtures, one `it` per case
// (scaffold `tests.md` § Probes); select one case with `-t`. The environment picks the build
// and the record: `COMBINATORS_ARM` names a build at `tmp/probes/<arm>/index.js`,
// `COMBINATORS_HASH` that entry's expected git blob hash, `COMBINATORS_PAD` the fraction of
// each reading's calls' wall spun after them, and `COMBINATORS_RECORD` the path of the process
// record. With no arm set, the bench times `@src/core` and checks no hash; with no record
// path, it writes no record. Each guard is bound to a module constant before any reading, so
// no module export getter runs inside one.
import {
	buildJudgmentPool,
	buildRecordPool,
	buildStringArray,
	buildStringRecord,
} from '../../setup.js'
import { loadContractEntry, measureCell, readBenchSettings } from '../../setupServer.js'
import { expect, it } from 'vitest'

const SETTINGS = readBenchSettings(process.env)
const { arrayOf, isFiniteNumber, isRecord, isString, optionalOf, recordOf } =
	await loadContractEntry(SETTINGS.arm, SETTINGS.hash)

// The back-to-back calls in one reading, fixed so one baseline reading holds at least 100 ms.
const ARRAY_CALLS = 60
const RECORD_CALLS = 260
const POOL_CALLS = 27
const JUDGMENT_CALLS = 1
const SHORT_CALLS = 640
const CELL_TIMEOUT = 300_000

const STRINGS = buildStringArray(10_000)
const SHORT_STRINGS = buildStringArray(1_000)
const WIDE = buildStringRecord(1_000, isString)
const POOL = buildRecordPool(1_000)
const JUDGMENTS = buildJudgmentPool(51_000)

const isStrings = arrayOf(isString)
const isWide = recordOf(WIDE.shape)
const isSmall = recordOf({
	id: isString,
	title: isString,
	state: isString,
	model: isString,
	tags: arrayOf(isString),
})
const isJudgment = recordOf(
	{
		id: isString,
		question: isRecord,
		model: isString,
		sources: arrayOf(isString),
		state: isString,
		time: isFiniteNumber,
		usage: optionalOf(isRecord),
		answer: isRecord,
	},
	['usage'],
)

it('checks a 10000-element string array', { timeout: CELL_TIMEOUT }, async ({ bench, task }) => {
	expect(isStrings(STRINGS)).toBe(true)
	const record = await measureCell(
		() => isStrings(STRINGS),
		{ ...SETTINGS, title: task.name, calls: ARRAY_CALLS },
		(sample, options) =>
			bench(task.name, { async: false, retainSamples: true }, sample).run(options),
	)
	expect(record.samples).toHaveLength(15)
	expect(record.tinybench.count).toBe(15)
})

it('checks a 1000-key string record', { timeout: CELL_TIMEOUT }, async ({ bench, task }) => {
	expect(isWide(WIDE.record)).toBe(true)
	const record = await measureCell(
		() => isWide(WIDE.record),
		{ ...SETTINGS, title: task.name, calls: RECORD_CALLS },
		(sample, options) =>
			bench(task.name, { async: false, retainSamples: true }, sample).run(options),
	)
	expect(record.samples).toHaveLength(15)
	expect(record.tinybench.count).toBe(15)
})

it('checks a pool of small records', { timeout: CELL_TIMEOUT }, async ({ bench, task }) => {
	expect(POOL.filter((value) => isSmall(value))).toHaveLength(625)
	const record = await measureCell(
		() => {
			for (const value of POOL) isSmall(value)
		},
		{ ...SETTINGS, title: task.name, calls: POOL_CALLS },
		(sample, options) =>
			bench(task.name, { async: false, retainSamples: true }, sample).run(options),
	)
	expect(record.samples).toHaveLength(15)
	expect(record.tinybench.count).toBe(15)
})

it('checks a pool of 51000 judgments', { timeout: CELL_TIMEOUT }, async ({ bench, task }) => {
	expect(JUDGMENTS.every((value) => isJudgment(value))).toBe(true)
	const record = await measureCell(
		() => {
			for (const value of JUDGMENTS) isJudgment(value)
		},
		{ ...SETTINGS, title: task.name, calls: JUDGMENT_CALLS },
		(sample, options) =>
			bench(task.name, { async: false, retainSamples: true }, sample).run(options),
	)
	expect(record.samples).toHaveLength(15)
	expect(record.tinybench.count).toBe(15)
})

it('checks a 1000-element string array', { timeout: CELL_TIMEOUT }, async ({ bench, task }) => {
	expect(isStrings(SHORT_STRINGS)).toBe(true)
	const record = await measureCell(
		() => isStrings(SHORT_STRINGS),
		{ ...SETTINGS, title: task.name, calls: SHORT_CALLS },
		(sample, options) =>
			bench(task.name, { async: false, retainSamples: true }, sample).run(options),
	)
	expect(record.samples).toHaveLength(15)
	expect(record.tinybench.count).toBe(15)
})
