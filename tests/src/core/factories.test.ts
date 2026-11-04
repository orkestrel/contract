import type { AuditorFunction, ContractInterface, ContractShape, ReporterFunction } from '@src/core'
import {
	arrayShape,
	attempt,
	booleanShape,
	compileAuditor,
	compileGenerator,
	compileGuard,
	compileReporter,
	createContract,
	integerShape,
	isString,
	jsonShape,
	nullShape,
	numberShape,
	objectShape,
	optionalShape,
	parseString,
	recordShape,
	seededRandom,
	stringShape,
	unionShape,
	validateShape,
} from '@src/core'
import {
	callAtStackLimit,
	captureContractError,
	measureWalks,
	pollutePrototype,
	readVerdict,
	replaceAccessor,
	replaceIntrinsic,
	throwReplacement,
} from '../../setup.js'
import { describe, expect, it } from 'vitest'

const ROOTS = ['schema', 'is', 'parse', 'audit', 'explain', 'generate'] as const

describe('createContract — eager bundle', () => {
	it('publishes plain data properties rather than getters', () => {
		const contract = createContract(objectShape({ name: stringShape() }))

		const descriptors = ROOTS.map((root) => {
			const descriptor = Object.getOwnPropertyDescriptor(contract, root)
			return { root, data: Object.hasOwn(descriptor ?? {}, 'value'), accessor: descriptor?.get }
		})

		expect(descriptors).toEqual(ROOTS.map((root) => ({ root, data: true, accessor: undefined })))
	})

	it('carries the same artifact identities through destructuring and through a spread', () => {
		const contract = createContract(objectShape({ name: stringShape() }))
		const { is, parse } = contract
		const spread = { ...contract }

		expect(is).toBe(contract.is)
		expect(parse).toBe(contract.parse)
		expect(ROOTS.filter((root) => spread[root] !== contract[root])).toEqual([])
	})
})

describe('createContract — both declared overloads', () => {
	it('answers every root through the generic overload', () => {
		const contract = createContract(
			objectShape({ name: stringShape({ min: 1 }), age: integerShape({ min: 0 }) }),
		)

		expect(contract.schema.type).toBe('object')
		expect(contract.is({ name: 'Ada', age: 36 })).toBe(true)
		expect(contract.parse({ name: 'Ada', age: '36' })).toEqual({ name: 'Ada', age: 36 })
		expect(contract.audit({ name: 'Ada', age: 36 })).toEqual([])
		expect(contract.explain({ name: 'Ada', age: 36 })).toEqual([])
		expect(contract.is(contract.generate(() => 0.5))).toBe(true)
	})

	it('answers every root through the widened ContractShape overload', () => {
		const widened: ContractShape = objectShape({ name: stringShape({ min: 1 }) })
		const contract: ContractInterface<unknown> = createContract(widened)

		expect(contract.schema.type).toBe('object')
		expect(contract.is({ name: 'Ada' })).toBe(true)
		expect(contract.parse({ name: 'Ada' })).toEqual({ name: 'Ada' })
		// An absent required key faults in both reports; a coercible `name` would fault
		// in `audit` alone, because `explain` mirrors `parse` rather than `is`.
		expect(contract.audit({}).length).toBeGreaterThan(0)
		expect(contract.explain({}).length).toBeGreaterThan(0)
		expect(contract.is(contract.generate(() => 0.5))).toBe(true)
	})
})

