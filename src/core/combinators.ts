import type {
	FromGuards,
	Guard,
	GuardsShape,
	GuardType,
	IntersectionFromGuards,
	LiteralValue,
	OptionalFromGuards,
	StringGuardOptions,
	TupleFromGuards,
} from './types.js'
import { GUARD_DEPTH_LIMIT, INTRINSICS } from './constants.js'
import { ContractError } from './errors.js'
import {
	isArray,
	isConstructor,
	isFiniteNumber,
	isFunction,
	isInstance,
	isLiteralValue,
	isMap,
	isNumber,
	isObject,
	isRecord,
	isRegExp,
	isSet,
	isString,
	isSymbol,
} from './validators.js'
import {
	collectMembers,
	contain,
	holds,
	matchesMember,
	matchesPattern,
	readArrayEntries,
	readGuardShape,
	readMapEntries,
	readOptions,
	readPattern,
	readSetEntries,
	readValue,
} from './helpers.js'

// Every combinator returns a `Guard<T>` — a total function (AGENTS §14). The
// combinators that invoke a caller-supplied callback inside the guard body
// contain the whole call via `holds`, so
// the produced guard reports a non-match instead of propagating. The container
// combinators likewise wrap their complete element/entry/key-read walk in
// `holds` — a hostile Proxy trap, a throwing getter, a throwing
// iterator, or a throwing caller-supplied predicate yields a non-match, never a
// propagated throw.

/**
 * Build a guard that accepts DENSE arrays whose every element satisfies
 * `elementGuard`.
 *
 * @remarks
 * Density is part of the contract, not an accident: the guard reads the array
 * through the shared reflected own-index lens {@link readArrayEntries}, which is
 * what makes it immune to caller-defined iteration and what `parseArray` reads
 * too. A SPARSE array is therefore refused outright — `[1, , 3]` fails even when
 * the element guard accepts `undefined` — because a hole is an absent own
 * property rather than a present `undefined`, and the two are different facts.
 * Pass `[1, undefined, 3]` when the middle slot is meant to exist.
 *
 * @param elementGuard - The guard each element must satisfy
 * @returns A guard accepting a dense array whose every element is accepted
 *
 * @example
 * ```ts
 * const isStringArray = arrayOf(isString)
 * isStringArray(['a', 'b']) // true
 * isStringArray(['a', 1])   // false
 * isStringArray(['a', , 'b']) // false — sparse
 * ```
 */
export function arrayOf<T>(elementGuard: Guard<T>): Guard<readonly T[]>
export function arrayOf(elementGuard: (value: unknown) => boolean): Guard<readonly unknown[]>
export function arrayOf(elementGuard: (value: unknown) => boolean): Guard<readonly unknown[]> {
	return (value: unknown): value is readonly unknown[] =>
		holds(() => {
			if (!isArray(value)) return false
			const entries = readArrayEntries(value)
			if (!entries.success || !entries.value.dense) return false
			for (let index = 0; index < entries.value.entries.length; index += 1) {
				if (!elementGuard(entries.value.entries[index])) return false
			}
			return true
		})
}

/**
 * Build a guard that accepts fixed-arity DENSE tuples, testing each index with
 * the corresponding guard.
 *
 * @param guards - One guard per tuple index, in declaration order
 * @returns A guard accepting a dense tuple of that exact arity whose every index is accepted
 *
 * @example
 * ```ts
 * const isPair = tupleOf(isString, isNumber)
 * isPair(['hello', 42]) // true
 * isPair(['hello'])     // false — wrong arity
 * isPair([, 42])        // false — sparse; see arrayOf for the dense lens
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
	return (value: unknown): value is readonly unknown[] =>
		holds(() => {
			if (!isArray(value)) {
				return false
			}
			const entries = readArrayEntries(value)
			if (!entries.success || !entries.value.dense) {
				return false
			}
			if (entries.value.entries.length !== guards.length) {
				return false
			}
			for (let index = 0; index < guards.length; index += 1) {
				const guard = guards[index]
				if (guard === undefined || !guard(entries.value.entries[index])) {
					return false
				}
			}
			return true
		})
}

/**
 * Build a guard that accepts a provided literal primitive using SameValueZero
 * comparison.
 *
 * @remarks
 * Signed zero compares equal, while `NaN` compares equal to `NaN`. Two call
 * forms, one meaning: list the literals inline, or hand in one array of them.
 * The array form exists for a vocabulary that is machine-generated rather than
 * hand-written — a `literalShape` built from an untrusted schema's `enum`, say
 * — where spreading a list of tens of thousands of entries would exhaust the
 * engine's argument limit. `compileGuard` / `compileParser` / `compileReporter`
 * take the array form for exactly that reason.
 *
 * @param literals - The permitted literal primitives, listed inline or as one array
 * @returns A guard narrowing to the provided literal union
 *
 * @example
 * ```ts
 * const isRole = literalOf('admin', 'member', 'guest')
 * isRole('admin') // true
 * isRole('owner') // false
 *
 * const isSameRole = literalOf(['admin', 'member', 'guest']) // the same guard, from an array
 * ```
 */
