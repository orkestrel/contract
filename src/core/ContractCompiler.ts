import type {
	ArrayShape,
	AuditFault,
	AuditorFunction,
	ContractCompilerInterface,
	ContractInterface,
	ContractShape,
	Fault,
	FaultKind,
	Guard,
	Infer,
	JSONSchema,
	LiteralValue,
	NumberShape,
	Parser,
	RandomFunction,
	ReporterFunction,
	Result,
	SeederFunction,
	StringShape,
} from './types.js'
import { FAULT_LIMIT, GENERATION_ATTEMPT_LIMIT, INTRINSICS } from './constants.js'
import { ContractError, isContractError } from './errors.js'
import {
	admitMember,
	appendEntries,
	attempt,
	collectMembers,
	contain,
	createArrayFaults,
	createNumberFaults,
	createStringFaults,
	drawRandom,
	enumerableKeys,
	limitEntries,
	matchesMember,
	pathOf,
	pinMembers,
	preview,
	readArrayEntries,
	readPatternSource,
	readValue,
	refuseExpansion,
	seededRandom,
	selectClosestFaults,
	shapeToKind,
} from './helpers.js'
import {
	isArray,
	isBoolean,
	isFiniteNumber,
	isInteger,
	isJSONValue,
	isNull,
	isObject,
	isRecord,
	isString,
	isUndefined,
} from './validators.js'
import {
	arrayOf,
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
import { cloneSchema, ownShape } from './cloners.js'
import { ShapeValidator } from './ShapeValidator.js'

/**
 * Lazy compiler owning one contract shape's six artifacts and their bundle.
 *
 * @remarks
 * The engine every standalone `compile*` function and `createContract` now runs
 * on. Its reason for existing is that the recursive compilers used to re-own and
 * re-validate the SUBGRAPH at every node they descended into, so a depth-100
 * chain paid a hundred clones of shrinking graphs and a hundred validations —
 * quadratic work for a linear declaration, measured at 640 ms for one guard and
 * 1.87 s for one contract. Here ownership runs once, validation runs once over
 * that owned result, and each unique node and structural edge is indexed once
 * into children-before-parent order. Every artifact family is then a single
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
 * all three.
 *
 * One terminal lifecycle covers preparation and every family. A failure settles
 * the compiler: later getters rethrow that exact error, while an artifact
 * already handed out keeps working, because each compiled artifact is
 * self-contained. Reentry — reachable only through a caller accessor the
 * declaration itself exposes, since a `pattern` getter is the one accessor
 * ownership invokes — poisons the nested read, the interrupted outer read, and
 * every later read with one shared cause-free error.
 *
 * @typeParam S - The declaration's shape type, which types the published artifacts
 *
 * @example
 * ```ts
 * const compiler = new ContractCompiler({ type: 'string', min: 1 })
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
	// The call-scoped value ledger's clock. `#visits` hands out one identity per
	// top-level walk and `#scope` names the walk now running, so a node's memo can
	// say which call filled it. Both are static because a compiled artifact is
	// self-contained by design — it must not reach instance state its compiler
	// releases — and because these two numbers are the whole of it: no value, no
	// answer, and nothing that outlives the walk that set them.
	static #visits = 0
	static #scope = 0
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
	readonly #emptyStack: Array<
		| { readonly operation: 'enter'; readonly shape: ContractShape }
		| { readonly operation: 'exit'; readonly index: number }
	>
	// The prepared index. `#nodes[0]` is the owned root by construction, `#index`
	// answers "which node is this child" by identity, and `#order` lists every
	// node with its children already listed before it — so a family solves any
	// bottom-up fact by reading it forwards once.
	#nodes: ContractShape[]
	readonly #emptyNodes: ContractShape[]
	#index: WeakMap<ContractShape, number>
	readonly #emptyIndex: WeakMap<ContractShape, number>
	#order: number[]
	readonly #emptyOrder: number[]
	// One plan per family, each indexed by the same node index. A plan entry is a
	// self-contained artifact for that node: it closes over the CHILD entries it
	// needs, resolved while the family is built, so nothing a compiled artifact
	// does at call time reaches back into the index this class later releases.
	#schemas: JSONSchema[]
	readonly #emptySchemas: JSONSchema[]
	#guards: Array<Guard<unknown>>
	readonly #emptyGuards: Array<Guard<unknown>>
	#parsers: Array<Parser<unknown>>
	readonly #emptyParsers: Array<Parser<unknown>>
	#audits: Array<(value: unknown, path: readonly string[]) => readonly AuditFault[]>
	readonly #emptyAudits: Array<(value: unknown, path: readonly string[]) => readonly AuditFault[]>
	#reports: Array<(value: unknown, path: readonly string[]) => readonly Fault[]>
	readonly #emptyReports: Array<(value: unknown, path: readonly string[]) => readonly Fault[]>
	#seeds: Array<(random: RandomFunction) => unknown>
	readonly #emptySeeds: Array<(random: RandomFunction) => unknown>
	#schema: JSONSchema | undefined
	#guard: Guard<unknown> | undefined
	#parser: Parser<unknown> | undefined
	#auditor: AuditorFunction | undefined
	#reporter: ReporterFunction | undefined
	#generator: SeederFunction<unknown> | undefined
	#bundle: ContractInterface<unknown> | undefined

	/**
	 * Retain a shape declaration without observing it.
	 *
	 * @param shape - The live declaration the first getter read will own
	 */
	constructor(shape: S) {
		this.#source = shape
		this.#state = { phase: 'ready' }
		this.#stack = []
		this.#emptyStack = []
		this.#nodes = []
		this.#emptyNodes = []
		this.#index = new ContractCompiler.#weakMap()
		this.#emptyIndex = new ContractCompiler.#weakMap()
		this.#order = []
		this.#emptyOrder = []
		this.#schemas = []
		this.#emptySchemas = []
		this.#guards = []
		this.#emptyGuards = []
		this.#parsers = []
		this.#emptyParsers = []
		this.#audits = []
		this.#emptyAudits = []
		this.#reports = []
		this.#emptyReports = []
		this.#seeds = []
		this.#emptySeeds = []
		this.#schema = undefined
		this.#guard = undefined
		this.#parser = undefined
		this.#auditor = undefined
		this.#reporter = undefined
		this.#generator = undefined
		this.#bundle = undefined
	}

	/**
	 * The emitted JSON Schema for the owned declaration.
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

	/** The compiled strict guard for the owned declaration. */
	get guard(): Guard<Infer<S>> {
		const ready = this.#guard
		if (ready !== undefined && this.#state.phase === 'ready') return this.#publish(ready)
		return this.#publish(this.#enter(() => this.#buildGuard()))
	}

	/** The compiled coercive parser for the owned declaration. */
	get parser(): Parser<Infer<S>> {
		const ready = this.#parser
		if (ready !== undefined && this.#state.phase === 'ready') return this.#publish(ready)
		return this.#publish(this.#enter(() => this.#buildParser()))
	}

	/** The compiled strict-domain diagnostic for the owned declaration. */
	get auditor(): AuditorFunction {
		const ready = this.#auditor
		if (ready !== undefined && this.#state.phase === 'ready') return ready
		return this.#enter(() => this.#buildAuditor())
	}

	/** The compiled coercive-domain diagnostic for the owned declaration. */
	get reporter(): ReporterFunction {
		const ready = this.#reporter
		if (ready !== undefined && this.#state.phase === 'ready') return ready
		return this.#enter(() => this.#buildReporter())
	}

	/** The compiled seed-data source for the owned declaration. */
	get generator(): SeederFunction<Infer<S>> {
		const ready = this.#generator
		if (ready !== undefined && this.#state.phase === 'ready') return this.#publish(ready)
		return this.#publish(this.#enter(() => this.#buildGenerator()))
	}

	/**
	 * The frozen six-member bundle of this compiler's artifacts.
	 *
	 * @remarks
	 * Own enumerable keys `schema`, `is`, `parse`, `audit`, `explain`,
	 * `generate`, in that order, each holding the exact value the corresponding
	 * getter publishes.
	 */
	get contract(): ContractInterface<Infer<S>> {
		const ready = this.#bundle
		if (ready !== undefined && this.#state.phase === 'ready') return this.#publish(ready)
		return this.#publish(this.#enter(() => this.#buildContract()))
	}

	// The one typed boundary in this class. Every family is compiled over the
	// OWNED graph, whose static type is the widened `ContractShape` union, while
	// the compiler publishes artifacts under the inferred type of the declaration
	// it was constructed from. The standalone `compile*` functions make the
	// identical claim through their own overload pairs; declaring it once here is
	// that same statement rather than an extra one, and it is the reason no
	// assertion appears anywhere in this file.
	#publish(root: Guard<unknown>): Guard<Infer<S>>
	#publish(root: Parser<unknown>): Parser<Infer<S>>
	#publish(root: SeederFunction<unknown>): SeederFunction<Infer<S>>
	#publish(root: ContractInterface<unknown>): ContractInterface<Infer<S>>
	#publish(root: unknown): unknown {
		return root
	}

	// Lifecycle. Every getter runs its build inside this, so preparation and all
	// six families share one terminal state.
	#enter<T>(build: () => T): T {
		const state = this.#state
		if (state.phase === 'failed') throw state.error
		if (state.phase === 'running' || state.phase === 'interrupted') {
			this.#state = { phase: 'interrupted', poison: state.poison }
			throw state.poison
		}
		// Created BEFORE the source is observed, for the same reason the cloners
		// create theirs there: a poison built on the settlement path would be built
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
		if (!outcome.success) {
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

	// Once all six roots exist nothing can need the graph again, so the graph, the
	// index, the order and every family plan go. The six roots and the optional
	// frozen bundle stay, and so does terminal state.
	#collect(): void {
		if (this.#schema === undefined || this.#guard === undefined) return
		if (this.#parser === undefined || this.#auditor === undefined) return
		if (this.#reporter === undefined || this.#generator === undefined) return
		this.#release()
	}

	// Assignment of preconstructed peers only. Nothing here calls a caller-mutable
	// cleanup member and nothing here constructs a collection after the source was
	// observed, so release cannot be redirected into leaving state behind.
	#release(): void {
		this.#source = undefined
		this.#stack = this.#emptyStack
		this.#nodes = this.#emptyNodes
		this.#index = this.#emptyIndex
		this.#order = this.#emptyOrder
		this.#schemas = this.#emptySchemas
		this.#guards = this.#emptyGuards
		this.#parsers = this.#emptyParsers
		this.#audits = this.#emptyAudits
		this.#reports = this.#emptyReports
		this.#seeds = this.#emptySeeds
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
		// ONE ownership population for the whole compiler. `ownShape` runs the
		// accepted `ShapeCloner`, whose completed-root pass validates what it built;
		// the pass below is this compiler's own single validation of that owned
		// result, and it is where the emitted-node bound is applied — the gate that
		// owns that rule authors its diagnosis, so the refusal reads identically
		// however the caller arrived.
		const owned = ownShape(source)
		const validator = new ShapeValidator(owned)
		validator.validate()
		refuseExpansion(validator.expansion)
		this.#discover(owned)
		this.#source = undefined
	}

	#discover(root: ContractShape): void {
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
			if (INTRINSICS.apply(INTRINSICS.recall, this.#index, [shape]) !== undefined) continue
			const index = this.#nodes.length
			this.#nodes[index] = shape
			INTRINSICS.apply(INTRINSICS.retain, this.#index, [shape, index])
			this.#stack[this.#stack.length] = { operation: 'exit', index }
			this.#schedule(shape)
		}
	}

	// Children are pushed in REVERSE slot order so the walk discovers them in
	// declaration order, which keeps node indices deterministic for one graph.
	#schedule(shape: ContractShape): void {
		switch (shape.type) {
			case 'array':
				this.#stack[this.#stack.length] = { operation: 'enter', shape: shape.items }
				return
			case 'optional':
			case 'nullable':
				this.#stack[this.#stack.length] = { operation: 'enter', shape: shape.inner }
				return
			case 'union': {
				for (let index = shape.variants.length - 1; index >= 0; index -= 1) {
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
				for (let index = keys.length - 1; index >= 0; index -= 1) {
					const key = keys[index]
					if (key === undefined) continue
					const child = shape.properties[key]
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
		const index = INTRINSICS.apply(INTRINSICS.recall, this.#index, [shape])
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
		for (let index = 0; index < this.#nodes.length; index += 1) {
			if (this.#nodes[index]?.type === 'union') return true
		}
		return false
	}

	// === Call-scoped value ledger
	//
	// A compiled artifact applies each child artifact once per OCCURRENCE, and a
	// value graph is a DAG as often as a declaration is — two slots holding one
	// object is ordinary data, not an attack. That costs one visit per PATH: a
	// twenty-three-node `arrayShape` chain over twenty-two shared arrays measured
	// 524,286 node reads, 4.4 s for `is` and 8.4 s for `audit`, growing fourfold
	// per two levels, for a declaration inside every published bound. The answer a
	// compiled node gives about one object is a function of that object, so it is
	// computed once per call and reused by every later path that arrives at the
	// same pair. The scope tag is what keeps that reuse INSIDE one call, since a
	// value the caller changes between two calls must be read again. It is the
	// per-call identity memo `valueToSchema` and `schemaToShape` already carry,
	// and it publishes nothing.
	//
	// A tracked node builds its ledger on the first call that hands it an
	// object. `filled` starts below every scope the clock hands out — `#visits`
	// rises before it names a scope, so no scope is 0 — and the first call
	// therefore always refreshes. The `memo === undefined` half of the refresh
	// condition is unreachable at runtime, because a refresh assigns the map and
	// the scope together; it stays because `INTRINSICS.apply` takes its receiver
	// type from the argument rather than from the target, so that half is what
	// proves the receiver at the `recall` and `retain` dispatches. Narrow the
	// condition to the scope alone and `undefined` reaches
	// `WeakMap.prototype.get` as far as the types know, with `check` still
	// exiting 0.

	// Only a node that descends into a child artifact can be reached twice through
	// one value; a leaf answers about the value in front of it, so tracking one
	// would buy nothing and would replace the package's own guards and parsers in
	// the artifacts a leaf-rooted declaration publishes.
	#repeats(index: number): boolean {
		const type = this.#node(index).type
		if (type === 'array' || type === 'object' || type === 'union') return true
		return type === 'optional' || type === 'nullable'
	}

	#trackGuard(plan: Guard<unknown>): Guard<unknown> {
		let filled = 0
		let memo: WeakMap<object, boolean> | undefined
		return (value: unknown): value is unknown => {
			if (!isObject(value)) return plan(value)
			const opened = ContractCompiler.#scope === 0
			if (opened) {
				ContractCompiler.#visits += 1
				ContractCompiler.#scope = ContractCompiler.#visits
			}
			try {
				const scope = ContractCompiler.#scope
				if (memo === undefined || filled !== scope) {
					memo = new ContractCompiler.#weakMap()
					filled = scope
				}
				const recalled = INTRINSICS.apply(INTRINSICS.recall, memo, [value])
				if (recalled !== undefined) return recalled
				const answer = plan(value)
				INTRINSICS.apply(INTRINSICS.retain, memo, [value, answer])
				return answer
			} finally {
				if (opened) ContractCompiler.#scope = 0
			}
		}
	}

	// The diagnostic families reuse only the CLEAN verdict, because a fault
	// carries the path it was found at while emptiness carries nothing: a node
	// that reported no fault about an object reports none about it wherever else
	// the walk arrives. A faulted node is re-walked at its new path, and stays
	// bounded by `FAULT_LIMIT` — every collector stops once the cap is reached, so
	// a value that faults everywhere saturates instead of expanding.
	#trackFaults<T>(
		plan: (value: unknown, path: readonly string[]) => readonly T[],
	): (value: unknown, path: readonly string[]) => readonly T[] {
		let filled = 0
		let memo: WeakMap<object, readonly T[]> | undefined
		return (value: unknown, path: readonly string[]): readonly T[] => {
			if (!isObject(value)) return plan(value, path)
			const opened = ContractCompiler.#scope === 0
			if (opened) {
				ContractCompiler.#visits += 1
				ContractCompiler.#scope = ContractCompiler.#visits
			}
			try {
				const scope = ContractCompiler.#scope
				if (memo === undefined || filled !== scope) {
					memo = new ContractCompiler.#weakMap()
					filled = scope
				}
				const recalled = INTRINSICS.apply(INTRINSICS.recall, memo, [value])
				if (recalled !== undefined) return recalled
				const answer = plan(value, path)
				if (answer.length === 0) INTRINSICS.apply(INTRINSICS.retain, memo, [value, answer])
				return answer
			} finally {
				if (opened) ContractCompiler.#scope = 0
			}
		}
	}

	// === Schema family

	#buildSchema(): JSONSchema {
		const ready = this.#schema
		if (ready !== undefined) return ready
		this.#prepare()
		for (let step = 0; step < this.#order.length; step += 1) {
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
		switch (owned.type) {
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
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			}
			case 'number':
				return INTRINSICS.freeze({
					type: owned.integer === true ? 'integer' : 'number',
					...(owned.min !== undefined ? { minimum: owned.min } : {}),
					...(owned.max !== undefined ? { maximum: owned.max } : {}),
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
			case 'literal': {
				// Indexed, not spread: this list is published inside the emitted schema,
				// and an array spread retrieves `Array.prototype[Symbol.iterator]` at the
				// moment of use, so a caller could add a member to a vocabulary this
				// package documents as exactly the shape's own.
				const vocabulary: LiteralValue[] = []
				for (let index2 = 0; index2 < owned.values.length; index2 += 1) {
					const value = owned.values[index2]
					if (value === undefined) continue
					vocabulary[vocabulary.length] = value
				}
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
				const properties: Record<string, JSONSchema> = INTRINSICS.create(null)
				const required: string[] = []
				const keyList = INTRINSICS.keys(owned.properties)
				for (let keyIndex = 0; keyIndex < keyList.length; keyIndex += 1) {
					const key = keyList[keyIndex]
					if (key === undefined) continue
					const child = owned.properties[key]
					if (child === undefined) continue
					properties[key] = this.#schemaAt(child.type === 'optional' ? child.inner : child)
					if (child.type !== 'optional') required[required.length] = key
				}
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
			case 'union': {
				// Indexed, not `map`: this array IS the published schema, and
				// `Array.prototype.map = () => ['INJECTED']` made `compileSchema` answer
				// `{"anyOf":["INJECTED"]}` — a success, with the caller's content inside
				// the package's own output.
				const variants: JSONSchema[] = []
				for (let index2 = 0; index2 < owned.variants.length; index2 += 1) {
					const variant = owned.variants[index2]
					if (variant === undefined) continue
					variants[variants.length] = this.#schemaAt(variant)
				}
				return INTRINSICS.freeze({
					...(owned.mode === 'oneOf'
						? { oneOf: INTRINSICS.freeze(variants) }
						: { anyOf: INTRINSICS.freeze(variants) }),
					...(owned.description !== undefined ? { description: owned.description } : {}),
				})
			}
			case 'optional':
				return this.#schemaAt(owned.inner)
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
		for (let step = 0; step < this.#order.length; step += 1) {
			const index = this.#order[step]
			if (index === undefined) continue
			const plan = this.#guardOf(index)
			this.#guards[index] = this.#repeats(index) ? this.#trackGuard(plan) : plan
		}
		const root = this.#guardAt(this.#node(0))
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

	#guardOf(index: number): Guard<unknown> {
		const owned = this.#node(index)
		switch (owned.type) {
			case 'string':
				// `stringOf` returns bare `isString` when unrefined, else composes the
				// length-bounds + pattern refinement — the same guard the parser re-applies.
				return stringOf({
					...(owned.min === undefined ? {} : { min: owned.min }),
					...(owned.max === undefined ? {} : { max: owned.max }),
					...(owned.pattern === undefined ? {} : { pattern: owned.pattern }),
				})
			case 'number': {
				const base = owned.integer === true ? isInteger : isFiniteNumber
				if (owned.min === undefined && owned.max === undefined) return base
				// `boundsOf` already refines `isFiniteNumber`; intersect with `isInteger`
				// when the leaf is an integer so both the integrality and the bounds hold.
				return owned.integer === true
					? intersectionOf(isInteger, boundsOf(owned.min, owned.max))
					: boundsOf(owned.min, owned.max)
			}
			case 'boolean':
				return isBoolean
			case 'null':
				return isNull
			case 'json':
				return isJSONValue
			case 'literal':
				// `literalOf` IS the package's literal match (SameValueZero over an owned
				// `Set`); the array form takes a machine-generated vocabulary no spread
				// could carry.
				return literalOf(owned.values)
			case 'array': {
				const base = arrayOf(this.#guardAt(owned.items))
				if (owned.min === undefined && owned.max === undefined) return base
				const withinLength = boundsOf(owned.min, owned.max)
				return whereOf(base, (value) => withinLength(value.length))
			}
			case 'object': {
				// Honest typing: a null-prototype accumulator so a property literally
				// named '__proto__' becomes an own data key instead of mutating the
				// prototype — the same pattern `pickOf` uses (combinators.ts).
				const map: Record<string, Guard<unknown>> = INTRINSICS.create(null)
				const optionalKeys: string[] = []
				const keyList = INTRINSICS.keys(owned.properties)
				for (let keyIndex = 0; keyIndex < keyList.length; keyIndex += 1) {
					const key = keyList[keyIndex]
					if (key === undefined) continue
					const child = owned.properties[key]
					if (child === undefined) continue
					if (child.type === 'optional') {
						map[key] = this.#guardAt(child.inner)
						optionalKeys[optionalKeys.length] = key
					} else {
						map[key] = this.#guardAt(child)
					}
				}
				const extra = owned.additionalProperties
				const closed = extra === undefined || extra === false
				const additional = closed || extra === true ? undefined : this.#guardAt(extra)
				// Indexed, not `filter`/`includes`: both are caller-writable members of
				// `Array.prototype` reached by name, one line above a boundary whose own
				// comment promises this walk never throws.
				const required: string[] = []
				const declared = INTRINSICS.keys(map)
				for (let keyIndex = 0; keyIndex < declared.length; keyIndex += 1) {
					const key = declared[keyIndex]
					if (key === undefined) continue
					let optional = false
					for (let optionalIndex = 0; optionalIndex < optionalKeys.length; optionalIndex += 1) {
						if (optionalKeys[optionalIndex] === key) optional = true
					}
					if (!optional) required[required.length] = key
				}
				return (value: unknown): value is unknown => {
					if (!isRecord(value)) return false
					const keys = enumerableKeys(value)
					if (keys === undefined) return false
					// Contain the whole key-enumeration + value-read walk — a hostile
					// getter on `value`, or a replaced `globalThis.Set` reached by the
					// presence view, must yield `false`, never throw (AGENTS §14).
					const outcome = attempt(() => {
						const present = collectMembers(keys)
						for (let keyIndex = 0; keyIndex < required.length; keyIndex += 1) {
							const key = required[keyIndex]
							if (key === undefined) continue
							if (!matchesMember(present, key)) return false
						}
						for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
							const key = keys[keyIndex]
							if (key === undefined) continue
							const guard = INTRINSICS.own(map, key) ? map[key] : undefined
							if (guard !== undefined) {
								if (!guard(value[key])) return false
								continue
							}
							if (closed) return false
							// An open object declares an undeclared key UNCONSTRAINED, not
							// UNOBSERVED. The compiled parser copies every one of them into
							// its result, so a guard that skipped the read certified a value
							// its own parser then refused as unreadable — `is` true, `audit`
							// and `explain` empty, `parse` throwing, on one input. The read is
							// the advertised read of the open-object domain; its RESULT is
							// only tested when a tail shape constrains it.
							const observed: unknown = value[key]
							if (additional !== undefined && !additional(observed)) return false
						}
						return true
					})
					return outcome.success && outcome.value
				}
			}
			case 'union': {
				const guards: Array<Guard<unknown>> = []
				for (let index2 = 0; index2 < owned.variants.length; index2 += 1) {
					const variant = owned.variants[index2]
					if (variant === undefined) continue
					guards[guards.length] = this.#guardAt(variant)
				}
				// A `oneOf`-mode union matches the emitted JSON Schema `oneOf` keyword —
				// EXACTLY one variant must guard-accept the value, not "at least one"
				// (unionOf's anyOf semantics). A value matching two-or-more variants is
				// rejected, since it would violate the compiled schema.
				if (owned.mode === 'oneOf') {
					return (value: unknown): value is unknown => {
						let matched = 0
						for (let index2 = 0; index2 < guards.length; index2 += 1) {
							const guard = guards[index2]
							if (guard !== undefined && guard(value)) matched += 1
						}
						return matched === 1
					}
				}
				// `Reflect.apply` reads its argument list by index (CreateListFromArrayLike),
				// where `unionOf(...guards)` would spread through the array iterator.
				return INTRINSICS.apply(unionOf, undefined, guards)
			}
			case 'optional':
				return orOf(isUndefined, this.#guardAt(owned.inner))
			case 'nullable':
				return nullableOf(this.#guardAt(owned.inner))
			case 'raw':
				return (value: unknown): value is unknown => value !== undefined
		}
	}

	// === Parser family

	#buildParser(): Parser<unknown> {
		const ready = this.#parser
		if (ready !== undefined) return ready
		this.#prepare()
		if (this.#unions()) this.#buildGuard()
		for (let step = 0; step < this.#order.length; step += 1) {
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
		switch (owned.type) {
			case 'string': {
				if (owned.min === undefined && owned.max === undefined && owned.pattern === undefined) {
					return parseString
				}
				// Coerce by type, then re-apply the SAME refinement the guard enforces (the
				// identical `stringOf`) — a value that parses but violates a bound or the
				// pattern fails the parse (returns `undefined`).
				const guard = stringOf({
					...(owned.min === undefined ? {} : { min: owned.min }),
					...(owned.max === undefined ? {} : { max: owned.max }),
					...(owned.pattern === undefined ? {} : { pattern: owned.pattern }),
				})
				return (value) => {
					const parsed = parseString(value)
					return parsed !== undefined && guard(parsed) ? parsed : undefined
				}
			}
			case 'number': {
				const base = owned.integer === true ? parseInteger : parseNumber
				if (owned.min === undefined && owned.max === undefined) return base
				// The same bound check the guard applies (integrality is already enforced by
				// `parseInteger`, so only the bounds need re-checking after coercion).
				const within = boundsOf(owned.min, owned.max)
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
					if (!entries.success) {
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
					for (let entryIndex = 0; entryIndex < entries.value.entries.length; entryIndex += 1) {
						// Indexed rather than iterated, and read in place: a hole and a
						// present `undefined` are the same observation to the item parser,
						// so neither is silently dropped from the assembled result.
						const parsed = item(entries.value.entries[entryIndex])
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
				const entries: Array<{ key: string; parse: Parser<unknown>; optional: boolean }> = []
				const keyList = INTRINSICS.keys(owned.properties)
				for (let keyIndex = 0; keyIndex < keyList.length; keyIndex += 1) {
					const key = keyList[keyIndex]
					if (key === undefined) continue
					const child = owned.properties[key]
					if (child === undefined) continue
					const optional = child.type === 'optional'
					entries[entries.length] = {
						key,
						parse: this.#parserAt(optional ? child.inner : child),
						optional,
					}
				}
				const known = readValue(
					() => {
						const declared = collectMembers([])
						for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
							const entry = entries[entryIndex]
							if (entry === undefined) continue
							admitMember(declared, entry.key)
						}
						return declared
					},
					'compileParser',
					{
						subject: 'object',
						context: { shape: 'object' },
					},
				)
				const extra = owned.additionalProperties
				const additional =
					extra === undefined || extra === false || extra === true
						? undefined
						: this.#parserAt(extra)
				const open = extra === true || additional !== undefined
				return (value) => {
					// A brand check, not `parseRecord`: that door's eager whole-record
					// `Object.values` probe reads EVERY own enumerable value, including
					// undeclared keys this parser is about to DROP. A closed object shape
					// whose input carried one throwing extra therefore refused as
					// unreadable while `explain` — which never performs that probe —
					// published the empty report that means "parse will succeed". The
					// reads this parser genuinely needs are the per-key reads below, and
					// they are already contained.
					if (!isRecord(value)) return undefined
					const record = value
					const keys = enumerableKeys(record)
					if (keys === undefined) return undefined
					// Contain the whole record walk — a hostile getter on `record`, or a
					// replaced `globalThis.Set` reached by the presence view, must yield
					// `undefined`, never throw (AGENTS §14).
					const outcome = attempt(() => {
						const present = collectMembers(keys)
						// Honest typing: a null-prototype accumulator so an input own key
						// literally named '__proto__' lands as an own data key instead of
						// mutating the prototype (same pattern as `pickOf`).
						const result: Record<string, unknown> = INTRINSICS.create(null)
						for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
							const entry = entries[entryIndex]
							if (entry === undefined) continue
							if (!matchesMember(present, entry.key)) {
								if (entry.optional) continue
								return undefined
							}
							const raw = record[entry.key]
							if (raw === undefined) {
								if (entry.optional) continue
								return undefined
							}
							const parsed = entry.parse(raw)
							if (parsed === undefined) return undefined
							result[entry.key] = parsed
						}
						if (open) {
							for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
								const key = keys[keyIndex]
								if (key === undefined) continue
								if (matchesMember(known, key)) continue
								if (additional === undefined) {
									result[key] = record[key]
								} else {
									const parsed = additional(record[key])
									if (parsed === undefined) return undefined
									result[key] = parsed
								}
							}
						}
						return result
					})
					if (outcome.success) return outcome.value
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
				const variants: Array<{ parse: Parser<unknown>; guard: Guard<unknown> }> = []
				for (let index2 = 0; index2 < owned.variants.length; index2 += 1) {
					const variant = owned.variants[index2]
					if (variant === undefined) continue
					variants[variants.length] = {
						parse: this.#parserAt(variant),
						guard: this.#guardAt(variant),
					}
				}
				// `oneOf` exactly-one semantics (documented on `oneOfShape`): judged on
				// the RAW input's guard matches only — no coercion fallback. Exactly one
				// variant's guard must accept the raw value; that variant's parser then
				// runs (its parse must equal the already guard-valid input by clause A).
				// Zero matches (no variant fits) or two-or-more matches (ambiguous —
				// which variant the value belongs to isn't well-defined) both fail the
				// parse, deliberately simpler than attempting a coercion-then-recheck
				// resolution for ambiguous input.
				if (owned.mode === 'oneOf') {
					return (value) => {
						// Indexed, not `filter`: an array prototype method decides how many
						// variants matched, and a substitute answering a rigged list decides
						// what this parser publishes.
						let matched = 0
						let only: { parse: Parser<unknown>; guard: Guard<unknown> } | undefined
						for (let index2 = 0; index2 < variants.length; index2 += 1) {
							const variant = variants[index2]
							if (variant === undefined || !variant.guard(value)) continue
							matched += 1
							if (matched === 1) only = variant
						}
						return matched === 1 && only !== undefined ? only.parse(value) : undefined
					}
				}
				return (value) => {
					// Identity pass first (AGENTS §14 clause A): a value already valid
					// against ANY variant's guard is returned unchanged, so an earlier
					// variant's coercion never overwrites a guard-valid input.
					for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
						const variant = variants[variantIndex]
						if (variant === undefined) continue
						if (variant.guard(value)) return value
					}
					// Coercion pass: no variant matched as-is, so parse-then-guard,
					// first variant that both parses and guards wins.
					for (let variantIndex = 0; variantIndex < variants.length; variantIndex += 1) {
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
			case 'raw':
				return (value) => value
		}
	}

	// === Auditor family

	#buildAuditor(): AuditorFunction {
		const ready = this.#auditor
		if (ready !== undefined) return ready
		this.#prepare()
		for (let step = 0; step < this.#order.length; step += 1) {
			const index = this.#order[step]
			if (index === undefined) continue
			const plan = this.#auditOf(index)
			this.#audits[index] = this.#repeats(index) ? this.#trackFaults(plan) : plan
		}
		const root = this.#exposeAudit(this.#auditAt(this.#node(0)))
		this.#auditor = root
		return root
	}

	// The published root supplies the documented default root path and carries the
	// door boundary the standalone `compileAuditor` used to provide around the
	// whole walk, so a host failure under a hostile value still publishes this
	// package's error class rather than the caller's raw value.
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
		switch (owned.type) {
			case 'string': {
				const node: StringShape = owned
				return (value, path) => {
					if (!isString(value)) {
						return [{ reason: 'type', path, expected: 'string', received: preview(value) }]
					}
					return createStringFaults(node, value, path)
				}
			}
			case 'number': {
				const node: NumberShape = owned
				const kind: FaultKind = owned.integer === true ? 'integer' : 'number'
				return (value, path) => {
					if (!isFiniteNumber(value)) {
						return [{ reason: 'type', path, expected: kind, received: preview(value) }]
					}
					return createNumberFaults(node, value, path)
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
					if (!entries.success) {
						return readValue(
							() => {
								throw entries.error
							},
							'compileAuditor',
							{ subject: 'array', context: { path, shape: 'array' } },
						)
					}
					const faults: AuditFault[] = []
					for (let entryIndex = 0; entryIndex < entries.value.entries.length; entryIndex += 1) {
						if (faults.length >= FAULT_LIMIT) break
						appendEntries(
							faults,
							item(entries.value.entries[entryIndex], pathOf(path, INTRINSICS.text(entryIndex))),
						)
					}
					appendEntries(faults, createArrayFaults(node, entries.value.entries.length, path))
					return limitEntries(faults, FAULT_LIMIT)
				}
			}
			case 'object': {
				const entries: Array<{
					key: string
					audit: (value: unknown, path: readonly string[]) => readonly AuditFault[]
					optional: boolean
					kind: FaultKind
				}> = []
				const declaredKeys = INTRINSICS.keys(owned.properties)
				for (let keyIndex = 0; keyIndex < declaredKeys.length; keyIndex += 1) {
					const key = declaredKeys[keyIndex]
					if (key === undefined) continue
					const child = owned.properties[key]
					if (child === undefined) continue
					const optional = child.type === 'optional'
					const inner = optional ? child.inner : child
					entries[entries.length] = {
						key,
						audit: this.#auditAt(inner),
						optional,
						kind: shapeToKind(inner),
					}
				}
				const extra = owned.additionalProperties
				const closed = extra === undefined || extra === false
				const additional = closed || extra === true ? undefined : this.#auditAt(extra)
				return (value, path) => {
					if (isObject(value)) {
						readValue(() => INTRINSICS.parent(value), 'compileAuditor', {
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
					// Both views are built inside the contained walk: a replaced
					// `globalThis.Set` must reach the auditor's own containment rather than
					// throw the caller's raw value out of a total report.
					const outcome = attempt(() => {
						const present = collectMembers(keys)
						const declared = collectMembers(declaredKeys)
						for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
							const entry = entries[entryIndex]
							if (entry === undefined) continue
							if (faults.length >= FAULT_LIMIT) return
							if (!matchesMember(present, entry.key)) {
								if (!entry.optional) {
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
						for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
							const key = keys[keyIndex]
							if (key === undefined) continue
							if (faults.length >= FAULT_LIMIT) return
							if (matchesMember(declared, key)) continue
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
					})
					if (!outcome.success) {
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
				const plans: Array<(value: unknown, path: readonly string[]) => readonly AuditFault[]> = []
				for (let index2 = 0; index2 < owned.variants.length; index2 += 1) {
					const variant = owned.variants[index2]
					if (variant === undefined) continue
					plans[plans.length] = this.#auditAt(variant)
				}
				const exclusive = owned.mode === 'oneOf'
				const count = owned.variants.length
				return (value, path) => {
					const perVariant: Array<readonly AuditFault[]> = []
					let matched = 0
					for (let index2 = 0; index2 < plans.length; index2 += 1) {
						const plan = plans[index2]
						if (plan === undefined) continue
						const variantFaults = plan(value, path)
						perVariant[perVariant.length] = variantFaults
						if (variantFaults.length === 0) matched += 1
					}
					if (exclusive) {
						if (matched === 1) return []
						if (matched > 1) return [{ reason: 'oneOf', path, matched }]
					} else if (matched > 0) {
						return []
					}
					const closest = selectClosestFaults(perVariant)
					const report: AuditFault[] = [
						exclusive
							? { reason: 'oneOf', path, matched: 0 }
							: { reason: 'variant', path, variants: count },
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
		if (this.#unions()) this.#buildGuard()
		for (let step = 0; step < this.#order.length; step += 1) {
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
		switch (owned.type) {
			case 'string': {
				const node: StringShape = owned
				return (value, path) => {
					const parsed = parseString(value)
					if (parsed === undefined) {
						return [{ reason: 'type', path, expected: 'string', received: preview(value) }]
					}
					return createStringFaults(node, parsed, path)
				}
			}
			case 'number': {
				const node: NumberShape = owned
				const kind: FaultKind = owned.integer === true ? 'integer' : 'number'
				return (value, path) => {
					const parsed = parseNumber(value)
					if (parsed === undefined) {
						return [{ reason: 'type', path, expected: kind, received: preview(value) }]
					}
					return createNumberFaults(node, parsed, path)
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
			case 'literal': {
				const allowed = literalOf(owned.values)
				return (value, path) =>
					allowed(value) || (isString(value) && allowed(value.trim()))
						? []
						: [{ reason: 'type', path, expected: 'literal', received: preview(value) }]
			}
			case 'array': {
				const node: ArrayShape = owned
				const item = this.#reportAt(owned.items)
				return (value, path) => {
					if (!isArray(value)) {
						return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
					}
					const entries = readArrayEntries(value)
					if (!entries.success) {
						return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
					}
					const faults: Fault[] = []
					for (let entryIndex = 0; entryIndex < entries.value.entries.length; entryIndex += 1) {
						if (faults.length >= FAULT_LIMIT) break
						appendEntries(
							faults,
							item(entries.value.entries[entryIndex], pathOf(path, INTRINSICS.text(entryIndex))),
						)
					}
					appendEntries(faults, createArrayFaults(node, entries.value.entries.length, path))
					return limitEntries(faults, FAULT_LIMIT)
				}
			}
			case 'object': {
				const entries: Array<{
					key: string
					report: (value: unknown, path: readonly string[]) => readonly Fault[]
					optional: boolean
					kind: FaultKind
				}> = []
				const keyList = INTRINSICS.keys(owned.properties)
				for (let keyIndex = 0; keyIndex < keyList.length; keyIndex += 1) {
					const key = keyList[keyIndex]
					if (key === undefined) continue
					const child = owned.properties[key]
					if (child === undefined) continue
					const optional = child.type === 'optional'
					const inner = optional ? child.inner : child
					entries[entries.length] = {
						key,
						report: this.#reportAt(inner),
						optional,
						kind: shapeToKind(inner),
					}
				}
				const extra = owned.additionalProperties
				const tail =
					extra === undefined || extra === true || extra === false
						? undefined
						: this.#reportAt(extra)
				const open = extra === true || tail !== undefined
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
					// Both views are built inside the contained walk: a replaced
					// `globalThis.Set` must reach the reporter's own diagnostic containment
					// rather than throw the caller's raw value out of a total report.
					const outcome = attempt(() => {
						const present = collectMembers(keys)
						const known = collectMembers([])
						for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
							const entry = entries[entryIndex]
							if (entry === undefined) continue
							if (faults.length >= FAULT_LIMIT) return
							admitMember(known, entry.key)
							// Mirror the parser's presence gate exactly: only an own
							// enumerable string key is present. A present key with an
							// explicit `undefined` value is still treated like absence, so
							// `explain` never faults where `parse` silently skips it.
							if (!matchesMember(present, entry.key)) {
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
							if (raw === undefined) {
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
							for (let keyIndex = 0; keyIndex < keys.length; keyIndex += 1) {
								const key = keys[keyIndex]
								if (key === undefined) continue
								if (faults.length >= FAULT_LIMIT) return
								if (matchesMember(known, key)) continue
								const observed: unknown = record[key]
								if (tail !== undefined) {
									appendEntries(faults, tail(observed, pathOf(path, key)))
								}
							}
						}
					})
					if (!outcome.success) {
						return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
					}
					return limitEntries(faults, FAULT_LIMIT)
				}
			}
			case 'union': {
				const plans: Array<(value: unknown, path: readonly string[]) => readonly Fault[]> = []
				const guards: Array<Guard<unknown>> = []
				for (let index2 = 0; index2 < owned.variants.length; index2 += 1) {
					const variant = owned.variants[index2]
					if (variant === undefined) continue
					plans[plans.length] = this.#reportAt(variant)
					guards[guards.length] = this.#guardAt(variant)
				}
				const exclusive = owned.mode === 'oneOf'
				const count = owned.variants.length
				return (value, path) => {
					const perVariant: Array<readonly Fault[]> = []
					for (let index2 = 0; index2 < plans.length; index2 += 1) {
						const plan = plans[index2]
						if (plan === undefined) continue
						perVariant[perVariant.length] = plan(value, path)
					}
					const closest = selectClosestFaults(perVariant)
					if (exclusive) {
						let matched = 0
						for (let index2 = 0; index2 < guards.length; index2 += 1) {
							const guard = guards[index2]
							if (guard !== undefined && guard(value)) matched += 1
						}
						if (matched === 1) return []
						if (matched === 0) {
							const report: Fault[] = [{ reason: 'oneOf', path, matched: 0 }]
							appendEntries(report, closest)
							return limitEntries(report, FAULT_LIMIT)
						}
						return [{ reason: 'oneOf', path, matched }]
					}
					for (let index2 = 0; index2 < perVariant.length; index2 += 1) {
						if (perVariant[index2]?.length === 0) return []
					}
					const report: Fault[] = [{ reason: 'variant', path, variants: count }]
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
		if (this.#unions()) this.#buildGuard()
		for (let step = 0; step < this.#order.length; step += 1) {
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
		switch (owned.type) {
			case 'string': {
				const min = owned.min ?? 0
				const max = owned.max ?? INTRINSICS.max(min, 12)
				const length = INTRINSICS.max(min, INTRINSICS.min(max, 8))
				const pattern = owned.pattern
				return (random) => {
					const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
					let value = ''
					for (let step = 0; step < length; step += 1) {
						value += alphabet[INTRINSICS.floor(drawRandom(random, 'string') * alphabet.length)]
					}
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
				const minimum = owned.min
				const maximum = owned.max
				return (random) => {
					const sample = drawRandom(random, whole ? 'integer' : 'number')
					if (whole) {
						const lo = INTRINSICS.ceil(minimum ?? (maximum === undefined ? -100 : maximum - 100))
						const hi = INTRINSICS.floor(maximum ?? (minimum === undefined ? 100 : minimum + 100))
						return lo === hi ? lo : INTRINSICS.floor(lo * (1 - sample) + hi * sample)
					}
					const lo = minimum ?? (maximum === undefined ? -100 : maximum - 100)
					const hi = maximum ?? (minimum === undefined ? 100 : minimum + 100)
					return lo === hi ? lo : lo * (1 - sample) + hi * sample
				}
			}
			case 'boolean':
				return (random) => drawRandom(random, 'boolean') >= 0.5
			case 'null':
				return () => null
			case 'json':
				return (random) => {
					const pick = INTRINSICS.floor(drawRandom(random, 'json') * 5)
					if (pick === 0) return null
					if (pick === 1) return drawRandom(random, 'json') >= 0.5
					if (pick === 2) return INTRINSICS.floor(drawRandom(random, 'json') * 1000)
					if (pick === 3) {
						const alphabet = 'abcdefghijklmnopqrstuvwxyz'
						let value = ''
						for (let step = 0; step < 6; step += 1) {
							value += alphabet[INTRINSICS.floor(drawRandom(random, 'json') * alphabet.length)]
						}
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
					const result: unknown[] = []
					for (let step = 0; step < length; step += 1) {
						result[result.length] = item(random)
					}
					return result
				}
			}
			case 'object': {
				const entries: Array<{
					key: string
					seed: (random: RandomFunction) => unknown
					optional: boolean
				}> = []
				const keyList = INTRINSICS.keys(owned.properties)
				for (let keyIndex = 0; keyIndex < keyList.length; keyIndex += 1) {
					const key = keyList[keyIndex]
					if (key === undefined) continue
					const child = owned.properties[key]
					if (child === undefined) continue
					const optional = child.type === 'optional'
					entries[entries.length] = {
						key,
						seed: this.#seedAt(optional ? child.inner : child),
						optional,
					}
				}
				const extra = owned.additionalProperties
				const tail =
					extra === undefined || extra === true || extra === false ? undefined : this.#seedAt(extra)
				return (random) => {
					// Honest typing: generated data is a value the caller keeps, so unlike the
					// guard's and parser's null-prototype property views it carries the normal
					// object prototype — `defineProperty` (never assignment) still lands a
					// '__proto__' key as an own data key rather than mutating that prototype.
					const result: Record<string, unknown> = {}
					for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
						const entry = entries[entryIndex]
						if (entry === undefined) continue
						if (entry.optional && drawRandom(random, 'object') < 0.3) continue
						INTRINSICS.define(result, entry.key, {
							value: entry.seed(random),
							enumerable: true,
							configurable: true,
							writable: true,
						})
					}
					// An open object (additionalProperties is a shape, not a boolean) also
					// generates synthetic extra entries so the shape does not trivially
					// generate as `{}` — skip any collision with a declared property name.
					if (tail !== undefined) {
						const count = 1 + INTRINSICS.floor(drawRandom(random, 'object') * 2)
						for (let step = 0; step < count; step += 1) {
							const key = `key${step}`
							if (INTRINSICS.own(result, key)) continue
							INTRINSICS.define(result, key, {
								value: tail(random),
								enumerable: true,
								configurable: true,
								writable: true,
							})
						}
					}
					return result
				}
			}
			case 'union': {
				const plans: Array<(random: RandomFunction) => unknown> = []
				for (let index2 = 0; index2 < owned.variants.length; index2 += 1) {
					const variant = owned.variants[index2]
					if (variant === undefined) continue
					plans[plans.length] = this.#seedAt(variant)
				}
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
					for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
						const plan = plans[(start + attemptIndex) % count]
						if (plan === undefined) continue
						const outcome = attempt(() => plan(random))
						if (
							!outcome.success &&
							isContractError(outcome.error) &&
							outcome.error.code === 'random'
						) {
							throw outcome.error
						}
						if (outcome.success && guard(outcome.value)) return outcome.value
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

	// === Bundle

	#buildContract(): ContractInterface<unknown> {
		const ready = this.#bundle
		if (ready !== undefined) return ready
		// Getter order, so a declaration that refuses refuses at the same artifact
		// whether the caller reads the six one at a time or asks for the bundle.
		const schema = this.#buildSchema()
		const guard = this.#buildGuard()
		const parser = this.#buildParser()
		const auditor = this.#buildAuditor()
		const reporter = this.#buildReporter()
		const generator = this.#buildGenerator()
		const bundle = INTRINSICS.freeze({
			schema,
			is: guard,
			parse: parser,
			audit: auditor,
			explain: reporter,
			generate: generator,
		})
		this.#bundle = bundle
		return bundle
	}

	static {
		// Pinned while this class is DEFINED. Every standalone compiler and
		// `createContract` reaches these getters, so one assignment on this
		// prototype would decide what six public doors publish while none of them
		// was touched.
		pinMembers(ContractCompiler.prototype, 'ContractCompiler')
	}
}
