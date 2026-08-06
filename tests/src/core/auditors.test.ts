import type { ContractShape } from '@src/core'
import { describe, expect, it } from 'vitest'
import {
	arrayShape,
	booleanShape,
	compileAuditor,
	compileGuard,
	FAULT_LIMIT,
	integerShape,
	literalShape,
	nullableShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	recordShape,
	stringShape,
	unionShape,
} from '@src/core'
import {
	SOUNDNESS_SAMPLE,
	compileWidenedContract,
	compositeShape,
	createHostileKeys,
	createRevokedArrayProxy,
	createRevokedProxy,
	createThrowingGetter,
	leafShapeVariations,
} from '../../setup.js'

describe('compileAuditor — strict soundness matrix', () => {
	const shapes: readonly (readonly [string, ContractShape])[] = [
		...leafShapeVariations(),
		['composite', compositeShape(2)],
	]

	it('audit(v).length === 0 iff guard(v), across every leaf/composite shape and sample', () => {
		const violations: string[] = []
		let comparisons = 0
		for (const [label, shape] of shapes) {
			const guard = compileGuard(shape)
			for (let index = 0; index < SOUNDNESS_SAMPLE.length; index += 1) {
				const value = SOUNDNESS_SAMPLE[index]
				const empty = compileAuditor(shape, value).length === 0
				if (empty !== guard(value)) violations.push(`${label}@${String(index)}`)
				comparisons += 1
			}
		}
		expect(violations).toEqual([])
		expect(comparisons).toBe(shapes.length * SOUNDNESS_SAMPLE.length)
	})

	it('covers every leaf variation plus the composite shape', () => {
		expect(shapes.length).toBeGreaterThanOrEqual(20)
		expect(SOUNDNESS_SAMPLE.length).toBeGreaterThanOrEqual(45)
	})
})

describe('compileAuditor — object exactness', () => {
	it('reports nested closed-object extras at the offending key without reading the value', () => {
		const shape = objectShape({ nested: objectShape({ id: stringShape() }) })
		const nested: Record<string, unknown> = { id: 'a' }
		Object.defineProperty(nested, 'extra', {
			get() {
				throw new Error('must not read an extra value')
			},
			enumerable: true,
		})

		expect(compileAuditor(shape, { nested })).toEqual([
			{ reason: 'extra', path: ['nested', 'extra'] },
		])
	})

	it('accepts unconstrained extras without reading them', () => {
		const shape = objectShape({ id: stringShape() }, { additionalProperties: true })
		const value: Record<string, unknown> = { id: 'a' }
		Object.defineProperty(value, 'extra', {
			get() {
				throw new Error('must not read an unconstrained extra value')
			},
			enumerable: true,
		})

		expect(compileAuditor(shape, value)).toEqual([])
		expect(compileGuard(shape)(value)).toBe(true)
	})

	it('recurses through a shape-valued tail and record shapes', () => {
		const tailed = objectShape(
			{ id: stringShape() },
			{ additionalProperties: integerShape({ min: 0 }) },
		)
		expect(compileAuditor(tailed, { id: 'a', count: 1 })).toEqual([])
		expect(compileAuditor(tailed, { id: 'a', count: -1 })).toEqual([
			{
				reason: 'constraint',
				path: ['count'],
				expected: 'integer',
				constraint: 'min',
				limit: 0,
				received: '-1',
			},
		])

		const record = recordShape(integerShape())
		expect(compileAuditor(record, { first: 1, second: 2 })).toEqual([])
		expect(compileAuditor(record, { first: 1, second: '2' })).toEqual([
			{ reason: 'type', path: ['second'], expected: 'integer', received: '"2"' },
		])
	})
})