export function literalOf<const Literals extends readonly LiteralValue[]>(
	literals: Literals,
): Guard<Literals[number]>
export function literalOf<const Literals extends readonly LiteralValue[]>(
	...literals: Literals
): Guard<Literals[number]>
export function literalOf(
	...literals: ReadonlyArray<LiteralValue | readonly LiteralValue[]>
): Guard<LiteralValue> {
	return contain(
		() => {
			// An indexed read, not array destructuring: destructuring dispatches through
			// `Array.prototype[Symbol.iterator]`, a caller-writable member.
			const first = literals[0]
			const collected =
				literals.length === 1
					? readValue(() => INTRINSICS.array(first), 'literalOf', {
							subject: 'literals',
							context: { path: ['literals'], shape: 'literal' },
						})
					: false
			const snapshot =
				collected && isArray(first)
					? readValue(
							() => {
								const entries = readArrayEntries(first)
								if (!entries.success) throw entries.error
								if (!entries.value.dense) {
									throw new INTRINSICS.error('Literal vocabulary must be dense')
								}
								return entries.value.entries
							},
							'literalOf',
							{
								subject: 'literals',
								context: { path: ['literals'], shape: 'literal' },
							},
						)
					: literals
			// Indexed, not `every`: an array prototype method is a caller-writable
			// member reached by name, and this statement sits between two statements an
			// earlier round repaired for exactly that reason. A boundary placed per
			// statement is only ever as complete as the last sweep; an indexed read
			// dispatches through nothing at all.
			let literal = true
			for (let index = 0; index < snapshot.length; index += 1) {
				if (!isLiteralValue(snapshot[index])) literal = false
			}
			if (!literal) {
				throw new ContractError(
					'literalOf: literals must contain only string, number, or boolean values',
					{
						code: 'literal',
						context: { path: ['literals'], shape: 'literal' },
					},
				)
			}
			// A module-scope membership question, not `set.has(value)` and not a
			// method on a class this package exports: the answer this guard returns IS
			// the package's published verdict, and BOTH of those spellings ask a
			// property every caller can rewrite. `Set.prototype.has = () => true` made
			// this guard accept a value outside its declared vocabulary; relocating
			// the read onto an exported class's `has` reproduced it one prototype
			// higher. A module binding is not a property.
			const allowed = collectMembers(snapshot)
			return (value: unknown): value is LiteralValue => holds(() => matchesMember(allowed, value))
		},
		'literalOf',
		{ code: 'literal', context: { path: ['literals'], shape: 'literal' } },
	)
}

/**
 * Build a guard that accepts instances of the provided constructor.
 *
 * @remarks
 * Verifies that `ctor` is a real constructor (via {@link isConstructor}) first,
 * so passing an arrow function does not silently produce a broken guard.
 *
 * @param ctor - The constructor whose instances the guard accepts
 * @returns A guard narrowing to that constructor's instance type
 *
 * @example
 * ```ts
 * const isDateValue = instanceOf(Date)
 * isDateValue(new Date()) // true
 * isDateValue({})         // false
 * ```
 */
