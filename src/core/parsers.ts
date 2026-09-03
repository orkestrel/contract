import type { FieldPath, Guard, JSONValue, LiteralValue } from './types.js'
import { INTRINSICS } from './constants.js'
import {
	isArray,
	isFiniteNumber,
	isLiteralValue,
	isNull,
	isObject,
	isRecord,
	isString,
} from './validators.js'
import {
	attempt,
	collectMembers,
	contain,
	holds,
	matchesJSONValue,
	matchesMember,
	readArrayEntries,
	readValue,
	resolveField,
} from './helpers.js'

// `.claude/rules/patterns.md` § Validation and contracts: a parser answers
// "give me a `T` or nothing" — it returns the
// typed value or `undefined` for readable invalid input. `parseRecord` and
// `parseJSONValue` refuse a failed traversal with a coded `ContractError`, so
// unreadability cannot masquerade as ordinary invalidity. Each leaf parser here forms a
// SOUND pair with the guard for its output TYPE: a guard-valid input is returned
// UNCHANGED (by identity, never rejected), and every non-`undefined` output
// satisfies that type guard. The pairings (verified in parsers.test.ts):
//
//   parseString  ↔ isString          parseRecord    ↔ isRecord
//   parseNumber  ↔ isFiniteNumber    parseArray     ↔ arrayOf(guard) / isArray
//   parseInteger ↔ isInteger         parseEnum      ↔ literalOf(...allowed)
//   parseBoolean ↔ isBoolean         parseNull      ↔ isNull
//                                    parseJSONValue ↔ isJSONValue
//
// Coercion of NON-valid inputs (for example numeric strings → numbers) is a
// bonus on top of soundness, not a violation of it — soundness constrains only
// the inputs the guard already accepts.
//
// These leaf parsers are deliberately TYPE-only: they know nothing about a
// shape's `min` / `max` / `pattern` refinements. Those refinements are enforced
// one layer up, by the compiled parser (compilers.ts `compileParser`), which
// re-applies the shared refinement combinators (`stringOf` / `boundsOf`,
// combinators.ts) after coercion — the same source the compiled guard uses. So `createContract(...).parse` IS sound against the FULL
// guard (refinements included); the split keeps each leaf parser small while the
// compiler composes the full soundness.
//
// Coercion policy — which types cross into which:
//   - number <-> string is BIDIRECTIONAL by design: parseNumber accepts a
//     numeric string ('42' -> 42) and parseString accepts a finite number,
//     stringifying it (42 -> '42'). Use isString / isFiniteNumber directly
//     (never the parser) when you need STRICT type rejection with no coercion.
//   - boolean is a coercion SINK, never a source: parseBoolean accepts
//     'true'/'false'/'1'/'0' and 1/0 and coerces them TO a boolean, but
//     parseNumber and parseString both reject booleans outright — a boolean
//     never coerces INTO a number or string. This is intentional asymmetry:
//     '1' meaning "the number one" and '1' meaning "true" are genuinely
//     different domains, so only the boolean parser treats the numeric/string
//     forms as booleans.

// === Primitive parsers

/**
 * Parses an unknown value to a string.
 *
 * @remarks
 * A string is returned unchanged; a finite number is coerced to its decimal
 * string (`42` → `'42'`). `NaN`, `±Infinity`, and every other type → `undefined`.
 *
 * @param value - The value to parse
 * @returns A string, or `undefined`
 *
 * @example
 * ```ts
 * parseString('hi') // 'hi'
 * parseString(42)    // '42'
 * parseString(true)  // undefined
 * ```
 */
export function parseString(value: unknown): string | undefined {
	if (isString(value)) return value
	if (isFiniteNumber(value)) return INTRINSICS.text(value)
	return undefined
}

