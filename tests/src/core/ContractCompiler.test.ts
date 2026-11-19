import type {
	ContractCompilerInterface,
	ContractInterface,
	ContractRefusal,
	ContractShape,
	Infer,
	Result,
	StringShape,
} from '@src/core'
import type { Equal, Expect } from '../../setup.js'
import {
	admitValue,
	arrayShape,
	attempt,
	booleanShape,
	CLONE_NODE_LIMIT,
	compileAuditor,
	compileGenerator,
	compileGuard,
	compileParser,
	compileReporter,
	compileSchema,
	ContractCompiler,
	cloneJSONValue,
	cloneShape,
	createContract,
	functionShape,
	integerShape,
	interfaceShape,
	isContractError,
	isRecord,
	jsonShape,
	literalShape,
	nullableShape,
	nullShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	rawShape,
	recordShape,
	seededRandom,
	shapeShape,
	stringShape,
	undefinedShape,
	unionShape,
} from '@src/core'
import {
	buildHoledArray,
	buildReportingRecord,
	buildUndefinedCorpus,
	findUndefinedLawViolations,
	UNDEFINED_LAW_SHAPES,
	UNDEFINED_ROWS,
	polluteArrayConstruction,
	measureAllocations,
	buildCountedGraph,
	buildCountedSlots,
	buildDeepShape,
	buildSharedDagShape,
	buildStaircaseShape,
	captureContractError,
	pollutePrototype,
	listCompilerDoors,
	ObservedShape,
	ReentrantShape,
	buildDiscriminatedCases,
	findAgreementViolations,
	buildCountedStore,
	buildImplementationRefusals,
	buildImplementationRows,
	createThrowingGetter,
	INTERFACE_LAW_SHAPES,
	PartialStore,
	SessionStore,
	STORE_DECLARATION,
	admissionToVerdict,
	buildCyclicRecord,
	buildLawShapes,
	buildFaultedStore,
	buildOwnedBag,
	buildOwnLawCorpus,
	createShiftingStore,
	createStatefulGetter,
	drawLawShape,
	OWNED_BAG_SHAPE,
	throwSentinel,
} from '../../setup.js'
import { createRecorder } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'

