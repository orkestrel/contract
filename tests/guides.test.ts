// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants below are this
// package's own, and are the only part a sibling package changes.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import { readFileSync } from 'node:fs'
import { requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'
import type { ContractCompilerInterface } from '@src/core'
import * as barrel from '@src/core'
import {
	ContractCompiler,
	ContractError,
	JSONCloner,
	SchemaCloner,
	ShapeCloner,
	ShapeValidator,
	createContract,
	objectShape,
	stringShape,
} from '@src/core'
import { DriftedMethods, SMUGGLED_KEY, SmuggledMember } from './setup.js'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['text', 'ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ '@orkestrel/contract': 'src/core', '@src/core': 'src/core' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the second assertion below fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([
	'class SampleInferer',
	'class SchemaShaper',
	'class ValueInferer',
])

/** Root-level files this package's guides link to. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['AGENTS.md'])

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
		})

		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('re-exports every direct declaration that is not named internal', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
		})
		it('names no symbol internal that the barrel already exports', () => {
			const stranded = findMissingSymbols(source.exports(), source.surface())
			expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
		})
		it('re-exports only direct declarations', () => {
			expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
		})
		it('documents every barrel export', () => {
			expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
		})
		it('documents only barrel exports', () => {
			expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(computeSymbolKey)).toEqual([])
		})

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.keyword === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				for (const { specifier, names } of extractFenceImports(fence.code)) {
					const imported = sources.source(specifier)
					if (imported === undefined) continue
					const surface = imported.surface().map((symbol) => symbol.name)
					expect(findMissing(names, surface)).toEqual([])
				}
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
		})
	})
}

// The RUNTIME half of the documentation contract. Everything above reflects
// source TEXT: `createSource` reads declarations, so a guide can agree with
// every declaration in the tree and still disagree with the object the package
// actually ships. These read the real prototypes instead, and the text half and
// the runtime half answer different questions — which is why each is here.
const CORE_GUIDE = 'guides/contract.md'
const RUNTIME_CLASSES = [
	{ name: 'ContractCompiler', value: ContractCompiler },
	{ name: 'ContractError', value: ContractError },
	{ name: 'JSONCloner', value: JSONCloner },
	{ name: 'SchemaCloner', value: SchemaCloner },
	{ name: 'ShapeCloner', value: ShapeCloner },
	{ name: 'ShapeValidator', value: ShapeValidator },
]

/**
 * Partition a prototype's own NAME-keyed members into call-signature members,
 * accessors, and plain data — the population `## Methods` and `## Surface`
 * split between them.
 */
function readMembers(prototype: object): {
	readonly methods: readonly string[]
	readonly accessors: readonly string[]
	readonly data: readonly string[]
} {
	const methods: string[] = []
	const accessors: string[] = []
	const data: string[] = []
	for (const key of Object.getOwnPropertyNames(prototype)) {
		if (key === 'constructor') continue
		const descriptor = Object.getOwnPropertyDescriptor(prototype, key)
		if (descriptor === undefined) continue
		if (typeof descriptor.value === 'function') methods.push(key)
		else if (typeof descriptor.get === 'function') accessors.push(key)
		else data.push(key)
	}
	return { methods, accessors, data }
}

describe('runtime parity', () => {
	const guideText = requireValue(files[CORE_GUIDE], `Missing file: ${CORE_GUIDE}`)
	const contractGuide = createGuide(guideText)
	const documented = new Map<string, readonly string[]>()
	for (const group of contractGuide.methods()) documented.set(group.interface, group.methods)

	it('enumerates every class the barrel publishes', () => {
		// The per-class checks below are worth exactly as much as this list is
		// complete: a new class nobody added here would be silently unchecked.
		const published: string[] = []
		for (const [name, value] of Object.entries(barrel)) {
			if (typeof value === 'function' && /^[A-Z]/.test(name)) published.push(name)
		}
		expect(published.sort()).toEqual(RUNTIME_CLASSES.map((entry) => entry.name).sort())
	})

	for (const entry of RUNTIME_CLASSES) {
		describe(`${entry.name}`, () => {
			it('carries exactly the methods its interface documents', () => {
				expect(readMembers(entry.value.prototype).methods).toEqual(
					documented.get(`${entry.name}Interface`) ?? [],
				)
			})

			it('documents every accessor and puts no data on its prototype', () => {
				const members = readMembers(entry.value.prototype)
				expect(members.data).toEqual([])
				for (const accessor of members.accessors) {
					expect(guideText).toContain(`\`${accessor}\``)
				}
			})

			it('hides no prototype member behind a symbol key', () => {
				expect(Object.getOwnPropertySymbols(entry.value.prototype)).toEqual([])
			})
		})
	}

	it('reports a class that grew an undocumented method', () => {
		// The controlled opposite, drawn from INSIDE the name-keyed population:
		// without it, a reader that found nothing at all would pass every check
		// above and look exactly like a package in perfect parity.
		expect(readMembers(DriftedMethods.prototype).methods).toEqual(['validate', 'undocumented'])
		expect(documented.get('ShapeValidatorInterface')).toEqual(['validate'])
	})

	it('cannot see a symbol-keyed method by name, which is what the symbol check is for', () => {
		// The control drawn from OUTSIDE that population. It establishes the
		// membership rule's blind spot and that the separate own-symbol assertion
		// is the thing that closes it — it establishes nothing about whether the
		// name walk partitions name-keyed members correctly.
		expect(readMembers(SmuggledMember.prototype).methods).toEqual([])
		expect(Object.getOwnPropertySymbols(SmuggledMember.prototype)).toEqual([SMUGGLED_KEY])
	})
})

