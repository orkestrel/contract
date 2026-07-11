import type { Guard } from './types.js'
import type { FieldPath } from './types.js'
import { isArray, isFiniteNumber, isRecord, isString } from './validators.js'
import { resolveField } from './helpers.js'

// AGENTS §14: a parser answers "give me a `T` or nothing" — it returns the
// typed value or `undefined`, and it never throws. Each leaf parser here forms a
// SOUND pair with the guard for its output TYPE: a guard-valid input is returned
// UNCHANGED (by identity, never rejected), and every non-`undefined` output
// satisfies that type guard. The pairings (verified in parsers.test.ts):
//
//   parseString  ↔ isString          parseRecord ↔ isRecord
//   parseNumber  ↔ isFiniteNumber    parseArray  ↔ arrayOf(guard) / isArray
//   parseInteger ↔ isInteger         parseEnum   ↔ literalOf(...allowed)
//   parseBoolean ↔ isBoolean
//
// Coercion of NON-valid inputs (e.g. numeric strings → numbers) is a bonus on
// top of soundness, not a violation of it — clause A only constrains inputs the
// guard already accepts.
//
// These leaf parsers are deliberately TYPE-only: they know nothing about a
// shape's `min` / `max` / `pattern` refinements. Those refinements are enforced
// one layer up, by the compiled parser (compilers.ts `compileParser`), which
// re-applies the shared refinement combinators (`stringOf` / `boundsOf`,
// combinators.ts) after coercion — the same source the compiled guard uses. So `createContract(...).parse` IS sound against the FULL
// guard (refinements included); the split keeps each leaf parser small while the
// compiler composes the full soundness.

// === Primitive parsers

/**
 * Parse an unknown value to a string.
 *
 * @remarks
 * A string is returned unchanged; a finite number is coerced to its decimal
 * string (`42` → `'42'`). `NaN`, `±Infinity`, and every other type → `undefined`.
 *
 * @param value - The value to parse
 * @returns A string, or `undefined`
 */
export function parseString(value: unknown): string | undefined {
	if (isString(value)) return value
	if (isFiniteNumber(value)) return String(value)
	return undefined
}

/**
 * Parse an unknown value to a finite number.
 *
 * @remarks
 * A finite number is returned unchanged; a non-blank numeric string is parsed
 * via `Number(...)`. `NaN`, `±Infinity`, blank/non-numeric strings, and every
 * other type → `undefined`.
 *
 * @param value - The value to parse
 * @returns A finite number, or `undefined`
 */
export function parseNumber(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : undefined
	}
	if (isString(value)) {
		if (value.trim() === '') return undefined
		const parsed = Number(value)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

/**
 * Parse an unknown value to a finite integer.
 *
 * @remarks
 * Accepts whatever {@link parseNumber} accepts, then requires the result to have
 * no fractional part. `3.14` / `'3.14'` → `undefined`.
 *
 * @param value - The value to parse
 * @returns A finite integer, or `undefined`
 */
export function parseInteger(value: unknown): number | undefined {
	const parsed = parseNumber(value)
	if (parsed === undefined) return undefined
	return Number.isInteger(parsed) ? parsed : undefined
}

/**
 * Parse an unknown value to a boolean.
 *
 * @remarks
 * A boolean is returned unchanged. The strings `'true'` / `'false'` / `'1'` /
 * `'0'` and the numbers `1` / `0` coerce to the matching boolean. Everything
 * else → `undefined`.
 *
 * @param value - The value to parse
 * @returns A boolean, or `undefined`
 */
export function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value
	if (value === 'true' || value === '1' || value === 1) return true
	if (value === 'false' || value === '0' || value === 0) return false
	return undefined
}

// === Structural parsers

/**
 * Parse an unknown value to a plain record — the input reference, never cloned.
 *
 * @param value - The value to parse
 * @returns The record, or `undefined`
 */
export function parseRecord(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined
}

/**
 * Parse an unknown value to an array — the input reference, never cloned —
 * optionally guarding every element.
 *
 * @remarks
 * Without a `guard`, element types are NOT verified; let `T` default to
 * `unknown` rather than asserting a specific element type.
 *
 * @param value - The value to parse
 * @param guard - Optional element guard
 * @returns The array, or `undefined`
 */
export function parseArray<T = unknown>(
	value: unknown,
	guard?: Guard<T>,
): readonly T[] | undefined {
	if (!isArray<T>(value)) return undefined
	if (guard !== undefined && !value.every(guard)) return undefined
	return value
}

// === Enum parser

