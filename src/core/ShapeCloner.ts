import type {
	ArrayShape,
	BooleanShape,
	ContractErrorOptions,
	ContractShape,
	JSONShape,
	LiteralShape,
	LiteralValue,
	NullableShape,
	NullShape,
	NumberShape,
	ObjectShape,
	OptionalShape,
	RawShape,
	Result,
	ShapeClonerInterface,
	ShapeProperty,
	StringShape,
	UnionShape,
} from './types.js'
import { COMPILE_DEPTH_LIMIT, INTRINSICS } from './constants.js'
import { ContractError, isContractError } from './errors.js'
import {
	admitVisited,
	attempt,
	matchesRecordBrand,
	matchesVisited,
	pathOf,
	pinMembers,
	readArrayEntries,
	readPatternFlags,
	readPatternSource,
} from './helpers.js'
import { isLiteralValue, isObject, isRecord, isRegExp } from './validators.js'
import { SchemaCloner } from './SchemaCloner.js'
import { ShapeValidator } from './ShapeValidator.js'

/**
 * Stateful owner of one contract-shape snapshot operation.
 *
 * @remarks
 * Construction retains the source without observing it. The first
 * {@link clone} call captures and validates one owned graph and settles
 * permanently. Success replays the exact frozen root; failure rethrows the
 * exact class-owned or directly adopted error. Nonredirectable settlement
 * releases populated traversal state before publishing that result. Reentry
 * poisons the active operation and every later call with one shared cause-free
 * error.
 *
 * @param shape - The contract-shape graph to retain for cloning
 *
 * @example
 * ```ts
 * const cloner = new ShapeCloner({ type: 'string', min: 1 })
 * const clone = cloner.clone()
 * cloner.clone() === clone // true
 * ```
 */
