// === Result

/**
 * Discriminated success branch of a {@link Result}.
 *
 * @remarks
 * Used for operations that can succeed or fail without throwing.
 */
export interface Success<T> {
	readonly success: true
	readonly value: T
}

/**
 * Discriminated failure branch of a {@link Result}.
 *
 * @remarks
 * Carries the error value when an operation does not succeed.
 */
export interface Failure<E> {
	readonly success: false
	readonly error: E
}

/**
 * Discriminated union for operations that can succeed or fail without throwing.
 *
 * @remarks
 * The failure channel defaults to `unknown`. Operations with a guaranteed
 * domain error name that error type explicitly.
 */
export type Result<T, E = unknown> = Success<T> | Failure<E>

// === Record access

/**
 * A field path into a record: a single key, or an ordered list of keys to
 * descend through nested objects.
 *
 * @remarks
 * A single `string` is ONE key — it is never split on `.`, so keys that contain
 * dots stay safe. Use a `readonly string[]` to descend into nested objects.
 */
export type FieldPath = string | readonly string[]

// === Errors

/** Machine-readable category carried by a {@link ContractError}. */
export type ContractCode =
	/** Identifies a bound contract error. */
	| 'bound'
	/** Identifies a range contract error. */
	| 'range'
	/** Identifies an empty-value contract error. */
	| 'empty'
	/** Identifies a valid optional shape used in a forbidden position. */
	| 'placement'
	/** Identifies a corrupt shape node or structural slot. */
	| 'structure'
	/** Identifies a literal contract error. */
	| 'literal'
	/** Identifies a cycle contract error. */
	| 'cycle'
	/** Identifies a pattern contract error. */
	| 'pattern'
	/** Identifies a generation contract error. */
	| 'generate'
	/** Identifies a random-source contract error. */
	| 'random'
	/** Identifies an owned-clone contract error. */
	| 'clone'
	/** Identifies a compilation-depth contract error. */
	| 'depth'
	/** Identifies a shape whose compiled expansion exceeds the emitted-node limit. */
	| 'expansion'

/** Optional structured details carried by a {@link ContractError}. */
export interface ContractErrorContext {
	/** Location associated with the error. */
	readonly path?: FieldPath
	/** Shape label associated with the error. */
	readonly shape?: string
	/** Numeric or textual limit associated with the error. */
	readonly limit?: number | string
	/** Received-value description associated with the error. */
	readonly received?: string
}

/** Construction options for a {@link ContractError}. */
export interface ContractErrorOptions {
	/** Machine-readable error category. */
	readonly code: ContractCode
	/** Optional structured error details. */
	readonly context?: ContractErrorContext
	/** Optional originating thrown value. */
	readonly cause?: unknown
}

/** Optional diagnostic metadata for a required read. */
export interface ReadValueOptions {
	/** Argument/domain noun used in the refusal message. */
	readonly subject?: string
	/** Machine-readable refusal category. */
	readonly code?: ContractCode
	/** Structured location and domain details retained by the refusal. */
	readonly context?: ContractErrorContext
}

/**
 * Optional diagnostic metadata for a public door's containment boundary.
 *
 * @remarks
 * Deliberately narrower than {@link ReadValueOptions}: a contained door's
 * subject IS the door, so there is no `subject` to name. The two options types
 * are separate because a signature that accepts a key it silently ignores tells
 * the caller a lie the type checker will not catch.
 */
export interface ContainOptions {
	/** Machine-readable refusal category. */
	readonly code?: ContractCode
	/** Structured location and domain details retained by the refusal. */
	readonly context?: ContractErrorContext
}

/**
 * Owned result of reading one array through its reflected own-index lens.
 *
 * @remarks
 * {@link entries} is a frozen native array with actual holes: reading a hole
 * yields `undefined`, while own membership remains absent. A length-driven
 * consumer must first require {@link dense} or carry an independent work bound.
 */
export interface ArrayRead<T = unknown> {
	/** Frozen native entries in index order, retaining sparse positions as holes. */
	readonly entries: ReadonlyArray<T | undefined>
	/** Whether every index from zero through length minus one was reflected. */
	readonly dense: boolean
}

/**
 * Owned result of reading one guard shape and its optional-key mode.
 *
 * @remarks
 * A null-prototype record plus its own key list, never a `Map`: the declared-key
 * population decides a shape combinator's answer, and map lookup and map
 * iteration are caller-writable members on that path.
 */
export interface GuardShapeRead {
	/** The owned guards, keyed by their own string declaration name. */
	readonly guards: Readonly<Record<string, Guard<unknown> | undefined>>
	/** The declared names in own-key order. */
	readonly names: readonly string[]
	/** Membership of the keys the combinator treats as optional. */
	readonly optional: ReadonlySet<unknown>
	/** Membership of every declared key, for exactness checks. */
	readonly vocabulary: ReadonlySet<unknown>
}

/**
 * Derived numeric bounds pair, either member absent.
 *
 * @remarks
 * The reduced result of a JSON Schema length or range keyword pair. A malformed
 * keyword is dropped as if absent, and a contradictory pair drops both members,
 * so an absent member always widens rather than narrows.
 */
export interface BoundsRead {
	/** The derived lower bound, absent when the keyword was malformed or contradictory. */
	readonly min?: number
	/** The derived upper bound, absent when the keyword was malformed or contradictory. */
	readonly max?: number
}

