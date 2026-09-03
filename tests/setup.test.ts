// The proof for `tests/setup.ts`. Its subject is the exported test
// infrastructure the workspace's suites drive: the error narrower, the
// redirection instruments and the corpora they arm, the fixture families, and
// the shape and sample factories. One case covers one behavioural contract, so
// the file is not a census of the module's names.
//
// Two things this proof deliberately does not do. It never re-asserts a
// published behaviour of `@src/core` — a door's verdict under an armed
// instrument belongs to the suite that drives the door. And it never derives an
// expectation the way the module derives it: every expected value here comes
// from a literal, from host reflection, or from a second mechanism that can
// disagree with the module.
import type { AuditFault, ContractShape, StringShape } from '@src/core'
import {
	arrayShape,
	ContractError,
	INFER_DEPTH_LIMIT,
	integerShape,
	literalShape,
	numberShape,
	objectShape,
	stringShape,
} from '@src/core'
import * as core from '@src/core'
import {
	ArrayRootSchema,
	BlankBrandDeclaration,
	buildCountedGraph,
	buildCountedSlots,
	buildCyclicArray,
	buildCyclicRecord,
	buildDeepNest,
	buildDeepShape,
	buildSharedDagShape,
	buildSparseArray,
	buildStaircaseShape,
	buildTree,
	buildTypeFault,
	buildWideVocabulary,
	captured,
	captureContractError,
	ClassSampleMemo,
	compileWidenedContract,
	compositeShape,
	createClassInstance,
	createHostileKeys,
	createInertOutcome,
	createNativeMaximumSparseArray,
	createNonEnumerableRecord,
	createNullPrototypeRecord,
	createInfiniteIterable,
	createOneShotIterable,
	createProxiedBrandDeclaration,
	createRevokedArrayProxy,
	createRevokedProxy,
	createSchemaRetention,
	createShapeRetention,
	createShapeValidationCase,
	createStatefulGetter,
	createThrowingGetter,
	createThrowingPrototype,
	createUndefinedSchema,
	createUnstableArray,
	createVariantRetention,
	createWorkBound,
	denyRecognition,
	DriftedMethods,
	buildJSONRoundtrip,
	buildLockstep,
	faultsToConstraints,
	findInstallationControls,
	findVacuousControls,
	fingerprintOwnership,
	forgeBlankBrand,
	forgeRecordBrand,
	ForgedBrandDeclaration,
	invalidSamplesFor,
	LateMutation,
	leafShapeVariations,
	lieIntrinsic,
	NullBaseDeclaration,
	ObservedShape,
	OWNED_MEMBERS,
	PatternFixture,
	pollutePrototype,
	ProxiedBrandDeclaration,
	publicDoors,
	RECORD_BRAND_MEMBERS,
	redirectIntrinsic,
	ReentrantPollution,
	ReentrantShape,
	replaceAccessor,
	replaceIntrinsic,
	replaceStringIterator,
	replaceStringSlice,
	SHAPE_SEPARATIONS,
	SingleReadPattern,
	SMUGGLED_KEY,
	SmuggledMember,
	SOUNDNESS_SAMPLE,
	soundnessViolations,
	StringDeclaration,
	StrippedBrandDeclaration,
	TERMINAL_CONSTRUCTORS,
	TERMINAL_HOOKS,
	TERMINAL_LIES,
	TERMINAL_MEMBERS,
	throwHostileAccess,
	throwSentinel,
	validSamplesFor,
} from './setup.js'
import type { Equal, Expect, TerminalIntrinsic } from './setup.js'
import { describe, expect, it } from 'vitest'

describe('error capture', () => {
	it('returns the coded error a throwing operation raised and refuses a silent one', () => {
		// The expectation comes from vitest's own matcher rather than from
		// `attempt` and `isContractError`, which is what the narrower itself
		// dispatches through.
		expect(() => stringShape({ min: -1 })).toThrow(ContractError)

		const error = captureContractError(() => stringShape({ min: -1 }))
		expect(error.code).toBe('bound')
		expect(error instanceof ContractError).toBe(true)

		// The two shapes that make a following `expect` vacuous are exactly the two
		// the narrower refuses loudly.
		expect(() => captureContractError(() => 1)).toThrow(
			'captureContractError: the operation returned instead of throwing',
		)
		expect(() =>
			captureContractError(() => {
				throw new TypeError('a stranger')
			}),
		).toThrow('captureContractError: the operation threw a non-ContractError')
	})
})

