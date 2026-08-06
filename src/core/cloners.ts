import type { ContractShape, JSONRecord, JSONSchema, JSONValue, StringShape } from './types.js'
import { ContractError, isContractError } from './errors.js'
import { attempt, enumerableKeys, holds } from './helpers.js'
import { isRecord } from './validators.js'

/**
 * Deep-clone exact JSON data into an owned frozen snapshot.
 *
 * @remarks
 * Traverses iteratively so deeply nested input cannot exhaust the call stack.
 * Repeated noncyclic aliases are duplicated because JSON persistence represents
 * a tree, while a structural back-edge on the active path is rejected as a
 * cycle. Arrays are rebuilt as standard dense arrays and records as
 * null-prototype objects; every produced node is frozen after its children are
 * wired. Array keys must be exactly `length` plus every canonical index.
 * Writable and configurable index flags are normalized rather than treated as
 * JSON data, so frozen arrays remain valid. Property descriptors are inspected
 * without reading values through accessors, and every hostile reflective
 * operation is contained before a new clone-coded error is exposed.
 *
 * @param value - The unknown value to validate and snapshot
 * @returns The primitive unchanged, or a deeply cloned and frozen JSON graph
 * @throws {ContractError} When the value is not exact acyclic JSON data or traversal fails
 *
 * @example
 * ```ts
 * const source = { settings: { enabled: true } }
 * const clone = cloneJSONValue(source)
 * source.settings.enabled = false
 * clone // { settings: { enabled: true } }
 * ```
 */
