import type {
	AuditFault,
	ContractInterface,
	ContractShape,
	Fault,
	FaultKind,
	Guard,
	Infer,
	JSONSchema,
	Parser,
	RandomFunction,
} from './types.js'
import {
	isArray,
	isBoolean,
	isFiniteNumber,
	isInteger,
	isJSONValue,
	isNull,
	isRecord,
	isRegExp,
	isString,
	isUndefined,
} from './validators.js'
import {
	attempt,
	drawRandom,
	enumerableKeys,
	preview,
	seededRandom,
	shapeToKind,
} from './helpers.js'
import { COMPILE_DEPTH_LIMIT, FAULT_LIMIT, GENERATION_ATTEMPT_LIMIT } from './constants.js'
import { ContractError, isContractError } from './errors.js'
import { cloneSchema, cloneShape, ownShape } from './cloners.js'
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
import { parseBoolean, parseInteger, parseNumber, parseRecord, parseString } from './parsers.js'

// The compilers walk a finite, developer-authored shape tree (never cyclic) and
// recurse on themselves — branches are kept inline and public per AGENTS §5,
// never hidden behind private helpers. `compileGuard` / `compileParser` /
// `compileReporter` / `compileAuditor` reuse the existing combinators and parsers rather than
// re-implementing them — including `literalOf` for literal membership, so
// SameValueZero matching has one implementation package-wide. Every entry point
// opens with `ownShape` (cloners.ts), the one place the frozen-means-owned
// invariant lives.

// === Validation

/**
 * Gate recursive compiler work on shape structure, depth, and cycles.
 *
 * @remarks
 * Walks the shape graph iteratively with explicit stack space. A tree is
 * linear in its nodes; a shared-child DAG is re-walked once per incoming path
 * because active ancestors, not a root-wide visited set, define cycle safety.
 * Every
 * structural child slot must contain a shape node before it can enter the walk;
 * every scalar field must hold its declared runtime domain before a compiler
 * can use it; and a missing child, corrupt container, inherited discriminant,
 * or unrecognized node reports `structure`. This is a structural-safety
 * prerequisite and shared well-formedness pass used by
 * {@link validateShape}: it enforces every bound domain and range used by the
 * artifacts, including non-empty literal/union vocabularies, finite literal
 * numbers, integer-range satisfiability, optional-shape placement, and the
 * recursively supported raw-schema vocabulary. Active ancestors are tracked
 * so shared children remain legal. Every standalone
 * compiler calls this gate before its recursive branch begins. Failures have
 * deterministic precedence independent of traversal order: depth, then
 * structure, then cycle, then field and vocabulary policy.
 *
 * @param shape - The shape graph to gate
 * @returns Nothing; successful return means recursive compilation is structurally safe and depth-safe
 * @throws {ContractError} When a node or structural slot is corrupt, a bound or vocabulary is outside its declared domain, the graph is cyclic, or it exceeds the compilation depth limit
 */
