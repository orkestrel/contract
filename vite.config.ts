import type {
	CSSOptions,
	HtmlAssetSource,
	HTMLOptions,
	Plugin,
	ResolvedConfig,
	UserConfig,
} from 'vite'
import { isCSSRequest, parseAst, preprocessCSS, transformWithOxc, Visitor } from 'vite'
import { defineConfig, mergeConfig } from 'vitest/config'
import tsconfig from './tsconfig.json' with { type: 'json' }
import { fileURLToPath, URL } from 'node:url'
import { isBuiltin } from 'node:module'
import {
	closeSync,
	constants as FS_CONSTANTS,
	existsSync,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'

export function resolveWorkspacePath(relativePath: string): string {
	return fileURLToPath(new URL(relativePath, import.meta.url))
}

export function hasAsciiUrlControl(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)
		if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true
	}
	return false
}

const resolve = {
	alias: Object.entries(tsconfig.compilerOptions.paths).reduce((a, [k, v]) => {
		const [path] = v
		if (path === undefined) throw new Error(`tsconfig path alias ${k} has no target`)
		return Object.assign(a, { [k]: resolveWorkspacePath(path) })
	}, {}),
}

export const ENVIRONMENT_CSS = Object.freeze({
	transformer: 'lightningcss',
	lightningcss: {
		visitor: () => {
			let sources: readonly string[] = []
			let source: string | undefined
			return {
				StyleSheet(stylesheet) {
					sources = stylesheet.sources
				},
				Rule(rule) {
					source =
						'value' in rule && rule.value !== null && 'loc' in rule.value
							? sources[rule.value.loc.source_index]
							: undefined
					if (rule.type !== 'import') return
					const error = stylesheetAssetError(source, rule.value.url)
					if (error !== undefined) {
						throw new Error(`[orkestrel-environment-boundary] ${error}`)
					}
				},
				Url(asset) {
					const error = stylesheetAssetError(source, asset.url)
					if (error !== undefined) {
						throw new Error(`[orkestrel-environment-boundary] ${error}`)
					}
				},
			}
		},
	},
} satisfies CSSOptions)
export const PACKAGE_MANIFEST_BYTES = 1_048_576
export const ENVIRONMENT_MODULE_BYTES = 8_388_608

const WORKSPACE_ROOT = realpathSync.native(dirname(fileURLToPath(import.meta.url)))
export const IMPORT_META_ENV_PREFIX = 'import.meta.env.'

export function physicalPath(path: string): string {
	const [pathWithoutQuery] = path.split('?')
	const candidate = pathWithoutQuery?.startsWith('/@fs/')
		? pathWithoutQuery.slice('/@fs/'.length)
		: pathWithoutQuery
	const physicalCandidate =
		candidate !== undefined && /^file:/i.test(candidate) ? fileURLToPath(candidate) : candidate
	const absoluteCandidate =
		physicalCandidate === undefined || physicalCandidate.length === 0
			? WORKSPACE_ROOT
			: isAbsolute(physicalCandidate)
				? physicalCandidate
				: resolvePath(WORKSPACE_ROOT, physicalCandidate)
	return existsSync(absoluteCandidate) ? realpathSync.native(absoluteCandidate) : absoluteCandidate
}

export function sourceFallback(importer: string, source: string): string {
	return /^file:/i.test(source) ? fileURLToPath(source) : resolvePath(dirname(importer), source)
}

export function workspacePath(path: string): string | undefined {
	const relativePath = relative(WORKSPACE_ROOT, physicalPath(path)).replaceAll('\\', '/')
	if (relativePath === '..' || relativePath.startsWith('../') || isAbsolute(relativePath)) {
		return undefined
	}
	return relativePath
}

export function isOutsideWorkspacePath(path: string): boolean {
	const [pathWithoutQuery] = path.split('?')
	if (pathWithoutQuery === undefined) return false
	const candidate = pathWithoutQuery.startsWith('/@fs/')
		? pathWithoutQuery.slice('/@fs/'.length)
		: pathWithoutQuery
	return isAbsolute(candidate)
}

