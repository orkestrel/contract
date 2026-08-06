import type { Block, Node, SourceFile } from 'typescript'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { assert, describe, it } from 'vitest'
import { PROTECTED_COMPILER_BODIES, PROTECTED_COMPILER_CLOSURE } from './constants.js'

interface FunctionSource {
	readonly body: Block
	readonly exported: boolean
	readonly file: string
}

function findFunctionBody(source: SourceFile, name: string): Block | undefined {
	for (const statement of source.statements) {
		if (!ts.isFunctionDeclaration(statement)) continue
		if (statement.name?.text !== name || statement.body === undefined) continue
		return statement.body
	}
	return undefined
}

function serializeNode(node: Node, output: string[]): void {
	if (ts.isTypeNode(node)) return
	output.push(`(${ts.SyntaxKind[node.kind]}`)
	if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) {
		output.push(`:${node.text}`)
	} else if (ts.isLiteralExpression(node) || ts.isTemplateLiteralToken(node)) {
		output.push(`:${JSON.stringify(node.text)}`)
	}
	ts.forEachChild(node, (child): undefined => {
		serializeNode(child, output)
		return undefined
	})
	output.push(')')
}

function collectCalls(node: Node, names: Set<string>): void {
	if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
		names.add(node.expression.text)
	}
	ts.forEachChild(node, (child): undefined => {
		collectCalls(child, names)
		return undefined
	})
}

function readFunctions(directory: string): ReadonlyMap<string, FunctionSource> {
	const functions = new Map<string, FunctionSource>()
	for (const file of readdirSync(directory)
		.filter((entry) => entry.endsWith('.ts'))
		.sort()) {
		const path = `${directory}/${file}`
		const text = readFileSync(path, 'utf8')
		const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
		for (const statement of source.statements) {
			if (!ts.isFunctionDeclaration(statement) || statement.body === undefined) continue
			const name = statement.name?.text
			if (name === undefined) continue
			if (functions.has(name)) throw new Error(`duplicate protected function name: ${name}`)
			const exported =
				ts
					.getModifiers(statement)
					?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
			functions.set(name, { body: statement.body, exported, file })
		}
	}
	return functions
}

function collectClosure(functions: ReadonlyMap<string, FunctionSource>): readonly string[] {
	const pending = [...functions].flatMap(([name, source]) =>
		source.exported && (name.startsWith('compile') || name === 'createContract') ? [name] : [],
	)
	const protectedNames = new Set<string>()
	while (pending.length > 0) {
		const name = pending.pop()
		if (name === undefined || protectedNames.has(name)) continue
		const source = functions.get(name)
		if (source === undefined) continue
		protectedNames.add(name)
		const calls = new Set<string>()
		collectCalls(source.body, calls)
		for (const call of calls) {
			if (functions.has(call) && !protectedNames.has(call)) pending.push(call)
		}
	}
	return [...protectedNames].sort()
}

function hashClosure(
	functions: ReadonlyMap<string, FunctionSource>,
	names: readonly string[],
): string {
	const output: string[] = []
	for (const name of names) {
		const source = functions.get(name)
		if (source === undefined) throw new Error(`protected function is missing: ${name}`)
		output.push(`${source.file}:${name}:${hashBody(source.body)}`)
	}
	return createHash('sha256').update(output.join('\n')).digest('hex').slice(0, 16)
}

function hashBody(body: Block): string {
	const output: string[] = []
	serializeNode(body, output)
	return createHash('sha256').update(output.join('')).digest('hex').slice(0, 16)
}

function parseBody(text: string): Block {
	const source = ts.createSourceFile('sample.ts', text, ts.ScriptTarget.Latest, true)
	const [statement] = source.statements
	if (
		statement === undefined ||
		!ts.isFunctionDeclaration(statement) ||
		statement.body === undefined
	) {
		throw new Error('sample function body is missing')
	}
	return statement.body
}

function changeMessage(name: string): string {
	return `${name}: the protected compiler body is missing or its executable AST changed. An executable change to a protected body requires updating its pin deliberately, in the same commit. A comment-, TSDoc-, or type-only change cannot cause this failure.`
}

describe('protected compiler bodies', () => {
	it('pins their comment-, TSDoc-, and type-stripped executable ASTs', () => {
		const path = fileURLToPath(new URL('../../../src/core/compilers.ts', import.meta.url))
		const text = readFileSync(path, 'utf8')
		const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)

		for (const protection of PROTECTED_COMPILER_BODIES) {
			const body = findFunctionBody(source, protection.name)
			const message = changeMessage(protection.name)
			assert(body !== undefined, message)
			assert.strictEqual(hashBody(body), protection.hash, message)
		}
	})

	it('pins every compiled-artifact entry and its transitive project-owned delegates', () => {
		const directory = fileURLToPath(new URL('../../../src/core', import.meta.url))
		const functions = readFunctions(directory)
		const names = collectClosure(functions)
		assert.deepStrictEqual(names, PROTECTED_COMPILER_CLOSURE.names)
		assert.strictEqual(hashClosure(functions, names), PROTECTED_COMPILER_CLOSURE.hash)
	})

	it('ignores type-annotation-only edits while retaining executable edits', () => {
		const original = hashBody(
			parseBody('function sample(): number { const value: number = 1; return value }'),
		)
		const typed = hashBody(
			parseBody('function sample(): bigint { const value: bigint = 1; return value }'),
		)
		const executable = hashBody(
			parseBody('function sample(): number { const value: number = 2; return value }'),
		)

		assert.strictEqual(typed, original)
		assert.notStrictEqual(executable, original)
	})
})
