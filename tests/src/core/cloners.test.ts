import type { AuditFault, ContractShape, JSONRecord, JSONSchema, StringShape } from '@src/core'
import {
	attempt,
	cloneJSONRecord,
	cloneJSONValue,
	cloneSchema,
	cloneShape,
	compileSchema,
	ContractError,
	dateShape,
	describeFaults,
	isRecord,
	literalShape,
	objectShape,
	ownShape,
	PREVIEW_LIMIT,
	SchemaCloner,
	ShapeCloner,
	stringShape,
	unionShape,
} from '@src/core'
import {
	acceptRecognition,
	ObservationCounter,
	captureContractError,
	ForgedBrandDeclaration,
	NullBaseDeclaration,
	replaceIntrinsic,
	throwReplacement,
} from '../../setup.js'
import { createForeignRecord } from '../../setupServer.js'
import { describe, expect, it } from 'vitest'

describe('cloneJSONValue', () => {
	it('keeps finite primitives, exposes one-argument functions, and narrows record roots', () => {
		for (const value of [
			null,
			'',
			'value',
			true,
			false,
			0,
			-0,
			Number.MIN_VALUE,
			Number.MAX_VALUE,
		]) {
			expect(Object.is(cloneJSONValue(value), value)).toBe(true)
		}

		const record: JSONRecord = cloneJSONRecord({ attempt: 1 })
		expect(record).toEqual({ attempt: 1 })
		expect(Object.getPrototypeOf(record)).toBeNull()
		expect(Object.isFrozen(record)).toBe(true)

		const emptyArray = cloneJSONValue(Object.freeze([]))
		expect(emptyArray).toEqual([])
		expect(Object.getPrototypeOf(emptyArray)).toBe(Array.prototype)
		expect(Object.isFrozen(emptyArray)).toBe(true)

		const emptySource: Record<string, unknown> = Object.create(null)
		const emptyRecord = cloneJSONRecord(emptySource)
		expect(Reflect.ownKeys(emptyRecord)).toEqual([])
		expect(Object.getPrototypeOf(emptyRecord)).toBeNull()
		expect(Object.isFrozen(emptyRecord)).toBe(true)

		for (const value of [null, [], 'record']) {
			const error = captureContractError(() => cloneJSONRecord(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}

		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const error = captureContractError(() => cloneJSONValue(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}
	})

	it('creates a deeply frozen caller-independent graph with normalized prototypes', () => {
		const source = { nested: [{ value: 'stable' }] }
		const clone = cloneJSONValue(source)

		const first = source.nested[0]
		if (first === undefined) throw new Error('expected source child')
		first.value = 'mutated'
		source.nested.push({ value: 'added' })
		expect(clone).toEqual({ nested: [{ value: 'stable' }] })
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(Object.getPrototypeOf(clone)).toBeNull()
		if (!isRecord(clone)) return

		const nested: unknown = clone.nested
		expect(Array.isArray(nested)).toBe(true)
		if (!Array.isArray(nested)) return
		expect(nested).not.toBe(source.nested)
		expect(Object.getPrototypeOf(nested)).toBe(Array.prototype)
		expect(Object.isFrozen(nested)).toBe(true)

		const child: unknown = nested[0]
		expect(isRecord(child)).toBe(true)
		if (!isRecord(child)) return
		expect(child).not.toBe(source.nested[0])
		expect(Object.getPrototypeOf(child)).toBeNull()
		expect(Object.isFrozen(child)).toBe(true)
	})

	it('creates a fresh composite snapshot for every eager call', () => {
		const observations = new ObservationCounter()
		const source = new Proxy(
			{ nested: [1] },
			{
				ownKeys(target) {
					observations.increment()
					return Reflect.ownKeys(target)
				},
			},
		)

		const first = cloneJSONValue(source)
		const afterFirst = observations.value
		const second = cloneJSONValue(source)

		expect(second).not.toBe(first)
		expect(second).toEqual(first)
		expect(observations.value).toBeGreaterThan(afterFirst)
	})

	it('preserves __proto__ as own data in deterministic key order', () => {
		const special: Record<string, unknown> = Object.create(null)
		special.first = 1
		Object.defineProperty(special, '__proto__', {
			value: 'data',
			enumerable: true,
			configurable: true,
			writable: true,
		})
		special.last = 2
		const clone = cloneJSONRecord(special)

		expect(Object.getPrototypeOf(clone)).toBeNull()
		expect(Object.prototype.hasOwnProperty.call(clone, '__proto__')).toBe(true)
		expect(Reflect.get(clone, '__proto__')).toBe('data')
		expect(Reflect.ownKeys(clone)).toEqual(['first', '__proto__', 'last'])
	})

	it('duplicates repeated noncyclic aliases as independent JSON tree branches', () => {
		const shared = { nested: [1, 2, 3] }
		const clone = cloneJSONRecord({ first: shared, second: shared })

		expect(clone.first).toEqual(clone.second)
		expect(clone.first).not.toBe(clone.second)
		if (!isRecord(clone.first) || !isRecord(clone.second)) {
			throw new Error('expected cloned records')
		}
		expect(clone.first.nested).not.toBe(clone.second.nested)
		expect(Object.isFrozen(clone.first)).toBe(true)
		expect(Object.isFrozen(clone.second)).toBe(true)
	})

	it('rejects direct and indirect cycles', () => {
		const direct: unknown[] = []
		direct.push(direct)
		const first: Record<string, unknown> = {}
		const second: Record<string, unknown> = { first }
		first.second = second

		for (const value of [direct, first]) {
			const error = captureContractError(() => cloneJSONValue(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}
	})

	it('accepts realm-agnostic record and array brands but rejects custom records', () => {
		const foreignRecord = createForeignRecord()
		const foreignArray: unknown[] = [foreignRecord]
		Object.setPrototypeOf(foreignArray, null)

		expect(isRecord(foreignRecord)).toBe(true)
		expect(Array.isArray(foreignArray)).toBe(true)
		expect(foreignArray instanceof Array).toBe(false)

		const clone = cloneJSONValue(foreignArray)
		expect(Array.isArray(clone)).toBe(true)
		if (!Array.isArray(clone)) throw new Error('expected cloned array')
		expect(Object.getPrototypeOf(clone)).toBe(Array.prototype)
		expect(Object.isFrozen(clone)).toBe(true)
		expect(isRecord(clone[0])).toBe(true)
		if (!isRecord(clone[0])) throw new Error('expected cloned record')
		expect(Object.getPrototypeOf(clone[0])).toBeNull()

		const frozen = Object.freeze([7])
		const frozenDescriptor = Reflect.getOwnPropertyDescriptor(frozen, '0')
		expect(frozenDescriptor?.writable).toBe(false)
		expect(frozenDescriptor?.configurable).toBe(false)
		const frozenClone = cloneJSONValue(frozen)
		expect(frozenClone).toEqual([7])
		expect(frozenClone).not.toBe(frozen)
		expect(Object.isFrozen(frozenClone)).toBe(true)

		class Value {
			readonly value = 1
		}
		const custom = Object.create({})
		const simulated = Object.create(Object.create(null))
		for (const value of [new Value(), custom, simulated, new NullBaseDeclaration()]) {
			expect(isRecord(value)).toBe(false)
			const error = captureContractError(() => cloneJSONValue(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}
	})

	it('rejects inexact properties and unsupported values without invoking accessors', () => {
		const accesses = new ObservationCounter()
		const sparse = new Array<unknown>(2)
		sparse[0] = 'present'

		const extra: unknown[] = []
		Object.defineProperty(extra, 'extra', {
			value: true,
			enumerable: true,
			configurable: true,
			writable: true,
		})

		const arrayAccessor: unknown[] = []
		Object.defineProperty(arrayAccessor, '0', {
			enumerable: true,
			configurable: true,
			get() {
				accesses.increment()
				return 'unsafe'
			},
		})

		const hiddenIndex: unknown[] = ['hidden']
		Object.defineProperty(hiddenIndex, '0', {
			value: 'hidden',
			enumerable: false,
			configurable: true,
			writable: true,
		})

		const recordAccessor: Record<string, unknown> = {}
		Object.defineProperty(recordAccessor, 'value', {
			enumerable: true,
			configurable: true,
			get() {
				accesses.increment()
				return 'unsafe'
			},
		})

		const hiddenRecord: Record<string, unknown> = {}
		Object.defineProperty(hiddenRecord, 'value', {
			value: 'hidden',
			enumerable: false,
			configurable: true,
			writable: true,
		})

		const symbolRecord: Record<string, unknown> = {}
		Object.defineProperty(symbolRecord, Symbol('value'), {
			value: 'symbol',
			enumerable: true,
			configurable: true,
			writable: true,
		})

		const symbolArray: unknown[] = []
		Object.defineProperty(symbolArray, Symbol('value'), {
			value: 'symbol',
			enumerable: false,
			configurable: true,
			writable: true,
		})

		const invalid: readonly unknown[] = [
			sparse,
			extra,
			arrayAccessor,
			hiddenIndex,
			recordAccessor,
			hiddenRecord,
			symbolRecord,
			symbolArray,
			undefined,
			Math.max,
			Symbol('unsupported'),
			1n,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
		]

		for (const value of invalid) {
			const error = captureContractError(() => cloneJSONValue(value))
			expect(error.code).toBe('clone')
			expect(error.context?.shape).toBe('json')
		}
		expect(accesses.value).toBe(0)
	})

	it('rejects an array proxy that substitutes a decoration for a canonical index key', () => {
		const source = [7]
		Object.defineProperty(source, 'decoration', {
			value: true,
			enumerable: true,
			configurable: true,
			writable: true,
		})
		const substituted = new Proxy(source, {
			ownKeys() {
				return ['length', 'decoration']
			},
		})

		const first = captureContractError(() => cloneJSONValue(substituted))
		const second = captureContractError(() => cloneJSONValue(substituted))
		expect(first).not.toBe(second)
		expect(first.code).toBe('clone')
		expect(first.context?.shape).toBe('json')
		expect(Object.hasOwn(first, 'cause')).toBe(false)
	})

	it('replaces hostile reflective throws with distinct cause-free clone errors', () => {
		const callerObject = { caller: true }
		const callerError = new ContractError('caller', { code: 'clone' })
		const primitiveTrap = new Proxy(
			{},
			{
				ownKeys() {
					throw 'primitive'
				},
			},
		)
		const objectTrap = new Proxy(
			{ value: 1 },
			{
				getOwnPropertyDescriptor() {
					throw callerObject
				},
			},
		)
		const errorTrap = new Proxy(
			{},
			{
				ownKeys() {
					throw callerError
				},
			},
		)
		const revoked = Proxy.revocable<Record<string, unknown>>({}, {})
		revoked.revoke()

		for (const value of [primitiveTrap, objectTrap, errorTrap, revoked.proxy]) {
			const first = captureContractError(() => cloneJSONValue(value))
			const second = captureContractError(() => cloneJSONValue(value))
			expect(first).not.toBe(second)
			expect(first).not.toBe(callerError)
			expect(first.code).toBe('clone')
			expect(first.context?.shape).toBe('json')
			expect(Object.hasOwn(first, 'cause')).toBe(false)
		}

		const recordError = new ContractError('record caller', { code: 'clone' })
		const recordTrap = new Proxy(
			{},
			{
				getPrototypeOf() {
					throw recordError
				},
			},
		)
		const contained = captureContractError(() => cloneJSONRecord(recordTrap))
		expect(contained).not.toBe(recordError)
		expect(contained.code).toBe('clone')
		expect(contained.context?.shape).toBe('json')
		expect(Object.hasOwn(contained, 'cause')).toBe(false)
	})

	it('clones deeply nested input without recursive call-stack pressure', () => {
		const depth = 20_000
		const source = Array.from({ length: depth }).reduce<unknown>((child) => [child], 'leaf')

		const clone = cloneJSONValue(source)
		const current = Array.from({ length: depth }).reduce<unknown>((child, _, index) => {
			if (!Array.isArray(child)) throw new Error(`expected array at depth ${index}`)
			if (!Object.isFrozen(child)) throw new Error(`expected frozen array at depth ${index}`)
			return child[0]
		}, clone)
		expect(current).toBe('leaf')
	})

	it('refuses at the root with the empty path and no suffix', () => {
		const unreadable = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('root keys')
				},
			},
		)

		const refusals = [unreadable, undefined].map((value) => {
			const error = captureContractError(() => cloneJSONValue(value))
			return { message: error.message, context: error.context }
		})

		expect(refusals).toEqual([
			{
				message: 'cloneJSONValue: own keys could not be inspected',
				context: { shape: 'json', path: [], received: 'object' },
			},
			{
				message: 'cloneJSONValue: value is not JSON data',
				context: { shape: 'json', path: [], received: 'undefined' },
			},
		])
	})

	it('renders a report and a refusal the same while every rebuilt array member throws', () => {
		const schema = compileSchema(
			objectShape({
				units: literalShape(['metric', 'imperial']),
				mode: unionShape(literalShape(['fast']), objectShape({ 'top speed': stringShape() })),
			}),
		)
		const faults: readonly AuditFault[] = [
			{ reason: 'extra', path: ['note'] },
			{ reason: 'type', path: ['units'], expected: 'literal', received: '"kelvin"' },
			{ reason: 'variant', path: ['mode'], variants: 2 },
			{
				reason: 'missing',
				path: [
					'northernDistributionWarehouse',
					'refrigeratedInventorySection',
					'temperatureControlledShelving',
					'perishableGoodsReceivingDock',
					'arrivalTemperatureReading',
				],
				expected: 'number',
			},
		]
		const source = { rows: [{ 'unit price': Math.max }] }
		const honest = {
			report: describeFaults(faults, schema),
			refusal: captureContractError(() => cloneJSONValue(source)).message,
		}
		const members: readonly PropertyKey[] = [
			'filter',
			'flatMap',
			'every',
			'some',
			'includes',
			'toSorted',
			'reduce',
			'map',
			'join',
			'slice',
			Symbol.iterator,
		]
		const replaced = members.reduceRight<
			() => { readonly report: string; readonly refusal: string }
		>(
			(operation, key) => () => replaceIntrinsic(Array.prototype, key, throwReplacement, operation),
			() => ({
				report: describeFaults(faults, schema),
				refusal: captureContractError(() => cloneJSONValue(source)).message,
			}),
		)()

		expect(honest.report).toContain('northernDistributionWarehouse.….')
		expect(replaced).toEqual(honest)
	})

	it('renders a refusal and a fault report the same while array and pattern members are replaced', () => {
		const source = { rows: [{ 'unit price': Math.max }] }
		const schema = compileSchema(
			objectShape({
				city: stringShape({ min: 1 }),
				units: literalShape(['metric', 'imperial']),
				mode: unionShape(literalShape(['fast']), objectShape({ 'top speed': stringShape() })),
			}),
		)
		const faults: readonly AuditFault[] = [
			{ reason: 'extra', path: ['note'] },
			{ reason: 'type', path: ['units'], expected: 'literal', received: '"kelvin"' },
			{ reason: 'missing', path: ['city'], expected: 'string' },
			{ reason: 'variant', path: ['mode'], variants: 2 },
		]
		const honest = {
			message: captureContractError(() => cloneJSONValue(source)).message,
			report: describeFaults(faults, schema),
		}
		const members: ReadonlyArray<readonly [object, string]> = [
			[Array.prototype, 'join'],
			[Array.prototype, 'map'],
			[Array.prototype, 'slice'],
			[RegExp.prototype, 'test'],
		]

		const readings = members.map(([target, key]) =>
			replaceIntrinsic(target, key, acceptRecognition, () => ({
				message: captureContractError(() => cloneJSONValue(source)).message,
				report: describeFaults(faults, schema),
			})),
		)

		expect(honest.message).toBe('cloneJSONValue: property is not JSON data at rows.0."unit price"')
		expect(readings).toEqual(members.map(() => honest))
	})

	it('encodes a line feed in a key while RegExp.prototype.test answers true', () => {
		const error = replaceIntrinsic(RegExp.prototype, 'test', acceptRecognition, () =>
			captureContractError(() => cloneJSONValue({ 'line\nbreak': Math.max })),
		)

		expect(error.message).toBe('cloneJSONValue: property is not JSON data at "line\\nbreak"')
		expect(error.context?.path).toEqual(['line\nbreak'])
	})

	it('names a refused root with its empty path and received preview through cloneJSONRecord', () => {
		const refusals = [['a'], null].map((value) => {
			const error = captureContractError(() => cloneJSONRecord(value))
			return { code: error.code, message: error.message, context: error.context }
		})

		expect(refusals).toEqual([
			{
				code: 'clone',
				message: 'cloneJSONRecord: value is not a plain record',
				context: { shape: 'json', path: [], received: 'array' },
			},
			{
				code: 'clone',
				message: 'cloneJSONRecord: value is not a plain record',
				context: { shape: 'json', path: [], received: 'null' },
			},
		])
	})

	it('names the refused member of a nested record with its complete path through cloneJSONRecord', () => {
		const accesses = new ObservationCounter()
		const accessor = captureContractError(() =>
			cloneJSONRecord({
				a: {
					get b() {
						accesses.increment()
						return 1
					},
				},
			}),
		)
		const symbol = captureContractError(() => cloneJSONRecord({ a: { [Symbol('s')]: 1 } }))
		const spelled = captureContractError(() => cloneJSONRecord({ a: { 'Symbol(s)': () => 1 } }))

		expect(accesses.value).toBe(0)
		expect(
			[accessor, symbol, spelled].map(({ message, context }) => ({ message, context })),
		).toEqual([
			{
				message: 'cloneJSONValue: record property is not enumerable data at a.b',
				context: { shape: 'json', path: ['a', 'b'], received: 'accessor' },
			},
			{
				message: 'cloneJSONValue: record has a symbol property Symbol(s) at a',
				context: { shape: 'json', path: ['a'], received: 'Symbol(s)' },
			},
			{
				message: 'cloneJSONValue: property is not JSON data at a."Symbol(s)"',
				context: { shape: 'json', path: ['a', 'Symbol(s)'], received: 'function' },
			},
		])
	})

	it('names every refused member or container with its complete path and received value', () => {
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()
		const unreadableRecord = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('record keys')
				},
			},
		)
		const unreadableArray = new Proxy([], {
			ownKeys() {
				throw new Error('array keys')
			},
		})
		const unreadableLength = new Proxy([], {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'length') throw new Error('array length')
				return Reflect.getOwnPropertyDescriptor(target, key)
			},
		})
		const fractionalLength = new Proxy([], {
			getOwnPropertyDescriptor(target, key) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
				return key === 'length' ? { ...descriptor, value: 0.5 } : descriptor
			},
		})
		const decorated: unknown[] = [1]
		Object.defineProperty(decorated, 'ghost', { value: 2, enumerable: true, configurable: true })
		const unreadableIndex = new Proxy([1], {
			getOwnPropertyDescriptor(target, key) {
				if (key === '0') throw new Error('array index')
				return Reflect.getOwnPropertyDescriptor(target, key)
			},
		})
		const accessorIndex: unknown[] = []
		Object.defineProperty(accessorIndex, '0', {
			enumerable: true,
			configurable: true,
			get: () => 1,
		})
		const hiddenIndex: unknown[] = ['hidden']
		Object.defineProperty(hiddenIndex, '0', { enumerable: false })
		const unreadableProperty = new Proxy(
			{ value: 1 },
			{
				getOwnPropertyDescriptor() {
					throw new Error('record property')
				},
			},
		)
		const hiddenProperty = Object.defineProperty({}, 'value', { value: 'hidden' })
		const vanishedProperty = new Proxy(
			{},
			{
				ownKeys() {
					return ['ghost']
				},
				getOwnPropertyDescriptor() {
					return undefined
				},
			},
		)
		const cases: ReadonlyArray<{
			readonly value: unknown
			readonly message: string
			readonly path: readonly string[]
			readonly received: unknown
		}> = [
			{
				value: { note: undefined },
				message: 'property is not JSON data at rows.0.note',
				path: ['rows', '0', 'note'],
				received: 'undefined',
			},
			{
				value: Number.NaN,
				message: 'number is not finite at rows.0',
				path: ['rows', '0'],
				received: 'NaN',
			},
			{
				value: cyclic,
				message: 'cycle detected at rows.0.self',
				path: ['rows', '0', 'self'],
				received: 'object',
			},
			{
				value: revoked.proxy,
				message: 'value brand could not be inspected at rows.0',
				path: ['rows', '0'],
				received: expect.any(String),
			},
			{
				value: new Map(),
				message: 'object is not a plain record at rows.0',
				path: ['rows', '0'],
				received: expect.any(String),
			},
			{
				value: unreadableRecord,
				message: 'own keys could not be inspected at rows.0',
				path: ['rows', '0'],
				received: 'object',
			},
			{
				value: unreadableArray,
				message: 'own keys could not be inspected at rows.0',
				path: ['rows', '0'],
				received: 'array',
			},
			{
				value: unreadableLength,
				message: 'array length could not be inspected at rows.0',
				path: ['rows', '0'],
				received: 'array',
			},
			{
				value: fractionalLength,
				message: 'array is not intrinsic and dense at rows.0',
				path: ['rows', '0'],
				received: 'array',
			},
			{
				value: decorated,
				message: 'array own keys are not exact at rows.0',
				path: ['rows', '0'],
				received: 'array',
			},
			{
				value: unreadableIndex,
				message: 'array index could not be inspected at rows.0.0',
				path: ['rows', '0', '0'],
				received: 'threw',
			},
			{
				value: accessorIndex,
				message: 'array index is not enumerable data at rows.0.0',
				path: ['rows', '0', '0'],
				received: 'accessor',
			},
			{
				value: hiddenIndex,
				message: 'array index is not enumerable data at rows.0.0',
				path: ['rows', '0', '0'],
				received: '"hidden"',
			},
			{
				value: unreadableProperty,
				message: 'record property could not be inspected at rows.0.value',
				path: ['rows', '0', 'value'],
				received: 'threw',
			},
			{
				value: hiddenProperty,
				message: 'record property is not enumerable data at rows.0.value',
				path: ['rows', '0', 'value'],
				received: '"hidden"',
			},
			{
				value: vanishedProperty,
				message: 'record property is not enumerable data at rows.0.ghost',
				path: ['rows', '0', 'ghost'],
				received: 'undefined',
			},
			{
				value: { [Symbol('s')]: 1 },
				message: 'record has a symbol property Symbol(s) at rows.0',
				path: ['rows', '0'],
				received: 'Symbol(s)',
			},
		]

		const refusals = cases.map(({ value }) => {
			const error = captureContractError(() => cloneJSONValue({ rows: [value] }))
			return { code: error.code, message: error.message, context: error.context }
		})

		expect(refusals).toEqual(
			cases.map(({ message, path, received }) => ({
				code: 'clone',
				message: `cloneJSONValue: ${message}`,
				context: { shape: 'json', path, received },
			})),
		)
	})

	it('encodes a caller key in the refusal text while the path holds the whole key', () => {
		const long = 'k'.repeat(200)
		const broken = captureContractError(() => cloneJSONValue({ 'line\nbreak': () => 1 }))
		const returned = captureContractError(() => cloneJSONValue({ rows: [{ 'carriage\r': 1n }] }))
		const bounded = captureContractError(() => cloneJSONValue({ [long]: Math.max }))
		const separated = captureContractError(() =>
			cloneJSONValue({ 'line\u{2028}separator': () => 1 }),
		)
		const head = 'cloneJSONValue: property is not JSON data at '

		expect(broken.message).toBe('cloneJSONValue: property is not JSON data at "line\\nbreak"')
		expect(broken.context?.path).toEqual(['line\nbreak'])
		expect(returned.message).toBe(
			'cloneJSONValue: property is not JSON data at rows.0."carriage\\r"',
		)
		expect(returned.context?.path).toEqual(['rows', '0', 'carriage\r'])
		expect(bounded.message.startsWith(head)).toBe(true)
		expect(bounded.message.length).toBeLessThanOrEqual(head.length + PREVIEW_LIMIT + 2)
		expect(bounded.context?.path).toEqual([long])
		expect(separated.message).toBe(
			'cloneJSONValue: property is not JSON data at "line\\u2028separator"',
		)
		expect(separated.context?.path).toEqual(['line\u{2028}separator'])
		for (const error of [broken, returned, bounded, separated]) {
			expect(error.message).not.toMatch(/[\n\r\u2028\u2029]/u)
		}
	})

	it('refuses with one located message and context through both doors', () => {
		const cases: ReadonlyArray<{
			readonly source: unknown
			readonly message: string
			readonly path: readonly string[]
			readonly received: string
		}> = [
			{
				source: { a: { b: Math.max } },
				message: 'property is not JSON data at a.b',
				path: ['a', 'b'],
				received: 'function',
			},
			{
				source: { settings: { [Symbol('s')]: 1 } },
				message: 'record has a symbol property Symbol(s) at settings',
				path: ['settings'],
				received: 'Symbol(s)',
			},
			{
				source: { a: [1, Number.POSITIVE_INFINITY] },
				message: 'number is not finite at a.1',
				path: ['a', '1'],
				received: 'Infinity',
			},
		]

		const refusals = cases.map(({ source }) =>
			[cloneJSONValue, cloneJSONRecord].map((door) => {
				const error = captureContractError(() => door(source))
				return { code: error.code, message: error.message, context: error.context }
			}),
		)

		expect(refusals).toEqual(
			cases.map(({ message, path, received }) => {
				const refusal = {
					code: 'clone',
					message: `cloneJSONValue: ${message}`,
					context: { shape: 'json', path, received },
				}
				return [refusal, refusal]
			}),
		)
	})
})