export function cloneJSONValue(value: unknown): JSONValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
	if (typeof value === 'number') {
		if (Number.isFinite(value)) return value
		throw new ContractError('cloneJSONValue: number is not finite', {
			code: 'clone',
			context: { shape: 'json' },
		})
	}
	if (typeof value !== 'object') {
		throw new ContractError('cloneJSONValue: value is not JSON data', {
			code: 'clone',
			context: { shape: 'json' },
		})
	}

	const arrayOutcome = attempt(() => Array.isArray(value))
	if (!arrayOutcome.success) {
		throw new ContractError('cloneJSONValue: value brand could not be inspected', {
			code: 'clone',
			context: { shape: 'json' },
		})
	}

	let root: JSONValue[] | JSONRecord
	if (arrayOutcome.value) {
		root = []
	} else if (isRecord(value)) {
		root = Object.create(null)
	} else {
		throw new ContractError('cloneJSONValue: object is not a plain record', {
			code: 'clone',
			context: { shape: 'json' },
		})
	}

	const active = new WeakSet<object>()
	active.add(value)
	const pending: {
		readonly source: object
		readonly clone: JSONValue[] | JSONRecord
		readonly array: boolean
		entries: readonly (readonly [key: string, value: unknown])[] | undefined
		index: number
	}[] = [
		{
			source: value,
			clone: root,
			array: arrayOutcome.value,
			entries: undefined,
			index: 0,
		},
	]

	while (pending.length > 0) {
		const frame = pending[pending.length - 1]
		if (frame === undefined) continue

		if (frame.entries === undefined) {
			const keysOutcome = attempt(() => Reflect.ownKeys(frame.source))
			if (!keysOutcome.success) {
				throw new ContractError('cloneJSONValue: own keys could not be inspected', {
					code: 'clone',
					context: { shape: 'json' },
				})
			}
			const keys = keysOutcome.value
			const entries: [key: string, value: unknown][] = []

			if (frame.array) {
				const lengthOutcome = attempt(() =>
					Reflect.getOwnPropertyDescriptor(frame.source, 'length'),
				)
				if (!lengthOutcome.success) {
					throw new ContractError('cloneJSONValue: array length could not be inspected', {
						code: 'clone',
						context: { shape: 'json' },
					})
				}
				const lengthDescriptor = lengthOutcome.value
				if (
					lengthDescriptor === undefined ||
					!('value' in lengthDescriptor) ||
					typeof lengthDescriptor.value !== 'number' ||
					!Number.isInteger(lengthDescriptor.value) ||
					lengthDescriptor.value < 0 ||
					lengthDescriptor.value > 4_294_967_295 ||
					lengthDescriptor.enumerable !== false ||
					lengthDescriptor.configurable !== false
				) {
					throw new ContractError('cloneJSONValue: array is not intrinsic and dense', {
						code: 'clone',
						context: { shape: 'json' },
					})
				}

				const remaining = new Set(keys)
				if (!remaining.delete('length')) {
					throw new ContractError('cloneJSONValue: array own keys are not exact', {
						code: 'clone',
						context: { shape: 'json' },
					})
				}
				for (let index = 0; index < lengthDescriptor.value; index += 1) {
					const key = String(index)
					if (!remaining.delete(key)) {
						throw new ContractError('cloneJSONValue: array own keys are not exact', {
							code: 'clone',
							context: { shape: 'json' },
						})
					}
					const descriptorOutcome = attempt(() =>
						Reflect.getOwnPropertyDescriptor(frame.source, key),
					)
					if (!descriptorOutcome.success) {
						throw new ContractError('cloneJSONValue: array index could not be inspected', {
							code: 'clone',
							context: { shape: 'json' },
						})
					}
					const descriptor = descriptorOutcome.value
					if (
						descriptor === undefined ||
						!('value' in descriptor) ||
						descriptor.enumerable !== true
					) {
						throw new ContractError('cloneJSONValue: array index is not enumerable data', {
							code: 'clone',
							context: { shape: 'json' },
						})
					}
					entries.push([key, descriptor.value])
				}
				if (remaining.size !== 0) {
					throw new ContractError('cloneJSONValue: array own keys are not exact', {
						code: 'clone',
						context: { shape: 'json' },
					})
				}
			} else {
				for (const key of keys) {
					if (typeof key !== 'string') {
						throw new ContractError('cloneJSONValue: record has a symbol property', {
							code: 'clone',
							context: { shape: 'json' },
						})
					}
					const descriptorOutcome = attempt(() =>
						Reflect.getOwnPropertyDescriptor(frame.source, key),
					)
					if (!descriptorOutcome.success) {
						throw new ContractError('cloneJSONValue: record property could not be inspected', {
							code: 'clone',
							context: { shape: 'json' },
						})
					}
					const descriptor = descriptorOutcome.value
					if (
						descriptor === undefined ||
						!('value' in descriptor) ||
						descriptor.enumerable !== true
					) {
						throw new ContractError('cloneJSONValue: record property is not enumerable data', {
							code: 'clone',
							context: { shape: 'json' },
						})
					}
					entries.push([key, descriptor.value])
				}
			}

			frame.entries = entries
		}

		const entry = frame.entries[frame.index]
		if (entry === undefined) {
			Object.freeze(frame.clone)
			active.delete(frame.source)
			pending.pop()
			continue
		}
		frame.index += 1

		const key = entry[0]
		const source = entry[1]
		let clone: JSONValue
		if (source === null || typeof source === 'string' || typeof source === 'boolean') {
			clone = source
		} else if (typeof source === 'number') {
			if (!Number.isFinite(source)) {
				throw new ContractError('cloneJSONValue: number is not finite', {
					code: 'clone',
					context: { shape: 'json' },
				})
			}
			clone = source
		} else if (typeof source === 'object') {
			if (active.has(source)) {
				throw new ContractError('cloneJSONValue: cycle detected', {
					code: 'clone',
					context: { shape: 'json' },
				})
			}
			const childArrayOutcome = attempt(() => Array.isArray(source))
			if (!childArrayOutcome.success) {
				throw new ContractError('cloneJSONValue: value brand could not be inspected', {
					code: 'clone',
					context: { shape: 'json' },
				})
			}
			let child: JSONValue[] | JSONRecord
			if (childArrayOutcome.value) {
				child = []
			} else if (isRecord(source)) {
				child = Object.create(null)
			} else {
				throw new ContractError('cloneJSONValue: object is not a plain record', {
					code: 'clone',
					context: { shape: 'json' },
				})
			}
			clone = child
			active.add(source)
			pending.push({
				source,
				clone: child,
				array: childArrayOutcome.value,
				entries: undefined,
				index: 0,
			})
		} else {
			throw new ContractError('cloneJSONValue: property is not JSON data', {
				code: 'clone',
				context: { shape: 'json' },
			})
		}

		Object.defineProperty(frame.clone, key, {
			value: clone,
			enumerable: true,
			configurable: true,
			writable: true,
		})
	}

	return root
}

