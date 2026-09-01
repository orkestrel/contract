import type {
	ArrayRead,
	ArrayShape,
	AuditFault,
	ContainOptions,
	ContractCode,
	ContractShape,
	Fault,
	FaultKind,
	FieldPath,
	Guard,
	GuardsShape,
	JSONSchema,
	JSONValue,
	NumberShape,
	RandomFunction,
	ReadValueOptions,
	Result,
	SampleMemo,
	StringShape,
} from './types.js'
import {
	COMPILE_NODE_LIMIT,
	GUARD_DEPTH_LIMIT,
	INFER_DEPTH_LIMIT,
	INTRINSICS,
	PREVIEW_LIMIT,
} from './constants.js'
import { ContractError, isContractError } from './errors.js'
import {
	isBigInt,
	isArray,
	isBoolean,
	isFiniteNumber,
	isMap,
	isNumber,
	isObject,
	isRecord,
	isString,
	isSymbol,
	isWeakMap,
} from './validators.js'

/**
 * Build a diagnostic path from an existing path and further segments, without
 * dispatching through array iteration.
 *
 * @remarks
 * `[...path, key]` reads well and dispatches through
 * `Array.prototype[Symbol.iterator]`, a member every caller can write — and the
 * damaging installation is not a thrower but a LIAR. An iterator yielding one
 * extra value before the array's real contents turns a refusal this package
 * authored into `path: ['INJECTED', 'properties', 'INJECTED']`, so the caller
 * writes their own text into a diagnostic this package published. An indexed
 * walk reads only own index properties of an array this package owns, and a
 * rest parameter collects its arguments without an iterator either, so nothing
 * on the path is caller-reachable.
 *
 * @param path - The path segments accumulated so far
 * @param segments - Further segments to append in order; an absent segment is
 *                   omitted, so an optional level needs no branch at the call site
 * @returns A fresh path carrying every existing segment and each new one
 *
 * @example
 * ```ts
 * pathOf(['properties'], 'age') // ['properties', 'age']
 * pathOf(path)                  // an owned copy
 * ```
 */
export function pathOf(
	path: readonly string[],
	...segments: ReadonlyArray<string | undefined>
): readonly string[] {
	const extended: string[] = []
	for (let index = 0; index < path.length; index += 1) {
		const existing = path[index]
		if (existing === undefined) continue
		extended[extended.length] = existing
	}
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index]
		if (segment === undefined) continue
		extended[extended.length] = segment
	}
	return extended
}

/**
 * Append every element of one array onto another, by index.
 *
 * @remarks
 * The sibling of {@link pathOf}, for the other shape the same defect takes.
 * `target[target.length] = ...source` and `[summary, ...rest]` both dispatch through
 * `Array.prototype[Symbol.iterator]`, and a caller-installed iterator that
 * yields one extra value writes the caller's text into a diagnostic this
 * package publishes as its own. Both operands here are arrays this package
 * built, and an indexed read of an own index property dispatches through
 * nothing.
 *
 * @param target - The array to extend in place
 * @param source - The elements to append, read by index
 *
 * @example
 * ```ts
 * appendEntries(faults, compileReporter(inner, raw, pathOf(path, key)))
 * ```
 */
export function appendEntries<T>(target: T[], source: readonly T[]): void {
	for (let index = 0; index < source.length; index += 1) {
		const entry = source[index]
		// A hole is skipped rather than materialized as a present `undefined`: the
		// arrays this appends are dense reports this package built, so the branch
		// exists to keep the honest typing rather than to hide a case.
		if (entry === undefined) continue
		target[target.length] = entry
	}
}

/**
 * Take at most `limit` leading elements of an array, by index.
 *
 * @remarks
 * `Array.prototype.slice` is a caller-writable member on every path that bounds
 * a published report, so a substitute decides how much of a diagnostic the
 * caller sees. Returns the input untouched when it already fits, so a bounded
 * report allocates nothing in the ordinary case.
 *
 * @param entries - The entries to bound
 * @param limit - The maximum number of leading entries to retain
 * @returns The input when it already fits, otherwise a fresh bounded copy
 *
 * @example
 * ```ts
 * limitEntries(faults, FAULT_LIMIT)
 * ```
 */
export function limitEntries<T>(entries: readonly T[], limit: number): readonly T[] {
	if (entries.length <= limit) return entries
	const bounded: T[] = []
	for (let index = 0; index < limit; index += 1) {
		const entry = entries[index]
		if (entry === undefined) continue
		bounded[bounded.length] = entry
	}
	return bounded
}

/**
 * Order two primitive keys or indices ascending.
 *
 * @remarks
 * The comparison {@link sortValues} hands to the captured sort, extracted rather
 * than written inline. `Reflect.apply` takes its arguments as a LIST, so an
 * inline comparator is a function expression inside an array literal rather than
 * one passed directly as an argument — a hidden function assignment, which this
 * repository forbids wherever it appears because a function that is not a named
 * declaration is a function no caller can reach and no test can exercise. As a
 * declaration it is both. The comparison is `<` / `>` on primitives, which
 * dispatches through nothing: no `valueOf`, no `toString`, and no member a
 * caller can replace, so the order a published schema is emitted in is decided
 * by the values and not by the environment.
 *
 * @param left - The value ordered first when it compares lower
 * @param right - The value compared against
 * @returns `-1`, `1`, or `0` as `left` sorts before, after, or with `right`
 *
 * @example
 * ```ts
 * compareValues('a', 'b') // -1
 * ```
 */
export function compareValues<T extends string | number>(left: T, right: T): number {
	return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Order primitive keys or indices deterministically, on an owned copy, through
 * the captured sort.
 *
 * @remarks
 * Every schema this package emits is ordered so the same input produces the
 * same bytes, and `Array.prototype.sort` is a caller-writable member on every
 * one of those paths: a substitute that empties its receiver made
 * `valueToSchema({ b: 1, a: 2 })` publish `{"type":"object","additionalProperties":false}`
 * — a successful answer with the caller's properties silently gone. The copy is
 * taken first so a caller-owned array is never reordered in place, and the order
 * is decided by {@link compareValues}, whose `<` / `>` comparison dispatches
 * through nothing.
 *
 * @param values - The keys or indices to order
 * @returns A fresh array in ascending order
 *
 * @example
 * ```ts
 * sortValues(['b', 'a']) // ['a', 'b']
 * ```
 */
export function sortValues<T extends string | number>(values: readonly T[]): readonly T[] {
	const owned: T[] = []
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index]
		if (value === undefined) continue
		owned[owned.length] = value
	}
	INTRINSICS.apply(INTRINSICS.order, owned, [compareValues])
	return owned
}

// === Captured membership, visitation, and pattern reads

/**
 * Collect an array's entries into a membership collection this package owns.
 *
 * @remarks
 * THE builder behind every declared vocabulary, and the first half of the answer
 * to a defect that survived three rounds by moving rather than closing. A guard
 * deciding membership with `set.has(value)` answers whatever the caller most
 * recently installed on `Set.prototype`, and answering it instead through the
 * `has` method of an exported class only moved the writable member one prototype
 * up: `Vocabulary.prototype.has = () => true` reproduced the whole defect at
 * nineteen door groups. There is no property lookup here to redirect —
 * membership is asked of a MODULE BINDING, which the specification makes
 * immutable to every importer, over operations {@link INTRINSICS} captured while
 * it evaluated.
 *
 * Collection is by INDEX rather than from an iterable on purpose:
 * `new Set(values)` reads `Symbol.iterator` off the argument and `add` off the
 * instance, so building from an iterable would reintroduce two replaceable
 * dispatches to remove one.
 *
 * @param values - The members to collect, read by index
 * @returns A collection no caller holds a reference to
 *
 * @example
 * ```ts
 * const allowed = collectMembers(['admin', 'guest'])
 * matchesMember(allowed, 'admin') // true
 * ```
 */
export function collectMembers(values: readonly unknown[]): Set<unknown> {
	const members = new INTRINSICS.set<unknown>()
	for (let index = 0; index < values.length; index += 1) {
		INTRINSICS.apply(INTRINSICS.admit, members, [values[index]])
	}
	return members
}

/**
 * Determine whether a value is a member of a collected vocabulary, by
 * SameValueZero.
 *
 * @param members - The vocabulary to ask, built by {@link collectMembers}
 * @param value - The value to test for membership
 * @returns `true` only when the value was collected
 *
 * @example
 * ```ts
 * matchesMember(collectMembers([Number.NaN]), Number.NaN) // true — SameValueZero
 * ```
 */
export function matchesMember(members: ReadonlySet<unknown>, value: unknown): boolean {
	return INTRINSICS.apply(INTRINSICS.member, members, [value]) === true
}

/**
 * Collect one more member into a vocabulary that grows as a walk proceeds.
 *
 * @param members - The vocabulary to extend
 * @param value - The value to admit
 *
 * @example
 * ```ts
 * const seen = collectMembers([])
 * admitMember(seen, 'a')
 * matchesMember(seen, 'a') // true
 * ```
 */
export function admitMember(members: Set<unknown>, value: unknown): void {
	INTRINSICS.apply(INTRINSICS.admit, members, [value])
}

/**
 * Determine whether an object is already on a traversal's active path.
 *
 * @remarks
 * The visitation half, and the one an earlier ruling wrongly excused as safe
 * because "a redirect corrupts it inside a boundary and the door refuses, which
 * is loud". It is not loud in the direction that matters:
 * `WeakSet.prototype.has` answering `false` does not make a cyclic clone refuse,
 * it removes the door's termination bound, and a door that never returns is the
 * one failure a containment boundary cannot report. Every walk's termination
 * therefore rests on a captured operation rather than on a caller-writable one.
 *
 * @param visited - The active-path set this traversal owns
 * @param value - The object to test
 * @returns `true` only when the object is already on the active path
 *
 * @example
 * ```ts
 * const active = new WeakSet<object>()
 * admitVisited(active, node)
 * matchesVisited(active, node) // true
 * ```
 */
export function matchesVisited(visited: WeakSet<object>, value: object): boolean {
	return INTRINSICS.apply(INTRINSICS.tracked, visited, [value]) === true
}