export function instanceOf<C extends abstract new (...args: never) => object>(
	ctor: C,
): Guard<InstanceType<C>> {
	// No `isObject` pre-filter: `typeof fn === 'function'`, so it rejected every
	// CALLABLE instance and `instanceOf(Function)(() => {})` answered `false`
	// while `isInstance(() => {}, Function)` — the helper this combinator is
	// documented to be built on — answered `true`. `isInstance` already refuses a
	// primitive (`primitive instanceof X` is `false`) and is itself contained, so
	// the pre-filter narrowed the domain and bought nothing.
	return (value: unknown): value is InstanceType<C> =>
		isConstructor(ctor) && isInstance(value, ctor)
}

/**
 * Build a guard from a native `enum` or any object whose values are strings or
 * numbers.
 *
 * @param enumeration - The readable enumeration whose values the guard accepts
 * @returns A guard accepting one enumeration value
 * @throws {ContractError} When the enumeration cannot be read
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
	return contain(() => {
		const values = collectMembers(
			readValue(() => INTRINSICS.values(enumeration), 'enumOf', { subject: 'enumeration' }),
		)
		// `holds`, exactly as `literalOf` does one screen up. The membership read is
		// now unredirectable, but the guard contract is "never throws" and a guard
		// that states it for one builder and not its sibling is a guard nobody can
		// rely on.
		return (value: unknown): value is E[keyof E] =>
			holds(() => (isString(value) || isNumber(value)) && matchesMember(values, value))
	}, 'enumOf')
}

/**
 * Build a guard that accepts `Set` instances whose every element satisfies
 * `elementGuard`.
 *
 * @param elementGuard - The guard each element must satisfy
 * @returns A guard accepting a `Set` whose every element is accepted
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
	return (value: unknown): value is ReadonlySet<unknown> =>
		holds(() => {
			if (!isSet(value)) {
				return false
			}
			// The genuine contents, read through the captured sweep rather than
			// through `Set.prototype[Symbol.iterator]`. An iterator that silently
			// skipped the non-string in `new Set(['a', 42])` made this guard answer
			// `true` while `forEach` and `size` still reported the real contents — the
			// guard's verdict and every other view of the same object disagreeing is
			// exactly the silent lie the sibling `arrayOf` was already hardened against.
			const entries = readSetEntries(value)
			if (!entries.success) return false
			for (let index = 0; index < entries.value.length; index += 1) {
				if (!elementGuard(entries.value[index])) {
					return false
				}
			}
			return true
		})
}

/**
 * Build a guard that accepts `Map` instances where every key satisfies
 * `keyGuard` and every value satisfies `valueGuard`.
 *
 * @param keyGuard - The guard each key must satisfy
 * @param valueGuard - The guard each value must satisfy
 * @returns A guard accepting a `Map` whose every entry is accepted
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
	return (value: unknown): value is ReadonlyMap<unknown, unknown> =>
		holds(() => {
			if (!isMap(value)) {
				return false
			}
			// The captured sweep, and each pair read POSITIONALLY: destructuring
			// `[key, entryValue]` adds `Array.prototype[Symbol.iterator]` to the
			// `Map.prototype[Symbol.iterator]` this already avoided, and a
			// substituting iterator can replace one half of a pair while every
			// downstream check still passes.
			const entries = readMapEntries(value)
			if (!entries.success) return false
			for (let index = 0; index < entries.value.length; index += 1) {
				const entry = entries.value[index]
				if (entry === undefined) return false
				if (!keyGuard(entry[0]) || !valueGuard(entry[1])) {
					return false
				}
			}
			return true
		})
}

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
 * A non-object / `null` / array input returns `false` rather than throwing.
 * The exactness check inspects every own string key, including non-enumerable
 * keys. Symbol keys are ignored intentionally for JSON fidelity.
 *
 * @param shape - The guard shape whose own string keys the record must satisfy
 * @param optional - The optional-key list, `true` for every key, or absent for none
 * @returns A guard accepting a record satisfying the shape under the selected mode
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
export function recordOf<S extends GuardsShape>(shape: S): Guard<FromGuards<S>>
export function recordOf<S extends GuardsShape, K extends ReadonlyArray<keyof S & string>>(
	shape: S,
	optional: K,
): Guard<OptionalFromGuards<S, K>>
export function recordOf<S extends GuardsShape>(
	shape: S,
	optional: true,
): Guard<Readonly<{ [P in keyof S]?: FromGuards<S>[P] }>>
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
	return contain(() => {
		const declared = readGuardShape(shape, optional, 'recordOf')

		return (
			value: unknown,
		): value is K extends true
			? Readonly<{ [P in keyof S]?: FromGuards<S>[P] }>
			: K extends ReadonlyArray<keyof S & string>
				? OptionalFromGuards<S, K>
				: FromGuards<S> =>
			holds(() => {
				if (!isRecord(value)) {
					return false
				}
				const members = INTRINSICS.reflect.members(value)
				for (let index = 0; index < members.length; index += 1) {
					const key = members[index]
					if (isString(key) && !matchesMember(declared.vocabulary, key)) {
						return false
					}
				}

				for (let index = 0; index < declared.names.length; index += 1) {
					const key = declared.names[index]
					if (key === undefined) continue
					const guard = declared.guards[key]
					const present = INTRINSICS.own(value, key)
					if (!matchesMember(declared.optional, key) && !present) {
						return false
					}
					if (present) {
						if (guard === undefined || !guard(value[key])) {
							return false
						}
					}
				}

				return true
			})
	}, 'recordOf')
}

/**
 * Build a guard that accepts non-array objects matching an open guard shape.
 *
 * @remarks
 * Three calling modes mirror {@link recordOf}:
 * - **No `optional`** — all shape keys required; unknown members admitted.
 * - **`optional: K[]`** — the listed keys are optional; all others required.
 * - **`optional: true`** — every shape key is optional.
 *
 * Each declared member is read through `Reflect.get`, so inherited data and
 * prototype accessors can satisfy the shape. An optional member passes when its
 * read value is `undefined`; otherwise its guard must accept the value. Unknown
 * members are never enumerated or inspected. Member-carrying functions are
 * accepted. Arrays, `null`, and primitives are rejected. Hostile reads return
 * `false` rather than throwing.
 *
 * @param shape - The guard shape whose declared members the object must satisfy
 * @param optional - The optional-key list, `true` for every key, or absent for none
 * @returns A guard accepting an object satisfying the shape under the selected mode
 *
 * @example
 * ```ts
 * const isResult = objectOf({ conclusion: isBoolean })
 * isResult({ conclusion: true, metadata: 'retained' }) // true
 * isResult([]) // false
 * ```
 */
