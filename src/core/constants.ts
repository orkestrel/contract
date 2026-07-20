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

// Value-to-schema inference bounds (`valueToSchema` / `samplesToSchema`).

/**
 * The default maximum object/array nesting depth {@link valueToSchema} walks,
 * frozen.
 *
 * @remarks
 * Bounds inference against adversarial or cyclic runtime input — once the
 * remaining depth budget reaches zero, inference stops descending and emits
 * the empty accept-anything schema `{}` for that branch instead of recursing
 * further. Overridable per call via {@link ValueToSchemaOptions.maxDepth}.
 */
export const INFER_DEPTH_LIMIT = 32

/**
 * The default maximum number of object properties / array elements
 * {@link valueToSchema} samples per container, frozen.
 *
 * @remarks
 * Bounds the work (and the emitted schema's size) against a wide record or a
 * huge array — properties/elements beyond this cap are never inspected.
 * Overridable per call via {@link ValueToSchemaOptions.maxProperties}.
 */
export const INFER_BREADTH_LIMIT = 256

/**
 * The default maximum number of distinct values a multi-sample slot may hold
 * before enum inference gives up and falls back to a bare `type`, frozen.
 *
 * @remarks
 * Bounds how large an `enum` list {@link samplesToSchema} / {@link inferRecordSamples}
 * will emit — a slot with distinct-value count at or above this limit is
 * treated as unbounded (an ID column, not a category) and never gets an
 * `enum` keyword. Overridable per call via {@link ValueToSchemaOptions.enum}
 * (which gates whether enum inference runs at all).
 */
export const INFER_ENUM_LIMIT = 12

/**
 * The maximum string length {@link stringToFormat} attempts to classify,
 * frozen.
 *
 * @remarks
 * Bounds per-string format-detection work: a value longer than this returns
 * `undefined` immediately, before any pattern match runs. 128 sits
 * comfortably above the longest real format token — an RFC 3339 date-time
 * with fractional seconds and a UTC offset — so no legitimate classification
 * changes; only pathologically long strings (a multi-megabyte payload passed
 * as a candidate email/URI) are skipped.
 */
export const FORMAT_MAX_LENGTH = 128

/**
 * Pure-regex matchers backing {@link stringToFormat}'s pattern-only formats
 * (`uuid` / `email` / `uri`), frozen as data.
 *
 * @remarks
 * The ISO-8601 date/time formats are NOT listed here — they additionally
 * require an attempt-guarded `Date` validity check, so their pattern lives
 * inline in `stringToFormat` rather than as reusable standalone data.
 */
export const FORMAT_PATTERNS: Readonly<Record<'uuid' | 'email' | 'uri', RegExp>> = Object.freeze({
	uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
	uri: /^[a-z][a-z0-9+.-]*:\/\//i,
})
