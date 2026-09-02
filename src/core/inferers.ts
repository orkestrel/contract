import type { JSONSchema, SchemaFormat, ValueToSchemaOptions } from './types.js'
import { FORMAT_MAX_LENGTH, INFER_BREADTH_LIMIT, INTRINSICS } from './constants.js'
import { ContractError } from './errors.js'
import { isFiniteNumber, isRecord, isString } from './validators.js'
import {
	admitMember,
	appendEntries,
	attempt,
	canonicalStringify,
	classifyFormat,
	collectMembers,
	contain,
	matchesMember,
	readArrayEntries,
	readOptions,
	readValue,
	sanitizeBudget,
	sanitizeDepth,
	sortValues,
} from './helpers.js'
import { SampleInferer } from './SampleInferer.js'
import { ValueInferer } from './ValueInferer.js'

// The inferers walk an UNKNOWN, possibly adversarial runtime value (or a set
// of example values) and emit a JSONSchema — the reverse direction of
// compileSchema (compilers.ts), which walks a finite, developer-authored
// ContractShape tree. Recursion here is runtime-only and bounded on three
// axes: a WeakSet of ancestor objects/arrays (cycle safety), a decrementing
// depth budget held at the INFER_DEPTH_LIMIT ceiling, and a per-container sampling cap
// (INFER_BREADTH_LIMIT default). Readable unsupported values widen only where
// documented; failed traversal is a coded refusal, never a permissive schema.

/**
 * Unifies a list of inferred `JSONSchema` fragments into one schema.
 *
 * @remarks
 * De-duplicates by {@link canonicalStringify}, then applies the one
 * special-case subsumption inference performs: a bare `{ type: 'integer' }`
 * alongside a bare `{ type: 'number' }` collapses to just `{ type: 'number' }`
 * (an integer sample is also a valid `number` sample). A single surviving
 * distinct schema is returned directly; two or more are wrapped as
 * `{ anyOf: [...] }`, sorted by their canonical key for deterministic output.
 * An empty input list returns the empty accept-anything schema `{}`.
 *
 * Every captured member must first be a non-null object record. This runtime
 * requirement is realm-agnostic and admits ordinary and null-prototype schema
 * records while refusing primitives and callables before canonicalization.
 *
 * A readable member {@link canonicalStringify} cannot key — a cyclic or
 * otherwise JSON-inexpressible fragment, which only a direct caller can supply
 * since the inferers always build plain encodable fragments — has NO
 * de-duplication key, so it can participate in neither de-duplication nor the
 * canonical-key ordering. It is KEPT (dropping a variant would narrow the
 * union, and unification only ever widens), appended in input order after the
 * sorted keyed members. A failed member read propagates the canonicalizer's
 * coded refusal instead of participating in the union.
 *
 * @param schemas - The schemas to unify
 * @returns The unified schema
 *
 * @example
 * ```ts
 * unifySchemas([{ type: 'integer' }, { type: 'number' }]) // { type: 'number' }
 * unifySchemas([{ type: 'string' }, { type: 'boolean' }])
 * // { anyOf: [{ type: 'boolean' }, { type: 'string' }] }
 * ```
 */