/**
 * The collector a captured `forEach` sweep invokes per entry.
 *
 * @remarks
 * Both the `Set` and `Map` sweeps hand the callback `(value, key)`; a `Set`
 * passes its entry in both positions, so one collector serves both.
 */
export type EntryCollectorFunction = (value: unknown, key: unknown) => void

// === Guards

/** A runtime type guard: returns `true` when `value` satisfies `T` and narrows it. */
export type Guard<T> = (value: unknown) => value is T

/** Extract the guarded type `T` from a `Guard<T>`. */
export type GuardType<G> = G extends Guard<infer T> ? T : never

/**
 * A mapping of string keys to guards.
 *
 * @remarks
 * The shape parameter for the `recordOf`, `pickOf`, and `omitOf` combinators.
 */
export type GuardsShape = Readonly<Record<string, Guard<unknown>>>

/** Resolve a {@link GuardsShape} to a readonly object type of its guarded property types. */
export type FromGuards<G extends GuardsShape> = Readonly<{ [K in keyof G]: GuardType<G[K]> }>

/**
 * Like {@link FromGuards}, but every key listed in `K` becomes a true optional
 * member (`?`) rather than a required key widened with `| undefined`.
 *
 * @remarks
 * A key present in `K` may be omitted entirely; if present, its value must
 * still satisfy the key's guard — a present key holding `undefined` is not
 * accepted.
 *
 * @typeParam S - The full guard shape
 * @typeParam K - Tuple of keys to make optional
 */
export type OptionalFromGuards<S extends GuardsShape, K extends ReadonlyArray<keyof S>> = Readonly<
	{ [P in Exclude<keyof S, K[number]>]: FromGuards<S>[P] } & {
		[P in Extract<keyof S, K[number]>]?: FromGuards<S>[P]
	}
>

/** Map a tuple of element guards to a readonly tuple of their guarded types. */
export type TupleFromGuards<Ts extends ReadonlyArray<Guard<unknown>>> = Readonly<{
	[K in keyof Ts]: GuardType<Ts[K]>
}>

/** Convert a union type to an intersection type. */
export type UnionToIntersection<U> = (U extends unknown ? (k: U) => void : never) extends (
	k: infer I,
) => void
	? I
	: never

/** Intersection of the types guarded by a tuple of guards — backs `intersectionOf`. */
export type IntersectionFromGuards<Gs extends ReadonlyArray<Guard<unknown>>> = UnionToIntersection<
	GuardType<Gs[number]>
>

// === Parsers

/**
 * A parser: coerces an unknown value to `T`, or returns `undefined`.
 *
 * @remarks
 * The runtime parallel of {@link Guard}. A parser pairs soundly with the guard
 * for its output type: a guard-valid input is returned unchanged, and every
 * non-`undefined` output satisfies that guard.
 */
export type Parser<T> = (value: unknown) => T | undefined

// === Constructors

/**
 * Any constructor signature that produces instances of `T`.
 *
 * @remarks
 * Uses `unknown[]` parameters to stay maximally assignable from specific
 * constructors without resorting to `any`.
 */
export type AnyConstructor<T = unknown> = new (...args: unknown[]) => T

// === Functions

/** A function accepting any arguments and returning `unknown`. */
export type AnyFunction = (...args: unknown[]) => unknown

/** An async function accepting any arguments and returning a `Promise`. */
export type AnyAsyncFunction = (...args: unknown[]) => Promise<unknown>

/** A function accepting zero arguments and returning `unknown`. */
export type ZeroArgFunction = () => unknown

/** An async function accepting zero arguments and returning a `Promise`. */
export type ZeroArgAsyncFunction = () => Promise<unknown>

// === Literal values

/** A string, number, or boolean literal value. */
export type LiteralValue = string | number | boolean

// === JSON

/**
 * A primitive JSON value — the flat leaf of any JSON document.
 *
 * @remarks
 * The recursive {@link JSONValue} tree type is shipped for consumers that need a
 * reusable JSON metadata contract. {@link JSONRecord} supplies the record-root
 * contract needed by persistence and metadata consumers; a dedicated
 * `JSONArray` alias remains unnecessary because `readonly JSONValue[]` already
 * expresses that branch directly.
 */
export type JSONPrimitive = string | number | boolean | null

/**
 * A readonly string-keyed JSON object record.
 *
 * @remarks
 * Runtime ownership through
 * {@link import('./cloners.js').cloneJSONRecord} normalizes records to a frozen
 * null-prototype object after exact descriptor validation.
 *
 * @example
 * ```ts
 * const metadata: JSONRecord = { attempt: 1, labels: ['ready'] }
 * ```
 */
export type JSONRecord = { readonly [key: string]: JSONValue }

/**
 * A recursive JSON value — primitives, arrays, and object records.
 *
 * @remarks
 * The static type admits any `number` because TypeScript cannot express
 * finiteness. The {@link isJSONValue} guard rejects `NaN` and `±Infinity` since
 * they have no JSON representation.
 *
 * @example
 * ```ts
 * const value: JSONValue = { nested: [1, 'x', null] }
 * ```
 */
export type JSONValue = JSONPrimitive | readonly JSONValue[] | JSONRecord

