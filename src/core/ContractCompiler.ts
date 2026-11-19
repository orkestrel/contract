import type {
	ArrayShape,
	AuditFault,
	AuditorFunction,
	CapturePlan,
	ContractCompilerInterface,
	ContractInterface,
	ContractRefusal,
	ContractShape,
	Fault,
	FaultKind,
	Guard,
	Infer,
	InterfaceShape,
	JSONSchema,
	JSONValue,
	LiteralValue,
	NumberShape,
	ObjectShape,
	OwnerFunction,
	Parser,
	RandomFunction,
	ReporterFunction,
	Result,
	SeederFunction,
	StringShape,
	UnionShape,
} from './types.js'
import {
	FAULT_LIMIT,
	GENERATION_ATTEMPT_LIMIT,
	INTRINSICS,
	PRESENCE_MASK_LIMIT,
	SHAPE_FIELDS,
} from './constants.js'
import { ContractError, isContractError } from './errors.js'
import {
	readIndexView,
	appendEntries,
	attempt,
	iterateIndices,
	collectArrayEntries,
	collectMembers,
	contain,
	buildArrayFaults,
	buildPositions,
	buildNumberFaults,
	buildStringFaults,
	computeMonthLength,
	drawRandom,
	enumerableKeys,
	failure,
	filterUncoveredFaults,
	holds,
	isFailure,
	isSuccess,
	limitEntries,
	matchesCalendarDate,
	matchesEnumerableKeys,
	matchesMember,
	matchesStepGuard,
	matchesUndefinedNode,
	ownPattern,
	pathOf,
	pinMembers,
	preview,
	readArrayEntries,
	readPatternSource,
	readPresence,
	readValue,
	refuseExpansion,
	selectClosestFaults,
	shapeToKind,
	success,
} from './helpers.js'
import {
	isArray,
	isBoolean,
	isFiniteNumber,
	isFunction,
	isInteger,
	isJSONValue,
	isNull,
	isObject,
	isRecord,
	isString,
	isUndefined,
} from './validators.js'
import {
	boundsOf,
	intersectionOf,
	literalOf,
	matchOf,
	nullableOf,
	orOf,
	stringOf,
	unionOf,
	whereOf,
} from './combinators.js'
import { parseBoolean, parseInteger, parseJSONValue, parseNumber, parseString } from './parsers.js'
import { cloneJSONValue, cloneSchema, ownShape } from './cloners.js'
import { ShapePass } from './ShapePass.js'
import { ShapeValidator } from './ShapeValidator.js'
import { EvaluationScope } from './EvaluationScope.js'
import { KeyPlanCache } from './KeyPlanCache.js'
import { ValueCloner } from './ValueCloner.js'
import { seededRandom } from './seeders.js'

/**
 * Owns one contract shape's artifacts and their bundle, compiled lazily.
 *
 * @remarks
 * The engine every standalone `compile*` function and `createContract` runs
 * on. A recursive compiler re-owns and
 * re-validates the SUBGRAPH at every node it descends into, so a depth-100
 * chain pays a hundred clones of shrinking graphs and a hundred validations —
 * quadratic work for a linear declaration. Here ownership runs once, validation runs once over
 * that owned result, and each unique node and structural edge is indexed once
 * into children-before-parent order. A declaration a builder sealed is frozen and
 * validated all the way down already, so it takes neither and is indexed as it
 * stands. Every artifact family is then a single
 * postorder pass whose entries are keyed by node identity, so a shared child is
 * compiled once however many parents point at it. The same asymmetry exists on
 * the VALUE side and is answered the same way: `guard`, `auditor` and `reporter`
 * carry a call-scoped ledger, so a shared object costs one visit per compiled
 * node rather than one per path through the graph.
 *
 * Construction observes nothing at all: no read, no validation, no clone, no
 * graph-sized allocation, no clock, no draw. The first getter read prepares; the
 * getters after it replay. A getter builds its own family and no other, except
 * that `parser`, `reporter` and `generator` build the guard plan when the graph
 * holds a union, because a union's membership question IS a guard question in
 * all three, and every getter builds it when the graph holds a default, because
 * a default that its inner shape refuses refuses at whichever artifact is read
 * first. The `guard`, `parser` and `reporter` plan the audits when the graph holds
 * an interface, because an interface node answers each of the three from its audit.
 * The `owner` builds the guard, the auditor, and the parser, because it judges with all three.
 *
 * One terminal lifecycle covers preparation and every family. A failure settles
 * the compiler: later getters rethrow that exact error, while an artifact
 * already handed out keeps working, because each compiled artifact is
 * self-contained. Reentry — reachable only through a caller accessor the
 * declaration itself exposes, because a `pattern` getter is the one accessor
 * ownership invokes — invalidates the nested read, the interrupted outer read, and
 * every later read with one shared cause-free error.
 *
 * @typeParam S - The declaration's shape type, which types the published artifacts
 *
 * @example
 * ```ts
 * const compiler = new ContractCompiler({ category: 'string', min: 1 })
 * compiler.guard('Ada') // true
 * compiler.guard === compiler.guard // true — every getter replays its exact root
 * ```
 */
export class ContractCompiler<
	S extends ContractShape = ContractShape,
