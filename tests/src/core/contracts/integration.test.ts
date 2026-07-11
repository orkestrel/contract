// Integration coverage for the full contract primitive matrix (AGENTS §14 /
// master spec Unit F): every leaf shape × variation, every container and
// wrapper, large composite contracts, and cross-pair composition with the
// guard combinators. Uses the shared factories/roundtrip helpers from
// tests/setup.ts rather than re-declaring shapes locally.
//
// `expectLockstep` / `expectJSONRoundtrip` carry their own `expect(...)`
// assertions internally (tests/setup.ts) — each `it` here wraps its seed
// loop in an outer `expect(() => { ... }).not.toThrow()` so a real, visible
// assertion sits in the test body (satisfying the `vitest/expect-expect`
// lint rule) without weakening or duplicating what the helper already
// asserts: a failed inner `expect` throws, which the wrapper still surfaces
// as a failing test.
import { describe, expect, it } from 'vitest'
import type { ContractShape, Guard, Infer, NumberShape, StringShape } from '@src/core'
import {
	arrayShape,
	booleanShape,
	compileSchema,
	createContract,
	integerShape,
	isNumber,
	jsonShape,
	lazyOf,
	literalShape,
	nullableShape,
	nullShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	parseJSONAs,
	recordOf,
	recordShape,
	seededRandom,
	stringShape,
	unionShape,
} from '@src/core'
import {
	compileWidenedContract,
	compositeShape,
	expectJSONRoundtrip,
	expectLockstep,
	leafShapeVariations,
} from '../../../setup.js'

const SEEDS = [0, 1, 7, 42, 999]
const MANY_SEEDS = Array.from({ length: 10 }, (_value, index) => index * 13 + 1)

describe('per-primitive roundtrips', () => {
	for (const [label, shape] of leafShapeVariations()) {
		describe(`${label}`, () => {
			it('is lockstep-sound across seeds', () => {
				expect(() => {
					for (const seed of SEEDS) expectLockstep(shape, seed)
				}).not.toThrow()
			})

			it('roundtrips through JSON byte-for-byte across seeds', () => {
				expect(() => {
					for (const seed of SEEDS) expectJSONRoundtrip(shape, seed)
				}).not.toThrow()
			})
		})
	}
})