/**
 * Stateful owner of one exact JSON snapshot operation.
 *
 * @remarks
 * Construction retains the source without observing it. The first
 * {@link clone} call settles once; later calls replay the exact same frozen
 * value or exact same owned {@link ContractError}. Terminal failure releases
 * partial traversal working state while retaining the source and exact error.
 */
export interface JSONClonerInterface {
	/**
	 * Clone the retained source into exact, deeply frozen JSON data.
	 *
	 * @returns The settled JSON snapshot
	 * @throws {ContractError} When the source is inexact, cyclic, unreadable, or cloning is reentered
	 */
	clone(): JSONValue
}

/**
 * Stateful owner of one JSON Schema snapshot operation.
 *
 * @remarks
 * Construction retains the schema without observing it. The first
 * {@link clone} call settles once; later calls replay the exact same frozen
 * schema or exact same owned {@link ContractError}. Nonredirectable terminal
 * settlement releases populated traversal state before publishing that exact
 * result, while retaining the source and result afterward.
 */
export interface SchemaClonerInterface {
	/**
	 * Clone the retained schema into a deeply frozen identity-preserving graph.
	 *
	 * @returns The settled JSON Schema snapshot
	 * @throws {ContractError} When traversal is unreadable or cloning is reentered
	 */
	clone(): JSONSchema
}

/**
 * One captured property of an object shape, held as an ordered entry rather
 * than as a `Map` pair.
 *
 * @remarks
 * The published property population of a cloned object shape is decided by
 * walking these entries. A `Map` would be the natural carrier and the wrong
 * one: iterating it dispatches through `Map.prototype[Symbol.iterator]` and
 * destructuring each pair through `Array.prototype[Symbol.iterator]`, both
 * caller-writable, and an arity-preserving substitution there renames a
 * property inside a snapshot the package publishes as exact.
 */
export interface ShapeProperty {
	/** The own enumerable key the property was captured under. */
	readonly key: string
	/** The captured child shape, absent when the declaration held no shape. */
	readonly child: ContractShape | undefined
}

/**
 * Stateful owner of one contract-shape snapshot operation.
 *
 * @remarks
 * Construction retains the shape without observing it. The first
 * {@link clone} call settles once; later calls replay the exact same frozen
 * shape or exact same owned {@link ContractError}. Nonredirectable terminal
 * settlement releases populated traversal state before publishing that exact
 * result, while retaining the source and result afterward.
 * Reentry permanently poisons the active operation with one shared error.
 */
export interface ShapeClonerInterface {
	/**
	 * Clone the retained shape into a deeply frozen identity-preserving graph.
	 *
	 * @returns The settled contract-shape snapshot
	 * @throws {ContractError} When the declaration is malformed, unreadable, cyclic, too deep, or cloning is reentered
	 */
	clone(): ContractShape
}

/** The seven standard JSON Schema `type` names. */
export type JSONSchemaType =
	| 'null'
	| 'boolean'
	| 'object'
	| 'array'
	| 'number'
	| 'integer'
	| 'string'

/**
 * A JSON Schema fragment — the supported keyword vocabulary the contract
 * compiler emits and {@link RawShape} validates before embedding.
 *
 * @remarks
 * Intentionally lean (not the full ~50-keyword vocabulary): it carries only the
 * keywords {@link Infer}-driven `compileSchema` produces, plus `format` —
 * emitted by the {@link stringToFormat} / {@link samplesToFormat} inference
 * heuristics (`valueToSchema` / `samplesToSchema`), never by `compileSchema`.
 * Recursive via `items` / `properties` / `additionalProperties` / `anyOf` /
 * `oneOf`. {@link createContract} owns and validates developer-authored shape
 * graphs; cycles and nesting past {@link COMPILE_DEPTH_LIMIT} fail with a coded
 * {@link ContractError} before artifact compilation.
 */
export interface JSONSchema {
	readonly type?: JSONSchemaType
	readonly description?: string
	readonly enum?: readonly LiteralValue[]
	readonly minLength?: number
	readonly maxLength?: number
	readonly pattern?: string
	readonly format?: string
	readonly minimum?: number
	readonly maximum?: number
	readonly minItems?: number
	readonly maxItems?: number
	readonly items?: JSONSchema
	readonly properties?: Readonly<Record<string, JSONSchema>>
	readonly required?: readonly string[]
	readonly additionalProperties?: boolean | JSONSchema
	readonly anyOf?: readonly JSONSchema[]
	readonly oneOf?: readonly JSONSchema[]
}

/**
 * The closed set of string formats {@link stringToFormat} recognizes.
 *
 * @remarks
 * Lowercase spec literals, matching the JSON Schema `format` vocabulary for
 * the subset the inferers detect: `'date-time'` / `'date'` / `'time'` are
 * ISO-8601 (validity-checked via `Date`, not pattern-only), `'uuid'` matches
 * RFC-4122 hex layout, `'email'` and `'uri'` are pragmatic (not full-spec)
 * shape checks. See {@link FORMAT_PATTERNS}.
 */
export type SchemaFormat = 'date-time' | 'date' | 'time' | 'uuid' | 'email' | 'uri'

