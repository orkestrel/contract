// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project (`setupFiles[0]`). Keep this file free of `node:*` and of
// `document` / `window` / Vue: DOM/Vue helpers live in `setupBrowser.ts`.
import type {
	AuditFault,
	ContractInterface,
	ContractShape,
	Fault,
	FaultConstraint,
	FaultKind,
	Guard,
	JSONSchema,
	JSONSchemaType,
	Result,
	SampleMemo,
	StringShape,
} from '@src/core'
import {
	andOf,
	arrayOf,
	ContractCompiler,
	arrayShape,
	attempt,
	booleanShape,
	boundsOf,
	canonicalizeValue,
	canonicalStringify,
	cloneJSONRecord,
	cloneJSONValue,
	cloneSchema,
	cloneShape,
	compileAuditor,
	compileGenerator,
	compileGuard,
	compileParser,
	compileReporter,
	compileSchema,
	complementOf,
	ContractError,
	createContract,
	drawRandom,
	enumerableKeys,
	enumerableSymbolCount,
	enumOf,
	holds,
	INFER_DEPTH_LIMIT,
	inferPrimitiveEnum,
	instanceOf,
	integerShape,
	intersectionOf,
	isArray,
	isBoundedJSONRecord,
	isBoundedJSONValue,
	isConstructor,
	isContractError,
	isDate,
	isEmptyObject,
	isEmptyString,
	isError,
	isInstance,
	isIterable,
	isJSONValue,
	isNonEmptyObject,
	isNonEmptyString,
	isNumber,
	isPromiseLike,
	isRecord,
	isRegExp,
	isString,
	isValidISOInstant,
	jsonShape,
	JSONCloner,
	keyOf,
	lazyOf,
	literalOf,
	literalShape,
	mapOf,
	matchesJSONDepth,
	matchesRecordBrand,
	matchOf,
	notOf,
	nullableOf,
	nullableShape,
	nullShape,
	numberShape,
	objectShape,
	omitOf,
	oneOfShape,
	optionalOf,
	optionalShape,
	orOf,
	ownShape,
	parseArray,
	parseArrayField,
	parseBoolean,
	parseEnum,
	parseInteger,
	parseJSON,
	parseJSONAs,
	parseJSONValue,
	parseNull,
	parseNumber,
	parseRecord,
	parseString,
	parseStringField,
	pickOf,
	preview,
	rawShape,
	readArrayEntries,
	readOptions,
	readValue,
	recordOf,
	recordShape,
	resolveField,
	samplesToFormat,
	samplesToSchema,
	sanitizeBudget,
	SchemaCloner,
	schemaToObject,
	schemaToParameters,
	schemaToShape,
	seededRandom,
	setOf,
	ShapeCloner,
	shapeToKind,
	ShapeValidator,
	stringOf,
	stringShape,
	stringToFormat,
	transformOf,
	tupleOf,
	unifySchemas,
	unionOf,
	unionShape,
	validateShapeDepth,
	valueToSchema,
	whereOf,
} from '@src/core'
import * as core from '@src/core'
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
		throw new Error('captureContractError: the operation threw a non-ContractError')
	}
	return outcome.error
}

/**
 * One caller-reachable property a terminal path must never depend on.
 *
 * @remarks
 * The membership rule is deliberately wider than "a member the intrinsic
 * already owns". A terminal path is redirectable in three ways, and an
 * instrument that models only the first cannot see the others: the caller can
 * REPLACE a member the target owns, so a later dispatch reaches the
 * replacement; the caller can POLLUTE the target with a name it does not own,
 * so an unqualified property read on an object that lacks that own key reaches
 * the caller's accessor through the prototype chain; and the name reached may
 * be a SYMBOL rather than a string, because a protocol hook such as
 * `Symbol.hasInstance` is a caller-writable member exactly as `Object.hasOwn`
 * is. `key` is therefore a `PropertyKey`: typed `string`, the whole
 * symbol-keyed population is structurally inexpressible and the corpus reports
 * green against a defect class it cannot write down. `via` names which of the
 * two installations a row exercises, because they need different installation
 * and different removal.
 */
export interface TerminalIntrinsic {
	readonly label: string
	readonly target: object
	readonly key: PropertyKey
	/** Whether the caller replaces a member the target owns or installs one it does not. */
	readonly via: 'replacement' | 'pollution'
}

/**
 * Replace one data-valued intrinsic member for a synchronous operation and
 * restore its exact own descriptor afterward.
 *
 * @remarks
 * THE shared intrinsic-redirection instrument. A caller who can reach a mutable
 * intrinsic before an engine runs can redirect every later dispatch through it,
 * so a claim of nonredirectable behavior is only evidence once that exact
 * intrinsic has been redirected under the claim. One general form replaces the
 * per-intrinsic helpers this suite previously repeated; an accessor-valued
 * intrinsic keeps its own {@link replaceStringIterator} form because a getter
 * descriptor is a different shape, not the same one renamed.
 *
 * @param target - The intrinsic holder whose member is replaced
 * @param key - The member replaced for the duration of the operation
 * @param replacement - The value installed in place of the intrinsic member
 * @param operation - Operation to execute while the replacement is installed
 * @returns The operation's exact result
 * @throws {Error} When the intrinsic descriptor is absent or cannot be replaced
 *
 * @example
 * ```ts
 * replaceIntrinsic(WeakSet.prototype, 'has', () => { throw sentinel }, () => cloner.clone())
 * ```
 */
export function replaceIntrinsic<T>(
	target: object,
	key: PropertyKey,
	replacement: unknown,
	operation: () => T,
): T {
	const descriptor = captured.descriptor(target, key)
	if (descriptor === undefined) {
		throw new Error(`replaceIntrinsic: the ${String(key)} descriptor is absent`)
	}
	if (!captured.define(target, key, { ...descriptor, value: replacement })) {
		throw new Error(`replaceIntrinsic: the ${String(key)} replacement could not be installed`)
	}
	try {
		return operation()
	} finally {
		// Restoration is unconditional and never throws: a `throw` here would
		// replace whatever the operation was already reporting, so an instrument
		// failure would masquerade as the subject's verdict.
		captured.define(target, key, descriptor)
	}
}

/**
 * Build a thrower that raises one exact caller value.
 *
 * @remarks
 * The redirection instruments install a function that must throw a value the
 * test can compare by identity. Building it here keeps every instrument and
 * suite on one thrower instead of re-declaring the same closure per call site.
 * It is deliberately a function EXPRESSION rather than an arrow: an arrow is
 * not constructible, so a redirected `globalThis.Map` reached through
 * `new Map()` would raise the host's own "not a constructor" `TypeError`
 * instead of the caller's exact value — the instrument would report a raw
 * escape that is not the one the attack actually produces, and could never
 * prove identity retention for a constructor row.
 *
 * @param sentinel - The exact value the returned function throws
 * @returns A function that always throws `sentinel`, whether called or constructed
 *
 * @example
 * ```ts
 * const sentinel = Object.freeze({ stage: 'cause' })
 * throwSentinel(sentinel)() // throws sentinel
 * ```
 */
export function throwSentinel(sentinel: unknown): () => never {
	return function (): never {
		throw sentinel
	}
}

/**
 * A caller-installed protocol hook that refuses every value.
 *
 * @remarks
 * The SILENT half of protocol-hook redirection, and the half a thrower cannot
 * express. A hook installed as `Symbol.hasInstance` does not have to throw to
 * defeat a narrowing: answering `false` for a genuine instance makes the
 * package fail to recognize its own value, and a contained `try`/`catch`
 * around the narrowing reports exactly the same answer as the honest one. A
 * corpus that only ever installs {@link throwSentinel} therefore certifies
 * containment while the denial goes unmeasured.
 *
 * @returns `false`, whatever it was asked about
 *
 * @example
 * ```ts
 * pollutePrototype(ContractError, Symbol.hasInstance, () => denyRecognition, operation)
 * ```
 */
export function denyRecognition(): boolean {
	return false
}

/**
 * The outcome an instrument's UNARMED pass reports so the armed pass alone
 * decides the sweep's verdict.
 *
 * @remarks
 * Every redirection instrument runs its operation twice — once with the
 * replacement installed and once without — and the unarmed pass has no door
 * answer to carry. Its outcome must therefore be a success the sweep ignores,
 * built once here rather than repeated as an inline literal at each sweep: five
 * copies of the same object literal is five places a later change has to find,
 * and each one needed a literal-type marker that the annotation supplies.
 *
 * @typeParam T - The value type the armed pass would have carried
 * @param value - The inert value the unarmed pass reports
 * @returns A successful `Result` carrying `value`
 *
 * @example
 * ```ts
 * redirectIntrinsic(row, sentinel, (armed) =>
 *   armed ? attempt(door.open) : createInertOutcome(undefined),
 * )
 * ```
 */
export function createInertOutcome<T>(value: T): Result<T> {
	return { success: true, value }
}

/**
 * The replaceable global constructors a terminal path may not build its own
 * working state through.
 *
 * @remarks
 * Drawn because capturing a prototype MEMBER and capturing the CONSTRUCTOR are
 * two different claims, and a corpus holding only `WeakSet.prototype.has` /
 * `.add` rows reports green for an engine that still reaches
 * `globalThis.WeakSet` — the constructor call happens before the first member
 * dispatch, so the member rows never run. `Map` and `WeakMap` sit inside the
 * same rule and were simply undrawn.
 */
export const TERMINAL_CONSTRUCTORS: readonly TerminalIntrinsic[] = Object.freeze([
	Object.freeze({
		label: 'globalThis.Map',
		target: globalThis,
		key: 'Map',
		via: 'replacement',
	}),
	Object.freeze({
		label: 'globalThis.WeakMap',
		target: globalThis,
		key: 'WeakMap',
		via: 'replacement',
	}),
	Object.freeze({
		label: 'globalThis.WeakSet',
		target: globalThis,
		key: 'WeakSet',
		via: 'replacement',
	}),
	Object.freeze({
		label: 'globalThis.Set',
		target: globalThis,
		key: 'Set',
		via: 'replacement',
	}),
])

/**
 * The symbol-keyed protocol hooks a terminal path may not dispatch through
 * unguarded.
 *
 * @remarks
 * The third hostile shape, and the one a string-keyed corpus could not write
 * down at all: a well-known symbol is a caller-writable member exactly as
 * `Object.hasOwn` is, reached implicitly by `instanceof`, by `for`/`of` and
 * array spread, by string coercion, and by `Object.prototype.toString`. Two
 * installations are drawn per hook where both exist — replacing an intrinsic
 * that owns the hook, and polluting a prototype that does not — because an
 * implicit dispatch finds a polluted `Object.prototype` exactly as an explicit
 * one does.
 */
export const TERMINAL_HOOKS: readonly TerminalIntrinsic[] = Object.freeze([
	Object.freeze({
		label: 'Array.prototype[Symbol.iterator]',
		target: Array.prototype,
		key: Symbol.iterator,
		via: 'replacement',
	}),
	Object.freeze({
		label: 'Object.prototype[Symbol.iterator]',
		target: Object.prototype,
		key: Symbol.iterator,
		via: 'pollution',
	}),
	Object.freeze({
		label: 'Object.prototype[Symbol.toPrimitive]',
		target: Object.prototype,
		key: Symbol.toPrimitive,
		via: 'pollution',
	}),
	Object.freeze({
		label: 'Object.prototype[Symbol.toStringTag]',
		target: Object.prototype,
		key: Symbol.toStringTag,
		via: 'pollution',
	}),
	Object.freeze({
		label: 'ContractError[Symbol.hasInstance]',
		target: ContractError,
		key: Symbol.hasInstance,
		via: 'pollution',
	}),
])

/**
 * Install an accessor for a property a prototype does not own, for one
 * synchronous operation, and remove it afterward.
 *
 * @remarks
 * THE prototype-pollution instrument, and the half of the redirection surface
 * {@link replaceIntrinsic} structurally cannot reach: replacement needs an
 * existing descriptor, while this attack exists precisely because there is
 * none. An unqualified `options.cause` on an internal literal that carries no
 * own `cause` is an ordinary `Get`, so it walks to `Object.prototype` — which
 * every caller can write. Refusing to run when the key is already own keeps the
 * instrument from silently degrading into a replacement that never restores the
 * original.
 *
 * @param prototype - The prototype polluted for the duration of the operation
 * @param key - The absent property name installed as an accessor
 * @param read - The getter installed for the polluted property
 * @param operation - Operation to execute while the pollution is installed
 * @returns The operation's exact result
 * @throws {Error} When the key is already own or the accessor cannot be installed
 *
 * @example
 * ```ts
 * pollutePrototype(Object.prototype, 'cause', throwSentinel(sentinel), () => cloner.clone())
 * ```
 */