describe('ContractCompiler', () => {
	it('keeps HEAD compiled artifacts under polluted array construction', () => {
		const shape = objectShape({
			name: stringShape({ min: 1, max: 1 }),
			age: optionalShape(integerShape({ min: 1, max: 1 })),
			tags: arrayShape(literalShape(['x']), { min: 1, max: 1 }),
			choice: unionShape(integerShape({ min: 1, max: 1 }), stringShape({ min: 1, max: 1 })),
		})
		const value = { name: 'x', age: 1, tags: ['x'], choice: 1 }
		const compiler = new ContractCompiler(shape)
		const actual = polluteArrayConstruction(() => ({
			schema: compiler.schema,
			accepted: compiler.guard(value),
			parsed: compiler.parser(value),
			audit: compiler.auditor(value),
			report: compiler.reporter(value),
			seeded: compiler.guard(compiler.generator(seededRandom(7))),
			refused: compiler.guard({ ...value, name: 3 }),
		}))
		// HEAD ContractCompiler.ts:717, :875, :1079, :1417, :1746 and :2067 compile these artifacts.
		expect(Object.keys(actual.schema.properties ?? {})).toEqual(['name', 'age', 'tags', 'choice'])
		expect(actual.schema.required).toEqual(['name', 'tags', 'choice'])
		expect(actual.accepted).toBe(true)
		expect(actual.parsed).toEqual(value)
		expect(actual.audit).toEqual([])
		expect(actual.report).toEqual([])
		expect(actual.seeded).toBe(true)
		expect(actual.refused).toBe(false)
	})

	it('exposes exactly the eight ruled getters and pins them', () => {
		const compiler: ContractCompilerInterface<StringShape> = new ContractCompiler(
			stringShape({ min: 1 }),
		)

		expect(Object.getOwnPropertyNames(ContractCompiler.prototype)).toEqual([
			'constructor',
			'schema',
			'guard',
			'parser',
			'auditor',
			'reporter',
			'generator',
			'owner',
			'contract',
		])
		const configurable = Object.getOwnPropertyNames(ContractCompiler.prototype).filter(
			(key) =>
				Object.getOwnPropertyDescriptor(ContractCompiler.prototype, key)?.configurable !== false,
		)
		expect(configurable).toEqual([])
		expect(compiler.guard('Ada')).toBe(true)
		expect(compiler.guard('')).toBe(false)
	})

	it('observes nothing at construction', () => {
		// Inertness is a claim about READS, so it is measured with a node that
		// counts them, and about work, so it is measured with declarations that
		// cannot survive a walk. Neither construction touches either.
		const observed = new ObservedShape()
		const malformed: ContractShape = JSON.parse('{"category":"string","min":5,"max":1}')
		const cyclic: ContractShape = JSON.parse('{"category":"array","items":{"category":"string"}}')
		Reflect.set(cyclic, 'items', cyclic)

		const counted = new ContractCompiler(observed.shape)
		const invalid = new ContractCompiler(malformed)
		const looped = new ContractCompiler(cyclic)

		expect(observed.reads).toBe(0)
		expect(counted).toBeInstanceOf(ContractCompiler)
		// Each refusal arrives at the FIRST getter read, never at construction.
		expect(captureContractError(() => invalid.schema).code).toBe('range')
		expect(captureContractError(() => looped.guard).code).toBe('cycle')
		expect(observed.reads).toBe(0)
		expect(counted.schema).toEqual({ type: 'string', pattern: '^[a-z]+$' })
		expect(observed.reads).toBeGreaterThan(0)
	})

	it('replays each root by identity and bundles those exact seven values', () => {
		const compiler = new ContractCompiler(objectShape({ name: stringShape({ min: 1 }) }))
		const bundle = compiler.contract

		expect(compiler.schema).toBe(compiler.schema)
		expect(compiler.guard).toBe(compiler.guard)
		expect(compiler.parser).toBe(compiler.parser)
		expect(compiler.auditor).toBe(compiler.auditor)
		expect(compiler.reporter).toBe(compiler.reporter)
		expect(compiler.generator).toBe(compiler.generator)
		expect(compiler.owner).toBe(compiler.owner)
		expect(compiler.contract).toBe(bundle)

		expect(Object.keys(bundle)).toEqual([
			'schema',
			'is',
			'parse',
			'audit',
			'explain',
			'generate',
			'own',
		])
		expect(Object.isFrozen(bundle)).toBe(true)
		expect(bundle.schema).toBe(compiler.schema)
		expect(bundle.is).toBe(compiler.guard)
		expect(bundle.parse).toBe(compiler.parser)
		expect(bundle.audit).toBe(compiler.auditor)
		expect(bundle.explain).toBe(compiler.reporter)
		expect(bundle.generate).toBe(compiler.generator)
		expect(bundle.own).toBe(compiler.owner)
	})

	it('keeps every root usable after all six exist and working state is released', () => {
		// Release drops the owned graph, the node index, the order and every family
		// plan. The proof it took nothing the artifacts still need is that all seven
		// answers keep working afterwards — including the bundle, which is assembled
		// from the six roots rather than from the graph.
		const compiler = new ContractCompiler(objectShape({ id: stringShape({ min: 1 }) }))
		const guard = compiler.guard
		const parser = compiler.parser
		const auditor = compiler.auditor
		const reporter = compiler.reporter
		const generator = compiler.generator
		const schema = compiler.schema

		const bundle = compiler.contract

		expect(bundle.is).toBe(guard)
		expect(bundle.schema).toBe(schema)
		expect(guard({ id: 'a' })).toBe(true)
		expect(parser({ id: 'a' })).toEqual({ id: 'a' })
		expect(auditor({ id: 1 })).toHaveLength(1)
		expect(reporter({})).toHaveLength(1)
		expect(typeof generator(seededRandom(7))).toBe('object')
		expect(compiler.contract).toBe(bundle)
		expect(compiler.generator).toBe(generator)
	})

	it('keeps two released compilers answering their own declaration and settles a later one alone', () => {
		// A preservation pin, not a discriminator: release mechanics are `#` private
		// and publish nothing, so no assertion here can observe a sentinel or bind to
		// the freeze — the heap baseline instrument in the campaign record is what
		// discriminates the sentinel design. What this case pins is that two
		// compilers driven past release keep answering for their own declaration,
		// and that a compiler built afterwards settles alone with its own coded
		// error while those answers stand.
		const names = new ContractCompiler(objectShape({ name: stringShape({ min: 1 }) }))
		const counts = new ContractCompiler(objectShape({ count: integerShape({ min: 0 }) }))

		const named = names.contract
		const counted = counts.contract

		expect([named.is({ name: 'Ada' }), named.is({ count: 1 })]).toEqual([true, false])
		expect([counted.is({ count: 1 }), counted.is({ name: 'Ada' })]).toEqual([true, false])
		expect(named.parse({ name: 'Ada' })).toEqual({ name: 'Ada' })
		expect(counted.parse({ count: 1 })).toEqual({ count: 1 })
		expect(named.audit({ name: 1 })).toHaveLength(1)
		expect(counted.audit({ count: 'x' })).toHaveLength(1)
		expect(names.schema).not.toEqual(counts.schema)

		const malformed: ContractShape = JSON.parse('{"category":"string","min":5,"max":1}')
		const later = new ContractCompiler(malformed)
		const error = captureContractError(() => later.contract)

		expect(error.code).toBe('range')
		expect(captureContractError(() => later.guard)).toBe(error)
		expect([named.is({ name: 'Ada' }), counted.is({ count: 1 })]).toEqual([true, true])
		expect(names.contract).toBe(named)
		expect(counts.contract).toBe(counted)
	})

	it('compiles one entry per unique node, so a shared child emits one shared subschema', () => {
		const child = objectShape({ id: stringShape() })
		const shape = objectShape({
			first: child,
			second: child,
			third: objectShape({ id: stringShape() }),
		})
		const schema = new ContractCompiler(shape).schema

		// Shared DECLARATION identity survives into the emitted document…
		expect(schema.properties?.first).toBe(schema.properties?.second)
		// …while two structurally equal but distinct nodes stay distinct.
		expect(schema.properties?.third).toEqual(schema.properties?.first)
		expect(schema.properties?.third).not.toBe(schema.properties?.first)
	})

	it('answers a staircase of shared edges in one pass rather than one per edge', () => {
		// The population the per-node index exists for: one child reached through
		// thirty incoming edges at thirty different depths, one hundred levels deep.
		// Every door must answer it well inside the bar, which a per-edge walk that
		// re-owned and re-gated its subgraph could not.
		const shape = buildStaircaseShape(buildDeepShape(69), 30)
		const started = performance.now()
		const contract = createContract(shape)
		const cost = performance.now() - started

		expect(cost).toBeLessThan(1_000)
		expect(contract.is({})).toBe(false)
		expect(contract.audit({}).length).toBeGreaterThan(0)
	})

	it('refuses a declaration whose expansion exceeds the node limit, in bounded time', () => {
		const compiler = new ContractCompiler(buildSharedDagShape(30))
		const started = performance.now()
		const error = captureContractError(() => compiler.schema)
		const cost = performance.now() - started

		expect(cost).toBeLessThan(1_000)
		expect(error.code).toBe('expansion')
		expect(error.message).toBe('validateShape: a shape expands past the compilation node limit')
		// Every later getter replays that exact terminal error rather than retrying.
		expect(captureContractError(() => compiler.guard)).toBe(error)
		expect(captureContractError(() => compiler.contract)).toBe(error)
	})

	it('poisons the nested read, the interrupted read, and every later read on reentry', () => {
		// The only reachable reentry: ownership invokes a declaration's `pattern`
		// getter — the one accessor it is documented to run — and that getter reads
		// a getter of the compiler owning the same declaration.
		const holder: { compiler?: ContractCompiler<StringShape> } = {}
		const fixture = new ReentrantShape(() => holder.compiler?.schema)
		holder.compiler = new ContractCompiler(fixture.shape)

		const outer = captureContractError(() => holder.compiler?.guard)
		const nested = fixture.nested

		expect(outer.message).toBe('ContractCompiler: contract compilation may not be reentered')
		expect(outer.code).toBe('structure')
		expect(outer.context).toEqual({ path: [], shape: 'contract' })
		expect(Object.hasOwn(outer, 'cause')).toBe(false)
		expect(nested?.success).toBe(false)
		expect(nested !== undefined && !nested.success ? nested.error : undefined).toBe(outer)
		expect(captureContractError(() => holder.compiler?.parser)).toBe(outer)
		expect(captureContractError(() => holder.compiler?.contract)).toBe(outer)
	})

	it('adopts an ownership refusal by identity and replays it at every later getter', () => {
		// Preparation is the compiler's only fallible phase, so this is the shape of
		// every real terminal failure: a `ContractError` the cloner or the validator
		// authored, adopted rather than rewrapped, and replayed thereafter. The
		// `ContractCompiler: contract compilation failed` wrap exists beneath it for
		// a host failure neither engine translated; no public vector reaches it,
		// because every dispatch this class makes after those two engines return is
		// either a captured intrinsic or an indexed read of an array it built.
		const revocable = Proxy.revocable({ category: 'string' } satisfies ContractShape, {})
		revocable.revoke()
		const compiler = new ContractCompiler(revocable.proxy)

		const error = captureContractError(() => compiler.schema)

		expect(error.code).toBe('clone')
		expect(error.message).toBe('cloneShape: failed to create an owned shape snapshot')
		expect(captureContractError(() => compiler.guard)).toBe(error)
		expect(captureContractError(() => compiler.parser)).toBe(error)
		expect(captureContractError(() => compiler.auditor)).toBe(error)
		expect(captureContractError(() => compiler.reporter)).toBe(error)
		expect(captureContractError(() => compiler.generator)).toBe(error)
		expect(captureContractError(() => compiler.contract)).toBe(error)
	})

	it('replays one settling refusal by identity from all seven getters, whichever one settled it', () => {
		// Settlement belongs to the lifecycle rather than to the door that reached
		// it. A refusal adopted at `reporter` is the refusal `schema` and every
		// other getter rethrows — the settling getter included — and none of them
		// retries preparation against a compiler whose working state is gone.
		const malformed: ContractShape = JSON.parse('{"category":"number","min":5,"max":1}')
		const compiler = new ContractCompiler(malformed)

		const error = captureContractError(() => compiler.reporter)

		expect(error.code).toBe('range')
		expect(captureContractError(() => compiler.schema)).toBe(error)
		expect(captureContractError(() => compiler.guard)).toBe(error)
		expect(captureContractError(() => compiler.parser)).toBe(error)
		expect(captureContractError(() => compiler.auditor)).toBe(error)
		expect(captureContractError(() => compiler.reporter)).toBe(error)
		expect(captureContractError(() => compiler.generator)).toBe(error)
		expect(captureContractError(() => compiler.contract)).toBe(error)
	})

	it('keeps separate compilers of one declaration independent', () => {
		const shape = objectShape({ id: stringShape() })
		const first = new ContractCompiler(shape)
		const second = new ContractCompiler(shape)

		expect(first.guard).not.toBe(second.guard)
		expect(first.contract).not.toBe(second.contract)
		expect(first.guard({ id: 'a' })).toBe(second.guard({ id: 'a' }))
		expect(createContract(shape)).not.toBe(createContract(shape))
	})

	it('agrees across is, audit, parse, and explain for every shape category', () => {
		const cases: ReadonlyArray<readonly [ContractShape, readonly unknown[]]> = [
			[stringShape({ min: 1, max: 4 }), ['', 'ab', 'abcde', 1, null, undefined]],
			[numberShape({ min: 0, max: 10 }), [-1, 5, 11, '5', Number.NaN, null]],
			[integerShape({ min: 0 }), [1, 1.5, -1, '2', null]],
			[booleanShape(), [true, 'true', 0, null]],
			[nullShape(), [null, undefined, 0]],
			[literalShape(['a', 'b']), ['a', ' a ', 'c', 1]],
			[jsonShape(), [{ a: 1 }, Number.NaN]],
			[functionShape(), [Math.max, Map, 'migrate', null, undefined]],
			[arrayShape(stringShape(), { min: 1 }), [[], ['a'], [1], 'a']],
			[objectShape({ id: stringShape() }), [{ id: 'a' }, { id: 1 }, { id: 'a', x: 1 }, null]],
			[recordShape(numberShape()), [{ a: 1 }, { a: 'x' }, {}]],
			[unionShape(stringShape(), integerShape()), ['a', 1, true, 1.5]],
			[oneOfShape(stringShape(), nullShape()), ['a', null, 1]],
			[objectShape({ bio: optionalShape(stringShape()) }), [{}, { bio: 'x' }, { bio: 1 }]],
			[nullableShape(stringShape()), [null, 'a', 1]],
			[rawShape({ type: 'string' }), ['a', 1, undefined]],
		]
		const disagreements: string[] = []
		for (const [shape, values] of cases) {
			const compiler = new ContractCompiler(shape)
			const contract = compiler.contract
			for (const value of values) {
				const accepted = contract.is(value)
				const audited = contract.audit(value).length === 0
				const parsed = contract.parse(value) !== undefined
				const explained = contract.explain(value).length === 0
				if (accepted !== audited) disagreements[disagreements.length] = `is/audit ${shape.category}`
				if (parsed !== explained) {
					disagreements[disagreements.length] = `parse/explain ${shape.category}`
				}
				// The standalone doors must answer identically to the compiler's roots,
				// since they are the same compiled artifacts reached another way.
				if (compileGuard(shape)(value) !== accepted) {
					disagreements[disagreements.length] = `door/is ${shape.category}`
				}
				if ((compileAuditor(shape, value).length === 0) !== audited) {
					disagreements[disagreements.length] = `door/audit ${shape.category}`
				}
				if ((compileReporter(shape, value).length === 0) !== explained) {
					disagreements[disagreements.length] = `door/explain ${shape.category}`
				}
				if ((compileParser(shape)(value) !== undefined) !== parsed) {
					disagreements[disagreements.length] = `door/parse ${shape.category}`
				}
			}
			expect(compileSchema(shape)).toEqual(compiler.schema)
		}

		expect(disagreements).toEqual([])
	})

	it('never throws out of a compiled guard on adversarial data', () => {
		const shape = objectShape({ id: stringShape(), tags: arrayShape(stringShape()) })
		const guard = new ContractCompiler(shape).guard
		const hostile: Record<string, unknown> = {}
		Object.defineProperty(hostile, 'id', {
			enumerable: true,
			get(): never {
				throw new Error('id')
			},
		})
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()
		const values: readonly unknown[] = [hostile, revoked.proxy, Object.create(null), [], undefined]

		for (const value of values) {
			expect(attempt(() => guard(value)).success).toBe(true)
		}
	})

	it('reads a shared value node once per compiled node however many paths reach it', () => {
		const levels = 18
		const guarded = buildCountedGraph(levels, true)
		const audited = buildCountedGraph(levels, true)
		const explained = buildCountedGraph(levels, true)
		const answers: readonly unknown[] = [
			compileGuard(guarded.shape)(guarded.value),
			compileAuditor(audited.shape, audited.value),
			compileReporter(explained.shape, explained.value),
		]

		expect(answers).toEqual([true, [], []])
		expect([guarded.count(), audited.count(), explained.count()]).toEqual([levels, levels, levels])
	})

	it('reads a shared object once per call where two slots of one node reach it', () => {
		const shared = buildCountedSlots(true)
		const distinct = buildCountedSlots(false)
		const answers = [
			compileGuard(shared.shape)(shared.value),
			compileGuard(distinct.shape)(distinct.value),
		]

		expect(answers).toEqual([true, true])
		expect([shared.count(), distinct.count()]).toEqual([1, 2])
	})

	it('answers thirty levels of shared references against a thirty-node chain in bounded time', () => {
		// The reported vector, kept in its reported form: no aliases in the
		// declaration, no accessors in the value, two references per level.
		const levels = 30
		const shape = Array.from({ length: levels }).reduce<ContractShape>(
			(child) => arrayShape(child),
			numberShape(),
		)
		const value = Array.from({ length: levels }).reduce<unknown>((child) => [child, child], 0)
		const contract = createContract(shape)
		const started = performance.now()
		const answers: readonly unknown[] = [
			contract.is(value),
			contract.audit(value),
			contract.explain(value),
		]

		expect(performance.now() - started).toBeLessThan(1_000)
		expect(answers).toEqual([true, [], []])
	})

	it('answers a value the caller changed between two calls from the changed value', () => {
		const shape = arrayShape(objectShape({ inner: stringShape() }))
		const record: Record<string, unknown> = { inner: 'x' }
		const value = [record, record]
		const guard = compileGuard(shape)
		const auditor = compileAuditor
		const accepted = [guard(value), auditor(shape, value).length]
		record.inner = 1

		expect(accepted).toEqual([true, 0])
		expect([guard(value), auditor(shape, value).length]).toEqual([false, 2])
	})

	it('holds no answer about an object across two calls of one compiled guard', () => {
		// The root node of an object declaration is tracked, so one retained
		// guard is the shortest path to the memo's lifetime: the answer the first
		// call kept about this record must not reach the second call, which sees
		// a record the caller has since made invalid.
		const guard = compileGuard(objectShape({ inner: stringShape() }))
		const record: Record<string, unknown> = { inner: 'x' }
		const accepted = guard(record)
		record.inner = 1

		expect(accepted).toBe(true)
		expect(guard(record)).toBe(false)
	})

	it('holds no report about an object across two calls of one retained auditor', () => {
		// Every standalone `compileAuditor` call compiles its own compiler, so a
		// RETAINED auditor is the one route that puts a single ledger in front of
		// two calls. The diagnostic families keep only the clean report, and this
		// is where that kept report would outlive its call: the emptiness the first
		// call recorded about this record must not answer the second, which sees a
		// record the caller has since made invalid.
		const auditor = new ContractCompiler(objectShape({ inner: stringShape() })).auditor
		const record: Record<string, unknown> = { inner: 'x' }
		const clean = auditor(record).length
		record.inner = 1

		expect(clean).toBe(0)
		expect(auditor(record).length).toBe(1)
	})

	it('builds no tracking ledger while a compiled family is assembled', async () => {
		// A ledger built with the artifact would cost one map per tracked node, so
		// the count taken across the getter read would rise with the tracked-node
		// count. These two declarations differ only there. The build allocates
		// working maps of its own, so the DELTA between the two reads is the
		// discriminating figure and neither total is asserted. The call counts are
		// the control: each member holds distinct records, so evaluation reaches
		// each tracked node's per-call memo. The counts rise with the tracked-node
		// population while building an artifact allocates no evaluation memo.
		const { answers, buildDelta, calledFew, calledMany } = await measureAllocations()

		expect(answers).toEqual([true, true])
		expect(buildDelta).toBe(0)
		expect(calledFew).toBeGreaterThan(0)
		expect(calledMany).toBeGreaterThan(calledFew)
	})

	it('reports a shared faulted node at every path the walk reached it through', () => {
		const shape = arrayShape(objectShape({ inner: stringShape() }))
		const record = { inner: 1 }
		const paths = compileAuditor(shape, [record, record]).map((fault) => `${fault.path}`)

		expect(paths).toEqual(['0,inner', '1,inner'])
	})

	it('still reads every distinct node of a tree value and leaves a bounded door alone', () => {
		const levels = 10
		const tree = buildCountedGraph(levels, false)
		const plain = Array.from({ length: 18 }).reduce<unknown>((child) => [child, child], 'leaf')

		expect(compileGuard(tree.shape)(tree.value)).toBe(true)
		expect(tree.count()).toBe(2 ** (levels + 1) - 2)
		expect(captureContractError(() => cloneJSONValue(plain)).code).toBe('clone')
	})

	it('generates the same value for one seed however the generator was reached', () => {
		const shape = objectShape({
			id: stringShape({ min: 2, max: 4 }),
			age: integerShape({ min: 0, max: 9 }),
		})
		const compiler = new ContractCompiler(shape)

		expect(compiler.generator(seededRandom(11))).toEqual(compiler.generator(seededRandom(11)))
		expect(compiler.generator(seededRandom(11))).toEqual(compileGenerator(shape, seededRandom(11)))
		expect(compiler.contract.generate(seededRandom(11))).toEqual(
			compileGenerator(shape, seededRandom(11)),
		)
		expect(compiler.guard(compiler.generator(seededRandom(11)))).toBe(true)
	})
})

