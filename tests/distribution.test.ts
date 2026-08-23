// The artifact a consumer installs, measured rather than described. This workspace
// is packed and installed into a throwaway consumer, and every claim below is read
// off that installed tree: the exports map it publishes, the declarations it ships,
// and the module objects a real runtime hands a consumer. Nothing here names this
// package, one of its exports, or how many there are, so the proof stays true as
// the published surface moves.
import type { SpawnSyncReturns } from 'node:child_process'
import type { TestContext } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Windows needs a shell to launch a `.cmd`: Node refuses one directly since the
// batch-argument hardening, and `spawnSync` returns `EINVAL` with a null status
// rather than an exit code a caller can read. Every argument below is a literal or
// a path this file built, so the shell has nothing to escape.
const SHELL = process.platform === 'win32'
// `prepublishOnly` runs this proof as `npm run test:distribution -- --mode release`.
// Release is the publish gate, so evidence it cannot obtain fails there and skips
// everywhere else: a gate that passes on missing evidence proves nothing.
const RELEASE = import.meta.env.MODE === 'release'
// The built output directory a browser face is published from. Every selection here
// reads this prefix off the export TARGET and never off the subpath name. A
// workspace whose only published face is the browser one publishes that face at the
// root subpath, so a rule keyed on the subpath name drives a browser bundle through
// Node and the miss is silent.
const BROWSER_OUTPUT = './dist/src/browser/'
const ABSENT_SUBPATH = '/no-subpath-is-published-under-this-name'
const PING = ['ping', '--fetch-retries=0', '--fetch-timeout=5000', '--loglevel=silent']
const ESM_DRIVER = 'drive.mjs'
const CJS_DRIVER = 'drive.cjs'
const CONSUMER_MANIFEST = `{ "name": "distribution-consumer", "private": true, "type": "module" }\n`
const ESM_DRIVER_SOURCE = `const entry = await import(process.argv[2])
process.stdout.write(JSON.stringify(Object.keys(entry).sort()))
`
const CJS_DRIVER_SOURCE = `const entry = require(process.argv[2])
process.stdout.write(JSON.stringify(Object.keys(entry).sort()))
`

// One module resolution a consumer's own TypeScript can be configured with, paired
// with the module target that resolution requires.
const RESOLUTIONS = [
	['node16', ts.ModuleResolutionKind.Node16, ts.ModuleKind.Node16],
	['nodenext', ts.ModuleResolutionKind.NodeNext, ts.ModuleKind.NodeNext],
	['bundler', ts.ModuleResolutionKind.Bundler, ts.ModuleKind.ESNext],
] as const

// One published subpath, resolved to what this proof can drive: the specifier a
// consumer writes, the declaration its types condition names, whether its target is
// a browser bundle, and whether it answers `require` at all.
interface Entry {
	readonly subpath: string
	readonly specifier: string
	readonly declaration: string
	readonly browser: boolean
	readonly commonjs: boolean
}

// The installed tree every claim is read from.
interface Stage {
	readonly consumer: string
	readonly installed: string
	readonly archives: readonly string[]
	readonly entries: readonly Entry[]
	readonly targets: readonly string[]
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNames(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((name) => typeof name === 'string')
}

function readJson(path: string): unknown {
	const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
	return parsed
}

function readManifestName(path: string): string {
	const manifest = readJson(path)
	if (!isRecord(manifest) || typeof manifest.name !== 'string') {
		throw new Error(`The manifest at ${path} declares no package name`)
	}
	return manifest.name
}

function writeFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(path, content)
}

function readOutput(result: SpawnSyncReturns<string>): string {
	return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
}

function runNpm(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
	return spawnSync(NPM, [...args], {
		cwd,
		encoding: 'utf8',
		env: { ...process.env, npm_config_cache: CACHE },
		shell: SHELL,
		windowsHide: true,
	})
}

function runNode(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [...args], { cwd, encoding: 'utf8', windowsHide: true })
}

// Node's own condition matching, read in declaration order: a key answers when the
// caller requested it or when it is `default`, and the first branch reaching a
// string wins. Walking it recursively is what makes a flat entry and a
// condition-nested one the same shape here. An entry may declare `types` beside
// `default` at its top level rather than inside `import`, and a fixed
// `entry.import.types` lookup returns a JavaScript file there.
function resolveTarget(entry: unknown, conditions: readonly string[]): string | undefined {
	if (typeof entry === 'string') return entry
	if (!isRecord(entry)) return undefined
	for (const [condition, nested] of Object.entries(entry)) {
		if (condition !== 'default' && !conditions.includes(condition)) continue
		const resolved = resolveTarget(nested, conditions)
		if (resolved !== undefined) return resolved
	}
	return undefined
}

// Every file an entry can resolve to under any condition, which is the set the
// installed tree owes a file for.
function collectTargets(entry: unknown): readonly string[] {
	if (typeof entry === 'string') return [entry]
	if (!isRecord(entry)) return []
	return Object.values(entry).flatMap((nested) => collectTargets(nested))
}