export function pollutePrototype<T>(
	prototype: object,
	key: PropertyKey,
	read: () => unknown,
	operation: () => T,
): T {
	if (captured.descriptor(prototype, key) !== undefined) {
		throw new Error(
			`pollutePrototype: ${String(key)} is already own, so pollution would hide a real member`,
		)
	}
	if (!captured.define(prototype, key, { configurable: true, get: read })) {
		throw new Error(`pollutePrototype: the ${String(key)} accessor could not be installed`)
	}
	try {
		return operation()
	} finally {
		captured.remove(prototype, key)
	}
}

/**
 * A prototype pollution a caller-supplied source arms from inside its own
 * reflective trap, once the operation walking it has already begun.
 *
 * @remarks
 * The control drawn from OUTSIDE {@link TerminalIntrinsic}'s membership rule.
 * Every corpus row arms before the operation is entered and restores after, so
 * a table of rows structurally cannot express this population — and it needs no
 * replaced function at all, only one accessor installed at the moment the
 * engine first observes the source's prototype.
 *
 * @example
 * ```ts
 * const pollution = new ReentrantPollution(Object.prototype, 'cause', throwSentinel(sentinel))
 * const outcome = attempt(() => new JSONCloner(pollution.source).clone())
 * pollution.restore()
 * ```
 */
export class ReentrantPollution {
	/** JSON-readable source whose prototype observation arms the pollution. */
	readonly source: object
	readonly #prototype: object
	readonly #key: PropertyKey
	#armed = false

	/**
	 * Build the source without arming anything.
	 *
	 * @param prototype - The prototype polluted when the source is first observed
	 * @param key - The absent property name installed as an accessor
	 * @param read - The getter installed for the polluted property
	 */
	constructor(prototype: object, key: PropertyKey, read: () => unknown) {
		this.#prototype = prototype
		this.#key = key
		this.source = new Proxy(
			{ bad: read },
			{
				getPrototypeOf: (target) => {
					this.#arm(read)
					return Reflect.getPrototypeOf(target)
				},
			},
		)
	}

	/** Whether the source's prototype was observed, so the pollution armed. */
	get armed(): boolean {
		return this.#armed
	}

	/** Remove the pollution, whether or not it armed. */
	restore(): void {
		Reflect.deleteProperty(this.#prototype, this.#key)
		this.#armed = false
	}

	#arm(read: () => unknown): void {
		this.#armed = Reflect.defineProperty(this.#prototype, this.#key, {
			configurable: true,
			get: read,
		})
	}
}

/**
 * Redirect one {@link TerminalIntrinsic} to a throwing sentinel for the
 * duration of a synchronous operation.
 *
 * @remarks
 * The shared dispatcher a terminal-atomicity corpus drives, so a suite declares
 * its rows as data and never branches on `via` inline. The operation receives
 * whether the redirect actually armed, because a corpus row that silently
 * failed to install reports a clean verdict for an attack that never happened.
 *
 * @param intrinsic - The corpus row to arm
 * @param sentinel - The exact value the redirect throws
 * @param operation - Operation executed with the redirect armed, told whether it armed
 * @returns The operation's exact result
 *
 * @example
 * ```ts
 * redirectIntrinsic(row, sentinel, (armed) => ({ armed, outcome: attempt(() => cloner.clone()) }))
 * ```
 */
export function redirectIntrinsic<T>(
	intrinsic: TerminalIntrinsic,
	sentinel: unknown,
	operation: (armed: boolean) => T,
): T {
	const redirect = throwSentinel(sentinel)
	if (intrinsic.via === 'replacement') {
		return replaceIntrinsic(intrinsic.target, intrinsic.key, redirect, () =>
			operation(captured.descriptor(intrinsic.target, intrinsic.key)?.value === redirect),
		)
	}
	return pollutePrototype(intrinsic.target, intrinsic.key, redirect, () =>
		operation(captured.descriptor(intrinsic.target, intrinsic.key)?.get === redirect),
	)
}

/**
 * The reflective operations every redirection instrument performs, captured
 * while this setup module evaluates.
 *
 * @remarks
 * Probe hygiene, learned the hard way: an instrument that attacks
 * `Object.getOwnPropertyDescriptor` and then arms, observes, or restores itself
 * THROUGH `Object.getOwnPropertyDescriptor` is measuring its own redirect.
 * Worse, a failed restore leaks the replacement into every later row, so one
 * contaminated instrument reports findings for cases it never actually ran.
 * These references are read once, before any row can be armed, so an armed row
 * changes what the package under test dispatches through and nothing about what
 * the instrument does.
 */
export const captured = Object.freeze({
	descriptor: Object.getOwnPropertyDescriptor,
	define: Reflect.defineProperty,
	remove: Reflect.deleteProperty,
	names: Object.getOwnPropertyNames,
	keys: Object.keys,
	frozen: Object.isFrozen,
	freeze: Object.freeze,
	array: Array.isArray,
	set: Reflect.set,
	get: Reflect.get,
	own: Object.hasOwn,
	apply: Reflect.apply,
})

/**
 * Replaceable string-keyed members of the host intrinsics, drawn as one
 * population rather than sampled by kind.
 *
 * @remarks
 * Membership rule: *a string-keyed member of a host intrinsic object or a host
 * prototype that package code can reach by name on a path a public door
 * enters.* This is the population the earlier corpora could not express —
 * {@link TERMINAL_CONSTRUCTORS} draws only `new`-called globals and
 * {@link TERMINAL_HOOKS} only well-known symbols, so a replaced
 * `Array.prototype.filter` or `Object.freeze` was invisible to both and the
 * permanent sweep reported green against every one of them.
 *
 * Controls drawn from OUTSIDE this rule: {@link OWNED_MEMBERS}, whose members
 * belong to values this package exports rather than to a host intrinsic, and
 * {@link TERMINAL_LIES}, which is enumerated by EFFECT rather than by
 * installation site and therefore holds rows this table structurally cannot
 * carry.
 */
export const TERMINAL_MEMBERS: readonly TerminalIntrinsic[] = Object.freeze(
	[
		{
			target: Object,
			holder: 'Object',
			members: ['freeze', 'isFrozen', 'keys', 'values', 'hasOwn', 'create', 'is'],
		},
		{
			target: Object,
			holder: 'Object',
			members: ['defineProperty', 'getOwnPropertyDescriptor', 'getOwnPropertySymbols'],
		},
		{
			target: Object,
			holder: 'Object',
			members: ['getPrototypeOf', 'entries', 'assign', 'fromEntries'],
		},
		{
			target: Reflect,
			holder: 'Reflect',
			members: ['get', 'set', 'has', 'ownKeys', 'apply', 'construct', 'defineProperty'],
		},
		{
			target: Reflect,
			holder: 'Reflect',
			members: ['getOwnPropertyDescriptor', 'getPrototypeOf', 'deleteProperty'],
		},
		{
			target: Number,
			holder: 'Number',
			members: ['isFinite', 'isInteger', 'isSafeInteger', 'isNaN', 'parseFloat'],
		},
		{ target: Array, holder: 'Array', members: ['isArray', 'from', 'of'] },
		{ target: JSON, holder: 'JSON', members: ['stringify', 'parse'] },
		{
			target: Math,
			holder: 'Math',
			members: ['floor', 'ceil', 'max', 'min', 'imul', 'abs', 'round', 'trunc'],
		},
		{
			target: Array.prototype,
			holder: 'Array.prototype',
			members: ['filter', 'every', 'some', 'includes', 'map', 'slice', 'sort', 'join', 'concat'],
		},
		{
			target: Array.prototype,
			holder: 'Array.prototype',
			members: ['push', 'pop', 'shift', 'indexOf', 'find', 'findIndex', 'reduce', 'reverse'],
		},
		{
			target: Array.prototype,
			holder: 'Array.prototype',
			members: ['keys', 'values', 'entries', 'at', 'toString'],
		},
		{
			target: String.prototype,
			holder: 'String.prototype',
			members: ['slice', 'replaceAll', 'replace', 'trim', 'split', 'includes', 'startsWith'],
		},
		{
			target: String.prototype,
			holder: 'String.prototype',
			members: ['endsWith', 'padStart', 'repeat', 'charCodeAt', 'codePointAt', 'localeCompare'],
		},
		{
			target: String.prototype,
			holder: 'String.prototype',
			members: ['normalize', 'toLowerCase', 'toUpperCase', 'at'],
		},
		{ target: RegExp.prototype, holder: 'RegExp.prototype', members: ['test', 'exec', 'toString'] },
		{
			target: Map.prototype,
			holder: 'Map.prototype',
			members: ['get', 'set', 'has', 'delete', 'keys', 'values', 'entries', 'forEach'],
		},
		{
			target: Set.prototype,
			holder: 'Set.prototype',
			members: ['add', 'has', 'delete', 'values', 'entries', 'forEach'],
		},
		{ target: Date.prototype, holder: 'Date.prototype', members: ['getTime', 'valueOf'] },
		{ target: WeakSet.prototype, holder: 'WeakSet.prototype', members: ['add', 'has', 'delete'] },
		{
			target: WeakMap.prototype,
			holder: 'WeakMap.prototype',
			members: ['get', 'set', 'has', 'delete'],
		},
		{
			target: Number.prototype,
			holder: 'Number.prototype',
			members: ['toString', 'valueOf', 'toFixed'],
		},
		{
			target: Object.prototype,
			holder: 'Object.prototype',
			members: ['toString', 'valueOf', 'hasOwnProperty'],
		},
		{
			target: globalThis,
			holder: 'globalThis',
			members: ['String', 'Number', 'Boolean', 'RegExp', 'Array', 'Error', 'Date'],
		},
		// Drawn by re-reading the rule rather than the table: a STATIC of a host
		// intrinsic satisfies it exactly as a prototype member does, and `Date.now`
		// — the read a generator's default seed was taken from — sat outside every
		// group because the `globalThis` row carries the CONSTRUCTOR only.
		{ target: Date, holder: 'Date', members: ['now', 'parse', 'UTC'] },
		{ target: Number, holder: 'Number', members: ['parseInt'] },
		{ target: Object, holder: 'Object', members: ['setPrototypeOf', 'getOwnPropertyNames'] },
		{ target: Reflect, holder: 'Reflect', members: ['setPrototypeOf'] },
		{ target: Symbol, holder: 'Symbol', members: ['for'] },
	].flatMap((group) =>
		group.members.map((member) => {
			const row: TerminalIntrinsic = {
				label: `${group.holder}.${member}`,
				target: group.target,
				key: member,
				via: 'replacement',
			}
			return Object.freeze(row)
		}),
	),
)

/**
 * The retired class-static recognition corpus.
 *
 * @remarks
 * Recognition reads no `ContractError` static after the answering member was
 * removed, so reflection produced an empty risk population. Its caller-writable
 * dependencies are captured host members named by {@link TERMINAL_MEMBERS};
 * dedicated recognition proofs replace the live globals and assert the
 * captured answers instead of treating an empty class-member sweep as evidence.
 */
// No declaration follows because the empty corpus is retired rather than
// preserved as an instrument that can pass without exercising recognition.

/**
 * Caller-writable members on the PROTOTYPES of the classes this package
 * exports, derived by reflection rather than listed.
 *
 * @remarks
 * Membership rule: *a writable own member of the `prototype` of any value the
 * core barrel exports as a constructor.* A class-object static corpus cannot
 * express this population, which is exactly how a previous round moved every
 * membership read off `Set.prototype.has` and onto the `has` method of a class
 * the barrel exports, so `Vocabulary.prototype.has = () => true` reproduced the
 * defect verbatim at nineteen door groups while every corpus stayed green. A
 * public class method is dispatched through a prototype every consumer can
 * reach, so relocating an answer onto one moves the defect rather than closing
 * it, and this corpus is the standing proof that no answer lives there.
 *
 * It is deliberately NOT part of the throwing sweep: replacing
 * `JSONCloner.prototype.clone` and then calling `clone` is a caller replacing
 * the very door they invoke, which is their own arrangement rather than a
 * package defect. Its subject is the doors that must not consult these members
 * at all.
 *
 * WHAT IT ACTUALLY HOLDS, stated because a round asserted the opposite: this
 * corpus is NOT empty. It holds one row per exported plain FUNCTION — the
 * writable `constructor` on that function's `.prototype` object — and zero rows
 * for the exported CLASSES, whose prototypes are pinned during definition. The
 * claim "the population is empty, because each of those classes pins its
 * prototype" was false about the population and true only about the classes; the
 * rule draws from every exported callable, and an ordinary function's
 * `.prototype.constructor` is writable and always will be. The sweep's value is
 * unchanged and is what it always was — no door may consult any of these members
 * — but the corpus it sweeps is 213 rows, not none, and
 * `documents its own composition` in the integration suite pins both that shape
 * and that size. The size pin is the later repair: this number read 205 for a
 * round after eight more functions were exported, because the suite asserted
 * only that the corpus was non-empty and constructor-shaped, and a count nobody
 * asserts is a count that drifts.
 *
 * Control drawn from OUTSIDE this rule: {@link TERMINAL_MEMBERS}, whose holders
 * are host prototypes this package never declared, and — for the sweep itself —
 * a class declared inside the test whose method a door genuinely does consult,
 * which the sweep must NAME. An empty corpus verdict is only evidence once the
 * sweep has reported a failing one.
 */