/**
 * Options for {@link valueToSchema} / {@link samplesToSchema}.
 *
 * @remarks
 * The reverse direction of {@link compileSchema}: instead of emitting a
 * `JSONSchema` from a developer-authored `ContractShape`, these bounds tame
 * inference from an unknown runtime value (or a set of example values), which
 * — unlike a shape tree — may be arbitrarily deep, wide, or cyclic.
 *
 * @remarks
 * `format` (default `false`) emits a `format` keyword on a string leaf whose
 * value(s) unanimously match one {@link SchemaFormat} via {@link stringToFormat}
 * / {@link samplesToFormat}. `enum` (default `false`, multi-sample paths only)
 * emits an `enum` keyword for a low-cardinality, repeated primitive slot
 * instead of a bare `type`.
 */
export interface ValueToSchemaOptions {
	readonly maxDepth?: number
	readonly maxProperties?: number
	readonly closed?: boolean
	readonly format?: boolean
	readonly enum?: boolean
}

/**
 * The per-walk memo {@link inferSamples} and {@link inferRecordSamples} share,
 * keyed by the ORDERED identities of the rows a slot collected.
 *
 * @remarks
 * `rows` is one step of a prefix chain: following the slot's rows in order
 * lands on the node that owns that exact row list, so two slots collecting the
 * same rows in the same order share one entry and two slots collecting
 * different rows never do. `schemas` holds that row list's already-inferred
 * results, keyed by EVERY budget and flag the emitted schema depends on
 * (remaining depth, breadth, `closed`, `format`, `enum`) — so the memo can
 * only ever return the schema a fresh call would have produced, and two
 * ordinary calls that differ in one flag cannot be served each other's answer.
 *
 * Build one with {@link buildSampleMemo} and give it to ONE walk. It is
 * traversal state, not a cache to keep: nothing is invalidated when a sample
 * row is later mutated.
 *
 * @example
 * ```ts
 * const memo = buildSampleMemo()
 * inferSamples([{ id: 1 }], 32, 256, true, false, false, memo)
 * ```
 */
export interface SampleMemo {
	readonly rows: WeakMap<object, SampleMemo>
	readonly schemas: Map<string, JSONSchema>
}

// === Contract shapes

/**
 * A contract shape — a declarative description of a value, built with the shape
 * builders and compiled into a guard, a parser, a JSON Schema, and a generator.
 *
 * @remarks
 * A discriminated union keyed on `type`. Shapes nest (an `ArrayShape` holds an
 * element shape, an `ObjectShape` a map of them). {@link validateShapeDepth}
 * enforces an acyclic graph within {@link COMPILE_DEPTH_LIMIT}.
 */
export type ContractShape =
	| StringShape
	| NumberShape
	| BooleanShape
	| NullShape
	| LiteralShape
	| ArrayShape
	| ObjectShape
	| UnionShape
	| OptionalShape
	| NullableShape
	| JSONShape
	| RawShape

/** A string shape with optional length and pattern constraints. */
export interface StringShape {
	readonly type: 'string'
	readonly min?: number
	readonly max?: number
	/**
	 * An unflagged pattern constraint; use inline pattern constructs for flag-like behavior.
	 * Builders and cloners expose an owned fresh frozen zero-state copy per read.
	 */
	readonly pattern?: RegExp
	readonly description?: string
}

/** A numeric shape with optional bounds; `integer` restricts to whole numbers. */
export interface NumberShape {
	readonly type: 'number'
	readonly min?: number
	readonly max?: number
	readonly integer?: boolean
	readonly description?: string
}

/** A boolean shape — accepts only `true` or `false`. */
export interface BooleanShape {
	readonly type: 'boolean'
	readonly description?: string
}

/** A null shape — accepts only `null`. */
export interface NullShape {
	readonly type: 'null'
	readonly description?: string
}

/** A literal shape — accepts exactly one of a fixed set of primitive values. */
export interface LiteralShape<T extends readonly LiteralValue[] = readonly LiteralValue[]> {
	readonly type: 'literal'
	readonly values: T
	readonly description?: string
}

/** An array shape with an element shape and optional length bounds. */
export interface ArrayShape<S extends ContractShape = ContractShape> {
	readonly type: 'array'
	readonly items: S
	readonly min?: number
	readonly max?: number
	readonly description?: string
}

/**
 * An object shape — a map of property names to child shapes.
 *
 * @remarks
 * A property whose shape is an {@link OptionalShape} may be absent; all others
 * are required. `additionalProperties` controls unknown keys, and each compiled
 * artifact acts on that setting in its own way. Closed (`undefined` / `false`):
 * the compiled guard rejects the object, the compiled auditor reports one
 * `'extra'` fault at the offending key, and the emitted schema sets
 * `additionalProperties: false` — while the compiled parser drops the key and
 * the compiled reporter stays silent, mirroring that parser. `true` accepts
 * unknown keys as-is, and a `ContractShape` validates them, in every artifact.
 */
export interface ObjectShape<
	P extends Readonly<Record<string, ContractShape>> = Readonly<Record<string, ContractShape>>,
	A extends boolean | ContractShape = boolean | ContractShape,
> {
	readonly type: 'object'
	readonly properties: P
	readonly additionalProperties?: A
	readonly description?: string
}

/**
 * A union shape — accepts a value matching any one variant (first match wins).
 *
 * @remarks
 * `mode` selects the emitted JSON Schema keyword and runtime matching rule:
 * `'anyOf'` (default) accepts the first matching variant, while `'oneOf'`
 * requires exactly one variant to match.
 */