export function containedPath(root: string, target: string): boolean {
	const relativePath = relative(root, target)
	return (
		relativePath === '' ||
		(relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	)
}

export function packageNameOf(source: string): string | undefined {
	const [sourcePath] = source.replaceAll('\\', '/').split(/[?#]/)
	if (
		sourcePath === undefined ||
		sourcePath.length === 0 ||
		sourcePath.startsWith('.') ||
		sourcePath.startsWith('/') ||
		sourcePath.startsWith('#') ||
		sourcePath.startsWith('file:') ||
		/^[A-Za-z]:\//.test(sourcePath) ||
		isBuiltin(sourcePath)
	) {
		return undefined
	}
	const segments = sourcePath.split('/')
	if (sourcePath.startsWith('@')) {
		const [scope, name] = segments
		return scope === undefined || name === undefined ? undefined : `${scope}/${name}`
	}
	return segments[0]
}

export function readBoundedFile(path: string, limit: number): string | undefined {
	if (!existsSync(path)) return undefined
	try {
		const status = lstatSync(path)
		if (!status.isFile() || status.isSymbolicLink() || status.nlink !== 1 || status.size > limit) {
			return undefined
		}
		const handle = openSync(path, FS_CONSTANTS.O_RDONLY | FS_CONSTANTS.O_NOFOLLOW)
		try {
			const current = fstatSync(handle)
			if (
				!current.isFile() ||
				current.nlink !== 1 ||
				current.dev !== status.dev ||
				current.ino !== status.ino ||
				current.size !== status.size ||
				current.mtimeMs !== status.mtimeMs ||
				current.ctimeMs !== status.ctimeMs
			) {
				return undefined
			}
			const bytes = Buffer.allocUnsafe(current.size + 1)
			let offset = 0
			for (;;) {
				const count = readSync(handle, bytes, offset, bytes.length - offset, null)
				if (count === 0) break
				offset += count
				if (offset > current.size) return undefined
			}
			const final = fstatSync(handle)
			if (
				!final.isFile() ||
				final.nlink !== 1 ||
				final.dev !== current.dev ||
				final.ino !== current.ino ||
				final.size !== current.size ||
				final.size !== offset ||
				final.mtimeMs !== current.mtimeMs ||
				final.ctimeMs !== current.ctimeMs
			) {
				return undefined
			}
			return bytes.toString('utf8', 0, offset)
		} finally {
			closeSync(handle)
		}
	} catch {
		return undefined
	}
}

export function packageManifestName(directory: string): string | undefined {
	const content = readBoundedFile(resolvePath(directory, 'package.json'), PACKAGE_MANIFEST_BYTES)
	if (content === undefined) return undefined
	try {
		const manifest: unknown = JSON.parse(content)
		if (typeof manifest !== 'object' || manifest === null) return undefined
		const manifestName = Object.getOwnPropertyDescriptor(manifest, 'name')?.value
		return typeof manifestName === 'string' && packageNameOf(manifestName) === manifestName
			? manifestName
			: undefined
	} catch {
		return undefined
	}
}

export function isPackageBoundary(directory: string): boolean {
	const segments = directory.replaceAll('\\', '/').split('/')
	let nodeModules = -1
	for (const [index, segment] of segments.entries()) {
		if (segment.toLowerCase() === 'node_modules') nodeModules = index
	}
	if (nodeModules < 0) return false
	const packageSegments = segments.slice(nodeModules + 1)
	return (
		(packageSegments.length === 1 && packageSegments[0]?.startsWith('@') === false) ||
		(packageSegments.length === 2 &&
			packageSegments[0]?.startsWith('@') === true &&
			packageSegments[1]?.length !== 0)
	)
}

export function packageRootOf(packageName: string, resolvedPath: string): string | undefined {
	const physical = physicalPath(resolvedPath)
	let current =
		existsSync(physical) && lstatSync(physical).isDirectory() ? physical : dirname(physical)
	for (;;) {
		const boundary = isPackageBoundary(current)
		const manifest = resolvePath(current, 'package.json')
		if (boundary || existsSync(manifest)) {
			return packageManifestName(current) === packageName ? realpathSync.native(current) : undefined
		}
		const parent = dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}

export function packageRootForResolved(resolvedPath: string): string | undefined {
	const physical = physicalPath(resolvedPath)
	let current =
		existsSync(physical) && lstatSync(physical).isDirectory() ? physical : dirname(physical)
	for (;;) {
		const boundary = isPackageBoundary(current)
		const manifest = resolvePath(current, 'package.json')
		if (boundary || existsSync(manifest)) {
			return packageManifestName(current) === undefined ? undefined : realpathSync.native(current)
		}
		const parent = dirname(current)
		if (parent === current) return undefined
		current = parent
	}
}

export function trustedPackageRootFor(
	target: string,
	trustedPackageRoots: ReadonlySet<string>,
): string | undefined {
	const physical = physicalPath(target)
	for (const root of trustedPackageRoots) {
		if (containedPath(root, physical)) return root
	}
	return undefined
}

export function isStylesheetPath(path: string): boolean {
	return /\.(?:css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:[?#]|$)/.test(path)
}

export function environmentPathError(owner: string, target: string): string | undefined {
	const targetApplication = target.startsWith('app/')
	const targetBrowser = target.startsWith('app/browser/') || target.startsWith('src/browser/')
	const targetServer = target.startsWith('app/server/') || target.startsWith('src/server/')
	const stylesheet = isStylesheetPath(target)
	if (owner.startsWith('src/') && targetApplication) {
		return 'Published modules cannot depend on private application modules'
	}
	if (owner.endsWith('/core') && (stylesheet || targetBrowser || targetServer)) {
		return 'Core modules must remain host-independent'
	}
	if (owner.endsWith('/browser') && targetServer) {
		return 'Browser modules cannot depend on Node or server-only modules'
	}
	if (owner.endsWith('/server') && (stylesheet || targetBrowser)) {
		return 'Server modules cannot depend on Vue or browser-only modules'
	}
	return undefined
}

export function environmentSourceError(owner: string, source: string): string | undefined {
	const normalizedSource = source.replaceAll('\\', '/')
	if (hasAsciiUrlControl(normalizedSource)) {
		return 'Environment module URLs cannot contain ASCII controls'
	}
	const [sourcePath] = normalizedSource.split(/[?#]/)
	const builtin = sourcePath !== undefined && isBuiltin(sourcePath)
	const unsupportedScheme =
		sourcePath !== undefined &&
		/^[A-Za-z][A-Za-z0-9+.-]*:/.test(sourcePath) &&
		!builtin &&
		!/^file:/i.test(sourcePath) &&
		!/^[A-Za-z]:\//.test(sourcePath)
	const browserPackage =
		/^(?:(?:vue|vite)(?:[/?#]|$)|@(?:vue|vitejs)\/|@(?:app|src)\/browser(?:[/?#]|$)|@orkestrel\/[^/]+\/browser(?:[/?#]|$))/.test(
			normalizedSource,
		)
	const serverPackage =
		/^(?:@(?:app|src)\/server(?:[/?#]|$)|@orkestrel\/[^/]+\/server(?:[/?#]|$))/.test(
			normalizedSource,
		)
	const stylesheet = isStylesheetPath(normalizedSource)
	if (unsupportedScheme) return 'Environment modules cannot import non-Node URL schemes'
	if (owner.startsWith('src/') && /^@app(?:[/?#]|$)/.test(normalizedSource)) {
		return 'Published modules cannot depend on private application modules'
	}
	if (owner.endsWith('/core') && (builtin || browserPackage || serverPackage || stylesheet)) {
		return 'Core modules must remain host-independent'
	}
	if (owner.endsWith('/browser') && (builtin || serverPackage)) {
		return 'Browser modules cannot depend on Node or server-only modules'
	}
	if (owner.endsWith('/server') && (browserPackage || stylesheet)) {
		return 'Server modules cannot depend on Vue or browser-only modules'
	}
	return undefined
}

export function stylesheetAssetError(
	source: string | undefined,
	value: string,
): string | undefined {
	if (source === undefined) return 'Stylesheet asset source could not be resolved'
	const decoded = decodeAssetSource(value)
	if (decoded === undefined) return 'Stylesheet asset URLs must use valid URI encoding'
	if (decoded.includes('\\')) return 'Stylesheet asset URLs must use forward slashes'
	const [assetPath] = decoded.split(/[?#]/)
	if (
		assetPath === undefined ||
		assetPath.length === 0 ||
		decoded.startsWith('#') ||
		decoded.startsWith('//') ||
		(assetPath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(assetPath))
	) {
		return undefined
	}
	const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.test(assetPath)
	const fileScheme = /^file:/i.test(assetPath)
	if (scheme && !fileScheme && !/^[A-Za-z]:[\\/]/.test(assetPath)) {
		return undefined
	}
	let physicalAsset: string
	try {
		physicalAsset = physicalPath(
			fileScheme ? fileURLToPath(assetPath) : resolvePath(dirname(physicalPath(source)), assetPath),
		)
	} catch {
		return 'Stylesheet asset URLs must use valid local paths'
	}
	const sourceTarget = workspacePath(source)
	const assetTarget = workspacePath(physicalAsset)
	if (sourceTarget !== undefined) {
		if (assetTarget === undefined) {
			return 'Environment modules cannot import files outside the workspace'
		}
		const [layer, environment] = sourceTarget.split('/')
		return environmentPathError(`${layer}/${environment}`, assetTarget)
	}
	const packageRoot = packageRootForResolved(source)
	if (packageRoot === undefined || !containedPath(packageRoot, physicalAsset)) {
		return 'Dependency modules cannot import files outside their physical package root'
	}
	return undefined
}

export function enforceOutputPath(configured: string, expected: string): void {
	if (relative(expected, configured) !== '') {
		throw new Error(
			'[orkestrel-output-boundary] Build output must use its exact configured workspace directory',
		)
	}
	const workspaceRelative = relative(WORKSPACE_ROOT, expected)
	if (
		workspaceRelative === '..' ||
		workspaceRelative.startsWith(`..${sep}`) ||
		isAbsolute(workspaceRelative)
	) {
		throw new Error('[orkestrel-output-boundary] Build output must remain inside the workspace')
	}
	let current = WORKSPACE_ROOT
	for (const segment of workspaceRelative.split(sep)) {
		if (segment.length === 0) continue
		current = resolvePath(current, segment)
		if (!existsSync(current)) continue
		const status = lstatSync(current)
		if (status.isSymbolicLink() || !status.isDirectory()) {
			throw new Error(
				'[orkestrel-output-boundary] Build output and its existing parents must be real directories',
			)
		}
		if (workspacePath(realpathSync.native(current)) === undefined) {
			throw new Error('[orkestrel-output-boundary] Build output must remain inside the workspace')
		}
	}
}

export function outputBoundary(output: string): Plugin {
	const expected = resolvePath(WORKSPACE_ROOT, output)
	let configured = expected
	let build = false
	return {
		name: 'orkestrel-output-boundary',
		enforce: 'pre',
		configResolved(config) {
			if (config.publicDir !== '') {
				throw new Error(
					'[orkestrel-output-boundary] Public directories are disabled; every output must come from the audited graph',
				)
			}
			if (output.endsWith('/browser') && config.build.assetsInlineLimit !== 0) {
				throw new Error(
					'[orkestrel-output-boundary] Browser assets must remain external for output auditing',
				)
			}
			const outputOptions = config.build.rolldownOptions.output
			const outputs = Array.isArray(outputOptions) ? outputOptions : [outputOptions]
			for (const options of outputs) {
				if (options?.dir !== undefined || options?.file !== undefined) {
					throw new Error(
						'[orkestrel-output-boundary] Rolldown output directories and files cannot override the configured output',
					)
				}
			}
			build = config.command === 'build'
			configured = resolvePath(config.root, config.build.outDir)
		},
		buildStart() {
			if (build) enforceOutputPath(configured, expected)
		},
	}
}

export function decodeAssetSource(source: string): string | undefined {
	try {
		return decodeURI(source)
	} catch {
		return undefined
	}
}

export function filterHtmlAssetSource(
	data: Parameters<NonNullable<HtmlAssetSource['filter']>>[0],
): boolean {
	const decoded = decodeAssetSource(data.value)
	if (decoded === undefined) {
		throw new Error('[orkestrel-environment-boundary] HTML asset URLs must use valid URI encoding')
	}
	if (decoded.includes('\\')) {
		throw new Error('[orkestrel-environment-boundary] HTML asset URLs must use forward slashes')
	}
	if (/[?&]inline\b/.test(decoded)) {
		throw new Error(
			'[orkestrel-environment-boundary] HTML asset URLs cannot force inlining outside the auditable output graph',
		)
	}
	return false
}

export function filterHtmlScriptSource(
	data: Parameters<NonNullable<HtmlAssetSource['filter']>>[0],
): boolean {
	filterHtmlAssetSource(data)
	if (data.attributes.type !== 'module') {
		throw new Error(
			'[orkestrel-environment-boundary] Classic external scripts are not permitted; use a module script',
		)
	}
	const decoded = decodeAssetSource(data.value)
	const source = decoded?.trim()
	if (source !== undefined && hasAsciiUrlControl(source)) {
		throw new Error(
			'[orkestrel-environment-boundary] Environment module URLs cannot contain ASCII controls',
		)
	}
	if (
		source === undefined ||
		source.length === 0 ||
		source !== decoded ||
		/&#(?:[0-9]+|[xX][0-9A-Fa-f]+);?/u.test(source) ||
		/&[A-Za-z][A-Za-z0-9]+;/u.test(source) ||
		source.includes('\t') ||
		source.includes('\n') ||
		source.includes('\r') ||
		source.startsWith('#') ||
		source.startsWith('//') ||
		/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(source)
	) {
		throw new Error(
			'[orkestrel-environment-boundary] Module script URLs must remain in the local Vite graph',
		)
	}
	return false
}

export function filterHtmlMetaSource(
	data: Parameters<NonNullable<HtmlAssetSource['filter']>>[0],
): boolean {
	const name = data.attributes.name?.trim().toLowerCase()
	const property = data.attributes.property?.trim().toLowerCase()
	const asset =
		name === 'msapplication-tileimage' ||
		name === 'msapplication-square70x70logo' ||
		name === 'msapplication-square150x150logo' ||
		name === 'msapplication-wide310x150logo' ||
		name === 'msapplication-square310x310logo' ||
		name === 'msapplication-config' ||
		name === 'twitter:image' ||
		property === 'og:image' ||
		property === 'og:image:url' ||
		property === 'og:image:secure_url' ||
		property === 'og:audio' ||
		property === 'og:audio:secure_url' ||
		property === 'og:video' ||
		property === 'og:video:secure_url'
	return asset ? filterHtmlAssetSource(data) : false
}

export function environmentHtml(): HTMLOptions {
	return {
		additionalAssetSources: {
			audio: { srcAttributes: ['src'], filter: filterHtmlAssetSource },
			embed: { srcAttributes: ['src'], filter: filterHtmlAssetSource },
			image: { srcAttributes: ['href', 'xlink:href'], filter: filterHtmlAssetSource },
			img: {
				srcAttributes: ['src'],
				srcsetAttributes: ['srcset'],
				filter: filterHtmlAssetSource,
			},
			input: { srcAttributes: ['src'], filter: filterHtmlAssetSource },
			link: {
				srcAttributes: ['href'],
				srcsetAttributes: ['imagesrcset'],
				filter: filterHtmlAssetSource,
			},
			meta: { srcAttributes: ['content'], filter: filterHtmlMetaSource },
			object: { srcAttributes: ['data'], filter: filterHtmlAssetSource },
			script: {
				srcAttributes: ['href', 'src', 'xlink:href'],
				filter: filterHtmlScriptSource,
			},
			source: {
				srcAttributes: ['src'],
				srcsetAttributes: ['srcset'],
				filter: filterHtmlAssetSource,
			},
			track: { srcAttributes: ['src'], filter: filterHtmlAssetSource },
			use: { srcAttributes: ['href', 'xlink:href'], filter: filterHtmlAssetSource },
			video: { srcAttributes: ['src', 'poster'], filter: filterHtmlAssetSource },
		},
	}
}

export const HTML_SECURITY_POLICY =
	"base-uri 'none'; object-src 'none'; script-src 'self'; script-src-attr 'none'"
export const HTML_SECURITY_META =
	'<meta\n\t\t\thttp-equiv="Content-Security-Policy"\n\t\t\tcontent="' +
	HTML_SECURITY_POLICY +
	'"\n\t\t/>'
export const HTML_SECURITY_PREFIX =
	'<!doctype html>\n<html lang="en">\n\t<head>\n\t\t' + HTML_SECURITY_META + '\n'

export function maskIgnoredHtml(environmentKeys: ReadonlySet<string>, html: string): string {
	if (!html.replaceAll('\r\n', '\n').startsWith(HTML_SECURITY_PREFIX)) {
		throw new Error(
			'[orkestrel-environment-boundary] Browser HTML must preserve the generated security prologue',
		)
	}
	for (const match of html.matchAll(/%(\S+?)%/gu)) {
		const key = match[1]
		if (key !== undefined && environmentKeys.has(key)) {
			throw new Error(
				'[orkestrel-environment-boundary] HTML environment substitution is not permitted; import environment values from a module',
			)
		}
	}
	const escaped = html.replace(
		/(?<prefix>[vV][iI][tT][eE])&#(?<zeros>0*)45;(?<suffix>[iI][gG][nN][oO][rR][eE])/gu,
		'$<prefix>&#0$<zeros>45;$<suffix>',
	)
	return escaped.replace(
		/(?<prefix>[vV][iI][tT][eE])-(?<suffix>[iI][gG][nN][oO][rR][eE])/gu,
		'$<prefix>&#45;$<suffix>',
	)
}

export function restoreIgnoredHtml(code: string): string {
	const literals = code.replace(
		/(?<prefix>[vV][iI][tT][eE])&#45;(?<suffix>[iI][gG][nN][oO][rR][eE])/gu,
		'$<prefix>-$<suffix>',
	)
	return literals.replace(
		/(?<prefix>[vV][iI][tT][eE])&#0(?<zeros>0*)45;(?<suffix>[iI][gG][nN][oO][rR][eE])/gu,
		'$<prefix>&#$<zeros>45;$<suffix>',
	)
}

export function prepareHtml(): Plugin {
	const environmentKeys = new Set<string>()
	return {
		name: 'orkestrel-html-boundary-prepare',
		enforce: 'post',
		configResolved(config) {
			for (const key of Object.keys(config.env)) environmentKeys.add(key)
			for (const key of Object.keys(config.define ?? {})) {
				if (key.startsWith(IMPORT_META_ENV_PREFIX)) {
					environmentKeys.add(key.slice(IMPORT_META_ENV_PREFIX.length))
				}
			}
		},
		transformIndexHtml: {
			order: 'pre',
			handler: maskIgnoredHtml.bind(undefined, environmentKeys),
		},
	}
}

export function restoreHtml(): Plugin {
	return {
		name: 'orkestrel-html-boundary-restore',
		enforce: 'pre',
		transformIndexHtml: restoreIgnoredHtml,
	}
}

export function finalizeHtml(): Plugin {
	return {
		name: 'orkestrel-html-boundary-finalize',
		enforce: 'post',
		transformIndexHtml: {
			order: 'post',
			handler(html) {
				if (!html.includes(HTML_SECURITY_META)) {
					throw new Error(
						'[orkestrel-environment-boundary] Browser HTML must retain its security policy',
					)
				}
			},
		},
	}
}

export async function environmentAssetSources(
	code: string,
	id: string,
	emitted = false,
): Promise<readonly string[]> {
	const [path] = id.split('?')
	if (
		path === undefined ||
		(!/\.[cm]?[jt]sx?$/.test(path) && !/[?&]html-proxy(?:[=&]|$)/.test(id))
	) {
		return []
	}
	const sources: string[] = []
	const transformed = await transformWithOxc(code, path)
	const visitor = new Visitor({
		ImportExpression(node) {
			let value: string | undefined
			if (node.source.type === 'Literal' && typeof node.source.value === 'string') {
				value = node.source.value
			} else if (node.source.type === 'TemplateLiteral' && node.source.expressions.length === 0) {
				value = node.source.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw).join('')
			} else {
				throw new Error(
					'[orkestrel-environment-boundary] Dynamic imports must use static string values',
				)
			}
			const decoded = decodeAssetSource(value)
			if (decoded === undefined) {
				throw new Error('[orkestrel-environment-boundary] Module URLs must use valid URI encoding')
			}
			sources.push(decoded)
		},
		NewExpression(node) {
			if (emitted) return
			const [source, base] = node.arguments
			if (
				node.callee.type !== 'Identifier' ||
				node.callee.name !== 'URL' ||
				base?.type !== 'MemberExpression' ||
				base.object.type !== 'MetaProperty' ||
				base.object.meta.name !== 'import' ||
				base.object.property.name !== 'meta' ||
				base.property.type !== 'Identifier' ||
				base.property.name !== 'url'
			) {
				return
			}
			let value: string | undefined
			if (source?.type === 'Literal' && typeof source.value === 'string') {
				const decoded = decodeAssetSource(source.value)
				if (decoded === undefined) {
					throw new Error('[orkestrel-environment-boundary] Asset URLs must use valid URI encoding')
				}
				value = decoded
			} else if (source?.type === 'TemplateLiteral') {
				const decodedQuasis: string[] = []
				for (const quasi of source.quasis) {
					const decoded = decodeAssetSource(quasi.value.cooked ?? quasi.value.raw)
					if (decoded === undefined) {
						throw new Error(
							'[orkestrel-environment-boundary] Asset URLs must use valid URI encoding',
						)
					}
					decodedQuasis.push(decoded)
				}
				if (source.expressions.length > 0) {
					throw new Error(
						'[orkestrel-environment-boundary] Asset URLs must use static string values',
					)
				}
				value = decodedQuasis.join('__orkestrel__')
			} else {
				throw new Error('[orkestrel-environment-boundary] Asset URLs must use static string values')
			}
			if (value === undefined) return
			if (
				value.startsWith('.') ||
				value.startsWith('/') ||
				/^file:/i.test(value) ||
				/^[A-Za-z]:[\\/]/.test(value)
			) {
				sources.push(value)
			}
		},
	})
	visitor.visit(parseAst(transformed.code, null, path))
	return sources
}

export function environmentBoundary(
	owner: 'src/core' | 'src/browser' | 'src/server' | 'app/core' | 'app/browser' | 'app/server',
): Plugin {
	const trustedPackageRoots = new Set<string>()
	let environmentRoot = WORKSPACE_ROOT
	let resolvedConfig: ResolvedConfig | undefined
	return {
		name: 'orkestrel-environment-boundary',
		enforce: 'pre',
		configResolved(config) {
			environmentRoot = physicalPath(config.root)
			resolvedConfig = config
		},
		async resolveId(source, importer) {
			if (importer === undefined) return null
			if (source.startsWith('\0')) return null
			const normalizedSource = source.replaceAll('\\', '/')
			const sourceError = environmentSourceError(owner, normalizedSource)
			if (sourceError !== undefined) this.error(sourceError)
			const importerPath = workspacePath(importer)
			const physicalImporter = physicalPath(importer)
			const importerPackageRoot = trustedPackageRootFor(physicalImporter, trustedPackageRoots)
			if (importerPath === undefined && importerPackageRoot === undefined) return null
			const [layer, environment] = importerPath?.split('/') ?? []
			if (
				importerPackageRoot === undefined &&
				((layer !== 'app' && layer !== 'src') ||
					(environment !== 'core' && environment !== 'browser' && environment !== 'server'))
			) {
				return null
			}
			const pathLike =
				normalizedSource.startsWith('.') ||
				normalizedSource.startsWith('/') ||
				/^file:/i.test(normalizedSource) ||
				/^[A-Za-z]:[\\/]/.test(normalizedSource)
			const fallbackSource =
				normalizedSource.startsWith('.') ||
				normalizedSource.startsWith('/') ||
				/^file:/i.test(normalizedSource)
					? sourceFallback(physicalImporter, normalizedSource)
					: ''
			const resolution = await this.resolve(source, importer, { skipSelf: true })
			const [resolvedId] = resolution?.id.split('?') ?? []
			const physicalResolution = resolvedId === undefined ? undefined : physicalPath(resolvedId)
			if (
				importerPackageRoot !== undefined &&
				(pathLike || normalizedSource.startsWith('#')) &&
				physicalResolution !== undefined &&
				!containedPath(importerPackageRoot, physicalResolution)
			) {
				if (normalizedSource.startsWith('#')) {
					const mappedPackageRoot =
						workspacePath(physicalResolution) === undefined
							? packageRootForResolved(physicalResolution)
							: undefined
					if (mappedPackageRoot === undefined) {
						this.error(
							'Dependency package imports must resolve inside an exact physical package root',
						)
					}
					trustedPackageRoots.add(mappedPackageRoot)
				} else {
					this.error('Dependency modules cannot import files outside their physical package root')
				}
			}
			if (
				!pathLike &&
				!normalizedSource.startsWith('#') &&
				physicalResolution !== undefined &&
				workspacePath(physicalResolution) === undefined
			) {
				const packageName = packageNameOf(normalizedSource)
				const packageRoot =
					packageName === undefined ? undefined : packageRootOf(packageName, physicalResolution)
				if (packageRoot === undefined || !containedPath(packageRoot, physicalResolution)) {
					this.error('Resolved dependencies must remain inside their physical package root')
				}
				trustedPackageRoots.add(packageRoot)
			}
			const resolvedSource = workspacePath(resolution?.id ?? fallbackSource)
			if (pathLike && resolvedSource === undefined && importerPackageRoot === undefined) {
				this.error('Environment modules cannot import files outside the workspace')
			}
			const pathError =
				resolvedSource === undefined
					? undefined
					: environmentPathError(`${layer}/${environment}`, resolvedSource)
			if (pathError !== undefined) this.error(pathError)
			return null
		},
		async load(id) {
			const physicalImporter = physicalPath(id)
			const trustedPackageRoot = trustedPackageRootFor(physicalImporter, trustedPackageRoots)
			const inferredPackageRoot =
				trustedPackageRoot === undefined ? packageRootForResolved(physicalImporter) : undefined
			const packageRoot =
				trustedPackageRoot ??
				(inferredPackageRoot !== undefined && isPackageBoundary(inferredPackageRoot)
					? inferredPackageRoot
					: undefined)
			if (packageRoot === undefined || !/\.[cm]?[jt]sx?$/.test(physicalImporter)) {
				return null
			}
			const code = readBoundedFile(physicalImporter, ENVIRONMENT_MODULE_BYTES)
			if (code === undefined) {
				this.error('Dependency module source must be a bounded regular file')
			}
			for (const source of await environmentAssetSources(code, id)) {
				const normalizedSource = source.replaceAll('\\', '/')
				const sourceError = environmentSourceError(owner, normalizedSource)
				if (sourceError !== undefined) this.error(sourceError)
				const sourcePathError = environmentPathError(owner, normalizedSource)
				if (sourcePathError !== undefined) this.error(sourcePathError)
				const pathLike =
					normalizedSource.startsWith('.') ||
					normalizedSource.startsWith('/') ||
					/^file:/i.test(normalizedSource) ||
					/^[A-Za-z]:[\\/]/.test(normalizedSource)
				if (
					pathLike &&
					!containedPath(
						packageRoot,
						physicalPath(sourceFallback(physicalImporter, normalizedSource)),
					)
				) {
					this.error('Dependency modules cannot import files outside their physical package root')
				}
			}
			return null
		},
		async generateBundle(_options, bundle) {
			for (const output of Object.values(bundle)) {
				if (output.type === 'chunk') {
					for (const source of await environmentAssetSources(
						output.code,
						output.fileName.endsWith('.js') ? output.fileName : `${output.fileName}.js`,
						true,
					)) {
						const normalizedSource = source.replaceAll('\\', '/')
						const sourceError = environmentSourceError(owner, normalizedSource)
						if (sourceError !== undefined) this.error(sourceError)
					}
					continue
				}
				for (const original of output.originalFileNames) {
					const physical = physicalPath(
						isAbsolute(original) ? original : resolvePath(environmentRoot, original),
					)
					const target = workspacePath(physical)
					if (target === undefined) {
						if (trustedPackageRootFor(physical, trustedPackageRoots) === undefined) {
							this.error('Environment modules cannot import files outside the workspace')
						}
						continue
					}
					const pathError = environmentPathError(owner, target)
					if (pathError !== undefined) this.error(pathError)
				}
			}
		},
		buildEnd(error) {
			if (error !== undefined) return
			for (const id of this.getModuleIds()) {
				const target = workspacePath(id)
				if (target === undefined) {
					if (
						isOutsideWorkspacePath(id) &&
						trustedPackageRootFor(physicalPath(id), trustedPackageRoots) === undefined
					) {
						this.error('Environment modules cannot import files outside the workspace')
					}
					continue
				}
				const pathError = environmentPathError(owner, target)
				if (pathError !== undefined) this.error(pathError)
			}
		},
		transform: {
			order: 'pre',
			async handler(code, id) {
				const restored = /[?&]html-proxy(?:[=&]|$)/.test(id) ? restoreIgnoredHtml(code) : code
				const target = workspacePath(id)
				const physicalImporter = physicalPath(id)
				const importerPackageRoot = trustedPackageRootFor(physicalImporter, trustedPackageRoots)
				if (target === undefined) {
					if (isOutsideWorkspacePath(id) && importerPackageRoot === undefined) {
						this.error('Environment modules cannot import files outside the workspace')
					}
				} else {
					const pathError = environmentPathError(owner, target)
					if (pathError !== undefined) this.error(pathError)
				}
				const environmentModule =
					target !== undefined && /^(?:app|src)\/(?:core|browser|server)\//.test(target)
				if (!environmentModule && importerPackageRoot === undefined) {
					return restored === code ? null : restored
				}
				if (isCSSRequest(id)) {
					const config = resolvedConfig
					if (config === undefined) {
						this.error('Environment boundary requires resolved Vite configuration')
					}
					const stylesheet = await preprocessCSS(restored, id, config)
					for (const dependency of stylesheet.deps ?? []) {
						const physicalDependency = physicalPath(dependency)
						const dependencyTarget = workspacePath(physicalDependency)
						if (dependencyTarget === undefined) {
							if (trustedPackageRootFor(physicalDependency, trustedPackageRoots) === undefined) {
								this.error('Environment modules cannot import files outside the workspace')
							}
							continue
						}
						const dependencyError = environmentPathError(owner, dependencyTarget)
						if (dependencyError !== undefined) this.error(dependencyError)
					}
				}
				for (const source of await environmentAssetSources(restored, id)) {
					const normalizedSource = source.replaceAll('\\', '/')
					const sourceError = environmentSourceError(owner, normalizedSource)
					if (sourceError !== undefined) this.error(sourceError)
					const [sourcePath] = normalizedSource.split(/[?#]/)
					if (sourcePath !== undefined && isBuiltin(sourcePath)) continue
					const resolution = await this.resolve(normalizedSource, id, { skipSelf: true })
					const fallbackSource = sourceFallback(physicalImporter, normalizedSource)
					const physicalSource = physicalPath(resolution?.id ?? fallbackSource)
					if (importerPackageRoot !== undefined) {
						const pathLike =
							normalizedSource.startsWith('.') ||
							normalizedSource.startsWith('/') ||
							/^file:/i.test(normalizedSource) ||
							/^[A-Za-z]:[\\/]/.test(normalizedSource)
						if (pathLike && !containedPath(importerPackageRoot, physicalSource)) {
							this.error(
								'Dependency modules cannot import files outside their physical package root',
							)
						}
						if (!pathLike && !containedPath(importerPackageRoot, physicalSource)) {
							const packageName = packageNameOf(normalizedSource)
							const packageRoot = normalizedSource.startsWith('#')
								? workspacePath(physicalSource) === undefined
									? packageRootForResolved(physicalSource)
									: undefined
								: packageName === undefined
									? undefined
									: packageRootOf(packageName, physicalSource)
							if (packageRoot === undefined || !containedPath(packageRoot, physicalSource)) {
								this.error('Resolved dependencies must remain inside their physical package root')
							}
							trustedPackageRoots.add(packageRoot)
						}
						continue
					}
					const resolvedSource = workspacePath(physicalSource)
					if (resolvedSource === undefined) {
						this.error('Environment modules cannot import files outside the workspace')
					}
					const assetError = environmentPathError(owner, resolvedSource)
					if (assetError !== undefined) this.error(assetError)
				}
				return restored === code ? null : restored
			},
		},
	}
}

export const srcCore = (config?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			publicDir: false,
			build: {
				emptyOutDir: true,
				sourcemap: true,
				minify: false,
			},
			test: {
				name: { label: 'src:core', color: 'magenta' },
				include: ['tests/src/core/**/*.test.ts'],
				setupFiles: ['./tests/setup.ts'],
				environment: 'node',
				browser: { enabled: false },
			},
		},
		config ?? {},
	)

export const policy = (config?: UserConfig): UserConfig =>
	mergeConfig(
		{
			resolve,
			test: {
				name: { label: 'policy', color: 'white' },
				include: ['tests/policy.test.ts'],
				setupFiles: ['./tests/setup.ts'],
				environment: 'node',
				browser: { enabled: false },
			},
		},
		config ?? {},
	)

export const guides = (config?: UserConfig): UserConfig =>
	srcCore(
		mergeConfig(
			{
				test: {
					name: { label: 'guides', color: 'green' },
					include: ['tests/guides/**/*.test.ts'],
					exclude: ['tests/src/**/*.test.ts', 'tests/setup.test.ts'],
				},
			},
			config ?? {},
		),
	)

export default defineConfig({
	resolve,
	test: {
		projects: [srcCore, policy, guides],
	},
})