/**
 * Record an object as entered on a traversal's active path.
 *
 * @param visited - The active-path set this traversal owns
 * @param value - The object being entered
 *
 * @example
 * ```ts
 * admitVisited(active, node)
 * ```
 */
export function admitVisited(visited: WeakSet<object>, value: object): void {
	INTRINSICS.apply(INTRINSICS.track, visited, [value])
}

/**
 * Record an object as exited from a traversal's active path.
 *
 * @param visited - The active-path set this traversal owns
 * @param value - The object being exited
 *
 * @example
 * ```ts
 * omitVisited(active, node)
 * ```
 */
export function omitVisited(visited: WeakSet<object>, value: object): void {
	INTRINSICS.apply(INTRINSICS.untrack, visited, [value])
}

/**
 * Record one node's answer at one remaining-depth allowance in a shared memo.
 *
 * @remarks
 * A depth-bounded walk answers the same node differently depending on how much
 * allowance was left when it arrived, so each node keeps a `Map` of answers
 * inside one `WeakMap`. Written inline, the get-or-create ferried that map out
 * of the branch that built it through a `let`, three times over in
 * `inferArray`, `inferObject` and `schemaNodeToShape`. Written once it is one
 * statement per caller, and the captured `WeakMap`/`Map` members stay the only
 * ones all three dispatch through — a substituted `WeakMap.prototype.get` that
 * answered a decoy map would otherwise decide what a later call replays.
 *
 * @param memo - The per-node depth memo this walk owns
 * @param node - The source node the answer was computed for
 * @param depth - The remaining-depth allowance the answer was computed under
 * @param answer - The answer to record for that node at that allowance
 *
 * @example
 * ```ts
 * const memo = new WeakMap<object, Map<number, string>>()
 * retainDepth(memo, node, 8, 'answer')
 * memo.get(node)?.get(8) // 'answer'
 * ```
 */
export function retainDepth<T>(
	memo: WeakMap<object, Map<number, T>>,
	node: object,
	depth: number,
	answer: T,
): void {
	const known = INTRINSICS.apply(INTRINSICS.recall, memo, [node])
	const depths = known || new INTRINSICS.map<number, T>()
	if (!known) INTRINSICS.apply(INTRINSICS.retain, memo, [node, depths])
	INTRINSICS.apply(INTRINSICS.store, depths, [depth, answer])
}

/**
 * Build one empty {@link SampleMemo} node.
 *
 * @remarks
 * The root a multi-sample walk starts from and the node every further row
 * prefix is grown into, built from the CAPTURED `WeakMap` and `Map` so a
 * replaced global cannot decide what a published schema is served from. One
 * memo belongs to one walk: {@link samplesToSchema} builds it at the door, and
 * a direct caller of {@link inferSamples} / {@link inferRecordSamples} builds a
 * fresh one per call.
 *
 * @returns An empty memo node with no recorded rows and no recorded schemas
 *
 * @example
 * ```ts
 * inferRecordSamples([{ id: 1 }], 32, 256, true, false, false, buildSampleMemo())
 * ```
 */
export function buildSampleMemo(): SampleMemo {
	return { rows: new INTRINSICS.weakMap<object, SampleMemo>(), schemas: new INTRINSICS.map() }
}

/**
 * Check that a value really is a {@link SampleMemo} before a walk stores a
 * published schema in it.
 *
 * @remarks
 * The memo is the one argument position on `inferSamples` /
 * `inferRecordSamples` that reaches a `WeakMap` and a `Map` the caller
 * supplied, and both doors are reachable untyped from JavaScript. Without this
 * check a wrong value there failed inside the traversal and was published as
 * `samples could not be read` — a true refusal naming the wrong argument, the
 * defect class those doors were already corrected for twice. It refuses under
 * the memo's own name and its own path instead.
 *
 * @param memo - The candidate memo
 * @param reader - The door name the refusal is published under
 * @returns The same memo when it carries a real `rows` `WeakMap` and `schemas` `Map`
 * @throws {ContractError} When the memo is not a `SampleMemo`
 *
 * @example
 * ```ts
 * readSampleMemo(buildSampleMemo(), 'inferSamples') // the same memo
 * ```
 */
export function readSampleMemo(memo: SampleMemo, reader: string): SampleMemo {
	if (!isObject(memo) || !isWeakMap(memo.rows) || !isMap(memo.schemas)) {
		throw new ContractError(`${reader}: memo must be a sample memo`, {
			code: 'structure',
			context: { path: ['memo'], limit: 'SampleMemo', received: preview(memo) },
		})
	}
	return memo
}

/**
 * Build the collector a captured `forEach` sweep appends through.
 *
 * @remarks
 * Extracted rather than written inline for the same reason
 * {@link compareValues} is: `Reflect.apply` takes its arguments as a LIST, so an
 * inline collector is a function expression inside an array literal rather than
 * one passed directly as an argument — a hidden function assignment this
 * repository forbids wherever it appears. Returned directly from a factory it is
 * both named and testable. Both sweeps hand the callback `(value, key)`; a `Set`
 * passes its entry in both positions, so one collector serves both.
 *
 * @param target - The pair list to append each swept entry onto
 * @returns The collector a captured `forEach` invokes per entry
 *
 * @example
 * ```ts
 * const collected: unknown[][] = []
 * new Set(['a']).forEach(collectEntries(collected)) // [['a', 'a']]
 * ```
 */
export function collectEntries(target: unknown[][]): (value: unknown, key: unknown) => void {
	return (value: unknown, key: unknown) => {
		target[target.length] = [key, value]
	}
}

/**
 * Snapshot the genuine contents of a caller's `Set` without running an iterator.
 *
 * @remarks
 * `Set.prototype[Symbol.iterator]` is a caller-writable member, and every other
 * view of the same collection disagrees with a replaced one: an iterator that
 * silently skips the non-string in `new Set(['a', 42])` made `setOf(isString)`
 * answer `true` while `forEach` and `size` still reported the real contents. The
 * sibling `arrayOf` already read its caller's collection through captured
 * reflection, so the exclusion was not even self-consistent within one file.
 * `forEach` is the only complete view of `[[SetData]]` that runs no iterator, so
 * it is dispatched here from the captured table.
 *
 * @param value - The set whose genuine entries to snapshot
 * @returns A frozen entry snapshot, or a failure carrying the exact thrown value
 *
 * @example
 * ```ts
 * readSetEntries(new Set(['a', 42])) // { success: true, value: ['a', 42] }
 * ```
 */
export function readSetEntries(value: ReadonlySet<unknown>): Result<readonly unknown[]> {
	return attempt(() => {
		const collected: unknown[][] = []
		INTRINSICS.apply(INTRINSICS.sweep, value, [collectEntries(collected)])
		const entries: unknown[] = []
		for (let index = 0; index < collected.length; index += 1) {
			const pair = collected[index]
			if (pair === undefined) continue
			entries[entries.length] = pair[1]
		}
		return INTRINSICS.freeze(entries)
	})
}

/**
 * Snapshot the genuine entries of a caller's `Map` without running an iterator.
 *
 * @remarks
 * The `Map` half of {@link readSetEntries}, with one further replaceable
 * dispatch removed: destructuring `for (const [key, value] of map)` reads
 * `Map.prototype[Symbol.iterator]` AND `Array.prototype[Symbol.iterator]` for
 * every pair, so a substituting iterator could rename a key or replace a value
 * while every downstream structural check still passed. Each pair is read
 * positionally from a list this package built.
 *
 * @param value - The map whose genuine entries to snapshot
 * @returns A frozen `[key, value]` pair snapshot, or a failure carrying the exact thrown value
 *
 * @example
 * ```ts
 * readMapEntries(new Map([['a', 1]])) // { success: true, value: [['a', 1]] }
 * ```
 */
export function readMapEntries(
	value: ReadonlyMap<unknown, unknown>,
): Result<ReadonlyArray<readonly unknown[]>> {
	return attempt(() => {
		const collected: unknown[][] = []
		INTRINSICS.apply(INTRINSICS.pairs, value, [collectEntries(collected)])
		return INTRINSICS.freeze(collected)
	})
}

/**
 * Read a regular expression's source text through the captured accessor.
 *
 * @remarks
 * `RegExp.prototype.source` is an ACCESSOR on a shared prototype, so replacing
 * its getter changes what every pattern in the realm reports — not only the
 * caller's own. A getter answering `'.*'` made `compileSchema` publish
 * `pattern: ".*"` inside a frozen schema and made `isRegExp('x')` answer `true`.
 * Reading the descriptor per call, as an earlier round did, captures nothing:
 * capture is decided by WHEN the reference is taken.
 *
 * @param pattern - The candidate regular expression to read
 * @returns The pattern's source text, or `undefined` when it cannot be read as a string
 * @throws The exact value the captured accessor throws for a receiver that is not a pattern
 *
 * @example
 * ```ts
 * readPatternSource(/^a+$/) // '^a+$'
 * ```
 */
export function readPatternSource(pattern: unknown): string | undefined {
	const read = INTRINSICS.expression
	if (read === undefined) return undefined
	const source: unknown = INTRINSICS.apply(read, pattern, [])
	return isString(source) ? source : undefined
}

/**
 * Read a regular expression's flag text through the captured accessor.
 *
 * @param pattern - The candidate regular expression to read
 * @returns The pattern's flag text, or `undefined` when it cannot be read as a string
 * @throws The exact value the captured accessor throws for a receiver that is not a pattern
 *
 * @example
 * ```ts
 * readPatternFlags(/^a+$/giu) // 'giu'
 * ```
 */
export function readPatternFlags(pattern: unknown): string | undefined {
	const read = INTRINSICS.modifiers
	if (read === undefined) return undefined
	const flags: unknown = INTRINSICS.apply(read, pattern, [])
	return isString(flags) ? flags : undefined
}

