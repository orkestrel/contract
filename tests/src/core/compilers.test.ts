import type { ContractShape, JSONSchema, RawShape } from '@src/core'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
	arrayShape,
	attempt,
	booleanShape,
	cloneShape,
	COMPILE_DEPTH_LIMIT,
	compileAuditor,
	compileGenerator,
	compileGuard,
	compileParser,
	compileReporter,
	compileSchema,
	ContractError,
	createContract,
	integerShape,
	isContractError,
	isRecord,
	jsonShape,
	literalShape,
	nullableShape,
	nullShape,
	numberShape,
	objectShape,
	oneOfShape,
	optionalShape,
	ownShape,
	rawShape,
	recordShape,
	seededRandom,
	stringShape,
	unionShape,
	validateShape,
	validateShapeDepth,
} from '@src/core'
import {
	buildDeepShape,
	buildWideVocabulary,
	captureContractError,
	createNonEnumerableRecord,
	createRevokedProxy,
	SHAPE_SEPARATIONS,
	SOUNDNESS_SAMPLE,
} from '../../setup.js'
import { describe, expect, it } from 'vitest'

const compilerSource = readFileSync(
	fileURLToPath(new URL('../../../src/core/compilers.ts', import.meta.url)),
	'utf8',
)

type ShapeByType<T extends ContractShape['type']> = Extract<ContractShape, { readonly type: T }>

type CompleteShape<T extends ContractShape['type']> = {
	readonly [K in keyof ShapeByType<T>]-?: ShapeByType<T>[K]
}

const COMPLETE_RAW_SCHEMA: JSONSchema = {
	type: 'object',
	description: 'complete',
	enum: ['x', 1, true],
	minLength: 0,
	maxLength: 1,
	pattern: '^x$',
	format: 'custom',
	minimum: 0,
	maximum: 1,
	minItems: 0,
	maxItems: 1,
	items: { type: 'string' },
	properties: { value: { type: 'string' } },
	required: ['value'],
	additionalProperties: { type: 'string' },
	anyOf: [{ type: 'string' }],
	oneOf: [{ type: 'number' }],
}

const COMPLETE_SHAPES = {
	string: {
		type: 'string',
		min: 0,
		max: 1,
		pattern: /^x$/,
		description: 'complete',
	},
	number: { type: 'number', min: 0, max: 1, integer: true, description: 'complete' },
	boolean: { type: 'boolean', description: 'complete' },
	null: { type: 'null', description: 'complete' },
	literal: { type: 'literal', values: ['x', 1, true], description: 'complete' },
	array: {
		type: 'array',
		items: { type: 'string' },
		min: 0,
		max: 1,
		description: 'complete',
	},
	object: {
		type: 'object',
		properties: { value: { type: 'string' } },
		additionalProperties: { type: 'string' },
		description: 'complete',
	},
	union: {
		type: 'union',
		variants: [{ type: 'string' }, { type: 'number' }],
		mode: 'anyOf',
		description: 'complete',
	},
	optional: { type: 'optional', inner: { type: 'string' } },
	nullable: { type: 'nullable', inner: { type: 'string' } },
	json: { type: 'json', description: 'complete' },
	raw: { type: 'raw', schema: COMPLETE_RAW_SCHEMA },
} satisfies { readonly [T in ContractShape['type']]: CompleteShape<T> }