/**
 * Parses an unknown value to a finite number.
 *
 * @remarks
 * A finite number is returned unchanged; a non-blank numeric string is parsed
 * through `Number(...)`. `NaN`, `±Infinity`, blank/non-numeric strings, and every
 * other type → `undefined`.
 *
 * @param value - The value to parse
 * @returns A finite number, or `undefined`
 *
 * @example
 * ```ts
 * parseNumber(42)    // 42
 * parseNumber('42')  // 42
 * parseNumber('abc') // undefined
 * ```
 */
export function parseNumber(value: unknown): number | undefined {
	if (typeof value === 'number') {
		return INTRINSICS.finite(value) ? value : undefined
	}
	if (!isString(value)) return undefined
	// Total by containment at the door. `String.prototype.trim` is a
	// caller-writable member reached by name, and this reader is documented to
	// ANSWER `undefined`, never to throw — so the boundary belongs here, where it
	// covers whatever the body reaches, rather than around the one dispatch
	// somebody happened to notice.
	const outcome = attempt(() => {
		if (value.trim() === '') return undefined
		const parsed = INTRINSICS.numeric(value)
		return INTRINSICS.finite(parsed) ? parsed : undefined
	})
	return outcome.success ? outcome.value : undefined
}

/**
 * Parses an unknown value to a finite integer.
 *
 * @remarks
 * Accepts whatever {@link parseNumber} accepts, then requires the result to have
 * no fractional part. `3.14` / `'3.14'` → `undefined`.
 *
 * @param value - The value to parse
 * @returns A finite integer, or `undefined`
 *
 * @example
 * ```ts
 * parseInteger(42)   // 42
 * parseInteger(3.14) // undefined
 * ```
 */
export function parseInteger(value: unknown): number | undefined {
	const parsed = parseNumber(value)
	if (parsed === undefined) return undefined
	return INTRINSICS.integer(parsed) ? parsed : undefined
}

/**
 * Parses an unknown value to a boolean.
 *
 * @remarks
 * A boolean is returned unchanged. The strings `'true'` / `'false'` / `'1'` /
 * `'0'` and the numbers `1` / `0` coerce to the matching boolean. Everything
 * else → `undefined`.
 *
 * @param value - The value to parse
 * @returns A boolean, or `undefined`
 *
 * @example
 * ```ts
 * parseBoolean(true)   // true
 * parseBoolean('1')    // true
 * parseBoolean('nope') // undefined
 * ```
 */
export function parseBoolean(value: unknown): boolean | undefined {
	if (typeof value === 'boolean') return value
	if (value === 'true' || value === '1' || value === 1) return true
	if (value === 'false' || value === '0' || value === 0) return false
	return undefined
}

/**
 * Parses an unknown value to `null`.
 *
 * @remarks
 * A successful parse returns `null` itself — distinct from the `undefined`
 * failure sentinel every other parser in this file uses. Only `null` passes;
 * every other value (including `undefined`) → `undefined`.
 *
 * @param value - The value to parse
 * @returns `null` on a successful parse, or `undefined`
 *
 * @example
 * ```ts
 * parseNull(null)      // null
 * parseNull(undefined) // undefined
 * ```
 */
export function parseNull(value: unknown): null | undefined {
	return isNull(value) ? value : undefined
}

// === Structural parsers

/**
 * Parses an unknown value to a plain record — the input reference, never cloned.
 *
 * @param value - The value to parse
 * @returns The record, or `undefined`
 * @throws {ContractError} When an object value cannot be read
 */
export function parseRecord(value: unknown): Record<string, unknown> | undefined {
	return contain(() => {
		if (isObject(value)) readValue(() => INTRINSICS.values(value), 'parseRecord')
		return isRecord(value) ? value : undefined
	}, 'parseRecord')
}

/**
 * Parses an unknown value to an array — the input reference, never cloned —
 * optionally guarding every element.
 *
 * @remarks
 * Without a `guard`, element types are NOT verified; let `T` default to
 * `unknown` rather than asserting a specific element type.
 *
 * @param value - The value to parse
 * @param guard - Optional element guard
 * @returns The array, or `undefined`
 *
 * @example
 * ```ts
 * parseArray([1, 2])            // [1, 2]
 * parseArray([1, 'x'], isNumber) // undefined
 * ```
 */
