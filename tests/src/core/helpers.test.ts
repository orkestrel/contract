import type {
	ArrayRead,
	ArrayShape,
	ContractCode,
	ContractErrorContext,
	ContractShape,
	ContractErrorOptions,
	Fault,
	JSONSchema,
	JSONSchemaType,
	NumberShape,
	Result,
	StringShape,
} from '@src/core'
import {
	BlankBrandDeclaration,
	buildDeepNest,
	ClassSampleMemo,
	buildSharedDagShape,
	buildTypeFault,
	buildSparseArray,
	captureContractError,
	createNativeMaximumSparseArray,
	createRevokedArrayProxy,
	createRevokedProxy,
	createProxiedBrandDeclaration,
	createThrowingPrototype,
	createThrowingGetter,
	denyRecognition,
	faultsToConstraints,
	ForgedBrandDeclaration,
	NullBaseDeclaration,
	pollutePrototype,
	RECORD_BRAND_MEMBERS,
	replaceIntrinsic,
	replaceStringIterator,
	replaceStringSlice,
	StrippedBrandDeclaration,
	StringDeclaration,
	throwSentinel,
} from '../../setup.js'
import { createForeignPrototype, createForeignRecord } from '../../setupServer.js'
import { describe, expect, expectTypeOf, it } from 'vitest'
import {
	admitMember,
	admitVisited,
	appendEntries,
	arrayShape,
	attempt,
	buildSampleMemo,
	collectEntries,
	collectMembers,
	compareValues,
	compileAuditor,
	compileReporter,
	COMPILE_NODE_LIMIT,
	contain,
	ContractCompiler,
	ContractError,
	buildArrayFaults,
	createContract,
	buildNumberFaults,
	buildStringFaults,
	drawRandom,
	INTRINSICS,
	limitEntries,
	matchesMember,
	matchesPattern,
	matchesVisited,
	omitVisited,
	ownPattern,
	pathOf,
	pinMembers,
	readMapEntries,
	readPattern,
	readPatternFlags,
	readPatternSource,
	readSampleMemo,
	readSetEntries,
	refuseExpansion,
	retainDepth,
	sortValues,
	validateShape,
	enumerableKeys,
	enumerableSymbolCount,
	GUARD_DEPTH_LIMIT,
	holds,
	isBoundedJSONValue,
	isJSONValue,
	isContractError,
	isRecord,
	isString,
	parseJSONValue,
	integerShape,
	JSONCloner,
	SchemaCloner,
	ShapeCloner,
	ShapeValidator,
	matchesJSONDepth,
	matchesJSONValue,
	matchesRecordBrand,
	objectShape,
	nullableShape,
	optionalShape,
	INFER_DEPTH_LIMIT,
	preview,
	readArrayEntries,
	readGuardShape,
	readOptions,
	readValue,
	resolveField,
	sanitizeBudget,
	sanitizeDepth,
	schemaToObject,
	schemaToParameters,
	seededRandom,
	selectClosestFaults,
	shapeToKind,
	stringShape,
	unionShape,
	valueToSchema,
} from '@src/core'

describe('ContractError', () => {
	it('constructs without context or an own cause property', () => {
		const error = new ContractError('Invalid bound', { code: 'bound' })

		expect(error).toBeInstanceOf(Error)
		expect(error).toBeInstanceOf(ContractError)
		expect(error.name).toBe('ContractError')
		expect(error.message).toBe('Invalid bound')
		expect(error.code).toBe('bound')
		expect(error.context).toBeUndefined()
		expect(Object.hasOwn(error, 'cause')).toBe(false)
	})

	it('preserves context and cause references', () => {
		const context: ContractErrorContext = {
			path: ['properties', 'age'],
			shape: 'number',
			limit: 120,
			received: '121',
		}
		const cause = new Error('origin')
		const error = new ContractError('Invalid range', {
			code: 'range',
			context,
			cause,
		})

		expect(error.context).toBe(context)
		expect(error.cause).toBe(cause)
	})

	it('distinguishes an omitted cause from an explicit undefined cause', () => {
		const omitted = new ContractError('No origin', { code: 'structure' })
		const explicit = new ContractError('Undefined origin', {
			code: 'structure',
			cause: undefined,
		})

		expect(Object.hasOwn(omitted, 'cause')).toBe(false)
		expect(Object.hasOwn(explicit, 'cause')).toBe(true)
		expect(explicit.cause).toBeUndefined()
	})

	it('preserves arbitrary object and symbol causes exactly', () => {
		const causes: readonly unknown[] = [Object.freeze({ source: 'object' }), Symbol('cause')]

		for (const cause of causes) {
			const error = new ContractError('Exact origin', { code: 'structure', cause })
			expect(Object.hasOwn(error, 'cause')).toBe(true)
			expect(error.cause).toBe(cause)
		}
	})

	it('treats an inherited cause and an inherited context as absent', () => {
		// The documented distinction is OWN property versus omission, and this is
		// the reason it has to be: an unqualified read of an absent option leaves
		// the container and lands on `Object.prototype`, which every caller can
		// write, so an inherited answer is the caller of the ENGINE choosing what
		// a refusal the engine authored carries.
		const cause = Object.freeze({ source: 'prototype' })
		const context: ContractErrorContext = Object.freeze({ path: ['prototype'] })
		const options: ContractErrorOptions = { code: 'structure' }
		Object.setPrototypeOf(options, { cause, context })

		const error = new ContractError('Inherited origin', options)

		expect(Object.hasOwn(error, 'cause')).toBe(false)
		expect(error.cause).toBeUndefined()
		expect(error.context).toBeUndefined()
	})

	it('preserves a non-enumerable own non-undefined cause exactly', () => {
		const cause = Object.freeze({ source: 'hidden' })
		const options: ContractErrorOptions = { code: 'structure' }
		Object.defineProperty(options, 'cause', { value: cause, enumerable: false })

		const error = new ContractError('Hidden origin', options)

		expect(Object.hasOwn(error, 'cause')).toBe(true)
		expect(error.cause).toBe(cause)
	})

	it('reads an accessor cause exactly once and preserves its value', () => {
		const cause = Object.freeze({ source: 'accessor' })
		const options: ContractErrorOptions = { code: 'structure' }
		let reads = 0
		Object.defineProperty(options, 'cause', {
			get() {
				reads += 1
				return cause
			},
		})

		const error = new ContractError('Accessor origin', options)

		expect(reads).toBe(1)
		expect(error.cause).toBe(cause)
	})

	it('establishes cause ownership before reading the cause at all', () => {
		const cause = Object.freeze({ source: 'proxy' })
		const observed: Array<{
			readonly owned: boolean
			readonly reads: number
			readonly adopted: boolean
		}> = []

		for (const owned of [true, false]) {
			let reads = 0
			const options = new Proxy<ContractErrorOptions>(
				{ code: 'structure' },
				{
					get(target, property, receiver) {
						if (property === 'cause') {
							reads += 1
							return cause
						}
						return Reflect.get(target, property, receiver)
					},
					getOwnPropertyDescriptor(target, property) {
						if (property === 'cause') {
							return owned
								? { value: cause, configurable: true, writable: true, enumerable: true }
								: undefined
						}
						return Reflect.getOwnPropertyDescriptor(target, property)
					},
				},
			)

			const error = new ContractError('Proxy origin', options)
			observed.push({
				owned,
				reads,
				adopted: Object.hasOwn(error, 'cause') && error.cause === cause,
			})
		}

		// Ownership decides first, so an unowned answer is never read and never
		// adopted; an owned one is read exactly once.
		expect(observed).toEqual([
			{ owned: true, reads: 1, adopted: true },
			{ owned: false, reads: 0, adopted: false },
		])
	})

	it('accepts and preserves every ContractCode', () => {
		const codes: Readonly<Record<ContractCode, ContractCode>> = {
			bound: 'bound',
			range: 'range',
			empty: 'empty',
			placement: 'placement',
			structure: 'structure',
			literal: 'literal',
			cycle: 'cycle',
			pattern: 'pattern',
			generate: 'generate',
			random: 'random',
			clone: 'clone',
			depth: 'depth',
			expansion: 'expansion',
		}

		for (const code of Object.values(codes)) {
			expect(new ContractError(code, { code }).code).toBe(code)
		}
	})
})

describe('isContractError', () => {
	it('accepts a ContractError', () => {
		expect(isContractError(new ContractError('Invalid shape', { code: 'placement' }))).toBe(true)
	})

	it('rejects an ordinary Error and a plain lookalike', () => {
		expect(isContractError(new Error('Invalid shape'))).toBe(false)
		expect(
			isContractError({
				name: 'ContractError',
				message: 'Invalid shape',
				code: 'placement',
			}),
		).toBe(false)
	})

	it('rejects primitives', () => {
		expect(isContractError(null)).toBe(false)
		expect(isContractError(undefined)).toBe(false)
		expect(isContractError('ContractError')).toBe(false)
		expect(isContractError(1)).toBe(false)
		expect(isContractError(true)).toBe(false)
		expect(isContractError(Symbol('ContractError'))).toBe(false)
	})

	it('returns false without throwing for a revoked Proxy', () => {
		const hostile = createRevokedProxy()
		expect(() => isContractError(hostile)).not.toThrow()
		expect(isContractError(hostile)).toBe(false)
	})

	it('recognizes its own error while the caller poisons the recognition protocol hook', () => {
		// `Symbol.hasInstance` is a caller-writable member of the constructor, so a
		// narrowing spelled `instanceof` is a dispatch through caller-reachable
		// code. Both installations are exercised: a hook that THROWS is contained
		// by a boundary and a hook that merely ANSWERS FALSE is not — the second
		// is the one a `try`/`catch` cannot tell from an honest refusal.
		const error = new ContractError('Invalid shape', { code: 'placement' })
		const forgery = { name: 'ContractError', message: 'Invalid shape', code: 'placement' }
		const denied = pollutePrototype(
			ContractError,
			Symbol.hasInstance,
			() => denyRecognition,
			() => ({
				own: isContractError(error),
				forged: isContractError(forgery),
			}),
		)
		const thrown = pollutePrototype(
			ContractError,
			Symbol.hasInstance,
			() => throwSentinel(Object.freeze({ stage: 'hasInstance' })),
			() => ({ own: isContractError(error), forged: isContractError(forgery) }),
		)

		expect({ denied, thrown }).toEqual({
			denied: { own: true, forged: false },
			thrown: { own: true, forged: false },
		})
	})
})

describe('attempt', () => {
	it('returns the exact value without mutation and invokes the callback once', () => {
		let calls = 0
		const value = { state: 'ready' }
		const outcome = attempt(() => {
			calls += 1
			return value
		})

		expect(outcome).toEqual({ success: true, value })
		expect(outcome.success && outcome.value).toBe(value)
		expect(value).toEqual({ state: 'ready' })
		expect(calls).toBe(1)
	})

	it('preserves Error and subclass identity', () => {
		for (const reason of [new Error('error'), new TypeError('subclass')]) {
			const outcome = attempt(() => {
				throw reason
			})

			expect(outcome.success).toBe(false)
			expect(!outcome.success && outcome.error).toBe(reason)
		}
	})

	it('preserves every primitive thrown value exactly', () => {
		const reasons: readonly unknown[] = [
			'plain string reason',
			Symbol('symbol reason'),
			42,
			Number.NaN,
			-0,
			0,
			42n,
			true,
			false,
			null,
			undefined,
		]

		for (const reason of reasons) {
			const outcome = attempt(() => {
				throw reason
			})

			expect(outcome.success).toBe(false)
			if (outcome.success) continue
			expect(Object.hasOwn(outcome, 'error')).toBe(true)
			expect(Object.is(outcome.error, reason)).toBe(true)
		}
	})

	it('preserves null-prototype and frozen structured reasons by identity', () => {
		const prototypeLess: object = Object.create(null)
		const frozen = Object.freeze({ code: 'structured', details: Object.freeze(['exact']) })

		for (const reason of [prototypeLess, frozen]) {
			const outcome = attempt(() => {
				throw reason
			})

			expect(outcome.success).toBe(false)
			expect(!outcome.success && outcome.error).toBe(reason)
		}
	})

	it('does not invoke coercion hooks on a thrown value', () => {
		let primitive = 0
		let string = 0
		let value = 0
		const hostile = Object.freeze({
			[Symbol.toPrimitive]() {
				primitive += 1
				throw new Error('primitive coercion')
			},
			toString() {
				string += 1
				throw new Error('string coercion')
			},
			valueOf() {
				value += 1
				throw new Error('value coercion')
			},
		})
		const outcome = attempt(() => {
			throw hostile
		})

		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBe(hostile)
		expect({ primitive, string, value }).toEqual({ primitive: 0, string: 0, value: 0 })
		expect(() => String(hostile)).toThrow('primitive coercion')
		expect(primitive).toBe(1)
	})

	it('preserves a revoked Proxy reason without a secondary throw', () => {
		const hostile = createRevokedProxy()
		const outcome = attempt(() => {
			throw hostile
		})

		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBe(hostile)
	})

	it('invokes a throwing callback exactly once', () => {
		let calls = 0
		const reason = Symbol('once')
		const outcome = attempt(() => {
			calls += 1
			throw reason
		})

		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBe(reason)
		expect(calls).toBe(1)
	})

	it('returns a rejecting Promise by identity without observing settlement', async () => {
		const reason = Symbol('rejection')
		const promise = Promise.reject(reason)
		const handled = promise.catch((error: unknown) => error)
		const outcome = attempt(() => promise)

		expect(outcome.success).toBe(true)
		expect(outcome.success && outcome.value).toBe(promise)
		expect(await handled).toBe(reason)
	})

	it('returns a hostile thenable by identity without reading or calling then', () => {
		let reads = 0
		let calls = 0
		const thenable = Object.defineProperty({}, 'then', {
			get() {
				reads += 1
				return () => {
					calls += 1
				}
			},
		})
		const outcome = attempt(() => thenable)

		expect(outcome.success).toBe(true)
		expect(outcome.success && outcome.value).toBe(thenable)
		expect({ reads, calls }).toEqual({ reads: 0, calls: 0 })
		expect(Reflect.get(thenable, 'then')).toBeTypeOf('function')
		expect(reads).toBe(1)
	})

	it('exposes unknown after failure-discriminant narrowing', () => {
		const outcome: Result<number> = attempt<number>(() => {
			throw Symbol('typed failure')
		})

		expect(outcome.success).toBe(false)
		if (!outcome.success) expectTypeOf(outcome.error).toEqualTypeOf<unknown>()
	})

	it('lets captureContractError reject a revoked Proxy without inspecting it', () => {
		const hostile = createRevokedProxy()
		expect(() =>
			captureContractError(() => {
				throw hostile
			}),
		).toThrow('captureContractError: the operation threw a non-ContractError')
	})
})

