import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import {
	createGuide,
	createSource,
	fenceImports,
	findMissing,
	findUnexampled,
	isExternalLink,
	missingSymbols,
	parseManifest,
	resolveLink,
	symbolKey,
} from '@orkestrel/guide'
import * as barrel from '@src/core'
import {
	ContractCompiler,
	ContractError,
	JSONCloner,
	SchemaCloner,
	ShapeCloner,
	ShapeValidator,
} from '@src/core'
import { DriftedMethods, SMUGGLED_KEY, SmuggledMember } from './setup.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const WALK_DIRS = ['src', 'guides', 'tests']
const SELF_SPECIFIERS = ['@orkestrel/contract', '@src/core']

function walk(dir: string, acc: Record<string, string>): void {
	for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
		const relative = `${dir}/${entry.name}`
		if (entry.isDirectory()) {
			walk(relative, acc)
			continue
		}
		if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.md')) continue
		acc[relative] = readFileSync(join(ROOT, relative), 'utf8')
	}
}

const files: Record<string, string> = {}
for (const dir of WALK_DIRS) walk(dir, files)
files['AGENTS.md'] = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')

function readText(relative: string): string {
	const text = files[relative]
	if (text === undefined) throw new Error(`Missing file: ${relative}`)
	return text
}

const manifest = parseManifest(readText('guides/README.md'), 'guides')

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(readText(entry.spec))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('extracts a non-empty documented surface', () => {
			expect(guide.surface().length).toBeGreaterThan(0)
		})
		it('documents every source export', () => {
			expect(missingSymbols(source.exports(), guide.surface())).toEqual([])
		})
		it('documents only real exports', () => {
			expect(missingSymbols(guide.surface(), source.exports())).toEqual([])
		})

		it('exposes no hidden module-scope declarations', () => {
			expect(source.hidden().map(symbolKey)).toEqual([])
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
			const fences = guide.patterns()
			const names = guide
				.surface()
				.filter((symbol) => symbol.kind === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide.patterns()
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const exportNames = source.exports().map((symbol) => symbol.name)
			for (const fence of guide.patterns()) {
				for (const { specifier, names } of fenceImports(fence)) {
					if (!SELF_SPECIFIERS.includes(specifier)) continue
					expect(findMissing(names, exportNames)).toEqual([])
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
// actually ships. These read the real prototypes instead, and the two halves
// answer different questions — which is why both are here.
const CORE_GUIDE = 'guides/src/contract.md'
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
	const guideText = readText(CORE_GUIDE)
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
