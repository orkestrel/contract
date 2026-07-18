// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window` / Vue: DOM/Vue helpers live in `setupBrowser.ts`.
import type { ContractShape, ContractInterface, Guard } from '@src/core'
import {
	arrayShape,
	booleanShape,
	createContract,
	integerShape,
	jsonShape,
	literalShape,
	nullableShape,
	nullShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	recordShape,
	seededRandom,
	stringShape,
	unionShape,
} from '@src/core'
import { afterEach, expect, vi } from 'vitest'

afterEach(() => {
	vi.restoreAllMocks()
})

/**
 * A broad spread of values for exercising parse↔guard soundness exhaustively:
 * guard-valid representatives for every shipped guard, coercible inputs (numeric
 * strings, `'true'` / `1`), and adversarial non-matches (mixed arrays, symbol,
 * bigint, function) so both soundness clauses are covered non-vacuously.
 */
export const SOUNDNESS_SAMPLE: readonly unknown[] = [
	null,
	undefined,
	true,
	false,
	0,
	1,
	-1,
	42,
	3.14,
	-0,
	Number.NaN,
	Number.POSITIVE_INFINITY,
	Number.NEGATIVE_INFINITY,
	'',
	' ',
	'hello',
	'abc',
	'42',
	'3.14',
	'true',
	'false',
	'0',
	'1',
	{},
	{ a: 1 },
	[],
	[1, 2],
	[1, '2'],
	['a', 'b'],
	new Map(),
	new Set(),
	10n,
	Symbol('s'),
	() => 1,
	new Date(),
]

/**
 * Return the parse↔guard soundness violations of a (guard, parser) pair over
 * {@link SOUNDNESS_SAMPLE} — an empty result means the pair is sound (AGENTS §14):
 * - **A** — a guard-valid input is returned UNCHANGED (by identity), never rejected.
 * - **B** — every non-`undefined` output satisfies the guard.
 *
 * @param guard - The guard for the parser's output type
 * @param parse - The parser under test
 * @returns Violation tags (`A@<index>` / `B@<index>`); empty when sound
 */
export function soundnessViolations<T>(
	guard: Guard<T>,
	parse: (value: unknown) => T | undefined,
): readonly string[] {
	const out: string[] = []
	for (let index = 0; index < SOUNDNESS_SAMPLE.length; index += 1) {
		const value = SOUNDNESS_SAMPLE[index]
		const parsed = parse(value)
		if (guard(value) && !Object.is(parsed, value)) out.push(`A@${index}`)
		if (parsed !== undefined && !guard(parsed)) out.push(`B@${index}`)
	}
	return out
}

// === Shape factories
//
// One factory per leaf kind, each returning every variation named in the
// dispatch — used by integration.test.ts to exercise the full primitive
// matrix and by the existing shape/compiler suites to avoid re-declaring the
// same shapes locally.

/** Every `stringShape` variation: plain, min-only, max-only, min+max, described. */
export function stringShapeVariations(): readonly (readonly [string, ContractShape])[] {
	return [
		['string:plain', stringShape()],
		['string:min', stringShape({ min: 2 })],
		['string:max', stringShape({ max: 10 })],
		['string:bounds', stringShape({ min: 2, max: 8 })],
		['string:described', stringShape({ min: 1, max: 5, description: 'a name' })],
	]
}

/**
 * Every `numberShape` / `integerShape` variation: plain, bounded, integer,
 * bounded integer, and an integer with fractional (but non-empty) bounds.
 */
export function numberShapeVariations(): readonly (readonly [string, ContractShape])[] {
	return [
		['number:plain', numberShape()],
		['number:bounds', numberShape({ min: -5, max: 5 })],
		['number:integer', integerShape()],
		['number:integer-bounds', integerShape({ min: 0, max: 100 })],
		['number:fractional-bounds-nonempty', integerShape({ min: 2.2, max: 5.8 })],
	]
}

/** The single `booleanShape` variation. */
export function booleanShapeVariations(): readonly (readonly [string, ContractShape])[] {
	return [['boolean:plain', booleanShape({ description: 'a flag' })]]
}