describe('validateShape', () => {
	it('generates every gate-rule and interface-field probe across all eleven entries', () => {
		const gateStart = compilerSource.indexOf('export function validateShapeDepth')
		const gateEnd = compilerSource.indexOf(
			'/**\n * Validate that a {@link ContractShape}',
			gateStart,
		)
		expect(gateStart).toBeGreaterThanOrEqual(0)
		expect(gateEnd).toBeGreaterThan(gateStart)
		const gate = compilerSource.slice(gateStart, gateEnd)
		const rules = new Set<string>()
		const assignments = gate.matchAll(
			/(?:nodeMessage|structureMessage|domainMessage)\s*=\s*'(validateShapeDepth: [^']+)'/g,
		)
		for (const match of assignments) {
			const message = match[1]
			if (message !== undefined) rules.add(message)
		}
		const direct = gate.matchAll(/throw new ContractError\(\s*'(validateShapeDepth: [^']+)'/g)
		for (const match of direct) {
			const message = match[1]
			if (message !== undefined) rules.add(message)
		}

		const malformed: readonly unknown[] = [
			undefined,
			null,
			false,
			true,
			-1,
			1.5,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			'x',
			'[',
			new String('x'),
			[],
			{},
			new Date(),
			new Map(),
			new Uint8Array([1]),
			createRevokedProxy(),
		]
		const candidates: ContractShape[] = []
		const fieldProbes: { readonly name: string; readonly shape: ContractShape }[] = []

		for (const source of Object.values(COMPLETE_SHAPES)) {
			const category = source.type
			for (const field of Object.keys(source)) {
				let root: ContractShape = structuredClone(source)
				let node = root
				if (category === 'optional') {
					root = { type: 'object', properties: { value: root } }
					if (root.type === 'object') {
						const child = root.properties.value
						if (child !== undefined) node = child
					}
				}
				Object.defineProperty(node, field, {
					enumerable: true,
					configurable: true,
					get() {
						return null
					},
				})
				fieldProbes.push({ name: `${category}.${field}`, shape: root })

				for (const value of malformed) {
					let candidate: ContractShape = structuredClone(source)
					let target = candidate
					if (category === 'optional') {
						candidate = { type: 'object', properties: { value: candidate } }
						if (candidate.type === 'object') {
							const child = candidate.properties.value
							if (child !== undefined) target = child
						}
					}
					Reflect.set(target, field, value)
					candidates.push(candidate)
				}
			}
		}

		for (const field of Object.keys(COMPLETE_RAW_SCHEMA)) {
			for (const value of malformed) {
				const candidate: ContractShape = structuredClone(COMPLETE_SHAPES.raw)
				if (candidate.type === 'raw') Reflect.set(candidate.schema, field, value)
				candidates.push(candidate)
			}
		}

		const sparseLiteral = structuredClone(COMPLETE_SHAPES.literal)
		if (sparseLiteral.type === 'literal') Reflect.deleteProperty(sparseLiteral.values, '1')
		candidates.push(sparseLiteral)
		const accessedLiteral = structuredClone(COMPLETE_SHAPES.literal)
		if (accessedLiteral.type === 'literal') {
			Object.defineProperty(accessedLiteral.values, '1', { enumerable: true, get: () => 1 })
		}
		candidates.push(accessedLiteral)
		const duplicateLiteral = structuredClone(COMPLETE_SHAPES.literal)
		if (duplicateLiteral.type === 'literal') Reflect.set(duplicateLiteral.values, '1', 'x')
		candidates.push(duplicateLiteral)
		candidates.push({ type: 'literal', values: [Number.NaN] })
		const nonPrimitiveLiteral = structuredClone(COMPLETE_SHAPES.literal)
		if (nonPrimitiveLiteral.type === 'literal') Reflect.set(nonPrimitiveLiteral.values, '0', null)
		candidates.push(nonPrimitiveLiteral)
		const unstableValues = new Proxy(['x'], {
			get(target, field, receiver) {
				if (field !== '0') return Reflect.get(target, field, receiver)
				return Reflect.get(target, field, receiver) === 'x' ? 'drift' : 'x'
			},
		})
		candidates.push({ type: 'literal', values: unstableValues })
		const unstablePattern = /x/
		let patternReads = 0
		Object.defineProperty(unstablePattern, 'source', {
			get() {
				patternReads += 1
				return patternReads % 2 === 1 ? 'x' : 'drift'
			},
		})
		candidates.push({ type: 'string', pattern: unstablePattern })

		for (const field of ['enum', 'required', 'anyOf', 'oneOf']) {
			const empty: ContractShape = structuredClone(COMPLETE_SHAPES.raw)
			if (empty.type === 'raw') Reflect.set(empty.schema, field, [])
			candidates.push(empty)
			const sparse: ContractShape = structuredClone(COMPLETE_SHAPES.raw)
			if (sparse.type === 'raw') {
				const values =
					field === 'required' ? ['value', 'extra'] : field === 'enum' ? ['x', 'extra'] : [{}, {}]
				Reflect.deleteProperty(values, '1')
				Reflect.set(sparse.schema, field, values)
			}
			candidates.push(sparse)
		}
		const duplicateEnum: ContractShape = structuredClone(COMPLETE_SHAPES.raw)
		if (duplicateEnum.type === 'raw') Reflect.set(duplicateEnum.schema, 'enum', ['x', 'x'])
		candidates.push(duplicateEnum)
		const duplicateRequired: ContractShape = structuredClone(COMPLETE_SHAPES.raw)
		if (duplicateRequired.type === 'raw') {
			Reflect.set(duplicateRequired.schema, 'required', ['value', 'value'])
		}
		candidates.push(duplicateRequired)
		const unsupported: ContractShape = structuredClone(COMPLETE_SHAPES.raw)
		if (unsupported.type === 'raw') Reflect.set(unsupported.schema, 'const', 'x')
		candidates.push(unsupported)

		for (const field of ['properties', 'items', 'additionalProperties']) {
			for (const value of [new Date(), new Map(), new Set(), /x/]) {
				const candidate: ContractShape = structuredClone(COMPLETE_SHAPES.raw)
				if (candidate.type === 'raw') Reflect.set(candidate.schema, field, value)
				candidates.push(candidate)
			}
		}

		const shapeCycle = structuredClone(COMPLETE_SHAPES.array)
		Reflect.set(shapeCycle, 'items', shapeCycle)
		candidates.push(shapeCycle)
		let deepShape: ContractShape = { type: 'string' }
		for (let depth = 0; depth <= COMPILE_DEPTH_LIMIT; depth += 1) {
			deepShape = { type: 'array', items: deepShape }
		}
		candidates.push(deepShape)
		const rawCycle: ContractShape = structuredClone(COMPLETE_SHAPES.raw)
		if (rawCycle.type === 'raw') Reflect.set(rawCycle.schema, 'items', rawCycle.schema)
		candidates.push(rawCycle)
		let deepSchema: JSONSchema = { type: 'string' }
		for (let depth = 0; depth <= COMPILE_DEPTH_LIMIT; depth += 1) {
			deepSchema = { items: deepSchema }
		}
		candidates.push({ type: 'raw', schema: deepSchema })

		for (const shape of [
			{ type: 'string', min: 2, max: 1 },
			{ type: 'number', min: 2, max: 1 },
			{ type: 'number', integer: true, min: 1.2, max: 1.8 },
			{ type: 'array', items: { type: 'string' }, min: 2, max: 1 },
		] satisfies readonly ContractShape[]) {
			candidates.push(shape)
		}
		const optional = { type: 'optional', inner: { type: 'string' } } satisfies ContractShape
		for (const parent of [
			optional,
			{ type: 'array', items: optional },
			{ type: 'object', properties: {}, additionalProperties: optional },
			{ type: 'union', variants: [optional] },
			{ type: 'nullable', inner: optional },
		] satisfies readonly ContractShape[]) {
			candidates.push(parent)
		}

		const probes = new Map<string, ContractShape>()
		for (const candidate of candidates) {
			const outcome = attempt(() => validateShapeDepth(candidate))
			if (outcome.success) continue
			expect(isContractError(outcome.error)).toBe(true)
			if (!isContractError(outcome.error)) continue
			if (!probes.has(outcome.error.message)) probes.set(outcome.error.message, candidate)
		}
		expect(fieldProbes).toHaveLength(38)
		expect(rules.size).toBe(57)
		expect([...probes.keys()].sort()).toEqual([...rules].sort())

		const missing = new Set(probes.keys())
		const first = missing.values().next().value
		if (first !== undefined) missing.delete(first)
		expect([...missing].sort()).not.toEqual([...rules].sort())

		for (const entry of [
			...fieldProbes,
			...[...probes].map(([name, shape]) => ({ name, shape })),
		]) {
			const outcomes = [
				{ name: 'ownShape', outcome: attempt(() => ownShape(entry.shape)) },
				{ name: 'cloneShape', outcome: attempt(() => cloneShape(entry.shape)) },
				{ name: 'validateShape', outcome: attempt(() => validateShape(entry.shape)) },
				{
					name: 'validateShapeDepth',
					outcome: attempt(() => validateShapeDepth(entry.shape)),
				},
				{ name: 'compileSchema', outcome: attempt(() => compileSchema(entry.shape)) },
				{ name: 'compileGuard', outcome: attempt(() => compileGuard(entry.shape)) },
				{ name: 'compileParser', outcome: attempt(() => compileParser(entry.shape)) },
				{
					name: 'compileGenerator',
					outcome: attempt(() => compileGenerator(entry.shape, () => 0)),
				},
				{
					name: 'compileReporter',
					outcome: attempt(() => compileReporter(entry.shape, undefined)),
				},
				{
					name: 'compileAuditor',
					outcome: attempt(() => compileAuditor(entry.shape, undefined)),
				},
				{ name: 'createContract', outcome: attempt(() => createContract(entry.shape)) },
			]
			for (const result of outcomes) {
				expect(result.outcome.success, `${entry.name} at ${result.name}`).toBe(false)
				if (result.outcome.success) continue
				expect(isContractError(result.outcome.error), `${entry.name} at ${result.name}`).toBe(true)
			}
		}
	})

	it('reports an unrecognized shape identically at the root and every structural slot', () => {
		const unknown: ContractShape = structuredClone(COMPLETE_SHAPES.string)
		Reflect.set(unknown, 'type', 'nope')
		const shapes = [
			unknown,
			{ type: 'array', items: unknown },
			{ type: 'object', properties: { value: unknown } },
			{ type: 'object', properties: {}, additionalProperties: unknown },
			{ type: 'union', variants: [unknown] },
			{ type: 'optional', inner: unknown },
			{ type: 'nullable', inner: unknown },
		] satisfies readonly ContractShape[]
		for (const shape of shapes) {
			const outcomes = [
				attempt(() => ownShape(shape)),
				attempt(() => cloneShape(shape)),
				attempt(() => validateShape(shape)),
				attempt(() => validateShapeDepth(shape)),
				attempt(() => compileSchema(shape)),
				attempt(() => compileGuard(shape)),
				attempt(() => compileParser(shape)),
				attempt(() => compileGenerator(shape, () => 0)),
				attempt(() => compileReporter(shape, undefined)),
				attempt(() => compileAuditor(shape, undefined)),
				attempt(() => createContract(shape)),
			]
			expect(outcomes).toHaveLength(11)
			for (const outcome of outcomes) {
				expect(outcome.success).toBe(false)
				if (outcome.success) continue
				expect(isContractError(outcome.error)).toBe(true)
				if (!isContractError(outcome.error)) continue
				expect(outcome.error.code).toBe('structure')
				expect(outcome.error.message).toBe(
					'validateShapeDepth: every node must be a recognized shape',
				)
			}
		}
	})

	it('rejects the six measured laundering inputs while accepting their controls', () => {
		const literalString = structuredClone(COMPLETE_SHAPES.literal)
		Reflect.set(literalString, 'values', 'abc')
		const literalObject = structuredClone(COMPLETE_SHAPES.literal)
		Reflect.set(literalObject, 'values', new String('ab'))
		const literalTyped = structuredClone(COMPLETE_SHAPES.literal)
		Reflect.set(literalTyped, 'values', new Uint8Array([1, 2]))
		const rawProperties = structuredClone(COMPLETE_SHAPES.raw)
		Reflect.set(rawProperties.schema, 'properties', new Date())
		const rawItems = structuredClone(COMPLETE_SHAPES.raw)
		Reflect.set(rawItems.schema, 'items', new Date())
		const rawAdditional = structuredClone(COMPLETE_SHAPES.raw)
		Reflect.set(rawAdditional.schema, 'additionalProperties', new Map())
		const cases: readonly { readonly malformed: ContractShape; readonly control: ContractShape }[] =
			[
				{
					malformed: literalString,
					control: { type: 'literal', values: ['a', 'b', 'c'] },
				},
				{
					malformed: literalObject,
					control: { type: 'literal', values: ['a', 'b'] },
				},
				{
					malformed: literalTyped,
					control: { type: 'literal', values: [1, 2] },
				},
				{
					malformed: rawProperties,
					control: {
						type: 'union',
						variants: [{ type: 'raw', schema: { properties: {} } }, { type: 'string' }],
					},
				},
				{
					malformed: rawItems,
					control: {
						type: 'union',
						variants: [{ type: 'raw', schema: { items: {} } }, { type: 'string' }],
					},
				},
				{
					malformed: rawAdditional,
					control: {
						type: 'union',
						variants: [{ type: 'raw', schema: { additionalProperties: {} } }, { type: 'string' }],
					},
				},
			]
		for (const entry of cases) {
			const malformed = [
				attempt(() => ownShape(entry.malformed)),
				attempt(() => cloneShape(entry.malformed)),
				attempt(() => validateShape(entry.malformed)),
				attempt(() => validateShapeDepth(entry.malformed)),
				attempt(() => compileSchema(entry.malformed)),
				attempt(() => compileGuard(entry.malformed)),
				attempt(() => compileParser(entry.malformed)),
				attempt(() => compileGenerator(entry.malformed, () => 0)),
				attempt(() => compileReporter(entry.malformed, undefined)),
				attempt(() => compileAuditor(entry.malformed, undefined)),
				attempt(() => createContract(entry.malformed)),
			]
			const controls = [
				attempt(() => ownShape(entry.control)),
				attempt(() => cloneShape(entry.control)),
				attempt(() => validateShape(entry.control)),
				attempt(() => validateShapeDepth(entry.control)),
				attempt(() => compileSchema(entry.control)),
				attempt(() => compileGuard(entry.control)),
				attempt(() => compileParser(entry.control)),
				attempt(() => compileGenerator(entry.control, () => 0)),
				attempt(() => compileReporter(entry.control, undefined)),
				attempt(() => compileAuditor(entry.control, undefined)),
				attempt(() => createContract(entry.control)),
			]
			expect(malformed.every((outcome) => !outcome.success)).toBe(true)
			expect(controls.every((outcome) => outcome.success)).toBe(true)
		}
	})

	it('rejects integer-empty ranges and misplaced optionals at all eleven shape entries', () => {
		const malformed: readonly {
			readonly shape: ContractShape
			readonly code: 'range' | 'placement'
		}[] = [
			{
				shape: JSON.parse('{"type":"number","integer":true,"min":1.2,"max":1.8}'),
				code: 'range',
			},
			{
				shape: JSON.parse('{"type":"optional","inner":{"type":"string"}}'),
				code: 'placement',
			},
		]

		for (const entry of malformed) {
			const outcomes = [
				{ name: 'ownShape', outcome: attempt(() => ownShape(entry.shape)) },
				{ name: 'cloneShape', outcome: attempt(() => cloneShape(entry.shape)) },
				{ name: 'validateShape', outcome: attempt(() => validateShape(entry.shape)) },
				{
					name: 'validateShapeDepth',
					outcome: attempt(() => validateShapeDepth(entry.shape)),
				},
				{ name: 'compileSchema', outcome: attempt(() => compileSchema(entry.shape)) },
				{ name: 'compileGuard', outcome: attempt(() => compileGuard(entry.shape)) },
				{ name: 'compileParser', outcome: attempt(() => compileParser(entry.shape)) },
				{
					name: 'compileGenerator',
					outcome: attempt(() => compileGenerator(entry.shape, () => 0)),
				},
				{
					name: 'compileReporter',
					outcome: attempt(() => compileReporter(entry.shape, undefined)),
				},
				{
					name: 'compileAuditor',
					outcome: attempt(() => compileAuditor(entry.shape, undefined)),
				},
				{ name: 'createContract', outcome: attempt(() => createContract(entry.shape)) },
			]

			expect(outcomes.map((result) => result.name)).toEqual([
				'ownShape',
				'cloneShape',
				'validateShape',
				'validateShapeDepth',
				'compileSchema',
				'compileGuard',
				'compileParser',
				'compileGenerator',
				'compileReporter',
				'compileAuditor',
				'createContract',
			])
			for (const result of outcomes) {
				expect(result.outcome.success, `${result.name} accepted ${entry.code}`).toBe(false)
				if (result.outcome.success) continue
				expect(isContractError(result.outcome.error)).toBe(true)
				if (!isContractError(result.outcome.error)) continue
				expect(result.outcome.error.code).toBe(entry.code)
			}
		}

		const controls: readonly ContractShape[] = [
			integerShape({ min: 1.2, max: 2 }),
			objectShape({ value: optionalShape(stringShape()) }),
		]
		for (const control of controls) {
			const outcomes = [
				attempt(() => ownShape(control)),
				attempt(() => cloneShape(control)),
				attempt(() => validateShape(control)),
				attempt(() => validateShapeDepth(control)),
				attempt(() => compileSchema(control)),
				attempt(() => compileGuard(control)),
				attempt(() => compileParser(control)),
				attempt(() => compileGenerator(control, () => 0)),
				attempt(() => compileReporter(control, undefined)),
				attempt(() => compileAuditor(control, undefined)),
				attempt(() => createContract(control)),
			]
			expect(outcomes).toHaveLength(11)
			expect(outcomes.every((outcome) => outcome.success)).toBe(true)
		}
	})

	it('rejects malformed raw-schema keywords recursively before emission', () => {
		const malformedSchemas: readonly JSONSchema[] = JSON.parse(`[
			{"enum":[]},
			{"pattern":"["},
			{"type":"bogus"},
			{"description":5},
			{"minLength":-1},
			{"maxLength":1.5},
			{"format":5},
			{"minimum":null},
			{"maximum":"x"},
			{"minItems":-1},
			{"maxItems":1.5},
			{"items":[]},
			{"properties":[]},
			{"required":"x"},
			{"required":["x","x"]},
			{"additionalProperties":1},
			{"anyOf":[]},
			{"oneOf":[]}
		]`)

		for (const schema of malformedSchemas) {
			const shape: RawShape = { type: 'raw', schema }
			const compilation = captureContractError(() => compileSchema(shape))
			const construction = captureContractError(() => rawShape(schema))
			expect(compilation.code).toBe('structure')
			expect(construction.code).toBe('structure')
		}

		const nested: JSONSchema = JSON.parse(
			'{"type":"object","properties":{"value":{"items":{"type":"bogus"}}}}',
		)
		expect(captureContractError(() => compileSchema({ type: 'raw', schema: nested })).code).toBe(
			'structure',
		)
		const unsupported: JSONSchema = JSON.parse('{"const":"x"}')
		expect(
			captureContractError(() => compileSchema({ type: 'raw', schema: unsupported })).code,
		).toBe('structure')

		const control: JSONSchema = {
			type: 'object',
			description: 'supported vocabulary',
			properties: {
				value: {
					type: 'array',
					minItems: 0,
					maxItems: 2,
					items: {
						type: 'string',
						minLength: 1,
						maxLength: 3,
						pattern: '^x+$',
						format: 'custom',
					},
				},
			},
			required: ['value'],
			additionalProperties: {
				anyOf: [{ enum: ['x', 1, true] }, { oneOf: [{ type: 'null' }] }],
			},
		}
		expect(() => compileSchema(rawShape(control))).not.toThrow()
	})

	it('rejects every malformed string and array length bound before contract compilation', () => {
		const shapes: readonly ContractShape[] = [
			{ type: 'string', min: Number.NaN },
			{ type: 'string', max: Number.POSITIVE_INFINITY },
			{ type: 'string', min: -1 },
			{ type: 'string', max: 1.5 },
			{ type: 'array', items: stringShape(), min: Number.NaN },
			{
				type: 'array',
				items: stringShape(),
				max: Number.POSITIVE_INFINITY,
			},
			{ type: 'array', items: stringShape(), min: -1 },
			{ type: 'array', items: stringShape(), max: 1.5 },
		]

		for (const shape of shapes) {
			const error = captureContractError(() => createContract(shape))
			expect(error.code).toBe('bound')
			expect(error.context?.limit).toBe('non-negative safe integer')
		}
	})

	it('throws coded ContractError categories for every malformed-shape policy', () => {
		const malformedInteger: ContractShape = JSON.parse(
			'{"type":"number","integer":true,"min":2.5,"max":2.6}',
		)
		const cases: readonly {
			readonly shape: ContractShape
			readonly code: 'range' | 'empty' | 'placement' | 'literal'
		}[] = [
			{ shape: { type: 'string', min: 5, max: 1 }, code: 'range' },
			{ shape: malformedInteger, code: 'range' },
			{ shape: JSON.parse('{"type":"literal","values":[]}'), code: 'empty' },
			{ shape: JSON.parse('{"type":"union","variants":[]}'), code: 'empty' },
			{ shape: optionalShape(stringShape()), code: 'placement' },
			{ shape: { type: 'literal', values: [Number.NaN] }, code: 'literal' },
		]

		for (const entry of cases) {
			expect(() => validateShape(entry.shape)).toThrowError(ContractError)
			const error = captureContractError(() => validateShape(entry.shape))
			expect(isContractError(error)).toBe(true)
			expect(error.code).toBe(entry.code)
		}
	})

	it('raises a cycle ContractError with the item path for a self-referential array shape', () => {
		const raw = JSON.parse('{"type":"array","items":{"type":"string"}}')
		raw.items = raw
		const shape: ContractShape = raw

		expect(() => validateShape(shape)).toThrowError(ContractError)
		const error = captureContractError(() => validateShape(shape))
		expect(error).toBeInstanceOf(ContractError)
		expect(error.code).toBe('cycle')
		expect(error.message).toBe('validateShapeDepth: a shape graph may not contain a cycle')
		expect(error.context?.path).toEqual(['items'])
	})

	it('raises a cycle ContractError with the property path for a self-referential object shape', () => {
		const raw = JSON.parse('{"type":"object","properties":{}}')
		raw.properties.self = raw
		const shape: ContractShape = raw

		expect(() => validateShape(shape)).toThrowError(ContractError)
		const error = captureContractError(() => validateShape(shape))
		expect(error).toBeInstanceOf(ContractError)
		expect(error.code).toBe('cycle')
		expect(error.context?.path).toEqual(['properties', 'self'])
	})

	it('raises a cycle ContractError with the variant path for a self-referential union shape', () => {
		const raw = JSON.parse('{"type":"union","variants":[]}')
		raw.variants.push(raw)
		const shape: ContractShape = raw

		expect(() => validateShape(shape)).toThrowError(ContractError)
		const error = captureContractError(() => validateShape(shape))
		expect(error).toBeInstanceOf(ContractError)
		expect(error.code).toBe('cycle')
		expect(error.context?.path).toEqual(['variants', '0'])
	})

	it('allows a shared child reached through separate non-cyclic paths', () => {
		const child = objectShape({ value: stringShape() })
		expect(() => validateShape(objectShape({ first: child, second: child }))).not.toThrow()
	})

	it('throws on an optional shape used as an array item', () => {
		expect(() => validateShape(arrayShape(optionalShape(stringShape())))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as a union variant', () => {
		expect(() => validateShape(unionShape(optionalShape(stringShape()), integerShape()))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as a nullable inner', () => {
		expect(() => validateShape(nullableShape(optionalShape(stringShape())))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as another optional inner', () => {
		expect(() => validateShape(optionalShape(optionalShape(stringShape())))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an optional shape used as additionalProperties', () => {
		expect(() =>
			validateShape(objectShape({}, { additionalProperties: optionalShape(stringShape()) })),
		).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on a top-level optional shape', () => {
		expect(() => validateShape(optionalShape(stringShape()))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})

	it('throws on an empty union', () => {
		expect(() => validateShape(unionShape())).toThrow(
			'validateShapeDepth: a union shape needs at least one variant',
		)
	})

	it('throws on an empty literal', () => {
		expect(() => validateShape(literalShape([]))).toThrow(
			'validateShapeDepth: a literal shape needs at least one value',
		)
	})

	it('throws on a literal shape containing a non-finite number value', () => {
		expect(() => validateShape(literalShape([Number.NaN]))).toThrow(
			'validateShapeDepth: a literal shape may not contain non-finite number values',
		)
		expect(() => validateShape(literalShape([Number.POSITIVE_INFINITY]))).toThrow(
			'validateShapeDepth: a literal shape may not contain non-finite number values',
		)
		expect(() => validateShape(literalShape([Number.NEGATIVE_INFINITY]))).toThrow(
			'validateShapeDepth: a literal shape may not contain non-finite number values',
		)
		// A finite number literal alongside other values still passes.
		expect(() => validateShape(literalShape([1, 'a', 2.5]))).not.toThrow()
	})

	it('throws on a string shape with min greater than max', () => {
		expect(() => validateShape({ type: 'string', min: 5, max: 1 })).toThrow(
			'validateShapeDepth: a string shape has min greater than max',
		)
	})

	it('throws on a number shape with min greater than max', () => {
		expect(() => validateShape(numberShape({ min: 5, max: 1 }))).toThrow(
			'validateShapeDepth: a number shape has min greater than max',
		)
	})

	it('rejects non-finite hand-authored number and integer bounds with bound errors', () => {
		const shapes: readonly ContractShape[] = [
			{ type: 'number', min: Number.NaN },
			{ type: 'number', integer: true, max: Number.POSITIVE_INFINITY },
		]

		for (const shape of shapes) {
			const error = captureContractError(() => validateShape(shape))
			expect(error.code).toBe('bound')
			expect(error.context?.limit).toBe('finite number')
		}
	})

	it('accepts the compilation depth boundary and rejects the next level without RangeError', () => {
		expect(() => createContract(buildDeepShape(COMPILE_DEPTH_LIMIT))).not.toThrow()

		const error = captureContractError(() =>
			createContract(buildDeepShape(COMPILE_DEPTH_LIMIT + 1)),
		)
		expect(error.code).toBe('depth')
		expect(error).not.toBeInstanceOf(RangeError)
		expect(error.context?.limit).toBe(COMPILE_DEPTH_LIMIT)
	})

	it('reports depth from the structural gate before validateShape reaches its duplicate branch', () => {
		const error = captureContractError(() => validateShape(buildDeepShape(COMPILE_DEPTH_LIMIT + 1)))

		expect(error.code).toBe('depth')
		expect(error.message).toBe('validateShapeDepth: a shape exceeds the compilation depth limit')
	})

	it('rejects excessive depth at every standalone compiler entry before recursion', () => {
		let shape: ContractShape = stringShape()
		for (let level = 0; level < 5_000; level += 1) shape = { type: 'array', items: shape }
		const schemaError = captureContractError(() => compileSchema(shape))
		const guardError = captureContractError(() => compileGuard(shape))
		const parserError = captureContractError(() => compileParser(shape))
		const generatorError = captureContractError(() => compileGenerator(shape, () => 0))
		const reporterError = captureContractError(() => compileReporter(shape, undefined))

		for (const error of [schemaError, guardError, parserError, generatorError, reporterError]) {
			expect(error.code).toBe('depth')
			expect(error).not.toBeInstanceOf(RangeError)
			expect(error.context?.limit).toBe(COMPILE_DEPTH_LIMIT)
		}
	})

	it('throws on an array shape with min greater than max', () => {
		expect(() => validateShape(arrayShape(stringShape(), { min: 5, max: 1 }))).toThrow(
			'validateShapeDepth: an array shape has min greater than max',
		)
	})

	it('throws on an integer shape with an empty integer range', () => {
		expect(() => validateShape(integerShape({ min: 2.5, max: 2.6 }))).toThrow(
			'validateShapeDepth: an integer number shape has an empty integer range',
		)
	})

	it('does not throw on legal placements', () => {
		// optional as a direct object property
		expect(() => validateShape(objectShape({ bio: optionalShape(stringShape()) }))).not.toThrow()
		// bounds where min === max
		expect(() => validateShape(stringShape({ min: 3, max: 3 }))).not.toThrow()
		expect(() => validateShape(numberShape({ min: 3, max: 3 }))).not.toThrow()
		expect(() => validateShape(arrayShape(stringShape(), { min: 2, max: 2 }))).not.toThrow()
		expect(() => validateShape(integerShape({ min: 2, max: 3 }))).not.toThrow()
		// null / json / raw / boolean leaves
		expect(() => validateShape(nullShape())).not.toThrow()
		expect(() => validateShape(jsonShape())).not.toThrow()
		expect(() => validateShape(rawShape({}))).not.toThrow()
		expect(() => validateShape(booleanShape())).not.toThrow()
		// nested legal composites
		expect(() =>
			validateShape(
				objectShape({
					tags: arrayShape(
						objectShape({
							id: stringShape(),
							note: optionalShape(stringShape()),
						}),
					),
					kind: unionShape(nullShape(), jsonShape(), rawShape({})),
					meta: nullableShape(objectShape({ value: optionalShape(integerShape()) })),
					extra: optionalShape(recordShape(jsonShape())),
				}),
			),
		).not.toThrow()
	})
})

describe('malformed shape children', () => {
	it('contains a revoked Proxy root at every compiler and contract entry point', () => {
		const source: { readonly shape: ContractShape } = JSON.parse('{}')
		Object.defineProperty(source, 'shape', { value: createRevokedProxy() })
		const shape = source.shape
		const outcomes = [
			attempt(() => compileSchema(shape)),
			attempt(() => compileGuard(shape)),
			attempt(() => compileParser(shape)),
			attempt(() => compileGenerator(shape, () => 0)),
			attempt(() => compileReporter(shape, undefined)),
			attempt(() => compileAuditor(shape, undefined)),
			attempt(() => createContract(shape)),
		]
		const errors = outcomes.map((outcome) =>
			outcome.success
				? 'returned'
				: isContractError(outcome.error)
					? outcome.error.code
					: outcome.error.name,
		)

		expect(errors).toEqual(['clone', 'clone', 'clone', 'clone', 'clone', 'clone', 'structure'])
	})

	it('contains hostile roots across ownership, validation, compilation, and contracts', () => {
		const revokedSource: { readonly shape: ContractShape } = JSON.parse('{}')
		Object.defineProperty(revokedSource, 'shape', {
			value: createRevokedProxy(),
		})

		const throwing: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(throwing, 'type', {
			enumerable: true,
			get() {
				throw 'caller getter'
			},
		})

		const revokedOutcomes = [
			attempt(() => ownShape(revokedSource.shape)),
			attempt(() => cloneShape(revokedSource.shape)),
			attempt(() => validateShapeDepth(revokedSource.shape)),
			attempt(() => validateShape(revokedSource.shape)),
		]
		const revokedCodes = revokedOutcomes.map((outcome) =>
			outcome.success
				? 'returned'
				: isContractError(outcome.error)
					? outcome.error.code
					: outcome.error.name,
		)

		expect(revokedCodes).toEqual(['clone', 'clone', 'structure', 'structure'])

		const throwingOutcomes = [
			attempt(() => ownShape(throwing)),
			attempt(() => cloneShape(throwing)),
			attempt(() => validateShapeDepth(throwing)),
			attempt(() => validateShape(throwing)),
			attempt(() => compileSchema(throwing)),
			attempt(() => compileGuard(throwing)),
			attempt(() => compileParser(throwing)),
			attempt(() => compileGenerator(throwing, () => 0)),
			attempt(() => compileReporter(throwing, undefined)),
			attempt(() => compileAuditor(throwing, undefined)),
			attempt(() => createContract(throwing)),
		]
		const throwingCodes = throwingOutcomes.map((outcome) =>
			outcome.success
				? 'returned'
				: isContractError(outcome.error)
					? outcome.error.code
					: outcome.error.name,
		)

		expect(throwingCodes).toEqual([
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
			'structure',
		])

		const primitive: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(primitive, Symbol.toPrimitive, {
			value() {
				throw new Error('primitive trap')
			},
		})
		expect(() => String(primitive)).toThrow('primitive trap')
		const outcomes = [
			attempt(() => ownShape(primitive)),
			attempt(() => cloneShape(primitive)),
			attempt(() => validateShapeDepth(primitive)),
			attempt(() => validateShape(primitive)),
			attempt(() => compileSchema(primitive)),
			attempt(() => compileGuard(primitive)),
			attempt(() => compileParser(primitive)),
			attempt(() => compileGenerator(primitive, () => 0)),
			attempt(() => compileReporter(primitive, '')),
			attempt(() => compileAuditor(primitive, '')),
			attempt(() => createContract(primitive)),
		]

		expect(outcomes.every((outcome) => outcome.success)).toBe(true)
	})

	it('rejects non-primitive scalar fields before any standalone compiler uses them', () => {
		const trap = Object.freeze({
			[Symbol.toPrimitive]() {
				throw new Error('symbol trap')
			},
		})
		const fields: readonly {
			readonly shape: ContractShape
			readonly field: string
			readonly path: readonly string[]
		}[] = [
			{
				shape: JSON.parse('{"type":"string"}'),
				field: 'min',
				path: ['min'],
			},
			{
				shape: JSON.parse('{"type":"string"}'),
				field: 'max',
				path: ['max'],
			},
			{
				shape: JSON.parse('{"type":"string"}'),
				field: 'pattern',
				path: ['pattern'],
			},
			{
				shape: JSON.parse('{"type":"number"}'),
				field: 'min',
				path: ['min'],
			},
			{
				shape: JSON.parse('{"type":"number"}'),
				field: 'max',
				path: ['max'],
			},
			{
				shape: JSON.parse('{"type":"number"}'),
				field: 'integer',
				path: ['integer'],
			},
			{
				shape: JSON.parse('{"type":"array","items":{"type":"string"}}'),
				field: 'min',
				path: ['min'],
			},
			{
				shape: JSON.parse('{"type":"array","items":{"type":"string"}}'),
				field: 'max',
				path: ['max'],
			},
			{
				shape: JSON.parse('{"type":"union","variants":[{"type":"string"}]}'),
				field: 'mode',
				path: ['mode'],
			},
			{
				shape: JSON.parse('{"type":"string"}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"number"}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"boolean"}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"null"}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"literal","values":["ok"]}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"array","items":{"type":"string"}}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"object","properties":{}}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"union","variants":[{"type":"string"}]}'),
				field: 'description',
				path: ['description'],
			},
			{
				shape: JSON.parse('{"type":"json"}'),
				field: 'description',
				path: ['description'],
			},
		]

		for (const entry of fields) {
			Object.defineProperty(entry.shape, entry.field, {
				value: trap,
				enumerable: true,
			})
			Object.freeze(entry.shape)
			const errors = [
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => validateShape(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, '')),
				captureContractError(() => compileAuditor(entry.shape, '')),
				captureContractError(() => createContract(entry.shape)),
			]
			for (const error of errors) {
				expect(error.code).toBe('structure')
				expect(error.context?.path).toEqual(entry.path)
			}
		}

		const literal: ContractShape = JSON.parse('{"type":"literal","values":[null]}')
		if (literal.type !== 'literal') throw new Error('test setup: expected a literal shape')
		Object.defineProperty(literal.values, '0', {
			value: trap,
			enumerable: true,
		})
		Object.freeze(literal.values)
		Object.freeze(literal)
		for (const error of [
			captureContractError(() => validateShapeDepth(literal)),
			captureContractError(() => validateShape(literal)),
			captureContractError(() => compileSchema(literal)),
			captureContractError(() => compileGuard(literal)),
			captureContractError(() => compileParser(literal)),
			captureContractError(() => compileGenerator(literal, () => 0)),
			captureContractError(() => compileReporter(literal, '')),
			captureContractError(() => compileAuditor(literal, '')),
			captureContractError(() => createContract(literal)),
		]) {
			expect(error.code).toBe('structure')
			expect(error.context?.path).toEqual(['values', '0'])
		}
	})

	it('distinguishes corrupt nodes, structural children, property maps, and variant arrays', () => {
		const missing: { readonly child: ContractShape } = JSON.parse('{}')
		const cases: readonly {
			readonly shape: ContractShape
			readonly message: string
		}[] = [
			{
				shape: JSON.parse('{}'),
				message: 'validateShapeDepth: every node must be a recognized shape',
			},
			{
				shape: { type: 'array', items: missing.child },
				message: 'validateShapeDepth: every structural child must be a shape',
			},
			{
				shape: JSON.parse('{"type":"object"}'),
				message: 'validateShapeDepth: properties must be a plain property map',
			},
			{
				shape: JSON.parse('{"type":"union"}'),
				message: 'validateShapeDepth: variants must be a finite array',
			},
		]

		for (const entry of cases) {
			const error = captureContractError(() => validateShapeDepth(entry.shape))
			expect(error.code).toBe('structure')
			expect(error.message).toBe(entry.message)
		}
	})

	it('contains hostile structural reflection and rejects inherited discriminants', () => {
		const revocable = Proxy.revocable({}, {})
		revocable.revoke()
		const revokedSource: { readonly child: ContractShape } = JSON.parse('{}')
		Object.defineProperty(revokedSource, 'child', {
			value: revocable.proxy,
		})

		const throwing: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(throwing, 'type', {
			get() {
				throw new Error('boom from getter')
			},
		})

		const inheritedSource: { readonly child: ContractShape } = JSON.parse('{}')
		Object.setPrototypeOf(inheritedSource, {
			child: Object.freeze(Object.create({ type: 'string' })),
		})
		const revokedArray: ContractShape = { type: 'array', items: revokedSource.child }
		const throwingArray: ContractShape = { type: 'array', items: throwing }
		const cases: readonly ContractShape[] = [
			Object.freeze(revokedArray),
			Object.freeze(throwingArray),
			inheritedSource.child,
		]

		for (const shape of cases) {
			const errors = [
				captureContractError(() => validateShapeDepth(shape)),
				captureContractError(() => validateShape(shape)),
				captureContractError(() => compileSchema(shape)),
				captureContractError(() => compileGuard(shape)),
				captureContractError(() => compileParser(shape)),
				captureContractError(() => compileGenerator(shape, () => 0)),
				captureContractError(() => compileReporter(shape, undefined)),
				captureContractError(() => compileAuditor(shape, undefined)),
			]
			for (const error of errors) {
				expect(error.code).toBe('structure')
				expect(error).not.toBeInstanceOf(TypeError)
			}
		}
	})

	it('contains hostile fields and revoked proxies in every structural slot at depth', () => {
		let reads = 0
		const secondRead: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(secondRead, 'description', {
			enumerable: true,
			get() {
				reads += 1
				if (reads % 2 === 0) throw new Error('second read')
				return 'stable once'
			},
		})
		Object.freeze(secondRead)

		const pattern = /safe/
		Object.defineProperty(pattern, 'source', {
			get() {
				throw new Error('pattern source')
			},
		})
		Object.freeze(pattern)
		const hostilePattern: ContractShape = Object.freeze({
			type: 'string',
			pattern,
		})

		const hostileProperties = new Proxy<Record<string, ContractShape>>(
			{},
			{
				ownKeys() {
					throw new Error('property keys')
				},
			},
		)
		const propertiesShape: ContractShape = Object.freeze({
			type: 'object',
			properties: hostileProperties,
		})

		const pollutedSource: { readonly child: ContractShape } = JSON.parse('{}')
		Object.defineProperty(pollutedSource, 'child', {
			value: Object.freeze(Object.create({ type: 'string' })),
		})

		const items = Proxy.revocable<ContractShape>(JSON.parse('{"type":"string"}'), {})
		const properties = Proxy.revocable<Record<string, ContractShape>>({}, {})
		const additional = Proxy.revocable<ContractShape>(JSON.parse('{"type":"string"}'), {})
		const variants = Proxy.revocable<ContractShape[]>([stringShape()], {})
		const values = Proxy.revocable<(string | number | boolean)[]>(['ok'], {})
		const optional = Proxy.revocable<ContractShape>(JSON.parse('{"type":"string"}'), {})
		const nullable = Proxy.revocable<ContractShape>(JSON.parse('{"type":"string"}'), {})
		const schema = Proxy.revocable<JSONSchema>({}, {})
		items.revoke()
		properties.revoke()
		additional.revoke()
		variants.revoke()
		values.revoke()
		optional.revoke()
		nullable.revoke()
		schema.revoke()

		const revokedShapes: ContractShape[] = [
			Object.freeze({ type: 'array', items: items.proxy }),
			Object.freeze({ type: 'object', properties: properties.proxy }),
			Object.freeze({
				type: 'object',
				properties: Object.freeze({}),
				additionalProperties: additional.proxy,
			}),
			Object.freeze({ type: 'union', variants: variants.proxy }),
			Object.freeze({ type: 'literal', values: values.proxy }),
			Object.freeze({ type: 'optional', inner: optional.proxy }),
			Object.freeze({ type: 'nullable', inner: nullable.proxy }),
			Object.freeze({ type: 'raw', schema: schema.proxy }),
		]
		const nested: ContractShape = {
			type: 'object',
			properties: {
				outer: {
					type: 'array',
					items: {
						type: 'object',
						properties: { inner: revokedShapes[0] ?? stringShape() },
					},
				},
			},
		}
		Object.freeze(nested)
		const polluted: ContractShape = { type: 'array', items: pollutedSource.child }
		const cases = [
			secondRead,
			hostilePattern,
			propertiesShape,
			Object.freeze(polluted),
			nested,
			...revokedShapes,
		]

		for (const shape of cases) {
			for (const error of [
				captureContractError(() => validateShapeDepth(shape)),
				captureContractError(() => validateShape(shape)),
				captureContractError(() => compileSchema(shape)),
				captureContractError(() => compileGuard(shape)),
				captureContractError(() => compileParser(shape)),
				captureContractError(() => compileGenerator(shape, () => 0)),
				captureContractError(() => compileReporter(shape, undefined)),
				captureContractError(() => compileAuditor(shape, undefined)),
				captureContractError(() => createContract(shape)),
			]) {
				expect(error.code).toBe('structure')
				expect(error).not.toBeInstanceOf(TypeError)
				expect(error).not.toBeInstanceOf(RangeError)
			}
		}
	})

	it('rejects a structural array whose reported length is not finite', () => {
		const shape: ContractShape = JSON.parse('{"type":"union","variants":[]}')
		const variants = new Proxy([], {
			get(target, key, receiver) {
				return key === 'length' ? Number.POSITIVE_INFINITY : Reflect.get(target, key, receiver)
			},
		})
		Object.defineProperty(shape, 'variants', { value: variants })

		const error = captureContractError(() => validateShapeDepth(shape))
		expect(error.code).toBe('structure')
		expect(error.context?.path).toEqual(['variants'])
	})

	it('reports structural corruption before cycles regardless of property insertion order', () => {
		const codes: string[] = []
		for (const order of [
			['cycle', 'bad'],
			['bad', 'cycle'],
		]) {
			const cycle: ContractShape = JSON.parse('{"type":"array","items":{}}')
			Object.defineProperty(cycle, 'items', { value: cycle })
			const properties: Record<string, ContractShape> = Object.create(null)
			const missing: { readonly child: ContractShape } = JSON.parse('{}')
			for (const key of order) properties[key] = key === 'cycle' ? cycle : missing.child
			const error = captureContractError(() => validateShapeDepth({ type: 'object', properties }))
			codes.push(error.code)
		}

		expect(codes).toEqual(['structure', 'structure'])
	})

	it('rejects every non-shape child with a structure ContractError at every entry point', () => {
		const source: { readonly child: ContractShape } = JSON.parse('{}')
		const child = source.child
		const cases: readonly {
			readonly shape: ContractShape
			readonly path: readonly string[]
		}[] = [
			{
				shape: { type: 'object', properties: { k: child } },
				path: ['properties', 'k'],
			},
			{ shape: { type: 'array', items: child }, path: ['items'] },
			{
				shape: { type: 'union', variants: [stringShape(), child] },
				path: ['variants', '1'],
			},
			{
				shape: { type: 'union', variants: [stringShape(), child], mode: 'oneOf' },
				path: ['variants', '1'],
			},
			{ shape: { type: 'optional', inner: child }, path: ['inner'] },
			{ shape: { type: 'nullable', inner: child }, path: ['inner'] },
		]

		for (const entry of cases) {
			const depth = captureContractError(() => validateShapeDepth(entry.shape))
			const validation = captureContractError(() => validateShape(entry.shape))
			const schema = captureContractError(() => compileSchema(entry.shape))
			const guard = captureContractError(() => compileGuard(entry.shape))
			const parser = captureContractError(() => compileParser(entry.shape))
			const generator = captureContractError(() => compileGenerator(entry.shape, () => 0))
			const reporter = captureContractError(() => compileReporter(entry.shape, undefined))
			const auditor = captureContractError(() => compileAuditor(entry.shape, undefined))

			for (const error of [
				depth,
				validation,
				schema,
				guard,
				parser,
				generator,
				reporter,
				auditor,
			]) {
				expect(error.code).toBe('structure')
				expect(error.context?.path).toEqual(entry.path)
				expect(error).not.toBeInstanceOf(TypeError)
			}
		}
	})

	it('rejects every structural slot before ownership can erase an unfrozen malformed child', () => {
		const missing: ContractShape = JSON.parse('{"type":"object","properties":{}}')
		if (missing.type !== 'object') throw new Error('test setup: expected an object shape')
		Object.defineProperty(missing.properties, 'missing', {
			value: undefined,
			enumerable: true,
		})
		const cases: readonly {
			readonly shape: ContractShape
			readonly path: readonly string[]
		}[] = [
			{
				shape: JSON.parse('{"type":"array","items":42}'),
				path: ['items'],
			},
			{
				shape: JSON.parse('{"type":"object","properties":{"value":42}}'),
				path: ['properties', 'value'],
			},
			{
				shape: missing,
				path: ['properties', 'missing'],
			},
			{
				shape: JSON.parse('{"type":"object","properties":{},"additionalProperties":42}'),
				path: ['additionalProperties'],
			},
			{
				shape: JSON.parse('{"type":"union","variants":[{"type":"string"},42]}'),
				path: ['variants', '1'],
			},
			{
				shape: JSON.parse('{"type":"optional","inner":42}'),
				path: ['inner'],
			},
			{
				shape: JSON.parse('{"type":"nullable","inner":42}'),
				path: ['inner'],
			},
		]

		for (const entry of cases) {
			const errors = [
				captureContractError(() => cloneShape(entry.shape)),
				captureContractError(() => ownShape(entry.shape)),
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => validateShape(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, undefined)),
				captureContractError(() => compileAuditor(entry.shape, undefined)),
				captureContractError(() => createContract(entry.shape)),
			]

			for (const error of errors) {
				expect(error.code).toBe('structure')
				expect(error.context?.path).toEqual(entry.path)
			}
			const frozen = captureContractError(() => ownShape(Object.freeze(entry.shape)))
			expect(frozen.code).toBe('structure')
			expect(frozen.context?.path).toEqual(entry.path)
		}
	})

	it('rejects every declared bound domain at all eleven shape entry points', () => {
		const integral = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			Number.NEGATIVE_INFINITY,
			-1,
			1.5,
			Number.MAX_SAFE_INTEGER + 1,
		]
		const finite = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
		const cases: { readonly shape: ContractShape; readonly code: 'bound' | 'range' }[] = []

		for (const boundary of ['min', 'max']) {
			for (const value of integral) {
				const string: ContractShape = { type: 'string', [boundary]: value }
				const array: ContractShape = {
					type: 'array',
					items: { type: 'string' },
					[boundary]: value,
				}
				cases.push({ shape: string, code: 'bound' }, { shape: array, code: 'bound' })
			}
			for (const value of finite) {
				const number: ContractShape = { type: 'number', [boundary]: value }
				cases.push({ shape: number, code: 'bound' })
			}
		}
		cases.push(
			{ shape: { type: 'string', min: 2, max: 1 }, code: 'range' },
			{
				shape: { type: 'array', items: { type: 'string' }, min: 2, max: 1 },
				code: 'range',
			},
			{ shape: { type: 'number', min: 2, max: 1 }, code: 'range' },
		)

		for (const entry of cases) {
			const errors = [
				captureContractError(() => cloneShape(entry.shape)),
				captureContractError(() => ownShape(entry.shape)),
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => validateShape(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, undefined)),
				captureContractError(() => compileAuditor(entry.shape, undefined)),
				captureContractError(() => createContract(entry.shape)),
			]

			for (const error of errors) expect(error.code).toBe(entry.code)
			expect(captureContractError(() => ownShape(Object.freeze(entry.shape))).code).toBe(entry.code)
		}
	})

	it('rejects malformed scalar snapshots instead of normalizing them', () => {
		const cases: readonly {
			readonly shape: ContractShape
			readonly path: readonly string[]
		}[] = [
			{ shape: JSON.parse('{"type":"string","pattern":"x"}'), path: ['pattern'] },
			{ shape: JSON.parse('{"type":"raw","schema":[]}'), path: ['schema'] },
		]

		for (const entry of cases) {
			const errors = [
				captureContractError(() => cloneShape(entry.shape)),
				captureContractError(() => ownShape(entry.shape)),
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => validateShape(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, undefined)),
				captureContractError(() => compileAuditor(entry.shape, undefined)),
				captureContractError(() => createContract(entry.shape)),
			]

			for (const error of errors) {
				expect(error.code).toBe('structure')
				expect(error.context?.path).toEqual(entry.path)
			}
			const frozen = captureContractError(() => ownShape(Object.freeze(entry.shape)))
			expect(frozen.code).toBe('structure')
			expect(frozen.context?.path).toEqual(entry.path)
		}
	})

	it('refuses every launderable declaration at all eleven named shape entry points', () => {
		const mapped: ContractShape = JSON.parse('{"type":"object","properties":{}}')
		Object.defineProperty(mapped, 'properties', { value: new Map(), enumerable: true })
		const inherited: ContractShape = JSON.parse('{}')
		Object.setPrototypeOf(inherited, { type: 'string' })
		const accessorType: ContractShape = JSON.parse('{}')
		Object.defineProperty(accessorType, 'type', {
			enumerable: true,
			get() {
				return 'string'
			},
		})
		const accessorMin: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(accessorMin, 'min', {
			enumerable: true,
			get() {
				return 1
			},
		})
		const cases: readonly { readonly name: string; readonly shape: ContractShape }[] = [
			{
				name: 'array properties',
				shape: JSON.parse('{"type":"object","properties":[]}'),
			},
			{ name: 'Map properties', shape: mapped },
			{ name: 'record variants', shape: JSON.parse('{"type":"union","variants":{}}') },
			{
				name: 'array-like variants',
				shape: JSON.parse('{"type":"union","variants":{"length":0}}'),
			},
			{ name: 'inherited type', shape: inherited },
			{ name: 'accessor type', shape: accessorType },
			{ name: 'accessor min', shape: accessorMin },
		]

		for (const entry of cases) {
			const outcomes = [
				{ name: 'cloneShape', outcome: attempt(() => cloneShape(entry.shape)) },
				{ name: 'ownShape', outcome: attempt(() => ownShape(entry.shape)) },
				{
					name: 'validateShapeDepth',
					outcome: attempt(() => validateShapeDepth(entry.shape)),
				},
				{ name: 'validateShape', outcome: attempt(() => validateShape(entry.shape)) },
				{ name: 'compileSchema', outcome: attempt(() => compileSchema(entry.shape)) },
				{ name: 'compileGuard', outcome: attempt(() => compileGuard(entry.shape)) },
				{ name: 'compileParser', outcome: attempt(() => compileParser(entry.shape)) },
				{
					name: 'compileGenerator',
					outcome: attempt(() => compileGenerator(entry.shape, () => 0)),
				},
				{
					name: 'compileReporter',
					outcome: attempt(() => compileReporter(entry.shape, '')),
				},
				{
					name: 'compileAuditor',
					outcome: attempt(() => compileAuditor(entry.shape, '')),
				},
				{ name: 'createContract', outcome: attempt(() => createContract(entry.shape)) },
			]

			expect(outcomes.map((outcome) => outcome.name)).toEqual([
				'cloneShape',
				'ownShape',
				'validateShapeDepth',
				'validateShape',
				'compileSchema',
				'compileGuard',
				'compileParser',
				'compileGenerator',
				'compileReporter',
				'compileAuditor',
				'createContract',
			])
			for (const result of outcomes) {
				expect(result.outcome.success, `${entry.name} at ${result.name}`).toBe(false)
				if (result.outcome.success) continue
				expect(isContractError(result.outcome.error), `${entry.name} at ${result.name}`).toBe(true)
				if (!isContractError(result.outcome.error)) continue
				expect(result.outcome.error.code, `${entry.name} at ${result.name}`).toBe('structure')
			}
		}

		const control = stringShape()
		const controls = [
			attempt(() => cloneShape(control)),
			attempt(() => ownShape(control)),
			attempt(() => validateShapeDepth(control)),
			attempt(() => validateShape(control)),
			attempt(() => compileSchema(control)),
			attempt(() => compileGuard(control)),
			attempt(() => compileParser(control)),
			attempt(() => compileGenerator(control, () => 0)),
			attempt(() => compileReporter(control, '')),
			attempt(() => compileAuditor(control, '')),
			attempt(() => createContract(control)),
		]
		expect(controls.every((outcome) => outcome.success)).toBe(true)
	})

	it('refuses only an unfrozen accessor result among valid pattern declaration forms', () => {
		const data: ContractShape = { type: 'string', pattern: /^[a-z0-9]*$/ }
		const ownedAccessor: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(ownedAccessor, 'pattern', {
			enumerable: true,
			get() {
				return Object.freeze(/^[a-z0-9]*$/)
			},
		})
		const unownedAccessor: ContractShape = JSON.parse('{"type":"string"}')
		Object.defineProperty(unownedAccessor, 'pattern', {
			enumerable: true,
			get() {
				return /^unowned$/
			},
		})

		for (const shape of [data, ownedAccessor]) {
			const outcomes = [
				attempt(() => cloneShape(shape)),
				attempt(() => ownShape(shape)),
				attempt(() => validateShapeDepth(shape)),
				attempt(() => validateShape(shape)),
				attempt(() => compileSchema(shape)),
				attempt(() => compileGuard(shape)),
				attempt(() => compileParser(shape)),
				attempt(() => compileGenerator(shape, () => 0)),
				attempt(() => compileReporter(shape, 'owned')),
				attempt(() => compileAuditor(shape, 'owned')),
				attempt(() => createContract(shape)),
			]
			expect(outcomes.every((outcome) => outcome.success)).toBe(true)
		}

		const errors = [
			captureContractError(() => cloneShape(unownedAccessor)),
			captureContractError(() => ownShape(unownedAccessor)),
			captureContractError(() => validateShapeDepth(unownedAccessor)),
			captureContractError(() => validateShape(unownedAccessor)),
			captureContractError(() => compileSchema(unownedAccessor)),
			captureContractError(() => compileGuard(unownedAccessor)),
			captureContractError(() => compileParser(unownedAccessor)),
			captureContractError(() => compileGenerator(unownedAccessor, () => 0)),
			captureContractError(() => compileReporter(unownedAccessor, 'unowned')),
			captureContractError(() => compileAuditor(unownedAccessor, 'unowned')),
			captureContractError(() => createContract(unownedAccessor)),
		]
		for (const error of errors) {
			expect(error.code).toBe('structure')
			expect(error.context?.path).toEqual(['pattern'])
		}
	})

	it('rejects malformed children nested under legal parents and additional properties', () => {
		const source: { readonly child: ContractShape } = JSON.parse('{}')
		const missing = source.child
		const malformed: ContractShape = JSON.parse('{}')
		const malformedObject: ContractShape = JSON.parse('{"type":"object"}')
		const malformedUnion: ContractShape = JSON.parse('{"type":"union"}')
		let deep: ContractShape = { type: 'nullable', inner: missing }
		for (let level = 0; level < 64; level += 1) deep = { type: 'array', items: deep }

		const nested = captureContractError(() =>
			compileGuard({
				type: 'object',
				properties: { values: { type: 'array', items: missing } },
			}),
		)
		const additional = captureContractError(() =>
			compileAuditor({ type: 'object', properties: {}, additionalProperties: malformed }, {}),
		)
		const discriminant = captureContractError(() =>
			compileParser({ type: 'object', properties: { value: malformed } }),
		)
		const properties = captureContractError(() =>
			compileSchema({ type: 'object', properties: { value: malformedObject } }),
		)
		const variants = captureContractError(() =>
			compileGenerator({ type: 'object', properties: { value: malformedUnion } }, () => 0),
		)
		const depth = captureContractError(() => compileReporter(deep, undefined))

		expect(nested.code).toBe('structure')
		expect(nested.context?.path).toEqual(['properties', 'values', 'items'])
		expect(additional.code).toBe('structure')
		expect(additional.context?.path).toEqual(['additionalProperties'])
		expect(discriminant.code).toBe('structure')
		expect(discriminant.context?.path).toEqual(['properties', 'value'])
		expect(properties.code).toBe('structure')
		expect(properties.context?.path).toEqual(['properties', 'value', 'properties'])
		expect(variants.code).toBe('structure')
		expect(variants.context?.path).toEqual(['properties', 'value', 'variants'])
		expect(depth.code).toBe('structure')
		expect(depth.context?.path).toEqual([...Array.from({ length: 64 }, () => 'items'), 'inner'])
		const undefinedAdditional = captureContractError(() => recordShape(missing))
		expect(undefinedAdditional.code).toBe('structure')
		expect(undefinedAdditional.context?.path).toEqual(['additionalProperties'])
		expect(() => validateShape(objectShape({}))).not.toThrow()
	})
})

