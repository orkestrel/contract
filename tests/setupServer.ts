// Node-only test seams. `workspace.md`'s project matrix lists this file as
// `src:server`'s setup, and `vite.config.ts` honours that: no project loads it
// through `setupFiles`, and `src:core` still loads only `setup.ts`. Ten
// `src:core` test files nevertheless IMPORT it directly, which is stated here
// rather than left for a reader to infer from the import graph.
//
// The reason is that the boundary is unavoidable, not convenient. A genuine
// foreign realm and a real collection round are host seams; a core test that
// simulated either would be the behavioural fake the test rules forbid, and
// cross-realm acceptance plus release-before-publication are core claims that
// no host-independent construction can drive. The `src:core` project runs in a
// Node environment, so the import resolves; what it does NOT do is make
// `src/core` itself host-dependent, because nothing here is reachable from the
// published graph. The rule this sits beside governs which setup a project
// LOADS; a test's direct import of a host seam is the narrower thing, and it is
// confined to the assertions that genuinely need a host.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { dirname, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'
import { isMainThread } from 'node:worker_threads'
import * as core from '@src/core'
import { isFunction, objectOf } from '@src/core'

/**
 * Requests collection of weakly referenced objects from the real V8 collector.
 *
 * @param references - Weak references to request collection for
 * @returns A promise that settles after bounded pressure and collection rounds
 */
export async function requestWeakReferenceCollection(
	references: ReadonlyArray<WeakRef<object>>,
): Promise<void> {
	setFlagsFromString('--expose_gc')
	try {
		const collector: unknown = runInNewContext('gc')
		if (typeof collector !== 'function') throw new Error('expected an exposed collector')

		const rounds = Array.from({ length: 40 }).values()
		while (!rounds.next().done && references.some((reference) => reference.deref() !== undefined)) {
			await setImmediate()
			const pressure = Array.from({ length: 2_000 }, () => new Uint8Array(4_096))
			Reflect.apply(collector, undefined, [])
			pressure.length = 0
		}
	} finally {
		setFlagsFromString('--no-expose_gc')
	}
}

export function createForeignRegExp(source: string, flags = ''): unknown {
	return runInNewContext('new RegExp(source, flags)', { flags, source })
}

/**
 * Creates a minimal string declaration in a genuine foreign JavaScript realm.
 *
 * @returns A foreign-realm `{ category: 'string' }` record as `unknown`
 */
export function createForeignStringShape(): unknown {
	return runInNewContext("({ category: 'string' })")
}

/**
 * Creates a fresh foreign JavaScript realm's own `Object.prototype`.
 *
 * @remarks
 * Every call builds a new realm, so a test may install an inherited member on
 * the returned prototype without polluting this realm's `Object.prototype` or
 * any other fixture's.
 *
 * @returns A genuine foreign realm's `Object.prototype`
 * @throws {Error} When the foreign realm does not yield an object prototype
 *
 * @example
 * ```ts
 * Object.setPrototypeOf(node, createForeignPrototype()) // still a plain record
 * ```
 */
export function createForeignPrototype(): object {
	const prototype: unknown = runInNewContext('Object.prototype')
	if (typeof prototype !== 'object' || prototype === null) {
		throw new Error('createForeignPrototype: expected a foreign object prototype')
	}
	return prototype
}

/**
 * Creates an ordinary record in a genuine foreign JavaScript realm.
 *
 * @returns A foreign-realm `{ value: 1 }` record as `unknown`
 *
 * @example
 * ```ts
 * isRecord(createForeignRecord()) // true
 * ```
 */
export function createForeignRecord(): unknown {
	return runInNewContext('({ value: 1 })')
}

/** Holds the guards and combinators a combinator bench times, from one contract build. */
export type ContractEntry = Pick<
	typeof core,
	'arrayOf' | 'isFiniteNumber' | 'isRecord' | 'isString' | 'optionalOf' | 'recordOf'
>

/** Holds the settings a bench process reads from its environment. */
export interface BenchSettings {
	/** The build under `tmp/probes/<arm>/index.js`, or `undefined` for `@src/core`. */
	readonly arm: string | undefined
	/** The git blob hash the arm's entry must have. */
	readonly hash: string | undefined
	/** The fraction of a reading's work each reading spins on after its calls. */
	readonly pad: number
	/** The path the process record is written to, or `undefined` for no record. */
	readonly record: string | undefined
}

