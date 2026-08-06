import type {
	AuditFault,
	ContractInterface,
	ContractShape,
	Fault,
	FaultKind,
	Guard,
	Infer,
	JSONSchema,
	Parser,
	RandomFunction,
} from './types.js'
import {
	isArray,
	isBoolean,
	isFiniteNumber,
	isInteger,
	isJSONValue,
	isNull,
	isRecord,
	isString,
	isUndefined,
} from './validators.js'
import {
	attempt,
	drawRandom,
	enumerableKeys,
	preview,
	seededRandom,
	shapeToKind,
} from './helpers.js'
import { COMPILE_DEPTH_LIMIT, FAULT_LIMIT, GENERATION_ATTEMPT_LIMIT } from './constants.js'
import { ContractError, isContractError } from './errors.js'
import { cloneSchema, cloneShape, ownShape } from './cloners.js'
import {
	arrayOf,
	boundsOf,
	intersectionOf,
	literalOf,
	matchOf,
	nullableOf,
	orOf,
	stringOf,
	unionOf,
	whereOf,
} from './combinators.js'
import { parseBoolean, parseInteger, parseNumber, parseRecord, parseString } from './parsers.js'

// The compilers walk a finite, developer-authored shape tree (never cyclic) and
// recurse on themselves — branches are kept inline and public per AGENTS §5,
// never hidden behind private helpers. `compileGuard` / `compileParser` /
// `compileReporter` / `compileAuditor` reuse the existing combinators and parsers rather than
// re-implementing them — including `literalOf` for literal membership, so
// SameValueZero matching has one implementation package-wide. Every entry point
// opens with `ownShape` (cloners.ts), the one place the frozen-means-owned
// invariant lives.

// === Validation

/**
 * Gate recursive compiler work on shape structure, depth, and cycles.
 *
 * @remarks
 * Walks the shape graph iteratively in linear time and stack space. Every
 * structural child slot must contain a shape node before it can enter the walk;
 * a missing child or unknown shape discriminant reports `placement`. This is a
 * structural-safety prerequisite rather than the full well-formedness pass in
 * {@link validateShape}: it does not diagnose bounds, empty vocabularies, or
 * optional-shape policy. Active ancestors are tracked so shared children remain
 * legal. Every standalone compiler calls this gate before its recursive branch
 * begins. The depth check runs before the child and active-ancestor checks, so a
 * malformed edge first reached beyond {@link COMPILE_DEPTH_LIMIT} reports
 * `depth`; a shallower cycle reports `cycle`.
 *
 * @param shape - The shape graph to gate
 * @returns Nothing; successful return means recursive compilation is structurally safe and depth-safe
 * @throws {ContractError} When a structural child is not a shape, the graph is cyclic, or it exceeds the compilation depth limit
 */
export function validateShapeDepth(shape: ContractShape): void {
	const active = new WeakSet<ContractShape>()
	const stack: (
		| {
				readonly operation: 'enter'
				readonly shape: ContractShape | undefined
				readonly path: readonly string[]
				readonly depth: number
		  }
		| { readonly operation: 'exit'; readonly shape: ContractShape }
	)[] = [{ operation: 'enter', shape, path: [], depth: 0 }]

	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		if (frame.operation === 'exit') {
			active.delete(frame.shape)
			continue
		}

		const current = frame.shape
		if (frame.depth > COMPILE_DEPTH_LIMIT) {
			throw new ContractError('validateShapeDepth: a shape exceeds the compilation depth limit', {
				code: 'depth',
				context: { path: frame.path, limit: COMPILE_DEPTH_LIMIT },
			})
		}
		if (typeof current !== 'object' || current === null) {
			throw new ContractError('validateShapeDepth: every structural child must be a shape', {
				code: 'placement',
				context: { path: frame.path },
			})
		}
		if (active.has(current)) {
			throw new ContractError('validateShapeDepth: a shape graph may not contain a cycle', {
				code: 'cycle',
				context: { path: frame.path },
			})
		}
		active.add(current)
		stack.push({ operation: 'exit', shape: current })

		switch (current.type) {
			case 'array':
				stack.push({
					operation: 'enter',
					shape: current.items,
					path: [...frame.path, 'items'],
					depth: frame.depth + 1,
				})
				break
			case 'object': {
				if (
					typeof current.properties !== 'object' ||
					current.properties === null ||
					Array.isArray(current.properties)
				) {
					throw new ContractError('validateShapeDepth: every structural child must be a shape', {
						code: 'placement',
						context: { path: [...frame.path, 'properties'] },
					})
				}
				const extra = current.additionalProperties
				if (extra !== undefined && extra !== true && extra !== false) {
					stack.push({
						operation: 'enter',
						shape: extra,
						path: [...frame.path, 'additionalProperties'],
						depth: frame.depth + 1,
					})
				}
				const keys = Object.keys(current.properties)
				for (let index = keys.length - 1; index >= 0; index -= 1) {
					const key = keys[index]
					if (key === undefined) continue
					const child = current.properties[key]
					stack.push({
						operation: 'enter',
						shape: child,
						path: [...frame.path, 'properties', key],
						depth: frame.depth + 1,
					})
				}
				break
			}
			case 'union':
				if (!Array.isArray(current.variants)) {
					throw new ContractError('validateShapeDepth: every structural child must be a shape', {
						code: 'placement',
						context: { path: [...frame.path, 'variants'] },
					})
				}
				for (let index = current.variants.length - 1; index >= 0; index -= 1) {
					const variant = current.variants[index]
					stack.push({
						operation: 'enter',
						shape: variant,
						path: [...frame.path, 'variants', String(index)],
						depth: frame.depth + 1,
					})
				}
				break
			case 'optional':
			case 'nullable':
				stack.push({
					operation: 'enter',
					shape: current.inner,
					path: [...frame.path, 'inner'],
					depth: frame.depth + 1,
				})
				break
			case 'string':
			case 'number':
			case 'boolean':
			case 'null':
			case 'json':
			case 'literal':
			case 'raw':
				break
			default:
				throw new ContractError('validateShapeDepth: every structural child must be a shape', {
					code: 'placement',
					context: { path: frame.path },
				})
		}
	}
}

