import { KEY_PLAN_LIMIT, isBoolean, isInteger, isString } from '@src/core'
import { KeyPlanCache } from '../../../src/core/KeyPlanCache.js'
import { polluteArrayConstruction } from '../../setup.js'
import { describe, expect, it } from 'vitest'

const GUARDS = Object.freeze({ id: isString, rank: isInteger, active: isBoolean, note: isString })
const ORDERS: ReadonlyArray<readonly string[]> = [
	['id', 'rank'],
	['rank', 'id'],
	['id', 'rank', 'note'],
	['note', 'id', 'rank'],
	['active', 'id', 'rank'],
	['id', 'active', 'rank'],
]

describe('KeyPlanCache', () => {
	it('recalls a retained key order as one step per key, in order', () => {
		const cache = new KeyPlanCache(GUARDS)
		expect(cache.recall(['id', 'rank'])).toBeUndefined()
		cache.retain(['id', 'rank'])
		expect(cache.recall(['id', 'rank'])).toEqual([
			{ key: 'id', guard: isString },
			{ key: 'rank', guard: isInteger },
		])
	})

	it('misses on a differing order and on a prefix', () => {
		const cache = new KeyPlanCache(GUARDS)
		cache.retain(['id', 'rank', 'note'])
		expect(cache.recall(['id', 'rank', 'note'])).toBeDefined()
		expect(cache.recall(['rank', 'id', 'note'])).toBeUndefined()
		expect(cache.recall(['id', 'rank'])).toBeUndefined()
		expect(cache.recall(['id', 'rank', 'note', 'active'])).toBeUndefined()
	})

	it('keeps the oldest plans and misses every order past KEY_PLAN_LIMIT', () => {
		expect(ORDERS.length).toBeGreaterThan(KEY_PLAN_LIMIT)
		const cache = new KeyPlanCache(GUARDS)
		for (const order of ORDERS) cache.retain(order)
		for (const order of ORDERS.slice(0, KEY_PLAN_LIMIT)) expect(cache.recall(order)).toBeDefined()
		for (const order of ORDERS.slice(KEY_PLAN_LIMIT)) expect(cache.recall(order)).toBeUndefined()
	})

	it('retains a held key order once', () => {
		const cache = new KeyPlanCache(GUARDS)
		const [first, ...rest] = ORDERS.slice(0, KEY_PLAN_LIMIT)
		cache.retain(first ?? [])
		cache.retain(first ?? [])
		for (const order of rest) cache.retain(order)
		for (const order of ORDERS.slice(0, KEY_PLAN_LIMIT)) expect(cache.recall(order)).toBeDefined()
	})

	it('retains nothing for a key list holding an undeclared key', () => {
		const cache = new KeyPlanCache(GUARDS)
		cache.retain(['id', 'secret'])
		expect(cache.recall(['id', 'secret'])).toBeUndefined()
		cache.retain(['constructor'])
		expect(cache.recall(['constructor'])).toBeUndefined()
		for (const order of ORDERS.slice(0, KEY_PLAN_LIMIT)) cache.retain(order)
		for (const order of ORDERS.slice(0, KEY_PLAN_LIMIT)) expect(cache.recall(order)).toBeDefined()
	})

	it('retains under polluted array construction', () => {
		const cache = new KeyPlanCache(GUARDS)
		polluteArrayConstruction(() => {
			cache.retain(['id', 'rank'])
			cache.retain(['rank', 'id'])
		})
		expect(cache.recall(['id', 'rank'])).toBeDefined()
		expect(cache.recall(['rank', 'id'])).toBeDefined()
	})
})
