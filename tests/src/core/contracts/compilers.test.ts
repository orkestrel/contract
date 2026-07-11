import { describe, expect, it } from 'vitest'
import {
	arrayShape,
	booleanShape,
	compileGenerator,
	compileGuard,
	compileParser,
	compileSchema,
	createContract,
	integerShape,
	literalShape,
	nullableShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	rawShape,
	recordShape,
	seededRandom,
	stringShape,
	unionShape,
} from '@src/core'
import { SOUNDNESS_SAMPLE } from '../../../setup.js'

describe('compileSchema', () => {
	it('emits string / number constraints', () => {
		expect(
			compileSchema(stringShape({ min: 1, max: 8, pattern: /^a+$/, description: 'd' })),
		).toEqual({ type: 'string', minLength: 1, maxLength: 8, pattern: '^a+$', description: 'd' })
		expect(compileSchema(integerShape({ min: 0 }))).toEqual({ type: 'integer', minimum: 0 })
		expect(compileSchema(numberShape({ max: 9 }))).toEqual({ type: 'number', maximum: 9 })
	})

	it('emits literals as enum and arrays with items + bounds', () => {
		expect(compileSchema(literalShape(['a', 'b']))).toEqual({ enum: ['a', 'b'] })
		expect(compileSchema(arrayShape(stringShape(), { max: 2 }))).toEqual({
			type: 'array',
			items: { type: 'string' },
			maxItems: 2,
		})
	})

	it('emits objects with required (optional excluded) + additionalProperties:false', () => {
		expect(
			compileSchema(objectShape({ name: stringShape(), bio: optionalShape(stringShape()) })),
		).toEqual({
			type: 'object',
			properties: { name: { type: 'string' }, bio: { type: 'string' } },
			required: ['name'],
			additionalProperties: false,
		})
		expect(compileSchema(recordShape(numberShape()))).toEqual({
			type: 'object',
			additionalProperties: { type: 'number' },
		})
	})

	it('emits union anyOf / oneOf, nullable anyOf+null, and raw passthrough', () => {
		expect(compileSchema(unionShape(stringShape(), integerShape()))).toEqual({
			anyOf: [{ type: 'string' }, { type: 'integer' }],
		})
		expect(compileSchema(oneOfShape(stringShape(), booleanShape()))).toEqual({
			oneOf: [{ type: 'string' }, { type: 'boolean' }],
		})
		expect(compileSchema(nullableShape(stringShape()))).toEqual({
			anyOf: [{ type: 'string' }, { type: 'null' }],
		})
		expect(compileSchema(rawShape({ type: 'string', description: 'x' }))).toEqual({
			type: 'string',
			description: 'x',
		})
	})
})

describe('compileGuard', () => {
	it('enforces string and number constraints', () => {
		const name = compileGuard(stringShape({ min: 2, max: 4 }))
		expect(name('abc')).toBe(true)
		expect(name('a')).toBe(false)
		expect(name('abcde')).toBe(false)
		expect(name(5)).toBe(false)
		const age = compileGuard(integerShape({ min: 0 }))
		expect(age(3)).toBe(true)
		expect(age(-1)).toBe(false)
		expect(age(3.5)).toBe(false)
	})

	it('validates a closed object with an optional field', () => {
		const guard = compileGuard(
			objectShape({ name: stringShape(), bio: optionalShape(stringShape()) }),
		)
		expect(guard({ name: 'Ada' })).toBe(true)
		expect(guard({ name: 'Ada', bio: 'hi' })).toBe(true)
		expect(guard({ name: 'Ada', extra: 1 })).toBe(false)
		expect(guard({ bio: 'hi' })).toBe(false)
	})

	it('validates an open object (recordShape)', () => {
		const guard = compileGuard(recordShape(numberShape()))
		expect(guard({ a: 1, b: 2 })).toBe(true)
		expect(guard({ a: 1, b: 'x' })).toBe(false)
		expect(guard({})).toBe(true)
	})

	it('handles union / nullable / literal / array', () => {
		const id = compileGuard(unionShape(stringShape(), integerShape()))
		expect(id('x')).toBe(true)
		expect(id(3)).toBe(true)
		expect(id(true)).toBe(false)
		expect(compileGuard(nullableShape(stringShape()))(null)).toBe(true)
		expect(compileGuard(literalShape(['a', 'b']))('a')).toBe(true)
		expect(compileGuard(literalShape(['a', 'b']))('c')).toBe(false)
		const arr = compileGuard(arrayShape(integerShape(), { min: 1 }))
		expect(arr([1, 2])).toBe(true)
		expect(arr([])).toBe(false)
		expect(arr([1, 'x'])).toBe(false)
	})

	it('raw accepts any value and the guard stays total on adversarial input', () => {
		expect(compileGuard(rawShape({}))(Symbol('x'))).toBe(true)
		const guard = compileGuard(objectShape({ name: stringShape() }))
		expect(() => guard(null)).not.toThrow()
		expect(guard(null)).toBe(false)
	})
})