describe('redirection instruments', () => {
	it('installs a data replacement for one operation and restores it after a throw', () => {
		const honest = Reflect.getOwnPropertyDescriptor(Number.prototype, 'toFixed')
		expect(
			replaceIntrinsic(
				Number.prototype,
				'toFixed',
				() => 'replaced',
				() => (5).toFixed(2),
			),
		).toBe('replaced')
		expect((5).toFixed(2)).toBe('5.00')

		const sentinel = Object.freeze({ stage: 'restore' })
		let raised: unknown
		try {
			replaceIntrinsic(Number.prototype, 'toFixed', () => 'replaced', throwSentinel(sentinel))
		} catch (error) {
			raised = error
		}
		expect(raised).toBe(sentinel)
		expect((5).toFixed(2)).toBe('5.00')
		expect(Reflect.getOwnPropertyDescriptor(Number.prototype, 'toFixed')?.value).toBe(honest?.value)

		expect(() => replaceIntrinsic({}, 'missing', 1, () => 1)).toThrow(
			'replaceIntrinsic: the missing descriptor is absent',
		)
	})

	it('installs an accessor for an absent key and refuses one the target owns', () => {
		expect(
			pollutePrototype(
				Object.prototype,
				'probeCause',
				() => 'polluted',
				() => Reflect.get({}, 'probeCause'),
			),
		).toBe('polluted')
		expect(Reflect.has({}, 'probeCause')).toBe(false)

		const sentinel = Object.freeze({ stage: 'pollution' })
		let raised: unknown
		try {
			pollutePrototype(Object.prototype, 'probeCause', () => 'polluted', throwSentinel(sentinel))
		} catch (error) {
			raised = error
		}
		expect(raised).toBe(sentinel)
		expect(Reflect.has({}, 'probeCause')).toBe(false)

		// Refusing an owned key is what keeps the instrument from degrading into a
		// replacement whose removal deletes a real member.
		expect(() =>
			pollutePrototype(
				Object.prototype,
				'toString',
				() => 1,
				() => 1,
			),
		).toThrow('pollutePrototype: toString is already own, so pollution would hide a real member')
	})

	it('replaces an accessor getter for one operation and refuses a data member', () => {
		expect(
			replaceAccessor(
				RegExp.prototype,
				'source',
				() => 'replaced',
				() => /a/.source,
			),
		).toBe('replaced')
		expect(/a/.source).toBe('a')
		expect(() =>
			replaceAccessor(
				Array.prototype,
				'at',
				() => 1,
				() => 1,
			),
		).toThrow('replaceAccessor: the at accessor is absent')
	})

	it('replaces the mutable string members through their own accessor form', () => {
		expect(replaceStringIterator(throwHostileAccess, () => 'unreached')).toBe('unreached')
		expect([...'ab']).toEqual(['a', 'b'])
		expect(replaceStringSlice(throwHostileAccess, () => 'unreached')).toBe('unreached')
		expect('abc'.slice(1)).toBe('bc')

		// Both install a GETTER, so a read of the member during the operation
		// reaches the replacement rather than the intrinsic.
		let raised: unknown
		try {
			replaceStringSlice(throwHostileAccess, () => 'abc'.slice(1))
		} catch (error) {
			raised = error
		}
		expect(raised).toBeInstanceOf(Error)
		expect('abc'.slice(1)).toBe('bc')
	})

	it('arms a replacement row and a pollution row through the installation each names', () => {
		const sentinel = Object.freeze({ stage: 'redirect' })
		let raised: unknown
		const replacement: TerminalIntrinsic = {
			label: 'Array.prototype.at',
			target: Array.prototype,
			key: 'at',
			via: 'replacement',
		}
		expect(
			redirectIntrinsic(replacement, sentinel, (armed) => {
				try {
					;['a'].at(0)
				} catch (error) {
					raised = error
				}
				return armed
			}),
		).toBe(true)
		expect(raised).toBe(sentinel)
		expect(['a'].at(0)).toBe('a')

		raised = undefined
		const pollution: TerminalIntrinsic = {
			label: 'Object.prototype.probeCause',
			target: Object.prototype,
			key: 'probeCause',
			via: 'pollution',
		}
		expect(
			redirectIntrinsic(pollution, sentinel, (armed) => {
				try {
					Reflect.get({}, 'probeCause')
				} catch (error) {
					raised = error
				}
				return armed
			}),
		).toBe(true)
		expect(raised).toBe(sentinel)
		expect(Reflect.has({}, 'probeCause')).toBe(false)

		// The unarmed pass of the same sweep carries this instead of a door answer,
		// so the armed pass alone decides the verdict.
		expect(createInertOutcome(undefined)).toEqual({ success: true, value: undefined })
		expect(createInertOutcome('carried')).toEqual({ success: true, value: 'carried' })
	})

	it('throws one exact value whether it is called or constructed', () => {
		const sentinel = Object.freeze({ stage: 'cause' })
		const thrower = throwSentinel(sentinel)

		let called: unknown
		try {
			thrower()
		} catch (error) {
			called = error
		}
		expect(called).toBe(sentinel)

		let constructed: unknown
		try {
			Reflect.construct(thrower, [])
		} catch (error) {
			constructed = error
		}
		expect(constructed).toBe(sentinel)

		// The control from outside the population: an arrow is not constructible,
		// so a redirected constructor reached through `new` would raise the host's
		// own refusal rather than the caller's value.
		let arrow: unknown
		try {
			Reflect.construct(() => 1, [])
		} catch (error) {
			arrow = error
		}
		expect(arrow).toBeInstanceOf(TypeError)
		expect(arrow).not.toBe(sentinel)
	})

	it('answers reflection honestly while the live reflective member lies', () => {
		const lie = replaceIntrinsic(
			Object,
			'getOwnPropertyDescriptor',
			() => undefined,
			() => ({
				live: Object.getOwnPropertyDescriptor({ value: 1 }, 'value'),
				captured: captured.descriptor({ value: 1 }, 'value')?.value,
			}),
		)
		expect(lie.live).toBeUndefined()
		expect(lie.captured).toBe(1)
		expect(Object.getOwnPropertyDescriptor({ value: 1 }, 'value')?.value).toBe(1)
	})

	it('makes a genuine value fail its own recognition when the hook denies it', () => {
		const error = captureContractError(() => stringShape({ min: -1 }))
		expect(error instanceof ContractError).toBe(true)
		expect(
			pollutePrototype(
				ContractError,
				Symbol.hasInstance,
				() => denyRecognition,
				() => error instanceof ContractError,
			),
		).toBe(false)
		expect(error instanceof ContractError).toBe(true)
		expect(denyRecognition()).toBe(false)
	})

	it('arms a pollution from inside the walk that observes its source', () => {
		const pollution = new ReentrantPollution(Object.prototype, 'probeCause', () => 'armed')
		try {
			expect(pollution.armed).toBe(false)
			expect(Reflect.has({}, 'probeCause')).toBe(false)
			Reflect.getPrototypeOf(pollution.source)
			expect(pollution.armed).toBe(true)
			expect(Reflect.get({}, 'probeCause')).toBe('armed')
		} finally {
			pollution.restore()
		}
		expect(pollution.armed).toBe(false)
		expect(Reflect.has({}, 'probeCause')).toBe(false)
	})

	it('answers the lie until the bound is passed and then throws the overflow', () => {
		const overflow = Object.freeze({ stage: 'overflow' })
		const bound = createWorkBound(3, overflow)
		expect([bound.deny(), bound.deny(), bound.deny()]).toEqual([false, false, false])
		expect(bound.count()).toBe(3)

		let raised: unknown
		try {
			bound.deny()
		} catch (error) {
			raised = error
		}
		expect(raised).toBe(overflow)
		expect(bound.count()).toBe(4)
	})
})

