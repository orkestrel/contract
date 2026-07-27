import type { ContractShape, JSONSchema } from './types.js'

/**
 * Deep-clone a contract shape graph into an owned frozen snapshot.
 *
 * @remarks
 * Uses an explicit memo to preserve shared-child identity and close cyclic
 * edges onto their cloned nodes. Shape-node shells are created iteratively,
 * then their structural edges are wired and their copied collections frozen.
 * A raw schema is cloned with the platform structured-clone algorithm and
 * frozen throughout its reachable object graph.
 *
 * @param shape - The contract shape graph to snapshot
 * @returns A deeply cloned and frozen shape graph
 *
 * @example
 * ```ts
 * const child = arrayShape(stringShape())
 * const clone = cloneShape(objectShape({ first: child, second: child }))
 * clone.type === 'object' && clone.properties.first === clone.properties.second // true
 * ```
 */
export function cloneShape(shape: ContractShape): ContractShape {
	const memo = new Map<ContractShape, ContractShape>()
	const pending: ContractShape[] = [shape]
	const sources: ContractShape[] = []
	let root = shape

	while (pending.length > 0) {
		const source = pending.pop()
		if (source === undefined || memo.has(source)) continue

		let clone: ContractShape
		switch (source.type) {
			case 'string':
				clone = {
					type: 'string',
					...(source.min === undefined ? {} : { min: source.min }),
					...(source.max === undefined ? {} : { max: source.max }),
					...(source.pattern === undefined
						? {}
						: {
								pattern: Object.freeze(
									new RegExp(source.pattern.source, source.pattern.flags),
								),
							}),
					...(source.description === undefined ? {} : { description: source.description }),
				}
				break
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
				const schema: JSONSchema = structuredClone(source.schema)
				const schemas: object[] = [schema]
				const visited = new Set<object>()
				while (schemas.length > 0) {
					const entry = schemas.pop()
					if (entry === undefined || visited.has(entry)) continue
					visited.add(entry)
					for (const key of Reflect.ownKeys(entry)) {
						const child = Reflect.get(entry, key)
						if (typeof child === 'object' && child !== null) schemas.push(child)
					}
					Object.freeze(entry)
				}
				clone = { type: 'raw', schema }
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
}