export function objectOf<S extends GuardsShape>(shape: S): Guard<FromGuards<S>>
export function objectOf<S extends GuardsShape, K extends ReadonlyArray<keyof S & string>>(
	shape: S,
	optional: K,
): Guard<OptionalFromGuards<S, K>>
export function objectOf<S extends GuardsShape>(
	shape: S,
	optional: true,
): Guard<Readonly<{ [P in keyof S]?: FromGuards<S>[P] }>>
export function objectOf<
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
	return contain(() => {
		const declared = readGuardShape(shape, optional, 'objectOf')

		return (
			value: unknown,
		): value is K extends true
			? Readonly<{ [P in keyof S]?: FromGuards<S>[P] }>
			: K extends ReadonlyArray<keyof S & string>
				? OptionalFromGuards<S, K>
				: FromGuards<S> =>
			holds(() => {
				if ((!isObject(value) && !isFunction(value)) || INTRINSICS.array(value)) {
					return false
				}

				for (let index = 0; index < declared.names.length; index += 1) {
					const key = declared.names[index]
					if (key === undefined) continue
					const guard = declared.guards[key]
					const member = INTRINSICS.reflect.read(value, key)
					if (matchesMember(declared.optional, key)) {
						if (member !== undefined && (guard === undefined || !guard(member))) {
							return false
						}
					} else if (guard === undefined || !guard(member)) {
						return false
					}
				}

				return true
			})
	}, 'objectOf')
}

