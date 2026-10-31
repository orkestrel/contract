import type { JSONSchema, SampleMemo } from './types.js'
import { INFER_ENUM_LIMIT, INTRINSICS } from './constants.js'
import {
	readIndexView,
	iterateIndices,
	attempt,
	buildSampleMemo,
	enumerableKeys,
	isFailure,
	limitEntries,
	readSampleMemo,
	sortValues,
} from './helpers.js'
import { isRecord } from './validators.js'
import { inferPrimitiveEnum, samplesToFormat, unifySchemas } from './inferers.js'
import { ValueInferer } from './ValueInferer.js'

/**
 * Owns the state of one multi-sample inference walk.
 *
 * @remarks
 * The engine behind `samplesToSchema`, which is the only door that constructs
 * it. The walk's {@link SampleMemo} is a `#` field rather than a parameter, so
 * no caller can pre-populate it and serve one walk another walk's answer.
 * Construction observes nothing; `infer` runs the whole walk.
 *
 * Every sample list the walk carries is owned: the door reads and dense-checks
 * the caller's array before construction, and every list below the root is
 * collected by this class. Every budget arrives already sanitized. Unlike the
 * single-value walk, the record path carries no ancestor set — a value shared by
 * reference across sample rows is legitimate data rather than a cycle back to an
 * ancestor — so termination rests on the decrementing depth budget and the
 * shared memo.
 *
 * The class is not published and no instance escapes its door, so its prototype
 * carries nothing a caller can reach and it needs no member pinning.
 */
export class SampleInferer {
	readonly #samples: readonly unknown[]
	readonly #depth: number
	readonly #breadth: number
	readonly #closed: boolean
	readonly #format: boolean
	readonly #enumerated: boolean
	readonly #memo: SampleMemo

	constructor(
		samples: readonly unknown[],
		depth: number,
		breadth: number,
		closed: boolean,
		format: boolean,
		enumerated: boolean,
	) {
		this.#samples = samples
		this.#depth = depth
		this.#breadth = breadth
		this.#closed = closed
		this.#format = format
		this.#enumerated = enumerated
		this.#memo = buildSampleMemo()
	}

	/**
	 * Infers one JSON Schema over the retained sample list.
	 *
	 * @returns The inferred schema
	 * @throws When a sample row cannot be read
	 */
	infer(): JSONSchema {
		return this.#infer(this.#samples, this.#depth, this.#memo)
	}

	// The shared non-record recursion step, entered at the top level and again per
	// collected property. When every value is itself a plain record, delegates to
	// the record branch. Otherwise: enum inference runs FIRST when enabled —
	// `inferPrimitiveEnum` fires only for a low-cardinality, repeated,
	// single-primitive-kind slot, and its `{ enum: [...] }` result wins outright
	// (ENUM > FORMAT > bare string). Failing that, each value is classified
	// independently by a fresh single-value walk with `format` FORCED OFF (the
	// multi-sample seam: nested formats never compound into an `anyOf`) and
	// unified with `unifySchemas`; only when that unified result is exactly
	// `{ type: 'string' }` and the outer format flag is on does `samplesToFormat`
	// run to (maybe) reattach a unanimous `format`.
	#infer(samples: readonly unknown[], depth: number, memo: SampleMemo): JSONSchema {
		if (samples.length === 0) return {}
		const observed = INTRINSICS.from(
			iterateIndices(() => samples.length),
			(index) => {
				const sample = samples[index]
				return isRecord(sample) ? sample : undefined
			},
		)
		const records: ReadonlyArray<Record<string, unknown>> = INTRINSICS.reflect.apply(
			INTRINSICS.select,
			readIndexView(observed),
			[(sample: unknown) => sample !== undefined],
		)
		if (records.length === samples.length) {
			return this.#walkRecords(records, depth, memo)
		}
		if (this.#enumerated) {
			const enumSchema = inferPrimitiveEnum(samples, INFER_ENUM_LIMIT)
			if (enumSchema) return enumSchema
		}
		const schemas = INTRINSICS.from(
			iterateIndices(() => samples.length),
			(index) =>
				new ValueInferer(samples[index], depth, this.#breadth, this.#closed, false).infer(),
		)
		const unified = unifySchemas(schemas)
		if (this.#format && unified.type === 'string' && INTRINSICS.keys(unified).length === 1) {
			const detected = samplesToFormat(samples)
			if (detected) return { type: 'string', format: detected }
		}
		return unified
	}