describe('createContract fail-fast', () => {
	it('throws at creation time for a degenerate shape, not at use', () => {
		expect(() => createContract({ type: 'string', min: 5, max: 1 })).toThrow(
			'validateShapeDepth: a string shape has min greater than max',
		)
		expect(() => createContract(JSON.parse('{"type":"union","variants":[]}'))).toThrow(
			'validateShapeDepth: a union shape needs at least one variant',
		)
		expect(() => createContract(JSON.parse('{"type":"literal","values":[]}'))).toThrow(
			'validateShapeDepth: a literal shape needs at least one value',
		)
		expect(() => createContract(integerShape({ min: 2.5, max: 2.6 }))).toThrow(
			'validateShapeDepth: an integer number shape has an empty integer range',
		)
		expect(() => createContract(arrayShape(optionalShape(stringShape())))).toThrow(
			'validateShapeDepth: an optional shape may only appear as a direct object-property value',
		)
	})
})

describe('JSON Schema vocabulary safety', () => {
	it('refuses empty applicator vocabularies and non-finite literal members at the shared gate', () => {
		const cases: readonly { readonly shape: ContractShape; readonly code: 'empty' | 'literal' }[] =
			[
				{ shape: JSON.parse('{"type":"union","variants":[]}'), code: 'empty' },
				{ shape: JSON.parse('{"type":"union","variants":[],"mode":"oneOf"}'), code: 'empty' },
				{ shape: JSON.parse('{"type":"literal","values":[]}'), code: 'empty' },
				{ shape: { type: 'literal', values: [Number.NaN] }, code: 'literal' },
				{ shape: { type: 'literal', values: [Number.POSITIVE_INFINITY] }, code: 'literal' },
				{ shape: { type: 'literal', values: [Number.NEGATIVE_INFINITY] }, code: 'literal' },
			]

		for (const entry of cases) {
			const errors = [
				captureContractError(() => validateShapeDepth(entry.shape)),
				captureContractError(() => validateShape(entry.shape)),
				captureContractError(() => compileSchema(entry.shape)),
				captureContractError(() => compileGuard(entry.shape)),
				captureContractError(() => compileParser(entry.shape)),
				captureContractError(() => compileGenerator(entry.shape, () => 0)),
				captureContractError(() => compileReporter(entry.shape, undefined)),
				captureContractError(() => compileAuditor(entry.shape, undefined)),
				captureContractError(() => createContract(entry.shape)),
			]
			for (const error of errors) expect(error.code).toBe(entry.code)
		}
	})

	it('emits applicator, enum, and numeric keywords inside their vocabulary domains', () => {
		const anyOf = compileSchema(unionShape(stringShape()))
		const oneOf = compileSchema(oneOfShape(booleanShape()))
		const enumeration = compileSchema(literalShape(['ready', 1, true]))
		const bounded = compileSchema(numberShape({ min: 0, max: 1 }))

		expect(Array.isArray(anyOf.anyOf) && anyOf.anyOf.length >= 1).toBe(true)
		expect(Array.isArray(oneOf.oneOf) && oneOf.oneOf.length >= 1).toBe(true)
		expect(
			enumeration.enum?.every((value) => typeof value !== 'number' || Number.isFinite(value)),
		).toBe(true)
		expect(bounded.minimum).toBe(0)
		expect(bounded.maximum).toBe(1)
		expect(JSON.stringify(bounded)).not.toContain('null')
	})
})

