import type { JSONSchema } from './types.js'
import { INTRINSICS } from './constants.js'
import {
	admitVisited,
	attempt,
	enumerableKeys,
	limitEntries,
	matchesVisited,
	omitVisited,
	readArrayEntries,
	retainDepth,
	sortValues,
} from './helpers.js'
import {
	isArray,
	isBoolean,
	isDate,
	isFiniteNumber,
	isInteger,
	isNull,
	isNumber,
	isRecord,
	isString,
} from './validators.js'
import { stringToFormat, unifySchemas } from './inferers.js'

/**
 * Owns the state of one single-value inference walk.
 *
 * @remarks
 * The engine behind `valueToSchema`, and the per-sample classifier
 * `samplesToSchema` reaches through {@link SampleInferer}. The walk's ancestor
 * set and its `(object, remaining depth)` memo are `#` fields rather than
 * parameters, so no caller can pre-populate either and change what the walk
 * treats as a cycle or serves from cache. Construction observes nothing;
 * `infer` runs the whole walk.
 *
 * Every budget arrives already sanitized: the door applies `sanitizeDepth` and
 * `sanitizeBudget` once, so the walk carries a depth no deeper than
 * `INFER_DEPTH_LIMIT` and a finite non-negative breadth. Depth decrements per
 * level and exhaustion widens to the empty accept-anything schema.
 *
 * The class is not published and no instance escapes its door, so its prototype
 * carries nothing a caller can reach and it needs no member pinning.
 */
export class ValueInferer {
	// Captured while this module evaluates: the constructor runs outside every
	// containment the doors place, so reaching `globalThis` there would leave the
	// door open one call earlier than any boundary can see.
	static readonly #weakSet = WeakSet
	static readonly #weakMap = WeakMap
	readonly #source: unknown
	readonly #depth: number
	readonly #breadth: number
	readonly #closed: boolean
	readonly #format: boolean
	readonly #visited: WeakSet<object>
	readonly #memo: WeakMap<object, Map<number, JSONSchema>>

	constructor(value: unknown, depth: number, breadth: number, closed: boolean, format: boolean) {
		this.#source = value
		this.#depth = depth
		this.#breadth = breadth
		this.#closed = closed
		this.#format = format
		this.#visited = new ValueInferer.#weakSet()
		this.#memo = new ValueInferer.#weakMap()
	}

	/**
	 * Infers a JSON Schema fragment for the retained value.
	 *
	 * @returns The inferred schema fragment
	 * @throws When a traversed container cannot be read
	 */
	infer(): JSONSchema {
		return this.#infer(this.#source, this.#depth)
	}

