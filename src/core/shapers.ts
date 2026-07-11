import type {
	ArrayShape,
	ArrayShapeOptions,
	BooleanShape,
	BooleanShapeOptions,
	ContractShape,
	JSONSchema,
	JSONShape,
	JSONShapeOptions,
	LiteralShape,
	LiteralShapeOptions,
	NullableShape,
	NullShape,
	NullShapeOptions,
	NumberShape,
	NumberShapeOptions,
	ObjectShape,
	ObjectShapeOptions,
	OptionalShape,
	RawShape,
	RecordShapeOptions,
	StringShape,
	StringShapeOptions,
	UnionShape,
} from './types.js'

// The builders return the parameterized types.ts interfaces (e.g. `ArrayShape<S>`,
// `ObjectShape<P>`), never inline object literals — the generic parameter keeps
// `Infer<typeof shape>` exact while the return type still enforces conformance to
// the shared shape interface.

// Shape builders — pure constructors for the `ContractShape` union. Each returns
// a plain descriptor; the compilers (compilers.ts) turn it into a guard, parser,
// schema, and generator. The precise return types (e.g. literal tuples, generic
// `items` / `properties`) are preserved so `Infer<typeof shape>` stays exact.

// === Primitives

/**
 * Build a string {@link StringShape}.
 *
 * @param options - Optional length (`min` / `max`), `pattern`, and `description`
 * @returns A string shape
 *
 * @example
 * ```ts
 * const name = stringShape({ min: 1, max: 80, description: 'Display name' })
 * ```
 */
export function stringShape(options?: StringShapeOptions): StringShape {
	return {
		type: 'string',
		min: options?.min,
		max: options?.max,
		pattern: options?.pattern,
		description: options?.description,
	}
}

/**
 * Build a numeric {@link NumberShape}.
 *
 * @param options - Optional bounds (`min` / `max`), `integer`, and `description`
 * @returns A number shape
 */
export function numberShape(options?: NumberShapeOptions): NumberShape {
	return {
		type: 'number',
		min: options?.min,
		max: options?.max,
		integer: options?.integer,
		description: options?.description,
	}
}

/**
 * Build an integer {@link NumberShape} — forces `integer: true`.
 *
 * @remarks
 * The emitted JSON Schema uses `"type": "integer"` and the guard rejects
 * fractional numbers.
 *
 * @param options - Optional bounds and `description` (no `integer` key)
 * @returns An integer number shape
 */
export function integerShape(options?: Omit<NumberShapeOptions, 'integer'>): NumberShape {
	return {
		type: 'number',
		integer: true,
		min: options?.min,
		max: options?.max,
		description: options?.description,
	}
}

/**
 * Build a {@link BooleanShape}.
 *
 * @param options - Optional `description`
 * @returns A boolean shape
 */
export function booleanShape(options?: BooleanShapeOptions): BooleanShape {
	return {
		type: 'boolean',
		description: options?.description,
	}
}

/**
 * Build a {@link NullShape}.
 *
 * @param options - Optional `description`
 * @returns A null shape
 */
export function nullShape(options?: NullShapeOptions): NullShape {
	return { type: 'null', description: options?.description }
}

/**
 * Build a literal shape from a fixed set of primitive values.
 *
 * @param values - The permitted literals
 * @param options - Optional `description`
 * @returns A literal shape whose `Infer` is the union of `values`
 *
 * @example
 * ```ts
 * const role = literalShape(['admin', 'member', 'guest'])
 * // Infer<typeof role> = 'admin' | 'member' | 'guest'
 *
 * const via = literalShape(['function', 'tool', 'agent'], { description: 'How to run the step.' })
 * ```
 */
export function literalShape<const T extends readonly (string | number | boolean)[]>(
	values: T,
	options?: LiteralShapeOptions,
): LiteralShape<T> {
	return { type: 'literal', values, description: options?.description }
}

// === Collections

/**
 * Build an {@link ArrayShape} from an element shape.
 *
 * @param items - The element shape
 * @param options - Optional length bounds and `description`
 * @returns An array shape
 *
 * @example
 * ```ts
 * const tags = arrayShape(stringShape(), { max: 10 })
 * ```
 */
export function arrayShape<S extends ContractShape>(
	items: S,
	options?: ArrayShapeOptions,
): ArrayShape<S> {
	return {
		type: 'array',
		items,
		min: options?.min,
		max: options?.max,
		description: options?.description,
	}
}