/**
 * Determine whether a string is in the language of a pattern this package owns.
 *
 * @remarks
 * The pattern-membership answer, asked exactly as {@link matchesMember} asks the
 * literal one, and asked through `exec` rather than `test` on purpose:
 * `RegExp.prototype.test` is spec-defined in terms of `RegExpExec`, which
 * re-reads `exec` off the receiver, so even a CAPTURED `test` still answers
 * whatever the caller installed. Replacing either member decided what `matchOf`,
 * `stringOf`, `contract.is`, `contract.parse`, `audit`, `explain` and the format
 * inferers published — a wrong yes for a non-member and a wrong no for a member,
 * silently.
 *
 * @param pattern - The owned pattern to apply
 * @param value - The string to test
 * @returns `true` only when the pattern genuinely matches
 *
 * @example
 * ```ts
 * matchesPattern(/^[0-9a-f]+$/, '1a2f') // true
 * ```
 */
export function matchesPattern(pattern: RegExp, value: string): boolean {
	return INTRINSICS.apply(INTRINSICS.captures, pattern, [value]) !== null
}

/**
 * Rebuild a caller's regular expression as a stateless pattern this package
 * owns.
 *
 * @remarks
 * Strips the stateful `g` / `y` flags so repeated checks are stable and the
 * caller's `lastIndex` never moves. The strip is an INDEXED character filter
 * rather than `String.prototype.replaceAll`, which is itself a caller-writable
 * member: a substitute answering `'i'` made `matchOf(/^abc$/)` accept `'ABC'` —
 * the package building a case-insensitive pattern the developer never wrote.
 *
 * @param pattern - The caller's regular expression
 * @returns An owned, stateless equivalent
 * @throws The exact value thrown when the pattern's source or flags cannot be read
 *
 * @example
 * ```ts
 * readPattern(/^a+$/gy) // /^a+$/
 * ```
 */
export function readPattern(pattern: RegExp): RegExp {
	const source = readPatternSource(pattern)
	const flags = readPatternFlags(pattern)
	if (source === undefined || flags === undefined) {
		throw new INTRINSICS.error('Pattern source and flags could not be read')
	}
	let stateless = ''
	for (let index = 0; index < flags.length; index += 1) {
		const flag = flags[index]
		if (flag === undefined || flag === 'g' || flag === 'y') continue
		stateless += flag
	}
	return new INTRINSICS.pattern(source, stateless)
}

/**
 * Pin every own member of a class prototype as a non-configurable member —
 * non-writable too when it is a data property — and verify the pin took.
 *
 * @remarks
 * The other half of the structural answer. Membership answers moved off class
 * methods entirely, but a class this package EXPORTS still has methods its own
 * modules dispatch through — `cloneShape` reaches `ShapeCloner.prototype.clone`,
 * and one assignment there made `compileSchema` publish whatever the caller
 * chose while `compileSchema` itself was never touched. That is the same defect
 * as a replaced host member with the package's own name on it, so every exported
 * class pins its prototype while it is DEFINED.
 *
 * The qualification that phrase used to carry — "before any importer's code can
 * run" — was FALSE, in exactly the case {@link INTRINSICS} already states and
 * does not defend: ESM evaluates imports in source order, so a module that
 * evaluates before this package has already run. What is true is narrower and is
 * what the pin buys: no code that runs AFTER this class is defined can replace a
 * member on its prototype.
 *
 * Placement goes through the captured `Reflect.defineProperty`, which ANSWERS
 * instead of throwing, and the answer is then corroborated by reading the
 * descriptor back. Installing is not reading: a pin that silently did not happen
 * is indistinguishable from one that did until something asks, so this asks. The
 * residual is named rather than denied: an adversary who also answers the
 * verifying descriptor read defeats this, and that adversary already chose what
 * {@link INTRINSICS} captured.
 *
 * @param prototype - The class prototype to pin
 * @param owner - The class name used in the refusal
 * @throws {ContractError} When a member cannot be pinned or the pin cannot be verified
 *
 * @example
 * ```ts
 * class Widget { static { pinMembers(Widget.prototype, 'Widget') } }
 * ```
 */
export function pinMembers(prototype: object, owner: string): void {
	const members = INTRINSICS.members(prototype)
	for (let index = 0; index < members.length; index += 1) {
		const key = members[index]
		if (key === undefined) continue
		// An ACCESSOR is pinned by its configurability alone. `writable` belongs to
		// a data property, and asking for it on a getter REPLACES the accessor with
		// a data property holding `undefined` — a pin that silently deletes the
		// member it was protecting, which is the failure mode this whole helper
		// exists to make impossible.
		const declared = INTRINSICS.describe(prototype, key)
		const accessor = declared !== undefined && !INTRINSICS.own(declared, 'value')
		INTRINSICS.declare(
			prototype,
			key,
			accessor ? { configurable: false } : { writable: false, configurable: false },
		)
		const pinned = INTRINSICS.describe(prototype, key)
		if (pinned?.configurable !== false || (!accessor && pinned.writable !== false)) {
			throw new ContractError(`${owner}: a prototype member could not be pinned`, {
				code: 'structure',
				context: { shape: owner, received: preview(key) },
			})
		}
	}
}

// === Result helpers

/**
 * Invoke a callback once and synchronously capture its exact outcome as a
 * {@link Result}.
 *
 * @remarks
 * The sanctioned never-throw boundary for the guards (AGENTS §14). The
 * `whereOf`, `lazyOf`, and `transformOf` combinators invoke caller-supplied
 * callbacks *inside* a guard body, yet a guard must NEVER throw — it returns a
 * `boolean`. This converts a throwing callback into a `Failure` so the
 * surrounding guard can treat it as a non-match instead of propagating the
 * exception, written once and shared rather than copy-pasted as ad-hoc
 * `try`/`catch`. The return or thrown value is retained exactly and is never
 * inspected, coerced, cloned, frozen, or mutated. A returned Promise or
 * thenable is an ordinary successful value; later settlement is outside this
 * synchronous boundary. {@link isContractError} does not use this boundary and
 * is not an exception to it: it carries its own `try`/`catch` inside the class
 * body, because `errors.ts` cannot import this module without inverting the
 * dependency. The earlier claim here — that it was total BY CONSTRUCTION and had
 * nothing to contain — was false, and it is what justified deleting the
 * containment the committed baseline had. A guard whose totality rests on an
 * argument that nothing inside it can throw is one refactor away from throwing.
 *
 * @param callback - The callback to invoke with no arguments
 * @returns A `Success` carrying the exact return value, or a `Failure` carrying
 *          the exact thrown value as `unknown`
 *
 * @example
 * ```ts
 * const outcome = attempt(() => predicate(value))
 * return outcome.success && outcome.value
 * ```
 */
export function attempt<T>(callback: () => T): Result<T> {
	try {
		return { success: true, value: callback() }
	} catch (error) {
		return { success: false, error }
	}
}

/**
 * Read a value through the shared containment boundary or refuse it with the
 * contract module's uniform read diagnostic.
 *
 * @remarks
 * Unlike {@link attempt}, this is not an optional-result boundary: a caller
 * has committed to reading the supplied value, so a failed read cannot be
 * represented as absence or another permissive answer. Every reader using
 * this helper throws with the same `<reader>: <subject> could not be read`
 * message shape and retains the exact thrown value as its cause. Required
 * structural readers use the defaults; pattern readers supply `pattern` for
 * both the subject and code.
 *
 * @param callback - The read operation to perform
 * @param reader - The public reader name used in the diagnostic
 * @param options - Optional subject, code, and structured context
 * @returns The successfully read value
 * @throws {ContractError} When the read operation fails
 *
 * @example
 * ```ts
 * readValue(() => source.value, 'parseRecord')
 * ```
 */
export function readValue<T>(callback: () => T, reader: string, options?: ReadValueOptions): T {
	const diagnostics = attempt(() => {
		const source = options?.context
		// Every consumed field is projected through a literal that already OWNS
		// all four names, so an absent field resolves to that own `undefined`
		// instead of leaving the container for `Object.prototype` — which every
		// caller can write. An unqualified `source.path` on a context literal
		// carrying only `shape` is an ordinary `Get`, and it walked, so a polluted
		// prototype chose what a refusal this module authored published and
		// retained the caller's object by identity. Spread copies own enumerable
		// properties only through the spec's own copy operation, so the projection
		// stays own-only without dispatching through a replaceable global.
		const owned = {
			path: undefined,
			shape: undefined,
			limit: undefined,
			received: undefined,
			...source,
		}
		const context =
			source === undefined
				? undefined
				: {
						...(owned.path === undefined ? {} : { path: owned.path }),
						...(owned.shape === undefined ? {} : { shape: owned.shape }),
						...(owned.limit === undefined ? {} : { limit: owned.limit }),
						...(owned.received === undefined ? {} : { received: owned.received }),
					}
		const requested = options?.code
		const code: ContractCode =
			requested === 'bound' ||
			requested === 'range' ||
			requested === 'empty' ||
			requested === 'placement' ||
			requested === 'structure' ||
			requested === 'literal' ||
			requested === 'cycle' ||
			requested === 'pattern' ||
			requested === 'generate' ||
			requested === 'random' ||
			requested === 'clone' ||
			requested === 'depth'
				? requested
				: 'structure'
		return {
			reader: isString(reader) ? reader : 'readValue',
			subject: isString(options?.subject) ? options.subject : 'value',
			code,
			context,
		}
	})
	if (!diagnostics.success) {
		throw new ContractError('readValue: options could not be read', {
			code: 'structure',
			cause: diagnostics.error,
		})
	}
	const outcome = attempt(callback)
	if (!outcome.success) {
		throw new ContractError(
			`${diagnostics.value.reader}: ${diagnostics.value.subject} could not be read`,
			{
				code: diagnostics.value.code,
				...(diagnostics.value.context === undefined ? {} : { context: diagnostics.value.context }),
				cause: outcome.error,
			},
		)
	}
	return outcome.value
}

