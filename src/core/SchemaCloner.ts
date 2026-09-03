import type { JSONSchema, Result, SchemaClonerInterface } from './types.js'
import { COMPILE_DEPTH_LIMIT, INTRINSICS } from './constants.js'
import { ContractError } from './errors.js'
import {
	admitVisited,
	attempt,
	enumerableKeys,
	matchesVisited,
	pathOf,
	pinMembers,
} from './helpers.js'
import { isObject } from './validators.js'

/**
 * Owns the state of one JSON Schema snapshot operation.
 *
 * @remarks
 * Construction retains the source without observing it. The first
 * {@link clone} call performs one iterative identity-memoized walk and settles
 * permanently. Success replays the exact frozen root; failure rethrows the
 * exact class-owned error. Nonredirectable terminal settlement releases
 * populated traversal state before publishing that result, while retaining
 * the source and exact result afterward. Reentry poisons the active operation
 * and every later call with one shared cause-free error.
 *
 * @param schema - The JSON Schema graph to retain for cloning
 *
 * @example
 * ```ts
 * const child = { type: 'string' }
 * const cloner = new SchemaCloner({ anyOf: [child, child] })
 * const clone = cloner.clone()
 * clone.anyOf?.[0] === clone.anyOf?.[1] // true
 * cloner.clone() === clone // true
 * ```
 */
