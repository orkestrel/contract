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
	buildCountedGraph,
	buildCountedSlots,
	buildDeepShape,
	buildSharedDagShape,
	buildStaircaseShape,
	captured,
	captureContractError,
	ObservedShape,
	ReentrantShape,
} from '../../setup.js'
import { describe, expect, it, vi } from 'vitest'

describe('ContractCompiler', () => {
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
		const configurable: string[] = []
		for (const key of Object.getOwnPropertyNames(ContractCompiler.prototype)) {
			const descriptor = Object.getOwnPropertyDescriptor(ContractCompiler.prototype, key)
			if (descriptor?.configurable !== false) configurable[configurable.length] = key
		}
		expect(configurable).toEqual([])
		expect(compiler.guard('Ada')).toBe(true)
		expect(compiler.guard('')).toBe(false)
	})

	it('observes nothing at construction', () => {
		// Inertness is a claim about READS, so it is measured with a node that
		// counts them, and about work, so it is measured with declarations that
		// cannot survive a walk. Neither construction touches either.
		const observed = new ObservedShape()
		const malformed: ContractShape = JSON.parse('{"type":"string","min":5,"max":1}')
		const cyclic: ContractShape = JSON.parse('{"type":"array","items":{"type":"string"}}')
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

		const malformed: ContractShape = JSON.parse('{"type":"string","min":5,"max":1}')
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
		const started = Date.now()
		const contract = createContract(shape)
		const cost = Date.now() - started

		expect(cost).toBeLessThan(1_000)
		expect(contract.is({})).toBe(false)
		expect(contract.audit({}).length).toBeGreaterThan(0)
	})

	it('refuses a declaration whose expansion exceeds the node limit, in bounded time', () => {
		const compiler = new ContractCompiler(buildSharedDagShape(30))
		const started = Date.now()
		const error = captureContractError(() => compiler.schema)
		const cost = Date.now() - started

		expect(cost).toBeLessThan(1_000)
		expect(error.code).toBe('expansion')
		expect(error.message).toBe(
			'validateShapeDepth: a shape expands past the compilation node limit',
		)
		// Every later getter replays that exact terminal error rather than retrying.
		expect(captureContractError(() => compiler.guard)).toBe(error)
		expect(captureContractError(() => compiler.contract)).toBe(error)
	})

	it('poisons the nested read, the interrupted read, and every later read on reentry', () => {
		// The only reachable reentry: ownership invokes a declaration's `pattern`
		// getter — the one accessor it is documented to run — and that getter reads
		// a getter of the compiler currently owning the same declaration.
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
		const revocable = Proxy.revocable({ type: 'string' } satisfies ContractShape, {})
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
		const malformed: ContractShape = JSON.parse('{"type":"number","min":5,"max":1}')
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
				if (accepted !== audited) disagreements[disagreements.length] = `is/audit ${shape.type}`
				if (parsed !== explained) {
					disagreements[disagreements.length] = `parse/explain ${shape.type}`
				}
				// The standalone doors must answer identically to the compiler's roots,
				// since they are the same compiled artifacts reached another way.
				if (compileGuard(shape)(value) !== accepted) {
					disagreements[disagreements.length] = `door/is ${shape.type}`
				}
				if ((compileAuditor(shape, value).length === 0) !== audited) {
					disagreements[disagreements.length] = `door/audit ${shape.type}`
				}
				if ((compileReporter(shape, value).length === 0) !== explained) {
					disagreements[disagreements.length] = `door/explain ${shape.type}`
				}
				if ((compileParser(shape)(value) !== undefined) !== parsed) {
					disagreements[disagreements.length] = `door/parse ${shape.type}`
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
		let shape: ContractShape = numberShape()
		let value: unknown = 0
		for (let level = 0; level < levels; level += 1) {
			shape = arrayShape(shape)
			value = [value, value]
		}
		const contract = createContract(shape)
		const started = Date.now()
		const answers: readonly unknown[] = [
			contract.is(value),
			contract.audit(value),
			contract.explain(value),
		]

		expect(Date.now() - started).toBeLessThan(1_000)
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

	it('builds no tracking ledger while a compiled family is assembled', async () => {
		// A ledger built with the artifact would cost one map per tracked node, so
		// the count taken across the getter read would rise with the tracked-node
		// count. These two declarations differ only there. The build allocates
		// working maps of its own, so the DELTA between the two reads is the
		// discriminating figure and neither total is asserted. The call counts are
		// the control: they prove this counter registers a map the closure builds,
		// and they rise with the tracked-node count as a per-node cost must.
		const original = captured.descriptor(globalThis, 'WeakMap')
		if (original === undefined) throw new Error('the WeakMap descriptor is absent')
		let constructions = 0
		class CountingWeakMap extends WeakMap<object, unknown> {
			constructor(entries?: ReadonlyArray<readonly [object, unknown]> | null) {
				super(entries)
				constructions += 1
			}
		}
		let buildDelta = 0
		let calledFew = 0
		let calledMany = 0
		let answers: readonly unknown[] = []
		try {
			captured.define(globalThis, 'WeakMap', { ...original, value: CountingWeakMap })
			vi.resetModules()
			const loaded = await import('../../../src/core/index.js')
			const few = loaded.objectShape({
				items: loaded.arrayShape(loaded.objectShape({ name: loaded.stringShape() })),
			})
			const many = loaded.objectShape({
				items: loaded.arrayShape(loaded.objectShape({ name: loaded.stringShape() })),
				first: loaded.objectShape({ tag: loaded.stringShape() }),
				second: loaded.objectShape({ tag: loaded.stringShape() }),
				third: loaded.objectShape({ tag: loaded.stringShape() }),
				fourth: loaded.objectShape({ tag: loaded.stringShape() }),
			})
			const compilerFew = new loaded.ContractCompiler(few)
			const compilerMany = new loaded.ContractCompiler(many)

			let opened = constructions
			const guardFew = compilerFew.guard
			const builtFew = constructions - opened
			opened = constructions
			const guardMany = compilerMany.guard
			buildDelta = constructions - opened - builtFew

			opened = constructions
			const answeredFew = guardFew({ items: [{ name: 'leaf' }] })
			calledFew = constructions - opened
			opened = constructions
			const answeredMany = guardMany({
				items: [{ name: 'leaf' }],
				first: { tag: 'a' },
				second: { tag: 'b' },
				third: { tag: 'c' },
				fourth: { tag: 'd' },
			})
			calledMany = constructions - opened
			answers = [answeredFew, answeredMany]
		} finally {
			captured.define(globalThis, 'WeakMap', original)
			vi.resetModules()
		}

		expect(answers).toEqual([true, true])
		expect(buildDelta).toBe(0)
		expect(calledFew).toBeGreaterThan(0)
		expect(calledMany).toBeGreaterThan(calledFew)
	})

	it('reports a shared faulted node at every path the walk reached it through', () => {
		const shape = arrayShape(objectShape({ inner: stringShape() }))
		const record = { inner: 1 }
		const paths: string[] = []
		for (const fault of compileAuditor(shape, [record, record]))
			paths[paths.length] = `${fault.path}`

		expect(paths).toEqual(['0,inner', '1,inner'])
	})

	it('still reads every distinct node of a tree value and leaves a bounded door alone', () => {
		const levels = 10
		const tree = buildCountedGraph(levels, false)
		let plain: unknown = 'leaf'
		for (let level = 0; level < 18; level += 1) plain = [plain, plain]

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