/**
 * Deep-clone an exact JSON object record into an owned frozen snapshot.
 *
 * @remarks
 * Adds a record-root boundary to {@link cloneJSONValue}. The output is a
 * deeply frozen null-prototype record, and repeated noncyclic aliases are
 * duplicated as independent JSON tree branches.
 *
 * @param value - The unknown record value to validate and snapshot
 * @returns A deeply cloned and frozen JSON record
 * @throws {ContractError} When the root is not a record, nested data is inexact, or traversal fails
 *
 * @example
 * ```ts
 * cloneJSONRecord({ attempt: 1 }) // frozen null-prototype record
 * ```
 */
export function cloneJSONRecord(value: unknown): JSONRecord {
	if (!isRecord(value)) {
		throw new ContractError('cloneJSONRecord: value is not a plain record', {
			code: 'clone',
			context: { shape: 'json' },
		})
	}
	const clone = cloneJSONValue(value)
	if (!isRecord(clone)) {
		throw new ContractError('cloneJSONRecord: cloned value is not a record', {
			code: 'clone',
			context: { shape: 'json' },
		})
	}
	return clone
}

/**
 * Deep-clone a JSON Schema graph into an owned frozen snapshot.
 *
 * @remarks
 * Walks arrays and records iteratively with a memo, preserving shared
 * references and closing cyclic edges onto their cloned nodes. Primitive
 * values and own enumerable string-keyed edges are copied; record nodes use
 * null prototypes, arrays retain only their intrinsic array prototype, and
 * every produced object is frozen after its edges are wired. Hostile traversal
 * throws a clone-coded {@link ContractError}, never a caller-owned raw error.
 *
 * @param schema - The JSON Schema graph to snapshot
 * @returns A deeply cloned and frozen JSON Schema graph
 * @throws {ContractError} When hostile schema traversal prevents ownership
 *
 * @example
 * ```ts
 * const child = { type: 'string' }
 * const clone = cloneSchema({ anyOf: [child, child] })
 * clone.anyOf?.[0] === clone.anyOf?.[1] // true
 * ```
 */