describe('createContract — refusal', () => {
	it('refuses a malformed declaration at the call rather than at a member read', () => {
		const malformed: ContractShape = { category: 'string', min: 5, max: 1 }
		const outcome = attempt(() => createContract(malformed))

		// The refusal arrives with no bundle, so no member read can be the trigger.
		expect(outcome.success).toBe(false)
	})

	it('adopts the authoring door’s own diagnosis instead of rewrapping it', () => {
		const malformed: ContractShape = { category: 'string', min: 5, max: 1 }
		const published = captureContractError(() => createContract(malformed))
		const authored = captureContractError(() => validateShape(malformed))

		expect(published.message).toBe(authored.message)
		expect(published.code).toBe(authored.code)
		expect(published.context).toEqual(authored.context)
		// A rewrap would prefix the door that adopted the diagnosis and retain the
		// original as a cause; this door does neither.
		expect(published.message.startsWith('createContract:')).toBe(false)
		expect(Object.hasOwn(published, 'cause')).toBe(false)
	})
})

describe('createContract — door and getter agreement', () => {
	it('answers a corpus exactly as compileGuard answers it', () => {
		const shapes: readonly ContractShape[] = [
			stringShape({ min: 1, max: 3 }),
			integerShape({ min: 0, max: 9 }),
			booleanShape(),
			arrayShape(stringShape(), { min: 1 }),
			objectShape({ name: stringShape(), bio: optionalShape(stringShape()) }),
			unionShape(stringShape(), integerShape()),
		]
		const corpus: readonly unknown[] = [
			undefined,
			null,
			'',
			'ab',
			0,
			36,
			true,
			[],
			['a'],
			{},
			{ name: 'Ada' },
			{ name: 'Ada', bio: 'x' },
			{ name: 1 },
		]

		const doorReadings: boolean[] = []
		const getterReadings: boolean[] = []
		for (const shape of shapes) {
			const door = createContract(shape).is
			const getter = compileGuard(shape)
			for (const value of corpus) {
				doorReadings.push(door(value))
				getterReadings.push(getter(value))
			}
		}

		expect(doorReadings).toEqual(getterReadings)
		// The corpus exercises each answer, so agreement is not agreement on one verdict.
		expect(new Set(doorReadings)).toEqual(new Set([true, false]))
	})
})

