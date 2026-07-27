import type { ContractShape, JSONSchema } from './types.js'

/**
 * Deep-clone a JSON Schema graph into an owned frozen snapshot.
 *
 * @remarks
 * Walks arrays and records iteratively with a memo, preserving shared
 * references and closing cyclic edges onto their cloned nodes. Primitive
 * values are copied directly, every own key is retained, and each produced
 * object is frozen after its edges are wired.
 *
 * @param schema - The JSON Schema graph to snapshot
 * @returns A deeply cloned and frozen JSON Schema graph
 *
 * @example
 * ```ts
 * const child = { type: 'string' }
 * const clone = cloneSchema({ anyOf: [child, child] })
 * clone.anyOf?.[0] === clone.anyOf?.[1] // true
 * ```
 */
export function cloneSchema(schema: JSONSchema): JSONSchema {
	const root: JSONSchema = Object.create(Object.getPrototypeOf(schema))
	const memo = new Map<object, object>([[schema, root]])
	const pending: { readonly source: object; readonly clone: object }[] = [
		{ source: schema, clone: root },
	]

	while (pending.length > 0) {
		const frame = pending.pop()
		if (frame === undefined) continue

		for (const key of Reflect.ownKeys(frame.source)) {
			const descriptor = Reflect.getOwnPropertyDescriptor(frame.source, key)
			if (descriptor === undefined) continue
			const source = Reflect.get(frame.source, key)
			let clone: unknown = source
			if (typeof source === 'object' && source !== null) {
				const existing = memo.get(source)
				if (existing !== undefined) {
					clone = existing
				} else {
					const child: object = Array.isArray(source)
						? []
						: Object.create(Object.getPrototypeOf(source))
					memo.set(source, child)
					pending.push({ source, clone: child })
					clone = child
				}
			}

			if (Array.isArray(frame.clone) && key === 'length') {
				Reflect.set(frame.clone, key, clone)
				continue
			}
			Object.defineProperty(frame.clone, key, {
				value: clone,
				enumerable: descriptor.enumerable === true,
				configurable: descriptor.configurable === true,
				writable: true,
			})
		}

		Object.freeze(frame.clone)
	}

	return root
}

/**
 * Deep-clone a contract shape graph into an owned frozen snapshot.
 *
 * @remarks
 * Uses an explicit memo to preserve shared-child identity and close cyclic
 * edges onto their cloned nodes. Shape-node shells are created iteratively,
 * then their structural edges are wired and their copied collections frozen.
 * A raw schema delegates to {@link cloneSchema}.
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
				clone = { type: 'raw', schema: cloneSchema(source.schema) }
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