describe('null / json compileSchema', () => {
	it('emits { type: "null" } with optional description', () => {
		expect(compileSchema(nullShape())).toEqual({ type: 'null' })
		expect(compileSchema(nullShape({ description: 'nothing' }))).toEqual({
			type: 'null',
			description: 'nothing',
		})
	})

	it('emits the empty schema for json, with optional description', () => {
		expect(compileSchema(jsonShape())).toEqual({})
		expect(compileSchema(jsonShape({ description: 'any JSON value' }))).toEqual({
			description: 'any JSON value',
		})
	})
})

describe('null / json compileGuard', () => {
	it('null guard accepts only null', () => {
		const guard = compileGuard(nullShape())
		expect(guard(null)).toBe(true)
		expect(guard(undefined)).toBe(false)
		expect(guard(0)).toBe(false)
		expect(guard('null')).toBe(false)
	})

	it('json guard accepts nested JSON trees and rejects functions, NaN, Infinity, cycles, Date', () => {
		const guard = compileGuard(jsonShape())
		expect(guard(null)).toBe(true)
		expect(guard(42)).toBe(true)
		expect(guard('hello')).toBe(true)
		expect(guard(true)).toBe(true)
		expect(guard({ a: [1, 'x', { b: null }] })).toBe(true)
		expect(guard(() => 1)).toBe(false)
		expect(guard(Number.NaN)).toBe(false)
		expect(guard(Number.POSITIVE_INFINITY)).toBe(false)
		expect(guard(new Date())).toBe(false)
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		expect(guard(cyclic)).toBe(false)
	})
})

