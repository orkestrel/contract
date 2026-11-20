import type { CapturePlan, Result } from './types.js'
import { CLONE_NODE_LIMIT, INTRINSICS } from './constants.js'
import { ContractError } from './errors.js'
import {
	attempt,
	buildChildPath,
	isFailure,
	isSuccess,
	iterateIndices,
	pathOf,
	pinMembers,
	readValue,
} from './helpers.js'
import { isRecord } from './validators.js'

/**
 * Owns the snapshot one owning admission judges in place of the caller's value.
 *
 * @remarks
 * Construction retains the value and its plan without observing either. The first {@link clone}
 * call walks the value once and settles: later calls replay the same snapshot or the same error.
 * A plain record or array is copied, with each own enumerable string member and each present
 * index read one time, an accessor read into data, and each copy frozen; one copy per source and
 * plan keeps sharing and cycles. An own non-enumerable or symbol key keeps its presence and its
 * enumerability: a data member carries its captured value, and an accessor carries `undefined` and
 * never runs. A position the plan holds, any other object, and every function are held by
 * identity and never read.
 *
 * @example
 * ```ts
 * const source = { name: 'Ada', tags: ['admin'] }
 * const snapshot = new ValueCloner(source, undefined).clone()
 * Object.isFrozen(snapshot) // true
 * ```
 */
