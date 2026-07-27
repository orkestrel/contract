import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord } from '@src/core'
import { describe, expect, it } from 'vitest'
import * as policy from './setupPolicy.js'

describe('coding policy', () => {
	it('normalizes platform separators', () => {
		expect(policy.normalizePolicyPath('src\\core\\\\types.ts')).toBe('src/core/types.ts')
	})

	it('accepts the production workspace', () => {
		expect(policy.inspectCodingWorkspace(process.cwd())).toEqual([])
	})

	it('reports one-based line and character positions', () => {
		expect(
			policy.inspectCodingLaw(
				'src/core/helpers.ts',
				'export function parseValue(value: unknown): string {\n\treturn value as string\n}',
			),
		).toEqual(expect.arrayContaining(['src/core/helpers.ts:2:9 forbids type/non-null assertions']))
	})

	it('accepts anonymous functions returned directly by factories and combinators', () => {
		expect(
			policy.inspectCodingLaw(
				'src/core/helpers.ts',
				'export function createValue() { return () => 1 }',
			),
		).toEqual([])
		expect(
			policy.inspectCodingLaw(
				'src/core/combinators.ts',
				'export const createValue = () => () => 1',
			),
		).toEqual([])
		expect(
			policy.inspectCodingLaw(
				'src/core/helpers.ts',
				'export function createValue() { return (() => 1) }',
			),
		).toEqual([])
	})

	it('rejects a named local closure assignment', () => {
		expect(
			policy.inspectCodingLaw(
				'src/core/helpers.ts',
				'export function createValue() { const compute = () => 1\nreturn compute }',
			),
		).toEqual(
			expect.arrayContaining([expect.stringContaining('forbids hidden function assignments')]),
		)
	})

	it('ships sensitive-read permission families', () => {
		const settings: unknown = JSON.parse(
			readFileSync(join(process.cwd(), '.claude', 'settings.json'), 'utf8'),
		)
		if (!isRecord(settings)) throw new Error('Claude settings must be a record')
		const permissions = settings.permissions
		if (!isRecord(permissions)) throw new Error('Claude permissions must be a record')

		expect(permissions.allow).toBeUndefined()
		expect(permissions.ask).toEqual(['Bash'])
		expect(permissions.deny).toEqual(
			expect.arrayContaining([
				'Read(.env*)',
				'Read(**/.env*)',
				'Read(//**/.env)',
				'Read(//**/.env.*)',
				'Read(credentials.json)',
				'Read(**/credentials.json)',
				'Read(//**/credentials.json)',
				'Read(settings.local.json)',
				'Read(**/settings.local.json)',
				'Read(//**/settings.local.json)',
				'Read(application_default_credentials.json)',
				'Read(**/application_default_credentials.json)',
				'Read(//**/application_default_credentials.json)',
				'Read(.kube/**)',
				'Read(**/.kube/**)',
				'Read(//**/.kube/**)',
			]),
		)
	})

	it.each([
		[
			'an assertion',
			'src/core/helpers.ts',
			'export function parseValue(value: unknown): string { return value as string }',
			'forbids type/non-null assertions',
		],
		[
			'module data outside a kind file',
			'src/core/helpers.ts',
			'export const VALUE = 1',
			'places module data in its centralized kind file',
		],
		[
			'a function in constants',
			'src/core/constants.ts',
			'export function createValue(): number { return 1 }',
			'places module functions in their centralized kind file',
		],
		[
			'a named barrel re-export',
			'src/core/index.ts',
			"export { parseValue } from './helpers.js'",
			'barrels contain only export * declarations',
		],
		[
			'a mutable interface property',
			'src/core/types.ts',
			'export interface Value { name: string }',
			'requires readonly contract properties',
		],
		[
			'a computed import',
			'src/core/helpers.ts',
			'export function load(path: string) { return import(`./${path}.js`) }',
			'requires dynamic imports to use string literals',
		],
		[
			'an HTTPS module import',
			'src/core/helpers.ts',
			"import 'https://example.com/module.js'",
			'forbids non-Node URL module specifiers',
		],
		[
			'a Node types reference in core',
			'src/core/types.ts',
			'/// <reference types="node" />\nexport type Value = string',
			'forbids triple-slash references outside app/browser/env.d.ts',
		],
	])('rejects %s', (_label, path, content, message) => {
		expect(policy.inspectCodingLaw(path, content)).toEqual(
			expect.arrayContaining([expect.stringContaining(message)]),
		)
	})

	it('checks Vue script blocks while accepting an inert template', () => {
		expect(
			policy.inspectVueCodingLaw('app/browser/Referenced.vue', [
				{
					content: '/// <reference types="node" />\nexport const value = 1',
					lang: 'ts',
				},
			]),
		).toEqual(
			expect.arrayContaining([
				expect.stringContaining('forbids triple-slash references outside app/browser/env.d.ts'),
			]),
		)
		expect(policy.inspectVueCodingLaw('app/browser/Inert.vue')).toEqual([])
	})
})
