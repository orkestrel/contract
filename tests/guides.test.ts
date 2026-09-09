// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import type { ContractCompilerInterface } from '@src/core'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['text', 'ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/contract.md'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ '@orkestrel/contract': 'src/core', '@src/core': 'src/core' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([
	'class SampleInferer',
	'class SchemaShaper',
	'class ValueInferer',
])

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { computeSymbolKey, createGuide, findMissingSymbols } = await import('@orkestrel/guide')
	const { requireValue } = await import('@orkestrel/test')
	const barrel = await import('@src/core')
	const {
		ContractCompiler,
		ContractError,
		JSONCloner,
		SchemaCloner,
		ShapeCloner,
		ShapeValidator,
		createContract,
		integerShape,
		objectShape,
		stringShape,
	} = barrel
	const { DriftedMethods, readMembers, SMUGGLED_KEY, SmuggledMember } = await import('./setup.js')
	const { describe, expect, it } = await import('vitest')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.map((row) => row.entry.spec)).toContain(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on both sides `findDrift` compares no pair and the case passes on the summaries
	// alone. This pins the population this repository's own guide contributes, so removing
	// every `@example` title reddens the suite instead of quietly retiring half the gate.
	// The failure names both title sets, because a pin reporting only its own emptiness
	// leaves the reader to work out which side dropped the title.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	// The README's pitch and the guide's tagline are one text, each read as the blockquote
	// under its file's H1. `README.md` is outside the concept index, so the reader is
	// applied to it directly rather than through a manifest row. Each side is guarded
	// against `undefined` first, so a file that lost its blockquote reports that rather
	// than reporting two absences as agreement.
	it('opens the README with the guide tagline', () => {
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
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

			it('documents a populated method group', () => {
				expect(guide.methods().filter((group) => group.methods.length === 0)).toEqual([])
			})

			it('keeps behavioral interfaces and implementing classes in parity', () => {
				expect(report.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			// The equality gate: a `Summary` cell against its export's description paragraph, a
			// titled fence against the `@example` of that title. `findDrift` owns the comparison
			// and names both sides; converge the two sides through the native entry, never by
			// weakening this assertion. `findDrift` pairs an example only where a title is
			// present on both sides, so an untitled `@example` block is outside this case. Each
			// collected line is the spec, the key, and each side's text or `absent` — the same
			// worklist the native entry prints, so a failure here is read the way that command's
			// output is. Select source authority with `--to guide`, or guide authority with
			// `--to source`.
			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			it('documents an example for every method', () => {
				expect(report.examples.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('imports only real exports in every ```ts fence', () => {
				expect(report.imports.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('resolves every relative link', () => {
				expect(report.links.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
			it('links only to test files that exist', () => {
				expect(report.tests.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
		})
	}

	// The RUNTIME half of the documentation contract. Everything above reflects
	// source TEXT: the row source reads declarations, so a guide can agree with
	// every declaration in the tree and still disagree with the object the package
	// actually ships. These read the real prototypes instead, and the text half and
	// the runtime half answer different questions — which is why each is here.
	const RUNTIME_CLASSES = [
		{ name: 'ContractCompiler', value: ContractCompiler },
		{ name: 'ContractError', value: ContractError },
		{ name: 'JSONCloner', value: JSONCloner },
		{ name: 'SchemaCloner', value: SchemaCloner },
		{ name: 'ShapeCloner', value: ShapeCloner },
		{ name: 'ShapeValidator', value: ShapeValidator },
	]

	describe('runtime parity', () => {
		const guideText = requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`)
		const contractGuide = createGuide(guideText)
		const documented = new Map<string, readonly string[]>()
		for (const group of contractGuide.methods())
			documented.set(
				group.interface,
				group.methods.map((method) => method.name),
			)

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
		const guideText = requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`)

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

		it('parses and explains the user contract the titled fence builds', () => {
			// The titled `Compiling a contract` fence, executed. Its parse line claims the
			// refinement is enforced on the parse side as well as the guard side, and its
			// explain line claims the exact fault a violation produces, so each runs here
			// rather than being read as text.
			const user = createContract(
				objectShape({ name: stringShape({ min: 1 }), age: integerShape() }),
			)

			expect(user.is({ name: 'Ada', age: 36 })).toBe(true)
			expect(user.parse({ name: 'Ada', age: '36' })).toEqual({ name: 'Ada', age: 36 })
			expect(user.parse({ name: '', age: 36 })).toBeUndefined()
			expect(user.explain({ name: '', age: 36 })).toEqual([
				{
					reason: 'constraint',
					path: ['name'],
					expected: 'string',
					constraint: 'min',
					limit: 1,
					received: '""',
				},
			])
		})

		it('carries the user fence lines the transcription copies', () => {
			expect(guideText).toContain(
				'const user = createContract(objectShape({ name: stringShape({ min: 1 }), age: integerShape() }))',
			)
			expect(guideText).toContain(
				"user.is({ name: 'Ada', age: 36 }) // true — a typed guard (narrows to Infer<typeof shape>)",
			)
			expect(guideText).toContain(
				"user.parse({ name: 'Ada', age: '36' }) // { name: 'Ada', age: 36 } — coerces, or undefined",
			)
			expect(guideText).toContain(
				"user.parse({ name: '', age: 36 }) // undefined — '' violates name min:1 (parse enforces refinements, like is)",
			)
			expect(guideText).toContain(
				`user.explain({ name: '', age: 36 }) // [{ reason: 'constraint', path: ['name'], expected: 'string', constraint: 'min', limit: 1, received: '""' }]`,
			)
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
})