describe('null / json compileParser', () => {
	it('null parser is an identity on null, undefined otherwise', () => {
		const parse = compileParser(nullShape())
		expect(parse(null)).toBeNull()
		expect(parse('null')).toBeUndefined()
		expect(parse(undefined)).toBeUndefined()
	})

	it('json parser is an identity for valid JSON, undefined for invalid', () => {
		const parse = compileParser(jsonShape())
		expect(parse({ a: 1 })).toEqual({ a: 1 })
		expect(parse(42)).toBe(42)
		expect(parse(() => 1)).toBeUndefined()
		expect(parse(Number.NaN)).toBeUndefined()
		expect(parse(undefined)).toBeUndefined()
	})
})

describe('null / json compileGenerator', () => {
	it('null generator always emits null and passes the null guard', () => {
		const guard = compileGuard(nullShape())
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(nullShape(), seededRandom(seed))
			expect(value).toBeNull()
			expect(guard(value)).toBe(true)
		}
	})

	it('json generator output always passes the json guard, across many seeds', () => {
		const guard = compileGuard(jsonShape())
		for (let seed = 0; seed < 30; seed += 1) {
			const value = compileGenerator(jsonShape(), seededRandom(seed))
			expect(guard(value)).toBe(true)
		}
	})

	it('json generator is deterministic for a given seed', () => {
		expect(compileGenerator(jsonShape(), seededRandom(99))).toEqual(
			compileGenerator(jsonShape(), seededRandom(99)),
		)
	})
})