describe('ContractCompiler — field defaults', () => {
	const flat = objectShape({ a: optionalShape(numberShape(), { default: 3 }) })

	it('fills an absent key and an undefined key alike', () => {
		const contract = createContract(flat)

		expect(contract.parse({})).toEqual({ a: 3 })
		expect(contract.parse({ a: undefined })).toEqual({ a: 3 })
		expect(contract.parse({ a: 4 })).toEqual({ a: 4 })
		expect(contract.parse({ a: '5' })).toEqual({ a: 5 })
	})

	it('leaves the strict doors on canonical absence', () => {
		const contract = createContract(flat)

		expect(contract.schema.properties?.a?.default).toBe(3)
		expect(contract.is({})).toBe(true)
		expect(contract.audit({})).toEqual([])
		expect(contract.explain({})).toEqual([])
		// An own `undefined` keeps its standing: the strict doors refuse it, and the parser
		// and its report treat it as absent, so the fill reaches it and nothing else moves.
		expect(contract.is({ a: undefined })).toBe(false)
		expect(contract.audit({ a: undefined }).length).toBeGreaterThan(0)
		expect(contract.explain({ a: undefined })).toEqual([])
	})

	it('still refuses what a present value gets wrong', () => {
		const contract = createContract(flat)

		expect(contract.parse({ a: 'x' })).toBeUndefined()
		expect(contract.parse({ a: null })).toBeUndefined()
		expect(contract.is({ a: 'x' })).toBe(false)
		expect(contract.explain({ a: 'x' }).length).toBeGreaterThan(0)
	})

	it('fills falsy defaults, null included', () => {
		const cases: ReadonlyArray<readonly [ContractShape, unknown]> = [
			[optionalShape(numberShape(), { default: 0 }), 0],
			[optionalShape(stringShape(), { default: '' }), ''],
			[optionalShape(booleanShape(), { default: false }), false],
			[optionalShape(nullShape(), { default: null }), null],
			[optionalShape(nullableShape(numberShape()), { default: null }), null],
		]
		const filled = cases.map(([shape]) => compileParser(objectShape({ a: shape }))({}))

		expect(filled).toEqual(cases.map(([, value]) => ({ a: value })))
	})

	it('leaves a key absent when its optional carries no default', () => {
		const parsed = compileParser(objectShape({ a: optionalShape(numberShape()) }))({})

		expect(parsed).toEqual({})
		expect(compileSchema(objectShape({ a: optionalShape(numberShape()) }))).toEqual({
			type: 'object',
			properties: { a: { type: 'number' } },
			additionalProperties: false,
		})
	})

	it('builds a distinct tree per parse for every inner category', () => {
		const value = { k: [1] }
		const cases: readonly ContractShape[] = [
			optionalShape(objectShape({ k: arrayShape(numberShape()) }), { default: value }),
			optionalShape(jsonShape(), { default: value }),
			optionalShape(rawShape({}), { default: value }),
			optionalShape(unionShape(objectShape({ k: arrayShape(numberShape()) }), nullShape()), {
				default: value,
			}),
		]
		const pairs = cases.map((shape) => {
			const parse = compileParser(objectShape({ a: shape }))
			return [parse({}), parse({})]
		})

		for (const [first, second] of pairs) {
			expect(first).toEqual({ a: value })
			expect(second).toEqual({ a: value })
			if (!isRecord(first) || !isRecord(second)) throw new Error('expected two filled records')
			expect(first.a).not.toBe(second.a)
			if (!isRecord(first.a) || !isRecord(second.a)) throw new Error('expected two filled trees')
			expect(first.a.k).not.toBe(second.a.k)
		}
	})

	it('applies a nested default inside a filled default', () => {
		const shape = objectShape({
			a: optionalShape(objectShape({ b: optionalShape(numberShape(), { default: 1 }) }), {
				default: {},
			}),
		})
		const contract = createContract(shape)

		expect(contract.parse({})).toEqual({ a: { b: 1 } })
		expect(contract.parse({ a: {} })).toEqual({ a: { b: 1 } })
		expect(contract.is(contract.parse({}))).toBe(true)
	})

	it('emits the default on the property schema alone', () => {
		const schema = compileSchema(flat)

		expect(schema.properties?.a?.default).toBe(3)
		expect(schema.required).toBeUndefined()
		expect(Object.isFrozen(schema.properties?.a)).toBe(true)
		expect(
			compileSchema(objectShape({ a: optionalShape(nullShape(), { default: null }) })).properties?.a
				?.default,
		).toBeNull()
	})

	it('compiles a JSON round trip of a defaulted shape equal to its source', () => {
		const shape = objectShape({
			a: optionalShape(numberShape({ min: 0 }), { default: 3 }),
			b: optionalShape(objectShape({ c: optionalShape(stringShape(), { default: 'x' }) }), {
				default: {},
			}),
			d: optionalShape(nullableShape(stringShape()), { default: null }),
		})
		const restored: ContractShape = JSON.parse(JSON.stringify(shape))
		const original = createContract(shape)
		const reloaded = compileParser(restored)

		expect(compileSchema(restored)).toEqual(original.schema)
		expect(JSON.stringify(compileSchema(restored))).toBe(JSON.stringify(original.schema))
		expect(reloaded({})).toEqual(original.parse({}))
		expect(reloaded({})).toEqual({ a: 3, b: { c: 'x' }, d: null })
	})

	it('refuses a default its inner shape refuses, at every door', () => {
		const shape: ContractShape = {
			category: 'object',
			properties: {
				a: { category: 'optional', inner: { category: 'number', min: 0 }, default: -5 },
			},
		}
		const doors = listCompilerDoors(shape)
		const refusals = doors.map(([label, door]) => {
			const error = captureContractError(door)
			return [label, error.code, error.context?.path]
		})

		expect(refusals).toEqual(
			doors.map(([label]) => [label, 'structure', ['properties', 'a', 'default']]),
		)
	})

	it('checks a default against every refinement of its inner shape', () => {
		const refused: readonly ContractShape[] = [
			{ category: 'optional', inner: { category: 'number', max: 1 }, default: 2 },
			{ category: 'optional', inner: { category: 'number', integer: true }, default: 1.5 },
			{ category: 'optional', inner: { category: 'string', min: 2 }, default: 'x' },
			{ category: 'optional', inner: { category: 'string', max: 1 }, default: 'xy' },
			{ category: 'optional', inner: { category: 'literal', values: ['a'] }, default: 'b' },
			{ category: 'optional', inner: { category: 'boolean' }, default: 1 },
			{ category: 'optional', inner: { category: 'null' }, default: 0 },
			{
				category: 'optional',
				inner: { category: 'array', items: { category: 'number' }, max: 1 },
				default: [1, 2],
			},
			{ category: 'optional', inner: { category: 'object', properties: {} }, default: { z: 1 } },
			{
				category: 'optional',
				inner: { category: 'object', properties: { b: { category: 'number' } } },
				default: {},
			},
			{ category: 'optional', inner: stringShape({ pattern: /^a$/ }), default: 'b' },
			{ category: 'optional', inner: numberShape(), default: '3' },
		]
		const codes = refused.map(
			(child) => captureContractError(() => createContract(objectShape({ a: child }))).code,
		)

		expect(codes).toEqual(refused.map(() => 'structure'))
	})

	it('names the deepest default that fails, below an array and a nested object', () => {
		const shape: ContractShape = {
			category: 'array',
			items: {
				category: 'object',
				properties: {
					a: {
						category: 'optional',
						inner: {
							category: 'object',
							properties: {
								b: { category: 'optional', inner: { category: 'number', min: 0 }, default: -1 },
							},
						},
					},
				},
			},
		}

		expect(captureContractError(() => compileSchema(shape)).context?.path).toEqual([
			'items',
			'properties',
			'a',
			'inner',
			'properties',
			'b',
			'default',
		])
	})

	it('keeps the failed compiler terminal on the one refusal', () => {
		const compiler = new ContractCompiler<ContractShape>({
			category: 'object',
			properties: {
				a: { category: 'optional', inner: { category: 'number', min: 0 }, default: -5 },
			},
		})
		const first = captureContractError(() => compiler.schema)

		expect(captureContractError(() => compiler.guard)).toBe(first)
		expect(captureContractError(() => compiler.contract)).toBe(first)
	})

	it('generates only values its guard accepts and never fills a default', () => {
		const shape = objectShape({
			a: optionalShape(integerShape({ min: 1000, max: 2000 }), { default: 1500 }),
		})
		const contract = createContract(shape)
		const drawn = Array.from({ length: 64 }, (_entry, seed) =>
			contract.generate(seededRandom(seed)),
		)
		const present = drawn.filter((value) => Object.hasOwn(value, 'a'))

		expect(drawn.filter((value) => !contract.is(value))).toEqual([])
		// The generator keeps its own choice: it omits the key or draws from `inner`. An omitted
		// key stays omitted, and a drawn value is not the default repeated.
		expect(contract.parse({})).toEqual({ a: 1500 })
		expect(present.length).toBeLessThan(drawn.length)
		expect(present.length).toBeGreaterThan(0)
		expect(present.filter((value) => value.a !== 1500).length).toBeGreaterThan(0)
	})

	it('reports nothing about a default the parser fills beside a key it refuses', () => {
		const shape = objectShape({
			a: optionalShape(numberShape(), { default: 3 }),
			b: stringShape(),
		})
		const contract = createContract(shape)

		expect(contract.parse({})).toBeUndefined()
		expect(contract.explain({}).map((fault) => fault.path)).toEqual([['b']])
		expect(contract.audit({}).map((fault) => fault.path)).toEqual([['b']])
		expect(contract.parse({ b: 'x' })).toEqual({ a: 3, b: 'x' })
	})

	it('drops an undeclared key while it fills, as a closed parser does', () => {
		expect(compileParser(flat)({ z: 1 })).toEqual({ a: 3 })
		expect(compileGuard(flat)({ z: 1 })).toBe(false)
	})

	it('fills past the presence mask width as it does within it', () => {
		const entries = Array.from({ length: 40 }, (_entry, index) => [
			`k${String(index)}`,
			optionalShape(numberShape(), { default: index }),
		])
		const parsed = compileParser(objectShape(Object.fromEntries(entries)))({ k3: 99 })

		expect(parsed).toEqual(
			Object.fromEntries(
				Array.from({ length: 40 }, (_entry, index) => [
					`k${String(index)}`,
					index === 3 ? 99 : index,
				]),
			),
		)
	})
})

