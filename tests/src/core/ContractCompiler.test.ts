import type { ContractCompilerInterface, ContractShape, StringShape } from '@src/core'
import {
	arrayShape,
	attempt,
	booleanShape,
	compileAuditor,
	compileGenerator,
	compileGuard,
	compileParser,
	compileReporter,
	compileSchema,
	ContractCompiler,
	cloneJSONValue,
	createContract,
	integerShape,
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
	stringShape,
	unionShape,
} from '@src/core'
import {
	polluteArrayConstruction,
	measureAllocations,
	buildCountedGraph,
	buildCountedSlots,
	buildDeepShape,
	buildSharedDagShape,
	buildStaircaseShape,
	captureContractError,
	listCompilerDoors,
	ObservedShape,
	ReentrantShape,
} from '../../setup.js'
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

	it('exposes exactly the seven ruled getters and pins them', () => {
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

	it('replays each root by identity and bundles those exact six values', () => {
		const compiler = new ContractCompiler(objectShape({ name: stringShape({ min: 1 }) }))
		const bundle = compiler.contract

		expect(compiler.schema).toBe(compiler.schema)
		expect(compiler.guard).toBe(compiler.guard)
		expect(compiler.parser).toBe(compiler.parser)
		expect(compiler.auditor).toBe(compiler.auditor)
		expect(compiler.reporter).toBe(compiler.reporter)
		expect(compiler.generator).toBe(compiler.generator)
		expect(compiler.contract).toBe(bundle)

		expect(Object.keys(bundle)).toEqual(['schema', 'is', 'parse', 'audit', 'explain', 'generate'])
		expect(Object.isFrozen(bundle)).toBe(true)
		expect(bundle.schema).toBe(compiler.schema)
		expect(bundle.is).toBe(compiler.guard)
		expect(bundle.parse).toBe(compiler.parser)
		expect(bundle.audit).toBe(compiler.auditor)
		expect(bundle.explain).toBe(compiler.reporter)
		expect(bundle.generate).toBe(compiler.generator)
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
