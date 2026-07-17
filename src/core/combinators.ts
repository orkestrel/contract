import type {
	AnyConstructor,
	FromGuards,
	Guard,
	GuardsShape,
	GuardType,
	IntersectionFromGuards,
	OptionalFromGuards,
	TupleFromGuards,
} from './types.js'
import {
	isArray,
	isConstructor,
	isFiniteNumber,
	isIterable,
	isMap,
	isNumber,
	isObject,
	isRecord,
	isSet,
	isString,
	isSymbol,
} from './validators.js'
import { attempt } from './helpers.js'

// Every combinator returns a `Guard<T>` — a total function (AGENTS §14). The
// three combinators that invoke a caller-supplied callback inside the guard
// body (`whereOf`, `lazyOf`, `transformOf`) contain any throw via `attempt`, so
// the produced guard reports a non-match instead of propagating. The container
// combinators (`arrayOf`, `tupleOf`, `setOf`, `mapOf`, `iterableOf`, `recordOf`)
// likewise wrap their element/entry/key-read walk in `attempt` after the cheap
// structural check — a hostile Proxy trap, a throwing getter, a throwing
// iterator, or a throwing caller-supplied predicate yields a non-match, never a
// propagated throw.

/**
 * Build a guard that accepts arrays whose every element satisfies `elementGuard`.
 *
 * @example
 * ```ts
 * const isStringArray = arrayOf(isString)
 * isStringArray(['a', 'b']) // true
 * isStringArray(['a', 1])   // false
 * ```
 */
export function arrayOf<T>(elementGuard: Guard<T>): Guard<readonly T[]>
export function arrayOf(elementGuard: (value: unknown) => boolean): Guard<readonly unknown[]>
export function arrayOf(elementGuard: (value: unknown) => boolean): Guard<readonly unknown[]> {
	return (value: unknown): value is readonly unknown[] => {
		if (!isArray(value)) {
			return false
		}
		const outcome = attempt(() => value.every(elementGuard))
		return outcome.success && outcome.value
	}
}

/**
 * Build a guard that accepts fixed-arity tuples, testing each index with the
 * corresponding guard.
 *
 * @example
 * ```ts
 * const isPair = tupleOf(isString, isNumber)
 * isPair(['hello', 42]) // true
 * isPair(['hello'])     // false — wrong arity
 * ```
 */
export function tupleOf<const Gs extends ReadonlyArray<Guard<unknown>>>(
	...guards: Gs
): Guard<TupleFromGuards<Gs>>
export function tupleOf(
	...predicates: ReadonlyArray<(value: unknown) => boolean>
): Guard<readonly unknown[]>
export function tupleOf(
	...guards: ReadonlyArray<(value: unknown) => boolean>
): Guard<readonly unknown[]> {
	return (value: unknown): value is readonly unknown[] => {
		if (!isArray(value)) {
			return false
		}
		// Arity comparison reads `.length`, which — like the element reads below —
		// can hit a hostile Proxy trap, so it stays inside the contained region too.
		const outcome = attempt(() => {
			if (value.length !== guards.length) {
				return false
			}
			for (let index = 0; index < guards.length; index += 1) {
				const guard = guards[index]
				if (!guard?.(value[index])) {
					return false
				}
			}
			return true
		})
		return outcome.success && outcome.value
	}
}

/**
 * Build a guard that accepts values identical (via `Object.is`) to one of the
 * provided literal primitives.
 *
 * @example
 * ```ts
 * const isRole = literalOf('admin', 'member', 'guest')
 * isRole('admin') // true
 * isRole('owner') // false
 * ```
 */
export function literalOf<const Literals extends ReadonlyArray<string | number | boolean>>(
	...literals: Literals
): Guard<Literals[number]> {
	return (value: unknown): value is Literals[number] =>
		literals.some((literal) => Object.is(literal, value))
}

/**
 * Build a guard that accepts instances of the provided constructor.
 *
 * @remarks
 * Verifies that `ctor` is a real constructor (via {@link isConstructor}) first,
 * so passing an arrow function does not silently produce a broken guard.
 *
 * @example
 * ```ts
 * const isDateValue = instanceOf(Date)
 * isDateValue(new Date()) // true
 * isDateValue({})         // false
 * ```
 */
export function instanceOf<C>(ctor: C): Guard<InstanceType<C & AnyConstructor<object>>> {
	return (value: unknown): value is InstanceType<C & AnyConstructor<object>> =>
		isConstructor(ctor) && isObject(value) && value instanceof ctor
}