export function validateShapeDepth(shape: ContractShape): void {
	const active = new WeakSet<ContractShape>()
	const path: string[] = []
	let structurePath: readonly string[] | undefined
	let structureMessage: string | undefined
	let cyclePath: readonly string[] | undefined
	let domainCode: 'bound' | 'range' | 'empty' | 'literal' | 'placement' | undefined
	let domainMessage: string | undefined
	let domainPath: readonly string[] | undefined
	let domainShape: string | undefined
	let domainLimit: string | undefined
	let domainReceived: string | undefined
	const stack: (
		| {
				readonly operation: 'enter'
				readonly shape: ContractShape | undefined
				readonly depth: number
				readonly optional: boolean
				readonly first?: string
				readonly second?: string
		  }
		| { readonly operation: 'exit'; readonly shape: ContractShape; readonly segments: number }
	)[] = [{ operation: 'enter', shape, depth: 0, optional: false }]

	while (stack.length > 0) {
		const frame = stack.pop()
		if (frame === undefined) continue
		if (frame.operation === 'exit') {
			active.delete(frame.shape)
			path.length -= frame.segments
			continue
		}
		let segments = 0
		if (frame.first !== undefined) {
			path.push(frame.first)
			segments += 1
		}
		if (frame.second !== undefined) {
			path.push(frame.second)
			segments += 1
		}

		const current = frame.shape
		if (frame.depth > COMPILE_DEPTH_LIMIT) {
			throw new ContractError('validateShapeDepth: a shape exceeds the compilation depth limit', {
				code: 'depth',
				context: { path: [...path], limit: COMPILE_DEPTH_LIMIT },
			})
		}
		if (typeof current !== 'object' || current === null || !isRecord(current)) {
			if (structurePath === undefined) {
				structurePath = [...path]
				structureMessage = 'validateShapeDepth: every structural child must be a shape'
			}
			path.length -= segments
			continue
		}
		if (active.has(current)) {
			if (cyclePath === undefined) cyclePath = [...path]
			path.length -= segments
			continue
		}

		const children: {
			readonly shape: ContractShape | undefined
			readonly optional: boolean
			readonly first: string
			readonly second?: string
		}[] = []
		let nodeMessage = 'validateShapeDepth: every node must be a recognized shape'
		let nodeFirst: string | undefined
		let nodeSecond: string | undefined
		const outcome = attempt((): boolean => {
			const descriptor = Object.getOwnPropertyDescriptor(current, 'type')
			if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return false
			const category = current.type
			if (current.type !== category || descriptor.value !== category) return false

			let fields: readonly string[]
			switch (category) {
				case 'string':
					fields = ['min', 'max', 'pattern', 'description']
					break
				case 'number':
					fields = ['integer', 'min', 'max', 'description']
					break
				case 'boolean':
				case 'null':
				case 'json':
					fields = ['description']
					break
				case 'literal':
					fields = ['values', 'description']
					break
				case 'array':
					fields = ['items', 'min', 'max', 'description']
					break
				case 'object':
					fields = ['properties', 'additionalProperties', 'description']
					break
				case 'union':
					fields = ['variants', 'mode', 'description']
					break
				case 'optional':
				case 'nullable':
					fields = ['inner']
					break
				case 'raw':
					fields = ['schema']
					break
				default:
					return false
			}

			for (const field of fields) {
				nodeFirst = field
				const fieldDescriptor = Object.getOwnPropertyDescriptor(current, field)
				const first: unknown = Reflect.get(current, field)
				const second: unknown = Reflect.get(current, field)
				if (fieldDescriptor === undefined) {
					if (first !== undefined || second !== undefined) return false
					continue
				}
				if (Object.hasOwn(fieldDescriptor, 'value')) {
					const described: unknown = fieldDescriptor.value
					if (!Object.is(first, described) || !Object.is(second, first)) return false
					continue
				}
				if (
					field !== 'pattern' ||
					!isRegExp(first) ||
					!isRegExp(second) ||
					first.source !== second.source ||
					first.flags !== second.flags ||
					!Object.isFrozen(first) ||
					!Object.isFrozen(second)
				) {
					return false
				}
			}
			nodeFirst = undefined

			if (
				category !== 'optional' &&
				category !== 'nullable' &&
				category !== 'raw' &&
				current.description !== undefined &&
				typeof current.description !== 'string'
			) {
				nodeFirst = 'description'
				nodeMessage = 'validateShapeDepth: description must be a string'
				return false
			}
			if (category === 'string') {
				if (current.min !== undefined && typeof current.min !== 'number') {
					nodeFirst = 'min'
					nodeMessage = 'validateShapeDepth: string min must be a number'
					return false
				}
				if (current.max !== undefined && typeof current.max !== 'number') {
					nodeFirst = 'max'
					nodeMessage = 'validateShapeDepth: string max must be a number'
					return false
				}
				if (current.pattern !== undefined) {
					const pattern = current.pattern
					if (!isRegExp(pattern)) {
						nodeFirst = 'pattern'
						nodeMessage = 'validateShapeDepth: string pattern must be a RegExp'
						return false
					}
					const source = pattern.source
					const flags = pattern.flags
					if (
						typeof source !== 'string' ||
						typeof flags !== 'string' ||
						pattern.source !== source ||
						pattern.flags !== flags
					) {
						nodeFirst = 'pattern'
						nodeMessage = 'validateShapeDepth: string pattern must be stable'
						return false
					}
				}
				if (
					domainCode === undefined &&
					current.min !== undefined &&
					(!Number.isSafeInteger(current.min) || current.min < 0)
				) {
					domainCode = 'bound'
					domainMessage =
						'validateShapeDepth: a string shape min must be a non-negative safe integer'
					domainPath = [...path]
					domainShape = 'string'
					domainLimit = 'non-negative safe integer'
					domainReceived = String(current.min)
				}
				if (
					domainCode === undefined &&
					current.max !== undefined &&
					(!Number.isSafeInteger(current.max) || current.max < 0)
				) {
					domainCode = 'bound'
					domainMessage =
						'validateShapeDepth: a string shape max must be a non-negative safe integer'
					domainPath = [...path]
					domainShape = 'string'
					domainLimit = 'non-negative safe integer'
					domainReceived = String(current.max)
				}
				if (
					domainCode === undefined &&
					current.min !== undefined &&
					current.max !== undefined &&
					current.min > current.max
				) {
					domainCode = 'range'
					domainMessage = 'validateShapeDepth: a string shape has min greater than max'
					domainPath = [...path]
					domainShape = 'string'
				}
			}
			if (category === 'number') {
				if (current.min !== undefined && typeof current.min !== 'number') {
					nodeFirst = 'min'
					nodeMessage = 'validateShapeDepth: number min must be a number'
					return false
				}
				if (current.max !== undefined && typeof current.max !== 'number') {
					nodeFirst = 'max'
					nodeMessage = 'validateShapeDepth: number max must be a number'
					return false
				}
				if (current.integer !== undefined && typeof current.integer !== 'boolean') {
					nodeFirst = 'integer'
					nodeMessage = 'validateShapeDepth: number integer must be a boolean'
					return false
				}
				if (
					domainCode === undefined &&
					current.min !== undefined &&
					!Number.isFinite(current.min)
				) {
					domainCode = 'bound'
					domainMessage = 'validateShapeDepth: a number shape min must be finite'
					domainPath = [...path]
					domainShape = current.integer === true ? 'integer' : 'number'
					domainLimit = 'finite number'
					domainReceived = String(current.min)
				}
				if (
					domainCode === undefined &&
					current.max !== undefined &&
					!Number.isFinite(current.max)
				) {
					domainCode = 'bound'
					domainMessage = 'validateShapeDepth: a number shape max must be finite'
					domainPath = [...path]
					domainShape = current.integer === true ? 'integer' : 'number'
					domainLimit = 'finite number'
					domainReceived = String(current.max)
				}
				if (
					domainCode === undefined &&
					current.min !== undefined &&
					current.max !== undefined &&
					current.min > current.max
				) {
					domainCode = 'range'
					domainMessage = 'validateShapeDepth: a number shape has min greater than max'
					domainPath = [...path]
					domainShape = current.integer === true ? 'integer' : 'number'
				}
				if (domainCode === undefined && current.integer === true) {
					const lo = Math.ceil(current.min ?? Number.NEGATIVE_INFINITY)
					const hi = Math.floor(current.max ?? Number.POSITIVE_INFINITY)
					if (lo > hi) {
						domainCode = 'range'
						domainMessage = 'validateShapeDepth: an integer number shape has an empty integer range'
						domainPath = [...path]
						domainShape = 'integer'
					}
				}
			}
			if (category === 'array' && current.min !== undefined && typeof current.min !== 'number') {
				nodeFirst = 'min'
				nodeMessage = 'validateShapeDepth: array min must be a number'
				return false
			}
			if (category === 'array' && current.max !== undefined && typeof current.max !== 'number') {
				nodeFirst = 'max'
				nodeMessage = 'validateShapeDepth: array max must be a number'
				return false
			}
			if (
				category === 'array' &&
				domainCode === undefined &&
				current.min !== undefined &&
				(!Number.isSafeInteger(current.min) || current.min < 0)
			) {
				domainCode = 'bound'
				domainMessage = 'validateShapeDepth: an array shape min must be a non-negative safe integer'
				domainPath = [...path]
				domainShape = 'array'
				domainLimit = 'non-negative safe integer'
				domainReceived = String(current.min)
			}
			if (
				category === 'array' &&
				domainCode === undefined &&
				current.max !== undefined &&
				(!Number.isSafeInteger(current.max) || current.max < 0)
			) {
				domainCode = 'bound'
				domainMessage = 'validateShapeDepth: an array shape max must be a non-negative safe integer'
				domainPath = [...path]
				domainShape = 'array'
				domainLimit = 'non-negative safe integer'
				domainReceived = String(current.max)
			}
			if (
				category === 'array' &&
				domainCode === undefined &&
				current.min !== undefined &&
				current.max !== undefined &&
				current.min > current.max
			) {
				domainCode = 'range'
				domainMessage = 'validateShapeDepth: an array shape has min greater than max'
				domainPath = [...path]
				domainShape = 'array'
			}
			if (
				category === 'union' &&
				current.mode !== undefined &&
				current.mode !== 'anyOf' &&
				current.mode !== 'oneOf'
			) {
				nodeFirst = 'mode'
				nodeMessage = 'validateShapeDepth: union mode must be anyOf or oneOf'
				return false
			}
			if (category === 'optional' && !frame.optional && domainCode === undefined) {
				domainCode = 'placement'
				domainMessage =
					'validateShapeDepth: an optional shape may only appear as a direct object-property value'
				domainPath = [...path]
				domainShape = 'optional'
			}
			if (category === 'raw') {
				nodeFirst = 'schema'
				if (!isRecord(current.schema)) {
					nodeMessage = 'validateShapeDepth: raw schema must be a plain record'
					return false
				}
				const schemaActive = new WeakSet<object>()
				const schemaStack: (
					| {
							readonly operation: 'enter'
							readonly schema: unknown
							readonly depth: number
					  }
					| { readonly operation: 'exit'; readonly schema: object }
				)[] = [{ operation: 'enter', schema: current.schema, depth: frame.depth }]

				while (schemaStack.length > 0) {
					const schemaFrame = schemaStack.pop()
					if (schemaFrame === undefined) continue
					if (schemaFrame.operation === 'exit') {
						schemaActive.delete(schemaFrame.schema)
						continue
					}
					if (schemaFrame.depth > COMPILE_DEPTH_LIMIT) {
						nodeMessage = 'validateShapeDepth: raw schema exceeds the compilation depth limit'
						return false
					}
					const schema = schemaFrame.schema
					if (!isRecord(schema)) {
						nodeMessage = 'validateShapeDepth: every raw schema child must be a plain record'
						return false
					}
					if (schemaActive.has(schema)) {
						nodeMessage = 'validateShapeDepth: a raw schema may not contain a cycle'
						return false
					}
					schemaActive.add(schema)
					schemaStack.push({ operation: 'exit', schema })

					for (const key of Object.keys(schema)) {
						if (
							key !== 'type' &&
							key !== 'description' &&
							key !== 'enum' &&
							key !== 'minLength' &&
							key !== 'maxLength' &&
							key !== 'pattern' &&
							key !== 'format' &&
							key !== 'minimum' &&
							key !== 'maximum' &&
							key !== 'minItems' &&
							key !== 'maxItems' &&
							key !== 'items' &&
							key !== 'properties' &&
							key !== 'required' &&
							key !== 'additionalProperties' &&
							key !== 'anyOf' &&
							key !== 'oneOf'
						) {
							nodeMessage = 'validateShapeDepth: raw schema contains an unsupported keyword'
							return false
						}
					}

					const schemaType = schema.type
					if (
						schemaType !== undefined &&
						schemaType !== 'null' &&
						schemaType !== 'boolean' &&
						schemaType !== 'object' &&
						schemaType !== 'array' &&
						schemaType !== 'number' &&
						schemaType !== 'integer' &&
						schemaType !== 'string'
					) {
						nodeMessage = 'validateShapeDepth: raw schema type is outside the supported vocabulary'
						return false
					}
					if (schema.description !== undefined && typeof schema.description !== 'string') {
						nodeMessage = 'validateShapeDepth: raw schema description must be a string'
						return false
					}
					if (schema.format !== undefined && typeof schema.format !== 'string') {
						nodeMessage = 'validateShapeDepth: raw schema format must be a string'
						return false
					}
					if (schema.pattern !== undefined) {
						if (typeof schema.pattern !== 'string') {
							nodeMessage = 'validateShapeDepth: raw schema pattern must be a string'
							return false
						}
						nodeMessage = 'validateShapeDepth: raw schema pattern must be valid'
						RegExp(schema.pattern)
					}

					for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems']) {
						const value = schema[key]
						if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 0)) {
							nodeMessage =
								'validateShapeDepth: raw schema length bounds must be non-negative safe integers'
							return false
						}
					}
					for (const key of ['minimum', 'maximum']) {
						const value = schema[key]
						if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
							nodeMessage = 'validateShapeDepth: raw schema numeric bounds must be finite numbers'
							return false
						}
					}
					if (schema.enum !== undefined) {
						if (!Array.isArray(schema.enum) || schema.enum.length === 0) {
							nodeMessage = 'validateShapeDepth: raw schema enum must be a non-empty array'
							return false
						}
						const values = new Set<string | number | boolean>()
						for (let index = 0; index < schema.enum.length; index += 1) {
							if (!Object.hasOwn(schema.enum, index)) {
								nodeMessage = 'validateShapeDepth: raw schema enum must be dense'
								return false
							}
							const value = schema.enum[index]
							if (
								(typeof value !== 'string' &&
									typeof value !== 'number' &&
									typeof value !== 'boolean') ||
								(typeof value === 'number' && !Number.isFinite(value)) ||
								values.has(value)
							) {
								nodeMessage =
									'validateShapeDepth: raw schema enum values must be finite unique primitives'
								return false
							}
							values.add(value)
						}
					}

					if (schema.required !== undefined) {
						if (!Array.isArray(schema.required)) {
							nodeMessage = 'validateShapeDepth: raw schema required must be an array'
							return false
						}
						const required = new Set<string>()
						for (let index = 0; index < schema.required.length; index += 1) {
							if (!Object.hasOwn(schema.required, index)) {
								nodeMessage = 'validateShapeDepth: raw schema required must be dense'
								return false
							}
							const value = schema.required[index]
							if (typeof value !== 'string' || required.has(value)) {
								nodeMessage =
									'validateShapeDepth: raw schema required values must be unique strings'
								return false
							}
							required.add(value)
						}
					}

					const nested: unknown[] = []
					if (schema.items !== undefined) nested.push(schema.items)
					if (schema.properties !== undefined) {
						if (!isRecord(schema.properties)) {
							nodeMessage = 'validateShapeDepth: raw schema properties must be a plain record'
							return false
						}
						for (const key of Object.keys(schema.properties)) {
							nested.push(schema.properties[key])
						}
					}
					if (
						schema.additionalProperties !== undefined &&
						schema.additionalProperties !== true &&
						schema.additionalProperties !== false
					) {
						nested.push(schema.additionalProperties)
					}
					for (const key of ['anyOf', 'oneOf']) {
						const variants = schema[key]
						if (variants === undefined) continue
						if (!Array.isArray(variants) || variants.length === 0) {
							nodeMessage = 'validateShapeDepth: raw schema unions must be non-empty arrays'
							return false
						}
						for (let index = 0; index < variants.length; index += 1) {
							if (!Object.hasOwn(variants, index)) {
								nodeMessage = 'validateShapeDepth: raw schema unions must be dense arrays'
								return false
							}
							nested.push(variants[index])
						}
					}
					for (let index = nested.length - 1; index >= 0; index -= 1) {
						const child = nested[index]
						if (child === undefined) continue
						schemaStack.push({
							operation: 'enter',
							schema: child,
							depth: schemaFrame.depth + 1,
						})
					}
				}
				nodeFirst = undefined
			}

			switch (category) {
				case 'array':
					children.push({ shape: current.items, first: 'items', optional: false })
					break
				case 'object': {
					nodeFirst = 'properties'
					const properties = current.properties
					if (!isRecord(properties)) {
						nodeMessage = 'validateShapeDepth: properties must be a plain property map'
						return false
					}
					const keys = Object.keys(properties)
					for (const key of keys) {
						nodeSecond = key
						const childDescriptor = Object.getOwnPropertyDescriptor(properties, key)
						if (childDescriptor === undefined || !Object.hasOwn(childDescriptor, 'value')) {
							children.push({
								shape: undefined,
								first: 'properties',
								second: key,
								optional: true,
							})
							continue
						}
						const child = current.properties[key]
						if (
							!Object.is(current.properties[key], child) ||
							!Object.is(childDescriptor.value, child)
						) {
							children.push({
								shape: undefined,
								first: 'properties',
								second: key,
								optional: true,
							})
							continue
						}
						children.push({
							shape: child,
							first: 'properties',
							second: key,
							optional: true,
						})
					}
					nodeSecond = undefined
					const extra = current.additionalProperties
					if (extra !== undefined && extra !== true && extra !== false) {
						children.push({
							shape: extra,
							first: 'additionalProperties',
							optional: false,
						})
					}
					break
				}
				case 'union': {
					nodeFirst = 'variants'
					if (!Array.isArray(current.variants)) {
						nodeMessage = 'validateShapeDepth: variants must be a finite array'
						return false
					}
					const length = current.variants.length
					if (!Number.isSafeInteger(length) || length < 0 || current.variants.length !== length) {
						nodeMessage = 'validateShapeDepth: variants must be a finite array'
						return false
					}
					if (domainCode === undefined && length === 0) {
						domainCode = 'empty'
						domainMessage = 'validateShapeDepth: a union shape needs at least one variant'
						domainPath = [...path]
						domainShape = 'union'
					}
					for (let index = 0; index < length; index += 1) {
						const key = String(index)
						nodeSecond = key
						const variantDescriptor = Object.getOwnPropertyDescriptor(current.variants, key)
						if (variantDescriptor === undefined || !Object.hasOwn(variantDescriptor, 'value')) {
							children.push({
								shape: undefined,
								first: 'variants',
								second: key,
								optional: false,
							})
							continue
						}
						const variant = current.variants[index]
						if (
							!Object.is(current.variants[index], variant) ||
							!Object.is(variantDescriptor.value, variant)
						) {
							children.push({
								shape: undefined,
								first: 'variants',
								second: key,
								optional: false,
							})
							continue
						}
						children.push({
							shape: variant,
							first: 'variants',
							second: key,
							optional: false,
						})
					}
					break
				}
				case 'literal': {
					nodeFirst = 'values'
					if (!Array.isArray(current.values)) {
						nodeMessage = 'validateShapeDepth: values must be a finite literal array'
						return false
					}
					const length = current.values.length
					if (!Number.isSafeInteger(length) || length < 0 || current.values.length !== length) {
						nodeMessage = 'validateShapeDepth: values must be a finite literal array'
						return false
					}
					if (domainCode === undefined && length === 0) {
						domainCode = 'empty'
						domainMessage = 'validateShapeDepth: a literal shape needs at least one value'
						domainPath = [...path]
						domainShape = 'literal'
					}
					const values = new Set<string | number | boolean>()
					for (let index = 0; index < length; index += 1) {
						const key = String(index)
						nodeSecond = key
						const valueDescriptor = Object.getOwnPropertyDescriptor(current.values, key)
						if (valueDescriptor === undefined || !Object.hasOwn(valueDescriptor, 'value')) {
							nodeMessage = 'validateShapeDepth: values must be a dense data array'
							return false
						}
						const value = current.values[index]
						if (
							!Object.is(current.values[index], value) ||
							!Object.is(valueDescriptor.value, value)
						) {
							nodeMessage = 'validateShapeDepth: values must be a stable data array'
							return false
						}
						if (values.has(value)) {
							nodeMessage = 'validateShapeDepth: literal values must be unique'
							return false
						}
						values.add(value)
						if (
							typeof value !== 'string' &&
							typeof value !== 'number' &&
							typeof value !== 'boolean'
						) {
							nodeMessage =
								'validateShapeDepth: every literal value must be a string, number, or boolean'
							return false
						}
						if (domainCode === undefined && typeof value === 'number' && !Number.isFinite(value)) {
							domainCode = 'literal'
							domainMessage =
								'validateShapeDepth: a literal shape may not contain non-finite number values'
							domainPath = [...path]
							domainShape = 'literal'
							domainReceived = String(value)
						}
					}
					break
				}
				case 'optional':
				case 'nullable':
					children.push({ shape: current.inner, first: 'inner', optional: false })
					break
				case 'string':
				case 'number':
				case 'boolean':
				case 'null':
				case 'json':
				case 'raw':
					break
			}
			return true
		})

		if (!outcome.success || !outcome.value) {
			if (structurePath === undefined) {
				structurePath = [
					...path,
					...(nodeFirst === undefined ? [] : [nodeFirst]),
					...(nodeSecond === undefined ? [] : [nodeSecond]),
				]
				structureMessage = nodeMessage
			}
			path.length -= segments
			continue
		}

		active.add(current)
		stack.push({ operation: 'exit', shape: current, segments })
		for (let index = children.length - 1; index >= 0; index -= 1) {
			const child = children[index]
			if (child === undefined) continue
			stack.push({
				operation: 'enter',
				shape: child.shape,
				depth: frame.depth + 1,
				optional: child.optional,
				first: child.first,
				...(child.second === undefined ? {} : { second: child.second }),
			})
		}
	}

	if (structurePath !== undefined) {
		throw new ContractError(
			structureMessage ?? 'validateShapeDepth: a shape structure is corrupt',
			{
				code: 'structure',
				context: { path: structurePath },
			},
		)
	}
	if (cyclePath !== undefined) {
		throw new ContractError('validateShapeDepth: a shape graph may not contain a cycle', {
			code: 'cycle',
			context: { path: cyclePath },
		})
	}
	if (domainCode !== undefined) {
		throw new ContractError(
			domainMessage ?? 'validateShapeDepth: a shape bound is outside its declared domain',
			{
				code: domainCode,
				context: {
					path: domainPath ?? [],
					...(domainShape === undefined ? {} : { shape: domainShape }),
					...(domainLimit === undefined ? {} : { limit: domainLimit }),
					...(domainReceived === undefined ? {} : { received: domainReceived }),
				},
			},
		)
	}
}