describe('readValue', () => {
	it('returns a successful read and gives every failed read one code and message shape', () => {
		expect(readValue(() => 42, 'example')).toBe(42)
		const error = captureContractError(() =>
			readValue(() => {
				throw new Error('hostile read')
			}, 'example'),
		)
		expect(error.code).toBe('structure')
		expect(error.message).toBe('example: value could not be read')
	})

	it('carries structured context and contains hostile diagnostic options', () => {
		const contextual = captureContractError(() =>
			readValue(
				() => {
					throw new Error('hostile read')
				},
				'compileParser',
				{ subject: 'array', context: { path: ['values'], shape: 'array' } },
			),
		)
		expect(contextual.context).toEqual({ path: ['values'], shape: 'array' })

		const revoked = createRevokedProxy()
		const hostile = captureContractError(() =>
			Reflect.apply(readValue, undefined, [
				() => {
					throw new Error('hostile read')
				},
				revoked,
				{ code: revoked },
			]),
		)
		expect(hostile.code).toBe('structure')
		expect(hostile.message).toBe('readValue: value could not be read')
	})

	it('preserves an exact non-Error thrown value as the refusal cause', () => {
		const reason = Object.freeze({ operation: 'read' })
		const error = captureContractError(() =>
			readValue(() => {
				throw reason
			}, 'example'),
		)

		expect(error.cause).toBe(reason)
	})

	it('projects its refusal context from OWN context fields only', () => {
		// Every field of an internal diagnostic literal that omits it is an
		// ordinary `Get`, so it walks to `Object.prototype` — which every caller
		// can write. All four consumed fields are exercised, because a rule
		// applied to the field a probe happened to choose is not a rule.
		const stolen = Object.freeze(['pwned'])
		const reason = Object.freeze({ stage: 'read' })
		const fields: ReadonlyArray<keyof ContractErrorContext> = ['path', 'shape', 'limit', 'received']
		const observed = fields.map((field) => {
			// The carried field is always one the probed field does not name, so
			// `context` is defined and the omission under test is genuine.
			const context: ContractErrorContext =
				field === 'shape' ? { path: ['kept'] } : { shape: 'kept' }
			const error = pollutePrototype(
				Object.prototype,
				field,
				() => stolen,
				() => captureContractError(() => readValue(throwSentinel(reason), 'example', { context })),
			)
			return [field, Object.keys(error.context ?? {})]
		})

		expect(observed).toEqual([
			['path', ['shape']],
			['shape', ['path']],
			['limit', ['shape']],
			['received', ['shape']],
		])
	})

	it('keeps a caller value out of a builder refusal it never received', () => {
		// The sharper half of the same defect at a public door: an inherited read
		// puts a caller-supplied object into an error the package authored, and
		// retains it BY IDENTITY.
		const stolen = Object.freeze(['pwned'])
		const error = pollutePrototype(
			Object.prototype,
			'path',
			() => stolen,
			() =>
				captureContractError(() =>
					Reflect.apply(stringShape, undefined, [createThrowingGetter('min')]),
				),
		)

		expect(Object.keys(error.context ?? {})).toEqual(['shape'])
		expect(Object.values(error.context ?? {})).not.toContain(stolen)
		expect(error.message).toBe('stringShape: options could not be read')
	})

	it('refuses the read when any own context field throws, advertised or not', () => {
		// The copy takes every OWN enumerable key, so a key `ContractErrorContext`
		// never advertises is read at the same moment as one it does. A reader
		// consulting the four consumed names BY NAME would let the unadvertised
		// getter through and go on to publish a refusal built from a context
		// nothing could finish reading.
		const reason = Object.freeze({ stage: 'context read' })
		const observed = ['path', 'detail'].map((key) => {
			const context: ContractErrorContext = {}
			Object.defineProperty(context, key, { enumerable: true, get: throwSentinel(reason) })
			const error = captureContractError(() => readValue(() => 42, 'example', { context }))
			return [key, error.message, error.code, error.cause === reason]
		})

		expect(observed).toEqual([
			['path', 'readValue: options could not be read', 'structure', true],
			['detail', 'readValue: options could not be read', 'structure', true],
		])
	})

	it('publishes carried context fields in one canonical order and retains no caller object', () => {
		const reason = Object.freeze({ stage: 'read' })
		const carried: ContractErrorContext = {
			received: '"sample"',
			limit: 8,
			shape: 'string',
			path: ['values', 'name'],
		}
		const error = captureContractError(() =>
			readValue(throwSentinel(reason), 'example', {
				subject: 'array',
				code: 'bound',
				context: carried,
			}),
		)

		expect(Object.keys(error.context ?? {})).toEqual(['path', 'shape', 'limit', 'received'])
		expect(error.context).toEqual({
			path: ['values', 'name'],
			shape: 'string',
			limit: 8,
			received: '"sample"',
		})
		expect(error.context).not.toBe(carried)
		expect(error.code).toBe('bound')
		expect(error.message).toBe('example: array could not be read')
		expect(error.cause).toBe(reason)

		const partial = captureContractError(() =>
			readValue(throwSentinel(reason), 'example', { context: { received: 'null', path: ['id'] } }),
		)

		expect(Object.keys(partial.context ?? {})).toEqual(['path', 'received'])
	})

	it('returns the callback value by identity when every context field is carried', () => {
		const value = Object.freeze({ id: 1 })
		const read = readValue(() => value, 'example', {
			subject: 'record',
			code: 'clone',
			context: { path: ['values'], shape: 'object', limit: 4, received: 'object' },
		})

		expect(read).toBe(value)
		expect(readValue(() => undefined, 'example')).toBeUndefined()
	})

	it('refuses through its own error when a subject accessor changes its answer between reads', () => {
		let reads = 0
		const options = {
			get subject() {
				reads += 1
				return reads === 1
					? 'thing'
					: {
							toString() {
								throw new Error('hostile toString')
							},
						}
			},
		}
		const error = captureContractError(() =>
			Reflect.apply(readValue, undefined, [
				() => {
					throw new Error('hostile read')
				},
				'door',
				options,
			]),
		)

		expect(error).toBeInstanceOf(ContractError)
		expect(error.message).toBe('door: thing could not be read')
		expect(reads).toBe(1)
	})
})

describe('readArrayEntries', () => {
	it('snapshots a native-maximum sparse array without indexed source work', () => {
		const fixture = createNativeMaximumSparseArray<number>()
		const outcome = readArrayEntries(fixture.value)

		expect(outcome.success).toBe(true)
		if (!outcome.success) throw outcome.error
		expect(outcome.value.dense).toBe(false)
		expect(outcome.value.entries.length).toBe(2 ** 32 - 1)
		expect(Reflect.ownKeys(outcome.value.entries)).toEqual(['length'])
		expect(Object.isFrozen(outcome.value.entries)).toBe(true)
		expect(Object.isFrozen(outcome.value)).toBe(true)
		expect(fixture.probes).toEqual([])
	})

	it('makes indexed membership probes visible to the maximum-sparse fixture', () => {
		const fixture = createNativeMaximumSparseArray<unknown>()

		expect(() => 0 in fixture.value).toThrow('Indexed source membership read: 0')
		expect(fixture.probes).toEqual(['membership:0'])
	})

	it('freezes one own-index snapshot and derives density', () => {
		const dense = readArrayEntries([1, 2])
		if (!dense.success) throw dense.error
		expectTypeOf(dense.value.entries).toEqualTypeOf<ReadonlyArray<number | undefined>>()
		expectTypeOf<ArrayRead['entries']>().toEqualTypeOf<readonly unknown[]>()
		expect(dense).toEqual({ success: true, value: { entries: [1, 2], dense: true } })
		expect(Object.isFrozen(dense.value)).toBe(true)
		expect(Object.isFrozen(dense.value.entries)).toBe(true)

		const sparseSource: number[] = []
		sparseSource.length = 3
		sparseSource[1] = 2
		const sparse = readArrayEntries(sparseSource)
		if (!sparse.success) throw sparse.error
		expectTypeOf(sparse.value.entries).toEqualTypeOf<ReadonlyArray<number | undefined>>()
		expect(sparse).toEqual({
			success: true,
			value: { entries: [undefined, 2, undefined], dense: false },
		})
		expect(sparse.value.entries[0]).toBeUndefined()
		expect(sparse.value.entries[2]).toBeUndefined()
		expect(Object.hasOwn(sparse.value.entries, 0)).toBe(false)
		expect(Object.hasOwn(sparse.value.entries, 1)).toBe(true)
		expect(Object.hasOwn(sparse.value.entries, 2)).toBe(false)
		expect(Reflect.ownKeys(sparse.value.entries)).toEqual(['1', 'length'])

		const unknownSparse = readArrayEntries(buildSparseArray())
		expect(unknownSparse.success && unknownSparse.value.dense).toBe(false)
	})

	it('reads a reordered key view identically to an ordinary copy', () => {
		// A caller-defined key view is the only source of a non-ascending arrival.
		// Its answer is pinned to the answer an ordinary copy of the same members
		// produces, and its membership reads to the documented ascending order —
		// which the snapshot alone cannot show, because entries are assigned by
		// index and retain no trace of the order their indices arrived in.
		const observed: string[] = []
		const source = [10, 20, 30]
		const reordered = new Proxy(source, {
			getOwnPropertyDescriptor(target, property) {
				if (typeof property === 'string') observed[observed.length] = property
				return Reflect.getOwnPropertyDescriptor(target, property)
			},
			ownKeys() {
				return ['2', '1', '0', 'length']
			},
		})
		const expected = readArrayEntries([...source])
		const outcome = readArrayEntries(reordered)

		expect(outcome.success).toBe(true)
		if (!outcome.success) throw outcome.error
		if (!expected.success) throw expected.error
		expect(observed).toEqual(['0', '1', '2'])
		expect(outcome.value.entries).toEqual([10, 20, 30])
		expect(outcome.value.entries).toEqual(expected.value.entries)
		expect(outcome.value.dense).toBe(expected.value.dense)
		expect(outcome.value.dense).toBe(true)
	})

	it('snapshots an array carrying an extra own string key like a plain array', () => {
		const annotated: number[] = [1, 2]
		Object.defineProperty(annotated, 'note', { value: 'metadata', enumerable: true })
		const outcome = readArrayEntries(annotated)
		const plain = readArrayEntries([1, 2])

		expect(Reflect.ownKeys(annotated)).toEqual(['0', '1', 'length', 'note'])
		expect(outcome.success).toBe(true)
		if (!outcome.success) throw outcome.error
		if (!plain.success) throw plain.error
		expect(outcome.value.entries).toEqual(plain.value.entries)
		expect(outcome.value.dense).toBe(plain.value.dense)
		expect(outcome.value.dense).toBe(true)
		expect(Reflect.ownKeys(outcome.value.entries)).toEqual(['0', '1', 'length'])
	})

	it('snapshots an array carrying an own symbol key like a plain array', () => {
		const marked: number[] = [1, 2]
		Object.defineProperty(marked, Symbol('mark'), { value: 'metadata', enumerable: true })
		const outcome = readArrayEntries(marked)
		const plain = readArrayEntries([1, 2])

		expect(Reflect.ownKeys(marked).length).toBe(4)
		expect(outcome.success).toBe(true)
		if (!outcome.success) throw outcome.error
		if (!plain.success) throw plain.error
		expect(outcome.value.entries).toEqual(plain.value.entries)
		expect(outcome.value.dense).toBe(plain.value.dense)
		expect(outcome.value.dense).toBe(true)
		expect(Object.getOwnPropertySymbols(outcome.value.entries)).toEqual([])
	})

	it('refuses a canonical population that disowns its last index', () => {
		// The reported population is exactly the canonical indices then `length`,
		// so the direct copy answers it — and every index is still corroborated
		// against its own membership read rather than taken from the report. The
		// refusal is pinned to its exact message, so a refusal arriving from
		// another cause cannot stand in for this one.
		const disowning = new Proxy([1, 2], {
			getOwnPropertyDescriptor(target, property) {
				return property === '1' ? undefined : Reflect.getOwnPropertyDescriptor(target, property)
			},
		})

		expect(Reflect.ownKeys(disowning)).toEqual(['0', '1', 'length'])
		expect(Object.hasOwn(disowning, '1')).toBe(false)

		const outcome = readArrayEntries(disowning)
		expect(outcome.success).toBe(false)
		if (outcome.success) throw new Error('a disowned last index was accepted')
		const refusal = outcome.error
		if (!(refusal instanceof Error)) throw refusal
		expect(refusal.message).toBe('Array index views disagree')
	})

	it('refuses a canonical population that disowns its first index', () => {
		// The first index is pinned beside the last: a corroboration reaching only
		// one end of the population still refuses the other, and one end alone
		// would read as covered.
		const disowning = new Proxy([1, 2], {
			getOwnPropertyDescriptor(target, property) {
				return property === '0' ? undefined : Reflect.getOwnPropertyDescriptor(target, property)
			},
		})

		expect(Reflect.ownKeys(disowning)).toEqual(['0', '1', 'length'])
		expect(Object.hasOwn(disowning, '0')).toBe(false)

		const outcome = readArrayEntries(disowning)
		expect(outcome.success).toBe(false)
		if (outcome.success) throw new Error('a disowned first index was accepted')
		const refusal = outcome.error
		if (!(refusal instanceof Error)) throw refusal
		expect(refusal.message).toBe('Array index views disagree')
	})

	it('fails a non-native advertised length', () => {
		const hostile = new Proxy([], {
			get(target, property, receiver) {
				return property === 'length' ? -1 : Reflect.get(target, property, receiver)
			},
		})
		expect(readArrayEntries(hostile).success).toBe(false)
	})

	it('refuses equal-cardinality split membership', () => {
		const split = new Proxy([1, 2], {
			ownKeys() {
				return ['0', 'length']
			},
			getOwnPropertyDescriptor(target, property) {
				return property === '0' ? undefined : Reflect.getOwnPropertyDescriptor(target, property)
			},
		})

		expect(readArrayEntries(split).success).toBe(false)
	})

	it('refuses canonical indices outside the advertised length', () => {
		const shortened = new Proxy([1, 2], {
			get(target, property, receiver) {
				return property === 'length' ? 1 : Reflect.get(target, property, receiver)
			},
		})

		expect(readArrayEntries(shortened).success).toBe(false)
	})

	it('accepts an unreflected descriptor-only in-range index as a hole', () => {
		const descriptorOnly = new Proxy([1], {
			ownKeys() {
				return ['length']
			},
		})
		const outcome = readArrayEntries(descriptorOnly)

		expect(outcome.success).toBe(true)
		if (!outcome.success) throw outcome.error
		expect(outcome.value.dense).toBe(false)
		expect(outcome.value.entries.length).toBe(1)
		expect(outcome.value.entries[0]).toBeUndefined()
		expect(Object.hasOwn(outcome.value.entries, 0)).toBe(false)
	})

	it('does not treat 4294967295 as an array index', () => {
		const value: number[] = []
		Object.defineProperty(value, '4294967295', { value: 'metadata', enumerable: true })
		const snapshot = readArrayEntries(value)

		expect(snapshot).toEqual({ success: true, value: { entries: [], dense: true } })
	})

	it('preserves the exact reason from hostile reflection', () => {
		const reason = Object.freeze({ operation: 'keys' })
		const hostile = new Proxy([], {
			ownKeys() {
				throw reason
			},
		})
		const outcome = readArrayEntries(hostile)

		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBe(reason)
	})

	it('preserves exact reasons from reflected membership and value reads', () => {
		const membershipReason = Object.freeze({ operation: 'membership' })
		const hostileMembership = new Proxy([], {
			get(target, property, receiver) {
				return property === 'length' ? 1 : Reflect.get(target, property, receiver)
			},
			getOwnPropertyDescriptor(target, property) {
				if (property === '0') throw membershipReason
				return Reflect.getOwnPropertyDescriptor(target, property)
			},
			ownKeys() {
				return ['0', 'length']
			},
		})
		const membership = readArrayEntries(hostileMembership)
		expect(membership.success).toBe(false)
		expect(!membership.success && membership.error).toBe(membershipReason)

		const valueReason = Object.freeze({ operation: 'value' })
		const hostileValue = new Proxy([1], {
			get(target, property, receiver) {
				if (property === '0') throw valueReason
				return Reflect.get(target, property, receiver)
			},
		})
		const value = readArrayEntries(hostileValue)
		expect(value.success).toBe(false)
		expect(!value.success && value.error).toBe(valueReason)
	})
})

describe('readGuardShape', () => {
	it('snapshots required, listed-optional, and all-optional modes', () => {
		const required = readGuardShape({ id: isString }, undefined, 'recordOf')
		expect(required.names).toEqual(['id'])
		expect(required.guards.id).toBe(isString)
		expect(matchesMember(required.optional, 'id')).toBe(false)
		expect(matchesMember(required.vocabulary, 'id')).toBe(true)

		const listed = readGuardShape({ id: isString, note: isString }, ['note'], 'objectOf')
		expect(listed.names).toEqual(['id', 'note'])
		expect(matchesMember(listed.optional, 'id')).toBe(false)
		expect(matchesMember(listed.optional, 'note')).toBe(true)

		const partial = readGuardShape({ id: isString, note: isString }, true, 'objectOf')
		expect(matchesMember(partial.optional, 'id')).toBe(true)
		expect(matchesMember(partial.optional, 'note')).toBe(true)
	})

	it('refuses unreadable shape and optional-key inputs under the supplied reader', () => {
		const shape = captureContractError(() =>
			Reflect.apply(readGuardShape, undefined, [createRevokedProxy(), undefined, 'objectOf']),
		)
		expect(shape.code).toBe('structure')
		expect(shape.message).toBe('objectOf: shape could not be read')

		const optional = captureContractError(() =>
			readGuardShape({ id: isString }, createRevokedArrayProxy<'id'>(), 'recordOf'),
		)
		expect(optional.code).toBe('structure')
		expect(optional.message).toBe('recordOf: optional could not be read')
	})
})

describe('holds', () => {
	it('returns false when the callback throws', () => {
		expect(
			holds(() => {
				throw new Error('boom')
			}),
		).toBe(false)
	})

	it('returns true when the callback returns true', () => {
		expect(holds(() => true)).toBe(true)
	})

	it('returns false when the callback returns false', () => {
		expect(holds(() => false)).toBe(false)
	})

	it('returns false when the callback returns a truthy non-boolean at runtime', () => {
		const callback = new Proxy(() => true, { apply: String })
		expect(holds(callback)).toBe(false)
	})
})