/** Describes one bench cell: its settings, its title, and the guard calls in one reading. */
export interface BenchCell extends BenchSettings {
	/** The case title the record names. */
	readonly title: string
	/** The back-to-back calls one reading times. */
	readonly calls: number
}

/** Holds one timed reading: the wall of its calls and the wall with its pad. */
export interface BenchSample {
	/** The wall of the calls, in milliseconds. */
	readonly work: number
	/** The reading, in milliseconds: the work, and the pad spun after it. */
	readonly wall: number
}

/** Holds the tinybench latency figures a bench record reports and never gates on. */
export interface BenchLatency {
	/** The count of samples tinybench took. */
	readonly samplesCount: number
	/** The median sample, in milliseconds. */
	readonly p50: number
	/** The mean sample, in milliseconds. */
	readonly mean: number
	/** The fastest sample, in milliseconds. */
	readonly min: number
	/** The slowest sample, in milliseconds. */
	readonly max: number
	/** The relative margin of error of the mean, in percent. */
	readonly rme: number
}

/** Runs a sampling function under fixed tinybench options and returns its latency figures. */
export type BenchRun = (
	sample: () => { readonly overriddenDuration: number },
	options: { readonly time: number; readonly iterations: number; readonly warmup: boolean },
) => Promise<{ readonly latency: BenchLatency }>

/** Holds the record one bench process writes for one cell. */
export interface BenchRecord {
	/** The arm the process loaded, `source` for `@src/core`. */
	readonly arm: string
	/** The case title. */
	readonly cell: string
	/** The back-to-back calls one reading times. */
	readonly calls: number
	/** The pad fraction. */
	readonly pad: number
	/** Every warmup reading, in order, in milliseconds. */
	readonly warmups: readonly number[]
	/** Every sample reading, in order, in milliseconds. */
	readonly samples: readonly number[]
	/** The wall of each sample's calls, in order, in milliseconds. */
	readonly work: readonly number[]
	/** The other load over the samples, a fraction of the host's logical processors. */
	readonly load: number
	/** The Node version. */
	readonly node: string
	/** The V8 version. */
	readonly engine: string
	/** True if the bench ran in a worker thread; false otherwise. */
	readonly threaded: boolean
	/** The entry's git blob hash, absent for `@src/core`. */
	readonly hash: string | undefined
	/** The process's V8 and Node flags. */
	readonly flags: readonly string[]
	/** The tinybench figures beside the samples. */
	readonly tinybench: {
		readonly count: number
		readonly p50: number
		readonly mean: number
		readonly min: number
		readonly max: number
		readonly rme: number
	}
}

/** Holds the CPU and wall clocks read at one moment, for an other-load reading. */
export interface HostTimes {
	/** The busy time summed over every logical processor, in milliseconds. */
	readonly busy: number
	/** This process's user and system CPU time, in milliseconds. */
	readonly own: number
	/** The monotonic wall clock, in milliseconds. */
	readonly wall: number
	/** The logical processor count. */
	readonly processors: number
}

/**
 * Computes the git blob hash of a file's bytes, as `git hash-object` prints it.
 *
 * @param bytes - The file's bytes
 * @returns The lowercase hexadecimal SHA-1 of the blob header and the bytes
 *
 * @example
 * ```ts
 * computeBlobHash(new Uint8Array()) // 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
 * ```
 */
export function computeBlobHash(bytes: Uint8Array): string {
	return createHash('sha1')
		.update(`blob ${String(bytes.byteLength)}\0`)
		.update(bytes)
		.digest('hex')
}

/**
 * Checks whether a module namespace exports every guard and combinator a combinator
 * bench times.
 *
 * @param value - The module namespace
 * @returns True if each timed member is a function; false otherwise
 *
 * @example
 * ```ts
 * isContractEntry(await import('@src/core')) // true
 * ```
 */
export function isContractEntry(value: unknown): value is ContractEntry {
	return objectOf({
		arrayOf: isFunction,
		isFiniteNumber: isFunction,
		isRecord: isFunction,
		isString: isFunction,
		optionalOf: isFunction,
		recordOf: isFunction,
	})(value)
}

/**
 * Loads one contract build for a bench, refusing a missing or stale entry.
 *
 * @remarks
 * The entry is `tmp/probes/<arm>/index.js` under `root`, imported at run time through its
 * resolved path. With no arm, it returns `@src/core` and checks no hash.
 *
 * @param arm - One lowercase word naming the build, or `undefined` for `@src/core`
 * @param expected - The git blob hash the entry must have
 * @param root - The workspace root. Default: the directory above this module
 * @returns The entry's timed guards and combinators
 * @throws {Error} When the arm is not one lowercase word, no hash is expected, the entry
 * is missing, its hash differs from the expected one, or it lacks a timed member
 *
 * @example
 * ```ts
 * const { arrayOf, isString } = await loadContractEntry('baseline', hash)
 * ```
 */