export interface UnionShape<V extends readonly ContractShape[] = readonly ContractShape[]> {
	readonly type: 'union'
	readonly variants: V
	readonly mode?: 'anyOf' | 'oneOf'
	readonly description?: string
}

/** An optional wrapper — the inner shape may be absent (`undefined`). */
export interface OptionalShape<S extends ContractShape = ContractShape> {
	readonly type: 'optional'
	readonly inner: S
}

/** A nullable wrapper — the inner shape may be `null`. */
export interface NullableShape<S extends ContractShape = ContractShape> {
	readonly type: 'nullable'
	readonly inner: S
}

/**
 * A JSON passthrough shape — accepts any JSON value.
 *
 * @remarks
 * The compiled guard is a sound {@link isJSONValue} check (rejecting cycles,
 * functions, `NaN`, and `±Infinity`); the parser gates through that guard; the
 * schema is the empty schema `{}` (matches any JSON instance); the generator
 * emits a small deterministic {@link JSONValue}. Unlike {@link RawShape}, whose
 * guard accepts every defined value, this shape validates that a value is real JSON.
 */
export interface JSONShape {
	readonly type: 'json'
	readonly description?: string
}

/**
 * A validated raw JSON Schema passthrough — embeds a supported schema fragment directly.
 *
 * @remarks
 * For values the shape DSL can't express. The fragment is checked recursively
 * against the lean {@link JSONSchema} vocabulary before it is accepted or
 * emitted; unsupported keywords and malformed keyword values throw a coded
 * {@link ContractError}. This is structural and keyword-domain validation,
 * not a full JSON Schema solver: it does not resolve cross-keyword
 * contradictions, `required`/`properties` membership, keyword/type coherence,
 * `enum`/`type` compatibility, or a closed `format` vocabulary. The compiled guard accepts every
 * top-level value except `undefined`, which is reserved as the parser failure
 * sentinel. Wrap the shape with {@link OptionalShape} to admit absence. Defined
 * values pass through unchanged, and the schema is emitted structurally
 * verbatim as an owned deeply frozen copy.
 */
export interface RawShape {
	readonly type: 'raw'
	readonly schema: JSONSchema
}

/**
 * Infer the static TypeScript type a {@link ContractShape} describes.
 *
 * @remarks
 * Structural and recursive: optional object fields surface as optional
 * properties, nullable wrappers add `| null`, and a literal tuple becomes a
 * string/number/boolean-literal union.
 *
 * The first, non-distributive branch bails out to `unknown` when `S` is the
 * full widened {@link ContractShape} union. Five members of that union recurse
 * back into the whole union through their defaulted generics, so inferring the
 * full union is a fixed point that can never shrink — the compiler would fan
 * out until it aborts with TS2589. Bailing out lazily short-circuits that
 * fixed point (the untaken branch is never instantiated) while every narrow
 * shape and every partial union still flows through the exact chain below.
 *
 * The `ObjectShape` branch's `additionalProperties` guard (`[A] extends
 * [boolean | ContractShape]`) is likewise wrapped in a tuple to stay
 * non-distributive: a naked `A extends boolean | ContractShape` distributes
 * over a union `A`, fanning a wide `additionalProperties` type into one
 * {@link InferObject} instantiation per union member instead of one
 * instantiation over the whole union — the same TS2589 risk under repeated
 * nesting. {@link InferIndex} and {@link InferOpenIndex} apply the identical
 * tuple guard to their own `A` parameter for the same reason.
 */
export type Infer<S extends ContractShape> = [ContractShape] extends [S]
	? unknown
	: S extends StringShape
		? string
		: S extends NumberShape
			? number
			: S extends BooleanShape
				? boolean
				: S extends NullShape
					? null
					: S extends { readonly type: 'literal'; readonly values: infer V }
						? V extends ReadonlyArray<infer L>
							? L
							: never
						: S extends { readonly type: 'array'; readonly items: infer I }
							? I extends ContractShape
								? ReadonlyArray<Infer<I>>
								: never
							: S extends ObjectShape<infer P, infer A>
								? P extends Readonly<Record<string, ContractShape>>
									? [A] extends [boolean | ContractShape]
										? InferObject<P, A>
										: never
									: never
								: S extends { readonly type: 'union'; readonly variants: infer V }
									? V extends readonly ContractShape[]
										? InferUnion<V>
										: never
									: S extends { readonly type: 'optional'; readonly inner: infer I }
										? I extends ContractShape
											? Infer<I> | undefined
											: never
										: S extends { readonly type: 'nullable'; readonly inner: infer I }
											? I extends ContractShape
												? Infer<I> | null
												: never
											: S extends JSONShape
												? JSONValue
												: unknown

/**
 * {@link Infer} of an object shape's `properties` — the required keys, plus the
 * `optional`-wrapped keys as optional members, plus the index-signature
 * contribution of `additionalProperties` (see {@link InferIndex}).
 *
 * @remarks
 * The `[keyof P] extends [never]` split is hoisted to the front (rather than
 * folded into the intersection's second operand) so a pure record shape
 * (`P` empty) short-circuits straight to {@link InferIndex} without ever
 * building the `Readonly<{} & {}>` intersection shell — the clean
 * `Readonly<Record<string, V>>` {@link InferIndex} already returns. A closed
 * empty object (`P` empty, `A` `false`/absent) still resolves through
 * {@link InferIndex}'s own `[A] extends [false]` branch to
 * `Readonly<Record<never, never>>`, preserving the empty-closed-object result.
 * A shape with fixed properties always routes through {@link InferOpenIndex}.
 */