describe('cloneSchema', () => {
	it('creates fresh eager successes and rereads the source', () => {
		const observations = new ObservationCounter()
		const source = new Proxy<JSONSchema>(
			{ type: 'string' },
			{
				ownKeys(target) {
					observations.increment()
					return Reflect.ownKeys(target)
				},
			},
		)

		const first = cloneSchema(source)
		const afterFirst = observations.value
		const second = cloneSchema(source)

		expect(second).not.toBe(first)
		expect(second).toEqual(first)
		expect(observations.value).toBeGreaterThan(afterFirst)
	})

	it('creates fresh eager failures while retaining the exact property cause', () => {
		const cause = new Error('property failure')
		const source: JSONSchema = {}
		Object.defineProperty(source, 'type', {
			enumerable: true,
			get() {
				throw cause
			},
		})

		const first = captureContractError(() => cloneSchema(source))
		const second = captureContractError(() => cloneSchema(source))

		expect(second).not.toBe(first)
		expect(first.message).toBe(second.message)
		expect(first.context).toEqual(second.context)
		expect(first.cause).toBe(cause)
		expect(second.cause).toBe(cause)
	})

	it('matches the class for shared cycles and hostile property reads', () => {
		const child: JSONSchema = { type: 'integer' }
		const source: JSONSchema = { anyOf: [child, child] }
		Reflect.set(source, 'self', source)
		const direct = new SchemaCloner(source).clone()
		const eager = cloneSchema(source)

		expect(direct).toEqual(eager)
		expect(direct.anyOf?.[0]).toBe(direct.anyOf?.[1])
		expect(eager.anyOf?.[0]).toBe(eager.anyOf?.[1])
		expect(Reflect.get(direct, 'self')).toBe(direct)
		expect(Reflect.get(eager, 'self')).toBe(eager)

		const cause = { reason: 'hostile' }
		const hostile: JSONSchema = {}
		Object.defineProperty(hostile, 'type', {
			enumerable: true,
			get() {
				throw cause
			},
		})
		const directError = captureContractError(() => new SchemaCloner(hostile).clone())
		const eagerError = captureContractError(() => cloneSchema(hostile))

		expect(directError).not.toBe(eagerError)
		expect(directError.message).toBe(eagerError.message)
		expect(directError.context).toEqual(eagerError.context)
		expect(directError.cause).toBe(cause)
		expect(eagerError.cause).toBe(cause)
	})
})