export function parseArray<T = unknown>(
	value: unknown,
	guard?: Guard<T>,
): readonly T[] | undefined {
	if (!isArray<T>(value)) return undefined
	if (guard === undefined) return value
	const entries = readArrayEntries(value)
	if (!entries.success || !entries.value.dense) return undefined
	if (
		!holds(() => {
			// Indexed: the snapshot is an array this package built, and walking it
			// through `Array.prototype[Symbol.iterator]` would let a replaced iterator
			// decide which elements this parser ever guards.
			const collected = entries.value.entries
			for (let index = 0; index < collected.length; index += 1) {
				if (!guard(collected[index])) return false
			}
			return true
		})
	) {
		return undefined
	}
	return value
}

/**
 * Parses an unknown value to a cycle-safe JSON value — the input reference,
 * never cloned.
 *
 * @remarks
 * Unlike {@link parseRecord} / {@link parseArray}, this is a DEEP gate: it
 * walks the entire tree through {@link isJSONValue} rather than checking only the
 * top-level shape. That walk is cycle-safe. A readable non-JSON structure,
 * including a cycle, returns `undefined`; a failed property read throws a
 * `structure` {@link ContractError}, keeping unreadability distinct from an
 * honest invalid result.
 *
 * @param value - The value to parse
 * @returns The value, or `undefined` when it is not a valid JSON value
 * @throws {ContractError} When the JSON tree cannot be read
 *
 * @example
 * ```ts
 * parseJSONValue({ a: 1 })     // { a: 1 }
 * parseJSONValue(Number.NaN)   // undefined
 * ```
 */
export function parseJSONValue(value: unknown): JSONValue | undefined {
	return contain(() => {
		return readValue(
			() => (matchesJSONValue(value, new INTRINSICS.weakSet()) ? value : undefined),
			'parseJSONValue',
			{ context: { shape: 'json' } },
		)
	}, 'parseJSONValue')
}

// === Enum parser

/**
 * Parses an unknown value as one of the allowed literal primitives.
 *
 * @remarks
 * Pairs with {@link literalOf} — both match by SameValueZero, so the
 * `parseEnum ↔ literalOf(...allowed)` pairing covers every literal primitive
 * (string, number, or boolean), not only strings. Matching is identity, never
 * cross-type coercion: `parseEnum('1', [1])` stays `undefined`. The allowed
 * values are captured through their dense own-index view and copied into an
 * owned `Set`; caller-defined iteration is ignored and unreadability returns
 * `undefined` rather than escaping.
 *
 * @param value - The value to parse
 * @param allowed - The permitted literal values
 * @returns The input when it matches an allowed literal by SameValueZero, or `undefined`
 *
 * @example
 * ```ts
 * parseEnum('b', ['a', 'b', 'c']) // 'b'
 * parseEnum('z', ['a', 'b', 'c']) // undefined
 * ```
 */
export function parseEnum<const T extends LiteralValue>(
	value: unknown,
	allowed: readonly T[],
): T | undefined
export function parseEnum(
	value: unknown,
	allowed: readonly LiteralValue[],
): LiteralValue | undefined
export function parseEnum(
	value: unknown,
	allowed: readonly LiteralValue[],
): LiteralValue | undefined {
	const outcome = readArrayEntries(allowed)
	if (!outcome.success || !outcome.value.dense) return undefined
	// A parser answers `undefined`, never throws, so the vocabulary is built and
	// consulted inside the never-throw boundary — and the membership question is
	// asked through a module binding rather than any property, because a coercer
	// that returns a value outside its own allowed list is the same silent lie the
	// paired guard was answering: `Set.prototype.has = () => true` made
	// `parseEnum('zzz', ['a', 'b'])` answer `'zzz'`.
	if (!holds(() => matchesMember(collectMembers(outcome.value.entries), value))) return undefined
	return isLiteralValue(value) ? value : undefined
}

// === Record-field parsers

