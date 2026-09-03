// The proof for `tests/setupServer.ts`. Its subject is the Node-only seams the
// `src:core` suites import directly: values built inside a genuine foreign
// JavaScript realm, and a collection request served by the real V8 collector.
// Each expectation is derived through `node:vm` and the host's own reflection
// rather than through the module under proof, so a seam that stopped crossing a
// realm boundary — or stopped collecting — reports here.
import { runInNewContext } from 'node:vm'
import {
	createForeignPrototype,
	createForeignRecord,
	createForeignRegExp,
	createForeignStringShape,
	requestWeakReferenceCollection,
} from './setupServer.js'
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
		let target: object | undefined = { payload: 'x'.repeat(1_024) }
		const unreachable = new WeakRef(target)
		target = undefined
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