export type InferObject<
	P extends Readonly<Record<string, ContractShape>>,
	A extends boolean | ContractShape = false,
> = [keyof P] extends [never]
	? [A] extends [false]
		? Readonly<Record<never, never>>
		: InferIndex<A>
	: Readonly<
			{
				[K in keyof P as P[K] extends { readonly type: 'optional' } ? never : K]: Infer<P[K]>
			} & {
				[K in keyof P as P[K] extends { readonly type: 'optional' } ? K : never]?: P[K] extends {
					readonly type: 'optional'
					readonly inner: infer I
				}
					? I extends ContractShape
						? Infer<I>
						: never
					: never
			}
		> &
			InferOpenIndex<A>

/**
 * The index-signature contribution of a pure record shape's `additionalProperties`
 * — the `recordShape` case, where `properties` is empty.
 *
 * @remarks
 * `false` (closed) contributes `unknown`, which collapses away in an
 * intersection — a closed object's {@link Infer} is unaffected. `true` (open,
 * unconstrained) contributes an `unknown`-valued index signature. A
 * {@link ContractShape} (open, constrained) contributes an index signature
 * typed to that shape's own `Infer` — sound here because there are no fixed
 * properties for the index to collide with.
 *
 * @remarks
 * The final `[A] extends [ContractShape]` guard is tuple-wrapped to stay
 * non-distributive, matching {@link Infer}'s own object-branch guard — see
 * that type's remarks for why a naked `extends` here would fan a wide `A`
 * into a union of `InferIndex` instantiations instead of one.
 */
export type InferIndex<A extends boolean | ContractShape> = [A] extends [false]
	? unknown
	: [A] extends [true]
		? { readonly [k: string]: unknown }
		: [A] extends [ContractShape]
			? { readonly [k: string]: Infer<A> }
			: unknown

/**
 * The index-signature contribution of a MIXED object shape's
 * `additionalProperties` — one with both fixed `properties` and an open tail.
 *
 * @remarks
 * A typed index (`{ readonly [k: string]: Infer<A> }`) collapses any
 * differently-typed fixed property to `never` on intersection and makes the
 * object type unconstructable — TypeScript rejects assigning any property
 * whose type differs from the index value type. So when `A` is a
 * {@link ContractShape} here, the index is deliberately widened to
 * `{ readonly [k: string]: unknown }`: the static type stops over-claiming the
 * extra-key type while the runtime guard still validates extras against `A`.
 * `false` / `true` behave exactly as {@link InferIndex}.
 *
 * @remarks
 * The final `[A] extends [ContractShape]` guard is tuple-wrapped to stay
 * non-distributive, matching {@link Infer}'s own object-branch guard and
 * {@link InferIndex}'s tail — see {@link Infer}'s remarks for why a naked
 * `extends` here would fan a wide `A` into a union of instantiations.
 */
export type InferOpenIndex<A extends boolean | ContractShape> = [A] extends [false]
	? unknown
	: [A] extends [true]
		? { readonly [k: string]: unknown }
		: [A] extends [ContractShape]
			? { readonly [k: string]: unknown }
			: unknown

/** {@link Infer} of a union shape's `variants` — the union of each variant's inferred type. */
export type InferUnion<V extends readonly ContractShape[]> =
	V extends ReadonlyArray<infer U> ? (U extends ContractShape ? Infer<U> : never) : never

/** {@link Infer} with its TOP-LEVEL `readonly` modifiers stripped (a shallow strip — nested object/array properties stay readonly) — for consumers writing the parsed value's own fields. */
export type InferMutable<S extends ContractShape> = { -readonly [K in keyof Infer<S>]: Infer<S>[K] }

// === Shape builder options

/** Options for {@link StringShape} (via `stringShape`). */
export interface StringShapeOptions {
	readonly min?: number
	readonly max?: number
	readonly pattern?: RegExp
	readonly description?: string
}

/**
 * Options for the `stringOf` guard builder.
 *
 * @remarks
 * The refinement half of {@link StringShapeOptions}: the same `min`, `max`, and
 * `pattern` members, without the `description` a shape carries for its emitted
 * schema. A guard publishes no description, so the two surfaces share the
 * refinements and nothing else.
 */
export interface StringGuardOptions {
	readonly min?: number
	readonly max?: number
	readonly pattern?: RegExp
}

/** Options for {@link NumberShape} (via `numberShape` / `integerShape`). */
export interface NumberShapeOptions {
	readonly min?: number
	readonly max?: number
	readonly integer?: boolean
	readonly description?: string
}

/** Options for {@link BooleanShape} (via `booleanShape`). */
export interface BooleanShapeOptions {
	readonly description?: string
}

/** Options for {@link NullShape} (via `nullShape`). */
export interface NullShapeOptions {
	readonly description?: string
}

/** Options for {@link JSONShape} (via `jsonShape`). */
export interface JSONShapeOptions {
	readonly description?: string
}

/** Options for {@link LiteralShape} (via `literalShape`). */
export interface LiteralShapeOptions {
	readonly description?: string
}