/**
 * Build a guard from a native `enum` or any object whose values are strings or
 * numbers.
 *
 * @example
 * ```ts
 * enum Direction { Up = 'up', Down = 'down' }
 * const isDirection = enumOf(Direction)
 * isDirection('up')   // true
 * isDirection('left') // false
 * ```
 */
export function enumOf<const E extends Record<string, string | number>>(
	enumeration: E,
): Guard<E[keyof E]> {
	const values = new Set(Object.values(enumeration))
	return (value: unknown): value is E[keyof E] =>
		(isString(value) || isNumber(value)) && values.has(value)
}

/**
 * Build a guard that accepts `Set` instances whose every element satisfies
 * `elementGuard`.
 *
 * @example
 * ```ts
 * const isStringSet = setOf(isString)
 * isStringSet(new Set(['a', 'b'])) // true
 * isStringSet(new Set(['a', 1]))   // false
 * ```
 */
export function setOf<T>(elementGuard: Guard<T>): Guard<ReadonlySet<T>>
export function setOf(elementGuard: (value: unknown) => boolean): Guard<ReadonlySet<unknown>>
export function setOf(elementGuard: (value: unknown) => boolean): Guard<ReadonlySet<unknown>> {
	return (value: unknown): value is ReadonlySet<unknown> => {
		if (!isSet(value)) {
			return false
		}
		const outcome = attempt(() => {
			for (const entry of value) {
				if (!elementGuard(entry)) {
					return false
				}
			}
			return true
		})
		return outcome.success && outcome.value
	}
}

/**
 * Build a guard that accepts `Map` instances where every key satisfies
 * `keyGuard` and every value satisfies `valueGuard`.
 *
 * @example
 * ```ts
 * const isStringNumberMap = mapOf(isString, isNumber)
 * isStringNumberMap(new Map([['a', 1]])) // true
 * isStringNumberMap(new Map([[1, 'a']])) // false
 * ```
 */
export function mapOf<K, V>(keyGuard: Guard<K>, valueGuard: Guard<V>): Guard<ReadonlyMap<K, V>>
export function mapOf(
	keyPredicate: (value: unknown) => boolean,
	valuePredicate: (value: unknown) => boolean,
): Guard<ReadonlyMap<unknown, unknown>>
export function mapOf(
	keyGuard: (value: unknown) => boolean,
	valueGuard: (value: unknown) => boolean,
): Guard<ReadonlyMap<unknown, unknown>> {
	return (value: unknown): value is ReadonlyMap<unknown, unknown> => {
		if (!isMap(value)) {
			return false
		}
		const outcome = attempt(() => {
			for (const [key, entryValue] of value) {
				if (!keyGuard(key) || !valueGuard(entryValue)) {
					return false
				}
			}
			return true
		})
		return outcome.success && outcome.value
	}
}

export function recordOf<S extends GuardsShape>(shape: S): Guard<FromGuards<S>>
export function recordOf<S extends GuardsShape, K extends ReadonlyArray<keyof S & string>>(
	shape: S,
	optional: K,
): Guard<OptionalFromGuards<S, K>>
export function recordOf<S extends GuardsShape>(
	shape: S,
	optional: true,
): Guard<Readonly<{ [P in keyof S]?: FromGuards<S>[P] }>>

/**
 * Build a guard that accepts plain records matching a guard shape.
 *
 * @remarks
 * Three calling modes depending on the `optional` argument:
 * - **No `optional`** — all shape keys required; extra keys rejected.
 * - **`optional: K[]`** — the listed keys are optional; all others required.
 * - **`optional: true`** — every shape key is optional.
 *
 * Key presence is tested with `Object.hasOwn`, so a shape key satisfied only by
 * an inherited prototype member (`toString`, `constructor`, …) counts as absent.
 * A non-object / `null` / array input returns `false` rather than throwing. The
 * extra-key check only inspects `Object.keys` (string keys), so an extra
 * enumerable SYMBOL key is never rejected — intentional, for JSON fidelity, and
 * matches the compiled guard.
 *
 * @example
 * ```ts
 * const isUser = recordOf({ name: isString, age: isNumber })
 * isUser({ name: 'Ada', age: 36 }) // true
 * isUser({ name: 'Ada' })          // false — age missing
 *
 * const isPartial = recordOf({ name: isString, age: isNumber }, ['age'])
 * isPartial({ name: 'Ada' }) // true
 * ```
 */
