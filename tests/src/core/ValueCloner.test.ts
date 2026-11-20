import type { CapturePlan } from '@src/core'
import { CLONE_NODE_LIMIT, ContractError } from '@src/core'
import { createRecorder } from '@orkestrel/test'
import { ValueCloner } from '../../../src/core/ValueCloner.js'
import {
	buildCyclicArray,
	buildCyclicRecord,
	buildHoledArray,
	buildReportingRecord,
	buildSparseArray,
	captureContractError,
	createClassInstance,
	createNullPrototypeRecord,
	createRevokedProxy,
	createThrowingGetter,
	SessionStore,
	throwHostileAccess,
	throwSentinel,
} from '../../setup.js'
import { describe, expect, it } from 'vitest'

const HELD: CapturePlan = Object.freeze({
	held: true,
	properties: Object.freeze({}),
	tail: undefined,
	items: undefined,
})

describe('ValueCloner', () => {
	it('copies a plain record and an array into frozen copies, reading each member one time', () => {
		const reads = createRecorder<readonly [string]>()
		const tags = ['admin', 'staff']
		const source = buildReportingRecord(
			[
				['name', 'Ada'],
				['tags', tags],
			],
			reads.handler,
		)
		const clone = new ValueCloner(source, undefined).clone()

		expect(clone).toEqual({ name: 'Ada', tags: ['admin', 'staff'] })
		expect(reads.calls).toEqual([['name'], ['tags']])
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(Reflect.get(Object(clone), 'tags')).not.toBe(tags)
		expect(Object.isFrozen(Reflect.get(Object(clone), 'tags'))).toBe(true)
		expect(Object.getOwnPropertyDescriptor(clone, 'name')).toEqual({
			value: 'Ada',
			enumerable: true,
			writable: false,
			configurable: false,
		})
	})

	it('keeps a null prototype, an inner hole, and a trailing hole', () => {
		const record = new ValueCloner(createNullPrototypeRecord(), undefined).clone()
		const sparse = new ValueCloner(buildSparseArray(), undefined).clone()
		const trailing = new ValueCloner(buildHoledArray(['a', 'b'], 1), undefined).clone()

		expect(Object.getPrototypeOf(record)).toBeNull()
		expect(record).toEqual(createNullPrototypeRecord())
		expect(Array.isArray(sparse)).toBe(true)
		expect(Reflect.get(Object(sparse), 'length')).toBe(3)
		expect(Object.keys(Object(sparse))).toEqual(['1'])
		expect(Reflect.get(Object(trailing), 'length')).toBe(2)
		expect(Object.keys(Object(trailing))).toEqual(['0'])
	})

	it('carries a non-enumerable or symbol accessor by its presence and never runs it', () => {
		const symbol = Symbol('token')
		const source = Object.defineProperties(
			{ name: 'Ada' },
			{
				hidden: { get: throwHostileAccess, enumerable: false },
				[symbol]: { get: throwHostileAccess, enumerable: true },
			},
		)
		const list = Object.defineProperty([1], 'note', { value: 'x', enumerable: false })
		const clone = Object(new ValueCloner(source, undefined).clone())
		const copied = Object(new ValueCloner(list, undefined).clone())

		expect(Reflect.ownKeys(clone)).toEqual(['name', 'hidden', symbol])
		expect(Object.getOwnPropertyDescriptor(clone, 'hidden')).toMatchObject({
			value: undefined,
			enumerable: false,
		})
		expect(Object.getOwnPropertyDescriptor(clone, symbol)).toMatchObject({
			value: undefined,
			enumerable: true,
		})
		expect(Reflect.ownKeys(copied)).toEqual(['0', 'length', 'note'])
		expect(Object.getOwnPropertyDescriptor(copied, 'note')).toMatchObject({
			value: 'x',
			enumerable: false,
		})
	})

	it('carries a non-enumerable or symbol data member with its captured value', () => {
		const symbol = Symbol('token')
		const limits = { max: 3 }
		const source = Object.defineProperties(
			{ category: 'number' },
			{
				min: { value: 'low', enumerable: false },
				limits: { value: limits, enumerable: false },
				[symbol]: { value: limits, enumerable: true },
			},
		)
		const clone = Object(new ValueCloner(source, undefined).clone())

		expect(Object.keys(clone)).toEqual(['category'])
		expect(Object.getOwnPropertyDescriptor(clone, 'min')).toMatchObject({
			value: 'low',
			enumerable: false,
		})
		expect(clone.limits).toEqual({ max: 3 })
		expect(clone.limits).not.toBe(limits)
		expect(Object.isFrozen(clone.limits)).toBe(true)
		expect(clone[symbol]).toBe(clone.limits)
	})

	it('keeps sharing and cycles through one copy per source', () => {
		const shared = { id: 1 }
		const pair = Object(new ValueCloner({ left: shared, right: shared }, undefined).clone())
		const record = Object(new ValueCloner(buildCyclicRecord(), undefined).clone())
		const array = Object(new ValueCloner(buildCyclicArray(), undefined).clone())

		expect(pair.left).toBe(pair.right)
		expect(pair.left).not.toBe(shared)
		expect(record.self).toBe(record)
		expect(Object.isFrozen(record)).toBe(true)
		expect(array[0]).toBe(array)
	})

	it('holds an interface position by identity and never descends into it', () => {
		const store = Object.defineProperty({ get: encodeURI }, 'secret', {
			get: throwHostileAccess,
			enumerable: true,
		})
		const plan: CapturePlan = {
			held: false,
			properties: { store: HELD },
			tail: undefined,
			items: undefined,
		}
		const clone = Object(new ValueCloner({ store, ttl: 5 }, plan).clone())

		expect(clone.store).toBe(store)
		expect(clone.ttl).toBe(5)
		expect(new ValueCloner(store, HELD).clone()).toBe(store)
	})

	it.each([
		['a class instance', createClassInstance()],
		['a store', new SessionStore()],
		['a date', new Date(0)],
		['a map', new Map([['id', 1]])],
		['a function', encodeURI],
		[
			'a class instance whose own getter throws',
			Object.defineProperty(createClassInstance(), 'secret', {
				get: throwHostileAccess,
				enumerable: true,
			}),
		],
		[
			'a function whose own getter throws',
			Object.defineProperty(() => undefined, 'secret', {
				get: throwHostileAccess,
				enumerable: true,
			}),
		],
	])('holds %s by identity and reads none of its members', (_name, value) => {
		const clone = Object(new ValueCloner({ value }, undefined).clone())

		expect(clone.value).toBe(value)
		expect(new ValueCloner(value, undefined).clone()).toBe(value)
	})

	it('copies one source at a free position and holds it at an interface position in one walk', () => {
		const implementation = { get: encodeURI, set: encodeURI }
		const plan: CapturePlan = {
			held: false,
			properties: { held: HELD, free: undefined },
			tail: undefined,
			items: undefined,
		}
		const first = Object(
			new ValueCloner({ held: implementation, free: implementation }, plan).clone(),
		)
		const second = Object(
			new ValueCloner({ free: implementation, held: implementation }, plan).clone(),
		)

		expect(first.held).toBe(implementation)
		expect(first.free).not.toBe(implementation)
		expect(first.free).toEqual(implementation)
		expect(second.held).toBe(implementation)
		expect(second.free).not.toBe(implementation)
	})

	it('copies one source into one copy per plan, so each copy holds only where its plan does', () => {
		const implementation = { get: encodeURI }
		const bag = { store: implementation }
		const plan: CapturePlan = {
			held: false,
			properties: {
				planned: { held: false, properties: { store: HELD }, tail: undefined, items: undefined },
				free: undefined,
			},
			tail: undefined,
			items: undefined,
		}
		const first = Object(new ValueCloner({ planned: bag, free: bag }, plan).clone())
		const second = Object(new ValueCloner({ free: bag, planned: bag }, plan).clone())

		expect(first.planned).not.toBe(first.free)
		expect(first.planned.store).toBe(implementation)
		expect(first.free.store).not.toBe(implementation)
		expect(second.planned.store).toBe(implementation)
		expect(second.free.store).not.toBe(implementation)
	})

	it('takes a declared key’s plan over the tail plan, and the element plan for every index', () => {
		const implementation = { get: encodeURI }
		const plan: CapturePlan = {
			held: false,
			properties: { declared: undefined },
			tail: HELD,
			items: undefined,
		}
		const listed: CapturePlan = {
			held: false,
			properties: {},
			tail: undefined,
			items: HELD,
		}
		const clone = Object(
			new ValueCloner({ declared: implementation, extra: implementation }, plan).clone(),
		)
		const list = Object(new ValueCloner([implementation, implementation], listed).clone())

		expect(clone.declared).not.toBe(implementation)
		expect(clone.extra).toBe(implementation)
		expect(list[0]).toBe(implementation)
		expect(list[1]).toBe(implementation)
	})

	it('admits a snapshot of exactly the node limit and refuses one node past it with code clone', () => {
		const within = new Array<number>(CLONE_NODE_LIMIT - 1).fill(0)
		const past = new Array<number>(CLONE_NODE_LIMIT).fill(0)
		const error = captureContractError(() => new ValueCloner(past, undefined).clone())

		expect(Reflect.get(Object(new ValueCloner(within, undefined).clone()), 'length')).toBe(
			CLONE_NODE_LIMIT - 1,
		)
		expect(error.code).toBe('clone')
		expect(error.message).toBe(`own: snapshot exceeds the node limit ${CLONE_NODE_LIMIT}`)
		expect(error.context).toEqual({ path: [String(CLONE_NODE_LIMIT - 1)], limit: CLONE_NODE_LIMIT })
	})

	it('refuses an unreadable member or value with a coded error that keeps the thrown value', () => {
		const sentinel = Object.freeze({ stage: 'read' })
		const member = Object.defineProperty({}, 'value', {
			get: throwSentinel(sentinel),
			enumerable: true,
		})
		const read = captureContractError(() => new ValueCloner({ nested: member }, undefined).clone())
		const revoked = captureContractError(() =>
			new ValueCloner(createRevokedProxy(), undefined).clone(),
		)

		expect(read).toBeInstanceOf(ContractError)
		expect(read.code).toBe('structure')
		expect(read.message).toBe('own: member could not be read')
		expect(read.context).toEqual({ path: ['nested', 'value'] })
		expect(read.cause).toBe(sentinel)
		expect(revoked.message).toBe('own: value could not be read')
		expect(revoked.context).toEqual({ path: [] })
	})

	it('locates a refusal deep in nested records and arrays by every key the walk took', () => {
		const sentinel = Object.freeze({ stage: 'deep' })
		const member = Object.defineProperty({}, 'value', {
			get: throwSentinel(sentinel),
			enumerable: true,
		})
		const read = captureContractError(() =>
			new ValueCloner({ list: [{ ok: 1 }, { deep: { member } }] }, undefined).clone(),
		)

		expect(read.message).toBe('own: member could not be read')
		expect(read.context).toEqual({ path: ['list', '1', 'deep', 'member', 'value'] })
	})

	it('replays its settled snapshot and its settled refusal without another read', () => {
		const reads = createRecorder<readonly [string]>()
		const cloner = new ValueCloner(buildReportingRecord([['id', 7]], reads.handler), undefined)
		const failing = new ValueCloner(createThrowingGetter(), undefined)
		const clone = cloner.clone()
		const refused = captureContractError(() => failing.clone())

		expect(cloner.clone()).toBe(clone)
		expect(reads.calls).toEqual([['id']])
		expect(captureContractError(() => failing.clone())).toBe(refused)
	})
})
