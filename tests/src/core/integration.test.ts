// Integration coverage for the full contract primitive matrix (AGENTS §14 /
// contract behavior): every leaf shape × variation, every container and
// wrapper, large composite contracts, and cross-pair composition with the
// guard combinators. Uses the shared factories/roundtrip helpers from
// tests/setup.ts rather than re-declaring shapes locally.
//
// Shared setup helpers exercise lockstep and JSON roundtrips while each case
// retains its own public cross-module composition boundary.
import { describe, expect, it, vi } from 'vitest'
import type { Guard } from '@src/core'
import type { Tree } from '../../setup.js'
import {
	arrayShape,
	attempt,
	booleanShape,
	cloneJSONValue,
	compileGenerator,
	compileSchema,
	ContractError,
	createContract,
	enumOf,
	integerShape,
	intersectionOf,
	isContractError,
	isNumber,
	isRegExp,
	isString,
	JSONCloner,
	jsonShape,
	keyOf,
	lazyOf,
	literalOf,
	literalShape,
	mapOf,
	matchOf,
	nullableShape,
	nullShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	parseEnum,
	parseJSONAs,
	recordOf,
	recordShape,
	SchemaCloner,
	seededRandom,
	setOf,
	ShapeCloner,
	ShapeValidator,
	stringOf,
	stringShape,
	stringToFormat,
	unionShape,
	valueToSchema,
	validateShapeDepth,
} from '@src/core'
import type { TerminalIntrinsic, TerminalLie } from '../../setup.js'
import {
	buildTree,
	captured,
	compileWidenedContract,
	compositeShape,
	createInertOutcome,
	createWorkBound,
	denyRecognition,
	expectJSONRoundtrip,
	expectLockstep,
	findInstallationControls,
	findVacuousControls,
	fingerprintOwnership,
	leafShapeVariations,
	lieIntrinsic,
	OWNED_MEMBERS,
	OWNED_STATICS,
	publicDoors,
	redirectIntrinsic,
	replaceAccessor,
	replaceIntrinsic,
	TERMINAL_CONSTRUCTORS,
	TERMINAL_HOOKS,
	TERMINAL_LIES,
	TERMINAL_MEMBERS,
} from '../../setup.js'

const SEEDS = [0, 1, 7, 42, 999]
const MANY_SEEDS = Array.from({ length: 10 }, (_value, index) => index * 13 + 1)

describe('per-primitive roundtrips', () => {
	for (const [label, shape] of leafShapeVariations()) {
		describe(`${label}`, () => {
			it('is lockstep-sound across seeds', () => {
				expect(() => {
					for (const seed of SEEDS) expectLockstep(shape, seed)
				}).not.toThrow()
			})

			it('roundtrips through JSON byte-for-byte across seeds', () => {
				expect(() => {
					for (const seed of SEEDS) expectJSONRoundtrip(shape, seed)
				}).not.toThrow()
			})
		})
	}
})