export function recordOf<
	S extends GuardsShape,
	K extends ReadonlyArray<keyof S & string> | true | undefined,
>(
	shape: S,
	optional?: K,
): Guard<
	K extends true
		? Readonly<{ [P in keyof S]?: FromGuards<S>[P] }>
		: K extends ReadonlyArray<keyof S & string>
			? OptionalFromGuards<S, K>
			: FromGuards<S>
> {
	const allowed = new Set<string>()
	for (const key in shape) {
		if (Object.prototype.hasOwnProperty.call(shape, key)) {
			allowed.add(key)
		}
	}
	const optionalSet = new Set<string>(
		optional === true ? [...allowed] : isArray(optional) ? optional.map((key) => String(key)) : [],
	)

	return (
		value: unknown,
	): value is K extends true
		? Readonly<{ [P in keyof S]?: FromGuards<S>[P] }>
		: K extends ReadonlyArray<keyof S & string>
			? OptionalFromGuards<S, K>
			: FromGuards<S> => {
		if (!isRecord(value)) {
			return false
		}

		const outcome = attempt(() => {
			for (const key of Object.keys(value)) {
				if (!allowed.has(key)) {
					return false
				}
			}

			for (const key in shape) {
				if (!Object.prototype.hasOwnProperty.call(shape, key)) {
					continue
				}
				const present = Object.hasOwn(value, key)
				if (!optionalSet.has(key) && !present) {
					return false
				}
				if (present) {
					const guard = shape[key]
					if (!guard(value[key])) {
						return false
					}
				}
			}

			return true
		})
		return outcome.success && outcome.value
	}
}

/**
 * Build a guard that accepts any iterable whose every element satisfies
 * `elementGuard`.
 *
 * @example
 * ```ts
 * const isNumberIterable = iterableOf(isNumber)
 * isNumberIterable([1, 2, 3])       // true
 * isNumberIterable(new Set([1, 2])) // true
 * isNumberIterable([1, 'two'])      // false
 * ```
 */
export function iterableOf<T>(elementGuard: Guard<T>): Guard<Iterable<T>>
export function iterableOf(elementGuard: (value: unknown) => boolean): Guard<Iterable<unknown>>
export function iterableOf(elementGuard: (value: unknown) => boolean): Guard<Iterable<unknown>> {
	return (value: unknown): value is Iterable<unknown> => {
		if (!isIterable(value)) {
			return false
		}
		const outcome = attempt(() => {
			for (const entry of value) {
				if (!elementGuard(entry)) {
					return false
				}
			}
			return true
		})
		return outcome.success && outcome.value
	}
}

/**
 * Build a guard that accepts values that are own keys of the provided object.
 *
 * @remarks
 * Membership is tested with `Object.hasOwn`, so inherited prototype-chain keys
 * (`toString`, `constructor`, …) are rejected. An own property that shadows a
 * prototype name is accepted.
 *
 * @example
 * ```ts
 * const COLORS = { red: '#f00', green: '#0f0', blue: '#00f' } as const
 * const isColorKey = keyOf(COLORS)
 * isColorKey('red')      // true
 * isColorKey('purple')   // false
 * isColorKey('toString') // false — inherited, not an own key
 * ```
 */
export function keyOf<const O extends Readonly<Record<PropertyKey, unknown>>>(
	value: O,
): Guard<keyof O> {
	return (entry: unknown): entry is keyof O =>
		(isString(entry) || isSymbol(entry) || isNumber(entry)) && Object.hasOwn(value, entry)
}

/**
 * Build a new guard shape by keeping only the listed keys — the structural
 * equivalent of `Pick<T, K>`. Produces a shape for {@link recordOf}, not a guard.
 *
 * @example
 * ```ts
 * const full = { name: isString, age: isNumber, role: isString }
 * const isName = recordOf(pickOf(full, ['name']))
 * isName({ name: 'Ada' }) // true
 * ```
 */
export function pickOf<S extends GuardsShape, K extends ReadonlyArray<keyof S & string>>(
	shape: S,
	keys: K,
): Pick<S, K[number]> {
	// Honest typing: the accumulator IS the picked-shape type, so every write is
	// checked against `S[P]` — no `as` / `!` / `asserts`. The seed is a genuine
	// null-prototype empty object, filled before any read.
	const result: { [P in K[number]]: S[P] } = Object.create(null)
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(shape, key)) {
			result[key] = shape[key]
		}
	}
	return result
}