describe('compileParser', () => {
	it('coerces whole objects and fails on a missing required field', () => {
		const parse = compileParser(objectShape({ name: stringShape(), age: integerShape() }))
		expect(parse({ name: 'Ada', age: '36' })).toEqual({ name: 'Ada', age: 36 })
		expect(parse({ name: 'Ada' })).toBeUndefined()
	})

	it('skips absent optional fields and coerces nullable', () => {
		const parse = compileParser(
			objectShape({ name: stringShape(), bio: optionalShape(stringShape()) }),
		)
		expect(parse({ name: 'Ada' })).toEqual({ name: 'Ada' })
		expect(compileParser(nullableShape(integerShape()))(null)).toBeNull()
		expect(compileParser(nullableShape(integerShape()))('7')).toBe(7)
	})

	it('union returns the first variant that both parses and guards', () => {
		const parse = compileParser(unionShape(integerShape(), stringShape()))
		expect(parse('36')).toBe(36)
		expect(parse('hello')).toBe('hello')
	})

	it('enforces string length + pattern refinements (rejects out-of-bounds)', () => {
		const parse = compileParser(stringShape({ min: 1, max: 3, pattern: /^a+$/ }))
		expect(parse('aa')).toBe('aa') // in-bounds
		expect(parse('')).toBeUndefined() // empty under min:1
		expect(parse('aaaa')).toBeUndefined() // over max:3
		expect(parse('xy')).toBeUndefined() // pattern miss
	})

	it('enforces number bounds, even on a coerced numeric string', () => {
		const parse = compileParser(integerShape({ min: 1, max: 5 }))
		expect(parse(3)).toBe(3) // in-bounds
		expect(parse('4')).toBe(4) // coerced and in-bounds
		expect(parse(0)).toBeUndefined() // under min:1
		expect(parse(6)).toBeUndefined() // over max:5
		expect(parse('0')).toBeUndefined() // coerces, then fails min:1
	})

	it('enforces array length bounds after coercing elements', () => {
		const parse = compileParser(arrayShape(integerShape(), { min: 1, max: 2 }))
		expect(parse(['1', '2'])).toEqual([1, 2]) // coerces + in-bounds
		expect(parse([])).toBeUndefined() // under min:1
		expect(parse([1, 2, 3])).toBeUndefined() // over max:2
	})

	it('enforces a refinement on a leaf nested inside an object', () => {
		const parse = compileParser(
			objectShape({ name: stringShape({ min: 1 }), age: integerShape({ min: 0 }) }),
		)
		expect(parse({ name: 'Ada', age: '36' })).toEqual({ name: 'Ada', age: 36 })
		expect(parse({ name: '', age: 36 })).toBeUndefined() // name under min:1
		expect(parse({ name: 'Ada', age: -1 })).toBeUndefined() // age under min:0
	})

	// AGENTS §14 parse↔guard soundness for REFINED leaves: the compiled guard and
	// parser are derived from one combinator source (`stringOf` / `boundsOf`), so every non-`undefined` parse
	// must satisfy the guard — refinements included. (Clause B of soundness; the
	// compiler intentionally rebuilds containers to coerce contents, so the leaf
	// parsers' by-identity clause A does not apply to compiled array/object parsers —
	// hence the focused B-only check rather than `soundnessViolations`.) Violations
	// are gathered into one array and asserted empty (no conditional `expect`).
	it('refined leaves: every non-undefined compiled parse satisfies the guard', () => {
		const shapes = [
			stringShape({ min: 2, max: 4, pattern: /^[a-z]+$/ }),
			numberShape({ min: -1, max: 1 }),
			integerShape({ min: 0, max: 10 }),
			arrayShape(integerShape(), { min: 1, max: 2 }),
			objectShape({ tag: stringShape({ min: 1 }), score: integerShape({ min: 0, max: 100 }) }),
		]
		const violations: string[] = []
		for (let shapeIndex = 0; shapeIndex < shapes.length; shapeIndex += 1) {
			const parse = compileParser(shapes[shapeIndex])
			const guard = compileGuard(shapes[shapeIndex])
			for (let index = 0; index < SOUNDNESS_SAMPLE.length; index += 1) {
				const parsed = parse(SOUNDNESS_SAMPLE[index])
				if (parsed !== undefined && !guard(parsed)) violations.push(`shape${shapeIndex}@${index}`)
			}
		}
		expect(violations).toEqual([])
	})

	it('an in-bounds value round-trips through createContract.parse and is', () => {
		const contract = createContract(
			objectShape({ name: stringShape({ min: 1, max: 5 }), age: integerShape({ min: 0 }) }),
		)
		const parsed = contract.parse({ name: 'Ada', age: '36' })
		expect(parsed).toEqual({ name: 'Ada', age: 36 })
		expect(parsed !== undefined && contract.is(parsed)).toBe(true)
		// An out-of-bounds field makes the whole contract parse fail.
		expect(contract.parse({ name: '', age: 36 })).toBeUndefined()
	})
})