export async function loadContractEntry(
	arm: string | undefined,
	expected: string | undefined,
	root = fileURLToPath(new URL('..', import.meta.url)),
): Promise<ContractEntry> {
	if (arm === undefined) return core
	if (!/^[a-z]+$/.test(arm)) {
		throw new Error(`loadContractEntry: the arm ${arm} is not one lowercase word`)
	}
	if (expected === undefined) {
		throw new Error(`loadContractEntry: the ${arm} arm names no expected hash`)
	}
	const path = resolve(root, 'tmp', 'probes', arm, 'index.js')
	if (!existsSync(path)) {
		throw new Error(`loadContractEntry: ${path} is missing; build and copy it first`)
	}
	const hash = computeBlobHash(readFileSync(path))
	if (hash !== expected) {
		throw new Error(`loadContractEntry: ${path} is stale; its hash ${hash} is not ${expected}`)
	}
	const entry: unknown = await import(pathToFileURL(path).href)
	if (!isContractEntry(entry)) {
		throw new Error(`loadContractEntry: ${path} lacks a guard or combinator the bench times`)
	}
	return entry
}

/**
 * Reads a bench process's settings from its environment.
 *
 * @remarks
 * Reads `COMBINATORS_ARM`, `COMBINATORS_HASH`, `COMBINATORS_PAD`, and
 * `COMBINATORS_RECORD`. An absent pad is 0.
 *
 * @param environment - The process environment
 * @returns The settings
 * @throws {Error} When the pad is not a finite non-negative number
 *
 * @example
 * ```ts
 * readBenchSettings({ COMBINATORS_PAD: '0.25' }).pad // 0.25
 * ```
 */
export function readBenchSettings(
	environment: Readonly<Record<string, string | undefined>>,
): BenchSettings {
	const pad = Number(environment.COMBINATORS_PAD ?? '0')
	if (!Number.isFinite(pad) || pad < 0) {
		throw new Error(`readBenchSettings: the pad ${String(environment.COMBINATORS_PAD)} is invalid`)
	}
	return Object.freeze({
		arm: environment.COMBINATORS_ARM,
		hash: environment.COMBINATORS_HASH,
		pad,
		record: environment.COMBINATORS_RECORD,
	})
}

/**
 * Times one reading: back-to-back calls, then a spin of the pad's share of their wall.
 *
 * @remarks
 * The spin ends once the reading reaches `(1 + pad)` times the calls' wall, so a padded
 * reading drops by exactly `pad / (1 + pad)` when the pad is removed.
 *
 * @param call - The timed call, passed the index of its call within the reading
 * @param calls - The back-to-back calls in the reading
 * @param pad - The fraction of the calls' wall spun after them
 * @returns The calls' wall and the reading
 *
 * @example
 * ```ts
 * measureSample(() => isStrings(strings), 50, 0).wall // the wall of 50 calls
 * ```
 */
export function measureSample(
	call: (round: number) => unknown,
	calls: number,
	pad: number,
): BenchSample {
	const rounds = Array.from({ length: calls }).keys()
	const start = performance.now()
	for (const round of rounds) call(round)
	const work = performance.now() - start
	const deadline = start + work * (1 + pad)
	while (performance.now() < deadline) {
		// The spin reads the clock and nothing else, so the pad adds wall and no work.
	}
	return Object.freeze({ work, wall: pad > 0 ? performance.now() - start : work })
}

/**
 * Times warmup readings until their calls hold at least 1 s and at least 2 readings have
 * passed, at most 30.
 *
 * @param call - The timed call
 * @param calls - The back-to-back calls in each reading
 * @param pad - The fraction of each reading's calls' wall spun after them
 * @returns Every warmup reading, in order
 *
 * @example
 * ```ts
 * measureWarmups(() => isStrings(strings), 50, 0).length // 2 to 30
 * ```
 */
export function measureWarmups(
	call: (round: number) => unknown,
	calls: number,
	pad: number,
): readonly BenchSample[] {
	const warmups: BenchSample[] = []
	while (
		warmups.length < 2 ||
		(warmups.length < 30 && warmups.reduce((total, warmup) => total + warmup.work, 0) < 1_000)
	) {
		warmups.push(measureSample(call, calls, pad))
	}
	return Object.freeze([...warmups])
}