// The EXECUTED half. Every preceding check reads a name — from source text or
// from a prototype — and a name that resolves proves nothing about a sentence
// beside it, so a fence whose comment claims a value the code contradicts
// passes all of them. The cases here run the flagship fences and assert the
// values their comments claim. Change a fence, change the transcription beside
// it.
describe('flagship fences', () => {
	const guideText = requireValue(files[CORE_GUIDE], `Missing file: ${CORE_GUIDE}`)

	it('answers from a compiled guard that no live compiler is behind', () => {
		// Transcribed from the compiling-a-contract passage, which tells a reader
		// wanting one artifact to keep the artifact and let the compiler go. That
		// advice is worth nothing unless the guard still answers when the compiler
		// it came from was never bound to a name, so this runs exactly that.
		const isTicket = new ContractCompiler(objectShape({ id: stringShape({ min: 1 }) })).guard

		expect(isTicket({ id: 'T-1' })).toBe(true)
		expect(isTicket({ id: '' })).toBe(false)
	})

	it('carries the guard fence lines the transcription copies', () => {
		// The presence guard beside the transcription: it proves the transcribed
		// lines are still the documented ones, and nothing whatever about behavior.
		// Binding the construction line alone leaves a comment free to claim the
		// opposite value and stay green, so every line carrying a claim is bound.
		expect(guideText).toContain(
			'const isTicket = new ContractCompiler(objectShape({ id: stringShape({ min: 1 }) })).guard',
		)
		expect(guideText).toContain("isTicket({ id: 'T-1' }) // true")
		expect(guideText).toContain("isTicket({ id: '' }) // false")
	})

	it('answers from a contract whose members disagree about one undeclared key', () => {
		// The compiling-a-contract fence: one undeclared key, read by every member
		// that can see it. Derived together is not the same as equal, and each
		// expectation here is that fence's own comment, executed.
		const contract = createContract(objectShape({ id: stringShape() }))
		const value = { id: 'a', debug: true }

		expect(contract.is(value)).toBe(false)
		expect(contract.parse(value)).toEqual({ id: 'a' })
		expect(contract.audit(value)).toEqual([{ reason: 'extra', path: ['debug'] }])
		expect(contract.explain(value)).toEqual([])
	})

	it('carries the contract fence lines the transcription copies', () => {
		expect(guideText).toContain(
			'const contract = createContract(objectShape({ id: stringShape() }))',
		)
		expect(guideText).toContain('contract.is(value) // false')
		expect(guideText).toContain("contract.parse(value) // { id: 'a' }")
		expect(guideText).toContain("contract.audit(value) // [{ reason: 'extra', path: ['debug'] }]")
		expect(guideText).toContain('contract.explain(value) // []')
	})

	it('replays one artifact per getter and hands the bundle those exact values', () => {
		// The direct-compiler fence. The identity claims are the load-bearing part:
		// a getter that recompiled on each read would satisfy every value assertion
		// in this file and still break the contract this fence documents.
		const shape = objectShape({ id: stringShape({ min: 1 }) })
		const compiler: ContractCompilerInterface<typeof shape> = new ContractCompiler(shape)

		expect(compiler.guard({ id: 'a' })).toBe(true)
		expect(compiler.guard).toBe(compiler.guard)
		expect(compiler.contract.is).toBe(compiler.guard)
	})

	it('carries the compiler fence lines the transcription copies', () => {
		expect(guideText).toContain(
			'const compiler: ContractCompilerInterface<typeof shape> = new ContractCompiler(shape)',
		)
		expect(guideText).toContain("compiler.guard({ id: 'a' }) // true")
		expect(guideText).toContain('compiler.guard === compiler.guard // true')
		expect(guideText).toContain('compiler.contract.is === compiler.guard // true')
	})
})