/**
 * Build a guard that accepts values that are own keys of the provided object.
 *
 * @remarks
 * Membership is tested with `Object.hasOwn`, so inherited prototype-chain keys
 * (`toString`, `constructor`, …) are rejected. An own property that shadows a
 * prototype name is accepted.
 *
 * @param value - The object whose own keys the guard accepts
 * @returns A guard narrowing to that object's own key union
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
	return contain(() => {
		const keys = collectMembers(readValue(() => INTRINSICS.reflect.members(value), 'keyOf'))
		return (entry: unknown): entry is keyof O =>
			holds(
				() =>
					(isString(entry) && matchesMember(keys, entry)) ||
					(isSymbol(entry) && matchesMember(keys, entry)) ||
					(isNumber(entry) && matchesMember(keys, INTRINSICS.text(entry))),
			)
	}, 'keyOf')
}

/**
 * Build a new guard shape by keeping only the listed keys — the structural
 * equivalent of `Pick<T, K>`. Produces a shape for {@link recordOf}, not a guard.
 *
 * @param shape - The guard shape to narrow
 * @param keys - The keys to keep
 * @returns A guard shape carrying only the kept keys
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
	return contain(() => {
		// Sound over-approximation: only selected keys are defined on the genuine
		// null-prototype accumulator; its mapped value slots remain checked against S.
		const selected = readValue(
			() => {
				const entries = readArrayEntries(keys)
				if (!entries.success) throw entries.error
				if (!entries.value.dense) throw new INTRINSICS.error('Picked key list must be dense')
				return collectMembers(entries.value.entries)
			},
			'pickOf',
			{ subject: 'keys' },
		)
		return readValue(
			() => {
				const result: { [P in keyof S]: S[P] } = INTRINSICS.create(null)
				const members = INTRINSICS.reflect.members(shape)
				for (let index = 0; index < members.length; index += 1) {
					const key = members[index]
					if (isString(key) && matchesMember(selected, key)) {
						INTRINSICS.define(result, key, {
							value: shape[key],
							enumerable: true,
							configurable: true,
							writable: true,
						})
					}
				}
				return result
			},
			'pickOf',
			{ subject: 'shape' },
		)
	}, 'pickOf')
}

/**
 * Build a new guard shape by removing the listed keys — the structural
 * equivalent of `Omit<T, K>`. Produces a shape for {@link recordOf}, not a guard.
 *
 * @param shape - The guard shape to narrow
 * @param keys - The keys to remove
 * @returns A guard shape carrying every key except the removed ones
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
	return contain(() => {
		const skipped = readValue(
			() => {
				const entries = readArrayEntries(keys)
				if (!entries.success) throw entries.error
				if (!entries.value.dense) throw new INTRINSICS.error('Omitted key list must be dense')
				return collectMembers(entries.value.entries)
			},
			'omitOf',
			{ subject: 'keys' },
		)
		// Sound over-approximation: only kept keys are written, so the value
		// structurally satisfies `Omit<S, K[number]>`. Same honest typing as
		// `pickOf` — no `as` / `!` / `asserts`.
		return readValue(
			() => {
				const result: { [P in keyof S]: S[P] } = INTRINSICS.create(null)
				const members = INTRINSICS.reflect.members(shape)
				for (let index = 0; index < members.length; index += 1) {
					const key = members[index]
					if (isString(key) && !matchesMember(skipped, key)) {
						INTRINSICS.define(result, key, {
							value: shape[key],
							enumerable: true,
							configurable: true,
							writable: true,
						})
					}
				}
				return result
			},
			'omitOf',
			{ subject: 'shape' },
		)
	}, 'omitOf')
}

/**
 * Combine two guards with logical AND — passes only when both pass.
 *
 * @remarks
 * Use {@link whereOf} when the right side refines an already-narrowed type; use
 * `andOf` to combine two independent guards.
 *
 * @param left - The guard tested first
 * @param right - The guard tested only after `left` passes
 * @returns A guard accepting a value both accept
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
	return (value: unknown): value is unknown => holds(() => left(value) && right(value))
}

/**
 * Combine two guards with logical OR — passes when at least one passes. For more
 * than two variants prefer {@link unionOf}.
 *
 * @param left - The guard tested first
 * @param right - The guard tested only after `left` fails
 * @returns A guard accepting a value either accepts
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
	// Each member is contained SEPARATELY. One `holds` around the whole
	// disjunction let a throwing member veto every later passing one, so
	// `orOf(isNull, naive)(null)` was `true` and `orOf(naive, isNull)(null)` was
	// `false` — the same disjunction, the same value, two answers. Disjunction is
	// commutative by definition, and the package's own doctrine everywhere else
	// is that a throw is contained as a NON-MATCH, not as a veto over siblings.
	return (value: unknown): value is unknown => holds(() => left(value)) || holds(() => right(value))
}

/**
 * Negate a guard or predicate — passes when `guard` returns `false`.
 *
 * @remarks
 * Typed as `Guard<unknown>` because `Exclude<unknown, T>` is not useful; use
 * {@link complementOf} when you need the narrowed `Exclude<TBase, TExcluded>`.
 *
 * @param guard - The guard or predicate to negate
 * @returns A guard accepting exactly the values `guard` rejects
 *
 * @example
 * ```ts
 * const isNotNull = notOf(isNull)
 * ```
 */