describe('matchesRecordBrand', () => {
	it('accepts every plain-record population, including a genuine foreign realm', () => {
		// The whole acceptance population, enumerated rather than sampled, so a
		// later tightening of the brand has to prove it did not narrow this set.
		const population: ReadonlyArray<readonly [string, unknown]> = [
			['object literal', {}],
			['populated literal', { a: 1 }],
			['null prototype', Object.create(null)],
			['assigned null prototype', Object.assign(Object.create(null), { a: 1 })],
			['frozen literal', Object.freeze({ a: 1 })],
			['JSON.parse', JSON.parse('{"a":1}')],
			['Object.fromEntries', Object.fromEntries([['a', 1]])],
			['structuredClone', structuredClone({ a: 1 })],
			['explicit Object.prototype', Object.create(Object.prototype)],
			['proxy over a literal', new Proxy({ a: 1 }, {})],
			['foreign realm record', createForeignRecord()],
			['foreign realm prototype', Object.create(createForeignPrototype())],
		]

		expect(
			population.filter((entry) => !matchesRecordBrand(entry[1])).map((entry) => entry[0]),
		).toEqual([])
	})

	it('refuses class instances whether or not the class prototype is reparented to null', () => {
		expect(matchesRecordBrand(new StringDeclaration())).toBe(false)
		expect(matchesRecordBrand(new NullBaseDeclaration())).toBe(false)
	})

	it('refuses a prototype that carries none of the realm object-prototype members', () => {
		// A two-link brand test cannot tell this apart from a reparented class
		// prototype; the mandated-member rule can, and refuses both. It is worth
		// stating precisely, because the earlier ruling that the two constructs
		// are STRUCTURALLY IDENTICAL is false — a class prototype always owns
		// `constructor` and this intermediate owns nothing:
		expect(Reflect.ownKeys(Object.create(null))).toEqual([])
		expect(Reflect.ownKeys(NullBaseDeclaration.prototype)).toEqual(['constructor'])
		// Refusing both is therefore a policy choice, not a structural necessity:
		// no realm produces this chain for a plain object, no consumer of it has
		// been named, and a caller can erase the difference in one line by
		// deleting `constructor`.
		expect(matchesRecordBrand(Object.create(Object.create(null)))).toBe(false)
	})

	it('rejects none of a genuine realm prototype twelve own members, and refuses a valueless stamp', () => {
		// What the function-value requirement costs a legitimate realm, measured
		// rather than argued: a prototype carrying all twelve own members of this
		// realm's `Object.prototype`, each exactly as the realm defines it, is
		// accepted — zero of the twelve is a reason for refusal.
		const members = Object.getOwnPropertyNames(Object.prototype)
		const faithful = Object.create(null)
		for (const member of members) {
			const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, member)
			if (descriptor === undefined) continue
			Object.defineProperty(faithful, member, descriptor)
		}

		expect(members).toHaveLength(12)
		expect(matchesRecordBrand(Object.create(faithful))).toBe(true)
		// The one own member that is NOT a function-valued data property is
		// `__proto__`, an accessor — and the rule does not consult it, which is why
		// the requirement costs the realm nothing.
		expect(typeof Object.getOwnPropertyDescriptor(Object.prototype, '__proto__')?.get).toBe(
			'function',
		)
		expect(RECORD_BRAND_MEMBERS).not.toContain('__proto__')
		// And the requirement is not inert: the cheapest forgery, which satisfies
		// membership with no values at all, is refused.
		expect(matchesRecordBrand(new BlankBrandDeclaration())).toBe(false)
	})

	it('accepts a function-valued forgery, which is the residual the rule cannot close', () => {
		// The residual, stated as what it IS rather than as "nothing observable
		// distinguishes a forgery". Something observable does: a valueless stamp.
		// What survives is the FUNCTION-VALUED forgery, and this realm hands the
		// forger the seven functions to stamp.
		const forged = new ForgedBrandDeclaration()
		const stripped = new StrippedBrandDeclaration()
		const proxied = createProxiedBrandDeclaration()

		expect([forged, stripped, proxied].map((value) => matchesRecordBrand(value))).toEqual([
			true,
			true,
			true,
		])
		expect(
			RECORD_BRAND_MEMBERS.map((member) => typeof Reflect.get(Object.prototype, member)),
		).toEqual(['function', 'function', 'function', 'function', 'function', 'function', 'function'])
		// Each forged prototype carries a genuine function for every mandated
		// member — this realm's own value where one was stamped, and the class's
		// own `constructor` where the prototype already had one, which is exactly
		// what a realm's `constructor` is. Nothing about the values is left to
		// compare against a real realm.
		expect(
			RECORD_BRAND_MEMBERS.map((member) => {
				const descriptor = Object.getOwnPropertyDescriptor(ForgedBrandDeclaration.prototype, member)
				if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) return 'absent'
				if (typeof descriptor.value !== 'function') return 'not a function'
				return descriptor.value === Reflect.get(Object.prototype, member) ? 'realm' : 'own'
			}),
		).toEqual(['own', 'realm', 'realm', 'realm', 'realm', 'realm', 'realm'])
		// The pass is not academic: each value is a class instance whose behavior
		// is still reachable on it.
		expect(
			[forged.escape(), stripped.escape(), Reflect.get(proxied, 'escape')].map(
				(member) => typeof member,
			),
		).toEqual(['string', 'string', 'function'])
		// And a further own-key SUBSET rule buys cost, not separation: it refuses
		// the forgery that left a method on its prototype and accepts the one that
		// moved the same method onto the instance, whose prototype owns exactly the
		// mandated set and nothing else.
		expect(Reflect.ownKeys(ForgedBrandDeclaration.prototype)).toContain('escape')
		expect(Reflect.ownKeys(StrippedBrandDeclaration.prototype).sort()).toEqual(
			[...RECORD_BRAND_MEMBERS].sort(),
		)
		expect(Object.hasOwn(stripped, 'escape')).toBe(true)
	})

	it('separates the forgery corpus from controls drawn outside its membership rule', () => {
		// The corpus's membership rule is "a prototype MADE to answer the seven
		// mandated names", by stamping or by trapping. Controls drawn from inside
		// it can only prove the brand discriminates among forgeries. These two are
		// outside it and decide opposite verdicts: a record from a genuine foreign
		// realm answers the same seven names because its realm put them there, and
		// must be ACCEPTED; a null-based chain answers none of them and was never
		// forged at all, and must be REFUSED.
		expect(matchesRecordBrand(Object.create(createForeignPrototype()))).toBe(true)
		expect(matchesRecordBrand(createForeignRecord())).toBe(true)
		expect(matchesRecordBrand(Object.create(Object.create(null)))).toBe(false)
	})

	it('refuses arrays, exotics, and non-objects', () => {
		expect(matchesRecordBrand([])).toBe(false)
		expect(matchesRecordBrand(new Date())).toBe(false)
		expect(matchesRecordBrand(new Map())).toBe(false)
		expect(matchesRecordBrand(null)).toBe(false)
		expect(matchesRecordBrand(undefined)).toBe(false)
		expect(matchesRecordBrand('record')).toBe(false)
	})

	it('raises the exact hostile prototype observation that isRecord contains as false', () => {
		const reason = Object.freeze({ stage: 'prototype' })
		const hostile = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw reason
				},
			},
		)

		expect(attempt(() => matchesRecordBrand(hostile))).toEqual({ success: false, error: reason })
		expect(isRecord(hostile)).toBe(false)
	})
})

describe('enumerableKeys', () => {
	it('returns a frozen owned snapshot of only own enumerable string keys', () => {
		const symbol = Symbol('symbol')
		const value = Object.create({ inherited: true })
		Object.defineProperty(value, 'hidden', { value: true, enumerable: false })
		Object.defineProperty(value, symbol, { value: true, enumerable: true })
		value.visible = true
		const keys = enumerableKeys(value)

		expect(keys).toEqual(['visible'])
		expect(Object.isFrozen(keys)).toBe(true)
	})

	it('returns undefined for hostile property enumeration', () => {
		expect(enumerableKeys(createRevokedProxy())).toBeUndefined()
	})
})

describe('readOptions', () => {
	it('returns an owned snapshot after probing every consumed key', () => {
		const source = { min: 1, max: 4 }
		const snapshot = readOptions(source, ['min', 'max'], 'stringShape', 'string')
		source.min = 2

		expect(snapshot).toEqual({ min: 1, max: 4 })
	})

	it('reads a consumed enumerable accessor once and snapshots that same value', () => {
		let reads = 0
		const source = {
			get min() {
				reads += 1
				return reads
			},
		}
		const snapshot = readOptions(source, ['min'], 'stringShape', 'string')

		expect(reads).toBe(1)
		expect(snapshot).toEqual({ min: 1 })
	})

	it('carries a consumed non-enumerable property into the snapshot', () => {
		const source: { readonly min?: number } = {}
		Object.defineProperty(source, 'min', { value: 1, enumerable: false })
		const snapshot = readOptions(source, ['min'], 'stringShape', 'string')

		expect(Reflect.get(source, 'min')).toBe(1)
		expect(snapshot).toEqual({ min: 1 })
		expect(Object.keys(snapshot ?? {})).toEqual(['min'])
	})

	it('carries a consumed inherited property into the snapshot', () => {
		// The options container must still be a plain record, so the inherited
		// option lives on a genuine foreign realm's own `Object.prototype` rather
		// than on an intermediate object no realm ever produces.
		const prototype = createForeignPrototype()
		Object.defineProperty(prototype, 'min', { value: 1, configurable: true })
		const source: { readonly min?: number } = Object.create(prototype)
		const snapshot = readOptions(source, ['min'], 'stringShape', 'string')

		expect(Reflect.get(source, 'min')).toBe(1)
		expect(snapshot).toEqual({ min: 1 })
		expect(Object.hasOwn(snapshot ?? {}, 'min')).toBe(true)
	})

	it('omits consumed undefined values and unrelated properties', () => {
		const snapshot = readOptions({ min: undefined, unrelated: 4 }, ['min'], 'stringShape', 'string')

		expect(snapshot).toEqual({})
		expect(Object.hasOwn(snapshot ?? {}, 'min')).toBe(false)
		expect(Object.hasOwn(snapshot ?? {}, 'unrelated')).toBe(false)
	})

	it('rejects arrays and class instances as non-record options', () => {
		class Options {
			readonly min = 1
		}
		for (const source of [[1], new Options()]) {
			const error = captureContractError(() =>
				Reflect.apply(readOptions<{ readonly min?: number }>, undefined, [
					source,
					['min'],
					'stringShape',
					'string',
				]),
			)
			expect(error.code).toBe('structure')
			expect(error.message).toBe('stringShape: options must be a plain record')
		}
	})

	it('rejects a primitive before reflection with the precise plain-record message', () => {
		const error = captureContractError(() =>
			Reflect.apply(readOptions<{ readonly min?: number }>, undefined, [
				null,
				['min'],
				'stringShape',
				'string',
			]),
		)

		expect(error.code).toBe('structure')
		expect(error.message).toBe('stringShape: options must be a plain record')
		expect(error.cause).toBeUndefined()
	})

	it('rejects a key-hiding hostile host with the uniform unreadable-options message', () => {
		const source: { readonly min?: number; readonly max?: number } = new Proxy(
			{},
			{
				get(_target, key) {
					if (key === 'min') throw new Error('hostile min')
					return undefined
				},
			},
		)
		const error = captureContractError(() =>
			readOptions(source, ['min', 'max'], 'stringShape', 'string'),
		)

		expect(error.code).toBe('structure')
		expect(error.message).toBe('stringShape: options could not be read')
		expect(error.cause).toBeInstanceOf(Error)
	})
})

describe('sanitizeDepth', () => {
	it('caps a valid but oversized budget at the limit', () => {
		expect(sanitizeDepth(1e9)).toBe(INFER_DEPTH_LIMIT)
		expect(sanitizeDepth(INFER_DEPTH_LIMIT + 1)).toBe(INFER_DEPTH_LIMIT)
		expect(sanitizeDepth(Number.MAX_SAFE_INTEGER)).toBe(INFER_DEPTH_LIMIT)
	})

	it('passes a budget at or below the limit through unchanged', () => {
		// The control: without this the helper could return the constant for every
		// input and still satisfy the cap above, which would make `limits.depth` inert
		// rather than narrowing.
		for (const value of [0, 1, 4, INFER_DEPTH_LIMIT - 1, INFER_DEPTH_LIMIT]) {
			expect(sanitizeDepth(value)).toBe(value)
		}
	})

	it('falls back to the limit for a budget that is not a finite non-negative integer', () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -1, 2.5, undefined]) {
			expect(sanitizeDepth(value)).toBe(INFER_DEPTH_LIMIT)
		}
	})

	it('leaves sanitizeBudget free to pass an oversized budget through', () => {
		// The two are deliberately different: sanitizeBudget decides shape and must
		// never read a hostile fallback, so the ceiling lives here instead.
		expect(sanitizeBudget(1e9, INFER_DEPTH_LIMIT)).toBe(1e9)
	})
})

describe('sanitizeBudget', () => {
	it('refuses an invalid selected numeric fallback with exact bound diagnostics', () => {
		const invalid: ReadonlyArray<readonly [number, string]> = [
			[Number.NaN, 'NaN'],
			[Number.POSITIVE_INFINITY, 'Infinity'],
			[Number.NEGATIVE_INFINITY, '-Infinity'],
			[-1, '-1'],
			[1.5, '1.5'],
		]

		for (const [fallback, received] of invalid) {
			const error = captureContractError(() => sanitizeBudget(undefined, fallback))

			expect(error.message).toBe('sanitizeBudget: fallback must be a finite non-negative integer')
			expect(error.code).toBe('bound')
			expect(error.context).toEqual({ limit: 'finite non-negative integer', received })
			expect(error.cause).toBeUndefined()
		}
	})

	it('refuses wrong-runtime fallbacks through the same safe diagnostic', () => {
		const invalid: ReadonlyArray<readonly [unknown, string]> = [
			[undefined, 'undefined'],
			[null, 'null'],
			['3', '"3"'],
			[{}, 'object'],
			[[], 'array'],
			[() => 3, 'function'],
		]

		for (const [fallback, received] of invalid) {
			const error = captureContractError(() =>
				Reflect.apply(sanitizeBudget, undefined, [undefined, fallback]),
			)

			expect(error.message).toBe('sanitizeBudget: fallback must be a finite non-negative integer')
			expect(error.code).toBe('bound')
			expect(error.context).toEqual({ limit: 'finite non-negative integer', received })
			expect(error.cause).toBeUndefined()
		}
	})

	it('previews hostile selected fallbacks without coercion or traversal', () => {
		let coercions = 0
		const hostile = Object.freeze({
			[Symbol.toPrimitive]() {
				coercions += 1
				throw new Error('primitive coercion')
			},
		})
		const objectError = captureContractError(() =>
			Reflect.apply(sanitizeBudget, undefined, [undefined, hostile]),
		)
		const proxyError = captureContractError(() =>
			Reflect.apply(sanitizeBudget, undefined, [undefined, createRevokedProxy()]),
		)

		expect(objectError.context?.received).toBe('object')
		expect(proxyError.context?.received).toBe('object')
		expect(coercions).toBe(0)
	})

	it('returns a valid candidate without inspecting an invalid fallback', () => {
		const hostile = createRevokedProxy()

		expect(Reflect.apply(sanitizeBudget, undefined, [4, hostile])).toBe(4)
		expect(sanitizeBudget(0, Number.NaN)).toBe(0)
		expect(Object.is(sanitizeBudget(-0, Number.POSITIVE_INFINITY), -0)).toBe(true)
	})

	it('returns the selected valid fallback unchanged', () => {
		for (const fallback of [0, -0, 32, 256, 2 ** 53]) {
			const sanitized = sanitizeBudget(undefined, fallback)

			expect(Object.is(sanitized, fallback)).toBe(true)
		}
		expect(Reflect.apply(sanitizeBudget, undefined, ['invalid', 32])).toBe(32)
	})
})

