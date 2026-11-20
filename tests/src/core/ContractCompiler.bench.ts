// Times the compiled guards a database pays per stored row and per query-door read, the refusal
// doors on the same row, the fifty-level chain's audit and ownership, and the owning door
// against `admitValue` on the option bags a factory admits, one `it` per cell; select one with an
// anchored `-t`. Each answer is asserted before its cell is timed, and an owning cell annotates its
// median latency in milliseconds for an interleaved reading.
import {
	admitValue,
	arrayShape,
	compileGuard,
	createContract,
	numberShape,
	rawShape,
	recordShape,
} from '@src/core'
import { ValueCloner } from '../../../src/core/ValueCloner.js'
import {
	CHAIN_BENCH_FAULTED,
	CHAIN_BENCH_SHAPE,
	CHAIN_BENCH_VALUE,
	CONDITION_BENCH_SHAPE,
	CONDITION_BENCH_VALUE,
	MIXED_BENCH_SHAPE,
	MIXED_BENCH_VALUE,
	OWN_BENCH_CASES,
	QUERY_BENCH_ONE,
	QUERY_BENCH_SHAPE,
	QUERY_BENCH_TEN,
	RECORD_BENCH_VALUE,
	ROW_BENCH_ORDERS,
	ROW_BENCH_REFUSED,
	ROW_BENCH_SHAPE,
	ROW_BENCH_VALUE,
	UNION_BENCH_SHAPE,
	UNION_BENCH_VALUE,
} from '../../setup.js'
import { expect, it } from 'vitest'

const row = createContract(ROW_BENCH_SHAPE)
const query = createContract(QUERY_BENCH_SHAPE)
const union = createContract(UNION_BENCH_SHAPE)
const chain = createContract(CHAIN_BENCH_SHAPE)
const mixed = createContract(MIXED_BENCH_SHAPE)
const numbers = createContract(recordShape(numberShape()))
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

it('admits a six-column row', async ({ bench }) => {
	expect(admitValue(row, ROW_BENCH_VALUE).success).toBe(true)
	const result = await bench('admits a six-column row', {}, () => {
		admitValue(row, ROW_BENCH_VALUE)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('audits a six-column row with four faults', async ({ bench }) => {
	expect(row.audit(ROW_BENCH_REFUSED)).toHaveLength(4)
	const result = await bench('audits a six-column row with four faults', {}, () => {
		row.audit(ROW_BENCH_REFUSED)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('refuses a six-column row with four faults', async ({ bench }) => {
	expect(admitValue(row, ROW_BENCH_REFUSED).success).toBe(false)
	const result = await bench('refuses a six-column row with four faults', {}, () => {
		admitValue(row, ROW_BENCH_REFUSED)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('explains a six-column row with one fault', async ({ bench }) => {
	expect(row.explain(ROW_BENCH_REFUSED)).toHaveLength(1)
	const result = await bench('explains a six-column row with one fault', {}, () => {
		row.explain(ROW_BENCH_REFUSED)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('audits a fifty-level chain whose leaf faults', async ({ bench }) => {
	expect(chain.audit(CHAIN_BENCH_FAULTED)[0]?.path).toHaveLength(50)
	const result = await bench('audits a fifty-level chain whose leaf faults', {}, () => {
		chain.audit(CHAIN_BENCH_FAULTED)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('owns a fifty-level chain', async ({ bench }) => {
	expect(chain.own(CHAIN_BENCH_VALUE).success).toBe(true)
	const result = await bench('owns a fifty-level chain', {}, () => {
		chain.own(CHAIN_BENCH_VALUE)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks a value against the last of four discriminated object arms', async ({ bench }) => {
	expect(union.is(UNION_BENCH_VALUE)).toBe(true)
	const result = await bench(
		'checks a value against the last of four discriminated object arms',
		{},
		() => {
			union.is(UNION_BENCH_VALUE)
		},
	).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks a fifty-level chain of nested records', async ({ bench }) => {
	expect(chain.is(CHAIN_BENCH_VALUE)).toBe(true)
	const result = await bench('checks a fifty-level chain of nested records', {}, () => {
		chain.is(CHAIN_BENCH_VALUE)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks an eight-member record with omitted optional and null members', async ({ bench }) => {
	expect(mixed.is(MIXED_BENCH_VALUE)).toBe(true)
	const result = await bench(
		'checks an eight-member record with omitted optional and null members',
		{},
		() => {
			mixed.is(MIXED_BENCH_VALUE)
		},
	).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks an eight-key record of numbers', async ({ bench }) => {
	expect(numbers.is(RECORD_BENCH_VALUE)).toBe(true)
	const result = await bench('checks an eight-key record of numbers', {}, () => {
		numbers.is(RECORD_BENCH_VALUE)
	}).run({ time: 1000 })
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

it.for(OWN_BENCH_CASES)('admits a $kind bag', async ({ kind, shape, bag }, { bench, annotate }) => {
	const contract = createContract(shape)
	expect(admitValue(contract, bag).success).toBe(true)
	const result = await bench(`admits a ${kind} bag`, {}, () => {
		admitValue(contract, bag)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
	if (result.state === 'completed') await annotate(`median ${result.latency.p50}`, 'reading')
})

it.for(OWN_BENCH_CASES)(
	'copies and admits a $kind bag',
	async ({ kind, shape, bag, plan }, { bench, annotate }) => {
		const contract = createContract(shape)
		expect(admitValue(contract, new ValueCloner(bag, plan).clone()).success).toBe(true)
		const result = await bench(`copies and admits a ${kind} bag`, {}, () => {
			new ValueCloner(bag, plan).clone()
			admitValue(contract, bag)
		}).run({ time: 1000 })
		expect(result.state).toBe('completed')
		if (result.state === 'completed') await annotate(`median ${result.latency.p50}`, 'reading')
	},
)

it.for(OWN_BENCH_CASES)('owns a $kind bag', async ({ kind, shape, bag }, { bench, annotate }) => {
	const contract = createContract(shape)
	const owned = contract.own(bag)
	expect(owned).toEqual(admitValue(contract, bag))
	expect(owned.success).toBe(true)
	const result = await bench(`owns a ${kind} bag`, {}, () => {
		contract.own(bag)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
	if (result.state === 'completed') await annotate(`median ${result.latency.p50}`, 'reading')
})
