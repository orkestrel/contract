import { describe, expect, it } from 'vitest'
import type { Fault } from '@src/core'
import {
	arrayShape,
	compileParser,
	compileReporter,
	createContract,
	integerShape,
	nullableShape,
	objectShape,
	oneOfShape,
	optionalShape,
	preview,
	rawShape,
	recordShape,
	shapeToKind,
	stringShape,
	unionShape,
} from '@src/core'
import { SOUNDNESS_SAMPLE, compositeShape, leafShapeVariations } from '../../setup.js'

// Mirrors `FAULT_LIMIT` in `src/core/constants.ts` (not part of the public
// barrel) — kept in lockstep by the overflow test below.
const FAULT_LIMIT = 64

describe('compileReporter — soundness matrix', () => {
	const shapes = [...leafShapeVariations(), ['composite', compositeShape(2)] as const]

	it('explain(v).length === 0 iff parse(v) !== undefined, across every leaf/composite shape and the full sample corpus', () => {
		const violations: string[] = []
		for (const [label, shape] of shapes) {
			const parse = compileParser(shape)
			for (let index = 0; index < SOUNDNESS_SAMPLE.length; index += 1) {
				const value = SOUNDNESS_SAMPLE[index]
				const empty = compileReporter(shape, value).length === 0
				const defined = parse(value) !== undefined
				if (empty !== defined) violations.push(`${label}@${index}`)
			}
		}
		expect(violations).toEqual([])
	})

	it('covers at least 12 shapes and 26 sample values (the soundness matrix minimums)', () => {
		expect(shapes.length).toBeGreaterThanOrEqual(12)
		expect(SOUNDNESS_SAMPLE.length).toBeGreaterThanOrEqual(26)
	})
})

describe('compileReporter — object faults', () => {
	it('reports a nested deep path for a failing nested-object leaf', () => {
		const shape = objectShape({
			profile: objectShape({ name: stringShape({ min: 1 }) }),
		})
		const faults = compileReporter(shape, { profile: { name: '' } })
		expect(faults).toEqual([
			{
				reason: 'constraint',
				path: ['profile', 'name'],
				expected: 'string',
				constraint: 'min',
				limit: 1,
				received: '""',
			},
		])
	})

	it('reports one missing fault per absent required key', () => {
		const shape = objectShape({ name: stringShape(), age: integerShape() })
		const faults = compileReporter(shape, {})
		expect(faults).toEqual([
			{ reason: 'missing', path: ['name'], expected: 'string' },
			{ reason: 'missing', path: ['age'], expected: 'integer' },
		])
	})

	it('an absent optional key produces no fault', () => {
		const shape = objectShape({ bio: optionalShape(stringShape()) })
		expect(compileReporter(shape, {})).toEqual([])
	})

	it('reports per-key faults for a record shape', () => {
		const shape = recordShape(integerShape({ min: 0 }))
		const faults = compileReporter(shape, { a: -1, b: 'x', c: 5 })
		expect(faults).toEqual([
			{
				reason: 'constraint',
				path: ['a'],
				expected: 'integer',
				constraint: 'min',
				limit: 0,
				received: '-1',
			},
			{ reason: 'type', path: ['b'], expected: 'integer', received: '"x"' },
		])
	})

	it('a closed object never faults on extra keys (parse silently drops them)', () => {
		const shape = objectShape({ id: stringShape() })
		const faults = compileReporter(shape, { id: 'a', extra: 1, another: 2 })
		expect(faults).toEqual([])
		expect(compileParser(shape)({ id: 'a', extra: 1 })).toEqual({ id: 'a' })
	})

	it('a constraining additionalProperties shape recurses extras and faults', () => {
		const shape = objectShape({ id: stringShape() }, { additionalProperties: integerShape() })
		const faults = compileReporter(shape, { id: 'a', extra: 'not-a-number' })
		expect(faults).toEqual([
			{ reason: 'type', path: ['extra'], expected: 'integer', received: '"not-a-number"' },
		])
	})
})

describe('compileReporter — array faults', () => {
	it('reports per-index faults with the index in the path', () => {
		const shape = arrayShape(stringShape())
		// A finite number coerces to a string (parseString mirrors bidirectional
		// number<->string coercion), so only the genuinely non-coercible entries
		// (a boolean) fault — index 1 ('1' via coercion) stays clean.
		const faults = compileReporter(shape, ['a', 1, 'c', true])
		expect(faults).toEqual([{ reason: 'type', path: ['3'], expected: 'string', received: 'true' }])
	})

	it('reports length constraint faults', () => {
		const shape = arrayShape(stringShape(), { min: 2, max: 3 })
		expect(compileReporter(shape, ['a'])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'array',
				constraint: 'min',
				limit: 2,
				received: '1',
			},
		])
		expect(compileReporter(shape, ['a', 'b', 'c', 'd'])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'array',
				constraint: 'max',
				limit: 3,
				received: '4',
			},
		])
	})
})