describe('terminal corpora', () => {
	it('draws every row against the installation its via names', () => {
		const rows = [...TERMINAL_CONSTRUCTORS, ...TERMINAL_HOOKS, ...TERMINAL_MEMBERS]
		// Reflection over the real target decides this, so a row whose `via` no
		// longer matches the member it points at is named rather than trusted.
		expect(
			rows
				.filter((row) => (row.via === 'replacement') !== Object.hasOwn(row.target, row.key))
				.map((row) => row.label),
		).toEqual([])
		expect(rows.filter((row) => !Object.isFrozen(row)).map((row) => row.label)).toEqual([])
		expect(
			rows
				.filter((row) =>
					typeof row.key === 'symbol'
						? !row.label.endsWith(`[${String(row.key.description)}]`)
						: !row.label.endsWith(`.${String(row.key)}`),
				)
				.map((row) => row.label),
		).toEqual([])
		expect(new Set(rows.map((row) => row.label)).size).toBe(rows.length)
	})

	it('separates the constructor, hook, and member populations by their membership rules', () => {
		expect(TERMINAL_CONSTRUCTORS.map((row) => String(row.key)).sort()).toEqual([
			'Map',
			'Set',
			'WeakMap',
			'WeakSet',
		])
		expect(TERMINAL_CONSTRUCTORS.filter((row) => row.target !== globalThis)).toEqual([])
		expect(
			TERMINAL_HOOKS.filter((row) => typeof row.key !== 'symbol').map((row) => row.label),
		).toEqual([])
		expect(
			TERMINAL_MEMBERS.filter(
				(row) => typeof row.key !== 'string' || row.via !== 'replacement',
			).map((row) => row.label),
		).toEqual([])
	})

	it('derives every owned row from a writable prototype member of an exported callable', () => {
		expect(OWNED_MEMBERS.length).toBeGreaterThan(0)
		expect(
			OWNED_MEMBERS.filter(
				(row) => Object.getOwnPropertyDescriptor(row.target, row.key)?.writable !== true,
			).map((row) => row.label),
		).toEqual([])
		// The label is checked back against the barrel rather than against the
		// reflection that built the row, so a row pointing at a prototype no export
		// owns is named.
		expect(
			OWNED_MEMBERS.filter((row) => {
				const [name] = row.label.split('.prototype.')
				if (name === undefined) return true
				const exported: unknown = Reflect.get(core, name)
				return typeof exported !== 'function' || Reflect.get(exported, 'prototype') !== row.target
			}).map((row) => row.label),
		).toEqual([])
	})

	it('arms one lying substitute, reports its control, and restores the honest member', () => {
		const armed = lieIntrinsic(
			{
				label: 'Math.trunc answers zero',
				target: Math,
				key: 'trunc',
				substitute: (): number => 0,
				control: (): boolean => Math.trunc(1.5) === 0,
			},
			(state) => ({ state, answer: Math.trunc(1.5) }),
		)
		expect(armed).toEqual({ state: true, answer: 0 })
		expect(Math.trunc(1.5)).toBe(1)

		// A row whose control cannot observe its own substitute reports unarmed,
		// so a sweep never records a verdict for an attack that did not happen.
		expect(
			lieIntrinsic(
				{
					label: 'Math.trunc answers zero, unobserved',
					target: Math,
					key: 'trunc',
					substitute: (): number => 0,
					control: (): boolean => false,
				},
				(state) => state,
			),
		).toBe(false)
		expect(Math.trunc(1.5)).toBe(1)

		expect(() =>
			lieIntrinsic(
				{
					label: 'absent member',
					target: {},
					key: 'missing',
					substitute: (): number => 0,
					control: (): boolean => true,
				},
				(state) => state,
			),
		).toThrow('lieIntrinsic: the missing descriptor is absent')
	})

	it('names a control that answers before its row is armed', () => {
		expect(
			findVacuousControls([
				{
					label: 'answers whatever it is asked',
					target: Math,
					key: 'trunc',
					substitute: (): number => 0,
					control: (): boolean => true,
				},
				{
					label: 'observes the member',
					target: Math,
					key: 'trunc',
					substitute: (): number => 0,
					control: (): boolean => Math.trunc(1.5) === 0,
				},
			]),
		).toEqual(['answers whatever it is asked'])
		expect(Math.trunc(1.5)).toBe(1)
	})

	it('names a control that observes installation rather than behaviour', () => {
		const honest: unknown = Object.getOwnPropertyDescriptor(Math, 'trunc')?.value
		expect(
			findInstallationControls([
				{
					label: 'reads the member identity',
					target: Math,
					key: 'trunc',
					substitute: (): number => 0,
					control: (): boolean => Object.getOwnPropertyDescriptor(Math, 'trunc')?.value !== honest,
				},
				{
					label: 'observes the member',
					target: Math,
					key: 'trunc',
					substitute: (): number => 0,
					control: (): boolean => Math.trunc(1.5) === 0,
				},
				{
					label: 'points at an absent member',
					target: {},
					key: 'missing',
					substitute: (): number => 0,
					control: (): boolean => false,
				},
			]),
		).toEqual(['reads the member identity', 'points at an absent member'])
		expect(Object.getOwnPropertyDescriptor(Math, 'trunc')?.value).toBe(honest)
	})

	it('holds one owned lying member per row, uniquely labelled', () => {
		expect(
			TERMINAL_LIES.filter((row) => !Object.hasOwn(row.target, row.key)).map((row) => row.label),
		).toEqual([])
		expect(
			TERMINAL_LIES.filter((row) => typeof row.substitute !== 'function').map((row) => row.label),
		).toEqual([])
		expect(TERMINAL_LIES.filter((row) => !Object.isFrozen(row)).map((row) => row.label)).toEqual([])
		expect(new Set(TERMINAL_LIES.map((row) => row.label)).size).toBe(TERMINAL_LIES.length)
	})
})

describe('published value fidelity', () => {
	it('reports frozenness and own data keys in sorted order and closes a cycle', () => {
		expect(fingerprintOwnership('text')).toBe('"text"')
		expect(fingerprintOwnership(1)).toBe('1')
		expect(fingerprintOwnership(null)).toBe('null')
		expect(fingerprintOwnership(undefined)).toBe('undefined')
		expect(fingerprintOwnership(Object.freeze({ b: 1, a: 'x' }))).toBe('{frozen a="x",b=1}')
		expect(fingerprintOwnership({ a: 1 })).toBe('{MUTABLE a=1}')
		expect(fingerprintOwnership(Object.freeze(['x']))).toBe('{frozen 0="x"}')
		expect(fingerprintOwnership(buildCyclicRecord())).toBe('{MUTABLE self=<edge>}')
		// An accessor carries no ownership fact and must not be invoked, which a
		// throwing getter is the only fixture that can prove.
		expect(fingerprintOwnership(createThrowingGetter())).toBe('{MUTABLE }')
	})

	it('builds a fresh door registry with one diagnosing row', () => {
		const first = publicDoors()
		const second = publicDoors()
		expect(first).not.toBe(second)
		expect(first[0]).not.toBe(second[0])
		expect(first.length).toBe(second.length)
		expect(first.filter((door) => !Object.isFrozen(door)).map((door) => door.label)).toEqual([])
		expect(new Set(first.map((door) => door.label)).size).toBe(first.length)
		expect([...new Set(first.map((door) => door.refusal))].sort()).toEqual([
			'coded',
			'raw',
			'total',
		])
		expect(first.filter((door) => door.refusal === 'raw').map((door) => door.label)).toEqual([
			'matchesRecordBrand',
		])
	})
})