/**
 * Build a new guard shape by removing the listed keys — the structural
 * equivalent of `Omit<T, K>`. Produces a shape for {@link recordOf}, not a guard.
 *
 * @example
 * ```ts
 * const full = { name: isString, age: isNumber, role: isString }
 * const isPublic = recordOf(omitOf(full, ['role']))
 * isPublic({ name: 'Ada', age: 36 }) // true
 * ```
 */
export function omitOf<S extends GuardsShape, K extends ReadonlyArray<keyof S & string>>(
	shape: S,
	keys: K,
): Omit<S, K[number]> {
	const skipped = new Set<PropertyKey>()
	for (const key of keys) {
		skipped.add(key)
	}
	// Sound over-approximation: only kept keys are written, so the value
	// structurally satisfies `Omit<S, K[number]>`. Same honest typing as
	// `pickOf` — no `as` / `!` / `asserts`.
	const result: { [P in keyof S]: S[P] } = Object.create(null)
	for (const key in shape) {
		if (!Object.prototype.hasOwnProperty.call(shape, key)) {
			continue
		}
		if (!skipped.has(key)) {
			result[key] = shape[key]
		}
	}
	return result
}

/**
 * Combine two guards with logical AND — passes only when both pass.
 *
 * @remarks
 * Use {@link whereOf} when the right side refines an already-narrowed type; use
 * `andOf` to combine two independent guards.
 *
 * @example
 * ```ts
 * const isShortString = andOf(isString, isNonEmptyString)
 * ```
 */
export function andOf<A, B>(left: Guard<A>, right: Guard<B>): Guard<A & B>
export function andOf<T, U extends T>(left: Guard<T>, right: (value: T) => value is U): Guard<U>
export function andOf<T>(left: Guard<T>, right: (value: T) => boolean): Guard<T>
export function andOf(
	left: (value: unknown) => boolean,
	right: (value: unknown) => boolean,
): Guard<unknown>
export function andOf(
	left: (value: unknown) => boolean,
	right: (value: unknown) => boolean,
): Guard<unknown> {
	return (value: unknown): value is unknown => left(value) && right(value)
}

/**
 * Combine two guards with logical OR — passes when at least one passes. For more
 * than two variants prefer {@link unionOf}.
 *
 * @example
 * ```ts
 * const isStringOrNumber = orOf(isString, isNumber)
 * ```
 */
export function orOf<A, B>(left: Guard<A>, right: Guard<B>): Guard<A | B>
export function orOf(
	left: (value: unknown) => boolean,
	right: (value: unknown) => boolean,
): Guard<unknown>
export function orOf(
	left: (value: unknown) => boolean,
	right: (value: unknown) => boolean,
): Guard<unknown> {
	return (value: unknown): value is unknown => left(value) || right(value)
}

/**
 * Negate a guard or predicate — passes when `guard` returns `false`.
 *
 * @remarks
 * Typed as `Guard<unknown>` because `Exclude<unknown, T>` is not useful; use
 * {@link complementOf} when you need the narrowed `Exclude<TBase, TExcluded>`.
 *
 * @example
 * ```ts
 * const isNotNull = notOf(isNull)
 * ```
 */
export function notOf(guard: (value: unknown) => boolean): Guard<unknown> {
	return (value: unknown): value is unknown => !guard(value)
}

/**
 * Build a guard for `Exclude<TBase, TExcluded>` — accepts values that pass
 * `base` but not `excluded`.
 *
 * @example
 * ```ts
 * const isNonEmpty = complementOf(isString, isEmptyString)
 * isNonEmpty('hi') // true
 * isNonEmpty('')   // false
 * ```
 */
export function complementOf<TBase, TExcluded extends TBase>(
	base: Guard<TBase>,
	excluded: Guard<TExcluded> | ((value: TBase) => value is TExcluded),
): Guard<Exclude<TBase, TExcluded>> {
	return (value: unknown): value is Exclude<TBase, TExcluded> => {
		if (!base(value)) {
			return false
		}
		return !excluded(value)
	}
}

/**
 * Build a guard that accepts values matching at least one of the provided
 * guards — the variadic form of {@link orOf}.
 *
 * @example
 * ```ts
 * const isStringOrBoolean = unionOf(isString, isBoolean)
 * ```
 */