describe('compileAuditor — strict coercion delta', () => {
	it('faults every coercive leaf while explain stays clean and parse succeeds', () => {
		const cases: readonly (readonly [string, ContractShape, unknown])[] = [
			['string-number', stringShape(), 42],
			['number-string', numberShape(), '42'],
			['boolean-word', booleanShape(), 'true'],
			['boolean-digit', booleanShape(), '0'],
			['literal-trim', literalShape(['ready']), ' ready '],
			['array-element', arrayShape(numberShape()), ['1']],
			[
				'nested-field',
				objectShape({ nested: objectShape({ count: numberShape() }) }),
				{
					nested: { count: '1' },
				},
			],
			['optional-inner', objectShape({ count: optionalShape(numberShape()) }), { count: '1' }],
			['nullable-inner', nullableShape(numberShape()), '1'],
		]

		for (const [label, shape, value] of cases) {
			const contract = compileWidenedContract(shape)
			expect([
				label,
				contract.is(value),
				contract.audit(value).length > 0,
				contract.explain(value).length,
				contract.parse(value) !== undefined,
			]).toEqual([label, false, true, 0, true])
		}
	})
})

describe('compileAuditor — strict unions', () => {
	it('anyOf is empty when one strict variant accepts the value', () => {
		const shape = unionShape(
			objectShape({ name: stringShape() }),
			objectShape({ name: stringShape(), count: integerShape() }),
		)
		const value = { name: 'a', count: 1 }

		expect(compileAuditor(shape, value)).toEqual([])
		expect(compileGuard(shape)(value)).toBe(true)
	})

	it('oneOf is empty only for exactly one strict match', () => {
		const exclusive = oneOfShape(stringShape(), booleanShape())
		expect(compileAuditor(exclusive, 'a')).toEqual([])
		expect(compileAuditor(exclusive, 1).length).toBeGreaterThan(0)

		const overlapping = oneOfShape(stringShape(), stringShape({ min: 0 }))
		expect(compileAuditor(overlapping, 'a')).toEqual([{ reason: 'oneOf', path: [], matched: 2 }])
	})
})

describe('compileAuditor — totality and cap', () => {
	it('contains hostile getters and throwing reflection traps as one top-level fault', () => {
		const shape = objectShape({ value: stringShape() })
		const expected = [{ reason: 'type', path: [], expected: 'object', received: 'object' }]

		expect(compileAuditor(shape, createThrowingGetter())).toEqual(expected)
		expect(compileAuditor(shape, createHostileKeys())).toEqual(expected)
		expect(compileAuditor(shape, createRevokedProxy())).toEqual(expected)
		expect(compileAuditor(arrayShape(stringShape()), createRevokedArrayProxy())).toEqual([
			{ reason: 'type', path: [], expected: 'array', received: 'object' },
		])
	})

	it('caps non-empty faults at every nesting level without truncating to empty', () => {
		const properties = Object.fromEntries(
			Array.from({ length: FAULT_LIMIT * 2 }, (_, index) => [
				`field${String(index)}`,
				stringShape(),
			]),
		)
		const object = objectShape(properties)
		const array = arrayShape(object)
		const nested = arrayShape(array)

		for (const [shape, value] of [
			[object, {}],
			[array, [{}]],
			[nested, [[{}]]],
		] satisfies readonly (readonly [ContractShape, unknown])[]) {
			const faults = compileAuditor(shape, value)
			expect(faults.length).toBe(FAULT_LIMIT)
			expect(faults.length).toBeGreaterThan(0)
		}

		const extras = Object.fromEntries(
			Array.from({ length: FAULT_LIMIT * 2 }, (_, index) => [`extra${String(index)}`, index]),
		)
		expect(compileAuditor(objectShape({}), extras).length).toBe(FAULT_LIMIT)
		expect(compileAuditor(arrayShape(stringShape()), ['valid'])).toEqual([])
	})
})

describe('createContract — audit wiring', () => {
	it('delegates audit to the strict auditor independently of explain', () => {
		const shape = objectShape({ count: integerShape() })
		const contract = compileWidenedContract(shape)
		const coercive = { count: '1' }
		const extra = { count: 1, extra: true }

		expect(contract.audit(coercive)).toEqual(compileAuditor(shape, coercive))
		expect(contract.audit(coercive).length).toBeGreaterThan(0)
		expect(contract.explain(coercive)).toEqual([])
		expect(contract.audit(extra)).toEqual([{ reason: 'extra', path: ['extra'] }])
		expect(contract.explain(extra)).toEqual([])
	})
})