describe('compileSchema', () => {
	it('emits string / number constraints', () => {
		expect(
			compileSchema(
				stringShape({
					min: 1,
					max: 8,
					pattern: /^a+$/,
					description: 'd',
				}),
			),
		).toEqual({
			type: 'string',
			minLength: 1,
			maxLength: 8,
			pattern: '^a+$',
			description: 'd',
		})
		expect(compileSchema(integerShape({ min: 0 }))).toEqual({
			type: 'integer',
			minimum: 0,
		})
		expect(compileSchema(numberShape({ max: 9 }))).toEqual({
			type: 'number',
			maximum: 9,
		})
	})

	it('emits literals as enum and arrays with items + bounds', () => {
		expect(compileSchema(literalShape(['a', 'b']))).toEqual({
			enum: ['a', 'b'],
		})
		expect(compileSchema(arrayShape(stringShape(), { max: 2 }))).toEqual({
			type: 'array',
			items: { type: 'string' },
			maxItems: 2,
		})
	})

	it('emits objects with required (optional excluded) + additionalProperties:false', () => {
		expect(
			compileSchema(
				objectShape({
					name: stringShape(),
					bio: optionalShape(stringShape()),
				}),
			),
		).toEqual({
			type: 'object',
			properties: { name: { type: 'string' }, bio: { type: 'string' } },
			required: ['name'],
			additionalProperties: false,
		})
		expect(compileSchema(recordShape(numberShape()))).toEqual({
			type: 'object',
			additionalProperties: { type: 'number' },
		})
	})

	it('emits union anyOf / oneOf, nullable anyOf+null, and raw passthrough', () => {
		expect(compileSchema(unionShape(stringShape(), integerShape()))).toEqual({
			anyOf: [{ type: 'string' }, { type: 'integer' }],
		})
		expect(compileSchema(oneOfShape(stringShape(), booleanShape()))).toEqual({
			oneOf: [{ type: 'string' }, { type: 'boolean' }],
		})
		expect(compileSchema(nullableShape(stringShape()))).toEqual({
			anyOf: [{ type: 'string' }, { type: 'null' }],
		})
		expect(compileSchema(rawShape({ type: 'string', description: 'x' }))).toEqual({
			type: 'string',
			description: 'x',
		})
	})

	it('emits a __proto__ property as schema data', () => {
		const properties: Record<string, ContractShape> = Object.create(null)
		properties['__proto__'] = integerShape()
		const schema = compileSchema(objectShape(properties))

		expect(schema.properties).toBeDefined()
		expect(Object.hasOwn(schema.properties ?? {}, '__proto__')).toBe(true)
		expect(schema.properties?.['__proto__']).toEqual({ type: 'integer' })
		expect(schema.required).toEqual(['__proto__'])
	})

	it('owns and deeply freezes a raw schema even when the root shape is caller-frozen', () => {
		const child: JSONSchema = { type: 'string' }
		const schema: JSONSchema = {
			type: 'object',
			properties: { value: child },
		}
		const shape: RawShape = Object.freeze({ type: 'raw', schema })
		const compiled = compileSchema(shape)

		Reflect.set(schema, 'type', 'number')
		Reflect.set(child, 'type', 'integer')
		expect(compiled).not.toBe(schema)
		expect(compiled).toEqual({
			type: 'object',
			properties: { value: { type: 'string' } },
		})
		expect(Object.isFrozen(compiled)).toBe(true)
		expect(Object.isFrozen(compiled.properties)).toBe(true)
		expect(Object.isFrozen(compiled.properties?.value)).toBe(true)
	})
})

describe('compileGuard', () => {
	it('enforces string and number constraints', () => {
		const name = compileGuard(stringShape({ min: 2, max: 4 }))
		expect(name('abc')).toBe(true)
		expect(name('a')).toBe(false)
		expect(name('abcde')).toBe(false)
		expect(name(5)).toBe(false)
		const age = compileGuard(integerShape({ min: 0 }))
		expect(age(3)).toBe(true)
		expect(age(-1)).toBe(false)
		expect(age(3.5)).toBe(false)
	})

	it('validates a closed object with an optional field', () => {
		const guard = compileGuard(
			objectShape({
				name: stringShape(),
				bio: optionalShape(stringShape()),
			}),
		)
		expect(guard({ name: 'Ada' })).toBe(true)
		expect(guard({ name: 'Ada', bio: 'hi' })).toBe(true)
		expect(guard({ name: 'Ada', extra: 1 })).toBe(false)
		expect(guard({ bio: 'hi' })).toBe(false)
	})

	it('validates an open object (recordShape)', () => {
		const guard = compileGuard(recordShape(numberShape()))
		expect(guard({ a: 1, b: 2 })).toBe(true)
		expect(guard({ a: 1, b: 'x' })).toBe(false)
		expect(guard({})).toBe(true)
	})

	it('handles union / nullable / literal / array', () => {
		const id = compileGuard(unionShape(stringShape(), integerShape()))
		expect(id('x')).toBe(true)
		expect(id(3)).toBe(true)
		expect(id(true)).toBe(false)
		expect(compileGuard(nullableShape(stringShape()))(null)).toBe(true)
		expect(compileGuard(literalShape(['a', 'b']))('a')).toBe(true)
		expect(compileGuard(literalShape(['a', 'b']))('c')).toBe(false)
		const arr = compileGuard(arrayShape(integerShape(), { min: 1 }))
		expect(arr([1, 2])).toBe(true)
		expect(arr([])).toBe(false)
		expect(arr([1, 'x'])).toBe(false)
	})

	it('uses SameValueZero for a compiled signed-zero literal round trip', () => {
		const shape = literalShape([-0])
		const guard = compileGuard(shape)
		const parse = compileParser(shape)
		const parsed = parse(+0)

		expect(guard(+0)).toBe(true)
		expect(parsed).toBe(0)
		expect(parsed !== undefined && guard(parsed)).toBe(true)
	})

	it('compiles a machine-scale literal vocabulary that no spread could carry', () => {
		// An untrusted schema's `enum` converts to a literalShape of whatever size
		// it declares, so every compiled literal artifact must match membership
		// without spreading the vocabulary into arguments.
		const vocabulary = buildWideVocabulary()
		const shape = literalShape(vocabulary)
		const contract = createContract(shape)

		expect(contract.is('value0')).toBe(true)
		expect(contract.is('absent')).toBe(false)
		expect(contract.parse(' value1 ')).toBe('value1')
		expect(contract.explain('absent')).toHaveLength(1)
		expect(contract.schema.enum).toHaveLength(vocabulary.length)
	})

	it('rejects top-level undefined for a raw shape in guard/parser agreement', () => {
		const shape = rawShape({})
		const guard = compileGuard(shape)
		const parse = compileParser(shape)

		expect(guard(undefined)).toBe(false)
		expect(parse(undefined)).toBeUndefined()
	})

	it('oneOfShape rejects a value matching more than one variant (exactly-one semantics)', () => {
		const guard = compileGuard(oneOfShape(numberShape(), integerShape()))
		// 3 is guard-valid against BOTH numberShape and integerShape — the emitted
		// JSON Schema `oneOf` requires EXACTLY one match, so the compiled guard
		// must reject it even though unionShape's anyOf semantics would accept it.
		expect(guard(3)).toBe(false)
		expect(guard(3.5)).toBe(true) // matches numberShape only
		expect(guard('x')).toBe(false) // matches neither
	})

	it('raw accepts defined values and the guard stays total on adversarial input', () => {
		expect(compileGuard(rawShape({}))(Symbol('x'))).toBe(true)
		const guard = compileGuard(objectShape({ name: stringShape() }))
		expect(() => guard(null)).not.toThrow()
		expect(guard(null)).toBe(false)
	})

	it('an open object guard is total on hostile keys (__proto__, constructor) — no pollution', () => {
		const guard = compileGuard(recordShape(integerShape()))
		const parse = compileParser(recordShape(integerShape()))
		const fromJSON: unknown = JSON.parse('{"__proto__":1}')
		// The '__proto__' key is validated like any other own key (value 1 passes
		// integerShape) — no throw, and guard/parse agree.
		expect(() => guard(fromJSON)).not.toThrow()
		expect(guard(fromJSON)).toBe(true)
		expect(parse(fromJSON)).not.toBeUndefined()
		// Object.prototype itself must be untouched by the walk.
		expect(Object.getPrototypeOf({})).toBe(Object.prototype)

		// 'constructor' is likewise just another own key — its value ('x') fails
		// integerShape, so the object is rejected, not treated specially.
		expect(guard({ constructor: 'x' })).toBe(false)
		expect(parse({ constructor: 'x' })).toBeUndefined()

		// A throwing getter remains false for the total guard, while the parser
		// distinguishes unreadability from an honest invalid result.
		const hostile: Record<string, unknown> = {}
		Object.defineProperty(hostile, 'bad', {
			enumerable: true,
			get() {
				throw new Error('hostile getter')
			},
		})
		expect(() => guard(hostile)).not.toThrow()
		expect(guard(hostile)).toBe(false)
		const error = captureContractError(() => parse(hostile))
		expect(error.code).toBe('structure')
		expect(error.message).toBe('parseRecord: value could not be read')
	})

	it('an open object guard/parse agree that a __proto__ own key round-trips faithfully', () => {
		const parse = compileParser(recordShape(integerShape()))
		const fromJSON: unknown = JSON.parse('{"__proto__":5}')
		const parsed = parse(fromJSON)
		expect(isRecord(parsed)).toBe(true)
		const record = isRecord(parsed) ? parsed : {}
		expect(Object.hasOwn(record, '__proto__')).toBe(true)
		expect(record['__proto__']).toBe(5)
		expect(JSON.stringify(record)).toBe('{"__proto__":5}')
	})

	it('compiled object artifacts share the own-enumerable-string property view', () => {
		const shape = objectShape({ x: booleanShape() }, { additionalProperties: true })
		const value = createNonEnumerableRecord('x', 'bad')
		const guard = compileGuard(shape)
		const parse = compileParser(shape)

		expect(guard(value)).toBe(false)
		expect(parse(value)).toBeUndefined()
		expect(compileReporter(shape, value)).toEqual([
			{ reason: 'missing', path: ['x'], expected: 'boolean' },
		])
	})

	it('round-trips a __proto__-keyed object through schema, guard, parser, and generator', () => {
		const properties: Record<string, ContractShape> = Object.create(null)
		properties['__proto__'] = literalShape(['safe'])
		const shape = objectShape(properties)
		const schema = compileSchema(shape)
		const guard = compileGuard(shape)
		const parse = compileParser(shape)
		const generated = compileGenerator(shape, seededRandom(1))
		const input: unknown = JSON.parse('{"__proto__":"safe"}')

		expect(Object.hasOwn(schema.properties ?? {}, '__proto__')).toBe(true)
		expect(guard(input)).toBe(true)
		expect(parse(input)).toEqual(input)
		expect(Object.hasOwn(generated, '__proto__')).toBe(true)
		expect(guard(generated)).toBe(true)
	})
})

