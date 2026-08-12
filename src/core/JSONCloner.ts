import type { JSONClonerInterface, JSONRecord, JSONValue, Result } from './types.js'
import { CLONE_NODE_LIMIT, INTRINSICS } from './constants.js'
import { ContractError } from './errors.js'
import {
	admitVisited,
	attempt,
	collectMembers,
	matchesMember,
	matchesVisited,
	omitVisited,
	pinMembers,
} from './helpers.js'
import { isObject, isRecord } from './validators.js'

/**
 * Stateful owner of one exact JSON snapshot operation.
 *
 * @remarks
 * Construction retains the source without observing it. The first
 * {@link clone} call performs one iterative descriptor walk and settles
 * permanently. Success replays the exact frozen root; failure rethrows the
 * exact class-owned error. Nonredirectable terminal failure releases partial
 * traversal working state while retaining the source and exact error. Reentry
 * poisons the active operation and every later call with one shared cause-free
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
	// replay reports the reentry poison — two different answers for one
	// operation. The constructor is already too late: a poison error, and so its
	// ownership record, is created before the source is ever observed. The
	// The active-path set is NOT an exception to that, and the sentence that made
	// it one was wrong: a redirected member there does not produce an owned
	// refusal, it removes the cycle test, and `WeakSet.prototype.has` answering
	// `false` made this class grow `#pending` without bound on a cyclic source —
	// no refusal, no return, and no instrument in the corpus able to report it.
	// Both sets are read through the captured visitation operations.
	static readonly #weakSet = WeakSet
	readonly #source: unknown
	readonly #owned: WeakSet<object>
	readonly #active: WeakSet<object>
	readonly #pending: Array<{
		readonly source: object
		readonly clone: JSONValue[] | JSONRecord
		readonly array: boolean
		entries: ReadonlyArray<readonly [key: string, value: unknown]> | undefined
		index: number
	}>
	// Every node this walk PRODUCES, not every node the source holds: the two
	// differ by exactly the alias duplication the tree contract requires, and it
	// is the produced count that grows exponentially.
	#produced: number
	#poison: ContractError | undefined
	#terminal: Result<JSONValue, ContractError> | undefined

	constructor(value: unknown) {
		this.#source = value
		this.#owned = new JSONCloner.#weakSet()
		this.#active = new JSONCloner.#weakSet()
		this.#pending = []
		this.#produced = 0
		this.#poison = undefined
		this.#terminal = undefined
	}

	/**
	 * Clone the retained source into exact, deeply frozen JSON data.
	 *
	 * @returns The settled JSON snapshot
	 * @throws {ContractError} When the source is inexact, cyclic, unreadable, or cloning is reentered
	 */
	clone(): JSONValue {
		const terminal = this.#terminal
		if (terminal !== undefined) {
			if (terminal.success) return terminal.value
			throw terminal.error
		}

		const poison = this.#poison
		if (poison !== undefined) {
			this.#terminal = { success: false, error: poison }
			throw poison
		}

		this.#poison = this.#create('JSONCloner.clone: JSON cloning may not be reentered')
		const outcome = attempt(() => this.#execute())
		const interruption = this.#terminal
		if (interruption !== undefined) {
			if (interruption.success) return interruption.value
			this.#fail(interruption.error)
		}
		if (outcome.success) {
			this.#terminal = outcome
			return outcome.value
		}

		const error = this.#owns(outcome.error)
			? outcome.error
			: this.#create('cloneJSONValue: failed to create an owned JSON snapshot')
		this.#fail(error)
	}

	#fail(error: ContractError): never {
		this.#terminal = { success: false, error }
		this.#pending.length = 0
		throw error
	}

	#execute(): JSONValue {
		const root = this.#capture(this.#source)
		this.#drain()
		return root
	}

	#drain(): void {
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

			const clone = this.#capture(entry[1])
			INTRINSICS.define(frame.clone, entry[0], {
				value: clone,
				enumerable: true,
				configurable: true,
				writable: true,
			})
		}
	}

	#capture(value: unknown): JSONValue {
		// Counted before the value is classified, so a leaf costs a tick too: the
		// blowup is in how many nodes the OUTPUT holds, and every produced node is
		// one unit of work and one unit of retained memory.
		this.#produced += 1
		if (this.#produced > CLONE_NODE_LIMIT) {
			this.#refuse('cloneJSONValue: snapshot exceeds the node limit')
		}
		if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
		if (typeof value === 'number') {
			if (INTRINSICS.finite(value)) return value
			this.#refuse('cloneJSONValue: number is not finite')
		}
		if (typeof value === 'object') return this.#captureObject(value)
		this.#refuse(
			this.#pending.length === 0
				? 'cloneJSONValue: value is not JSON data'
				: 'cloneJSONValue: property is not JSON data',
		)
	}

	#captureObject(source: object): JSONValue[] | JSONRecord {
		if (matchesVisited(this.#active, source)) this.#refuse('cloneJSONValue: cycle detected')
		const arrayOutcome = attempt(() => INTRINSICS.array(source))
		if (!arrayOutcome.success) this.#refuse('cloneJSONValue: value brand could not be inspected')
		if (arrayOutcome.value) return this.#schedule(source, true)
		if (isRecord(source)) return this.#schedule(source, false)
		this.#refuse('cloneJSONValue: object is not a plain record')
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
		const keysOutcome = attempt(() => INTRINSICS.members(source))
		if (!keysOutcome.success) this.#refuse('cloneJSONValue: own keys could not be inspected')
		const lengthOutcome = attempt(() => INTRINSICS.reveal(source, 'length'))
		if (!lengthOutcome.success) this.#refuse('cloneJSONValue: array length could not be inspected')
		const lengthDescriptor = lengthOutcome.value
		if (
			lengthDescriptor === undefined ||
			!('value' in lengthDescriptor) ||
			typeof lengthDescriptor.value !== 'number' ||
			!INTRINSICS.integer(lengthDescriptor.value) ||
			lengthDescriptor.value < 0 ||
			lengthDescriptor.value > 4_294_967_295 ||
			lengthDescriptor.enumerable !== false ||
			lengthDescriptor.configurable !== false
		) {
			this.#refuse('cloneJSONValue: array is not intrinsic and dense')
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
			this.#refuse('cloneJSONValue: array own keys are not exact')
		}
		if (keysOutcome.value.length !== lengthDescriptor.value + 1) {
			this.#refuse('cloneJSONValue: array own keys are not exact')
		}
		const entries: Array<[key: string, value: unknown]> = []
		for (let index = 0; index < lengthDescriptor.value; index += 1) {
			const key = INTRINSICS.text(index)
			if (!matchesMember(owned, key)) {
				this.#refuse('cloneJSONValue: array own keys are not exact')
			}
			const descriptorOutcome = attempt(() => INTRINSICS.reveal(source, key))
			if (!descriptorOutcome.success) {
				this.#refuse('cloneJSONValue: array index could not be inspected')
			}
			const descriptor = descriptorOutcome.value
			if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
				this.#refuse('cloneJSONValue: array index is not enumerable data')
			}
			entries[entries.length] = [key, descriptor.value]
		}
		return entries
	}

	#captureRecord(source: object): ReadonlyArray<readonly [key: string, value: unknown]> {
		const keysOutcome = attempt(() => INTRINSICS.members(source))
		if (!keysOutcome.success) this.#refuse('cloneJSONValue: own keys could not be inspected')
		const entries: Array<[key: string, value: unknown]> = []
		const names = keysOutcome.value
		// Indexed, not iterated: this walk decides the published record's own-key
		// population, and an iterator is a caller-writable member that can yield a
		// key the source never had.
		for (let index = 0; index < names.length; index += 1) {
			const key = names[index]
			if (typeof key !== 'string') this.#refuse('cloneJSONValue: record has a symbol property')
			const descriptorOutcome = attempt(() => INTRINSICS.reveal(source, key))
			if (!descriptorOutcome.success) {
				this.#refuse('cloneJSONValue: record property could not be inspected')
			}
			const descriptor = descriptorOutcome.value
			if (descriptor === undefined || !('value' in descriptor) || descriptor.enumerable !== true) {
				this.#refuse('cloneJSONValue: record property is not enumerable data')
			}
			entries[entries.length] = [key, descriptor.value]
		}
		return entries
	}

	#create(message: string): ContractError {
		const error = new ContractError(message, {
			code: 'clone',
			context: { shape: 'json' },
		})
		admitVisited(this.#owned, error)
		return error
	}

	#owns(error: unknown): error is ContractError {
		return isObject(error) && matchesVisited(this.#owned, error)
	}

	#refuse(message: string): never {
		const terminal = this.#terminal
		if (terminal !== undefined && !terminal.success) throw terminal.error
		throw this.#create(message)
	}

	static {
		// Pinned while this class is DEFINED. `cloneJSONValue` reaches this class
		// through `JSONCloner.prototype.clone`, so one assignment there decided what
		// a door the caller never touched published — the same defect as a replaced
		// host member, with this package's own name on it.
		pinMembers(JSONCloner.prototype, 'JSONCloner')
	}
}