export function unifySchemas(schemas: readonly JSONSchema[]): JSONSchema {
	return contain(() => {
		return readValue(
			() => {
				const snapshot = readArrayEntries(schemas)
				if (!snapshot.success) throw snapshot.error
				if (!snapshot.value.dense) throw new INTRINSICS.error('unifySchemas: schemas must be dense')
				const owned = snapshot.value.entries
				if (owned.length === 0) return {}
				// A key list plus a null-prototype table, walked by index — not a `Map`
				// spread into `.sort().map()`. Every one of those is a caller-writable
				// member on the path that decides the PUBLISHED union: an emptying
				// `sort` truncated the answer and a substituted `map` replaced it
				// wholesale, both without throwing.
				const keys: string[] = []
				const collected = collectMembers([])
				const byKey: Record<string, JSONSchema> = INTRINSICS.create(null)
				const unkeyed: JSONSchema[] = []
				for (let index = 0; index < owned.length; index += 1) {
					const schema = owned[index]
					if (schema === undefined || !isRecord(schema)) {
						throw new INTRINSICS.error('unifySchemas: schemas must be records')
					}
					const key = canonicalStringify(schema)
					if (key === undefined) {
						unkeyed[unkeyed.length] = schema
						continue
					}
					if (matchesMember(collected, key)) continue
					admitMember(collected, key)
					keys[keys.length] = key
					byKey[key] = schema
				}
				// Both literals always canonicalize; the explicit checks keep the
				// subsumption total against `canonicalStringify`'s optional result.
				const integerKey = canonicalStringify({ type: 'integer' })
				const numberKey = canonicalStringify({ type: 'number' })
				const subsumed =
					integerKey !== undefined &&
					numberKey !== undefined &&
					matchesMember(collected, integerKey) &&
					matchesMember(collected, numberKey)
						? integerKey
						: undefined
				const ordered = sortValues(keys)
				const members: JSONSchema[] = []
				for (let index = 0; index < ordered.length; index += 1) {
					const key = ordered[index]
					if (key === undefined || key === subsumed) continue
					const schema = byKey[key]
					if (schema === undefined) continue
					members[members.length] = schema
				}
				appendEntries(members, unkeyed)
				if (members.length <= 1) {
					const only = members[0]
					return only ?? {}
				}
				return { anyOf: members }
			},
			'unifySchemas',
			{ subject: 'schemas' },
		)
	}, 'unifySchemas')
}

// === Format inference

/**
 * Classifies a string against the {@link SchemaFormat} vocabulary.
 *
 * @remarks
 * Total, pure, and deterministic. Fixed precedence, most specific first:
 * `'uuid'`, `'date-time'`, `'date'`, `'time'`, `'email'`, `'uri'` — the first
 * match wins. The `date-time` / `date` / `time` branches require BOTH a
 * strict ISO-8601 shape match AND a real {@link matchesISOInstant} validity
 * check, so a shape-plausible but impossible date (`2020-13-45`) is rejected.
 * Returns `undefined` when no format matches (including the empty string).
 *
 * @param value - The string to classify
 * @returns The matched {@link SchemaFormat}, or `undefined`
 *
 * @example
 * ```ts
 * stringToFormat('550e8400-e29b-41d4-a716-446655440000') // 'uuid'
 * stringToFormat('2024-01-15')                             // 'date'
 * stringToFormat('2020-13-45')                             // undefined — invalid date
 * stringToFormat('ada@example.com')                        // 'email'
 * stringToFormat('10:30:00')                                // undefined — RFC 3339 time requires an offset
 * stringToFormat('10:30:00+02:00')                          // 'time'
 * ```
 */
export function stringToFormat(value: string): SchemaFormat | undefined {
	if (!isString(value)) return undefined
	if (value.length > FORMAT_MAX_LENGTH) return undefined
	// Total by containment at the door: every classification below dispatches
	// through `RegExp.prototype.test`/`.exec`, caller-writable members reached by
	// name, and this reader is documented to answer `SchemaFormat | undefined`
	// with no `@throws` at all.
	const outcome = attempt(() => classifyFormat(value))
	return outcome.success ? outcome.value : undefined
}

/**
 * Classifies a list of sample values against the {@link SchemaFormat}
 * vocabulary, requiring unanimity.
 *
 * @remarks
 * A format is returned ONLY IF every value is a string AND every one maps to
 * the SAME {@link stringToFormat} result (including all mapping to
 * `undefined`, which itself returns `undefined` here). A single disagreeing
 * value, a non-string value, or an empty list all yield `undefined` — the
 * multi-sample seam behind {@link samplesToSchema}
 * relies on this unanimity so a slot with mixed string shapes emits a bare
 * `{ type: 'string' }` rather than an `anyOf` of formats.
 *
 * @param values - The sample values to classify
 * @returns The unanimous {@link SchemaFormat}, or `undefined`
 *
 * @example
 * ```ts
 * samplesToFormat(['2024-01-01', '2024-02-02']) // 'date'
 * samplesToFormat(['2024-01-01', 'not a date'])  // undefined
 * samplesToFormat([])                            // undefined
 * ```
 */
