import type { ContractShape, ShapeValidatorInterface, StringShape } from './types.js'
import { COMPILE_DEPTH_LIMIT, INTRINSICS } from './constants.js'
import { ContractError, isContractError } from './errors.js'
import {
	admitMember,
	admitVisited,
	attempt,
	collectMembers,
	matchesMember,
	matchesVisited,
	omitVisited,
	pathOf,
	pinMembers,
	readArrayEntries,
	readPatternFlags,
	readPatternSource,
} from './helpers.js'
import { isLiteralValue, isRecord, isRegExp } from './validators.js'

/**
 * A reusable live validator for one retained contract-shape source.
 *
 * @remarks
 * Construction performs no source observation. Every non-overlapping
 * {@link validate} call starts a fresh pass over the source's current state.
 * Reentry poisons the active pass with one shared cause-free structure error;
 * cleanup always restores an idle validator for the next independent call.
 *
 * @example
 * ```ts
 * const validator = new ShapeValidator({ type: 'string', min: 1 })
 * validator.validate()
 * ```
 */
export class ShapeValidator implements ShapeValidatorInterface {
	// Captured while this module evaluates — the qualification matters, because
	// "before any caller code runs" is false for a consumer module ordered
	// earlier, which is the limit `constants.ts` states and does not defend. So no
	// caller code that runs AFTER this module can replace
	// the global binding. Cleanup runs OUTSIDE the contained walk, at both ends
	// of every call, so a replaced `WeakSet` would throw the caller's raw value
	// out of a door documented to throw a `ContractError` before any containment
	// exists. Every other dispatch on the traversal path runs inside the
	// contained walk and is translated below.
	static readonly #weakSet = WeakSet
	static readonly #weakMap = WeakMap
	readonly #source: ContractShape
	#state:
		| { readonly phase: 'idle' }
		| { readonly phase: 'active'; readonly poison?: ContractError } = { phase: 'idle' }
	#stack: Array<
		| {
				readonly operation: 'enter'
				readonly shape: ContractShape | undefined
				readonly depth: number
				readonly optional: boolean
				readonly first?: string
				readonly second?: string
		  }
		| { readonly operation: 'exit'; readonly index: number; readonly segments: number }
	> = []
	#path: string[] = []
	#active = new ShapeValidator.#weakSet<ContractShape>()
	// The capture. Discovery observes each unique node ONCE — descriptors, two
	// stable reads, scalar evidence and ordered outgoing edges — and every later
	// incoming edge is answered from here instead of from the caller's source.
	// Re-observing per incoming edge cost one whole observation per DISTINCT depth
	// a node was reached at, so an object holding one leaf at sixteen nesting
	// levels read that leaf sixteen times, and the subtree under it was re-walked
	// with it. `raw` is the height of a raw node's embedded schema, `0` for every
	// other node.
	#index = new ShapeValidator.#weakMap<ContractShape, number>()
	#captures: Array<{
		readonly shape: ContractShape
		readonly category: ContractShape['type'] | undefined
		readonly children: ReadonlyArray<{
			readonly shape: ContractShape | undefined
			readonly optional: boolean
			readonly first: string
			readonly second?: string
		}>
		readonly raw: number
	}> = []
	// Discovery postorder: children finish before parents, so reading it forwards
	// solves any bottom-up fact in one pass and reading it backwards solves any
	// top-down one. Both replace a walk that was multiplicative in incoming edges.
	#post: number[] = []
	#height: number[] = []
	#reach: number[] = []
	// The edge that last raised `#reach`, so the position a depth verdict was
	// taken FROM can be spelled back out as a path. A refusal answered from the
	// deepest occurrence and reported at the first-discovered one accuses a slot
	// the same declaration proves legal on its own.
	#via: Array<{ readonly parent: number; readonly first: string; readonly second?: string }> = []
	// One node per node per incoming edge: the size of the TREE a compiler would
	// build from this DAG, which is what actually bounds compilation.
	#counts: number[] = []
	#schemas = new ShapeValidator.#weakMap<object, number>()
	#expansion = 0
	#children: Array<{
		readonly shape: ContractShape | undefined
		readonly optional: boolean
		readonly first: string
		readonly second?: string
	}> = []
	#category: ContractShape['type'] | undefined
	#raw = 0
	#structure: ContractError | undefined
	#cycle: ContractError | undefined
	#domain: ContractError | undefined

	/**
	 * Retain a shape source without observing it.
	 *
	 * @param shape - The live shape source validated by each call
	 */
	constructor(shape: ContractShape) {
		this.#source = shape
	}

	/**
	 * The number of nodes the last successful {@link validate} found the source
	 * expands into.
	 *
	 * @remarks
	 * One per node per INCOMING EDGE, summed bottom-up — the size of the tree a
	 * compiler would build from this DAG, which a node count of the declaration
	 * itself does not describe. `0` before the first successful pass and after a
	 * failed one, because a failed pass has no expansion to report.
	 */
	get expansion(): number {
		return this.#expansion
	}

	/**
	 * Validate the retained source's current declaration.
	 *
	 * @remarks
	 * The whole traversal is contained, and a failure this class did not author
	 * is translated into `validateShapeDepth: shape reflection failed` carrying
	 * the exact thrown value. Containment is what makes that claim hold for
	 * dispatch nobody enumerated — including the recognition of an authored error,
	 * which is why that recognition is no longer answerable by any member a caller
	 * can write. The sentence this replaces asserted the same conclusion from the
	 * absence of reachable dispatch, and the absence was not established.
	 *
	 * @returns Nothing when the declaration is valid
	 * @throws {ContractError} When the declaration is malformed, cyclic, too deep, unreadable, or reentered
	 */
	validate(): void {
		if (this.#state.phase === 'active') {
			const poison =
				this.#state.poison ??
				new ContractError('ShapeValidator.validate: shape validation may not be reentered', {
					code: 'structure',
					context: { path: [] },
				})
			this.#state = { phase: 'active', poison }
			throw poison
		}

		this.#clear()
		this.#state = { phase: 'active' }
		const outcome = attempt(() => this.#execute())
		const poison = this.#state.phase === 'active' ? this.#state.poison : undefined
		this.#clear()
		if (poison !== undefined) throw poison
		if (outcome.success) return
		// A contained failure this class did not author came from a caller-
		// reachable dispatch on the traversal path — a replaced intrinsic member,
		// a polluted diagnostic read — and rethrowing it verbatim would put the
		// caller's raw value through a door whose contract is a `ContractError`.
		if (isContractError(outcome.error)) throw outcome.error
		throw new ContractError('validateShapeDepth: shape reflection failed', {
			code: 'structure',
			context: { path: [] },
			cause: outcome.error,
		})
	}

	#clear(): void {
		this.#state = { phase: 'idle' }
		this.#stack = []
		this.#path = []
		this.#active = new ShapeValidator.#weakSet()
		this.#index = new ShapeValidator.#weakMap()
		this.#captures = []
		this.#post = []
		this.#height = []
		this.#reach = []
		this.#via = []
		this.#counts = []
		this.#schemas = new ShapeValidator.#weakMap()
		this.#children = []
		this.#category = undefined
		this.#raw = 0
		this.#structure = undefined
		this.#cycle = undefined
		this.#domain = undefined
	}

	#execute(): void {
		this.#expansion = 0
		this.#stack[this.#stack.length] = {
			operation: 'enter',
			shape: this.#source,
			depth: 0,
			optional: false,
		}
		while (this.#stack.length > 0) this.#visit()
		this.#measure()
		this.#finish()
		this.#expansion = this.#counts[0] ?? 1
	}

	#visit(): void {
		const frame = this.#stack.pop()
		if (frame === undefined) return
		if (frame.operation === 'exit') {
			const capture = this.#captures[frame.index]
			if (capture !== undefined) omitVisited(this.#active, capture.shape)
			this.#post[this.#post.length] = frame.index
			this.#path.length -= frame.segments
			return
		}

		let segments = 0
		if (frame.first !== undefined) {
			this.#path[this.#path.length] = frame.first
			segments += 1
		}
		if (frame.second !== undefined) {
			this.#path[this.#path.length] = frame.second
			segments += 1
		}

		const current = frame.shape
		if (typeof current !== 'object' || current === null || !isRecord(current)) {
			this.#structure ??= new ContractError(
				'validateShapeDepth: every structural child must be a shape',
				{
					code: 'structure',
					context: { path: pathOf(this.#path) },
				},
			)
			this.#path.length -= segments
			return
		}
		if (matchesVisited(this.#active, current)) {
			this.#cycle ??= new ContractError(
				'validateShapeDepth: a shape graph may not contain a cycle',
				{
					code: 'cycle',
					context: { path: pathOf(this.#path) },
				},
			)
			this.#path.length -= segments
			return
		}

		// The refinement, and the whole reason discovery is separate from
		// measurement: a node already captured is not observed again. Every rule the
		// OBSERVATION enforces is a property of the node, so a second look at the
		// same node can only produce the same answer at a longer path. Two rules are
		// properties of the POSITION instead, and they are answered in two different
		// places: where an `optional` node is legal is re-asked here, from the
		// capture, for every incoming edge, while depth — the shape's own and a raw
		// node's embedded schema alike — is measured over the whole captured graph in
		// `#measure`, which is why its diagnostics are spelled from the deepest
		// occurrence rather than from whichever edge discovery arrived on.
		const seen = INTRINSICS.apply(INTRINSICS.recall, this.#index, [current])
		if (seen !== undefined) {
			this.#place(seen, frame.optional)
			this.#path.length -= segments
			return
		}

		this.#children = []
		this.#category = undefined
		this.#raw = 0
		const outcome = attempt(() => this.#observe(current, frame.depth))
		if (!outcome.success || !outcome.value) {
			this.#structure ??= new ContractError(
				'validateShapeDepth: every node must be a recognized shape',
				{
					code: 'structure',
					context: { path: pathOf(this.#path) },
				},
			)
			// Captured as a childless leaf. Its subtree is not walked, exactly as
			// before, but every later edge to it now measures its depth from the
			// capture instead of re-running the observation that already refused.
			this.#post[this.#post.length] = this.#capture(current, [])
			this.#path.length -= segments
			return
		}

		this.#place(this.#schedule(current, frame.depth, segments), frame.optional)
	}

	#observe(current: ContractShape, depth: number): boolean {
		const descriptor = INTRINSICS.describe(current, 'type')
		if (descriptor === undefined || !INTRINSICS.own(descriptor, 'value')) {
			return this.#refuse('validateShapeDepth: every node must be a recognized shape')
		}
		const category = current.type
		if (current.type !== category || descriptor.value !== category) {
			return this.#refuse('validateShapeDepth: every node must be a recognized shape')
		}
		const fields = this.#recognize(category)
		if (fields === undefined) {
			return this.#refuse('validateShapeDepth: every node must be a recognized shape')
		}
		this.#category = category
		if (!this.#scan(current, fields)) return false
		if (!this.#constrain(current)) return false
		if (category === 'raw') {
			const schema = current.schema
			const outcome = attempt(() => this.#inspect(schema))
			if (!outcome.success) {
				return this.#refuse('validateShapeDepth: every node must be a recognized shape', 'schema')
			}
			if (!outcome.value) return false
			// The embedded schema's own nesting is measured once per unique record
			// and applied at THIS node's depth, so a schema shared by two raw nodes
			// is validated once and still refuses at whichever node is too deep for
			// it. The deeper-occurrence case is re-asked in `#measure`.
			if (depth + this.#raw > COMPILE_DEPTH_LIMIT) {
				return this.#refuse(
					'validateShapeDepth: raw schema exceeds the compilation depth limit',
					'schema',
				)
			}
		}
		if (category === 'object') {
			const outcome = attempt(() => this.#populate(current))
			if (!outcome.success) {
				return this.#refuse(
					'validateShapeDepth: every node must be a recognized shape',
					'properties',
				)
			}
			return outcome.value
		}
		if (category === 'union') {
			const outcome = attempt(() => this.#populate(current))
			if (!outcome.success) {
				return this.#refuse('validateShapeDepth: every node must be a recognized shape', 'variants')
			}
			return outcome.value
		}
		if (category === 'literal') {
			const outcome = attempt(() => this.#populate(current))
			if (!outcome.success) {
				return this.#refuse('validateShapeDepth: every node must be a recognized shape', 'values')
			}
			return outcome.value
		}
		return this.#populate(current)
	}

	#recognize(category: ContractShape['type']): readonly string[] | undefined {
		switch (category) {
			case 'string':
				return ['min', 'max', 'pattern', 'description']
			case 'number':
				return ['integer', 'min', 'max', 'description']
			case 'boolean':
			case 'null':
			case 'json':
				return ['description']
			case 'literal':
				return ['values', 'description']
			case 'array':
				return ['items', 'min', 'max', 'description']
			case 'object':
				return ['properties', 'additionalProperties', 'description']
			case 'union':
				return ['variants', 'mode', 'description']
			case 'optional':
			case 'nullable':
				return ['inner']
			case 'raw':
				return ['schema']
		}
	}

	#scan(current: ContractShape, fields: readonly string[]): boolean {
		for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex += 1) {
			const field = fields[fieldIndex]
			if (field === undefined) continue
			const outcome = attempt((): boolean => {
				const descriptor = INTRINSICS.describe(current, field)
				if (
					descriptor !== undefined &&
					!INTRINSICS.own(descriptor, 'value') &&
					field !== 'pattern'
				) {
					return false
				}
				const first: unknown = INTRINSICS.read(current, field)
				const second: unknown = INTRINSICS.read(current, field)
				if (descriptor === undefined) return first === undefined && second === undefined
				if (INTRINSICS.own(descriptor, 'value')) {
					const described: unknown = descriptor.value
					return INTRINSICS.same(first, described) && INTRINSICS.same(second, first)
				}
				return (
					field === 'pattern' &&
					isRegExp(first) &&
					isRegExp(second) &&
					readPatternSource(first) === readPatternSource(second) &&
					readPatternFlags(first) === readPatternFlags(second) &&
					INTRINSICS.frozen(first) &&
					INTRINSICS.frozen(second)
				)
			})
			if (!outcome.success || !outcome.value) {
				return this.#refuse('validateShapeDepth: every node must be a recognized shape', field)
			}
		}
		return true
	}

	#constrain(current: ContractShape): boolean {
		if (
			current.type !== 'optional' &&
			current.type !== 'nullable' &&
			current.type !== 'raw' &&
			current.description !== undefined &&
			typeof current.description !== 'string'
		) {
			return this.#refuse('validateShapeDepth: description must be a string', 'description')
		}
		if (current.type === 'string') {
			if (current.min !== undefined && typeof current.min !== 'number') {
				return this.#refuse('validateShapeDepth: string min must be a number', 'min')
			}
			if (current.max !== undefined && typeof current.max !== 'number') {
				return this.#refuse('validateShapeDepth: string max must be a number', 'max')
			}
			if (current.pattern !== undefined) {
				const pattern = current.pattern
				if (!isRegExp(pattern)) {
					return this.#refuse('validateShapeDepth: string pattern must be a RegExp', 'pattern')
				}
				// Both observations go through the CAPTURED accessors: a replaced
				// `source` getter reports for every pattern in the realm, so the
				// stability this gate publishes would be stability of the caller's
				// answer rather than of the pattern.
				const source = readPatternSource(pattern)
				const flags = readPatternFlags(pattern)
				if (
					typeof source !== 'string' ||
					typeof flags !== 'string' ||
					readPatternSource(pattern) !== source ||
					readPatternFlags(pattern) !== flags
				) {
					return this.#refuse('validateShapeDepth: string pattern must be stable', 'pattern')
				}
				this.#restrict(current, source, flags)
			} else {
				this.#restrict(current)
			}
		}
		if (current.type === 'number') {
			if (current.min !== undefined && typeof current.min !== 'number') {
				return this.#refuse('validateShapeDepth: number min must be a number', 'min')
			}
			if (current.max !== undefined && typeof current.max !== 'number') {
				return this.#refuse('validateShapeDepth: number max must be a number', 'max')
			}
			if (current.integer !== undefined && typeof current.integer !== 'boolean') {
				return this.#refuse('validateShapeDepth: number integer must be a boolean', 'integer')
			}
			const shape = current.integer === true ? 'integer' : 'number'
			if (
				this.#domain === undefined &&
				current.min !== undefined &&
				!INTRINSICS.finite(current.min)
			) {
				this.#domain = new ContractError('validateShapeDepth: a number shape min must be finite', {
					code: 'bound',
					context: {
						path: pathOf(this.#path),
						shape,
						limit: 'finite number',
						received: INTRINSICS.text(current.min),
					},
				})
			}
			if (
				this.#domain === undefined &&
				current.max !== undefined &&
				!INTRINSICS.finite(current.max)
			) {
				this.#domain = new ContractError('validateShapeDepth: a number shape max must be finite', {
					code: 'bound',
					context: {
						path: pathOf(this.#path),
						shape,
						limit: 'finite number',
						received: INTRINSICS.text(current.max),
					},
				})
			}
			if (
				this.#domain === undefined &&
				current.min !== undefined &&
				current.max !== undefined &&
				current.min > current.max
			) {
				this.#domain = new ContractError(
					'validateShapeDepth: a number shape has min greater than max',
					{ code: 'range', context: { path: pathOf(this.#path), shape } },
				)
			}
			if (this.#domain === undefined && current.integer === true) {
				const lo = INTRINSICS.ceil(current.min ?? Number.NEGATIVE_INFINITY)
				const hi = INTRINSICS.floor(current.max ?? Number.POSITIVE_INFINITY)
				if (lo > hi) {
					this.#domain = new ContractError(
						'validateShapeDepth: an integer number shape has an empty integer range',
						{
							code: 'range',
							context: { path: pathOf(this.#path), shape: 'integer' },
						},
					)
				}
			}
		}
		if (current.type === 'array' && current.min !== undefined && typeof current.min !== 'number') {
			return this.#refuse('validateShapeDepth: array min must be a number', 'min')
		}
		if (current.type === 'array' && current.max !== undefined && typeof current.max !== 'number') {
			return this.#refuse('validateShapeDepth: array max must be a number', 'max')
		}
		if (
			current.type === 'array' &&
			this.#domain === undefined &&
			current.min !== undefined &&
			(!INTRINSICS.safe(current.min) || current.min < 0)
		) {
			this.#domain = new ContractError(
				'validateShapeDepth: an array shape min must be a non-negative safe integer',
				{
					code: 'bound',
					context: {
						path: pathOf(this.#path),
						shape: 'array',
						limit: 'non-negative safe integer',
						received: INTRINSICS.text(current.min),
					},
				},
			)
		}
		if (
			current.type === 'array' &&
			this.#domain === undefined &&
			current.max !== undefined &&
			(!INTRINSICS.safe(current.max) || current.max < 0)
		) {
			this.#domain = new ContractError(
				'validateShapeDepth: an array shape max must be a non-negative safe integer',
				{
					code: 'bound',
					context: {
						path: pathOf(this.#path),
						shape: 'array',
						limit: 'non-negative safe integer',
						received: INTRINSICS.text(current.max),
					},
				},
			)
		}
		if (
			current.type === 'array' &&
			this.#domain === undefined &&
			current.min !== undefined &&
			current.max !== undefined &&
			current.min > current.max
		) {
			this.#domain = new ContractError(
				'validateShapeDepth: an array shape has min greater than max',
				{
					code: 'range',
					context: { path: pathOf(this.#path), shape: 'array' },
				},
			)
		}
		if (
			current.type === 'union' &&
			current.mode !== undefined &&
			current.mode !== 'anyOf' &&
			current.mode !== 'oneOf'
		) {
			return this.#refuse('validateShapeDepth: union mode must be anyOf or oneOf', 'mode')
		}
		return true
	}

	// Where an `optional` node is legal depends on the SLOT it arrived through, not
	// on the node, so this is the one rule discovery asks per incoming edge rather
	// than once per node. It reads the captured category instead of the source: a
	// second read of `type` would be a second observation of a node already
	// observed, and an unrecognized node has no category to answer with.
	#place(index: number, optional: boolean): void {
		if (optional || this.#domain !== undefined) return
		if (this.#captures[index]?.category !== 'optional') return
		this.#domain = new ContractError(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
			{
				code: 'placement',
				context: { path: pathOf(this.#path), shape: 'optional' },
			},
		)
	}

	#restrict(current: StringShape, source = '', flags = ''): void {
		if (
			this.#domain === undefined &&
			current.min !== undefined &&
			(!INTRINSICS.safe(current.min) || current.min < 0)
		) {
			this.#domain = new ContractError(
				'validateShapeDepth: a string shape min must be a non-negative safe integer',
				{
					code: 'bound',
					context: {
						path: pathOf(this.#path),
						shape: 'string',
						limit: 'non-negative safe integer',
						received: INTRINSICS.text(current.min),
					},
				},
			)
		}
		if (
			this.#domain === undefined &&
			current.max !== undefined &&
			(!INTRINSICS.safe(current.max) || current.max < 0)
		) {
			this.#domain = new ContractError(
				'validateShapeDepth: a string shape max must be a non-negative safe integer',
				{
					code: 'bound',
					context: {
						path: pathOf(this.#path),
						shape: 'string',
						limit: 'non-negative safe integer',
						received: INTRINSICS.text(current.max),
					},
				},
			)
		}
		if (this.#domain === undefined && flags.length > 0) {
			this.#domain = new ContractError(
				'validateShapeDepth: a string shape pattern must not use flags; use inline pattern constructs instead',
				{
					code: 'pattern',
					context: {
						path: pathOf(this.#path),
						shape: 'string',
						received: `/${source}/${flags}`,
					},
				},
			)
		}
		if (
			this.#domain === undefined &&
			current.min !== undefined &&
			current.max !== undefined &&
			current.min > current.max
		) {
			this.#domain = new ContractError(
				'validateShapeDepth: a string shape has min greater than max',
				{
					code: 'range',
					context: { path: pathOf(this.#path), shape: 'string' },
				},
			)
		}
	}

	// Validates the embedded schema graph and leaves its HEIGHT in `#raw` — the
	// number of levels it adds below the raw node that carries it. Each unique
	// record is validated once per call and memoized, so a schema shared between
	// two raw nodes, or reached twice inside one, costs its records and edges
	// rather than its paths. The depth verdict moved out with it: a height is a
	// property of the schema, while whether that height fits is a property of the
	// node's position, and only the second one varies per occurrence.
	#inspect(source: unknown): boolean {
		if (!isRecord(source)) {
			return this.#refuse('validateShapeDepth: raw schema must be a plain record', 'schema')
		}
		const active = new ShapeValidator.#weakSet<object>()
		const stack: Array<
			| { readonly operation: 'enter'; readonly schema: unknown }
			| { readonly operation: 'exit'; readonly schema: object; readonly nested: readonly unknown[] }
		> = [{ operation: 'enter', schema: source }]

		while (stack.length > 0) {
			const frame = stack.pop()
			if (frame === undefined) continue
			if (frame.operation === 'exit') {
				omitVisited(active, frame.schema)
				this.#settleSchema(frame.schema, frame.nested)
				continue
			}
			const schema = frame.schema
			if (!isRecord(schema)) {
				return this.#refuse(
					'validateShapeDepth: every raw schema child must be a plain record',
					'schema',
				)
			}
			if (matchesVisited(active, schema)) {
				return this.#refuse('validateShapeDepth: a raw schema may not contain a cycle', 'schema')
			}
			if (INTRINSICS.apply(INTRINSICS.recall, this.#schemas, [schema]) !== undefined) continue
			admitVisited(active, schema)

			const keyList = INTRINSICS.keys(schema)
			for (let keyIndex = 0; keyIndex < keyList.length; keyIndex += 1) {
				const key = keyList[keyIndex]
				if (key === undefined) continue
				if (
					key !== 'type' &&
					key !== 'description' &&
					key !== 'enum' &&
					key !== 'minLength' &&
					key !== 'maxLength' &&
					key !== 'pattern' &&
					key !== 'format' &&
					key !== 'minimum' &&
					key !== 'maximum' &&
					key !== 'minItems' &&
					key !== 'maxItems' &&
					key !== 'items' &&
					key !== 'properties' &&
					key !== 'required' &&
					key !== 'additionalProperties' &&
					key !== 'anyOf' &&
					key !== 'oneOf'
				) {
					return this.#refuse(
						'validateShapeDepth: raw schema contains an unsupported keyword',
						'schema',
					)
				}
			}

			const category = schema.type
			if (
				category !== undefined &&
				category !== 'null' &&
				category !== 'boolean' &&
				category !== 'object' &&
				category !== 'array' &&
				category !== 'number' &&
				category !== 'integer' &&
				category !== 'string'
			) {
				return this.#refuse(
					'validateShapeDepth: raw schema type is outside the supported vocabulary',
					'schema',
				)
			}
			if (schema.description !== undefined && typeof schema.description !== 'string') {
				return this.#refuse('validateShapeDepth: raw schema description must be a string', 'schema')
			}
			if (schema.format !== undefined && typeof schema.format !== 'string') {
				return this.#refuse('validateShapeDepth: raw schema format must be a string', 'schema')
			}
			if (schema.pattern !== undefined) {
				if (typeof schema.pattern !== 'string') {
					return this.#refuse('validateShapeDepth: raw schema pattern must be a string', 'schema')
				}
				// The CAPTURED `RegExp`, not the live global: the result of this read is
				// the refusal `rawShape` documents, and a caller who installed a
				// non-throwing stub made a malformed pattern compile clean.
				const pattern = attempt(() =>
					INTRINSICS.apply(INTRINSICS.pattern, undefined, [schema.pattern]),
				)
				if (!pattern.success) {
					return this.#refuse('validateShapeDepth: raw schema pattern must be valid', 'schema')
				}
			}

			const lengthList = ['minLength', 'maxLength', 'minItems', 'maxItems']
			for (let lengthIndex = 0; lengthIndex < lengthList.length; lengthIndex += 1) {
				const key = lengthList[lengthIndex]
				if (key === undefined) continue
				const value = schema[key]
				if (value !== undefined && (!INTRINSICS.safe(value) || INTRINSICS.numeric(value) < 0)) {
					return this.#refuse(
						'validateShapeDepth: raw schema length bounds must be non-negative safe integers',
						'schema',
					)
				}
			}
			const rangeList = ['minimum', 'maximum']
			for (let rangeIndex = 0; rangeIndex < rangeList.length; rangeIndex += 1) {
				const key = rangeList[rangeIndex]
				if (key === undefined) continue
				const value = schema[key]
				if (value !== undefined && (typeof value !== 'number' || !INTRINSICS.finite(value))) {
					return this.#refuse(
						'validateShapeDepth: raw schema numeric bounds must be finite numbers',
						'schema',
					)
				}
			}
			const population = schema.enum
			if (population !== undefined) {
				if (!INTRINSICS.array(population)) {
					return this.#refuse(
						'validateShapeDepth: raw schema enum must be a non-empty array',
						'schema',
					)
				}
				const snapshot = readArrayEntries(population)
				if (!snapshot.success || snapshot.value.entries.length === 0) {
					return this.#refuse(
						'validateShapeDepth: raw schema enum must be a non-empty array',
						'schema',
					)
				}
				if (!snapshot.value.dense) {
					return this.#refuse('validateShapeDepth: raw schema enum must be dense', 'schema')
				}
				// A module-scope membership question, not `set.has(value)`: this
				// uniqueness test decides whether the door accepts or refuses, so
				// `Set.prototype.has = () => false` would admit a duplicate vocabulary
				// the shape gate exists to reject.
				const values = collectMembers([])
				for (let valueIndex = 0; valueIndex < snapshot.value.entries.length; valueIndex += 1) {
					// A present member whose captured value is `undefined` is refused by
					// the literal test below rather than skipped.
					const value = snapshot.value.entries[valueIndex]
					if (
						!isLiteralValue(value) ||
						(typeof value === 'number' && !INTRINSICS.finite(value)) ||
						matchesMember(values, value)
					) {
						return this.#refuse(
							'validateShapeDepth: raw schema enum values must be finite unique primitives',
							'schema',
						)
					}
					admitMember(values, value)
				}
			}

			const names = schema.required
			if (names !== undefined) {
				if (!INTRINSICS.array(names)) {
					return this.#refuse('validateShapeDepth: raw schema required must be an array', 'schema')
				}
				const snapshot = readArrayEntries(names)
				if (!snapshot.success) {
					return this.#refuse('validateShapeDepth: raw schema required must be an array', 'schema')
				}
				if (!snapshot.value.dense) {
					return this.#refuse('validateShapeDepth: raw schema required must be dense', 'schema')
				}
				const required = collectMembers([])
				for (let valueIndex = 0; valueIndex < snapshot.value.entries.length; valueIndex += 1) {
					const value = snapshot.value.entries[valueIndex]
					if (value === undefined) continue
					if (typeof value !== 'string' || matchesMember(required, value)) {
						return this.#refuse(
							'validateShapeDepth: raw schema required values must be unique strings',
							'schema',
						)
					}
					admitMember(required, value)
				}
			}

			const nested: unknown[] = []
			if (schema.items !== undefined) nested[nested.length] = schema.items
			if (schema.properties !== undefined) {
				if (!isRecord(schema.properties)) {
					return this.#refuse(
						'validateShapeDepth: raw schema properties must be a plain record',
						'schema',
					)
				}
				const propertyList = INTRINSICS.keys(schema.properties)
				for (let propertyIndex = 0; propertyIndex < propertyList.length; propertyIndex += 1) {
					const key = propertyList[propertyIndex]
					if (key === undefined) continue
					nested[nested.length] = schema.properties[key]
				}
			}
			if (
				schema.additionalProperties !== undefined &&
				schema.additionalProperties !== true &&
				schema.additionalProperties !== false
			) {
				nested[nested.length] = schema.additionalProperties
			}
			const unionList = ['anyOf', 'oneOf']
			for (let unionIndex = 0; unionIndex < unionList.length; unionIndex += 1) {
				const key = unionList[unionIndex]
				if (key === undefined) continue
				const variants = schema[key]
				if (variants === undefined) continue
				if (!INTRINSICS.array(variants)) {
					return this.#refuse(
						'validateShapeDepth: raw schema unions must be non-empty arrays',
						'schema',
					)
				}
				const snapshot = readArrayEntries(variants)
				if (!snapshot.success || snapshot.value.entries.length === 0) {
					return this.#refuse(
						'validateShapeDepth: raw schema unions must be non-empty arrays',
						'schema',
					)
				}
				if (!snapshot.value.dense) {
					return this.#refuse(
						'validateShapeDepth: raw schema unions must be dense arrays',
						'schema',
					)
				}
				for (
					let variantIndex = 0;
					variantIndex < snapshot.value.entries.length;
					variantIndex += 1
				) {
					// A present member whose captured value is `undefined` is still a
					// present member, so it is scheduled and refused as a nonrecord
					// rather than skipped.
					nested[nested.length] = snapshot.value.entries[variantIndex]
				}
			}
			stack[stack.length] = { operation: 'exit', schema, nested }
			for (let index = nested.length - 1; index >= 0; index -= 1) {
				stack[stack.length] = { operation: 'enter', schema: nested[index] }
			}
		}
		this.#raw = INTRINSICS.apply(INTRINSICS.recall, this.#schemas, [source]) ?? 0
		return true
	}

	// One raw-schema record's height, recorded as its walk finishes. Every nested
	// record has already finished, so its own height is in the memo.
	#settleSchema(schema: object, nested: readonly unknown[]): void {
		let height = 0
		for (let index = 0; index < nested.length; index += 1) {
			const child = nested[index]
			const recorded =
				typeof child !== 'object' || child === null
					? 0
					: (INTRINSICS.apply(INTRINSICS.recall, this.#schemas, [child]) ?? 0)
			if (recorded + 1 > height) height = recorded + 1
		}
		INTRINSICS.apply(INTRINSICS.retain, this.#schemas, [schema, height])
	}

	#populate(current: ContractShape): boolean {
		switch (current.type) {
			case 'array':
				this.#children[this.#children.length] = {
					shape: current.items,
					first: 'items',
					optional: false,
				}
				break
			case 'object': {
				const properties = current.properties
				if (!isRecord(properties)) {
					return this.#refuse(
						'validateShapeDepth: properties must be a plain property map',
						'properties',
					)
				}
				const keys = INTRINSICS.keys(properties)
				for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
					const key = keys[keyIndex]
					if (key === undefined) continue
					const descriptorOutcome = attempt(() => INTRINSICS.describe(properties, key))
					if (!descriptorOutcome.success) {
						return this.#refuse(
							'validateShapeDepth: every node must be a recognized shape',
							'properties',
							key,
						)
					}
					const descriptor = descriptorOutcome.value
					if (descriptor === undefined || !INTRINSICS.own(descriptor, 'value')) {
						this.#children[this.#children.length] = {
							shape: undefined,
							first: 'properties',
							second: key,
							optional: true,
						}
						continue
					}
					const childOutcome = attempt(() => current.properties[key])
					if (!childOutcome.success) {
						return this.#refuse(
							'validateShapeDepth: every node must be a recognized shape',
							'properties',
							key,
						)
					}
					const child = childOutcome.value
					const stable = attempt(
						() =>
							INTRINSICS.same(current.properties[key], child) &&
							INTRINSICS.same(descriptor.value, child),
					)
					if (!stable.success) {
						return this.#refuse(
							'validateShapeDepth: every node must be a recognized shape',
							'properties',
							key,
						)
					}
					if (!stable.value) {
						this.#children[this.#children.length] = {
							shape: undefined,
							first: 'properties',
							second: key,
							optional: true,
						}
						continue
					}
					this.#children[this.#children.length] = {
						shape: child,
						first: 'properties',
						second: key,
						optional: true,
					}
				}
				const extra = current.additionalProperties
				if (extra !== undefined && extra !== true && extra !== false) {
					this.#children[this.#children.length] = {
						shape: extra,
						first: 'additionalProperties',
						optional: false,
					}
				}
				break
			}
			case 'union': {
				if (!INTRINSICS.array(current.variants)) {
					return this.#refuse('validateShapeDepth: variants must be a finite array', 'variants')
				}
				const snapshot = readArrayEntries(current.variants)
				if (!snapshot.success) {
					return this.#refuse('validateShapeDepth: variants must be a finite array', 'variants')
				}
				if (!snapshot.value.dense) {
					return this.#refuse('validateShapeDepth: variants must be a dense data array', 'variants')
				}
				const variants = snapshot.value.entries
				const length = variants.length
				if (this.#domain === undefined && length === 0) {
					this.#domain = new ContractError(
						'validateShapeDepth: a union shape needs at least one variant',
						{
							code: 'empty',
							context: { path: pathOf(this.#path), shape: 'union' },
						},
					)
				}
				for (let index = 0; index < length; index += 1) {
					const key = INTRINSICS.text(index)
					const descriptorOutcome = attempt(() => INTRINSICS.describe(current.variants, key))
					if (!descriptorOutcome.success) {
						return this.#refuse(
							'validateShapeDepth: every node must be a recognized shape',
							'variants',
							key,
						)
					}
					const descriptor = descriptorOutcome.value
					if (descriptor === undefined || !INTRINSICS.own(descriptor, 'value')) {
						this.#children[this.#children.length] = {
							shape: undefined,
							first: 'variants',
							second: key,
							optional: false,
						}
						continue
					}
					const variant = variants[index]
					const stable = attempt(
						() =>
							INTRINSICS.same(current.variants[index], variant) &&
							INTRINSICS.same(descriptor.value, variant),
					)
					if (!stable.success) {
						return this.#refuse(
							'validateShapeDepth: every node must be a recognized shape',
							'variants',
							key,
						)
					}
					if (!stable.value) {
						this.#children[this.#children.length] = {
							shape: undefined,
							first: 'variants',
							second: key,
							optional: false,
						}
						continue
					}
					this.#children[this.#children.length] = {
						shape: variant,
						first: 'variants',
						second: key,
						optional: false,
					}
				}
				break
			}
			case 'literal': {
				if (!INTRINSICS.array(current.values)) {
					return this.#refuse('validateShapeDepth: values must be a finite literal array', 'values')
				}
				const snapshot = readArrayEntries(current.values)
				if (!snapshot.success) {
					return this.#refuse('validateShapeDepth: values must be a finite literal array', 'values')
				}
				if (!snapshot.value.dense) {
					return this.#refuse('validateShapeDepth: values must be a dense data array', 'values')
				}
				const literals = snapshot.value.entries
				const length = literals.length
				if (this.#domain === undefined && length === 0) {
					this.#domain = new ContractError(
						'validateShapeDepth: a literal shape needs at least one value',
						{
							code: 'empty',
							context: { path: pathOf(this.#path), shape: 'literal' },
						},
					)
				}
				// A module-scope membership question, not `set.has(value)`: this
				// uniqueness test decides whether the door accepts or refuses, so
				// `Set.prototype.has = () => false` would admit a duplicate vocabulary
				// the shape gate exists to reject.
				const values = collectMembers([])
				for (let index = 0; index < length; index += 1) {
					const key = INTRINSICS.text(index)
					const descriptorOutcome = attempt(() => INTRINSICS.describe(current.values, key))
					if (!descriptorOutcome.success) {
						return this.#refuse(
							'validateShapeDepth: every node must be a recognized shape',
							'values',
							key,
						)
					}
					const descriptor = descriptorOutcome.value
					if (descriptor === undefined || !INTRINSICS.own(descriptor, 'value')) {
						return this.#refuse(
							'validateShapeDepth: values must be a dense data array',
							'values',
							key,
						)
					}
					const value = literals[index]
					const stable = attempt(
						() =>
							INTRINSICS.same(current.values[index], value) &&
							INTRINSICS.same(descriptor.value, value),
					)
					if (!stable.success) {
						return this.#refuse(
							'validateShapeDepth: every node must be a recognized shape',
							'values',
							key,
						)
					}
					if (!stable.value) {
						return this.#refuse(
							'validateShapeDepth: values must be a stable data array',
							'values',
							key,
						)
					}
					if (!isLiteralValue(value)) {
						return this.#refuse(
							'validateShapeDepth: every literal value must be a string, number, or boolean',
							'values',
							key,
						)
					}
					if (matchesMember(values, value)) {
						return this.#refuse('validateShapeDepth: literal values must be unique', 'values', key)
					}
					admitMember(values, value)
					if (
						this.#domain === undefined &&
						typeof value === 'number' &&
						!INTRINSICS.finite(value)
					) {
						this.#domain = new ContractError(
							'validateShapeDepth: a literal shape may not contain non-finite number values',
							{
								code: 'literal',
								context: {
									path: pathOf(this.#path),
									shape: 'literal',
									received: INTRINSICS.text(value),
								},
							},
						)
					}
				}
				break
			}
			case 'optional':
			case 'nullable':
				this.#children[this.#children.length] = {
					shape: current.inner,
					first: 'inner',
					optional: false,
				}
				break
			case 'string':
			case 'number':
			case 'boolean':
			case 'null':
			case 'json':
			case 'raw':
				break
		}
		return true
	}

	#schedule(current: ContractShape, depth: number, segments: number): number {
		admitVisited(this.#active, current)
		const children: Array<{
			readonly shape: ContractShape | undefined
			readonly optional: boolean
			readonly first: string
			readonly second?: string
		}> = []
		for (let index = 0; index < this.#children.length; index += 1) {
			const child = this.#children[index]
			if (child === undefined) continue
			children[children.length] = child
		}
		const captured = this.#capture(current, children)
		this.#stack[this.#stack.length] = { operation: 'exit', index: captured, segments }
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index]
			if (child === undefined) continue
			this.#stack[this.#stack.length] = {
				operation: 'enter',
				shape: child.shape,
				depth: depth + 1,
				optional: child.optional,
				first: child.first,
				...(child.second === undefined ? {} : { second: child.second }),
			}
		}
		return captured
	}

	#capture(
		shape: ContractShape,
		children: ReadonlyArray<{
			readonly shape: ContractShape | undefined
			readonly optional: boolean
			readonly first: string
			readonly second?: string
		}>,
	): number {
		const index = this.#captures.length
		this.#captures[index] = { shape, category: this.#category, children, raw: this.#raw }
		INTRINSICS.apply(INTRINSICS.retain, this.#index, [shape, index])
		return index
	}

	#locate(shape: ContractShape | undefined): number | undefined {
		if (shape === undefined) return undefined
		return INTRINSICS.apply(INTRINSICS.recall, this.#index, [shape])
	}

	// Everything the walk used to answer by walking again. Reading the discovery
	// postorder forwards gives every bottom-up fact — subtree height and emitted
	// expansion — and reading it backwards gives the top-down one, the deepest
	// position each node occupies. Both are one pass over the captured nodes and
	// edges, which is what makes a shared-child declaration cost its DECLARATION
	// rather than its paths.
	#measure(): void {
		for (let index = 0; index < this.#captures.length; index += 1) {
			this.#height[index] = 0
			this.#reach[index] = 0
			this.#counts[index] = 1
		}
		// A back edge to a still-open ancestor leaves no order to compute a height
		// in, so a cyclic capture takes the ordered path walk instead.
		if (this.#cycle !== undefined) {
			this.#trace()
			return
		}
		for (let step = 0; step < this.#post.length; step += 1) {
			const index = this.#post[step]
			if (index === undefined) continue
			const capture = this.#captures[index]
			if (capture === undefined) continue
			let height = 0
			let count = 1
			for (let edge = 0; edge < capture.children.length; edge += 1) {
				const child = capture.children[edge]
				if (child === undefined) continue
				const located = this.#locate(child.shape)
				const reached = located === undefined ? 0 : (this.#height[located] ?? 0)
				if (reached + 1 > height) height = reached + 1
				count += located === undefined ? 1 : (this.#counts[located] ?? 1)
			}
			this.#height[index] = height
			this.#counts[index] = count
		}
		if ((this.#height[0] ?? 0) > COMPILE_DEPTH_LIMIT) this.#witness()
		// Reverse postorder is a topological order, so a node's own deepest position
		// is final before its edges are read. Recording the edge that raised it
		// leaves a parent chain from any node back to the root, each link one level
		// shallower than the last.
		for (let step = this.#post.length - 1; step >= 0; step -= 1) {
			const index = this.#post[step]
			if (index === undefined) continue
			const capture = this.#captures[index]
			if (capture === undefined) continue
			const base = this.#reach[index] ?? 0
			for (let edge = 0; edge < capture.children.length; edge += 1) {
				const child = capture.children[edge]
				if (child === undefined) continue
				const located = this.#locate(child.shape)
				if (located === undefined) continue
				if ((this.#reach[located] ?? 0) >= base + 1) continue
				this.#reach[located] = base + 1
				this.#via[located] = {
					parent: index,
					first: child.first,
					...(child.second === undefined ? {} : { second: child.second }),
				}
			}
		}
		for (let index = 0; index < this.#captures.length; index += 1) {
			const capture = this.#captures[index]
			if (capture === undefined || capture.raw === 0) continue
			if ((this.#reach[index] ?? 0) + capture.raw <= COMPILE_DEPTH_LIMIT) continue
			this.#structure ??= new ContractError(
				'validateShapeDepth: raw schema exceeds the compilation depth limit',
				{ code: 'structure', context: { path: pathOf(this.#ascend(index), 'schema') } },
			)
		}
	}

	// The declaration path to a node's DEEPEST occurrence, spelled out by walking
	// the improving edges back to the root and reversing them. The raw-depth rule
	// is re-asked from that occurrence, so the diagnostic has to name it too: the
	// first-discovered path names a slot that, on its own, validates.
	#ascend(index: number): readonly string[] {
		const reversed: string[] = []
		let current = index
		while (current !== 0) {
			const edge = this.#via[current]
			if (edge === undefined) break
			if (edge.second !== undefined) reversed[reversed.length] = edge.second
			reversed[reversed.length] = edge.first
			current = edge.parent
		}
		const path: string[] = []
		for (let step = reversed.length - 1; step >= 0; step -= 1) {
			const segment = reversed[step]
			if (segment === undefined) continue
			path[path.length] = segment
		}
		return path
	}

	// The first excessive-depth witness in declaration order, reconstructed rather
	// than searched for: at each level the earliest edge whose remaining height
	// still overshoots the allowance is the edge a pre-order walk would have taken.
	#witness(): never {
		const path: string[] = []
		let index: number | undefined = 0
		let depth = 0
		while (depth <= COMPILE_DEPTH_LIMIT) {
			const capture = index === undefined ? undefined : this.#captures[index]
			const children = capture === undefined ? [] : capture.children
			let chosen:
				| {
						readonly shape: ContractShape | undefined
						readonly first: string
						readonly second?: string
				  }
				| undefined
			for (let edge = 0; edge < children.length; edge += 1) {
				const child = children[edge]
				if (child === undefined) continue
				const located = this.#locate(child.shape)
				const reached = located === undefined ? 0 : (this.#height[located] ?? 0)
				if (depth + 1 + reached > COMPILE_DEPTH_LIMIT) {
					chosen = child
					index = located
					break
				}
			}
			if (chosen === undefined) break
			path[path.length] = chosen.first
			if (chosen.second !== undefined) path[path.length] = chosen.second
			depth += 1
		}
		throw new ContractError('validateShapeDepth: a shape exceeds the compilation depth limit', {
			code: 'depth',
			context: { path: pathOf(path), limit: COMPILE_DEPTH_LIMIT },
		})
	}

	// The cyclic fallback. It walks the CAPTURED nodes and edges — never the
	// caller's source again — carrying the deepest start each node already cleared,
	// so a shared child off the cycle is still not re-walked from a shallower
	// position. Depth outranks the recorded cycle, exactly as before: a back edge
	// first reached beyond the limit is a depth refusal, and one reached inside it
	// leaves the cycle to speak.
	//
	// A clearance is only reusable when the walk that produced it did not depend on
	// the CALLER's path. A walk stopped by the active set stopped at some ancestor,
	// and which ancestor decides everything: one admitted inside this subtree is
	// re-admitted at the same relative place on every later arrival, so the walk
	// repeats and the clearance holds; one that was already active when the subtree
	// was entered belongs to the route in, and a later, shallower arrival without it
	// walks on through the cycle to a depth this walk never measured. Memoizing that
	// second kind made the verdict depend on how long the alias chain to the node
	// was — shortening a declaration by one link turned `depth` into `cycle`.
	//
	// Admission order tells the two apart with one comparison and no extra
	// collection: a node's own admission number bounds its subtree, so a blocker
	// numbered below it came from outside. `oldest` carries the lowest-numbered
	// blocker the open subtree met, seeded one past the subtree root so an
	// unblocked walk compares as internal, and each exit hands its parent the lower
	// of the two.
	#trace(): void {
		const settled: number[] = []
		const order: number[] = []
		let clock = 0
		let oldest = 0
		const active = new ShapeValidator.#weakSet<ContractShape>()
		const path: string[] = []
		const stack: Array<
			| {
					readonly operation: 'enter'
					readonly index: number | undefined
					readonly depth: number
					readonly first?: string
					readonly second?: string
			  }
			| {
					readonly operation: 'exit'
					readonly index: number
					readonly depth: number
					readonly segments: number
					readonly outer: number
			  }
		> = [{ operation: 'enter', index: 0, depth: 0 }]

		while (stack.length > 0) {
			const frame = stack.pop()
			if (frame === undefined) continue
			if (frame.operation === 'exit') {
				const capture = this.#captures[frame.index]
				if (capture !== undefined) omitVisited(active, capture.shape)
				if (oldest >= (order[frame.index] ?? 0) && (settled[frame.index] ?? -1) < frame.depth) {
					settled[frame.index] = frame.depth
				}
				if (frame.outer < oldest) oldest = frame.outer
				path.length -= frame.segments
				continue
			}
			let segments = 0
			if (frame.first !== undefined) {
				path[path.length] = frame.first
				segments += 1
			}
			if (frame.second !== undefined) {
				path[path.length] = frame.second
				segments += 1
			}
			if (frame.depth > COMPILE_DEPTH_LIMIT) {
				throw new ContractError('validateShapeDepth: a shape exceeds the compilation depth limit', {
					code: 'depth',
					context: { path: pathOf(path), limit: COMPILE_DEPTH_LIMIT },
				})
			}
			const index = frame.index
			const capture = index === undefined ? undefined : this.#captures[index]
			if (index === undefined || capture === undefined) {
				path.length -= segments
				continue
			}
			if (matchesVisited(active, capture.shape)) {
				const blocker = order[index] ?? 0
				if (blocker < oldest) oldest = blocker
				path.length -= segments
				continue
			}
			const recorded = settled[index]
			if (recorded !== undefined && frame.depth <= recorded) {
				path.length -= segments
				continue
			}
			admitVisited(active, capture.shape)
			order[index] = clock
			clock += 1
			stack[stack.length] = {
				operation: 'exit',
				index,
				depth: frame.depth,
				segments,
				outer: oldest,
			}
			oldest = clock
			for (let edge = capture.children.length - 1; edge >= 0; edge -= 1) {
				const child = capture.children[edge]
				if (child === undefined) continue
				stack[stack.length] = {
					operation: 'enter',
					index: this.#locate(child.shape),
					depth: frame.depth + 1,
					first: child.first,
					...(child.second === undefined ? {} : { second: child.second }),
				}
			}
		}
	}

	#finish(): void {
		if (this.#structure !== undefined) throw this.#structure
		if (this.#cycle !== undefined) throw this.#cycle
		if (this.#domain !== undefined) throw this.#domain
	}

	#refuse(message: string, first?: string, second?: string): false {
		if (this.#structure === undefined) {
			const path = pathOf(this.#path, first, second)
			this.#structure = new ContractError(message, {
				code: 'structure',
				context: { path },
			})
		}
		return false
	}

	static {
		// Pinned while this class is DEFINED: `ShapeCloner`'s `#validateShape` and
		// `validateShapeDepth` reach it through `ShapeValidator.prototype.validate`,
		// so an assignment there decides whether a shape gate the caller never
		// touched ever runs.
		pinMembers(ShapeValidator.prototype, 'ShapeValidator')
	}
}
