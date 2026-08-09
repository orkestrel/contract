import type { JSONClonerInterface, JSONRecord, JSONValue } from '@src/core'
import type { TerminalIntrinsic } from '../../setup.js'
import {
	attempt,
	cloneJSONValue,
	ContractError,
	isContractError,
	isRecord,
	JSONCloner,
} from '@src/core'
import {
	captureContractError,
	pollutePrototype,
	redirectIntrinsic,
	ReentrantPollution,
	replaceIntrinsic,
	throwSentinel,
} from '../../setup.js'
import { requestWeakReferenceCollection } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('JSONCloner', () => {
	it('is root-exported, conforms to its interface, and exposes only clone', () => {
		const cloner: JSONClonerInterface = new JSONCloner({ ready: true })

		expect(cloner.clone()).toEqual({ ready: true })
		expect(Reflect.ownKeys(JSONCloner.prototype)).toEqual(['constructor', 'clone'])
	})

	it('does not observe the retained source during construction', () => {
		const observations: PropertyKey[] = []
		const source = new Proxy(
			{},
			{
				get(_target, key) {
					observations.push(key)
					return undefined
				},
				getOwnPropertyDescriptor(_target, key) {
					observations.push(key)
					return undefined
				},
				getPrototypeOf() {
					observations.push('prototype')
					return null
				},
				has(_target, key) {
					observations.push(key)
					return false
				},
				ownKeys() {
					observations.push('keys')
					return []
				},
			},
		)

		const cloner = new JSONCloner(source)

		expect(cloner).toBeInstanceOf(JSONCloner)
		expect(observations).toEqual([])
	})

	it('settles success once and replays the exact frozen root without rereading', () => {
		let observations = 0
		const source = new Proxy(
			{ nested: [1, 2, 3] },
			{
				getOwnPropertyDescriptor(target, key) {
					observations += 1
					return Reflect.getOwnPropertyDescriptor(target, key)
				},
				getPrototypeOf(target) {
					observations += 1
					return Reflect.getPrototypeOf(target)
				},
				ownKeys(target) {
					observations += 1
					return Reflect.ownKeys(target)
				},
			},
		)
		const cloner = new JSONCloner(source)
		const first = cloner.clone()
		const settled = observations
		const second = cloner.clone()

		expect(second).toBe(first)
		expect(observations).toBe(settled)
		expect(Object.isFrozen(first)).toBe(true)
	})

	it('settles failure once and rethrows the exact owned error without rereading', () => {
		let observations = 0
		const caller = new ContractError('caller', { code: 'clone' })
		const source = new Proxy(
			{},
			{
				ownKeys() {
					observations += 1
					throw caller
				},
			},
		)
		const cloner = new JSONCloner(source)
		const first = captureContractError(() => cloner.clone())
		const settled = observations
		const second = captureContractError(() => cloner.clone())

		expect(second).toBe(first)
		expect(first).not.toBe(caller)
		expect(observations).toBe(settled)
		expect(Object.hasOwn(first, 'cause')).toBe(false)
	})

	it('settles atomically while every terminal-path intrinsic is redirected by the caller', () => {
		const reason = new Error('JSON traversal failed')
		const intrinsics: readonly TerminalIntrinsic[] = [
			{ label: 'WeakSet.prototype.has', target: WeakSet.prototype, key: 'has', via: 'replacement' },
			{ label: 'WeakSet.prototype.add', target: WeakSet.prototype, key: 'add', via: 'replacement' },
			{ label: 'Object.hasOwn', target: Object, key: 'hasOwn', via: 'replacement' },
			{ label: 'Object.prototype.cause', target: Object.prototype, key: 'cause', via: 'pollution' },
			{
				label: 'Object.prototype.context',
				target: Object.prototype,
				key: 'context',
				via: 'pollution',
			},
			{ label: 'Object.prototype.path', target: Object.prototype, key: 'path', via: 'pollution' },
		]
		const settled = {
			redirected: true,
			escaped: false,
			owned: true,
			causeless: true,
			replayed: true,
		}
		const observed: unknown[] = []

		for (const intrinsic of intrinsics) {
			const sentinel = Object.freeze({ stage: intrinsic.label })
			const failingSource = new Proxy(
				{},
				{
					ownKeys() {
						throw reason
					},
				},
			)
			const cloners = [
				{ name: 'readable', cloner: new JSONCloner({ value: [1] }) },
				{ name: 'unreadable', cloner: new JSONCloner(failingSource) },
			]

			for (const subject of cloners) {
				let redirected = false
				const first = redirectIntrinsic(intrinsic, sentinel, (armed) => {
					redirected = armed
					return attempt(() => subject.cloner.clone())
				})
				const replay = attempt(() => subject.cloner.clone())

				observed.push({
					intrinsic: intrinsic.label,
					source: subject.name,
					redirected,
					escaped: !first.success && first.error === sentinel,
					owned: first.success || isContractError(first.error),
					// Unlike the schema and shape engines, every JSON refusal is
					// documented cause-free, so a redirected intrinsic must not
					// smuggle the caller's sentinel out as a cause either.
					causeless:
						first.success || (isContractError(first.error) && !Object.hasOwn(first.error, 'cause')),
					replayed: first.success
						? replay.success && replay.value === first.value
						: !replay.success && replay.error === first.error,
				})
			}
		}

		expect(observed).toEqual([
			{ intrinsic: 'WeakSet.prototype.has', source: 'readable', ...settled },
			{ intrinsic: 'WeakSet.prototype.has', source: 'unreadable', ...settled },
			{ intrinsic: 'WeakSet.prototype.add', source: 'readable', ...settled },
			{ intrinsic: 'WeakSet.prototype.add', source: 'unreadable', ...settled },
			{ intrinsic: 'Object.hasOwn', source: 'readable', ...settled },
			{ intrinsic: 'Object.hasOwn', source: 'unreadable', ...settled },
			{ intrinsic: 'Object.prototype.cause', source: 'readable', ...settled },
			{ intrinsic: 'Object.prototype.cause', source: 'unreadable', ...settled },
			{ intrinsic: 'Object.prototype.context', source: 'readable', ...settled },
			{ intrinsic: 'Object.prototype.context', source: 'unreadable', ...settled },
			{ intrinsic: 'Object.prototype.path', source: 'readable', ...settled },
			{ intrinsic: 'Object.prototype.path', source: 'unreadable', ...settled },
		])
	})

	it('settles atomically when the pollution is armed from the source it is walking', () => {
		// The control drawn from OUTSIDE the corpus membership rule. Every row of
		// the table above arms its redirect before `clone()` is entered and
		// removes it after, so the table structurally cannot express a caller who
		// arms the hostile state from inside its own reflective trap, once the
		// walk has already begun and the poison is already built. That population
		// is reachable with no replaced function at all.
		const sentinel = Object.freeze({ stage: 'reentrant cause' })
		const pollution = new ReentrantPollution(Object.prototype, 'cause', throwSentinel(sentinel))
		const cloner = new JSONCloner(pollution.source)

		const first = attempt(() => cloner.clone())
		const armed = pollution.armed
		pollution.restore()
		const replay = attempt(() => cloner.clone())

		expect({
			armed,
			escaped: !first.success && first.error === sentinel,
			owned: !first.success && isContractError(first.error),
			causeless:
				!first.success && isContractError(first.error) && !Object.hasOwn(first.error, 'cause'),
			replayed: !first.success && !replay.success && replay.error === first.error,
		}).toEqual({ armed: true, escaped: false, owned: true, causeless: true, replayed: true })
	})

	it('keeps a documented cause-free refusal cause-free while the caller supplies an inherited cause', () => {
		const baseline = captureContractError(() => new JSONCloner({ bad: () => 1 }).clone())
		const polluted = pollutePrototype(
			Object.prototype,
			'cause',
			() => 'polluted',
			() => captureContractError(() => new JSONCloner({ bad: () => 1 }).clone()),
		)

		expect({
			baseline: Object.hasOwn(baseline, 'cause'),
			polluted: Object.hasOwn(polluted, 'cause'),
			code: polluted.code,
			message: polluted.message === baseline.message,
		}).toEqual({ baseline: false, polluted: false, code: 'clone', message: true })
	})

	it('releases failed traversal work while retaining exact terminal replay', async () => {
		let subjectChild: { readonly nested: readonly number[] } | undefined = {
			nested: Array.from({ length: 20_000 }, (_value, index) => index),
		}
		const subjectReference = new WeakRef(subjectChild)
		const subjectSource = new Proxy(
			{},
			{
				getPrototypeOf() {
					return null
				},
				ownKeys() {
					return ['child', 'bad']
				},
				getOwnPropertyDescriptor(_target, key) {
					return {
						value: key === 'child' ? subjectChild : Symbol('bad'),
						enumerable: true,
						configurable: true,
						writable: true,
					}
				},
			},
		)
		const subjectCloner = new JSONCloner(subjectSource)
		const terminal = captureContractError(() => subjectCloner.clone())
		subjectChild = undefined

		let controlChild: { readonly nested: readonly number[] } | undefined = {
			nested: Array.from({ length: 20_000 }, (_value, index) => index),
		}
		const controlReference = new WeakRef(controlChild)
		const controlSource = new Proxy(
			{},
			{
				getPrototypeOf() {
					return null
				},
				ownKeys() {
					return ['child', 'bad']
				},
				getOwnPropertyDescriptor(_target, key) {
					return {
						value: key === 'child' ? controlChild : Symbol('bad'),
						enumerable: true,
						configurable: true,
						writable: true,
					}
				},
			},
		)
		captureContractError(() => new JSONCloner(controlSource).clone())
		controlChild = undefined

		await requestWeakReferenceCollection([controlReference, subjectReference])

		expect(controlReference.deref()).toBeUndefined()
		expect(subjectReference.deref()).toBeUndefined()
		expect(captureContractError(() => subjectCloner.clone())).toBe(terminal)
	})

	it('promotes caught active reentry to the shared terminal poison', () => {
		const state: { cloner: JSONClonerInterface | undefined } = { cloner: undefined }
		let nested: unknown
		const source = new Proxy(
			{},
			{
				getPrototypeOf() {
					if (state.cloner === undefined) throw new Error('cloner must be initialized')
					try {
						state.cloner.clone()
					} catch (reason) {
						nested = reason
					}
					return null
				},
			},
		)
		state.cloner = new JSONCloner(source)

		const outer = captureContractError(() => state.cloner?.clone())
		const later = captureContractError(() => state.cloner?.clone())

		expect(nested).toBe(outer)
		expect(later).toBe(outer)
		expect(outer.message).toBe('JSONCloner.clone: JSON cloning may not be reentered')
		expect(outer.code).toBe('clone')
		expect(outer.context).toEqual({ shape: 'json' })
		expect(Object.hasOwn(outer, 'cause')).toBe(false)
	})

	it('promotes uncaught active reentry to the shared terminal poison', () => {
		const state: { cloner: JSONClonerInterface | undefined } = { cloner: undefined }
		const source = new Proxy(
			{},
			{
				getPrototypeOf() {
					if (state.cloner === undefined) throw new Error('cloner must be initialized')
					state.cloner.clone()
					return null
				},
			},
		)
		state.cloner = new JSONCloner(source)

		const outer = captureContractError(() => state.cloner?.clone())
		const later = captureContractError(() => state.cloner?.clone())

		expect(later).toBe(outer)
		expect(outer.message).toBe('JSONCloner.clone: JSON cloning may not be reentered')
		expect(Object.hasOwn(outer, 'cause')).toBe(false)
	})

	it('keeps class instances and eager operations observably fresh', () => {
		let observations = 0
		const source = new Proxy(
			{ value: [1] },
			{
				ownKeys(target) {
					observations += 1
					return Reflect.ownKeys(target)
				},
			},
		)
		const first = new JSONCloner(source).clone()
		const afterFirst = observations
		const second = new JSONCloner(source).clone()
		const afterSecond = observations
		const eagerFirst = cloneJSONValue(source)
		const eagerSecond = cloneJSONValue(source)

		expect(second).not.toBe(first)
		expect(eagerFirst).not.toBe(eagerSecond)
		expect(afterSecond).toBeGreaterThan(afterFirst)
		expect(observations).toBeGreaterThan(afterSecond)
	})

	it('contains caller-owned and clone-shaped thrown values without a cause', () => {
		const caller = new ContractError('caller owned', { code: 'clone' })
		const shaped = { code: 'clone', context: { shape: 'json' } }

		for (const reason of [caller, shaped]) {
			const source = new Proxy(
				{},
				{
					ownKeys() {
						throw reason
					},
				},
			)
			const error = captureContractError(() => new JSONCloner(source).clone())

			expect(error).not.toBe(reason)
			expect(error.code).toBe('clone')
			expect(error.context).toEqual({ shape: 'json' })
			expect(Object.hasOwn(error, 'cause')).toBe(false)
		}
	})

	it('matches the eager boundary for primitives, arrays, records, and aliases', () => {
		const shared = { nested: [1, null, 'value'] }
		const corpus: readonly unknown[] = [
			null,
			'',
			true,
			-0,
			Number.MAX_VALUE,
			[1, { value: false }],
			{ first: shared, second: shared },
		]

		for (const source of corpus) {
			const direct = new JSONCloner(source).clone()
			const eager = cloneJSONValue(source)

			expect(direct).toEqual(eager)
			expect(Object.isFrozen(direct)).toBe(Object.isFrozen(eager))
		}

		const direct = new JSONCloner({ first: shared, second: shared }).clone()
		if (!isRecord(direct)) throw new Error('expected a record clone')
		expect(direct.first).not.toBe(direct.second)
	})

	it('matches eager cycle and hostile-reflection diagnostics exactly', () => {
		const cycle: unknown[] = []
		cycle.push(cycle)
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile keys')
				},
			},
		)

		for (const source of [cycle, hostile]) {
			const direct = captureContractError(() => new JSONCloner(source).clone())
			const eager = captureContractError(() => cloneJSONValue(source))

			expect(direct).not.toBe(eager)
			expect(direct.message).toBe(eager.message)
			expect(direct.code).toBe(eager.code)
			expect(direct.context).toEqual(eager.context)
			expect(Object.hasOwn(direct, 'cause')).toBe(false)
		}
	})

	it('matches descriptor refusal, key order, normalized output, and mutation isolation', () => {
		let accesses = 0
		const accessor: Record<string, unknown> = {}
		Object.defineProperty(accessor, 'value', {
			enumerable: true,
			get() {
				accesses += 1
				return 'unsafe'
			},
		})
		const directError = captureContractError(() => new JSONCloner(accessor).clone())
		const eagerError = captureContractError(() => cloneJSONValue(accessor))
		expect(directError.message).toBe(eagerError.message)
		expect(accesses).toBe(0)

		const source: Record<string, unknown> = Object.create(null)
		source.first = { value: 'stable' }
		Object.defineProperty(source, '__proto__', {
			value: 'data',
			enumerable: true,
			configurable: true,
			writable: true,
		})
		source.last = [7]
		const direct = new JSONCloner(source).clone()
		const eager = cloneJSONValue(source)
		if (!isRecord(direct) || !isRecord(eager)) throw new Error('expected record clones')

		const first = source.first
		if (!isRecord(first)) throw new Error('expected source record')
		Reflect.set(first, 'value', 'changed')
		expect(direct).toEqual(eager)
		expect(Reflect.ownKeys(direct)).toEqual(['first', '__proto__', 'last'])
		expect(Object.getPrototypeOf(direct)).toBeNull()
		expect(Reflect.get(direct, '__proto__')).toBe('data')
		expect(direct.first).toEqual({ value: 'stable' })
		expect(Object.isFrozen(direct)).toBe(true)
		expect(Object.isFrozen(direct.first)).toBe(true)
		expect(Object.isFrozen(direct.last)).toBe(true)
	})

	it('matches the eager boundary for deeply nested iterative input', () => {
		let source: unknown = 'leaf'
		for (let index = 0; index < 20_000; index += 1) source = [source]

		const direct = new JSONCloner(source).clone()
		const eager = cloneJSONValue(source)
		let directNode: JSONValue = direct
		let eagerNode: JSONValue = eager
		for (let index = 0; index < 20_000; index += 1) {
			if (!Array.isArray(directNode) || !Array.isArray(eagerNode)) {
				throw new Error(`expected arrays at depth ${index}`)
			}
			directNode = directNode[0]
			eagerNode = eagerNode[0]
		}

		expect(directNode).toBe('leaf')
		expect(eagerNode).toBe('leaf')
	})

	it('returns frozen null-prototype records through the interface contract', () => {
		const cloner: JSONClonerInterface = new JSONCloner({ value: 1 })
		const clone: JSONValue = cloner.clone()
		if (!isRecord(clone)) throw new Error('expected a JSON record')
		const record: JSONRecord = clone

		expect(record).toEqual({ value: 1 })
		expect(Object.getPrototypeOf(record)).toBeNull()
		expect(Object.isFrozen(record)).toBe(true)
	})
})

