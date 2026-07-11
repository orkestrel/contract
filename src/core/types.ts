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

/** Discriminated union for operations that can succeed or fail without throwing. */
export type Result<T, E = Error> = Success<T> | Failure<E>

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
 * Like {@link FromGuards}, but every key listed in `K` is made optional.
 *
 * @typeParam S - The full guard shape
 * @typeParam K - Tuple of keys to widen with `| undefined`
 */
export type OptionalFromGuards<S extends GuardsShape, K extends ReadonlyArray<keyof S>> = Readonly<{
	[P in keyof S]: P extends K[number] ? FromGuards<S>[P] | undefined : FromGuards<S>[P]
}>

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

// === JSON

/**
 * A primitive JSON value — the flat leaf of any JSON document.
 *
 * @remarks
 * The recursive {@link JSONValue} tree type is shipped for consumers that need a
 * reusable JSON metadata contract. Dedicated `JSONObject` / `JSONArray` aliases
 * remain unshipped; compose those narrower shapes with the combinators, or keep
 * an untrusted parse result as `unknown` and narrow it.
 */
export type JSONPrimitive = string | number | boolean | null

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
export type JSONValue = JSONPrimitive | readonly JSONValue[] | { readonly [key: string]: JSONValue }

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
 * A JSON Schema fragment — the subset of keywords the contract compiler emits
 * and {@link RawShape} embeds.
 *
 * @remarks
 * Intentionally lean (not the full ~50-keyword vocabulary): it carries only the
 * keywords {@link Infer}-driven `compileSchema` produces. Recursive via `items` /
 * `properties` / `additionalProperties` / `anyOf` / `oneOf`, but every walk is
 * over a finite, developer-authored shape — there is no cycle/depth risk.
 */
export interface JSONSchema {
	readonly type?: JSONSchemaType
	readonly description?: string
	readonly enum?: readonly (string | number | boolean)[]
	readonly minLength?: number
	readonly maxLength?: number
	readonly pattern?: string
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

// === Contract shapes

/**
 * A contract shape — a declarative description of a value, built with the shape
 * builders and compiled into a guard, a parser, a JSON Schema, and a generator.
 *
 * @remarks
 * A discriminated union keyed on `type`. Shapes nest (an `ArrayShape` holds an
 * element shape, an `ObjectShape` a map of them), so a contract is a finite,
 * developer-authored tree — never cyclic.
 */
export type ContractShape =
	| StringShape
	| NumberShape
	| BooleanShape
	| LiteralShape
	| ArrayShape
	| ObjectShape
	| UnionShape
	| OptionalShape
	| NullableShape
	| RawShape

/** A string shape with optional length and pattern constraints. */
export interface StringShape {
	readonly type: 'string'
	readonly min?: number
	readonly max?: number
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

/** A literal shape — accepts exactly one of a fixed set of primitive values. */
export interface LiteralShape {
	readonly type: 'literal'
	readonly values: readonly (string | number | boolean)[]
	readonly description?: string
}

/** An array shape with an element shape and optional length bounds. */
export interface ArrayShape {
	readonly type: 'array'
	readonly items: ContractShape
	readonly min?: number
	readonly max?: number
	readonly description?: string
}

/**
 * An object shape — a map of property names to child shapes.
 *
 * @remarks
 * A property whose shape is an {@link OptionalShape} may be absent; all others
 * are required. `additionalProperties` controls unknown keys: `undefined` /
 * `false` rejects them (closed), `true` accepts them as-is, a `ContractShape`
 * validates them.
 */
export interface ObjectShape {
	readonly type: 'object'
	readonly properties: Readonly<Record<string, ContractShape>>
	readonly additionalProperties?: boolean | ContractShape
	readonly description?: string
}

/**
 * A union shape — accepts a value matching any one variant (first match wins).
 *
 * @remarks
 * `mode` selects the emitted JSON Schema keyword: `'anyOf'` (default) or
 * `'oneOf'`. Runtime behavior is identical.
 */
export interface UnionShape {
	readonly type: 'union'
	readonly variants: readonly ContractShape[]
	readonly mode?: 'anyOf' | 'oneOf'
	readonly description?: string
}

/** An optional wrapper — the inner shape may be absent (`undefined`). */
export interface OptionalShape {
	readonly type: 'optional'
	readonly inner: ContractShape
}

/** A nullable wrapper — the inner shape may be `null`. */
export interface NullableShape {
	readonly type: 'nullable'
	readonly inner: ContractShape
}

/**
 * A raw JSON Schema passthrough — embeds a schema fragment directly.
 *
 * @remarks
 * For values the shape DSL can't express. The compiled guard accepts any value
 * and the parser passes it through unchanged; the schema is emitted verbatim.
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
 */
export type Infer<S extends ContractShape> = S extends StringShape
	? string
	: S extends NumberShape
		? number
		: S extends BooleanShape
			? boolean
			: S extends { readonly type: 'literal'; readonly values: infer V }
				? V extends readonly (infer L)[]
					? L
					: never
				: S extends { readonly type: 'array'; readonly items: infer I }
					? I extends ContractShape
						? readonly Infer<I>[]
						: never
					: S extends { readonly type: 'object'; readonly properties: infer P }
						? P extends Readonly<Record<string, ContractShape>>
							? InferObject<P>
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
									: unknown

/**
 * {@link Infer} of an object shape's `properties` — the required keys, plus the
 * `optional`-wrapped keys as optional members.
 */
export type InferObject<P extends Readonly<Record<string, ContractShape>>> = Readonly<
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
>

/** {@link Infer} of a union shape's `variants` — the union of each variant's inferred type. */
export type InferUnion<V extends readonly ContractShape[]> = V extends readonly (infer U)[]
	? U extends ContractShape
		? Infer<U>
		: never
	: never

// === Shape builder options

/** Options for {@link StringShape} (via `stringShape`). */
export interface StringShapeOptions {
	readonly min?: number
	readonly max?: number
	readonly pattern?: RegExp
	readonly description?: string
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

/** Options for {@link ArrayShape} (via `arrayShape`). */
export interface ArrayShapeOptions {
	readonly min?: number
	readonly max?: number
	readonly description?: string
}

/** Options for {@link ObjectShape} (via `objectShape`). */
export interface ObjectShapeOptions {
	readonly additionalProperties?: boolean | ContractShape
	readonly description?: string
}

// === Contract compilation

/** A deterministic random source returning a value in `[0, 1)`. */
export type RandomFunction = () => number

/**
 * A compiled contract — the four lockstep outputs derived from one shape.
 *
 * @remarks
 * Built by `createContract`: `is` narrows, `parse` coerces (returning the typed
 * value or `undefined`), `schema` is the emitted JSON Schema, and `generate`
 * produces deterministic seed data from a {@link RandomFunction} (defaulting to
 * a wall-clock-seeded source when none is supplied).
 */
export interface ContractInterface<T> {
	readonly schema: JSONSchema
	readonly is: Guard<T>
	parse(value: unknown): T | undefined
	generate(random?: RandomFunction): T
}