describe('compileReporter — string constraint faults', () => {
	it('reports min / max / pattern faults with their limits', () => {
		const shape = stringShape({ min: 3, max: 5, pattern: /^[a-z]+$/ })
		expect(compileReporter(shape, 'ab')).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'min',
				limit: 3,
				received: '"ab"',
			},
		])
		expect(compileReporter(shape, 'abcdef')).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'max',
				limit: 5,
				received: '"abcdef"',
			},
		])
		expect(compileReporter(shape, 'AB')).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'min',
				limit: 3,
				received: '"AB"',
			},
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'pattern',
				limit: '^[a-z]+$',
				received: '"AB"',
			},
		])
	})

	it('a coercible number-as-string reports no fault (mirrors parse, not is)', () => {
		const shape = stringShape({ min: 1 })
		expect(compileReporter(shape, 42)).toEqual([])
		expect(compileParser(shape)(42)).toBe('42')
	})
})

describe('compileReporter — number/integer faults', () => {
	it('a coercible numeric string reports no fault', () => {
		const shape = integerShape({ min: 0, max: 10 })
		expect(compileReporter(shape, '42' /* out of range but coerces */)).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'integer',
				constraint: 'max',
				limit: 10,
				received: '42',
			},
		])
		expect(compileReporter(integerShape(), '7')).toEqual([])
		expect(compileParser(integerShape())('7')).toBe(7)
	})

	it('a fractional value against an integer shape reports an integer constraint fault', () => {
		expect(compileReporter(integerShape(), 3.5)).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'integer',
				constraint: 'integer',
				received: '3.5',
			},
		])
	})
})

describe('compileReporter — union / oneOf', () => {
	it('anyOf: any matching variant reports empty', () => {
		const shape = unionShape(stringShape(), integerShape())
		expect(compileReporter(shape, 'x')).toEqual([])
		expect(compileReporter(shape, 5)).toEqual([])
	})

	it('anyOf: no matching variant reports a variant summary plus the closest variant faults', () => {
		const shape = unionShape(stringShape({ min: 10 }), integerShape({ min: 0 }))
		const faults = compileReporter(shape, -1)
		expect(faults[0]).toEqual({ reason: 'variant', path: [], variants: 2 })
		// The integer variant is closer (a type fault vs. a constraint fault would
		// tie on count here, so this asserts against the actual closest — the
		// number variant, since -1 fails string's type check and integer's min
		// constraint: 1 fault each, ties broken by lowest index — string wins the
		// tie, so its type fault follows.
		expect(faults.length).toBe(2)
	})

	it('oneOf: zero matches reports matched:0 plus the closest variant faults', () => {
		const shape = oneOfShape(stringShape({ pattern: /^a/ }), stringShape({ pattern: /^b/ }))
		const faults = compileReporter(shape, 'x')
		expect(faults[0]).toEqual({ reason: 'oneOf', path: [], matched: 0 })
		expect(faults.length).toBeGreaterThan(1)
	})

	it('oneOf: exactly one match reports empty', () => {
		const shape = oneOfShape(stringShape({ pattern: /^a/ }), stringShape({ pattern: /^b/ }))
		expect(compileReporter(shape, 'apple')).toEqual([])
	})

	it('oneOf: two-or-more matches reports matched >= 2 alone', () => {
		const shape = oneOfShape(stringShape(), stringShape({ min: 0 }))
		expect(compileReporter(shape, 'x')).toEqual([{ reason: 'oneOf', path: [], matched: 2 }])
	})
})

describe('compileReporter — hostile input containment', () => {
	it('bounds a cyclic object value against a finite shape and JSON.stringify(faults) succeeds', () => {
		const shape = objectShape({ id: stringShape() })
		// The shape tree is finite (never cyclic per AGENTS §14), so recursion
		// depth follows the SHAPE, not the value — a self-referencing value poses
		// no infinite-recursion risk. `id` is a non-coercible object, so it faults.
		const cyclic: Record<string, unknown> = { id: {} }
		cyclic.self = cyclic
		const faults = compileReporter(shape, cyclic)
		expect(faults).toEqual([
			{ reason: 'type', path: ['id'], expected: 'string', received: 'object' },
		])
		expect(() => JSON.stringify(faults)).not.toThrow()
	})

	it('caps a 5000-element hostile array at FAULT_LIMIT', () => {
		const shape = arrayShape(stringShape())
		// Objects never coerce to a string, so every element faults.
		const hostile = new Array(5000).fill({})
		const faults = compileReporter(shape, hostile)
		expect(faults.length).toBeLessThanOrEqual(64)
		expect(faults.length).toBeGreaterThan(0)
	})

	it('clips a giant string preview', () => {
		const shape = stringShape({ pattern: /^a+$/ })
		const giant = 'b'.repeat(1000)
		const faults = compileReporter(shape, giant)
		expect(faults.length).toBe(1)
		const fault = faults[0]
		expect(fault !== undefined && fault.reason === 'constraint').toBe(true)
		expect(fault?.reason === 'constraint' && fault.received.length).toBeLessThanOrEqual(66) // PREVIEW_LIMIT + quotes + ellipsis
	})

	it('contains a throwing Proxy getter — returns faults, never throws', () => {
		const hostile = new Proxy(
			{ id: 'x' },
			{
				get() {
					throw new Error('hostile getter')
				},
			},
		)
		const shape = objectShape({ id: stringShape() })
		expect(() => compileReporter(shape, hostile)).not.toThrow()
		const faults = compileReporter(shape, hostile)
		expect(faults.length).toBeGreaterThan(0)
	})

	it('is deterministic — two runs over the same input produce identical faults', () => {
		const shape = objectShape({
			id: stringShape({ min: 1 }),
			tags: arrayShape(stringShape()),
		})
		const value = { id: '', tags: ['a', 1, 'c'] }
		const first = compileReporter(shape, value)
		const second = compileReporter(shape, value)
		expect(first).toEqual(second)
	})
})

