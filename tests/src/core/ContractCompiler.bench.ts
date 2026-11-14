// Times the compiled guards a database pays per stored row and per query-door read, one `it`
// per cell; select one with `-t`. Each answer is asserted before its cell is timed.
import { arrayShape, compileGuard, createContract, rawShape } from '@src/core'
import {
	CONDITION_BENCH_SHAPE,
	CONDITION_BENCH_VALUE,
	QUERY_BENCH_ONE,
	QUERY_BENCH_SHAPE,
	QUERY_BENCH_TEN,
	ROW_BENCH_ORDERS,
	ROW_BENCH_SHAPE,
	ROW_BENCH_VALUE,
} from '../../setup.js'
import { expect, it } from 'vitest'

const row = createContract(ROW_BENCH_SHAPE)
const query = createContract(QUERY_BENCH_SHAPE)
const isOperands = compileGuard(arrayShape(rawShape({})))
const isCondition = compileGuard(CONDITION_BENCH_SHAPE)
const OPERANDS = Object.freeze([5])
// The `equals` arm the operator names requires one operand, so the guard reaches its refusal path.
const REFUSED = Object.freeze({ ...CONDITION_BENCH_VALUE, values: Object.freeze([]) })

it('checks a six-column row', async ({ bench }) => {
	expect(row.is(ROW_BENCH_VALUE)).toBe(true)
	const result = await bench('checks a six-column row', {}, () => {
		row.is(ROW_BENCH_VALUE)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks a six-column row in more key orders than the guard keeps plans for', async ({
	bench,
}) => {
	const orders = createContract(ROW_BENCH_SHAPE)
	expect(ROW_BENCH_ORDERS.every((value) => orders.is(value))).toBe(true)
	const result = await bench(
		'checks a six-column row in more key orders than the guard keeps plans for',
		{},
		() => {
			for (const value of ROW_BENCH_ORDERS) orders.is(value)
		},
	).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks a one-element operand array', async ({ bench }) => {
	expect(isOperands(OPERANDS)).toBe(true)
	const result = await bench('checks a one-element operand array', {}, () => {
		isOperands(OPERANDS)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks one condition against its five-arm union', async ({ bench }) => {
	expect(isCondition(CONDITION_BENCH_VALUE)).toBe(true)
	const result = await bench('checks one condition against its five-arm union', {}, () => {
		isCondition(CONDITION_BENCH_VALUE)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('refuses one condition its named arm refuses', async ({ bench }) => {
	expect(isCondition(REFUSED)).toBe(false)
	const result = await bench('refuses one condition its named arm refuses', {}, () => {
		isCondition(REFUSED)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks a one-condition query', async ({ bench }) => {
	expect(query.is(QUERY_BENCH_ONE)).toBe(true)
	const result = await bench('checks a one-condition query', {}, () => {
		query.is(QUERY_BENCH_ONE)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks a ten-condition query', async ({ bench }) => {
	expect(query.is(QUERY_BENCH_TEN)).toBe(true)
	const result = await bench('checks a ten-condition query', {}, () => {
		query.is(QUERY_BENCH_TEN)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})