describe('drawRandom', () => {
	it('returns finite samples inside the random-source range', () => {
		expect(drawRandom(() => 0, 'number')).toBe(0)
		expect(drawRandom(() => 0.999, 'number')).toBe(0.999)
	})

	it('throws a random ContractError with drawRandom diagnostics for invalid or throwing sources', () => {
		const invalid = captureContractError(() => drawRandom(() => 1, 'union'))
		const throwing = captureContractError(() =>
			drawRandom(() => {
				throw new Error('source')
			}, 'union'),
		)

		expect(invalid.code).toBe('random')
		expect(invalid.message).toContain('drawRandom:')
		expect(throwing.code).toBe('random')
		expect(throwing.message).toContain('drawRandom:')
	})

	it('preserves an exact non-Error thrown value as the random failure cause', () => {
		const reason = Symbol('random source')
		const error = captureContractError(() =>
			drawRandom(() => {
				throw reason
			}, 'union'),
		)

		expect(error.cause).toBe(reason)
	})

	it('reports a hostile invalid sample without inspecting or coercing it', () => {
		const accesses: PropertyKey[] = []
		const sample = new Proxy(
			{},
			{
				get(target, property, receiver) {
					if (
						property === Symbol.toPrimitive ||
						property === 'valueOf' ||
						property === 'toString'
					) {
						accesses.push(property)
						throw new Error('sample coercion')
					}
					return Reflect.get(target, property, receiver)
				},
			},
		)
		const error = captureContractError(() =>
			Reflect.apply(drawRandom, undefined, [() => sample, 'number']),
		)

		expect(error.message).toBe('drawRandom: the random source must return a value in [0, 1)')
		expect(error.code).toBe('random')
		expect(error.context).toEqual({
			shape: 'number',
			limit: '[0, 1)',
			received: 'object',
		})
		expect(accesses).toEqual([])
	})

	it('reports a primitive symbol without calling its mutable prototype method', () => {
		const calls: string[] = []
		const error = replaceIntrinsic(
			Symbol.prototype,
			'toString',
			() => {
				calls.push('toString')
				throw new Error('symbol formatting')
			},
			() =>
				captureContractError(() =>
					Reflect.apply(drawRandom, undefined, [() => Symbol('sample'), 'number']),
				),
		)

		expect(error.message).toBe('drawRandom: the random source must return a value in [0, 1)')
		expect(error.code).toBe('random')
		expect(error.context).toEqual({
			shape: 'number',
			limit: '[0, 1)',
			received: 'Symbol(sample)',
		})
		expect(Object.hasOwn(error, 'cause')).toBe(false)
		expect(calls).toEqual([])
	})

	it('shares one well-formed astral-boundary symbol preview with the random diagnostic', () => {
		const sample = Symbol(`x${'x'.repeat(55)}${String.fromCodePoint(0x1f600)}`)
		const received = `Symbol(${'x'.repeat(56)}…`

		expect(preview(sample)).toBe(received)
		expect(preview(sample).isWellFormed()).toBe(true)
		const error = captureContractError(() =>
			Reflect.apply(drawRandom, undefined, [() => sample, 'number']),
		)

		expect(error.message).toBe('drawRandom: the random source must return a value in [0, 1)')
		expect(error.code).toBe('random')
		expect(error.context).toEqual({ shape: 'number', limit: '[0, 1)', received })
		expect(received).toHaveLength(64)
		expect(Object.hasOwn(error, 'cause')).toBe(false)
	})

	it('shares one complete escape-boundary preview with the random diagnostic', () => {
		const sample = Symbol(`${'x'.repeat(56)}\\tail`)
		const received = `Symbol(${'x'.repeat(56)}…`

		expect(preview(sample)).toBe(received)
		const error = captureContractError(() =>
			Reflect.apply(drawRandom, undefined, [() => sample, 'number']),
		)

		expect(error.message).toBe('drawRandom: the random source must return a value in [0, 1)')
		expect(error.code).toBe('random')
		expect(error.context).toEqual({ shape: 'number', limit: '[0, 1)', received })
		expect(Object.hasOwn(error, 'cause')).toBe(false)
	})

	it('does not retrieve the mutable primitive-string iterator for diagnostics', () => {
		const calls: string[] = []
		const sample = Symbol('sample')
		const result = replaceStringIterator(
			() => {
				calls.push('iterator')
				throw Object.freeze({ source: 'string iterator' })
			},
			() => ({
				string: preview('safe'),
				symbol: preview(sample),
				error: captureContractError(() =>
					Reflect.apply(drawRandom, undefined, [() => sample, 'number']),
				),
			}),
		)

		expect(result.string).toBe('"safe"')
		expect(result.symbol).toBe('Symbol(sample)')
		expect(result.error.code).toBe('random')
		expect(result.error.context?.received).toBe('Symbol(sample)')
		expect(calls).toEqual([])
	})
})

describe('resolveField', () => {
	it('resolves a single key, including a dotted key treated as one segment', () => {
		expect(resolveField({ a: 1 }, 'a')).toBe(1)
		expect(resolveField({ 'a.b': 1 }, 'a.b')).toBe(1)
	})

	it('resolves a nested path left-to-right', () => {
		expect(resolveField({ user: { name: 'Ada' } }, ['user', 'name'])).toBe('Ada')
	})

	it('returns undefined for an off-path key', () => {
		expect(resolveField({ a: 1 }, ['a', 'b'])).toBeUndefined()
		expect(resolveField({}, 'missing')).toBeUndefined()
	})

	it('returns undefined when an intermediate segment is not an object', () => {
		expect(resolveField({ a: 1 }, ['a', 'b'])).toBeUndefined()
		expect(resolveField({ a: null }, ['a', 'b'])).toBeUndefined()
		expect(resolveField({ a: 'x' }, ['a', 'b'])).toBeUndefined()
	})

	it('requires a record root and reads only own properties at every segment', () => {
		const inherited = Object.create({ role: 'admin' })
		const nested = { defaults: Object.create({ role: 'admin' }) }

		expect(isRecord(inherited)).toBe(false)
		expect(resolveField(inherited, 'role')).toBeUndefined()
		expect(resolveField(nested, ['defaults', 'role'])).toBeUndefined()
	})

	it('returns undefined against a hostile getter without throwing', () => {
		const hostile = createThrowingGetter()
		expect(() => resolveField(hostile, 'value')).not.toThrow()
		expect(resolveField(hostile, 'value')).toBeUndefined()
	})

	it('returns undefined against a hostile getter mid-path without throwing', () => {
		const hostile = { user: createThrowingGetter() }
		expect(() => resolveField(hostile, ['user', 'value'])).not.toThrow()
		expect(resolveField(hostile, ['user', 'value'])).toBeUndefined()
	})
})

describe('matchesJSONValue', () => {
	it('refuses a failed direct traversal through the shared coded boundary', () => {
		const hostile = createThrowingGetter()
		const error = captureContractError(() => matchesJSONValue(hostile, new WeakSet()))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('matchesJSONValue: value could not be read')
	})

	it('refuses a non-native advertised array length', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, property, receiver) {
				return property === 'length' ? -1 : Reflect.get(target, property, receiver)
			},
		})
		const error = captureContractError(() => matchesJSONValue(hostile, new WeakSet()))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('matchesJSONValue: value could not be read')
	})

	it('accepts JSON leaves and nested structures', () => {
		expect(matchesJSONValue(null, new WeakSet())).toBe(true)
		expect(matchesJSONValue('value', new WeakSet())).toBe(true)
		expect(matchesJSONValue(false, new WeakSet())).toBe(true)
		expect(matchesJSONValue(0, new WeakSet())).toBe(true)
		expect(
			matchesJSONValue(
				{
					array: [1, 'two', null, { nested: true }],
					record: { empty: {} },
				},
				new WeakSet(),
			),
		).toBe(true)
	})

	it('rejects non-finite numbers and non-JSON leaves', () => {
		expect(matchesJSONValue(Number.NaN, new WeakSet())).toBe(false)
		expect(matchesJSONValue(Number.POSITIVE_INFINITY, new WeakSet())).toBe(false)
		expect(matchesJSONValue(Number.NEGATIVE_INFINITY, new WeakSet())).toBe(false)
		expect(matchesJSONValue(() => 1, new WeakSet())).toBe(false)
		expect(matchesJSONValue(Symbol('value'), new WeakSet())).toBe(false)
		expect(matchesJSONValue(undefined, new WeakSet())).toBe(false)
	})

	it('rejects direct and nested cycles', () => {
		const direct: unknown[] = []
		direct.push(direct)
		expect(matchesJSONValue(direct, new WeakSet())).toBe(false)

		const nested: { child?: unknown } = {}
		nested.child = { parent: nested }
		expect(matchesJSONValue(nested, new WeakSet())).toBe(false)
	})

	it('rejects sparse arrays', () => {
		expect(matchesJSONValue(buildSparseArray(), new WeakSet())).toBe(false)
	})
})

describe('matchesJSONDepth', () => {
	it('counts only array and plain-record containers at the fixed boundary', () => {
		let emptyAtLimit: unknown = {}
		for (let depth = 1; depth < GUARD_DEPTH_LIMIT; depth += 1) {
			emptyAtLimit = { value: emptyAtLimit }
		}
		const emptyPastLimit = { value: emptyAtLimit }

		expect(matchesJSONDepth(null)).toBe(true)
		expect(matchesJSONDepth('leaf')).toBe(true)
		expect(matchesJSONDepth(() => 'leaf')).toBe(true)
		expect(matchesJSONDepth([])).toBe(true)
		expect(matchesJSONDepth({})).toBe(true)
		expect(matchesJSONDepth(emptyAtLimit)).toBe(true)
		expect(matchesJSONDepth(emptyPastLimit)).toBe(false)
		expect(matchesJSONDepth(buildDeepNest(GUARD_DEPTH_LIMIT))).toBe(true)
		expect(matchesJSONDepth(buildDeepNest(GUARD_DEPTH_LIMIT + 1))).toBe(false)
	})

	it('revisits shared aliases on shallow and deep paths in both visitation orders', () => {
		const shared = Object.freeze({})
		let allowed: unknown = shared
		let refused: unknown = shared
		for (let depth = 0; depth < GUARD_DEPTH_LIMIT - 2; depth += 1) {
			allowed = { value: allowed }
			refused = { value: refused }
		}
		refused = { value: refused }

		expect(matchesJSONDepth({ shallow: shared, deep: allowed })).toBe(true)
		expect(matchesJSONDepth({ deep: allowed, shallow: shared })).toBe(true)
		expect(matchesJSONDepth({ shallow: shared, deep: refused })).toBe(false)
		expect(matchesJSONDepth({ deep: refused, shallow: shared })).toBe(false)
	})

	it('does not count an active back-edge as another level', () => {
		const shallow: unknown[] = []
		shallow.push(shallow)
		expect(matchesJSONDepth(shallow)).toBe(true)

		const boundary: unknown[] = []
		let cursor = boundary
		for (let depth = 1; depth < GUARD_DEPTH_LIMIT; depth += 1) {
			const child: unknown[] = []
			cursor.push(child)
			cursor = child
		}
		cursor.push(boundary)

		expect(matchesJSONDepth(boundary)).toBe(true)
		expect(matchesJSONDepth(buildDeepNest(GUARD_DEPTH_LIMIT + 1))).toBe(false)
	})

	it('walks sparse arrays by reflected population without caller iteration', () => {
		const sparse = buildSparseArray()
		Object.defineProperty(sparse, Symbol.iterator, {
			get() {
				throw new Error('caller iterator')
			},
		})
		expect(matchesJSONDepth(sparse)).toBe(true)

		const maximum = createNativeMaximumSparseArray<unknown>()
		expect(matchesJSONDepth(maximum.value)).toBe(true)
		expect(maximum.probes).toEqual([])
	})

	it('refuses contradictory, impossible, and hostile array reads', () => {
		const contradictory = new Proxy([1], {
			ownKeys() {
				return ['0', 'length']
			},
			getOwnPropertyDescriptor(target, property) {
				return property === '0' ? undefined : Reflect.getOwnPropertyDescriptor(target, property)
			},
		})
		const impossible = new Proxy([], {
			get(target, property, receiver) {
				return property === 'length' ? -1 : Reflect.get(target, property, receiver)
			},
		})
		const hostile = new Proxy([], {
			ownKeys() {
				throw new Error('array keys')
			},
		})
		const hostileValue = new Proxy([1], {
			get(target, property, receiver) {
				if (property === '0') throw new Error('array value')
				return Reflect.get(target, property, receiver)
			},
		})

		for (const value of [
			contradictory,
			impossible,
			hostile,
			hostileValue,
			createRevokedArrayProxy(),
		]) {
			expect(() => matchesJSONDepth(value)).not.toThrow()
			expect(matchesJSONDepth(value)).toBe(false)
		}
	})

	it('reads plain-record keys once and contains hostile reflection', () => {
		let readableReads = 0
		const readable = Object.defineProperty({}, 'value', {
			get() {
				readableReads += 1
				return { nested: [] }
			},
			enumerable: true,
		})
		expect(matchesJSONDepth(readable)).toBe(true)
		expect(readableReads).toBe(1)

		let membershipReads = 0
		const hostileMembership = new Proxy(
			{ value: 1 },
			{
				getOwnPropertyDescriptor(target, property) {
					membershipReads += 1
					if (membershipReads > 1) throw new Error('record membership')
					return Reflect.getOwnPropertyDescriptor(target, property)
				},
			},
		)
		const hostileValue = new Proxy(
			{ value: 1 },
			{
				get(target, property, receiver) {
					if (property === 'value') throw new Error('record value')
					return Reflect.get(target, property, receiver)
				},
			},
		)

		for (const value of [
			createThrowingGetter(),
			new Proxy(
				{},
				{
					ownKeys() {
						throw new Error('record keys')
					},
				},
			),
			hostileMembership,
			hostileValue,
			createThrowingPrototype(new Error('record prototype')),
			createRevokedProxy(),
		]) {
			expect(() => matchesJSONDepth(value)).not.toThrow()
			expect(matchesJSONDepth(value)).toBe(false)
		}
	})

	it('treats readable exotics as leaves and ignores fields outside the serialized view', () => {
		expect(matchesJSONDepth(new Date())).toBe(true)
		expect(matchesJSONDepth(new Map([['deep', buildDeepNest(GUARD_DEPTH_LIMIT + 1)]]))).toBe(true)

		const prototype = Object.defineProperty({}, 'inherited', {
			get() {
				throw new Error('inherited field')
			},
		})
		const inherited = new Proxy(Object.create(prototype), {
			getPrototypeOf() {
				return Object.prototype
			},
		})
		const record = {}
		Object.defineProperty(record, 'hidden', {
			get() {
				throw new Error('hidden field')
			},
		})
		Object.defineProperty(record, Symbol('symbol'), {
			get() {
				throw new Error('symbol field')
			},
			enumerable: true,
		})
		const array: unknown[] = []
		Object.defineProperty(array, 'decoration', {
			get() {
				throw new Error('array decoration')
			},
			enumerable: true,
		})
		const named: Record<string, unknown> = Object.create(null)
		Object.defineProperty(named, '__proto__', { value: {}, enumerable: true })
		Object.defineProperty(named, 'constructor', { value: [], enumerable: true })

		expect(matchesJSONDepth(inherited)).toBe(true)
		expect(matchesJSONDepth(record)).toBe(true)
		expect(matchesJSONDepth(array)).toBe(true)
		expect(matchesJSONDepth(named)).toBe(true)
	})
})

describe('seededRandom', () => {
	it('rejects runtime non-numbers without inspecting or coercing them', () => {
		const accesses: PropertyKey[] = []
		const hostile = new Proxy(
			{},
			{
				get(target, property, receiver) {
					if (
						property === Symbol.toPrimitive ||
						property === 'valueOf' ||
						property === 'toString'
					) {
						accesses.push(property)
						throw new Error('seed coercion')
					}
					return Reflect.get(target, property, receiver)
				},
			},
		)
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()
		const values: readonly unknown[] = [
			undefined,
			null,
			false,
			'42',
			42n,
			Symbol('seed'),
			{},
			[],
			Object(42),
			() => 42,
			hostile,
			revoked.proxy,
		]

		for (const value of values) {
			const error = captureContractError(() => Reflect.apply(seededRandom, undefined, [value]))

			expect(error.message).toBe('seededRandom: seed must be a number')
			expect(error.code).toBe('random')
			expect(error.context).toEqual({
				limit: 'number',
				received: preview(value),
			})
		}
		expect(accesses).toEqual([])
	})

	it('pins the seed 42 sequence and preserves numeric ToUint32 normalization', () => {
		const random = seededRandom(42)
		expect([random(), random(), random()]).toEqual([
			0.6011037519201636, 0.44829055899754167, 0.8524657934904099,
		])

		for (const pair of [
			{ left: -1, right: 4_294_967_295 },
			{ left: 1.5, right: 1 },
			{ left: Number.NaN, right: 0 },
			{ left: Number.POSITIVE_INFINITY, right: 0 },
			{ left: Number.NEGATIVE_INFINITY, right: 0 },
			{ left: -0, right: 0 },
		]) {
			const left = seededRandom(pair.left)
			const right = seededRandom(pair.right)
			expect([left(), left(), left()]).toEqual([right(), right(), right()])
		}
	})

	it('reports a primitive symbol seed without calling its mutable prototype method', () => {
		const calls: string[] = []
		const error = replaceIntrinsic(
			Symbol.prototype,
			'toString',
			() => {
				calls.push('toString')
				throw new Error('symbol formatting')
			},
			() => captureContractError(() => Reflect.apply(seededRandom, undefined, [Symbol('seed')])),
		)

		expect(error.message).toBe('seededRandom: seed must be a number')
		expect(error.code).toBe('random')
		expect(error.context).toEqual({ limit: 'number', received: 'Symbol(seed)' })
		expect(Object.hasOwn(error, 'cause')).toBe(false)
		expect(calls).toEqual([])
	})

	it('is deterministic — the same seed yields the same sequence', () => {
		const a = seededRandom(42)
		const b = seededRandom(42)
		const first = [a(), a(), a()]
		const second = [b(), b(), b()]
		expect(first).toEqual(second)
	})

	it('produces different sequences for different seeds', () => {
		expect(seededRandom(1)()).not.toBe(seededRandom(2)())
	})

	it('returns values within the [0, 1) range', () => {
		const random = seededRandom(7)
		for (let index = 0; index < 100; index += 1) {
			const value = random()
			expect(value).toBeGreaterThanOrEqual(0)
			expect(value).toBeLessThan(1)
		}
	})
})