/**
 * Validate that a {@link ContractShape} graph is well-formed before
 * compilation.
 *
 * @remarks
 * Fail-fast, per AGENTS §12: a malformed shape is a programmer error, so this
 * throws a coded {@link ContractError} immediately rather than surfacing as a
 * silently-wrong guard, parser, schema, or generator later. It first runs the
 * complete shared {@link validateShapeDepth} gate, which rejects corrupt nodes,
 * structural slots, scalar/vocabulary violations, integer-empty ranges, and
 * misplaced optional nodes before this retained policy recheck begins. The iterative walk tracks
 * active ancestors, so a structural cycle reports its precise path while a
 * shared child reached through separate paths remains legal. Checks:
 *
 * - An {@link OptionalShape} is only legal as a direct object-property value —
 *   `optionalShape` wrapping an array item, a union variant, another
 *   optional/nullable's inner shape, `additionalProperties`, or the top-level
 *   shape all throw. An object property IS the one legal placement: its value
 *   is unwrapped to `.inner` before recursing, so `.inner` itself is validated
 *   as a normal (non-optional-wrapping) shape.
 * - The shared pass has already required non-empty union/literal vocabularies,
 *   finite literal numbers, valid bound domains, `min <= max`, satisfiable
 *   integer ranges, legal optional placement, and valid raw-schema vocabulary.
 * - An integer {@link NumberShape} (`integer: true`) needs a non-empty integer
 *   range: `Math.ceil(min ?? -Infinity) <= Math.floor(max ?? Infinity)`.
 * - Shape nesting may not exceed {@link COMPILE_DEPTH_LIMIT}; excessive depth
 *   fails before recursive artifact compilation begins. Because the depth check
 *   runs before the active-ancestor check, a back-edge first reached beyond the
 *   limit reports `depth`; a cycle reached within the limit reports `cycle`.
 * - `null` / `json` / `raw` / `boolean` are always-valid leaves. Recursion
 *   continues into array items, object properties (and `additionalProperties`
 *   when it is a shape), union variants, and optional/nullable inner shapes.
 *
 * @param shape - The shape to validate
 * @throws {ContractError} When the shape is malformed or cyclic
 *
 * @example
 * ```ts
 * validateShape(stringShape({ min: 1, max: 10 })) // does not throw
 * validateShape(stringShape({ min: 10, max: 1 })) // throws
 * ```
 */