describe('container / wrapper roundtrips', () => {
	it('arrayShape over several leaf kinds, including bounds', () => {
		const shapes = [
			arrayShape(stringShape(), { min: 1, max: 4 }),
			arrayShape(integerShape({ min: 0, max: 10 }), { max: 0 }),
			arrayShape(booleanShape()),
			arrayShape(nullShape(), { min: 2, max: 2 }),
		]
		expect(() => {
			for (const shape of shapes) {
				for (const seed of SEEDS) {
					expectLockstep(shape, seed)
					expectJSONRoundtrip(shape, seed)
				}
			}
		}).not.toThrow()
	})

	it('recordShape dictionaries', () => {
		const shapes = [recordShape(integerShape({ min: 0 })), recordShape(stringShape({ max: 5 }))]
		expect(() => {
			for (const shape of shapes) {
				for (const seed of SEEDS) {
					expectLockstep(shape, seed)
					expectJSONRoundtrip(shape, seed)
				}
			}
		}).not.toThrow()
	})

	it('unionShape / oneOfShape mixed variants', () => {
		const shapes = [
			unionShape(stringShape(), integerShape(), booleanShape()),
			oneOfShape(nullShape(), stringShape({ min: 1 })),
		]
		expect(() => {
			for (const shape of shapes) {
				for (const seed of SEEDS) {
					expectLockstep(shape, seed)
					expectJSONRoundtrip(shape, seed)
				}
			}
		}).not.toThrow()
	})

	it('nullableShape over leaves', () => {
		const shapes = [nullableShape(stringShape()), nullableShape(integerShape({ min: 0, max: 5 }))]
		expect(() => {
			for (const shape of shapes) {
				for (const seed of SEEDS) {
					expectLockstep(shape, seed)
					expectJSONRoundtrip(shape, seed)
				}
			}
		}).not.toThrow()
	})

	it('optionalShape inside objectShape — present and absent key handling through parse', () => {
		const shape = objectShape({ name: stringShape({ min: 1 }), bio: optionalShape(stringShape()) })
		const contract = createContract(shape)
		// Present.
		expect(contract.parse({ name: 'Ada', bio: 'hi' })).toEqual({ name: 'Ada', bio: 'hi' })
		// Absent — key genuinely missing from the parsed result, not `undefined`-valued.
		const parsed = contract.parse({ name: 'Ada' })
		expect(parsed).toEqual({ name: 'Ada' })
		expect(parsed !== undefined && Object.hasOwn(parsed, 'bio')).toBe(false)
		expect(() => {
			for (const seed of SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})

	it('additionalProperties open objects', () => {
		const shape = objectShape(
			{ id: stringShape() },
			{ additionalProperties: integerShape({ min: 0 }) },
		)
		const contract = createContract(shape)
		expect(contract.is({ id: 'a', extra: 1 })).toBe(true)
		expect(contract.is({ id: 'a', extra: 'nope' })).toBe(false)
		expect(() => {
			for (const seed of SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})
})

describe('large composite contracts', () => {
	it('compositeShape(2) is lockstep-sound and byte-for-byte across seeds', () => {
		const shape = compositeShape(2)
		expect(() => {
			for (const seed of MANY_SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})

	it('compositeShape(3) is lockstep-sound and byte-for-byte across seeds', () => {
		const shape = compositeShape(3)
		expect(() => {
			for (const seed of MANY_SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})

	it('a kitchen-sink contract combining every shape kind is lockstep-sound and byte-for-byte', () => {
		const shape = objectShape({
			str: stringShape({ min: 1, max: 10, description: 'a string' }),
			num: numberShape({ min: -50, max: 50 }),
			int: integerShape({ min: 0, max: 50 }),
			bool: booleanShape(),
			nul: nullShape(),
			lit: literalShape(['x', 1, false]),
			arr: arrayShape(stringShape(), { min: 0, max: 3 }),
			obj: objectShape({ inner: integerShape({ min: 0 }) }),
			uni: unionShape(stringShape(), integerShape()),
			one: oneOfShape(booleanShape(), nullShape()),
			opt: optionalShape(stringShape()),
			nullable: nullableShape(stringShape()),
			rec: recordShape(booleanShape()),
			json: jsonShape(),
		})
		expect(() => {
			for (const seed of MANY_SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})

	it('determinism: the same seed produces deep-equal output across contracts of the same shape', () => {
		const shape = compositeShape(2)
		// `compileWidenedContract` (not `createContract` directly) — `shape`'s
		// static type is the widened `ContractShape` union, and letting
		// `createContract`'s generic `Infer<S>` overload resolve against that
		// union is excessively deep for the type checker (TS2589).
		const first = compileWidenedContract(shape).generate(seededRandom(55))
		const second = compileWidenedContract(shape).generate(seededRandom(55))
		expect(first).toEqual(second)
	})

	it('schema sanity: compileSchema(shape) deep-equals contract.schema', () => {
		const shape = compositeShape(3)
		// See the note above — `shape` is a widened `ContractShape`.
		const contract = compileWidenedContract(shape)
		expect(contract.schema).toEqual(compileSchema(shape))
	})

	it('a representative composite compiles to a hand-authored expected JSON Schema', () => {
		const shape = objectShape(
			{
				name: stringShape({ min: 1 }),
				age: optionalShape(integerShape({ min: 0 })),
				active: nullableShape(booleanShape()),
				roles: arrayShape(literalShape(['admin', 'guest'])),
			},
			{ additionalProperties: numberShape() },
		)
		expect(compileSchema(shape)).toEqual({
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1 },
				age: { type: 'integer', minimum: 0 },
				active: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
				roles: { type: 'array', items: { enum: ['admin', 'guest'] } },
			},
			required: ['name', 'active', 'roles'],
			additionalProperties: { type: 'number' },
		})
	})
})

describe('cross-pair composition', () => {
	it('parseJSONAs round-trips a generated value through its own compiled guard', () => {
		const shape = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape({ min: 0, max: 120 }),
			tags: arrayShape(stringShape(), { max: 3 }),
		})
		const contract = createContract(shape)
		for (const seed of SEEDS) {
			const value = contract.generate(seededRandom(seed))
			const text = JSON.stringify(value)
			expect(parseJSONAs(text, contract.is)).toEqual(value)
		}
		// A malformed document never throws, even against a live compiled guard.
		expect(parseJSONAs('{not json', contract.is)).toBeUndefined()
	})

	it('lazyOf recursive guard validates a nested tree built from contract-generated leaves', () => {
		interface Tree {
			readonly value: number
			readonly children: readonly Tree[]
		}
		const isTree: Guard<Tree> = recordOf({
			value: isNumber,
			children: (input: unknown): input is readonly Tree[] =>
				Array.isArray(input) && input.every((entry) => lazyOf(() => isTree)(entry)),
		})

		const valueContract = createContract(integerShape({ min: 0, max: 1000 }))
		const random = seededRandom(3)
		const buildTree = (depth: number): Tree => ({
			value: valueContract.generate(random),
			children: depth <= 0 ? [] : [buildTree(depth - 1), buildTree(depth - 1)],
		})

		const tree = buildTree(3)
		expect(isTree(tree)).toBe(true)
		// A depth-mismatched shape (a string where a number is expected) fails.
		expect(isTree({ value: 'x', children: [] })).toBe(false)
	})
})

describe('widened ContractShape inference (TS2589 regression)', () => {
	// Infer of the FULL widened union is a type-level fixed point (five members
	// recurse back into the whole union), so Infer bails out to `unknown`
	// lazily instead of letting the compiler fan out until TS2589. Every line
	// in this block was a confirmed TS2589 trigger before the bail-out; the
	// file compiling at all IS the regression assertion for them.
	it('compiles the three previously-exploding widened forms and keeps them lockstep-sound', () => {
		// Trigger 1: a bare type alias over the full union — exactly `unknown`.
		type Widened = Infer<ContractShape>
		type IsUnknown<T> = unknown extends T ? ([T] extends [unknown] ? true : false) : false
		const widenedIsUnknown: IsUnknown<Widened> = true
		expect(widenedIsUnknown).toBe(true)

		// Trigger 2: an indexed-access argument out of a widened registry.
		const registry: Record<string, ContractShape> = {
			user: objectShape({ name: stringShape({ min: 1 }) }),
		}
		const fromRegistry = createContract(registry['user'] ?? stringShape())
		expect(fromRegistry.is({ name: 'Ada' })).toBe(true)

		// Trigger 3: chaining directly off the result of a widened call.
		expect(fromRegistry.parse({ name: 'Ada' })).toEqual({ name: 'Ada' })
		expect(
			fromRegistry.is(createContract(registry['user'] ?? stringShape()).generate(seededRandom(11))),
		).toBe(true)
	})

	it('partial unions still distribute exactly — only the full union bails out', () => {
		// StringShape | NumberShape must stay string | number, not unknown.
		type Partial = Infer<StringShape | NumberShape>
		const asString: Partial = 'text'
		const asNumber: Partial = 42
		// @ts-expect-error — a boolean is outside the partial union's inference
		const asBoolean: Partial = true
		expect([asString, asNumber, asBoolean]).toBeDefined()
	})
})