describe('ContractCompiler — a prototype changed after compiling', () => {
	const values = [{ n: 3 }, {}, { n: -1 }, { n: 'x' }, 5]

	it.each<readonly [string, () => ContractShape]>([
		[
			'a built declaration',
			() => objectShape({ n: optionalShape(numberShape({ min: 0 }), { default: 3 }) }),
		],
		[
			'a cloned declaration',
			() => cloneShape(objectShape({ n: optionalShape(numberShape({ min: 0 }), { default: 3 }) })),
		],
		[
			'a hand-written declaration',
			() => ({
				category: 'object',
				properties: {
					n: {
						category: 'optional',
						inner: { category: 'number', min: 0 },
						default: 3,
					},
				},
			}),
		],
	])('keeps both laws over %s', (_label, build) => {
		const compiler = new ContractCompiler(build())
		const { is, parse, audit, explain } = compiler.contract
		const answers = pollutePrototype(
			Object.prototype,
			'max',
			() => 2,
			() =>
				values.map((value) => ({
					is: is(value),
					parsed: parse(value) !== undefined,
					auditClean: audit(value).length === 0,
					explainClean: explain(value).length === 0,
				})),
		)

		expect(answers.map(({ auditClean }) => auditClean)).toEqual(answers.map((answer) => answer.is))
		expect(answers.map(({ explainClean }) => explainClean)).toEqual(
			answers.map(({ parsed }) => parsed),
		)
		expect(answers[0]).toEqual({ is: true, parsed: true, auditClean: true, explainClean: true })
	})

	it.each<readonly [string, unknown]>([
		['min', 100],
		['max', 0],
		['pattern', /^never$/],
		['integer', true],
	])('reads no inherited %s from any leaf or array at call time', (field, inherited) => {
		const hand: ContractShape = {
			category: 'object',
			properties: {
				text: { category: 'string' },
				count: { category: 'number' },
				list: { category: 'array', items: { category: 'string' } },
			},
		}
		const value = { text: 'abc', count: 1.5, list: ['a'] }
		const { is, audit, explain } = new ContractCompiler(hand).contract
		const answers = pollutePrototype(
			Object.prototype,
			field,
			() => inherited,
			() => ({ is: is(value), audit: audit(value), explain: explain(value) }),
		)

		expect(answers).toEqual({ is: true, audit: [], explain: [] })
	})
})