export class ValueCloner {
	readonly #source: unknown
	readonly #plan: CapturePlan | undefined
	// One copy per source under each plan, because one source can sit at a held position and at a copied one.
	readonly #copies: Map<CapturePlan | undefined, Map<object, object>>
	readonly #pending: Array<{
		readonly source: object
		readonly copy: object
		readonly array: boolean
		readonly plan: CapturePlan | undefined
		readonly path: readonly string[]
	}>
	#left: number
	#settled: Result<unknown> | undefined

	/**
	 * Retains a value and the plan that says where it is held, without observing either.
	 *
	 * @param value - The value to snapshot
	 * @param plan - Where the snapshot holds by identity; `undefined` copies every plain record and array
	 */
	constructor(value: unknown, plan: CapturePlan | undefined) {
		this.#source = value
		this.#plan = plan
		this.#copies = new INTRINSICS.map()
		this.#pending = []
		this.#left = CLONE_NODE_LIMIT
		this.#settled = undefined
	}

	/**
	 * Returns the settled snapshot of the retained value.
	 *
	 * @returns The snapshot
	 * @throws {ContractError} When the snapshot passes {@link CLONE_NODE_LIMIT} nodes, or a member or the value cannot be read
	 */
	clone(): unknown {
		const settled = this.#settled ?? this.#settle()
		if (isSuccess(settled)) return settled.value
		throw settled.error
	}

	#settle(): Result<unknown> {
		const settled = attempt(() => this.#walk())
		this.#settled = settled
		return settled
	}

	#walk(): unknown {
		const root = this.#capture(this.#source, this.#plan, [], undefined)
		while (this.#pending.length > 0) {
			const top = this.#pending.length - 1
			const frame = this.#pending[top]
			this.#pending.length = top
			if (frame !== undefined) this.#fill(frame)
		}
		return root
	}

	// Counted before the value is classified, so every node the snapshot holds costs one unit.
	#count(path: readonly string[], key: string | undefined): void {
		this.#left -= 1
		if (this.#left >= 0) return
		throw new ContractError(`own: snapshot exceeds the node limit ${CLONE_NODE_LIMIT}`, {
			code: 'clone',
			context: { path: pathOf(path, key), limit: CLONE_NODE_LIMIT },
		})
	}

	// `path` locates the container and `key` the member in it, so a path is built only for a
	// container the walk descends into and for a refusal.
	#capture(
		value: unknown,
		plan: CapturePlan | undefined,
		path: readonly string[],
		key: string | undefined,
	): unknown {
		this.#count(path, key)
		if (plan?.held === true || typeof value !== 'object' || value === null) return value
		const copies = this.#copiesOf(plan)
		const known: object | undefined = INTRINSICS.reflect.apply(INTRINSICS.fetch, copies, [value])
		if (known !== undefined) return known
		const shell = attempt((): { readonly copy: object; readonly array: boolean } | undefined =>
			INTRINSICS.array(value)
				? { copy: [], array: true }
				: isRecord(value)
					? { copy: INTRINSICS.create(INTRINSICS.reflect.prototype(value)), array: false }
					: undefined,
		)
		if (isFailure(shell)) this.#refuse('value', shell.error, path, key)
		if (shell.value === undefined) return value
		const { copy, array } = shell.value
		INTRINSICS.reflect.apply(INTRINSICS.store, copies, [value, copy])
		this.#pending[this.#pending.length] = {
			source: value,
			copy,
			array,
			plan,
			path: key === undefined ? path : buildChildPath(path, key),
		}
		return copy
	}

	#refuse(
		subject: string,
		cause: unknown,
		path: readonly string[],
		key: string | undefined,
	): never {
		return readValue(
			(): never => {
				throw cause
			},
			'own',
			{ subject, context: { path: pathOf(path, key) } },
		)
	}

	// A member outside the enumerable view gives its data value and never runs its accessor.
	static #read(
		source: object,
		key: string | symbol,
	): { readonly enumerable: boolean; readonly value: unknown } {
		const descriptor = INTRINSICS.reflect.describe(source, key)
		const enumerable = descriptor?.enumerable === true
		if (descriptor !== undefined && INTRINSICS.own(descriptor, 'value')) {
			return { enumerable, value: descriptor.value }
		}
		if (typeof key !== 'string' || !enumerable) return { enumerable, value: undefined }
		return { enumerable, value: INTRINSICS.reflect.read(source, key) }
	}

	#copiesOf(plan: CapturePlan | undefined): Map<object, object> {
		const known: Map<object, object> | undefined = INTRINSICS.reflect.apply(
			INTRINSICS.fetch,
			this.#copies,
			[plan],
		)
		if (known !== undefined) return known
		const created = new INTRINSICS.map<object, object>()
		INTRINSICS.reflect.apply(INTRINSICS.store, this.#copies, [plan, created])
		return created
	}

	#fill(frame: {
		readonly source: object
		readonly copy: object
		readonly array: boolean
		readonly plan: CapturePlan | undefined
		readonly path: readonly string[]
	}): void {
		const { source, copy, array, plan, path } = frame
		const keys = attempt(() => INTRINSICS.reflect.members(source))
		if (isFailure(keys)) this.#refuse('value', keys.error, path, undefined)
		for (const index of iterateIndices(() => keys.value.length)) {
			const key = keys.value[index]
			if (key === undefined || (array && key === 'length')) continue
			// A symbol key takes no path segment and no plan.
			const label = typeof key === 'string' ? key : undefined
			const member = attempt(() => ValueCloner.#read(source, key))
			if (isFailure(member)) this.#refuse('member', member.error, path, label)
			// A declared key takes its own plan, even an absent one, before the tail plan.
			const child =
				label === undefined
					? undefined
					: plan === undefined || array
						? plan?.items
						: INTRINSICS.own(plan.properties, label)
							? plan.properties[label]
							: plan.tail
			INTRINSICS.define(copy, key, {
				value: this.#capture(member.value.value, child, path, label),
				enumerable: member.value.enumerable,
				writable: true,
				configurable: true,
			})
		}
		if (array) {
			const length = attempt(() => INTRINSICS.reflect.describe(source, 'length'))
			if (isFailure(length)) this.#refuse('value', length.error, path, undefined)
			if (length.value !== undefined && INTRINSICS.own(length.value, 'value')) {
				INTRINSICS.define(copy, 'length', { value: length.value.value })
			}
		}
		INTRINSICS.freeze(copy)
	}

	static {
		// Pinned while this class is defined, as every cloner in this package pins its own.
		pinMembers(ValueCloner.prototype, 'ValueCloner')
	}
}