> implements ContractCompilerInterface<S> {
	// Captured while this module evaluates — the qualification matters, because
	// "before any caller code runs" is false for a consumer module ordered
	// earlier, which is the limit `constants.ts` states and does not defend. The
	// node index is built and released outside every containment this class has,
	// so a replaced `globalThis.WeakMap` would throw a caller value out of a door
	// documented to publish a `ContractError`.
	static readonly #weakMap = WeakMap
	// The released state, shared by every compiler this class ever builds.
	// `#release` assigns these in place of the working collections, so an instance
	// allocates one collection per family instead of two and construction carries
	// no empty peer of its own. Sharing them is safe because nothing MUTATES a
	// released collection: every element write — `#discover`, `#schedule`, and the
	// family loops — runs behind `#prepare`, which refuses after `#release`
	// clears `#source`; the constructor and `#release` assign the field and never
	// touch a sentinel's elements. The static block beneath freezes them, so a
	// write that did reach one fails at its own line rather than leaking a node of
	// one compiler's graph into every other compiler's release — under the same
	// qualification `#weakMap` carries earlier: `INTRINSICS.freeze` is captured
	// while this module evaluates, so a consumer module ordered before
	// `constants.ts` defeats it, and that limit is stated there rather than
	// defended.
	static readonly #emptyStack: Array<
		| { readonly operation: 'enter'; readonly shape: ContractShape }
		| { readonly operation: 'exit'; readonly index: number }
	> = []
	static readonly #emptyNodes: ContractShape[] = []
	static readonly #emptyOrder: number[] = []
	static readonly #emptySchemas: JSONSchema[] = []
	static readonly #emptyGuards: Array<Guard<unknown>> = []
	static readonly #emptyParsers: Array<Parser<unknown>> = []
	static readonly #emptyAudits: Array<
		(value: unknown, path: readonly string[]) => readonly AuditFault[]
	> = []
	static readonly #emptyReports: Array<
		(value: unknown, path: readonly string[]) => readonly Fault[]
	> = []
	static readonly #emptySeeds: Array<(random: RandomFunction) => unknown> = []
	static readonly #emptyAdmitted: boolean[] = []
	static readonly #emptyCaptures: Array<CapturePlan | undefined> = []
	// The plan of every interface position: the value there is held, so nothing below it is planned.
	static readonly #held: CapturePlan = INTRINSICS.freeze({
		held: true,
		properties: INTRINSICS.freeze(INTRINSICS.create(null)),
		tail: undefined,
		items: undefined,
	})
	// One frozen function for every draw, so two seeds generate equal values.
	static readonly #function: () => undefined = INTRINSICS.freeze(() => undefined)
	// The path an interface's guard and parser hand its audit; a clean verdict carries none.
	static readonly #root: readonly string[] = INTRINSICS.freeze([])

	static {
		// Frozen in a statement of its own, and the result discarded: `Object.freeze`
		// returns a readonly view, so binding it back would retype the peers and
		// stop them satisfying the mutable working fields they are assigned to.
		INTRINSICS.freeze(ContractCompiler.#emptyStack)
		INTRINSICS.freeze(ContractCompiler.#emptyNodes)
		INTRINSICS.freeze(ContractCompiler.#emptyOrder)
		INTRINSICS.freeze(ContractCompiler.#emptySchemas)
		INTRINSICS.freeze(ContractCompiler.#emptyGuards)
		INTRINSICS.freeze(ContractCompiler.#emptyParsers)
		INTRINSICS.freeze(ContractCompiler.#emptyAudits)
		INTRINSICS.freeze(ContractCompiler.#emptyReports)
		INTRINSICS.freeze(ContractCompiler.#emptySeeds)
		INTRINSICS.freeze(ContractCompiler.#emptyAdmitted)
		INTRINSICS.freeze(ContractCompiler.#emptyCaptures)
	}

	#source: ContractShape | undefined
	#state:
		| { readonly phase: 'ready' }
		| { readonly phase: 'running'; readonly poison: ContractError }
		| { readonly phase: 'interrupted'; readonly poison: ContractError }
		| { readonly phase: 'failed'; readonly error: ContractError }
	#stack: Array<
		| { readonly operation: 'enter'; readonly shape: ContractShape }
		| { readonly operation: 'exit'; readonly index: number }
	>
	// The prepared index. `#nodes[0]` is the owned root by construction, `#index`
	// answers "which node is this child" by identity, and `#order` lists every
	// node with its children already listed before it — so a family solves any
	// bottom-up fact by reading it forwards once. The index is the one working
	// field with no shared peer: `Object.freeze` reaches an array's writes and not
	// a `WeakMap`'s, so a shared empty map would be a class-lifetime cache that
	// any write could fill with the caller's own shapes. Release drops the map
	// instead, and absence is `undefined`.
	#nodes: ContractShape[]
	#index: WeakMap<ContractShape, number> | undefined
	#order: number[]
	// One plan per family, each indexed by the same node index. A plan entry is a
	// self-contained artifact for that node: it closes over the CHILD entries it
	// needs, resolved while the family is built, so nothing a compiled artifact
	// does at call time reaches back into the index this class later releases.
	#schemas: JSONSchema[]
	#guards: Array<Guard<unknown>>
	#parsers: Array<Parser<unknown>>
	#audits: Array<(value: unknown, path: readonly string[]) => readonly AuditFault[]>
	#reports: Array<(value: unknown, path: readonly string[]) => readonly Fault[]>
	#seeds: Array<(random: RandomFunction) => unknown>
	// The one static fact the container families share: whether each node admits `undefined`.
	#admitted: boolean[]
	// Each node's capture plan, absent where no interface sits below it.
	#captures: Array<CapturePlan | undefined>
	#schema: JSONSchema | undefined
	#guard: Guard<unknown> | undefined
	#parser: Parser<unknown> | undefined
	#auditor: AuditorFunction | undefined
	#reporter: ReporterFunction | undefined
	#generator: SeederFunction<unknown> | undefined
	#owner: OwnerFunction<unknown> | undefined
	#bundle: ContractInterface<unknown> | undefined

	/**
	 * Retains a shape declaration without observing it.
	 *
	 * @param shape - The live declaration the first getter read will own
	 */
	constructor(shape: S) {
		this.#source = shape
		this.#state = { phase: 'ready' }
		this.#stack = []
		this.#nodes = []
		this.#index = new ContractCompiler.#weakMap()
		this.#order = []
		this.#schemas = []
		this.#guards = []
		this.#parsers = []
		this.#audits = []
		this.#reports = []
		this.#seeds = []
		this.#admitted = []
		this.#captures = []
		this.#schema = undefined
		this.#guard = undefined
		this.#parser = undefined
		this.#auditor = undefined
		this.#reporter = undefined
		this.#generator = undefined
		this.#owner = undefined
		this.#bundle = undefined
	}

	/**
	 * Returns the emitted JSON Schema for the owned declaration.
	 *
	 * @remarks
	 * A deeply frozen graph that preserves shared declaration identity: two
	 * property slots holding the same authored node hold the same emitted
	 * subschema, while structurally equal distinct nodes stay distinct objects.
	 */
	get schema(): JSONSchema {
		const ready = this.#schema
		if (ready !== undefined && this.#state.phase === 'ready') return ready
		return this.#enter(() => this.#buildSchema())
	}

	/** Returns the compiled strict guard for the owned declaration. */
	get guard(): Guard<Infer<S>> {
		const ready = this.#guard
		if (ready !== undefined && this.#state.phase === 'ready') return this.#publish(ready)
		return this.#publish(this.#enter(() => this.#buildGuard()))
	}

	/** Returns the compiled coercive parser for the owned declaration. */
	get parser(): Parser<Infer<S>> {
		const ready = this.#parser
		if (ready !== undefined && this.#state.phase === 'ready') return this.#publish(ready)
		return this.#publish(this.#enter(() => this.#buildParser()))
	}

	/** Returns the compiled strict-domain diagnostic for the owned declaration. */
	get auditor(): AuditorFunction {
		const ready = this.#auditor
		if (ready !== undefined && this.#state.phase === 'ready') return ready
		return this.#enter(() => this.#buildAuditor())
	}

	/** Returns the compiled coercive-domain diagnostic for the owned declaration. */
	get reporter(): ReporterFunction {
		const ready = this.#reporter
		if (ready !== undefined && this.#state.phase === 'ready') return ready
		return this.#enter(() => this.#buildReporter())
	}

	/** Returns the compiled seed-data source for the owned declaration. */
	get generator(): SeederFunction<Infer<S>> {
		const ready = this.#generator
		if (ready !== undefined && this.#state.phase === 'ready') return this.#publish(ready)
		return this.#publish(this.#enter(() => this.#buildGenerator()))
	}

	/** Returns the compiled owning admission for the owned declaration. */
	get owner(): OwnerFunction<Infer<S>> {
		const ready = this.#owner
		if (ready !== undefined && this.#state.phase === 'ready') return this.#publish(ready)
		return this.#publish(this.#enter(() => this.#buildOwner()))
	}

	/**
	 * Returns the frozen bundle of this compiler's artifacts.
	 *
	 * @remarks
	 * Own enumerable keys `schema`, `is`, `parse`, `audit`, `explain`,
	 * `generate`, `own`, in that order, each holding the exact value the
	 * corresponding getter publishes.
	 */
	get contract(): ContractInterface<Infer<S>> {
		const ready = this.#bundle
		if (ready !== undefined && this.#state.phase === 'ready') return this.#publish(ready)
		return this.#publish(this.#enter(() => this.#buildContract()))
	}

	// One of the two typed boundaries in this class, with `#claim`. Every family is compiled over
	// the OWNED graph, whose static type is the widened `ContractShape` union, while
	// the compiler publishes artifacts under the inferred type of the declaration
	// it was constructed from. The standalone `compile*` functions make the
	// identical claim through their own overload pairs; declaring it once here is
	// that same statement rather than an extra one, and the two boundaries are the
	// reason no assertion appears anywhere in this file.
	// The owner overload comes first, because an owner is also assignable to `Parser<unknown>`.
	#publish(root: OwnerFunction<unknown>): OwnerFunction<Infer<S>>
	#publish(root: Guard<unknown>): Guard<Infer<S>>
	#publish(root: Parser<unknown>): Parser<Infer<S>>
	#publish(root: SeederFunction<unknown>): SeederFunction<Infer<S>>
	#publish(root: ContractInterface<unknown>): ContractInterface<Infer<S>>
	#publish(root: unknown): unknown {
		return root
	}

	// Lifecycle. Every getter runs its build inside this, so preparation and every
	// family share one terminal state.
	#enter<T>(build: () => T): T {
		const state = this.#state
		if (state.phase === 'failed') throw state.error
		if (state.phase === 'running' || state.phase === 'interrupted') {
			this.#state = { phase: 'interrupted', poison: state.poison }
			throw state.poison
		}
		// Created BEFORE the source is observed, for the same reason the cloners
		// create theirs there: a reentry refusal built on the settlement path would be built
		// under whatever the caller installed while the build was running.
		const poison = new ContractError(
			'ContractCompiler: contract compilation may not be reentered',
			{ code: 'structure', context: { path: [], shape: 'contract' } },
		)
		this.#state = { phase: 'running', poison }
		return this.#leave(attempt(build))
	}

	#leave<T>(outcome: Result<T>): T {
		const state = this.#state
		if (state.phase === 'interrupted') return this.#fail(state.poison)
		if (isFailure(outcome)) {
			return this.#fail(
				isContractError(outcome.error)
					? outcome.error
					: new ContractError('ContractCompiler: contract compilation failed', {
							code: 'structure',
							context: { path: [], shape: 'contract' },
							cause: outcome.error,
						}),
			)
		}
		this.#state = { phase: 'ready' }
		this.#collect()
		return outcome.value
	}

	#fail(error: ContractError): never {
		this.#state = { phase: 'failed', error }
		this.#release()
		throw error
	}

	// After every root exists nothing can need the graph again, so the graph, the
	// index, the order and every family plan go. The roots and the optional
	// frozen bundle stay, and so does terminal state.
	#collect(): void {
		if (this.#schema === undefined || this.#guard === undefined) return
		if (this.#parser === undefined || this.#auditor === undefined) return
		if (this.#reporter === undefined || this.#generator === undefined) return
		if (this.#owner === undefined) return
		this.#release()
	}

	// Assignment only: every working collection takes the class's shared frozen
	// empty peer and the index is dropped outright. Nothing here calls a
	// caller-mutable cleanup member and nothing here constructs a collection at
	// all, so release cannot be redirected into leaving state behind.
	#release(): void {
		this.#source = undefined
		this.#stack = ContractCompiler.#emptyStack
		this.#nodes = ContractCompiler.#emptyNodes
		this.#index = undefined
		this.#order = ContractCompiler.#emptyOrder
		this.#schemas = ContractCompiler.#emptySchemas
		this.#guards = ContractCompiler.#emptyGuards
		this.#parsers = ContractCompiler.#emptyParsers
		this.#audits = ContractCompiler.#emptyAudits
		this.#reports = ContractCompiler.#emptyReports
		this.#seeds = ContractCompiler.#emptySeeds
		this.#admitted = ContractCompiler.#emptyAdmitted
		this.#captures = ContractCompiler.#emptyCaptures
	}

	// === Preparation

	#prepare(): void {
		if (this.#nodes.length > 0) return
		const source = this.#source
		if (source === undefined) {
			throw new ContractError('ContractCompiler: the retained declaration is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		// A node a builder sealed is already frozen and validated all the way down, so
		// it is owned as it stands and only the emitted-node bound is left to ask.
		const sealed = ShapePass.expansionOf(source)
		if (sealed !== undefined) {
			refuseExpansion(sealed)
			this.#discover(source)
			this.#source = undefined
			return
		}
		// ONE ownership population for the whole compiler. `ownShape` runs the
		// accepted `ShapeCloner`, whose completed-root pass validates what it built;
		// the following pass is this compiler's own single validation of that owned
		// result, and it is where the emitted-node bound is applied — the gate that
		// owns that rule authors its diagnosis, so the refusal reads identically
		// however the caller arrived.
		const owned = ownShape(source)
		// Ownership has already bounded capture. This existing validation checks
		// that bounded graph without opening a second capture budget for this call.
		refuseExpansion(new ShapePass(owned).validate())
		this.#discover(owned)
		this.#source = undefined
	}

	#discover(root: ContractShape): void {
		// Narrowed once at the door, because both following dispatches take their
		// receiver type from this value. `#prepare` is the only caller and it
		// refuses while the declaration is gone, so the walk always finds the map
		// the constructor built; this refusal is what keeps that a statement the
		// types carry rather than one a comment makes.
		const known = this.#index
		if (known === undefined) {
			throw new ContractError('ContractCompiler: the prepared index is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		this.#stack[this.#stack.length] = { operation: 'enter', shape: root }
		while (this.#stack.length > 0) {
			// Popped by index and truncated by `length`, never through
			// `Array.prototype.pop`: that member is caller-writable and this walk runs
			// after the two contained engines have finished, so a redirect here would
			// be the one dispatch in this class with nothing between it and the
			// caller. Indexed reads and a `length` assignment on an array this class
			// built reach no member at all.
			const top = this.#stack.length - 1
			const frame = this.#stack[top]
			this.#stack.length = top
			if (frame === undefined) continue
			if (frame.operation === 'exit') {
				this.#order[this.#order.length] = frame.index
				continue
			}
			const shape = frame.shape
			// A node reached a second time is already indexed, and the graph is
			// acyclic by validation, so it is already finished too — which is exactly
			// what makes one entry per unique node correct rather than merely cheap.
			if (INTRINSICS.reflect.apply(INTRINSICS.recall, known, [shape]) !== undefined) continue
			const index = this.#nodes.length
			// `Object.prototype` can gain a field a node leaves out at any time after this
			// call, and a family or a report plan reading the node would answer from it, so
			// they read an own copy that cannot inherit.
			const node: ContractShape = INTRINSICS.rebase({ ...shape }, null)
			this.#nodes[index] = node
			INTRINSICS.reflect.apply(INTRINSICS.retain, known, [node, index])
			INTRINSICS.reflect.apply(INTRINSICS.retain, known, [shape, index])
			this.#stack[this.#stack.length] = { operation: 'exit', index }
			this.#schedule(shape)
		}
	}

	// Children are pushed in REVERSE slot order so the walk discovers them in
	// declaration order, which keeps node indices deterministic for one graph.
	#schedule(shape: ContractShape): void {
		switch (shape.category) {
			case 'array':
				this.#stack[this.#stack.length] = { operation: 'enter', shape: shape.items }
				return
			case 'optional':
			case 'nullable':
				this.#stack[this.#stack.length] = { operation: 'enter', shape: shape.inner }
				return
			case 'union': {
				for (const offset of iterateIndices(() => shape.variants.length)) {
					const index = shape.variants.length - 1 - offset
					const variant = shape.variants[index]
					if (variant === undefined) continue
					this.#stack[this.#stack.length] = { operation: 'enter', shape: variant }
				}
				return
			}
			case 'object': {
				const extra = shape.additionalProperties
				if (extra !== undefined && extra !== true && extra !== false) {
					this.#stack[this.#stack.length] = { operation: 'enter', shape: extra }
				}
				const keys = INTRINSICS.keys(shape.properties)
				for (const offset of iterateIndices(() => keys.length)) {
					const index = keys.length - 1 - offset
					const key = keys[index]
					if (key === undefined) continue
					const child = shape.properties[key]
					if (child === undefined) continue
					this.#stack[this.#stack.length] = { operation: 'enter', shape: child }
				}
				return
			}
			case 'interface': {
				const keys = INTRINSICS.keys(shape.members)
				for (const offset of iterateIndices(() => keys.length)) {
					const key = keys[keys.length - 1 - offset]
					const child = key === undefined ? undefined : shape.members[key]
					if (child === undefined) continue
					this.#stack[this.#stack.length] = { operation: 'enter', shape: child }
				}
				return
			}
			default:
				return
		}
	}

	#locate(shape: ContractShape): number {
		// The receiver is narrowed BEFORE the dispatch. `INTRINSICS.reflect.apply` takes its
		// receiver type from this argument rather than from the target, so a dropped
		// index would leave `WeakMap.prototype.get` throwing a host `TypeError`
		// through a door whose whole contract is that it publishes this package's
		// error class. Defense in depth, not a live path: a released compiler holds
		// every root, so every family returns its ready root before locating
		// anything, and a failed one rethrows at `#enter` — which is why no
		// reachable vector settles here and the guard still belongs.
		const known = this.#index
		if (known === undefined) {
			throw new ContractError('ContractCompiler: the prepared index is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		const index = INTRINSICS.reflect.apply(INTRINSICS.recall, known, [shape])
		if (index === undefined) {
			throw new ContractError('ContractCompiler: a structural child is not in the prepared index', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		return index
	}

	#node(index: number): ContractShape {
		const shape = this.#nodes[index]
		if (shape === undefined) {
			throw new ContractError('ContractCompiler: a prepared node is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		return shape
	}

	// A union's membership answer is its compiled guard in the parser, the
	// reporter and the generator alike, so those three build the guard plan when —
	// and only when — the graph actually holds one.
	#unions(): boolean {
		for (const index of iterateIndices(() => this.#nodes.length)) {
			if (this.#nodes[index]?.category === 'union') return true
		}
		return false
	}

	// An interface's guard, parser, and reporter answer from its audit, so those three plan the
	// audits when — and only when — the graph holds one.
	#interfaces(): boolean {
		for (const index of iterateIndices(() => this.#nodes.length)) {
			if (this.#nodes[index]?.category === 'interface') return true
		}
		return false
	}

	// A default is judged by the guard of the shape it fills, and a declaration that
	// refuses has to refuse at whichever artifact is read first, so every family builds
	// the guard plan when — and only when — the graph holds a default.
	#defaults(): boolean {
		for (const index of iterateIndices(() => this.#nodes.length)) {
			const node = this.#nodes[index]
			if (node?.category === 'optional' && INTRINSICS.own(node, 'default')) return true
		}
		return false
	}

	// Walks the declaration rather than the node list, because the path a refusal names
	// exists only on the way down. Validation bounded the tree this expands into, and
	// `#buildGuard` runs this once, on a graph that holds a default.
	#checkDefaults(shape: ContractShape, path: readonly string[]): void {
		switch (shape.category) {
			case 'array':
				this.#checkDefaults(shape.items, pathOf(path, 'items'))
				return
			case 'nullable':
				this.#checkDefaults(shape.inner, pathOf(path, 'inner'))
				return
			case 'optional': {
				this.#checkDefaults(shape.inner, pathOf(path, 'inner'))
				if (!INTRINSICS.own(shape, 'default') || this.#guardAt(shape.inner)(shape.default)) return
				throw new ContractError(
					'ContractCompiler: a default must satisfy the shape it fills; change the default or the shape',
					{
						code: 'structure',
						context: {
							path: pathOf(path, 'default'),
							shape: 'optional',
							received: preview(shape.default),
						},
					},
				)
			}
			case 'union':
				for (const index of iterateIndices(() => shape.variants.length)) {
					const variant = shape.variants[index]
					if (variant === undefined) continue
					this.#checkDefaults(variant, pathOf(path, 'variants', INTRINSICS.text(index)))
				}
				return
			case 'object': {
				const keys = INTRINSICS.keys(shape.properties)
				for (const index of iterateIndices(() => keys.length)) {
					const key = keys[index]
					const child = key === undefined ? undefined : shape.properties[key]
					if (child === undefined) continue
					this.#checkDefaults(child, pathOf(path, 'properties', key))
				}
				const extra = shape.additionalProperties
				if (extra !== undefined && extra !== true && extra !== false) {
					this.#checkDefaults(extra, pathOf(path, 'additionalProperties'))
				}
				return
			}
			default:
				return
		}
	}

	// Solved one time per compiler, children first, by whichever container family asks first.
	#admit(): void {
		if (this.#admitted.length > 0) return
		for (const step of iterateIndices(() => this.#order.length)) {
			const index = this.#order[step]
			if (index === undefined) continue
			const owned = this.#node(index)
			const children: readonly ContractShape[] =
				owned.category === 'union'
					? owned.variants
					: owned.category === 'nullable'
						? [owned.inner]
						: []
			const answers: readonly boolean[] = INTRINSICS.reflect.apply(
				INTRINSICS.project,
				readIndexView(children),
				[(child: ContractShape) => this.#admitted[this.#locate(child)] === true],
			)
			this.#admitted[index] = matchesUndefinedNode(
				owned.category,
				owned.category === 'union' ? owned.mode : undefined,
				answers,
			)
		}
	}

	#admits(shape: ContractShape): boolean {
		this.#admit()
		return this.#admitted[this.#locate(shape)] === true
	}

	// Each root evaluation owns the answers for its active synchronous walk.
	// Shared objects reuse one answer per compiled node; the scope is removed
	// in finally so later calls always observe the caller's current value.

	// Only a node that descends into a child artifact can be reached twice through
	// one value; a leaf answers about the value in front of it, so tracking one
	// would buy nothing and would replace the package's own guards and parsers in
	// the artifacts a leaf-rooted declaration publishes.
	#repeats(index: number): boolean {
		const category = this.#node(index).category
		if (category === 'array' || category === 'object' || category === 'union') return true
		return category === 'optional' || category === 'nullable' || category === 'interface'
	}

	#trackGuard(plan: Guard<unknown>): Guard<unknown> {
		return (value: unknown): value is unknown => EvaluationScope.run(plan, value)
	}

	// The diagnostic families reuse only the CLEAN verdict, because a fault
	// carries the path it was found at while emptiness carries nothing: a node
	// that reported no fault about an object reports none about it wherever else
	// the walk arrives. A faulted node is re-walked at its new path, and stays
	// bounded by `FAULT_LIMIT` — every collector stops after the cap is reached, so
	// a value that faults everywhere saturates instead of expanding.
	#trackFaults<T>(
		plan: (value: unknown, path: readonly string[]) => readonly T[],
	): (value: unknown, path: readonly string[]) => readonly T[] {
		return (value, path) => EvaluationScope.run(plan, value, path, true)
	}

	// What tells a union's arms apart, when anything does: a property every arm is an
	// object declaring as a required literal. A value names an arm when its own data
	// property exactly equals a literal only that arm holds, which is the membership the
	// literal guard asks, so no other arm's guard could accept that value and the named
	// arm answers for the whole union. A key whose literal two arms share names nothing,
	// so the next such key is asked. The answer closes over no part of this compiler.
	#discriminate(owned: UnionShape):
		| {
				readonly select: (value: unknown) => number | undefined
				readonly hint: { readonly key: string; readonly expected: readonly LiteralValue[] }
		  }
		| undefined {
		const arms: readonly ObjectShape[] = INTRINSICS.reflect.apply(
			INTRINSICS.select,
			readIndexView(owned.variants),
			[(variant: ContractShape | undefined) => variant?.category === 'object'],
		)
		const first = arms[0]
		if (first === undefined || arms.length !== owned.variants.length) return undefined
		const keys: readonly string[] = INTRINSICS.reflect.apply(
			INTRINSICS.select,
			readIndexView(INTRINSICS.keys(first.properties)),
			[
				(key: string) =>
					!INTRINSICS.reflect.apply(INTRINSICS.some, arms, [
						(arm: ObjectShape) =>
							!INTRINSICS.own(arm.properties, key) || arm.properties[key]?.category !== 'literal',
					]),
			],
		)
		const tables: ReadonlyArray<{
			readonly key: string
			readonly members: Map<unknown, number>
			readonly expected: readonly LiteralValue[]
		}> = INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(keys), [
			(key: string) => ContractCompiler.#tableOf(key, arms),
		])
		const named = tables[0]
		if (named === undefined) return undefined
		return {
			hint: INTRINSICS.freeze({ key: named.key, expected: named.expected }),
			select: (value: unknown): number | undefined => {
				if (!isObject(value)) return undefined
				for (const index of iterateIndices(() => tables.length)) {
					const table = tables[index]
					if (table === undefined) continue
					const held = attempt(() => INTRINSICS.describe(value, table.key))
					if (isFailure(held) || held.value === undefined) continue
					if (!INTRINSICS.own(held.value, 'value')) continue
					const arm = INTRINSICS.reflect.apply(INTRINSICS.fetch, table.members, [held.value.value])
					if (arm !== undefined && arm >= 0) return arm
				}
				return undefined
			},
		}
	}

	// One key's literals, each with the arm that alone holds it, or -1 when two arms do.
	static #tableOf(
		key: string,
		arms: readonly ObjectShape[],
	): {
		readonly key: string
		readonly members: Map<unknown, number>
		readonly expected: readonly LiteralValue[]
	} {
		const members = new INTRINSICS.map<unknown, number>()
		const expected: LiteralValue[] = []
		for (const armIndex of iterateIndices(() => arms.length)) {
			const node = arms[armIndex]?.properties[key]
			if (node?.category !== 'literal') continue
			for (const valueIndex of iterateIndices(() => node.values.length)) {
				const literal = node.values[valueIndex]
				if (literal === undefined) continue
				const known = INTRINSICS.reflect.apply(INTRINSICS.fetch, members, [literal])
				if (known === undefined) expected[expected.length] = literal
				const arm = known === undefined || known === armIndex ? armIndex : -1
				INTRINSICS.reflect.apply(INTRINSICS.store, members, [literal, arm])
			}
		}
		return { key, members, expected: INTRINSICS.freeze(expected) }
	}

	// The union parser's own two steps, over the named arm alone. A value that arm accepts
	// returns by identity, and a coercion must satisfy the arm's guard.
	static #parseArm(
		arm: { readonly parse: Parser<unknown>; readonly guard: Guard<unknown> },
		value: unknown,
	): unknown {
		if (arm.guard(value)) return value
		const parsed = arm.parse(value)
		return parsed !== undefined && arm.guard(parsed) ? parsed : undefined
	}

	// === Schema family

	#buildSchema(): JSONSchema {
		const ready = this.#schema
		if (ready !== undefined) return ready
		this.#prepare()
		if (this.#defaults()) this.#buildGuard()
		for (const step of iterateIndices(() => this.#order.length)) {
			const index = this.#order[step]
			if (index === undefined) continue
			this.#schemas[index] = this.#schemaOf(index)
		}
		const root = this.#schemaAt(this.#node(0))
		this.#schema = root
		return root
	}

	#schemaAt(shape: ContractShape): JSONSchema {
		const emitted = this.#schemas[this.#locate(shape)]
		if (emitted === undefined) {
			throw new ContractError('ContractCompiler: a child schema is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		return emitted
	}

	#schemaOf(index: number): JSONSchema {
		const owned = this.#node(index)
		switch (owned.category) {
			case 'shape':
				return INTRINSICS.freeze({
					type: 'object',
					description:
						owned.description ??
						'Over-approximates declarations whose JSON projection preserves their own enumerable data; values without that projection are outside this schema. is decides whether the complete shape is valid.',
					properties: INTRINSICS.freeze({
						category: INTRINSICS.freeze({ enum: INTRINSICS.freeze(INTRINSICS.keys(SHAPE_FIELDS)) }),
					}),
					required: INTRINSICS.freeze(['category']),
					additionalProperties: true,
				})
			case 'string': {
				// The pattern text is read through the CAPTURED `source` getter. It is an
				// accessor on a shared prototype, so a replaced getter chose the
				// `pattern` keyword inside a frozen schema this door publishes as exact —
				// and a schema that quietly dropped the keyword instead would be the same
				// lie with a smaller footprint, so an unreadable source refuses.
				const text = owned.pattern === undefined ? undefined : readPatternSource(owned.pattern)
				if (owned.pattern !== undefined && text === undefined) {
					throw new ContractError('compileSchema: pattern source could not be read', {
						code: 'pattern',
						context: { shape: 'string' },
					})
				}
				return INTRINSICS.freeze({
					type: 'string',
					...(owned.min !== undefined ? { minLength: owned.min } : {}),
					...(owned.max !== undefined ? { maxLength: owned.max } : {}),
					...(text !== undefined ? { pattern: text } : {}),
					...(owned.date === true ? { format: 'date' } : {}),
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			}
			case 'number':
				return INTRINSICS.freeze({
					type: owned.integer === true ? 'integer' : 'number',
					...(owned.min !== undefined ? { minimum: owned.min } : {}),
					...(owned.over !== undefined ? { exclusiveMinimum: owned.over } : {}),
					...(owned.max !== undefined ? { maximum: owned.max } : {}),
					...(owned.under !== undefined ? { exclusiveMaximum: owned.under } : {}),
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			case 'boolean':
				return INTRINSICS.freeze({
					type: 'boolean',
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			case 'null':
				return INTRINSICS.freeze({
					type: 'null',
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			case 'json':
				return INTRINSICS.freeze({
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			case 'function':
				return INTRINSICS.freeze({
					not: INTRINSICS.freeze({}),
					format: 'function',
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			case 'undefined':
				return INTRINSICS.freeze({
					not: INTRINSICS.freeze({}),
					format: 'undefined',
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			case 'literal': {
				// Indexed, not spread: this list is published inside the emitted schema,
				// and an array spread retrieves `Array.prototype[Symbol.iterator]` at the
				// moment of use, so a caller could add a member to a vocabulary this
				// package documents as exactly the shape's own.
				const vocabulary: readonly LiteralValue[] = INTRINSICS.reflect.apply(
					INTRINSICS.select,
					readIndexView(owned.values),
					[(value: LiteralValue | undefined) => value !== undefined],
				)
				return INTRINSICS.freeze({
					enum: INTRINSICS.freeze(vocabulary),
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			}
			case 'array':
				return INTRINSICS.freeze({
					type: 'array',
					items: this.#schemaAt(owned.items),
					...(owned.min !== undefined ? { minItems: owned.min } : {}),
					...(owned.max !== undefined ? { maxItems: owned.max } : {}),
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			case 'object': {
				const entries: ReadonlyArray<{
					readonly key: string
					readonly schema: JSONSchema
					readonly required: boolean
				}> = INTRINSICS.reflect.apply(
					INTRINSICS.expand,
					readIndexView(INTRINSICS.keys(owned.properties)),
					[
						(key: string) => {
							const child = owned.properties[key]
							if (child === undefined) return []
							return [
								{
									key,
									schema: this.#schemaAt(child),
									required: child.category !== 'optional',
								},
							]
						},
					],
				)
				const pairs = INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(entries), [
					(entry: (typeof entries)[number]) => [entry.key, entry.schema],
				])
				const properties = INTRINSICS.rebase(
					INTRINSICS.record<JSONSchema>({
						[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [
							pairs,
						]),
					}),
					null,
				)
				const required: readonly string[] = INTRINSICS.reflect.apply(
					INTRINSICS.expand,
					readIndexView(entries),
					[(entry: (typeof entries)[number]) => (entry.required ? [entry.key] : [])],
				)
				const extra = owned.additionalProperties
				const additionalProperties: boolean | JSONSchema =
					extra === true
						? true
						: extra !== undefined && extra !== false
							? this.#schemaAt(extra)
							: false
				return INTRINSICS.freeze({
					type: 'object',
					...(INTRINSICS.keys(properties).length > 0
						? { properties: INTRINSICS.freeze(properties) }
						: {}),
					...(required.length > 0 ? { required: INTRINSICS.freeze(required) } : {}),
					additionalProperties,
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			}
			case 'interface': {
				const keys = INTRINSICS.keys(owned.members)
				const pairs = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(keys), [
					(key: string) => {
						const child = owned.members[key]
						return child === undefined ? [] : [[key, this.#schemaAt(child)]]
					},
				])
				const properties = INTRINSICS.rebase(
					INTRINSICS.record<JSONSchema>({
						[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [
							pairs,
						]),
					}),
					null,
				)
				const required: readonly string[] = INTRINSICS.reflect.apply(
					INTRINSICS.select,
					readIndexView(keys),
					[(key: string) => owned.members[key]?.category !== 'optional'],
				)
				return INTRINSICS.freeze({
					type: 'object',
					format: 'interface',
					...(keys.length > 0 ? { properties: INTRINSICS.freeze(properties) } : {}),
					...(required.length > 0 ? { required: INTRINSICS.freeze(required) } : {}),
					additionalProperties: true,
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			}
			case 'union': {
				// Indexed, not `map`: this array IS the published schema, and
				// `Array.prototype.map = () => ['INJECTED']` made `compileSchema` answer
				// `{"anyOf":["INJECTED"]}` — a success, with the caller's content inside
				// the package's own output.
				const variants: JSONSchema[] = INTRINSICS.reflect.apply(
					INTRINSICS.expand,
					readIndexView(owned.variants),
					[
						(variant: ContractShape | undefined) =>
							variant === undefined ? [] : [this.#schemaAt(variant)],
					],
				)
				return INTRINSICS.freeze({
					...(owned.mode === 'oneOf'
						? { oneOf: INTRINSICS.freeze(variants) }
						: { anyOf: INTRINSICS.freeze(variants) }),
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			}
			case 'optional': {
				const emitted = this.#schemaAt(owned.inner)
				const value = owned.default
				return value === undefined ? emitted : INTRINSICS.freeze({ ...emitted, default: value })
			}
			case 'nullable':
				return INTRINSICS.freeze({
					anyOf: INTRINSICS.freeze([
						this.#schemaAt(owned.inner),
						INTRINSICS.freeze({ type: 'null' }),
					]),
				})
			case 'raw':
				return cloneSchema(owned.schema)
		}
	}

	// === Guard family

	#buildGuard(): Guard<unknown> {
		const ready = this.#guard
		if (ready !== undefined) return ready
		this.#prepare()
		if (this.#interfaces()) this.#planAudits()
		for (const step of iterateIndices(() => this.#order.length)) {
			const index = this.#order[step]
			if (index === undefined) continue
			const plan = this.#guardOf(index)
			this.#guards[index] = this.#repeats(index) ? this.#trackGuard(plan) : plan
		}
		const root = this.#guardAt(this.#node(0))
		if (this.#defaults()) this.#checkDefaults(this.#node(0), [])
		this.#guard = root
		return root
	}

	#guardAt(shape: ContractShape): Guard<unknown> {
		const compiled = this.#guards[this.#locate(shape)]
		if (compiled === undefined) {
			throw new ContractError('ContractCompiler: a child guard is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		return compiled
	}

	// `stringOf` returns bare `isString` when unrefined, else composes the length-bounds
	// + pattern refinement, and a date shape adds the calendar check — the same guard
	// the parser re-applies. It reads its options
	// through the prototype chain and a family may build after `Object.prototype` gained
	// a field these leave out, so they carry no prototype.
	#stringGuard(owned: StringShape): Guard<string> {
		const guard = stringOf(
			INTRINSICS.rebase(
				{
					...(owned.min === undefined ? {} : { min: owned.min }),
					...(owned.max === undefined ? {} : { max: owned.max }),
					...(owned.pattern === undefined ? {} : { pattern: owned.pattern }),
				},
				null,
			),
		)
		return owned.date === true ? whereOf(guard, matchesCalendarDate) : guard
	}

	// The finite-number range a number node declares, or `undefined` when it declares no bound.
	#rangeOf(owned: NumberShape): Guard<number> | undefined {
		const { min, over, max, under } = owned
		if (over === undefined && under === undefined) {
			return min === undefined && max === undefined ? undefined : boundsOf(min, max)
		}
		return whereOf(
			boundsOf(min, max),
			(value) => (over === undefined || value > over) && (under === undefined || value < under),
		)
	}

	static #acceptShape(value: unknown): boolean {
		return isSuccess(
			attempt(() => {
				const validator = new ShapeValidator(value)
				validator.validate()
				refuseExpansion(validator.expansion)
			}),
		)
	}

	#guardOf(index: number): Guard<unknown> {
		const owned = this.#node(index)
		switch (owned.category) {
			case 'string':
				return this.#stringGuard(owned)
			case 'number': {
				const within = this.#rangeOf(owned)
				if (within === undefined) return owned.integer === true ? isInteger : isFiniteNumber
				// The range already refines `isFiniteNumber`; intersect with `isInteger`
				// when the leaf is an integer so both the integrality and the bounds hold.
				return owned.integer === true ? intersectionOf(isInteger, within) : within
			}
			case 'boolean':
				return isBoolean
			case 'null':
				return isNull
			case 'json':
				return isJSONValue
			case 'function':
				return isFunction
			case 'undefined':
				return isUndefined
			case 'shape':
				return (value): value is ContractShape => ContractCompiler.#acceptShape(value)
			case 'literal':
				// `literalOf` IS the package's literal match (SameValueZero over an owned
				// `Set`); the array form takes a machine-generated vocabulary no spread
				// could carry.
				return literalOf(owned.values)
			case 'array': {
				const element = this.#guardAt(owned.items)
				const withinLength =
					owned.min === undefined && owned.max === undefined
						? undefined
						: boundsOf(owned.min, owned.max)
				// One boundary over the private unfrozen read: the bound takes the read's length, so
				// the walk observes `length` once.
				return (value: unknown): value is unknown =>
					holds(() => {
						if (!INTRINSICS.array(value)) return false
						const read = collectArrayEntries(value)
						if (!read.dense || !read.exact) return false
						const entries = read.entries
						for (let position = 0, count = entries.length; position < count; position++) {
							if (!element(entries[position])) return false
						}
						return withinLength === undefined || withinLength(entries.length)
					})
			}
			case 'object': {
				// Honest typing: a null-prototype accumulator so a property literally
				// named '__proto__' becomes an own data key instead of mutating the
				// prototype — the same pattern `pickOf` uses (combinators.ts).
				const entries: ReadonlyArray<{
					readonly key: string
					readonly guard: Guard<unknown>
					readonly optional: boolean
				}> = INTRINSICS.reflect.apply(
					INTRINSICS.expand,
					readIndexView(INTRINSICS.keys(owned.properties)),
					[
						(key: string) => {
							const child = owned.properties[key]
							if (child === undefined) return []
							const optional = child.category === 'optional'
							return [{ key, guard: this.#guardAt(optional ? child.inner : child), optional }]
						},
					],
				)
				const pairs = INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(entries), [
					(entry: (typeof entries)[number]) => [entry.key, entry.guard],
				])
				const map = INTRINSICS.rebase(
					INTRINSICS.record<Guard<unknown>>({
						[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [
							pairs,
						]),
					}),
					null,
				)
				const optionalKeys: readonly string[] = INTRINSICS.reflect.apply(
					INTRINSICS.expand,
					readIndexView(entries),
					[(entry: (typeof entries)[number]) => (entry.optional ? [entry.key] : [])],
				)
				const extra = owned.additionalProperties
				const closed = extra === undefined || extra === false
				const additional = closed || extra === true ? undefined : this.#guardAt(extra)
				// Indexed, not `filter`/`includes`: both are caller-writable members of
				// `Array.prototype` reached by name, one line before a boundary whose own
				// comment promises this walk never throws.
				const required: readonly string[] = INTRINSICS.reflect.apply(
					INTRINSICS.select,
					readIndexView(INTRINSICS.keys(map)),
					[
						(key: string) =>
							!INTRINSICS.reflect.apply(INTRINSICS.some, optionalKeys, [
								(optional: string) => optional === key,
							]),
					],
				)
				// The required keys are fixed here, so their presence question is
				// answered by one integer rather than by a per-call vocabulary: each
				// required key takes a bit position here, and a call ORs one bit per own
				// key it recognizes and compares the result against the full mask. The
				// record is null-prototype own data so a key literally named
				// '__proto__' takes a position like any other. Past the mask's width
				// the following collected-vocabulary form still answers.
				const maskable = required.length <= PRESENCE_MASK_LIMIT
				const positions = buildPositions(maskable ? required : [])
				const full = maskable ? readPresence(required, positions) : 0
				const plans = closed ? new KeyPlanCache(map) : undefined
				return (value: unknown): value is unknown => {
					if (!isRecord(value)) return false
					// Contain the whole key-enumeration + value-read walk — an untrusted
					// getter on `value`, or a replaced `globalThis.Set` reached by the
					// presence view, must yield `false`, never throw, as
					// `.claude/rules/patterns.md` § Validation and contracts requires.
					// The key list is this walk's own, so the captured array methods read
					// it without reaching any caller member.
					return holds(() => {
						const keys: readonly string[] = INTRINSICS.keys(value)
						if (extra !== true && !matchesEnumerableKeys(value, keys)) return false
						const plan = plans?.recall(keys)
						if (plan !== undefined) {
							return INTRINSICS.reflect.apply(INTRINSICS.every, plan, [matchesStepGuard, value])
						}
						if (maskable) {
							if (readPresence(keys, positions) !== full) return false
						} else {
							const present = collectMembers(keys)
							const missing: boolean = INTRINSICS.reflect.apply(INTRINSICS.some, required, [
								(key: string) => !matchesMember(present, key),
							])
							if (missing) return false
						}
						const refused: boolean = INTRINSICS.reflect.apply(INTRINSICS.some, keys, [
							(key: string) => {
								const guard = INTRINSICS.own(map, key) ? map[key] : undefined
								if (guard !== undefined) return !guard(value[key])
								if (closed) return true
								// An open object declares an undeclared key UNCONSTRAINED, not
								// UNOBSERVED. The compiled parser copies every one of them into
								// its result, so a guard that skipped the read certified a value
								// its own parser then refused as unreadable — `is` true, `audit`
								// and `explain` empty, `parse` throwing, on one input. The read is
								// the advertised read of the open-object domain; its RESULT is
								// only tested when a tail shape constrains it.
								const observed: unknown = value[key]
								return additional !== undefined && !additional(observed)
							},
						])
						if (refused) return false
						plans?.retain(keys)
						return true
					})
				}
			}
			case 'union': {
				const guards: Array<Guard<unknown>> = INTRINSICS.reflect.apply(
					INTRINSICS.expand,
					readIndexView(owned.variants),
					[
						(variant: ContractShape | undefined) =>
							variant === undefined ? [] : [this.#guardAt(variant)],
					],
				)
				// The arm a value's discriminant names answers alone in both modes, as it does at
				// every other door; a value that names none takes the every-arm rule.
				const discriminated = this.#discriminate(owned)
				// A `oneOf`-mode union matches the emitted JSON Schema `oneOf` keyword —
				// EXACTLY one variant must guard-accept the value, not "at least one"
				// (unionOf's anyOf semantics). A value matching two-or-more variants is
				// rejected, because it would violate the compiled schema.
				if (owned.mode === 'oneOf') {
					return (value: unknown): value is unknown => {
						const arm = discriminated?.select(value)
						const named = arm === undefined ? undefined : guards[arm]
						if (named !== undefined) return holds(() => named(value))
						const matched: number = INTRINSICS.reflect.apply(INTRINSICS.fold, guards, [
							(total: number, guard: Guard<unknown>) => total + (guard(value) ? 1 : 0),
							0,
						])
						return matched === 1
					}
				}
				// `Reflect.apply` reads its argument list by index (CreateListFromArrayLike),
				// where `unionOf(...guards)` would spread through the array iterator.
				const union: Guard<unknown> = INTRINSICS.reflect.apply(unionOf, undefined, guards)
				if (discriminated === undefined) return union
				return (value: unknown): value is unknown => {
					const arm = discriminated.select(value)
					const named = arm === undefined ? undefined : guards[arm]
					return named !== undefined ? holds(() => named(value)) : union(value)
				}
			}
			case 'optional':
				return orOf(isUndefined, this.#guardAt(owned.inner))
			case 'nullable':
				return nullableOf(this.#guardAt(owned.inner))
			case 'interface': {
				// The tracked audit, so a scope that already holds its clean verdict reads no member again.
				const audit = this.#auditAt(owned)
				return (value: unknown): value is unknown =>
					holds(() => audit(value, ContractCompiler.#root).length === 0)
			}
			case 'raw':
				return (value: unknown): value is unknown => value !== undefined
		}
	}

	// === Parser family

	#buildParser(): Parser<unknown> {
		const ready = this.#parser
		if (ready !== undefined) return ready
		this.#prepare()
		if (this.#unions() || this.#defaults()) this.#buildGuard()
		if (this.#interfaces()) this.#planAudits()
		for (const step of iterateIndices(() => this.#order.length)) {
			const index = this.#order[step]
			if (index === undefined) continue
			this.#parsers[index] = this.#parserOf(index)
		}
		const root = this.#parserAt(this.#node(0))
		this.#parser = root
		return root
	}

	#parserAt(shape: ContractShape): Parser<unknown> {
		const compiled = this.#parsers[this.#locate(shape)]
		if (compiled === undefined) {
			throw new ContractError('ContractCompiler: a child parser is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		return compiled
	}

	#parserOf(index: number): Parser<unknown> {
		const owned = this.#node(index)
		switch (owned.category) {
			case 'string': {
				if (
					owned.min === undefined &&
					owned.max === undefined &&
					owned.pattern === undefined &&
					owned.date !== true
				) {
					return parseString
				}
				// Coerce by type, then re-apply the SAME refinement the guard enforces (the
				// identical `stringOf`) — a value that parses but violates a bound or the
				// pattern fails the parse (returns `undefined`).
				const guard = this.#stringGuard(owned)
				return (value) => {
					const parsed = parseString(value)
					return parsed !== undefined && guard(parsed) ? parsed : undefined
				}
			}
			case 'number': {
				const base = owned.integer === true ? parseInteger : parseNumber
				// The same range the guard applies (integrality is already enforced by
				// `parseInteger`, so only the bounds need re-checking after coercion).
				const within = this.#rangeOf(owned)
				if (within === undefined) return base
				return (value) => {
					const parsed = base(value)
					return parsed !== undefined && within(parsed) ? parsed : undefined
				}
			}
			case 'boolean':
				return parseBoolean
			case 'null':
				return (value) => (value === null ? null : undefined)
			case 'json':
				return parseJSONValue
			case 'function':
				return (value) => (isFunction(value) ? value : undefined)
			// Every answer is `undefined`, the value on success and the sentinel on failure, so a
			// container reads the raw value and `#admits`, never this result.
			case 'undefined':
				return () => undefined
			case 'shape':
				return (value) => (ContractCompiler.#acceptShape(value) ? value : undefined)
			// The literal parser trims a matching string but never numeric-coerces —
			// `'42'` never parses to the literal `42`; only an exact (post-trim) match
			// of one of the shape's `values` succeeds. This is an intended leniency,
			// not a soundness gap: a trimmed value is re-checked against `allowed`,
			// the same `literalOf` guard the compiled guard uses.
			case 'literal': {
				const allowed = literalOf(owned.values)
				return (value) => {
					if (allowed(value)) return value
					if (isString(value)) {
						const trimmed = value.trim()
						if (allowed(trimmed)) return trimmed
					}
					return undefined
				}
			}
			case 'array': {
				const item = this.#parserAt(owned.items)
				const admitted = this.#admits(owned.items)
				const unbounded = owned.min === undefined && owned.max === undefined
				const withinLength = boundsOf(owned.min, owned.max)
				return (value) => {
					if (isObject(value)) {
						readValue(() => INTRINSICS.array(value), 'compileParser', {
							subject: 'array',
							context: { shape: 'array' },
						})
					}
					if (!isArray(value)) return undefined
					const entries = readArrayEntries(value)
					if (isFailure(entries)) {
						return readValue(
							() => {
								throw entries.error
							},
							'compileParser',
							{ subject: 'array', context: { shape: 'array' } },
						)
					}
					if (!entries.value.dense) return undefined
					const result: unknown[] = []
					for (const entryIndex of iterateIndices(() => entries.value.entries.length)) {
						// Indexed rather than iterated, and read in place, so no element is
						// silently dropped from the assembled result.
						const entry = entries.value.entries[entryIndex]
						// The read is dense, so this `undefined` is present, and an element that admits it keeps it.
						if (entry === undefined && admitted) {
							result[result.length] = undefined
							continue
						}
						const parsed = item(entry)
						if (parsed === undefined) return undefined
						result[result.length] = parsed
					}
					// Enforce the SAME length bounds the guard does (coercion never changes
					// length, so this is checked once on the assembled result).
					return unbounded || withinLength(result.length) ? result : undefined
				}
			}
			// A closed object (no `additionalProperties`) silently drops unknown keys
			// present on the input rather than failing the parse — an intended
			// coercion leniency, and an observable one. The compiled guard rejects
			// such an input, so `parse` returning a value never implies `is` accepted
			// what it was handed: `parse({ id: 'a', debug: true })` answers
			// `{ id: 'a' }` for a shape whose `is` says false. The compiled reporter
			// mirrors this parser and reports nothing for a dropped key; the compiled
			// auditor is the artifact that reports it, one `'extra'` fault per
			// undeclared key.
			case 'object': {
				const keyList = INTRINSICS.keys(owned.properties)
				const entries: ReadonlyArray<{
					readonly key: string
					readonly parse: Parser<unknown>
					readonly optional: boolean
					readonly fill: JSONValue | undefined
					readonly admits: boolean
				}> = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(keyList), [
					(key: string) => {
						const child = owned.properties[key]
						if (child === undefined) return []
						const optional = child.category === 'optional'
						const inner = optional ? child.inner : child
						return [
							{
								key,
								parse: this.#parserAt(inner),
								optional,
								fill: optional && INTRINSICS.own(child, 'default') ? child.default : undefined,
								admits: this.#admits(inner),
							},
						]
					},
				])
				const known = readValue(
					() =>
						collectMembers(
							INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(entries), [
								(entry: { readonly key: string }) => entry.key,
							]),
						),
					'compileParser',
					{
						subject: 'object',
						context: { shape: 'object' },
					},
				)
				// One bit position per declared entry, assigned here because the entry
				// list is fixed here: a call then reads presence as a bit test instead
				// of a membership dispatch per entry. Null-prototype own data, so an
				// entry named '__proto__' takes a position like any other. Past the
				// mask's width the collected-vocabulary form still answers.
				const maskable = entries.length <= PRESENCE_MASK_LIMIT
				const positions = buildPositions(
					maskable
						? INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(entries), [
								(entry: { readonly key: string }) => entry.key,
							])
						: [],
				)
				const extra = owned.additionalProperties
				const additional =
					extra === undefined || extra === false || extra === true
						? undefined
						: this.#parserAt(extra)
				const admitted =
					extra === undefined || extra === false || extra === true ? false : this.#admits(extra)
				const open = extra === true || additional !== undefined
				return (value) => {
					// A brand check, not `parseRecord`: that door's eager whole-record
					// `Object.values` probe reads EVERY own enumerable value, including
					// undeclared keys this parser is about to DROP. A closed object shape
					// whose input carried one throwing extra therefore refused as
					// unreadable while `explain` — which never performs that probe —
					// published the empty report that means "parse will succeed". The
					// reads this parser genuinely needs are the following per-key reads, and
					// they are already contained.
					if (!isRecord(value)) return undefined
					const record = value
					const keys = enumerableKeys(record)
					if (keys === undefined) return undefined
					// Contain the whole record walk — an untrusted getter on `record`, or a
					// replaced `globalThis.Set` reached by the presence view, must yield
					// `undefined`, never throw, as `.claude/rules/patterns.md`
					// § Validation and contracts requires.
					const outcome = attempt(() => {
						const present = maskable ? undefined : collectMembers(keys)
						const seen = present === undefined ? readPresence(keys, positions) : 0
						// Honest typing: a null-prototype accumulator so an input own key
						// literally named '__proto__' lands as an own data key instead of
						// mutating the prototype (same pattern as `pickOf`).
						const selected: Array<readonly [string, unknown]> = []
						// The entry list is this compiler's own and the key list this walk's own,
						// so the captured method reads each in order and reaches no caller member.
						// A step answers `true` to refuse the whole record.
						const refused: boolean = INTRINSICS.reflect.apply(INTRINSICS.some, entries, [
							(entry: (typeof entries)[number], entryIndex: number) => {
								const absent =
									present === undefined
										? (seen & (1 << entryIndex)) === 0
										: !matchesMember(present, entry.key)
								const raw = absent ? undefined : record[entry.key]
								if (raw === undefined) {
									// A present `undefined` its child admits is the member's value, so its key stays.
									if (!absent && entry.admits) {
										selected[selected.length] = [entry.key, undefined]
										return false
									}
									if (!entry.optional) return true
									// A container parses from a fresh copy, so nested defaults apply and no
									// two results share a tree, whichever parser the inner shape holds.
									if (entry.fill !== undefined) {
										const fill = isObject(entry.fill) ? cloneJSONValue(entry.fill) : entry.fill
										selected[selected.length] = [entry.key, entry.parse(fill)]
									}
									return false
								}
								const parsed = entry.parse(raw)
								if (parsed === undefined) return true
								selected[selected.length] = [entry.key, parsed]
								return false
							},
						])
						if (refused) return undefined
						const extras: boolean =
							open &&
							INTRINSICS.reflect.apply(INTRINSICS.some, keys, [
								(key: string) => {
									if (matchesMember(known, key)) return false
									if (additional === undefined) {
										selected[selected.length] = [key, record[key]]
										return false
									}
									const observed: unknown = record[key]
									if (observed === undefined && admitted) {
										selected[selected.length] = [key, undefined]
										return false
									}
									const parsed = additional(observed)
									if (parsed === undefined) return true
									selected[selected.length] = [key, parsed]
									return false
								},
							])
						if (extras) return undefined
						return INTRINSICS.rebase(
							INTRINSICS.record<unknown>({
								[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [
									selected,
								]),
							}),
							null,
						)
					})
					if (isSuccess(outcome)) return outcome.value
					if (isContractError(outcome.error)) throw outcome.error
					return readValue(
						() => {
							throw outcome.error
						},
						'compileParser',
						{ subject: 'object', context: { shape: 'object' } },
					)
				}
			}
			case 'union': {
				const variants: ReadonlyArray<{
					readonly parse: Parser<unknown>
					readonly guard: Guard<unknown>
				}> = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(owned.variants), [
					(variant: ContractShape | undefined) =>
						variant === undefined
							? []
							: [
									{
										parse: this.#parserAt(variant),
										guard: this.#guardAt(variant),
									},
								],
				])
				const discriminated = this.#discriminate(owned)
				// `oneOf` exactly-one semantics (documented on `oneOfShape`): judged on
				// the RAW input's guard matches only — no coercion fallback. Exactly one
				// variant's guard must accept the raw value; preserve that value by
				// identity so rebuilding cannot change which variants accept it.
				// Zero matches (no variant fits) or two-or-more matches (ambiguous —
				// which variant the value belongs to isn't well-defined) both fail the
				// parse, deliberately simpler than attempting a coercion-then-recheck
				// resolution for ambiguous input.
				if (owned.mode === 'oneOf') {
					return (value) => {
						const selected = discriminated?.select(value)
						const arm = selected === undefined ? undefined : variants[selected]
						if (arm !== undefined) return ContractCompiler.#parseArm(arm, value)
						// Indexed, not `filter`: an array prototype method decides how many
						// variants matched, and a substitute answering a rigged list decides
						// what this parser publishes.
						const matching: ReadonlyArray<{
							readonly parse: Parser<unknown>
							readonly guard: Guard<unknown>
						}> = INTRINSICS.reflect.apply(INTRINSICS.select, readIndexView(variants), [
							(variant: { readonly guard: Guard<unknown> }) => variant.guard(value),
						])
						const only = matching[0]
						return matching.length === 1 && only !== undefined ? value : undefined
					}
				}
				return (value) => {
					const selected = discriminated?.select(value)
					const arm = selected === undefined ? undefined : variants[selected]
					if (arm !== undefined) return ContractCompiler.#parseArm(arm, value)
					// Identity pass first, so guard-valid input is never rejected by its
					// parser (`.claude/rules/patterns.md` § Validation and contracts): a
					// value already valid against ANY variant's guard is returned
					// unchanged, so an earlier variant's coercion never overwrites it.
					for (const variantIndex of iterateIndices(() => variants.length)) {
						const variant = variants[variantIndex]
						if (variant === undefined) continue
						if (variant.guard(value)) return value
					}
					// Coercion pass: no variant matched as-is, so parse-then-guard,
					// first variant that both parses and guards wins.
					for (const variantIndex of iterateIndices(() => variants.length)) {
						const variant = variants[variantIndex]
						if (variant === undefined) continue
						const parsed = variant.parse(value)
						if (parsed !== undefined && variant.guard(parsed)) return parsed
					}
					return undefined
				}
			}
			case 'optional': {
				const inner = this.#parserAt(owned.inner)
				return (value) => (value === undefined ? undefined : inner(value))
			}
			case 'nullable': {
				const inner = this.#parserAt(owned.inner)
				return (value) => (value === null ? null : inner(value))
			}
			// The guard's own question, asked of the tracked audit, so the value returns by identity
			// and a scope that already holds the clean verdict reads no member again. A failed member
			// read refuses, as a failed required object read does.
			case 'interface': {
				const audit = this.#auditAt(owned)
				return (value) => {
					const outcome = attempt(() => audit(value, ContractCompiler.#root))
					if (isSuccess(outcome)) return outcome.value.length === 0 ? value : undefined
					if (isContractError(outcome.error)) throw outcome.error
					return readValue(
						() => {
							throw outcome.error
						},
						'compileParser',
						{ subject: 'interface', context: { shape: 'interface' } },
					)
				}
			}
			case 'raw':
				return (value) => value
		}
	}

	// === Auditor family

	#buildAuditor(): AuditorFunction {
		const ready = this.#auditor
		if (ready !== undefined) return ready
		this.#prepare()
		if (this.#defaults()) this.#buildGuard()
		this.#planAudits()
		const root = this.#exposeAudit(this.#auditAt(this.#node(0)))
		this.#auditor = root
		return root
	}

	// Planned one time, by the auditor or by whichever family an interface sends here first.
	#planAudits(): void {
		if (this.#audits.length > 0) return
		for (const step of iterateIndices(() => this.#order.length)) {
			const index = this.#order[step]
			if (index === undefined) continue
			const plan = this.#auditOf(index)
			this.#audits[index] = this.#repeats(index) ? this.#trackFaults(plan) : plan
		}
	}

	// An interface's declared members, each with its child's tracked audit. An optional member
	// audits its inner shape, and `admits` says whether that shape reads `undefined` as clean.
	#membersOf(owned: InterfaceShape): ReadonlyArray<{
		readonly key: string
		readonly audit: (value: unknown, path: readonly string[]) => readonly AuditFault[]
		readonly optional: boolean
		readonly admits: boolean
		readonly kind: FaultKind
	}> {
		return INTRINSICS.reflect.apply(
			INTRINSICS.expand,
			readIndexView(INTRINSICS.keys(owned.members)),
			[
				(key: string) => {
					const child = owned.members[key]
					if (child === undefined) return []
					const optional = child.category === 'optional'
					const inner = optional ? child.inner : child
					return [
						{
							key,
							audit: this.#auditAt(inner),
							optional,
							admits: this.#admits(inner),
							kind: shapeToKind(inner),
						},
					]
				},
			],
		)
	}

	// The published root supplies the documented default root path and carries the
	// door boundary around the whole walk, so a host failure under an untrusted value
	// publishes this package's error class rather than the caller's raw value.
	#exposeAudit(
		plan: (value: unknown, path: readonly string[]) => readonly AuditFault[],
	): AuditorFunction {
		return (value: unknown, path: readonly string[] = []): readonly AuditFault[] =>
			contain(() => plan(value, path), 'compileAuditor')
	}

	#auditAt(
		shape: ContractShape,
	): (value: unknown, path: readonly string[]) => readonly AuditFault[] {
		const compiled = this.#audits[this.#locate(shape)]
		if (compiled === undefined) {
			throw new ContractError('ContractCompiler: a child auditor is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		return compiled
	}

	#auditOf(index: number): (value: unknown, path: readonly string[]) => readonly AuditFault[] {
		const owned = this.#node(index)
		switch (owned.category) {
			// A leaf's refinement fields are fixed when its plan is built, exactly as
			// its `kind` is, so a declaration carrying none has no refinement report
			// to build at all: the only question such a leaf asks is the type test
			// before the gate, and its answer past that test is empty for every
			// accepted value. The helper stays the single source for every REFINED
			// leaf and is entered unchanged there — the gate decides whether the leaf
			// has a refinement question, never how one is answered. Each clean answer
			// is its own array, because a report's identity is the caller's.
			case 'string': {
				const node: StringShape = owned
				// The clone's `pattern` is an ACCESSOR that mints a fresh frozen
				// `RegExp` per read, so the plan reads it once and carries its
				// stateless rebuild into every answer instead of rebuilding one per
				// value. The rebuild is safe to share exactly because `readPattern`
				// strips `g` and `y`: it holds no `lastIndex` an answer could move.
				// `ownPattern` takes that read, and this door publishes only a
				// `ContractError`, so an unreadable source or flags refuses with the
				// same `pattern` code and `{ shape: 'string' }` context the schema leaf
				// publishes.
				const declared = owned.pattern
				const kind: FaultKind = owned.date === true ? 'date' : 'string'
				const refined =
					owned.min !== undefined ||
					owned.max !== undefined ||
					declared !== undefined ||
					owned.date === true
				const pattern = declared === undefined ? undefined : ownPattern(declared, 'compileAuditor')
				return (value, path) => {
					if (!isString(value)) {
						return [{ reason: 'type', path, expected: kind, received: preview(value) }]
					}
					return refined ? buildStringFaults(node, value, path, pattern) : []
				}
			}
			case 'number': {
				const node: NumberShape = owned
				const kind: FaultKind = owned.integer === true ? 'integer' : 'number'
				const refined =
					owned.integer === true ||
					owned.min !== undefined ||
					owned.over !== undefined ||
					owned.max !== undefined ||
					owned.under !== undefined
				return (value, path) => {
					if (!isFiniteNumber(value)) {
						return [{ reason: 'type', path, expected: kind, received: preview(value) }]
					}
					return refined ? buildNumberFaults(node, value, path) : []
				}
			}
			case 'boolean':
				return (value, path) =>
					isBoolean(value)
						? []
						: [{ reason: 'type', path, expected: 'boolean', received: preview(value) }]
			case 'null':
				return (value, path) =>
					value === null
						? []
						: [{ reason: 'type', path, expected: 'null', received: preview(value) }]
			case 'json':
				return (value, path) =>
					isJSONValue(value)
						? []
						: [{ reason: 'type', path, expected: 'json', received: preview(value) }]
			case 'function':
				return (value, path) =>
					isFunction(value)
						? []
						: [{ reason: 'type', path, expected: 'function', received: preview(value) }]
			case 'undefined':
				return (value, path) =>
					value === undefined
						? []
						: [{ reason: 'type', path, expected: 'undefined', received: preview(value) }]
			case 'shape':
				return (value, path) =>
					ContractCompiler.#acceptShape(value)
						? []
						: [{ reason: 'type', path, expected: 'shape', received: preview(value) }]
			case 'literal': {
				const allowed = literalOf(owned.values)
				return (value, path) =>
					allowed(value)
						? []
						: [{ reason: 'type', path, expected: 'literal', received: preview(value) }]
			}
			case 'array': {
				const node: ArrayShape = owned
				const item = this.#auditAt(owned.items)
				const admitted = this.#admits(owned.items)
				const kind = shapeToKind(owned.items)
				return (value, path) => {
					if (isObject(value)) {
						readValue(() => INTRINSICS.array(value), 'compileAuditor', {
							subject: 'array',
							context: { path, shape: 'array' },
						})
					}
					if (!isArray(value)) {
						return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
					}
					const entries = readArrayEntries(value)
					if (isFailure(entries)) {
						return readValue(
							() => {
								throw entries.error
							},
							'compileAuditor',
							{ subject: 'array', context: { path, shape: 'array' } },
						)
					}
					const faults: AuditFault[] = []
					for (const entryIndex of iterateIndices(() => entries.value.entries.length)) {
						if (faults.length >= FAULT_LIMIT) break
						const at = INTRINSICS.text(entryIndex)
						// A hole is an absent element, which an element that admits `undefined` reads as clean.
						if (admitted && !entries.value.dense && !INTRINSICS.own(entries.value.entries, at)) {
							faults[faults.length] = { reason: 'missing', path: pathOf(path, at), expected: kind }
							continue
						}
						appendEntries(faults, item(entries.value.entries[entryIndex], pathOf(path, at)))
					}
					appendEntries(faults, buildArrayFaults(node, entries.value.entries.length, path))
					if (entries.value.exact) return limitEntries(faults, FAULT_LIMIT)
					// The own keys the snapshot holds no index for, read once on this diagnostic path
					// and classified by membership alone: no descriptor and no member value is read.
					const snapshot = entries.value.entries
					const members = readValue(() => INTRINSICS.reflect.members(value), 'compileAuditor', {
						subject: 'array',
						context: { path, shape: 'array' },
					})
					for (const memberIndex of iterateIndices(() => members.length)) {
						const member = members[memberIndex]
						if (faults.length >= FAULT_LIMIT) break
						if (isString(member)) {
							if (!INTRINSICS.own(snapshot, member)) {
								faults[faults.length] = { reason: 'extra', path: pathOf(path, member) }
							}
						} else if (member !== undefined) {
							faults[faults.length] = { reason: 'extra', path, symbol: preview(member) }
						}
					}
					return limitEntries(faults, FAULT_LIMIT)
				}
			}
			case 'object': {
				const declaredKeys = INTRINSICS.keys(owned.properties)
				const entries: ReadonlyArray<{
					readonly key: string
					readonly audit: (value: unknown, path: readonly string[]) => readonly AuditFault[]
					readonly optional: boolean
					readonly kind: FaultKind
				}> = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(declaredKeys), [
					(key: string) => {
						const child = owned.properties[key]
						if (child === undefined) return []
						const optional = child.category === 'optional'
						const inner = optional ? child.inner : child
						return [
							{
								key,
								audit: this.#auditAt(inner),
								optional,
								kind: shapeToKind(inner),
							},
						]
					},
				])
				const extra = owned.additionalProperties
				const closed = extra === undefined || extra === false
				const additional = closed || extra === true ? undefined : this.#auditAt(extra)
				// The declared vocabulary is a compile-time constant, so it is built
				// once here rather than rebuilt on every report. One bit position per
				// declared entry answers the per-entry presence question the same way,
				// with a bit test in place of a membership dispatch; past the mask's
				// width the collected-vocabulary form still answers.
				//
				// Plan time is not a call, so it has no path to name and no refusal to
				// publish: this build is contained by `attempt` and holds `undefined`
				// when it fails. A `globalThis.Set` replaced before this module loaded,
				// and so captured into `INTRINSICS`, is what makes it fail. The call
				// rebuilds it inside the walk's own containment, where that failure
				// reaches the coded refusal this door publishes, carrying the path.
				const planned = attempt(() => collectMembers(declaredKeys))
				const declared = isSuccess(planned) ? planned.value : undefined
				const maskable = entries.length <= PRESENCE_MASK_LIMIT
				const positions = buildPositions(
					maskable
						? INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(entries), [
								(entry: { readonly key: string }) => entry.key,
							])
						: [],
				)
				return (value, path) => {
					if (isObject(value)) {
						readValue(() => INTRINSICS.reflect.prototype(value), 'compileAuditor', {
							subject: 'object',
							context: { path, shape: 'object' },
						})
					}
					if (!isRecord(value)) {
						return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
					}
					const record = value
					const keys = readValue(
						() => INTRINSICS.freeze(INTRINSICS.keys(record)),
						'compileAuditor',
						{ subject: 'object', context: { path, shape: 'object' } },
					)
					const faults: AuditFault[] = []
					// The value-side presence view is built inside the contained walk, and
					// the declared vocabulary rebuilt there whenever its plan-time build
					// failed: a replaced `globalThis.Set` must reach the auditor's own
					// containment rather than throw the caller's raw value out of a report
					// this door answers.
					const outcome = attempt(() => {
						const present = maskable ? undefined : collectMembers(keys)
						const vocabulary = declared ?? collectMembers(declaredKeys)
						const seen = present === undefined ? readPresence(keys, positions) : 0
						// The own names outside the enumerable view, read once and classified
						// by membership alone: no descriptor and no member value is read, so a
						// key a `Proxy` lists with no descriptor is still named.
						const listed = present ?? collectMembers(keys)
						const outside: readonly string[] =
							extra === true
								? []
								: INTRINSICS.reflect.apply(
										INTRINSICS.select,
										readIndexView(INTRINSICS.names(record)),
										[(name: string) => !matchesMember(listed, name)],
									)
						const concealed = collectMembers(outside)
						for (const entryIndex of iterateIndices(() => entries.length)) {
							const entry = entries[entryIndex]
							if (entry === undefined) continue
							if (faults.length >= FAULT_LIMIT) return
							const absent =
								present === undefined
									? (seen & (1 << entryIndex)) === 0
									: !matchesMember(present, entry.key)
							if (absent) {
								if (matchesMember(concealed, entry.key)) {
									faults[faults.length] = { reason: 'hidden', path: pathOf(path, entry.key) }
								} else if (!entry.optional) {
									faults[faults.length] = {
										reason: 'missing',
										path: pathOf(path, entry.key),
										expected: entry.kind,
									}
								}
								continue
							}
							appendEntries(faults, entry.audit(record[entry.key], pathOf(path, entry.key)))
						}
						for (const keyIndex of iterateIndices(() => keys.length)) {
							const key = keys[keyIndex]
							if (key === undefined) continue
							if (faults.length >= FAULT_LIMIT) return
							if (matchesMember(vocabulary, key)) continue
							if (closed) {
								faults[faults.length] = { reason: 'extra', path: pathOf(path, key) }
								continue
							}
							// The same advertised read the compiled guard performs on an open
							// object's undeclared key, so this report cannot call a value clean
							// that `is` rejects and `parse` refuses as unreadable.
							const observed: unknown = record[key]
							if (additional !== undefined) {
								appendEntries(faults, additional(observed, pathOf(path, key)))
							}
						}
						for (const nameIndex of iterateIndices(() => outside.length)) {
							const name = outside[nameIndex]
							if (name === undefined || matchesMember(vocabulary, name)) continue
							if (faults.length >= FAULT_LIMIT) return
							faults[faults.length] = {
								reason: closed ? 'extra' : 'hidden',
								path: pathOf(path, name),
							}
						}
						const symbols = extra === true ? [] : INTRINSICS.symbols(record)
						for (const symbolIndex of iterateIndices(() => symbols.length)) {
							if (faults.length >= FAULT_LIMIT) return
							faults[faults.length] = {
								reason: 'extra',
								path,
								symbol: preview(symbols[symbolIndex]),
							}
						}
					})
					if (isFailure(outcome)) {
						if (isContractError(outcome.error)) throw outcome.error
						return readValue(
							() => {
								throw outcome.error
							},
							'compileAuditor',
							{ subject: 'object', context: { path, shape: 'object' } },
						)
					}
					return limitEntries(faults, FAULT_LIMIT)
				}
			}
			case 'union': {
				const plans: Array<(value: unknown, path: readonly string[]) => readonly AuditFault[]> =
					INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(owned.variants), [
						(variant: ContractShape | undefined) =>
							variant === undefined ? [] : [this.#auditAt(variant)],
					])
				const exclusive = owned.mode === 'oneOf'
				const count = owned.variants.length
				const discriminated = this.#discriminate(owned)
				return (value, path) => {
					const selected = discriminated?.select(value)
					const arm = selected === undefined ? undefined : plans[selected]
					if (arm !== undefined) return arm(value, path)
					const perVariant: Array<readonly AuditFault[]> = []
					for (const index2 of iterateIndices(() => plans.length)) {
						const plan = plans[index2]
						if (plan === undefined) continue
						const variantFaults = plan(value, path)
						if (variantFaults.length === 0) {
							// An `anyOf` verdict is settled by the FIRST clean variant in
							// declaration order, so no later variant plan runs for a value an
							// earlier variant already accepted. That is the stop the compiled
							// guard and parser already make, and joining it is what keeps a
							// later object variant's prototype probe from publishing a coded
							// refusal for a value `is` answers `true` for. A `oneOf` verdict is
							// the match count over every variant, so it reads all of them.
							if (!exclusive) return []
						}
						perVariant[perVariant.length] = variantFaults
					}
					const matched: number = INTRINSICS.reflect.apply(INTRINSICS.fold, perVariant, [
						(total: number, faults: readonly AuditFault[]) => total + (faults.length === 0 ? 1 : 0),
						0,
					])
					if (exclusive) {
						if (matched === 1) return []
						if (matched > 1) return [{ reason: 'oneOf', path, matched, ...discriminated?.hint }]
					}
					const closest = selectClosestFaults(perVariant)
					const report: AuditFault[] = [
						exclusive
							? { reason: 'oneOf', path, matched: 0, ...discriminated?.hint }
							: { reason: 'variant', path, variants: count, ...discriminated?.hint },
					]
					appendEntries(report, closest)
					return limitEntries(report, FAULT_LIMIT)
				}
			}
			case 'optional': {
				const inner = this.#auditAt(owned.inner)
				return (value, path) => (value === undefined ? [] : inner(value, path))
			}
			case 'nullable': {
				const inner = this.#auditAt(owned.inner)
				return (value, path) => (value === null ? [] : inner(value, path))
			}
			// Each declared member is read one time and its value handed to the child, and an
			// undeclared member is never read, so an implementation answers through its prototype.
			case 'interface': {
				const entries = this.#membersOf(owned)
				return (value, path) => {
					if (isObject(value)) {
						readValue(() => INTRINSICS.array(value), 'compileAuditor', {
							subject: 'interface',
							context: { path, shape: 'interface' },
						})
					}
					if ((!isObject(value) && !isFunction(value)) || isArray(value)) {
						return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
					}
					const faults: AuditFault[] = []
					for (const entryIndex of iterateIndices(() => entries.length)) {
						const entry = entries[entryIndex]
						if (entry === undefined) continue
						if (faults.length >= FAULT_LIMIT) break
						const at = pathOf(path, entry.key)
						const member: unknown = readValue(
							() => INTRINSICS.reflect.read(value, entry.key),
							'compileAuditor',
							{ subject: 'interface member', context: { path: at, shape: 'interface' } },
						)
						if (member === undefined && !entry.admits) {
							if (!entry.optional) {
								faults[faults.length] = { reason: 'missing', path: at, expected: entry.kind }
							}
							continue
						}
						appendEntries(faults, entry.audit(member, at))
					}
					return limitEntries(faults, FAULT_LIMIT)
				}
			}
			case 'raw':
				return (value, path) =>
					value === undefined
						? [{ reason: 'type', path, expected: 'json', received: preview(value) }]
						: []
		}
	}

	// === Reporter family

	#buildReporter(): ReporterFunction {
		const ready = this.#reporter
		if (ready !== undefined) return ready
		this.#prepare()
		if (this.#unions() || this.#defaults()) this.#buildGuard()
		if (this.#interfaces()) this.#planAudits()
		for (const step of iterateIndices(() => this.#order.length)) {
			const index = this.#order[step]
			if (index === undefined) continue
			const plan = this.#reportOf(index)
			this.#reports[index] = this.#repeats(index) ? this.#trackFaults(plan) : plan
		}
		const root = this.#exposeReport(this.#reportAt(this.#node(0)))
		this.#reporter = root
		return root
	}

	#exposeReport(
		plan: (value: unknown, path: readonly string[]) => readonly Fault[],
	): ReporterFunction {
		return (value: unknown, path: readonly string[] = []): readonly Fault[] =>
			contain(() => plan(value, path), 'compileReporter')
	}

	#reportAt(shape: ContractShape): (value: unknown, path: readonly string[]) => readonly Fault[] {
		const compiled = this.#reports[this.#locate(shape)]
		if (compiled === undefined) {
			throw new ContractError('ContractCompiler: a child reporter is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		return compiled
	}

	#reportOf(index: number): (value: unknown, path: readonly string[]) => readonly Fault[] {
		const owned = this.#node(index)
		switch (owned.category) {
			// The same compile-time gate the auditor's leaves carry, over the COERCED
			// value: the two doors differ in how they obtain the primitive and not in
			// what an unrefined declaration has to say about it.
			case 'string': {
				const node: StringShape = owned
				// The same one-time pattern read the auditor's leaf takes, for the same
				// accessor and the same reason; see `#auditOf`.
				const declared = owned.pattern
				const kind: FaultKind = owned.date === true ? 'date' : 'string'
				const refined =
					owned.min !== undefined ||
					owned.max !== undefined ||
					declared !== undefined ||
					owned.date === true
				const pattern = declared === undefined ? undefined : ownPattern(declared, 'compileReporter')
				return (value, path) => {
					const parsed = parseString(value)
					if (parsed === undefined) {
						return [{ reason: 'type', path, expected: kind, received: preview(value) }]
					}
					return refined ? buildStringFaults(node, parsed, path, pattern) : []
				}
			}
			case 'number': {
				const node: NumberShape = owned
				const kind: FaultKind = owned.integer === true ? 'integer' : 'number'
				const refined =
					owned.integer === true ||
					owned.min !== undefined ||
					owned.over !== undefined ||
					owned.max !== undefined ||
					owned.under !== undefined
				return (value, path) => {
					const parsed = parseNumber(value)
					if (parsed === undefined) {
						return [{ reason: 'type', path, expected: kind, received: preview(value) }]
					}
					return refined ? buildNumberFaults(node, parsed, path) : []
				}
			}
			case 'boolean':
				return (value, path) =>
					parseBoolean(value) === undefined
						? [{ reason: 'type', path, expected: 'boolean', received: preview(value) }]
						: []
			case 'null':
				return (value, path) =>
					value === null
						? []
						: [{ reason: 'type', path, expected: 'null', received: preview(value) }]
			case 'json':
				return (value, path) =>
					isJSONValue(value)
						? []
						: [{ reason: 'type', path, expected: 'json', received: preview(value) }]
			case 'function':
				return (value, path) =>
					isFunction(value)
						? []
						: [{ reason: 'type', path, expected: 'function', received: preview(value) }]
			case 'undefined':
				return (value, path) =>
					value === undefined
						? []
						: [{ reason: 'type', path, expected: 'undefined', received: preview(value) }]
			case 'literal': {
				const allowed = literalOf(owned.values)
				return (value, path) =>
					allowed(value) || (isString(value) && allowed(value.trim()))
						? []
						: [{ reason: 'type', path, expected: 'literal', received: preview(value) }]
			}
			case 'shape':
				return (value, path) =>
					ContractCompiler.#acceptShape(value)
						? []
						: [{ reason: 'type', path, expected: 'shape', received: preview(value) }]
			case 'array': {
				const node: ArrayShape = owned
				const item = this.#reportAt(owned.items)
				const admitted = this.#admits(owned.items)
				const kind = shapeToKind(owned.items)
				return (value, path) => {
					if (!isArray(value)) {
						return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
					}
					const entries = readArrayEntries(value)
					if (isFailure(entries)) {
						return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
					}
					const faults: Fault[] = []
					for (const entryIndex of iterateIndices(() => entries.value.entries.length)) {
						if (faults.length >= FAULT_LIMIT) break
						const at = INTRINSICS.text(entryIndex)
						// The parser refuses a hole, so the report names it where the element reads it as clean.
						if (admitted && !entries.value.dense && !INTRINSICS.own(entries.value.entries, at)) {
							faults[faults.length] = { reason: 'missing', path: pathOf(path, at), expected: kind }
							continue
						}
						appendEntries(faults, item(entries.value.entries[entryIndex], pathOf(path, at)))
					}
					appendEntries(faults, buildArrayFaults(node, entries.value.entries.length, path))
					return limitEntries(faults, FAULT_LIMIT)
				}
			}
			case 'object': {
				const keyList = INTRINSICS.keys(owned.properties)
				const entries: ReadonlyArray<{
					readonly key: string
					readonly report: (value: unknown, path: readonly string[]) => readonly Fault[]
					readonly optional: boolean
					readonly kind: FaultKind
					readonly admits: boolean
				}> = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(keyList), [
					(key: string) => {
						const child = owned.properties[key]
						if (child === undefined) return []
						const optional = child.category === 'optional'
						const inner = optional ? child.inner : child
						return [
							{
								key,
								report: this.#reportAt(inner),
								optional,
								kind: shapeToKind(inner),
								admits: this.#admits(inner),
							},
						]
					},
				])
				const names: readonly string[] = INTRINSICS.reflect.apply(
					INTRINSICS.project,
					readIndexView(entries),
					[(entry: (typeof entries)[number]) => entry.key],
				)
				const extra = owned.additionalProperties
				const tail =
					extra === undefined || extra === true || extra === false
						? undefined
						: this.#reportAt(extra)
				const open = extra === true || tail !== undefined
				// The declared vocabulary is a compile-time constant, so it is built
				// once here over the entry key names rather than admitted key by key on
				// every report. One bit position per declared entry answers the
				// per-entry presence question the same way, with a bit test in place of
				// a membership dispatch; past the mask's width the collected-vocabulary
				// form still answers.
				//
				// Plan time is not a call, so it has no value to report on: this build
				// is contained by `attempt` and holds `undefined` when it fails. A
				// `globalThis.Set` replaced before this module loaded, and so captured
				// into `INTRINSICS`, is what makes it fail. The call rebuilds it inside
				// the walk's own containment, which keeps this door's answer a fault
				// array in exactly the regime its totality promise names.
				const planned = attempt(() => collectMembers(names))
				const known = isSuccess(planned) ? planned.value : undefined
				const maskable = entries.length <= PRESENCE_MASK_LIMIT
				const positions = buildPositions(
					maskable
						? INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(entries), [
								(entry: { readonly key: string }) => entry.key,
							])
						: [],
				)
				return (value, path) => {
					if (!isRecord(value)) {
						return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
					}
					const record = value
					const keys = enumerableKeys(record)
					if (keys === undefined) {
						return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
					}
					const faults: Fault[] = []
					// The value-side presence view is built inside the contained walk, and
					// the declared vocabulary rebuilt there whenever its plan-time build
					// failed: a replaced `globalThis.Set` must reach the reporter's own
					// diagnostic containment rather than throw the caller's raw value out
					// of a total report.
					const outcome = attempt(() => {
						const present = maskable ? undefined : collectMembers(keys)
						const vocabulary = known ?? collectMembers(names)
						const seen = present === undefined ? readPresence(keys, positions) : 0
						for (const entryIndex of iterateIndices(() => entries.length)) {
							const entry = entries[entryIndex]
							if (entry === undefined) continue
							if (faults.length >= FAULT_LIMIT) return
							// Mirror the parser's presence gate exactly: only an own
							// enumerable string key is present. A present key with an
							// explicit `undefined` value is treated like absence unless its
							// child admits `undefined`, as `parse` treats it.
							const absent =
								present === undefined
									? (seen & (1 << entryIndex)) === 0
									: !matchesMember(present, entry.key)
							if (absent) {
								if (!entry.optional) {
									faults[faults.length] = {
										reason: 'missing',
										path: pathOf(path, entry.key),
										expected: entry.kind,
									}
								}
								continue
							}
							const raw = record[entry.key]
							if (raw === undefined && !entry.admits) {
								if (!entry.optional) {
									faults[faults.length] = {
										reason: 'missing',
										path: pathOf(path, entry.key),
										expected: entry.kind,
									}
								}
								continue
							}
							appendEntries(faults, entry.report(raw, pathOf(path, entry.key)))
						}
						// A CLOSED object's undeclared key is never read here, because `parse`
						// drops it without reading it either. An OPEN one's is, because `parse`
						// copies it — and a report that skipped that read published the empty
						// report, its documented "parse will succeed" signal, for a value
						// `parse` refused as unreadable.
						if (open) {
							for (const keyIndex of iterateIndices(() => keys.length)) {
								const key = keys[keyIndex]
								if (key === undefined) continue
								if (faults.length >= FAULT_LIMIT) return
								if (matchesMember(vocabulary, key)) continue
								const observed: unknown = record[key]
								if (tail !== undefined) {
									appendEntries(faults, tail(observed, pathOf(path, key)))
								}
							}
						}
					})
					if (isFailure(outcome)) {
						return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
					}
					return limitEntries(faults, FAULT_LIMIT)
				}
			}
			case 'union': {
				const variants: ReadonlyArray<{
					readonly report: (value: unknown, path: readonly string[]) => readonly Fault[]
					readonly guard: Guard<unknown>
				}> = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(owned.variants), [
					(variant: ContractShape | undefined) =>
						variant === undefined
							? []
							: [
									{
										report: this.#reportAt(variant),
										guard: this.#guardAt(variant),
									},
								],
				])
				const plans: ReadonlyArray<(value: unknown, path: readonly string[]) => readonly Fault[]> =
					INTRINSICS.reflect.apply(INTRINSICS.project, readIndexView(variants), [
						(variant: (typeof variants)[number]) => variant.report,
					])
				const guards: ReadonlyArray<Guard<unknown>> = INTRINSICS.reflect.apply(
					INTRINSICS.project,
					readIndexView(variants),
					[(variant: (typeof variants)[number]) => variant.guard],
				)
				const exclusive = owned.mode === 'oneOf'
				const count = owned.variants.length
				const discriminated = this.#discriminate(owned)
				return (value, path) => {
					const selected = discriminated?.select(value)
					const arm = selected === undefined ? undefined : plans[selected]
					if (arm !== undefined) return arm(value, path)
					const perVariant: Array<readonly Fault[]> = []
					for (const index2 of iterateIndices(() => plans.length)) {
						const plan = plans[index2]
						if (plan === undefined) continue
						const variantFaults = plan(value, path)
						// The auditor's first-clean-variant stop, mirrored: an `anyOf` report
						// is settled by the FIRST variant that reports nothing, in declaration
						// order, and no later variant plan reads the value after it. A `oneOf`
						// report is the guard-match count over every variant, so it reads all
						// of them.
						if (!exclusive && variantFaults.length === 0) return []
						perVariant[perVariant.length] = variantFaults
					}
					const closest = selectClosestFaults(perVariant)
					if (exclusive) {
						const matched: number = INTRINSICS.reflect.apply(INTRINSICS.fold, guards, [
							(total: number, guard: Guard<unknown>) => total + (guard(value) ? 1 : 0),
							0,
						])
						if (matched === 1) return []
						if (matched === 0) {
							const report: Fault[] = [
								{ reason: 'oneOf', path, matched: 0, ...discriminated?.hint },
							]
							appendEntries(report, closest)
							return limitEntries(report, FAULT_LIMIT)
						}
						return [{ reason: 'oneOf', path, matched, ...discriminated?.hint }]
					}
					const report: Fault[] = [
						{ reason: 'variant', path, variants: count, ...discriminated?.hint },
					]
					appendEntries(report, closest)
					return limitEntries(report, FAULT_LIMIT)
				}
			}
			case 'optional': {
				const inner = this.#reportAt(owned.inner)
				return (value, path) => (value === undefined ? [] : inner(value, path))
			}
			case 'nullable': {
				const inner = this.#reportAt(owned.inner)
				return (value, path) => (value === null ? [] : inner(value, path))
			}
			// The parser returns the value by identity when the audit is clean, so the report is the
			// audit's own walk. A member whose audit names an undeclared or hidden key reports one
			// `type` fault in place of those keys, which a parse fault has no reason for, and a
			// member that cannot be read reports the interface as the wrong kind.
			case 'interface': {
				const entries = this.#membersOf(owned)
				return (value, path) => {
					if ((!isObject(value) && !isFunction(value)) || isArray(value)) {
						return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
					}
					const faults: Fault[] = []
					const outcome = attempt(() => {
						for (const entryIndex of iterateIndices(() => entries.length)) {
							const entry = entries[entryIndex]
							if (entry === undefined) continue
							if (faults.length >= FAULT_LIMIT) return
							const at = pathOf(path, entry.key)
							const member: unknown = INTRINSICS.reflect.read(value, entry.key)
							if (member === undefined && !entry.admits) {
								if (!entry.optional) {
									faults[faults.length] = { reason: 'missing', path: at, expected: entry.kind }
								}
								continue
							}
							const found = entry.audit(member, at)
							const kept: readonly Fault[] = INTRINSICS.reflect.apply(
								INTRINSICS.select,
								readIndexView(found),
								[(fault: AuditFault) => fault.reason !== 'extra' && fault.reason !== 'hidden'],
							)
							if (kept.length < found.length) {
								faults[faults.length] = {
									reason: 'type',
									path: at,
									expected: entry.kind,
									received: preview(member),
								}
							}
							appendEntries(faults, kept)
						}
					})
					if (isFailure(outcome)) {
						return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
					}
					return limitEntries(faults, FAULT_LIMIT)
				}
			}
			case 'raw':
				return (value, path) =>
					value === undefined
						? [{ reason: 'type', path, expected: 'json', received: preview(value) }]
						: []
		}
	}

	// === Generator family

	#buildGenerator(): SeederFunction<unknown> {
		const ready = this.#generator
		if (ready !== undefined) return ready
		this.#prepare()
		if (this.#unions() || this.#defaults()) this.#buildGuard()
		for (const step of iterateIndices(() => this.#order.length)) {
			const index = this.#order[step]
			if (index === undefined) continue
			this.#seeds[index] = this.#seedOf(index)
		}
		const root = this.#exposeSeed(this.#seedAt(this.#node(0)))
		this.#generator = root
		return root
	}

	// The default seed is drawn INSIDE the boundary, not in a parameter list. A
	// default-parameter initializer is evaluated in the function environment
	// before the first statement of the body, so no at-the-door containment could
	// ever reach it — `Date.now = () => { throw x }` made this door and
	// `contract.generate()` throw the caller's raw object by identity. The read is
	// captured too: `INTRINSICS.now` rather than the live global.
	#exposeSeed(plan: (random: RandomFunction) => unknown): SeederFunction<unknown> {
		return (random?: RandomFunction): unknown =>
			contain(() => plan(random ?? seededRandom(INTRINSICS.now())), 'compileGenerator', {
				code: 'generate',
			})
	}

	#seedAt(shape: ContractShape): (random: RandomFunction) => unknown {
		const compiled = this.#seeds[this.#locate(shape)]
		if (compiled === undefined) {
			throw new ContractError('ContractCompiler: a child generator is unavailable', {
				code: 'structure',
				context: { path: [], shape: 'contract' },
			})
		}
		return compiled
	}

	#seedOf(index: number): (random: RandomFunction) => unknown {
		const owned = this.#node(index)
		switch (owned.category) {
			case 'string': {
				// Every date is 10 characters long, and validation refuses a date shape
				// whose bounds exclude that length, so the draw never reads them.
				if (owned.date === true) {
					return (random) => {
						const year = 2000 + INTRINSICS.floor(drawRandom(random, 'string') * 100)
						const month = 1 + INTRINSICS.floor(drawRandom(random, 'string') * 12)
						const length = computeMonthLength(year, month)
						const day = 1 + INTRINSICS.floor(drawRandom(random, 'string') * length)
						return `${year}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`
					}
				}
				const min = owned.min ?? 0
				const max = owned.max ?? INTRINSICS.max(min, 12)
				const length = INTRINSICS.max(min, INTRINSICS.min(max, 8))
				const pattern = owned.pattern
				return (random) => {
					const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
					const characters = INTRINSICS.from(
						iterateIndices(() => length),
						() =>
							INTRINSICS.text(
								alphabet[INTRINSICS.floor(drawRandom(random, 'string') * alphabet.length)],
							),
					)
					const value: string = INTRINSICS.reflect.apply(INTRINSICS.join, characters, [''])
					if (pattern !== undefined && !matchOf(pattern)(value)) {
						const limit = readPatternSource(pattern)
						throw new ContractError(
							'compileGenerator: a pattern-constrained string shape cannot be auto-generated — supply or verify values another way',
							{
								code: 'generate',
								context: { shape: 'string', ...(limit === undefined ? {} : { limit }) },
							},
						)
					}
					return value
				}
			}
			case 'number': {
				const whole = owned.integer === true
				const inside = this.#rangeOf(owned)
				// An integer node narrows an exclusive bound to the nearest whole number inside it.
				const above =
					owned.over === undefined
						? undefined
						: whole
							? INTRINSICS.floor(owned.over) + 1
							: owned.over
				const below =
					owned.under === undefined
						? undefined
						: whole
							? INTRINSICS.ceil(owned.under) - 1
							: owned.under
				const minimum =
					owned.min === undefined || above === undefined
						? (owned.min ?? above)
						: INTRINSICS.max(owned.min, above)
				const maximum =
					owned.max === undefined || below === undefined
						? (owned.max ?? below)
						: INTRINSICS.min(owned.max, below)
				return (random) => {
					const sample = drawRandom(random, whole ? 'integer' : 'number')
					const low = minimum ?? (maximum === undefined ? -100 : maximum - 100)
					const high = maximum ?? (minimum === undefined ? 100 : minimum + 100)
					const lo = whole ? INTRINSICS.ceil(low) : low
					const hi = whole ? INTRINSICS.floor(high) : high
					const drawn =
						lo === hi
							? lo
							: whole
								? INTRINSICS.floor(lo * (1 - sample) + hi * sample)
								: lo * (1 - sample) + hi * sample
					if (inside === undefined || inside(drawn)) return drawn
					// A draw can land on an exclusive bound or round past a bound, so the midpoint is the second candidate.
					const middle = whole ? INTRINSICS.floor(lo / 2 + hi / 2) : lo / 2 + hi / 2
					if (inside(middle)) return middle
					throw new ContractError(
						'compileGenerator: no number lies inside the number shape bounds — supply values another way',
						{ code: 'generate', context: { shape: whole ? 'integer' : 'number' } },
					)
				}
			}
			case 'boolean':
				return (random) => drawRandom(random, 'boolean') >= 0.5
			case 'null':
				return () => null
			case 'function':
				return () => ContractCompiler.#function
			case 'undefined':
				return () => undefined
			case 'shape':
				return () => ({ category: 'object', properties: {}, additionalProperties: false })
			case 'json':
				return (random) => {
					const pick = INTRINSICS.floor(drawRandom(random, 'json') * 5)
					if (pick === 0) return null
					if (pick === 1) return drawRandom(random, 'json') >= 0.5
					if (pick === 2) return INTRINSICS.floor(drawRandom(random, 'json') * 1000)
					if (pick === 3) {
						const alphabet = 'abcdefghijklmnopqrstuvwxyz'
						const characters = INTRINSICS.from(
							iterateIndices(() => 6),
							() =>
								INTRINSICS.text(
									alphabet[INTRINSICS.floor(drawRandom(random, 'json') * alphabet.length)],
								),
						)
						const value: string = INTRINSICS.reflect.apply(INTRINSICS.join, characters, [''])
						return value
					}
					return { value: INTRINSICS.floor(drawRandom(random, 'json') * 1000) }
				}
			case 'literal': {
				const values = owned.values
				return (random) => {
					if (values.length === 0) {
						throw new ContractError('compileGenerator: a literal shape needs at least one value', {
							code: 'generate',
							context: { shape: 'literal', limit: 1 },
						})
					}
					return values[INTRINSICS.floor(drawRandom(random, 'literal') * values.length)]
				}
			}
			case 'array': {
				const item = this.#seedAt(owned.items)
				const lo = owned.min ?? INTRINSICS.min(1, owned.max ?? 1)
				const hi = owned.max ?? INTRINSICS.max(lo, 3)
				return (random) => {
					const length = INTRINSICS.floor(drawRandom(random, 'array') * (hi - lo + 1)) + lo
					return INTRINSICS.from(
						iterateIndices(() => length),
						() => item(random),
					)
				}
			}
			case 'object': {
				const keyList = INTRINSICS.keys(owned.properties)
				const entries: ReadonlyArray<{
					readonly key: string
					readonly seed: (random: RandomFunction) => unknown
					readonly optional: boolean
				}> = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(keyList), [
					(key: string) => {
						const child = owned.properties[key]
						if (child === undefined) return []
						const optional = child.category === 'optional'
						const inner = optional ? child.inner : child
						return [
							{
								key,
								seed: this.#seedAt(inner),
								optional,
							},
						]
					},
				])
				const extra = owned.additionalProperties
				const tail =
					extra === undefined || extra === true || extra === false ? undefined : this.#seedAt(extra)
				return (random) => {
					// Honest typing: generated data is a value the caller keeps, so unlike the
					// guard's and parser's null-prototype property views it carries the normal
					// object prototype — `defineProperty` (never assignment) still lands a
					// '__proto__' key as an own data key rather than mutating that prototype.
					const pairs = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(entries), [
						(entry: (typeof entries)[number]) =>
							entry.optional && drawRandom(random, 'object') < 0.3
								? []
								: [[entry.key, entry.seed(random)]],
					])
					const declared = INTRINSICS.record<unknown>({
						[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [
							pairs,
						]),
					})
					const count =
						tail === undefined ? 0 : 1 + INTRINSICS.floor(drawRandom(random, 'object') * 2)
					const extras = INTRINSICS.from(
						iterateIndices(() => count),
						(step) => {
							const key = `key${step}`
							return INTRINSICS.own(declared, key) || tail === undefined
								? undefined
								: [key, tail(random)]
						},
					)
					const selected = INTRINSICS.reflect.apply(INTRINSICS.select, readIndexView(extras), [
						(entry: unknown) => entry !== undefined,
					])
					const additional = INTRINSICS.record<unknown>({
						[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [
							selected,
						]),
					})
					const result = { ...declared, ...additional }
					return result
				}
			}
			case 'union': {
				const plans: Array<(random: RandomFunction) => unknown> = INTRINSICS.reflect.apply(
					INTRINSICS.expand,
					readIndexView(owned.variants),
					[
						(variant: ContractShape | undefined) =>
							variant === undefined ? [] : [this.#seedAt(variant)],
					],
				)
				const count = owned.variants.length
				const guard = count === 0 ? undefined : this.#guardAt(owned)
				const attempts = INTRINSICS.max(GENERATION_ATTEMPT_LIMIT, count)
				return (random) => {
					if (count === 0 || guard === undefined) {
						throw new ContractError('compileGenerator: a union shape needs at least one variant', {
							code: 'generate',
							context: { shape: 'union', limit: 1 },
						})
					}
					const start = INTRINSICS.floor(drawRandom(random, 'union') * count)
					for (const attemptIndex of iterateIndices(() => attempts)) {
						const plan = plans[(start + attemptIndex) % count]
						if (plan === undefined) continue
						const outcome = attempt(() => plan(random))
						if (
							isFailure(outcome) &&
							isContractError(outcome.error) &&
							outcome.error.code === 'random'
						) {
							throw outcome.error
						}
						if (isSuccess(outcome) && guard(outcome.value)) return outcome.value
					}
					throw new ContractError(
						'compileGenerator: no union candidate satisfied the compiled guard',
						{
							code: 'generate',
							context: { shape: 'union', limit: attempts },
						},
					)
				}
			}
			case 'optional':
				return this.#seedAt(owned.inner)
			case 'nullable': {
				const inner = this.#seedAt(owned.inner)
				return (random) => (drawRandom(random, 'nullable') < 0.2 ? null : inner(random))
			}
			case 'interface': {
				const entries: ReadonlyArray<{
					readonly key: string
					readonly seed: (random: RandomFunction) => unknown
					readonly optional: boolean
				}> = INTRINSICS.reflect.apply(
					INTRINSICS.expand,
					readIndexView(INTRINSICS.keys(owned.members)),
					[
						(key: string) => {
							const child = owned.members[key]
							if (child === undefined) return []
							const optional = child.category === 'optional'
							return [{ key, seed: this.#seedAt(optional ? child.inner : child), optional }]
						},
					],
				)
				return (random) => {
					const pairs = INTRINSICS.reflect.apply(INTRINSICS.expand, readIndexView(entries), [
						(entry: (typeof entries)[number]) =>
							entry.optional && drawRandom(random, 'interface') < 0.3
								? []
								: [[entry.key, entry.seed(random)]],
					])
					return INTRINSICS.freeze(
						INTRINSICS.record<unknown>({
							[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [
								pairs,
							]),
						}),
					)
				}
			}
			case 'raw':
				return () => {
					throw new ContractError(
						'compileGenerator: a raw shape embeds an arbitrary JSON Schema and cannot be auto-generated — supply values another way',
						{
							code: 'generate',
							context: { shape: 'raw', limit: 'explicit value source' },
						},
					)
				}
		}
	}

	// === Owner family

	#buildOwner(): OwnerFunction<unknown> {
		const ready = this.#owner
		if (ready !== undefined) return ready
		this.#prepare()
		const guard = this.#buildGuard()
		const auditor = this.#buildAuditor()
		const parser = this.#buildParser()
		this.#planCaptures()
		const root = ContractCompiler.#claim(
			this.#exposeOwner(this.#captureAt(this.#node(0)), { guard, auditor, parser }),
		)
		this.#owner = root
		return root
	}

	// Planned one time, children first.
	#planCaptures(): void {
		if (this.#captures.length > 0) return
		for (const step of iterateIndices(() => this.#order.length)) {
			const index = this.#order[step]
			if (index === undefined) continue
			this.#captures[index] = this.#captureOf(index)
		}
	}

	#captureAt(shape: ContractShape): CapturePlan | undefined {
		return this.#captures[this.#locate(shape)]
	}

	// A node plans only where an interface sits below it. An interface under a union refuses at
	// validation, so a union plans nothing, as every leaf does.
	#captureOf(index: number): CapturePlan | undefined {
		const owned = this.#node(index)
		switch (owned.category) {
			case 'interface':
				return ContractCompiler.#held
			case 'optional':
			case 'nullable':
				return this.#captureAt(owned.inner)
			case 'array': {
				const items = this.#captureAt(owned.items)
				if (items === undefined) return undefined
				return INTRINSICS.freeze({
					held: false,
					properties: ContractCompiler.#held.properties,
					tail: undefined,
					items,
				})
			}
			case 'object': {
				const extra = owned.additionalProperties
				const tail =
					extra === undefined || extra === true || extra === false
						? undefined
						: this.#captureAt(extra)
				const pairs: ReadonlyArray<readonly [string, CapturePlan | undefined]> =
					INTRINSICS.reflect.apply(
						INTRINSICS.project,
						readIndexView(INTRINSICS.keys(owned.properties)),
						[
							(key: string) => {
								const child = owned.properties[key]
								return [key, child === undefined ? undefined : this.#captureAt(child)]
							},
						],
					)
				const planned = INTRINSICS.reflect.apply(INTRINSICS.some, pairs, [
					(pair: readonly [string, CapturePlan | undefined]) => pair[1] !== undefined,
				])
				if (tail === undefined && !planned) return undefined
				const properties = INTRINSICS.rebase(
					INTRINSICS.record<CapturePlan | undefined>({
						[Symbol.iterator]: INTRINSICS.reflect.apply(INTRINSICS.bind, INTRINSICS.iterator, [
							pairs,
						]),
					}),
					null,
				)
				return INTRINSICS.freeze({
					held: false,
					properties: INTRINSICS.freeze(properties),
					tail,
					items: undefined,
				})
			}
			default:
				return undefined
		}
	}

	// Capture, then the guard, then the parser or the audit, inside one evaluation scope: a clean
	// interface audit is kept in the scope, so its declared members are read one time.
	#exposeOwner(
		plan: CapturePlan | undefined,
		judges: {
			readonly guard: Guard<unknown>
			readonly auditor: AuditorFunction
			readonly parser: Parser<unknown>
		},
	): (value: unknown) => Result<unknown, ContractRefusal> {
		return (value: unknown): Result<unknown, ContractRefusal> => {
			try {
				const snapshot = new ValueCloner(value, plan).clone()
				return EvaluationScope.run(
					(owned: unknown) => ContractCompiler.#judge(judges, owned),
					snapshot,
				)
			} catch (cause) {
				return failure({ faults: [], cause })
			}
		}
	}

	// The guard decides the verdict and the audit only explains a refusal, built as `admitValue`
	// builds it. A held member read live can answer the audit differently, so an empty audit
	// after a refused guard still refuses.
	static #judge(
		judges: {
			readonly guard: Guard<unknown>
			readonly auditor: AuditorFunction
			readonly parser: Parser<unknown>
		},
		value: unknown,
	): Result<unknown, ContractRefusal> {
		if (judges.guard(value)) {
			const parsed = judges.parser(value)
			if (parsed === undefined && value !== undefined) return failure({ faults: [] })
			return success(parsed === undefined ? value : parsed)
		}
		const faults = judges.auditor(value)
		if (faults.length > 0) {
			return failure({ faults: limitEntries(filterUncoveredFaults(faults), FAULT_LIMIT) })
		}
		return failure({
			faults: [],
			cause: new ContractError('own: the value changed between reads', {
				code: 'structure',
				context: { path: [] },
			}),
		})
	}

	// The other typed boundary, beside `#publish`: the generic call of `own` answers at its
	// argument's static type, because the owned snapshot stands in for the argument.
	static #claim(owner: (value: unknown) => Result<unknown, ContractRefusal>): OwnerFunction<unknown>
	static #claim(owner: unknown): unknown {
		return owner
	}

	// === Bundle

	#buildContract(): ContractInterface<unknown> {
		const ready = this.#bundle
		if (ready !== undefined) return ready
		// Getter order, so a declaration that refuses refuses at the same artifact
		// whether the caller reads the roots one at a time or asks for the bundle.
		const schema = this.#buildSchema()
		const guard = this.#buildGuard()
		const parser = this.#buildParser()
		const auditor = this.#buildAuditor()
		const reporter = this.#buildReporter()
		const generator = this.#buildGenerator()
		const owner = this.#buildOwner()
		const bundle = INTRINSICS.freeze({
			schema,
			is: guard,
			parse: parser,
			audit: auditor,
			explain: reporter,
			generate: generator,
			own: owner,
		})
		this.#bundle = bundle
		return bundle
	}

	static {
		// Pinned while this class is DEFINED. Every standalone compiler and
		// `createContract` reaches these getters, so one assignment on this
		// prototype would decide what the public doors publish while none of them
		// was touched.
		pinMembers(ContractCompiler.prototype, 'ContractCompiler')
	}
}