export function validateShape(shape: ContractShape): void {
	validateShapeDepth(shape)
	const outcome = attempt(() => {
		const active = new WeakSet<ContractShape>()
		const stack: (
			| {
					readonly operation: 'enter'
					readonly shape: ContractShape
					readonly path: readonly string[]
					readonly optional: boolean
					readonly depth: number
			  }
			| { readonly operation: 'exit'; readonly shape: ContractShape }
		)[] = [{ operation: 'enter', shape, path: [], optional: false, depth: 0 }]

		while (stack.length > 0) {
			const frame = stack.pop()
			if (frame === undefined) continue
			if (frame.operation === 'exit') {
				active.delete(frame.shape)
				continue
			}

			const current = frame.shape
			if (frame.depth > COMPILE_DEPTH_LIMIT) {
				throw new ContractError('validateShape: a shape exceeds the compilation depth limit', {
					code: 'depth',
					context: { path: frame.path, shape: current.type, limit: COMPILE_DEPTH_LIMIT },
				})
			}
			if (active.has(current)) {
				throw new ContractError('validateShape: a shape graph may not contain a cycle', {
					code: 'cycle',
					context: { path: frame.path },
				})
			}
			active.add(current)
			stack.push({ operation: 'exit', shape: current })

			switch (current.type) {
				case 'string':
					break
				case 'number':
					if (current.integer === true) {
						const lo = Math.ceil(current.min ?? Number.NEGATIVE_INFINITY)
						const hi = Math.floor(current.max ?? Number.POSITIVE_INFINITY)
						if (lo > hi) {
							throw new ContractError(
								'validateShape: an integer number shape has an empty integer range',
								{
									code: 'range',
									context: { path: frame.path, shape: 'integer' },
								},
							)
						}
					}
					break
				case 'boolean':
				case 'null':
				case 'json':
				case 'raw':
					break
				case 'literal':
					break
				case 'array':
					stack.push({
						operation: 'enter',
						shape: current.items,
						path: [...frame.path, 'items'],
						optional: false,
						depth: frame.depth + 1,
					})
					break
				case 'object': {
					const extra = current.additionalProperties
					if (extra !== undefined && extra !== true && extra !== false) {
						stack.push({
							operation: 'enter',
							shape: extra,
							path: [...frame.path, 'additionalProperties'],
							optional: false,
							depth: frame.depth + 1,
						})
					}
					const keys = Object.keys(current.properties)
					for (let index = keys.length - 1; index >= 0; index -= 1) {
						const key = keys[index]
						if (key === undefined) continue
						const child = current.properties[key]
						if (child === undefined) continue
						stack.push({
							operation: 'enter',
							shape: child,
							path: [...frame.path, 'properties', key],
							optional: true,
							depth: frame.depth + 1,
						})
					}
					break
				}
				case 'union':
					for (let index = current.variants.length - 1; index >= 0; index -= 1) {
						const variant = current.variants[index]
						if (variant === undefined) continue
						stack.push({
							operation: 'enter',
							shape: variant,
							path: [...frame.path, 'variants', String(index)],
							optional: false,
							depth: frame.depth + 1,
						})
					}
					break
				case 'optional':
					if (!frame.optional) {
						throw new ContractError(
							'validateShape: an optional shape may only appear as a direct object-property value',
							{
								code: 'placement',
								context: { path: frame.path, shape: 'optional' },
							},
						)
					}
					stack.push({
						operation: 'enter',
						shape: current.inner,
						path: [...frame.path, 'inner'],
						optional: false,
						depth: frame.depth + 1,
					})
					break
				case 'nullable':
					stack.push({
						operation: 'enter',
						shape: current.inner,
						path: [...frame.path, 'inner'],
						optional: false,
						depth: frame.depth + 1,
					})
					break
			}
		}
	})
	if (outcome.success) return
	if (isContractError(outcome.error)) throw outcome.error
	throw new ContractError('validateShape: shape reflection failed', {
		code: 'structure',
		context: { path: [] },
		cause: outcome.error,
	})
}

// === Schema

/**
 * Compile a {@link ContractShape} into a JSON Schema document.
 *
 * @remarks
 * Object shapes emit `additionalProperties: false` (unless opened) and list only
 * required keys in `required`; nullable shapes emit an `anyOf` with `{ type:
 * 'null' }`. The result is an owned deeply frozen graph; raw schemas are cloned
 * rather than retained by reference. Emission only — it never inspects a
 * runtime value. {@link validateShapeDepth} iteratively rejects excessive
 * nesting or cycles before recursive emission begins.
 *
 * @param shape - The shape to compile
 * @returns The emitted JSON Schema
 *
 * @example
 * ```ts
 * compileSchema(stringShape({ min: 1 })) // { type: 'string', minLength: 1 }
 * ```
 */
