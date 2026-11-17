import type {
	ContractErrorContext,
	JSONClonerInterface,
	JSONRecord,
	JSONValue,
	Result,
} from './types.js'
import { CLONE_NODE_LIMIT, INTRINSICS } from './constants.js'
import { ContractError } from './errors.js'
import {
	iterateIndices,
	admitVisited,
	attempt,
	failure,
	collectMembers,
	isFailure,
	isSuccess,
	matchesMember,
	matchesVisited,
	omitVisited,
	pinMembers,
	preview,
	renderPath,
} from './helpers.js'
import { isObject, isRecord } from './validators.js'

/**
 * Owns the state of one exact JSON snapshot operation.
 *
 * @remarks
 * Construction retains the source without observing it. The first
 * {@link clone} call performs one iterative descriptor walk and settles
 * permanently. Success replays the exact frozen root; failure rethrows the
 * exact class-owned error. Nonredirectable terminal failure releases partial
 * traversal working state while retaining the source and exact error. Reentry
 * invalidates the active operation and every later call with one shared cause-free
 * error.
 *
 * @param value - The unknown value to retain for cloning
 *
 * @example
 * ```ts
 * const source = { settings: { enabled: true } }
 * const cloner = new JSONCloner(source)
 * const clone = cloner.clone()
 * source.settings.enabled = false
 * cloner.clone() === clone // true
 * ```
 */
