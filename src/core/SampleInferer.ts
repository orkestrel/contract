import type { JSONSchema, SampleMemo } from './types.js'
import { INFER_ENUM_LIMIT, INTRINSICS } from './constants.js'
import {
	admitMember,
	attempt,
	buildSampleMemo,
	collectMembers,
	enumerableKeys,
	limitEntries,
	matchesMember,
	readSampleMemo,
	sortValues,
} from './helpers.js'
import { isRecord } from './validators.js'
import { inferPrimitiveEnum, samplesToFormat, unifySchemas } from './inferers.js'
import { ValueInferer } from './ValueInferer.js'

/**
 * Stateful owner of one multi-sample inference walk.
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
	 * Infer one JSON Schema over the retained sample list.
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
		// Indexed rather than `every`, and the narrowed rows are collected as they
		// are recognized so the record branch keeps its honest typing without an
		// assertion.
		const records: Array<Record<string, unknown>> = []
		for (let index = 0; index < samples.length; index += 1) {
			const sample = samples[index]
			if (isRecord(sample)) records[records.length] = sample
		}
		if (records.length === samples.length) {
			return this.#walkRecords(records, depth, memo)
		}
		if (this.#enumerated) {
			const enumSchema = inferPrimitiveEnum(samples, INFER_ENUM_LIMIT)
			if (enumSchema) return enumSchema
		}
		const schemas: JSONSchema[] = []
		for (let index = 0; index < samples.length; index += 1) {
			schemas[schemas.length] = new ValueInferer(
				samples[index],
				depth,
				this.#breadth,
				this.#closed,
				false,
			).infer()
		}
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
		let node = memo
		for (let index = 0; index < samples.length; index += 1) {
			const row = samples[index]
			if (row === undefined) break
			const next = INTRINSICS.reflect.apply(INTRINSICS.recall, node.rows, [row])
			if (next !== undefined) {
				node = readSampleMemo(next, 'samplesToSchema')
				continue
			}
			const fresh = buildSampleMemo()
			INTRINSICS.reflect.apply(INTRINSICS.retain, node.rows, [row, fresh])
			node = fresh
		}
		const signature = `${depth}|${this.#breadth}|${this.#closed}|${this.#format}|${this.#enumerated}`
		const cached = INTRINSICS.reflect.apply(INTRINSICS.fetch, node.schemas, [signature])
		if (cached !== undefined) return cached
		// Refuse the whole key-enumeration claim when any row cannot be read.
		const seen = collectMembers([])
		const collected: string[] = []
		for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
			const sample = samples[sampleIndex]
			// Indexed, never iterated: the row list is walked by index so no answer
			// this class publishes depends on `Array.prototype[Symbol.iterator]`. The
			// caller's own list was already read into an owned dense snapshot, so an
			// absent row here is unreachable and the refusal states the invariant.
			if (sample === undefined) {
				throw new INTRINSICS.error('samplesToSchema: every sample must be a record')
			}
			const sampleKeys = enumerableKeys(sample)
			if (sampleKeys === undefined) {
				throw new INTRINSICS.error('samplesToSchema: property enumeration failed')
			}
			for (let keyIndex = 0; keyIndex < sampleKeys.length; keyIndex += 1) {
				const key = sampleKeys[keyIndex]
				if (key === undefined || matchesMember(seen, key)) continue
				admitMember(seen, key)
				collected[collected.length] = key
			}
		}
		const allKeys = sortValues(collected)
		const keys = limitEntries(allKeys, this.#breadth)
		const truncated = allKeys.length > this.#breadth
		// Honest typing: a null-prototype accumulator so a key literally named
		// '__proto__' becomes an own data key instead of mutating the prototype —
		// the same pattern compileGuard / compileParser use (compilers.ts).
		const properties: Record<string, JSONSchema> = INTRINSICS.create(null)
		const required: string[] = []
		let partial = truncated
		// Bounded by depth alone: unlike the single-value walk, this record-sample
		// path carries no ancestor set. A shared reference across sample rows is
		// legitimate data (not a cycle back to an ancestor), so the decrementing
		// depth budget is the sole termination guarantee here.
		for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
			const key = keys[keyIndex]
			if (key === undefined) continue
			// Refuse the whole per-key claim when any sample value cannot be read.
			const valuesOutcome = attempt(() => {
				const values: unknown[] = []
				let dropped = false
				for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
					const sample = samples[sampleIndex]
					if (sample === undefined) {
						throw new INTRINSICS.error('samplesToSchema: every sample must be a record')
					}
					const propertyValue = sample[key]
					if (propertyValue === undefined) {
						if (INTRINSICS.own(sample, key)) dropped = true
						continue
					}
					values[values.length] = propertyValue
				}
				return { values, dropped }
			})
			if (!valuesOutcome.success) throw valuesOutcome.error
			const { values, dropped } = valuesOutcome.value
			// A row holding `undefined` for this key OPENS the schema; it does not
			// delete the column. Skipping the key entirely discarded a property two
			// of three rows carried as a real integer, and neither the TSDoc nor the
			// guide ever promised more than the opening.
			if (dropped) partial = true
			if (values.length > 0) {
				// The slot below is followed from the node this call was ENTERED with,
				// not from the row-prefix node reached above: two keys of one record
				// carry different row lists, so a shared base is what lets each land on
				// its own node instead of on a prefix of its sibling's.
				properties[key] = this.#infer(values, depth - 1, memo)
			}
			if (!dropped && values.length === samples.length) required[required.length] = key
		}
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