/**
 * Validate that a {@link ContractShape} graph is well-formed before
 * compilation.
 *
 * @remarks
 * Fail-fast, per AGENTS §12: a malformed shape is a programmer error, so this
 * throws a coded {@link ContractError} immediately rather than surfacing as a
 * silently-wrong guard, parser, schema, or generator later. It first runs
 * {@link validateShapeDepth}, which rejects a structural child that is not a
 * shape before this well-formedness walk begins. The iterative walk tracks
 * active ancestors, so a structural cycle reports its precise path while a
 * shared child reached through separate paths remains legal. Checks:
 *
 * - An {@link OptionalShape} is only legal as a direct object-property value —
 *   `optionalShape` wrapping an array item, a union variant, another
 *   optional/nullable's inner shape, `additionalProperties`, or the top-level
 *   shape all throw. An object property IS the one legal placement: its value
 *   is unwrapped to `.inner` before recursing, so `.inner` itself is validated
 *   as a normal (non-optional-wrapping) shape.
 * - A {@link UnionShape} needs at least one variant; a {@link LiteralShape}
 *   needs at least one value and rejects non-finite (`NaN` / `Infinity` /
 *   `-Infinity`) number values.
 * - A bounded {@link StringShape} / {@link NumberShape} / {@link ArrayShape}
 *   needs `min <= max` when both are set.
 * - Every present number bound is finite.
 * - An integer {@link NumberShape} (`integer: true`) needs a non-empty integer
 *   range: `Math.ceil(min ?? -Infinity) <= Math.floor(max ?? Infinity)`.
 * - Shape nesting may not exceed {@link COMPILE_DEPTH_LIMIT}; excessive depth
 *   fails before recursive artifact compilation begins. Because the depth check
 *   runs before the active-ancestor check, a back-edge first reached beyond the
 *   limit reports `depth`; a cycle reached within the limit reports `cycle`.
 * - `null` / `json` / `raw` / `boolean` are always-valid leaves. Recursion
 *   continues into array items, object properties (and `additionalProperties`
 *   when it is a shape), union variants, and optional/nullable inner shapes.
 *
 * @param shape - The shape to validate
 * @throws {ContractError} When the shape is malformed or cyclic
 *
 * @example
 * ```ts
 * validateShape(stringShape({ min: 1, max: 10 })) // does not throw
 * validateShape(stringShape({ min: 10, max: 1 })) // throws
 * ```
 */
export function validateShape(shape: ContractShape): void {
	validateShapeDepth(shape)
	const active = new WeakSet<ContractShape>()
	const stack: (
		| {
				readonly operation: 'enter'
				readonly shape: ContractShape
				readonly path: readonly string[]
				readonly optional: boolean
				readonly depth: number
		  }
		| { readonly operation: 'exit'; readonly shape: ContractShape }
	)[] = [{ operation: 'enter', shape, path: [], optional: false, depth: 0 }]

	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		if (frame.operation === 'exit') {
			active.delete(frame.shape)
			continue
		}

		const current = frame.shape
		if (frame.depth > COMPILE_DEPTH_LIMIT) {
			throw new ContractError('validateShape: a shape exceeds the compilation depth limit', {
				code: 'depth',
				context: { path: frame.path, shape: current.type, limit: COMPILE_DEPTH_LIMIT },
			})
		}
		if (active.has(current)) {
			throw new ContractError('validateShape: a shape graph may not contain a cycle', {
				code: 'cycle',
				context: { path: frame.path },
			})
		}
		active.add(current)
		stack.push({ operation: 'exit', shape: current })

		switch (current.type) {
			case 'string':
				if (current.min !== undefined && current.max !== undefined && current.min > current.max) {
					throw new ContractError('validateShape: a string shape has min greater than max', {
						code: 'range',
						context: { path: frame.path, shape: 'string' },
					})
				}
				break
			case 'number':
				if (current.min !== undefined && !Number.isFinite(current.min)) {
					throw new ContractError('validateShape: a number shape min must be finite', {
						code: 'bound',
						context: {
							path: frame.path,
							shape: current.integer === true ? 'integer' : 'number',
							limit: 'finite number',
							received: String(current.min),
						},
					})
				}
				if (current.max !== undefined && !Number.isFinite(current.max)) {
					throw new ContractError('validateShape: a number shape max must be finite', {
						code: 'bound',
						context: {
							path: frame.path,
							shape: current.integer === true ? 'integer' : 'number',
							limit: 'finite number',
							received: String(current.max),
						},
					})
				}
				if (current.min !== undefined && current.max !== undefined && current.min > current.max) {
					throw new ContractError('validateShape: a number shape has min greater than max', {
						code: 'range',
						context: {
							path: frame.path,
							shape: current.integer === true ? 'integer' : 'number',
						},
					})
				}
				if (current.integer === true) {
					const lo = Math.ceil(current.min ?? Number.NEGATIVE_INFINITY)
					const hi = Math.floor(current.max ?? Number.POSITIVE_INFINITY)
					if (lo > hi) {
						throw new ContractError(
							'validateShape: an integer number shape has an empty integer range',
							{
								code: 'range',
								context: { path: frame.path, shape: 'integer' },
							},
						)
					}
				}
				break
			case 'boolean':
			case 'null':
			case 'json':
			case 'raw':
				break
			case 'literal':
				if (current.values.length === 0) {
					throw new ContractError('validateShape: a literal shape needs at least one value', {
						code: 'empty',
						context: { path: frame.path, shape: 'literal' },
					})
				}
				for (const value of current.values) {
					if (typeof value === 'number' && !Number.isFinite(value)) {
						throw new ContractError(
							'validateShape: a literal shape may not contain non-finite number values',
							{
								code: 'literal',
								context: { path: frame.path, shape: 'literal', received: String(value) },
							},
						)
					}
				}
				break
			case 'array':
				if (current.min !== undefined && current.max !== undefined && current.min > current.max) {
					throw new ContractError('validateShape: an array shape has min greater than max', {
						code: 'range',
						context: { path: frame.path, shape: 'array' },
					})
				}
				stack.push({
					operation: 'enter',
					shape: current.items,
					path: [...frame.path, 'items'],
					optional: false,
					depth: frame.depth + 1,
				})
				break
			case 'object': {
				const extra = current.additionalProperties
				if (extra !== undefined && extra !== true && extra !== false) {
					stack.push({
						operation: 'enter',
						shape: extra,
						path: [...frame.path, 'additionalProperties'],
						optional: false,
						depth: frame.depth + 1,
					})
				}
				const keys = Object.keys(current.properties)
				for (let index = keys.length - 1; index >= 0; index -= 1) {
					const key = keys[index]
					if (key === undefined) continue
					const child = current.properties[key]
					if (child === undefined) continue
					stack.push({
						operation: 'enter',
						shape: child,
						path: [...frame.path, 'properties', key],
						optional: true,
						depth: frame.depth + 1,
					})
				}
				break
			}
			case 'union':
				if (current.variants.length === 0) {
					throw new ContractError('validateShape: a union shape needs at least one variant', {
						code: 'empty',
						context: { path: frame.path, shape: 'union' },
					})
				}
				for (let index = current.variants.length - 1; index >= 0; index -= 1) {
					const variant = current.variants[index]
					if (variant === undefined) continue
					stack.push({
						operation: 'enter',
						shape: variant,
						path: [...frame.path, 'variants', String(index)],
						optional: false,
						depth: frame.depth + 1,
					})
				}
				break
			case 'optional':
				if (!frame.optional) {
					throw new ContractError(
						'validateShape: an optional shape may only appear as a direct object-property value',
						{
							code: 'placement',
							context: { path: frame.path, shape: 'optional' },
						},
					)
				}
				stack.push({
					operation: 'enter',
					shape: current.inner,
					path: [...frame.path, 'inner'],
					optional: false,
					depth: frame.depth + 1,
				})
				break
			case 'nullable':
				stack.push({
					operation: 'enter',
					shape: current.inner,
					path: [...frame.path, 'inner'],
					optional: false,
					depth: frame.depth + 1,
				})
				break
		}
	}
}