/** The single `nullShape` variation. */
export function nullShapeVariations(): readonly (readonly [string, ContractShape])[] {
	return [['null:plain', nullShape()]]
}

/** Every `literalShape` variation: single/multi string, number, boolean, mixed, described. */
export function literalShapeVariations(): readonly (readonly [string, ContractShape])[] {
	return [
		['literal:single', literalShape(['only'])],
		['literal:multi', literalShape(['a', 'b', 'c'])],
		['literal:number', literalShape([1, 2, 3])],
		['literal:boolean', literalShape([true, false])],
		['literal:mixed', literalShape(['a', 1, true])],
		['literal:described', literalShape(['x', 'y'], { description: 'a letter' })],
	]
}

/** The single `jsonShape` variation. */
export function jsonShapeVariations(): readonly (readonly [string, ContractShape])[] {
	return [['json:plain', jsonShape()]]
}

/**
 * Every leaf-kind × variation pair, flattened — string, number, boolean,
 * null, literal, and json, each with every knob combination named above.
 */
export function leafShapeVariations(): readonly (readonly [string, ContractShape])[] {
	return [
		...stringShapeVariations(),
		...numberShapeVariations(),
		...booleanShapeVariations(),
		...nullShapeVariations(),
		...literalShapeVariations(),
		...jsonShapeVariations(),
	]
}

/**
 * Build a nested, all-kinds composite shape — an object combining every
 * `ContractShape` kind (string / number / integer / boolean / null / literal
 * / array / union / oneOf / optional / nullable / record / json).
 *
 * @remarks
 * At `depth >= 2` the previous level's composite is nested inside a wrapping
 * object's `arrayShape` and `recordShape` fields, so `compositeShape(3)`
 * contains two levels of array/record nesting around the all-kinds leaf.
 *
 * @param depth - How many nesting levels to wrap (depth < 2 returns the flat composite)
 * @returns A composite object shape
 */
export function compositeShape(depth = 2): ContractShape {
	const leaf = objectShape({
		str: stringShape({ min: 1, max: 20 }),
		num: numberShape({ min: -100, max: 100 }),
		int: integerShape({ min: 0, max: 1000 }),
		bool: booleanShape(),
		nul: nullShape(),
		lit: literalShape(['a', 'b', 'c']),
		arr: arrayShape(stringShape(), { min: 0, max: 5 }),
		uni: unionShape(stringShape(), integerShape()),
		one: oneOfShape(stringShape(), booleanShape()),
		opt: optionalShape(stringShape()),
		nullable: nullableShape(integerShape()),
		rec: recordShape(numberShape()),
		json: jsonShape(),
	})
	let current: ContractShape = leaf
	for (let level = 2; level <= depth; level += 1) {
		current = objectShape({
			nested: current,
			list: arrayShape(current, { min: 0, max: 3 }),
			dict: recordShape(current),
		})
	}
	return current
}

// === Value factories
//
// Small, curated (honest — not generator-derived) valid/invalid samples per
// leaf kind, keyed by the shape's `type`. Covers the leaf kinds where a
// static sample set is meaningful; containers/wrappers are exercised via
// generated values instead (see expectLockstep / expectJSONRoundtrip).

/** A small curated set of values that satisfy an unconstrained shape of the given leaf kind. */
export function validSamplesFor(shape: ContractShape): readonly unknown[] {
	switch (shape.type) {
		case 'string':
			return ['a', 'hello', '']
		case 'number':
			return shape.integer === true ? [0, 1, -1, 42] : [0, 1.5, -2.25, 100]
		case 'boolean':
			return [true, false]
		case 'null':
			return [null]
		case 'literal':
			return [...shape.values]
		case 'json':
			return [null, 42, 'x', true, { a: [1, 'x', null] }]
		default:
			return []
	}
}