export class ShapeCloner implements ShapeClonerInterface {
	// Captured while this module evaluates — the qualification matters, because
	// "before any caller code runs" is false for a consumer module ordered
	// earlier, which is the limit `constants.ts` states and does not defend. So no
	// caller code that runs AFTER this module can replace
	// them. Terminal settlement must reach the genuine implementation of every
	// intrinsic it dispatches through, or a caller who redirects one after
	// construction makes the first call escape with a raw caller value while the
	// replay reports the reentry poison — two different answers for one
	// operation. The constructor is already too late: a poison error, and so its
	// ownership record, is created before the source is ever observed. The
	// CONSTRUCTOR of each collection is captured beside its members, because
	// construction happens first: capturing `WeakSet.prototype.has` while still
	// reaching `globalThis.WeakSet` leaves the door open one call earlier than
	// the member rows can see, and the constructor runs outside every
	// containment this class has.
	static readonly #map = Map
	static readonly #weakSet = WeakSet
	// The released state, shared by every cloner this class ever builds. `#settle`
	// assigns these in place of the working lists, so an instance allocates one
	// collection per family instead of two and construction carries no empty peer
	// of its own. Sharing them is safe because nothing writes to a released list:
	// every writer runs inside the walk and `#settle` is the walk's last step. The
	// static block at the foot of the class freezes them, so a write that did
	// reach one fails loudly at its own line rather than leaking one cloner's node
	// into every other cloner's release.
	static readonly #emptyPending: Array<{
		readonly shape: ContractShape
		readonly depth: number
	}> = []
	static readonly #emptySources: ContractShape[] = []
	readonly #source: ContractShape
	readonly #owned: WeakSet<object>
	// The working maps are the fields with no shared peer: `Object.freeze` reaches
	// an array's writes and not a `Map`'s, so a shared empty map would be a
	// class-lifetime cache any write could fill with one cloner's nodes. `#settle`
	// drops them instead, and absence is `undefined`.
	#memo: Map<ContractShape, ContractShape> | undefined
	#paths: Map<ContractShape, readonly string[]> | undefined
	// An ordered ENTRY LIST rather than a `Map`: every consumer of this snapshot
	// walks it to decide the published property population, and iterating a `Map`
	// dispatches through `Map.prototype[Symbol.iterator]` while destructuring each
	// `[key, child]` pair dispatches through `Array.prototype[Symbol.iterator]`.
	// A caller-installed iterator that substitutes the first element of a
	// two-element entry — same arity, so every downstream structural check still
	// passes — published a frozen shape whose property was RENAMED to the
	// caller's text.
	#properties: Map<ContractShape, readonly ShapeProperty[]> | undefined
	#variants: Map<ContractShape, ReadonlyArray<ContractShape | undefined>> | undefined
	// FIFO, walked with a read cursor rather than `pop()`. A LIFO drain captured
	// siblings in REVERSE declaration order, so the first refusal this class threw
	// named the LAST offending sibling while the shared gate named the first — one
	// declaration, two different codes, messages and `context.path` values from
	// doors the guide names in one sentence as agreeing.
	#pending: Array<{ readonly shape: ContractShape; readonly depth: number }>
	#sources: ContractShape[]
	#fidelity: ContractError | undefined
	#state:
		| { readonly phase: 'ready' }
		| { readonly phase: 'running'; readonly poison: ContractError }
		| { readonly phase: 'interrupted'; readonly poison: ContractError }
		| { readonly phase: 'settled'; readonly result: Result<ContractShape, ContractError> }

	constructor(shape: ContractShape) {
		this.#source = shape
		this.#owned = new ShapeCloner.#weakSet()
		this.#memo = new ShapeCloner.#map()
		this.#paths = new ShapeCloner.#map()
		this.#properties = new ShapeCloner.#map()
		this.#variants = new ShapeCloner.#map()
		this.#pending = []
		this.#sources = []
		this.#fidelity = undefined
		this.#state = { phase: 'ready' }
	}

	/**
	 * Clone the retained declaration into an owned, validated frozen graph.
	 *
	 * @returns The settled contract-shape snapshot
	 * @throws {ContractError} When the declaration is malformed, unreadable, cyclic, too deep, or cloning is reentered
	 */
	clone(): ContractShape {
		const state = this.#state
		if (state.phase === 'settled') {
			if (state.result.success) return state.result.value
			throw state.result.error
		}
		if (state.phase === 'running' || state.phase === 'interrupted') {
			this.#state = { phase: 'interrupted', poison: state.poison }
			throw state.poison
		}

		const poison = this.#create('ShapeCloner.clone: shape cloning may not be reentered', {
			code: 'clone',
			context: { shape: 'shape' },
		})
		this.#state = { phase: 'running', poison }
		return this.#complete(attempt(() => this.#execute()))
	}

	#complete(outcome: Result<ContractShape>): ContractShape {
		const state = this.#state
		if (state.phase === 'interrupted') {
			return this.#settle({ success: false, error: state.poison })
		}
		if (outcome.success) return this.#settle(outcome)

		const error = this.#owns(outcome.error)
			? outcome.error
			: this.#create('cloneShape: failed to create an owned shape snapshot', {
					code: 'clone',
					context: { shape: 'shape' },
					cause: outcome.error,
				})
		return this.#settle({ success: false, error })
	}

	#execute(): ContractShape {
		// Narrowed once at the door, because both dispatches below take their
		// receiver type from these values. The walk runs before `#settle` drops
		// them, so it always finds the maps the constructor built; this refusal is
		// what keeps that a statement the types carry rather than one a comment
		// makes.
		const paths = this.#paths
		const memo = this.#memo
		if (paths === undefined || memo === undefined) throw this.#unavailable()
		INTRINSICS.reflect.apply(INTRINSICS.store, paths, [this.#source, []])
		this.#pending[this.#pending.length] = { shape: this.#source, depth: 0 }
		this.#drain()
		this.#wireNodes()
		const root = INTRINSICS.reflect.apply(INTRINSICS.fetch, memo, [this.#source])
		if (root === undefined) {
			throw this.#create('ShapeCloner.clone: captured root is unavailable', {
				code: 'clone',
				context: { shape: 'shape' },
			})
		}
		this.#freezeNodes()
		this.#validateShape(root)
		if (this.#fidelity !== undefined) throw this.#fidelity
		return root
	}

	#drain(): void {
		// A read cursor, so the walk is breadth-first in DECLARATION order. The
		// cursor also makes the level a node was reached at meaningful: it is the
		// SHORTEST path to that node, so this bound never refuses a graph the
		// validator would accept.
		const memo = this.#memo
		if (memo === undefined) throw this.#unavailable()
		let cursor = 0
		while (cursor < this.#pending.length) {
			const entry = this.#pending[cursor]
			cursor += 1
			if (entry === undefined) continue
			if (INTRINSICS.reflect.apply(INTRINSICS.keyed, memo, [entry.shape])) continue
			// The depth verdict is reached in time proportional to the LIMIT rather
			// than to the caller's declaration. Capturing, wiring and freezing a
			// 4,000-level chain that is CERTAIN to be refused cost 120 ms against
			// `validateShape`'s 1 ms for the identical verdict, and the cost is
			// quadratic because every child registration copies its whole path.
			if (entry.depth > COMPILE_DEPTH_LIMIT) this.#refuseDepth()
			this.#captureNode(entry.shape, entry.depth)
		}
	}

	// The gate that OWNS the depth rule authors the diagnosis, on the same source
	// `validateShape` would be handed, so the two doors cannot disagree about
	// which node exceeded the limit or what the refusal says.
	#refuseDepth(): never {
		this.#validateShape(this.#source)
		throw this.#create('validateShape: a shape exceeds the compilation depth limit', {
			code: 'depth',
			context: { path: [], limit: COMPILE_DEPTH_LIMIT },
		})
	}

	#captureShell(source: ContractShape, path: readonly string[]): ContractShape {
		if (!matchesRecordBrand(source)) {
			throw this.#create('validateShape: every structural child must be a shape', {
				code: 'structure',
				context: { path },
			})
		}
		const descriptor = INTRINSICS.describe(source, 'type')
		if (descriptor === undefined || !INTRINSICS.own(descriptor, 'value')) {
			throw this.#create('cloneShape: every node needs an own data discriminant', {
				code: 'structure',
				context: { path },
			})
		}
		const category = source.type
		const repeated = source.type
		if (!INTRINSICS.same(descriptor.value, category) || !INTRINSICS.same(repeated, category)) {
			throw this.#create('cloneShape: every node needs an own data discriminant', {
				code: 'structure',
				context: { path },
			})
		}

		switch (category) {
			case 'string':
				return this.#captureString(source, path)
			case 'number':
				return this.#captureNumber(source, path)
			case 'boolean':
				return this.#captureSimple(source, path, 'boolean')
			case 'null':
				return this.#captureSimple(source, path, 'null')
			case 'literal':
				return this.#captureLiteral(source, path)
			case 'array':
				return this.#captureArray(source, path)
			case 'object':
				return this.#captureObject(source, path)
			case 'union':
				return this.#captureUnion(source, path)
			case 'optional':
				return this.#captureWrapper(source, path, 'optional')
			case 'nullable':
				return this.#captureWrapper(source, path, 'nullable')
			case 'json':
				return this.#captureSimple(source, path, 'json')
			case 'raw':
				return this.#captureRaw(source, path)
			default:
				throw this.#create('validateShape: every node must be a recognized shape', {
					code: 'structure',
					context: { path },
				})
		}
	}

	#captureField<S extends object, K extends keyof S & string>(
		source: S,
		field: K,
		path: readonly string[],
	): S[K] | undefined {
		const descriptor = INTRINSICS.describe(source, field)
		if (descriptor === undefined) {
			if (INTRINSICS.reflect.present(source, field)) {
				throw this.#create('cloneShape: inherited shape fields cannot be owned', {
					code: 'structure',
					context: { path: pathOf(path, field) },
				})
			}
			return undefined
		}
		if (!INTRINSICS.own(descriptor, 'value')) {
			throw this.#create('cloneShape: shape accessors cannot be owned faithfully', {
				code: 'structure',
				context: { path: pathOf(path, field) },
			})
		}
		const first = source[field]
		const second = source[field]
		if (!INTRINSICS.same(first, descriptor.value) || !INTRINSICS.same(second, first)) {
			throw this.#create('cloneShape: shape fields must be stable data', {
				code: 'structure',
				context: { path: pathOf(path, field) },
			})
		}
		return first
	}

	#capturePattern(
		source: StringShape,
		path: readonly string[],
	): { readonly source: string; readonly flags: string } | undefined {
		const descriptor = INTRINSICS.describe(source, 'pattern')
		if (descriptor === undefined) {
			if (INTRINSICS.reflect.present(source, 'pattern')) {
				throw this.#create('cloneShape: inherited shape fields cannot be owned', {
					code: 'structure',
					context: { path: pathOf(path, 'pattern') },
				})
			}
			return undefined
		}

		if (INTRINSICS.own(descriptor, 'value')) {
			const first = source.pattern
			const second = source.pattern
			if (!INTRINSICS.same(first, descriptor.value) || !INTRINSICS.same(second, first)) {
				throw this.#create('cloneShape: shape fields must be stable data', {
					code: 'structure',
					context: { path: pathOf(path, 'pattern') },
				})
			}
			return this.#capturePatternValue(first, path)
		}

		const first = source.pattern
		const second = source.pattern
		if (!isRegExp(first) || !isRegExp(second)) {
			throw this.#create('cloneShape: shape accessors cannot be owned faithfully', {
				code: 'structure',
				context: { path: pathOf(path, 'pattern') },
			})
		}
		// Each revealed RegExp is captured once, through the same scalar-pair
		// routine the data population uses, and the two captured PRIMITIVE pairs
		// are what get compared. Reading scalars here and then handing a
		// already-observed RegExp back to that routine would observe it twice, so
		// an accessor that answers one observation per value lost its deferred
		// stable-pattern diagnosis to an outer hostile-read translation.
		const firstValue = this.#capturePatternValue(first, path)
		if (firstValue === undefined) return undefined
		const secondValue = this.#capturePatternValue(second, path)
		if (secondValue === undefined) return undefined
		if (
			firstValue.source !== secondValue.source ||
			firstValue.flags !== secondValue.flags ||
			!INTRINSICS.frozen(first) ||
			!INTRINSICS.frozen(second)
		) {
			throw this.#create('cloneShape: shape accessors cannot be owned faithfully', {
				code: 'structure',
				context: { path: pathOf(path, 'pattern') },
			})
		}
		return firstValue
	}

	#capturePatternValue(
		pattern: RegExp | undefined,
		path: readonly string[],
	): { readonly source: string; readonly flags: string } | undefined {
		if (pattern === undefined) return undefined
		if (!isRegExp(pattern)) {
			throw this.#create('validateShape: string pattern must be a RegExp', {
				code: 'structure',
				context: { path: pathOf(path, 'pattern') },
			})
		}
		// Both reads go through the CAPTURED accessors. `source` and `flags` are
		// getters on a shared prototype, so a replaced getter reports for every
		// pattern in the realm, not only the caller's — and it decided the pattern a
		// published shape carries. The repeated read still earns its place: it
		// diagnoses an accessor that answers once per value, which capture does not
		// address.
		const sourceText: unknown = readPatternSource(pattern)
		const flags: unknown = readPatternFlags(pattern)
		const repeated = attempt(() => {
			const repeatedFlags: unknown = readPatternFlags(pattern)
			const repeatedSource: unknown = readPatternSource(pattern)
			return { flags: repeatedFlags, source: repeatedSource }
		})
		if (
			typeof sourceText !== 'string' ||
			typeof flags !== 'string' ||
			!repeated.success ||
			typeof repeated.value.source !== 'string' ||
			typeof repeated.value.flags !== 'string' ||
			repeated.value.source !== sourceText ||
			repeated.value.flags !== flags
		) {
			this.#fidelity ??= this.#create('validateShape: string pattern must be stable', {
				code: 'structure',
				context: { path: pathOf(path, 'pattern') },
			})
			return undefined
		}
		return { source: sourceText, flags }
	}

	#captureNode(source: ContractShape, depth: number): void {
		const paths = this.#paths
		const memo = this.#memo
		if (paths === undefined || memo === undefined) throw this.#unavailable()
		const path = INTRINSICS.reflect.apply(INTRINSICS.fetch, paths, [source]) ?? []
		const clone = this.#captureShell(source, path)

		INTRINSICS.reflect.apply(INTRINSICS.store, memo, [source, clone])
		this.#sources[this.#sources.length] = source
		this.#scheduleNode(source, clone, path, depth)
	}

	#captureString(source: StringShape, path: readonly string[]): StringShape {
		const min = this.#captureField(source, 'min', path)
		const max = this.#captureField(source, 'max', path)
		const pattern = this.#capturePattern(source, path)
		const description = this.#captureField(source, 'description', path)
		// No declaration-policy rule is enforced here. Every bound, range and
		// pattern-flag rule this capture used to author has an exact twin in
		// `ShapeValidator`, which runs on the carried clone at `#execute` — and a
		// second copy that fires EARLIER, in capture order rather than declaration
		// order and before structure outranks domain, is exactly how `cloneShape`
		// came to name a different rule at a different path than the shared gate
		// for one declaration. One rule, one arbiter.
		const fields: StringShape = {
			type: 'string',
			...(min === undefined ? {} : { min }),
			...(max === undefined ? {} : { max }),
			...(description === undefined ? {} : { description }),
		}
		if (pattern === undefined) return fields
		const sourceText = pattern.source
		const flags = pattern.flags
		return {
			...fields,
			get pattern() {
				return INTRINSICS.freeze(new INTRINSICS.pattern(sourceText, flags))
			},
		}
	}

	#captureNumber(source: NumberShape, path: readonly string[]): NumberShape {
		const integer = this.#captureField(source, 'integer', path)
		const min = this.#captureField(source, 'min', path)
		const max = this.#captureField(source, 'max', path)
		const description = this.#captureField(source, 'description', path)
		// Domain rules belong to the single gate on the carried clone; see
		// `#captureString`.
		return {
			type: 'number',
			...(min === undefined ? {} : { min }),
			...(max === undefined ? {} : { max }),
			...(integer === undefined ? {} : { integer }),
			...(description === undefined ? {} : { description }),
		}
	}

	#captureSimple(
		source: BooleanShape | NullShape | JSONShape,
		path: readonly string[],
		category: 'boolean' | 'null' | 'json',
	): BooleanShape | NullShape | JSONShape {
		const description = this.#captureField(source, 'description', path)
		if (category === 'boolean') {
			return { type: 'boolean', ...(description === undefined ? {} : { description }) }
		}
		if (category === 'null') {
			return { type: 'null', ...(description === undefined ? {} : { description }) }
		}
		return { type: 'json', ...(description === undefined ? {} : { description }) }
	}

	#captureLiteral(source: LiteralShape, path: readonly string[]): LiteralShape {
		const values = this.#captureField(source, 'values', path)
		const description = this.#captureField(source, 'description', path)
		const entries = this.#captureLiterals(values, path)
		return {
			type: 'literal',
			values: entries,
			...(description === undefined ? {} : { description }),
		}
	}

	#captureArray(source: ArrayShape, path: readonly string[]): ArrayShape {
		const items = this.#captureField(source, 'items', path)
		const min = this.#captureField(source, 'min', path)
		const max = this.#captureField(source, 'max', path)
		const description = this.#captureField(source, 'description', path)
		// Domain rules belong to the single gate on the carried clone; see
		// `#captureString`. A missing `items` is not a domain rule — the node
		// cannot be BUILT without it — so that refusal stays here, and it is
		// `structure`, the family the validator itself ranks first.
		if (items === undefined) {
			throw this.#create('validateShape: every structural child must be a shape', {
				code: 'structure',
				context: { path: pathOf(path, 'items') },
			})
		}
		return {
			type: 'array',
			items,
			...(min === undefined ? {} : { min }),
			...(max === undefined ? {} : { max }),
			...(description === undefined ? {} : { description }),
		}
	}

	#captureObject(source: ObjectShape, path: readonly string[]): ObjectShape {
		const propertySource = this.#captureField(source, 'properties', path)
		const additional = this.#captureField(source, 'additionalProperties', path)
		const description = this.#captureField(source, 'description', path)
		if (!isRecord(propertySource)) {
			throw this.#create('validateShape: properties must be a plain property map', {
				code: 'structure',
				context: { path: pathOf(path, 'properties') },
			})
		}
		this.#captureProperties(source, propertySource, path)
		const properties: Record<string, ContractShape> = INTRINSICS.create(null)
		return {
			type: 'object',
			properties,
			...(additional === undefined ? {} : { additionalProperties: additional }),
			...(description === undefined ? {} : { description }),
		}
	}

	#captureUnion(source: UnionShape, path: readonly string[]): UnionShape {
		const variantSource = this.#captureField(source, 'variants', path)
		const mode = this.#captureField(source, 'mode', path)
		const description = this.#captureField(source, 'description', path)
		this.#captureVariants(source, variantSource, path)
		return {
			type: 'union',
			variants: [],
			...(mode === undefined ? {} : { mode }),
			...(description === undefined ? {} : { description }),
		}
	}

	#captureWrapper(
		source: OptionalShape | NullableShape,
		path: readonly string[],
		category: 'optional' | 'nullable',
	): OptionalShape | NullableShape {
		const inner = this.#captureField(source, 'inner', path)
		if (inner === undefined) {
			throw this.#create('validateShape: every structural child must be a shape', {
				code: 'structure',
				context: { path: pathOf(path, 'inner') },
			})
		}
		return category === 'optional' ? { type: 'optional', inner } : { type: 'nullable', inner }
	}

	#captureRaw(source: RawShape, path: readonly string[]): RawShape {
		const schema = this.#captureField(source, 'schema', path)
		if (!isRecord(schema)) {
			throw this.#create('validateShape: raw schema must be a plain record', {
				code: 'structure',
				context: { path: pathOf(path, 'schema') },
			})
		}
		this.#validateShape({ type: 'raw', schema })
		const outcome = attempt(() => new SchemaCloner(schema).clone())
		if (!outcome.success) {
			if (isContractError(outcome.error)) {
				admitVisited(this.#owned, outcome.error)
			}
			throw outcome.error
		}
		return { type: 'raw', schema: outcome.value }
	}

	#captureLiterals(
		values: readonly LiteralValue[] | undefined,
		path: readonly string[],
	): readonly LiteralValue[] {
		if (!INTRINSICS.array(values)) {
			throw this.#create('validateShape: values must be a finite literal array', {
				code: 'structure',
				context: { path: pathOf(path, 'values') },
			})
		}
		const snapshot = readArrayEntries(values)
		if (!snapshot.success) {
			throw this.#create('validateShape: values must be a finite literal array', {
				code: 'structure',
				context: { path: pathOf(path, 'values') },
			})
		}
		if (!snapshot.value.dense) {
			throw this.#create('validateShape: values must be a dense data array', {
				code: 'structure',
				context: { path: pathOf(path, 'values') },
			})
		}
		const entries: LiteralValue[] = []
		for (let index = 0; index < snapshot.value.entries.length; index += 1) {
			entries[entries.length] = this.#literal(values, snapshot.value.entries[index], index, path)
		}
		return INTRINSICS.freeze(entries)
	}

	#literal(
		values: readonly LiteralValue[],
		value: unknown,
		index: number,
		path: readonly string[],
	): LiteralValue {
		const key = INTRINSICS.text(index)
		const descriptor = attempt(() => INTRINSICS.describe(values, key))
		const repeated = attempt(() => values[index])
		if (
			!descriptor.success ||
			descriptor.value === undefined ||
			!INTRINSICS.own(descriptor.value, 'value')
		) {
			this.#fidelity ??= this.#create('validateShape: values must be a dense data array', {
				code: 'structure',
				context: { path: pathOf(path, 'values', key) },
			})
		} else if (
			!repeated.success ||
			!INTRINSICS.same(repeated.value, value) ||
			!INTRINSICS.same(descriptor.value.value, value)
		) {
			this.#fidelity ??= this.#create('validateShape: values must be a stable data array', {
				code: 'structure',
				context: { path: pathOf(path, 'values', key) },
			})
		}
		if (!isLiteralValue(value)) {
			throw this.#create(
				'validateShape: every literal value must be a string, number, or boolean',
				{
					code: 'structure',
					context: { path: pathOf(path, 'values', key) },
				},
			)
		}
		return value
	}

	#captureProperties(
		source: ObjectShape,
		properties: Readonly<Record<string, ContractShape>>,
		path: readonly string[],
	): void {
		const keys = INTRINSICS.keys(properties)
		const snapshot: ShapeProperty[] = []
		// Indexed, not iterated: this walk decides the cloned shape's property
		// population.
		for (let index = 0; index < keys.length; index += 1) {
			const key = keys[index]
			if (key === undefined) continue
			const descriptor = INTRINSICS.describe(properties, key)
			if (descriptor === undefined || !INTRINSICS.own(descriptor, 'value')) {
				throw this.#create('validateShape: every structural child must be a shape', {
					code: 'structure',
					context: { path: pathOf(path, 'properties', key) },
				})
			}
			const child = properties[key]
			const repeated = properties[key]
			const described: unknown = descriptor.value
			if (!INTRINSICS.same(described, child) || !INTRINSICS.same(child, repeated)) {
				throw this.#create('validateShape: every structural child must be a shape', {
					code: 'structure',
					context: { path: pathOf(path, 'properties', key) },
				})
			}
			snapshot[snapshot.length] = { key, child }
		}
		const repeated = INTRINSICS.keys(properties)
		let drifted = repeated.length !== keys.length
		for (let index = 0; index < repeated.length; index += 1) {
			if (repeated[index] !== keys[index]) drifted = true
		}
		if (drifted) {
			throw this.#create('cloneShape: property keys must be stable data', {
				code: 'structure',
				context: { path: pathOf(path, 'properties') },
			})
		}
		const captured = this.#properties
		if (captured === undefined) throw this.#unavailable()
		INTRINSICS.reflect.apply(INTRINSICS.store, captured, [source, snapshot])
	}

	#captureVariants(
		source: UnionShape,
		variants: readonly ContractShape[] | undefined,
		path: readonly string[],
	): void {
		if (!INTRINSICS.array(variants)) {
			throw this.#create('validateShape: variants must be a finite array', {
				code: 'structure',
				context: { path: pathOf(path, 'variants') },
			})
		}
		const snapshot = readArrayEntries(variants)
		if (!snapshot.success) {
			throw this.#create('validateShape: variants must be a finite array', {
				code: 'structure',
				context: { path: pathOf(path, 'variants') },
			})
		}
		if (!snapshot.value.dense) {
			throw this.#create('validateShape: variants must be a dense data array', {
				code: 'structure',
				context: { path: pathOf(path, 'variants') },
			})
		}
		const entries = snapshot.value.entries
		const captured = this.#variants
		if (captured === undefined) throw this.#unavailable()
		INTRINSICS.reflect.apply(INTRINSICS.store, captured, [source, entries])
		for (let index = 0; index < entries.length; index += 1) {
			const variant = entries[index]
			const key = INTRINSICS.text(index)
			const descriptor = attempt(() => INTRINSICS.describe(variants, key))
			const repeated = attempt(() => variants[index])
			if (
				!descriptor.success ||
				descriptor.value === undefined ||
				!INTRINSICS.own(descriptor.value, 'value') ||
				!repeated.success ||
				!INTRINSICS.same(repeated.value, variant) ||
				!INTRINSICS.same(descriptor.value.value, variant)
			) {
				this.#fidelity ??= this.#create('validateShape: every structural child must be a shape', {
					code: 'structure',
					context: { path: pathOf(path, 'variants', key) },
				})
			}
		}
	}

	#scheduleNode(
		source: ContractShape,
		clone: ContractShape,
		path: readonly string[],
		depth: number,
	): void {
		switch (clone.type) {
			case 'array':
				this.#registerChild(clone.items, pathOf(path, 'items'), depth)
				break
			case 'object': {
				const captured = this.#properties
				if (captured === undefined) throw this.#unavailable()
				const properties = INTRINSICS.reflect.apply(INTRINSICS.fetch, captured, [source])
				if (properties === undefined) {
					throw this.#create('cloneShape: properties could not be read', {
						code: 'clone',
						context: { path: pathOf(path, 'properties'), shape: 'object' },
					})
				}
				for (let index = 0; index < properties.length; index += 1) {
					const entry = properties[index]
					if (entry === undefined || entry.child === undefined) continue
					this.#registerChild(entry.child, pathOf(path, 'properties', entry.key), depth)
				}
				const additional = clone.additionalProperties
				if (additional !== undefined && additional !== true && additional !== false) {
					this.#registerChild(additional, pathOf(path, 'additionalProperties'), depth)
				}
				break
			}
			case 'union': {
				const captured = this.#variants
				if (captured === undefined) throw this.#unavailable()
				const variants = INTRINSICS.reflect.apply(INTRINSICS.fetch, captured, [source])
				if (variants === undefined) {
					throw this.#create('validateShape: variants must be a finite array', {
						code: 'structure',
						context: { path: pathOf(path, 'variants') },
					})
				}
				for (let index = 0; index < variants.length; index += 1) {
					const variant = variants[index]
					if (variant !== undefined) {
						this.#registerChild(variant, pathOf(path, 'variants', INTRINSICS.text(index)), depth)
					}
				}
				break
			}
			case 'optional':
			case 'nullable':
				this.#registerChild(clone.inner, pathOf(path, 'inner'), depth)
				break
			default:
				break
		}
	}

	#registerChild(child: ContractShape, path: readonly string[], depth: number): void {
		const paths = this.#paths
		if (paths === undefined) throw this.#unavailable()
		INTRINSICS.reflect.apply(INTRINSICS.store, paths, [child, path])
		this.#pending[this.#pending.length] = { shape: child, depth: depth + 1 }
	}

	#wireNodes(): void {
		const memo = this.#memo
		const paths = this.#paths
		if (memo === undefined || paths === undefined) throw this.#unavailable()
		for (let sourceIndex = 0; sourceIndex < this.#sources.length; sourceIndex += 1) {
			const source = this.#sources[sourceIndex]
			if (source === undefined) continue
			const clone = INTRINSICS.reflect.apply(INTRINSICS.fetch, memo, [source])
			if (clone === undefined) continue
			const path = INTRINSICS.reflect.apply(INTRINSICS.fetch, paths, [source]) ?? []
			switch (clone.type) {
				case 'array':
					this.#wireArray(clone, path)
					break
				case 'object':
					this.#wireObject(source, clone, path)
					break
				case 'union':
					this.#wireUnion(source, clone, path)
					break
				case 'optional':
				case 'nullable':
					this.#wireWrapper(clone, path)
					break
				default:
					break
			}
		}
	}

	#wireArray(clone: ArrayShape, path: readonly string[]): void {
		const memo = this.#memo
		if (memo === undefined) throw this.#unavailable()
		const items = INTRINSICS.reflect.apply(INTRINSICS.fetch, memo, [clone.items])
		if (items === undefined) {
			throw this.#create('validateShape: every structural child must be a shape', {
				code: 'structure',
				context: { path: pathOf(path, 'items') },
			})
		}
		INTRINSICS.reflect.write(clone, 'items', items)
	}

	#wireObject(source: ContractShape, clone: ObjectShape, path: readonly string[]): void {
		const memo = this.#memo
		const captured = this.#properties
		if (memo === undefined || captured === undefined) throw this.#unavailable()
		const snapshot = INTRINSICS.reflect.apply(INTRINSICS.fetch, captured, [source])
		if (snapshot === undefined) {
			throw this.#create('cloneShape: properties could not be read', {
				code: 'clone',
				context: { path: pathOf(path, 'properties'), shape: 'object' },
			})
		}
		const properties: Record<string, ContractShape> = INTRINSICS.create(null)
		for (let index = 0; index < snapshot.length; index += 1) {
			const entry = snapshot[index]
			if (entry === undefined) continue
			const { key, child } = entry
			if (child === undefined) {
				throw this.#create('validateShape: every structural child must be a shape', {
					code: 'structure',
					context: { path: pathOf(path, 'properties', key) },
				})
			}
			const cloned = INTRINSICS.reflect.apply(INTRINSICS.fetch, memo, [child])
			if (cloned === undefined) {
				throw this.#create('validateShape: every structural child must be a shape', {
					code: 'structure',
					context: { path: pathOf(path, 'properties', key) },
				})
			}
			properties[key] = cloned
		}
		INTRINSICS.reflect.write(clone, 'properties', INTRINSICS.freeze(properties))
		const additional = clone.additionalProperties
		if (additional !== undefined && additional !== true && additional !== false) {
			const cloned = INTRINSICS.reflect.apply(INTRINSICS.fetch, memo, [additional])
			if (cloned === undefined) {
				throw this.#create('validateShape: every structural child must be a shape', {
					code: 'structure',
					context: { path: pathOf(path, 'additionalProperties') },
				})
			}
			INTRINSICS.reflect.write(clone, 'additionalProperties', cloned)
		}
	}

	#wireUnion(source: ContractShape, clone: UnionShape, path: readonly string[]): void {
		const memo = this.#memo
		const captured = this.#variants
		if (memo === undefined || captured === undefined) throw this.#unavailable()
		const snapshot = INTRINSICS.reflect.apply(INTRINSICS.fetch, captured, [source])
		if (snapshot === undefined) {
			throw this.#create('validateShape: variants must be a finite array', {
				code: 'structure',
				context: { path: pathOf(path, 'variants') },
			})
		}
		const variants: ContractShape[] = []
		for (let index = 0; index < snapshot.length; index += 1) {
			const variant = snapshot[index]
			if (variant === undefined) {
				throw this.#create('validateShape: every structural child must be a shape', {
					code: 'structure',
					context: { path: pathOf(path, 'variants', INTRINSICS.text(index)) },
				})
			}
			const cloned = INTRINSICS.reflect.apply(INTRINSICS.fetch, memo, [variant])
			if (cloned === undefined) {
				throw this.#create('validateShape: every structural child must be a shape', {
					code: 'structure',
					context: { path: pathOf(path, 'variants', INTRINSICS.text(index)) },
				})
			}
			variants[variants.length] = cloned
		}
		INTRINSICS.reflect.write(clone, 'variants', INTRINSICS.freeze(variants))
	}

	#wireWrapper(clone: OptionalShape | NullableShape, path: readonly string[]): void {
		const memo = this.#memo
		if (memo === undefined) throw this.#unavailable()
		const inner = INTRINSICS.reflect.apply(INTRINSICS.fetch, memo, [clone.inner])
		if (inner === undefined) {
			throw this.#create('validateShape: every structural child must be a shape', {
				code: 'structure',
				context: { path: pathOf(path, 'inner') },
			})
		}
		INTRINSICS.reflect.write(clone, 'inner', inner)
	}

	#freezeNodes(): void {
		const memo = this.#memo
		if (memo === undefined) throw this.#unavailable()
		for (let sourceIndex = 0; sourceIndex < this.#sources.length; sourceIndex += 1) {
			const source = this.#sources[sourceIndex]
			if (source === undefined) continue
			const clone = INTRINSICS.reflect.apply(INTRINSICS.fetch, memo, [source])
			if (clone !== undefined) INTRINSICS.freeze(clone)
		}
	}

	#validateShape(shape: ContractShape): void {
		const outcome = attempt(() => new ShapeValidator(shape).validate())
		if (outcome.success) return
		if (isContractError(outcome.error)) {
			admitVisited(this.#owned, outcome.error)
		}
		throw outcome.error
	}

	// One refusal for every dropped working map, because a settled cloner replays
	// from `#state` and re-enters no walk method: nothing reachable settles here,
	// and every guard that says so must say it the same way.
	#unavailable(): ContractError {
		return this.#create('ShapeCloner.clone: the capture state is unavailable', {
			code: 'clone',
			context: { shape: 'shape' },
		})
	}

	#create(message: string, options: ContractErrorOptions): ContractError {
		const error = new ContractError(message, options)
		admitVisited(this.#owned, error)
		return error
	}

	#owns(error: unknown): error is ContractError {
		return isObject(error) && matchesVisited(this.#owned, error)
	}

	// Assignment only: every working list takes the class's shared frozen empty
	// peer and every working map is dropped outright. Nothing here calls a
	// caller-mutable cleanup member and nothing here constructs a collection, so
	// settlement cannot be redirected into leaving state behind.
	#settle(result: Result<ContractShape, ContractError>): ContractShape {
		this.#memo = undefined
		this.#paths = undefined
		this.#properties = undefined
		this.#variants = undefined
		this.#pending = ShapeCloner.#emptyPending
		this.#sources = ShapeCloner.#emptySources
		this.#fidelity = undefined
		this.#state = { phase: 'settled', result }
		if (result.success) return result.value
		throw result.error
	}

	static {
		// Frozen in a statement of its own, and the result discarded: `Object.freeze`
		// returns a readonly view, so binding it back would retype the peers and
		// stop them satisfying the mutable working fields they are assigned to.
		INTRINSICS.freeze(ShapeCloner.#emptyPending)
		INTRINSICS.freeze(ShapeCloner.#emptySources)
		// Pinned while this class is DEFINED. `cloneShape` / `ownShape` reach it
		// through `ShapeCloner.prototype.clone`, so one assignment there made
		// `compileSchema`, `contract.audit` and `contract.explain` publish whatever
		// the caller chose while none of those doors was touched.
		pinMembers(ShapeCloner.prototype, 'ShapeCloner')
	}
}