describe('record brand forgeries', () => {
	it('names the realm members a record brand is identified by', () => {
		expect(Object.isFrozen(RECORD_BRAND_MEMBERS)).toBe(true)
		expect(
			RECORD_BRAND_MEMBERS.filter((member) => {
				const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, member)
				return descriptor === undefined || typeof descriptor.value !== 'function'
			}),
		).toEqual([])
		expect(
			RECORD_BRAND_MEMBERS.filter(
				(member) => Object.getOwnPropertyDescriptor(Object.prototype, member)?.enumerable !== false,
			),
		).toEqual([])
	})

	it('stamps a forged prototype with this realm values and a blank one with none', () => {
		const faithful = forgeRecordBrand(Object.create(Object.prototype))
		expect(Object.getPrototypeOf(faithful)).toBeNull()
		expect(
			RECORD_BRAND_MEMBERS.filter(
				(member) =>
					Object.getOwnPropertyDescriptor(faithful, member)?.value !==
					Object.getOwnPropertyDescriptor(Object.prototype, member)?.value,
			),
		).toEqual([])

		const blank = forgeBlankBrand(Object.create(Object.prototype))
		expect(Object.getPrototypeOf(blank)).toBeNull()
		expect(
			RECORD_BRAND_MEMBERS.filter(
				(member) => Object.getOwnPropertyDescriptor(blank, member)?.value !== undefined,
			),
		).toEqual([])
		// The difference the two forgeries exist to separate: a mandated name is
		// present in each, and only one answers it with a callable member.
		expect(RECORD_BRAND_MEMBERS.every((member) => Object.hasOwn(blank, member))).toBe(true)
	})

	it('carries the declared string shape and the prototype state each fixture names', () => {
		for (const instance of [
			new StringDeclaration(),
			new NullBaseDeclaration(),
			new ForgedBrandDeclaration(),
			new StrippedBrandDeclaration(),
			new BlankBrandDeclaration(),
			new ProxiedBrandDeclaration(),
		]) {
			expect(instance.category).toBe('string')
			expect(instance.min).toBe(1)
		}

		expect(Object.getPrototypeOf(StringDeclaration.prototype)).toBe(Object.prototype)
		expect(Object.getPrototypeOf(NullBaseDeclaration.prototype)).toBeNull()
		expect(Object.getOwnPropertyNames(NullBaseDeclaration.prototype)).toEqual(['constructor'])

		// The forged pair differs only by where the live method sits, which is the
		// whole point of keeping both.
		expect(Object.getOwnPropertyNames(ForgedBrandDeclaration.prototype).sort()).toEqual(
			[...RECORD_BRAND_MEMBERS, 'escape'].sort(),
		)
		expect(Object.getOwnPropertyNames(StrippedBrandDeclaration.prototype).sort()).toEqual(
			[...RECORD_BRAND_MEMBERS].sort(),
		)
		expect(typeof Reflect.get(new StrippedBrandDeclaration(), 'escape')).toBe('function')
		expect(new ForgedBrandDeclaration().escape()).toBe('live')

		expect(
			RECORD_BRAND_MEMBERS.filter(
				(member) =>
					member !== 'constructor' &&
					Object.getOwnPropertyDescriptor(BlankBrandDeclaration.prototype, member)?.value !==
						undefined,
			),
		).toEqual([])
	})

	it('answers as a realm through a trap while the class keeps its real chain', () => {
		const value = createProxiedBrandDeclaration()
		const forged = Object.getPrototypeOf(value)
		// The trap answers the questions a realm's own prototype answers: no
		// prototype above it, exactly the mandated key population, and this realm's
		// real member values behind each name.
		expect(Object.getPrototypeOf(forged)).toBeNull()
		expect(Reflect.ownKeys(forged)).toEqual([...RECORD_BRAND_MEMBERS])
		expect(
			RECORD_BRAND_MEMBERS.filter((member) => typeof Reflect.get(value, member) !== 'function'),
		).toEqual([])
		// Nothing was reparented or stamped, so the live method survives and the
		// untouched control class is exactly as JavaScript built it.
		expect(typeof Reflect.get(value, 'escape')).toBe('function')
		expect(Object.getPrototypeOf(ProxiedBrandDeclaration.prototype)).toBe(Object.prototype)
		expect(new ProxiedBrandDeclaration().escape()).toBe('live')
	})
})

describe('pattern fixtures', () => {
	it('counts every string conversion the pattern field routes to the carrier', () => {
		const data = new PatternFixture('source', false)
		expect(data.carrier.count).toBe(0)
		expect(data.carrier.text).toBe('a')
		const pattern: unknown = data.shape.pattern
		expect(pattern).toBeInstanceOf(RegExp)
		expect(String(Reflect.get(Object(pattern), 'source'))).toBe('a')
		expect(data.carrier.count).toBe(1)
		data.carrier.change('b')
		expect(String(Reflect.get(Object(pattern), 'source'))).toBe('b')
		expect(data.carrier.count).toBe(2)

		// The accessor form answers a fresh frozen pattern per read, so a reader
		// that caches one cannot be mistaken for one that rereads.
		const accessor = new PatternFixture('flags', true)
		const first = accessor.shape.pattern
		const second = accessor.shape.pattern
		expect(first).not.toBe(second)
		expect(Object.isFrozen(first)).toBe(true)
		expect(Object.getOwnPropertyDescriptor(accessor.shape, 'pattern')?.get).toBeTypeOf('function')
	})

	it('answers one source observation per produced pattern and refuses the second', () => {
		const data = new SingleReadPattern(false)
		expect(data.reads).toBe(0)
		const pattern = data.shape.pattern
		expect(pattern?.source).toBe('a')
		expect(data.reads).toBe(1)
		expect(() => pattern?.source).toThrow('SingleReadPattern: source was observed twice')

		const accessor = new SingleReadPattern(true)
		expect(accessor.shape.pattern?.source).toBe('a')
		expect(accessor.shape.pattern?.source).toBe('a')
		expect(accessor.reads).toBe(2)
	})
})

