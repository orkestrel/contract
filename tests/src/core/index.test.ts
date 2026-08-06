import type { AnyFunction, Result } from '@src/core'
import { attempt, isContractError, isFunction } from '@src/core'
import * as contract from '@src/core'
import { describe, expect, it } from 'vitest'

const READ_CONTROL = 'valueToSchema'
const HONEST_READ = { a: 1 }
const EMPTY_READ = {}
const HOSTILE_READ = new Proxy(HONEST_READ, {
	get() {
		throw new Error('hostile read')
	},
})

function observeRead(value: unknown, input: unknown): Result<string | undefined> {
	if (value === input) return { success: true, value: '[input]' }
	if (isFunction(value)) {
		const called = attempt(() => value(1))
		if (!called.success) return called
		return observeRead(called.value, input)
	}
	return attempt(() => JSON.stringify(value))
}

function runRead(candidate: AnyFunction, input: unknown): Result<string | undefined> {
	const called = attempt(() => candidate(input))
	if (!called.success) return called
	return observeRead(called.value, input)
}

function collectReadFindings(
	entries: readonly (readonly [string, AnyFunction])[],
): readonly string[] {
	const findings: string[] = []
	for (const [name, candidate] of entries) {
		const honest = runRead(candidate, HONEST_READ)
		const empty = runRead(candidate, EMPTY_READ)
		const hostile = runRead(candidate, HOSTILE_READ)
		if (!honest.success || (empty.success && honest.value === empty.value)) continue
		if (hostile.success && hostile.value === honest.value) continue
		if (!hostile.success && isContractError(hostile.error)) continue
		findings.push(name)
	}
	return findings
}

function launderValueToSchema(value: unknown): unknown {
	const outcome = attempt(() => contract.valueToSchema(value))
	return outcome.success ? outcome.value : {}
}

describe('public read-containment matrix', () => {
	it('derives every callable from the public runtime export surface', () => {
		const functions: (readonly [string, AnyFunction])[] = []
		for (const [name, value] of Object.entries(contract)) {
			if (isFunction(value)) functions.push([name, value])
		}
		if (functions.length === 0)
			throw new Error('INSTRUMENT VACUOUS: public function corpus is empty')
		if (!functions.some(([name]) => name === READ_CONTROL)) {
			throw new Error('INSTRUMENT VACUOUS: valueToSchema control is absent')
		}
		expect(collectReadFindings(functions)).toEqual([])
	})

	it('reports the mandatory laundering control with the opposite verdict', () => {
		const findings = collectReadFindings([[READ_CONTROL, launderValueToSchema]])
		if (!findings.includes(READ_CONTROL)) {
			throw new Error('INSTRUMENT VACUOUS: valueToSchema laundering control was not found')
		}
		expect(findings).toEqual([READ_CONTROL])
	})
})
