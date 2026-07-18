import type { JSONSchemaType } from './types.js'

// JSON-related constants. Kept as plain frozen data so the shipped combinators
// and parsers operate on them directly — there is deliberately no bespoke
// JSON-Schema guard (AGENTS §14 — the deep recursive validators stay out by
// design).

/**
 * The seven standard JSON Schema `type` names, frozen.
 *
 * @remarks
 * The runtime source of truth for the {@link JSONSchemaType} vocabulary. Compose
 * it with the shipped primitives instead of reaching for a bespoke guard:
 * `literalOf(...JSON_SCHEMA_TYPES)` is the guard, and
 * `parseEnum(value, JSON_SCHEMA_TYPES)` / `parseEnumField(record, path, JSON_SCHEMA_TYPES)`
 * is the parser.
 *
 * @example
 * ```ts
 * import { JSON_SCHEMA_TYPES, literalOf, parseEnumField } from '@src/core'
 *
 * const isSchemaType = literalOf(...JSON_SCHEMA_TYPES) // Guard<JSONSchemaType>
 * parseEnumField(schema, 'type', JSON_SCHEMA_TYPES)    // JSONSchemaType | undefined
 * ```
 */
export const JSON_SCHEMA_TYPES: readonly JSONSchemaType[] = Object.freeze([
	'null',
	'boolean',
	'object',
	'array',
	'number',
	'integer',
	'string',
])

// Reporting-surface bounds (`compileReporter` / `ContractInterface.explain`).

/**
 * The maximum number of {@link Fault} entries a single `explain` report ever
 * returns, frozen.
 *
 * @remarks
 * Bounds the report against adversarial input (a giant array, a wide record) —
 * `compileReporter` collects faults in stable pre-order and stops once this cap
 * is reached, so the report size (and the work to build it) stays finite and
 * deterministic regardless of the input's size.
 */
export const FAULT_LIMIT = 64

/**
 * The maximum character length of a {@link preview}-rendered string, frozen.
 *
 * @remarks
 * A previewed string longer than this is clipped with a trailing `…` so a
 * {@link Fault}'s `received` field never embeds an unbounded amount of
 * untrusted text.
 */
export const PREVIEW_LIMIT = 64