describe('retention fixtures', () => {
	it('serves the live population until release and refuses every later observation', () => {
		const retention = createShapeRetention('x', false)
		expect(retention.reference.deref()).toBeDefined()
		expect(Object.keys(Reflect.get(retention.source, 'properties'))).toEqual(['child'])
		retention.release()
		expect(() => Reflect.get(retention.source, 'properties')).toThrow(
			'RetentionFixture: population was released before observation completed',
		)
	})

	it('carries each population through the member the door it feeds walks', () => {
		expect(Object.keys(Reflect.get(createShapeRetention('x', false).source, 'properties'))).toEqual(
			['child'],
		)
		expect(Object.keys(Reflect.get(createShapeRetention('x', true).source, 'properties'))).toEqual([
			'child',
			'bad',
		])
		expect(Reflect.get(createVariantRetention('x', false).source, 'variants')).toHaveLength(1)
		expect(Reflect.get(createVariantRetention('x', true).source, 'variants')).toHaveLength(2)

		// The schema population advertises its keys through a trap, and every read
		// outside the advertised child raises the fixture's own exact failure.
		const schema = createSchemaRetention('y', true)
		expect(Reflect.ownKeys(schema.fixture.source)).toEqual(['child', 'bad'])
		expect(schema.reason.message).toBe('y schema read')
		let raised: unknown
		try {
			Reflect.get(schema.fixture.source, 'bad')
		} catch (error) {
			raised = error
		}
		expect(raised).toBe(schema.reason)
		expect(Reflect.ownKeys(createSchemaRetention('y', false).fixture.source)).toEqual(['child'])
	})
})

describe('hostile sources', () => {
	it('refuses every observation once a proxy fixture is revoked', () => {
		const record = createRevokedProxy()
		expect(() => Reflect.getPrototypeOf(record)).toThrow(TypeError)
		const list = createRevokedArrayProxy()
		expect(() => list.length).toThrow(TypeError)
		// Even the array brand is unreachable, so a reader that asks before
		// guarding meets the refusal rather than a wrong answer.
		expect(() => Array.isArray(list)).toThrow(TypeError)
	})

	it('throws from the exact observation each hostile record names', () => {
		expect(() => throwHostileAccess()).toThrow('hostile access')

		const record = createThrowingGetter()
		expect(Object.keys(record)).toEqual(['value'])
		expect(() => Reflect.get(record, 'value')).toThrow('hostile access')
		expect(Reflect.get(createThrowingGetter('other'), 'value')).toBeUndefined()

		const keys = createHostileKeys()
		expect(() => Reflect.ownKeys(keys)).toThrow('hostile access')
		expect(() => Object.getOwnPropertyDescriptor(keys, 'value')).toThrow('hostile access')

		const reason = new Error('prototype read')
		const prototype = createThrowingPrototype(reason)
		let raised: unknown
		try {
			Reflect.getPrototypeOf(prototype)
		} catch (error) {
			raised = error
		}
		expect(raised).toBe(reason)
		expect(Object.keys(prototype)).toEqual(['b', 'a'])
	})

	it('drifts after the first read and advertises what it does not hold', () => {
		const record = createStatefulGetter()
		expect(Reflect.get(record, 'value')).toBe(1)
		expect(Reflect.get(record, 'value')).toBe('drifted')
		expect(Reflect.get(record, 'value')).toBe('drifted')

		const list = createUnstableArray()
		expect([list[0], list[1], list[2]]).toEqual([1, 2, 3])
		expect(list.slice(0, 2)).toEqual(['lie', 'lie'])
		expect(Object.getOwnPropertyDescriptor(list, 'slice')?.enumerable).toBe(false)
	})

	it('advertises the native maximum length while refusing every indexed observation', () => {
		const fixture = createNativeMaximumSparseArray()
		expect(fixture.value.length).toBe(2 ** 32 - 1)
		expect(Reflect.ownKeys(fixture.value)).toEqual(['length'])
		expect(fixture.probes).toEqual([])

		expect(() => fixture.value[0]).toThrow('Indexed source value read: 0')
		expect(() => Object.getOwnPropertyDescriptor(fixture.value, '1')).toThrow(
			'Indexed source descriptor read: 1',
		)
		expect(() => Reflect.has(fixture.value, '2')).toThrow('Indexed source membership read: 2')
		expect(fixture.probes).toEqual(['value:0', 'descriptor:1', 'membership:2'])
	})
})

describe('structural fixtures', () => {
	it('builds the cyclic, sparse, hidden, and null-based values each factory names', () => {
		const record = buildCyclicRecord()
		expect(Reflect.get(record, 'self')).toBe(record)

		const list = buildCyclicArray()
		expect(list).toHaveLength(1)
		expect(list[0]).toBe(list)

		const sparse = buildSparseArray()
		expect(sparse).toHaveLength(3)
		expect([0, 1, 2].map((index) => Object.hasOwn(sparse, index))).toEqual([false, true, false])
		expect(sparse[1]).toBe('value')

		const hidden = createNonEnumerableRecord('hidden', true)
		expect(Object.keys(hidden)).toEqual([])
		expect(Object.getOwnPropertyDescriptor(hidden, 'hidden')?.value).toBe(true)

		const based = createNullPrototypeRecord()
		expect(Object.getPrototypeOf(based)).toBeNull()
		expect(Reflect.get(based, 'value')).toBe(1)

		const instance = createClassInstance()
		expect(Object.getPrototypeOf(instance)).not.toBe(Object.prototype)
		expect(Object.getPrototypeOf(instance).constructor.name).toBe('Sample')
		expect(Reflect.get(instance, 'value')).toBe(1)
	})

	it('alternates an array and a record layer around the leaf', () => {
		expect(buildDeepNest(0)).toBe('leaf')
		expect(buildDeepNest(1)).toEqual(['leaf'])
		expect(buildDeepNest(2)).toEqual({ value: ['leaf'] })

		let node: unknown = buildDeepNest(9)
		let layers = 0
		for (let step = 0; step < 16; step += 1) {
			if (Array.isArray(node)) {
				node = node[0]
				layers += 1
				continue
			}
			if (typeof node !== 'object' || node === null) break
			node = Reflect.get(node, 'value')
			layers += 1
		}
		expect(node).toBe('leaf')
		expect(layers).toBe(9)
	})

	it('builds a distinct ordered vocabulary at the requested size', () => {
		expect(buildWideVocabulary(3)).toEqual(['value0', 'value1', 'value2'])
		const wide = buildWideVocabulary()
		expect(wide).toHaveLength(200_000)
		expect(wide[0]).toBe('value0')
		expect(wide[wide.length - 1]).toBe('value199999')
		expect(new Set(wide).size).toBe(wide.length)
		// Whether spreading the default vocabulary into arguments raises a
		// `RangeError` is the host's stack budget rather than the fixture's
		// property — a Vitest worker carries a larger stack than a plain Node
		// entry — so the suites that drive the vocabulary through the package own
		// that claim and this proof pins the size and the order.
	})

	it('consumes the one-shot iterator once and yields forever from the infinite one', () => {
		const once = createOneShotIterable()
		expect(Array.from(once)).toEqual([1, 2, 3])
		expect(Array.from(once)).toEqual([])

		const forever = createInfiniteIterable()
		expect(forever[Symbol.iterator]()).toBe(forever)
		expect([forever.next(), forever.next()]).toEqual([
			{ done: false, value: 0 },
			{ done: false, value: 0 },
		])
	})
})

