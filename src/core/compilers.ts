import type {
	ContractInterface,
	ContractShape,
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
	isRecord,
	isString,
	isUndefined,
} from './validators.js'
import { seededRandom } from './helpers.js'
import {
	arrayOf,
	boundsOf,
	intersectionOf,
	literalOf,
	nullableOf,
	orOf,
	recordOf,
	stringOf,
	unionOf,
	whereOf,
} from './combinators.js'
import { parseBoolean, parseInteger, parseNumber, parseRecord, parseString } from './parsers.js'

// The compilers walk a finite, developer-authored shape tree (never cyclic) and
// recurse on themselves — branches are kept inline and public per AGENTS §5,
// never hidden behind private helpers. `compileGuard` / `compileParser` reuse the
// existing combinators and parsers rather than re-implementing them.

// === Schema

/**
 * Compile a {@link ContractShape} into a JSON Schema document.
 *
 * @remarks
 * Object shapes emit `additionalProperties: false` (unless opened) and list only
 * required keys in `required`; nullable shapes emit an `anyOf` with `{ type:
 * 'null' }`. Emission only — it never inspects a runtime value.
 *
 * @param shape - The shape to compile
 * @returns The emitted JSON Schema
 */
export function compileSchema(shape: ContractShape): JSONSchema {
	switch (shape.type) {
		case 'string':
			return {
				type: 'string',
				...(shape.min !== undefined ? { minLength: shape.min } : {}),
				...(shape.max !== undefined ? { maxLength: shape.max } : {}),
				...(shape.pattern !== undefined ? { pattern: shape.pattern.source } : {}),
				...(shape.description !== undefined ? { description: shape.description } : {}),
			}
		case 'number':
			return {
				type: shape.integer === true ? 'integer' : 'number',
				...(shape.min !== undefined ? { minimum: shape.min } : {}),
				...(shape.max !== undefined ? { maximum: shape.max } : {}),
				...(shape.description !== undefined ? { description: shape.description } : {}),
			}
		case 'boolean':
			return {
				type: 'boolean',
				...(shape.description !== undefined ? { description: shape.description } : {}),
			}
		case 'literal':
			return {
				enum: [...shape.values],
				...(shape.description !== undefined ? { description: shape.description } : {}),
			}
		case 'array':
			return {
				type: 'array',
				items: compileSchema(shape.items),
				...(shape.min !== undefined ? { minItems: shape.min } : {}),
				...(shape.max !== undefined ? { maxItems: shape.max } : {}),
				...(shape.description !== undefined ? { description: shape.description } : {}),
			}
		case 'object': {
			const properties: Record<string, JSONSchema> = {}
			const required: string[] = []
			for (const key of Object.keys(shape.properties)) {
				const child = shape.properties[key]
				if (child === undefined) continue
				properties[key] = compileSchema(child)
				if (child.type !== 'optional') required.push(key)
			}
			const extra = shape.additionalProperties
			const additionalProperties: boolean | JSONSchema =
				extra === true
					? true
					: extra !== undefined && extra !== false
						? compileSchema(extra)
						: false
			return {
				type: 'object',
				...(Object.keys(properties).length > 0 ? { properties } : {}),
				...(required.length > 0 ? { required } : {}),
				additionalProperties,
				...(shape.description !== undefined ? { description: shape.description } : {}),
			}
		}
		case 'union':
			return {
				...(shape.mode === 'oneOf'
					? { oneOf: shape.variants.map((variant) => compileSchema(variant)) }
					: { anyOf: shape.variants.map((variant) => compileSchema(variant)) }),
				...(shape.description !== undefined ? { description: shape.description } : {}),
			}
		case 'optional':
			return compileSchema(shape.inner)
		case 'nullable':
			return { anyOf: [compileSchema(shape.inner), { type: 'null' }] }
		case 'raw':
			return shape.schema
	}
}

// === Guard

/**
 * Compile a {@link ContractShape} into a runtime type guard.
 *
 * @remarks
 * Reuses the combinators: `literalOf` for literals, `arrayOf` for arrays,
 * `recordOf` for closed objects, `unionOf` for unions, `nullableOf` for nullable,
 * and `whereOf` for constraint refinement. Like every guard it is total — it
 * never throws (AGENTS §14).
 *
 * @param shape - The shape to compile
 * @returns A guard narrowing to the shape's inferred type
 */