// === Schema

/**
 * Compile a {@link ContractShape} into a JSON Schema document.
 *
 * @remarks
 * Object shapes emit `additionalProperties: false` (unless opened) and list only
 * required keys in `required`; nullable shapes emit an `anyOf` with `{ type:
 * 'null' }`. The result is an owned deeply frozen graph; raw schemas are cloned
 * rather than retained by reference. Emission only — it never inspects a
 * runtime value. {@link validateShapeDepth} iteratively rejects excessive
 * nesting or cycles before recursive emission begins.
 *
 * @param shape - The shape to compile
 * @returns The emitted JSON Schema
 *
 * @example
 * ```ts
 * compileSchema(stringShape({ min: 1 })) // { type: 'string', minLength: 1 }
 * ```
 */
export function compileSchema(shape: ContractShape): JSONSchema {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string':
			return Object.freeze({
				type: 'string',
				...(owned.min !== undefined ? { minLength: owned.min } : {}),
				...(owned.max !== undefined ? { maxLength: owned.max } : {}),
				...(owned.pattern !== undefined ? { pattern: owned.pattern.source } : {}),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'number':
			return Object.freeze({
				type: owned.integer === true ? 'integer' : 'number',
				...(owned.min !== undefined ? { minimum: owned.min } : {}),
				...(owned.max !== undefined ? { maximum: owned.max } : {}),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'boolean':
			return Object.freeze({
				type: 'boolean',
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'null':
			return Object.freeze({
				type: 'null',
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'json':
			return Object.freeze({
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'literal':
			return Object.freeze({
				enum: Object.freeze([...owned.values]),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'array':
			return Object.freeze({
				type: 'array',
				items: compileSchema(owned.items),
				...(owned.min !== undefined ? { minItems: owned.min } : {}),
				...(owned.max !== undefined ? { maxItems: owned.max } : {}),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'object': {
			const properties: Record<string, JSONSchema> = Object.create(null)
			const required: string[] = []
			for (const key of Object.keys(owned.properties)) {
				const child = owned.properties[key]
				if (child === undefined) continue
				properties[key] = compileSchema(child)
				if (child.type !== 'optional') required.push(key)
			}
			const extra = owned.additionalProperties
			const additionalProperties: boolean | JSONSchema =
				extra === true
					? true
					: extra !== undefined && extra !== false
						? compileSchema(extra)
						: false
			return Object.freeze({
				type: 'object',
				...(Object.keys(properties).length > 0 ? { properties: Object.freeze(properties) } : {}),
				...(required.length > 0 ? { required: Object.freeze(required) } : {}),
				additionalProperties,
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		}
		case 'union':
			return Object.freeze({
				...(owned.mode === 'oneOf'
					? {
							oneOf: Object.freeze(owned.variants.map((variant) => compileSchema(variant))),
						}
					: {
							anyOf: Object.freeze(owned.variants.map((variant) => compileSchema(variant))),
						}),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'optional':
			return compileSchema(owned.inner)
		case 'nullable':
			return Object.freeze({
				anyOf: Object.freeze([compileSchema(owned.inner), Object.freeze({ type: 'null' })]),
			})
		case 'raw':
			return cloneSchema(owned.schema)
	}
}

// === Guard

/**
 * Compile a {@link ContractShape} into a runtime type guard.
 *
 * @remarks
 * Reuses the combinators for structural and refined shapes, including
 * {@link literalOf} for SameValueZero literal matching. Compiled object shapes
 * observe own enumerable string keys through {@link enumerableKeys}, the same
 * key view their parser, reporter, auditor, and inference use for both open and
 * closed objects — the view is shared, the verdict on an undeclared key is not
 * (this guard rejects the object; the parser drops the key).
 * Like every guard it is total — it never throws (AGENTS §14). The shape is
 * taken through {@link ownShape} first, so an unfrozen caller-owned graph
 * compiles from a snapshot. {@link validateShapeDepth} iteratively rejects
 * excessive nesting or cycles before recursive guard compilation begins.
 *
 * @param shape - The shape to compile
 * @returns A guard narrowing to the shape's inferred type
 *
 * @example
 * ```ts
 * const isUser = compileGuard(objectShape({ name: stringShape() }))
 * isUser({ name: 'Ada' }) // true
 * ```
 */
export function compileGuard<S extends ContractShape>(shape: S): Guard<Infer<S>>
export function compileGuard(shape: ContractShape): Guard<unknown>
export function compileGuard(shape: ContractShape): Guard<unknown> {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string':
			// `stringOf` returns bare `isString` when unrefined, else composes the
			// length-bounds + pattern refinement — the same guard the parser re-applies.
			return stringOf({
				...(owned.min === undefined ? {} : { min: owned.min }),
				...(owned.max === undefined ? {} : { max: owned.max }),
				...(owned.pattern === undefined ? {} : { pattern: owned.pattern }),
			})
		case 'number': {
			const base = owned.integer === true ? isInteger : isFiniteNumber
			if (owned.min === undefined && owned.max === undefined) return base
			// `boundsOf` already refines `isFiniteNumber`; intersect with `isInteger`
			// when the leaf is an integer so both the integrality and the bounds hold.
			return owned.integer === true
				? intersectionOf(isInteger, boundsOf(owned.min, owned.max))
				: boundsOf(owned.min, owned.max)
		}
		case 'boolean':
			return isBoolean
		case 'null':
			return isNull
		case 'json':
			return isJSONValue
		case 'literal':
			// `literalOf` IS the package's literal match (SameValueZero over an owned
			// `Set`); the array form takes a machine-generated vocabulary no spread
			// could carry.
			return literalOf(owned.values)
		case 'array': {
			const base = arrayOf(compileGuard(owned.items))
			if (owned.min === undefined && owned.max === undefined) return base
			const withinLength = boundsOf(owned.min, owned.max)
			return whereOf(base, (value) => withinLength(value.length))
		}
		case 'object': {
			// Honest typing: a null-prototype accumulator so a property literally
			// named '__proto__' becomes an own data key instead of mutating the
			// prototype — the same pattern `pickOf` uses (combinators.ts).
			const map: Record<string, Guard<unknown>> = Object.create(null)
			const optionalKeys: string[] = []
			for (const key of Object.keys(owned.properties)) {
				const child = owned.properties[key]
				if (child === undefined) continue
				if (child.type === 'optional') {
					map[key] = compileGuard(child.inner)
					optionalKeys.push(key)
				} else {
					map[key] = compileGuard<ContractShape>(child)
				}
			}
			const extra = owned.additionalProperties
			const closed = extra === undefined || extra === false
			const additional = closed || extra === true ? undefined : compileGuard(extra)
			const required = Object.keys(map).filter((key) => !optionalKeys.includes(key))
			return (value: unknown): value is unknown => {
				if (!isRecord(value)) return false
				const keys = enumerableKeys(value)
				if (keys === undefined) return false
				const present = new Set(keys)
				for (const key of required) {
					if (!present.has(key)) return false
				}
				// Contain the whole key-enumeration + value-read walk — a hostile
				// getter on `value` must yield `false`, never throw (AGENTS §14).
				const outcome = attempt(() => {
					for (const key of keys) {
						const guard = Object.hasOwn(map, key) ? map[key] : undefined
						if (guard !== undefined) {
							if (!guard(value[key])) return false
						} else if (closed) {
							return false
						} else if (additional !== undefined && !additional(value[key])) {
							return false
						}
					}
					return true
				})
				return outcome.success && outcome.value
			}
		}
		case 'union': {
			const guards = owned.variants.map((variant) => compileGuard(variant))
			// A `oneOf`-mode union matches the emitted JSON Schema `oneOf` keyword —
			// EXACTLY one variant must guard-accept the value, not "at least one"
			// (unionOf's anyOf semantics). A value matching two-or-more variants is
			// rejected, since it would violate the compiled schema.
			if (owned.mode === 'oneOf') {
				return (value: unknown): value is unknown =>
					guards.filter((guard) => guard(value)).length === 1
			}
			return unionOf(...guards)
		}
		case 'optional':
			return orOf(isUndefined, compileGuard(owned.inner))
		case 'nullable':
			return nullableOf(compileGuard(owned.inner))
		case 'raw':
			return (value: unknown): value is unknown => value !== undefined
	}
}

// === Parser

/**
 * Compile a {@link ContractShape} into an input parser.
 *
 * @remarks
 * Reuses the leaf parsers (`parseString` / `parseInteger` / `parseNumber` /
 * `parseBoolean` / `parseRecord`) and coerces structurally. An object fails as a
 * whole on any required-field failure; a union returns a guard-valid value
 * unchanged, otherwise the first variant that both parses and guards wins.
 *
 * After coercing a leaf, it re-applies that leaf's REFINEMENTS through the same
 * combinators `compileGuard` uses — `stringOf` for a string's length/pattern,
 * `boundsOf` for a number's value and an array's length, and {@link literalOf}
 * for literal membership — so a value that coerces but violates a bound parses
 * to `undefined`. The result is full parse↔guard soundness (AGENTS §14): a
 * non-`undefined` parse always satisfies the contract's `is`, refinements
 * included — a statement about the OUTPUT, never about the input, which may be
 * a value `is` rejects. Object presence and extra-key processing read the same
 * own-enumerable-string key view as the guard, reporter, auditor, and inference
 * — one key set, deliberately different verdicts: this parser drops an
 * undeclared key that {@link compileGuard} rejects and {@link compileAuditor}
 * faults. The shape is taken through {@link ownShape} first, so an unfrozen
 * caller-owned graph compiles from a snapshot. {@link validateShapeDepth}
 * iteratively rejects excessive nesting or cycles before recursive parser
 * compilation.
 *
 * @param shape - The shape to compile
 * @returns A parser yielding the shape's inferred type or `undefined`
 *
 * @example
 * ```ts
 * const parseUser = compileParser(objectShape({ name: stringShape() }))
 * parseUser({ name: 'Ada' }) // { name: 'Ada' }
 * ```
 */
export function compileParser<S extends ContractShape>(shape: S): Parser<Infer<S>>
export function compileParser(shape: ContractShape): Parser<unknown>
export function compileParser(shape: ContractShape): Parser<unknown> {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string': {
			if (owned.min === undefined && owned.max === undefined && owned.pattern === undefined) {
				return parseString
			}
			// Coerce by type, then re-apply the SAME refinement the guard enforces (the
			// identical `stringOf`) — a value that parses but violates a bound or the
			// pattern fails the parse (returns `undefined`).
			const guard = stringOf({
				...(owned.min === undefined ? {} : { min: owned.min }),
				...(owned.max === undefined ? {} : { max: owned.max }),
				...(owned.pattern === undefined ? {} : { pattern: owned.pattern }),
			})
			return (value) => {
				const parsed = parseString(value)
				return parsed !== undefined && guard(parsed) ? parsed : undefined
			}
		}
		case 'number': {
			const base = owned.integer === true ? parseInteger : parseNumber
			if (owned.min === undefined && owned.max === undefined) return base
			// The same bound check the guard applies (integrality is already enforced by
			// `parseInteger`, so only the bounds need re-checking after coercion).
			const within = boundsOf(owned.min, owned.max)
			return (value) => {
				const parsed = base(value)
				return parsed !== undefined && within(parsed) ? parsed : undefined
			}
		}
		case 'boolean':
			return parseBoolean
		case 'null':
			return (value) => (value === null ? null : undefined)
		case 'json':
			return (value) => (isJSONValue(value) ? value : undefined)
		// The literal parser trims a matching string but never numeric-coerces —
		// `'42'` never parses to the literal `42`; only an exact (post-trim) match
		// of one of the shape's `values` succeeds. This is an intended leniency,
		// not a soundness gap: a trimmed value is re-checked against `allowed`,
		// the same `literalOf` guard the compiled guard uses.
		case 'literal': {
			const allowed = literalOf(owned.values)
			return (value) => {
				if (allowed(value)) return value
				if (isString(value)) {
					const trimmed = value.trim()
					if (allowed(trimmed)) return trimmed
				}
				return undefined
			}
		}
		case 'array': {
			const item = compileParser(owned.items)
			const unbounded = owned.min === undefined && owned.max === undefined
			const withinLength = boundsOf(owned.min, owned.max)
			return (value) => {
				if (!isArray(value)) return undefined
				const result: unknown[] = []
				for (const entry of value) {
					const parsed = item(entry)
					if (parsed === undefined) return undefined
					result.push(parsed)
				}
				// Enforce the SAME length bounds the guard does (coercion never changes
				// length, so this is checked once on the assembled result).
				return unbounded || withinLength(result.length) ? result : undefined
			}
		}
		// A closed object (no `additionalProperties`) silently drops unknown keys
		// present on the input rather than failing the parse — an intended
		// coercion leniency, and an observable one. The compiled guard rejects
		// such an input, so `parse` returning a value never implies `is` accepted
		// what it was handed: `parse({ id: 'a', debug: true })` answers
		// `{ id: 'a' }` for a shape whose `is` says false. `compileReporter`
		// mirrors this parser and reports nothing for a dropped key;
		// `compileAuditor` is the artifact that reports it, one `'extra'` fault
		// per undeclared key.
		case 'object': {
			const entries: { key: string; parse: Parser<unknown>; optional: boolean }[] = []
			for (const key of Object.keys(owned.properties)) {
				const child = owned.properties[key]
				if (child === undefined) continue
				const optional = child.type === 'optional'
				entries.push({ key, parse: compileParser(optional ? child.inner : child), optional })
			}
			const known = new Set(entries.map((entry) => entry.key))
			const extra = owned.additionalProperties
			const additional =
				extra === undefined || extra === false || extra === true ? undefined : compileParser(extra)
			const open = extra === true || additional !== undefined
			return (value) => {
				const record = parseRecord(value)
				if (record === undefined) return undefined
				const keys = enumerableKeys(record)
				if (keys === undefined) return undefined
				const present = new Set(keys)
				// Contain the whole record walk — a hostile getter on `record` must
				// yield `undefined`, never throw (AGENTS §14).
				const outcome = attempt(() => {
					// Honest typing: a null-prototype accumulator so an input own key
					// literally named '__proto__' lands as an own data key instead of
					// mutating the prototype (same pattern as `pickOf`).
					const result: Record<string, unknown> = Object.create(null)
					for (const entry of entries) {
						if (!present.has(entry.key)) {
							if (entry.optional) continue
							return undefined
						}
						const raw = record[entry.key]
						if (raw === undefined) {
							if (entry.optional) continue
							return undefined
						}
						const parsed = entry.parse(raw)
						if (parsed === undefined) return undefined
						result[entry.key] = parsed
					}
					if (open) {
						for (const key of keys) {
							if (known.has(key)) continue
							if (additional === undefined) {
								result[key] = record[key]
							} else {
								const parsed = additional(record[key])
								if (parsed === undefined) return undefined
								result[key] = parsed
							}
						}
					}
					return result
				})
				return outcome.success ? outcome.value : undefined
			}
		}
		case 'union': {
			const variants = owned.variants.map((variant) => ({
				parse: compileParser(variant),
				guard: compileGuard(variant),
			}))
			// `oneOf` exactly-one semantics (documented on `oneOfShape`): judged on
			// the RAW input's guard matches only — no coercion fallback. Exactly one
			// variant's guard must accept the raw value; that variant's parser then
			// runs (its parse must equal the already guard-valid input by clause A).
			// Zero matches (no variant fits) or two-or-more matches (ambiguous —
			// which variant the value belongs to isn't well-defined) both fail the
			// parse, deliberately simpler than attempting a coercion-then-recheck
			// resolution for ambiguous input.
			if (owned.mode === 'oneOf') {
				return (value) => {
					const matches = variants.filter((variant) => variant.guard(value))
					const [only] = matches
					return matches.length === 1 && only !== undefined ? only.parse(value) : undefined
				}
			}
			return (value) => {
				// Identity pass first (AGENTS §14 clause A): a value already valid
				// against ANY variant's guard is returned unchanged, so an earlier
				// variant's coercion never overwrites a guard-valid input.
				for (const variant of variants) {
					if (variant.guard(value)) return value
				}
				// Coercion pass: no variant matched as-is, so parse-then-guard,
				// first variant that both parses and guards wins.
				for (const variant of variants) {
					const parsed = variant.parse(value)
					if (parsed !== undefined && variant.guard(parsed)) return parsed
				}
				return undefined
			}
		}
		case 'optional': {
			const inner = compileParser(owned.inner)
			return (value) => (value === undefined ? undefined : inner(value))
		}
		case 'nullable': {
			const inner = compileParser(owned.inner)
			return (value) => (value === null ? null : inner(value))
		}
		case 'raw':
			return (value) => value
	}
}

// === Generator

/**
 * Compile a {@link ContractShape} into a deterministic seed value.
 *
 * @remarks
 * The same shape and the same `random` source always produce the same value, so
 * seed data is reproducible. Defaults to a {@link seededRandom} source seeded
 * from the wall clock when none is supplied. Shape-generation failures throw a
 * {@link ContractError} with code `'generate'`; {@link drawRandom} failures use
 * code `'random'` and retain the consuming shape category in context.
 * Failures include a degenerate empty `literalShape` / `unionShape`, a
 * pattern-constrained `stringShape` whose generated sample cannot satisfy the
 * pattern, an invalid random sample, and a `rawShape` whose arbitrary embedded
 * schema cannot be auto-generated. {@link validateShapeDepth} iteratively
 * rejects excessive nesting or cycles before recursive generation begins.
 * `createContract` runs
 * {@link validateShape} first, so a degenerate `literalShape` / `unionShape` /
 * bounded shape is normally caught there; these throws remain here as defense
 * for standalone `compileGenerator` use. Union candidates are bounded by
 * {@link GENERATION_ATTEMPT_LIMIT} and accepted only when they satisfy the
 * union's compiled guard.
 *
 * @param shape - The shape to generate from
 * @param random - A seeded random source (defaults to `seededRandom(Date.now())`)
 * @returns A value matching the shape
 * @throws {ContractError} When the shape or random source cannot produce a valid value
 *
 * @example
 * ```ts
 * compileGenerator(stringShape({ min: 1, max: 4 })) // a random string of 1-4 characters (seed a RandomFunction for determinism)
 * ```
 */
export function compileGenerator<S extends ContractShape>(
	shape: S,
	random?: RandomFunction,
): Infer<S>
export function compileGenerator(shape: ContractShape, random?: RandomFunction): unknown
export function compileGenerator(
	shape: ContractShape,
	random: RandomFunction = seededRandom(Date.now()),
): unknown {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string': {
			const min = owned.min ?? 0
			const max = owned.max ?? Math.max(min, 12)
			const length = Math.max(min, Math.min(max, 8))
			const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
			let value = ''
			for (let index = 0; index < length; index += 1) {
				value += alphabet[Math.floor(drawRandom(random, 'string') * alphabet.length)]
			}
			if (owned.pattern !== undefined && !matchOf(owned.pattern)(value)) {
				throw new ContractError(
					'compileGenerator: a pattern-constrained string shape cannot be auto-generated — supply or verify values another way',
					{
						code: 'generate',
						context: { shape: 'string', limit: owned.pattern.source },
					},
				)
			}
			return value
		}
		case 'number': {
			const sample = drawRandom(random, owned.integer === true ? 'integer' : 'number')
			if (owned.integer === true) {
				const lo = Math.ceil(owned.min ?? (owned.max === undefined ? -100 : owned.max - 100))
				const hi = Math.floor(owned.max ?? (owned.min === undefined ? 100 : owned.min + 100))
				return lo === hi ? lo : Math.floor(lo * (1 - sample) + hi * sample)
			}
			const lo = owned.min ?? (owned.max === undefined ? -100 : owned.max - 100)
			const hi = owned.max ?? (owned.min === undefined ? 100 : owned.min + 100)
			return lo === hi ? lo : lo * (1 - sample) + hi * sample
		}
		case 'boolean':
			return drawRandom(random, 'boolean') >= 0.5
		case 'null':
			return null
		case 'json': {
			const pick = Math.floor(drawRandom(random, 'json') * 5)
			if (pick === 0) return null
			if (pick === 1) return drawRandom(random, 'json') >= 0.5
			if (pick === 2) return Math.floor(drawRandom(random, 'json') * 1000)
			if (pick === 3) {
				const alphabet = 'abcdefghijklmnopqrstuvwxyz'
				let value = ''
				for (let index = 0; index < 6; index += 1) {
					value += alphabet[Math.floor(drawRandom(random, 'json') * alphabet.length)]
				}
				return value
			}
			return { value: Math.floor(drawRandom(random, 'json') * 1000) }
		}
		case 'literal': {
			if (owned.values.length === 0) {
				throw new ContractError('compileGenerator: a literal shape needs at least one value', {
					code: 'generate',
					context: { shape: 'literal', limit: 1 },
				})
			}
			return owned.values[Math.floor(drawRandom(random, 'literal') * owned.values.length)]
		}
		case 'array': {
			const lo = owned.min ?? Math.min(1, owned.max ?? 1)
			const hi = owned.max ?? Math.max(lo, 3)
			const length = Math.floor(drawRandom(random, 'array') * (hi - lo + 1)) + lo
			const result: unknown[] = []
			for (let index = 0; index < length; index += 1) {
				result.push(compileGenerator(owned.items, random))
			}
			return result
		}
		case 'object': {
			// Honest typing: generated data is a value the caller keeps, so unlike the
			// guard's and parser's null-prototype property views it carries the normal
			// object prototype — `defineProperty` (never assignment) still lands a
			// '__proto__' key as an own data key rather than mutating that prototype.
			const result: Record<string, unknown> = {}
			for (const key of Object.keys(owned.properties)) {
				const child = owned.properties[key]
				if (child === undefined) continue
				if (child.type === 'optional' && drawRandom(random, 'object') < 0.3) continue
				Object.defineProperty(result, key, {
					value: compileGenerator(child, random),
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}
			// An open object (additionalProperties is a shape, not a boolean) also
			// generates synthetic extra entries so the shape does not trivially
			// generate as `{}` — skip any collision with a declared property name.
			const extra = owned.additionalProperties
			if (extra !== undefined && extra !== true && extra !== false) {
				const count = 1 + Math.floor(drawRandom(random, 'object') * 2)
				for (let index = 0; index < count; index += 1) {
					const key = `key${index}`
					if (Object.hasOwn(result, key)) continue
					Object.defineProperty(result, key, {
						value: compileGenerator(extra, random),
						enumerable: true,
						configurable: true,
						writable: true,
					})
				}
			}
			return result
		}
		case 'union': {
			if (owned.variants.length === 0) {
				throw new ContractError('compileGenerator: a union shape needs at least one variant', {
					code: 'generate',
					context: { shape: 'union', limit: 1 },
				})
			}
			const guard = compileGuard<ContractShape>(owned)
			const attempts = Math.max(GENERATION_ATTEMPT_LIMIT, owned.variants.length)
			const start = Math.floor(drawRandom(random, 'union') * owned.variants.length)
			for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
				const variant = owned.variants[(start + attemptIndex) % owned.variants.length]
				if (variant === undefined) continue
				const outcome = attempt(() => compileGenerator(variant, random))
				if (!outcome.success && isContractError(outcome.error) && outcome.error.code === 'random') {
					throw outcome.error
				}
				if (outcome.success && guard(outcome.value)) return outcome.value
			}
			throw new ContractError('compileGenerator: no union candidate satisfied the compiled guard', {
				code: 'generate',
				context: { shape: 'union', limit: attempts },
			})
		}
		case 'optional':
			return compileGenerator(owned.inner, random)
		case 'nullable':
			return drawRandom(random, 'nullable') < 0.2 ? null : compileGenerator(owned.inner, random)
		case 'raw':
			throw new ContractError(
				'compileGenerator: a raw shape embeds an arbitrary JSON Schema and cannot be auto-generated — supply values another way',
				{
					code: 'generate',
					context: { shape: 'raw', limit: 'explicit value source' },
				},
			)
	}
}

// === Reporter

/**
 * Compile a {@link ContractShape} into a structured fault report for a value —
 * the diagnostic counterpart of {@link compileGuard} / {@link compileParser}.
 *
 * @remarks
 * MIRROR-PARSE semantics: reuses the exact leaf parsers/guards
 * {@link compileParser} uses (`parseString` / `parseNumber` / `parseBoolean` /
 * `isJSONValue` / …), so the soundness invariant
 * `compileReporter(shape, v).length === 0 ⟺ compileParser(shape)(v) !== undefined`
 * holds structurally — `explain` mirrors `parse`, not the stricter `is` (a
 * coercible value like `'42'` against a `numberShape` reports no fault, the
 * same leniency `parse` grants, even though the strict guard would reject it).
 * The invariant relates two separate calls, so it holds for a value whose reads
 * are stable across calls; see the read-stability precondition on
 * {@link ContractInterface}. {@link compileAuditor} is the counterpart report
 * for the strict domain, mirroring {@link compileGuard} the way this one
 * mirrors {@link compileParser}.
 *
 * Faults are collected in stable pre-order (declared key/index order); every
 * call — object, array, and union alike, including a union's `oneOf` "no
 * match" / "no consensus" summary fault prepended to its closest variant's
 * faults — slices its return to at most {@link FAULT_LIMIT} entries, so the
 * bound holds at every level of nesting, not just the outermost container, on
 * adversarial input (a huge array, a wide record, a wide union of wide
 * records). A closed object's extra keys never
 * fault — `parse` silently drops them, so `explain` mirrors that leniency, and
 * {@link compileAuditor} is where they do fault; an open object with a
 * constraining `additionalProperties` shape recurses extras against it instead.
 * A hostile getter or throwing `Proxy` trap is contained via {@link attempt}
 * and surfaces as a single top-level type fault, never a throw (AGENTS §14).
 * {@link validateShapeDepth} iteratively rejects excessive shape nesting or
 * cycles before recursive reporting begins.
 *
 * @param shape - The shape to report against
 * @param value - The value to check
 * @param path - The path prefix for faults produced at this call (defaults to the root)
 * @returns The faults found, empty when the value parses successfully
 *
 * @example
 * ```ts
 * const user = objectShape({ name: stringShape({ min: 1 }) })
 * compileReporter(user, { name: '' })
 * // [{ reason: 'constraint', path: ['name'], expected: 'string', constraint: 'min', limit: 1, received: '""' }]
 * compileReporter(user, { name: 'Ada' }) // []
 * ```
 */
export function compileReporter(
	shape: ContractShape,
	value: unknown,
	path: string[] = [],
): readonly Fault[] {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string': {
			const parsed = parseString(value)
			if (parsed === undefined) {
				return [{ reason: 'type', path, expected: 'string', received: preview(value) }]
			}
			const faults: Fault[] = []
			if (owned.min !== undefined && parsed.length < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'min',
					limit: owned.min,
					received: preview(parsed),
				})
			}
			if (owned.max !== undefined && parsed.length > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'max',
					limit: owned.max,
					received: preview(parsed),
				})
			}
			if (owned.pattern !== undefined && !matchOf(owned.pattern)(parsed)) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'pattern',
					limit: owned.pattern.source,
					received: preview(parsed),
				})
			}
			return faults
		}
		case 'number': {
			const kind: FaultKind = owned.integer === true ? 'integer' : 'number'
			const parsed = parseNumber(value)
			if (parsed === undefined) {
				return [{ reason: 'type', path, expected: kind, received: preview(value) }]
			}
			const faults: Fault[] = []
			if (owned.integer === true && !Number.isInteger(parsed)) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'integer',
					received: preview(parsed),
				})
			}
			if (owned.min !== undefined && parsed < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'min',
					limit: owned.min,
					received: preview(parsed),
				})
			}
			if (owned.max !== undefined && parsed > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'max',
					limit: owned.max,
					received: preview(parsed),
				})
			}
			return faults
		}
		case 'boolean':
			return parseBoolean(value) === undefined
				? [{ reason: 'type', path, expected: 'boolean', received: preview(value) }]
				: []
		case 'null':
			return value === null
				? []
				: [{ reason: 'type', path, expected: 'null', received: preview(value) }]
		case 'json':
			return isJSONValue(value)
				? []
				: [{ reason: 'type', path, expected: 'json', received: preview(value) }]
		case 'literal': {
			const allowed = literalOf(owned.values)
			const matched = allowed(value) || (isString(value) && allowed(value.trim()))
			return matched
				? []
				: [{ reason: 'type', path, expected: 'literal', received: preview(value) }]
		}
		case 'array': {
			if (!isArray(value)) {
				return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
			}
			const faults: Fault[] = []
			const outcome = attempt(() => {
				for (let index = 0; index < value.length; index += 1) {
					if (faults.length >= FAULT_LIMIT) return
					faults.push(...compileReporter(owned.items, value[index], [...path, String(index)]))
				}
			})
			if (!outcome.success) {
				return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
			}
			if (owned.min !== undefined && value.length < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'array',
					constraint: 'min',
					limit: owned.min,
					received: String(value.length),
				})
			}
			if (owned.max !== undefined && value.length > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'array',
					constraint: 'max',
					limit: owned.max,
					received: String(value.length),
				})
			}
			return faults.length > FAULT_LIMIT ? faults.slice(0, FAULT_LIMIT) : faults
		}
		case 'object': {
			if (!isRecord(value)) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			const record = value
			const keys = enumerableKeys(record)
			if (keys === undefined) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			const present = new Set(keys)
			const faults: Fault[] = []
			const known = new Set<string>()
			const outcome = attempt(() => {
				for (const key of Object.keys(owned.properties)) {
					if (faults.length >= FAULT_LIMIT) return
					const child = owned.properties[key]
					if (child === undefined) continue
					known.add(key)
					const optional = child.type === 'optional'
					const inner = optional ? child.inner : child
					// Mirror the parser's presence gate exactly: only an own
					// enumerable string key is present. A present key with an
					// explicit `undefined` value is still treated like absence, so
					// `explain` never faults where `parse` silently skips it.
					if (!present.has(key)) {
						if (!optional) {
							faults.push({ reason: 'missing', path: [...path, key], expected: shapeToKind(inner) })
						}
						continue
					}
					const raw = record[key]
					if (raw === undefined) {
						if (!optional) {
							faults.push({ reason: 'missing', path: [...path, key], expected: shapeToKind(inner) })
						}
						continue
					}
					faults.push(...compileReporter(inner, raw, [...path, key]))
				}
				const extra = owned.additionalProperties
				if (extra !== undefined && extra !== true && extra !== false) {
					for (const key of keys) {
						if (faults.length >= FAULT_LIMIT) return
						if (known.has(key)) continue
						faults.push(...compileReporter(extra, record[key], [...path, key]))
					}
				}
			})
			if (!outcome.success) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			return faults.length > FAULT_LIMIT ? faults.slice(0, FAULT_LIMIT) : faults
		}
		case 'union': {
			const perVariant = owned.variants.map((variant) => compileReporter(variant, value, path))
			let bestIndex = 0
			for (let index = 1; index < perVariant.length; index += 1) {
				const current = perVariant[index]
				const best = perVariant[bestIndex]
				if (current !== undefined && best !== undefined && current.length < best.length) {
					bestIndex = index
				}
			}
			const closest = perVariant[bestIndex] ?? []
			if (owned.mode === 'oneOf') {
				let matched = 0
				for (const variant of owned.variants) {
					if (compileGuard(variant)(value)) matched += 1
				}
				if (matched === 1) return []
				if (matched === 0) {
					const summary: Fault = { reason: 'oneOf', path, matched: 0 }
					return [summary, ...closest].slice(0, FAULT_LIMIT)
				}
				return [{ reason: 'oneOf', path, matched }]
			}
			const anyMatch = perVariant.some((variantFaults) => variantFaults.length === 0)
			if (anyMatch) return []
			const summary: Fault = { reason: 'variant', path, variants: owned.variants.length }
			return [summary, ...closest].slice(0, FAULT_LIMIT)
		}
		case 'optional':
			return value === undefined ? [] : compileReporter(owned.inner, value, path)
		case 'nullable':
			return value === null ? [] : compileReporter(owned.inner, value, path)
		case 'raw':
			return value === undefined
				? [{ reason: 'type', path, expected: 'json', received: preview(value) }]
				: []
	}
}