export class SchemaCloner implements SchemaClonerInterface {
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
	// reaching `globalThis.Map` leaves the door open one call earlier than the
	// member rows can see, and the constructor runs outside every containment
	// this class has.
	static readonly #map = Map
	static readonly #weakSet = WeakSet
	static readonly #hasOwn = Object.hasOwn
	// The released state, shared by every cloner this class ever builds. `#settle`
	// assigns it in place of the working list, so an instance allocates one
	// collection instead of two and construction carries no empty peer of its own.
	// Sharing is safe because nothing writes to a released list: every writer runs
	// inside the walk and `#settle` is the walk's last step. The static block at
	// the foot of the class freezes it, so a write that did reach it fails loudly
	// at its own line rather than leaking one cloner's frame into every other
	// cloner's release.
	static readonly #emptyPending: Array<{
		readonly source: object
		readonly clone: object
		readonly path: readonly string[]
		readonly depth: number
	}> = []
	readonly #source: JSONSchema
	readonly #owned: WeakSet<object>
	// The working map is the field with no shared peer: `Object.freeze` reaches an
	// array's writes and not a `Map`'s, so a shared empty map would be a
	// class-lifetime cache any write could fill with one cloner's nodes. `#settle`
	// drops it instead, and absence is `undefined`.
	#memo: Map<object, object> | undefined
	#pending: Array<{
		readonly source: object
		readonly clone: object
		readonly path: readonly string[]
		readonly depth: number
	}>
	#state:
		| { readonly phase: 'ready' }
		| { readonly phase: 'running'; readonly poison: ContractError }
		| { readonly phase: 'interrupted'; readonly poison: ContractError }
		| { readonly phase: 'settled'; readonly result: Result<JSONSchema, ContractError> }

	constructor(schema: JSONSchema) {
		this.#source = schema
		this.#owned = new SchemaCloner.#weakSet()
		this.#memo = new SchemaCloner.#map()
		this.#pending = []
		this.#state = { phase: 'ready' }
	}

	/**
	 * Clones the retained schema into an identity-preserving frozen graph.
	 *
	 * @returns The settled JSON Schema snapshot
	 * @throws {ContractError} When traversal is unreadable or cloning is reentered
	 */
	clone(): JSONSchema {
		const state = this.#state
		switch (state.phase) {
			case 'settled':
				if (state.result.success) return state.result.value
				throw state.result.error
			case 'running':
			case 'interrupted':
				this.#state = { phase: 'interrupted', poison: state.poison }
				throw state.poison
			case 'ready':
				break
		}

		const poison = this.#create('SchemaCloner.clone: schema cloning may not be reentered')
		this.#state = { phase: 'running', poison }
		return this.#complete(attempt(() => this.#execute()))
	}

	#complete(outcome: Result<JSONSchema>): JSONSchema {
		const state = this.#state
		if (state.phase === 'interrupted') {
			return this.#settle({ success: false, error: state.poison })
		}
		if (outcome.success) return this.#settle(outcome)

		const error = this.#owns(outcome.error)
			? outcome.error
			: this.#create('cloneSchema: failed to create an owned schema snapshot', {
					cause: outcome.error,
				})
		return this.#settle({ success: false, error })
	}

	#execute(): JSONSchema {
		// The root is branded like every other node. `#schedule` has always branched
		// on `Array.isArray`, so a nested array kept its brand while an ARRAY ROOT
		// was silently republished as a null-prototype record — one construct, two
		// answers depending on position, from a door whose whole contract is a
		// faithful owned snapshot. A `JSONSchema` root is a record, and a snapshot
		// that cannot be faithful refuses rather than rebrands. The rule is the ROOT's
		// alone: a schema graph is otherwise deliberately unbranded, so a class
		// instance stays acceptable schema data.
		if (INTRINSICS.array(this.#source)) {
			this.#refuse('cloneSchema: a schema root must be a record, not an array', 'structure', [])
		}
		// Narrowed once at the door, because the dispatch below takes its receiver
		// type from this value. The walk runs before `#settle` drops the map, so it
		// always finds the one the constructor built; this refusal is what keeps
		// that a statement the types carry rather than one a comment makes.
		const memo = this.#memo
		if (memo === undefined) throw this.#unavailable()
		const root: JSONSchema = INTRINSICS.create(null)
		INTRINSICS.reflect.apply(INTRINSICS.store, memo, [this.#source, root])
		this.#pending[this.#pending.length] = {
			source: this.#source,
			clone: root,
			path: [],
			depth: 0,
		}
		this.#drain()
		return root
	}

	#drain(): void {
		while (this.#pending.length > 0) {
			const frame = this.#pending.pop()
			if (frame === undefined) continue
			if (frame.depth > COMPILE_DEPTH_LIMIT) {
				// This door carried NO depth bound at all while every other public
				// traversal carried one, and its per-key path copy makes the walk
				// quadratic, so a 16,000-level schema — a few hundred kilobytes of
				// `JSON.parse`-able text — bought tens of seconds of work. The bound is
				// the shared compilation limit, and it is unreachable from `ShapeCloner`,
				// whose raw path validates the fragment against the same limit first.
				this.#refuse('cloneSchema: schema exceeds the compilation depth limit', 'depth', frame.path)
			}
			const keys = enumerableKeys(frame.source)
			if (keys === undefined) {
				throw this.#create('cloneSchema: property enumeration failed', { path: frame.path })
			}

			// Indexed, not iterated: this walk decides the cloned node's own-key
			// population, so a lying `Array.prototype[Symbol.iterator]` would place a
			// key the source never had into a snapshot documented as faithful.
			for (let index = 0; index < keys.length; index += 1) {
				const key = keys[index]
				if (key === undefined) continue
				const path = pathOf(frame.path, key)
				const source = this.#read(frame.source, key, path)
				const clone = this.#capture(source, path, frame.depth + 1)
				INTRINSICS.define(frame.clone, key, {
					value: clone,
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}

			INTRINSICS.freeze(frame.clone)
		}
	}

	#capture(value: unknown, path: readonly string[], depth: number): unknown {
		if (typeof value !== 'object' || value === null) return value
		const memo = this.#memo
		if (memo === undefined) throw this.#unavailable()
		const existing = INTRINSICS.reflect.apply(INTRINSICS.fetch, memo, [value])
		if (existing !== undefined) return existing
		return this.#schedule(value, path, depth)
	}

	#schedule(source: object, path: readonly string[], depth: number): object {
		const memo = this.#memo
		if (memo === undefined) throw this.#unavailable()
		const clone: object = INTRINSICS.array(source) ? [] : INTRINSICS.create(null)
		INTRINSICS.reflect.apply(INTRINSICS.store, memo, [source, clone])
		this.#pending[this.#pending.length] = { source, clone, path, depth }
		return clone
	}

	#read(source: object, key: string, path: readonly string[]): unknown {
		const outcome = attempt(() => INTRINSICS.reflect.read(source, key))
		if (outcome.success) return outcome.value
		throw this.#create('cloneSchema: property access failed', {
			path,
			cause: outcome.error,
		})
	}

	// One refusal for the dropped working map, because a settled cloner replays
	// from `#state` and re-enters no walk method: nothing reachable settles here,
	// and every guard that says so must say it the same way.
	#unavailable(): ContractError {
		return this.#create('SchemaCloner.clone: the capture state is unavailable')
	}

	#create(
		message: string,
		options?: { readonly path?: readonly string[]; readonly cause?: unknown },
	): ContractError {
		// Own reads only, exactly as the diagnostic's `cause` already was: the
		// translation literal below carries `cause` and no `path`, so an
		// unqualified `options.path` would leave the literal and consult
		// `Object.prototype`, which the caller being diagnosed can write.
		const path =
			options !== undefined && SchemaCloner.#hasOwn(options, 'path') ? options.path : undefined
		const context = path === undefined ? { shape: 'schema' } : { path, shape: 'schema' }
		const error =
			options !== undefined && SchemaCloner.#hasOwn(options, 'cause')
				? new ContractError(message, { code: 'clone', context, cause: options.cause })
				: new ContractError(message, { code: 'clone', context })
		admitVisited(this.#owned, error)
		return error
	}

	// The rules this engine OWNS rather than adopts: the record-rooted snapshot
	// and the shared depth bound. Registered as owned exactly as `#create` does,
	// so terminal replay still answers by identity.
	#refuse(message: string, code: 'structure' | 'depth', path: readonly string[]): never {
		const error = new ContractError(message, {
			code,
			context:
				code === 'depth'
					? { path, shape: 'schema', limit: COMPILE_DEPTH_LIMIT }
					: { path, shape: 'schema' },
		})
		admitVisited(this.#owned, error)
		throw error
	}

	#owns(error: unknown): error is ContractError {
		return isObject(error) && matchesVisited(this.#owned, error)
	}

	// Assignment only: the working list takes the class's shared frozen empty peer
	// and the working map is dropped outright. Nothing here calls a
	// caller-mutable cleanup member and nothing here constructs a collection, so
	// settlement cannot be redirected into leaving state behind.
	#settle(result: Result<JSONSchema, ContractError>): JSONSchema {
		this.#pending = SchemaCloner.#emptyPending
		this.#memo = undefined
		this.#state = { phase: 'settled', result }
		if (result.success) return result.value
		throw result.error
	}

	static {
		// Frozen in a statement of its own, and the result discarded: `Object.freeze`
		// returns a readonly view, so binding it back would retype the peer and stop
		// it satisfying the mutable working field it is assigned to.
		INTRINSICS.freeze(SchemaCloner.#emptyPending)
		// Pinned while this class is DEFINED: `cloneSchema` reaches it through
		// `SchemaCloner.prototype.clone`, so an assignment there decides what a door
		// the caller never touched publishes.
		pinMembers(SchemaCloner.prototype, 'SchemaCloner')
	}
}