export function compileSchema(shape: ContractShape): JSONSchema {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string':
			return Object.freeze({
				type: 'string',
				...(owned.min !== undefined ? { minLength: owned.min } : {}),
				...(owned.max !== undefined ? { maxLength: owned.max } : {}),
				...(owned.pattern !== undefined ? { pattern: owned.pattern.source } : {}),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'number':
			return Object.freeze({
				type: owned.integer === true ? 'integer' : 'number',
				...(owned.min !== undefined ? { minimum: owned.min } : {}),
				...(owned.max !== undefined ? { maximum: owned.max } : {}),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'boolean':
			return Object.freeze({
				type: 'boolean',
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'null':
			return Object.freeze({
				type: 'null',
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'json':
			return Object.freeze({
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'literal':
			return Object.freeze({
				enum: Object.freeze([...owned.values]),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'array':
			return Object.freeze({
				type: 'array',
				items: compileSchema(owned.items),
				...(owned.min !== undefined ? { minItems: owned.min } : {}),
				...(owned.max !== undefined ? { maxItems: owned.max } : {}),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'object': {
			const properties: Record<string, JSONSchema> = Object.create(null)
			const required: string[] = []
			for (const key of Object.keys(owned.properties)) {
				const child = owned.properties[key]
				if (child === undefined) continue
				properties[key] = compileSchema(child.type === 'optional' ? child.inner : child)
				if (child.type !== 'optional') required.push(key)
			}
			const extra = owned.additionalProperties
			const additionalProperties: boolean | JSONSchema =
				extra === true
					? true
					: extra !== undefined && extra !== false
						? compileSchema(extra)
						: false
			return Object.freeze({
				type: 'object',
				...(Object.keys(properties).length > 0 ? { properties: Object.freeze(properties) } : {}),
				...(required.length > 0 ? { required: Object.freeze(required) } : {}),
				additionalProperties,
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		}
		case 'union':
			return Object.freeze({
				...(owned.mode === 'oneOf'
					? {
							oneOf: Object.freeze(owned.variants.map((variant) => compileSchema(variant))),
						}
					: {
							anyOf: Object.freeze(owned.variants.map((variant) => compileSchema(variant))),
						}),
				...(owned.description !== undefined ? { description: owned.description } : {}),
			})
		case 'optional':
			return compileSchema(owned.inner)
		case 'nullable':
			return Object.freeze({
				anyOf: Object.freeze([compileSchema(owned.inner), Object.freeze({ type: 'null' })]),
			})
		case 'raw':
			return cloneSchema(owned.schema)
	}
}

// === Guard

/**
 * Compile a {@link ContractShape} into a runtime type guard.
 *
 * @remarks
 * Reuses the combinators for structural and refined shapes, including
 * {@link literalOf} for SameValueZero literal matching. Compiled object shapes
 * observe own enumerable string keys through {@link enumerableKeys}, the same
 * key view their parser, reporter, auditor, and inference use for both open and
 * closed objects — the view is shared, the verdict on an undeclared key is not
 * (this guard rejects the object; the parser drops the key).
 * Like every guard it is total — it never throws (AGENTS §14). The shape is
 * taken through {@link ownShape} first, so an unfrozen caller-owned graph
 * compiles from a snapshot. {@link validateShapeDepth} iteratively rejects
 * excessive nesting or cycles before recursive guard compilation begins.
 *
 * @param shape - The shape to compile
 * @returns A guard narrowing to the shape's inferred type
 *
 * @example
 * ```ts
 * const isUser = compileGuard(objectShape({ name: stringShape() }))
 * isUser({ name: 'Ada' }) // true
 * ```
 */
export function compileGuard<S extends ContractShape>(shape: S): Guard<Infer<S>>
export function compileGuard(shape: ContractShape): Guard<unknown>
export function compileGuard(shape: ContractShape): Guard<unknown> {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
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
			const base = arrayOf(compileGuard(owned.items))
			if (owned.min === undefined && owned.max === undefined) return base
			const withinLength = boundsOf(owned.min, owned.max)
			return whereOf(base, (value) => withinLength(value.length))
		}
		case 'object': {
			// Honest typing: a null-prototype accumulator so a property literally
			// named '__proto__' becomes an own data key instead of mutating the
			// prototype — the same pattern `pickOf` uses (combinators.ts).
			const map: Record<string, Guard<unknown>> = Object.create(null)
			const optionalKeys: string[] = []
			for (const key of Object.keys(owned.properties)) {
				const child = owned.properties[key]
				if (child === undefined) continue
				if (child.type === 'optional') {
					map[key] = compileGuard(child.inner)
					optionalKeys.push(key)
				} else {
					map[key] = compileGuard<ContractShape>(child)
				}
			}
			const extra = owned.additionalProperties
			const closed = extra === undefined || extra === false
			const additional = closed || extra === true ? undefined : compileGuard(extra)
			const required = Object.keys(map).filter((key) => !optionalKeys.includes(key))
			return (value: unknown): value is unknown => {
				if (!isRecord(value)) return false
				const keys = enumerableKeys(value)
				if (keys === undefined) return false
				const present = new Set(keys)
				for (const key of required) {
					if (!present.has(key)) return false
				}
				// Contain the whole key-enumeration + value-read walk — a hostile
				// getter on `value` must yield `false`, never throw (AGENTS §14).
				const outcome = attempt(() => {
					for (const key of keys) {
						const guard = Object.hasOwn(map, key) ? map[key] : undefined
						if (guard !== undefined) {
							if (!guard(value[key])) return false
						} else if (closed) {
							return false
						} else if (additional !== undefined && !additional(value[key])) {
							return false
						}
					}
					return true
				})
				return outcome.success && outcome.value
			}
		}
		case 'union': {
			const guards = owned.variants.map((variant) => compileGuard(variant))
			// A `oneOf`-mode union matches the emitted JSON Schema `oneOf` keyword —
			// EXACTLY one variant must guard-accept the value, not "at least one"
			// (unionOf's anyOf semantics). A value matching two-or-more variants is
			// rejected, since it would violate the compiled schema.
			if (owned.mode === 'oneOf') {
				return (value: unknown): value is unknown =>
					guards.filter((guard) => guard(value)).length === 1
			}
			return unionOf(...guards)
		}
		case 'optional':
			return orOf(isUndefined, compileGuard(owned.inner))
		case 'nullable':
			return nullableOf(compileGuard(owned.inner))
		case 'raw':
			return (value: unknown): value is unknown => value !== undefined
	}
}

// === Parser

/**
 * Compile a {@link ContractShape} into an input parser.
 *
 * @remarks
 * Reuses the leaf parsers (`parseString` / `parseInteger` / `parseNumber` /
 * `parseBoolean` / `parseRecord`) and coerces structurally. An object fails as a
 * whole on any required-field failure; a union returns a guard-valid value
 * unchanged, otherwise the first variant that both parses and guards wins.
 *
 * After coercing a leaf, it re-applies that leaf's REFINEMENTS through the same
 * combinators `compileGuard` uses — `stringOf` for a string's length/pattern,
 * `boundsOf` for a number's value and an array's length, and {@link literalOf}
 * for literal membership — so a value that coerces but violates a bound parses
 * to `undefined`. The result is full parse↔guard soundness (AGENTS §14): a
 * non-`undefined` parse always satisfies the contract's `is`, refinements
 * included — a statement about the OUTPUT, never about the input, which may be
 * a value `is` rejects. Object presence and extra-key processing read the same
 * own-enumerable-string key view as the guard, reporter, auditor, and inference
 * — one key set, deliberately different verdicts: this parser drops an
 * undeclared key that {@link compileGuard} rejects and {@link compileAuditor}
 * faults. The shape is taken through {@link ownShape} first, so an unfrozen
 * caller-owned graph compiles from a snapshot. {@link validateShapeDepth}
 * iteratively rejects excessive nesting or cycles before recursive parser
 * compilation.
 *
 * @param shape - The shape to compile
 * @returns A parser yielding the shape's inferred type or `undefined`
 *
 * @example
 * ```ts
 * const parseUser = compileParser(objectShape({ name: stringShape() }))
 * parseUser({ name: 'Ada' }) // { name: 'Ada' }
 * ```
 */
export function compileParser<S extends ContractShape>(shape: S): Parser<Infer<S>>
export function compileParser(shape: ContractShape): Parser<unknown>
export function compileParser(shape: ContractShape): Parser<unknown> {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
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
			return (value) => (isJSONValue(value) ? value : undefined)
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
			const item = compileParser(owned.items)
			const unbounded = owned.min === undefined && owned.max === undefined
			const withinLength = boundsOf(owned.min, owned.max)
			return (value) => {
				if (!isArray(value)) return undefined
				const result: unknown[] = []
				for (const entry of value) {
					const parsed = item(entry)
					if (parsed === undefined) return undefined
					result.push(parsed)
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
		// `{ id: 'a' }` for a shape whose `is` says false. `compileReporter`
		// mirrors this parser and reports nothing for a dropped key;
		// `compileAuditor` is the artifact that reports it, one `'extra'` fault
		// per undeclared key.
		case 'object': {
			const entries: { key: string; parse: Parser<unknown>; optional: boolean }[] = []
			for (const key of Object.keys(owned.properties)) {
				const child = owned.properties[key]
				if (child === undefined) continue
				const optional = child.type === 'optional'
				entries.push({ key, parse: compileParser(optional ? child.inner : child), optional })
			}
			const known = new Set(entries.map((entry) => entry.key))
			const extra = owned.additionalProperties
			const additional =
				extra === undefined || extra === false || extra === true ? undefined : compileParser(extra)
			const open = extra === true || additional !== undefined
			return (value) => {
				const record = parseRecord(value)
				if (record === undefined) return undefined
				const keys = enumerableKeys(record)
				if (keys === undefined) return undefined
				const present = new Set(keys)
				// Contain the whole record walk — a hostile getter on `record` must
				// yield `undefined`, never throw (AGENTS §14).
				const outcome = attempt(() => {
					// Honest typing: a null-prototype accumulator so an input own key
					// literally named '__proto__' lands as an own data key instead of
					// mutating the prototype (same pattern as `pickOf`).
					const result: Record<string, unknown> = Object.create(null)
					for (const entry of entries) {
						if (!present.has(entry.key)) {
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
						for (const key of keys) {
							if (known.has(key)) continue
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
				return outcome.success ? outcome.value : undefined
			}
		}
		case 'union': {
			const variants = owned.variants.map((variant) => ({
				parse: compileParser(variant),
				guard: compileGuard(variant),
			}))
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
					const matches = variants.filter((variant) => variant.guard(value))
					const [only] = matches
					return matches.length === 1 && only !== undefined ? only.parse(value) : undefined
				}
			}
			return (value) => {
				// Identity pass first (AGENTS §14 clause A): a value already valid
				// against ANY variant's guard is returned unchanged, so an earlier
				// variant's coercion never overwrites a guard-valid input.
				for (const variant of variants) {
					if (variant.guard(value)) return value
				}
				// Coercion pass: no variant matched as-is, so parse-then-guard,
				// first variant that both parses and guards wins.
				for (const variant of variants) {
					const parsed = variant.parse(value)
					if (parsed !== undefined && variant.guard(parsed)) return parsed
				}
				return undefined
			}
		}
		case 'optional': {
			const inner = compileParser(owned.inner)
			return (value) => (value === undefined ? undefined : inner(value))
		}
		case 'nullable': {
			const inner = compileParser(owned.inner)
			return (value) => (value === null ? null : inner(value))
		}
		case 'raw':
			return (value) => value
	}
}

// === Generator

/**
 * Compile a {@link ContractShape} into a deterministic seed value.
 *
 * @remarks
 * The same shape and the same `random` source always produce the same value, so
 * seed data is reproducible. Defaults to a {@link seededRandom} source seeded
 * from the wall clock when none is supplied. Shape-generation failures throw a
 * {@link ContractError} with code `'generate'`; {@link drawRandom} failures use
 * code `'random'` and retain the consuming shape category in context.
 * Failures include a pattern-constrained `stringShape` whose generated sample
 * cannot satisfy the pattern, an invalid random sample, and a `rawShape` whose
 * arbitrary embedded schema cannot be auto-generated. Degenerate empty
 * literal/union vocabularies fail earlier with the shared gate's `empty` code.
 * {@link validateShapeDepth} iteratively
 * rejects excessive nesting or cycles before recursive generation begins.
 * `createContract` runs {@link validateShape} first, so malformed vocabulary
 * and bounded shapes are caught before generation. The local empty checks
 * remain defensive after the shared gate. Union candidates are bounded by
 * {@link GENERATION_ATTEMPT_LIMIT} and accepted only when they satisfy the
 * union's compiled guard.
 *
 * @param shape - The shape to generate from
 * @param random - A seeded random source (defaults to `seededRandom(Date.now())`)
 * @returns A value matching the shape
 * @throws {ContractError} When the shape or random source cannot produce a valid value
 *
 * @example
 * ```ts
 * compileGenerator(stringShape({ min: 1, max: 4 })) // a random string of 1-4 characters (seed a RandomFunction for determinism)
 * ```
 */
export function compileGenerator<S extends ContractShape>(
	shape: S,
	random?: RandomFunction,
): Infer<S>
export function compileGenerator(shape: ContractShape, random?: RandomFunction): unknown
export function compileGenerator(
	shape: ContractShape,
	random: RandomFunction = seededRandom(Date.now()),
): unknown {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string': {
			const min = owned.min ?? 0
			const max = owned.max ?? Math.max(min, 12)
			const length = Math.max(min, Math.min(max, 8))
			const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
			let value = ''
			for (let index = 0; index < length; index += 1) {
				value += alphabet[Math.floor(drawRandom(random, 'string') * alphabet.length)]
			}
			if (owned.pattern !== undefined && !matchOf(owned.pattern)(value)) {
				throw new ContractError(
					'compileGenerator: a pattern-constrained string shape cannot be auto-generated — supply or verify values another way',
					{
						code: 'generate',
						context: { shape: 'string', limit: owned.pattern.source },
					},
				)
			}
			return value
		}
		case 'number': {
			const sample = drawRandom(random, owned.integer === true ? 'integer' : 'number')
			if (owned.integer === true) {
				const lo = Math.ceil(owned.min ?? (owned.max === undefined ? -100 : owned.max - 100))
				const hi = Math.floor(owned.max ?? (owned.min === undefined ? 100 : owned.min + 100))
				return lo === hi ? lo : Math.floor(lo * (1 - sample) + hi * sample)
			}
			const lo = owned.min ?? (owned.max === undefined ? -100 : owned.max - 100)
			const hi = owned.max ?? (owned.min === undefined ? 100 : owned.min + 100)
			return lo === hi ? lo : lo * (1 - sample) + hi * sample
		}
		case 'boolean':
			return drawRandom(random, 'boolean') >= 0.5
		case 'null':
			return null
		case 'json': {
			const pick = Math.floor(drawRandom(random, 'json') * 5)
			if (pick === 0) return null
			if (pick === 1) return drawRandom(random, 'json') >= 0.5
			if (pick === 2) return Math.floor(drawRandom(random, 'json') * 1000)
			if (pick === 3) {
				const alphabet = 'abcdefghijklmnopqrstuvwxyz'
				let value = ''
				for (let index = 0; index < 6; index += 1) {
					value += alphabet[Math.floor(drawRandom(random, 'json') * alphabet.length)]
				}
				return value
			}
			return { value: Math.floor(drawRandom(random, 'json') * 1000) }
		}
		case 'literal': {
			if (owned.values.length === 0) {
				throw new ContractError('compileGenerator: a literal shape needs at least one value', {
					code: 'generate',
					context: { shape: 'literal', limit: 1 },
				})
			}
			return owned.values[Math.floor(drawRandom(random, 'literal') * owned.values.length)]
		}
		case 'array': {
			const lo = owned.min ?? Math.min(1, owned.max ?? 1)
			const hi = owned.max ?? Math.max(lo, 3)
			const length = Math.floor(drawRandom(random, 'array') * (hi - lo + 1)) + lo
			const result: unknown[] = []
			for (let index = 0; index < length; index += 1) {
				result.push(compileGenerator(owned.items, random))
			}
			return result
		}
		case 'object': {
			// Honest typing: generated data is a value the caller keeps, so unlike the
			// guard's and parser's null-prototype property views it carries the normal
			// object prototype — `defineProperty` (never assignment) still lands a
			// '__proto__' key as an own data key rather than mutating that prototype.
			const result: Record<string, unknown> = {}
			for (const key of Object.keys(owned.properties)) {
				const child = owned.properties[key]
				if (child === undefined) continue
				if (child.type === 'optional' && drawRandom(random, 'object') < 0.3) continue
				Object.defineProperty(result, key, {
					value: compileGenerator(child.type === 'optional' ? child.inner : child, random),
					enumerable: true,
					configurable: true,
					writable: true,
				})
			}
			// An open object (additionalProperties is a shape, not a boolean) also
			// generates synthetic extra entries so the shape does not trivially
			// generate as `{}` — skip any collision with a declared property name.
			const extra = owned.additionalProperties
			if (extra !== undefined && extra !== true && extra !== false) {
				const count = 1 + Math.floor(drawRandom(random, 'object') * 2)
				for (let index = 0; index < count; index += 1) {
					const key = `key${index}`
					if (Object.hasOwn(result, key)) continue
					Object.defineProperty(result, key, {
						value: compileGenerator(extra, random),
						enumerable: true,
						configurable: true,
						writable: true,
					})
				}
			}
			return result
		}
		case 'union': {
			if (owned.variants.length === 0) {
				throw new ContractError('compileGenerator: a union shape needs at least one variant', {
					code: 'generate',
					context: { shape: 'union', limit: 1 },
				})
			}
			const guard = compileGuard<ContractShape>(owned)
			const attempts = Math.max(GENERATION_ATTEMPT_LIMIT, owned.variants.length)
			const start = Math.floor(drawRandom(random, 'union') * owned.variants.length)
			for (let attemptIndex = 0; attemptIndex < attempts; attemptIndex += 1) {
				const variant = owned.variants[(start + attemptIndex) % owned.variants.length]
				if (variant === undefined) continue
				const outcome = attempt(() => compileGenerator(variant, random))
				if (!outcome.success && isContractError(outcome.error) && outcome.error.code === 'random') {
					throw outcome.error
				}
				if (outcome.success && guard(outcome.value)) return outcome.value
			}
			throw new ContractError('compileGenerator: no union candidate satisfied the compiled guard', {
				code: 'generate',
				context: { shape: 'union', limit: attempts },
			})
		}
		case 'optional':
			return compileGenerator(owned.inner, random)
		case 'nullable':
			return drawRandom(random, 'nullable') < 0.2 ? null : compileGenerator(owned.inner, random)
		case 'raw':
			throw new ContractError(
				'compileGenerator: a raw shape embeds an arbitrary JSON Schema and cannot be auto-generated — supply values another way',
				{
					code: 'generate',
					context: { shape: 'raw', limit: 'explicit value source' },
				},
			)
	}
}

// === Reporter

/**
 * Compile a {@link ContractShape} into a structured fault report for a value —
 * the diagnostic counterpart of {@link compileGuard} / {@link compileParser}.
 *
 * @remarks
 * MIRROR-PARSE semantics: reuses the exact leaf parsers/guards
 * {@link compileParser} uses (`parseString` / `parseNumber` / `parseBoolean` /
 * `isJSONValue` / …), so the soundness invariant
 * `compileReporter(shape, v).length === 0 ⟺ compileParser(shape)(v) !== undefined`
 * holds structurally — `explain` mirrors `parse`, not the stricter `is` (a
 * coercible value like `'42'` against a `numberShape` reports no fault, the
 * same leniency `parse` grants, even though the strict guard would reject it).
 * The invariant relates two separate calls, so it holds for a value whose reads
 * are stable across calls; see the read-stability precondition on
 * {@link ContractInterface}. {@link compileAuditor} is the counterpart report
 * for the strict domain, mirroring {@link compileGuard} the way this one
 * mirrors {@link compileParser}.
 *
 * Faults are collected in stable pre-order (declared key/index order); every
 * call — object, array, and union alike, including a union's `oneOf` "no
 * match" / "no consensus" summary fault prepended to its closest variant's
 * faults — slices its return to at most {@link FAULT_LIMIT} entries, so the
 * bound holds at every level of nesting, not just the outermost container, on
 * adversarial input (a huge array, a wide record, a wide union of wide
 * records). A closed object's extra keys never
 * fault — `parse` silently drops them, so `explain` mirrors that leniency, and
 * {@link compileAuditor} is where they do fault; an open object with a
 * constraining `additionalProperties` shape recurses extras against it instead.
 * A hostile getter or throwing `Proxy` trap is contained via {@link attempt}
 * and surfaces as a single top-level type fault, never a throw (AGENTS §14).
 * {@link validateShapeDepth} iteratively rejects excessive shape nesting or
 * cycles before recursive reporting begins.
 *
 * @param shape - The shape to report against
 * @param value - The value to check
 * @param path - The path prefix for faults produced at this call (defaults to the root)
 * @returns The faults found, empty when the value parses successfully
 *
 * @example
 * ```ts
 * const user = objectShape({ name: stringShape({ min: 1 }) })
 * compileReporter(user, { name: '' })
 * // [{ reason: 'constraint', path: ['name'], expected: 'string', constraint: 'min', limit: 1, received: '""' }]
 * compileReporter(user, { name: 'Ada' }) // []
 * ```
 */
export function compileReporter(
	shape: ContractShape,
	value: unknown,
	path: string[] = [],
): readonly Fault[] {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string': {
			const parsed = parseString(value)
			if (parsed === undefined) {
				return [{ reason: 'type', path, expected: 'string', received: preview(value) }]
			}
			const faults: Fault[] = []
			if (owned.min !== undefined && parsed.length < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'min',
					limit: owned.min,
					received: preview(parsed),
				})
			}
			if (owned.max !== undefined && parsed.length > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'max',
					limit: owned.max,
					received: preview(parsed),
				})
			}
			if (owned.pattern !== undefined && !matchOf(owned.pattern)(parsed)) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'pattern',
					limit: owned.pattern.source,
					received: preview(parsed),
				})
			}
			return faults
		}
		case 'number': {
			const kind: FaultKind = owned.integer === true ? 'integer' : 'number'
			const parsed = parseNumber(value)
			if (parsed === undefined) {
				return [{ reason: 'type', path, expected: kind, received: preview(value) }]
			}
			const faults: Fault[] = []
			if (owned.integer === true && !Number.isInteger(parsed)) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'integer',
					received: preview(parsed),
				})
			}
			if (owned.min !== undefined && parsed < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'min',
					limit: owned.min,
					received: preview(parsed),
				})
			}
			if (owned.max !== undefined && parsed > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'max',
					limit: owned.max,
					received: preview(parsed),
				})
			}
			return faults
		}
		case 'boolean':
			return parseBoolean(value) === undefined
				? [{ reason: 'type', path, expected: 'boolean', received: preview(value) }]
				: []
		case 'null':
			return value === null
				? []
				: [{ reason: 'type', path, expected: 'null', received: preview(value) }]
		case 'json':
			return isJSONValue(value)
				? []
				: [{ reason: 'type', path, expected: 'json', received: preview(value) }]
		case 'literal': {
			const allowed = literalOf(owned.values)
			const matched = allowed(value) || (isString(value) && allowed(value.trim()))
			return matched
				? []
				: [{ reason: 'type', path, expected: 'literal', received: preview(value) }]
		}
		case 'array': {
			if (!isArray(value)) {
				return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
			}
			const faults: Fault[] = []
			const outcome = attempt(() => {
				for (let index = 0; index < value.length; index += 1) {
					if (faults.length >= FAULT_LIMIT) return
					faults.push(...compileReporter(owned.items, value[index], [...path, String(index)]))
				}
			})
			if (!outcome.success) {
				return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
			}
			if (owned.min !== undefined && value.length < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'array',
					constraint: 'min',
					limit: owned.min,
					received: String(value.length),
				})
			}
			if (owned.max !== undefined && value.length > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'array',
					constraint: 'max',
					limit: owned.max,
					received: String(value.length),
				})
			}
			return faults.length > FAULT_LIMIT ? faults.slice(0, FAULT_LIMIT) : faults
		}
		case 'object': {
			if (!isRecord(value)) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			const record = value
			const keys = enumerableKeys(record)
			if (keys === undefined) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			const present = new Set(keys)
			const faults: Fault[] = []
			const known = new Set<string>()
			const outcome = attempt(() => {
				for (const key of Object.keys(owned.properties)) {
					if (faults.length >= FAULT_LIMIT) return
					const child = owned.properties[key]
					if (child === undefined) continue
					known.add(key)
					const optional = child.type === 'optional'
					const inner = optional ? child.inner : child
					// Mirror the parser's presence gate exactly: only an own
					// enumerable string key is present. A present key with an
					// explicit `undefined` value is still treated like absence, so
					// `explain` never faults where `parse` silently skips it.
					if (!present.has(key)) {
						if (!optional) {
							faults.push({ reason: 'missing', path: [...path, key], expected: shapeToKind(inner) })
						}
						continue
					}
					const raw = record[key]
					if (raw === undefined) {
						if (!optional) {
							faults.push({ reason: 'missing', path: [...path, key], expected: shapeToKind(inner) })
						}
						continue
					}
					faults.push(...compileReporter(inner, raw, [...path, key]))
				}
				const extra = owned.additionalProperties
				if (extra !== undefined && extra !== true && extra !== false) {
					for (const key of keys) {
						if (faults.length >= FAULT_LIMIT) return
						if (known.has(key)) continue
						faults.push(...compileReporter(extra, record[key], [...path, key]))
					}
				}
			})
			if (!outcome.success) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			return faults.length > FAULT_LIMIT ? faults.slice(0, FAULT_LIMIT) : faults
		}
		case 'union': {
			const perVariant = owned.variants.map((variant) => compileReporter(variant, value, path))
			let bestIndex = 0
			for (let index = 1; index < perVariant.length; index += 1) {
				const current = perVariant[index]
				const best = perVariant[bestIndex]
				if (current !== undefined && best !== undefined && current.length < best.length) {
					bestIndex = index
				}
			}
			const closest = perVariant[bestIndex] ?? []
			if (owned.mode === 'oneOf') {
				let matched = 0
				for (const variant of owned.variants) {
					if (compileGuard(variant)(value)) matched += 1
				}
				if (matched === 1) return []
				if (matched === 0) {
					const summary: Fault = { reason: 'oneOf', path, matched: 0 }
					return [summary, ...closest].slice(0, FAULT_LIMIT)
				}
				return [{ reason: 'oneOf', path, matched }]
			}
			const anyMatch = perVariant.some((variantFaults) => variantFaults.length === 0)
			if (anyMatch) return []
			const summary: Fault = { reason: 'variant', path, variants: owned.variants.length }
			return [summary, ...closest].slice(0, FAULT_LIMIT)
		}
		case 'optional':
			return value === undefined ? [] : compileReporter(owned.inner, value, path)
		case 'nullable':
			return value === null ? [] : compileReporter(owned.inner, value, path)
		case 'raw':
			return value === undefined
				? [{ reason: 'type', path, expected: 'json', received: preview(value) }]
				: []
	}
}

