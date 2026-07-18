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
	isRecord,
	jsonShape,
	literalShape,
	nullableShape,
	nullShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	rawShape,
	recordShape,
	seededRandom,
	stringShape,
	unionShape,
	validateShape,
} from '@src/core'
import { SOUNDNESS_SAMPLE } from '../../setup.js'

describe('validateShape', () => {
	it('throws on an optional shape used as an array item', () => {
		expect(() => validateShape(arrayShape(optionalShape(stringShape())))).toThrow(
			'validateShape: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as a union variant', () => {
		expect(() => validateShape(unionShape(optionalShape(stringShape()), integerShape()))).toThrow(
			'validateShape: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as a nullable inner', () => {
		expect(() => validateShape(nullableShape(optionalShape(stringShape())))).toThrow(
			'validateShape: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as another optional inner', () => {
		expect(() => validateShape(optionalShape(optionalShape(stringShape())))).toThrow(
			'validateShape: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as additionalProperties', () => {
		expect(() =>
			validateShape(objectShape({}, { additionalProperties: optionalShape(stringShape()) })),
		).toThrow('validateShape: an optional shape may only appear as a direct object-property value')
	})

	it('throws on a top-level optional shape', () => {
		expect(() => validateShape(optionalShape(stringShape()))).toThrow(
			'validateShape: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an empty union', () => {
		expect(() => validateShape(unionShape())).toThrow(
			'validateShape: a union shape needs at least one variant',
		)
	})

	it('throws on an empty literal', () => {
		expect(() => validateShape(literalShape([]))).toThrow(
			'validateShape: a literal shape needs at least one value',
		)
	})

	it('throws on a literal shape containing a non-finite number value', () => {
		expect(() => validateShape(literalShape([Number.NaN]))).toThrow(
			'validateShape: a literal shape may not contain non-finite number values',
		)
		expect(() => validateShape(literalShape([Number.POSITIVE_INFINITY]))).toThrow(
			'validateShape: a literal shape may not contain non-finite number values',
		)
		expect(() => validateShape(literalShape([Number.NEGATIVE_INFINITY]))).toThrow(
			'validateShape: a literal shape may not contain non-finite number values',
		)
		// A finite number literal alongside other values still passes.
		expect(() => validateShape(literalShape([1, 'a', 2.5]))).not.toThrow()
	})

	it('throws on a string shape with min greater than max', () => {
		expect(() => validateShape(stringShape({ min: 5, max: 1 }))).toThrow(
			'validateShape: a string shape has min greater than max',
		)
	})

	it('throws on a number shape with min greater than max', () => {
		expect(() => validateShape(numberShape({ min: 5, max: 1 }))).toThrow(
			'validateShape: a number shape has min greater than max',
		)
	})

	it('throws on an array shape with min greater than max', () => {
		expect(() => validateShape(arrayShape(stringShape(), { min: 5, max: 1 }))).toThrow(
			'validateShape: an array shape has min greater than max',
		)
	})

	it('throws on an integer shape with an empty integer range', () => {
		expect(() => validateShape(integerShape({ min: 2.5, max: 2.6 }))).toThrow(
			'validateShape: an integer number shape has an empty integer range',
		)
	})

	it('does not throw on legal placements', () => {
		// optional as a direct object property
		expect(() => validateShape(objectShape({ bio: optionalShape(stringShape()) }))).not.toThrow()
		// bounds where min === max
		expect(() => validateShape(stringShape({ min: 3, max: 3 }))).not.toThrow()
		expect(() => validateShape(numberShape({ min: 3, max: 3 }))).not.toThrow()
		expect(() => validateShape(arrayShape(stringShape(), { min: 2, max: 2 }))).not.toThrow()
		expect(() => validateShape(integerShape({ min: 2, max: 3 }))).not.toThrow()
		// null / json / raw / boolean leaves
		expect(() => validateShape(nullShape())).not.toThrow()
		expect(() => validateShape(jsonShape())).not.toThrow()
		expect(() => validateShape(rawShape({}))).not.toThrow()
		expect(() => validateShape(booleanShape())).not.toThrow()
		// nested legal composites
		expect(() =>
			validateShape(
				objectShape({
					tags: arrayShape(objectShape({ id: stringShape(), note: optionalShape(stringShape()) })),
					kind: unionShape(nullShape(), jsonShape(), rawShape({})),
					meta: nullableShape(objectShape({ value: optionalShape(integerShape()) })),
					extra: optionalShape(recordShape(jsonShape())),
				}),
			),
		).not.toThrow()
	})
})

describe('createContract fail-fast', () => {
	it('throws at creation time for a degenerate shape, not at use', () => {
		expect(() => createContract(stringShape({ min: 5, max: 1 }))).toThrow(
			'validateShape: a string shape has min greater than max',
		)
		expect(() => createContract(unionShape())).toThrow(
			'validateShape: a union shape needs at least one variant',
		)
		expect(() => createContract(literalShape([]))).toThrow(
			'validateShape: a literal shape needs at least one value',
		)
		expect(() => createContract(integerShape({ min: 2.5, max: 2.6 }))).toThrow(
			'validateShape: an integer number shape has an empty integer range',
		)
		expect(() => createContract(arrayShape(optionalShape(stringShape())))).toThrow(
			'validateShape: an optional shape may only appear as a direct object-property value',
		)
	})
})

describe('null / json compileSchema', () => {
	it('emits { type: "null" } with optional description', () => {
		expect(compileSchema(nullShape())).toEqual({ type: 'null' })
		expect(compileSchema(nullShape({ description: 'nothing' }))).toEqual({
			type: 'null',
			description: 'nothing',
		})
	})

	it('emits the empty schema for json, with optional description', () => {
		expect(compileSchema(jsonShape())).toEqual({})
		expect(compileSchema(jsonShape({ description: 'any JSON value' }))).toEqual({
			description: 'any JSON value',
		})
	})
})

describe('null / json compileGuard', () => {
	it('null guard accepts only null', () => {
		const guard = compileGuard(nullShape())
		expect(guard(null)).toBe(true)
		expect(guard(undefined)).toBe(false)
		expect(guard(0)).toBe(false)
		expect(guard('null')).toBe(false)
	})

	it('json guard accepts nested JSON trees and rejects functions, NaN, Infinity, cycles, Date', () => {
		const guard = compileGuard(jsonShape())
		expect(guard(null)).toBe(true)
		expect(guard(42)).toBe(true)
		expect(guard('hello')).toBe(true)
		expect(guard(true)).toBe(true)
		expect(guard({ a: [1, 'x', { b: null }] })).toBe(true)
		expect(guard(() => 1)).toBe(false)
		expect(guard(Number.NaN)).toBe(false)
		expect(guard(Number.POSITIVE_INFINITY)).toBe(false)
		expect(guard(new Date())).toBe(false)
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(guard(cyclic)).toBe(false)
	})
})

describe('null / json compileParser', () => {
	it('null parser is an identity on null, undefined otherwise', () => {
		const parse = compileParser(nullShape())
		expect(parse(null)).toBeNull()
		expect(parse('null')).toBeUndefined()
		expect(parse(undefined)).toBeUndefined()
	})

	it('json parser is an identity for valid JSON, undefined for invalid', () => {
		const parse = compileParser(jsonShape())
		expect(parse({ a: 1 })).toEqual({ a: 1 })
		expect(parse(42)).toBe(42)
		expect(parse(() => 1)).toBeUndefined()
		expect(parse(Number.NaN)).toBeUndefined()
		expect(parse(undefined)).toBeUndefined()
	})
})

describe('null / json compileGenerator', () => {
	it('null generator always emits null and passes the null guard', () => {
		const guard = compileGuard(nullShape())
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(nullShape(), seededRandom(seed))
			expect(value).toBeNull()
			expect(guard(value)).toBe(true)
		}
	})

	it('json generator output always passes the json guard, across many seeds', () => {
		const guard = compileGuard(jsonShape())
		for (let seed = 0; seed < 30; seed += 1) {
			const value = compileGenerator(jsonShape(), seededRandom(seed))
			expect(guard(value)).toBe(true)
		}
	})

	it('json generator is deterministic for a given seed', () => {
		expect(compileGenerator(jsonShape(), seededRandom(99))).toEqual(
			compileGenerator(jsonShape(), seededRandom(99)),
		)
	})
})

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

	it('oneOfShape rejects a value matching more than one variant (exactly-one semantics)', () => {
		const guard = compileGuard(oneOfShape(numberShape(), integerShape()))
		// 3 is guard-valid against BOTH numberShape and integerShape — the emitted
		// JSON Schema `oneOf` requires EXACTLY one match, so the compiled guard
		// must reject it even though unionShape's anyOf semantics would accept it.
		expect(guard(3)).toBe(false)
		expect(guard(3.5)).toBe(true) // matches numberShape only
		expect(guard('x')).toBe(false) // matches neither
	})

	it('raw accepts any value and the guard stays total on adversarial input', () => {
		expect(compileGuard(rawShape({}))(Symbol('x'))).toBe(true)
		const guard = compileGuard(objectShape({ name: stringShape() }))
		expect(() => guard(null)).not.toThrow()
		expect(guard(null)).toBe(false)
	})

	it('an open object guard is total on hostile keys (__proto__, constructor) — no pollution', () => {
		const guard = compileGuard(recordShape(integerShape()))
		const parse = compileParser(recordShape(integerShape()))
		const fromJSON: unknown = JSON.parse('{"__proto__":1}')
		// The '__proto__' key is validated like any other own key (value 1 passes
		// integerShape) — no throw, and guard/parse agree.
		expect(() => guard(fromJSON)).not.toThrow()
		expect(guard(fromJSON)).toBe(true)
		expect(parse(fromJSON)).not.toBeUndefined()
		// Object.prototype itself must be untouched by the walk.
		expect(Object.getPrototypeOf({})).toBe(Object.prototype)

		// 'constructor' is likewise just another own key — its value ('x') fails
		// integerShape, so the object is rejected, not treated specially.
		expect(guard({ constructor: 'x' })).toBe(false)
		expect(parse({ constructor: 'x' })).toBeUndefined()

		// A throwing getter must yield `false` / `undefined`, never throw.
		const hostile: Record<string, unknown> = {}
		Object.defineProperty(hostile, 'bad', {
			enumerable: true,
			get() {
				throw new Error('hostile getter')
			},
		})
		expect(() => guard(hostile)).not.toThrow()
		expect(guard(hostile)).toBe(false)
		expect(() => parse(hostile)).not.toThrow()
		expect(parse(hostile)).toBeUndefined()
	})

	it('an open object guard/parse agree that a __proto__ own key round-trips faithfully', () => {
		const parse = compileParser(recordShape(integerShape()))
		const fromJSON: unknown = JSON.parse('{"__proto__":5}')
		const parsed = parse(fromJSON)
		expect(isRecord(parsed)).toBe(true)
		const record = isRecord(parsed) ? parsed : {}
		expect(Object.hasOwn(record, '__proto__')).toBe(true)
		expect(record['__proto__']).toBe(5)
		expect(JSON.stringify(record)).toBe('{"__proto__":5}')
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
		// '36' is already guard-valid as a string (clause A), so it is returned
		// unchanged rather than coerced by the integer variant.
		expect(parse('36')).toBe('36')
		expect(parse('hello')).toBe('hello')
	})

	it('union returns a guard-valid value unchanged rather than coerced by an earlier variant', () => {
		const parse = compileParser(unionShape(stringShape(), integerShape()))
		expect(parse(37)).toBe(37) // guard-valid via integer variant — not coerced to '37'
		expect(parse('37')).toBe('37') // already guard-valid via string variant — unchanged
		expect(parse(true)).toBeUndefined() // guard-invalid against every variant
	})

	it('oneOfShape parse rejects an input matching more than one variant', () => {
		const parse = compileParser(oneOfShape(numberShape(), integerShape()))
		expect(parse(3)).toBeUndefined() // matches both variants — ambiguous, rejected
		expect(parse(3.5)).toBe(3.5) // matches numberShape only
		expect(parse('x')).toBeUndefined() // matches neither
	})

	it('union returns a guard-valid object by reference through the identity pass', () => {
		const parse = compileParser(
			unionShape(
				objectShape({ name: stringShape() }),
				objectShape({ name: stringShape(), age: integerShape() }),
			),
		)
		const input = { name: 'Ada', age: 36 }
		expect(parse(input)).toBe(input)
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

	it('generates an empty array when max:0 and passes the guard', () => {
		const shape = arrayShape(stringShape(), { max: 0 })
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(shape, seededRandom(seed))
			expect(value).toEqual([])
			expect(guard(value)).toBe(true)
		}
	})

	it('generates within a fractional-bounds integer range and passes the guard', () => {
		const shape = integerShape({ min: 2.5, max: 3.4 })
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(shape, seededRandom(seed))
			expect(value).toBe(3)
			expect(guard(value)).toBe(true)
		}
	})

	it('throws on a raw shape (cannot be auto-generated)', () => {
		expect(() => compileGenerator(rawShape({ type: 'string' }), seededRandom(1))).toThrow(
			'compileGenerator: a raw shape embeds an arbitrary JSON Schema and cannot be auto-generated — supply values another way',
		)
	})

	it('an open recordShape generates at least one synthetic entry and passes its own guard', () => {
		const shape = recordShape(integerShape())
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(shape, seededRandom(seed))
			expect(isRecord(value)).toBe(true)
			const record = isRecord(value) ? value : {}
			expect(Object.keys(record).length).toBeGreaterThan(0)
			expect(guard(value)).toBe(true)
		}
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

	it('carries Infer<S> end-to-end from a recordShape (finding #7)', () => {
		const c = createContract(recordShape(numberShape()))
		const parsed = c.parse({})
		expect(parsed).toBeDefined()
		const record = parsed ?? {}
		const one: number | undefined = record.k
		expect(one).toBeUndefined()
		// @ts-expect-error — generate returns a number-valued record, not a string-valued one
		const bad: Readonly<Record<string, string>> = c.generate()
		expect(bad).toBeDefined()
	})
})

describe('compileGuard generic overload (finding #4)', () => {
	it('narrows a Guard<Infer<S>> when the shape is a specific literal type', () => {
		const g = compileGuard(objectShape({ name: stringShape() }))
		const x: unknown = { name: 'Ada' }
		expect(g(x)).toBe(true)
		const guarded = g(x) ? x : { name: '' }
		const nm: string = guarded.name
		expect(nm).toBe('Ada')
	})
})

describe('compileParser generic overload (finding #5)', () => {
	it('narrows a Parser<Infer<S>> when the shape is a specific literal type', () => {
		const p = compileParser(recordShape(numberShape()))
		const r = p({})
		const val: Readonly<Record<string, number>> | undefined = r
		expect(val).toBeDefined()
		// @ts-expect-error — parser result is a record, not string
		const wrong: string | undefined = r
		expect(wrong).toBeDefined()
	})
})

describe('compileGenerator generic overload (finding #6)', () => {
	it('narrows to Infer<S> when the shape is a specific literal type', () => {
		const gen = compileGenerator(objectShape({ age: integerShape() }))
		const a: number = gen.age
		expect(a).toBeDefined()
	})
})
