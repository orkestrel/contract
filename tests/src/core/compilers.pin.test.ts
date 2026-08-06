import type { Block, Node, SourceFile } from 'typescript'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { assert, describe, it } from 'vitest'
import { PROTECTED_COMPILER_BODIES } from './constants.js'

function findFunctionBody(source: SourceFile, name: string): Block | undefined {
	for (const statement of source.statements) {
		if (!ts.isFunctionDeclaration(statement)) continue
		if (statement.name?.text !== name || statement.body === undefined) continue
		return statement.body
	}
	return undefined
}

function serializeNode(node: Node, output: string[]): void {
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

function hashBody(body: Block): string {
	const output: string[] = []
	serializeNode(body, output)
	return createHash('sha256').update(output.join('')).digest('hex').slice(0, 16)
}

function changeMessage(name: string): string {
	return `${name}: the protected compiler body is missing or its executable AST changed. An executable change to a protected body requires updating its pin deliberately, in the same commit. A comment-only change cannot cause this failure.`
}

describe('protected compiler bodies', () => {
	it('pins their comment-stripped executable ASTs', () => {
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
})