export function samplesToFormat(values: readonly unknown[]): SchemaFormat | undefined {
	return contain(() => {
		return readValue(
			() => {
				const snapshot = readArrayEntries(values)
				if (!snapshot.success) throw snapshot.error
				if (!snapshot.value.dense)
					throw new INTRINSICS.error('samplesToFormat: values must be dense')
				const owned = snapshot.value.entries
				if (owned.length === 0) return undefined
				let first: SchemaFormat | undefined
				for (let index = 0; index < owned.length; index += 1) {
					const value = owned[index]
					if (!isString(value)) return undefined
					const format = stringToFormat(value)
					if (format === undefined) return undefined
					if (index === 0) first = format
					else if (format !== first) return undefined
				}
				return first
			},
			'samplesToFormat',
			{ subject: 'values' },
		)
	}, 'samplesToFormat')
}

// === Enum inference

/**
 * Infers an `{ enum: [...] }` fragment for a low-cardinality, repeated
 * primitive slot — the multi-sample-only counterpart to
 * {@link stringToFormat} ({@link valueToSchema} never emits `enum`).
 *
 * @remarks
 * Fires only when ALL of: every value is the same primitive kind (all string
 * or all FINITE number via {@link isFiniteNumber} — any `null`/boolean/mixed
 * slot never qualifies, and a slot containing `NaN` / `±Infinity` never
 * qualifies either, since {@link canonicalStringify} collapses `NaN` to
 * `'null'` and would otherwise risk an invalid-JSON `enum`); at least 2
 * values are given; the distinct-by-{@link canonicalStringify} count is LESS
 * than the value count (repetition required — separates a categorical column
 * from an ID column); and the distinct count is at most `limit`. The emitted
 * schema carries `enum` with NO `type` key, byte-matching `compileSchema`'s
 * `literalShape` emission. Members are sorted by canonical key for
 * deterministic output.
 *
 * A member {@link canonicalStringify} cannot key has no identity to
 * de-duplicate against, so the whole slot is enum-INELIGIBLE and returns
 * `undefined` — widening to the caller's bare `type` rather than emitting an
 * `enum` that might silently omit a value. (A string or finite number always
 * canonicalizes, so this only guards the total contract.)
 *
 * @param values - The collected slot values
 * @param limit - The maximum distinct-value count before giving up
 * @returns The `{ enum: [...] }` fragment, or `undefined` when ineligible
 *
 * @example
 * ```ts
 * inferPrimitiveEnum(['active', 'inactive', 'active'], 12)
 * // { enum: ['active', 'inactive'] }
 * inferPrimitiveEnum(['a', 'b', 'c'], 12) // undefined — no repetition
 * ```
 */
export function inferPrimitiveEnum(
	values: readonly unknown[],
	limit: number,
): JSONSchema | undefined {
	return contain(() => {
		return readValue(
			() => {
				const snapshot = readArrayEntries(values)
				if (!snapshot.success) throw snapshot.error
				if (!snapshot.value.dense)
					throw new INTRINSICS.error('inferPrimitiveEnum: values must be dense')
				const owned = snapshot.value.entries
				if (owned.length < 2) return undefined
				let strings = 0
				let numbers = 0
				for (let index = 0; index < owned.length; index += 1) {
					const value = owned[index]
					if (isString(value)) strings += 1
					else if (isFiniteNumber(value)) numbers += 1
				}
				const allString = strings === owned.length
				const allNumber = !allString && numbers === owned.length
				if (!allString && !allNumber) return undefined
				// A key list plus a null-prototype table, ordered through the captured
				// sort: `Map` iteration, array spread, `.sort` and `.map` are four
				// caller-writable dispatches deciding a published `enum`.
				const keys: string[] = []
				const collected = collectMembers([])
				const byKey: Record<string, string | number> = INTRINSICS.create(null)
				for (let index = 0; index < owned.length; index += 1) {
					const value = owned[index]
					if (!isString(value) && !isFiniteNumber(value)) continue
					const key = canonicalStringify(value)
					if (key === undefined) return undefined
					if (!matchesMember(collected, key)) {
						admitMember(collected, key)
						keys[keys.length] = key
					}
					byKey[key] = value
				}
				if (keys.length >= owned.length || keys.length > limit) return undefined
				const ordered = sortValues(keys)
				const population: Array<string | number> = []
				for (let index = 0; index < ordered.length; index += 1) {
					const key = ordered[index]
					if (key === undefined) continue
					const value = byKey[key]
					if (value === undefined) continue
					population[population.length] = value
				}
				return { enum: population }
			},
			'inferPrimitiveEnum',
			{ subject: 'values' },
		)
	}, 'inferPrimitiveEnum')
}

