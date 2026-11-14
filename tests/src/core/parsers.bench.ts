// Times `parseEnum` over an error-code vocabulary beside the prebuilt `literalOf` guard over the
// same members. Each answer is asserted before its cell is timed.
import { literalOf, parseEnum } from '@src/core'
import { ENUM_BENCH_CODES } from '../../setup.js'
import { expect, it } from 'vitest'

const isCode = literalOf(ENUM_BENCH_CODES)

it('parses a member of a fourteen-member vocabulary', async ({ bench }) => {
	expect(parseEnum('CODE_7', ENUM_BENCH_CODES)).toBe('CODE_7')
	const result = await bench('parses a member of a fourteen-member vocabulary', {}, () => {
		parseEnum('CODE_7', ENUM_BENCH_CODES)
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})

it('checks a member against the prebuilt literal guard', async ({ bench }) => {
	expect(isCode('CODE_7')).toBe(true)
	const result = await bench('checks a member against the prebuilt literal guard', {}, () => {
		isCode('CODE_7')
	}).run({ time: 1000 })
	expect(result.state).toBe('completed')
})