export function compileGuard(shape: ContractShape): Guard<unknown> {
	switch (shape.type) {
		case 'string':
			// `stringOf` returns bare `isString` when unrefined, else composes the
			// length-bounds + pattern refinement — the same guard the parser re-applies.
			return stringOf({ min: shape.min, max: shape.max, pattern: shape.pattern })
		case 'number': {
			const base = shape.integer === true ? isInteger : isFiniteNumber
			if (shape.min === undefined && shape.max === undefined) return base
			// `boundsOf` already refines `isFiniteNumber`; intersect with `isInteger`
			// when the leaf is an integer so both the integrality and the bounds hold.
			return shape.integer === true
				? intersectionOf(isInteger, boundsOf(shape.min, shape.max))
				: boundsOf(shape.min, shape.max)
		}
		case 'boolean':
			return isBoolean
		case 'literal':
			return literalOf(...shape.values)
		case 'array': {
			const base = arrayOf(compileGuard(shape.items))
			if (shape.min === undefined && shape.max === undefined) return base
			const withinLength = boundsOf(shape.min, shape.max)
			return whereOf(base, (value) => withinLength(value.length))
		}
		case 'object': {
			const map: Record<string, Guard<unknown>> = {}
			const optionalKeys: string[] = []
			for (const key of Object.keys(shape.properties)) {
				const child = shape.properties[key]
				if (child === undefined) continue
				if (child.type === 'optional') {
					map[key] = compileGuard(child.inner)
					optionalKeys.push(key)
				} else {
					map[key] = compileGuard(child)
				}
			}
			const extra = shape.additionalProperties
			// Closed object → the exact, optional-key-aware `recordOf`.
			if (extra === undefined || extra === false) {
				return optionalKeys.length > 0 ? recordOf(map, optionalKeys) : recordOf(map)
			}
			// Open object → validate known keys, then accept (`true`) or guard extras.
			const additional = extra === true ? undefined : compileGuard(extra)
			const required = Object.keys(map).filter((key) => !optionalKeys.includes(key))
			return (value: unknown): value is unknown => {
				if (!isRecord(value)) return false
				for (const key of required) {
					if (!Object.hasOwn(value, key)) return false
				}
				for (const key of Object.keys(value)) {
					const guard = map[key]
					if (guard !== undefined) {
						if (!guard(value[key])) return false
					} else if (additional !== undefined && !additional(value[key])) {
						return false
					}
				}
				return true
			}
		}
		case 'union':
			return unionOf(...shape.variants.map((variant) => compileGuard(variant)))
		case 'optional':
			return orOf(isUndefined, compileGuard(shape.inner))
		case 'nullable':
			return nullableOf(compileGuard(shape.inner))
		case 'raw':
			// The tautological always-true guard for `raw` — accepts anything, so `_value` is
			// genuinely unused (the `_` suppresses the unused-arg lint; AGENTS §4.8).
			return (_value: unknown): _value is unknown => true
	}
}

// === Parser

/**
 * Compile a {@link ContractShape} into an input parser.
 *
 * @remarks
 * Reuses the leaf parsers (`parseString` / `parseInteger` / `parseNumber` /
 * `parseBoolean` / `parseRecord`) and coerces structurally. An object fails as a
 * whole on any required-field failure; a union returns the first variant that
 * both parses and guards.
 *
 * After coercing a leaf, it re-applies that leaf's REFINEMENTS through the same
 * combinators `compileGuard` uses — `stringOf` for a string's length/pattern and
 * `boundsOf` for a number's value and an array's length — so a value that coerces
 * but violates a bound parses to `undefined`. The result is full parse↔guard
 * soundness (AGENTS §14): a non-`undefined` parse always satisfies the contract's
 * `is`, refinements included.
 *
 * @param shape - The shape to compile
 * @returns A parser yielding the shape's inferred type or `undefined`
 */