/**
 * Audit a value against the strict acceptance domain of a {@link ContractShape}.
 *
 * @remarks
 * The diagnostic for the domain {@link compileGuard} and {@link compileSchema}
 * describe, where {@link compileReporter} diagnoses the wider preimage
 * {@link compileParser} maps into it. This walk therefore mirrors the guard:
 * leaf coercions are faults, closed-object extras are faults, and union
 * acceptance is decided from each variant's strict audit emptiness, so the
 * soundness invariant
 * `compileAuditor(shape, v).length === 0 ⟺ compileGuard(shape)(v)` holds
 * structurally. {@link validateShapeDepth} rejects structural and bound-domain
 * malformations before either artifact recurses, so the invariant is only
 * evaluated for a valid declaration. The invariant relates two
 * separate calls, so it holds for a value whose reads are stable across calls;
 * see the read-stability precondition on {@link ContractInterface}. Every
 * recursive call returns at most {@link FAULT_LIMIT} entries. Hostile property
 * access is contained through {@link attempt} and collapses to one fault at the
 * current container path.
 *
 * @param shape - The shape to audit against
 * @param value - The value to check
 * @param path - The path prefix for faults produced at this call
 * @returns The strict faults found, empty exactly when the compiled guard accepts a stably-read value
 *
 * @example
 * ```ts
 * const user = objectShape({ name: stringShape() })
 * compileAuditor(user, { name: 'Ada', extra: true })
 * // [{ reason: 'extra', path: ['extra'] }]
 * ```
 */