// === Single-value inference

/**
 * Infers a `JSONSchema` for one unknown value — the reverse direction of
 * {@link compileSchema}.
 *
 * @remarks
 * Cycle-, depth-, and breadth-bounded: the walk keeps an ancestor set and an
 * `(object, remaining depth)` memo of its own, so a cyclic host terminates and a
 * shared-reference DAG costs its nodes rather than its paths. A failed traversal
 * throws a `structure`
 * {@link ContractError}; it never becomes `{}` or another permissive schema. Nested
 * objects close to unknown keys (`additionalProperties: false`) by default;
 * pass `closed: false` to open them. `format` (default `false`) opts a
 * string/`Date` leaf into the `format` keyword. Structurally-equal inputs
 * infer byte-identical schemas (object keys and `anyOf` members are sorted).
 *
 * A non-object root — e.g. `valueToSchema('hi')` yielding `{ type: 'string'
 * }` — is structurally accepted by `schemaToParameters`, but MCP clients
 * expect an object-shaped `inputSchema`; wrap a non-object payload with
 * {@link schemaToObject} before advertising it as a tool's parameters.
 *
 * `limits.properties` is sanitized via {@link sanitizeBudget} to a finite
 * non-negative integer, falling back to {@link INFER_BREADTH_LIMIT} for anything
 * else (`NaN`, `Infinity`, negative, fractional), so a malformed breadth cannot
 * corrupt the sampled key/element list.
 *
 * `limits.depth` goes through {@link sanitizeDepth}, which does the same and then caps
 * at {@link INFER_DEPTH_LIMIT}, so the option NARROWS the walk and cannot widen
 * it. The cap is what makes the depth guard unbreakable: depth is the recursing
 * axis, and a large-but-valid budget used to descend until the call STACK failed
 * rather than until the guard said stop.
 *
 * @param value - The value to infer a schema from
 * @param options - Optional {@link ValueToSchemaLimits} `limits` plus `closed` / `format` bounds
 * @returns The inferred `JSONSchema`
 * @throws {ContractError} When the value or options cannot be read
 *
 * @example
 * ```ts
 * valueToSchema({ id: 1, name: 'Ada', tags: ['a', 'b'] })
 * // { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' },
 * //   tags: { type: 'array', items: { type: 'string' } } },
 * //   required: ['id', 'name', 'tags'], additionalProperties: false }
 * ```
 */
export function valueToSchema(value: unknown, options?: ValueToSchemaOptions): JSONSchema {
	return contain(() => {
		const optionsSnapshot = readOptions(
			options,
			['limits', 'closed', 'format', 'enum'],
			'valueToSchema',
			'schema',
		)
		// The grouped budgets cross the same contained read the flat keys crossed:
		// `limits` is a caller-owned record, so a hostile getter or `ownKeys` trap
		// on it refuses under this door's name rather than reaching the walk.
		const limits = readOptions(
			optionsSnapshot?.limits,
			['depth', 'properties'],
			'valueToSchema',
			'schema',
		)
		const depth = sanitizeDepth(limits?.depth)
		const properties = sanitizeBudget(limits?.properties, INFER_BREADTH_LIMIT)
		const closed = optionsSnapshot?.closed ?? true
		const format = optionsSnapshot?.format ?? false
		// The whole walk runs inside this door's own read boundary, so a hostile
		// getter, `length` trap, or key enumeration anywhere below it is published
		// under this door's name rather than under the name of an engine method no
		// consumer can call.
		return readValue(
			() => new ValueInferer(value, depth, properties, closed, format).infer(),
			'valueToSchema',
		)
	}, 'valueToSchema')
}