// The value exports a declaration publishes, read through the compiler's checker
// over the module symbol rather than off the declaration text. An alias resolves to
// what it names, so a re-export counts as the thing it re-exports, and a type-only
// symbol is dropped because no runtime publishes one.
function readDeclaredExports(declaration: string): readonly string[] {
	const program = ts.createProgram([declaration], {
		module: ts.ModuleKind.ESNext,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		noEmit: true,
		skipLibCheck: true,
		target: ts.ScriptTarget.ESNext,
	})
	const source = program.getSourceFile(declaration)
	if (source === undefined) throw new Error(`The declaration ${declaration} was not read`)
	const checker = program.getTypeChecker()
	const symbol = checker.getSymbolAtLocation(source)
	if (symbol === undefined) throw new Error(`${declaration} declares no module symbol`)
	const values: string[] = []
	for (const exported of checker.getExportsOfModule(symbol)) {
		const direct = (exported.flags & ts.SymbolFlags.Alias) === 0
		const resolved = direct ? exported : checker.getAliasedSymbol(exported)
		if ((resolved.flags & ts.SymbolFlags.Value) !== 0) values.push(exported.getName())
	}
	return [...values].sort()
}

// The diagnostics a consumer compiling against the installed declarations reports,
// flattened to their messages so a failure names what the consumer could not do.
function compileConsumer(
	entry: string,
	resolution: ts.ModuleResolutionKind,
	module: ts.ModuleKind,
): readonly string[] {
	const program = ts.createProgram([entry], {
		module,
		moduleResolution: resolution,
		noEmit: true,
		skipLibCheck: true,
		strict: true,
		target: ts.ScriptTarget.ESNext,
	})
	return ts
		.getPreEmitDiagnostics(program)
		.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))
}

// One consumer module importing every installed entry, written where its own
// resolution finds the installed package.
function writeConsumerProbe(stage: Stage, path: string, specifiers: readonly string[]): string {
	const names: string[] = []
	const bindings: string[] = []
	for (const [index, specifier] of specifiers.entries()) {
		const binding = `entry${String(index)}`
		names.push(binding)
		bindings.push(`import * as ${binding} from ${JSON.stringify(specifier)}`)
	}
	const target = join(stage.consumer, path)
	writeFile(target, `${bindings.join('\n')}\nexport const surface = [${names.join(', ')}]\n`)
	return target
}

// The runtime key set a real process reads off one installed entry under one
// condition. The driver is a file rather than an `--eval` string, so the specifier
// travels as an argument and nothing needs escaping.
function driveRuntime(stage: Stage, specifier: string, driver: string): readonly string[] {
	const result = runNode([join(stage.consumer, driver), specifier], stage.consumer)
	if (result.status !== 0) {
		throw new Error(`Loading ${specifier} from the consumer failed: ${readOutput(result)}`)
	}
	const published: unknown = JSON.parse(result.stdout)
	if (!isNames(published)) throw new Error(`The driver printed no name list for ${specifier}`)
	return published
}

// Pack this workspace, install the archive into an isolated consumer, and read the
// published surface back off the installed tree. Every later claim reads this
// result, so a failure here is raised where it happens rather than once per entry.
function buildStage(): Stage {
	const packed = join(SCRATCH, 'packed')
	const consumer = join(SCRATCH, 'consumer')
	mkdirSync(packed, { recursive: true })
	const pack = runNpm(['pack', '--ignore-scripts', '--pack-destination', packed], ROOT)
	if (pack.status !== 0) throw new Error(`npm pack refused this workspace: ${readOutput(pack)}`)
	const archives = readdirSync(packed).filter((name) => name.endsWith('.tgz'))
	const archive = archives[0]
	if (archives.length !== 1 || archive === undefined) {
		throw new Error(`npm pack wrote no single archive: ${archives.join(', ')}`)
	}
	writeFile(join(consumer, 'package.json'), CONSUMER_MANIFEST)
	writeFile(join(consumer, ESM_DRIVER), ESM_DRIVER_SOURCE)
	writeFile(join(consumer, CJS_DRIVER), CJS_DRIVER_SOURCE)
	const install = runNpm(
		['install', '--ignore-scripts', '--no-audit', '--no-fund', join(packed, archive)],
		consumer,
	)
	if (install.status !== 0) {
		throw new Error(`Installing the packed archive failed: ${readOutput(install)}`)
	}
	const name = readManifestName(join(ROOT, 'package.json'))
	const installed = join(consumer, 'node_modules', ...name.split('/'))
	const manifest = readJson(join(installed, 'package.json'))
	if (!isRecord(manifest) || !isRecord(manifest.exports)) {
		throw new Error('The installed manifest publishes no exports map')
	}
	const entries: Entry[] = []
	const targets: string[] = []
	for (const [subpath, entry] of Object.entries(manifest.exports)) {
		targets.push(...collectTargets(entry))
		const declaration = resolveTarget(entry, ['types', 'import'])
		if (declaration === undefined || !declaration.endsWith('.d.ts')) continue
		const module = resolveTarget(entry, ['import'])
		entries.push({
			subpath,
			specifier: subpath === '.' ? name : `${name}${subpath.slice(1)}`,
			declaration: join(installed, declaration),
			browser: module !== undefined && module.startsWith(BROWSER_OUTPUT),
			commonjs: resolveTarget(entry, ['require']) !== undefined,
		})
	}
	return { consumer, installed, archives, entries, targets }
}