/**
 * Audit a value against the strict acceptance domain of a {@link ContractShape}.
 *
 * @remarks
 * The diagnostic for the domain {@link compileGuard} and {@link compileSchema}
 * describe, where {@link compileReporter} diagnoses the wider preimage
 * {@link compileParser} maps into it. This walk therefore mirrors the guard:
 * leaf coercions are faults, closed-object extras are faults, and union
 * acceptance is decided from each variant's strict audit emptiness, so the
 * soundness invariant
 * `compileAuditor(shape, v).length === 0 ⟺ compileGuard(shape)(v)` holds
 * structurally. {@link validateShapeDepth} rejects a missing or unrecognized
 * child before either artifact recurses, so a malformed declaration cannot
 * create an empty audit beside a rejecting guard. The invariant relates two
 * separate calls, so it holds for a value whose reads are stable across calls;
 * see the read-stability precondition on {@link ContractInterface}. Every
 * recursive call returns at most {@link FAULT_LIMIT} entries. Hostile property
 * access is contained through {@link attempt} and collapses to one fault at the
 * current container path.
 *
 * @param shape - The shape to audit against
 * @param value - The value to check
 * @param path - The path prefix for faults produced at this call
 * @returns The strict faults found, empty exactly when the compiled guard accepts a stably-read value
 *
 * @example
 * ```ts
 * const user = objectShape({ name: stringShape() })
 * compileAuditor(user, { name: 'Ada', extra: true })
 * // [{ reason: 'extra', path: ['extra'] }]
 * ```
 */