describe('ContractCompiler — a discriminated union', () => {
	const find = objectShape({ operation: literalShape(['find']), limit: integerShape() })
	const read = objectShape({ operation: literalShape(['read']), id: stringShape({ min: 1 }) })
	const write = objectShape({
		operation: literalShape(['write']),
		id: stringShape({ min: 1 }),
		text: stringShape(),
	})
	const tools = unionShape(find, read, write)
	const allowed = ['find', 'read', 'write']

	it('reports the named arm with its real paths, in place of a variant', () => {
		const contract = createContract(tools)
		const value = { operation: 'find', limit: 'many' }

		expect(contract.explain(value)).toEqual([
			{ reason: 'type', path: ['limit'], expected: 'integer', received: '"many"' },
		])
		expect(contract.audit(value)).toEqual([
			{ reason: 'type', path: ['limit'], expected: 'integer', received: '"many"' },
		])
	})

	it('reports a missing key and an undeclared key of the named arm', () => {
		const contract = createContract(tools)

		expect(contract.audit({ operation: 'read' })).toEqual([
			{ reason: 'missing', path: ['id'], expected: 'string' },
		])
		expect(contract.audit({ operation: 'read', id: 'a', extra: 1 })).toEqual([
			{ reason: 'extra', path: ['extra'] },
		])
	})

	it('carries the path of the slot the union sits in', () => {
		const contract = createContract(objectShape({ tool: tools }))
		const faults = contract.audit({ tool: { operation: 'find', limit: 'many' } })

		expect(faults.map(({ path }) => path)).toEqual([['tool', 'limit']])
	})

	it('repairs through the named arm', () => {
		const contract = createContract(tools)

		expect(contract.parse({ operation: 'find', limit: '5' })).toEqual({
			operation: 'find',
			limit: 5,
		})
		expect(contract.explain({ operation: 'find', limit: '5' })).toEqual([])
		expect(contract.parse({ operation: 'find', limit: 'many' })).toBeUndefined()
	})

	it('returns a value its arm accepts by identity', () => {
		const value = { operation: 'read', id: 'a' }

		expect(createContract(tools).parse(value)).toBe(value)
	})

	it('repairs through no other arm when the named arm refuses', () => {
		const first = objectShape({ kind: literalShape(['1']), size: numberShape() })
		const second = objectShape({ kind: literalShape([1]), size: stringShape() })
		const contract = createContract(unionShape(first, second))

		expect(contract.parse({ kind: '1', size: 'x' })).toBeUndefined()
		expect(contract.explain({ kind: '1', size: 'x' })[0]?.path).toEqual(['size'])
	})

	it.each<readonly [string, unknown]>([
		['an unknown literal', { operation: 'nope' }],
		['an absent discriminator', { limit: 5 }],
		['a literal of another type', { operation: 1 }],
		['a value that is no object', 5],
		['an array', []],
		['null', null],
	])('keeps a variant fault for %s, naming what would select', (_label, value) => {
		const contract = createContract(tools)

		expect(contract.audit(value)[0]).toEqual({
			reason: 'variant',
			path: [],
			variants: 3,
			key: 'operation',
			expected: allowed,
		})
		expect(contract.explain(value)[0]).toEqual({
			reason: 'variant',
			path: [],
			variants: 3,
			key: 'operation',
			expected: allowed,
		})
		expect(contract.parse(value)).toBeUndefined()
	})

	it('selects on a literal one arm alone holds, and on no literal two arms share', () => {
		const left = objectShape({ kind: literalShape(['x', 'y']), a: numberShape() })
		const right = objectShape({ kind: literalShape(['y', 'z']), b: numberShape() })
		const contract = createContract(unionShape(left, right))

		expect(contract.audit({ kind: 'x', a: 'no' })[0]?.path).toEqual(['a'])
		expect(contract.audit({ kind: 'z', b: 'no' })[0]?.path).toEqual(['b'])
		expect(contract.audit({ kind: 'y', a: 'no' })[0]).toEqual({
			reason: 'variant',
			path: [],
			variants: 2,
			key: 'kind',
			expected: ['x', 'y', 'z'],
		})
		expect(contract.is({ kind: 'y', a: 1 })).toBe(true)
		expect(contract.is({ kind: 'y', b: 1 })).toBe(true)
	})

	it('reads the next shared literal when the first cannot tell the arms apart', () => {
		const left = objectShape({ version: literalShape([1]), kind: literalShape(['a']) })
		const right = objectShape({
			version: literalShape([1]),
			kind: literalShape(['b']),
			n: numberShape(),
		})
		const contract = createContract(unionShape(left, right))

		expect(contract.audit({ version: 1, kind: 'b', n: 'no' })[0]?.path).toEqual(['n'])
	})

	it.each<readonly [string, ContractShape]>([
		[
			'one arm that is no object',
			unionShape(objectShape({ kind: literalShape(['a']), n: numberShape() }), stringShape()),
		],
		[
			'a nullable arm',
			unionShape(
				objectShape({ kind: literalShape(['a']), n: numberShape() }),
				nullableShape(objectShape({ kind: literalShape(['b']) })),
			),
		],
		[
			'a discriminator inside a nullable',
			unionShape(
				objectShape({ kind: nullableShape(literalShape(['a'])), n: numberShape() }),
				objectShape({ kind: literalShape(['b']) }),
			),
		],
		[
			'an optional discriminator',
			unionShape(
				objectShape({ kind: optionalShape(literalShape(['a'])), n: numberShape() }),
				objectShape({ kind: literalShape(['b']) }),
			),
		],
		[
			'a nested union',
			unionShape(
				objectShape({ kind: literalShape(['a']), n: numberShape() }),
				unionShape(
					objectShape({ kind: literalShape(['b']) }),
					objectShape({ kind: literalShape(['c']) }),
				),
			),
		],
		[
			'a property only some arms declare',
			unionShape(
				objectShape({ kind: literalShape(['a']), n: numberShape() }),
				objectShape({ other: literalShape(['b']) }),
			),
		],
	])('leaves %s as it was', (_label, shape) => {
		const faults = createContract(shape).audit({ kind: 'a', n: 'no' })

		expect(faults[0]?.reason).toBe('variant')
		expect(Object.keys(faults[0] ?? {})).toEqual(['reason', 'path', 'variants'])
	})

	it('selects within a union nested below the outer one', () => {
		const inner = unionShape(
			objectShape({ kind: literalShape(['b']), n: numberShape() }),
			objectShape({ kind: literalShape(['c']) }),
		)
		const contract = createContract(objectShape({ slot: inner }))

		expect(contract.audit({ slot: { kind: 'b', n: 'no' } })[0]?.path).toEqual(['slot', 'n'])
	})

	it('reads an inherited or accessor discriminator as absent', () => {
		const contract = createContract(tools)
		const inherited = Object.create({ operation: 'find', limit: 1 })
		const accessor = Object.defineProperty({ limit: 1 }, 'operation', {
			get: () => 'find',
			enumerable: true,
		})

		expect(contract.audit(inherited)[0]?.reason).toBe('variant')
		expect(contract.audit(accessor)).toEqual([])
		expect(contract.is(accessor)).toBe(true)
	})

	it('survives a discriminator read that throws', () => {
		const hostile = new Proxy(
			{},
			{
				getOwnPropertyDescriptor() {
					throw new Error('hostile')
				},
			},
		)

		expect(createContract(tools).is(hostile)).toBe(false)
	})

	it('treats a oneOf the same way, since one named arm leaves nothing ambiguous', () => {
		const contract = createContract(oneOfShape(find, read))
		const value = { operation: 'find', limit: '5' }

		expect(contract.parse(value)).toEqual({ operation: 'find', limit: 5 })
		expect(contract.explain(value)).toEqual([])
		expect(contract.audit(value)[0]?.path).toEqual(['limit'])
		expect(contract.is(contract.parse(value))).toBe(true)
		expect(contract.audit({ operation: 'nope' })[0]).toEqual({
			reason: 'oneOf',
			path: [],
			matched: 0,
			key: 'operation',
			expected: ['find', 'read'],
		})
	})

	it('keeps a oneOf with no discriminator judged on the raw value', () => {
		const contract = createContract(oneOfShape(numberShape(), integerShape()))

		expect(contract.parse(3)).toBeUndefined()
		expect(contract.parse(3.5)).toBe(3.5)
	})

	it('keeps the three laws over generated unions', { timeout: 15_000 }, () => {
		const violations = buildDiscriminatedCases(11).flatMap(({ label, shape, values }) =>
			findAgreementViolations(shape, undefined, values).map((violation) => [label, violation]),
		)

		expect(violations).toEqual([])
	})

	it('selects exactly when one arm alone holds the literal, over generated unions', () => {
		const wrong = buildDiscriminatedCases(23).flatMap(({ label, shape, discriminated, values }) => {
			const { audit, is } = createContract(shape)
			return values.flatMap((value) => {
				const first = audit(value)[0]
				const variant = first?.reason === 'variant' || first?.reason === 'oneOf'
				// A selected arm answers for itself, so a fault below it is never a variant.
				return discriminated(value) && variant ? [[label, value, is(value)]] : []
			})
		})

		expect(wrong).toEqual([])
	})
})

describe('ContractCompiler — function shape', () => {
	it('emits the unsatisfiable leaf, with a description only when one is authored', () => {
		const schema = compileSchema(functionShape())
		expect(schema).toStrictEqual({ not: {}, format: 'function' })
		expect(Object.hasOwn(schema, 'description')).toBe(false)
		expect(Object.isFrozen(schema)).toBe(true)
		expect(Object.isFrozen(schema.not)).toBe(true)
		expect(compileSchema(functionShape({ description: 'Runs the schema migration' }))).toEqual({
			not: {},
			format: 'function',
			description: 'Runs the schema migration',
		})
	})

	it('accepts every callable by identity and reports a type fault for anything else', () => {
		const contract = new ContractCompiler(functionShape()).contract
		const callables: readonly unknown[] = [
			Math.max,
			Math.max.bind(Math),
			Map,
			Promise.resolve,
			encodeURI,
		]
		for (const value of callables) {
			expect(contract.is(value)).toBe(true)
			expect(contract.parse(value)).toBe(value)
			expect(contract.audit(value)).toEqual([])
			expect(contract.explain(value)).toEqual([])
		}
		for (const value of ['migrate', null, undefined, {}, [], 0]) {
			expect(contract.is(value)).toBe(false)
			expect(contract.parse(value)).toBeUndefined()
		}
		expect(contract.audit('migrate')).toEqual([
			{ reason: 'type', path: [], expected: 'function', received: '"migrate"' },
		])
		expect(contract.explain('migrate')).toEqual([
			{ reason: 'type', path: [], expected: 'function', received: '"migrate"' },
		])
	})

	it('generates one frozen function by identity under every seed', () => {
		const first = compileGenerator(functionShape(), seededRandom(1))
		const second = compileGenerator(functionShape(), seededRandom(2))
		expect(first).toBeTypeOf('function')
		expect(second).toBe(first)
		expect(Object.isFrozen(first)).toBe(true)
		expect(first()).toBeUndefined()
		const options = createContract(objectShape({ name: stringShape(), upgrade: functionShape() }))
		const generated = options.generate(seededRandom(3))
		expect(options.is(generated)).toBe(true)
		expect(options.generate(seededRandom(3))).toEqual(generated)
	})
})