describe('shape factories', () => {
	it('nests one array level per requested depth', () => {
		expect(buildDeepShape(0)).toEqual({ category: 'string' })
		let node: ContractShape = buildDeepShape(3)
		let levels = 0
		for (let step = 0; step < 8 && node.category === 'array'; step += 1) {
			node = node.items
			levels += 1
		}
		expect(levels).toBe(3)
		expect(node.category).toBe('string')
	})

	it('binds one child into both properties of every level', () => {
		const dag = buildSharedDagShape(3)
		if (dag.category !== 'object')
			throw new Error('buildSharedDagShape: the root must be an object shape')
		expect(Object.keys(dag.properties)).toEqual(['left', 'right'])
		expect(Reflect.get(dag.properties, 'left')).toBe(Reflect.get(dag.properties, 'right'))

		// The gap the fixture exists for: an expansion that does not share reads
		// one node per emitted edge, so the emitted total doubles per level.
		let emitted = 0
		const pending: ContractShape[] = [dag]
		for (let step = 0; step < 64 && pending.length > 0; step += 1) {
			const node = pending.pop()
			if (node === undefined) continue
			emitted += 1
			if (node.category === 'object')
				for (const child of Object.values(node.properties)) pending.push(child)
		}
		expect(emitted).toBe(2 ** 4 - 1)
	})

	it('reaches one child through an edge per level, each a level deeper', () => {
		const child = stringShape({ description: 'shared' })
		const staircase = buildStaircaseShape(child, 3)
		if (staircase.category !== 'object')
			throw new Error('buildStaircaseShape: the root must be an object shape')
		expect(Object.keys(staircase.properties)).toEqual(['k0', 'k1', 'k2'])
		expect(Reflect.get(staircase.properties, 'k0')).toBe(child)

		let node: ContractShape | undefined = Reflect.get(staircase.properties, 'k2')
		let wrappers = 0
		for (let step = 0; step < 8 && node !== undefined && node.category === 'array'; step += 1) {
			node = node.items
			wrappers += 1
		}
		expect(wrappers).toBe(2)
		expect(node).toBe(child)
	})

	it('tallies one read per record visit and holds one record per shared slot', () => {
		const shared = buildCountedGraph(2, true)
		expect(shared.count()).toBe(0)
		const slots: unknown = shared.value
		if (!Array.isArray(slots)) throw new Error('buildCountedGraph: the value root must be an array')
		expect(slots).toHaveLength(2)
		expect(slots[0]).toBe(slots[1])
		Reflect.get(slots[0], 'inner')
		expect(shared.count()).toBe(1)
		Reflect.get(slots[1], 'inner')
		expect(shared.count()).toBe(2)

		const distinct = buildCountedGraph(2, false)
		const separate: unknown = distinct.value
		if (!Array.isArray(separate))
			throw new Error('buildCountedGraph: the value root must be an array')
		expect(separate[0]).not.toBe(separate[1])
	})

	it('binds one child node into both slots and tallies a read per slot it fills', () => {
		const shared = buildCountedSlots(true)
		expect(shared.count()).toBe(0)
		const root: unknown = shared.value
		if (typeof root !== 'object' || root === null)
			throw new Error('buildCountedSlots: the value root must be a record')
		expect(captured.get(root, 'left')).toBe(captured.get(root, 'right'))
		const declaration: ContractShape = shared.shape
		if (declaration.category !== 'object')
			throw new Error('buildCountedSlots: the root must be an object shape')
		expect(captured.get(declaration.properties, 'left')).toBe(
			captured.get(declaration.properties, 'right'),
		)

		const slot: unknown = captured.get(root, 'left')
		if (typeof slot !== 'object' || slot === null)
			throw new Error('buildCountedSlots: a slot must hold a record')
		captured.get(slot, 'inner')
		expect(shared.count()).toBe(1)
		captured.get(slot, 'inner')
		expect(shared.count()).toBe(2)

		const distinct = buildCountedSlots(false)
		const separate: unknown = distinct.value
		if (typeof separate !== 'object' || separate === null)
			throw new Error('buildCountedSlots: the value root must be a record')
		expect(captured.get(separate, 'left')).not.toBe(captured.get(separate, 'right'))
	})

	it('combines every shape kind and wraps the previous level per depth', () => {
		const flat = compositeShape(1)
		if (flat.category !== 'object')
			throw new Error('compositeShape: the composite must be an object shape')
		expect(Object.keys(flat.properties)).toEqual([
			'str',
			'num',
			'int',
			'bool',
			'nul',
			'lit',
			'arr',
			'uni',
			'one',
			'opt',
			'nullable',
			'rec',
			'json',
		])
		expect(Object.values(flat.properties).map((child) => child.category)).toEqual([
			'string',
			'number',
			'number',
			'boolean',
			'null',
			'literal',
			'array',
			'union',
			'union',
			'optional',
			'nullable',
			'object',
			'json',
		])

		const deep = compositeShape(3)
		if (deep.category !== 'object')
			throw new Error('compositeShape: the composite must be an object shape')
		expect(Object.keys(deep.properties)).toEqual(['nested', 'list', 'dict'])
		const level: ContractShape = Reflect.get(deep.properties, 'nested')
		if (level.category !== 'object')
			throw new Error('compositeShape: the nested level must be an object shape')
		expect(Object.keys(level.properties)).toEqual(['nested', 'list', 'dict'])
		const leaf: ContractShape = Reflect.get(level.properties, 'nested')
		if (leaf.category !== 'object')
			throw new Error('compositeShape: the leaf must be an object shape')
		expect(Object.keys(leaf.properties)).toEqual(Object.keys(flat.properties))
	})

	it('plants each requested declaration defect in the order its caller named', () => {
		const root = createShapeValidationCase(['domain', 'cycle', 'structure'])
		if (root.category !== 'object')
			throw new Error('createShapeValidationCase: the root must be an object shape')
		expect(Object.keys(root.properties)).toEqual(['domain', 'cycle', 'structure'])
		expect(Reflect.get(root.properties, 'domain')).toEqual({ category: 'string', min: -1 })
		expect(Reflect.get(root.properties, 'cycle')).toBe(root)
		expect(Object.hasOwn(root.properties, 'structure')).toBe(true)
		expect(Reflect.get(root.properties, 'structure')).toBeUndefined()

		const reordered = createShapeValidationCase(['cycle', 'domain'])
		if (reordered.category !== 'object')
			throw new Error('createShapeValidationCase: the root must be an object shape')
		expect(Object.keys(reordered.properties)).toEqual(['cycle', 'domain'])
		// Each call owns its graph, so one case's cycle can never reach another's.
		expect(reordered).not.toBe(root)
	})

	it('keys every separation row by the kind it names, in the position that kind permits', () => {
		expect(Object.isFrozen(SHAPE_SEPARATIONS)).toBe(true)
		expect(Object.values(SHAPE_SEPARATIONS).filter((row) => !Object.isFrozen(row))).toEqual([])
		expect(
			Object.entries(SHAPE_SEPARATIONS)
				.filter(([kind, row]) => {
					if (row.shape.category === kind) return false
					if (row.shape.category !== 'object') return true
					return Object.values(row.shape.properties).some((child) => child.category !== kind)
				})
				.map(([kind]) => kind),
		).toEqual([])
		// A witness-free row tells a consumer the two artifacts coincide for that
		// kind, so the kinds without one are part of the corpus's contract.
		expect(
			Object.entries(SHAPE_SEPARATIONS)
				.filter(([, row]) => row.witness === undefined)
				.map(([kind]) => kind)
				.sort(),
		).toEqual(['json', 'null', 'raw'])
	})
})

