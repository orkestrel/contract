// The proof for `tests/setupServer.ts`. Its subject is the Node-only seams the
// `src:core` suites import directly: values built inside a genuine foreign
// JavaScript realm, and a collection request served by the real V8 collector.
// Each expectation is derived through `node:vm` and the host's own reflection
// rather than through the module under proof, so a seam that stopped crossing a
// realm boundary — or stopped collecting — reports here.
import type { BenchRecord } from './setupServer.js'
import { readFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { isMainThread } from 'node:worker_threads'
import * as core from '@src/core'
import {
	createForeignPrototype,
	createForeignRecord,
	createForeignRegExp,
	createForeignStringShape,
	requestWeakReferenceCollection,
	computeBlobHash,
	computeOtherLoad,
	isContractEntry,
	loadContractEntry,
	measureCell,
	measureSample,
	measureWarmups,
	readBenchSettings,
	readHostTimes,
	writeBenchRecord,
} from './setupServer.js'
import { createRecorder } from '@orkestrel/test'
import { createScratch } from '@orkestrel/test/server'
import { describe, expect, it } from 'vitest'

describe('foreign realm sources', () => {
	it('builds a record and a string declaration this realm did not construct', () => {
		const record = createForeignRecord()
		expect(record).toEqual({ value: 1 })
		// The whole point of the seam: structurally a plain record, yet nothing on
		// its chain belongs to this realm, so every ownership door meets a value it
		// cannot have built.
		expect(record instanceof Object).toBe(false)
		expect(Object.getPrototypeOf(record)).not.toBe(Object.prototype)
		expect(Object.getPrototypeOf(record).constructor).not.toBe(Object)

		const shape = createForeignStringShape()
		expect(shape).toEqual({ category: 'string' })
		expect(shape instanceof Object).toBe(false)
	})

	it('builds a pattern carrying the requested source and flags outside this realm', () => {
		const flagged = createForeignRegExp('a+', 'gi')
		expect(String(flagged)).toBe('/a+/gi')
		expect(flagged instanceof RegExp).toBe(false)
		// A foreign pattern still answers the brand every reader identifies a
		// pattern by, which is what makes it a hostile input rather than a stranger.
		expect(Object.prototype.toString.call(flagged)).toBe('[object RegExp]')

		const unflagged = createForeignRegExp('b')
		expect(String(unflagged)).toBe('/b/')
	})

	it('builds a fresh realm prototype per call that this realm does not share', () => {
		const first = createForeignPrototype()
		const second = createForeignPrototype()
		expect(first).not.toBe(second)
		expect(first).not.toBe(Object.prototype)
		expect(Object.getPrototypeOf(first)).toBeNull()
		expect(typeof Reflect.get(first, 'hasOwnProperty')).toBe('function')

		// The isolation claim the fixture exists for: a test may install an
		// inherited member on the returned prototype without reaching this realm or
		// any other caller's realm.
		Reflect.defineProperty(first, 'planted', { configurable: true, value: 'installed' })
		try {
			expect(Reflect.get(first, 'planted')).toBe('installed')
			expect(Object.hasOwn(second, 'planted')).toBe(false)
			expect(Object.hasOwn(Object.prototype, 'planted')).toBe(false)
		} finally {
			Reflect.deleteProperty(first, 'planted')
		}
	})
})

describe('weak reference collection', () => {
	it('collects an unreachable target and returns while a reachable one survives', async () => {
		const unreachable = new WeakRef({ payload: 'x'.repeat(1_024) })
		await requestWeakReferenceCollection([unreachable])
		expect(unreachable.deref()).toBeUndefined()

		// The bound is the other half of the contract: a reference the caller still
		// holds can never clear, so the request has to stop asking rather than run
		// forever, and the surviving target proves the rounds really ran.
		const retained = { keep: 1 }
		const reachable = new WeakRef(retained)
		await requestWeakReferenceCollection([reachable])
		expect(reachable.deref()).toBe(retained)

		// The exposure is undone, so a later realm gets the collector it would have
		// had if this request had never run.
		expect(runInNewContext('typeof gc')).toBe('undefined')
	})
})

describe('combinator bench seams', () => {
	it('computes the blob hash git prints for the same bytes', () => {
		expect(computeBlobHash(new Uint8Array())).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
		expect(computeBlobHash(new TextEncoder().encode('hello\n'))).toBe(
			'ce013625030ba8dba906f756967f9e9ca394464a',
		)
	})

	it('accepts a namespace exporting every timed member and refuses one lacking any', () => {
		expect(isContractEntry(core)).toBe(true)
		expect(isContractEntry({ ...core, recordOf: undefined })).toBe(false)
		expect(isContractEntry({})).toBe(false)
		expect(isContractEntry(1)).toBe(false)
	})

	it('loads the source entry when no arm is set', async () => {
		const entry = await loadContractEntry(undefined, undefined)
		expect(entry.arrayOf).toBe(core.arrayOf)
		expect(entry.recordOf).toBe(core.recordOf)
	})

	it('loads an arm entry whose hash matches and refuses a stale or missing one', async () => {
		const scratch = createScratch()
		try {
			const text = [
				'export function arrayOf() {}',
				'export function isFiniteNumber() {}',
				'export function isRecord() {}',
				'export function isString() {}',
				'export function optionalOf() {}',
				'export function recordOf() {}',
				'',
			].join('\n')
			const path = scratch.write('tmp/probes/alpha/index.js', text)
			const hash = computeBlobHash(readFileSync(path))
			const entry = await loadContractEntry('alpha', hash, scratch.path)
			expect(entry.arrayOf.name).toBe('arrayOf')
			expect(entry.recordOf.name).toBe('recordOf')

			await expect(loadContractEntry('alpha', '0'.repeat(40), scratch.path)).rejects.toThrow(
				'is stale',
			)
			await expect(loadContractEntry('beta', hash, scratch.path)).rejects.toThrow('is missing')
			await expect(loadContractEntry('alpha', undefined, scratch.path)).rejects.toThrow(
				'names no expected hash',
			)
			await expect(loadContractEntry('../alpha', hash, scratch.path)).rejects.toThrow(
				'is not one lowercase word',
			)

			const partial = scratch.write(
				'tmp/probes/gamma/index.js',
				text.replace('export function recordOf() {}\n', ''),
			)
			await expect(
				loadContractEntry('gamma', computeBlobHash(readFileSync(partial)), scratch.path),
			).rejects.toThrow('lacks a guard or combinator')
		} finally {
			scratch.destroy()
		}
	})

	it('reads the bench settings and refuses an invalid pad', () => {
		expect(
			readBenchSettings({
				COMBINATORS_ARM: 'baseline',
				COMBINATORS_HASH: 'abc',
				COMBINATORS_PAD: '0.25',
				COMBINATORS_RECORD: 'record.json',
			}),
		).toEqual({ arm: 'baseline', hash: 'abc', pad: 0.25, record: 'record.json' })
		expect(readBenchSettings({})).toEqual({
			arm: undefined,
			hash: undefined,
			pad: 0,
			record: undefined,
		})
		expect(() => readBenchSettings({ COMBINATORS_PAD: 'wide' })).toThrow('is invalid')
		expect(() => readBenchSettings({ COMBINATORS_PAD: '-0.1' })).toThrow('is invalid')
	})

	it('times every call of a reading and spins a padded reading to its share', () => {
		const recorder = createRecorder()
		const plain = measureSample(recorder.handler, 100, 0)
		expect(recorder.count).toBe(100)
		expect(plain.wall).toBe(plain.work)

		const padded = measureSample(
			() => [...'abcdefghijklmnopqrstuvwxyz'].reverse().join(''),
			2_000,
			0.5,
		)
		expect(padded.work).toBeGreaterThan(0)
		expect(padded.wall).toBeGreaterThanOrEqual(padded.work * 1.5)
	})

	it('stops warming at 30 readings or once 2 readings hold 1 s of calls', () => {
		const recorder = createRecorder()
		expect(measureWarmups(recorder.handler, 1, 0)).toHaveLength(30)
		expect(recorder.count).toBe(30)

		const long = measureWarmups(
			() => {
				const deadline = performance.now() + 520
				while (performance.now() < deadline) {
					// The call holds the clock for its whole share.
				}
			},
			1,
			0,
		)
		expect(long).toHaveLength(2)
		expect(long.every((warmup) => warmup.work >= 520)).toBe(true)
	})

	it('reads host clocks and computes the load outside this process', () => {
		expect(
			computeOtherLoad(
				{ busy: 1_000, own: 100, wall: 0, processors: 16 },
				{ busy: 2_600, own: 200, wall: 100, processors: 16 },
			),
		).toBe(0.9375)
		expect(() =>
			computeOtherLoad(
				{ busy: 0, own: 0, wall: 5, processors: 16 },
				{ busy: 0, own: 0, wall: 5, processors: 16 },
			),
		).toThrow('holds no wall time')

		const start = readHostTimes()
		measureSample(() => [...'abcdefghijklmnopqrstuvwxyz'].reverse().join(''), 20_000, 0)
		const end = readHostTimes()
		expect(end.processors).toBe(cpus().length)
		expect(end.wall).toBeGreaterThan(start.wall)
		expect(end.busy).toBeGreaterThanOrEqual(start.busy)
		expect(end.own).toBeGreaterThanOrEqual(start.own)
		expect(Number.isFinite(computeOtherLoad(start, end))).toBe(true)
	})

	it('writes a record under a created directory and refuses an existing file', () => {
		const scratch = createScratch()
		try {
			const record: BenchRecord = {
				arm: 'alpha',
				cell: 'cell',
				calls: 1,
				pad: 0,
				warmups: [1],
				samples: [2],
				work: [2],
				load: 0,
				node: '22.0.0',
				engine: '12.0',
				threaded: true,
				hash: 'abc',
				flags: [],
				tinybench: { count: 1, p50: 2, mean: 2, min: 2, max: 2, rme: 0 },
			}
			const path = join(scratch.path, 'nested', 'record.json')
			writeBenchRecord(path, record)
			expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record)
			expect(() => writeBenchRecord(path, record)).toThrow('EEXIST')
		} finally {
			scratch.destroy()
		}
	})

	it('measures a cell through a sampling run and writes its record', async () => {
		const scratch = createScratch()
		try {
			const recorder = createRecorder()
			const path = join(scratch.path, 'cell', 'record.json')
			const record = await measureCell(
				recorder.handler,
				{ arm: 'alpha', hash: 'abc', pad: 0.5, record: path, title: 'cell', calls: 3 },
				(sample, options) => {
					const walls = Array.from(
						{ length: options.iterations },
						() => sample().overriddenDuration,
					)
					return Promise.resolve({
						latency: {
							samplesCount: walls.length,
							p50: 0,
							mean: 0,
							min: Math.min(...walls),
							max: Math.max(...walls),
							rme: 0,
						},
					})
				},
			)
			expect(record.warmups).toHaveLength(30)
			expect(record.samples).toHaveLength(15)
			expect(record.work).toHaveLength(15)
			expect(recorder.count).toBe(3 * 45)
			expect(record.work.every((work, index) => (record.samples[index] ?? 0) >= work * 1.5)).toBe(
				true,
			)
			expect(record.tinybench.count).toBe(15)
			expect(record).toMatchObject({
				arm: 'alpha',
				cell: 'cell',
				calls: 3,
				pad: 0.5,
				hash: 'abc',
				node: process.versions.node,
				threaded: !isMainThread,
			})
			expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(record)

			await expect(
				measureCell(
					recorder.handler,
					{ arm: undefined, hash: undefined, pad: 0, record: undefined, title: 'cell', calls: 0 },
					() => Promise.reject(new Error('unreached')),
				),
			).rejects.toThrow('is not a positive count')
		} finally {
			scratch.destroy()
		}
	})
})