export function notOf(guard: (value: unknown) => boolean): Guard<unknown> {
	// The negation is applied to the CONTAINED verdict, not contained around the
	// negation. `holds(() => !guard(value))` never evaluated `!` when the guard
	// threw, so a guard and its negation both reported a non-match for the same
	// value and `orOf(g, notOf(g))` stopped being a tautology.
	return (value: unknown): value is unknown => !holds(() => guard(value))
}

/**
 * Build a guard for `Exclude<TBase, TExcluded>` — accepts values that pass
 * `base` but not `excluded`.
 *
 * @param base - The guard establishing the accepted domain
 * @param excluded - The guard whose accepted values are removed from that domain
 * @returns A guard accepting a value `base` accepts and `excluded` rejects
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
	// Two separate containments, for the reason `notOf` carries: a throwing
	// EXCLUSION is a non-match, so the complement must PASS when the base passes.
	// One containment around `base(value) && !excluded(value)` made a value fail
	// both a guard and its complement.
	return (value: unknown): value is Exclude<TBase, TExcluded> =>
		holds(() => {
			if (!base(value)) return false
			const accepted = value
			return !holds(() => excluded(accepted))
		})
}

/**
 * Build a guard that accepts values matching at least one of the provided
 * guards — the variadic form of {@link orOf}.
 *
 * @param guards - The guards tried in order
 * @returns A guard accepting a value at least one guard accepts
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
	// Per-member containment, exactly as its declared twin `orOf`: one `holds`
	// around the whole loop made a throwing member erase every later passing one,
	// so `unionOf(a, b)` and `unionOf(b, a)` answered differently for one value.
	return (value: unknown): value is unknown => {
		for (let index = 0; index < guards.length; index += 1) {
			const guard = guards[index]
			if (guard !== undefined && holds(() => guard(value))) return true
		}
		return false
	}
}

/**
 * Build a guard that accepts values matching ALL of the provided guards — the
 * variadic form of {@link andOf}.
 *
 * @param guards - The guards every accepted value must satisfy
 * @returns A guard accepting a value every guard accepts
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
	return (value: unknown): value is unknown =>
		holds(() => {
			// Indexed, exactly as its declared twin `unionOf` twelve lines up. The
			// ruling forbidding `Array.prototype.every` here was already stated 528
			// lines earlier in this same file and applied to `literalOf`, and this
			// statement was missed by the sweep that wrote it: `every` answering
			// `true` for everything made this guard accept a value no constituent
			// guard admits.
			for (let index = 0; index < guards.length; index += 1) {
				const guard = guards[index]
				if (guard === undefined || !guard(value)) return false
			}
			return true
		})
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
 * @param base - The guard establishing the accepted domain
 * @param predicate - The refinement run only after `base` passes
 * @returns A guard accepting a value `base` accepts and the refinement admits
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
	return (value: unknown): value is T => holds(() => base(value) && predicate(value))
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
 * Each lazy guard tracks its active invocation depth. An invocation that would
 * exceed {@link GUARD_DEPTH_LIMIT} returns `false` before resolving `thunk`; the
 * counter always unwinds after the contained call, so one deep or cyclic input
 * cannot poison later guard calls.
 *
 * @param thunk - The factory producing the guard to apply, called on every invocation
 * @returns A guard deferring each call to the thunk's guard
 *
 * @example
 * ```ts
 * type Tree = { value: number; children: Tree[] }
 * let isTree: Guard<Tree>
 * isTree = recordOf({ value: isNumber, children: arrayOf(lazyOf(() => isTree)) })
 * ```
 */
export function lazyOf<T>(thunk: () => Guard<T>): Guard<T> {
	let depth = 0
	return (value: unknown): value is T => {
		if (depth >= GUARD_DEPTH_LIMIT) return false
		depth += 1
		try {
			return holds(() => thunk()(value))
		} finally {
			depth -= 1
		}
	}
}