describe('enumerableSymbolCount', () => {
	it('counts only enumerable own symbols', () => {
		const visible = Symbol('visible')
		const hidden = Symbol('hidden')
		const value = { [visible]: 1 }
		Object.defineProperty(value, hidden, { value: 2, enumerable: false })

		expect(enumerableSymbolCount(value)).toBe(1)
		expect(enumerableSymbolCount({})).toBe(0)
		expect(enumerableSymbolCount({ stringKey: 1 })).toBe(0)
	})
})

describe('schemaToParameters', () => {
	it('passes a record schema through by reference (a compiled contract schema is always a record)', () => {
		// The production case: a compiled contract's `schema` is a plain object, so the guard passes
		// and the same reference comes back as the open tool-parameters record.
		const schema = createContract(objectShape({ name: stringShape() })).schema
		expect(schemaToParameters(schema)).toBe(schema)

		const literal: JSONSchema = { type: 'object', properties: { id: { type: 'string' } } }
		expect(schemaToParameters(literal)).toBe(literal)
	})

	it('returns undefined for a non-record schema (the defensive optionality fallback)', () => {
		// A class INSTANCE structurally satisfies the all-optional `JSONSchema` interface yet is NOT a
		// plain record (its prototype is the class, not `Object.prototype`), so the `isRecord` boundary
		// guard rejects it and the helper yields its `undefined` fallback — the narrowing
		// `.claude/rules/patterns.md` § Validation and contracts requires, in action.
		class FakeSchema {
			readonly type: JSONSchemaType = 'object'
		}
		const notRecord: JSONSchema = new FakeSchema()
		expect(schemaToParameters(notRecord)).toBeUndefined()
	})

	it('refuses an unreadable record schema with the shared coded read error', () => {
		const error = captureContractError(() => schemaToParameters(createThrowingGetter()))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('schemaToParameters: value could not be read')
	})
})