describe('container / wrapper roundtrips', () => {
	it('arrayShape over several leaf kinds, including bounds', () => {
		const shapes = [
			arrayShape(stringShape(), { min: 1, max: 4 }),
			arrayShape(integerShape({ min: 0, max: 10 }), { max: 0 }),
			arrayShape(booleanShape()),
			arrayShape(nullShape(), { min: 2, max: 2 }),
		]
		expect(() => {
			for (const shape of shapes) {
				for (const seed of SEEDS) {
					expectLockstep(shape, seed)
					expectJSONRoundtrip(shape, seed)
				}
			}
		}).not.toThrow()
	})

	it('recordShape dictionaries', () => {
		const shapes = [recordShape(integerShape({ min: 0 })), recordShape(stringShape({ max: 5 }))]
		expect(() => {
			for (const shape of shapes) {
				for (const seed of SEEDS) {
					expectLockstep(shape, seed)
					expectJSONRoundtrip(shape, seed)
				}
			}
		}).not.toThrow()
	})

	it('unionShape / oneOfShape mixed variants', () => {
		const shapes = [
			unionShape(stringShape(), integerShape(), booleanShape()),
			oneOfShape(nullShape(), stringShape({ min: 1 })),
		]
		expect(() => {
			for (const shape of shapes) {
				for (const seed of SEEDS) {
					expectLockstep(shape, seed)
					expectJSONRoundtrip(shape, seed)
				}
			}
		}).not.toThrow()
	})

	it('nullableShape over leaves', () => {
		const shapes = [nullableShape(stringShape()), nullableShape(integerShape({ min: 0, max: 5 }))]
		expect(() => {
			for (const shape of shapes) {
				for (const seed of SEEDS) {
					expectLockstep(shape, seed)
					expectJSONRoundtrip(shape, seed)
				}
			}
		}).not.toThrow()
	})

	it('optionalShape inside objectShape — present and absent key handling through parse', () => {
		const shape = objectShape({ name: stringShape({ min: 1 }), bio: optionalShape(stringShape()) })
		const contract = createContract(shape)
		// Present.
		expect(contract.parse({ name: 'Ada', bio: 'hi' })).toEqual({ name: 'Ada', bio: 'hi' })
		// Absent — key genuinely missing from the parsed result, not `undefined`-valued.
		const parsed = contract.parse({ name: 'Ada' })
		expect(parsed).toEqual({ name: 'Ada' })
		expect(parsed !== undefined && Object.hasOwn(parsed, 'bio')).toBe(false)
		expect(() => {
			for (const seed of SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})

	it('additionalProperties open objects', () => {
		const shape = objectShape(
			{ id: stringShape() },
			{ additionalProperties: integerShape({ min: 0 }) },
		)
		const contract = createContract(shape)
		expect(contract.is({ id: 'a', extra: 1 })).toBe(true)
		expect(contract.is({ id: 'a', extra: 'nope' })).toBe(false)
		expect(() => {
			for (const seed of SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})
})

describe('large composite contracts', () => {
	it('compositeShape(2) is lockstep-sound and byte-for-byte across seeds', () => {
		const shape = compositeShape(2)
		expect(() => {
			for (const seed of MANY_SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})

	it('compositeShape(3) is lockstep-sound and byte-for-byte across seeds', () => {
		const shape = compositeShape(3)
		expect(() => {
			for (const seed of MANY_SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})

	it('a kitchen-sink contract combining every shape kind is lockstep-sound and byte-for-byte', () => {
		const shape = objectShape({
			str: stringShape({ min: 1, max: 10, description: 'a string' }),
			num: numberShape({ min: -50, max: 50 }),
			int: integerShape({ min: 0, max: 50 }),
			bool: booleanShape(),
			nul: nullShape(),
			lit: literalShape(['x', 1, false]),
			arr: arrayShape(stringShape(), { min: 0, max: 3 }),
			obj: objectShape({ inner: integerShape({ min: 0 }) }),
			uni: unionShape(stringShape(), integerShape()),
			one: oneOfShape(booleanShape(), nullShape()),
			opt: optionalShape(stringShape()),
			nullable: nullableShape(stringShape()),
			rec: recordShape(booleanShape()),
			json: jsonShape(),
		})
		expect(() => {
			for (const seed of MANY_SEEDS) {
				expectLockstep(shape, seed)
				expectJSONRoundtrip(shape, seed)
			}
		}).not.toThrow()
	})

	it('determinism: the same seed produces deep-equal output across contracts of the same shape', () => {
		const shape = compositeShape(2)
		// `compileWidenedContract` (not `createContract` directly) — `shape`'s
		// static type is the widened `ContractShape` union, and letting
		// `createContract`'s generic `Infer<S>` overload resolve against that
		// union is excessively deep for the type checker (TS2589).
		const first = compileWidenedContract(shape).generate(seededRandom(55))
		const second = compileWidenedContract(shape).generate(seededRandom(55))
		expect(first).toEqual(second)
	})

	it('schema sanity: compileSchema(shape) deep-equals contract.schema', () => {
		const shape = compositeShape(3)
		// See the note above — `shape` is a widened `ContractShape`.
		const contract = compileWidenedContract(shape)
		expect(contract.schema).toEqual(compileSchema(shape))
	})

	it('a representative composite compiles to a hand-authored expected JSON Schema', () => {
		const shape = objectShape(
			{
				name: stringShape({ min: 1 }),
				age: optionalShape(integerShape({ min: 0 })),
				active: nullableShape(booleanShape()),
				roles: arrayShape(literalShape(['admin', 'guest'])),
			},
			{ additionalProperties: numberShape() },
		)
		expect(compileSchema(shape)).toEqual({
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1 },
				age: { type: 'integer', minimum: 0 },
				active: { anyOf: [{ type: 'boolean' }, { type: 'null' }] },
				roles: { type: 'array', items: { enum: ['admin', 'guest'] } },
			},
			required: ['name', 'active', 'roles'],
			additionalProperties: { type: 'number' },
		})
	})
})

describe('caller-reachable dispatch on a path whose contract forbids failure', () => {
	// SCOPE, stated first because it decides what a failure here MEANS. The
	// same-realm intrinsic-modification threat model is out of scope for this
	// package: an adversary who can rewrite `String.prototype.trim` in this realm
	// already has arbitrary code execution and can replace the package outright,
	// so defending is impossible in principle and no comparable validation library
	// attempts it. Everything in this block is a REGRESSION GUARD over hardening
	// that is already paid for and that raises attacker cost. It is not an
	// acceptance gate: a NEW hostile-intrinsic vector found later is recorded as a
	// boundary case, not treated as a release blocker. What remains in scope, and
	// what the rest of the suite gates, is every defect reachable with HONEST
	// intrinsics — hostile DATA, not a hostile realm.
	//
	// The defect class, not its instances. Four rounds fixed the sites they were
	// shown and were defeated by the same class arriving through a door nobody
	// enumerated: a replaceable prototype MEMBER, a prototype-chain READ, a
	// symbol-keyed protocol HOOK, and finally a redirect that LIES instead of
	// throwing. The corpora below are therefore drawn by rule rather than by
	// recollection — one rule per corpus, each with a control drawn from outside
	// the population that rule defines — and the doors are enumerated from the
	// barrel, because the engine that wrote a fix is the least able to see that
	// it verified the fix only where the defect was found.
	const doors = publicDoors()
	const throwing: readonly TerminalIntrinsic[] = [
		...TERMINAL_CONSTRUCTORS,
		...TERMINAL_HOOKS,
		...TERMINAL_MEMBERS,
		...OWNED_STATICS,
	]

	it('lets no public door escape with a raw caller value while any member is redirected', () => {
		const escaped: string[] = []

		for (let row = 0; row < throwing.length; row += 1) {
			const intrinsic = throwing[row]
			if (intrinsic === undefined) continue
			const sentinel = Object.freeze({ stage: intrinsic.label })
			for (let index = 0; index < doors.length; index += 1) {
				const door = doors[index]
				if (door === undefined || door.refusal === 'raw') continue
				const outcome = redirectIntrinsic(intrinsic, sentinel, (armed) =>
					armed ? attempt(door.open) : createInertOutcome(undefined),
				)
				if (outcome.success) continue
				if (door.refusal === 'total' || !isContractError(outcome.error)) {
					escaped[escaped.length] = `${intrinsic.label} at ${door.label}`
				}
			}
		}

		expect(escaped).toEqual([])
	})

	it('proves every redirected member arms, so a clean sweep is not a silent no-op', () => {
		// The negative control the sweep above is worthless without: each row is
		// installed and then reached THROUGH the member it replaced, so a row that
		// silently failed to install reports as inert rather than as clean.
		const inert: string[] = []

		for (let row = 0; row < throwing.length; row += 1) {
			const intrinsic = throwing[row]
			if (intrinsic === undefined) continue
			const sentinel = Object.freeze({ stage: intrinsic.label })
			const outcome = redirectIntrinsic(intrinsic, sentinel, (armed) =>
				armed
					? attempt(() => {
							const member = captured.get(intrinsic.target, intrinsic.key)
							return typeof member === 'function'
								? captured.apply(member, intrinsic.target, [])
								: member
						})
					: createInertOutcome(undefined),
			)
			if (outcome.success || outcome.error !== sentinel) inert[inert.length] = intrinsic.label
		}

		expect(inert).toEqual([])
	})

	it('keeps every ownership guarantee it publishes while a redirect lies instead of throwing', () => {
		// The fourth shape, and the only one no earlier instrument could express:
		// `Object.freeze = (value) => value` makes every cloner SUCCEED and publish
		// a mutable graph, so a corpus deciding escapes by `thrown === sentinel`
		// reports green forever. The population asserted here is DERIVED from the
		// honest run rather than listed: a door that publishes a deeply frozen,
		// marker-free value in an honest realm must publish one or refuse.
		const honest = new Map<string, string>()
		for (let index = 0; index < doors.length; index += 1) {
			const door = doors[index]
			if (door === undefined) continue
			const outcome = attempt(door.open)
			honest.set(door.label, outcome.success ? fingerprintOwnership(outcome.value) : 'refused')
		}
		const unfaithful: string[] = []

		for (let row = 0; row < TERMINAL_LIES.length; row += 1) {
			const lie = TERMINAL_LIES[row]
			if (lie === undefined) continue
			for (let index = 0; index < doors.length; index += 1) {
				const door = doors[index]
				if (door === undefined || door.refusal === 'raw') continue
				const baseline = honest.get(door.label)
				if (baseline === undefined || baseline === 'refused') continue
				const outcome = lieIntrinsic(lie, (armed) =>
					armed ? attempt(door.open) : createInertOutcome(undefined),
				)
				const site = `${lie.label} at ${door.label}`
				if (!outcome.success) {
					if (door.refusal === 'total' || !isContractError(outcome.error)) {
						unfaithful[unfaithful.length] = `${site}: refused rawly`
						continue
					}
					// Fidelity is asked of a REFUSAL too, not only of a success. A
					// diagnostic is a published value: the round that fixed an injected
					// `context.path` at one door left it open at two others, and this
					// sweep could not see it because it inspected `outcome.value` alone.
					const diagnosed = `${outcome.error.message} ${fingerprintOwnership(outcome.error.context)}`
					if (diagnosed.includes('ghost') || diagnosed.includes('INJECTED')) {
						unfaithful[unfaithful.length] = `${site}: published an injected diagnostic`
					}
					continue
				}
				const published = fingerprintOwnership(outcome.value)
				if (!baseline.includes('MUTABLE') && published.includes('MUTABLE')) {
					unfaithful[unfaithful.length] = `${site}: published a mutable graph`
				}
				if (published.includes('ghost') || published.includes('INJECTED')) {
					unfaithful[unfaithful.length] = `${site}: published an injected member`
				}
			}
		}

		expect(unfaithful).toEqual([])
	})

	it('publishes a marker-free diagnostic while a lying iterator injects into published paths', () => {
		// The lie that never touches a snapshot and still reaches the caller: a
		// diagnostic path is built by array spread, so an iterator yielding one
		// extra value writes the caller's text into a refusal this package
		// authored.
		const hostile = Object.freeze({
			type: 'object',
			properties: Object.freeze({ a: Object.freeze({ type: 'string', min: -1 }) }),
		})
		const lie = TERMINAL_LIES.find((row) => row.key === Symbol.iterator)
		expect(lie).toBeDefined()
		if (lie === undefined) return

		const outcome = lieIntrinsic(lie, (armed) =>
			armed ? attempt(() => validateShapeDepth(hostile)) : createInertOutcome(undefined),
		)

		expect(outcome.success).toBe(false)
		if (outcome.success) return
		expect(isContractError(outcome.error)).toBe(true)
		if (!isContractError(outcome.error)) return
		expect(fingerprintOwnership(outcome.error.context)).not.toContain('INJECTED')
	})
})

describe('error recognition', () => {
	// Recognition is the package's own must-not-fail path: every engine routes
	// its authored-versus-adopted decision through it, so a caller who can deny
	// it makes the package rewrap an error it authored as an unreadable failure,
	// and a caller who can make it throw puts a raw value through fifteen doors.
	const inputs: readonly unknown[] = [
		undefined,
		null,
		0,
		Number.NaN,
		'text',
		Symbol('brand'),
		{},
		[],
		Object.create(null),
		new Error('foreign'),
		Object.create(ContractError.prototype),
		new Proxy(
			{},
			{
				get: () => {
					throw new Error('trap')
				},
			},
		),
	]

	it('answers every input without throwing while any writable member of the class is a thrower', () => {
		const escaped: string[] = []

		for (let row = 0; row < OWNED_STATICS.length; row += 1) {
			const intrinsic = OWNED_STATICS[row]
			if (intrinsic === undefined) continue
			const sentinel = Object.freeze({ stage: intrinsic.label })
			for (let index = 0; index < inputs.length; index += 1) {
				const value = inputs[index]
				const outcome = redirectIntrinsic(intrinsic, sentinel, (armed) =>
					armed ? attempt(() => isContractError(value)) : createInertOutcome(false),
				)
				if (!outcome.success) escaped[escaped.length] = `${intrinsic.label} at input ${index}`
				else if (outcome.value !== false) escaped[escaped.length] = `${intrinsic.label} forged`
			}
		}

		expect(escaped).toEqual([])
	})

	it('still recognizes an authored error while any writable member of the class denies', () => {
		const authored = new ContractError('authored', { code: 'structure' })
		const denied: string[] = []

		for (let row = 0; row < OWNED_STATICS.length; row += 1) {
			const intrinsic = OWNED_STATICS[row]
			if (intrinsic === undefined) continue
			const answers = replaceIntrinsic(intrinsic.target, intrinsic.key, denyRecognition, () =>
				attempt(() => ({
					authored: isContractError(authored),
					foreign: isContractError(new Error('foreign')),
				})),
			)
			if (!answers.success) denied[denied.length] = `${intrinsic.label} threw`
			else if (!answers.value.authored || answers.value.foreign) {
				denied[denied.length] = intrinsic.label
			}
		}

		expect(denied).toEqual([])
	})

	it('publishes the authored diagnostic while any writable member of the class denies', () => {
		// The symptom the private brand was chosen to remove, asked at the door
		// rather than at the guard: a denied recognition demotes the authored
		// refusal to a cause and republishes a blank structural failure.
		const hostile = Object.freeze({ type: 'string', min: -1 })
		const degraded: string[] = []

		for (let row = 0; row < OWNED_STATICS.length; row += 1) {
			const intrinsic = OWNED_STATICS[row]
			if (intrinsic === undefined) continue
			const outcome = replaceIntrinsic(intrinsic.target, intrinsic.key, denyRecognition, () =>
				attempt(() => validateShapeDepth(hostile)),
			)
			if (outcome.success || !isContractError(outcome.error)) {
				degraded[degraded.length] = `${intrinsic.label} did not refuse`
				continue
			}
			if (outcome.error.code !== 'bound') degraded[degraded.length] = intrinsic.label
		}

		expect(degraded).toEqual([])
	})

	it('pins the one member on the recognition path against replacement', () => {
		// The corpus above draws only members a caller CAN replace, so a member that
		// became non-writable would silently leave the population. Naming it here
		// keeps the exclusion a measured fact rather than a gap.
		const descriptor = Object.getOwnPropertyDescriptor(ContractError, 'guard')

		expect(descriptor).toBeDefined()
		expect(descriptor?.writable).toBe(false)
		expect(descriptor?.configurable).toBe(false)
	})

	it('exposes no member of the class that answers the recognition question', () => {
		// Exactly one public spelling. A second one is not merely surplus API: it
		// is the caller-writable surface the private brand existed to remove, and
		// publishing the brand test as a writable static reintroduced it verbatim.
		const answering: string[] = []
		const authored = new ContractError('authored', { code: 'structure' })

		for (const member of Object.getOwnPropertyNames(ContractError)) {
			const descriptor = Object.getOwnPropertyDescriptor(ContractError, member)
			if (descriptor === undefined || typeof descriptor.value !== 'function') continue
			if (member === 'prototype') continue
			const answered = attempt(() => descriptor.value(authored) === true)
			if (answered.success && answered.value) answering[answering.length] = member
		}

		expect(answering).toEqual([])
	})
})

describe('cross-pair composition', () => {
	it('parseJSONAs round-trips a generated value through its own compiled guard', () => {
		const shape = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape({ min: 0, max: 120 }),
			tags: arrayShape(stringShape(), { max: 3 }),
		})
		const contract = createContract(shape)
		for (const seed of SEEDS) {
			const value = contract.generate(seededRandom(seed))
			const text = JSON.stringify(value)
			expect(parseJSONAs(text, contract.is)).toEqual(value)
		}
		// A malformed document never throws, even against a live compiled guard.
		expect(parseJSONAs('{not json', contract.is)).toBeUndefined()
	})

	it('lazyOf recursive guard validates a nested tree built from contract-generated leaves', () => {
		const isTree: Guard<Tree<number>> = recordOf({
			value: isNumber,
			children: (input: unknown): input is ReadonlyArray<Tree<number>> =>
				Array.isArray(input) && input.every((entry) => lazyOf(() => isTree)(entry)),
		})

		const valueContract = createContract(integerShape({ min: 0, max: 1000 }))
		const random = seededRandom(3)
		const tree = buildTree(() => valueContract.generate(random), 3)
		expect(isTree(tree)).toBe(true)
		// A depth-mismatched shape (a string where a number is expected) fails.
		expect(isTree({ value: 'x', children: [] })).toBe(false)
	})
})

describe('the redirection instruments can report a failure', () => {
	// An instrument is not evidence until it has failed. Each control below feeds
	// the instrument a subject that IS unfaithful and requires the failing
	// verdict, so a clean sweep above distinguishes a sound package from a blind
	// probe.
	it('the ownership fingerprint reports a mutable graph and an injected member', () => {
		const faithful = fingerprintOwnership(Object.freeze({ real: 'a' }))
		const mutable = fingerprintOwnership({ real: 'a' })
		const injected = fingerprintOwnership(Object.freeze({ real: 'a', ghost: 'b' }))

		expect(faithful).not.toContain('MUTABLE')
		expect(mutable).toContain('MUTABLE')
		expect(injected).toContain('ghost')
		expect(faithful).not.toContain('ghost')
	})

	it('the ownership fingerprint reports a nested mutable child', () => {
		const shallow = Object.freeze({ child: { real: 'a' } })

		expect(fingerprintOwnership(shallow)).toContain('MUTABLE')
	})

	it('every lying row installs and every control answers while it is armed', () => {
		// The liveness half, and the sole spelling of it in this file: a substitute
		// that failed to install answers honestly, and an honest answer is exactly
		// what the fidelity sweep above expects to see, so an unarmed row would
		// report a clean verdict for an attack that never happened. Collected rather
		// than asserted per row, so one silent installation failure names itself
		// instead of stopping the sweep at the first row.
		const inert: string[] = []
		for (let row = 0; row < TERMINAL_LIES.length; row += 1) {
			const lie = TERMINAL_LIES[row]
			if (lie === undefined) continue
			if (!lieIntrinsic(lie, (armed) => armed)) inert[inert.length] = lie.label
		}

		expect(inert).toEqual([])
	})

	it('names a control that cannot report its failing verdict, and clears every shipped row', () => {
		// The half the liveness sweep above structurally cannot ask. It requires
		// `true` while a row is armed, and `control: () => true` satisfies that
		// forever while observing nothing — which is how `Array.prototype.map`
		// shipped a control comparing a `number | undefined` element against
		// `'INJECTED'`. So each control is run against the HONEST member, where the
		// only sound answer is `false`, and the instrument doing the running is
		// itself controlled: a deliberately vacuous row, substituting the honest
		// member for itself and answering `true` regardless, must be NAMED. Without
		// that second expectation this test passes just as well when the sweep is
		// broken and finds nothing.
		const vacuous: TerminalLie = Object.freeze({
			label: 'a control that answers true against the honest member',
			target: Object,
			key: 'freeze',
			substitute: Object.freeze,
			control: (): boolean => true,
		})

		expect(findVacuousControls(TERMINAL_LIES)).toEqual([])
		expect(findVacuousControls([...TERMINAL_LIES, vacuous])).toEqual([vacuous.label])
	})

	it('names a control that observes installation rather than behaviour', () => {
		// The control drawn from OUTSIDE the vacuity sweep's rule, and the reason it
		// needed one. This row is false unarmed and true armed, so the vacuity sweep
		// can never name it — and it observes only that SOMETHING was installed, so
		// a semantically inert substitute would clear every sweep in the file while
		// proving nothing about the package. The discriminator is a member that is
		// behaviourally identical and identity-distinct: a control watching what the
		// member DOES stays silent; a control watching the descriptor speaks.
		const honest = Object.freeze
		const blind: TerminalLie = Object.freeze({
			label: 'a control that observes only that something was installed',
			target: Object,
			key: 'freeze',
			substitute: (value: unknown): unknown => value,
			control: (): boolean => captured.descriptor(Object, 'freeze')?.value !== honest,
		})

		expect(findVacuousControls([blind])).toEqual([])
		expect(lieIntrinsic(blind, (armed) => armed)).toBe(true)
		expect(findInstallationControls(TERMINAL_LIES)).toEqual([])
		expect(findInstallationControls([blind])).toEqual([blind.label])
	})

	it('reaches the members the repaired door rows were armed against', () => {
		// The gap this closes: a row that arms and a row that REACHES are different
		// facts. `compileGenerator` was driven with an explicit random source, so
		// the default seed it was armed against never evaluated; `enumOf` was driven
		// with a record, so the membership read short-circuited before the armed
		// member. Each row below is answered THROUGH the code the sweep attacks.
		const doors = publicDoors()
		const required = [
			'compileGenerator/default',
			'enumOf/stranger',
			'literalOf/stranger',
			'parseEnum/stranger',
		]
		const labels: string[] = []
		for (let index = 0; index < doors.length; index += 1) {
			const door = doors[index]
			if (door !== undefined) labels[labels.length] = door.label
		}
		for (const label of required) expect(labels).toContain(label)

		const answerTrue = (): boolean => true
		const thrower = (): never => {
			throw new Error('clock')
		}
		const membership = replaceIntrinsic(Set.prototype, 'has', answerTrue, () => ({
			enumerated: enumOf({ red: 'r' })('NOT-A-MEMBER'),
			literal: literalOf('a', 'b')('NOT-A-MEMBER'),
		}))
		const clock = replaceIntrinsic(Date, 'now', thrower, () =>
			attempt(() => compileGenerator(stringShape())),
		)

		expect(membership).toEqual({ enumerated: false, literal: false })
		expect(clock.success).toBe(true)
	})
})

/**
 * A membership answer spelled the way this package used to spell it: through a
 * method on a class prototype every consumer can reach.
 *
 * @remarks
 * The control drawn from OUTSIDE the membership sweeps' populations. Both
 * sweeps below are only evidence once they have reported a failing verdict, and
 * neither can report one against a package that no longer contains this
 * construct — so the construct is declared here, driven through the identical
 * doors, and required to be NAMED. An empty verdict from an instrument that has
 * never named anything measures nothing.
 */
class ReachableVocabulary {
	readonly #members: Set<unknown>

	constructor(values: readonly unknown[]) {
		this.#members = new Set(values)
	}

	has(value: unknown): boolean {
		return this.#members.has(value)
	}
}

/** An iterative walk whose termination genuinely rests on `WeakSet.prototype.has`. */
function walkUnbounded(root: object): number {
	const active = new WeakSet<object>()
	const pending: object[] = [root]
	let visits = 0
	while (pending.length > 0) {
		const node = pending.pop()
		if (node === undefined) continue
		if (active.has(node)) continue
		active.add(node)
		visits += 1
		for (const value of Object.values(node)) {
			if (typeof value === 'object' && value !== null) pending[pending.length] = value
		}
	}
	return visits
}

describe('no caller-reachable member decides a membership answer', () => {
	// Every door and every fixture is built HERE, before any redirect can arm,
	// exactly as a consumer builds a guard at import time and calls it later. A
	// door built inside the armed window measures its own construction rather
	// than the answer, which is how three rounds of this corpus armed an attack
	// they never reached.
	const literalGuard = literalOf('a', 'b')
	const enumGuard = enumOf({ up: 'up', down: 'down' })
	const keyGuard = keyOf({ red: '#f00', green: '#0f0' })
	const shapeGuard = recordOf({ name: isString })
	const hexGuard = matchOf(/^[0-9a-f]+$/)
	const refinedGuard = stringOf({ pattern: /^a+$/ })
	const stringSetGuard = setOf(isString)
	const numberMapGuard = mapOf(isString, isNumber)
	const bothGuard = intersectionOf(isString)
	const literalContract = createContract(literalShape(['a', 'b']))
	const patternShape = stringShape({ pattern: /^a+$/ })
	const patternContract = createContract(patternShape)
	const mixedSet = new Set<unknown>(['a', 42])
	const mixedMap = new Map<unknown, unknown>([['a', 'not-a-number']])
	const reachable = new ReachableVocabulary(['a', 'b'])

	const answers: ReadonlyArray<readonly [string, () => unknown, unknown]> = [
		['literalOf/stranger', () => literalGuard('NOT-A-MEMBER'), false],
		['literalOf/member', () => literalGuard('a'), true],
		['enumOf/stranger', () => enumGuard('NOT-A-MEMBER'), false],
		['enumOf/member', () => enumGuard('up'), true],
		['keyOf/stranger', () => keyGuard('purple'), false],
		['keyOf/member', () => keyGuard('red'), true],
		['recordOf/undeclared', () => shapeGuard({ name: 'x', UNDECLARED: 1 }), false],
		['recordOf/member', () => shapeGuard({ name: 'x' }), true],
		['parseEnum/stranger', () => parseEnum('NOT-A-MEMBER', ['a', 'b']), undefined],
		['parseEnum/member', () => parseEnum('a', ['a', 'b']), 'a'],
		['contract.is/literal', () => literalContract.is('NOT-A-MEMBER'), false],
		['contract.parse/literal', () => literalContract.parse('NOT-A-MEMBER'), undefined],
		['matchOf/stranger', () => hexGuard('THIS-IS-NOT-HEX'), false],
		['matchOf/member', () => hexGuard('1a2f'), true],
		// Built INSIDE the armed window on purpose: a pattern guard reads its
		// source and flags while it is constructed, so a lying `source` getter, a
		// lying `flags` getter, and a lying `replaceAll` are only reachable here.
		['matchOf/built', () => matchOf(/^abc$/)('ABC'), false],
		['stringOf/built', () => stringOf({ pattern: /^a+$/ })('ZZZ'), false],
		['stringOf/stranger', () => refinedGuard('ZZZ'), false],
		['stringOf/member', () => refinedGuard('aaa'), true],
		['contract.is/pattern', () => patternContract.is('ZZZ'), false],
		['contract.parse/pattern', () => patternContract.parse('ZZZ'), undefined],
		['contract.audit/pattern', () => patternContract.audit('ZZZ').length > 0, true],
		['contract.explain/pattern', () => patternContract.explain('ZZZ').length > 0, true],
		['setOf/stranger', () => stringSetGuard(mixedSet), false],
		['mapOf/stranger', () => numberMapGuard(mixedMap), false],
		['intersectionOf/stranger', () => bothGuard(42), false],
		['intersectionOf/member', () => bothGuard('a'), true],
		['stringToFormat/stranger', () => stringToFormat('NOT-A-UUID'), undefined],
		['stringToFormat/member', () => stringToFormat('550e8400-e29b-41d4-a716-446655440000'), 'uuid'],
		[
			'valueToSchema/format',
			() => JSON.stringify(valueToSchema('NOT-A-UUID', { format: true })),
			'{"type":"string"}',
		],
		[
			'compileSchema/pattern',
			() => JSON.stringify(compileSchema(patternShape)),
			'{"type":"string","pattern":"^a+$"}',
		],
		['isRegExp/stranger', () => isRegExp('x'), false],
	]

	const control: readonly [string, () => unknown, unknown] = [
		'ReachableVocabulary/stranger',
		() => reachable.has('NOT-A-MEMBER'),
		false,
	]

	function driftOf(
		door: readonly [string, () => unknown, unknown],
		label: string,
		drift: string[],
	): void {
		const outcome = attempt(door[1])
		if (!outcome.success || outcome.value !== door[2]) {
			drift[drift.length] = `${label} at ${door[0]}`
		}
	}

	it('answers every membership question honestly in an honest realm', () => {
		const wrong: string[] = []
		for (let index = 0; index < answers.length; index += 1) {
			const door = answers[index]
			if (door !== undefined) driftOf(door, 'honest', wrong)
		}
		driftOf(control, 'honest', wrong)

		expect(wrong).toEqual([])
	})

	it('answers every membership question honestly while a host member lies', () => {
		const injectString = function* onlyStrings(this: ReadonlySet<unknown>): Generator<unknown> {
			for (const entry of Array.from(this.values())) if (typeof entry === 'string') yield entry
		}
		const injectPair = function* onlyNumbers(
			this: ReadonlyMap<unknown, unknown>,
		): Generator<unknown> {
			for (const entry of Array.from(this.entries())) yield [entry[0], 1]
		}
		const lies: ReadonlyArray<readonly [string, object, PropertyKey, unknown]> = [
			['Set.prototype.has answers true', Set.prototype, 'has', (): boolean => true],
			['Set.prototype.has answers false', Set.prototype, 'has', (): boolean => false],
			['WeakSet.prototype.has answers true', WeakSet.prototype, 'has', (): boolean => true],
			['WeakSet.prototype.has answers false', WeakSet.prototype, 'has', (): boolean => false],
			['Map.prototype.has answers true', Map.prototype, 'has', (): boolean => true],
			['Array.prototype.every answers true', Array.prototype, 'every', (): boolean => true],
			['Array.prototype.some answers true', Array.prototype, 'some', (): boolean => true],
			['Array.prototype.includes answers true', Array.prototype, 'includes', (): boolean => true],
			['RegExp.prototype.test answers true', RegExp.prototype, 'test', (): boolean => true],
			['RegExp.prototype.test answers false', RegExp.prototype, 'test', (): boolean => false],
			['RegExp.prototype.exec answers a decoy', RegExp.prototype, 'exec', (): unknown => ['D']],
			['RegExp.prototype.exec answers null', RegExp.prototype, 'exec', (): unknown => null],
			['String.prototype.replaceAll answers a flag', String.prototype, 'replaceAll', () => 'i'],
			[
				'Set.prototype[Symbol.iterator] hides a stranger',
				Set.prototype,
				Symbol.iterator,
				injectString,
			],
			[
				'Map.prototype[Symbol.iterator] hides a stranger',
				Map.prototype,
				Symbol.iterator,
				injectPair,
			],
		]
		const drift: string[] = []
		const named: string[] = []

		for (let row = 0; row < lies.length; row += 1) {
			const lie = lies[row]
			if (lie === undefined) continue
			for (let index = 0; index < answers.length; index += 1) {
				const door = answers[index]
				if (door === undefined) continue
				replaceIntrinsic(lie[1], lie[2], lie[3], () => driftOf(door, lie[0], drift))
			}
			replaceIntrinsic(lie[1], lie[2], lie[3], () => driftOf(control, lie[0], named))
		}
		const accessors: ReadonlyArray<'source' | 'flags'> = ['source', 'flags']
		for (const accessor of accessors) {
			for (let index = 0; index < answers.length; index += 1) {
				const door = answers[index]
				if (door === undefined) continue
				replaceAccessor(
					RegExp.prototype,
					accessor,
					() => '.*',
					() => driftOf(door, `RegExp.prototype.${accessor} answers a decoy`, drift),
				)
			}
		}

		expect(drift).toEqual([])
		// The control the sweep is worthless without: a membership answer that IS
		// reachable must be named, or an empty verdict means only that nothing ran.
		expect(named.length).toBeGreaterThan(0)
	})

	it('answers every membership question honestly while any exported class member lies', () => {
		const vocabularyMember: TerminalIntrinsic = {
			label: 'ReachableVocabulary.prototype.has',
			target: ReachableVocabulary.prototype,
			key: 'has',
			via: 'replacement',
		}
		const rows: readonly TerminalIntrinsic[] = [...OWNED_MEMBERS, Object.freeze(vocabularyMember)]
		const substitutes: ReadonlyArray<() => boolean> = [(): boolean => true, (): boolean => false]
		const drift: string[] = []
		const named: string[] = []

		for (let row = 0; row < rows.length; row += 1) {
			const member = rows[row]
			if (member === undefined) continue
			for (let choice = 0; choice < substitutes.length; choice += 1) {
				const substitute = substitutes[choice]
				for (let index = 0; index < answers.length; index += 1) {
					const door = answers[index]
					if (door === undefined) continue
					replaceIntrinsic(member.target, member.key, substitute, () =>
						driftOf(door, member.label, drift),
					)
				}
				replaceIntrinsic(member.target, member.key, substitute, () =>
					driftOf(control, member.label, named),
				)
			}
		}

		expect(drift).toEqual([])
		expect(named).toContain('ReachableVocabulary.prototype.has at ReachableVocabulary/stranger')
	})

	it('documents its own composition, because a round asserted this corpus was empty', () => {
		// The claim under repair: "every writable prototype member of every class
		// this package exports — a population that is empty, because each of those
		// classes pins its prototype while it is defined." The second half is true;
		// the first is not, and the two were run together into a false universal.
		// The rule draws from every exported CALLABLE, and an ordinary function's
		// `.prototype.constructor` is writable, so the corpus is one row per
		// exported plain function and zero rows per exported class.
		expect(OWNED_MEMBERS.length).toBeGreaterThan(0)
		// The SIZE, not just the shape. `toBeGreaterThan(0)` survived eight new
		// exports while the guide and this file both went on saying 205, which is
		// the drift a shape-only assertion cannot see. This literal is the number
		// `guides/src/contract.md` states; a new export moves it, and moving it
		// must be a deliberate edit in both places rather than a silent one here.
		expect(OWNED_MEMBERS.length).toBe(216)
		expect(
			OWNED_MEMBERS.filter((member) => !member.label.endsWith('.prototype.constructor')).map(
				(member) => member.label,
			),
		).toEqual([])
		for (const owner of [JSONCloner, SchemaCloner, ShapeCloner, ShapeValidator, ContractError]) {
			expect(OWNED_MEMBERS.some((member) => member.label.startsWith(`${owner.name}.`))).toBe(false)
		}
	})

	it('refuses a cyclic clone in bounded time while the visitation member lies', () => {
		// The shape every other instrument presupposes away: the damage here is the
		// ABSENCE of an answer, so the substitute carries its own work bound and a
		// door that stopped terminating names itself instead of hanging the suite.
		const overflow = Object.freeze({ stage: 'unbounded' })
		const cyclic: Record<string, unknown> = { name: 'root' }
		cyclic.self = cyclic
		const bound = createWorkBound(2000, overflow)
		const outcome = replaceIntrinsic(WeakSet.prototype, 'has', bound.deny, () =>
			attempt(() => cloneJSONValue(cyclic)),
		)
		// The control: a walk whose termination genuinely rests on the lying member
		// must overflow, so an in-bounds verdict above is evidence rather than an
		// instrument that could never report one.
		const naive = createWorkBound(2000, overflow)
		const naiveOutcome = replaceIntrinsic(WeakSet.prototype, 'has', naive.deny, () =>
			attempt(() => walkUnbounded(cyclic)),
		)

		const refusal: unknown = outcome.success ? undefined : outcome.error
		const naiveRefusal: unknown = naiveOutcome.success ? undefined : naiveOutcome.error

		expect(outcome.success).toBe(false)
		expect(refusal).not.toBe(overflow)
		expect(isContractError(refusal) ? refusal.message : 'not a ContractError').toBe(
			'cloneJSONValue: cycle detected',
		)
		expect(naiveOutcome.success).toBe(false)
		expect(naiveRefusal).toBe(overflow)
	})

	it('refuses to define its error class when its own pin cannot be installed', async () => {
		// `installing is not reading`: the static block closes the window in which
		// anything could READ an unpinned member, and says nothing about whether the
		// pin INSTALLS. A module that evaluated earlier can no-op the one dispatch
		// the installation makes, after which the pin silently never happened.
		const genuine = Object.defineProperty
		const selective = function (
			target: object,
			key: PropertyKey,
			descriptor: PropertyDescriptor,
		): object {
			return key === 'guard' ? target : genuine(target, key, descriptor)
		}
		const original = captured.descriptor(Object, 'defineProperty')
		if (original === undefined) throw new Error('Object.defineProperty descriptor is absent')
		captured.define(Object, 'defineProperty', { ...original, value: selective })
		// A fresh module record is the only way to re-run a static block, and
		// `resetModules` is what makes the record fresh. It is not a mock and
		// simulates nothing: it discards the registry so the REAL module evaluates
		// again, under the sabotage this test installs. The registry is reset again
		// afterwards so the discarded copy never becomes a sibling test's import.
		let outcome: { readonly success: boolean; readonly error?: unknown }
		try {
			vi.resetModules()
			const loaded: Promise<unknown> = import('../../../src/core/errors.js')
			outcome = await loaded.then(
				() => ({ success: true }),
				(error: unknown) => ({ success: false, error }),
			)
		} finally {
			captured.define(Object, 'defineProperty', original)
			vi.resetModules()
		}

		expect(outcome.success).toBe(false)
	})
})