const SCRATCH = mkdtempSync(join(tmpdir(), 'distribution-'))
const CACHE = join(SCRATCH, 'cache')
mkdirSync(CACHE, { recursive: true })
// The scratch tree holds the npm cache, the packed archive, and the installed
// consumer, so its removal is registered before the first thing that can throw.
afterAll(() => {
	rmSync(SCRATCH, { force: true, recursive: true })
})

// Installing the packed archive resolves its own runtime dependencies, so an
// unreachable registry leaves nothing to measure. Under release that is the gate
// failing; anywhere else the suite skips and names the mechanism it wanted.
//
// A module that throws while loading never reaches the `afterAll` it registered,
// so every throw here removes the scratch tree on its way out.
function openStage(): Stage | undefined {
	try {
		if (runNpm(PING, ROOT).status !== 0) {
			if (!RELEASE) return undefined
			throw new Error(
				'The release gate requires a reachable npm registry, and npm ping did not answer',
			)
		}
		return buildStage()
	} catch (error) {
		rmSync(SCRATCH, { force: true, recursive: true })
		throw error
	}
}

const STAGE = openStage()
const STAGED = STAGE !== undefined

// The staged consumer, or a skip naming what the run could not reach. `it.skipIf`
// carries no reason, so the gate sits here where the test context can state one.
function requireStage(context: TestContext): Stage {
	if (!STAGED) {
		return context.skip('`npm ping` did not answer, so nothing was packed or installed')
	}
	return STAGE
}

describe('installed package consumer', () => {
	it('packs one archive and installs it in isolation [requires the registry]', (context) => {
		const stage = requireStage(context)
		expect(stage.archives).toHaveLength(1)
		expect(existsSync(join(stage.installed, 'package.json'))).toBe(true)
		expect(stage.entries.length).toBeGreaterThan(0)
	})

	it('ships every relative target its exports map names [requires the registry]', (context) => {
		const stage = requireStage(context)
		const relative = stage.targets.filter((target) => target.startsWith('./'))
		expect(relative).not.toStrictEqual([])
		expect(relative.filter((target) => !existsSync(join(stage.installed, target)))).toStrictEqual(
			[],
		)
	})

	it('refuses a subpath its exports map does not name [requires the registry]', (context) => {
		const stage = requireStage(context)
		const name = readManifestName(join(stage.installed, 'package.json'))
		const driver = join(stage.consumer, ESM_DRIVER)
		const result = runNode([driver, `${name}${ABSENT_SUBPATH}`], stage.consumer)
		expect(result.status).not.toBe(0)
		expect(readOutput(result)).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED')
	})

	// The absent subpath is the firing control: a resolution that reports nothing
	// for every published entry has not been shown to resolve anything at all.
	it('compiles a consumer under every module resolution [requires the registry]', (context) => {
		const stage = requireStage(context)
		const name = readManifestName(join(stage.installed, 'package.json'))
		const published = stage.entries.map((entry) => entry.specifier)
		const reported: string[] = []
		const silent: string[] = []
		for (const [label, resolution, module] of RESOLUTIONS) {
			const probe = writeConsumerProbe(stage, `probe.${label}.ts`, published)
			for (const message of compileConsumer(probe, resolution, module)) {
				reported.push(`${label}: ${message}`)
			}
			const control = writeConsumerProbe(stage, `control.${label}.ts`, [`${name}${ABSENT_SUBPATH}`])
			if (compileConsumer(control, resolution, module).length === 0) silent.push(label)
		}
		expect(reported).toStrictEqual([])
		expect(silent).toStrictEqual([])
	})
})

for (const entry of STAGE?.entries ?? []) {
	describe(`installed entry ${entry.subpath}`, () => {
		it.runIf(!entry.browser)(
			'publishes what it declares to a Node import, and no more',
			(context) => {
				const published = driveRuntime(requireStage(context), entry.specifier, ESM_DRIVER)
				expect(published).toStrictEqual(readDeclaredExports(entry.declaration))
			},
		)

		it.runIf(!entry.browser && entry.commonjs)(
			'publishes what it declares to a Node require, and no more',
			(context) => {
				const published = driveRuntime(requireStage(context), entry.specifier, CJS_DRIVER)
				expect(published).toStrictEqual(readDeclaredExports(entry.declaration))
			},
		)
	})
}