/**
 * Run a public door's whole body and publish only this package's error class.
 *
 * @remarks
 * The other half of the answer {@link INTRINSICS} gives, and the half that does
 * not depend on anyone enumerating anything. Capture removes a named dispatch;
 * this removes the CONSEQUENCE of every dispatch a door's path still makes,
 * named or not. Four consecutive rounds fixed the statements they were shown
 * and were defeated by a statement one line later, because a boundary placed
 * per statement is only ever as complete as the last sweep. A boundary at the
 * door composes: whatever the body reaches, and whatever a caller installs
 * under it, the door publishes a {@link ContractError} or the value it
 * promised.
 *
 * A {@link ContractError} reaching this boundary passes through by identity —
 * the diagnosis a door spent its whole body computing is the point of the door,
 * and rewrapping it would demote it to a cause. The mechanism is
 * {@link isContractError}, which establishes CLASS MEMBERSHIP; it does not and
 * cannot establish that this package authored the error, and the passthrough is
 * described by what it tests rather than by what it intends. Anything else is a
 * host failure the caller arranged, so it is republished under the door's own
 * name with the exact thrown value retained as `cause`.
 *
 * Its population is exactly the public doors that can refuse — every door whose
 * TSDoc carries `@throws {ContractError}`, and no door whose body cannot throw
 * at all. A wrapper around a body that only allocates a closure buys nothing
 * and misreports where the refusals are.
 *
 * Use {@link readValue} instead where a single read has its own subject and
 * deserves its own diagnostic; use this where the subject is the door.
 *
 * @param callback - The door body to run
 * @param door - The public door name used in the diagnostic
 * @param options - Optional code and structured context for the published refusal
 * @returns The body's exact return value
 * @throws {ContractError} The body's own refusal, or a coded translation of a host failure
 *
 * @example
 * ```ts
 * export function nullShape(options?: NullShapeOptions): NullShape {
 * 	return contain(() => buildNullShape(options), 'nullShape')
 * }
 * ```
 */
export function contain<T>(callback: () => T, door: string, options?: ContainOptions): T {
	const outcome = attempt(callback)
	if (outcome.success) return outcome.value
	if (isContractError(outcome.error)) throw outcome.error
	throw new ContractError(`${door}: a host operation this door depends on failed`, {
		code: options?.code ?? 'structure',
		...(options?.context === undefined ? {} : { context: options.context }),
		cause: outcome.error,
	})
}

/**
 * Invoke a predicate through the sanctioned never-throw boundary.
 *
 * @param callback - The predicate to invoke with no arguments
 * @returns `true` only when the callback returns the boolean value `true`
 *
 * @example
 * ```ts
 * holds(() => value instanceof Widget) // false when inspection throws
 * ```
 */
export function holds(callback: () => boolean): boolean {
	const outcome = attempt(callback)
	return outcome.success && outcome.value === true
}

/**
 * Determine whether a value carries the plain-record brand, raising a hostile
 * prototype observation instead of answering it.
 *
 * @remarks
 * THE single record-brand rule: a plain record is a non-array object whose
 * prototype is `null`, or is a realm's `Object.prototype`. Realm-agnosticism is
 * why the second arm cannot simply compare against this realm's
 * `Object.prototype` — a plain object from another `vm.Context`, iframe, or
 * worker inherits from THAT realm's `Object.prototype`, which is a different
 * object. The earlier rule accepted any prototype that itself had a `null`
 * prototype, which every realm's `Object.prototype` satisfies — and so does a
 * class prototype a caller reparented to `null`, which is how a class instance
 * laundered through every ownership door. A foreign `Object.prototype` is
 * therefore identified by the own members ECMAScript requires every realm to
 * put on it (`constructor`, `hasOwnProperty`, `isPrototypeOf`,
 * `propertyIsEnumerable`, `toLocaleString`, `toString`, `valueOf`), each read
 * through its own DESCRIPTOR so no accessor on a hostile prototype ever runs.
 * Each must be an own DATA property whose value is a FUNCTION — true of every
 * conformant realm, so the requirement costs a genuine foreign record nothing,
 * and it refuses the cheapest forgery (stamping the seven names with
 * `undefined`) for free.
 *
 * That is a structural test, not a provenance one, and the residual is stated
 * as exactly what it is: a FUNCTION-VALUED forgery passes, and this realm's own
 * `Object.prototype` supplies the seven functions to stamp, so the price is a
 * few lines rather than nothing. Reparenting a class prototype to `null` and
 * stamping the seven names with real functions passes; so does leaving the
 * class untouched and putting a `Proxy` in prototype position that reports
 * `null` as its own prototype and answers those seven descriptor reads with
 * functions. In both cases the value is a live class instance whose methods are
 * still reachable on it. A further own-key SUBSET rule buys even less: it
 * refuses a forgery that left methods on its prototype and accepts the same
 * class with those methods moved onto the instance, where they are
 * indistinguishable from a plain record's function
 * properties — so it raises the forgery's price and narrows the realm-agnostic
 * arm this rule exists to keep open. What the pass buys is acceptance at
 * brand-governed doors and nothing after it: every ownership engine publishes a
 * frozen plain record built only from captured data, so no class instance,
 * class behavior, or forged prototype survives into a snapshot.
 *
 * `Object.create(<null-prototype object>)` is refused, and NOT because it is
 * structurally identical to a reparented class instance — it is not, since a
 * class prototype always owns `constructor` and a bare `Object.create(null)`
 * owns nothing. It is refused as policy: no realm produces that chain for a
 * plain object, no consumer of it has been named, and a caller erases the
 * difference by deleting `constructor`.
 *
 * This is the diagnosing form, deliberately NOT total: a revoked `Proxy` or a
 * hostile `getPrototypeOf` trap throws out of it, so an ownership engine can
 * report an unreadable value as a failed read with the exact cause rather than
 * as a well-formed structural refusal. {@link isRecord} is the total form for
 * every guard consumer and contains that throw as `false`.
 *
 * @param value - The value whose record brand to inspect
 * @returns `true` only when the value is a plain record
 * @throws The exact value thrown by a hostile brand observation
 *
 * @example
 * ```ts
 * matchesRecordBrand({})                    // true
 * matchesRecordBrand(Object.create(null))   // true
 * matchesRecordBrand(new Date())            // false
 * ```
 */
export function matchesRecordBrand(value: unknown): boolean {
	if (!isObject(value) || INTRINSICS.array(value)) return false
	const prototype = INTRINSICS.prototype(value)
	if (prototype === null || prototype === INTRINSICS.base) return true
	if (INTRINSICS.prototype(prototype) !== null) return false
	const mandated = [
		'constructor',
		'hasOwnProperty',
		'isPrototypeOf',
		'propertyIsEnumerable',
		'toLocaleString',
		'toString',
		'valueOf',
	]
	// Indexed, not iterated: `for…of` over an array this module built still reads
	// `Array.prototype[Symbol.iterator]`, a caller-writable member, and an
	// iterator yielding a name this list never held decides a brand verdict.
	for (let index = 0; index < mandated.length; index += 1) {
		const member = mandated[index]
		if (member === undefined) return false
		// A descriptor read, not a value read: it answers ownership, data-ness and
		// the member's kind in one observation while running no accessor a hostile
		// prototype installed. Every realm's members are function-valued data
		// properties, so requiring that costs a genuine realm nothing and costs a
		// forger the work of finding seven functions to stamp.
		const descriptor = INTRINSICS.describe(prototype, member)
		if (descriptor === undefined || !INTRINSICS.own(descriptor, 'value')) return false
		if (typeof descriptor.value !== 'function') return false
	}
	return true
}

/**
 * Snapshot an array through its reflected own-index population.
 *
 * @remarks
 * Reads `length` once and one reflected own-key population, then corroborates
 * and reads only those reflected canonical indices in ascending order. The
 * frozen native snapshot retains actual holes: reading one yields `undefined`,
 * while own membership remains absent. Its work is proportional to the
 * reflected population, so a length-driven consumer must require `dense` or
 * carry an independent bound. A population that is exactly the canonical
 * indices in ascending order followed by `length` is copied straight by index
 * under the same per-index corroboration, and answers with the same entries,
 * the same `dense` fact, and the same refusals as the walk. Caller-defined
 * iteration is ignored. A descriptor-only index omitted from reflection is
 * deliberately outside this lens and remains a hole. Failure retains the exact
 * thrown value when length, reflection, membership, or indexed value
 * observation throws; a non-native length or view disagreement is also
 * failure. `4294967295` is metadata rather than an array index.
 *
 * @param value - The array whose reflected indexed entries to read
 * @returns A successful frozen entry snapshot with its dense fact, or a
 *          failure carrying the exact thrown value as `unknown`
 *
 * @example
 * ```ts
 * readArrayEntries([1, 2]) // { success: true, value: { entries: [1, 2], dense: true } }
 * ```
 */
export function readArrayEntries<T>(value: readonly T[]): Result<ArrayRead<T>> {
	return attempt(() => {
		const length = value.length
		if (!INTRINSICS.safe(length) || length < 0 || length > 2 ** 32 - 1) {
			throw new INTRINSICS.error('Array length is outside the native array domain')
		}
		const members = INTRINSICS.members(value)
		// One canonicality question, asked once: the reported population is the
		// ascending index texts and `length`, and nothing else. The scan stops at
		// the first disagreement, so a population that fails the question pays for
		// the prefix it shares with a canonical one before it walks.
		let matched = 0
		while (matched < length && members[matched] === INTRINSICS.text(matched)) matched += 1
		if (matched === length && members.length === length + 1 && members[length] === 'length') {
			const packed = new INTRINSICS.list<T | undefined>(length)
			for (let index = 0; index < length; index += 1) {
				const key = members[index]
				if (key === undefined || !INTRINSICS.own(value, key)) {
					throw new INTRINSICS.error('Array index views disagree')
				}
				packed[index] = value[index]
			}
			return INTRINSICS.freeze({ entries: INTRINSICS.freeze(packed), dense: true })
		}
		const collected: number[] = []
		const keys: string[] = []
		let ascending = true
		let previous = -1
		for (let position = 0; position < members.length; position += 1) {
			const key = members[position]
			if (!isString(key)) continue
			const index = INTRINSICS.numeric(key)
			if (
				INTRINSICS.integer(index) &&
				index >= 0 &&
				index < 2 ** 32 - 1 &&
				INTRINSICS.text(index) === key
			) {
				if (index >= length) throw new INTRINSICS.error('Array index views disagree')
				if (index <= previous) ascending = false
				previous = index
				collected[collected.length] = index
				keys[keys.length] = key
			}
		}
		// Ordered on arrival, not by default: a caller-defined key view may deliver
		// the canonical indices in any order, so the sort answers that view alone
		// and the parallel key list carries the string already proven canonical
		// against its index, which the ordered arrival then never re-derives.
		const indices = ascending ? collected : sortValues(collected)
		const entries = new INTRINSICS.list<T | undefined>(length)
		for (let position = 0; position < indices.length; position += 1) {
			const index = indices[position]
			if (index === undefined) continue
			const key = ascending ? keys[position] : INTRINSICS.text(index)
			if (key === undefined || !INTRINSICS.own(value, key)) {
				throw new INTRINSICS.error('Array index views disagree')
			}
			entries[index] = value[index]
		}
		return INTRINSICS.freeze({
			entries: INTRINSICS.freeze(entries),
			dense: indices.length === length,
		})
	})
}