/**
 * Reads the host's busy time, this process's CPU time, and the wall clock.
 *
 * @returns The three clocks and the logical processor count
 *
 * @example
 * ```ts
 * const start = readHostTimes()
 * ```
 */
export function readHostTimes(): HostTimes {
	const processors = cpus()
	const usage = process.cpuUsage()
	return Object.freeze({
		busy: processors.reduce(
			(total, processor) =>
				total +
				processor.times.user +
				processor.times.nice +
				processor.times.sys +
				processor.times.irq,
			0,
		),
		own: (usage.user + usage.system) / 1_000,
		wall: performance.now(),
		processors: processors.length,
	})
}

/**
 * Computes the load other processes put on the host between two readings.
 *
 * @param start - The reading at the window's start
 * @param end - The reading at the window's end
 * @returns The busy time outside this process over the window, as a fraction of every
 * logical processor's wall
 * @throws {Error} When the window holds no wall time
 *
 * @example
 * ```ts
 * computeOtherLoad(start, readHostTimes()) // 0.02 on a quiet host
 * ```
 */
export function computeOtherLoad(start: HostTimes, end: HostTimes): number {
	const elapsed = end.wall - start.wall
	if (!(elapsed > 0)) throw new Error('computeOtherLoad: the window holds no wall time')
	return (end.busy - start.busy - (end.own - start.own)) / (elapsed * end.processors)
}

/**
 * Writes a bench record as JSON, creating its directory and refusing an existing file.
 *
 * @remarks
 * A second write to one path throws, so a process that ran a second case cannot replace
 * the first case's record.
 *
 * @param path - The record's path
 * @param record - The record
 * @throws {Error} When the file already exists or cannot be written
 *
 * @example
 * ```ts
 * writeBenchRecord('tmp/probes/combinators/trial/G1.json', record)
 * ```
 */
export function writeBenchRecord(path: string, record: BenchRecord): void {
	const target = resolve(path)
	mkdirSync(dirname(target), { recursive: true })
	writeFileSync(target, `${JSON.stringify(record, undefined, '\t')}\n`, { flag: 'wx' })
}

/**
 * Measures one bench cell: warmups, 15 samples under the supplied run, the other load
 * over the samples, and the record, written when the cell names a path.
 *
 * @param call - The timed call
 * @param cell - The cell's settings, title, and calls per reading
 * @param run - Runs the sampling function under the fixed tinybench options
 * @returns The record
 * @throws {Error} When the calls per reading are not a positive safe integer, or the
 * record cannot be written
 *
 * @example
 * ```ts
 * await measureCell(() => isStrings(strings), cell, (sample, options) =>
 * 	bench(cell.title, { retainSamples: true }, sample).run(options),
 * )
 * ```
 */
export async function measureCell(
	call: (round: number) => unknown,
	cell: BenchCell,
	run: BenchRun,
): Promise<BenchRecord> {
	if (!Number.isSafeInteger(cell.calls) || cell.calls < 1) {
		throw new Error(`measureCell: ${String(cell.calls)} calls per reading is not a positive count`)
	}
	const warmups = measureWarmups(call, cell.calls, cell.pad)
	const samples: BenchSample[] = []
	const start = readHostTimes()
	const result = await run(
		() => {
			const sample = measureSample(call, cell.calls, cell.pad)
			samples.push(sample)
			return { overriddenDuration: sample.wall }
		},
		{ time: 0, iterations: 15, warmup: false },
	)
	const end = readHostTimes()
	const record: BenchRecord = Object.freeze({
		arm: cell.arm ?? 'source',
		cell: cell.title,
		calls: cell.calls,
		pad: cell.pad,
		warmups: warmups.map((warmup) => warmup.wall),
		samples: samples.map((sample) => sample.wall),
		work: samples.map((sample) => sample.work),
		load: computeOtherLoad(start, end),
		node: process.versions.node,
		engine: process.versions.v8,
		threaded: !isMainThread,
		hash: cell.hash,
		flags: [...process.execArgv],
		tinybench: {
			count: result.latency.samplesCount,
			p50: result.latency.p50,
			mean: result.latency.mean,
			min: result.latency.min,
			max: result.latency.max,
			rme: result.latency.rme,
		},
	})
	if (cell.record !== undefined) writeBenchRecord(cell.record, record)
	return record
}