export function compileAuditor(
	shape: ContractShape,
	value: unknown,
	path: string[] = [],
): readonly AuditFault[] {
	const owned = ownShape(shape)
	validateShapeDepth(owned)
	switch (owned.type) {
		case 'string': {
			if (!isString(value)) {
				return [{ reason: 'type', path, expected: 'string', received: preview(value) }]
			}
			const faults: AuditFault[] = []
			if (owned.min !== undefined && value.length < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'min',
					limit: owned.min,
					received: preview(value),
				})
			}
			if (owned.max !== undefined && value.length > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'max',
					limit: owned.max,
					received: preview(value),
				})
			}
			if (owned.pattern !== undefined && !matchOf(owned.pattern)(value)) {
				faults.push({
					reason: 'constraint',
					path,
					expected: 'string',
					constraint: 'pattern',
					limit: owned.pattern.source,
					received: preview(value),
				})
			}
			return faults
		}
		case 'number': {
			const kind: FaultKind = owned.integer === true ? 'integer' : 'number'
			if (!isFiniteNumber(value)) {
				return [{ reason: 'type', path, expected: kind, received: preview(value) }]
			}
			const faults: AuditFault[] = []
			if (owned.integer === true && !Number.isInteger(value)) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'integer',
					received: preview(value),
				})
			}
			if (owned.min !== undefined && value < owned.min) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'min',
					limit: owned.min,
					received: preview(value),
				})
			}
			if (owned.max !== undefined && value > owned.max) {
				faults.push({
					reason: 'constraint',
					path,
					expected: kind,
					constraint: 'max',
					limit: owned.max,
					received: preview(value),
				})
			}
			return faults
		}
		case 'boolean':
			return isBoolean(value)
				? []
				: [{ reason: 'type', path, expected: 'boolean', received: preview(value) }]
		case 'null':
			return value === null
				? []
				: [{ reason: 'type', path, expected: 'null', received: preview(value) }]
		case 'json':
			return isJSONValue(value)
				? []
				: [{ reason: 'type', path, expected: 'json', received: preview(value) }]
		case 'literal':
			return literalOf(owned.values)(value)
				? []
				: [{ reason: 'type', path, expected: 'literal', received: preview(value) }]
		case 'array': {
			if (!isArray(value)) {
				return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
			}
			const faults: AuditFault[] = []
			const outcome = attempt(() => {
				for (let index = 0; index < value.length; index += 1) {
					if (faults.length >= FAULT_LIMIT) return
					const entry = Object.hasOwn(value, index) ? value[index] : undefined
					faults.push(...compileAuditor(owned.items, entry, [...path, String(index)]))
				}
				if (owned.min !== undefined && value.length < owned.min) {
					faults.push({
						reason: 'constraint',
						path,
						expected: 'array',
						constraint: 'min',
						limit: owned.min,
						received: String(value.length),
					})
				}
				if (owned.max !== undefined && value.length > owned.max) {
					faults.push({
						reason: 'constraint',
						path,
						expected: 'array',
						constraint: 'max',
						limit: owned.max,
						received: String(value.length),
					})
				}
			})
			if (!outcome.success) {
				return [{ reason: 'type', path, expected: 'array', received: preview(value) }]
			}
			return faults.length > FAULT_LIMIT ? faults.slice(0, FAULT_LIMIT) : faults
		}
		case 'object': {
			if (!isRecord(value)) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			const record = value
			const keys = enumerableKeys(record)
			if (keys === undefined) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			const present = new Set(keys)
			const declaredKeys = Object.keys(owned.properties)
			const declared = new Set(declaredKeys)
			const faults: AuditFault[] = []
			const extra = owned.additionalProperties
			const closed = extra === undefined || extra === false
			const additional = closed || extra === true ? undefined : extra
			const outcome = attempt(() => {
				for (const key of declaredKeys) {
					if (faults.length >= FAULT_LIMIT) return
					const child = owned.properties[key]
					if (child === undefined) continue
					const optional = child.type === 'optional'
					const inner = optional ? child.inner : child
					if (!present.has(key)) {
						if (!optional) {
							faults.push({
								reason: 'missing',
								path: [...path, key],
								expected: shapeToKind(inner),
							})
						}
						continue
					}
					faults.push(...compileAuditor(inner, record[key], [...path, key]))
				}
				for (const key of keys) {
					if (faults.length >= FAULT_LIMIT) return
					if (declared.has(key)) continue
					if (closed) {
						faults.push({ reason: 'extra', path: [...path, key] })
					} else if (additional !== undefined) {
						faults.push(...compileAuditor(additional, record[key], [...path, key]))
					}
				}
			})
			if (!outcome.success) {
				return [{ reason: 'type', path, expected: 'object', received: preview(value) }]
			}
			return faults.length > FAULT_LIMIT ? faults.slice(0, FAULT_LIMIT) : faults
		}
		case 'union': {
			const perVariant = owned.variants.map((variant) => compileAuditor(variant, value, path))
			const matched = perVariant.filter((faults) => faults.length === 0).length
			if (owned.mode === 'oneOf') {
				if (matched === 1) return []
				if (matched > 1) return [{ reason: 'oneOf', path, matched }]
			} else if (matched > 0) {
				return []
			}
			let bestIndex = 0
			for (let index = 1; index < perVariant.length; index += 1) {
				const current = perVariant[index]
				const best = perVariant[bestIndex]
				if (current !== undefined && best !== undefined && current.length < best.length) {
					bestIndex = index
				}
			}
			const closest = perVariant[bestIndex] ?? []
			const summary: AuditFault =
				owned.mode === 'oneOf'
					? { reason: 'oneOf', path, matched: 0 }
					: { reason: 'variant', path, variants: owned.variants.length }
			return [summary, ...closest].slice(0, FAULT_LIMIT)
		}
		case 'optional':
			return value === undefined ? [] : compileAuditor(owned.inner, value, path)
		case 'nullable':
			return value === null ? [] : compileAuditor(owned.inner, value, path)
		case 'raw':
			return value === undefined
				? [{ reason: 'type', path, expected: 'json', received: preview(value) }]
				: []
	}
}