	// The recursive spine, shared by the root and by every collected property or
	// element. Terminates on cyclic readable input through the ancestor set; a
	// failed traversal is refused by the containing public reader. Leaf
	// classification order: `null`, boolean, integer (`Number.isInteger`
	// semantics — `-0` counts), finite non-integer number, string (gaining a
	// `format` keyword when `format` is on and `stringToFormat` matches), array
	// (recurse), plain record (recurse), `Date` (`{ type: 'string' }`, plus
	// `format: 'date-time'` when `format` is on); everything else — a NON-FINITE
	// number (`NaN` / `±Infinity`), a function, a symbol, a bigint, `undefined`,
	// and other non-plain objects such as `Map` / `Set` — is the empty
	// accept-anything schema `{}`.
	//
	// A non-finite number bottoms out with the other JSON-inexpressible values on
	// purpose: JSON carries no `NaN` / `±Infinity` (`JSON.stringify(Number.NaN)`
	// is `'null'`), so `{ type: 'number' }` would ASSERT something a JSON Schema
	// validator rejects — and the shape `schemaToShape` builds from it would
	// reject the very sample it was inferred from. `{}` is the truthful
	// description, and it inverts to an accept-anything shape, keeping
	// `compileGuard(schemaToShape(valueToSchema(v)))(v)` true.
	#infer(value: unknown, depth: number): JSONSchema {
		if (isNull(value)) return { type: 'null' }
		if (isBoolean(value)) return { type: 'boolean' }
		if (isInteger(value)) return { type: 'integer' }
		if (isFiniteNumber(value)) return { type: 'number' }
		// A non-finite number has no JSON representation at all, so it widens to
		// `{}` with the other inexpressible values rather than claiming a `number`
		// type no validator would accept it under.
		if (isNumber(value)) return {}
		if (isString(value)) {
			if (this.#format) {
				const detected = stringToFormat(value)
				if (detected) return { type: 'string', format: detected }
			}
			return { type: 'string' }
		}
		if (isArray(value)) return this.#walkArray(value, depth)
		if (isRecord(value)) return this.#walkRecord(value, depth)
		if (isDate(value)) {
			return this.#format ? { type: 'string', format: 'date-time' } : { type: 'string' }
		}
		return {}
	}

	// The array branch. An empty array infers `{ type: 'array' }` with no `items`.
	// Otherwise the first `#breadth` elements are classified and unified with
	// `unifySchemas`: a single distinct element schema becomes `items` directly;
	// several distinct schemas become `items: { anyOf: [...] }`. Depth exhaustion
	// or a cyclic re-encounter both yield `{}` instead of descending. A SPARSE
	// array (holes, for example `[1, , 3]`) has no JSON expression and widens to
	// the accept-anything `{}`, the same treatment `NaN`, a function, a symbol, a
	// `Map` and a `Set` receive — it is not read as a list of present `undefined`
	// leaves, because the array schema that reading produced was rejected by its
	// own compiled guard, which is the one direction the round-trip law forbids.
	//
	// ALL reads of `value` — including its `length` — happen inside `attempt`, and
	// the ancestor set is restored before the captured failure is rethrown, so a
	// hostile `length` getter, throwing own-getter element, or hostile element
	// access reaches the door's boundary with the walk already unwound. A
	// genuinely empty sampled list still returns `{ type: 'array' }` with no
	// `items`. A same-object re-inference at the same remaining depth is served
	// from the memo instead of recomputing, which guards a shared-reference DAG
	// against exponential blowup.
	#walkArray(value: readonly unknown[], depth: number): JSONSchema {
		if (!(depth > 0) || matchesVisited(this.#visited, value)) return {}
		// At a node reached through a cycle at the SAME remaining depth through two
		// different paths, the memo may serve the first traversal's already
		// cycle-truncated fragment (`{}`) to the second path instead of a fully
		// re-descended schema — a sound, deterministic over-approximation, never
		// a false-reject (a schema too permissive, never too strict).
		const cached = INTRINSICS.reflect.apply(INTRINSICS.recall, this.#memo, [value])?.get(depth)
		if (cached) return cached
		admitVisited(this.#visited, value)
		const outcome = attempt(() => {
			const snapshot = readArrayEntries(value)
			if (!snapshot.success) throw snapshot.error
			// A HOLE is an absent own property, and that is the lens every other
			// door in this package applies: `arrayOf`, `parseArray`, `isJSONValue`,
			// `cloneJSONValue`, `canonicalStringify` and the compiled array guard
			// all refuse a sparse array. Reading a hole as a PRESENT `undefined`
			// leaf made this door the one dissenter, and the disagreement was not
			// cosmetic: `valueToSchema([1, , 3])` emitted an array schema whose
			// guard REJECTED `[1, , 3]`, so the package published a schema that
			// refused the value it was inferred from. A non-dense snapshot has no
			// JSON expression, so it widens to `{}` alongside `NaN`, a function, a
			// symbol, a `Map` and a `Set` — which restores the round-trip law
			// rather than adding a fourth exception to it.
			if (!snapshot.value.dense) return undefined
			const entries = snapshot.value.entries
			const sampled: JSONSchema[] = []
			const length = INTRINSICS.min(entries.length, this.#breadth)
			for (let index = 0; index < length; index += 1) {
				sampled[sampled.length] = this.#infer(entries[index], depth - 1)
			}
			return sampled
		})
		omitVisited(this.#visited, value)
		if (!outcome.success) throw outcome.error
		const sampled = outcome.value
		const schema: JSONSchema =
			sampled === undefined
				? {}
				: sampled.length > 0
					? { type: 'array', items: unifySchemas(sampled) }
					: { type: 'array' }
		retainDepth(this.#memo, value, depth, schema)
		return schema
	}

	// The plain-record branch. Own enumerable string keys through
	// `enumerableKeys`, sorted lexicographically for deterministic output, capped
	// at `#breadth`. This is the same property view compiled object guards,
	// parsers, and reporters use. Each property value is read inside `attempt`; a
	// hostile getter reaches the door's boundary. A readable property whose value
	// is `undefined` is DROPPED — JSON encodes no such property
	// (`JSON.stringify({ a: undefined })` is `'{}'`), so it contributes neither a
	// `properties` entry nor a `required` entry. Every other present key is
	// required.
	//
	// Emits `additionalProperties: false` when closed, `true` otherwise —
	// mirroring `compileSchema`'s object-emission convention — EXCEPT when the
	// sampled key list no longer describes every key `value` actually carries,
	// which happens two ways: the own-key list exceeds `#breadth` (truncation), or
	// a key was dropped for holding `undefined`. Either way `additionalProperties`
	// is forced to `true` regardless of the flag, because a CLOSED schema built
	// from an incomplete key list would reject the very object it was inferred
	// from (`recordOf` rejects any own key the shape does not declare).
	#walkRecord(value: Record<string, unknown>, depth: number): JSONSchema {
		if (!(depth > 0) || matchesVisited(this.#visited, value)) return {}
		const cached = INTRINSICS.reflect.apply(INTRINSICS.recall, this.#memo, [value])?.get(depth)
		if (cached) return cached
		admitVisited(this.#visited, value)
		// Capture the whole key-enumeration and value-read walk, then unwind the
		// ancestor set before rethrowing. Readable depth or cycle exhaustion widens
		// to `{}`; unreadability never does.
		const outcome = attempt(() => {
			const snapshot = enumerableKeys(value)
			if (snapshot === undefined) {
				throw new INTRINSICS.error('valueToSchema: property enumeration failed')
			}
			const allKeys = sortValues(snapshot)
			const keys = limitEntries(allKeys, this.#breadth)
			const truncated = allKeys.length > this.#breadth
			// Honest typing: a null-prototype accumulator so a property literally
			// named '__proto__' becomes an own data key instead of mutating the
			// prototype — the same pattern compileGuard / compileParser use
			// (compilers.ts).
			const properties: Record<string, JSONSchema> = INTRINSICS.create(null)
			const required: string[] = []
			let dropped = false
			for (let index = 0; index < keys.length; index += 1) {
				const key = keys[index]
				if (key === undefined) continue
				const propertyValue = value[key]
				if (propertyValue === undefined) {
					dropped = true
					continue
				}
				properties[key] = this.#infer(propertyValue, depth - 1)
				required[required.length] = key
			}
			return { properties, required, partial: truncated || dropped }
		})
		omitVisited(this.#visited, value)
		if (!outcome.success) throw outcome.error
		const { properties, required, partial } = outcome.value
		const schema: JSONSchema = {
			type: 'object',
			...(INTRINSICS.keys(properties).length > 0 ? { properties } : {}),
			...(required.length > 0 ? { required } : {}),
			additionalProperties: partial ? true : !this.#closed,
		}
		retainDepth(this.#memo, value, depth, schema)
		return schema
	}
}