describe('array exactness is decided through an unredirectable vocabulary', () => {
	// The exactness verdict is what this door publishes about the caller's array,
	// and the shrinking-`Set` form asked three caller-writable members for it:
	// `has`, `delete`, and the `size` accessor.
	const answerTrue = (): boolean => true
	const answerFalse = (): boolean => false

	it('accepts an exact array while Set.prototype.has answers false', () => {
		const outcome = replaceIntrinsic(Set.prototype, 'has', answerFalse, () =>
			attempt(() => new JSONCloner([1, 2]).clone()),
		)

		expect(outcome.success).toBe(true)
		expect(outcome.success ? outcome.value : undefined).toEqual([1, 2])
	})

	it('refuses an array carrying an extra own key while Set.prototype.has answers true', () => {
		const hostile: unknown[] = [1]
		Object.defineProperty(hostile, 'ghost', { value: 2, enumerable: true, configurable: true })
		const outcome = replaceIntrinsic(Set.prototype, 'has', answerTrue, () =>
			attempt(() => new JSONCloner(hostile).clone()),
		)

		expect(outcome.success).toBe(false)
		expect(!outcome.success && isContractError(outcome.error)).toBe(true)
	})

	it('refuses the same array while Set.prototype.delete answers true', () => {
		const hostile: unknown[] = [1]
		Object.defineProperty(hostile, 'ghost', { value: 2, enumerable: true, configurable: true })
		const outcome = replaceIntrinsic(Set.prototype, 'delete', answerTrue, () =>
			attempt(() => new JSONCloner(hostile).clone()),
		)

		expect(outcome.success).toBe(false)
	})
})