export const OWNED_MEMBERS: readonly TerminalIntrinsic[] = Object.freeze(
	captured.names(core).flatMap((name) => {
		const exported: unknown = captured.get(core, name)
		if (typeof exported !== 'function') return []
		const prototype: unknown = captured.get(exported, 'prototype')
		if (typeof prototype !== 'object' || prototype === null) return []
		return captured.names(prototype).flatMap((member) => {
			const descriptor = captured.descriptor(prototype, member)
			if (descriptor === undefined || descriptor.writable !== true) return []
			const row: TerminalIntrinsic = {
				label: `${name}.prototype.${member}`,
				target: prototype,
				key: member,
				via: 'replacement',
			}
			return [Object.freeze(row)]
		})
	}),
)

/**
 * Replace the getter of an EXISTING accessor member for one synchronous
 * operation and restore its exact descriptor afterward.
 *
 * @remarks
 * The third redirection shape. {@link replaceIntrinsic} needs a DATA descriptor
 * — spreading an accessor descriptor and adding `value` produces a descriptor
 * the host rejects — and {@link pollutePrototype} refuses a key the target
 * already owns. `RegExp.prototype.source` and `RegExp.prototype.flags` are
 * accessors the package reads on a caller's pattern, so neither existing
 * instrument could arm against them and the whole pattern family went
 * unmeasured.
 *
 * @param target - The accessor holder whose getter is replaced
 * @param key - The accessor member replaced for the duration of the operation
 * @param read - The getter installed in place of the genuine one
 * @param operation - Operation to execute while the replacement is installed
 * @returns The operation's exact result
 * @throws {Error} When the member is absent, is not an accessor, or cannot be replaced
 *
 * @example
 * ```ts
 * replaceAccessor(RegExp.prototype, 'source', () => '.*', () => matchOf(/^a+$/)('ZZZ'))
 * ```
 */
export function replaceAccessor<T>(
	target: object,
	key: PropertyKey,
	read: () => unknown,
	operation: () => T,
): T {
	const descriptor = captured.descriptor(target, key)
	if (descriptor === undefined || descriptor.get === undefined) {
		throw new Error(`replaceAccessor: the ${String(key)} accessor is absent`)
	}
	if (!captured.define(target, key, { ...descriptor, get: read })) {
		throw new Error(`replaceAccessor: the ${String(key)} replacement could not be installed`)
	}
	try {
		return operation()
	} finally {
		captured.define(target, key, descriptor)
	}
}

/** A lying membership answer that refuses once a fixed amount of work has happened. */
export interface WorkBoundInterface {
	/** The lying answer, which throws the overflow value once the bound is passed. */
	readonly deny: () => boolean
	/** How many times the lying answer has been asked. */
	readonly count: () => number
}

/**
 * Build a work-bounded lying membership answer.
 *
 * @remarks
 * The corpus shape no existing instrument can express. Every redirection
 * instrument here presupposes that the door RETURNS — `redirectIntrinsic` and
 * `lieIntrinsic` hand back the operation's result, `fingerprintOwnership`
 * fingerprints a returned value, `contain` classifies a thrown one — so a
 * redirect whose damage is that the door never returns at all is invisible to
 * all of them, and a suite that arms one simply hangs. This makes
 * non-termination a reportable verdict: the substitute answers the lie until
 * the bound is passed and then throws a value the test can compare by identity,
 * so a door that lost its termination guarantee names itself in bounded time.
 *
 * @param limit - How many lying answers to give before refusing
 * @param overflow - The exact value thrown once the bound is passed
 * @returns The bounded lying answer and its read tally
 *
 * @example
 * ```ts
 * const bound = createWorkBound(5000, OVERFLOW)
 * replaceIntrinsic(WeakSet.prototype, 'has', bound.deny, () => cloneJSONValue(cyclic))
 * ```
 */
export function createWorkBound(limit: number, overflow: unknown): WorkBoundInterface {
	let asked = 0
	return Object.freeze({
		deny: (): boolean => {
			asked += 1
			if (asked > limit) throw overflow
			return false
		},
		count: (): number => asked,
	})
}

/**
 * One redirect that answers plausibly instead of throwing.
 *
 * @remarks
 * The fourth hostile shape, and the one enumerated by EFFECT rather than by
 * installation site. Every throwing row is decided by `thrown === sentinel`, so
 * a redirect that never throws is invisible to that criterion no matter how
 * many installation sites the table holds — `Object.freeze = (value) => value`
 * makes every cloner SUCCEED and publish a mutable graph, and the caller cannot
 * tell. `verify` is therefore the row's own fidelity question, asked of the
 * value the door actually published.
 */
export interface TerminalLie {
	readonly label: string
	readonly target: object
	readonly key: PropertyKey
	/** The plausible wrong answer installed in place of the honest member. */
	readonly substitute: unknown
	/** The control proving the substitute is live, run while the row is armed. */
	readonly control: () => boolean
}

/**
 * Redirects that lie: each answers a plausible wrong result rather than
 * throwing.
 *
 * @remarks
 * Membership rule, stated by SITE so a reviewer can say a member is MISSING from
 * it: *a member of a host intrinsic that this package either CAPTURES in
 * `INTRINSICS` or deliberately refuses to dispatch through, armed with a
 * substitute that returns a well-formed wrong answer instead of throwing.* The
 * earlier wording named only the substitute — "a redirect whose substitute
 * returns a well-formed wrong answer" — which describes every row this table
 * holds and excludes nothing, so its completeness was unfalsifiable by
 * construction. Each substitute is built from {@link captured} references, so the
 * lie is exactly the one named and not an accidental second failure.
 *
 * The limit, stated as a limit: this is a SAMPLE of that population, not an
 * enumeration of it. {@link TERMINAL_MEMBERS} draws 128 sites and this corpus
 * lies at 32; every other site is exercised only by the throwing sweep, whose
 * success criterion (`thrown === sentinel`) structurally cannot decide a
 * substitute that never throws. A green run here is evidence about the rows it
 * holds and about nothing else, and completeness is not claimed.
 *
 * Control drawn from OUTSIDE this rule: the throwing rows of
 * {@link TERMINAL_MEMBERS}, which this corpus's success criterion could never
 * decide, plus the honest baseline every fidelity sweep runs unarmed.
 */
export const TERMINAL_LIES: readonly TerminalLie[] = Object.freeze([
	Object.freeze({
		label: 'Object.freeze returns its argument unfrozen',
		target: Object,
		key: 'freeze',
		substitute: (value: unknown): unknown => value,
		control: (): boolean => !captured.frozen(Object.freeze({ probe: 1 })),
	}),
	Object.freeze({
		label: 'Object.isFrozen answers true for everything',
		target: Object,
		key: 'isFrozen',
		substitute: (): boolean => true,
		control: (): boolean => Object.isFrozen({ probe: 1 }),
	}),
	Object.freeze({
		label: 'Object.keys injects a ghost key',
		target: Object,
		key: 'keys',
		substitute: (value: object): readonly string[] => [...captured.keys(value), 'ghost'],
		control: (): boolean => Object.keys({ probe: 1 }).length === 2,
	}),
	Object.freeze({
		label: 'Object.hasOwn answers true for everything',
		target: Object,
		key: 'hasOwn',
		substitute: (): boolean => true,
		control: (): boolean => Object.hasOwn({}, 'absent'),
	}),
	Object.freeze({
		label: 'Array.isArray answers false for everything',
		target: Array,
		key: 'isArray',
		substitute: (): boolean => false,
		control: (): boolean => !Array.isArray([]),
	}),
	Object.freeze({
		label: 'Reflect.ownKeys injects a ghost key',
		target: Reflect,
		key: 'ownKeys',
		substitute: (value: object): readonly PropertyKey[] => [...captured.names(value), 'ghost'],
		control: (): boolean => Reflect.ownKeys({ probe: 1 }).length === 2,
	}),
	Object.freeze({
		label: 'Array.prototype[Symbol.iterator] injects a leading value',
		target: Array.prototype,
		key: Symbol.iterator,
		substitute: function* injectLeading(this: readonly unknown[]): Generator<unknown> {
			yield 'INJECTED'
			for (let index = 0; index < this.length; index += 1) yield this[index]
		},
		control: (): boolean => [...['real']][0] === 'INJECTED',
	}),
	Object.freeze({
		label: 'Array.prototype.every answers true for everything',
		target: Array.prototype,
		key: 'every',
		substitute: (): boolean => true,
		control: (): boolean => [1].every(() => false),
	}),
	Object.freeze({
		label: 'Number.isSafeInteger answers true for everything',
		target: Number,
		key: 'isSafeInteger',
		substitute: (): boolean => true,
		control: (): boolean => Number.isSafeInteger(Number.NaN),
	}),
	Object.freeze({
		label: 'WeakSet.prototype.has answers false for everything',
		target: WeakSet.prototype,
		key: 'has',
		substitute: (): boolean => false,
		control: (): boolean => {
			const seen = new WeakSet<object>()
			const member = {}
			seen.add(member)
			return !seen.has(member)
		},
	}),
	// Below: the rows the rule admits that the table did not draw. The first ten
	// rows were remembered, and nine of them targeted operations the package
	// CAPTURES — a corpus certifying the uncaptured surface, sampled almost
	// entirely from the captured one. Redrawing from the rule means asking which
	// substitutes return a well-formed wrong answer on a path a door publishes,
	// and that admits both halves of the working-collection population, every
	// array operation on a publication walk, and an iterator that SUBSTITUTES
	// rather than prepends.
	Object.freeze({
		label: 'Set.prototype.has answers true for everything',
		target: Set.prototype,
		key: 'has',
		substitute: (): boolean => true,
		control: (): boolean => new Set(['member']).has('absent'),
	}),
	Object.freeze({
		label: 'Set.prototype.has answers false for everything',
		target: Set.prototype,
		key: 'has',
		substitute: (): boolean => false,
		control: (): boolean => !new Set(['member']).has('member'),
	}),
	Object.freeze({
		label: 'Set.prototype.add drops every member',
		target: Set.prototype,
		key: 'add',
		substitute: function keepEmpty(this: Set<unknown>): Set<unknown> {
			return this
		},
		control: (): boolean => {
			const collected = new Set<string>()
			collected.add('member')
			return !collected.has('member')
		},
	}),
	Object.freeze({
		label: 'Map.prototype.get answers a decoy',
		target: Map.prototype,
		key: 'get',
		substitute: (): unknown => ({ type: 'DECOY' }),
		control: (): boolean => {
			const table = new Map<string, string>()
			return table.get('absent') !== undefined
		},
	}),
	Object.freeze({
		label: 'Array.prototype.map answers an injected list',
		target: Array.prototype,
		key: 'map',
		substitute: (): readonly string[] => ['INJECTED'],
		// Drawn over a string receiver on purpose. The earlier probe mapped
		// `[1, 2]` and compared the result against `'INJECTED'`, so its two operand
		// types had no overlap: the comparison the instrument's whole verdict rests
		// on was one the checker had already decided, and a control whose failing
		// verdict is decided before it runs measures nothing about the row. Both
		// facts the lie produces are asked here — the arity collapse and the
		// injected element — because an honest `map` answers `['a', 'b']` and
		// fails both.
		control: (): boolean => {
			const mapped = ['a', 'b'].map((entry) => entry)
			return mapped.length === 1 && mapped[0] === 'INJECTED'
		},
	}),
	Object.freeze({
		label: 'Array.prototype.sort empties its receiver',
		target: Array.prototype,
		key: 'sort',
		substitute: function emptyReceiver(this: unknown[]): unknown[] {
			this.length = 0
			return this
		},
		control: (): boolean => ['b', 'a'].sort().length === 0,
	}),
	Object.freeze({
		label: 'Array.prototype.slice answers an empty list',
		target: Array.prototype,
		key: 'slice',
		substitute: (): readonly unknown[] => [],
		control: (): boolean => [1, 2].slice(0, 1).length === 0,
	}),
	Object.freeze({
		label: 'Array.prototype.filter answers an empty list',
		target: Array.prototype,
		key: 'filter',
		substitute: (): readonly unknown[] => [],
		control: (): boolean => [1].filter(() => true).length === 0,
	}),
	Object.freeze({
		label: 'Array.prototype.some answers false for everything',
		target: Array.prototype,
		key: 'some',
		substitute: (): boolean => false,
		control: (): boolean => ![1].some(() => true),
	}),
	Object.freeze({
		label: 'Array.prototype.join answers injected text',
		target: Array.prototype,
		key: 'join',
		substitute: (): string => 'INJECTED',
		control: (): boolean => ['a', 'b'].join(',') === 'INJECTED',
	}),
	Object.freeze({
		label: 'Array.prototype.push drops every element',
		target: Array.prototype,
		key: 'push',
		substitute: function dropElement(this: readonly unknown[]): number {
			return this.length
		},
		control: (): boolean => {
			const collected: string[] = []
			collected.push('member')
			return collected.length === 0
		},
	}),
	Object.freeze({
		label: 'Array.prototype[Symbol.iterator] SUBSTITUTES the first entry of a pair',
		target: Array.prototype,
		key: Symbol.iterator,
		// The refinement the prepending row cannot express: same arity, same
		// positions, one substituted value. Every downstream structural check
		// still passes, so it reaches publication — this is the shape that renamed
		// a property inside a frozen snapshot published as exact.
		substitute: function* substituteFirst(this: readonly unknown[]): Generator<unknown> {
			if (this.length === 2 && typeof this[0] === 'string') {
				yield 'ghost'
				yield this[1]
				return
			}
			for (let index = 0; index < this.length; index += 1) yield this[index]
		},
		control: (): boolean => {
			const [first] = ['name', 'value']
			return first === 'ghost'
		},
	}),
	Object.freeze({
		label: 'Date.now answers a fixed instant',
		target: Date,
		key: 'now',
		substitute: (): number => 0,
		control: (): boolean => Date.now() === 0,
	}),
	Object.freeze({
		label: 'Set.prototype.delete answers true for everything',
		target: Set.prototype,
		key: 'delete',
		substitute: (): boolean => true,
		control: (): boolean => new Set<string>().delete('absent'),
	}),
	Object.freeze({
		label: 'Map.prototype.set drops every entry',
		target: Map.prototype,
		key: 'set',
		substitute: function keepEmpty(this: Map<unknown, unknown>): Map<unknown, unknown> {
			return this
		},
		control: (): boolean => {
			const table = new Map<string, string>()
			table.set('key', 'value')
			return table.get('key') === undefined
		},
	}),
	// The rows the newly captured operations admit. Each is a member the package
	// now dispatches from the table, so a corpus that did not carry it could not
	// tell a capture from a call site that still reads the live member.
	Object.freeze({
		label: 'Set.prototype.forEach visits nothing',
		target: Set.prototype,
		key: 'forEach',
		substitute: (): void => undefined,
		control: (): boolean => {
			let visits = 0
			new Set(['member']).forEach(() => {
				visits += 1
			})
			return visits === 0
		},
	}),
	Object.freeze({
		label: 'Map.prototype.forEach visits nothing',
		target: Map.prototype,
		key: 'forEach',
		substitute: (): void => undefined,
		control: (): boolean => {
			let visits = 0
			new Map([['key', 'value']]).forEach(() => {
				visits += 1
			})
			return visits === 0
		},
	}),
	Object.freeze({
		label: 'Map.prototype.has answers true for everything',
		target: Map.prototype,
		key: 'has',
		substitute: (): boolean => true,
		control: (): boolean => new Map<string, string>().has('absent'),
	}),
	Object.freeze({
		label: 'WeakSet.prototype.add drops every member',
		target: WeakSet.prototype,
		key: 'add',
		substitute: function keepEmpty(this: WeakSet<object>): WeakSet<object> {
			return this
		},
		control: (): boolean => {
			const seen = new WeakSet<object>()
			const member = {}
			seen.add(member)
			return !seen.has(member)
		},
	}),
	Object.freeze({
		label: 'RegExp.prototype.exec answers a decoy match',
		target: RegExp.prototype,
		key: 'exec',
		substitute: (): unknown => ['DECOY'],
		control: (): boolean => /^a+$/.exec('ZZZ')?.[0] === 'DECOY',
	}),
	Object.freeze({
		label: 'Date.prototype.getTime answers a fixed instant',
		target: Date.prototype,
		key: 'getTime',
		substitute: (): number => 0,
		control: (): boolean => new Date('2024-01-15').getTime() === 0,
	}),
	Object.freeze({
		label: 'Object.values injects a ghost value',
		target: Object,
		key: 'values',
		substitute: (value: object): readonly unknown[] => [...captured.keys(value), 'ghost'],
		control: (): boolean => Object.values({ probe: 1 }).length === 2,
	}),
])