// === Multi-sample inference

/**
 * Infers a `JSONSchema` from a set of example values — the multi-example
 * counterpart of {@link valueToSchema} (e.g. inferring one schema from
 * several database rows).
 *
 * @remarks
 * An empty `samples` array infers the empty accept-anything schema `{}`.
 * When every sample is a plain record, properties/required are unified
 * per-key across all samples — a key
 * required iff present and non-`undefined` in every sample. Otherwise the
 * slot is inferred one value at a time (independent {@link valueToSchema}
 * per sample, unified with {@link unifySchemas} — the same de-duplication and
 * `anyOf` ordering an array's element schemas receive). `format`
 * and `enum` (both default `false`) opt a low-cardinality/unanimous-format
 * slot into the corresponding keyword: enum inference runs first and wins
 * outright, and a unanimous format is reattached only to a slot that unified to
 * exactly `{ type: 'string' }`, with nested formats forced off. `limits.depth` /
 * `limits.properties` are resolved exactly as {@link valueToSchema} resolves them —
 * breadth through {@link sanitizeBudget}, depth through {@link sanitizeDepth},
 * which also caps at {@link INFER_DEPTH_LIMIT}; see there for why.
 *
 * @param samples - The example values to infer a schema from
 * @param options - Optional {@link ValueToSchemaLimits} `limits` plus `closed` / `format` / `enum` bounds
 * @returns The inferred `JSONSchema`
 * @throws {ContractError} When the samples or options cannot be read
 *
 * @example
 * ```ts
 * samplesToSchema([{ id: 1 }, { id: 2, name: 'Ada' }])
 * // { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } },
 * //   required: ['id'], additionalProperties: false }
 * samplesToSchema([]) // {}
 * ```
 */
export function samplesToSchema(
	samples: readonly unknown[],
	options?: ValueToSchemaOptions,
): JSONSchema {
	return contain(() => {
		const optionsSnapshot = readOptions(
			options,
			['limits', 'closed', 'format', 'enum'],
			'samplesToSchema',
			'schema',
		)
		const limits = readOptions(
			optionsSnapshot?.limits,
			['depth', 'properties'],
			'samplesToSchema',
			'schema',
		)
		const depth = sanitizeDepth(limits?.depth)
		const properties = sanitizeBudget(limits?.properties, INFER_BREADTH_LIMIT)
		const closed = optionsSnapshot?.closed ?? true
		const format = optionsSnapshot?.format ?? false
		const enumOn = optionsSnapshot?.enum ?? false
		const read = readValue(
			() => {
				const snapshot = readArrayEntries(samples)
				if (!snapshot.success) throw snapshot.error
				return snapshot.value
			},
			'samplesToSchema',
			{ subject: 'samples' },
		)
		// A hole is READABLE. Reporting it as `samples could not be read` paired a
		// true refusal with a false diagnosis and contradicted the guide's own
		// attribution of that message to "a hostile getter or failed key walk".
		if (!read.dense) {
			throw new ContractError('samplesToSchema: samples must be a dense array', {
				code: 'structure',
			})
		}
		// The recursion stays inside this door's own read boundary, so a failed read
		// anywhere below is still published as `samplesToSchema: samples could not
		// be read` rather than under the name of an internal spine function.
		return readValue(
			() => new SampleInferer(read.entries, depth, properties, closed, format, enumOn).infer(),
			'samplesToSchema',
			{ subject: 'samples' },
		)
	}, 'samplesToSchema')
}