/**
 * Build an {@link ObjectShape} from a property map.
 *
 * @remarks
 * Wrap any property in {@link optionalShape} to allow its absence. By default
 * the compiled guard rejects unknown keys; pass `additionalProperties` to open
 * the object.
 *
 * @param properties - Map of property names to child shapes
 * @param options - Optional `additionalProperties` and `description`
 * @returns An object shape
 *
 * @example
 * ```ts
 * const user = objectShape({
 * 	name: stringShape({ min: 1 }),
 * 	age: integerShape({ min: 0, max: 120 }),
 * 	bio: optionalShape(stringShape()),
 * })
 * ```
 */
export function objectShape<P extends Readonly<Record<string, ContractShape>>>(
	properties: P,
	options?: ObjectShapeOptions,
): ObjectShape<P> {
	return {
		type: 'object',
		properties,
		additionalProperties: options?.additionalProperties,
		description: options?.description,
	}
}

/**
 * Build an open {@link ObjectShape} with no fixed properties — a dictionary.
 *
 * @remarks
 * Every value is validated against `values`; keys are unconstrained. Equivalent
 * to `objectShape({}, { additionalProperties: values })`.
 *
 * @param values - The shape every value must match
 * @param options - Optional `description`
 * @returns An open object shape
 *
 * @example
 * ```ts
 * const bindings = recordShape(numberShape()) // ~ Record<string, number>
 * ```
 */
export function recordShape<S extends ContractShape>(
	values: S,
	options?: RecordShapeOptions,
): ObjectShape {
	return {
		type: 'object',
		properties: {},
		additionalProperties: values,
		description: options?.description,
	}
}

// === Composition

/**
 * Build a {@link UnionShape} from a list of variant shapes (`anyOf` in JSON Schema).
 *
 * @param variants - The candidate shapes; the first match wins at runtime
 * @returns A union shape whose `Infer` is the union of the variants
 *
 * @example
 * ```ts
 * const id = unionShape(stringShape(), integerShape())
 * // Infer<typeof id> = string | number
 * ```
 */
export function unionShape<V extends readonly ContractShape[]>(...variants: V): UnionShape<V> {
	return { type: 'union', variants }
}

/**
 * Build a {@link UnionShape} that emits `oneOf` (exactly one match) in JSON Schema.
 *
 * @remarks
 * Runtime behavior is identical to {@link unionShape} — only the emitted schema
 * keyword differs (`oneOf` vs `anyOf`).
 *
 * @param variants - The candidate shapes
 * @returns A union shape with `mode: 'oneOf'`
 */
export function oneOfShape<V extends readonly ContractShape[]>(...variants: V): UnionShape<V> {
	return { type: 'union', variants, mode: 'oneOf' }
}

/**
 * Wrap a shape so it may be absent (`undefined`).
 *
 * @remarks
 * As an {@link objectShape} property, the field becomes a true optional property
 * in the inferred type.
 *
 * @param inner - The wrapped shape
 * @returns An optional shape
 */
export function optionalShape<S extends ContractShape>(inner: S): OptionalShape<S> {
	return { type: 'optional', inner }
}

/**
 * Wrap a shape so it may be `null`.
 *
 * @param inner - The wrapped shape
 * @returns A nullable shape
 */
export function nullableShape<S extends ContractShape>(inner: S): NullableShape<S> {
	return { type: 'nullable', inner }
}

// === Escape hatch

/**
 * Build a {@link JSONShape}.
 *
 * @remarks
 * The sound counterpart of {@link rawShape}: `rawShape` embeds an arbitrary
 * schema fragment and accepts anything at runtime, while `jsonShape` validates
 * that a value is real JSON (via {@link isJSONValue}).
 *
 * @param options - Optional `description`
 * @returns A JSON passthrough shape
 */
export function jsonShape(options?: JSONShapeOptions): JSONShape {
	return { type: 'json', description: options?.description }
}

/**
 * Build a {@link RawShape} from a JSON Schema fragment.
 *
 * @remarks
 * For values the shape DSL can't express. The compiled guard accepts any value;
 * the parser passes it through; the schema is emitted verbatim.
 *
 * @param schema - The JSON Schema fragment to embed
 * @returns A raw shape
 */
export function rawShape(schema: JSONSchema): RawShape {
	return { type: 'raw', schema }
}