/**
 * Reads and parses a string field from a record by key or nested key path.
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
 * Reads and parses a finite-number field from a record by key or nested key path.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns A finite number, or `undefined`
 *
 * @example
 * ```ts
 * parseNumberField({ age: '42' }, 'age') // 42
 * parseNumberField({}, 'age')             // undefined
 * ```
 */
export function parseNumberField(
	record: Record<string, unknown>,
	path: FieldPath,
): number | undefined {
	return parseNumber(resolveField(record, path))
}

/**
 * Reads and parses a finite-integer field from a record by key or nested key path.
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
 * Reads and parses a boolean field from a record by key or nested key path.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns A boolean, or `undefined`
 *
 * @example
 * ```ts
 * parseBooleanField({ on: 'true' }, 'on') // true
 * parseBooleanField({}, 'on')              // undefined
 * ```
 */
export function parseBooleanField(
	record: Record<string, unknown>,
	path: FieldPath,
): boolean | undefined {
	return parseBoolean(resolveField(record, path))
}

/**
 * Reads and parses a `null` field from a record by key or nested key path.
 *
 * @remarks
 * A successful parse returns `null` itself — distinct from the `undefined`
 * failure sentinel, which also covers a missing field.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns `null` on a successful parse, or `undefined`
 *
 * @example
 * ```ts
 * parseNullField({ value: null }, 'value') // null
 * parseNullField({}, 'value')              // undefined
 * ```
 */
export function parseNullField(record: Record<string, unknown>, path: FieldPath): null | undefined {
	return parseNull(resolveField(record, path))
}

/**
 * Reads and parses a nested record field from a record by key or nested key path.
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
 * Reads and parses an array field from a record by key or nested key path,
 * optionally guarding elements.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @param guard - Optional element guard
 * @returns An array, or `undefined`
 *
 * @example
 * ```ts
 * parseArrayField({ tags: [1, 2] }, 'tags') // [1, 2]
 * parseArrayField({}, 'tags')                // undefined
 * ```
 */
export function parseArrayField<T = unknown>(
	record: Record<string, unknown>,
	path: FieldPath,
	guard?: Guard<T>,
): readonly T[] | undefined {
	return parseArray(resolveField(record, path), guard)
}

/**
 * Reads and parses an enum field from a record by key or nested key path.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @param allowed - The permitted literal values
 * @returns The matched literal, or `undefined`
 */
export function parseEnumField<const T extends LiteralValue>(
	record: Record<string, unknown>,
	path: FieldPath,
	allowed: readonly T[],
): T | undefined {
	return parseEnum(resolveField(record, path), allowed)
}

/**
 * Reads and parses a JSON-value field from a record by key or nested key path.
 *
 * @remarks
 * Deep-gates the field's whole subtree through {@link parseJSONValue} — see that
 * function's remarks for why this differs from the shallow
 * {@link parseRecordField} / {@link parseArrayField}.
 *
 * @param record - The source record
 * @param path - A property key, or a key path descending into nested objects
 * @returns The value, or `undefined`
 *
 * @example
 * ```ts
 * parseJSONValueField({ data: { a: 1 } }, 'data') // { a: 1 }
 * parseJSONValueField({}, 'data')                  // undefined
 * ```
 */
export function parseJSONValueField(
	record: Record<string, unknown>,
	path: FieldPath,
): JSONValue | undefined {
	return parseJSONValue(resolveField(record, path))
}

// === JSON

/**
 * Parses a JSON string, returning `undefined` instead of throwing.
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
		return INTRINSICS.decode(value)
	} catch {
		return undefined
	}
}

/**
 * Parses a JSON string and validates the result against a guard.
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
	// The guard runs inside the shared result boundary rather than beside a `let`
	// the callback assigns into: the narrowed value IS the callback's answer, so
	// it is returned rather than ferried out of the branch that proved it.
	const checked = attempt(() => (guard(parsed) ? parsed : undefined))
	return checked.success ? checked.value : undefined
}