export function unionOf<const Gs extends ReadonlyArray<Guard<unknown>>>(
	...guards: Gs
): Guard<GuardType<Gs[number]>>
export function unionOf(...predicates: ReadonlyArray<(value: unknown) => boolean>): Guard<unknown>
export function unionOf(...guards: ReadonlyArray<(value: unknown) => boolean>): Guard<unknown> {
	return (value: unknown): value is unknown => guards.some((guard) => guard(value))
}

/**
 * Build a guard that accepts values matching ALL of the provided guards — the
 * variadic form of {@link andOf}.
 *
 * @example
 * ```ts
 * const isNonEmpty = intersectionOf(isString, isNonEmptyString)
 * ```
 */
export function intersectionOf<const Gs extends ReadonlyArray<Guard<unknown>>>(
	...guards: Gs
): Guard<IntersectionFromGuards<Gs>>
export function intersectionOf(
	...predicates: ReadonlyArray<(value: unknown) => boolean>
): Guard<unknown>
export function intersectionOf(
	...guards: ReadonlyArray<(value: unknown) => boolean>
): Guard<unknown> {
	return (value: unknown): value is unknown => guards.every((guard) => guard(value))
}

/**
 * Refine a base guard with an additional predicate that runs only when the base
 * passes.
 *
 * @remarks
 * The predicate receives a value already narrowed to `T`. When the predicate is
 * itself a type guard (`value is U`), the result narrows to `Guard<U>` — it
 * passes only when the value is genuinely a `U`, so the narrowing is sound. Per
 * §14 the returned guard never throws: if `predicate` throws, the throw is
 * contained and the guard reports a non-match.
 *
 * @example
 * ```ts
 * const isPositive = whereOf(isNumber, (n) => n > 0)
 * isPositive(5)  // true
 * isPositive(-1) // false
 *
 * // A narrowing predicate refines the result type to Guard<5>
 * const isFive = whereOf(isNumber, (n): n is 5 => n === 5)
 * ```
 */
export function whereOf<T, U extends T>(
	base: Guard<T>,
	predicate: (value: T) => value is U,
): Guard<U>
export function whereOf<T>(base: Guard<T>, predicate: (value: T) => boolean): Guard<T>
export function whereOf<T>(base: Guard<T>, predicate: (value: T) => boolean): Guard<T> {
	return (value: unknown): value is T => {
		if (!base(value)) {
			return false
		}
		// `predicate` is user-supplied with no never-throw contract; §14 forbids
		// the guard from propagating its throw.
		const outcome = attempt(() => predicate(value))
		return outcome.success && outcome.value
	}
}

/**
 * Defer guard creation until first use by calling `thunk()` on every
 * invocation.
 *
 * @remarks
 * `thunk` is called on every guard call, not cached — this lets it close over a
 * binding assigned *after* `lazyOf` is called, the primary use case for
 * self-referential recursive guards. Per §14 a throw from `thunk` (or the guard
 * it resolves to) is contained and reported as a non-match.
 *
 * A recursive guard built this way has no cycle/depth detection: a cyclic or
 * pathologically deep input is stack-bounded — the overflow is contained and the
 * guard returns `false` rather than throwing, but it is not validated correctly
 * past that bound.
 *
 * @example
 * ```ts
 * type Tree = { value: number; children: Tree[] }
 * let isTree: Guard<Tree>
 * isTree = recordOf({ value: isNumber, children: arrayOf(lazyOf(() => isTree)) })
 * ```
 */
export function lazyOf<T>(thunk: () => Guard<T>): Guard<T> {
	return (value: unknown): value is T => {
		// `thunk` and the guard it returns are user-supplied; §14 forbids
		// propagating either throw.
		const outcome = attempt(() => thunk()(value))
		return outcome.success && outcome.value
	}
}

/**
 * Build a guard that passes when the base passes AND the projection of the value
 * satisfies the target guard. Still narrows to `T` (the base type) — the target
 * check is a validity constraint on a derived view, not a type transformation.
 *
 * @remarks
 * `project` is a plain `(value: T) => U`. Per §14 the returned guard never
 * throws: a throw from `project` is contained and reported as a non-match.
 * `target` is itself a Guard (already §14-bound), so it stays outside the
 * contained region. (Unlike the reference implementation, there is no
 * "curried projector" branch — a projection that legitimately returns a function
 * would be double-invoked under that scheme. Compose explicitly if you need it.)
 *
 * @example
 * ```ts
 * const isBounded = transformOf(
 *   isString,
 *   (s) => s.trim().length,
 *   whereOf(isNumber, (n) => n >= 1 && n <= 50),
 * )
 * isBounded('hello') // true
 * isBounded('')      // false
 * ```
 */