describe('ContractCompiler — the undefined leaf', () => {
	it('emits the unsatisfiable leaf, with a description only when one is authored', () => {
		const schema = compileSchema(undefinedShape())
		expect(schema).toStrictEqual({ not: {}, format: 'undefined' })
		expect(Object.isFrozen(schema)).toBe(true)
		expect(Object.isFrozen(schema.not)).toBe(true)
		expect(compileSchema(undefinedShape({ description: 'No limit set' }))).toEqual({
			not: {},
			format: 'undefined',
			description: 'No limit set',
		})
	})

	it('accepts only undefined at the root and reports a type fault for anything else', () => {
		const contract = new ContractCompiler(undefinedShape()).contract
		expect(contract.is(undefined)).toBe(true)
		expect(contract.parse(undefined)).toBeUndefined()
		expect(contract.audit(undefined)).toEqual([])
		expect(contract.explain(undefined)).toEqual([])
		expect(contract.generate(seededRandom(1))).toBeUndefined()
		for (const value of [null, 0, '', false, Number.NaN, {}, [], encodeURI]) {
			expect(contract.is(value)).toBe(false)
			expect(contract.parse(value)).toBeUndefined()
			expect(contract.explain(value).length).toBe(1)
		}
		expect(contract.audit(null)).toEqual([
			{ reason: 'type', path: [], expected: 'undefined', received: 'null' },
		])
		expect(contract.explain('')).toEqual([
			{ reason: 'type', path: [], expected: 'undefined', received: '""' },
		])
	})

	it.each(UNDEFINED_ROWS)('keeps a present undefined at $name', ({ shape, value, keys }) => {
		const contract = createContract(shape)
		expect(contract.is(value)).toBe(true)
		expect(contract.audit(value)).toEqual([])
		expect(contract.explain(value)).toEqual([])
		const parsed = contract.parse(value)
		expect(contract.is(parsed)).toBe(true)
		expect(isRecord(parsed) || Array.isArray(parsed) ? Object.keys(parsed) : parsed).toEqual(keys)
		expect(isRecord(parsed) || Array.isArray(parsed) ? Object.values(parsed) : []).toEqual(
			(keys ?? []).map(() => undefined),
		)
		for (const seed of [1, 2, 3, 4]) {
			expect(contract.is(contract.generate(seededRandom(seed)))).toBe(true)
		}
	})

	it('holds the sound pair on { limit: undefined } for a required member', () => {
		const contract = createContract(objectShape({ limit: undefinedShape() }))
		const value = { limit: undefined }
		const parsed = contract.parse(value)
		expect(contract.is(value)).toBe(true)
		expect(parsed).toBeDefined()
		expect(contract.is(parsed)).toBe(true)
		expect(isRecord(parsed) && Object.hasOwn(parsed, 'limit')).toBe(true)
	})

	it('tells a present undefined from an absent member', () => {
		const required = createContract(objectShape({ limit: undefinedShape() }))
		const missing = [{ reason: 'missing', path: ['limit'], expected: 'undefined' }]
		expect(required.is({})).toBe(false)
		expect(required.parse({})).toBeUndefined()
		expect(required.audit({})).toEqual(missing)
		expect(required.explain({})).toEqual(missing)
		const optional = createContract(objectShape({ limit: optionalShape(undefinedShape()) }))
		const absent = optional.parse({})
		expect(optional.is({})).toBe(true)
		expect(isRecord(absent) && Object.keys(absent)).toEqual([])
	})

	it('admits undefined through a oneOf union only when exactly one arm does', () => {
		const both = createContract(
			objectShape({ limit: oneOfShape(undefinedShape(), nullableShape(undefinedShape())) }),
		)
		const value = { limit: undefined }
		expect(both.is(value)).toBe(false)
		expect(both.parse(value)).toBeUndefined()
		expect(both.audit(value)).toEqual([{ reason: 'oneOf', path: ['limit'], matched: 2 }])
		expect(both.explain(value).length).toBeGreaterThan(0)
		const one = createContract(objectShape({ limit: oneOfShape(undefinedShape(), stringShape()) }))
		const kept = one.parse(value)
		expect(one.is(value)).toBe(true)
		expect(isRecord(kept) && Object.keys(kept)).toEqual(['limit'])
	})

	it('coerces through a union arm and keeps the undefined arm for undefined alone', () => {
		const contract = createContract(unionShape(integerShape(), undefinedShape()))
		expect(contract.parse('3')).toBe(3)
		expect(contract.is(undefined)).toBe(true)
		expect(contract.parse(undefined)).toBeUndefined()
		expect(contract.explain(undefined)).toEqual([])
		expect(contract.parse('x')).toBeUndefined()
		expect(contract.explain('x').length).toBeGreaterThan(0)
		const member = createContract(
			objectShape({ limit: unionShape(integerShape(), undefinedShape()) }),
		)
		expect(member.parse({ limit: '3' })).toEqual({ limit: 3 })
	})

	it('refuses an array hole where the element admits undefined, as a missing element', () => {
		const contract = createContract(arrayShape(undefinedShape()))
		const holed = buildHoledArray([undefined, undefined], 0)
		const missing = [{ reason: 'missing', path: ['0'], expected: 'undefined' }]
		expect(contract.is(holed)).toBe(false)
		expect(contract.parse(holed)).toBeUndefined()
		expect(contract.audit(holed)).toEqual(missing)
		expect(contract.explain(holed)).toEqual(missing)
	})

	it('leaves the adjacent refusals where 0.0.24 answers them', () => {
		const optional = createContract(objectShape({ limit: optionalShape(numberShape()) }))
		const value = { limit: undefined }
		const typed = [{ reason: 'type', path: ['limit'], expected: 'number', received: 'undefined' }]
		expect(optional.is(value)).toBe(false)
		expect(optional.audit(value)).toEqual(typed)
		expect(optional.explain(value)).toEqual([])
		const dropped = optional.parse(value)
		expect(isRecord(dropped) && Object.keys(dropped)).toEqual([])
		const raw = createContract(rawShape({}))
		expect(raw.is(undefined)).toBe(false)
		expect(raw.parse(undefined)).toBeUndefined()
		expect(raw.audit(undefined)).toEqual([
			{ reason: 'type', path: [], expected: 'json', received: 'undefined' },
		])
		const numbers = createContract(arrayShape(numberShape()))
		const holed = buildHoledArray([1, 2, 3], 1)
		const hole = [{ reason: 'type', path: ['1'], expected: 'number', received: 'undefined' }]
		expect(numbers.is(holed)).toBe(false)
		expect(numbers.parse(holed)).toBeUndefined()
		expect(numbers.audit(holed)).toEqual(hole)
		expect(numbers.explain(holed)).toEqual(hole)
	})

	it.each(UNDEFINED_LAW_SHAPES.map((shape, index) => [index, shape] as const))(
		'holds every law over the seeded corpus of law shape %i',
		(_index, shape) => {
			expect(findUndefinedLawViolations(shape, 16)).toEqual([])
		},
	)

	it('draws a corpus that holds undefined members, admitted values, and refused values', () => {
		const contract = createContract(objectShape({ limit: undefinedShape() }))
		const corpus = buildUndefinedCorpus(contract, 4)
		expect(corpus.some((value) => isRecord(value) && Object.hasOwn(value, 'limit'))).toBe(true)
		expect(corpus.some((value) => contract.is(value))).toBe(true)
		expect(corpus.some((value) => isRecord(value) && !contract.is(value))).toBe(true)
	})
})

