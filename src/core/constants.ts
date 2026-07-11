import { JSONSchemaType } from './types'

/**
 * The `{{placeholder}}` marker pattern — whitespace-tolerant inside the braces
 * (`{{ name }}` matches `name`), capturing a dotted identifier path
 * (`{{outcome.total}}` captures `outcome.total`). Global so a `replace`
 * substitutes every occurrence.
 *
 * @remarks
 * A global `RegExp` carries a mutable `lastIndex`, so a scan must build a FRESH
 * `RegExp` from this one's `source` + `flags` (never reuse this instance's
 * `lastIndex` directly) — the pattern here is the canonical definition, not a
 * shared scanner.
 */
export const PLACEHOLDER_PATTERN = /\{\{\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*}}/g

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