/**
 * Install one {@link TerminalLie} for the duration of a synchronous operation
 * and restore the exact own descriptor afterward.
 *
 * @remarks
 * Arming, observation, and restoration all run through {@link captured}, so a
 * row that lies about reflection cannot corrupt the instrument that installed
 * it. The operation is told whether the row actually armed, because a silently
 * failed installation reports a clean fidelity verdict for an attack that never
 * happened.
 *
 * @param lie - The lying row to arm
 * @param operation - Operation executed with the lie armed, told whether it armed
 * @returns The operation's exact result
 * @throws {Error} When the member descriptor is absent
 *
 * @example
 * ```ts
 * lieIntrinsic(row, (armed) => (armed ? attempt(() => cloneShape(shape)) : undefined))
 * ```
 */
export function lieIntrinsic<T>(lie: TerminalLie, operation: (armed: boolean) => T): T {
	const descriptor = captured.descriptor(lie.target, lie.key)
	if (descriptor === undefined) {
		throw new Error(`lieIntrinsic: the ${String(lie.key)} descriptor is absent`)
	}
	const installed = captured.define(lie.target, lie.key, { ...descriptor, value: lie.substitute })
	try {
		return operation(installed && lie.control())
	} finally {
		captured.define(lie.target, lie.key, descriptor)
	}
}

/**
 * Name every row whose control answers `true` while that row is NOT armed.
 *
 * @remarks
 * Membership rule, stated because this instrument shipped without one while
 * every sibling in this file carries one: *a {@link TerminalLie} row whose
 * `control()` answers truthy while the honest member is installed.* The
 * canonical member of that population is a control spelled `() => true`.
 *
 * The other half of {@link lieIntrinsic}'s question, and the half no sweep
 * asked. Every existing check runs a control while its row IS armed and requires
 * `true`, which `() => true` satisfies forever — so an armed sweep certifies a
 * row that observes nothing, and a corpus can go inert one row at a time while
 * every verdict stays green. This runs each control against the HONEST member,
 * where the only sound answer is `false`, and collects the rows that answer
 * otherwise.
 *
 * What the pair of sweeps establishes and what it does not, stated rather than
 * implied: together they establish that a control DISCRIMINATES armed from
 * unarmed. They do not establish that it observes the substitute's BEHAVIOUR —
 * a control that merely detects that some function was installed is false
 * unarmed and true armed, so it clears both while proving nothing about the
 * package. That residual is exactly the population
 * {@link findInstallationControls} draws, and it is the control this instrument
 * needs from outside its own rule: a row this sweep can never name, which the
 * other one must.
 *
 * @param lies - The rows whose controls to exercise unarmed
 * @returns The labels of rows whose control cannot report its failing verdict
 *
 * @example
 * ```ts
 * expect(findVacuousControls(TERMINAL_LIES)).toEqual([])
 * ```
 */
export function findVacuousControls(lies: readonly TerminalLie[]): readonly string[] {
	const vacuous: string[] = []
	for (let row = 0; row < lies.length; row += 1) {
		const lie = lies[row]
		if (lie === undefined) continue
		if (lie.control()) vacuous[vacuous.length] = lie.label
	}
	return vacuous
}

/**
 * Name every row whose control reports a lie while the member behaves honestly.
 *
 * @remarks
 * Membership rule: *a {@link TerminalLie} row whose `control()` answers truthy
 * while a function that FORWARDS to the honest member is installed in its
 * place.* Identity changed, behaviour did not — so a control that observes what
 * the member DOES answers `false`, and a control that merely observes that
 * something was installed answers `true` and is named.
 *
 * This is the gap {@link findVacuousControls} structurally cannot reach. That
 * sweep's rule ranges over controls that cannot report a failing verdict; a
 * control reading `captured.descriptor(Object, 'freeze')?.value !== honest` is
 * false unarmed and true armed, so it sits outside that population entirely
 * while observing nothing about the substitute's semantics — and a row whose
 * substitute is semantically inert then passes every sweep in the file. Drawing
 * the boundary requires an observation neither sweep could make from the row
 * alone: install a member that is behaviourally identical and see whether the
 * control notices.
 *
 * Its own control comes from outside its rule too: every shipped row, whose
 * control exercises the member and must therefore stay silent here, and the
 * deliberately blind row the suite adds, which must be named.
 *
 * @param lies - The rows whose controls to exercise against a forwarding member
 * @returns The labels of rows whose control observes installation, not behaviour
 *
 * @example
 * ```ts
 * expect(findInstallationControls(TERMINAL_LIES)).toEqual([])
 * ```
 */
export function findInstallationControls(lies: readonly TerminalLie[]): readonly string[] {
	const blind: string[] = []
	for (let row = 0; row < lies.length; row += 1) {
		const lie = lies[row]
		if (lie === undefined) continue
		const descriptor = captured.descriptor(lie.target, lie.key)
		const honest: unknown = descriptor?.value
		if (descriptor === undefined || typeof honest !== 'function') {
			blind[blind.length] = lie.label
			continue
		}
		const forward = function (this: unknown, ...args: readonly unknown[]): unknown {
			return captured.apply(honest, this, args)
		}
		captured.define(lie.target, lie.key, { ...descriptor, value: forward })
		try {
			if (lie.control()) blind[blind.length] = lie.label
		} finally {
			captured.define(lie.target, lie.key, descriptor)
		}
	}
	return blind
}

/**
 * Fingerprint a published value's ownership facts through captured reflection.
 *
 * @remarks
 * The fidelity question a throwing corpus never asks: not "did anything
 * escape" but "is the value the door published still the value its contract
 * promises". Frozenness, the own-key population, and the same facts for every
 * reachable child are read through {@link captured} references, so a lying
 * `Object.keys` or `Object.isFrozen` changes what the PACKAGE saw and nothing
 * about what this fingerprint reports.
 *
 * @param value - The published value to fingerprint
 * @param ancestors - Objects on the active path, so a shared or cyclic edge
 *                    closes instead of recurring
 * @returns A stable text fingerprint of frozenness and own-key population
 *
 * @example
 * ```ts
 * expect(fingerprintOwnership(cloneShape(shape))).toBe(honest)
 * ```
 */
export function fingerprintOwnership(value: unknown, ancestors: readonly object[] = []): string {
	if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
		return typeof value === 'string' ? `"${value}"` : String(value)
	}
	for (let index = 0; index < ancestors.length; index += 1) {
		if (ancestors[index] === value) return '<edge>'
	}
	const path = [...ancestors, value]
	const names = captured.names(value)
	const parts: string[] = []
	for (let index = 0; index < names.length; index += 1) {
		const name = names[index]
		if (name === undefined || name === 'length') continue
		const descriptor = captured.descriptor(value, name)
		if (descriptor === undefined || !captured.own(descriptor, 'value')) continue
		parts[parts.length] = `${name}=${fingerprintOwnership(descriptor.value, path)}`
	}
	parts.sort()
	return `{${captured.frozen(value) ? 'frozen' : 'MUTABLE'} ${parts.join(',')}}`
}

/**
 * One public entry of the core barrel, paired with what its contract permits it
 * to publish when its path fails.
 *
 * @remarks
 * A sweep is only as wide as its door population, and a door population sampled
 * from the doors a defect already arrived through re-verifies the fix where it
 * was found. `refusal` is the axis that decides a row's verdict, so a total
 * reader and a refusing builder are judged by their own contracts rather than
 * by one blended rule.
 */
export interface PublicDoor {
	readonly label: string
	readonly open: () => unknown
	/** What the door's own contract permits it to publish on failure. */
	readonly refusal: 'coded' | 'total' | 'raw'
}

/**
 * Build the public-door registry every redirection sweep drives.
 *
 * @remarks
 * Enumerated from `src/core/index.ts` rather than sampled, and built fresh per
 * call so no door observes a value another sweep already published. Every
 * argument is constructed here, before any redirect can be armed, so a row
 * measures the door and never the fixture that fed it.
 *
 * @returns Every public door, with the refusal contract its verdict is judged by
 *
 * @example
 * ```ts
 * for (const door of publicDoors()) attempt(door.open)
 * ```
 */