describe('schemaToObject', () => {
	it('passes an object-rooted schema through unchanged', () => {
		const schema: JSONSchema = {
			type: 'object',
			properties: { name: { type: 'string' } },
			required: ['name'],
			additionalProperties: false,
		}
		expect(schemaToObject(schema)).toBe(schema)
	})

	it('refuses an unreadable schema root with the shared coded read error', () => {
		const hostile = new Proxy<JSONSchema>(
			{},
			{
				get() {
					throw new Error('hostile read')
				},
			},
		)
		const error = captureContractError(() => schemaToObject(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('schemaToObject: schema could not be read')
	})

	it('refuses failed root enumeration before carrying the schema', () => {
		const hostile = new Proxy({ type: 'string' } satisfies JSONSchema, {
			ownKeys() {
				throw new Error('hostile keys')
			},
		})
		const error = captureContractError(() => schemaToObject(hostile))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('schemaToObject: schema could not be read')
	})

	it('wraps a string-rooted schema as a single required "value" property', () => {
		expect(schemaToObject({ type: 'string' })).toEqual({
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('wraps a number-rooted schema', () => {
		expect(schemaToObject({ type: 'number' })).toEqual({
			type: 'object',
			properties: { value: { type: 'number' } },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('wraps an array-rooted schema', () => {
		const schema: JSONSchema = { type: 'array', items: { type: 'string' } }
		expect(schemaToObject(schema)).toEqual({
			type: 'object',
			properties: { value: schema },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('wraps an anyOf/enum-only schema with no type', () => {
		const anyOf: JSONSchema = { anyOf: [{ type: 'string' }, { type: 'number' }] }
		expect(schemaToObject(anyOf)).toEqual({
			type: 'object',
			properties: { value: anyOf },
			required: ['value'],
			additionalProperties: false,
		})
		const literal: JSONSchema = { enum: ['a', 'b'] }
		expect(schemaToObject(literal)).toEqual({
			type: 'object',
			properties: { value: literal },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('wraps the empty schema {}', () => {
		expect(schemaToObject({})).toEqual({
			type: 'object',
			properties: { value: {} },
			required: ['value'],
			additionalProperties: false,
		})
	})

	it('is deterministic — same input yields byte-identical output', () => {
		const schema: JSONSchema = { type: 'string', format: 'uuid' }
		expect(JSON.stringify(schemaToObject(schema))).toBe(JSON.stringify(schemaToObject(schema)))
	})

	it('composes with schemaToParameters(schemaToObject(valueToSchema(...))) for a non-object payload', () => {
		const schema = valueToSchema('hello')
		const parameters = schemaToParameters(schemaToObject(schema))
		expect(parameters).toEqual({
			type: 'object',
			properties: { value: { type: 'string' } },
			required: ['value'],
			additionalProperties: false,
		})
	})
})

describe('preview', () => {
	it('does not retrieve a throwing mutable string-slice getter', () => {
		let getters = 0
		const reason = Object.freeze({ source: 'string slice' })
		const sample = Symbol('sample')
		const result = replaceStringSlice(
			() => {
				getters += 1
				throw reason
			},
			() => ({
				string: preview('safe'),
				symbol: preview(sample),
				error: captureContractError(() =>
					Reflect.apply(drawRandom, undefined, [() => sample, 'number']),
				),
			}),
		)

		expect(result.string).toBe('"safe"')
		expect(result.symbol).toBe('Symbol(sample)')
		expect(result.error.code).toBe('random')
		expect(result.error.context).toEqual({
			shape: 'number',
			limit: '[0, 1)',
			received: 'Symbol(sample)',
		})
		expect(Object.hasOwn(result.error, 'cause')).toBe(false)
		expect(getters).toBe(0)
	})

	it('does not retrieve or call a hostile mutable string-slice replacement', () => {
		let getters = 0
		let calls = 0
		const sample = Symbol('sample')
		const result = replaceStringSlice(
			() => {
				getters += 1
				return () => {
					calls += 1
					return '\n'
				}
			},
			() => ({
				string: preview('safe'),
				symbol: preview(sample),
				error: captureContractError(() =>
					Reflect.apply(drawRandom, undefined, [() => sample, 'number']),
				),
			}),
		)

		expect({
			string: result.string,
			symbol: result.symbol,
			code: result.error.code,
			context: result.error.context,
			cause: Object.hasOwn(result.error, 'cause'),
			getters,
			calls,
		}).toEqual({
			string: '"safe"',
			symbol: 'Symbol(sample)',
			code: 'random',
			context: { shape: 'number', limit: '[0, 1)', received: 'Symbol(sample)' },
			cause: false,
			getters: 0,
			calls: 0,
		})
	})

	it('proves the string-slice replacement is installed and restored', () => {
		const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'slice')
		if (descriptor === undefined) throw new Error('String.prototype slice descriptor is absent')
		const invocations = ['substituted']
		const callable = invocations.pop.bind(invocations)
		const retrievals = [callable]
		const replacement = retrievals.pop.bind(retrievals)
		const result = replaceStringSlice(replacement, () => {
			const installed = Object.getOwnPropertyDescriptor(String.prototype, 'slice')
			if (installed === undefined) {
				throw new Error('Installed String.prototype slice descriptor is absent')
			}
			const method = 'source'.slice
			const retrieval = {
				getters: 1 - retrievals.length,
				calls: 1 - invocations.length,
			}
			const output = Reflect.apply(method, 'source', [1, 4])
			return {
				installed,
				retrieval,
				output,
				final: { getters: 1 - retrievals.length, calls: 1 - invocations.length },
			}
		})

		expect(result.installed).toEqual({
			configurable: descriptor.configurable === true,
			enumerable: descriptor.enumerable === true,
			get: replacement,
			set: undefined,
		})
		expect(result.retrieval).toEqual({ getters: 1, calls: 0 })
		expect(result.output).toBe('substituted')
		expect(result.final).toEqual({ getters: 1, calls: 1 })
		expect(Object.getOwnPropertyDescriptor(String.prototype, 'slice')).toEqual(descriptor)

		const reason = Object.freeze({ source: 'throwing string slice' })
		const outcome = attempt(() =>
			replaceStringSlice(
				() => () => {
					throw reason
				},
				() => 'source'.slice(1, 4),
			),
		)

		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBe(reason)
		expect(Object.getOwnPropertyDescriptor(String.prototype, 'slice')).toEqual(descriptor)
	})

	it('proves the string-iterator replacement is installed and restored', () => {
		const descriptor = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)
		if (descriptor === undefined) {
			throw new Error('String.prototype iterator descriptor is absent')
		}
		const iterator = descriptor.value
		if (typeof iterator !== 'function') {
			throw new Error('String.prototype iterator descriptor is not callable')
		}
		const invocations = [Reflect.apply(iterator, 'substituted', [])]
		const callable = invocations.pop.bind(invocations)
		const retrievals = [callable]
		const replacement = retrievals.pop.bind(retrievals)
		const result = replaceStringIterator(replacement, () => {
			const installed = Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)
			if (installed === undefined) {
				throw new Error('Installed String.prototype iterator descriptor is absent')
			}
			const method = 'source'[Symbol.iterator]
			const retrieval = {
				getters: 1 - retrievals.length,
				calls: 1 - invocations.length,
			}
			const output = Array.from(Reflect.apply(method, 'source', []))
			return {
				installed,
				retrieval,
				output,
				final: { getters: 1 - retrievals.length, calls: 1 - invocations.length },
			}
		})

		expect(result.installed).toEqual({
			configurable: descriptor.configurable === true,
			enumerable: descriptor.enumerable === true,
			get: replacement,
			set: undefined,
		})
		expect(result.retrieval).toEqual({ getters: 1, calls: 0 })
		expect(result.output).toEqual(['s', 'u', 'b', 's', 't', 'i', 't', 'u', 't', 'e', 'd'])
		expect(result.final).toEqual({ getters: 1, calls: 1 })
		expect(Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)).toEqual(descriptor)

		const reason = Object.freeze({ source: 'throwing string iterator' })
		const outcome = attempt(() =>
			replaceStringIterator(
				() => () => {
					throw reason
				},
				() => [...'source'],
			),
		)

		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBe(reason)
		expect(Object.getOwnPropertyDescriptor(String.prototype, Symbol.iterator)).toEqual(descriptor)
	})

	it('restores the exact string-slice descriptor across returns and throws', () => {
		const descriptor = Object.getOwnPropertyDescriptor(String.prototype, 'slice')
		if (descriptor === undefined) throw new Error('String.prototype slice descriptor is absent')
		const returned = Object.freeze({ operation: 'return' })
		const result = replaceStringSlice(
			() => () => '\n',
			() => returned,
		)

		expect(result).toBe(returned)
		expect(Object.getOwnPropertyDescriptor(String.prototype, 'slice')).toEqual(descriptor)

		const reason = Object.freeze({ operation: 'throw' })
		const outcome = attempt(() =>
			replaceStringSlice(
				() => () => '\n',
				() => {
					throw reason
				},
			),
		)

		expect(outcome.success).toBe(false)
		expect(!outcome.success && outcome.error).toBe(reason)
		expect(Object.getOwnPropertyDescriptor(String.prototype, 'slice')).toEqual(descriptor)
	})

	it('renders a primitive symbol without calling its mutable prototype method', () => {
		const calls: string[] = []
		const descriptor = Object.getOwnPropertyDescriptor(Symbol.prototype, 'toString')
		if (descriptor === undefined) throw new Error('Symbol.prototype.toString descriptor is absent')
		const result = replaceIntrinsic(
			Symbol.prototype,
			'toString',
			() => {
				calls.push('toString')
				throw new Error('symbol formatting')
			},
			() => preview(Symbol('sample')),
		)

		expect(result).toBe('Symbol(sample)')
		expect(calls).toEqual([])
		expect(Object.getOwnPropertyDescriptor(Symbol.prototype, 'toString')).toEqual(descriptor)
		expect(Symbol('control').toString()).toBe('Symbol(control)')
	})

	it('restores the exact symbol descriptor and preserves an operation throw', () => {
		const descriptor = Object.getOwnPropertyDescriptor(Symbol.prototype, 'toString')
		if (descriptor === undefined) throw new Error('Symbol.prototype.toString descriptor is absent')
		const reason = Object.freeze({ operation: 'symbol formatting' })
		const outcome = attempt(() =>
			replaceIntrinsic(
				Symbol.prototype,
				'toString',
				() => 'replacement',
				() => {
					throw reason
				},
			),
		)

		expect(outcome).toEqual({ success: false, error: reason })
		expect(Object.getOwnPropertyDescriptor(Symbol.prototype, 'toString')).toEqual(descriptor)
		expect(Symbol('control').toString()).toBe('Symbol(control)')
	})

	it('escapes control, quote, and backslash content in a short primitive symbol', () => {
		const sample = Symbol('line\n\t\u0000"\\end')

		expect(preview(sample)).toBe('Symbol(line\\n\\t\\u0000\\"\\\\end)')
	})

	it.each([
		['backslash', '\\', '\\\\'],
		['quote', '"', '\\"'],
		['backspace', '\b', '\\b'],
		['form feed', '\f', '\\f'],
		['newline', '\n', '\\n'],
		['carriage return', '\r', '\\r'],
		['tab', '\t', '\\t'],
	])('keeps every %s token atomic at its short boundaries', (_label, character, token) => {
		for (let remaining = 0; remaining <= token.length; remaining += 1) {
			const stringPrefix = `"${'x'.repeat(63 - remaining)}`
			const symbolPrefix = `Symbol(${'x'.repeat(57 - remaining)}`
			const suffix = remaining < token.length ? '…' : `${token}…`

			expect(preview(`${'x'.repeat(63 - remaining)}${character}tail`)).toBe(
				`${stringPrefix}${suffix}`,
			)
			expect(preview(Symbol(`${'x'.repeat(57 - remaining)}${character}tail`))).toBe(
				`${symbolPrefix}${suffix}`,
			)
		}
	})

	it.each([
		['null', '\u0000', '\\u0000'],
		['control', '\u0001', '\\u0001'],
		['high surrogate', '\ud800', '\\ud800'],
		['low surrogate', '\udc00', '\\udc00'],
	])('keeps every %s token atomic at all unicode boundaries', (_label, character, token) => {
		for (let remaining = 0; remaining <= token.length; remaining += 1) {
			const stringPrefix = `"${'x'.repeat(63 - remaining)}`
			const symbolPrefix = `Symbol(${'x'.repeat(57 - remaining)}`
			const suffix = remaining < token.length ? '…' : `${token}…`

			expect(preview(`${'x'.repeat(63 - remaining)}${character}tail`)).toBe(
				`${stringPrefix}${suffix}`,
			)
			expect(preview(Symbol(`${'x'.repeat(57 - remaining)}${character}tail`))).toBe(
				`${symbolPrefix}${suffix}`,
			)
		}
	})

	it.each([
		[
			'omitted',
			`${'x'.repeat(62)}${String.fromCodePoint(0x1f600)}`,
			`"${'x'.repeat(62)}…`,
			Symbol(`${'x'.repeat(56)}${String.fromCodePoint(0x1f600)}`),
			`Symbol(${'x'.repeat(56)}…`,
		],
		[
			'exact-fit',
			`${'x'.repeat(61)}${String.fromCodePoint(0x1f600)}`,
			`"${'x'.repeat(61)}${String.fromCodePoint(0x1f600)}…`,
			Symbol(`${'x'.repeat(55)}${String.fromCodePoint(0x1f600)}`),
			`Symbol(${'x'.repeat(55)}${String.fromCodePoint(0x1f600)}…`,
		],
		[
			'one-under',
			`${'x'.repeat(60)}${String.fromCodePoint(0x1f600)}`,
			`"${'x'.repeat(60)}${String.fromCodePoint(0x1f600)}"`,
			Symbol(`${'x'.repeat(54)}${String.fromCodePoint(0x1f600)}`),
			`Symbol(${'x'.repeat(54)}${String.fromCodePoint(0x1f600)})`,
		],
	])(
		'keeps adjacent astral pairs whole at the %s boundary',
		(_label, string, stringPreview, symbol, symbolPreview) => {
			const stringResult = preview(string)
			const symbolResult = preview(symbol)

			expect(stringResult).toBe(stringPreview)
			expect(symbolResult).toBe(symbolPreview)
			expect(stringResult.isWellFormed()).toBe(true)
			expect(symbolResult.isWellFormed()).toBe(true)
		},
	)

	it('renders primitives as literals and escapes/clips strings', () => {
		expect(preview(null)).toBe('null')
		expect(preview(undefined)).toBe('undefined')
		expect(preview(42)).toBe('42')
		expect(preview(true)).toBe('true')
		expect(preview(10n)).toBe('10n')
		expect(preview('hi')).toBe('"hi"')
		const giant = preview('x'.repeat(200))
		expect(giant.endsWith('…')).toBe(true)
		expect(giant.length).toBeLessThanOrEqual(65)
	})

	it('bounds 100,000-code-unit string and symbol inputs', () => {
		expect(preview('x'.repeat(100_000))).toBe(`"${'x'.repeat(63)}…`)
		expect(preview(Symbol('x'.repeat(100_000)))).toBe(`Symbol(${'x'.repeat(57)}…`)
	})

	it('labels arrays without traversing other hosts', () => {
		expect(preview({ a: 1 })).toBe('object')
		expect(preview([1, 2, 3])).toBe('array')
		expect(preview(() => 1)).toBe('function')
	})

	it('renders a string by its escaped length at, on, and past the clip boundary', () => {
		// The ESCAPED inner length decides the answer, never the input length. At
		// two under `PREVIEW_LIMIT` the render closes with the quote, and one
		// character further it closes with the clip mark instead.
		expect(preview('x'.repeat(62))).toBe(`"${'x'.repeat(62)}"`)
		expect(preview('x'.repeat(63))).toBe(`"${'x'.repeat(63)}…`)
		expect(preview('x'.repeat(64))).toBe(`"${'x'.repeat(63)}…`)
		expect(preview('\n'.repeat(31))).toBe(`"${'\\n'.repeat(31)}"`)
		expect(preview(`${'\n'.repeat(30)}xxx`)).toBe(`"${'\\n'.repeat(30)}xxx…`)
		expect(preview('\n'.repeat(32))).toBe(`"${'\\n'.repeat(31)}…`)
	})

	it('escapes a lone surrogate and keeps a short astral pair whole', () => {
		const pair = `a${String.fromCodePoint(0x1f600)}b`

		expect(preview('\ud800')).toBe('"\\ud800"')
		expect(preview('a\udc00b')).toBe('"a\\udc00b"')
		expect(preview(pair)).toBe(`"${pair}"`)
		expect(preview(pair).isWellFormed()).toBe(true)
	})

	it('renders a symbol unquoted at a length a string renders quoted', () => {
		expect(preview(Symbol('sample'))).toBe('Symbol(sample)')
		expect(preview(Symbol('line\n'))).toBe('Symbol(line\\n)')
		expect(preview('sample')).toBe('"sample"')
	})

	it('renders text far past the limit without encoding the text it never renders', () => {
		// The clipped answer is the same whether or not the whole string was
		// encoded first, so the promise that enormous primitive text is never
		// fully encoded is a cost relationship rather than an output difference.
		// The lowest reading of several is taken on each side, so a scheduler
		// stall lengthens one reading instead of deciding the comparison. The
		// encoded length is asserted as well, because a control that skipped the
		// work would make the comparison meaningless.
		const huge = '\n'.repeat(2_000_000)
		let rendering = Number.POSITIVE_INFINITY
		let encoding = Number.POSITIVE_INFINITY
		let rendered = ''
		let encoded = ''
		for (let round = 0; round < 3; round += 1) {
			const renderStart = performance.now()
			rendered = preview(huge)
			rendering = Math.min(rendering, performance.now() - renderStart)
			const encodeStart = performance.now()
			encoded = INTRINSICS.stringify(huge)
			encoding = Math.min(encoding, performance.now() - encodeStart)
		}

		expect(rendered).toBe(`"${'\\n'.repeat(31)}…`)
		expect(encoded.length).toBe(4_000_002)
		// The threshold is 20 times; the gate measured about 2600 times on an
		// idle host, so a red reading here is host noise or a lost gate, and
		// the Orchestrator's idle re-run decides which.
		expect(rendering * 20).toBeLessThan(encoding)
	})
})

describe('shapeToKind', () => {
	it('projects each leaf shape to its FaultKind', () => {
		expect(shapeToKind(stringShape())).toBe('string')
		expect(shapeToKind(integerShape())).toBe('integer')
	})

	it('projects optional/nullable through their inner shape, and raw to json', () => {
		expect(shapeToKind(optionalShape(stringShape()))).toBe('string')
		expect(shapeToKind(nullableShape(integerShape()))).toBe('integer')
	})
})

describe('contain', () => {
	// The door boundary. Its own contract has two halves: a `ContractError`
	// reaching it passes through by identity, and anything else is republished
	// under the door name with the exact thrown value retained as `cause`.
	it('returns the body value untouched on success', () => {
		const value = { id: 1 }

		expect(contain(() => value, 'probe')).toBe(value)
		expect(contain(() => undefined, 'probe')).toBeUndefined()
	})

	it('passes a ContractError through by identity, keeping its diagnosis', () => {
		const authored = new ContractError('probe: the shape is malformed', {
			code: 'bound',
			context: { path: ['min'], shape: 'string' },
		})
		const outcome = attempt(() =>
			contain(() => {
				throw authored
			}, 'probe'),
		)

		expect(outcome.success).toBe(false)
		expect(outcome.success ? undefined : outcome.error).toBe(authored)
	})

	it('republishes a host failure under the door name and retains the exact cause', () => {
		const raw = Object.freeze({ stage: 'host' })
		const error = captureContractError(() =>
			contain(() => {
				throw raw
			}, 'probe'),
		)

		expect(error.message).toBe('probe: a host operation this door depends on failed')
		expect(error.code).toBe('structure')
		expect(error.cause).toBe(raw)
		expect(error.context).toBeUndefined()
	})

	it('carries the declared code and context onto a host failure', () => {
		const error = captureContractError(() =>
			contain(
				() => {
					throw new Error('host')
				},
				'probe',
				{ code: 'clone', context: { path: ['properties'], shape: 'object' } },
			),
		)

		expect(error.code).toBe('clone')
		expect(error.context).toEqual({ path: ['properties'], shape: 'object' })
	})

	it('never rewraps an authored refusal with the door options', () => {
		// The identity half again, this time with options present: the diagnosis a
		// door computed must not be demoted to a cause by its own boundary.
		const authored = new ContractError('probe: exact', { code: 'literal' })
		const error = captureContractError(() =>
			contain(
				() => {
					throw authored
				},
				'probe',
				{ code: 'clone' },
			),
		)

		expect(error).toBe(authored)
		expect(error.code).toBe('literal')
	})
})

describe('pathOf', () => {
	it('copies the existing path and appends each present segment', () => {
		expect(pathOf(['properties'], 'age')).toEqual(['properties', 'age'])
		expect(pathOf([], 'a', 'b')).toEqual(['a', 'b'])
		expect(pathOf(['a'])).toEqual(['a'])
	})

	it('omits an absent segment instead of encoding it', () => {
		expect(pathOf(['a'], undefined, 'b')).toEqual(['a', 'b'])
		expect(pathOf(['a'], undefined)).toEqual(['a'])
	})

	it('returns an owned copy rather than the caller array', () => {
		const source = ['a']
		const extended = pathOf(source)

		expect(extended).not.toBe(source)
		expect(extended).toEqual(['a'])
	})

	it('publishes only its own segments while the array iterator injects', () => {
		function* injectLeading(this: readonly unknown[]): Generator<unknown> {
			yield 'INJECTED'
			for (let index = 0; index < this.length; index += 1) yield this[index]
		}
		const built = replaceIntrinsic(Array.prototype, Symbol.iterator, injectLeading, () =>
			pathOf(['properties'], 'age'),
		)

		expect(built).toEqual(['properties', 'age'])
	})
})

describe('appendEntries', () => {
	it('appends every element in order', () => {
		const target = [1, 2]
		appendEntries(target, [3, 4])

		expect(target).toEqual([1, 2, 3, 4])
	})

	it('appends nothing for an empty source', () => {
		const target = [1]
		appendEntries(target, [])

		expect(target).toEqual([1])
	})

	it('appends its own elements while the array iterator injects', () => {
		function* injectLeading(this: readonly unknown[]): Generator<unknown> {
			yield 'INJECTED'
			for (let index = 0; index < this.length; index += 1) yield this[index]
		}
		const target: string[] = ['a']
		replaceIntrinsic(Array.prototype, Symbol.iterator, injectLeading, () => {
			appendEntries(target, ['b'])
		})

		expect(target).toEqual(['a', 'b'])
	})
})

describe('limitEntries', () => {
	it('returns the input untouched when it already fits', () => {
		const entries = [1, 2]

		expect(limitEntries(entries, 2)).toBe(entries)
		expect(limitEntries(entries, 5)).toBe(entries)
	})

	it('bounds a longer input to its leading entries', () => {
		expect(limitEntries([1, 2, 3, 4], 2)).toEqual([1, 2])
		expect(limitEntries([1, 2, 3], 0)).toEqual([])
	})

	it('bounds through an owned walk while Array.prototype.slice lies', () => {
		const lie = (): readonly number[] => [9, 9, 9]
		const bounded = replaceIntrinsic(Array.prototype, 'slice', lie, () =>
			limitEntries([1, 2, 3, 4], 2),
		)

		expect(bounded).toEqual([1, 2])
	})
})

describe('compareValues', () => {
	it('answers the three orderings for strings and for numbers', () => {
		expect(compareValues('a', 'b')).toBe(-1)
		expect(compareValues('b', 'a')).toBe(1)
		expect(compareValues('a', 'a')).toBe(0)
		expect(compareValues(2, 10)).toBe(-1)
		expect(compareValues(10, 2)).toBe(1)
		expect(compareValues(2, 2)).toBe(0)
	})

	it('compares numbers numerically rather than as text', () => {
		// The reason the captured sort is handed a comparator at all: the default
		// ordering coerces to string, where 10 sorts before 2 and a published
		// schema's index order stops matching its data.
		expect(compareValues(10, 2)).toBe(1)
		expect(compareValues(9, 10)).toBe(-1)
	})

	it('dispatches through no replaceable member while the comparison primitives lie', () => {
		// `<` / `>` on primitives runs no conversion hook, so a hostile prototype
		// member has nothing to answer. Asked with both operand kinds, because the
		// coercion a substituted `valueOf` or `toString` would supply is exactly
		// what the default ordering does and this comparator must not.
		function lie(): string {
			return 'INJECTED'
		}
		const answers = replaceIntrinsic(Number.prototype, 'valueOf', lie, () =>
			replaceIntrinsic(String.prototype, 'toString', lie, () => ({
				numeric: compareValues(10, 2),
				text: compareValues('a', 'b'),
			})),
		)

		expect(answers).toEqual({ numeric: 1, text: -1 })
	})
})

describe('sortValues', () => {
	it('orders strings and numbers ascending', () => {
		expect(sortValues(['b', 'a', 'c'])).toEqual(['a', 'b', 'c'])
		expect(sortValues([10, 2, 33])).toEqual([2, 10, 33])
	})

	it('never reorders the input array', () => {
		const source = ['b', 'a']
		const ordered = sortValues(source)

		expect(ordered).not.toBe(source)
		expect(source).toEqual(['b', 'a'])
		expect(ordered).toEqual(['a', 'b'])
	})

	it('orders through the captured sort while Array.prototype.sort empties its receiver', () => {
		function emptySort(this: unknown[]): unknown[] {
			this.length = 0
			return this
		}
		const ordered = replaceIntrinsic(Array.prototype, 'sort', emptySort, () =>
			sortValues(['b', 'a']),
		)

		expect(ordered).toEqual(['a', 'b'])
	})
})

describe('INTRINSICS', () => {
	// The capture table. Its published claims are that it is frozen data, that
	// every row is a data property (so no hostile accessor runs when a call site
	// reads one), and that a row keeps answering after a caller replaces the live
	// member it was read from.
	it('is a frozen table of data properties only', () => {
		expect(Object.isFrozen(INTRINSICS)).toBe(true)
		for (const key of Object.getOwnPropertyNames(INTRINSICS)) {
			const descriptor = Object.getOwnPropertyDescriptor(INTRINSICS, key)
			expect(descriptor).toBeDefined()
			expect(descriptor !== undefined && Object.hasOwn(descriptor, 'value')).toBe(true)
			expect(descriptor?.writable).toBe(false)
		}
	})

	it('freezes the proxy-visible group the same way it freezes the table', () => {
		// The group is a row like any other, so a reader that stopped at the top
		// level would report the whole table frozen while every proxy-visible
		// operation stayed writable.
		expect(Object.isFrozen(INTRINSICS.reflect)).toBe(true)
		for (const key of Object.getOwnPropertyNames(INTRINSICS.reflect)) {
			const descriptor = Object.getOwnPropertyDescriptor(INTRINSICS.reflect, key)
			expect(descriptor).toBeDefined()
			expect(descriptor !== undefined && Object.hasOwn(descriptor, 'value')).toBe(true)
			expect(descriptor?.writable).toBe(false)
		}
	})

	it('separates the reflective operations from their flat Object peers', () => {
		// `describe`, `define`, and `prototype` name one operation in each set, and
		// the split is the whole reason the group exists: the flat row reports the
		// target and the grouped row reports the trap.
		expect(INTRINSICS.describe).toBe(Object.getOwnPropertyDescriptor)
		expect(INTRINSICS.reflect.describe).toBe(Reflect.getOwnPropertyDescriptor)
		expect(INTRINSICS.define).toBe(Object.defineProperty)
		expect(INTRINSICS.reflect.define).toBe(Reflect.defineProperty)
		expect(INTRINSICS.prototype).toBe(Object.getPrototypeOf)
		expect(INTRINSICS.reflect.prototype).toBe(Reflect.getPrototypeOf)
	})

	it('keeps answering after the member it captured is replaced', () => {
		const thrower = (): never => {
			throw new Error('replaced')
		}
		const passthrough = (value: unknown): unknown => value
		const answers = replaceIntrinsic(Object, 'freeze', passthrough, () =>
			replaceIntrinsic(Date, 'now', thrower, () => ({
				frozen: Object.isFrozen(INTRINSICS.freeze({ probe: 1 })),
				clock: typeof INTRINSICS.now(),
			})),
		)

		expect(answers).toEqual({ frozen: true, clock: 'number' })
	})

	it('carries no row nothing reaches by name', () => {
		// A dead row is a rule nobody applied: `match: RegExp.prototype.exec` sat in
		// the table for a whole campaign with no call site, and it was also the only
		// row contradicting the table's own stated membership.
		expect(Object.hasOwn(INTRINSICS, 'match')).toBe(false)
	})
})

describe('captured membership', () => {
	it('answers SameValueZero membership over an indexed collection', () => {
		const members = collectMembers(['a', Number.NaN, -0])

		expect(matchesMember(members, 'a')).toBe(true)
		expect(matchesMember(members, Number.NaN)).toBe(true)
		expect(matchesMember(members, 0)).toBe(true)
		expect(matchesMember(members, 'NOT-A-MEMBER')).toBe(false)
	})

	it('grows a vocabulary as a walk proceeds', () => {
		const members = collectMembers([])

		expect(matchesMember(members, 'a')).toBe(false)
		admitMember(members, 'a')
		expect(matchesMember(members, 'a')).toBe(true)
	})

	it('answers through the captured operations while the host members lie', () => {
		const members = collectMembers(['a'])
		const answers = replaceIntrinsic(
			Set.prototype,
			'has',
			(): boolean => true,
			() =>
				replaceIntrinsic(
					Set.prototype,
					'add',
					function keepEmpty(this: Set<unknown>): Set<unknown> {
						return this
					},
					() => {
						const built = collectMembers(['b'])
						return {
							stranger: matchesMember(members, 'NOT-A-MEMBER'),
							member: matchesMember(members, 'a'),
							collected: matchesMember(built, 'b'),
						}
					},
				),
		)

		expect(answers).toEqual({ stranger: false, member: true, collected: true })
	})

	it('tracks and releases an active traversal path through the captured operations', () => {
		const visited = new WeakSet<object>()
		const node = { name: 'node' }

		expect(matchesVisited(visited, node)).toBe(false)
		admitVisited(visited, node)
		expect(matchesVisited(visited, node)).toBe(true)
		const lying = replaceIntrinsic(
			WeakSet.prototype,
			'has',
			(): boolean => false,
			() => matchesVisited(visited, node),
		)
		expect(lying).toBe(true)
		omitVisited(visited, node)
		expect(matchesVisited(visited, node)).toBe(false)
	})
})

describe('captured collection reads', () => {
	it('appends each swept entry as a key/value pair', () => {
		const collected: unknown[][] = []
		new Set(['a']).forEach(collectEntries(collected))
		new Map([['key', 'value']]).forEach(collectEntries(collected))

		expect(collected).toEqual([
			['a', 'a'],
			['key', 'value'],
		])
	})

	it('reads a set and a map through the captured sweep while their iterators lie', () => {
		const set = new Set<unknown>(['a', 42])
		const table = new Map<unknown, unknown>([['a', 1]])
		const skipNumbers = function* onlyStrings(this: ReadonlySet<unknown>): Generator<unknown> {
			for (const entry of Array.from(this.values())) if (typeof entry === 'string') yield entry
		}

		const entries = replaceIntrinsic(Set.prototype, Symbol.iterator, skipNumbers, () =>
			readSetEntries(set),
		)
		const pairs = readMapEntries(table)

		expect(entries.success && entries.value).toEqual(['a', 42])
		expect(pairs.success && pairs.value).toEqual([['a', 1]])
		expect(entries.success && Object.isFrozen(entries.value)).toBe(true)
	})

	it('reports an unreadable receiver as a failure carrying the exact thrown value', () => {
		// A revoked proxy over a genuine Set: the captured sweep reaches no
		// `[[SetData]]`, so the read fails instead of publishing an empty snapshot.
		const revocable = Proxy.revocable<Set<unknown>>(new Set(['a']), {})
		revocable.revoke()

		const outcome = readSetEntries(revocable.proxy)

		expect(outcome.success).toBe(false)
		expect(outcome.success ? undefined : isContractError(outcome.error)).toBe(false)
	})
})

describe('captured pattern reads', () => {
	it('reads source and flags from the internal slots, not from an own accessor', () => {
		const pattern = /^a+$/i
		Object.defineProperty(pattern, 'source', { get: () => '.*' })
		Object.defineProperty(pattern, 'flags', { get: () => 'g' })

		expect(readPatternSource(pattern)).toBe('^a+$')
		expect(readPatternFlags(pattern)).toBe('i')
		// A receiver carrying no pattern internal slots THROWS out of the captured
		// accessor, which is exactly the brand test `isRegExp` is spelled with.
		expect(attempt(() => readPatternSource('not a pattern')).success).toBe(false)
	})

	it('answers pattern membership through the captured exec while test and exec lie', () => {
		const answers = replaceIntrinsic(
			RegExp.prototype,
			'test',
			(): boolean => true,
			() =>
				replaceIntrinsic(
					RegExp.prototype,
					'exec',
					(): unknown => ['DECOY'],
					() => ({
						stranger: matchesPattern(/^[0-9a-f]+$/, 'THIS-IS-NOT-HEX'),
						member: matchesPattern(/^[0-9a-f]+$/, '1a2f'),
					}),
				),
		)

		expect(answers).toEqual({ stranger: false, member: true })
	})

	it('rebuilds an owned stateless pattern with an indexed flag filter', () => {
		const owned = replaceIntrinsic(
			String.prototype,
			'replaceAll',
			() => 'i',
			() => readPattern(/^abc$/gy),
		)

		expect(owned.source).toBe('^abc$')
		expect(owned.flags).toBe('')
		expect(matchesPattern(owned, 'ABC')).toBe(false)
		expect(matchesPattern(owned, 'abc')).toBe(true)
	})
})

describe('ownPattern', () => {
	it("rebuilds a pattern statelessly and refuses through the reader's coded error when the pattern cannot be read", () => {
		const caller = /^[a-z]+$/gy
		const owned = ownPattern(caller, 'stringOf')

		expect(owned.source).toBe('^[a-z]+$')
		expect(matchesPattern(owned, 'abc')).toBe(true)
		expect(matchesPattern(owned, 'abc')).toBe(true)
		expect(matchesPattern(owned, 'ABC')).toBe(false)
		expect(matchesPattern(owned, 'abc')).toBe(true)
		expect(caller.lastIndex).toBe(0)
		expect(owned.lastIndex).toBe(0)
		// Controls: the caller really carried the stateful flags, and the rebuild
		// really dropped them, so the preceding repeated answers are the strip rather
		// than a caller that never advanced.
		expect(caller.flags).toBe('gy')
		expect(owned.flags).toBe('')

		// A Proxy carries no pattern internal slots, so the captured `source`
		// getter refuses the receiver and the reader's own name reaches the caller
		// instead of the host's raw `TypeError`.
		const refusal = captureContractError(() => ownPattern(new Proxy(/^a$/, {}), 'stringOf'))

		expect(refusal.message).toBe('stringOf: pattern could not be read')
		expect(refusal.code).toBe('pattern')
		expect(refusal.context).toEqual({ shape: 'string' })
	})
})

describe('pinned prototypes', () => {
	it('pins every own prototype member and refuses when the pin cannot be verified', () => {
		class Widget {
			run(): string {
				return 'ran'
			}
		}
		pinMembers(Widget.prototype, 'Widget')

		expect(Object.getOwnPropertyDescriptor(Widget.prototype, 'run')?.writable).toBe(false)
		expect(Object.getOwnPropertyDescriptor(Widget.prototype, 'run')?.configurable).toBe(false)
		expect(Reflect.defineProperty(Widget.prototype, 'run', { value: (): string => 'lied' })).toBe(
			false,
		)

		// Placement is the CAPTURED `Reflect.defineProperty`, so a caller who
		// replaces `Object.defineProperty` with a no-op does not silence the pin.
		class Captured {
			run(): string {
				return 'ran'
			}
		}
		const noop = function (target: object): object {
			return target
		}
		replaceIntrinsic(Object, 'defineProperty', noop, () =>
			pinMembers(Captured.prototype, 'Captured'),
		)
		expect(Object.getOwnPropertyDescriptor(Captured.prototype, 'run')?.writable).toBe(false)

		// And a member that cannot be pinned refuses loudly instead of passing:
		// placement through a prototype whose `defineProperty` answers `false`
		// leaves the member configurable, and the corroborating read reports it.
		const blocked = new Proxy(
			{
				run(): string {
					return 'ran'
				},
			},
			{ defineProperty: (): boolean => false },
		)
		const refusal = captureContractError(() => pinMembers(blocked, 'Other'))

		expect(refusal.code).toBe('structure')
		expect(refusal.message).toBe('Other: a prototype member could not be pinned')
	})

	it('pins an accessor without replacing it with undefined', () => {
		// Asking for `writable` on a getter silently converts it into a data
		// property holding `undefined` — a pin that deletes the member it was
		// protecting. `ShapeValidator.prototype.expansion` is the live case.
		class Counted {
			get count(): number {
				return 7
			}
		}
		pinMembers(Counted.prototype, 'Counted')
		const descriptor = Object.getOwnPropertyDescriptor(Counted.prototype, 'count')

		expect(typeof descriptor?.get).toBe('function')
		expect(descriptor?.configurable).toBe(false)
		expect(new Counted().count).toBe(7)
		expect(new ShapeValidator({ category: 'string' }).expansion).toBeUndefined()
	})

	it('leaves no exported class prototype member writable', () => {
		for (const owner of [ContractError, JSONCloner, SchemaCloner, ShapeCloner, ShapeValidator]) {
			for (const key of Object.getOwnPropertyNames(owner.prototype)) {
				const descriptor = Object.getOwnPropertyDescriptor(owner.prototype, key)
				expect(descriptor?.configurable, `${owner.name}.prototype.${key}`).toBe(false)
				// A data member is pinned non-writable; an accessor has no `writable` to
				// pin and must instead still answer through its own getter.
				const data = descriptor !== undefined && 'value' in descriptor
				expect(
					data ? descriptor?.writable === false : typeof descriptor?.get === 'function',
					`${owner.name}.prototype.${key}`,
				).toBe(true)
			}
		}
	})
})

describe('matchesJSONValue — an iterative verdict (H9)', () => {
	it('answers the same for one document however deep the caller already is', () => {
		// It used to recurse, so V8's remaining stack decided the answer instead of
		// the value: a strictly shallower document evaluated `false` moments after a
		// deeper one evaluated `true`, and `parseJSONValue` republished the
		// resulting `RangeError` as an unreadability refusal.
		let payload: unknown = 1
		for (let index = 0; index < 20_000; index += 1) payload = { a: payload }

		expect(matchesJSONValue(payload, new WeakSet())).toBe(true)
		expect(isJSONValue(payload)).toBe(true)
		expect(parseJSONValue(payload)).toBe(payload)

		// The same document reached from inside a deep walk of its own answers
		// identically — the verdict is a function of the value, not of the frame.
		let nested: unknown = payload
		for (let index = 0; index < 20_000; index += 1) nested = [nested]
		expect(matchesJSONValue(nested, new WeakSet())).toBe(true)

		// Controls: the walk still refuses honest invalidity and still refuses a
		// cycle, at depth.
		let invalid: unknown = Number.NaN
		for (let index = 0; index < 20_000; index += 1) invalid = { a: invalid }
		expect(matchesJSONValue(invalid, new WeakSet())).toBe(false)
		expect(parseJSONValue(invalid)).toBeUndefined()

		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(matchesJSONValue(cyclic, new WeakSet())).toBe(false)

		// A shared alias off the active path is still legal, which is the property
		// the ancestor set exists to preserve.
		const shared = { value: 1 }
		expect(matchesJSONValue({ a: shared, b: shared }, new WeakSet())).toBe(true)

		// The bounded pair beside it is unchanged, so the two remain distinct doors.
		expect(matchesJSONDepth(payload)).toBe(false)
		expect(isBoundedJSONValue(payload)).toBe(false)
	})
})

describe('shapeToKind — declared return type (H9)', () => {
	it('refuses an unrecognized discriminant rather than answering undefined', () => {
		// Declared and documented as `shape -> FaultKind`, non-optional; the switch
		// had no default and fell off its end for a hand-authored node. The node is
		// built as a real declaration and then corrupted reflectively, because a
		// type assertion would have made the input the type system's problem rather
		// than the switch's.
		const corrupt: ContractShape = { category: 'string' }
		Reflect.set(corrupt, 'category', 'not-a-real-category')
		const error = captureContractError(() => shapeToKind(corrupt))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('shapeToKind: shape could not be read')

		// Controls: every recognized discriminant still projects.
		expect(shapeToKind(stringShape())).toBe('string')
		expect(shapeToKind(integerShape())).toBe('integer')
		expect(shapeToKind(optionalShape(stringShape()))).toBe('string')
	})
})

describe('buildStringFaults', () => {
	it('reports min, max, and pattern in declaration order', () => {
		// All three cannot be violated by one length, so the order is proven in two
		// halves that overlap on `pattern`.
		const short: StringShape = { category: 'string', min: 4, pattern: /^[0-9]+$/ }
		expect(faultsToConstraints(buildStringFaults(short, 'ab', []))).toEqual(['min', 'pattern'])

		const long: StringShape = { category: 'string', max: 2, pattern: /^[0-9]+$/ }
		expect(faultsToConstraints(buildStringFaults(long, 'abcd', []))).toEqual(['max', 'pattern'])
	})

	it('treats both bounds as inclusive and previews the offending value', () => {
		const bounded: StringShape = { category: 'string', min: 2, max: 4 }
		expect(buildStringFaults(bounded, 'ab', [])).toEqual([])
		expect(buildStringFaults(bounded, 'abcd', [])).toEqual([])
		expect(buildStringFaults(bounded, 'a', [])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'min',
				limit: 2,
				received: '"a"',
			},
		])
		expect(buildStringFaults(bounded, 'abcde', [])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'max',
				limit: 4,
				received: '"abcde"',
			},
		])
	})

	it('carries the pattern source as the limit and roots faults at the given path', () => {
		const shape: StringShape = { category: 'string', pattern: /^[a-z]+$/ }
		expect(buildStringFaults(shape, 'A1', ['properties', 'name'])).toEqual([
			{
				reason: 'constraint',
				path: ['properties', 'name'],
				expected: 'string',
				constraint: 'pattern',
				limit: '^[a-z]+$',
				received: '"A1"',
			},
		])
	})

	it('applies a stateful pattern statelessly and never moves the caller lastIndex', () => {
		// `g` makes `exec` advance `lastIndex`, so a door reusing the caller's own
		// regex answers differently on the second call for the same value. The owned
		// rebuild strips it; the controls below prove the flag was really set.
		const pattern = /^[a-z]+$/g
		const shape: StringShape = { category: 'string', pattern }
		expect(buildStringFaults(shape, 'abc', [])).toEqual([])
		expect(buildStringFaults(shape, 'abc', [])).toEqual([])
		expect(pattern.lastIndex).toBe(0)
		expect(pattern.global).toBe(true)
	})

	it('reports the same faults from a supplied rebuild as from the shape itself', () => {
		// A contradictory declaration is the only one a single length can violate on
		// every axis at once, so it is what pins the whole order in one report.
		const shape: StringShape = { category: 'string', min: 4, max: 2, pattern: /^[0-9]+$/ }
		const supplied = buildStringFaults(shape, 'abc', ['items'], readPattern(/^[0-9]+$/))

		expect(supplied).toEqual([
			{
				reason: 'constraint',
				path: ['items'],
				expected: 'string',
				constraint: 'min',
				limit: 4,
				received: '"abc"',
			},
			{
				reason: 'constraint',
				path: ['items'],
				expected: 'string',
				constraint: 'max',
				limit: 2,
				received: '"abc"',
			},
			{
				reason: 'constraint',
				path: ['items'],
				expected: 'string',
				constraint: 'pattern',
				limit: '^[0-9]+$',
				received: '"abc"',
			},
		])
		expect(buildStringFaults(shape, 'abc', ['items'])).toEqual(supplied)
	})

	it("applies the supplied pattern rather than the shape's own to decide the match", () => {
		const shape: StringShape = { category: 'string', pattern: /^a$/ }
		expect(buildStringFaults(shape, 'b', [], readPattern(/^b$/))).toEqual([])

		// Control: the same value against the same shape without the supplied
		// rebuild does fault, so the preceding empty report is the argument being
		// applied rather than a value that was never checked at all.
		expect(faultsToConstraints(buildStringFaults(shape, 'b', []))).toEqual(['pattern'])
	})

	it('answers repeatedly from one rebuild of a global caller pattern without moving lastIndex', () => {
		// The rebuild is what a caller holding one shape for many values supplies
		// once, so it has to be reusable: `g` on the caller's own object advances
		// `lastIndex` per `exec`, and stripping it is what makes a single shared
		// pattern answer the same way on every call.
		const caller = /^[a-z]+$/g
		const shape: StringShape = { category: 'string', pattern: /^[a-z]+$/ }
		const stateless = readPattern(caller)

		expect(buildStringFaults(shape, 'abc', [], stateless)).toEqual([])
		expect(buildStringFaults(shape, 'abc', [], stateless)).toEqual([])
		expect(buildStringFaults(shape, 'ABC', [], stateless)).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'pattern',
				limit: '^[a-z]+$',
				received: '"ABC"',
			},
		])
		expect(buildStringFaults(shape, 'abc', [], stateless)).toEqual([])
		expect(caller.lastIndex).toBe(0)
		expect(stateless.lastIndex).toBe(0)
		// Controls: the caller really carried `g`, and the rebuild really dropped it.
		expect(caller.global).toBe(true)
		expect(stateless.global).toBe(false)
	})

	it("reads a hand-rolled shape's pattern accessor twice per call when the shape declares one, for the presence test and for the rebuild that names the limit", () => {
		// A hand-rolled declaration is what can count the reads at all: the
		// package's own clone answers with a fresh frozen `RegExp` per read, and a
		// plain literal observes nothing. The accessor answers with the same
		// pattern every time, so a differing read count is the only thing this can
		// report.
		let reads = 0
		const shape: StringShape = {
			category: 'string',
			get pattern() {
				reads += 1
				return /^[0-9]+$/
			},
		}
		const first = buildStringFaults(shape, 'abc', [])

		expect(first).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'pattern',
				limit: '^[0-9]+$',
				received: '"abc"',
			},
		])
		// The rebuild that applied the pattern is also what the `limit` text is
		// read from, so the accessor answers one read for it and one for the
		// presence test that decides whether a pattern was declared at all.
		expect(reads).toBe(2)

		expect(buildStringFaults(shape, 'abc', [])).toEqual(first)
		expect(reads).toBe(4)
	})

	it('answers from a supplied rebuild without asking the shape for its pattern', () => {
		// A counting accessor is the only instrument that separates applying the
		// supplied rebuild from rebuilding out of the shape regardless: the reports
		// are identical either way, so only the read count binds the promise.
		let reads = 0
		const shape: StringShape = {
			category: 'string',
			get pattern() {
				reads += 1
				return /^[0-9]+$/
			},
		}
		const supplied = buildStringFaults(shape, 'abc', [], readPattern(/^[0-9]+$/))

		expect(supplied).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'string',
				constraint: 'pattern',
				limit: '^[0-9]+$',
				received: '"abc"',
			},
		])
		expect(reads).toBe(0)

		// Control: the omitted form asks the same accessor, so a count that stayed
		// at zero is the supplied rebuild being applied rather than an accessor
		// that cannot count.
		expect(buildStringFaults(shape, 'abc', [])).toEqual(supplied)
		expect(reads).toBe(2)
	})

	it('returns a fresh array per call and mutates neither the shape nor the path', () => {
		const path = ['items']
		const shape: StringShape = { category: 'string', min: 3 }
		const first = buildStringFaults(shape, 'a', path)
		const second = buildStringFaults(shape, 'a', path)

		expect(first).not.toBe(second)
		expect(first).toEqual(second)
		expect(path).toEqual(['items'])
		expect(shape).toEqual({ category: 'string', min: 3 })
		expect(buildStringFaults(shape, 'abc', [])).not.toBe(buildStringFaults(shape, 'abc', []))
	})

	it('refuses a shape it cannot read instead of publishing the host failure', () => {
		// A public export takes whatever a `StringShape` annotation vouched for, and
		// TypeScript vouches for a shape parsed out of a document exactly as loudly
		// as for one a builder made. The compiled doors gate a non-`RegExp` pattern
		// and a non-finite bound long before this helper sees them, so the package's
		// own path never arrives here off-domain — but the door is published, and a
		// published door that leaks a raw host value falsifies the promise its
		// sibling `shapeToKind` states for this whole module.
		const disguised = captureContractError(() =>
			buildStringFaults({ category: 'string', pattern: new Proxy(/^a+$/, {}) }, 'abc', []),
		)
		expect(disguised.code).toBe('structure')
		expect(disguised.message).toBe('buildStringFaults: shape could not be read')

		const hostile: StringShape = { category: 'string' }
		Object.defineProperty(hostile, 'min', {
			get: throwSentinel(new Error('boom')),
			enumerable: true,
		})
		const unreadable = captureContractError(() => buildStringFaults(hostile, 'abc', []))
		expect(unreadable.code).toBe('structure')
		expect(unreadable.message).toBe('buildStringFaults: shape could not be read')
		expect(unreadable.cause).toBeInstanceOf(Error)

		// Control: the honest shape beside it still reports, so the boundary refuses
		// the unreadable declaration rather than swallowing every answer.
		expect(
			faultsToConstraints(buildStringFaults({ category: 'string', min: 4 }, 'ab', [])),
		).toEqual(['min'])
	})
})

describe('buildNumberFaults', () => {
	it('reports integer, min, and max in declaration order', () => {
		const shape: NumberShape = { category: 'number', integer: true, min: 10, max: 1 }
		expect(faultsToConstraints(buildNumberFaults(shape, 5.5, []))).toEqual([
			'integer',
			'min',
			'max',
		])
	})

	it('names the declared kind rather than the value kind', () => {
		expect(buildNumberFaults({ category: 'number', integer: true, min: 1 }, 0, [])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'integer',
				constraint: 'min',
				limit: 1,
				received: '0',
			},
		])
		expect(buildNumberFaults({ category: 'number', min: 1 }, 0, [])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'number',
				constraint: 'min',
				limit: 1,
				received: '0',
			},
		])
	})

	it('treats both bounds as inclusive and accepts a whole-valued float as an integer', () => {
		const bounded: NumberShape = { category: 'number', min: -1, max: 1 }
		expect(buildNumberFaults(bounded, -1, [])).toEqual([])
		expect(buildNumberFaults(bounded, 1, [])).toEqual([])
		expect(faultsToConstraints(buildNumberFaults(bounded, -1.5, []))).toEqual(['min'])
		// Negative zero satisfies both bounds exactly as positive zero does, and
		// `Number.isInteger(-0)` is true, so the signed zero faults at neither gate.
		expect(buildNumberFaults({ category: 'number', integer: true }, -0, [])).toEqual([])
		expect(buildNumberFaults({ category: 'number', integer: true }, 2.0, [])).toEqual([])
	})

	it('returns a fresh array per call and mutates neither the shape nor the path', () => {
		const path = ['properties', 'age']
		const shape: NumberShape = { category: 'number', max: 1 }
		const first = buildNumberFaults(shape, 2, path)
		const second = buildNumberFaults(shape, 2, path)

		expect(first).not.toBe(second)
		expect(first).toEqual(second)
		expect(path).toEqual(['properties', 'age'])
		expect(shape).toEqual({ category: 'number', max: 1 })
	})

	it('refuses a shape it cannot read instead of publishing the host failure', () => {
		const hostile: NumberShape = { category: 'number' }
		Object.defineProperty(hostile, 'min', {
			get: throwSentinel(new Error('boom')),
			enumerable: true,
		})
		const error = captureContractError(() => buildNumberFaults(hostile, 3, []))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('buildNumberFaults: shape could not be read')
		expect(error.cause).toBeInstanceOf(Error)

		// Control: the honest shape beside it still reports.
		expect(faultsToConstraints(buildNumberFaults({ category: 'number', min: 4 }, 3, []))).toEqual([
			'min',
		])
	})
})