describe('cloneShape', () => {
	it('preserves the string overload while returning a frozen runtime snapshot', () => {
		const source = stringShape({ min: 1 })
		const clone: StringShape = cloneShape(source)

		expect(clone).toEqual(source)
		expect(clone).not.toBe(source)
		expect(Object.isFrozen(clone)).toBe(true)
	})

	it('creates fresh roots and re-observes the source on every eager call', () => {
		const child: { category: 'string'; min?: number } = { category: 'string', min: 1 }
		const source: ContractShape = { category: 'object', properties: { child } }

		const first = cloneShape(source)
		child.min = 2
		const second = cloneShape(source)

		expect(first).not.toBe(second)
		if (first.category !== 'object' || second.category !== 'object') {
			throw new Error('expected object snapshots')
		}
		expect(first.properties.child).not.toBe(second.properties.child)
		expect(first.properties.child).toEqual({ category: 'string', min: 1 })
		expect(second.properties.child).toEqual({ category: 'string', min: 2 })
	})

	it('creates a fresh contained failure on every eager call', () => {
		const cause = new Error('hostile minimum')
		const target: ContractShape = { category: 'number' }
		const source = new Proxy(target, {
			getOwnPropertyDescriptor() {
				throw cause
			},
		})

		const first = captureContractError(() => cloneShape(source))
		const second = captureContractError(() => cloneShape(source))

		expect(first).not.toBe(second)
		expect(first.code).toBe('clone')
		expect(first.message).toBe('cloneShape: failed to create an owned shape snapshot')
		expect(first.cause).toBe(cause)
		expect(second.cause).toBe(cause)
	})

	it('matches fresh direct-class snapshots across a compact shape corpus', () => {
		const shared = stringShape({ min: 1 })
		const shapes: readonly ContractShape[] = [
			stringShape({ pattern: /^stable$/ }),
			objectShape({ first: shared, second: shared }),
			unionShape(stringShape(), { category: 'raw', schema: { type: 'number' } }),
		]

		for (const shape of shapes) {
			const eager = cloneShape(shape)
			const direct = new ShapeCloner(shape).clone()

			expect(eager).toEqual(direct)
			expect(eager).not.toBe(direct)
		}
	})
})