export function publicDoors(): readonly PublicDoor[] {
	const shape = objectShape({
		name: stringShape({ min: 1 }),
		age: optionalShape(integerShape({ min: 0 })),
		tags: arrayShape(stringShape()),
	})
	const schema = compileSchema(shape)
	const record = { name: 'Ada', age: 36, tags: ['x'] }
	const contract = createContract(shape)
	// Fixture values a door merely consumes are built HERE, before any redirect
	// can arm: a `new Date()` or `new WeakSet()` inside a door thunk is the
	// INSTRUMENT dispatching through the member under attack, and it reports the
	// probe's own construction as the package's escape.
	const instant = new Date()
	const ancestors = new WeakSet<object>()
	const coded: ReadonlyArray<readonly [string, () => unknown]> = [
		['new ShapeCloner', () => new ShapeCloner(shape)],
		['ShapeCloner.clone', () => new ShapeCloner(shape).clone()],
		['new SchemaCloner', () => new SchemaCloner(schema)],
		['SchemaCloner.clone', () => new SchemaCloner(schema).clone()],
		['new JSONCloner', () => new JSONCloner(record)],
		['JSONCloner.clone', () => new JSONCloner(record).clone()],
		['new ShapeValidator', () => new ShapeValidator(shape)],
		['ShapeValidator.validate', () => new ShapeValidator(shape).validate()],
		['cloneShape', () => cloneShape(shape)],
		['ownShape', () => ownShape(shape)],
		['cloneSchema', () => cloneSchema(schema)],
		['cloneJSONValue', () => cloneJSONValue(record)],
		['cloneJSONRecord', () => cloneJSONRecord(record)],
		['validateShapeDepth', () => validateShapeDepth(shape)],
		['compileSchema', () => compileSchema(shape)],
		['compileGuard', () => compileGuard(shape)(record)],
		['compileParser', () => compileParser(shape)(record)],
		// Driven with AND without an explicit random source. A row that supplies
		// one can never evaluate the door's own default, and the default is where
		// the fifth shape lived: a parameter initializer runs before the body, so
		// no at-the-door boundary reaches it and no registry thunk that hands in a
		// source can see it.
		['compileGenerator', () => compileGenerator(shape, seededRandom(7))],
		['compileGenerator/default', () => compileGenerator(stringShape())],
		['compileReporter', () => compileReporter(shape, { name: 1 })],
		['compileAuditor', () => compileAuditor(shape, { name: 1 })],
		['createContract', () => createContract(shape)],
		// The lazy engine's own doors, beside the eager functions that request its
		// roots. Enumerated separately because a getter that refuses is a different
		// door from a function that refuses: the class publishes its own terminal
		// error, and a sweep that only drove `compileGuard` would never see it.
		['new ContractCompiler', () => new ContractCompiler(shape)],
		['ContractCompiler.schema', () => new ContractCompiler(shape).schema],
		['ContractCompiler.guard', () => new ContractCompiler(shape).guard(record)],
		['ContractCompiler.parser', () => new ContractCompiler(shape).parser(record)],
		['ContractCompiler.auditor', () => new ContractCompiler(shape).auditor({ name: 1 })],
		['ContractCompiler.reporter', () => new ContractCompiler(shape).reporter({ name: 1 })],
		['ContractCompiler.generator', () => new ContractCompiler(shape).generator(seededRandom(7))],
		['ContractCompiler.contract', () => new ContractCompiler(shape).contract],
		['contract.parse', () => contract.parse(record)],
		['contract.explain', () => contract.explain({ name: 1 })],
		['contract.audit', () => contract.audit({ name: 1 })],
		['contract.generate', () => contract.generate(seededRandom(7))],
		['stringShape', () => stringShape({ min: 1 })],
		['stringShape/pattern', () => stringShape({ pattern: /ab/ }).pattern],
		['numberShape', () => numberShape({ min: 0 })],
		['integerShape', () => integerShape({ min: 0 })],
		['booleanShape', () => booleanShape()],
		['nullShape', () => nullShape()],
		['jsonShape', () => jsonShape()],
		['literalShape', () => literalShape(['a', 'b'])],
		['objectShape', () => objectShape({ name: stringShape() })],
		['recordShape', () => recordShape(stringShape())],
		['arrayShape', () => arrayShape(stringShape())],
		['unionShape', () => unionShape(stringShape(), integerShape())],
		['oneOfShape', () => oneOfShape(stringShape(), nullShape())],
		['optionalShape', () => optionalShape(stringShape())],
		['nullableShape', () => nullableShape(stringShape())],
		['rawShape', () => rawShape({ type: 'string' })],
		['schemaToShape', () => schemaToShape(schema)],
		['valueToSchema', () => valueToSchema(record)],
		['samplesToSchema', () => samplesToSchema([record, record])],
		['canonicalStringify', () => canonicalStringify(record)],
		['canonicalizeValue', () => canonicalizeValue(record, ancestors)],
		// Documented `@throws {ContractError} When the JSON tree cannot be read`, so
		// its refusal contract is coded rather than total.
		['parseJSONValue', () => parseJSONValue(record)],
		['unifySchemas', () => unifySchemas([schema, schema])],
		['readOptions', () => readOptions({ min: 1 }, ['min'], 'stringShape', 'string')],
		['readValue', () => readValue(() => 1, 'probe')],
		['shapeToKind', () => shapeToKind(shape)],
		['schemaToParameters', () => schemaToParameters(schema)],
		['schemaToObject', () => schemaToObject(schema)],
		['sanitizeBudget', () => sanitizeBudget(undefined, 4)],
		['drawRandom', () => drawRandom(seededRandom(7), 'string')],
		['seededRandom', () => seededRandom(3)()],
		['enumerableSymbolCount', () => enumerableSymbolCount(record)],
		['inferPrimitiveEnum', () => inferPrimitiveEnum(['a', 'b', 'c'], 12)],
		['samplesToFormat', () => samplesToFormat(['a@b.co'])],
		// Driven with a STRING, not the record: `enumOf`'s guard short-circuits on
		// `isString(value) || isNumber(value)`, so a record argument never reaches
		// the membership read the row exists to attack. A row that arms and a row
		// that reaches are different facts.
		['enumOf', () => enumOf({ red: 'r', blue: 'b' })('r')],
		['enumOf/stranger', () => enumOf({ red: 'r', blue: 'b' })('NOT-A-MEMBER')],
		['keyOf', () => keyOf(record)('name')],
		['recordOf', () => recordOf({ name: isString })(record)],
		['literalOf', () => literalOf('a', 'b')('a')],
		['literalOf/list', () => literalOf(['a', 'b'])('a')],
		['literalOf/stranger', () => literalOf('a', 'b')('NOT-A-MEMBER')],
		['setOf', () => setOf(isString)(record)],
		['mapOf', () => mapOf(isString, isString)(record)],
		['arrayOf', () => arrayOf(isString)(record.tags)],
		['tupleOf', () => tupleOf(isString)(record.tags)],
		['pickOf', () => recordOf(pickOf({ name: isString }, ['name']))(record)],
		['omitOf', () => recordOf(omitOf({ name: isString, age: isNumber }, ['age']))(record)],
		['matchOf', () => matchOf(/a/)('a')],
		['stringOf', () => stringOf({ min: 1 })('a')],
		['boundsOf', () => boundsOf(0, 5)(1)],
		['instanceOf', () => instanceOf(Date)(instant)],
		['notOf', () => notOf(isString)(1)],
		['unionOf', () => unionOf(isString, isNumber)('a')],
		['intersectionOf', () => intersectionOf(isString)('a')],
		['lazyOf', () => lazyOf(() => isString)('a')],
		['nullableOf', () => nullableOf(isString)(null)],
		['optionalOf', () => optionalOf(isString)(undefined)],
		['whereOf', () => whereOf(isString, (value) => value.length > 0)('a')],
		['transformOf', () => transformOf(isString, (value) => value.length, isNumber)('a')],
		['andOf', () => andOf(isString, isNonEmptyString)('a')],
		['orOf', () => orOf(isString, isNumber)('a')],
		['complementOf', () => complementOf(isString, isEmptyString)('a')],
	]
	const total: ReadonlyArray<readonly [string, () => unknown]> = [
		['contract.is', () => contract.is(record)],
		['contract.schema', () => contract.schema],
		['isContractError', () => isContractError(record)],
		['isRecord', () => isRecord(record)],
		['isArray', () => isArray(record.tags)],
		['isJSONValue', () => isJSONValue(record)],
		['isBoundedJSONValue', () => isBoundedJSONValue(record)],
		['isBoundedJSONRecord', () => isBoundedJSONRecord(record)],
		['isEmptyObject', () => isEmptyObject(record)],
		['isNonEmptyObject', () => isNonEmptyObject(record)],
		['isIterable', () => isIterable(record.tags)],
		['isPromiseLike', () => isPromiseLike(record)],
		['isInstance', () => isInstance(record, Date)],
		['isDate', () => isDate(record)],
		['isRegExp', () => isRegExp(record)],
		['isError', () => isError(record)],
		['isConstructor', () => isConstructor(Date)],
		['matchesJSONDepth', () => matchesJSONDepth(record)],
		['enumerableKeys', () => enumerableKeys(record)],
		['readArrayEntries', () => readArrayEntries(record.tags)],
		['resolveField', () => resolveField(record, 'name')],
		['preview', () => preview(record)],
		['stringToFormat', () => stringToFormat('a@b.co')],
		['isValidISOInstant', () => isValidISOInstant('2024-01-15')],
		['parseArray', () => parseArray(record.tags)],
		['parseEnum', () => parseEnum('a', ['a', 'b'])],
		['parseEnum/stranger', () => parseEnum('zzz', ['a', 'b'])],
		['parseRecord', () => parseRecord(record)],
		['parseJSON', () => parseJSON('{"a":1}')],
		['parseJSONAs', () => parseJSONAs('{"a":1}', isRecord)],
		['parseString', () => parseString('a')],
		['parseNumber', () => parseNumber('1')],
		['parseInteger', () => parseInteger('1')],
		['parseBoolean', () => parseBoolean('true')],
		['parseNull', () => parseNull('null')],
		['parseStringField', () => parseStringField(record, 'name')],
		['parseArrayField', () => parseArrayField(record, 'tags')],
		['holds', () => holds(() => true)],
		['attempt', () => attempt(() => 1)],
	]
	const doors: PublicDoor[] = []
	for (let index = 0; index < coded.length; index += 1) {
		const row = coded[index]
		if (row === undefined) continue
		const door: PublicDoor = { label: row[0], open: row[1], refusal: 'coded' }
		doors[doors.length] = Object.freeze(door)
	}
	for (let index = 0; index < total.length; index += 1) {
		const row = total[index]
		if (row === undefined) continue
		const door: PublicDoor = { label: row[0], open: row[1], refusal: 'total' }
		doors[doors.length] = Object.freeze(door)
	}
	// The one door whose contract genuinely publishes the exact observed value:
	// `matchesRecordBrand` is the DIAGNOSING form and says so, so a raw escape
	// there is its documented answer rather than a leak. Naming it keeps the
	// sweep honest instead of quietly widening the rule for every other door.
	const diagnosing: PublicDoor = {
		label: 'matchesRecordBrand',
		open: () => matchesRecordBrand(record),
		refusal: 'raw',
	}
	doors[doors.length] = Object.freeze(diagnosing)
	return Object.freeze(doors)
}

/**
 * An object declaration whose property map rewrites the graph the SECOND time
 * it is enumerated.
 *
 * @remarks
 * The only instrument that can make a multi-walk door's walks disagree.
 * `createContract` gates the declaration, clones it, then gates the clone, so it
 * observes its caller's source more than once — and with a static declaration
 * the walks never differ, which is why a later walk's diagnostics can drift for a
 * whole campaign without one test noticing. A property map is the seam: its
 * enumeration is caller code that runs INSIDE the first walk, so it can hand the
 * second walk a different graph.
 *
 * @example
 * ```ts
 * const late = new LateMutation({ a: array }, () => Reflect.set(item, 'type', 'optional'))
 * captureContractError(() => createContract(late.shape)).message
 * ```
 */
export class LateMutation {
	/** The declaration to hand to a door that walks its source more than once. */
	readonly shape: ContractShape
	readonly #mutate: () => void
	#walks = 0