export function compileParser(shape: ContractShape): Parser<unknown> {
	switch (shape.type) {
		case 'string': {
			if (shape.min === undefined && shape.max === undefined && shape.pattern === undefined) {
				return parseString
			}
			// Coerce by type, then re-apply the SAME refinement the guard enforces (the
			// identical `stringOf`) — a value that parses but violates a bound or the
			// pattern fails the parse (returns `undefined`).
			const guard = stringOf({ min: shape.min, max: shape.max, pattern: shape.pattern })
			return (value) => {
				const parsed = parseString(value)
				return parsed !== undefined && guard(parsed) ? parsed : undefined
			}
		}
		case 'number': {
			const base = shape.integer === true ? parseInteger : parseNumber
			if (shape.min === undefined && shape.max === undefined) return base
			// The same bound check the guard applies (integrality is already enforced by
			// `parseInteger`, so only the bounds need re-checking after coercion).
			const within = boundsOf(shape.min, shape.max)
			return (value) => {
				const parsed = base(value)
				return parsed !== undefined && within(parsed) ? parsed : undefined
			}
		}
		case 'boolean':
			return parseBoolean
		case 'literal': {
			const allowed = new Set<unknown>(shape.values)
			return (value) => {
				if (allowed.has(value)) return value
				if (isString(value)) {
					const trimmed = value.trim()
					if (allowed.has(trimmed)) return trimmed
				}
				return undefined
			}
		}
		case 'array': {
			const item = compileParser(shape.items)
			const unbounded = shape.min === undefined && shape.max === undefined
			const withinLength = boundsOf(shape.min, shape.max)
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
		case 'object': {
			const entries: { key: string; parse: Parser<unknown>; optional: boolean }[] = []
			for (const key of Object.keys(shape.properties)) {
				const child = shape.properties[key]
				if (child === undefined) continue
				const optional = child.type === 'optional'
				entries.push({ key, parse: compileParser(optional ? child.inner : child), optional })
			}
			const known = new Set(entries.map((entry) => entry.key))
			const extra = shape.additionalProperties
			const additional =
				extra === undefined || extra === false || extra === true ? undefined : compileParser(extra)
			const open = extra === true || additional !== undefined
			return (value) => {
				const record = parseRecord(value)
				if (record === undefined) return undefined
				const result: Record<string, unknown> = {}
				for (const entry of entries) {
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
					for (const key of Object.keys(record)) {
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
			}
		}
		case 'union': {
			const variants = shape.variants.map((variant) => ({
				parse: compileParser(variant),
				guard: compileGuard(variant),
			}))
			return (value) => {
				for (const variant of variants) {
					const parsed = variant.parse(value)
					if (parsed !== undefined && variant.guard(parsed)) return parsed
				}
				return undefined
			}
		}
		case 'optional': {
			const inner = compileParser(shape.inner)
			return (value) => (value === undefined ? undefined : inner(value))
		}
		case 'nullable': {
			const inner = compileParser(shape.inner)
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
 * from the wall clock when none is supplied. Throws on a degenerate empty
 * `literalShape` / `unionShape` — a programmer error that cannot generate a
 * value (AGENTS §12).
 *
 * @param shape - The shape to generate from
 * @param random - A seeded random source (defaults to `seededRandom(Date.now())`)
 * @returns A value matching the shape
 */
export function compileGenerator(
	shape: ContractShape,
	random: RandomFunction = seededRandom(Date.now()),
): unknown {
	switch (shape.type) {
		case 'string': {
			const min = shape.min ?? 0
			const max = shape.max ?? Math.max(min, 12)
			const length = Math.max(min, Math.min(max, 8))
			const suffix = Math.floor(random() * 1_000_000)
				.toString()
				.padStart(length, '0')
			return `str_${suffix}`
		}
		case 'number': {
			const min = shape.min ?? 0
			const max = shape.max ?? 100
			const value = random() * (max - min) + min
			return shape.integer === true ? Math.floor(value) : value
		}
		case 'boolean':
			return random() >= 0.5
		case 'literal': {
			if (shape.values.length === 0) {
				throw new Error('compileGenerator: a literal shape needs at least one value')
			}
			return shape.values[Math.floor(random() * shape.values.length)]
		}
		case 'array': {
			const min = shape.min ?? 1
			const max = shape.max ?? Math.max(min, 3)
			const length = Math.floor(random() * (max - min + 1)) + min
			const result: unknown[] = []
			for (let index = 0; index < length; index += 1) {
				result.push(compileGenerator(shape.items, random))
			}
			return result
		}
		case 'object': {
			const result: Record<string, unknown> = {}
			for (const key of Object.keys(shape.properties)) {
				const child = shape.properties[key]
				if (child === undefined) continue
				if (child.type === 'optional' && random() < 0.3) continue
				result[key] = compileGenerator(child, random)
			}
			return result
		}
		case 'union': {
			if (shape.variants.length === 0) {
				throw new Error('compileGenerator: a union shape needs at least one variant')
			}
			return compileGenerator(shape.variants[Math.floor(random() * shape.variants.length)], random)
		}
		case 'optional':
			return compileGenerator(shape.inner, random)
		case 'nullable':
			return random() < 0.2 ? null : compileGenerator(shape.inner, random)
		case 'raw':
			return undefined
	}
}

// === Contract

/**
 * Compile a {@link ContractShape} into a {@link ContractInterface} — the four
 * lockstep outputs from one declaration.
 *
 * @remarks
 * Precompiles the schema, guard, and parser once; `generate` walks the shape per
 * call with the supplied random source.
 *
 * @param shape - The shape to compile
 * @returns A contract bundling `schema` / `is` / `parse` / `generate`
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
	const schema = compileSchema(shape)
	const guard = compileGuard(shape)
	const parser = compileParser(shape)
	return {
		schema,
		is: guard,
		parse(value: unknown): unknown {
			return parser(value)
		},
		generate(random?: RandomFunction): unknown {
			return compileGenerator(shape, random)
		},
	}
}