// === Contract

/**
 * Compile a {@link ContractShape} into a {@link ContractInterface} — the six
 * lockstep outputs from one declaration, lockstep meaning derived from one
 * owned snapshot rather than accepting the same values.
 *
 * @remarks
 * Runs {@link validateShapeDepth} on every original declaration before
 * ownership, then runs {@link validateShape} on the snapshot — a malformed
 * shape throws immediately rather than compiling into a silently-wrong
 * contract (AGENTS §12). It always takes its own {@link cloneShape} snapshot —
 * never merely a frozen node's word — and hands that same graph to every
 * artifact compiler. Pre-ownership gating prevents cloning from normalizing a
 * malformed scalar field; hostile reflection remains contained.
 * Then it precompiles the deeply frozen owned schema, guard, and parser once;
 * `generate` walks the snapshot per call with the supplied random source;
 * `audit` and `explain` compile their diagnostic reports via
 * {@link compileAuditor} and {@link compileReporter} at zero added compile-time
 * cost (they re-walk the snapshot per call, exactly like `generate`).
 *
 * @param shape - The shape to compile
 * @returns A contract bundling `schema` / `is` / `parse` / `audit` / `explain` / `generate`
 *
 * @example
 * ```ts
 * const user = createContract(objectShape({ name: stringShape(), age: integerShape() }))
 * user.is({ name: 'Ada', age: 36 })        // true
 * user.parse({ name: 'Ada', age: '36' })   // { name: 'Ada', age: 36 }
 * user.schema                              // { type: 'object', properties: { … }, … }
 * ```
 */
export function createContract<S extends ContractShape>(shape: S): ContractInterface<Infer<S>>
export function createContract(shape: ContractShape): ContractInterface<unknown>
export function createContract(shape: ContractShape): ContractInterface<unknown> {
	validateShapeDepth(shape)
	const snapshot = cloneShape(shape)
	validateShape(snapshot)
	const schema = compileSchema(snapshot)
	const guard = compileGuard(snapshot)
	const parser = compileParser(snapshot)
	return {
		schema,
		is: guard,
		parse(value: unknown): unknown {
			return parser(value)
		},
		audit(value: unknown): readonly AuditFault[] {
			return compileAuditor(snapshot, value)
		},
		explain(value: unknown): readonly Fault[] {
			return compileReporter(snapshot, value)
		},
		generate(random?: RandomFunction): unknown {
			return compileGenerator(snapshot, random)
		},
	}
}