describe('buildArrayFaults', () => {
	it('reports min then max against the observed length', () => {
		const shape: ArrayShape = { category: 'array', items: { category: 'string' }, min: 2, max: 3 }
		expect(buildArrayFaults(shape, 2, [])).toEqual([])
		expect(buildArrayFaults(shape, 3, [])).toEqual([])
		expect(buildArrayFaults(shape, 1, [])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'array',
				constraint: 'min',
				limit: 2,
				received: '1',
			},
		])
		expect(buildArrayFaults(shape, 4, [])).toEqual([
			{
				reason: 'constraint',
				path: [],
				expected: 'array',
				constraint: 'max',
				limit: 3,
				received: '4',
			},
		])
	})

	it('reports the length it was handed rather than re-reading any value', () => {
		// Both doors read their entries once through `readArrayEntries`; the count
		// reported here is that read's count, so a value whose `length` moved between
		// reads cannot make the diagnostic disagree with the walk that produced it.
		const shape: ArrayShape = { category: 'array', items: { category: 'string' }, min: 5 }
		expect(buildArrayFaults(shape, 0, ['items'])).toEqual([
			{
				reason: 'constraint',
				path: ['items'],
				expected: 'array',
				constraint: 'min',
				limit: 5,
				received: '0',
			},
		])
	})

	it('returns a fresh array per call and mutates neither the shape nor the path', () => {
		const path = ['0']
		const shape: ArrayShape = { category: 'array', items: { category: 'string' }, min: 1 }
		const first = buildArrayFaults(shape, 0, path)
		const second = buildArrayFaults(shape, 0, path)

		expect(first).not.toBe(second)
		expect(first).toEqual(second)
		expect(path).toEqual(['0'])
		expect(shape).toEqual({ category: 'array', items: { category: 'string' }, min: 1 })
	})

	it('refuses a shape it cannot read instead of publishing the host failure', () => {
		const hostile: ArrayShape = { category: 'array', items: { category: 'string' } }
		Object.defineProperty(hostile, 'min', {
			get: throwSentinel(new Error('boom')),
			enumerable: true,
		})
		const error = captureContractError(() => buildArrayFaults(hostile, 3, []))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('buildArrayFaults: shape could not be read')
		expect(error.cause).toBeInstanceOf(Error)

		// Control: the honest shape beside it still reports.
		expect(
			faultsToConstraints(
				buildArrayFaults({ category: 'array', items: { category: 'string' }, min: 4 }, 3, []),
			),
		).toEqual(['min'])
	})
})