describe('compileParser', () => {
	it('refuses failed dense-index reads at the root and through object parsing', () => {
		const hostile = new Proxy([1, 2], {
			get(target, key, receiver) {
				if (key === '1') throw new Error('hostile index')
				return Reflect.get(target, key, receiver)
			},
		})
		const direct = createContract(arrayShape(numberShape()))
		const nested = createContract(objectShape({ values: arrayShape(numberShape()) }))

		for (const callback of [() => direct.parse(hostile), () => nested.parse({ values: hostile })]) {
			const error = captureContractError(callback)
			expect(error.code).toBe('structure')
			expect(error.message).toBe('compileParser: array could not be read')
			expect(error.context).toEqual({ shape: 'array' })
		}
	})

	it('parses array indices consistently with is, audit, and explain', () => {
		const iteratorThrow = [1, 2]
		Object.defineProperty(iteratorThrow, Symbol.iterator, {
			value() {
				throw new Error('iterator must not run')
			},
		})
		const divergent = [1, 2, 3]
		Object.defineProperty(divergent, Symbol.iterator, {
			value: () => ['x', 'y', 'z'][Symbol.iterator](),
		})
		const contract = createContract(arrayShape(numberShape()))

		expect(contract.is(iteratorThrow)).toBe(true)
		expect(contract.parse(iteratorThrow)).toEqual([1, 2])
		expect(contract.audit(iteratorThrow)).toEqual([])
		expect(contract.explain(iteratorThrow)).toEqual([])
		expect(contract.parse(divergent)).toEqual([1, 2, 3])
		expect(contract.explain(divergent)).toEqual([])
	})

	it('refuses a malformed array length instead of accepting an empty view', () => {
		const hostile = new Proxy([1, 2, 3], {
			get(target, key, receiver) {
				return key === 'length' ? -1 : Reflect.get(target, key, receiver)
			},
		})
		const contract = createContract(arrayShape(numberShape()))

		expect(contract.is(hostile)).toBe(false)
		expect(captureContractError(() => contract.parse(hostile)).code).toBe('structure')
		expect(captureContractError(() => contract.audit(hostile)).code).toBe('structure')
	})

	it('refuses an unreadable json leaf instead of returning honest invalidity', () => {
		const hostile = new Proxy(
			{ value: 1 },
			{
				getOwnPropertyDescriptor() {
					throw new Error('hostile descriptor')
				},
			},
		)
		const error = captureContractError(() => createContract(jsonShape()).parse(hostile))

		expect(error.code).toBe('structure')
		expect(error.message).toBe('parseJSONValue: value could not be read')
		expect(error.context).toEqual({ shape: 'json' })
	})

	it('coerces whole objects and fails on a missing required field', () => {
		const parse = compileParser(objectShape({ name: stringShape(), age: integerShape() }))
		expect(parse({ name: 'Ada', age: '36' })).toEqual({
			name: 'Ada',
			age: 36,
		})
		expect(parse({ name: 'Ada' })).toBeUndefined()
	})

	it('skips absent optional fields and coerces nullable', () => {
		const parse = compileParser(
			objectShape({
				name: stringShape(),
				bio: optionalShape(stringShape()),
			}),
		)
		expect(parse({ name: 'Ada' })).toEqual({ name: 'Ada' })
		expect(compileParser(nullableShape(integerShape()))(null)).toBeNull()
		expect(compileParser(nullableShape(integerShape()))('7')).toBe(7)
	})

	it('union returns the first variant that both parses and guards', () => {
		const parse = compileParser(unionShape(integerShape(), stringShape()))
		// '36' is already guard-valid as a string (clause A), so it is returned
		// unchanged rather than coerced by the integer variant.
		expect(parse('36')).toBe('36')
		expect(parse('hello')).toBe('hello')
	})

	it('union returns a guard-valid value unchanged rather than coerced by an earlier variant', () => {
		const parse = compileParser(unionShape(stringShape(), integerShape()))
		expect(parse(37)).toBe(37) // guard-valid via integer variant — not coerced to '37'
		expect(parse('37')).toBe('37') // already guard-valid via string variant — unchanged
		expect(parse(true)).toBeUndefined() // guard-invalid against every variant
	})

	it('oneOfShape parse rejects an input matching more than one variant', () => {
		const parse = compileParser(oneOfShape(numberShape(), integerShape()))
		expect(parse(3)).toBeUndefined() // matches both variants — ambiguous, rejected
		expect(parse(3.5)).toBe(3.5) // matches numberShape only
		expect(parse('x')).toBeUndefined() // matches neither
	})

	it('union returns a guard-valid object by reference through the identity pass', () => {
		const parse = compileParser(
			unionShape(
				objectShape({ name: stringShape() }),
				objectShape({ name: stringShape(), age: integerShape() }),
			),
		)
		const input = { name: 'Ada', age: 36 }
		expect(parse(input)).toBe(input)
	})

	it('enforces string length + pattern refinements (rejects out-of-bounds)', () => {
		const parse = compileParser(stringShape({ min: 1, max: 3, pattern: /^a+$/ }))
		expect(parse('aa')).toBe('aa') // in-bounds
		expect(parse('')).toBeUndefined() // empty under min:1
		expect(parse('aaaa')).toBeUndefined() // over max:3
		expect(parse('xy')).toBeUndefined() // pattern miss
	})

	it('enforces number bounds, even on a coerced numeric string', () => {
		const parse = compileParser(integerShape({ min: 1, max: 5 }))
		expect(parse(3)).toBe(3) // in-bounds
		expect(parse('4')).toBe(4) // coerced and in-bounds
		expect(parse(0)).toBeUndefined() // under min:1
		expect(parse(6)).toBeUndefined() // over max:5
		expect(parse('0')).toBeUndefined() // coerces, then fails min:1
	})

	it('enforces array length bounds after coercing elements', () => {
		const parse = compileParser(arrayShape(integerShape(), { min: 1, max: 2 }))
		expect(parse(['1', '2'])).toEqual([1, 2]) // coerces + in-bounds
		expect(parse([])).toBeUndefined() // under min:1
		expect(parse([1, 2, 3])).toBeUndefined() // over max:2
	})

	it('enforces a refinement on a leaf nested inside an object', () => {
		const parse = compileParser(
			objectShape({
				name: stringShape({ min: 1 }),
				age: integerShape({ min: 0 }),
			}),
		)
		expect(parse({ name: 'Ada', age: '36' })).toEqual({
			name: 'Ada',
			age: 36,
		})
		expect(parse({ name: '', age: 36 })).toBeUndefined() // name under min:1
		expect(parse({ name: 'Ada', age: -1 })).toBeUndefined() // age under min:0
	})

	// AGENTS §14 parse↔guard soundness for REFINED leaves: the compiled guard and
	// parser are derived from one combinator source (`stringOf` / `boundsOf`), so every non-`undefined` parse
	// must satisfy the guard — refinements included. (Clause B of soundness; the
	// compiler intentionally rebuilds containers to coerce contents, so the leaf
	// parsers' by-identity clause A does not apply to compiled array/object parsers —
	// hence the focused B-only check rather than `soundnessViolations`.) Violations
	// are gathered into one array and asserted empty (no conditional `expect`).
	it('refined leaves: every non-undefined compiled parse satisfies the guard', () => {
		const shapes = [
			stringShape({ min: 2, max: 4, pattern: /^[a-z]+$/ }),
			numberShape({ min: -1, max: 1 }),
			integerShape({ min: 0, max: 10 }),
			arrayShape(integerShape(), { min: 1, max: 2 }),
			objectShape({
				tag: stringShape({ min: 1 }),
				score: integerShape({ min: 0, max: 100 }),
			}),
		]
		const violations: string[] = []
		for (const [shapeIndex, shape] of shapes.entries()) {
			const parse = compileParser(shape)
			const guard = compileGuard(shape)
			for (let index = 0; index < SOUNDNESS_SAMPLE.length; index += 1) {
				const outcome = attempt(() => parse(SOUNDNESS_SAMPLE[index]))
				if (!outcome.success) {
					if (!isContractError(outcome.error)) violations.push(`raw@shape${shapeIndex}@${index}`)
					continue
				}
				const parsed = outcome.value
				if (parsed !== undefined && !guard(parsed)) violations.push(`shape${shapeIndex}@${index}`)
			}
		}
		expect(violations).toEqual([])
	})

	it('an in-bounds value round-trips through createContract.parse and is', () => {
		const contract = createContract(
			objectShape({
				name: stringShape({ min: 1, max: 5 }),
				age: integerShape({ min: 0 }),
			}),
		)
		const parsed = contract.parse({ name: 'Ada', age: '36' })
		expect(parsed).toEqual({ name: 'Ada', age: 36 })
		expect(parsed !== undefined && contract.is(parsed)).toBe(true)
		// An out-of-bounds field makes the whole contract parse fail.
		expect(contract.parse({ name: '', age: 36 })).toBeUndefined()
	})
})