describe('ownShape', () => {
	it('prefers a frozen source validation ContractError over the original clone failure', () => {
		const cause = new Error('first minimum read')
		const reads = new ObservationCounter()
		const target: ContractShape = { category: 'number' }
		Object.defineProperty(target, 'min', {
			enumerable: true,
			get() {
				return 'invalid'
			},
		})
		Object.freeze(target)
		const source = new Proxy(target, {
			getOwnPropertyDescriptor(sourceTarget, property) {
				if (property === 'min') {
					reads.increment()
					if (reads.value === 2) throw cause
				}
				return Reflect.getOwnPropertyDescriptor(sourceTarget, property)
			},
		})

		const error = captureContractError(() => ownShape(source))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('validateShape: every node must be a recognized shape')
		expect(Object.hasOwn(error, 'cause')).toBe(false)
	})

	it('keeps an unfrozen eager clone failure unchanged', () => {
		const cause = new Error('hostile minimum')
		const target: ContractShape = { category: 'number' }
		const source = new Proxy(target, {
			getOwnPropertyDescriptor() {
				throw cause
			},
		})

		const error = captureContractError(() => ownShape(source))

		expect(error.code).toBe('clone')
		expect(error.cause).toBe(cause)
	})

	it('returns independent successful snapshots for frozen and unfrozen sources', () => {
		const child: ContractShape = { category: 'string' }
		const unfrozen: ContractShape = {
			category: 'object',
			properties: { first: child, second: child },
		}
		const frozen = Object.freeze({
			category: 'object',
			properties: { first: child, second: child },
		}) satisfies ContractShape

		for (const source of [unfrozen, frozen]) {
			const first = ownShape(source)
			const second = ownShape(source)

			expect(first).not.toBe(source)
			expect(first).not.toBe(second)
			if (first.category !== 'object' || second.category !== 'object') {
				throw new Error('expected object snapshots')
			}
			expect(first.properties.first).toBe(first.properties.second)
			expect(first.properties.first).not.toBe(child)
			expect(first.properties.first).not.toBe(second.properties.first)
		}
	})
})