describe('sample corpora', () => {
	it('freezes an adversarial sample carrying the hosts the whole-value invariants need', () => {
		expect(Object.isFrozen(SOUNDNESS_SAMPLE)).toBe(true)
		expect(SOUNDNESS_SAMPLE.some((value) => Object.is(value, -0))).toBe(true)
		expect(SOUNDNESS_SAMPLE.some((value) => Object.is(value, 0))).toBe(true)
		expect(SOUNDNESS_SAMPLE.some((value) => typeof value === 'number' && Number.isNaN(value))).toBe(
			true,
		)
		expect(SOUNDNESS_SAMPLE.some((value) => value === Number.POSITIVE_INFINITY)).toBe(true)
		expect(SOUNDNESS_SAMPLE.some((value) => value === Number.NEGATIVE_INFINITY)).toBe(true)
		// The absentees are named rather than counted, so a sample that lost one
		// host reports which one.
		expect(
			['bigint', 'symbol', 'function', 'undefined'].filter(
				(kind) => !SOUNDNESS_SAMPLE.some((value) => typeof value === kind),
			),
		).toEqual([])
		expect(
			[Map, Set, Date]
				.filter((host) => !SOUNDNESS_SAMPLE.some((value) => value instanceof host))
				.map((host) => host.name),
		).toEqual([])
		expect(
			SOUNDNESS_SAMPLE.some(
				(value) =>
					typeof value === 'object' && value !== null && Reflect.get(value, 'self') === value,
			),
		).toBe(true)

		// The nest the inference round trip needs is the one that outruns the
		// package's own depth limit, so the walk that finds it must reach past it.
		let deepest = 0
		for (const value of SOUNDNESS_SAMPLE) {
			let node: unknown = value
			let depth = 0
			for (let step = 0; step <= INFER_DEPTH_LIMIT + 16; step += 1) {
				if (Array.isArray(node)) {
					node = node[0]
					depth += 1
					continue
				}
				if (typeof node !== 'object' || node === null) break
				let descriptor: PropertyDescriptor | undefined
				try {
					descriptor = Object.getOwnPropertyDescriptor(node, 'value')
				} catch {
					break
				}
				if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) break
				node = descriptor.value
				depth += 1
			}
			if (node === 'leaf' && depth > deepest) deepest = depth
		}
		expect(deepest).toBeGreaterThan(INFER_DEPTH_LIMIT)
	})

	it('names the soundness violation an unsound pair produces and stays silent for a sound one', () => {
		const index = SOUNDNESS_SAMPLE.indexOf('hello')
		expect(index).toBeGreaterThan(-1)

		expect(
			soundnessViolations(
				(value: unknown): value is unknown => value === 'hello',
				(value: unknown): unknown => (value === 'hello' ? 'hello' : undefined),
			),
		).toEqual([])

		// A guard-valid input the parser refuses is the A violation; an output the
		// guard rejects is the B violation. Each tag carries the sample position
		// that produced it.
		expect(
			soundnessViolations(
				(value: unknown): value is unknown => value === 'hello',
				(): unknown => undefined,
			),
		).toEqual([`A@${String(index)}`])
		expect(
			soundnessViolations(
				(value: unknown): value is unknown => value === 'hello',
				(): unknown => 'ghost',
			),
		).toHaveLength(SOUNDNESS_SAMPLE.length + 1)
	})

	it('answers a disjoint valid and invalid set per leaf kind and none for a container', () => {
		const defects: string[] = []
		for (const [label, shape] of leafShapeVariations()) {
			const valid = validSamplesFor(shape)
			const invalid = invalidSamplesFor(shape)
			if (valid.length === 0) defects.push(`${label}: no valid sample`)
			if (invalid.length === 0) defects.push(`${label}: no invalid sample`)
			for (const value of valid) {
				if (invalid.some((other) => Object.is(other, value))) {
					defects.push(`${label}: ${String(value)} sits in both sets`)
				}
			}
		}
		expect(defects).toEqual([])
		expect(validSamplesFor(arrayShape(stringShape()))).toEqual([])
		expect(invalidSamplesFor(objectShape({}))).toEqual([])

		// The integer flag picks the set, and a literal kind answers its own
		// declared vocabulary rather than a fixed list.
		expect(validSamplesFor(integerShape())).toEqual([0, 1, -1, 42])
		expect(validSamplesFor(numberShape())).toEqual([0, 1.5, -2.25, 100])
		expect(validSamplesFor(literalShape(['x', 'y']))).toEqual(['x', 'y'])
	})
})

describe('report fixtures', () => {
	it('builds the smallest distinguishable fault and projects a report to its refinements', () => {
		expect(buildTypeFault('string')).toEqual({
			reason: 'type',
			path: [],
			expected: 'string',
			received: 'null',
		})
		expect(buildTypeFault('string')).not.toBe(buildTypeFault('string'))
		expect(buildTypeFault('number')).not.toEqual(buildTypeFault('string'))

		const report: readonly AuditFault[] = [
			{ reason: 'constraint', path: [], expected: 'string', constraint: 'min', received: '""' },
			buildTypeFault('string'),
			{ reason: 'constraint', path: ['a'], expected: 'number', constraint: 'max', received: '9' },
			{ reason: 'extra', path: ['b'] },
		]
		// Report order is preserved and a non-constraint entry answers `undefined`
		// rather than dropping out, so an order assertion still fails loudly.
		expect(faultsToConstraints(report)).toEqual(['min', undefined, 'max', undefined])
		expect(faultsToConstraints([])).toEqual([])
	})
})