describe('compileGenerator', () => {
	it('is deterministic for a given seed', () => {
		const shape = objectShape({
			name: stringShape(),
			age: integerShape({ min: 0, max: 100 }),
		})
		expect(compileGenerator(shape, seededRandom(42))).toEqual(
			compileGenerator(shape, seededRandom(42)),
		)
	})

	it('produces values that satisfy the compiled guard', () => {
		const shape = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape({ min: 0, max: 120 }),
			role: literalShape(['admin', 'guest']),
			tags: arrayShape(stringShape(), { min: 1, max: 3 }),
		})
		const guard = compileGuard(shape)
		const random = seededRandom(7)
		for (let index = 0; index < 20; index += 1) {
			expect(guard(compileGenerator(shape, random))).toBe(true)
		}
	})

	it('produces bounded strings that satisfy the compiled guard', () => {
		const shapes = [
			stringShape({ min: 2, max: 4 }),
			stringShape({ max: 6 }),
			stringShape({ min: 0, max: 0 }),
			objectShape({ tag: stringShape({ min: 2, max: 4 }) }),
			arrayShape(stringShape({ min: 2, max: 4 }), { min: 1, max: 3 }),
		]
		for (const shape of shapes) {
			const guard = compileGuard(shape)
			const random = seededRandom(11)
			for (let index = 0; index < 20; index += 1) {
				expect(guard(compileGenerator(shape, random))).toBe(true)
			}
		}
	})

	it('generates the empty string when min and max are both 0', () => {
		const shape = stringShape({ min: 0, max: 0 })
		expect(compileGenerator(shape, seededRandom(1))).toBe('')
	})

	it('throws on a degenerate empty literal / union (programmer error)', () => {
		expect(() => compileGenerator(literalShape([]), seededRandom(1))).toThrow('at least one value')
		expect(() => compileGenerator(unionShape(), seededRandom(1))).toThrow('at least one variant')
	})

	it('throws on a pattern-constrained string shape it cannot satisfy (programmer error)', () => {
		const shape = stringShape({ min: 4, max: 6, pattern: /^ZZZZZZ$/ })
		expect(() => compileGenerator(shape, seededRandom(1))).toThrow('cannot be auto-generated')
	})

	it('falls back to the default random source when none is supplied', () => {
		const shape = objectShape({
			name: stringShape({ min: 1 }),
			age: integerShape({ min: 0, max: 9 }),
		})
		const guard = compileGuard(shape)
		expect(guard(compileGenerator(shape))).toBe(true)
	})

	it('generates an empty array when max:0 and passes the guard', () => {
		const shape = arrayShape(stringShape(), { max: 0 })
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(shape, seededRandom(seed))
			expect(value).toEqual([])
			expect(guard(value)).toBe(true)
		}
	})

	it('generates within a fractional-bounds integer range and passes the guard', () => {
		const shape = integerShape({ min: 2.5, max: 3.4 })
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(shape, seededRandom(seed))
			expect(value).toBe(3)
			expect(guard(value)).toBe(true)
		}
	})

	it('honors a one-sided negative maximum across one thousand seeds', () => {
		const shape = numberShape({ max: -1 })
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 1000; seed += 1) {
			expect(guard(compileGenerator(shape, seededRandom(seed)))).toBe(true)
		}
	})

	it('draws bounded number and integer values across their effective ranges', () => {
		const number = numberShape({ min: 10, max: 20 })
		const integer = integerShape({ min: 10, max: 20 })

		expect(compileGenerator(number, () => 0)).toBe(10)
		expect(compileGenerator(number, () => 0.5)).toBe(15)
		expect(compileGenerator(integer, () => 0)).toBe(10)
		expect(compileGenerator(integer, () => 0.5)).toBe(15)
	})

	it('generates guard-valid finite values across extreme numeric bounds without overflow', () => {
		const shapes = [
			numberShape({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE }),
			integerShape({ min: -Number.MAX_VALUE, max: Number.MAX_VALUE }),
			numberShape({ min: Number.MAX_VALUE }),
			integerShape({ max: -Number.MAX_VALUE }),
		]

		for (const shape of shapes) {
			const guard = compileGuard(shape)
			const value = compileGenerator(shape, () => 0.5)
			expect(Number.isFinite(value)).toBe(true)
			expect(guard(value)).toBe(true)
		}
	})

	it('uses a span-relative synthetic range for one-sided number and integer bounds', () => {
		const shapes = [numberShape({ min: 500 }), integerShape({ max: -500 })]

		for (const shape of shapes) {
			const first = compileGenerator(shape, () => 0)
			const second = compileGenerator(shape, () => 0.5)
			expect(first).not.toBe(second)
			expect(compileGuard(shape)(first)).toBe(true)
			expect(compileGuard(shape)(second)).toBe(true)
		}
	})

	it('rotates through union and oneOf variants so an ungeneratable first variant cannot starve siblings', () => {
		expect(compileGenerator(unionShape(rawShape({}), literalShape(['ok'])), () => 0)).toBe('ok')
		expect(
			compileGenerator(
				oneOfShape(stringShape({ min: 1, pattern: /^z$/ }), literalShape([1])),
				() => 0,
			),
		).toBe(1)
	})

	it('reports an out-of-range random source distinctly from union exhaustion', () => {
		const error = captureContractError(() =>
			compileGenerator(unionShape(stringShape(), integerShape()), () => 1),
		)

		expect(error.code).toBe('random')
		expect(error.context).toEqual({
			shape: 'union',
			limit: '[0, 1)',
			received: '1',
		})
	})

	it('propagates invalid and throwing random samples from inside a union variant', () => {
		let invalidDraw = 0
		const invalid = captureContractError(() =>
			compileGenerator(unionShape(stringShape(), nullShape()), () => {
				invalidDraw += 1
				return invalidDraw === 1 ? 0 : 1
			}),
		)
		let throwingDraw = 0
		const throwing = captureContractError(() =>
			compileGenerator(unionShape(stringShape(), nullShape()), () => {
				throwingDraw += 1
				if (throwingDraw > 1) throw new Error('later draw')
				return 0
			}),
		)

		expect(invalid.code).toBe('random')
		expect(invalid.context?.shape).toBe('string')
		expect(throwing.code).toBe('random')
		expect(throwing.context?.shape).toBe('string')
	})

	it('distinguishes shared-gate failures from direct generator failures', () => {
		const generation: readonly ContractShape[] = [
			stringShape({ min: 1, pattern: /^z$/ }),
			rawShape({}),
		]

		for (const shape of generation) {
			const error = captureContractError(() => compileGenerator(shape, () => 0))
			expect(error.code).toBe('generate')
			expect(error.context?.shape).toBe(shape.type)
		}
		const malformed: readonly ContractShape[] = [
			JSON.parse('{"type":"literal","values":[]}'),
			JSON.parse('{"type":"union","variants":[]}'),
		]
		for (const shape of malformed) {
			const error = captureContractError(() => compileGenerator(shape, () => 0))
			expect(error.code).toBe('empty')
			expect(error.context?.shape).toBe(shape.type)
		}
	})

	it('throws generate when no oneOf candidate can satisfy the compiled guard', () => {
		const shape = oneOfShape(literalShape(['same']), literalShape(['same']))

		expect(() => compileGenerator(shape, seededRandom(1))).toThrowError(ContractError)
		const error = captureContractError(() => compileGenerator(shape, seededRandom(1)))
		expect(isContractError(error)).toBe(true)
		expect(error.code).toBe('generate')
	})

	it('throws on a raw shape (cannot be auto-generated)', () => {
		expect(() => compileGenerator(rawShape({ type: 'string' }), seededRandom(1))).toThrow(
			'compileGenerator: a raw shape embeds an arbitrary JSON Schema and cannot be auto-generated — supply values another way',
		)
	})

	it('an open recordShape generates at least one synthetic entry and passes its own guard', () => {
		const shape = recordShape(integerShape())
		const guard = compileGuard(shape)
		for (let seed = 0; seed < 20; seed += 1) {
			const value = compileGenerator(shape, seededRandom(seed))
			expect(isRecord(value)).toBe(true)
			const record = isRecord(value) ? value : {}
			expect(Object.keys(record).length).toBeGreaterThan(0)
			expect(guard(value)).toBe(true)
		}
	})
})

describe('createContract', () => {
	it('bundles schema / is / parse / generate from one shape', () => {
		const contract = createContract(
			objectShape({ name: stringShape({ min: 1 }), age: integerShape() }),
		)
		expect(contract.schema).toEqual({
			type: 'object',
			properties: {
				name: { type: 'string', minLength: 1 },
				age: { type: 'integer' },
			},
			required: ['name', 'age'],
			additionalProperties: false,
		})
		expect(contract.is({ name: 'Ada', age: 36 })).toBe(true)
		expect(contract.is({ name: 'Ada', age: 36.5 })).toBe(false)
		expect(contract.parse({ name: 'Ada', age: '36' })).toEqual({
			name: 'Ada',
			age: 36,
		})
		// The generator's output satisfies the contract's own guard.
		expect(contract.is(contract.generate(seededRandom(3)))).toBe(true)
	})

	it('owns one immutable snapshot of a hand-authored mutable shape graph', () => {
		const values: (string | number | boolean)[] = ['stable']
		const items = { type: 'literal', values } satisfies ContractShape
		const array = { type: 'array', items } satisfies ContractShape
		const variants: ContractShape[] = [array]
		const shape: ContractShape = { type: 'union', variants }
		const contract = createContract<ContractShape>(shape)
		const schema = contract.schema

		values[0] = 'drift'
		array.items = { type: 'literal', values: ['drift'] }
		variants[0] = { type: 'number' }

		expect(contract.schema).toBe(schema)
		expect(contract.schema).toEqual({
			anyOf: [{ type: 'array', items: { enum: ['stable'] } }],
		})
		expect(contract.is(['stable'])).toBe(true)
		expect(contract.is(['drift'])).toBe(false)
		expect(contract.parse(['stable'])).toEqual(['stable'])
		expect(contract.parse(['drift'])).toBeUndefined()
		expect(contract.is(contract.generate(seededRandom(4)))).toBe(true)
		expect(contract.generate(seededRandom(4))).toEqual(['stable'])
	})

	it('exposes a deeply frozen schema artifact that cannot drift from compiled behavior', () => {
		const contract = createContract(objectShape({ value: stringShape() }))

		expect(Object.isFrozen(contract.schema)).toBe(true)
		expect(Object.isFrozen(contract.schema.properties)).toBe(true)
		expect(Object.isFrozen(contract.schema.properties?.value)).toBe(true)
		expect(Reflect.set(contract.schema, 'type', 'number')).toBe(false)
		expect(contract.schema.type).toBe('object')
		expect(contract.is({ value: 'stable' })).toBe(true)
	})

	it('carries Infer<S> end-to-end from a recordShape (finding #7)', () => {
		const c = createContract(recordShape(numberShape()))
		const parsed = c.parse({})
		expect(parsed).toBeDefined()
		const record = parsed ?? {}
		const one: number | undefined = record.k
		expect(one).toBeUndefined()
		// @ts-expect-error — generate returns a number-valued record, not a string-valued one
		const bad: Readonly<Record<string, string>> = c.generate()
		expect(bad).toBeDefined()
	})
})

describe('compiler shape ownership', () => {
	it('owns an unfrozen caller graph at every compiler entry point', () => {
		const values: (string | number | boolean)[] = ['stable']
		const items: ContractShape = { type: 'literal', values }
		const shape: ContractShape = { type: 'array', items }

		const schema = compileSchema(shape)
		const guard = compileGuard(shape)
		const parse = compileParser(shape)
		const generated = compileGenerator(shape, seededRandom(7))
		const faults = compileReporter(shape, ['drift'])

		values[0] = 'drift'

		expect(schema).toEqual({ type: 'array', items: { enum: ['stable'] } })
		expect(guard(['stable'])).toBe(true)
		expect(guard(['drift'])).toBe(false)
		expect(parse(['stable'])).toEqual(['stable'])
		expect(parse(['drift'])).toBeUndefined()
		expect(guard(generated)).toBe(true)
		expect(faults).toHaveLength(1)
	})
})

describe('compileGuard generic overload (finding #4)', () => {
	it('narrows a Guard<Infer<S>> when the shape is a specific literal type', () => {
		const g = compileGuard(objectShape({ name: stringShape() }))
		const x: unknown = { name: 'Ada' }
		expect(g(x)).toBe(true)
		const guarded = g(x) ? x : { name: '' }
		const nm: string = guarded.name
		expect(nm).toBe('Ada')
	})
})

describe('compileParser generic overload (finding #5)', () => {
	it('narrows a Parser<Infer<S>> when the shape is a specific literal type', () => {
		const p = compileParser(recordShape(numberShape()))
		const r = p({})
		const val: Readonly<Record<string, number>> | undefined = r
		expect(val).toBeDefined()
		// @ts-expect-error — parser result is a record, not string
		const wrong: string | undefined = r
		expect(wrong).toBeDefined()
	})
})

describe('compileGenerator generic overload (finding #6)', () => {
	it('narrows to Infer<S> when the shape is a specific literal type', () => {
		const gen = compileGenerator(objectShape({ age: integerShape() }))
		const a: number = gen.age
		expect(a).toBeDefined()
	})
})

describe('shape separation registry', () => {
	it('demonstrates every declared parser-versus-guard separation', () => {
		let count = 0
		for (const separation of Object.values(SHAPE_SEPARATIONS)) {
			if (separation.witness === undefined) continue
			count += 1
			const parse = compileParser(separation.shape)
			const guard = compileGuard(separation.shape)

			expect(parse(separation.witness)).not.toBeUndefined()
			expect(guard(separation.witness)).toBe(false)
			expect(compileAuditor(separation.shape, separation.witness).length).toBeGreaterThan(0)
			expect(compileReporter(separation.shape, separation.witness)).toHaveLength(0)
		}
		expect(count).toBe(9)
	})

	it('finds no corpus witness for source-argued coincident domains', () => {
		let count = 0
		let refusals = 0
		let uncoded = 0
		for (const separation of Object.values(SHAPE_SEPARATIONS)) {
			if (separation.witness !== undefined) continue
			count += 1
			const parse = compileParser(separation.shape)
			const guard = compileGuard(separation.shape)
			const witnesses: unknown[] = []
			for (const value of SOUNDNESS_SAMPLE) {
				const parsed = attempt(() => parse(value))
				if (!parsed.success) {
					if (!isContractError(parsed.error)) uncoded += 1
					refusals += 1
					continue
				}
				if (parsed.value !== undefined && !guard(value)) witnesses.push(value)
			}
			expect(witnesses).toEqual([])
		}
		expect(count).toBe(3)
		expect(uncoded).toBe(0)
		expect(refusals).toBeGreaterThan(0)
	})

	it('validates and compiles representatives for all twelve shape kinds', () => {
		expect(Object.keys(SHAPE_SEPARATIONS)).toHaveLength(12)
		for (const separation of Object.values(SHAPE_SEPARATIONS)) {
			expect(() => validateShape(separation.shape)).not.toThrow()
			expect(() => validateShapeDepth(separation.shape)).not.toThrow()
			const schema = compileSchema(separation.shape)
			const guard = compileGuard(separation.shape)
			const parse = compileParser(separation.shape)
			expect(schema).toBeDefined()
			expect(guard).toBeTypeOf('function')
			expect(parse).toBeTypeOf('function')
			expect(compileAuditor(separation.shape, null)).toBeInstanceOf(Array)
			expect(compileReporter(separation.shape, null)).toBeInstanceOf(Array)
		}

		const raw = SHAPE_SEPARATIONS.raw
		const rawGuard = compileGuard(raw.shape)
		const rawParse = compileParser(raw.shape)
		expect(rawGuard(null)).toBe(true)
		expect(rawParse(null)).toBeNull()
		expect(compileAuditor(raw.shape, null)).toHaveLength(0)
		expect(compileReporter(raw.shape, null)).toHaveLength(0)
		const error = captureContractError(() => compileGenerator(raw.shape, seededRandom(7)))
		expect(error.code).toBe('generate')

		const generatedEntries = Object.entries(SHAPE_SEPARATIONS).filter(([type]) => type !== 'raw')
		for (const [, separation] of generatedEntries) {
			const guard = compileGuard(separation.shape)
			const parse = compileParser(separation.shape)
			const generated = compileGenerator(separation.shape, seededRandom(7))
			expect(generated).not.toBeUndefined()
			expect(guard(generated)).toBe(true)
			expect(parse(generated)).not.toBeUndefined()
			expect(compileAuditor(separation.shape, generated)).toHaveLength(0)
			expect(compileReporter(separation.shape, generated)).toHaveLength(0)
		}
	})
})