/** Options for {@link ArrayShape} (via `arrayShape`). */
export interface ArrayShapeOptions {
	readonly min?: number
	readonly max?: number
	readonly description?: string
}

/** Options for {@link ObjectShape} (via `objectShape`). */
export interface ObjectShapeOptions<A extends boolean | ContractShape = boolean | ContractShape> {
	readonly additionalProperties?: A
	readonly description?: string
}

/** Options for record shapes (via `recordShape`). */
export interface RecordShapeOptions {
	readonly description?: string
}

// === Contract reporting

/** The kind of value a {@link Fault} expected — the shape-projected counterpart of a `ContractShape`'s `type`. */
export type FaultKind =
	| 'string'
	| 'number'
	| 'integer'
	| 'boolean'
	| 'null'
	| 'literal'
	| 'array'
	| 'object'
	| 'union'
	| 'json'

/** The refinement a {@link Fault} of reason `'constraint'` violates. */
export type FaultConstraint = 'min' | 'max' | 'pattern' | 'integer'

/**
 * A single structured parse-failure diagnostic — one entry of an
 * {@link ContractInterface.explain} report.
 *
 * @remarks
 * A discriminated union on `reason`:
 * - `'type'` — the value could not coerce to `expected` at all.
 * - `'missing'` — a required object property was absent.
 * - `'constraint'` — the value coerced to `expected` but violated one
 *   refinement (`min` / `max` / `pattern` / `integer`); `limit` carries the
 *   violated bound/pattern when applicable.
 * - `'variant'` — an `anyOf`-mode union matched no variant; `variants` is the
 *   variant count, followed (in the report) by the closest variant's own faults.
 * - `'oneOf'` — a `oneOf`-mode union matched zero or two-or-more variants;
 *   `matched` is the raw match count.
 */
export type Fault =
	| {
			readonly reason: 'type'
			readonly path: FieldPath
			readonly expected: FaultKind
			readonly received: string
	  }
	| { readonly reason: 'missing'; readonly path: FieldPath; readonly expected: FaultKind }
	| {
			readonly reason: 'constraint'
			readonly path: FieldPath
			readonly expected: FaultKind
			readonly constraint: FaultConstraint
			readonly limit?: number | string
			readonly received: string
	  }
	| { readonly reason: 'variant'; readonly path: FieldPath; readonly variants: number }
	| { readonly reason: 'oneOf'; readonly path: FieldPath; readonly matched: number }

/** A key present on a value that its closed object shape does not declare. */
export interface ExtraFault {
	readonly reason: 'extra'
	readonly path: FieldPath
}

/** Every fault an audit reports — the parse faults plus undeclared keys. */
export type AuditFault = Fault | ExtraFault

// === Contract compilation

/** A deterministic random source returning a value in `[0, 1)`. */
export type RandomFunction = () => number

/**
 * A compiled strict-domain diagnostic — the shape of `compileAuditor` bound to
 * one shape.
 *
 * @remarks
 * The optional `path` is the prefix every fault this call reports is rooted at,
 * so a nested walk can name where it started. A contract's
 * {@link ContractInterface.audit} takes only the value, because no contract
 * consumer injects a root path; a function of this type is assignable to that
 * property, so one compiled function can serve both surfaces.
 */
export type AuditorFunction = (value: unknown, path?: readonly string[]) => readonly AuditFault[]

/**
 * A compiled coercive-domain diagnostic — the shape of `compileReporter` bound
 * to one shape.
 *
 * @remarks
 * The counterpart of {@link AuditorFunction} for the wider preimage `parse`
 * maps into the domain, with the same optional root-path prefix and the same
 * assignability to {@link ContractInterface.explain}.
 */
export type ReporterFunction = (value: unknown, path?: readonly string[]) => readonly Fault[]

/**
 * A compiled seed-data source — the shape of `compileGenerator` bound to one
 * shape.
 *
 * @remarks
 * An absent `random` selects the invocation's own wall-clock-seeded source, so
 * a generator retains no randomness between calls.
 *
 * @remarks
 * Named for the SEED DATA it produces rather than for the `generator` getter it
 * serves, which is the one place this package's three compiled-diagnostic types
 * break their own symmetry with {@link AuditorFunction} and
 * {@link ReporterFunction}. `GeneratorFunction` is already taken twice over: it
 * is a realm global (the constructor every `function*` reports), and it is the
 * exact string {@link isGeneratorFunction} compares against. Publishing a type
 * of that name beside that guard would put two contradictory meanings of one
 * word in one barrel, where `isGeneratorFunction(contract.generate)` answers
 * `false` for a value the types call a `GeneratorFunction`.
 */
export type SeederFunction<T> = (random?: RandomFunction) => T

/**
 * Validates one retained contract-shape source on demand.
 *
 * @remarks
 * Construction does not observe the source. Every {@link validate} call is an
 * independent live validation pass over its current state.
 */
export interface ShapeValidatorInterface {
	/**
	 * The number of nodes the last successful {@link validate} found the retained
	 * declaration expands into, counting one per node per incoming edge — the
	 * size of the TREE every compiled artifact would build from this DAG. `0`
	 * before the first successful pass and after a failed one.
	 */
	readonly expansion: number

