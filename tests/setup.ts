// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window` / Vue: DOM/Vue helpers live in `setupBrowser.ts`.
import type { ContractError, ContractShape, ContractInterface, Guard } from '@src/core'
import {
	arrayShape,
	attempt,
	booleanShape,
	createContract,
	INFER_DEPTH_LIMIT,
	integerShape,
	isContractError,
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
 * Run an operation expected to throw a {@link ContractError} and return that
 * error, already narrowed.
 *
 * @remarks
 * The shared THROWING NARROWER for error-path tests. A `try`/`catch` around the
 * operation puts every following `expect` on a conditional path — the assertion
 * silently never runs if the operation stops throwing, which is exactly the
 * regression such a test exists to catch. This runs the operation through the
 * package's own {@link attempt} boundary instead and narrows with the real
 * {@link isContractError} guard, so the caller reads `code` / `context`
 * unconditionally and a missing or wrong-typed throw fails the test here with a
 * precise message rather than passing vacuously.
 *
 * @param operation - The operation expected to throw
 * @returns The thrown {@link ContractError}
 * @throws {Error} When `operation` returns normally or throws a non-`ContractError`
 *
 * @example
 * ```ts
 * const error = captureContractError(() => stringShape({ min: -1 }))
 * expect(error.code).toBe('bound')
 * ```
 */
export function captureContractError(operation: () => unknown): ContractError {
	const outcome = attempt(operation)
	if (outcome.success) {
		throw new Error('captureContractError: the operation returned instead of throwing')
	}
	if (!isContractError(outcome.error)) {
		throw new Error(
			`captureContractError: the operation threw a non-ContractError: ${String(outcome.error)}`,
		)
	}
	return outcome.error
}

/**
 * Throw from a deliberately hostile fixture operation.
 *
 * @returns Never returns because hostile access always throws
 *
 * @example
 * ```ts
 * throwHostileAccess() // throws
 * ```
 */
export function throwHostileAccess(): never {
	throw new Error('hostile access')
}

/**
 * Advance an infinite numeric iterator by one entry.
 *
 * @returns An unfinished iterator result carrying zero
 *
 * @example
 * ```ts
 * advanceInfiniteIterable() // { done: false, value: 0 }
 * ```
 */
export function advanceInfiniteIterable(): IteratorResult<number> {
	return { done: false, value: 0 }
}

/**
 * Return an infinite iterator from its iterable protocol method.
 *
 * @returns The iterator receiving the protocol call
 *
 * @example
 * ```ts
 * const values = createInfiniteIterable()
 * Object.is(iterateInfiniteIterable.call(values), values) // true
 * ```
 */
export function iterateInfiniteIterable(this: IterableIterator<number>): IterableIterator<number> {
	return this
}

/**
 * Create an object Proxy whose access has been permanently revoked.
 *
 * @returns A revoked Proxy that throws when inspected
 *
 * @example
 * ```ts
 * const value = createRevokedProxy()
 * Reflect.getPrototypeOf(value) // throws
 * ```
 */
export function createRevokedProxy(): object {
	const revocable = Proxy.revocable({}, {})
	revocable.revoke()
	return revocable.proxy
}

/**
 * Create an array Proxy whose access has been permanently revoked.
 *
 * @typeParam T - The array element type exposed to the caller
 * @returns A revoked array Proxy that throws when inspected
 *
 * @example
 * ```ts
 * const value = createRevokedArrayProxy()
 * value.length // throws
 * ```
 */
export function createRevokedArrayProxy<T = unknown>(): readonly T[] {
	const target: T[] = []
	const revocable = Proxy.revocable(target, {})
	revocable.revoke()
	return revocable.proxy
}

/**
 * Create a record with an own getter that throws whenever read.
 *
 * @returns A record whose `value` getter throws
 *
 * @example
 * ```ts
 * const record = createThrowingGetter()
 * Reflect.get(record, 'value') // throws
 * ```
 */
export function createThrowingGetter(): Readonly<Record<string, unknown>> {
	const record: Record<string, unknown> = {}
	return Object.defineProperty(record, 'value', {
		get: throwHostileAccess,
		enumerable: true,
	})
}

/**
 * Create a record whose own getter returns a different value on every read.
 *
 * @remarks
 * The unstable-read fixture: inference samples a value once and the compiled
 * guard reads it again, so a property that answers `1` to the first read and
 * `'drifted'` to every read after belongs to no single schema. The change is
 * one-way (never alternating) so the outcome does not depend on how many walks
 * ran before.
 *
 * @returns A record whose `value` getter drifts after its first read
 *
 * @example
 * ```ts
 * const record = createStatefulGetter()
 * record.value // 1
 * record.value // 'drifted'
 * ```
 */
export function createStatefulGetter(): Readonly<Record<string, unknown>> {
	const record: Record<string, unknown> = {}
	let read = false
	return Object.defineProperty(record, 'value', {
		get: () => {
			const first = !read
			read = true
			return first ? 1 : 'drifted'
		},
		enumerable: true,
	})
}

/**
 * Create an array whose own `slice` reports elements it does not hold.
 *
 * @remarks
 * The array-side unstable read: inference samples through `slice`, while the
 * compiled guard walks the real indices, so an overridden reader makes the two
 * views disagree by construction.
 *
 * @returns An array of numbers whose `slice` yields strings
 *
 * @example
 * ```ts
 * const array = createUnstableArray()
 * array[0]          // 1
 * array.slice(0, 2) // ['lie', 'lie']
 * ```
 */
export function createUnstableArray(): readonly unknown[] {
	const array: unknown[] = [1, 2, 3]
	return Object.defineProperty(array, 'slice', {
		value: () => ['lie', 'lie'],
	})
}

/**
 * Create an object whose own-key reflection traps always throw.
 *
 * @returns A Proxy hostile to own-key and descriptor inspection
 *
 * @example
 * ```ts
 * const value = createHostileKeys()
 * Reflect.ownKeys(value) // throws
 * ```
 */
export function createHostileKeys(): object {
	return new Proxy(
		{},
		{
			ownKeys: throwHostileAccess,
			getOwnPropertyDescriptor: throwHostileAccess,
		},
	)
}

/**
 * Build an alternating array-and-record nest around a string leaf.
 *
 * @param depth - The number of container layers to add
 * @returns `'leaf'` wrapped in `depth` alternating container layers
 *
 * @example
 * ```ts
 * buildDeepNest(2) // { value: ['leaf'] }
 * ```
 */
export function buildDeepNest(depth: number): unknown {
	let value: unknown = 'leaf'
	for (let layer = 0; layer < depth; layer += 1) {
		value = layer % 2 === 0 ? [value] : { value }
	}
	return value
}

/**
 * Build a machine-scale literal vocabulary — larger than the engine's
 * spread-argument limit.
 *
 * @remarks
 * The realistic source of such a list is inference, not authorship: an
 * untrusted schema's `enum` keyword converts to a `literalShape` of whatever
 * size it carries. The default count is above the point where
 * `guard(...vocabulary)` throws a `RangeError` on V8, so any literal machinery
 * that spreads its vocabulary into arguments fails this corpus while the
 * array-taking form passes.
 *
 * @param count - The number of distinct string literals to build
 * @returns The vocabulary, in generation order
 *
 * @example
 * ```ts
 * buildWideVocabulary(3) // ['value0', 'value1', 'value2']
 * ```
 */
export function buildWideVocabulary(count = 200_000): readonly string[] {
	const values: string[] = []
	for (let index = 0; index < count; index += 1) values.push(`value${index}`)
	return values
}

/**
 * Build a finite array-shape nest at an exact depth.
 *
 * @param depth - The number of array wrappers around the string leaf
 * @returns The nested contract shape
 *
 * @example
 * ```ts
 * buildDeepShape(2) // arrayShape(arrayShape(stringShape()))
 * ```
 */
export function buildDeepShape(depth: number): ContractShape {
	let shape: ContractShape = stringShape()
	for (let index = 0; index < depth; index += 1) {
		shape = arrayShape(shape)
	}
	return shape
}

/**
 * Create a plain record with one non-enumerable own property.
 *
 * @param key - The hidden property key
 * @param value - The hidden property value
 * @returns The record carrying the non-enumerable property
 *
 * @example
 * ```ts
 * Object.keys(createNonEnumerableRecord('hidden', true)) // []
 * ```
 */
export function createNonEnumerableRecord(
	key: string,
	value: unknown,
): Readonly<Record<string, unknown>> {
	const record: Record<string, unknown> = {}
	Object.defineProperty(record, key, {
		value,
		enumerable: false,
		configurable: true,
		writable: true,
	})
	return record
}

/**
 * Build a record whose `self` property points back to the record.
 *
 * @returns A cyclic readonly record
 *
 * @example
 * ```ts
 * const record = buildCyclicRecord()
 * Object.is(record.self, record) // true
 * ```
 */
export function buildCyclicRecord(): Readonly<Record<string, unknown>> {
	const record: Record<string, unknown> = {}
	record.self = record
	return record
}

/**
 * Build an array whose only entry points back to the array.
 *
 * @returns A cyclic readonly array
 *
 * @example
 * ```ts
 * const value = buildCyclicArray()
 * Object.is(value[0], value) // true
 * ```
 */
export function buildCyclicArray(): readonly unknown[] {
	const value: unknown[] = []
	value.push(value)
	return value
}

/**
 * Build a three-slot sparse array with only its middle entry populated.
 *
 * @returns A readonly sparse array containing `'value'` at index one
 *
 * @example
 * ```ts
 * const value = buildSparseArray()
 * value.length // 3
 * ```
 */
export function buildSparseArray(): readonly unknown[] {
	const value: unknown[] = []
	value.length = 3
	value[1] = 'value'
	return value
}

/**
 * Create a record whose prototype is `null` — a plain record that no realm's
 * `Object.prototype` sits above.
 *
 * @returns A null-prototype record carrying one integer property
 *
 * @example
 * ```ts
 * const record = createNullPrototypeRecord()
 * Object.getPrototypeOf(record) // null
 * ```
 */
export function createNullPrototypeRecord(): Readonly<Record<string, unknown>> {
	const record: Record<string, unknown> = Object.create(null)
	record.value = 1
	return record
}

/**
 * Create an instance of a user-defined class — an exotic, non-plain object no
 * JSON Schema keyword describes.
 *
 * @returns A class instance carrying one integer property
 *
 * @example
 * ```ts
 * const instance = createClassInstance()
 * Object.getPrototypeOf(instance) === Object.prototype // false
 * ```
 */
export function createClassInstance(): object {
	return new (class Sample {
		readonly value: number = 1
	})()
}

/**
 * Create a self-iterating iterator that can be consumed only once.
 *
 * @returns An iterator over `1`, `2`, and `3`
 *
 * @example
 * ```ts
 * const values = createOneShotIterable()
 * Array.from(values) // [1, 2, 3]
 * Array.from(values) // []
 * ```
 */
export function createOneShotIterable(): IterableIterator<number> {
	return [1, 2, 3].values()
}

/**
 * Create an iterator that yields zero forever.
 *
 * @returns A self-iterating infinite iterator
 *
 * @example
 * ```ts
 * const values = createInfiniteIterable()
 * values.next() // { done: false, value: 0 }
 * ```
 */
export function createInfiniteIterable(): IterableIterator<number> {
	return {
		next: advanceInfiniteIterable,
		[Symbol.iterator]: iterateInfiniteIterable,
	}
}

/**
 * A broad, frozen spread of values for exercising the package's whole-value
 * invariants exhaustively — parse↔guard soundness (see
 * {@link soundnessViolations}), `explain` ⟺ `parse`, and the inference round
 * trip `compileGuard(schemaToShape(valueToSchema(v)))(v)`.
 *
 * @remarks
 * Covers guard-valid representatives for every shipped guard, coercible inputs
 * (numeric strings, `'true'` / `1`), signed zero, `NaN` / `±Infinity`, empty and
 * nested containers, exotic hosts (`Map`, `Set`, `Date`, a class instance, a
 * function, a symbol, a bigint), a null-prototype record, cyclic record/array
 * graphs, a sparse array, a record with a non-enumerable own property, hostile
 * hosts (a throwing own-getter, a throwing `ownKeys` Proxy), and a nest deeper
 * than `INFER_DEPTH_LIMIT` — so every invariant is covered non-vacuously and
 * adversarially.
 */
export const SOUNDNESS_SAMPLE: readonly unknown[] = Object.freeze([
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
	// A structurally-valid `compositeShape(2)` value except its optional `opt`
	// leaf is present with an explicit `undefined` — the class of input that
	// breaks the hasOwn-vs-value-undefined presence check between parse and
	// explain (parse skips it as absent; a hasOwn-gated reporter used to
	// recurse into the inner shape with `undefined` and fault).
	(() => {
		const leaf = {
			str: 'a',
			num: 1,
			int: 1,
			bool: true,
			nul: null,
			lit: 'a',
			arr: ['x'],
			uni: 'a',
			one: true,
			opt: undefined,
			nullable: null,
			rec: { x: 1 },
			json: null,
		}
		return { nested: leaf, list: [leaf], dict: { a: leaf } }
	})(),
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
	createNullPrototypeRecord(),
	createNonEnumerableRecord('hidden', 'value'),
	createClassInstance(),
	buildCyclicRecord(),
	buildCyclicArray(),
	buildSparseArray(),
	createThrowingGetter(),
	createHostileKeys(),
	buildDeepNest(INFER_DEPTH_LIMIT + 8),
])

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
