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
 * Stateful owner of one JSON Schema snapshot operation.
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
	readonly #source: JSONSchema
	readonly #owned: WeakSet<object>
	#memo: Map<object, object>
	readonly #emptyMemo: Map<object, object>
	#pending: Array<{
		readonly source: object
		readonly clone: object
		readonly path: readonly string[]
		readonly depth: number
	}>
	readonly #emptyPending: Array<{
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
		this.#emptyMemo = new SchemaCloner.#map()
		this.#pending = []
		this.#emptyPending = []
		this.#state = { phase: 'ready' }
	}

	/**
	 * Clone the retained schema into an identity-preserving frozen graph.
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
		const root: JSONSchema = INTRINSICS.create(null)
		INTRINSICS.apply(INTRINSICS.store, this.#memo, [this.#source, root])
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
		const existing = INTRINSICS.apply(INTRINSICS.fetch, this.#memo, [value])
		if (existing !== undefined) return existing
		return this.#schedule(value, path, depth)
	}

	#schedule(source: object, path: readonly string[], depth: number): object {
		const clone: object = INTRINSICS.array(source) ? [] : INTRINSICS.create(null)
		INTRINSICS.apply(INTRINSICS.store, this.#memo, [source, clone])
		this.#pending[this.#pending.length] = { source, clone, path, depth }
		return clone
	}

	#read(source: object, key: string, path: readonly string[]): unknown {
		const outcome = attempt(() => INTRINSICS.read(source, key))
		if (outcome.success) return outcome.value
		throw this.#create('cloneSchema: property access failed', {
			path,
			cause: outcome.error,
		})
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

	// Two rules this engine OWNS rather than adopts: the record-rooted snapshot
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

	#settle(result: Result<JSONSchema, ContractError>): JSONSchema {
		this.#pending = this.#emptyPending
		this.#memo = this.#emptyMemo
		this.#state = { phase: 'settled', result }
		if (result.success) return result.value
		throw result.error
	}

	static {
		// Pinned while this class is DEFINED: `cloneSchema` reaches it through
		// `SchemaCloner.prototype.clone`, so an assignment there decides what a door
		// the caller never touched publishes.
		pinMembers(SchemaCloner.prototype, 'SchemaCloner')
	}
}