/** A small curated set of values that violate an unconstrained shape of the given leaf kind. */
export function invalidSamplesFor(shape: ContractShape): readonly unknown[] {
	switch (shape.type) {
		case 'string':
			return [42, true, null, undefined, {}]
		case 'number':
			return shape.integer === true
				? [1.5, '1', Number.NaN, null]
				: ['1', Number.NaN, Number.POSITIVE_INFINITY, null]
		case 'boolean':
			return [0, 1, 'true', null]
		case 'null':
			return [undefined, 0, '', false]
		case 'literal':
			return ['not-a-value', Symbol('x'), {}]
		case 'json':
			return [() => 1, Number.NaN, Number.POSITIVE_INFINITY, new Date()]
		default:
			return []
	}
}

/**
 * Compile a widened `ContractShape` into a contract without letting
 * `createContract`'s generic `Infer<S>` overload resolve against the full
 * `ContractShape` union — a caller holding only the widened type (e.g. from
 * {@link compositeShape}) would otherwise trigger an excessively-deep type
 * instantiation (TS2589) at the call site.
 *
 * @param shape - A shape whose static type is the widened `ContractShape` union
 * @returns The compiled contract, typed as `ContractInterface<unknown>`
 */
export function compileWidenedContract<S extends ContractShape>(
	shape: S,
): ContractInterface<unknown> {
	return createContract(shape)
}

// === Compile-time type equality
//
// A precision oracle stronger than assignability: `expectTypeOf(...).toEqualTypeOf`
// covers most cases, but a hand-rolled identity check is used where a type-level
// `Expect<Equal<...>>` assertion reads more directly alongside a hand-written
// expected type (e.g. a deep structural snapshot lock).

/**
 * Strict type-level equality — `true` only when `X` and `Y` are identical types
 * (mutual assignability is NOT enough; e.g. `{ a: string }` and `{ a: string; b?: never }`
 * are mutually assignable but not `Equal`).
 *
 * @remarks
 * The classic conditional-generic-identity trick: two distinct generic
 * functions collapse to the same type only when `X` and `Y` are exactly equal.
 */
export type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false

/** Compile-time assertion — fails to typecheck unless `T` is exactly `true`. */
export type Expect<T extends true> = T

// === Roundtrip helpers

/**
 * Assert the generate → is → parse lockstep for one shape and seed.
 *
 * @remarks
 * `generate` must satisfy `is`; `parse` of a generated (guard-valid) value
 * must deep-equal that value (the parser rebuilds objects/arrays, so equality
 * is structural, not identity — primitives are naturally identical); the
 * parsed result must itself satisfy `is`.
 *
 * @param shape - The shape to compile and exercise
 * @param seed - The seed for the deterministic generator
 */
export function expectLockstep<S extends ContractShape>(shape: S, seed: number): void {
	const contract: ContractInterface<unknown> = createContract(shape)
	const value = contract.generate(seededRandom(seed))
	expect(contract.is(value)).toBe(true)
	const parsed = contract.parse(value)
	expect(parsed).toEqual(value)
	expect(parsed !== undefined && contract.is(parsed)).toBe(true)
}

/**
 * Assert byte-for-byte JSON roundtrip fidelity for one shape and seed.
 *
 * @remarks
 * generate → `JSON.stringify` → `JSON.parse` → `is` → `parse` →
 * `JSON.stringify` must reproduce the ORIGINAL stringified text exactly.
 * Every shape kind reachable through `leafShapeVariations` / `compositeShape`
 * generates JSON-safe values (the `json` leaf and `nullable`'s `null` case
 * included), and an absent optional property is simply omitted by
 * `JSON.stringify` on both sides — so no shape kind here needs a documented
 * exception (e.g. `-0`, which the bounded generators never produce: the
 * default and every configured `min` in these shapes is `>= 0` or the range
 * excludes an exact zero draw at `random() === 0`).
 *
 * @param shape - The shape to compile and exercise
 * @param seed - The seed for the deterministic generator
 */
export function expectJSONRoundtrip<S extends ContractShape>(shape: S, seed: number): void {
	const contract: ContractInterface<unknown> = createContract(shape)
	const value = contract.generate(seededRandom(seed))
	const text = JSON.stringify(value)
	const revived: unknown = JSON.parse(text)
	expect(contract.is(revived)).toBe(true)
	const reparsed = contract.parse(revived)
	expect(JSON.stringify(reparsed)).toBe(text)
}