/**
 * Snapshot a guard shape and its optional-key mode for a shape combinator.
 *
 * @remarks
 * A null-prototype record plus its own key list is used instead of a `Map`.
 * The declared-key population decides the guard's answer, and
 * `Map.prototype.has`, `Map.prototype.get`, and map iteration are three
 * caller-writable members on that path. An own data key read by index
 * dispatches through nothing.
 *
 * @param shape - The guard shape whose own string declarations to snapshot
 * @param optional - The optional-key list, `true` for every key, or `undefined`
 * @param reader - The public combinator name used in read refusals
 * @returns The owned guards and names plus the collected optional-key membership
 * @throws {ContractError} When the shape or optional-key list cannot be read
 *
 * @example
 * ```ts
 * readGuardShape({ id: isString }, undefined, 'recordOf')
 * ```
 */
export function readGuardShape(
	shape: GuardsShape,
	optional: readonly string[] | true | undefined,
	reader: string,
): Readonly<{
	readonly guards: Readonly<Record<string, Guard<unknown> | undefined>>
	readonly names: readonly string[]
	readonly optional: ReadonlySet<unknown>
	readonly vocabulary: ReadonlySet<unknown>
}> {
	const declared = readValue(
		() => {
			const members = INTRINSICS.members(shape)
			const guards: Record<string, Guard<unknown> | undefined> = INTRINSICS.create(null)
			const names: string[] = []
			for (let index = 0; index < members.length; index += 1) {
				const key = members[index]
				if (!isString(key)) continue
				if (!INTRINSICS.own(guards, key)) names[names.length] = key
				guards[key] = shape[key]
			}
			return { guards, names, vocabulary: collectMembers(names) }
		},
		reader,
		{ subject: 'shape' },
	)
	const optionalKeys = readValue(
		() => {
			if (optional === true) return collectMembers(declared.names)
			if (!INTRINSICS.array(optional)) return collectMembers([])
			const entries = readArrayEntries(optional)
			if (!entries.success) throw entries.error
			if (!entries.value.dense) throw new INTRINSICS.error('Optional key list must be dense')
			const keys = collectMembers([])
			for (let index = 0; index < entries.value.entries.length; index += 1) {
				admitMember(keys, INTRINSICS.text(entries.value.entries[index]))
			}
			return keys
		},
		reader,
		{ subject: 'optional' },
	)

	return {
		guards: declared.guards,
		names: declared.names,
		optional: optionalKeys,
		vocabulary: declared.vocabulary,
	}
}

/**
 * Snapshot an object's own enumerable string keys through a total boundary.
 *
 * @remarks
 * This is the package-wide runtime property view used by compiled object
 * guards, parsers, reporters, schema inference, and owned schema cloning. It
 * matches the object-key view serialized by `JSON.stringify`: inherited,
 * symbol, and non-enumerable properties are excluded. A hostile Proxy trap
 * returns `undefined` rather than escaping.
 *
 * @param value - The object whose keys to snapshot
 * @returns A frozen owned key list, or `undefined` when enumeration throws
 *
 * @example
 * ```ts
 * enumerableKeys({ visible: 1 }) // ['visible']
 * ```
 */
export function enumerableKeys(value: object): readonly string[] | undefined {
	// `Object.keys` already returns a fresh own array, so it is frozen directly:
	// the copy it replaces was an array SPREAD, which dispatches through
	// `Array.prototype[Symbol.iterator]` — a caller-writable member — and sat
	// outside the boundary, so a redirected iterator threw the caller's raw value
	// out of a helper documented to answer `undefined`, and out of every compiled
	// guard and parser layered on it.
	const outcome = attempt(() => INTRINSICS.freeze(INTRINSICS.keys(value)))
	return outcome.success ? outcome.value : undefined
}

/**
 * Validate and snapshot a shape-builder options record through every reflective
 * operation the builder relies on.
 *
 * @remarks
 * Primitive inputs are rejected before reflection so ordinary caller mistakes
 * retain the reader's precise plain-record diagnostic. For an object, every
 * consumed key is read exactly once, checked for presence, and inspected for an
 * own descriptor while the container is enumerated once. Every successfully
 * read non-`undefined` consumed value enters the fresh own-enumerable snapshot,
 * including an inherited or non-enumerable option. A hostile host is reported
 * uniformly as an unreadable options record, while a readable array or class
 * instance retains the plain-record diagnostic.
 *
 * @param source - The optional builder options value
 * @param keys - Every option key consumed by that builder
 * @param builder - The builder name used in diagnostics
 * @param shape - The shape category used in structured error context
 * @returns An owned options snapshot, or `undefined` when options are absent
 * @throws {ContractError} When the value is not a plain record or reflection fails
 *
 * @example
 * ```ts
 * const options = readOptions(source, ['min', 'max'], 'numberShape', 'number')
 * ```
 */
export function readOptions<T extends object>(
	source: T | undefined,
	keys: ReadonlyArray<keyof T & string>,
	builder: string,
	shape: string,
): T | undefined {
	return contain(() => {
		if (source === undefined) return undefined
		const input: unknown = source
		if (!isObject(input)) {
			throw new ContractError(`${builder}: options must be a plain record`, {
				code: 'structure',
				context: { shape },
			})
		}
		const result = readValue(
			() => {
				// A null-prototype accumulator, indexed — not a `Map`. The values read
				// here become the builder's published options, and `Map.prototype.get`
				// is a caller-writable member: a substitute answering a decoy would put
				// the caller's value into a snapshot the builder swears it observed.
				// An own data key on a null-prototype object dispatches through nothing,
				// including for a key literally named '__proto__'.
				const values: Record<string, unknown> = INTRINSICS.create(null)
				for (let index = 0; index < keys.length; index += 1) {
					const key = keys[index]
					if (key === undefined) continue
					values[key] = INTRINSICS.read(input, key)
					INTRINSICS.present(input, key)
					INTRINSICS.reveal(input, key)
				}
				INTRINSICS.members(input)
				const record = matchesRecordBrand(input)
				const snapshot: T = INTRINSICS.create(INTRINSICS.base)
				for (let index = 0; index < keys.length; index += 1) {
					const key = keys[index]
					if (key === undefined) continue
					const value = values[key]
					if (value === undefined) continue
					INTRINSICS.declare(snapshot, key, {
						value,
						enumerable: true,
						configurable: true,
						writable: true,
					})
				}
				return { snapshot, record }
			},
			builder,
			{ subject: 'options', context: { shape } },
		)
		if (!result.record) {
			throw new ContractError(`${builder}: options must be a plain record`, {
				code: 'structure',
				context: { shape },
			})
		}
		return result.snapshot
	}, 'readOptions')
}

/**
 * Draw and validate one generator random sample.
 *
 * @param random - The caller-supplied random source
 * @param shape - The shape category consuming the sample
 * @returns A finite sample in `[0, 1)`
 * @throws {ContractError} When the source throws or returns outside `[0, 1)`;
 *                        a thrown value is retained exactly as the cause
 *
 * @example
 * ```ts
 * drawRandom(() => 0.5, 'number') // 0.5
 * ```
 */
export function drawRandom(random: RandomFunction, shape: string): number {
	return contain(() => {
		const outcome = attempt(random)
		if (!outcome.success) {
			throw new ContractError('drawRandom: the random source threw', {
				code: 'random',
				context: { shape, limit: '[0, 1)', received: 'threw' },
				cause: outcome.error,
			})
		}
		const sample = outcome.value
		if (!isFiniteNumber(sample) || sample < 0 || sample >= 1) {
			throw new ContractError('drawRandom: the random source must return a value in [0, 1)', {
				code: 'random',
				context: { shape, limit: '[0, 1)', received: preview(sample) },
			})
		}
		return sample
	}, 'drawRandom')
}

// === Record-field access

/**
 * Resolve a (possibly nested) field value from a record by a key or key path.
 *
 * @remarks
 * A single `string` is ONE key (never split on `.`, so dotted keys are safe); a
 * string array descends left-to-right through own properties of nested objects.
 * The root must satisfy {@link isRecord}; inherited properties are never fields.
 * Intermediates may be objects or arrays indexed by string. Returns `undefined`
 * the moment a segment is missing or lands on a non-object, so the lookup is
 * total — even against a hostile getter or Proxy trap that throws on read,
 * contained via {@link attempt} so the throw never escapes.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns The resolved value, or `undefined`
 *
 * @example
 * ```ts
 * resolveField({ user: { name: 'Ada' } }, ['user', 'name']) // 'Ada'
 * resolveField({ 'a.b': 1 }, 'a.b')                          // 1 (one key)
 * resolveField({ a: 1 }, ['a', 'b'])                         // undefined
 * ```
 */
export function resolveField(record: Readonly<Record<string, unknown>>, path: FieldPath): unknown {
	const outcome = attempt(() => {
		if (!isRecord(record)) return undefined
		const keys = isString(path) ? [path] : path
		let current: unknown = record
		// Indexed: the caller's own path array is walked through its own index
		// properties rather than through `Array.prototype[Symbol.iterator]`, so an
		// injected leading segment cannot redirect the lookup.
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index]
			if (key === undefined) return undefined
			if (!isObject(current) || !INTRINSICS.own(current, key)) return undefined
			current = INTRINSICS.read(current, key)
		}
		return current
	})
	return outcome.success ? outcome.value : undefined
}