describe('createContract — members compile on first use', () => {
	const shape = objectShape({
		text: stringShape(),
		count: numberShape(),
		either: unionShape(booleanShape(), nullShape()),
		list: arrayShape(stringShape()),
		map: recordShape(numberShape()),
		maybe: optionalShape(jsonShape()),
	})
	const valid = { text: 'a', count: 1, either: true, list: ['b'], map: { c: 2 } }

	it('compiles no function member of a built declaration until one is called', async () => {
		const { contractBuilt, contractHand, firstCall, firstCallHand } = await measureWalks()

		expect(contractBuilt).toBe(0)
		expect(firstCall).toBeGreaterThan(0)
		expect(contractHand).toBeGreaterThan(0)
		expect(firstCallHand).toBe(0)
	})

	it('keeps one identity for a member across its first call', () => {
		const contract = createContract(shape)
		const { is, parse, audit, explain, generate } = contract

		expect(is(valid)).toBe(true)
		expect([contract.is, contract.parse, contract.audit]).toEqual([is, parse, audit])
		expect([contract.explain, contract.generate]).toEqual([explain, generate])
		expect(is(valid)).toBe(true)
	})

	it('keeps a leaf contract on the package guard and parser', () => {
		const contract = createContract(stringShape())

		expect(contract.is).toBe(isString)
		expect(contract.parse).toBe(parseString)
	})

	it('hands a member the path it was given', () => {
		const contract = createContract(shape)
		const audit: AuditorFunction = contract.audit
		const explain: ReporterFunction = contract.explain
		const value = { ...valid, count: 'not a number' }
		const faults = explain(value, ['root'])

		expect(audit(value, ['root'])).toEqual(compileAuditor(shape, value, ['root']))
		expect(faults).toEqual(compileReporter(shape, value, ['root']))
		expect(faults[0]?.path[0]).toBe('root')
	})

	it('draws from the random source it was given', () => {
		const contract = createContract(shape)

		expect(contract.generate(seededRandom(7))).toEqual(compileGenerator(shape, seededRandom(7)))
		expect(contract.is(contract.generate())).toBe(true)
	})

	it('lets a read a parser refuses throw on the first call as on any other', () => {
		const hostile = new Proxy(
			{},
			{
				ownKeys() {
					throw new Error('hostile')
				},
			},
		)
		const compiled = createContract(shape)
		compiled.is(valid)

		expect(readVerdict(() => createContract(shape).parse(hostile))).toBe(
			readVerdict(() => compiled.parse(hostile)),
		)
	})

	it.each([
		'min',
		'max',
		'pattern',
		'description',
		'integer',
		'additionalProperties',
		'mode',
		'default',
	])('answers a first call under an inherited %s as a compiled contract does', (field) => {
		const compiled = createContract(shape)
		compiled.is(valid)
		const first = createContract(shape)
		const values = [valid, {}, { ...valid, text: 1 }, { ...valid, list: [] }, null]
		const answers = pollutePrototype(
			Object.prototype,
			field,
			// A maximum no text meets, and a minimum no number or text below it meets.
			() => (field === 'max' ? 0 : 3),
			() =>
				values.map((value) => ({
					is: [first.is(value), compiled.is(value)],
					parse: [first.parse(value), compiled.parse(value)],
					auditClean: first.audit(value).length === 0,
					explainClean: first.explain(value).length === 0,
				})),
		)

		expect(answers.map(({ is }) => is[0])).toEqual(answers.map(({ is }) => is[1]))
		expect(answers.map(({ parse }) => parse[0])).toEqual(answers.map(({ parse }) => parse[1]))
		expect(answers.map(({ auditClean }) => auditClean)).toEqual(answers.map(({ is }) => is[0]))
		expect(answers.map(({ explainClean }) => explainClean)).toEqual(
			answers.map(({ parse }) => parse[0] !== undefined),
		)
		expect(first.is(valid)).toBe(true)
		expect(first.audit(valid)).toEqual([])
	})

	it('recovers from a first call near the stack limit', () => {
		const contract = createContract(shape)

		// Retried in every frame on the way up until it answers, so some attempts run out
		// of stack part way through a compile.
		const answered = callAtStackLimit(() => {
			if (!contract.is(valid)) throw new Error('not yet')
			return true
		})

		expect(answered).toBe(true)
		expect(contract.is(valid)).toBe(true)
		expect(contract.parse(valid)).toBeDefined()
		expect(contract.audit(valid)).toEqual([])
	})

	it('compiles nothing on a host replaced after it was created, then recovers', () => {
		const contract = createContract(shape)
		const answers = replaceIntrinsic(Array.prototype, 'pop', throwReplacement, () => ({
			is: contract.is(valid),
			parse: contract.parse(valid),
			audit: readVerdict(() => contract.audit(valid)),
			explain: readVerdict(() => contract.explain(valid)),
			generate: readVerdict(() => contract.generate()),
		}))

		expect(answers.is).toBe(false)
		expect(answers.parse).toBeUndefined()
		expect(answers.audit).toContain('compileAuditor: a host member')
		expect(answers.explain).toContain('compileReporter: a host member')
		expect(answers.generate).toContain('compileGenerator: a host member')
		expect(contract.is(valid)).toBe(true)
		expect(contract.parse(valid)).toBeDefined()
		expect(contract.audit(valid)).toEqual([])
	})

	it('keeps no plan compiled while a flag getter lies', () => {
		const patterned = objectShape({ text: stringShape({ pattern: /^a/ }) })
		const contract = createContract(patterned)
		const during = replaceAccessor(
			RegExp.prototype,
			'global',
			() => true,
			() => contract.is({ text: 'a' }),
		)

		expect(during).toBe(false)
		expect(contract.is({ text: 'a' })).toBe(true)
		expect(contract.is({ text: 'a' })).toBe(true)
		expect(contract.is({ text: 'b' })).toBe(false)
	})
})