export function compileAuditor(
	shape: ContractShape,
	value: unknown,
	path: string[] = [],
): readonly AuditFault[] {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string': {
			if (!isString(value)) {
				return [{ reason: 'type', path, expected: 'string', received: preview(value) }]
			}
			const faults: AuditFault[] = []
			if (owned.min !== undefined && value.length < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'min',
					limit: owned.min,
					received: preview(value),
				})
			}
			if (owned.max !== undefined && value.length > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'max',
					limit: owned.max,
					received: preview(value),
				})
			}
			if (owned.pattern !== undefined && !matchOf(owned.pattern)(value)) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'pattern',
					limit: owned.pattern.source,
					received: preview(value),
				})
			}
			return faults
		}
		case 'number': {
			const kind: FaultKind = owned.integer === true ? 'integer' : 'number'
			if (!isFiniteNumber(value)) {
				return [{ reason: 'type', path, expected: kind, received: preview(value) }]
			}
			const faults: AuditFault[] = []
			if (owned.integer === true && !Number.isInteger(value)) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'integer',
					received: preview(value),
				})
			}
			if (owned.min !== undefined && value < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'min',
					limit: owned.min,
					received: preview(value),
				})
			}
			if (owned.max !== undefined && value > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'max',
					limit: owned.max,
					received: preview(value),
				})
			}
			return faults
		}
		case 'boolean':
			return isBoolean(value)
				? []
				: [{ reason: 'type', path, expected: 'boolean', received: preview(value) }]
		case 'null':
			return value === null
				? []
				: [{ reason: 'type', path, expected: 'null', received: preview(value) }]
		case 'json':
			return isJSONValue(value)
				? []
				: [{ reason: 'type', path, expected: 'json', received: preview(value) }]
		case 'literal':
			return literalOf(owned.values)(value)
				? []
				: [{ reason: 'type', path, expected: 'literal', received: preview(value) }]
		case 'array': {
			if (!isArray(value)) {
				return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
			}
			const faults: AuditFault[] = []
			const outcome = attempt(() => {
				for (let index = 0; index < value.length; index += 1) {
					if (faults.length >= FAULT_LIMIT) return
					const entry = Object.hasOwn(value, index) ? value[index] : undefined
					faults.push(...compileAuditor(owned.items, entry, [...path, String(index)]))
				}
				if (owned.min !== undefined && value.length < owned.min) {
					faults.push({
						reason: 'constraint',
						path,
						expected: 'array',
						constraint: 'min',
						limit: owned.min,
						received: String(value.length),
					})
				}
				if (owned.max !== undefined && value.length > owned.max) {
					faults.push({
						reason: 'constraint',
						path,
						expected: 'array',
						constraint: 'max',
						limit: owned.max,
						received: String(value.length),
					})
				}
			})
			if (!outcome.success) {
				return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
			}
			return faults.length > FAULT_LIMIT ? faults.slice(0, FAULT_LIMIT) : faults
		}
		case 'object': {
			if (!isRecord(value)) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			const record = value
			const keys = enumerableKeys(record)
			if (keys === undefined) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			const present = new Set(keys)
			const declaredKeys = Object.keys(owned.properties)
			const declared = new Set(declaredKeys)
			const faults: AuditFault[] = []
			const extra = owned.additionalProperties
			const closed = extra === undefined || extra === false
			const additional = closed || extra === true ? undefined : extra
			const outcome = attempt(() => {
				for (const key of declaredKeys) {
					if (faults.length >= FAULT_LIMIT) return
					const child = owned.properties[key]
					if (child === undefined) continue
					const optional = child.type === 'optional'
					const inner = optional ? child.inner : child
					if (!present.has(key)) {
						if (!optional) {
							faults.push({
								reason: 'missing',
								path: [...path, key],
								expected: shapeToKind(inner),
							})
						}
						continue
					}
					faults.push(...compileAuditor(inner, record[key], [...path, key]))
				}
				for (const key of keys) {
					if (faults.length >= FAULT_LIMIT) return
					if (declared.has(key)) continue
					if (closed) {
						faults.push({ reason: 'extra', path: [...path, key] })
					} else if (additional !== undefined) {
						faults.push(...compileAuditor(additional, record[key], [...path, key]))
					}
				}
			})
			if (!outcome.success) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			return faults.length > FAULT_LIMIT ? faults.slice(0, FAULT_LIMIT) : faults
		}
		case 'union': {
			const perVariant = owned.variants.map((variant) => compileAuditor(variant, value, path))
			const matched = perVariant.filter((faults) => faults.length === 0).length
			if (owned.mode === 'oneOf') {
				if (matched === 1) return []
				if (matched > 1) return [{ reason: 'oneOf', path, matched }]
			} else if (matched > 0) {
				return []
			}
			let bestIndex = 0
			for (let index = 1; index < perVariant.length; index += 1) {
				const current = perVariant[index]
				const best = perVariant[bestIndex]
				if (current !== undefined && best !== undefined && current.length < best.length) {
					bestIndex = index
				}
			}
			const closest = perVariant[bestIndex] ?? []
			const summary: AuditFault =
				owned.mode === 'oneOf'
					? { reason: 'oneOf', path, matched: 0 }
					: { reason: 'variant', path, variants: owned.variants.length }
			return [summary, ...closest].slice(0, FAULT_LIMIT)
		}
		case 'optional':
			return value === undefined ? [] : compileAuditor(owned.inner, value, path)
		case 'nullable':
			return value === null ? [] : compileAuditor(owned.inner, value, path)
		case 'raw':
			return value === undefined
				? [{ reason: 'type', path, expected: 'json', received: preview(value) }]
				: []
	}
}