/**
 * Determine whether a readable value stays within the fixed JSON container-depth limit.
 *
 * @remarks
 * Counts array and plain-record containers on each active root-to-value path.
 * Primitive and readable non-record objects are leaves, active cycles add no
 * level, and shared aliases are answered from the shallowest depth at which
 * the alias already fit. Arrays are traversed through their reflected
 * own-index population, so sparse work is proportional to populated entries
 * rather than advertised length. Every observable operation is contained;
 * hostile or contradictory reads return `false`.
 *
 * The walk carries a settled-depth memo beside its active-path set: a
 * container that fit at depth `d` also fits at any depth `<= d`, because every
 * path below it is then shallower than the one already measured. Without it a
 * node reachable by `k` distinct paths was re-walked `k` times, so an ORDINARY
 * record graph with thirty shared aliases — thirty-one nodes — cost `2^30`
 * visits through a public guard.
 *
 * @param value - The value whose readable container depth to inspect
 * @returns `true` when no active path exceeds {@link GUARD_DEPTH_LIMIT}
 *
 * @example
 * ```ts
 * matchesJSONDepth({ nested: [1] }) // true
 * ```
 */
export function matchesJSONDepth(value: unknown): boolean {
	return holds(() => {
		const stack: Array<
			| { readonly operation: 'enter'; readonly value: unknown; readonly depth: number }
			| { readonly operation: 'exit'; readonly value: object; readonly depth: number }
		> = [{ operation: 'enter', value, depth: 0 }]
		const active = new INTRINSICS.weakSet<object>()
		const settled = new INTRINSICS.weakMap<object, number>()

		while (stack.length > 0) {
			const frame = stack.pop()
			if (frame === undefined) return false
			if (frame.operation === 'exit') {
				omitVisited(active, frame.value)
				INTRINSICS.apply(INTRINSICS.retain, settled, [frame.value, frame.depth])
				continue
			}

			const entry = frame.value
			if (entry === null || typeof entry !== 'object') continue
			const array = INTRINSICS.array(entry)
			if (!array && !matchesRecordBrand(entry)) continue
			if (matchesVisited(active, entry)) continue

			const depth = frame.depth + 1
			if (depth > GUARD_DEPTH_LIMIT) return false
			// Settled at a deeper start means every path below it was measured with
			// LESS headroom than this one has, so it cannot exceed the limit here.
			const deepest: unknown = INTRINSICS.apply(INTRINSICS.recall, settled, [entry])
			if (isNumber(deepest) && depth <= deepest) continue
			admitVisited(active, entry)
			stack[stack.length] = { operation: 'exit', value: entry, depth }

			if (array) {
				const snapshot = readArrayEntries(entry)
				if (!snapshot.success) return false
				const children = INTRINSICS.values(snapshot.value.entries)
				for (let index = 0; index < children.length; index += 1) {
					stack[stack.length] = { operation: 'enter', value: children[index], depth }
				}
				continue
			}

			const keys = enumerableKeys(entry)
			if (keys === undefined) return false
			for (let index = 0; index < keys.length; index += 1) {
				const key = keys[index]
				if (key === undefined) return false
				if (!INTRINSICS.own(entry, key)) return false
				stack[stack.length] = { operation: 'enter', value: INTRINSICS.read(entry, key), depth }
			}
		}

		return true
	})
}

/**
 * Match an unknown value against the recursive JSON value structure.
 *
 * @remarks
 * The caller-owned ancestor set tracks only the active traversal path, so
 * cycles fail while shared references across sibling branches remain valid.
 * The set belongs to one traversal from one entry point; passing a shared or
 * pre-populated set is unsupported. Arrays descend through the shared dense
 * own-index lens and plain records descend by values; class instances and
 * non-finite numbers are rejected.
 *
 * The walk is ITERATIVE, over an explicit enter/exit stack, exactly as
 * {@link matchesJSONDepth} already was. It used to recurse, and that made the
 * verdict a function of the REMAINING CALL STACK rather than of the value: the
 * same readable 4,000-deep document answered `true` at a root call site and
 * `false` a few frames down, and `parseJSONValue` republished the resulting
 * `RangeError` as `value could not be read` for a value every read of which
 * succeeded. A cap enforced by the JavaScript stack is not a cap. This walk
 * carries no depth cap of its own — `isJSONValue` is deliberately the unbounded
 * deep gate and {@link matchesJSONDepth} / `isBoundedJSONValue` are the bounded
 * pair beside it — so the answer now depends only on the value, at every depth
 * and from every call site.
 *
 * Beside the ancestor set the walk keeps a walk-local PROVED set, so a node
 * whose whole subtree already matched is not re-walked when a second path
 * reaches it. Removing the recursion alone left the work exponential in shared
 * aliases: thirty aliases — thirty-one ordinary records — cost `2^30` visits
 * through `isJSONValue`, `parseJSONValue`, `canonicalStringify` and every
 * `jsonShape` contract.
 *
 * @param entry - The value to inspect
 * @param ancestors - Objects on the active traversal path
 * @returns `true` when the value is a cycle-free JSON value
 *
 * @example
 * ```ts
 * matchesJSONValue({ nested: [1, 'x', null] }, new WeakSet()) // true
 * matchesJSONValue(Number.NaN, new WeakSet())                 // false
 * ```
 */
export function matchesJSONValue(entry: unknown, ancestors: WeakSet<object>): entry is JSONValue {
	return readValue(
		() => {
			const stack: Array<
				| { readonly operation: 'enter'; readonly value: unknown }
				| { readonly operation: 'exit'; readonly value: object }
			> = [{ operation: 'enter', value: entry }]
			// Walk-local, never the caller's set: a node whose WHOLE subtree already
			// matched needs no second walk. Soundness — if a proved node could reach
			// an ancestor active on some later path, that ancestor was inside the
			// proved node's own subtree, so the first walk descended into it, met the
			// proved node again while it was still active, and refused. A proved node
			// therefore cannot participate in a cycle any later path could discover.
			const proved = new INTRINSICS.weakSet<object>()

			while (stack.length > 0) {
				const frame = stack.pop()
				if (frame === undefined) return false
				if (frame.operation === 'exit') {
					omitVisited(ancestors, frame.value)
					admitVisited(proved, frame.value)
					continue
				}

				const node = frame.value
				if (node === null || isString(node) || isBoolean(node) || isFiniteNumber(node)) continue
				if (INTRINSICS.array(node)) {
					if (matchesVisited(ancestors, node)) return false
					if (matchesVisited(proved, node)) continue
					const snapshot = readArrayEntries(node)
					if (!snapshot.success) throw snapshot.error
					if (!snapshot.value.dense) return false
					admitVisited(ancestors, node)
					stack[stack.length] = { operation: 'exit', value: node }
					// Pushed in reverse so the LIFO stack visits siblings in source order,
					// which is the order the recursive walk this replaced descended in.
					const entries = snapshot.value.entries
					for (let index = entries.length - 1; index >= 0; index -= 1) {
						stack[stack.length] = { operation: 'enter', value: entries[index] }
					}
					continue
				}
				if (!isRecord(node)) return false
				if (matchesVisited(ancestors, node)) return false
				if (matchesVisited(proved, node)) continue
				admitVisited(ancestors, node)
				stack[stack.length] = { operation: 'exit', value: node }
				const members = INTRINSICS.values(node)
				for (let index = members.length - 1; index >= 0; index -= 1) {
					stack[stack.length] = { operation: 'enter', value: members[index] }
				}
			}

			return true
		},
		'matchesJSONValue',
		{ context: { shape: 'json' } },
	)
}

// === Random

/**
 * Build a deterministic pseudo-random source seeded from a single number.
 *
 * @remarks
 * A mulberry32 generator — the same seed always yields the same sequence, so
 * generated seed data is reproducible across runs. Used as the default random
 * source for {@link compileGenerator}, seeded from the wall clock so casual
 * callers still get varied output without passing a source themselves.
 *
 * @param seed - The seed for the sequence
 * @returns A {@link RandomFunction} returning values in `[0, 1)`
 *
 * @example
 * ```ts
 * const random = seededRandom(42)
 * random() // always the same first value for seed 42
 * ```
 */
export function seededRandom(seed: number): RandomFunction {
	if (!isNumber(seed)) {
		throw new ContractError('seededRandom: seed must be a number', {
			code: 'random',
			context: { limit: 'number', received: preview(seed) },
		})
	}
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = INTRINSICS.imul(t ^ (t >>> 15), t | 1)
		t ^= t + INTRINSICS.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
	}
}

/**
 * Count the enumerable own-symbol keys on a value.
 *
 * @remarks
 * String keys are ignored — only `Object.getOwnPropertySymbols` entries whose
 * descriptor is `enumerable` are counted, and each descriptor is read through
 * the captured observation so no accessor runs. It answers exactly the
 * `JSON.stringify`-invisible half of a record's own-symbol population, for a
 * consumer that needs that count directly. It does NOT back `isEmptyObject` /
 * `isNonEmptyObject` — those ask the complete own-key question `recordOf` asks,
 * because an enumerable-only count made their `never` narrowing unsound for an
 * own non-enumerable key.
 *
 * @param value - The object to inspect
 * @returns The number of enumerable own-symbol keys
 *
 * @example
 * ```ts
 * const flag = Symbol('flag')
 * enumerableSymbolCount(Object.defineProperty({}, flag, { value: 1, enumerable: true })) // 1
 * enumerableSymbolCount({}) // 0
 * ```
 */
export function enumerableSymbolCount(value: object): number {
	return readValue(() => {
		let count = 0
		// Indexed: `Object.getOwnPropertySymbols` returns a fresh array this module
		// owns, and walking it through `Array.prototype[Symbol.iterator]` would let
		// a replaced iterator decide an emptiness verdict.
		const symbols = INTRINSICS.symbols(value)
		for (let index = 0; index < symbols.length; index += 1) {
			const symbol = symbols[index]
			if (symbol === undefined) continue
			if (INTRINSICS.describe(value, symbol)?.enumerable) {
				count += 1
			}
		}
		return count
	}, 'enumerableSymbolCount')
}