describe('selectClosestFaults', () => {
	it('selects the shortest report by identity rather than by copy', () => {
		const wide = [buildTypeFault('string'), buildTypeFault('number')]
		const narrow = [buildTypeFault('number')]

		expect(selectClosestFaults([wide, narrow])).toBe(narrow)
		expect(selectClosestFaults([narrow, wide])).toBe(narrow)
	})

	it('keeps the earliest of equally short reports, so declaration order decides', () => {
		const first = [buildTypeFault('string')]
		const second = [buildTypeFault('number')]

		expect(selectClosestFaults([first, second])).toBe(first)
		expect(selectClosestFaults([second, first])).toBe(second)

		// An empty report is the shortest possible one, and the same rule applies.
		const empty: readonly Fault[] = []
		expect(selectClosestFaults([first, empty, []])).toBe(empty)
	})

	it('answers a frozen empty collection when there is no report at all', () => {
		const none = selectClosestFaults([])

		expect(none).toEqual([])
		expect(Object.isFrozen(none)).toBe(true)
		// Fresh per call, so no two callers share one published collection.
		expect(none).not.toBe(selectClosestFaults([]))
	})

	it('mutates neither the outer list nor any report it inspected', () => {
		const wide = [buildTypeFault('string'), buildTypeFault('number')]
		const narrow = [buildTypeFault('number')]
		const reports = [wide, narrow]

		selectClosestFaults(reports)

		expect(reports).toEqual([wide, narrow])
		expect(wide.length).toBe(2)
		expect(narrow.length).toBe(1)
	})
})

describe('the shared fault helpers are the reporter and auditor rule (R6-A)', () => {
	it('gives explain and audit the same string faults, in the helper order', () => {
		const shape = stringShape({ min: 4, pattern: /^[0-9]+$/ })
		const contract = createContract(shape)
		const expected = buildStringFaults(shape, 'ab', [])

		expect(faultsToConstraints(expected)).toEqual(['min', 'pattern'])
		expect(contract.explain('ab')).toEqual(expected)
		expect(contract.audit('ab')).toEqual(expected)
	})

	it('gives explain and audit the same number faults, in the helper order', () => {
		const shape = integerShape({ min: 10 })
		const contract = createContract(shape)
		const expected = buildNumberFaults(shape, 5.5, [])

		expect(faultsToConstraints(expected)).toEqual(['integer', 'min'])
		expect(contract.explain(5.5)).toEqual(expected)
		expect(contract.audit(5.5)).toEqual(expected)
	})

	it('gives explain and audit the same array length faults', () => {
		const shape = arrayShape(stringShape(), { min: 2 })
		const contract = createContract(shape)
		const expected = buildArrayFaults(shape, 1, [])

		expect(expected.length).toBe(1)
		expect(contract.explain(['a'])).toEqual(expected)
		expect(contract.audit(['a'])).toEqual(expected)
	})

	it('gives explain and audit the same closest variant, chosen earliest-shortest', () => {
		// The object variant faults once for the missing key and the array variant
		// faults once for the type, so both reports are length 1 and the EARLIER
		// variant supplies the summary's tail.
		const object = objectShape({ name: stringShape() })
		const list = arrayShape(stringShape())
		const shape = unionShape(object, list)
		const contract = createContract(shape)

		const explained = contract.explain({})
		expect(explained[0]).toEqual({ reason: 'variant', path: [], variants: 2 })
		expect(explained.slice(1)).toEqual(
			selectClosestFaults([compileReporter(object, {}), compileReporter(list, {})]),
		)
		expect(explained.slice(1)).toEqual(compileReporter(object, {}))

		const audited = contract.audit({})
		expect(audited[0]).toEqual({ reason: 'variant', path: [], variants: 2 })
		expect(audited.slice(1)).toEqual(
			selectClosestFaults([compileAuditor(object, {}), compileAuditor(list, {})]),
		)
	})
})

describe('refuseExpansion', () => {
	it('refuses an absent measurement rather than reading it as a small one', () => {
		// `undefined` reaches here only when the pass that was to measure the graph
		// did not, so admitting it would report the node bound as satisfied by a
		// count nobody took.
		const error = captureContractError(() => refuseExpansion(undefined))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('validateShape: a validated shape measured no expansion')
		expect(error.context).toEqual({ path: [] })
	})

	it('accepts a count at the limit and refuses the first count past it', () => {
		expect(() => refuseExpansion(0)).not.toThrow()
		expect(() => refuseExpansion(COMPILE_NODE_LIMIT)).not.toThrow()

		const error = captureContractError(() => refuseExpansion(COMPILE_NODE_LIMIT + 1))

		expect(error.code).toBe('expansion')
		expect(error.message).toBe('validateShape: a shape expands past the compilation node limit')
		expect(error.context).toEqual({
			path: [],
			limit: COMPILE_NODE_LIMIT,
			received: String(COMPILE_NODE_LIMIT + 1),
		})
		expect(Object.hasOwn(error, 'cause')).toBe(false)
	})

	it('publishes one refusal for both boundaries that apply the bound', () => {
		// The eager function and the lazy compiler reach the same rule, so a
		// declaration past the cap must be refused with the identical error at both
		// — one message, one code, one context, however the caller arrived.
		const refused = buildSharedDagShape(14)
		const eager = captureContractError(() => validateShape(refused))
		const lazy = captureContractError(() => new ContractCompiler(refused).schema)

		expect(lazy.message).toBe(eager.message)
		expect(lazy.code).toBe(eager.code)
		expect(lazy.context).toEqual(eager.context)
	})
})

describe('retainDepth', () => {
	it('creates one map per node and keeps every allowance recorded against it', () => {
		// The three depth-bounded walks answer one node once per remaining
		// allowance, so the node's map must be created on first sight and REUSED
		// afterwards. A get-or-create that rebuilt the map would silently drop the
		// earlier allowance and make a later call recompute what was already known.
		const memo = new WeakMap<object, Map<number, string>>()
		const first = {}
		const second = {}

		retainDepth(memo, first, 8, 'deep')
		const created = memo.get(first)
		retainDepth(memo, first, 4, 'shallow')

		expect(memo.get(first)).toBe(created)
		expect([...(memo.get(first) ?? [])]).toEqual([
			[8, 'deep'],
			[4, 'shallow'],
		])

		// Keyed by node identity: a second node gets its own map rather than
		// sharing the first node's answers.
		retainDepth(memo, second, 8, 'other')
		expect(memo.get(second)).not.toBe(created)
		expect(memo.get(second)?.get(8)).toBe('other')
		expect(memo.get(first)?.get(8)).toBe('deep')

		// Rewriting one allowance replaces that entry alone.
		retainDepth(memo, first, 8, 'again')
		expect(memo.get(first)?.get(8)).toBe('again')
		expect(memo.get(first)?.get(4)).toBe('shallow')
	})

	it('records through the captured members, so a replaced global cannot divert it', () => {
		// The memo is where a walk's already-published answer is stored, so a
		// caller who replaces `WeakMap.prototype.set` or `Map.prototype.set` must
		// not be able to decide what a later call replays.
		const memo = new WeakMap<object, Map<number, string>>()
		const node = {}

		// The answer is collected INSIDE the replacement window and asserted after
		// it: the assertion library keeps its own state in `WeakMap` and `Map`, so
		// an `expect` under a throwing prototype member reports on the harness
		// rather than on the subject.
		const outcome = replaceIntrinsic(WeakMap.prototype, 'set', throwSentinel('weakmap'), () =>
			replaceIntrinsic(Map.prototype, 'set', throwSentinel('map'), () =>
				attempt(() => retainDepth(memo, node, 2, 'captured')),
			),
		)

		expect(outcome.success).toBe(true)
		expect(memo.get(node)?.get(2)).toBe('captured')
	})
})

describe('readSampleMemo', () => {
	it('returns the memo it was given and refuses one whose collections are wrong', () => {
		const memo = buildSampleMemo()
		expect(readSampleMemo(memo, 'samplesToSchema')).toBe(memo)

		// Inside the rule: a record built by this module whose collection fields
		// are the wrong KIND. The refusal names the door the memo was read for and
		// points at the memo argument rather than at the samples beside it — the
		// whole reason the check exists rather than letting the traversal fail.
		const swappedRows = buildSampleMemo()
		Reflect.set(swappedRows, 'rows', new Map())
		const rows = captureContractError(() => readSampleMemo(swappedRows, 'samplesToSchema'))
		expect(rows.code).toBe('structure')
		expect(rows.message).toBe('samplesToSchema: memo must be a sample memo')
		expect(rows.context).toEqual({
			path: ['memo'],
			limit: 'SampleMemo',
			received: preview(swappedRows),
		})

		const swappedSchemas = buildSampleMemo()
		Reflect.set(swappedSchemas, 'schemas', new WeakMap())
		const schemas = captureContractError(() => readSampleMemo(swappedSchemas, 'compileSchema'))
		expect(schemas.code).toBe('structure')
		expect(schemas.message).toBe('compileSchema: memo must be a sample memo')
	})

	it('accepts a memo from outside the population buildSampleMemo produces', () => {
		// Control drawn from OUTSIDE the membership rule. Every case above is a
		// record this module built and then corrupted, so together they establish
		// only that the reader discriminates among its OWN records. The rule it
		// actually applies is structural, so a memo this package never built must
		// be accepted — and the class instance below is exactly that value.
		const foreign = new ClassSampleMemo()

		expect(isRecord(foreign)).toBe(false)
		expect(readSampleMemo(foreign, 'samplesToSchema')).toBe(foreign)

		// The pair that makes the acceptance mean something: the SAME class with
		// one collection swapped is refused, so the reader is applying the rule to
		// the value rather than letting every class instance past.
		const corrupt = new ClassSampleMemo()
		Reflect.set(corrupt, 'schemas', new WeakMap())
		expect(captureContractError(() => readSampleMemo(corrupt, 'samplesToSchema')).message).toBe(
			'samplesToSchema: memo must be a sample memo',
		)
	})
})