export class JSONCloner implements JSONClonerInterface {
	// Captured while this module evaluates — the qualification matters, because
	// "before any caller code runs" is false for a consumer module ordered
	// earlier, which is the limit `constants.ts` states and does not defend. So no
	// caller code that runs AFTER this module can replace
	// them. Terminal settlement must reach the genuine implementation of every
	// intrinsic it dispatches through, or a caller who redirects one after
	// construction makes the first call escape with a raw caller value while the
	// replay reports the reentry refusal — two different answers for one
	// operation. The constructor is already too late: a reentry error, and so its
	// ownership record, is created before the source is ever observed. The
	// The active-path set is NOT an exception to that, and the sentence that made
	// it one was wrong: a redirected member there does not produce an owned
	// refusal, it removes the cycle test, and `WeakSet.prototype.has` answering
	// `false` made this class grow `#pending` without bound on a cyclic source —
	// no refusal, no return, and no instrument in the corpus able to report it.
	// Both sets are read through the captured visitation operations.
	static readonly #weakSet = WeakSet
	// The released state, shared by every cloner this class ever builds. `#fail`
	// assigns it in place of the working list, so a failed clone releases its
	// frames to collection instead of retaining an emptied array's capacity for
	// the instance's life. Sharing is safe because nothing writes to a released
	// list: every writer runs inside the walk, and a failed clone has already set
	// `#terminal`, which every later call answers from. The static block at the
	// foot of the class freezes it, so a write that did reach it fails loudly at
	// its own line rather than leaking one cloner's frame into every other
	// cloner's release.
	static readonly #emptyPending: Array<{
		readonly source: object
		readonly clone: JSONValue[] | JSONRecord
		readonly array: boolean
		entries: ReadonlyArray<readonly [key: string, value: unknown]> | undefined
		index: number
	}> = []
	readonly #source: unknown
	readonly #owned: WeakSet<object>
	readonly #active: WeakSet<object>
	#pending: Array<{
		readonly source: object
		readonly clone: JSONValue[] | JSONRecord
		readonly array: boolean
		entries: ReadonlyArray<readonly [key: string, value: unknown]> | undefined
		index: number
	}>
	#poison: ContractError | undefined
	#terminal: Result<JSONValue, ContractError> | undefined

	constructor(value: unknown) {
		this.#source = value
		this.#owned = new JSONCloner.#weakSet()
		this.#active = new JSONCloner.#weakSet()
		this.#pending = []
		this.#poison = undefined
		this.#terminal = undefined
	}

	/**
	 * Clones the retained source into exact, deeply frozen JSON data.
	 *
	 * @param budget - Remaining nodes shared with an enclosing ownership operation
	 * @returns The settled JSON snapshot
	 * @throws {ContractError} When the source is inexact, cyclic, unreadable, or cloning is reentered
	 */
	clone(budget: { left: number } = { left: CLONE_NODE_LIMIT }): JSONValue {
		const terminal = this.#terminal
		if (terminal !== undefined) {
			if (isSuccess(terminal)) return terminal.value
			throw terminal.error
		}

		const poison = this.#poison
		if (poison !== undefined) {
			this.#terminal = failure(poison)
			throw poison
		}

		this.#poison = this.#create('JSONCloner.clone: JSON cloning may not be reentered', {
			shape: 'json',
		})
		const outcome = attempt(() => this.#execute(budget))
		const interruption = this.#terminal
		if (interruption !== undefined) {
			if (isSuccess(interruption)) return interruption.value
			this.#fail(interruption.error)
		}
		if (isSuccess(outcome)) {
			this.#terminal = outcome
			return outcome.value
		}

		const error = this.#owns(outcome.error)
			? outcome.error
			: this.#create('cloneJSONValue: failed to create an owned JSON snapshot', { shape: 'json' })
		this.#fail(error)
	}

	// Assignment only: the working list takes the class's shared frozen empty peer
	// rather than being truncated in place, so the abandoned frames are released
	// instead of held by an emptied array. `length` is a caller-reachable write on
	// the instance's own array; an assignment reaches no member at all.
	#fail(error: ContractError): never {
		this.#terminal = failure(error)
		this.#pending = JSONCloner.#emptyPending
		throw error
	}

	#execute(budget: { left: number }): JSONValue {
		if (!INTRINSICS.safe(budget.left)) {
			this.#refuse('cloneJSONValue: invalid node budget', { shape: 'json' })
		}
		budget.left = INTRINSICS.min(budget.left, CLONE_NODE_LIMIT)
		const root = this.#capture(this.#source, budget)
		this.#drain(budget)
		return root
	}

	#drain(budget: { left: number }): void {
		while (this.#pending.length > 0) {
			const frame = this.#pending[this.#pending.length - 1]
			if (frame === undefined) continue

			if (frame.entries === undefined) {
				frame.entries = frame.array
					? this.#captureArray(frame.source)
					: this.#captureRecord(frame.source)
			}

			const entry = frame.entries[frame.index]
			if (entry === undefined) {
				INTRINSICS.freeze(frame.clone)
				omitVisited(this.#active, frame.source)
				this.#pending.pop()
				continue
			}
			frame.index += 1

			const clone = this.#capture(entry[1], budget)
			INTRINSICS.define(frame.clone, entry[0], {
				value: clone,
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
	}

	#capture(value: unknown, budget: { left: number }): JSONValue {
		// Counted before the value is classified, so a leaf costs a tick too: the
		// blowup is in how many nodes the OUTPUT holds, and every produced node is
		// one unit of work and one unit of retained memory.
		budget.left -= 1
		if (budget.left < 0) {
			this.#refuse(`cloneJSONValue: snapshot exceeds the node limit ${CLONE_NODE_LIMIT}`, {
				shape: 'json',
				limit: CLONE_NODE_LIMIT,
			})
		}
		if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
		if (typeof value === 'number') {
			if (INTRINSICS.finite(value)) return value
			this.#refusePath('number is not finite', preview(value))
		}
		if (typeof value === 'object') return this.#captureObject(value)
		this.#refusePath(
			this.#pending.length === 0 ? 'value is not JSON data' : 'property is not JSON data',
			preview(value),
		)
	}

	#captureObject(source: object): JSONValue[] | JSONRecord {
		if (matchesVisited(this.#active, source)) this.#refusePath('cycle detected', preview(source))
		const arrayOutcome = attempt(() => INTRINSICS.array(source))
		if (isFailure(arrayOutcome)) {
			this.#refusePath('value brand could not be inspected', preview(source))
		}
		if (arrayOutcome.value) return this.#schedule(source, true)
		if (isRecord(source)) return this.#schedule(source, false)
		this.#refusePath('object is not a plain record', preview(source))
	}

	#schedule(source: object, array: boolean): JSONValue[] | JSONRecord {
		const clone: JSONValue[] | JSONRecord = array ? [] : INTRINSICS.create(null)
		admitVisited(this.#active, source)
		this.#pending[this.#pending.length] = {
			source,
			clone,
			array,
			entries: undefined,
			index: 0,
		}
		return clone
	}

	#captureArray(source: object): ReadonlyArray<readonly [key: string, value: unknown]> {
		const keysOutcome = attempt(() => INTRINSICS.reflect.members(source))
		if (isFailure(keysOutcome)) this.#refusePath('own keys could not be inspected', preview(source))
		const lengthOutcome = attempt(() => INTRINSICS.reflect.describe(source, 'length'))
		if (isFailure(lengthOutcome)) {
			this.#refusePath('array length could not be inspected', preview(source))
		}
		const lengthDescriptor = lengthOutcome.value
		if (
			lengthDescriptor === undefined ||
			!INTRINSICS.own(lengthDescriptor, 'value') ||
			typeof lengthDescriptor.value !== 'number' ||
			!INTRINSICS.integer(lengthDescriptor.value) ||
			lengthDescriptor.value < 0 ||
			lengthDescriptor.value > 4_294_967_295 ||
			lengthDescriptor.enumerable !== false ||
			lengthDescriptor.configurable !== false
		) {
			this.#refusePath('array is not intrinsic and dense', preview(source))
		}

		// A collected vocabulary plus an exact count, not a shrinking `Set`:
		// exactness is the verdict this door PUBLISHES about the caller's array, and
		// `Set.prototype.delete` and the `size` accessor are two more members the
		// caller can answer for. `Reflect.ownKeys` never repeats a key — a proxy
		// trap returning duplicates is rejected by the host — so "every index plus
		// `length`, and nothing else" is exactly "each is present, and the count
		// matches".
		const owned = collectMembers(keysOutcome.value)
		if (!matchesMember(owned, 'length')) {
			this.#refusePath('array own keys are not exact', preview(source))
		}
		if (keysOutcome.value.length !== lengthDescriptor.value + 1) {
			this.#refusePath('array own keys are not exact', preview(source))
		}
		return INTRINSICS.from(
			iterateIndices(() => lengthDescriptor.value),
			(index): readonly [string, unknown] => {
				const key = INTRINSICS.text(index)
				if (!matchesMember(owned, key)) {
					this.#refusePath('array own keys are not exact', preview(source))
				}
				const descriptorOutcome = attempt(() => INTRINSICS.reflect.describe(source, key))
				if (isFailure(descriptorOutcome)) {
					this.#refusePath('array index could not be inspected', 'threw', key)
				}
				const descriptor = descriptorOutcome.value
				if (
					descriptor === undefined ||
					!INTRINSICS.own(descriptor, 'value') ||
					descriptor.enumerable !== true
				) {
					this.#refuseMember('array index is not enumerable data', descriptor, key)
				}
				return [key, descriptor.value]
			},
		)
	}

	#captureRecord(source: object): ReadonlyArray<readonly [key: string, value: unknown]> {
		const keysOutcome = attempt(() => INTRINSICS.reflect.members(source))
		if (isFailure(keysOutcome)) this.#refusePath('own keys could not be inspected', preview(source))
		const names = keysOutcome.value
		// Indexed, not iterated: this walk decides the published record's own-key
		// population, and an iterator is a caller-writable member that can yield a
		// key the source never had.
		return INTRINSICS.from(
			iterateIndices(() => names.length),
			(index): readonly [string, unknown] => {
				const key = names[index]
				// Every string can be a key, so a symbol takes no segment and is named in the text.
				if (typeof key !== 'string') {
					this.#refusePath(`record has a symbol property ${preview(key)}`, preview(key))
				}
				const descriptorOutcome = attempt(() => INTRINSICS.reflect.describe(source, key))
				if (isFailure(descriptorOutcome)) {
					this.#refusePath('record property could not be inspected', 'threw', key)
				}
				const descriptor = descriptorOutcome.value
				if (
					descriptor === undefined ||
					!INTRINSICS.own(descriptor, 'value') ||
					descriptor.enumerable !== true
				) {
					this.#refuseMember('record property is not enumerable data', descriptor, key)
				}
				return [key, descriptor.value]
			},
		)
	}

	#create(message: string, context: ContractErrorContext): ContractError {
		const error = new ContractError(message, { code: 'clone', context })
		admitVisited(this.#owned, error)
		return error
	}

	#owns(error: unknown): error is ContractError {
		return isObject(error) && matchesVisited(this.#owned, error)
	}

	#refuse(message: string, context: ContractErrorContext): never {
		const terminal = this.#terminal
		if (terminal !== undefined && isFailure(terminal)) throw terminal.error
		throw this.#create(message, context)
	}

	// The root names no member, so its refusal carries the empty path and no suffix.
	#refusePath(reason: string, received: string, key?: string): never {
		const path = this.#trace(key)
		this.#refuse(
			path.length === 0
				? `cloneJSONValue: ${reason}`
				: `cloneJSONValue: ${reason} at ${renderPath(path)}`,
			{ shape: 'json', path, received },
		)
	}

	// Names what the descriptor holds instead of a value, and never runs an accessor.
	#refuseMember(reason: string, descriptor: PropertyDescriptor | undefined, key: string): never {
		this.#refusePath(
			reason,
			descriptor === undefined
				? preview(undefined)
				: INTRINSICS.own(descriptor, 'value')
					? preview(descriptor.value)
					: 'accessor',
			key,
		)
	}

	// Each frame below the top holds its current entry; a capture method's key stands in for the top's.
	#trace(key: string | undefined): readonly string[] {
		const pending = this.#pending
		const top = pending[pending.length - 1]
		const size =
			top?.entries === undefined && key === undefined ? pending.length - 1 : pending.length
		return INTRINSICS.from(
			iterateIndices(() => size),
			(index): string => {
				const frame = pending[index]
				const entry = frame?.entries?.[frame.index - 1]
				return entry === undefined ? (key ?? '') : entry[0]
			},
		)
	}

	static {
		// Frozen in a statement of its own, and the result discarded: `Object.freeze`
		// returns a readonly view, so binding it back would retype the peer and stop
		// it satisfying the mutable working field it is assigned to.
		INTRINSICS.freeze(JSONCloner.#emptyPending)
		// Pinned while this class is DEFINED. `cloneJSONValue` reaches this class
		// through `JSONCloner.prototype.clone`, so one assignment there decided what
		// a door the caller never touched published — the same defect as a replaced
		// host member, with this package's own name on it.
		pinMembers(JSONCloner.prototype, 'JSONCloner')
	}
}