describe('eager ownership boundaries — reparented class brands', () => {
	it('refuses a null-base class instance at every eager shape and JSON door', () => {
		const doors = Object.freeze([
			{ name: 'cloneShape', operation: () => cloneShape(new NullBaseDeclaration()) },
			{ name: 'ownShape', operation: () => ownShape(new NullBaseDeclaration()) },
			{ name: 'cloneJSONValue', operation: () => cloneJSONValue(new NullBaseDeclaration()) },
			{ name: 'cloneJSONRecord', operation: () => cloneJSONRecord(new NullBaseDeclaration()) },
		])

		const observed = doors.map((door) => {
			const error = captureContractError(door.operation)
			return { name: door.name, code: error.code, caused: Object.hasOwn(error, 'cause') }
		})

		expect(observed).toEqual([
			{ name: 'cloneShape', code: 'structure', caused: false },
			{ name: 'ownShape', code: 'structure', caused: false },
			{ name: 'cloneJSONValue', code: 'clone', caused: false },
			{ name: 'cloneJSONRecord', code: 'clone', caused: false },
		])
	})

	it('accepts a forged record brand at every eager shape and JSON door, owning only plain data', () => {
		// The counterpart of the refusal above, and the exact limit of it: a
		// reparented class prototype is refused, and the SAME prototype stamped
		// with the mandated realm members is not, because nothing observable from
		// outside a realm separates the two. The forgery buys acceptance, and the
		// snapshots published are still owned plain data.
		const doors: ReadonlyArray<{ readonly name: string; readonly operation: () => unknown }> =
			Object.freeze([
				{ name: 'cloneShape', operation: () => cloneShape(new ForgedBrandDeclaration()) },
				{ name: 'ownShape', operation: () => ownShape(new ForgedBrandDeclaration()) },
				{ name: 'cloneJSONValue', operation: () => cloneJSONValue(new ForgedBrandDeclaration()) },
				{ name: 'cloneJSONRecord', operation: () => cloneJSONRecord(new ForgedBrandDeclaration()) },
			])

		const observed = doors.map((door) => {
			const outcome = attempt(door.operation)
			return {
				name: door.name,
				accepted: outcome.success,
				value: outcome.success ? outcome.value : undefined,
			}
		})

		expect(observed).toEqual([
			{ name: 'cloneShape', accepted: true, value: { category: 'string', min: 1 } },
			{ name: 'ownShape', accepted: true, value: { category: 'string', min: 1 } },
			{ name: 'cloneJSONValue', accepted: true, value: { category: 'string', min: 1 } },
			{ name: 'cloneJSONRecord', accepted: true, value: { category: 'string', min: 1 } },
		])
	})

	it('owns a reparented class instance as schema data because no brand rule governs a schema graph', () => {
		// cloneSchema is the one ownership door that never consults the record
		// brand: it snapshots an arbitrary readable graph, and its output is
		// already an owned null-prototype record, so nothing class-branded
		// survives the call.
		// A shape declaration is not a JSON Schema, so this door is driven reflectively to put
		// the same reparented instance the shape doors refuse through the schema door.
		const owned: JSONSchema = Reflect.apply(cloneSchema, undefined, [new NullBaseDeclaration()])

		expect(owned).toEqual({ category: 'string', min: 1 })
		expect(Object.getPrototypeOf(owned)).toBeNull()
		expect(Object.isFrozen(owned)).toBe(true)
	})
})

describe('date string shapes', () => {
	it('keeps date through cloneShape, ownShape, and ShapeCloner', () => {
		const authored: StringShape = { category: 'string', min: 10, date: true }

		expect(cloneShape(authored)).toEqual(authored)
		expect(ownShape(authored)).toEqual(authored)
		expect(cloneShape(dateShape())).toEqual({ category: 'string', date: true })
		expect(ownShape(dateShape())).toEqual({ category: 'string', date: true })
		expect(new ShapeCloner(dateShape()).clone()).toEqual({ category: 'string', date: true })
		expect(
			captureContractError(() =>
				Reflect.apply(cloneShape, undefined, [{ category: 'string', date: 'yes' }]),
			).message,
		).toContain('date')
	})
})