	/**
	 * Build the declaration without arming anything.
	 *
	 * @param properties - The property map the declaration exposes
	 * @param mutate - The rewrite applied before every enumeration after the first
	 */
	constructor(properties: Readonly<Record<string, unknown>>, mutate: () => void) {
		this.#mutate = mutate
		const source: ContractShape = JSON.parse('{"type":"object"}')
		Object.defineProperty(source, 'properties', {
			value: new Proxy(properties, { ownKeys: (target) => this.#enumerate(target) }),
			enumerable: true,
		})
		this.shape = source
	}

	/** How many times the property map has been enumerated. */
	get walks(): number {
		return this.#walks
	}

	#enumerate(target: object): ReadonlyArray<string | symbol> {
		this.#walks += 1
		if (this.#walks > 1) this.#mutate()
		return Reflect.ownKeys(target)
	}
}

/**
 * The own members ECMA-262 20.1.3 requires on every realm's `Object.prototype`
 * — the exact anchor `matchesRecordBrand` identifies a foreign realm by, and
 * therefore the exact set a prototype forgery has to carry.
 */
export const RECORD_BRAND_MEMBERS: readonly string[] = Object.freeze([
	'constructor',
	'hasOwnProperty',
	'isPrototypeOf',
	'propertyIsEnumerable',
	'toLocaleString',
	'toString',
	'valueOf',
])

/**
 * Stamp a prototype with this realm's REAL value for every mandated member it
 * does not already own, and reparent it to `null`, so it satisfies the record
 * brand the way an actual attacker would.
 *
 * @remarks
 * The forgery is faithful on purpose. Stamping the seven names with `undefined`
 * also satisfies a membership-only rule, but it is a signature: two lines
 * separate it from every genuine realm, so a corpus built on it demonstrates
 * irreducibility with fixtures a trivial tightening beats — the conclusion
 * survives and the evidence does not support it. Copying this realm's own
 * function values costs the forger nothing and leaves the brand with no
 * observable difference to test.
 *
 * @param prototype - The prototype to forge
 * @returns The same prototype, now indistinguishable from a realm's own
 * @throws {Error} When this realm's `Object.prototype` lacks a mandated function value
 *
 * @example
 * ```ts
 * forgeRecordBrand(Example.prototype)
 * matchesRecordBrand(new Example()) // true
 * ```
 */
export function forgeRecordBrand(prototype: object): object {
	Object.setPrototypeOf(prototype, null)
	for (const member of RECORD_BRAND_MEMBERS) {
		if (Object.hasOwn(prototype, member)) continue
		const genuine = Object.getOwnPropertyDescriptor(Object.prototype, member)
		if (genuine === undefined || typeof genuine.value !== 'function') {
			throw new Error(`forgeRecordBrand: ${member} is not a function on this realm's prototype`)
		}
		Object.defineProperty(prototype, member, {
			value: genuine.value,
			configurable: true,
			writable: true,
			enumerable: false,
		})
	}
	return prototype
}

/**
 * Stamp a prototype with `undefined`-valued mandated members and reparent it to
 * `null` — the cheapest forgery, retained as a named control.
 *
 * @remarks
 * Kept precisely because {@link forgeRecordBrand} no longer produces it. A
 * tightening is only evidence once something it must refuse has actually been
 * refused, and this is that something: it satisfies membership and fails the
 * function-value requirement, so it separates "the brand accepts any stamp"
 * from "the brand accepts a stamp that looks like a realm".
 *
 * @param prototype - The prototype to stamp
 * @returns The same prototype, carrying the mandated names with no values
 *
 * @example
 * ```ts
 * forgeBlankBrand(Example.prototype)
 * matchesRecordBrand(new Example()) // false
 * ```
 */
export function forgeBlankBrand(prototype: object): object {
	Object.setPrototypeOf(prototype, null)
	for (const member of RECORD_BRAND_MEMBERS) {
		if (Object.hasOwn(prototype, member)) continue
		Object.defineProperty(prototype, member, {
			value: undefined,
			configurable: true,
			writable: true,
			enumerable: false,
		})
	}
	return prototype
}

/** A structurally valid string declaration with a non-record class brand. */
export class StringDeclaration implements StringShape {
	readonly type = 'string'
	readonly min = 1
}

/**
 * A structurally valid string declaration whose class prototype is reparented
 * to `null`, so its instances satisfy the retired two-link brand test.
 */
export class NullBaseDeclaration implements StringShape {
	readonly type = 'string'
	readonly min = 1
}

// The reparenting is the whole fixture: an instance of this class has a
// non-null prototype whose own prototype is null — structurally identical to a
// plain object from another realm under a two-link brand test, and the exact
// value that laundered a class instance through every ownership door.
Object.setPrototypeOf(NullBaseDeclaration.prototype, null)

/**
 * A string declaration whose class prototype is reparented AND stamped with the
 * mandated realm members, while a live prototype method survives on it.
 *
 * @remarks
 * The residual population the record brand cannot refuse. It is not a
 * hypothetical: `escape` is still a function on every instance, so a value that
 * passes every ownership door is a genuine class instance with reachable
 * behavior — the fact the "class instances are refused" universal is false for.
 *
 * This row and its two siblings ({@link StrippedBrandDeclaration},
 * {@link createProxiedBrandDeclaration}) form a corpus whose MEMBERSHIP RULE is
 * "a prototype made to answer the seven mandated names with real functions",
 * reached by stamping or by trapping. Two controls sit outside that rule and
 * decide opposite verdicts, which is what keeps the corpus from certifying only
 * that the brand discriminates among forgeries: a record from a genuine foreign
 * realm (`createForeignPrototype` / `createForeignRecord` in `setupServer.ts`),
 * which answers the same seven names because its realm put them there and must
 * be ACCEPTED; and a null-based chain (`Object.create(Object.create(null))`),
 * which answers none of them and was never forged, and must be REFUSED.
 * {@link BlankBrandDeclaration} is the third control, drawn from inside the
 * "stamped" half but on the other side of the one distinction the brand can
 * still draw.
 */
export class ForgedBrandDeclaration implements StringShape {
	readonly type = 'string'
	readonly min = 1

	/** Reachable class behavior that survives the forgery. */
	escape(): string {
		return 'live'
	}
}

forgeRecordBrand(ForgedBrandDeclaration.prototype)

/**
 * A string declaration whose forged prototype owns EXACTLY the mandated realm
 * members, with its live behavior carried on the instance instead.
 *
 * @remarks
 * The control that decides what an own-key rule on the prototype could buy. A
 * rule requiring the prototype's own keys to be a subset of the specification's
 * set refuses {@link ForgedBrandDeclaration}, whose prototype carries `escape`
 * — and accepts this one, whose prototype carries nothing extra while `escape`
 * remains a live own function on the instance. The two differ by where the
 * attacker put one function, so a prototype own-key rule raises the forgery's
 * cost without changing what passes.
 */
export class StrippedBrandDeclaration implements StringShape {
	readonly type = 'string'
	readonly min = 1
	/** Reachable class behavior carried by the instance, not the prototype. */
	readonly escape = (): string => 'live'
}

forgeRecordBrand(StrippedBrandDeclaration.prototype)

/**
 * A string declaration whose forged prototype carries the mandated names with
 * NO values — the control the function-value rule must refuse.
 *
 * @remarks
 * The forgery corpus's membership rule is "a prototype made to answer the seven
 * mandated names". This row and the three faithful ones sit on opposite sides
 * of the one distinction the brand can still draw, so a corpus containing both
 * reports which of the two it is measuring instead of certifying a technique it
 * never varied.
 */
export class BlankBrandDeclaration implements StringShape {
	readonly type = 'string'
	readonly min = 1

	/** Reachable class behavior the blank forgery would have carried. */
	escape(): string {
		return 'live'
	}
}

forgeBlankBrand(BlankBrandDeclaration.prototype)

/**
 * A string declaration whose class prototype is left exactly as JavaScript
 * built it — the untouched control for {@link createProxiedBrandDeclaration}.
 */
export class ProxiedBrandDeclaration implements StringShape {
	readonly type = 'string'
	readonly min = 1

	/** Reachable class behavior the proxied route preserves. */
	escape(): string {
		return 'live'
	}
}

/**
 * Create a string declaration whose prototype is a `Proxy` over an UNTOUCHED
 * class prototype that answers the brand's questions as a realm would.
 *
 * @remarks
 * The cheapest route to the residual: nothing is reparented and nothing is
 * stamped, so the class keeps its real prototype chain and its real methods,
 * and the forgery costs one wrapper. It fabricates the mandated members it does
 * not own, reports `null` as its own prototype, and advertises only the
 * mandated key population.
 *
 * @returns A class instance whose prototype answers as a realm's own
 *
 * @example
 * ```ts
 * const value = createProxiedBrandDeclaration()
 * matchesRecordBrand(value) // true
 * ```
 */
export function createProxiedBrandDeclaration(): StringShape {
	const value = new ProxiedBrandDeclaration()
	Object.setPrototypeOf(
		value,
		new Proxy(ProxiedBrandDeclaration.prototype, {
			getPrototypeOf() {
				return null
			},
			getOwnPropertyDescriptor(target, key) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
				if (descriptor !== undefined) return descriptor
				if (typeof key !== 'string' || !RECORD_BRAND_MEMBERS.includes(key)) return undefined
				// The fabricated descriptor carries this realm's REAL member value,
				// for the same reason `forgeRecordBrand` stamps real functions: a
				// trap answering `undefined` is a signature, and a forgery with a
				// signature proves nothing about the forgeries that do not have one.
				return {
					value: Reflect.get(Object.prototype, key),
					configurable: true,
					writable: true,
					enumerable: false,
				}
			},
			ownKeys() {
				return [...RECORD_BRAND_MEMBERS]
			},
		}),
	)
	return value
}

/** Mutable scalar carrier used to detect forbidden RegExp coercion and retention. */
export class PatternCarrier {
	#text: string
	#count: number

	constructor(text: string) {
		this.#text = text
		this.#count = 0
	}

	/** Current scalar text represented by the carrier. */
	get text(): string {
		return this.#text
	}

	/** Number of string conversions observed. */
	get count(): number {
		return this.#count
	}

	/**
	 * Replace the represented text.
	 *
	 * @param text - Next represented text
	 */
	change(text: string): void {
		this.#text = text
	}

	/** @returns The represented text while recording the conversion */
	toString(): string {
		this.#count += 1
		return this.#text
	}
}

/** A type-correct string shape carrying one hostile RegExp scalar population. */
export class PatternFixture {
	readonly carrier: PatternCarrier
	readonly shape: StringShape
	readonly #field: 'source' | 'flags'

	constructor(field: 'source' | 'flags', accessor: boolean) {
		this.#field = field
		this.carrier = new PatternCarrier(field === 'source' ? 'a' : '')
		if (!accessor) {
			this.shape = { type: 'string', pattern: this.#pattern(false) }
			return
		}

		const shape: StringShape = { type: 'string' }
		Object.defineProperty(shape, 'pattern', {
			configurable: true,
			enumerable: true,
			get: () => this.#pattern(true),
		})
		this.shape = shape
	}

	#pattern(frozen: boolean): RegExp {
		const pattern = /a/
		Object.defineProperty(pattern, this.#field, {
			configurable: true,
			get: () => this.carrier,
		})
		return frozen ? Object.freeze(pattern) : pattern
	}
}

/**
 * A type-correct string shape whose genuine frozen `RegExp` scalars answer one
 * `source` observation each and refuse every later one.
 *
 * @remarks
 * The population that separates a capture schedule from a reread: a scalar pair
 * captured once per observed `RegExp` completes, while any routine that reads a
 * value it already captured meets the refusal and loses the deferred
 * stable-pattern diagnosis to an outer hostile-read translation.
 */
export class SingleReadPattern {
	readonly shape: StringShape
	#reads: number

	constructor(accessor: boolean) {
		this.#reads = 0
		if (!accessor) {
			this.shape = { type: 'string', pattern: this.#pattern() }
			return
		}
		const shape: StringShape = { type: 'string' }
		Object.defineProperty(shape, 'pattern', {
			configurable: true,
			enumerable: true,
			get: () => this.#pattern(),
		})
		this.shape = shape
	}

	/** Total number of `source` observations across every produced RegExp. */
	get reads(): number {
		return this.#reads
	}

	#pattern(): RegExp {
		const pattern = /a/
		let observed = 0
		Object.defineProperty(pattern, 'source', {
			configurable: true,
			get: () => {
				observed += 1
				this.#reads += 1
				if (observed > 1) throw new Error('SingleReadPattern: source was observed twice')
				return 'a'
			},
		})
		return Object.freeze(pattern)
	}
}

/** Factory callback that gives a fixture source access to its live population. */
export type RetentionFactory<TSource, TPopulation extends object> = (
	read: () => TPopulation,
) => TSource

/** Stateful caller-owned population whose retained target can be released. */
export class RetentionFixture<TSource, TPopulation extends object> {
	readonly reference: WeakRef<object>
	readonly source: TSource
	#population: TPopulation | undefined

	constructor(
		target: object,
		population: TPopulation,
		create: RetentionFactory<TSource, TPopulation>,
	) {
		this.reference = new WeakRef(target)
		this.#population = population
		this.source = create(() => this.#read())
	}

	/** Release the fixture's caller-owned population. */
	release(): void {
		this.#population = undefined
	}

	#read(): TPopulation {
		const population = this.#population
		if (population === undefined) {
			throw new Error('RetentionFixture: population was released before observation completed')
		}
		return population
	}
}

/**
 * Create a shape population for terminal working-state retention proofs.
 *
 * @param label - Large child description seed
 * @param invalid - Whether one property is an invalid structural child
 * @returns The releasable shape population
 */