describe('compileGenerator', () => {
	it('is deterministic for a given seed', () => {
		const shape = objectShape({ name: stringShape(), age: integerShape({ min: 0, max: 100 }) })
		expect(compileGenerator(shape, seededRandom(42))).toEqual(
			compileGenerator(shape, seededRandom(42)),
		)
	})

	it('produces values that satisfy the compiled guard', () => {
		const shape = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape({ min: 0, max: 120 }),
			role: literalShape(['admin', 'guest']),
			tags: arrayShape(stringShape(), { min: 1, max: 3 }),
		})
		const guard = compileGuard(shape)
		const random = seededRandom(7)
		for (let index = 0; index < 20; index += 1) {
			expect(guard(compileGenerator(shape, random))).toBe(true)
		}
	})

	it('produces bounded strings that satisfy the compiled guard', () => {
		const shapes = [
			stringShape({ min: 2, max: 4 }),
			stringShape({ max: 6 }),
			stringShape({ min: 0, max: 0 }),
			objectShape({ tag: stringShape({ min: 2, max: 4 }) }),
			arrayShape(stringShape({ min: 2, max: 4 }), { min: 1, max: 3 }),
		]
		for (const shape of shapes) {
			const guard = compileGuard(shape)
			const random = seededRandom(11)
			for (let index = 0; index < 20; index += 1) {
				expect(guard(compileGenerator(shape, random))).toBe(true)
			}
		}
	})

	it('generates the empty string when min and max are both 0', () => {
		const shape = stringShape({ min: 0, max: 0 })
		expect(compileGenerator(shape, seededRandom(1))).toBe('')
	})

	it('throws on a degenerate empty literal / union (programmer error)', () => {
		expect(() => compileGenerator(literalShape([]), seededRandom(1))).toThrow('at least one value')
		expect(() => compileGenerator(unionShape(), seededRandom(1))).toThrow('at least one variant')
	})

	it('throws on a pattern-constrained string shape it cannot satisfy (programmer error)', () => {
		const shape = stringShape({ min: 4, max: 6, pattern: /^ZZZZZZ$/ })
		expect(() => compileGenerator(shape, seededRandom(1))).toThrow('cannot be auto-generated')
	})

	it('falls back to the default random source when none is supplied', () => {
		const shape = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape({ min: 0, max: 9 }),
		})
		const guard = compileGuard(shape)
		expect(guard(compileGenerator(shape))).toBe(true)
	})
})

describe('createContract', () => {
	it('bundles schema / is / parse / generate from one shape', () => {
		const contract = createContract(
			objectShape({ name: stringShape({ min: 1 }), age: integerShape() }),
		)
		expect(contract.schema).toEqual({
			type: 'object',
			properties: { name: { type: 'string', minLength: 1 }, age: { type: 'integer' } },
			required: ['name', 'age'],
			additionalProperties: false,
		})
		expect(contract.is({ name: 'Ada', age: 36 })).toBe(true)
		expect(contract.is({ name: 'Ada', age: 36.5 })).toBe(false)
		expect(contract.parse({ name: 'Ada', age: '36' })).toEqual({ name: 'Ada', age: 36 })
		// The generator's output satisfies the contract's own guard.
		expect(contract.is(contract.generate(seededRandom(3)))).toBe(true)
	})
})