describe('ContractCompiler — the interface shape', () => {
	it('emits an open object schema that names its format, its members, and the required ones', () => {
		const schema = compileSchema(
			interfaceShape(
				{ get: functionShape(), ttl: optionalShape(integerShape()) },
				{ description: 'Session store' },
			),
		)
		expect(schema).toEqual({
			type: 'object',
			format: 'interface',
			properties: { get: { not: {}, format: 'function' }, ttl: { type: 'integer' } },
			required: ['get'],
			additionalProperties: true,
			description: 'Session store',
		})
		expect(Object.keys(schema)).toEqual([
			'type',
			'format',
			'properties',
			'required',
			'additionalProperties',
			'description',
		])
		expect(Object.isFrozen(schema)).toBe(true)
		expect(Object.isFrozen(schema.properties)).toBe(true)
		expect(Object.isFrozen(schema.required)).toBe(true)
		expect(compileSchema(interfaceShape({}))).toStrictEqual({
			type: 'object',
			format: 'interface',
			additionalProperties: true,
		})
	})

	it.each(buildImplementationRows())('admits $name by identity', ({ value }) => {
		const contract = createContract(STORE_DECLARATION)
		expect(contract.is(value)).toBe(true)
		expect(contract.audit(value)).toEqual([])
		expect(contract.explain(value)).toEqual([])
		expect(contract.parse(value)).toBe(value)
	})

	it.each(buildImplementationRefusals())(
		'refuses $name with its declared faults',
		({ shape, value, faults }) => {
			const contract = createContract(shape)
			expect(contract.is(value)).toBe(false)
			expect(contract.parse(value)).toBeUndefined()
			expect(contract.audit(value)).toEqual(faults)
			expect(contract.explain(value)).toEqual(faults)
		},
	)

	it('refuses a declared getter that throws, with a coded refusal where a read is required', () => {
		const contract = createContract(STORE_DECLARATION)
		const value = createThrowingGetter('get')
		expect(contract.is(value)).toBe(false)
		const audited = captureContractError(() => contract.audit(value))
		expect(audited).toMatchObject({
			code: 'structure',
			message: 'compileAuditor: interface member could not be read',
			context: { path: ['get'], shape: 'interface' },
		})
		expect(captureContractError(() => contract.parse(value)).context).toEqual(audited.context)
		expect(contract.explain(value)).toEqual([
			{ reason: 'type', path: [], expected: 'object', received: 'object' },
		])
	})

	it('passes an optional member that reads undefined, and a required one only when it admits undefined', () => {
		const contract = createContract(
			interfaceShape({
				get: functionShape(),
				ttl: optionalShape(integerShape()),
				limit: unionShape(integerShape(), undefinedShape()),
			}),
		)
		const value = { get: encodeURI }
		expect(contract.is(value)).toBe(true)
		expect(contract.audit(value)).toEqual([])
		expect(contract.parse(value)).toBe(value)
		expect(contract.is({ get: encodeURI, limit: 'many' })).toBe(false)
		expect(contract.audit({ ttl: 3 })).toEqual([
			{ reason: 'missing', path: ['get'], expected: 'function' },
		])
	})

	it('reports an undeclared or hidden key under a member as one type fault at that member', () => {
		const contract = createContract(
			interfaceShape({ config: objectShape({ port: integerShape() }) }),
		)
		const typed = { reason: 'type', path: ['config'], expected: 'object', received: 'object' }
		const extra = { config: { port: 1, debug: true } }
		expect(contract.audit(extra)).toEqual([{ reason: 'extra', path: ['config', 'debug'] }])
		expect(contract.explain(extra)).toEqual([typed])
		expect(contract.parse(extra)).toBeUndefined()
		const hidden = { config: Object.defineProperty({}, 'port', { value: 1, enumerable: false }) }
		expect(contract.audit(hidden)).toEqual([{ reason: 'hidden', path: ['config', 'port'] }])
		expect(contract.explain(hidden)).toEqual([typed])
		const mixed = { config: { port: 'eighty', debug: true } }
		const wrong = {
			reason: 'type',
			path: ['config', 'port'],
			expected: 'integer',
			received: '"eighty"',
		}
		expect(contract.audit(mixed)).toEqual([wrong, { reason: 'extra', path: ['config', 'debug'] }])
		expect(contract.explain(mixed)).toEqual([typed, wrong])
	})

	it.each(['prototype', 'function'] as const)(
		'reads each declared member of a %s implementation one time at every door',
		(form) => {
			const contract = createContract(STORE_DECLARATION)
			const reads = createRecorder<readonly [string]>()
			const store = buildCountedStore(form, reads.handler)
			const once = [['get'], ['set'], ['delete']]
			expect(contract.is(store)).toBe(true)
			expect(reads.calls).toEqual(once)
			reads.clear()
			expect(contract.audit(store)).toEqual([])
			expect(reads.calls).toEqual(once)
			reads.clear()
			expect(contract.parse(store)).toBe(store)
			expect(reads.calls).toEqual(once)
			reads.clear()
			expect(contract.explain(store)).toEqual([])
			expect(reads.calls).toEqual(once)
		},
	)

	it('admits a class-instance store with unknown extra members and refuses one missing delete at its path', () => {
		const contract = createContract(STORE_DECLARATION)
		const store = new SessionStore()
		store.set('Ada', 1)
		expect(contract.is(store)).toBe(true)
		expect(contract.parse(store)).toBe(store)
		const missing = [{ reason: 'missing', path: ['delete'], expected: 'function' }]
		expect(contract.audit(new PartialStore())).toEqual(missing)
		expect(contract.explain(new PartialStore())).toEqual(missing)
		const nested = createContract(arrayShape(objectShape({ store: STORE_DECLARATION })))
		expect(nested.audit([{ store }, { store: new PartialStore() }])).toEqual([
			{ reason: 'missing', path: ['1', 'store', 'delete'], expected: 'function' },
		])
	})

	it('answers from a compiler whose guard, parser, or reporter is read first', () => {
		const store = new SessionStore()
		const partial = new PartialStore()
		expect(new ContractCompiler(STORE_DECLARATION).guard(store)).toBe(true)
		expect(new ContractCompiler(STORE_DECLARATION).guard(partial)).toBe(false)
		expect(new ContractCompiler(STORE_DECLARATION).parser(store)).toBe(store)
		expect(new ContractCompiler(STORE_DECLARATION).parser(partial)).toBeUndefined()
		expect(new ContractCompiler(STORE_DECLARATION).reporter(partial)).toEqual([
			{ reason: 'missing', path: ['delete'], expected: 'function' },
		])
	})

	it('generates a frozen plain record of generated members that the contract admits', () => {
		const contract = createContract(
			interfaceShape({
				get: functionShape(),
				ttl: optionalShape(integerShape({ min: 0, max: 9 })),
			}),
		)
		for (const seed of [1, 2, 3, 4, 5, 6]) {
			const generated = contract.generate(seededRandom(seed))
			expect(Object.isFrozen(generated)).toBe(true)
			expect(Object.getPrototypeOf(generated)).toBe(Object.prototype)
			expect(typeof generated.get).toBe('function')
			expect(contract.is(generated)).toBe(true)
		}
	})

	it.each(INTERFACE_LAW_SHAPES.map((shape, index) => [index, shape] as const))(
		'holds every law over the seeded corpus of interface law shape %i',
		(_index, shape) => {
			expect(findUndefinedLawViolations(shape, 16)).toEqual([])
		},
	)

	it('publishes only coded refusals for an unreadable implementation', () => {
		const contract = createContract(STORE_DECLARATION)
		const revoked = Proxy.revocable({}, {})
		revoked.revoke()
		expect(contract.is(revoked.proxy)).toBe(false)
		expect(captureContractError(() => contract.audit(revoked.proxy)).message).toBe(
			'compileAuditor: interface could not be read',
		)
		expect(captureContractError(() => contract.parse(revoked.proxy)).code).toBe('structure')
		expect(contract.explain(revoked.proxy)).toEqual([
			{ reason: 'type', path: [], expected: 'object', received: 'instance' },
		])
	})
})