export function createShapeRetention(
	label: string,
	invalid: boolean,
): RetentionFixture<ContractShape, Record<string, ContractShape>> {
	const child: ContractShape = { type: 'string', description: label.repeat(200_000) }
	const properties: Record<string, ContractShape> = { child }
	if (invalid) {
		properties.bad = { type: 'string' }
		Reflect.set(properties, 'bad', null)
	}
	return new RetentionFixture(
		child,
		properties,
		(read) =>
			new Proxy<ContractShape>(
				{ type: 'object', properties: {} },
				{
					get: (target, key, receiver) =>
						key === 'properties' ? read() : Reflect.get(target, key, receiver),
					getOwnPropertyDescriptor: (target, key) =>
						key === 'properties'
							? {
									value: read(),
									configurable: true,
									enumerable: true,
									writable: true,
								}
							: Reflect.getOwnPropertyDescriptor(target, key),
				},
			),
	)
}

/**
 * Create a union population for terminal working-state retention proofs.
 *
 * @remarks
 * The object population reaches a cloner's property map but never its variant
 * map, so it cannot observe a variant map that is left populated. A union source
 * carries its large child ONLY through the variant map, which makes the omission
 * of that one release observable on its own.
 *
 * @param label - Large variant description seed
 * @param invalid - Whether one variant is an invalid structural child
 * @returns The releasable union population
 */
export function createVariantRetention(
	label: string,
	invalid: boolean,
): RetentionFixture<ContractShape, ContractShape[]> {
	const child: ContractShape = { type: 'string', description: label.repeat(200_000) }
	const variants: ContractShape[] = [child]
	if (invalid) {
		variants.push({ type: 'string' })
		Reflect.set(variants, 1, null)
	}
	return new RetentionFixture(
		child,
		variants,
		(read) =>
			new Proxy<ContractShape>(
				{ type: 'union', variants: [] },
				{
					get: (target, key, receiver) =>
						key === 'variants' ? read() : Reflect.get(target, key, receiver),
					getOwnPropertyDescriptor: (target, key) =>
						key === 'variants'
							? {
									value: read(),
									configurable: true,
									enumerable: true,
									writable: true,
								}
							: Reflect.getOwnPropertyDescriptor(target, key),
				},
			),
	)
}

/** Schema retention fixture with its exact genuine traversal failure. */
export interface SchemaRetentionFixture {
	readonly fixture: RetentionFixture<JSONSchema, { readonly child: JSONSchema }>
	readonly reason: Error
}

/**
 * Create a schema population for terminal working-state retention proofs.
 *
 * @param label - Large child description seed
 * @param invalid - Whether enumeration advertises one failing property read
 * @returns The releasable schema population and exact failure
 */
export function createSchemaRetention(label: string, invalid: boolean): SchemaRetentionFixture {
	const child: JSONSchema = { description: label.repeat(200_000) }
	const population = { child }
	const reason = new Error(`${label} schema read`)
	const fixture = new RetentionFixture(
		child,
		population,
		(read) =>
			new Proxy<JSONSchema>(
				{},
				{
					get: (_target, key) => {
						if (key !== 'child') throw reason
						return read().child
					},
					getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
					ownKeys: () => (invalid ? ['child', 'bad'] : ['child']),
				},
			),
	)
	return { fixture, reason }
}

/**
 * Execute one synchronous operation with a replacement string-iterator getter.
 *
 * @param replacement - Getter installed for the mutable iterator property
 * @param operation - Operation to execute while the getter is installed
 * @returns The operation's exact result
 * @throws {Error} When the intrinsic descriptor is absent
 */
export function replaceStringIterator<T>(replacement: () => unknown, operation: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)
	if (descriptor === undefined) {
		throw new Error('replaceStringIterator: String.prototype iterator descriptor is absent')
	}
	if (
		!Reflect.defineProperty(String.prototype, Symbol.iterator, {
			configurable: descriptor.configurable === true,
			enumerable: descriptor.enumerable === true,
			get: replacement,
		})
	) {
		throw new Error('replaceStringIterator: replacement could not be installed')
	}
	try {
		return operation()
	} finally {
		Reflect.defineProperty(String.prototype, Symbol.iterator, descriptor)
	}
}

/**
 * Execute one synchronous operation with a replacement string-slice getter.
 *
 * @param replacement - Getter installed for the mutable slice property
 * @param operation - Operation to execute while the getter is installed
 * @returns The operation's exact result
 * @throws {Error} When the intrinsic descriptor is absent
 */
export function replaceStringSlice<T>(replacement: () => unknown, operation: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'slice')
	if (descriptor === undefined) {
		throw new Error('replaceStringSlice: String.prototype slice descriptor is absent')
	}
	if (
		!Reflect.defineProperty(String.prototype, 'slice', {
			configurable: descriptor.configurable === true,
			enumerable: descriptor.enumerable === true,
			get: replacement,
		})
	) {
		throw new Error('replaceStringSlice: replacement could not be installed')
	}
	try {
		return operation()
	} finally {
		Reflect.defineProperty(String.prototype, 'slice', descriptor)
	}
}

/**
 * Create a schema with one present-but-undefined structural keyword.
 *
 * @param keyword - Structural keyword to populate
 * @returns A schema carrying the hostile keyword through reflected mutation
 */
export function createUndefinedSchema(keyword: 'items' | 'additionalProperties'): JSONSchema {
	const schema: JSONSchema = {}
	Reflect.set(schema, keyword, undefined)
	return schema
}

/**
 * A genuine `Array` exotic object that is also a `JSONSchema`.
 *
 * @remarks
 * `Array.isArray` answers `true` for an instance because it IS an array, and an
 * instance satisfies `JSONSchema` because every keyword on that interface is
 * optional and this class declares one of them. That is the whole fixture: the
 * array-root refusal is about the root's array-ness rather than about a missing
 * keyword, and the input can be expressed without a type assertion. `declare`
 * keeps `type` a type-level member only, so an instance carries no own keyword
 * the refusal could have been reading instead.
 *
 * @example
 * ```ts
 * const root = new ArrayRootSchema()
 * root[0] = { type: 'string' }
 * Array.isArray(root) // true
 * ```
 */
export class ArrayRootSchema extends Array<JSONSchema> implements JSONSchema {
	declare readonly type?: JSONSchemaType
}

/**
 * A `SampleMemo` carried by a class instance rather than by the plain record
 * `buildSampleMemo` returns.
 *
 * @remarks
 * The control drawn from OUTSIDE the population `readSampleMemo`'s own callers
 * produce. Its rule is structural — an object whose `rows` is a real `WeakMap`
 * and whose `schemas` is a real `Map` — so a value this package never built must
 * still be accepted, and a class instance is a value no `buildSampleMemo` can
 * return.
 */
export class ClassSampleMemo implements SampleMemo {
	readonly rows: WeakMap<object, SampleMemo> = new WeakMap()
	readonly schemas: Map<string, JSONSchema> = new Map()
}

/** A generic readonly tree used by cross-module integration fixtures. */
export interface Tree<T> {
	/** Value stored at this node. */
	readonly value: T
	/** Child nodes below this node. */
	readonly children: ReadonlyArray<Tree<T>>
}

/**
 * Build a complete two-child tree from a value callback.
 *
 * @param value - Callback producing each node value
 * @param depth - Number of child levels below the root
 * @returns A complete readonly tree
 */