/**
 * Build a guard that passes when the base passes AND the projection of the value
 * satisfies the target guard. Still narrows to `T` (the base type) — the target
 * check is a validity constraint on a derived view, not a type transformation.
 *
 * @remarks
 * `project` is a plain `(value: T) => U`. Per §14 the returned guard never
 * throws: a throw from `project` or `target` is contained and reported as a
 * non-match. (Unlike the reference implementation, there is no
 * "curried projector" branch — a projection that legitimately returns a function
 * would be double-invoked under that scheme. Compose explicitly if you need it.)
 *
 * @param base - The guard establishing the accepted domain
 * @param project - The projection applied to a value `base` accepted
 * @param target - The guard the projection's result must satisfy
 * @returns A guard narrowing to the base type, accepting only a value whose projection satisfies `target`
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
	return (value: unknown): value is T => holds(() => base(value) && target(project(value)))
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
 * @param min - The inclusive lower bound, absent for unbounded below
 * @param max - The inclusive upper bound, absent for unbounded above
 * @returns A guard accepting a finite number inside the bounds
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
 * @remarks
 * Clones the pattern for the guard and strips the stateful `g` / `y` flags, so
 * repeated checks are stable and never change the caller's `lastIndex`.
 *
 * @param pattern - The regular expression to own and apply
 * @returns A stateless string guard
 *
 * @example
 * ```ts
 * const isHex = matchOf(/^[0-9a-f]+$/)
 * isHex('1a2f') // true
 * isHex('xyz')  // false
 * ```
 */
export function matchOf(pattern: RegExp): Guard<string> {
	return contain(() => {
		if (!isRegExp(pattern)) {
			throw new ContractError('matchOf: pattern must be a RegExp', { code: 'pattern' })
		}
		const owned = readValue(() => readPattern(pattern), 'matchOf', {
			subject: 'pattern',
			code: 'pattern',
		})
		return whereOf(isString, (value) => matchesPattern(owned, value))
	}, 'matchOf')
}

/**
 * Build a guard that accepts strings satisfying optional length and pattern
 * refinements — `min` / `max` length and a `pattern`.
 *
 * @remarks
 * Composes {@link isString} with {@link boundsOf} on the string's `.length` and
 * an owned stateless pattern (the same refinement {@link matchOf} performs).
 * When all three options are absent it returns the bare {@link isString} guard
 * (the unconstrained fast path), so an unrefined string leaf pays no wrapping
 * cost. The single source of the string refinement shared by the compiled guard
 * and parser (compilers.ts).
 *
 * @param options - Optional length bounds and regular expression refinement
 * @returns A string guard enforcing the requested refinements
 * @throws {ContractError} When the options cannot be read
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
export function stringOf(options?: StringGuardOptions): Guard<string> {
	return contain(() => {
		const safe = readOptions(options, ['min', 'max', 'pattern'], 'stringOf', 'string')
		const min = safe?.min
		const max = safe?.max
		const source = safe?.pattern
		if (source !== undefined && !isRegExp(source)) {
			throw new ContractError('stringOf: pattern must be a RegExp', { code: 'pattern' })
		}
		const pattern =
			source === undefined
				? undefined
				: readValue(() => readPattern(source), 'stringOf', {
						subject: 'pattern',
						code: 'pattern',
						context: { shape: 'string' },
					})
		if (min === undefined && max === undefined && pattern === undefined) {
			return isString
		}
		const withinLength = boundsOf(min, max)
		return whereOf(
			isString,
			(value) =>
				withinLength(value.length) && (pattern === undefined || matchesPattern(pattern, value)),
		)
	}, 'stringOf')
}

/**
 * Extend a guard to also allow `null`.
 *
 * @param guard - The guard to extend
 * @returns A guard accepting `null` and every value `guard` accepts
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
	return (value: unknown): value is T | null => holds(() => value === null || guard(value))
}

/**
 * Extend a guard to also allow `undefined` — the optional counterpart of
 * {@link nullableOf}.
 *
 * @param guard - The guard to extend
 * @returns A guard accepting `undefined` and every value `guard` accepts
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
	return (value: unknown): value is T | undefined =>
		holds(() => value === undefined || guard(value))
}