export function transformOf<T, U>(
	base: Guard<T>,
	project: (value: T) => U,
	target: Guard<U>,
): Guard<T>
export function transformOf<T>(
	base: Guard<T>,
	project: (value: T) => unknown,
	target: (value: unknown) => boolean,
): Guard<T>
export function transformOf<T>(
	base: Guard<T>,
	project: (value: T) => unknown,
	target: (value: unknown) => boolean,
): Guard<T> {
	return (value: unknown): value is T => {
		if (!base(value)) {
			return false
		}
		// `project` is user-supplied with no never-throw contract; §14 forbids the
		// guard from propagating its throw.
		const outcome = attempt(() => project(value))
		return outcome.success && target(outcome.value)
	}
}

/**
 * Build a guard that accepts finite numbers within an inclusive `[min, max]`
 * range.
 *
 * @remarks
 * Refines {@link isFiniteNumber} with the bound comparison, so `NaN` /
 * `±Infinity` are rejected before any comparison runs. An absent bound never
 * constrains that side. Reused for a number's own value AND, applied to a
 * `.length`, for string and array length refinements — the single source of the
 * bound logic shared by the compiled guard and parser (compilers.ts).
 *
 * @example
 * ```ts
 * const inRange = boundsOf(1, 5)
 * inRange(3)  // true
 * inRange(0)  // false — below min
 * inRange(6)  // false — above max
 *
 * const atLeastTwo = boundsOf(2)
 * atLeastTwo(2) // true — unbounded above
 * ```
 */
export function boundsOf(min?: number, max?: number): Guard<number> {
	return whereOf(
		isFiniteNumber,
		(value) => (min === undefined || value >= min) && (max === undefined || value <= max),
	)
}

/**
 * Build a guard that accepts strings matching a regular expression.
 *
 * @example
 * ```ts
 * const isHex = matchOf(/^[0-9a-f]+$/)
 * isHex('1a2f') // true
 * isHex('xyz')  // false
 * ```
 */
export function matchOf(pattern: RegExp): Guard<string> {
	return whereOf(isString, (value) => pattern.test(value))
}

/**
 * Build a guard that accepts strings satisfying optional length and pattern
 * refinements — `min` / `max` length and a `pattern`.
 *
 * @remarks
 * Composes {@link isString} with {@link boundsOf} on the string's `.length` and
 * an inline `pattern.test` (the same refinement {@link matchOf} performs). When all three options are absent it returns
 * the bare {@link isString} guard (the unconstrained fast path), so an
 * unrefined string leaf pays no wrapping cost. The single source of the string
 * refinement shared by the compiled guard and parser (compilers.ts).
 *
 * @example
 * ```ts
 * const isSlug = stringOf({ min: 1, max: 32, pattern: /^[a-z-]+$/ })
 * isSlug('hello-world') // true
 * isSlug('')            // false — below min
 * isSlug('Hello')       // false — pattern miss
 *
 * stringOf() // identical to isString
 * ```
 */
export function stringOf(options?: {
	min?: number
	max?: number
	pattern?: RegExp
}): Guard<string> {
	const min = options?.min
	const max = options?.max
	const pattern = options?.pattern
	if (min === undefined && max === undefined && pattern === undefined) {
		return isString
	}
	const withinLength = boundsOf(min, max)
	return whereOf(
		isString,
		(value) => withinLength(value.length) && (pattern === undefined || pattern.test(value)),
	)
}

/**
 * Extend a guard to also allow `null`.
 *
 * @example
 * ```ts
 * const isNullableString = nullableOf(isString)
 * isNullableString('hi') // true
 * isNullableString(null) // true
 * isNullableString(42)   // false
 * ```
 */
export function nullableOf<T>(guard: Guard<T>): Guard<T | null> {
	return (value: unknown): value is T | null => value === null || guard(value)
}

/**
 * Extend a guard to also allow `undefined` — the optional counterpart of
 * {@link nullableOf}.
 *
 * @example
 * ```ts
 * const isOptionalString = optionalOf(isString)
 * isOptionalString('hi')        // true
 * isOptionalString(undefined)   // true
 * isOptionalString(null)        // false
 * ```
 */
export function optionalOf<T>(guard: Guard<T>): Guard<T | undefined> {
	return (value: unknown): value is T | undefined => value === undefined || guard(value)
}