export function buildTree<T>(value: () => T, depth: number): Tree<T> {
	return {
		value: value(),
		children: depth <= 0 ? [] : [buildTree(value, depth - 1), buildTree(value, depth - 1)],
	}
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
 * @remarks
 * The key is a parameter because a reader only observes the keys it consumes:
 * a hostile getter on a name the reader never reads is not a hostile input at
 * all, and a fixture pinned to one name silently degrades into a benign record
 * at every door that consumes different ones.
 *
 * @param key - The property name whose getter throws
 * @returns A record whose getter for `key` throws
 *
 * @example
 * ```ts
 * const record = createThrowingGetter()
 * Reflect.get(record, 'value') // throws
 * ```
 */
export function createThrowingGetter(key = 'value'): Readonly<Record<string, unknown>> {
	const record: Record<string, unknown> = {}
	return Object.defineProperty(record, key, {
		get: throwHostileAccess,
		enumerable: true,
	})
}

/**
 * Create a JSON-readable object whose prototype inspection throws.
 *
 * @param reason - Exact value thrown by prototype inspection
 * @returns An ordinary-object Proxy hostile only to prototype inspection
 *
 * @example
 * ```ts
 * const reason = new Error('prototype read')
 * const value = createThrowingPrototype(reason)
 * Reflect.getPrototypeOf(value) // throws reason
 * ```
 */
export function createThrowingPrototype(reason: unknown): object {
	return new Proxy(
		{ b: 1, a: 2 },
		{
			getPrototypeOf() {
				throw reason
			},
		},
	)
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
 * The caller-defined method is outside the shared own-index lens. This fixture
 * proves array inference and compiled artifacts agree on the real indices even
 * when an unrelated reader advertises different values.
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
 * Build a shared-child shape DAG whose compiled expansion doubles per level.
 *
 * @remarks
 * Each level binds the SAME child node into two properties, so `levels` authored
 * object nodes over one string leaf are `levels + 1` authored nodes and
 * `2 ** (levels + 1) - 1` emitted ones. That gap is what `COMPILE_NODE_LIMIT`
 * bounds and what `ownShape` deliberately is not bounded by, so a test needs to
 * pick its level from the emitted count rather than the authored one.
 *
 * @param levels - The number of shared-child object wrappers around the leaf
 * @returns The shared-child contract shape
 *
 * @example
 * ```ts
 * buildSharedDagShape(13) // 14 authored nodes, 16383 emitted
 * ```
 */
export function buildSharedDagShape(levels: number): ContractShape {
	let shape: ContractShape = stringShape()
	for (let index = 0; index < levels; index += 1) {
		shape = objectShape({ left: shape, right: shape })
	}
	return shape
}

/** A declaration, a value graph walking it, and the tally of nodes the walk read. */
export interface CountedGraphInterface {
	/** The declaration a door compiles. */
	readonly shape: ContractShape
	/** The value a door is handed. */
	readonly value: unknown
	/** How many record nodes of the value the walk has read so far. */
	readonly count: () => number
}

/**
 * Build a counted array/record value graph and the declaration that walks it.
 *
 * @remarks
 * The bounded-work instrument. Every level is an array holding two references,
 * and each reference is a record whose one property is an accessor that tallies
 * its read — so `count()` IS the number of node visits the walk performed,
 * observable from outside the package and independent of the clock. `shared`
 * chooses whether a level's two slots hold ONE record or two distinct ones,
 * which is the only difference between the fixed population (a shared-reference
 * graph, whose visits must stay linear in the graph) and the control drawn from
 * outside it (a genuine tree, whose `2 ** (levels + 1) - 2` visits are real work
 * no memo may skip). The declaration stays a linear chain of `levels` array
 * nodes over one record node, so nothing here loads the declaration side that
 * `COMPILE_NODE_LIMIT` already bounds.
 *
 * @param levels - The number of array levels above the string leaf
 * @param shared - Whether each level's two slots hold the same record
 * @returns The declaration, the value, and its read tally
 *
 * @example
 * ```ts
 * const graph = buildCountedGraph(3, true)
 * compileGuard(graph.shape)(graph.value) // true
 * graph.count() // 3 once a walk visits each shared record once
 * ```
 */
export function buildCountedGraph(levels: number, shared: boolean): CountedGraphInterface {
	let reads = 0
	let shape: ContractShape = stringShape()
	let layer: unknown[] = []
	for (let index = 0; index < (shared ? 1 : 2 ** levels); index += 1) layer[layer.length] = 'leaf'
	for (let level = 0; level < levels; level += 1) {
		shape = arrayShape(objectShape({ inner: shape }))
		const records: unknown[] = []
		for (let index = 0; index < layer.length; index += 1) {
			const child = layer[index]
			const record: Record<string, unknown> = {}
			Object.defineProperty(record, 'inner', {
				get: () => {
					reads += 1
					return child
				},
				enumerable: true,
			})
			records[records.length] = record
		}
		const wrapped: unknown[] = []
		for (let index = 0; index < records.length; index += shared ? 1 : 2) {
			wrapped[wrapped.length] = shared
				? [records[index], records[index]]
				: [records[index], records[index + 1]]
		}
		layer = wrapped
	}
	return Object.freeze({
		shape,
		value: layer[0],
		count: (): number => reads,
	})
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

/** Hostile native-maximum sparse-array fixture with its indexed source probes. */
export interface NativeMaximumSparseArrayFixture<T> {
	/** Array-branded source advertising the native maximum length. */
	readonly value: readonly T[]
	/** Indexed descriptor and value observations attempted against the source. */
	readonly probes: readonly string[]
}

/**
 * Create an array-branded hostile source that advertises the native maximum
 * length while reflecting no indexed population.
 *
 * @remarks
 * Any indexed membership, descriptor, or value observation is recorded and
 * throws. The fixture therefore proves that a bounded consumer relies only on
 * the reflected population instead of beginning a length-driven source walk.
 *
 * @returns The hostile array and its live indexed-probe record
 *
 * @example
 * ```ts
 * const fixture = createNativeMaximumSparseArray()
 * fixture.value.length // 4294967295
 * fixture.probes // []
 * ```
 */
export function createNativeMaximumSparseArray<T>(): NativeMaximumSparseArrayFixture<T> {
	const probes: string[] = []
	const value = new Proxy<T[]>([], {
		get(target, property, receiver) {
			if (property === 'length') return 2 ** 32 - 1
			if (typeof property === 'string') {
				probes.push(`value:${property}`)
				throw new Error(`Indexed source value read: ${property}`)
			}
			return Reflect.get(target, property, receiver)
		},
		getOwnPropertyDescriptor(target, property) {
			if (typeof property === 'string' && property !== 'length') {
				probes.push(`descriptor:${property}`)
				throw new Error(`Indexed source descriptor read: ${property}`)
			}
			return Reflect.getOwnPropertyDescriptor(target, property)
		},
		has(target, property) {
			if (typeof property === 'string') {
				const index = Number(property)
				if (
					Number.isInteger(index) &&
					index >= 0 &&
					index < 2 ** 32 - 1 &&
					String(index) === property
				) {
					probes.push(`membership:${property}`)
					throw new Error(`Indexed source membership read: ${property}`)
				}
			}
			return Reflect.has(target, property)
		},
		ownKeys() {
			return ['length']
		},
	})
	return { value, probes }
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

/** Deferred declaration defect used by the validator precedence corpus. */
export type ShapeValidationDefect = 'domain' | 'cycle' | 'structure'

/**
 * Build a fresh object-shape graph carrying the requested deferred defects.
 *
 * @param order - Property insertion order for the requested defects
 * @returns A fresh caller-owned shape graph
 */
export function createShapeValidationCase(order: readonly ShapeValidationDefect[]): ContractShape {
	const root: ContractShape = { type: 'object', properties: {} }
	if (root.type !== 'object') return root
	for (const defect of order) {
		if (defect === 'domain') {
			Reflect.set(root.properties, defect, { type: 'string', min: -1 })
			continue
		}
		if (defect === 'cycle') {
			Reflect.set(root.properties, defect, root)
			continue
		}
		Reflect.set(root.properties, defect, undefined)
	}
	return root
}
//
// One factory per leaf kind, each returning every variation named in the
// dispatch — used by integration.test.ts to exercise the full primitive
// matrix and by the existing shape/compiler suites to avoid re-declaring the
// same shapes locally.

/** One shape kind's declared separation between its compiled parser's domain and its compiled guard's. */
export interface ShapeSeparation {
	/** A representative shape of this kind, legal in the position the kind permits. */
	readonly shape: ContractShape
	/** A value that shape's parser accepts and its guard rejects — absent when the domains coincide. */
	readonly witness?: unknown
}

/**
 * Exhaustive test-only evidence for every contract-shape kind's parse-versus-guard separation.
 */
export const SHAPE_SEPARATIONS: Readonly<Record<ContractShape['type'], ShapeSeparation>> =
	Object.freeze({
		string: Object.freeze({ shape: stringShape(), witness: 42 }),
		number: Object.freeze({ shape: numberShape(), witness: '42' }),
		boolean: Object.freeze({ shape: booleanShape(), witness: 'true' }),
		// Both artifacts accept only strict null; the corpus supplements rather than proves coincidence.
		null: Object.freeze({ shape: nullShape() }),
		literal: Object.freeze({ shape: literalShape(['allowed']), witness: ' allowed ' }),
		array: Object.freeze({ shape: arrayShape(integerShape()), witness: Object.freeze(['42']) }),
		object: Object.freeze({
			shape: objectShape({ value: integerShape() }),
			witness: Object.freeze({ value: 1, extra: true }),
		}),
		union: Object.freeze({
			shape: unionShape(integerShape(), booleanShape()),
			witness: '42',
		}),
		optional: Object.freeze({
			shape: objectShape({ value: optionalShape(integerShape()) }),
			witness: Object.freeze({ value: '42' }),
		}),
		nullable: Object.freeze({ shape: nullableShape(integerShape()), witness: '42' }),
		// Both artifacts delegate to isJSONValue; the corpus supplements rather than proves coincidence.
		json: Object.freeze({ shape: jsonShape() }),
		// Both artifacts accept any defined value; the corpus supplements rather than proves coincidence.
		raw: Object.freeze({ shape: rawShape({}) }),
	})

/** Every `stringShape` variation: plain, min-only, max-only, min+max, described. */
export function stringShapeVariations(): ReadonlyArray<readonly [string, ContractShape]> {
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
export function numberShapeVariations(): ReadonlyArray<readonly [string, ContractShape]> {
	return [
		['number:plain', numberShape()],
		['number:bounds', numberShape({ min: -5, max: 5 })],
		['number:integer', integerShape()],
		['number:integer-bounds', integerShape({ min: 0, max: 100 })],
		['number:fractional-bounds-nonempty', integerShape({ min: 2.2, max: 5.8 })],
	]
}

/** The single `booleanShape` variation. */
export function booleanShapeVariations(): ReadonlyArray<readonly [string, ContractShape]> {
	return [['boolean:plain', booleanShape({ description: 'a flag' })]]
}

/** The single `nullShape` variation. */
export function nullShapeVariations(): ReadonlyArray<readonly [string, ContractShape]> {
	return [['null:plain', nullShape()]]
}

/** Every `literalShape` variation: single/multi string, number, boolean, mixed, described. */
export function literalShapeVariations(): ReadonlyArray<readonly [string, ContractShape]> {
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
export function jsonShapeVariations(): ReadonlyArray<readonly [string, ContractShape]> {
	return [['json:plain', jsonShape()]]
}

/**
 * Every leaf-kind × variation pair, flattened — string, number, boolean,
 * null, literal, and json, each with every knob combination named above.
 */
export function leafShapeVariations(): ReadonlyArray<readonly [string, ContractShape]> {
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

/**
 * Build one inert `'type'` fault for a report fixture.
 *
 * @remarks
 * The smallest well-formed `Fault`, used where a test needs reports of a known
 * LENGTH rather than of a particular content — closest-variant selection, report
 * bounding, and append order. `expected` varies so two fixtures of equal length
 * remain distinguishable by identity and by value.
 *
 * @param expected - The kind the fault claims it wanted
 * @returns A fresh fault carrying an empty path and a `null` preview
 */
export function buildTypeFault(expected: FaultKind): Fault {
	return { reason: 'type', path: [], expected, received: 'null' }
}

/**
 * Project a fault report to the refinement each entry violated.
 *
 * @remarks
 * A report is a discriminated union, so reading `constraint` off every entry is
 * not type-correct. This projects the whole report instead: a `'constraint'`
 * entry yields its refinement and every other reason yields `undefined`, so an
 * expected-order assertion still fails loudly when a non-constraint fault
 * appears where a refinement was expected.
 *
 * @param faults - The report to project
 * @returns One entry per fault, in report order
 */
export function faultsToConstraints(
	faults: readonly AuditFault[],
): ReadonlyArray<FaultConstraint | undefined> {
	const constraints: Array<FaultConstraint | undefined> = []
	for (let index = 0; index < faults.length; index += 1) {
		const fault = faults[index]
		if (fault === undefined) continue
		constraints[constraints.length] = fault.reason === 'constraint' ? fault.constraint : undefined
	}
	return constraints
}

/**
 * A valid string shape node that counts how often a walk observes it.
 *
 * @remarks
 * The one field a declaration walk may read through an accessor is `pattern`, so
 * it is the only seam that can count observations of a node without making the
 * node invalid. The getter answers one frozen owned `RegExp` every time, so the
 * node passes every rule and the count reflects only how often it was LOOKED at.
 *
 * A count is meaningful only against a baseline, never on its own: compare a node
 * reached through many incoming edges with the same node reached through one.
 */
export class ObservedShape {
	readonly shape: StringShape
	#reads = 0

	constructor() {
		const shape: StringShape = { type: 'string' }
		Object.defineProperty(shape, 'pattern', {
			configurable: true,
			enumerable: true,
			get: () => {
				this.#reads += 1
				return Object.freeze(/^[a-z]+$/)
			},
		})
		this.shape = shape
	}

	/** Total reads of the observable field since the last `clear()`. */
	get reads(): number {
		return this.#reads
	}

	/** Reset the count so one fixture can measure several walks. */
	clear(): void {
		this.#reads = 0
	}
}

/**
 * Build an object shape that reaches one child through `levels` incoming edges,
 * each one nesting level deeper than the last.
 *
 * @remarks
 * The staircase is the population that separates a per-node walk from a per-edge
 * one. Reaching a shared child at a STRICTLY greater depth than before is what
 * used to force a fresh observation of it and a fresh walk of everything under
 * it, so the cost of one declaration grew with the number of positions it was
 * used in rather than with its size.
 *
 * @param child - The shape every property eventually reaches
 * @param levels - The number of incoming edges, at depths 1 through `levels`
 * @returns An object shape whose property `kN` wraps `child` in `N` array levels
 */
export function buildStaircaseShape(child: ContractShape, levels: number): ContractShape {
	const properties: Record<string, ContractShape> = {}
	for (let level = 0; level < levels; level += 1) {
		let node: ContractShape = child
		for (let step = 0; step < level; step += 1) node = { type: 'array', items: node }
		properties[`k${String(level)}`] = node
	}
	return { type: 'object', properties }
}

/**
 * A valid string shape node whose one legal accessor re-enters the package.
 *
 * @remarks
 * The only seam a caller has into a compilation in progress. Ownership invokes a
 * declaration's `pattern` getter — the documented single exception to the
 * accessor refusal — so a getter that calls back into the compiler that is
 * currently owning this declaration is the ONE reachable way to reach a
 * cross-getter reentry, and it is therefore the only honest instrument for the
 * reentry contract. The callback is supplied rather than captured so a test can
 * point it at a compiler that does not exist yet.
 *
 * @example
 * ```ts
 * const holder: { compiler?: ContractCompiler } = {}
 * const fixture = new ReentrantShape(() => holder.compiler?.schema)
 * holder.compiler = new ContractCompiler(fixture.shape)
 * ```
 */
export class ReentrantShape {
	readonly shape: StringShape
	readonly #reenter: () => unknown
	#nested: Result<unknown> | undefined
	#reads = 0

	/**
	 * Build the declaration without arming anything.
	 *
	 * @param reenter - The nested operation the first `pattern` read performs
	 */
	constructor(reenter: () => unknown) {
		this.#reenter = reenter
		const shape: StringShape = { type: 'string' }
		Object.defineProperty(shape, 'pattern', {
			configurable: true,
			enumerable: true,
			get: () => {
				this.#reads += 1
				if (this.#reads === 1) this.#nested = attempt(this.#reenter)
				return Object.freeze(/^[a-z]+$/)
			},
		})
		this.shape = shape
	}

	/** The exact outcome of the nested operation, absent until the getter ran. */
	get nested(): Result<unknown> | undefined {
		return this.#nested
	}
}

/**
 * The symbol key {@link SmuggledMember} hides its only prototype member behind.
 */
export const SMUGGLED_KEY: unique symbol = Symbol('SmuggledMember')

/**
 * A class whose prototype carries one documentable method beside an
 * undocumented one — the controlled opposite for the runtime `## Methods`
 * comparison.
 *
 * @remarks
 * A prototype reader that reports nothing looks exactly like a package whose
 * classes match their guide, so the comparison is worth nothing until the same
 * reader has been shown to report drift it must catch. This fixture is drawn
 * from INSIDE the comparison's population — a plain class with name-keyed
 * prototype methods — and its `undocumented` member is the difference the
 * reader has to surface. {@link SmuggledMember} is the control from outside
 * that population.
 */
export class DriftedMethods {
	/** The member a guide would legitimately document. */
	validate(): number {
		return 0
	}

	/** The member no guide documents, which the reader must still report. */
	undocumented(): number {
		return 1
	}
}

/**
 * A class whose only prototype member is symbol-keyed — the control drawn from
 * OUTSIDE the name-keyed population the runtime comparison walks.
 *
 * @remarks
 * `Object.getOwnPropertyNames` cannot see this member at all, so a comparison
 * built only from names certifies this class as memberless however much
 * behavior it carries. Naming that gap does not close it; the runtime suite
 * closes it with a separate own-symbol assertion, and this fixture is what
 * proves that assertion is capable of failing.
 */
export class SmuggledMember {
	/** The member the name walk is structurally unable to reach. */
	[SMUGGLED_KEY](): number {
		return 2
	}
}