describe('observation seams', () => {
	it('counts every observation of the declaration and clears its tally', () => {
		const observed = new ObservedShape()
		expect(observed.reads).toBe(0)
		const seen = observed.shape.pattern
		expect(seen).toBeInstanceOf(RegExp)
		expect(Object.isFrozen(seen)).toBe(true)
		expect(observed.reads).toBe(1)
		expect(observed.shape.pattern?.source).toBe('^[a-z]+$')
		expect(observed.reads).toBe(2)
		observed.clear()
		expect(observed.reads).toBe(0)
	})

	it('rewrites the graph on every enumeration after the first', () => {
		const rewrites: string[] = []
		const late = new LateMutation({ a: stringShape() }, () => rewrites.push('rewritten'))
		expect(late.walks).toBe(0)
		JSON.stringify(late.shape)
		expect(late.walks).toBe(1)
		expect(rewrites).toEqual([])
		JSON.stringify(late.shape)
		expect(late.walks).toBe(2)
		expect(rewrites).toEqual(['rewritten'])
	})

	it('performs the nested operation on the first observation only', () => {
		const reentries: string[] = []
		const fixture = new ReentrantShape(() => reentries.push('entered'))
		expect(fixture.nested).toBeUndefined()
		expect(fixture.shape.pattern).toBeInstanceOf(RegExp)
		expect(fixture.nested).toEqual({ success: true, value: 1 })
		expect(reentries).toEqual(['entered'])

		expect(fixture.shape.pattern).toBeInstanceOf(RegExp)
		expect(reentries).toEqual(['entered'])

		// A nested operation that fails is recorded rather than raised, so the
		// declaration stays valid while the outcome is still readable.
		const failing = new ReentrantShape(throwHostileAccess)
		expect(failing.shape.pattern).toBeInstanceOf(RegExp)
		expect(failing.nested?.success).toBe(false)
	})
})

describe('schema and memo fixtures', () => {
	it('carries the hostile schema structures each fixture names', () => {
		const schema = createUndefinedSchema('items')
		expect(Object.hasOwn(schema, 'items')).toBe(true)
		expect(Object.keys(schema)).toEqual(['items'])
		expect(Reflect.get(schema, 'items')).toBeUndefined()

		const root = new ArrayRootSchema()
		root[0] = { type: 'string' }
		expect(Array.isArray(root)).toBe(true)
		expect(root).toHaveLength(1)
		// `declare` keeps the keyword type-level only, so the array-root refusal
		// cannot be reading an own keyword instead of the root's array-ness.
		expect(Object.hasOwn(root, 'type')).toBe(false)

		const memo = new ClassSampleMemo()
		expect(memo.rows).toBeInstanceOf(WeakMap)
		expect(memo.schemas).toBeInstanceOf(Map)
		expect(new ClassSampleMemo().rows).not.toBe(memo.rows)
	})

	it('builds a complete two-child tree at the requested depth', () => {
		expect(buildTree(() => 1, 0)).toEqual({ value: 1, children: [] })

		let drawn = 0
		const tree = buildTree(() => {
			drawn += 1
			return drawn
		}, 2)
		let nodes = 0
		const pending = [tree]
		for (let step = 0; step < 32 && pending.length > 0; step += 1) {
			const node = pending.pop()
			if (node === undefined) continue
			nodes += 1
			for (const child of node.children) pending.push(child)
		}
		expect(nodes).toBe(2 ** 3 - 1)
		expect(drawn).toBe(nodes)
		expect(tree.children).toHaveLength(2)
	})
})

describe('guide comparison fixtures', () => {
	it('carries a documentable and an undocumented member beside a symbol-keyed one', () => {
		expect(Object.getOwnPropertyNames(DriftedMethods.prototype).sort()).toEqual([
			'constructor',
			'undocumented',
			'validate',
		])
		expect(new DriftedMethods().undocumented()).toBe(1)

		// The control from outside the name-keyed population a runtime comparison
		// walks: a name walk cannot see this member at all.
		expect(Object.getOwnPropertyNames(SmuggledMember.prototype)).toEqual(['constructor'])
		expect(Object.getOwnPropertySymbols(SmuggledMember.prototype)).toEqual([SMUGGLED_KEY])
		expect(new SmuggledMember()[SMUGGLED_KEY]()).toBe(2)
	})
})

describe('roundtrip readings', () => {
	it('reports a sound declaration in lockstep and propagates a generator refusal rather than swallowing it', () => {
		const leaf = buildLockstep(stringShape(), 7)
		expect(leaf.guarded).toBe(true)
		expect(leaf.parsed).toEqual(leaf.value)
		expect(leaf.reparsed).toBe(true)
		const leafText = buildJSONRoundtrip(stringShape(), 7)
		expect(leafText.guarded).toBe(true)
		expect(leafText.reencoded).toBe(leafText.text)
		const composite = buildLockstep(compositeShape(2), 7)
		expect(composite.guarded).toBe(true)
		expect(composite.parsed).toEqual(composite.value)
		expect(composite.reparsed).toBe(true)
		const compositeText = buildJSONRoundtrip(compositeShape(2), 7)
		expect(compositeText.guarded).toBe(true)
		expect(compositeText.reencoded).toBe(compositeText.text)

		// A declaration whose contract cannot serve the roundtrip must reach the
		// caller as the generator's own refusal; a helper that swallowed it would
		// certify every shape it was handed.
		expect(() => buildLockstep(stringShape({ pattern: /^[a-z]+$/ }), 7)).toThrow(
			'a pattern-constrained string shape cannot be auto-generated',
		)
		expect(() => buildJSONRoundtrip(stringShape({ pattern: /^[a-z]+$/ }), 7)).toThrow(
			'a pattern-constrained string shape cannot be auto-generated',
		)
	})

	it('compiles a widened declaration whose static type the caller no longer carries', () => {
		const contract = compileWidenedContract(compositeShape(2))
		expect(typeof contract.is).toBe('function')
		expect(typeof contract.parse).toBe('function')
		expect(typeof contract.audit).toBe('function')
		expect(typeof contract.explain).toBe('function')
		expect(typeof contract.generate).toBe('function')
		expect(contract.schema).toBeDefined()
	})

	it('answers type identity rather than mutual assignability', () => {
		const identical: Expect<Equal<StringShape, StringShape>> = true
		// The control: the two are mutually assignable and not identical, so a
		// check built on assignability would answer `true` here.
		const assignable: Equal<{ a: string }, { a: string; b?: never }> = false
		expect(identical).toBe(true)
		expect(assignable).toBe(false)
	})
})