describe('JSONCloner — bounded produced work (H9)', () => {
	it('bounds the snapshot it produces instead of paying alias duplication without limit', () => {
		// Duplication is the documented contract — JSON persistence is a tree, and
		// `clone.primary !== clone.fallback` is a guarantee a memo would silently
		// take away — but its COST was unbounded: 21 source objects, a few hundred
		// bytes, took 3.3 s, and 30 aliases takes hours. Shared references are
		// ordinary data, so this is reachable with no attacker at all.
		let excessive: unknown = { leaf: true }
		for (let index = 0; index < 30; index += 1) excessive = { x: excessive, y: excessive }

		const started = Date.now()
		const error = captureContractError(() => cloneJSONValue(excessive))
		const elapsed = Date.now() - started

		expect(error.code).toBe('clone')
		expect(error.message).toBe('cloneJSONValue: snapshot exceeds the node limit')
		expect(error.context).toEqual({ shape: 'json' })
		// Bounded WORK: the worst case is a function of the constant, not of the
		// caller's graph. Unbounded, this input is 2^30 produced nodes.
		expect(elapsed).toBeLessThan(2_000)

		// Control: a graph comfortably inside the bound still clones, and still
		// duplicates its aliases exactly as documented.
		let modest: unknown = { leaf: true }
		for (let index = 0; index < 12; index += 1) modest = { x: modest, y: modest }
		const clone = cloneJSONValue(modest)
		expect(isRecord(clone)).toBe(true)
		const record = isRecord(clone) ? clone : {}
		expect(record.x).not.toBe(record.y)
		expect(record.x).toEqual(record.y)
		expect(Object.isFrozen(clone)).toBe(true)
	})
})