/**
 * Parse an unknown value as one of the allowed literal strings.
 *
 * @remarks
 * Matches with `Object.is` — the same equality `literalOf` uses — so the
 * `parseEnum ↔ literalOf(...allowed)` pairing stays exact.
 *
 * @param value - The value to parse
 * @param allowed - The permitted literal values
 * @returns The matched literal (by identity), or `undefined`
 */
export function parseEnum<const T extends string>(
	value: unknown,
	allowed: readonly T[],
): T | undefined {
	if (!isString(value)) return undefined
	for (const option of allowed) {
		if (Object.is(value, option)) return option
	}
	return undefined
}

// === Record-field parsers

/**
 * Read and parse a string field from a record by key or nested key path.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns A string, or `undefined`
 */
export function parseStringField(
	record: Record<string, unknown>,
	path: FieldPath,
): string | undefined {
	return parseString(resolveField(record, path))
}

/**
 * Read and parse a finite-number field from a record by key or nested key path.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns A finite number, or `undefined`
 */
export function parseNumberField(
	record: Record<string, unknown>,
	path: FieldPath,
): number | undefined {
	return parseNumber(resolveField(record, path))
}

/**
 * Read and parse a finite-integer field from a record by key or nested key path.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns A finite integer, or `undefined`
 */
export function parseIntegerField(
	record: Record<string, unknown>,
	path: FieldPath,
): number | undefined {
	return parseInteger(resolveField(record, path))
}

/**
 * Read and parse a boolean field from a record by key or nested key path.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns A boolean, or `undefined`
 */
export function parseBooleanField(
	record: Record<string, unknown>,
	path: FieldPath,
): boolean | undefined {
	return parseBoolean(resolveField(record, path))
}

/**
 * Read and parse a nested record field from a record by key or nested key path.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns A plain record, or `undefined`
 */
export function parseRecordField(
	record: Record<string, unknown>,
	path: FieldPath,
): Record<string, unknown> | undefined {
	return parseRecord(resolveField(record, path))
}

/**
 * Read and parse an array field from a record by key or nested key path,
 * optionally guarding elements.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @param guard - Optional element guard
 * @returns An array, or `undefined`
 */
export function parseArrayField<T = unknown>(
	record: Record<string, unknown>,
	path: FieldPath,
	guard?: Guard<T>,
): readonly T[] | undefined {
	return parseArray(resolveField(record, path), guard)
}

/**
 * Read and parse an enum field from a record by key or nested key path.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @param allowed - The permitted literal values
 * @returns The matched literal, or `undefined`
 */
export function parseEnumField<const T extends string>(
	record: Record<string, unknown>,
	path: FieldPath,
	allowed: readonly T[],
): T | undefined {
	return parseEnum(resolveField(record, path), allowed)
}

// === JSON

/**
 * Parse a JSON string, returning `undefined` instead of throwing.
 *
 * @remarks
 * The safe boundary for untrusted JSON text: a malformed string yields
 * `undefined`, never an exception. Returns `unknown` — a successful parse proves
 * nothing about shape, so narrow the result with a guard (or use
 * {@link parseJSONAs}). A large document is not walked here; parsing is shallow
 * and lazy validation is the caller's to compose.
 *
 * @param value - The JSON string to parse
 * @returns The parsed value, or `undefined` when `value` is not valid JSON
 */
export function parseJSON(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch {
		return undefined
	}
}

/**
 * Parse a JSON string and validate the result against a guard.
 *
 * @remarks
 * The lazy, safe path from an untrusted string to a typed `T`: parse, then check
 * the parsed value with the guard you bring — typically one composed from the
 * combinators (`recordOf`, `arrayOf`, …). Only the shape the guard inspects is
 * validated, so a large document is never walked in full unless the guard does.
 *
 * @param value - The JSON string to parse
 * @param guard - The guard for the expected shape
 * @returns The parsed value when it satisfies `guard`, otherwise `undefined`
 *
 * @example
 * ```ts
 * const isConfig = recordOf({ host: isString, tags: arrayOf(isString) })
 * parseJSONAs('{"host":"localhost","tags":["a"]}', isConfig) // { host: 'localhost', tags: ['a'] }
 * parseJSONAs('{"host":"localhost"}', isConfig)              // undefined — guard fails
 * parseJSONAs('not json', isConfig)                          // undefined — never throws
 * ```
 */
export function parseJSONAs<T>(value: string, guard: Guard<T>): T | undefined {
	const parsed = parseJSON(value)
	if (parsed === undefined) return undefined
	return guard(parsed) ? parsed : undefined
}
