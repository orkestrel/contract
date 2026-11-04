import type { ContractShape } from './types.js'
import { CLONE_NODE_LIMIT, COMPILE_DEPTH_LIMIT, INTRINSICS, SHAPE_FIELDS } from './constants.js'
import { ContractError, isContractError } from './errors.js'
import {
	readIndexView,
	admitMember,
	admitVisited,
	appendEntries,
	attempt,
	iterateIndices,
	collectMembers,
	holds,
	isFailure,
	isSuccess,
	matchesMember,
	matchesJSONValue,
	matchesVisited,
	omitVisited,
	pathOf,
	readArrayEntries,
	readPatternFlags,
	readPatternSource,
} from './helpers.js'
import { isJSONValue, isLiteralValue, isRecord, isRegExp } from './validators.js'

/** Owns the traversal and reentry poison of one validation call. */
export class ShapePass {
	static readonly #weakSet = WeakSet
	static readonly #weakMap = WeakMap
	static readonly #arrays = Array.prototype
	static readonly #pop = Array.prototype.pop
	static readonly #iterators = INTRINSICS.prototype(
		INTRINSICS.reflect.apply(INTRINSICS.indices, [], []),
	)
	static readonly #blank = INTRINSICS.freeze(new INTRINSICS.pattern(''))
	// Every field a node may leave out, so every read an inherited value could answer.
	// A sealed node's own fields cannot change, but a walk of one still refuses a
	// polluted `Object.prototype`, because a field the node does not hold reads through
	// to it. A required field is own on every node that recognizes it.
	static readonly #fields = [
		'min',
		'max',
		'pattern',
		'description',
		'integer',
		'additionalProperties',
		'mode',
		'default',
	]
	// What a walk of a builder's node found, kept so a later builder or compiler need
	// not walk it again. Building a declaration walked every subtree once per ancestor,
	// which is quadratic in depth, and compiling it cloned the graph and walked it twice
	// more. Only `#survey` writes here, and only for a frozen node this package made
	// whose children are all sealed, so a mutable node, a node frozen by a caller, and a
	// node with an accessor are never recorded and take the whole walk. `reach` is the
	// deepest level the subtree occupies, a raw node's embedded schema included, `count`
	// is the expansion, `defaulted` is a default on this node, and `held` is one
	// anywhere in the subtree.
	static readonly #seals = new ShapePass.#weakMap<
		ContractShape,
		{
			readonly category: ContractShape['category']
			readonly reach: number
			readonly count: number
			readonly defaulted: boolean
			readonly held: boolean
		}
	>()
	readonly #source: unknown
	readonly #budget: { left: number } | undefined
	#stack: Array<
		| {
				readonly operation: 'enter'
				readonly shape: unknown
				readonly depth: number
				readonly optional: boolean
				readonly first?: string
				readonly second?: string
		  }
		| { readonly operation: 'exit'; readonly index: number; readonly segments: number }
	> = []
	#path: string[] = []
	#active = new ShapePass.#weakSet<object>()
	// The capture. Discovery observes each unique node ONCE — descriptors, two
	// stable reads, scalar evidence and ordered outgoing edges — and every later
	// incoming edge is answered from here instead of from the caller's source.
	// Re-observing per incoming edge cost one whole observation per DISTINCT depth
	// a node was reached at, so an object holding one leaf at sixteen nesting
	// levels read that leaf sixteen times, and the subtree under it was re-walked
	// with it. `raw` is the height of a raw node's embedded schema, `0` for every
	// other node.
	#index = new ShapePass.#weakMap<object, number>()
	#captures: Array<{
		readonly shape: object
		readonly category: unknown
		readonly children: ReadonlyArray<{
			readonly shape: unknown
			readonly optional: boolean
			readonly first: string
			readonly second?: string
		}>
		readonly raw: number
		readonly defaulted: boolean
		readonly open: boolean
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
	// The edge that first put a node below a union, so a default's refusal can spell
	// the route through that union rather than the node's deepest one.
	#within: Array<{ readonly parent: number; readonly first: string; readonly second?: string }> = []
	// One node per node per incoming edge: the size of the TREE a compiler would
	// build from this DAG, which is what actually bounds compilation.
	#counts: number[] = []
	#schemas = new ShapePass.#weakMap<object, number>()
	#children: Array<{
		readonly shape: unknown
		readonly optional: boolean
		readonly first: string
		readonly second?: string
	}> = []
	#category: unknown
	#raw = 0
	#defaulted = false
	#open = false
	#structure: ContractError | undefined
	#cycle: ContractError | undefined
	#domain: ContractError | undefined

	#poison: ContractError | undefined

	constructor(shape: unknown, budget?: { left: number }) {
		this.#source = shape
		this.#budget = budget
	}

	/**
	 * Validates a node fresh from a builder, freezes it, and records what the walk found.
	 *
	 * @remarks
	 * The node's own fields are always observed, and each child is answered from its
	 * seal rather than walked. Anything short of a clean answer takes the whole walk
	 * instead, which is what authors every refusal, so a refusal reads the same and
	 * fires at the same call as it would with no seals at all. That second look is safe
	 * because the first read nothing a caller wrote: the node is this package's own
	 * literal, and a child with no seal stops the survey before it is read.
	 *
	 * @param shape - The builder's fresh node, which no caller has seen
	 * @param check - What the whole walk validates, when the node is only legal in a slot
	 * @returns The frozen node
	 * @throws {ContractError} When the node is refused
	 */
	static seal<S extends ContractShape>(shape: S, check: ContractShape = shape): Readonly<S> {
		const frozen = INTRINSICS.freeze(shape)
		if (!new ShapePass(shape).#survey(check === shape ? 0 : 1)) {
			new ShapePass(check, { left: CLONE_NODE_LIMIT }).validate()
		}
		return frozen
	}

	/**
	 * Reports the expansion of a sealed node a compiler can take as it stands.
	 *
	 * @remarks
	 * `undefined` sends the caller to its own ownership and validation: the node was
	 * never sealed, an inherited field would answer a walk of it, or it is an `optional`
	 * node, which a walk refuses as a root.
	 *
	 * @param shape - The declaration to look up
	 * @returns The expansion a walk would report, or `undefined`
	 */
	static expansionOf(shape: ContractShape): number | undefined {
		if (ShapePass.polluted()) return undefined
		const seal = INTRINSICS.reflect.apply(INTRINSICS.recall, ShapePass.#seals, [shape])
		return seal === undefined || seal.category === 'optional' ? undefined : seal.count
	}

	/**
	 * Reports whether a walk could answer differently from a seal.
	 *
	 * @remarks
	 * A field a node may leave out reads through to `Object.prototype`, which is a
	 * verdict about the declaration, and a {@link tampered} host breaks a walk into a
	 * refusal a seal would otherwise skip.
	 *
	 * @returns True when a walk has to answer rather than a seal
	 */
	static polluted(): boolean {
		if (ShapePass.tampered()) return true
		return INTRINSICS.reflect.apply(INTRINSICS.some, ShapePass.#fields, [
			(field: string) => INTRINSICS.own(INTRINSICS.base, field),
		])
	}

	/**
	 * Reports whether a member a walk or a compile runs on has been replaced.
	 *
	 * @remarks
	 * An index on either prototype, reached by array writes, a replaced `pop` or array
	 * iterator `next`, and a flag getter a pattern's `flags` reads. An array's `length`
	 * always passes its highest index, and own keys list an index first, so one read
	 * answers for every index, and a name that merely opens with a digit only costs a walk.
	 *
	 * @returns True when the host is not the one this package loaded on
	 */
	static tampered(): boolean {
		if (ShapePass.#arrays.length !== 0) return true
		const first = INTRINSICS.reflect.members(INTRINSICS.base)[0]
		if (typeof first === 'string' && first >= '0' && first < ':') return true
		if (INTRINSICS.describe(ShapePass.#arrays, 'pop')?.value !== ShapePass.#pop) return true
		const next = INTRINSICS.describe(ShapePass.#iterators, 'next')?.value
		if (next !== INTRINSICS.advance) return true
		return !holds(() => readPatternFlags(ShapePass.#blank) === '')
	}

	/** Poisons this pass and throws the same refusal on every reentry. */
	interrupt(): never {
		this.#poison ??= new ContractError(
			'ShapeValidator.validate: shape validation may not be reentered',
			{ code: 'structure', context: { path: [] } },
		)
		throw this.#poison
	}

	/** Validates the captured source and returns its expansion. */
	validate(): number {
		const outcome = attempt(() => this.#execute())
		if (this.#poison !== undefined) throw this.#poison
		if (isSuccess(outcome)) return this.#counts[0] ?? 1
		if (isContractError(outcome.error)) throw outcome.error
		throw new ContractError('validateShape: shape reflection failed', {
			code: 'structure',
			context: { path: [] },
			cause: outcome.error,
		})
	}

	// One observation of the node, and its children answered from their seals. Each
	// rule the walk asks across an edge is asked here too: optional placement in the
	// slot, a default below a union or beside an open object's extras, and depth. `lift`
	// is how far below the walk's root this node sits, which is one under the object an
	// optional node is validated inside. A false answer says nothing about the node
	// beyond that the walk has to decide.
	#survey(lift: number): boolean {
		if (ShapePass.polluted()) return false
		const shape = this.#source
		if (!isRecord(shape)) return false
		const outcome = attempt(() => this.#observe(shape, 0))
		if (isFailure(outcome) || !outcome.value || this.#domain !== undefined) return false
		const seal = {
			category: shape.category,
			reach: this.#raw,
			count: 1,
			defaulted: this.#defaulted,
			held: this.#defaulted,
		}
		for (const index of iterateIndices(() => this.#children.length)) {
			const child = this.#children[index]
			const known = INTRINSICS.reflect.apply(INTRINSICS.recall, ShapePass.#seals, [child?.shape])
			if (child === undefined || known === undefined) return false
			if (known.category === 'optional' && !child.optional) return false
			if (known.held && shape.category === 'union') return false
			if (known.defaulted && this.#open) return false
			seal.reach = INTRINSICS.max(seal.reach, known.reach + 1)
			seal.count += known.count
			seal.held ||= known.held
		}
		if (seal.reach + lift > COMPILE_DEPTH_LIMIT) return false
		INTRINSICS.reflect.apply(INTRINSICS.retain, ShapePass.#seals, [shape, seal])
		return true
	}

	#execute(): void {
		this.#stack[this.#stack.length] = {
			operation: 'enter',
			shape: this.#source,
			depth: 0,
			optional: false,
		}
		while (this.#stack.length > 0) this.#visit()
		this.#measure()
		this.#finish()
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

		const first = INTRINSICS.own(frame, 'first') ? frame.first : undefined
		const second = INTRINSICS.own(frame, 'second') ? frame.second : undefined
		const segments = (first === undefined ? 0 : 1) + (second === undefined ? 0 : 1)
		if (first !== undefined) {
			this.#path[this.#path.length] = first
		}
		if (second !== undefined) {
			this.#path[this.#path.length] = second
		}

		const current = frame.shape
		if (typeof current !== 'object' || current === null || !isRecord(current)) {
			this.#structure ??= new ContractError(
				'validateShape: every structural child must be a shape',
				{
					code: 'structure',
					context: { path: pathOf(this.#path) },
				},
			)
			this.#path.length -= segments
			return
		}
		if (matchesVisited(this.#active, current)) {
			this.#cycle ??= new ContractError('validateShape: a shape graph may not contain a cycle', {
				code: 'cycle',
				context: { path: pathOf(this.#path) },
			})
			this.#path.length -= segments
			return
		}

		// The refinement, and the whole reason discovery is separate from
		// measurement: a node already captured is not observed again. Every rule the
		// OBSERVATION enforces is a property of the node, so a second look at the
		// same node can only produce the same answer at a longer path. Optional
		// placement and depth are properties of the POSITION instead, and they are
		// answered in separate
		// places: where an `optional` node is legal is re-asked here, from the
		// capture, for every incoming edge, while depth — the shape's own and a raw
		// node's embedded schema alike — is measured over the whole captured graph in
		// `#measure`, which is why its diagnostics are spelled from the deepest
		// occurrence rather than from whichever edge discovery arrived on.
		const seen = INTRINSICS.reflect.apply(INTRINSICS.recall, this.#index, [current])
		if (seen !== undefined) {
			this.#place(seen, frame.optional)
			this.#path.length -= segments
			return
		}

		this.#children = []
		this.#category = undefined
		this.#raw = 0
		this.#defaulted = false
		this.#open = false
		const outcome = attempt(() => this.#observe(current, frame.depth))
		this.#spend(0)
		if (isFailure(outcome) || !outcome.value) {
			this.#structure ??= new ContractError(
				'validateShape: every node must be a recognized shape',
				{
					code: 'structure',
					context: { path: pathOf(this.#path) },
				},
			)
			// Captured as a childless leaf. Its subtree is not walked, and every later
			// edge to it measures its depth from the capture instead of re-running the
			// observation that already refused.
			this.#post[this.#post.length] = this.#capture(current, [])
			this.#path.length -= segments
			return
		}

		this.#place(this.#schedule(current, frame.depth, segments), frame.optional)
	}

	#observe(current: Record<string, unknown>, depth: number): boolean {
		const descriptor = INTRINSICS.describe(current, 'category')
		if (descriptor === undefined || !INTRINSICS.own(descriptor, 'value')) {
			return this.#refuse('validateShape: every node must be a recognized shape')
		}
		const category = current.category
		if (current.category !== category || descriptor.value !== category) {
			return this.#refuse('validateShape: every node must be a recognized shape')
		}
		const fields =
			typeof category === 'string' && INTRINSICS.own(SHAPE_FIELDS, category)
				? SHAPE_FIELDS[category]
				: undefined
		if (fields === undefined) {
			return this.#refuse('validateShape: every node must be a recognized shape')
		}
		this.#category = category
		if (!this.#scan(current, fields)) return false
		if (!this.#constrain(current)) return false
		if (category === 'raw') {
			const schema = current.schema
			const outcome = attempt(() => this.#inspect(schema))
			if (isFailure(outcome)) {
				return this.#refuse('validateShape: every node must be a recognized shape', 'schema')
			}
			if (!outcome.value) return false
			// The embedded schema's own nesting is measured once per unique record
			// and applied at THIS node's depth, so a schema shared by two raw nodes
			// is validated once and still refuses at whichever node is too deep for
			// it. The deeper-occurrence case is re-asked in `#measure`.
			if (depth + this.#raw > COMPILE_DEPTH_LIMIT) {
				return this.#refuse(
					'validateShape: raw schema exceeds the compilation depth limit',
					'schema',
				)
			}
		}
		if (category === 'object') {
			const outcome = attempt(() => this.#populate(current))
			if (isFailure(outcome)) {
				return this.#refuse('validateShape: every node must be a recognized shape', 'properties')
			}
			return outcome.value
		}
		if (category === 'union') {
			const outcome = attempt(() => this.#populate(current))
			if (isFailure(outcome)) {
				return this.#refuse('validateShape: every node must be a recognized shape', 'variants')
			}
			return outcome.value
		}
		if (category === 'literal') {
			const outcome = attempt(() => this.#populate(current))
			if (isFailure(outcome)) {
				return this.#refuse('validateShape: every node must be a recognized shape', 'values')
			}
			return outcome.value
		}
		return this.#populate(current)
	}

	#scan(current: Record<string, unknown>, fields: readonly string[]): boolean {
		for (const fieldIndex of iterateIndices(() => fields.length)) {
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
				const first: unknown = INTRINSICS.reflect.read(current, field)
				const second: unknown = INTRINSICS.reflect.read(current, field)
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
			if (isFailure(outcome) || !outcome.value) {
				return this.#refuse('validateShape: every node must be a recognized shape', field)
			}
		}
		return true
	}

	#constrain(current: Record<string, unknown>): boolean {
		if (
			current.category !== 'optional' &&
			current.category !== 'nullable' &&
			current.category !== 'raw' &&
			current.description !== undefined &&
			typeof current.description !== 'string'
		) {
			return this.#refuse('validateShape: description must be a string', 'description')
		}
		if (current.category === 'optional' && INTRINSICS.own(current, 'default')) {
			if (!holds(() => matchesJSONValue(current.default, new ShapePass.#weakSet(), this.#budget))) {
				return this.#refuse('validateShape: an optional default must be a JSON value', 'default')
			}
			this.#defaulted = true
		}
		if (current.category === 'string') {
			if (current.min !== undefined && typeof current.min !== 'number') {
				return this.#refuse('validateShape: string min must be a number', 'min')
			}
			if (current.max !== undefined && typeof current.max !== 'number') {
				return this.#refuse('validateShape: string max must be a number', 'max')
			}
			if (current.pattern !== undefined) {
				const pattern = current.pattern
				if (!isRegExp(pattern)) {
					return this.#refuse('validateShape: string pattern must be a RegExp', 'pattern')
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
					return this.#refuse('validateShape: string pattern must be stable', 'pattern')
				}
				this.#restrict(current, source, flags)
			} else {
				this.#restrict(current)
			}
		}
		if (current.category === 'number') {
			if (current.min !== undefined && typeof current.min !== 'number') {
				return this.#refuse('validateShape: number min must be a number', 'min')
			}
			if (current.max !== undefined && typeof current.max !== 'number') {
				return this.#refuse('validateShape: number max must be a number', 'max')
			}
			if (current.integer !== undefined && typeof current.integer !== 'boolean') {
				return this.#refuse('validateShape: number integer must be a boolean', 'integer')
			}
			const shape = current.integer === true ? 'integer' : 'number'
			if (
				this.#domain === undefined &&
				current.min !== undefined &&
				!INTRINSICS.finite(current.min)
			) {
				this.#domain = new ContractError('validateShape: a number shape min must be finite', {
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
				this.#domain = new ContractError('validateShape: a number shape max must be finite', {
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
				typeof current.min === 'number' &&
				typeof current.max === 'number' &&
				current.min > current.max
			) {
				this.#domain = new ContractError('validateShape: a number shape has min greater than max', {
					code: 'range',
					context: { path: pathOf(this.#path), shape },
				})
			}
			if (this.#domain === undefined && current.integer === true) {
				const lo = INTRINSICS.ceil(current.min ?? Number.NEGATIVE_INFINITY)
				const hi = INTRINSICS.floor(current.max ?? Number.POSITIVE_INFINITY)
				if (lo > hi) {
					this.#domain = new ContractError(
						'validateShape: an integer number shape has an empty integer range',
						{
							code: 'range',
							context: { path: pathOf(this.#path), shape: 'integer' },
						},
					)
				}
			}
		}
		if (
			current.category === 'array' &&
			current.min !== undefined &&
			typeof current.min !== 'number'
		) {
			return this.#refuse('validateShape: array min must be a number', 'min')
		}
		if (
			current.category === 'array' &&
			current.max !== undefined &&
			typeof current.max !== 'number'
		) {
			return this.#refuse('validateShape: array max must be a number', 'max')
		}
		if (
			current.category === 'array' &&
			this.#domain === undefined &&
			current.min !== undefined &&
			(typeof current.min !== 'number' || !INTRINSICS.safe(current.min) || current.min < 0)
		) {
			this.#domain = new ContractError(
				'validateShape: an array shape min must be a non-negative safe integer',
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
			current.category === 'array' &&
			this.#domain === undefined &&
			current.max !== undefined &&
			(typeof current.max !== 'number' || !INTRINSICS.safe(current.max) || current.max < 0)
		) {
			this.#domain = new ContractError(
				'validateShape: an array shape max must be a non-negative safe integer',
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
			current.category === 'array' &&
			this.#domain === undefined &&
			current.min !== undefined &&
			current.max !== undefined &&
			typeof current.min === 'number' &&
			typeof current.max === 'number' &&
			current.min > current.max
		) {
			this.#domain = new ContractError('validateShape: an array shape has min greater than max', {
				code: 'range',
				context: { path: pathOf(this.#path), shape: 'array' },
			})
		}
		if (
			current.category === 'union' &&
			current.mode !== undefined &&
			current.mode !== 'anyOf' &&
			current.mode !== 'oneOf'
		) {
			return this.#refuse('validateShape: union mode must be anyOf or oneOf', 'mode')
		}
		return true
	}

	// Where an `optional` node is legal depends on the SLOT it arrived through, not
	// on the node, so this is the one rule discovery asks per incoming edge rather
	// than once per node. It reads the captured category instead of the source: a
	// second read of `category` would be a second observation of a node already
	// observed, and an unrecognized node has no category to answer with.
	#place(index: number, optional: boolean): void {
		if (optional || this.#domain !== undefined) return
		if (this.#captures[index]?.category !== 'optional') return
		this.#domain = new ContractError(
			'validateShape: an optional shape may only appear as a direct object-property value',
			{
				code: 'placement',
				context: { path: pathOf(this.#path), shape: 'optional' },
			},
		)
	}

	#restrict(current: Record<string, unknown>, source = '', flags = ''): void {
		if (
			this.#domain === undefined &&
			current.min !== undefined &&
			(typeof current.min !== 'number' || !INTRINSICS.safe(current.min) || current.min < 0)
		) {
			this.#domain = new ContractError(
				'validateShape: a string shape min must be a non-negative safe integer',
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
			(typeof current.max !== 'number' || !INTRINSICS.safe(current.max) || current.max < 0)
		) {
			this.#domain = new ContractError(
				'validateShape: a string shape max must be a non-negative safe integer',
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
				'validateShape: a string shape pattern must not use flags; use inline pattern constructs instead',
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
			typeof current.min === 'number' &&
			typeof current.max === 'number' &&
			current.min > current.max
		) {
			this.#domain = new ContractError('validateShape: a string shape has min greater than max', {
				code: 'range',
				context: { path: pathOf(this.#path), shape: 'string' },
			})
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
		if (this.#structure !== undefined) return true
		if (!isRecord(source)) {
			return this.#refuse('validateShape: raw schema must be a plain record', 'schema')
		}
		const active = new ShapePass.#weakSet<object>()
		const stack: Array<
			| {
					readonly operation: 'enter'
					readonly schema: unknown
					readonly first?: string
					readonly second?: string
			  }
			| {
					readonly operation: 'exit'
					readonly schema: object
					readonly nested: readonly unknown[]
					readonly first?: string
					readonly second?: string
			  }
		> = [{ operation: 'enter', schema: source }]

		while (stack.length > 0) {
			const frame = stack.pop()
			if (frame === undefined) continue
			if (frame.operation === 'exit') {
				omitVisited(active, frame.schema)
				this.#settleSchema(frame.schema, frame.nested)
				continue
			}
			const first = INTRINSICS.own(frame, 'first') ? frame.first : undefined
			const second = INTRINSICS.own(frame, 'second') ? frame.second : undefined
			const schema = frame.schema
			if (!isRecord(schema)) {
				return this.#refuseSchema(
					'validateShape: every raw schema child must be a plain record',
					stack,
					first,
					second,
					undefined,
				)
			}
			if (matchesVisited(active, schema)) {
				return this.#refuseSchema(
					'validateShape: a raw schema may not contain a cycle',
					stack,
					first,
					second,
					undefined,
				)
			}
			if (INTRINSICS.reflect.apply(INTRINSICS.recall, this.#schemas, [schema]) !== undefined)
				continue
			admitVisited(active, schema)

			const keyList = INTRINSICS.keys(schema)
			for (const keyIndex of iterateIndices(() => keyList.length)) {
				const key = keyList[keyIndex]
				if (key === undefined) continue
				if (
					key !== 'type' &&
					key !== 'description' &&
					key !== 'default' &&
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
					return this.#refuseSchema(
						'validateShape: raw schema contains an unsupported keyword',
						stack,
						first,
						second,
						key,
					)
				}
			}

			const category = INTRINSICS.own(schema, 'type') ? schema.type : undefined
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
				return this.#refuseSchema(
					'validateShape: raw schema type is outside the supported vocabulary',
					stack,
					first,
					second,
					'type',
				)
			}
			if (
				INTRINSICS.own(schema, 'description') &&
				schema.description !== undefined &&
				typeof schema.description !== 'string'
			) {
				return this.#refuseSchema(
					'validateShape: raw schema description must be a string',
					stack,
					first,
					second,
					'description',
				)
			}
			if (INTRINSICS.own(schema, 'default') && !isJSONValue(schema.default)) {
				return this.#refuseSchema(
					'validateShape: raw schema default must be a JSON value',
					stack,
					first,
					second,
					'default',
				)
			}
			if (
				INTRINSICS.own(schema, 'format') &&
				schema.format !== undefined &&
				typeof schema.format !== 'string'
			) {
				return this.#refuseSchema(
					'validateShape: raw schema format must be a string',
					stack,
					first,
					second,
					'format',
				)
			}
			if (INTRINSICS.own(schema, 'pattern') && schema.pattern !== undefined) {
				if (typeof schema.pattern !== 'string') {
					return this.#refuseSchema(
						'validateShape: raw schema pattern must be a string',
						stack,
						first,
						second,
						'pattern',
					)
				}
				// The CAPTURED `RegExp`, not the live global: the result of this read is
				// the refusal `rawShape` documents, and a caller who installed a
				// non-throwing stub made a malformed pattern compile clean.
				const pattern = attempt(() =>
					INTRINSICS.reflect.apply(INTRINSICS.pattern, undefined, [schema.pattern]),
				)
				if (isFailure(pattern)) {
					return this.#refuseSchema(
						'validateShape: raw schema pattern must be valid',
						stack,
						first,
						second,
						'pattern',
					)
				}
			}

			const lengthList = ['minLength', 'maxLength', 'minItems', 'maxItems']
			for (const lengthIndex of iterateIndices(() => lengthList.length)) {
				const key = lengthList[lengthIndex]
				if (key === undefined) continue
				const value = INTRINSICS.own(schema, key) ? schema[key] : undefined
				if (value !== undefined && (!INTRINSICS.safe(value) || INTRINSICS.numeric(value) < 0)) {
					return this.#refuseSchema(
						'validateShape: raw schema length bounds must be non-negative safe integers',
						stack,
						first,
						second,
						key,
					)
				}
			}
			const rangeList = ['minimum', 'maximum']
			for (const rangeIndex of iterateIndices(() => rangeList.length)) {
				const key = rangeList[rangeIndex]
				if (key === undefined) continue
				const value = INTRINSICS.own(schema, key) ? schema[key] : undefined
				if (value !== undefined && (typeof value !== 'number' || !INTRINSICS.finite(value))) {
					return this.#refuseSchema(
						'validateShape: raw schema numeric bounds must be finite numbers',
						stack,
						first,
						second,
						key,
					)
				}
			}
			const population = INTRINSICS.own(schema, 'enum') ? schema.enum : undefined
			if (population !== undefined) {
				if (!INTRINSICS.array(population)) {
					return this.#refuseSchema(
						'validateShape: raw schema enum must be a non-empty array',
						stack,
						first,
						second,
						'enum',
					)
				}
				const snapshot = readArrayEntries(population)
				if (isFailure(snapshot) || snapshot.value.entries.length === 0) {
					return this.#refuseSchema(
						'validateShape: raw schema enum must be a non-empty array',
						stack,
						first,
						second,
						'enum',
					)
				}
				if (!snapshot.value.dense) {
					return this.#refuseSchema(
						'validateShape: raw schema enum must be dense',
						stack,
						first,
						second,
						'enum',
					)
				}
				// A module-scope membership question, not `set.has(value)`: this
				// uniqueness test decides whether the door accepts or refuses, so
				// `Set.prototype.has = () => false` would admit a duplicate vocabulary
				// the shape gate exists to reject.
				const values = collectMembers([])
				for (const valueIndex of iterateIndices(() => snapshot.value.entries.length)) {
					// A present member whose captured value is `undefined` is refused by
					// the literal test below rather than skipped.
					const value = snapshot.value.entries[valueIndex]
					if (
						!isLiteralValue(value) ||
						(typeof value === 'number' && !INTRINSICS.finite(value)) ||
						matchesMember(values, value)
					) {
						return this.#refuseSchema(
							'validateShape: raw schema enum values must be finite unique primitives',
							stack,
							first,
							second,
							'enum',
							INTRINSICS.text(valueIndex),
						)
					}
					admitMember(values, value)
				}
			}

			const names = INTRINSICS.own(schema, 'required') ? schema.required : undefined
			if (names !== undefined) {
				if (!INTRINSICS.array(names)) {
					return this.#refuseSchema(
						'validateShape: raw schema required must be an array',
						stack,
						first,
						second,
						'required',
					)
				}
				const snapshot = readArrayEntries(names)
				if (isFailure(snapshot)) {
					return this.#refuseSchema(
						'validateShape: raw schema required must be an array',
						stack,
						first,
						second,
						'required',
					)
				}
				if (!snapshot.value.dense) {
					return this.#refuseSchema(
						'validateShape: raw schema required must be dense',
						stack,
						first,
						second,
						'required',
					)
				}
				const required = collectMembers([])
				for (const valueIndex of iterateIndices(() => snapshot.value.entries.length)) {
					const value = snapshot.value.entries[valueIndex]
					if (value === undefined) continue
					if (typeof value !== 'string' || matchesMember(required, value)) {
						return this.#refuseSchema(
							'validateShape: raw schema required values must be unique strings',
							stack,
							first,
							second,
							'required',
							INTRINSICS.text(valueIndex),
						)
					}
					admitMember(required, value)
				}
			}

			const nested: unknown[] = []
			const edges: Array<readonly [string, string?]> = []
			if (INTRINSICS.own(schema, 'items') && schema.items !== undefined) {
				edges[nested.length] = ['items']
				nested[nested.length] = schema.items
			}
			if (INTRINSICS.own(schema, 'properties') && schema.properties !== undefined) {
				if (!isRecord(schema.properties)) {
					return this.#refuseSchema(
						'validateShape: raw schema properties must be a plain record',
						stack,
						first,
						second,
						'properties',
					)
				}
				const propertyList = INTRINSICS.keys(schema.properties)
				for (const propertyIndex of iterateIndices(() => propertyList.length)) {
					const key = propertyList[propertyIndex]
					if (key === undefined) continue
					edges[nested.length] = ['properties', key]
					nested[nested.length] = INTRINSICS.own(schema.properties, key)
						? schema.properties[key]
						: undefined
				}
			}
			if (
				INTRINSICS.own(schema, 'additionalProperties') &&
				schema.additionalProperties !== undefined &&
				schema.additionalProperties !== true &&
				schema.additionalProperties !== false
			) {
				edges[nested.length] = ['additionalProperties']
				nested[nested.length] = schema.additionalProperties
			}
			const unionList = ['anyOf', 'oneOf']
			for (const unionIndex of iterateIndices(() => unionList.length)) {
				const key = unionList[unionIndex]
				if (key === undefined) continue
				const variants = INTRINSICS.own(schema, key) ? schema[key] : undefined
				if (variants === undefined) continue
				if (!INTRINSICS.array(variants)) {
					return this.#refuseSchema(
						'validateShape: raw schema unions must be non-empty arrays',
						stack,
						first,
						second,
						key,
					)
				}
				const snapshot = readArrayEntries(variants)
				if (isFailure(snapshot) || snapshot.value.entries.length === 0) {
					return this.#refuseSchema(
						'validateShape: raw schema unions must be non-empty arrays',
						stack,
						first,
						second,
						key,
					)
				}
				if (!snapshot.value.dense) {
					return this.#refuseSchema(
						'validateShape: raw schema unions must be dense arrays',
						stack,
						first,
						second,
						key,
					)
				}
				for (const variantIndex of iterateIndices(() => snapshot.value.entries.length)) {
					// A present member whose captured value is `undefined` is still a
					// present member, so it is scheduled and refused as a nonrecord
					// rather than skipped.
					edges[nested.length] = [key, INTRINSICS.text(variantIndex)]
					nested[nested.length] = snapshot.value.entries[variantIndex]
				}
			}
			stack[stack.length] = {
				operation: 'exit',
				schema,
				nested,
				...(first === undefined ? {} : { first: first }),
				...(second === undefined ? {} : { second: second }),
			}
			for (const offset of iterateIndices(() => nested.length)) {
				const index = nested.length - 1 - offset
				const childFirst = edges[index]?.[0]
				const edge = edges[index]
				const childSecond = edge !== undefined && INTRINSICS.own(edge, 1) ? edge[1] : undefined
				stack[stack.length] = {
					operation: 'enter',
					schema: nested[index],
					...(childFirst === undefined ? {} : { first: childFirst }),
					...(childSecond === undefined ? {} : { second: childSecond }),
				}
			}
		}
		this.#raw = INTRINSICS.reflect.apply(INTRINSICS.recall, this.#schemas, [source]) ?? 0
		return true
	}

	// One raw-schema record's height, recorded as its walk finishes. Every nested
	// record has already finished, so its own height is in the memo.
	#settleSchema(schema: object, nested: readonly unknown[]): void {
		const height: number = INTRINSICS.reflect.apply(INTRINSICS.fold, nested, [
			(highest: number, child: unknown) => {
				const recorded =
					typeof child !== 'object' || child === null
						? 0
						: (INTRINSICS.reflect.apply(INTRINSICS.recall, this.#schemas, [child]) ?? 0)
				return INTRINSICS.max(highest, recorded + 1)
			},
			0,
		])
		INTRINSICS.reflect.apply(INTRINSICS.retain, this.#schemas, [schema, height])
	}

	#populate(current: Record<string, unknown>): boolean {
		switch (current.category) {
			case 'array':
				this.#spend(1)
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
						'validateShape: properties must be a plain property map',
						'properties',
					)
				}
				const keys = INTRINSICS.keys(properties)
				for (const keyIndex of iterateIndices(() => keys.length)) {
					const key = keys[keyIndex]
					if (key === undefined) continue
					this.#spend(1)
					const descriptorOutcome = attempt(() => INTRINSICS.describe(properties, key))
					if (isFailure(descriptorOutcome)) {
						return this.#refuse(
							'validateShape: every node must be a recognized shape',
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
					const childOutcome = attempt(() => {
						const population = current.properties
						return isRecord(population) ? population[key] : undefined
					})
					if (isFailure(childOutcome)) {
						return this.#refuse(
							'validateShape: every node must be a recognized shape',
							'properties',
							key,
						)
					}
					const child = childOutcome.value
					const stable = attempt(() => {
						const population = current.properties
						return (
							isRecord(population) &&
							INTRINSICS.same(population[key], child) &&
							INTRINSICS.same(descriptor.value, child)
						)
					})
					if (isFailure(stable)) {
						return this.#refuse(
							'validateShape: every node must be a recognized shape',
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
				this.#open = extra !== undefined && extra !== false
				if (extra !== undefined && extra !== true && extra !== false) {
					this.#spend(1)
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
					return this.#refuse('validateShape: variants must be a finite array', 'variants')
				}
				const snapshot = readArrayEntries(current.variants)
				if (isFailure(snapshot)) {
					return this.#refuse('validateShape: variants must be a finite array', 'variants')
				}
				if (!snapshot.value.dense) {
					return this.#refuse('validateShape: variants must be a dense data array', 'variants')
				}
				const variants = snapshot.value.entries
				const length = variants.length
				if (this.#domain === undefined && length === 0) {
					this.#domain = new ContractError(
						'validateShape: a union shape needs at least one variant',
						{
							code: 'empty',
							context: { path: pathOf(this.#path), shape: 'union' },
						},
					)
				}
				for (const index of iterateIndices(() => length)) {
					const key = INTRINSICS.text(index)
					this.#spend(1)
					const descriptorOutcome = attempt(() => INTRINSICS.describe(current.variants, key))
					if (isFailure(descriptorOutcome)) {
						return this.#refuse(
							'validateShape: every node must be a recognized shape',
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
					const stable = attempt(() => {
						const population = current.variants
						return (
							INTRINSICS.array(population) &&
							INTRINSICS.same(population[index], variant) &&
							INTRINSICS.same(descriptor.value, variant)
						)
					})
					if (isFailure(stable)) {
						return this.#refuse(
							'validateShape: every node must be a recognized shape',
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
					return this.#refuse('validateShape: values must be a finite literal array', 'values')
				}
				const snapshot = readArrayEntries(current.values)
				if (isFailure(snapshot)) {
					return this.#refuse('validateShape: values must be a finite literal array', 'values')
				}
				if (!snapshot.value.dense) {
					return this.#refuse('validateShape: values must be a dense data array', 'values')
				}
				const literals = snapshot.value.entries
				const length = literals.length
				if (this.#domain === undefined && length === 0) {
					this.#domain = new ContractError(
						'validateShape: a literal shape needs at least one value',
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
				for (const index of iterateIndices(() => length)) {
					const key = INTRINSICS.text(index)
					const descriptorOutcome = attempt(() => INTRINSICS.describe(current.values, key))
					if (isFailure(descriptorOutcome)) {
						return this.#refuse(
							'validateShape: every node must be a recognized shape',
							'values',
							key,
						)
					}
					const descriptor = descriptorOutcome.value
					if (descriptor === undefined || !INTRINSICS.own(descriptor, 'value')) {
						return this.#refuse('validateShape: values must be a dense data array', 'values', key)
					}
					const value = literals[index]
					const stable = attempt(() => {
						const population = current.values
						return (
							INTRINSICS.array(population) &&
							INTRINSICS.same(population[index], value) &&
							INTRINSICS.same(descriptor.value, value)
						)
					})
					if (isFailure(stable)) {
						return this.#refuse(
							'validateShape: every node must be a recognized shape',
							'values',
							key,
						)
					}
					if (!stable.value) {
						return this.#refuse('validateShape: values must be a stable data array', 'values', key)
					}
					if (!isLiteralValue(value)) {
						return this.#refuse(
							'validateShape: every literal value must be a string, number, or boolean',
							'values',
							key,
						)
					}
					if (matchesMember(values, value)) {
						return this.#refuse('validateShape: literal values must be unique', 'values', key)
					}
					admitMember(values, value)
					if (
						this.#domain === undefined &&
						typeof value === 'number' &&
						!INTRINSICS.finite(value)
					) {
						this.#domain = new ContractError(
							'validateShape: a literal shape may not contain non-finite number values',
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
				this.#spend(1)
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
			case 'shape':
			case 'raw':
				break
		}
		return true
	}

	#spend(count: number): void {
		const budget = this.#budget
		if (budget === undefined) return
		budget.left -= count
		if (budget.left < 0) {
			throw new ContractError(`validateShape: capture exceeds the node limit ${CLONE_NODE_LIMIT}`, {
				code: 'clone',
				context: { path: pathOf(this.#path), limit: CLONE_NODE_LIMIT },
			})
		}
	}

	#schedule(current: object, depth: number, segments: number): number {
		admitVisited(this.#active, current)
		const children: ReadonlyArray<{
			readonly shape: unknown
			readonly optional: boolean
			readonly first: string
			readonly second?: string
		}> = INTRINSICS.reflect.apply(INTRINSICS.select, readIndexView(this.#children), [
			(child: unknown) => child !== undefined,
		])
		const captured = this.#capture(current, children)
		this.#stack[this.#stack.length] = { operation: 'exit', index: captured, segments }
		for (const offset of iterateIndices(() => children.length)) {
			const index = children.length - 1 - offset
			const child = children[index]
			if (child === undefined) continue
			this.#stack[this.#stack.length] = {
				operation: 'enter',
				shape: child.shape,
				depth: depth + 1,
				optional: child.optional,
				first: child.first,
				...(INTRINSICS.own(child, 'second') && child.second !== undefined
					? { second: child.second }
					: {}),
			}
		}
		return captured
	}

	#capture(
		shape: object,
		children: ReadonlyArray<{
			readonly shape: unknown
			readonly optional: boolean
			readonly first: string
			readonly second?: string
		}>,
	): number {
		const index = this.#captures.length
		this.#captures[index] = {
			shape,
			category: this.#category,
			children,
			raw: this.#raw,
			defaulted: this.#defaulted,
			open: this.#open,
		}
		INTRINSICS.reflect.apply(INTRINSICS.retain, this.#index, [shape, index])
		return index
	}

	#locate(shape: unknown): number | undefined {
		if (typeof shape !== 'object' || shape === null) return undefined
		return INTRINSICS.reflect.apply(INTRINSICS.recall, this.#index, [shape])
	}

	// Everything a second walk would answer, answered from the capture instead.
	// Reading the discovery
	// postorder forwards gives every bottom-up fact — subtree height and emitted
	// expansion — and reading it backwards gives the top-down one, the deepest
	// position each node occupies. Both are one pass over the captured nodes and
	// edges, which is what makes a shared-child declaration cost its DECLARATION
	// rather than its paths.
	#measure(): void {
		// Capture has already decided cycles in linear time. Only a DAG has a depth.
		if (this.#cycle !== undefined) {
			this.#finish()
			return
		}
		for (const index of iterateIndices(() => this.#captures.length)) {
			this.#height[index] = 0
			this.#reach[index] = 0
			this.#counts[index] = 1
		}
		for (const step of iterateIndices(() => this.#post.length)) {
			const index = this.#post[step]
			if (index === undefined) continue
			const capture = this.#captures[index]
			if (capture === undefined) continue
			const totals: { readonly height: number; readonly count: number } = INTRINSICS.reflect.apply(
				INTRINSICS.fold,
				capture.children,
				[
					(
						current: { readonly height: number; readonly count: number },
						child: (typeof capture.children)[number],
					) => {
						const located = this.#locate(child.shape)
						const reached = located === undefined ? 0 : (this.#height[located] ?? 0)
						return {
							height: INTRINSICS.max(current.height, reached + 1),
							count: current.count + (located === undefined ? 1 : (this.#counts[located] ?? 1)),
						}
					},
					{ height: 0, count: 1 },
				],
			)
			this.#height[index] = totals.height
			this.#counts[index] = totals.count
		}
		if ((this.#height[0] ?? 0) > COMPILE_DEPTH_LIMIT) this.#witness(0, 0, [])
		// Reverse postorder is a topological order, so a node's own deepest position
		// is final before its edges are read. Recording the edge that raised it
		// leaves a parent chain from any node back to the root, each link one level
		// shallower than the last.
		for (const offset of iterateIndices(() => this.#post.length)) {
			const step = this.#post.length - 1 - offset
			const index = this.#post[step]
			if (index === undefined) continue
			const capture = this.#captures[index]
			if (capture === undefined) continue
			const base = this.#reach[index] ?? 0
			for (const edge of iterateIndices(() => capture.children.length)) {
				const child = capture.children[edge]
				if (child === undefined) continue
				const located = this.#locate(child.shape)
				if (located === undefined) continue
				if ((this.#reach[located] ?? 0) >= base + 1) continue
				this.#reach[located] = base + 1
				this.#via[located] = {
					parent: index,
					first: child.first,
					...(INTRINSICS.own(child, 'second') && child.second !== undefined
						? { second: child.second }
						: {}),
				}
			}
		}
		for (const index of iterateIndices(() => this.#captures.length)) {
			const capture = this.#captures[index]
			if (capture === undefined || capture.raw === 0) continue
			if ((this.#reach[index] ?? 0) + capture.raw <= COMPILE_DEPTH_LIMIT) continue
			this.#structure ??= new ContractError(
				'validateShape: raw schema exceeds the compilation depth limit',
				{ code: 'structure', context: { path: pathOf(this.#ascend(index), 'schema') } },
			)
		}
		this.#placeDefaults()
	}

	// Where a default can fill is a fact about every route to it, and a shared node is
	// discovered through one route alone, so this is asked over the captured graph. It
	// reads the reverse postorder top-down: a node's union ancestry is final before its
	// edges are read, so one pass answers every route. A union's parser returns a
	// guard-valid value by identity, so a default below one fills only the inputs that
	// needed a coercion. An open object takes a misspelled key as an extra, so a default
	// beside one fills the real key with no fault to report it.
	#placeDefaults(): void {
		const carried = INTRINSICS.reflect.apply(INTRINSICS.some, this.#captures, [
			(capture: { readonly defaulted: boolean }) => capture.defaulted,
		])
		if (!carried) return
		for (const offset of iterateIndices(() => this.#post.length)) {
			const index = this.#post[this.#post.length - 1 - offset]
			if (index === undefined) continue
			const capture = this.#captures[index]
			if (capture === undefined) continue
			const enclosed =
				capture.category === 'union' ||
				(INTRINSICS.own(this.#within, index) && this.#within[index] !== undefined)
			for (const edge of iterateIndices(() => capture.children.length)) {
				const child = capture.children[edge]
				if (child === undefined) continue
				const located = this.#locate(child.shape)
				if (located === undefined) continue
				if (
					enclosed &&
					(!INTRINSICS.own(this.#within, located) || this.#within[located] === undefined)
				) {
					this.#within[located] = {
						parent: index,
						first: child.first,
						...(INTRINSICS.own(child, 'second') && child.second !== undefined
							? { second: child.second }
							: {}),
					}
				}
				if (this.#captures[located]?.defaulted !== true) continue
				// Keep own guards consistent; valid optional-property edges always own their second segment.
				if (enclosed) {
					this.#domain ??= new ContractError(
						'validateShape: a default may not sit under a union, whose parser can return a valid value without filling it; move the default outside the union or remove it',
						{
							code: 'placement',
							context: {
								path: pathOf(
									this.#route(index),
									child.first,
									INTRINSICS.own(child, 'second') ? child.second : undefined,
								),
								shape: 'optional',
							},
						},
					)
				}
				if (capture.open) {
					this.#domain ??= new ContractError(
						'validateShape: a default may not sit on a property of an open object, where a misspelled key would fill it unreported; close the object or remove the default',
						{
							code: 'placement',
							context: {
								path: pathOf(
									this.#ascend(index),
									child.first,
									INTRINSICS.own(child, 'second') ? child.second : undefined,
								),
								shape: 'optional',
							},
						},
					)
				}
			}
		}
	}

	// The path to a node through the union edge recorded for it, falling back to its
	// deepest occurrence above the union that encloses it.
	#route(index: number): readonly string[] {
		const edge = INTRINSICS.own(this.#within, index) ? this.#within[index] : undefined
		return edge === undefined
			? this.#ascend(index)
			: pathOf(
					this.#route(edge.parent),
					edge.first,
					INTRINSICS.own(edge, 'second') ? edge.second : undefined,
				)
	}

	// The declaration path to a node's DEEPEST occurrence, spelled out by walking
	// the improving edges back to the root and reversing them. The raw-depth rule
	// is re-asked from that occurrence, so the diagnostic has to name it too: the
	// first-discovered path names a slot that, on its own, validates.
	#ascend(index: number): readonly string[] {
		if (index === 0) return []
		const edge = INTRINSICS.own(this.#via, index) ? this.#via[index] : undefined
		return edge === undefined
			? []
			: pathOf(
					this.#ascend(edge.parent),
					edge.first,
					INTRINSICS.own(edge, 'second') ? edge.second : undefined,
				)
	}

	// The first excessive-depth witness in declaration order, reconstructed rather
	// than searched for: at each level the earliest edge whose remaining height
	// still overshoots the allowance is the edge a pre-order walk would have taken.
	#witness(index: number | undefined, depth: number, path: readonly string[]): never {
		if (depth <= COMPILE_DEPTH_LIMIT) {
			const capture = index === undefined ? undefined : this.#captures[index]
			const children = capture === undefined ? [] : capture.children
			const selected: number = INTRINSICS.reflect.apply(INTRINSICS.find, children, [
				(child: (typeof children)[number]) => {
					const located = this.#locate(child.shape)
					const reached = located === undefined ? 0 : (this.#height[located] ?? 0)
					return depth + 1 + reached > COMPILE_DEPTH_LIMIT
				},
			])
			const chosen = children[selected]
			if (chosen !== undefined) {
				return this.#witness(
					this.#locate(chosen.shape),
					depth + 1,
					pathOf(path, chosen.first, INTRINSICS.own(chosen, 'second') ? chosen.second : undefined),
				)
			}
		}
		throw new ContractError('validateShape: a shape exceeds the compilation depth limit', {
			code: 'depth',
			context: { path: pathOf(path), limit: COMPILE_DEPTH_LIMIT },
		})
	}

	#finish(): void {
		if (this.#structure !== undefined) throw this.#structure
		if (this.#cycle !== undefined) throw this.#cycle
		if (this.#domain !== undefined) throw this.#domain
	}

	#refuseSchema(
		message: string,
		stack: ReadonlyArray<{
			readonly operation: 'enter' | 'exit'
			readonly first?: string
			readonly second?: string
		}>,
		first?: string,
		second?: string,
		keyword?: string,
		member?: string,
	): false {
		if (this.#structure !== undefined) return false
		const ancestors: readonly string[] = INTRINSICS.reflect.apply(
			INTRINSICS.expand,
			readIndexView(stack),
			[
				(frame: {
					readonly operation: 'enter' | 'exit'
					readonly first?: string
					readonly second?: string
				}) =>
					frame.operation === 'exit'
						? pathOf(
								[],
								INTRINSICS.own(frame, 'first') ? frame.first : undefined,
								INTRINSICS.own(frame, 'second') ? frame.second : undefined,
							)
						: [],
			],
		)
		const prefix: string[] = []
		appendEntries(prefix, this.#path)
		prefix[prefix.length] = 'schema'
		appendEntries(prefix, ancestors)
		const path = pathOf(prefix, first, second)
		return this.#refuse(message, keyword, member, path)
	}

	#refuse(
		message: string,
		first?: string,
		second?: string,
		prefix: readonly string[] = this.#path,
	): false {
		if (this.#structure === undefined) {
			const path = pathOf(prefix, first, second)
			this.#structure = new ContractError(message, {
				code: 'structure',
				context: { path },
			})
		}
		return false
	}
}