/**
 * Narrow a compiled {@link JSONSchema} down to the open `Readonly<Record<string, unknown>>` shape
 * tool definitions advertise as `parameters` — through the {@link isRecord} boundary guard, never
 * an assertion (AGENTS §14).
 *
 * @remarks
 * A `JSONSchema` is the closed contract-compiler fragment (it has no index signature), whereas a
 * tool advertises its `parameters` as an open record. The two are structurally compatible but not
 * assignable, so the schema crosses that boundary through `isRecord` — a compiled contract schema
 * is always a record, so the guard passes; the `undefined` fallback only satisfies the type's
 * optionality. This is the single sanctioned narrowing from a compiled contract schema to the open
 * tool-parameters record, so the crossing lives once rather than being copy-pasted per call site.
 *
 * @param schema - The compiled JSON Schema (a contract's `schema`)
 * @returns The schema as the open tool-parameters record, or `undefined` when it is not a record
 * @throws {ContractError} When the schema cannot be read
 *
 * @example
 * ```ts
 * import { createContract, schemaToParameters } from '@orkestrel/contract'
 *
 * const contract = createContract(shape)
 * const parameters = schemaToParameters(contract.schema) // the open record a tool advertises
 * ```
 */
export function schemaToParameters(
	schema: JSONSchema,
): Readonly<Record<string, unknown>> | undefined {
	return contain(() => {
		readValue(() => INTRINSICS.values(schema), 'schemaToParameters')
		return isRecord(schema) ? schema : undefined
	}, 'schemaToParameters')
}

/**
 * Wrap a non-object `JSONSchema` root in a single-property object schema, so
 * an inferred primitive/array/union schema can flow into {@link schemaToParameters}
 * as an MCP-compatible `inputSchema`.
 *
 * @remarks
 * Deterministic for readable input. `schema.type === 'object'` passes through
 * unchanged; every other root (a primitive/array `type`, an `anyOf`/`enum`-only
 * schema with no `type`, or the empty `{}`) is wrapped as a single required
 * `value` property: `{ type: 'object', properties: { value: schema },
 * required: ['value'], additionalProperties: false }`. Composition:
 * `schemaToParameters(schemaToObject(valueToSchema(payload)))`.
 *
 * @param schema - The schema to wrap
 * @returns `schema` unchanged when object-rooted, otherwise the wrapped object schema
 * @throws {ContractError} When the schema root cannot be read
 *
 * @example
 * ```ts
 * schemaToObject({ type: 'string' })
 * // { type: 'object', properties: { value: { type: 'string' } },
 * //   required: ['value'], additionalProperties: false }
 * schemaToObject({ type: 'object', properties: {} }) // unchanged
 * ```
 */
export function schemaToObject(schema: JSONSchema): JSONSchema {
	return contain(() => {
		return readValue(
			() => {
				INTRINSICS.values(schema)
				if (schema.type === 'object') return schema
				return {
					type: 'object',
					properties: { value: schema },
					required: ['value'],
					additionalProperties: false,
				}
			},
			'schemaToObject',
			{ subject: 'schema' },
		)
	}, 'schemaToObject')
}

// === Inference option sanitization

/**
 * Sanitize a user-supplied inference budget (`maxDepth` / `maxProperties`) to
 * a finite non-negative integer, selecting a valid fallback for anything else.
 *
 * @remarks
 * Guards {@link valueToSchema} / {@link samplesToSchema} against a hostile or
 * malformed budget: an unclamped `NaN` defeats every `depth <= 0` guard
 * (`NaN <= 0` is `false`, so recursion never halts), and a negative
 * `maxProperties` makes `slice(0, -1)` silently drop the LAST sorted key
 * instead of capping the list (a fractional value has a similarly undefined
 * `slice` bound). `Infinity` is rejected too — `Number.isInteger(Infinity)`
 * is `false` — since an unbounded budget is exactly the adversarial case the
 * caps exist to prevent. A valid candidate passes through unchanged without
 * inspecting the fallback. When the candidate is invalid, the fallback must
 * satisfy the same finite non-negative-integer contract or this boundary
 * refuses it with a coded error instead of returning an invalid budget.
 *
 * @param value - The candidate budget value
 * @param fallback - The default to select when `value` is not a finite
 *                   non-negative integer
 * @returns A finite non-negative integer budget
 * @throws {ContractError} When the selected fallback is not a finite
 *                         non-negative integer
 *
 * @example
 * ```ts
 * sanitizeBudget(Number.NaN, INFER_DEPTH_LIMIT) // INFER_DEPTH_LIMIT
 * sanitizeBudget(-1, INFER_BREADTH_LIMIT)       // INFER_BREADTH_LIMIT
 * sanitizeBudget(4, INFER_DEPTH_LIMIT)          // 4
 * ```
 */
export function sanitizeBudget(value: number | undefined, fallback: number): number {
	return contain(() => {
		if (typeof value === 'number' && INTRINSICS.integer(value) && value >= 0) return value
		if (typeof fallback === 'number' && INTRINSICS.integer(fallback) && fallback >= 0)
			return fallback
		throw new ContractError('sanitizeBudget: fallback must be a finite non-negative integer', {
			code: 'bound',
			context: { limit: 'finite non-negative integer', received: preview(fallback) },
		})
	}, 'sanitizeBudget')
}

/**
 * Resolve a caller's depth budget to one the traversal can actually survive.
 *
 * @remarks
 * {@link sanitizeBudget} decides the SHAPE of a budget and deliberately lets any
 * finite non-negative integer through, because it must never read a fallback a
 * hostile caller supplied. That left the depth axis unbounded from above, and
 * depth is the axis that recurses: `1e9` is a valid integer, so the walk descended
 * until the call STACK failed, at a depth that varied between runs, and the
 * refusal surfaced as an unreadable value rather than as the exhaustion the guard
 * promises. Breadth needs no such ceiling — its loop is already bounded by the
 * entries actually present.
 *
 * So {@link INFER_DEPTH_LIMIT} is the ceiling as well as the default, and
 * `maxDepth` narrows the walk rather than widening it. One bound, and the same
 * answer on every host.
 *
 * @param value - The candidate depth budget
 * @returns A finite non-negative integer no greater than `INFER_DEPTH_LIMIT`
 *
 * @example
 * ```ts
 * sanitizeDepth(4) // 4
 * sanitizeDepth(1e9) // 32
 * ```
 */
export function sanitizeDepth(value: number | undefined): number {
	return INTRINSICS.min(sanitizeBudget(value, INFER_DEPTH_LIMIT), INFER_DEPTH_LIMIT)
}

// === Reporting

/**
 * Render a short, safe, TOTAL preview of an unknown value for a {@link Fault}'s
 * `received` field.
 *
 * @remarks
 * A primitive renders as printable text: a string retains its quoted JSON
 * representation, while a narrowed symbol renders through intrinsic `String`
 * and receives the same escaping without outer quotes. One bounded indexed
 * encoder appends only complete escaped code-point tokens within
 * {@link PREVIEW_LIMIT}; clipping therefore never retrieves the mutable string
 * iterator or splits an escape/surrogate pair before its trailing `…`, and
 * enormous primitive text is not fully traversed. A number / boolean / bigint
 * renders via `String`; `null` and `undefined` render as their own name. An
 * array renders as `'array'`. Every other host — a plain object, a function, a
 * class instance, a `Map` — is NEVER traversed or stringified; it renders as
 * its bare `typeof` tag (`'object'` / `'function'`).
 *
 * @param value - The value to preview
 * @returns A short descriptive string, always safe to embed in a diagnostic
 *
 * @example
 * ```ts
 * preview('hi')        // '"hi"'
 * preview(42)           // '42'
 * preview(null)         // 'null'
 * preview({ a: 1 })     // 'object'
 * preview([1, 2, 3])    // 'array'
 * ```
 */
export function preview(value: unknown): string {
	if (value === null) return 'null'
	if (value === undefined) return 'undefined'
	if (isString(value) || isSymbol(value)) {
		const quoted = isString(value)
		const source = INTRINSICS.text(value)
		let text = quoted ? '"' : ''
		let index = 0
		while (index < source.length) {
			const first = source[index]
			if (first === undefined) break
			const second = index + 1 < source.length ? source[index + 1] : undefined
			const paired =
				first >= '\ud800' &&
				first <= '\udbff' &&
				second !== undefined &&
				second >= '\udc00' &&
				second <= '\udfff'
			const character = paired ? `${first}${second}` : first
			const encoded = INTRINSICS.stringify(character)
			const tokenLength = encoded.length - 2
			if (text.length + tokenLength > PREVIEW_LIMIT) return `${text}…`
			let tokenIndex = 1
			while (tokenIndex <= tokenLength) {
				const token = encoded[tokenIndex]
				if (token !== undefined) text += token
				tokenIndex += 1
			}
			index += paired ? 2 : 1
		}
		if (!quoted) return text
		return text.length < PREVIEW_LIMIT ? `${text}"` : `${text}…`
	}
	if (isNumber(value) || isBoolean(value)) return INTRINSICS.text(value)
	if (isBigInt(value)) return `${value}n`
	if (isArray(value)) return 'array'
	return typeof value
}

/**
 * Build the refinement faults a string value has against a {@link StringShape}.
 *
 * @remarks
 * The single source of the string refinement report, shared by
 * `compileReporter` and `compileAuditor`. The two doors differ only in how they
 * OBTAIN the string — the reporter coerces through `parseString`, the auditor
 * demands a primitive string — and agreed on every constraint afterwards by
 * carrying two copies of the same twenty-one lines, which is one edit away from
 * two contracts. Faults come out in declaration order — `min`, then `max`, then
 * `pattern` — because a report is read top to bottom and its order is public.
 *
 * The pattern is applied through an OWNED stateless rebuild
 * ({@link readPattern}) and asked through {@link matchesPattern}, so a caller's
 * `lastIndex` never moves and no caller-writable member decides whether the
 * value matched.
 *
 * The whole body reads the caller's SHAPE, so it runs through the same
 * {@link readValue} boundary {@link shapeToKind} uses and refuses an
 * out-of-domain declaration with the same diagnostic. The compiled doors gate a
 * non-`RegExp` `pattern` and a non-finite bound long before this helper sees
 * them, so the package's own path never arrives here off-domain — but the door
 * is PUBLISHED, and a shape a `StringShape` annotation merely vouched for
 * (parsed out of a document, say) reaches it unchecked. Publishing the host's
 * own `TypeError` from such a shape would falsify the promise this module makes
 * for every one of its doors.
 *
 * @param shape - The string shape whose refinements are checked
 * @param value - The already-obtained string to check
 * @param path - The path every produced fault is rooted at
 * @returns A fresh array of faults, empty when the value satisfies every refinement
 * @throws {ContractError} When the shape's refinement fields cannot be read
 *
 * @example
 * ```ts
 * createStringFaults({ type: 'string', min: 3 }, 'ab', [])
 * // [{ reason: 'constraint', path: [], expected: 'string', constraint: 'min', limit: 3, received: '"ab"' }]
 * ```
 */