describe('ContractCompiler — own', () => {
	it.each(['prototype', 'function'] as const)(
		'reads each own member and each declared member of a %s store one time when the bag is admitted',
		(form) => {
			const reads = createRecorder<readonly [string]>()
			const bag = buildOwnedBag(form, 5, reads.handler)
			const result = createContract(OWNED_BAG_SHAPE).own(bag)

			expect(result.success).toBe(true)
			expect(reads.calls).toEqual([['secret'], ['get'], ['set'], ['delete']])
		},
	)

	it.each(['prototype', 'function'] as const)(
		'reads each own member and each declared member of a %s store one time when the bag is refused',
		(form) => {
			const reads = createRecorder<readonly [string]>()
			const bag = buildOwnedBag(form, 'soon', reads.handler)
			const result = createContract(OWNED_BAG_SHAPE).own(bag)

			expect(result).toEqual({
				success: false,
				error: {
					faults: [{ reason: 'type', path: ['ttl'], expected: 'number', received: '"soon"' }],
				},
			})
			expect(reads.calls).toEqual([['secret'], ['get'], ['set'], ['delete']])
		},
	)

	it('reads each declared member of a store that faults two times, where the refusal is explained', () => {
		const reads = createRecorder<readonly [string]>()
		const bag = { secret: 'hunter2', store: buildFaultedStore(reads.handler), ttl: 5 }
		const result = createContract(OWNED_BAG_SHAPE).own(bag)

		expect(result).toEqual({
			success: false,
			error: {
				faults: [
					{ reason: 'type', path: ['store', 'delete'], expected: 'function', received: '"never"' },
				],
			},
		})
		expect(reads.calls).toEqual([['get'], ['set'], ['delete'], ['get'], ['set'], ['delete']])
	})

	it('keeps the refusal of a store member that reads invalid then valid, with a structure cause', () => {
		const bag = { secret: 'hunter2', store: createShiftingStore(), ttl: 5 }
		const result = createContract(OWNED_BAG_SHAPE).own(bag)
		const cause = result.success ? undefined : result.error.cause

		expect(result.success).toBe(false)
		expect(!result.success && result.error.faults).toEqual([])
		expect(isContractError(cause) && cause.code).toBe('structure')
		expect(isContractError(cause) && cause.message).toBe('own: the value changed between reads')
		expect(isContractError(cause) && cause.context?.path).toEqual([])
	})

	it.each(buildImplementationRows())(
		'returns $name at the store position by identity, inside a copy of the bag',
		({ value }) => {
			const bag = { secret: 'hunter2', store: value, ttl: 5 }
			const result = createContract(OWNED_BAG_SHAPE).own(bag)

			expect(result.success && result.value.store).toBe(value)
			expect(result.success && result.value).not.toBe(bag)
			expect(result.success && result.value).toEqual(bag)
		},
	)

	it('answers from the one read a changing getter gives, where admitValue reads it twice', () => {
		const counted = createContract(objectShape({ value: integerShape() }))
		const named = createContract(objectShape({ value: stringShape() }))

		expect(counted.own(createStatefulGetter())).toEqual({ success: true, value: { value: 1 } })
		expect(admitValue(counted, createStatefulGetter())).toEqual({
			success: false,
			error: { faults: [] },
		})
		expect(named.own(createStatefulGetter())).toEqual({
			success: false,
			error: {
				faults: [{ reason: 'type', path: ['value'], expected: 'string', received: '1' }],
			},
		})
		expect(admitValue(named, createStatefulGetter())).toEqual({
			success: false,
			error: { faults: [] },
		})
	})

	it.each(Array.from({ length: 24 }, (_entry, seed) => seed + 1))(
		'equals admitValue in verdict, value, and faults over seeded law shape %i',
		(seed) => {
			const contract: ContractInterface<unknown> = createContract(
				drawLawShape(seededRandom(seed), 3),
			)
			const corpus = buildOwnLawCorpus(contract, 8)

			expect(corpus.length).toBeGreaterThan(0)
			expect(corpus.map((value) => admissionToVerdict(contract.own(value)))).toEqual(
				corpus.map((value) => admissionToVerdict(admitValue(contract, value))),
			)
		},
	)

	it.each([1, 2, 3, 4])(
		'equals admitValue over the union and refinement shapes of seed %i',
		(seed) => {
			for (const shape of buildLawShapes(seed)) {
				const contract: ContractInterface<unknown> = createContract(shape)
				const corpus = buildOwnLawCorpus(contract, 8)

				expect(corpus.map((value) => admissionToVerdict(contract.own(value)))).toEqual(
					corpus.map((value) => admissionToVerdict(admitValue(contract, value))),
				)
			}
		},
	)

	it('judges a non-enumerable data member a shape position reads as admitValue does', () => {
		const contract = createContract(shapeShape())
		const low = Object.defineProperty({ category: 'number' }, 'min', {
			value: 'low',
			enumerable: false,
		})
		const bounded = Object.defineProperty({ category: 'number' }, 'min', {
			value: 2,
			enumerable: false,
		})

		expect(contract.own(low)).toEqual(admitValue(contract, low))
		expect(contract.own(low).success).toBe(false)
		expect(admissionToVerdict(contract.own(bounded))).toEqual(
			admissionToVerdict(admitValue(contract, bounded)),
		)
	})

	it('reports every fault of a bag with a function member beside data that is not JSON in one refusal', () => {
		const contract = createContract(
			objectShape({
				name: stringShape({ min: 1 }),
				version: optionalShape(integerShape({ min: 1 })),
				stores: recordShape(objectShape({ key: stringShape() })),
				upgrade: optionalShape(functionShape()),
			}),
		)
		const upgrade = encodeURI
		const refused = contract.own({
			name: '',
			version: 0,
			stores: { users: { key: new Date(0) } },
			upgrade,
		})
		const admitted = contract.own({ name: 'app', stores: { users: { key: 'id' } }, upgrade })

		expect(refused).toEqual({
			success: false,
			error: {
				faults: [
					{
						reason: 'constraint',
						path: ['name'],
						expected: 'string',
						constraint: 'min',
						limit: 1,
						received: '""',
					},
					{
						reason: 'constraint',
						path: ['version'],
						expected: 'integer',
						constraint: 'min',
						limit: 1,
						received: '0',
					},
					{
						reason: 'type',
						path: ['stores', 'users', 'key'],
						expected: 'string',
						received: 'instance',
					},
				],
			},
		})
		expect(admitted.success && admitted.value.upgrade).toBe(upgrade)
	})

	it('owns JSON data through a JSON contract and refuses a value that is not JSON data', () => {
		const contract = createContract(jsonShape())
		const source = { name: 'Ada', tags: ['admin'], profile: { age: 36 } }
		const owned = contract.own(source)

		expect(owned).toEqual({ success: true, value: source })
		expect(owned.success && owned.value).not.toBe(source)
		expect(owned.success && Object.isFrozen(owned.value)).toBe(true)
		expect(contract.own({ name: 'Ada', joined: new Date(0) })).toEqual(
			admitValue(contract, { name: 'Ada', joined: new Date(0) }),
		)
		expect(contract.own({ name: 'Ada', joined: new Date(0) }).success).toBe(false)
	})

	it('refuses a class-instance bag at an object position without reading its members', () => {
		const reads = createRecorder<readonly [string]>()
		const bag = Object.defineProperty(new SessionStore(), 'secret', {
			get: () => {
				reads.handler('secret')
				return 'hunter2'
			},
			enumerable: true,
		})
		const contract = createContract(objectShape({ secret: stringShape() }))

		expect(contract.own(bag)).toEqual({
			success: false,
			error: {
				faults: [{ reason: 'type', path: [], expected: 'object', received: 'instance' }],
			},
		})
		expect(reads.calls).toEqual([])
	})

	it('owns a cyclic value in one walk and answers it as admitValue does', () => {
		const contract = createContract(jsonShape())
		const nested = createContract(objectShape({ self: objectShape({ self: jsonShape() }) }))

		expect(contract.own(buildCyclicRecord())).toEqual(admitValue(contract, buildCyclicRecord()))
		expect(contract.own(buildCyclicRecord()).success).toBe(false)
		expect(admissionToVerdict(nested.own(buildCyclicRecord()))).toEqual(
			admissionToVerdict(admitValue(nested, buildCyclicRecord())),
		)
	})

	it('refuses a value past the node limit with a clone cause and admits one at the limit', () => {
		const contract = createContract(arrayShape(numberShape()))
		const refused = contract.own(new Array<number>(CLONE_NODE_LIMIT).fill(0))
		const admitted = contract.own(new Array<number>(CLONE_NODE_LIMIT - 1).fill(0))

		expect(refused.success).toBe(false)
		expect(!refused.success && refused.error.faults).toEqual([])
		expect(
			!refused.success && isContractError(refused.error.cause) && refused.error.cause.code,
		).toBe('clone')
		expect(admitted.success).toBe(true)
	})

	it('refuses a throwing getter with a coded cause that keeps the thrown value', () => {
		const sentinel = Object.freeze({ stage: 'read' })
		const bag = Object.defineProperty({}, 'secret', {
			get: throwSentinel(sentinel),
			enumerable: true,
		})
		const result = createContract(objectShape({ secret: stringShape() })).own(bag)

		expect(result.success).toBe(false)
		expect(!result.success && result.error.faults).toEqual([])
		const cause = result.success ? undefined : result.error.cause
		expect(isContractError(cause) && cause.code).toBe('structure')
		expect(isContractError(cause) && cause.cause).toBe(sentinel)
	})

	it('types the generic call at the argument and the unannotated call at the contract', () => {
		const contract = createContract(OWNED_BAG_SHAPE)
		const bag = { secret: 'hunter2', store: new SessionStore(), ttl: 5 }
		const typed = contract.own(bag)
		const unknown: unknown = bag
		const widened = contract.own(unknown)
		const lock: Expect<Equal<typeof typed, Result<typeof bag, ContractRefusal>>> = true
		const wide: Expect<
			Equal<typeof widened, Result<Infer<typeof OWNED_BAG_SHAPE>, ContractRefusal>>
		> = true

		expect([lock, wide]).toEqual([true, true])
		expect(typed.success && typed.value.store.size).toBe(0)
	})

	it('publishes one owner on the compiler and in the bundle', () => {
		const compiler = new ContractCompiler(OWNED_BAG_SHAPE)

		expect(compiler.owner).toBe(compiler.owner)
		expect(compiler.contract.own).toBe(compiler.owner)
	})
})

describe('ContractCompiler — counted guard walks', () => {
	it('answers the array guard over empty, single, signed-zero, and NaN items', () => {
		const numbers = createContract(arrayShape(numberShape()))
		const bounded = createContract(arrayShape(numberShape(), { min: 1 }))

		expect(numbers.is([])).toBe(true)
		expect(numbers.is([1.5])).toBe(true)
		expect(numbers.is([-0, 0])).toBe(true)
		expect(numbers.is([Number.NaN])).toBe(false)
		expect(numbers.is([1, 2, 'three'])).toBe(false)
		expect(numbers.is(buildHoledArray([1, 2, 3], 1))).toBe(false)
		expect(bounded.is([])).toBe(false)
		expect(bounded.is(['one'])).toBe(false)
	})

	it('stops the array guard at the first refused item and reads no later item', () => {
		const reads = createRecorder<[key: string]>()
		const rows = createContract(arrayShape(objectShape({ id: numberShape() })))
		const refused = buildReportingRecord([['id', 'one']], reads.handler)
		const later = buildReportingRecord([['id', 2]], reads.handler)

		expect(rows.is([refused, later])).toBe(false)
		expect(reads.calls).toEqual([['id']])
		reads.clear()
		expect(rows.is([later, refused])).toBe(false)
		expect(reads.calls).toEqual([['id'], ['id']])
	})

	it('answers a kept key plan in plan order and stops at the first refused member', () => {
		const reads = createRecorder<[key: string]>()
		const rows = createContract(objectShape({ id: numberShape(), rank: numberShape() }))
		const empty = createContract(objectShape({}))

		expect(rows.is({ id: 1, rank: 2 })).toBe(true)
		expect(
			rows.is(
				buildReportingRecord(
					[
						['id', -0],
						['rank', 2],
					],
					reads.handler,
				),
			),
		).toBe(true)
		expect(reads.calls).toEqual([['id'], ['rank']])
		reads.clear()
		expect(
			rows.is(
				buildReportingRecord(
					[
						['id', Number.NaN],
						['rank', 2],
					],
					reads.handler,
				),
			),
		).toBe(false)
		expect(reads.calls).toEqual([['id']])
		expect(empty.is({})).toBe(true)
		expect(empty.is({})).toBe(true)
		expect(empty.is({ id: 1 })).toBe(false)
	})
})