export function cloneSchema(schema: JSONSchema): JSONSchema {
	try {
		const root: JSONSchema = Object.create(null)
		const memo = new Map<object, object>([[schema, root]])
		const pending: {
			readonly source: object
			readonly clone: object
			readonly path: readonly string[]
		}[] = [{ source: schema, clone: root, path: [] }]

		while (pending.length > 0) {
			const frame = pending.pop()
			if (frame === undefined) continue
			const keys = enumerableKeys(frame.source)
			if (keys === undefined) {
				throw new ContractError('cloneSchema: property enumeration failed', {
					code: 'clone',
					context: { path: frame.path, shape: 'schema' },
				})
			}

			for (const key of keys) {
				const outcome = attempt(() => Reflect.get(frame.source, key))
				if (!outcome.success) {
					throw new ContractError('cloneSchema: property access failed', {
						code: 'clone',
						context: {
							path: [...frame.path, key],
							shape: 'schema',
						},
						cause: outcome.error,
					})
				}
				const source = outcome.value
				let clone: unknown = source
				if (typeof source === 'object' && source !== null) {
					const existing = memo.get(source)
					if (existing !== undefined) {
						clone = existing
					} else {
						const child: object = Array.isArray(source) ? [] : Object.create(null)
						memo.set(source, child)
						pending.push({
							source,
							clone: child,
							path: [...frame.path, key],
						})
						clone = child
					}
				}

				Object.defineProperty(frame.clone, key, {
					value: clone,
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}

			Object.freeze(frame.clone)
		}

		return root
	} catch (reason) {
		if (reason instanceof ContractError) throw reason
		throw new ContractError('cloneSchema: failed to create an owned schema snapshot', {
			code: 'clone',
			context: { shape: 'schema' },
			cause: reason,
		})
	}
}

/**
 * Deep-clone a contract shape graph into an owned frozen snapshot.
 *
 * @remarks
 * Uses an explicit memo to preserve shared-child identity and close cyclic
 * edges onto their cloned nodes. Shape-node shells are created iteratively,
 * then their structural edges are wired and their copied collections frozen.
 * String patterns are captured by source and flags behind an enumerable
 * accessor that returns a fresh frozen zero-state `RegExp` on every read.
 * A raw schema delegates to {@link cloneSchema}; every shape-graph read is
 * contained, so hostile traversal throws only a clone-coded
 * {@link ContractError}.
 *
 * @param shape - The contract shape graph to snapshot
 * @returns A deeply cloned and frozen shape graph
 * @throws {ContractError} When hostile shape or raw-schema traversal prevents ownership
 *
 * @example
 * ```ts
 * const child = arrayShape(stringShape())
 * const clone = cloneShape(objectShape({ first: child, second: child }))
 * clone.type === 'object' && clone.properties.first === clone.properties.second // true
 * ```
 */
export function cloneShape(shape: StringShape): StringShape
export function cloneShape(shape: ContractShape): ContractShape
export function cloneShape(shape: ContractShape): ContractShape {
	try {
		const memo = new Map<ContractShape, ContractShape>()
		const pending: ContractShape[] = [shape]
		const sources: ContractShape[] = []
		let root = shape

		while (pending.length > 0) {
			const source = pending.pop()
			if (source === undefined || memo.has(source)) continue

			let clone: ContractShape
			switch (source.type) {
				case 'string': {
					const pattern = source.pattern
					const fields: StringShape = {
						type: 'string',
						...(source.min === undefined ? {} : { min: source.min }),
						...(source.max === undefined ? {} : { max: source.max }),
						...(source.description === undefined ? {} : { description: source.description }),
					}
					if (pattern === undefined) {
						clone = fields
					} else {
						const patternSource = pattern.source
						const patternFlags = pattern.flags
						clone = {
							...fields,
							get pattern() {
								return Object.freeze(new RegExp(patternSource, patternFlags))
							},
						}
					}
					break
				}
				case 'number':
					clone = {
						type: 'number',
						...(source.min === undefined ? {} : { min: source.min }),
						...(source.max === undefined ? {} : { max: source.max }),
						...(source.integer === undefined ? {} : { integer: source.integer }),
						...(source.description === undefined ? {} : { description: source.description }),
					}
					break
				case 'boolean':
					clone = {
						type: 'boolean',
						...(source.description === undefined ? {} : { description: source.description }),
					}
					break
				case 'null':
					clone = {
						type: 'null',
						...(source.description === undefined ? {} : { description: source.description }),
					}
					break
				case 'literal':
					clone = {
						type: 'literal',
						values: Object.freeze([...source.values]),
						...(source.description === undefined ? {} : { description: source.description }),
					}
					break
				case 'array':
					clone = {
						type: 'array',
						items: source.items,
						...(source.min === undefined ? {} : { min: source.min }),
						...(source.max === undefined ? {} : { max: source.max }),
						...(source.description === undefined ? {} : { description: source.description }),
					}
					pending.push(source.items)
					break
				case 'object': {
					const extra = source.additionalProperties
					clone = {
						type: 'object',
						properties: Object.create(null),
						...(extra === undefined || (extra !== true && extra !== false)
							? {}
							: { additionalProperties: extra }),
						...(source.description === undefined ? {} : { description: source.description }),
					}
					for (const key of Object.keys(source.properties)) {
						const child = source.properties[key]
						if (child !== undefined) pending.push(child)
					}
					if (extra !== undefined && extra !== true && extra !== false) pending.push(extra)
					break
				}
				case 'union':
					clone = {
						type: 'union',
						variants: [],
						...(source.mode === undefined ? {} : { mode: source.mode }),
						...(source.description === undefined ? {} : { description: source.description }),
					}
					for (const variant of source.variants) pending.push(variant)
					break
				case 'optional':
					clone = { type: 'optional', inner: source.inner }
					pending.push(source.inner)
					break
				case 'nullable':
					clone = { type: 'nullable', inner: source.inner }
					pending.push(source.inner)
					break
				case 'json':
					clone = {
						type: 'json',
						...(source.description === undefined ? {} : { description: source.description }),
					}
					break
				case 'raw': {
					const outcome = attempt(() => source.schema)
					if (!outcome.success) {
						throw new ContractError('cloneShape: raw schema access failed', {
							code: 'clone',
							context: { shape: 'raw' },
							cause: outcome.error,
						})
					}
					clone = { type: 'raw', schema: cloneSchema(outcome.value) }
					break
				}
			}

			memo.set(source, clone)
			if (source === shape) root = clone
			sources.push(source)
		}

		for (const source of sources) {
			const clone = memo.get(source)
			if (clone === undefined) continue

			switch (source.type) {
				case 'array': {
					const items = memo.get(source.items)
					if (items !== undefined) Reflect.set(clone, 'items', items)
					break
				}
				case 'object': {
					const properties: Record<string, ContractShape> = Object.create(null)
					for (const key of Object.keys(source.properties)) {
						const child = source.properties[key]
						if (child === undefined) continue
						const clonedChild = memo.get(child)
						if (clonedChild !== undefined) properties[key] = clonedChild
					}
					Reflect.set(clone, 'properties', Object.freeze(properties))
					const extra = source.additionalProperties
					if (extra !== undefined && extra !== true && extra !== false) {
						const clonedExtra = memo.get(extra)
						if (clonedExtra !== undefined) {
							Reflect.set(clone, 'additionalProperties', clonedExtra)
						}
					}
					break
				}
				case 'union': {
					const variants: ContractShape[] = []
					for (const variant of source.variants) {
						const clonedVariant = memo.get(variant)
						if (clonedVariant !== undefined) variants.push(clonedVariant)
					}
					Reflect.set(clone, 'variants', Object.freeze(variants))
					break
				}
				case 'optional':
				case 'nullable': {
					const inner = memo.get(source.inner)
					if (inner !== undefined) Reflect.set(clone, 'inner', inner)
					break
				}
				default:
					break
			}

			Object.freeze(clone)
		}

		return root
	} catch (reason) {
		if (isContractError(reason) && reason.code === 'clone') throw reason
		throw new ContractError('cloneShape: failed to create an owned shape snapshot', {
			code: 'clone',
			context: { shape: 'shape' },
			cause: reason,
		})
	}
}

/**
 * Take ownership of a contract shape node — the node itself when it is already
 * frozen, otherwise a {@link cloneShape} snapshot of its graph.
 *
 * @remarks
 * Builder- and `cloneShape`-produced frozen means owned: those nodes have frozen
 * `properties` / `variants` / `values` collections and pattern accessors that
 * return fresh frozen snapshots, so they cannot drift under a caller who still
 * holds an input reference or a previously read pattern. `Object.freeze` on a
 * hand-authored pattern shape is not an ownership marker because it cannot
 * protect `RegExp` internal slots; leave that shape unfrozen for this function
 * to snapshot, or pass it through {@link cloneShape} first.
 *
 * Frozen-state inspection is itself contained through {@link holds}: when a
 * hostile root prevents that check, this function falls through to
 * {@link cloneShape}, which exposes the failure as a clone-coded
 * {@link ContractError}.
 *
 * Every compiler entry point (`compileSchema` / `compileGuard` /
 * `compileParser` / `compileGenerator` / `compileReporter` / `compileAuditor`)
 * opens with this call, and the check applies per node as the recursion
 * descends: a frozen
 * parent is trusted for its own fields while each child is owned again at its
 * own level, so a hand-assembled graph that froze only part of itself is still
 * compiled from owned data.
 *
 * @param shape - The contract shape to own
 * @returns The shape itself when frozen, otherwise a deeply cloned frozen snapshot
 *
 * @example
 * ```ts
 * const authored = stringShape() // builders freeze
 * ownShape(authored) === authored // true
 * ownShape({ type: 'string' }) // a frozen snapshot — the literal is caller-owned
 * ```
 */
export function ownShape(shape: ContractShape): ContractShape {
	return holds(() => Object.isFrozen(shape)) ? shape : cloneShape(shape)
}
