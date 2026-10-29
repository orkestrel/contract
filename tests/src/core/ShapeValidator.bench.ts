import { ShapeValidator } from '@src/core'
import { VALIDATION_BENCH_LEAF, VALIDATION_BENCH_OBJECT } from '../../setup.js'
import { expect, it } from 'vitest'

it('validates a retained refined leaf', async ({ bench }) => {
	const validator = new ShapeValidator(VALIDATION_BENCH_LEAF)
	const result = await bench('validates a retained refined leaf', {}, () => {
		validator.validate()
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('constructs and validates a refined leaf', async ({ bench }) => {
	const result = await bench('constructs and validates a refined leaf', {}, () => {
		new ShapeValidator(VALIDATION_BENCH_LEAF).validate()
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('validates a retained five-key object', async ({ bench }) => {
	const validator = new ShapeValidator(VALIDATION_BENCH_OBJECT)
	const result = await bench('validates a retained five-key object', {}, () => {
		validator.validate()
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('validates a retained identity leaf', async ({ bench }) => {
	const validator = new ShapeValidator(VALIDATION_BENCH_LEAF)
	const result = await bench('validates a retained identity leaf', {}, () => {
		validator.validate()
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('validates a retained leaf twice', async ({ bench }) => {
	const validator = new ShapeValidator(VALIDATION_BENCH_LEAF)
	const result = await bench('validates a retained leaf twice', {}, () => {
		validator.validate()
		validator.validate()
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})