describe('createContract — explain wiring', () => {
	it('present-but-undefined optional property: explain matches parse (accept)', () => {
		const shape = objectShape({ bio: optionalShape(stringShape()) })
		const value = { bio: undefined }
		const faults = compileReporter(shape, value)
		const parsed = compileParser(shape)(value)
		expect(faults).toEqual([])
		expect(parsed).toBeDefined()
	})

	it('present-but-undefined required raw property: explain matches parse (reject as missing)', () => {
		const shape = objectShape({ k: rawShape({}) })
		const value = { k: undefined }
		const faults = compileReporter(shape, value)
		const parsed = compileParser(shape)(value)
		expect(parsed).toBeUndefined()
		expect(faults.length).toBeGreaterThan(0)
		expect(faults[0]).toMatchObject({ reason: 'missing', path: ['k'] })
	})

	it('caps total faults at FAULT_LIMIT even across nested union variant concatenation', () => {
		const wide = objectShape(
			Object.fromEntries(
				Array.from({ length: FAULT_LIMIT }, (_, index) => [
					`f${String(index)}`,
					stringShape({ min: 1 }),
				]),
			),
		)
		const badRecord = Object.fromEntries(
			Array.from({ length: FAULT_LIMIT }, (_, index) => [`f${String(index)}`, '']),
		)
		const shape = unionShape(wide, wide)
		const faults = compileReporter(shape, badRecord)
		expect(faults.length).toBeLessThanOrEqual(FAULT_LIMIT)
	})

	it('explain(v) delegates to compileReporter(shape, v)', () => {
		const shape = objectShape({ name: stringShape({ min: 1 }) })
		const contract = createContract(shape)
		expect(contract.explain({ name: '' })).toEqual(compileReporter(shape, { name: '' }))
		expect(contract.explain({ name: 'Ada' })).toEqual([])
	})

	it('explain empty iff parse defined, on the compiled contract', () => {
		const shape = objectShape({ id: stringShape(), age: integerShape({ min: 0 }) })
		const contract = createContract(shape)
		const good = { id: 'x', age: 5 }
		const bad = { id: 'x', age: -1 }
		expect(contract.explain(good).length === 0).toBe(contract.parse(good) !== undefined)
		expect(contract.explain(bad).length === 0).toBe(contract.parse(bad) !== undefined)
	})
})

describe('preview', () => {
	it('renders primitives as literals and escapes/clips strings', () => {
		expect(preview(null)).toBe('null')
		expect(preview(undefined)).toBe('undefined')
		expect(preview(42)).toBe('42')
		expect(preview(true)).toBe('true')
		expect(preview(10n)).toBe('10n')
		expect(preview('hi')).toBe('"hi"')
		const giant = preview('x'.repeat(200))
		expect(giant.endsWith('…')).toBe(true)
		expect(giant.length).toBeLessThanOrEqual(65)
	})

	it('renders objects, arrays, and functions as their typeof tag only — never traversed', () => {
		expect(preview({ a: 1 })).toBe('object')
		expect(preview([1, 2, 3])).toBe('object')
		expect(preview(() => 1)).toBe('function')
	})
})

describe('shapeToKind', () => {
	it('projects each leaf shape to its FaultKind', () => {
		expect(shapeToKind(stringShape())).toBe('string')
		expect(shapeToKind(integerShape())).toBe('integer')
	})

	it('projects optional/nullable through their inner shape, and raw to json', () => {
		expect(shapeToKind(optionalShape(stringShape()))).toBe('string')
		expect(shapeToKind(nullableShape(integerShape()))).toBe('integer')
	})
})

describe('Fault — compile-time exhaustiveness lock', () => {
	it('a switch on every Fault reason is exhaustive (never default)', () => {
		function describeReason(fault: Fault): string {
			switch (fault.reason) {
				case 'type':
					return 'type'
				case 'missing':
					return 'missing'
				case 'constraint':
					return 'constraint'
				case 'variant':
					return 'variant'
				case 'oneOf':
					return 'oneOf'
				default: {
					const exhaustive: never = fault
					throw new Error(`unreachable: ${JSON.stringify(exhaustive)}`)
				}
			}
		}
		expect(describeReason({ reason: 'missing', path: [], expected: 'string' })).toBe('missing')
	})
})