// === Contract

/**
 * Compile a {@link ContractShape} into a {@link ContractInterface} — the six
 * lockstep outputs from one declaration, lockstep meaning derived from one
 * owned snapshot rather than accepting the same values.
 *
 * @remarks
 * Runs {@link validateShape} first — a malformed shape throws immediately
 * rather than compiling into a silently-wrong contract (AGENTS §12). It always
 * takes its own {@link cloneShape} snapshot — never merely a frozen node's word
 * — and hands that same graph to every artifact compiler.
 * Then it precompiles the deeply frozen owned schema, guard, and parser once;
 * `generate` walks the snapshot per call with the supplied random source;
 * `audit` and `explain` compile their diagnostic reports via
 * {@link compileAuditor} and {@link compileReporter} at zero added compile-time
 * cost (they re-walk the snapshot per call, exactly like `generate`).
 *
 * @param shape - The shape to compile
 * @returns A contract bundling `schema` / `is` / `parse` / `audit` / `explain` / `generate`
 *
 * @example
 * ```ts
 * const user = createContract(objectShape({ name: stringShape(), age: integerShape() }))
 * user.is({ name: 'Ada', age: 36 })        // true
 * user.parse({ name: 'Ada', age: '36' })   // { name: 'Ada', age: 36 }
 * user.schema                              // { type: 'object', properties: { … }, … }
 * ```
 */
export function createContract<S extends ContractShape>(shape: S): ContractInterface<Infer<S>>
export function createContract(shape: ContractShape): ContractInterface<unknown>
export function createContract(shape: ContractShape): ContractInterface<unknown> {
	const snapshot = cloneShape(shape)
	validateShape(snapshot)
	const schema = compileSchema(snapshot)
	const guard = compileGuard(snapshot)
	const parser = compileParser(snapshot)
	return {
		schema,
		is: guard,
		parse(value: unknown): unknown {
			return parser(value)
		},
		audit(value: unknown): readonly AuditFault[] {
			return compileAuditor(snapshot, value)
		},
		explain(value: unknown): readonly Fault[] {
			return compileReporter(snapshot, value)
		},
		generate(random?: RandomFunction): unknown {
			return compileGenerator(snapshot, random)
		},
	}
}