	// The record-specialized branch. `properties` is the union of every sample's
	// own keys (sorted, capped at `#breadth`); a key is `required` only when
	// present (and non-`undefined`) in EVERY sample. Each key's schema is inferred
	// over the collected values for that key through the shared step above (one
	// less depth), so a property that is itself an array or object of varying
	// shape across rows is unified the same way the top level is, and the same
	// format and enum gating applies per key.
	//
	// `additionalProperties` is forced to `true` regardless of the closed flag when
	// the key union exceeds `#breadth`, or a readable row carries a key as an own
	// property holding `undefined`. A hostile getter or failed KEY walk reaches the
	// door's boundary instead of dropping a key or widening the whole slot.
	//
	// The memo is keyed by the slot's ORDERED row identities, not by a single row.
	// Keying only the one-row slot left every MULTI-row slot — the shape this walk
	// exists for — re-inferring a shared child once per path: two rows sharing one
	// `{ a: child, b: child }` detail cost `2^depth` inferences, the identical
	// denial of service the one-row memo was added to remove.
	#walkRecords(
		samples: ReadonlyArray<Record<string, unknown>>,
		depth: number,
		memo: SampleMemo,
	): JSONSchema {
		if (!(depth > 0)) return {}
		// The slot's ROW LIST is the key, followed one row at a time through the
		// memo's prefix chain, and the recorded schema is keyed by every budget and
		// flag the emission depends on. A multi-row list is a fresh array on every
		// call, but its rows are not: following their identities lands on the same
		// node whichever array carried them.
		const node: SampleMemo = INTRINSICS.reflect.apply(INTRINSICS.fold, samples, [
			(current: SampleMemo, row: Record<string, unknown>) => {
				const next = INTRINSICS.reflect.apply(INTRINSICS.recall, current.rows, [row])
				if (next !== undefined) return readSampleMemo(next, 'samplesToSchema')
				const fresh = buildSampleMemo()
				INTRINSICS.reflect.apply(INTRINSICS.retain, current.rows, [row, fresh])
				return fresh
			},
			memo,
		])
		const signature = `${depth}|${this.#breadth}|${this.#closed}|${this.#format}|${this.#enumerated}`
		const cached = INTRINSICS.reflect.apply(INTRINSICS.fetch, node.schemas, [signature])
		if (cached !== undefined) return cached
		const keyPairs = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(samples), [
			(sample: Record<string, unknown> | undefined) => {
				if (sample === undefined) {
					throw new INTRINSICS.error('samplesToSchema: every sample must be a record')
				}
				const sampleKeys = enumerableKeys(sample)
				if (sampleKeys === undefined) {
					throw new INTRINSICS.error('samplesToSchema: property enumeration failed')
				}
				return INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(sampleKeys), [
					(key: string) => [key, true],
				])
			},
		])
		const keySet = INTRINSICS.record<boolean>({
			[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [keyPairs]),
		})
		const allKeys = sortValues(INTRINSICS.keys(keySet))
		const keys = limitEntries(allKeys, this.#breadth)
		const truncated = allKeys.length > this.#breadth
		const columns = INTRINSICS.from(
			iterateIndices(() => keys.length),
			(index) => {
				const key = keys[index]
				if (key === undefined) return { key, schema: undefined, dropped: false, required: false }
				const valuesOutcome = attempt(() => {
					const observed = INTRINSICS.from(
						iterateIndices(() => samples.length),
						(sampleIndex) => {
							const sample = samples[sampleIndex]
							if (sample === undefined) {
								throw new INTRINSICS.error('samplesToSchema: every sample must be a record')
							}
							const value = sample[key]
							return { value, dropped: value === undefined && INTRINSICS.own(sample, key) }
						},
					)
					const present = INTRINSICS.reflect.apply(INTRINSICS.select, readIndexView(observed), [
						(entry: { readonly value: unknown }) => entry.value !== undefined,
					])
					const values: readonly unknown[] = INTRINSICS.reflect.apply(
						INTRINSICS.project,
						readIndexView(present),
						[(entry: { readonly value: unknown }) => entry.value],
					)
					const dropped: boolean = INTRINSICS.reflect.apply(INTRINSICS.some, observed, [
						(entry: { readonly dropped: boolean }) => entry.dropped,
					])
					return { values, dropped }
				})
				if (isFailure(valuesOutcome)) throw valuesOutcome.error
				const { values, dropped } = valuesOutcome.value
				return {
					key,
					schema: values.length > 0 ? this.#infer(values, depth - 1, memo) : undefined,
					dropped,
					required: !dropped && values.length === samples.length,
				}
			},
		)
		const pairs = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(columns), [
			(column: { readonly key: string | undefined; readonly schema: JSONSchema | undefined }) =>
				column.key === undefined || column.schema === undefined
					? []
					: [[column.key, column.schema]],
		])
		const properties = INTRINSICS.rebase(
			INTRINSICS.record<JSONSchema>({
				[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [pairs]),
			}),
			null,
		)
		const required: readonly string[] = INTRINSICS.reflect.apply(
			INTRINSICS.expand,
			readIndexView(columns),
			[
				(column: { readonly key: string | undefined; readonly required: boolean }) =>
					column.required && column.key !== undefined ? [column.key] : [],
			],
		)
		const partial =
			truncated ||
			INTRINSICS.reflect.apply(INTRINSICS.some, columns, [
				(column: { readonly dropped: boolean }) => column.dropped,
			])
		const schema: JSONSchema = {
			type: 'object',
			...(INTRINSICS.keys(properties).length > 0 ? { properties } : {}),
			...(required.length > 0 ? { required } : {}),
			additionalProperties: partial ? true : !this.#closed,
		}
		INTRINSICS.reflect.apply(INTRINSICS.store, node.schemas, [signature, schema])
		return schema
	}
}