export function createStringFaults(
	shape: StringShape,
	value: string,
	path: readonly string[],
): readonly Fault[] {
	return readValue(
		() => {
			const faults: Fault[] = []
			if (shape.min !== undefined && value.length < shape.min) {
				faults[faults.length] = {
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'min',
					limit: shape.min,
					received: preview(value),
				}
			}
			if (shape.max !== undefined && value.length > shape.max) {
				faults[faults.length] = {
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'max',
					limit: shape.max,
					received: preview(value),
				}
			}
			if (shape.pattern !== undefined && !matchesPattern(readPattern(shape.pattern), value)) {
				const limit = readPatternSource(shape.pattern)
				faults[faults.length] = {
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'pattern',
					...(limit === undefined ? {} : { limit }),
					received: preview(value),
				}
			}
			return faults
		},
		'createStringFaults',
		{ subject: 'shape' },
	)
}

/**
 * Build the refinement faults a number value has against a {@link NumberShape}.
 *
 * @remarks
 * The numeric sibling of {@link createStringFaults}, shared by the same two
 * doors for the same reason. `expected` is the shape's own kind — `'integer'`
 * when `integer: true`, otherwise `'number'` — so a caller reading the report
 * sees the declaration's vocabulary rather than the value's. Order is
 * `integer`, then `min`, then `max`. It refuses an unreadable shape through the
 * same boundary and for the same reason {@link createStringFaults} does.
 *
 * @param shape - The number shape whose refinements are checked
 * @param value - The already-obtained number to check
 * @param path - The path every produced fault is rooted at
 * @returns A fresh array of faults, empty when the value satisfies every refinement
 * @throws {ContractError} When the shape's refinement fields cannot be read
 *
 * @example
 * ```ts
 * createNumberFaults({ type: 'number', integer: true }, 1.5, [])
 * // [{ reason: 'constraint', path: [], expected: 'integer', constraint: 'integer', received: '1.5' }]
 * ```
 */
export function createNumberFaults(
	shape: NumberShape,
	value: number,
	path: readonly string[],
): readonly Fault[] {
	return readValue(
		() => {
			const expected: FaultKind = shape.integer === true ? 'integer' : 'number'
			const faults: Fault[] = []
			if (shape.integer === true && !INTRINSICS.integer(value)) {
				faults[faults.length] = {
					reason: 'constraint',
					path,
					expected,
					constraint: 'integer',
					received: preview(value),
				}
			}
			if (shape.min !== undefined && value < shape.min) {
				faults[faults.length] = {
					reason: 'constraint',
					path,
					expected,
					constraint: 'min',
					limit: shape.min,
					received: preview(value),
				}
			}
			if (shape.max !== undefined && value > shape.max) {
				faults[faults.length] = {
					reason: 'constraint',
					path,
					expected,
					constraint: 'max',
					limit: shape.max,
					received: preview(value),
				}
			}
			return faults
		},
		'createNumberFaults',
		{ subject: 'shape' },
	)
}

/**
 * Build the length faults an array has against an {@link ArrayShape}.
 *
 * @remarks
 * Takes the LENGTH rather than the array, because both doors have already read
 * their entries through {@link readArrayEntries} and must report the length that
 * read observed rather than re-asking the caller's value for it. `received` is
 * that count rendered through the captured `String`, matching the other length
 * diagnostics in the package. Order is `min`, then `max`. It refuses an
 * unreadable shape through the same boundary and for the same reason
 * {@link createStringFaults} does.
 *
 * @param shape - The array shape whose bounds are checked
 * @param length - The entry count the door already observed
 * @param path - The path every produced fault is rooted at
 * @returns A fresh array of faults, empty when the length satisfies both bounds
 * @throws {ContractError} When the shape's bound fields cannot be read
 *
 * @example
 * ```ts
 * createArrayFaults({ type: 'array', items: { type: 'string' }, min: 2 }, 1, [])
 * // [{ reason: 'constraint', path: [], expected: 'array', constraint: 'min', limit: 2, received: '1' }]
 * ```
 */
export function createArrayFaults(
	shape: ArrayShape,
	length: number,
	path: readonly string[],
): readonly Fault[] {
	return readValue(
		() => {
			const faults: Fault[] = []
			if (shape.min !== undefined && length < shape.min) {
				faults[faults.length] = {
					reason: 'constraint',
					path,
					expected: 'array',
					constraint: 'min',
					limit: shape.min,
					received: INTRINSICS.text(length),
				}
			}
			if (shape.max !== undefined && length > shape.max) {
				faults[faults.length] = {
					reason: 'constraint',
					path,
					expected: 'array',
					constraint: 'max',
					limit: shape.max,
					received: INTRINSICS.text(length),
				}
			}
			return faults
		},
		'createArrayFaults',
		{ subject: 'shape' },
	)
}

/**
 * Select the report of the variant that came closest to matching.
 *
 * @remarks
 * The union summary both diagnostic doors append their closest variant's faults
 * to. "Closest" is the SHORTEST report, and an earlier variant wins a tie, so a
 * union's diagnostic follows declaration order rather than whichever variant a
 * later comparison happened to visit. The winning report is returned BY
 * IDENTITY, never copied, so the summary carries the exact fault objects the
 * variant produced. No report at all — a union whose every variant slot was
 * unreadable — yields a frozen empty collection rather than `undefined`, so the
 * caller appends nothing instead of branching.
 *
 * The scan is an indexed read of arrays this package built, so neither the
 * choice of variant nor the length comparison dispatches through a member a
 * caller can replace.
 *
 * @param reports - One report per variant, in declaration order
 * @returns The first shortest report, or a frozen empty collection when there are none
 *
 * @example
 * ```ts
 * selectClosestFaults([[fault, fault], [fault]]) // the second report
 * selectClosestFaults([])                        // []
 * ```
 */
export function selectClosestFaults<T extends AuditFault>(
	reports: ReadonlyArray<readonly T[]>,
): readonly T[] {
	let closest: readonly T[] | undefined
	for (let index = 0; index < reports.length; index += 1) {
		const report = reports[index]
		if (report === undefined) continue
		if (closest === undefined || report.length < closest.length) closest = report
	}
	return closest ?? INTRINSICS.freeze([])
}

/**
 * Project a {@link ContractShape} to the {@link FaultKind} it describes.
 *
 * @remarks
 * A structural mapping used by {@link compileReporter} to fill a `Fault`'s
 * `expected` field and by {@link compileAuditor} to fill an `AuditFault`'s:
 * most shapes map to their own `type` (`numberShape` maps to
 * `'integer'` when `integer: true`, else `'number'`); `optionalShape` /
 * `nullableShape` project through to their inner shape's kind, and `rawShape`
 * (an arbitrary embedded schema with no fixed kind) projects to `'json'`.
 *
 * A hand-authored node carrying an unrecognized discriminant is REFUSED rather
 * than answered out of type. The switch used to fall off its end and return
 * `undefined` for such a node, which made the declared non-optional
 * {@link FaultKind} return type a lie at a public export; every other door in
 * this module refuses out-of-domain input, so this one does too.
 *
 * @param shape - The shape to project
 * @returns The shape's {@link FaultKind}
 * @throws {ContractError} When the node carries no recognized shape discriminant
 *
 * @example
 * ```ts
 * shapeToKind(stringShape())            // 'string'
 * shapeToKind(integerShape())           // 'integer'
 * shapeToKind(optionalShape(nullShape())) // 'null'
 * ```
 */
export function shapeToKind(shape: ContractShape): FaultKind {
	return readValue(
		() => {
			switch (shape.type) {
				case 'string':
					return 'string'
				case 'number':
					return shape.integer === true ? 'integer' : 'number'
				case 'boolean':
					return 'boolean'
				case 'null':
					return 'null'
				case 'literal':
					return 'literal'
				case 'array':
					return 'array'
				case 'object':
					return 'object'
				case 'union':
					return 'union'
				case 'json':
					return 'json'
				case 'optional':
					return shapeToKind(shape.inner)
				case 'nullable':
					return shapeToKind(shape.inner)
				case 'raw':
					return 'json'
				default:
					throw new INTRINSICS.error('shapeToKind: unrecognized shape discriminant')
			}
		},
		'shapeToKind',
		{ subject: 'shape' },
	)
}

/**
 * Refuse a validated declaration whose compiled expansion exceeds
 * {@link COMPILE_NODE_LIMIT}.
 *
 * @remarks
 * The compilers' emitted-node bound, written once because two boundaries apply
 * it over a {@link ShapeValidatorInterface.expansion} count: the eager
 * {@link validateShapeDepth} function and the lazy {@link ContractCompiler}
 * preparation. The refusal keeps `validateShapeDepth`'s name because that gate
 * OWNS the rule and its exact diagnostic is public API — the same reason
 * `ShapeCloner` publishes the gate's depth wording rather than inventing a
 * second vocabulary for one rule. Two constructions of one refusal are two
 * messages waiting to drift apart.
 *
 * @param expansion - The node count one successful validation measured
 * @returns Nothing when the count is within the limit
 * @throws {ContractError} When the count exceeds {@link COMPILE_NODE_LIMIT}
 *
 * @example
 * ```ts
 * const validator = new ShapeValidator(shape)
 * validator.validate()
 * refuseExpansion(validator.expansion)
 * ```
 */
export function refuseExpansion(expansion: number): void {
	if (expansion <= COMPILE_NODE_LIMIT) return
	throw new ContractError('validateShapeDepth: a shape expands past the compilation node limit', {
		code: 'expansion',
		context: {
			path: [],
			limit: COMPILE_NODE_LIMIT,
			received: INTRINSICS.text(expansion),
		},
	})
}