	/**
	 * Validate the retained shape declaration.
	 *
	 * @returns Nothing when the declaration is valid
	 * @throws {ContractError} When the declaration is malformed, cyclic, or too deep
	 */
	validate(): void
}

/**
 * A compiled contract — the six lockstep outputs derived from one shape.
 *
 * @remarks
 * Built by `createContract`: `is` narrows, `audit` diagnoses strict rejection,
 * `parse` coerces (returning the typed value or `undefined`), `schema` is an
 * owned deeply frozen emitted JSON Schema, `explain` reports the structured
 * faults behind a failed `parse`, and `generate` produces deterministic seed
 * data from a {@link RandomFunction} (defaulting to a wall-clock-seeded source
 * when none is supplied).
 *
 * LOCKSTEP means derived from one owned snapshot of the shape, not agreeing on
 * which values to accept: `is` and `schema` describe the contract's canonical
 * domain, while `parse` is a map into that domain whose preimage is
 * deliberately larger (it coerces leaves and drops a closed object's undeclared
 * keys). `audit` diagnoses the domain; `explain` diagnoses the map.
 *
 * READ STABILITY is the precondition on both soundness laws — `audit` against
 * `is`, `explain` against `parse`. Each law relates two separate calls, and
 * every call reads the value it is handed, so both hold for a STABLE value: one
 * whose observable reads do not change between calls. A getter that answers a
 * declared string on its first read and a number on its second, or a `Proxy`
 * whose traps change behavior mid-flight, can leave `audit` empty and still
 * fail `is`; no law spanning two calls can promise otherwise, and no artifact
 * re-reads a value to close the gap. This is a statement of scope, not a hedge:
 * for primitives and data-only structures whose entire observable read surface
 * stays stable across both calls, both laws hold exactly as written.
 * `Object.freeze` alone does not establish that condition because it is shallow
 * and does not stabilize accessors.
 */
export interface ContractInterface<T> {
	readonly schema: JSONSchema
	readonly is: Guard<T>
	parse(value: unknown): T | undefined
	/**
	 * Report every strict fault a value has against this contract.
	 *
	 * @remarks
	 * An empty report means the value is strictly valid. Soundness invariant:
	 * `audit(v).length === 0` if and only if `is(v)`, for a value whose reads are
	 * stable across calls (see the read-stability precondition on
	 * {@link ContractInterface}). It is the report for the stricter of the two
	 * domains, so a coercible leaf and a closed object's undeclared key both
	 * fault here and neither faults in `explain`.
	 *
	 * @param value - The value to check
	 * @returns The faults found, empty when the value is strictly valid
	 */
	audit(value: unknown): readonly AuditFault[]
	/**
	 * Report every structured parse fault a value has against this contract.
	 *
	 * @remarks
	 * An empty report means the value is valid. Soundness invariant:
	 * `explain(v).length === 0` if and only if `parse(v) !== undefined`, for a
	 * value whose reads are stable across calls (see the read-stability
	 * precondition on {@link ContractInterface}) — explain mirrors `parse`'s
	 * coercion, not the stricter `is`, and `audit` is the report that mirrors
	 * `is`. Faults are listed in stable pre-order (declared key/index order).
	 *
	 * @param value - The value to check
	 * @returns The faults found, empty when the value parses successfully
	 */
	explain(value: unknown): readonly Fault[]
	generate(random?: RandomFunction): T
}

/**
 * Lazy owner of one contract shape's six compiled artifacts plus their bundle.
 *
 * @remarks
 * Construction observes nothing. The FIRST getter read owns the declaration
 * once, validates that owned graph once, and indexes each unique node and
 * structural edge once into children-before-parent order; every artifact family
 * is then one postorder pass over that index, so a shared child costs its
 * authored nodes rather than its paths. A getter builds its own family and no
 * other, except where an artifact genuinely consumes the compiled guard —
 * `parser`, `reporter` and `generator` resolve union membership through it, so
 * they build it too. `contract` requests all six roots in getter order.
 *
 * Every getter REPLAYS its exact artifact: reading one twice returns the same
 * function or graph by identity, and {@link contract}'s six members are those
 * exact values. One terminal lifecycle covers preparation and every family, so
 * a failure anywhere settles the compiler permanently — later getters rethrow
 * that exact error while an artifact already handed out stays usable, because
 * each one is self-contained. Cross-getter reentry (only reachable through a
 * caller accessor the declaration exposes) poisons the nested read, the
 * interrupted outer read, and every later read with one shared cause-free
 * error.
 *
 * @example
 * ```ts
 * const compiler = new ContractCompiler(stringShape({ min: 1 }))
 * compiler.guard('Ada') // true
 * ```
 */
export interface ContractCompilerInterface<S extends ContractShape> {
	/** The emitted JSON Schema, deeply frozen and shared-identity preserving. */
	readonly schema: JSONSchema
	/** The compiled strict guard. */
	readonly guard: Guard<Infer<S>>
	/** The compiled coercive parser. */
	readonly parser: Parser<Infer<S>>
	/** The compiled strict-domain diagnostic. */
	readonly auditor: AuditorFunction
	/** The compiled coercive-domain diagnostic. */
	readonly reporter: ReporterFunction
	/** The compiled seed-data source. */
	readonly generator: SeederFunction<Infer<S>>
	/** The frozen six-member bundle whose values are the six artifacts above. */
	readonly contract: ContractInterface<Infer<S>>
}
