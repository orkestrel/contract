import type { ContractShape, JSONRecord, JSONSchema, JSONValue, StringShape } from './types.js'
import { INTRINSICS } from './constants.js'
import { ContractError, isContractError } from './errors.js'
import { attempt, contain, holds } from './helpers.js'
import { isRecord } from './validators.js'
import { JSONCloner } from './JSONCloner.js'
import { SchemaCloner } from './SchemaCloner.js'
import { ShapeValidator } from './ShapeValidator.js'
import { ShapeCloner } from './ShapeCloner.js'

/**
 * Deep-clones exact JSON data into an owned frozen snapshot.
 *
 * @remarks
 * Traverses iteratively so deeply nested input cannot exhaust the call stack.
 * Repeated noncyclic aliases are duplicated because JSON persistence represents
 * a tree, while a structural back-edge on the active path is rejected as a
 * cycle. Arrays are rebuilt as standard dense arrays and records as
 * null-prototype objects; every produced node is frozen after its children are
 * wired. Array keys must be exactly `length` plus every canonical index.
 * Writable and configurable index flags are normalized rather than treated as
 * JSON data, so frozen arrays remain valid. Property descriptors are inspected
 * without reading values through accessors, and every hostile reflective
 * operation is contained before a new clone-coded error is exposed.
 * Each call creates a fresh {@link JSONCloner}; use the class directly when
 * terminal success or failure identity must be replayed without another read.
 *
 * @param value - The unknown value to validate and snapshot
 * @returns The primitive unchanged, or a deeply cloned and frozen JSON graph
 * @throws {ContractError} When the value is not exact acyclic JSON data or traversal fails
 *
 * @example
 * ```ts
 * const source = { settings: { enabled: true } }
 * const clone = cloneJSONValue(source)
 * source.settings.enabled = false
 * clone // { settings: { enabled: true } }
 * ```
 */
export function cloneJSONValue(value: unknown): JSONValue {
	return contain(() => {
		return new JSONCloner(value).clone()
	}, 'cloneJSONValue')
}

/**
 * Deep-clones an exact JSON object record into an owned frozen snapshot.
 *
 * @remarks
 * Adds a record-root boundary to {@link cloneJSONValue}. The output is a
 * deeply frozen null-prototype record, and repeated noncyclic aliases are
 * duplicated as independent JSON tree branches.
 *
 * @param value - The unknown record value to validate and snapshot
 * @returns A deeply cloned and frozen JSON record
 * @throws {ContractError} When the root is not a record, nested data is inexact, or traversal fails
 *
 * @example
 * ```ts
 * cloneJSONRecord({ attempt: 1 }) // frozen null-prototype record
 * ```
 */
export function cloneJSONRecord(value: unknown): JSONRecord {
	return contain(() => {
		if (!isRecord(value)) {
			throw new ContractError('cloneJSONRecord: value is not a plain record', {
				code: 'clone',
				context: { shape: 'json' },
			})
		}
		const clone = cloneJSONValue(value)
		if (!isRecord(clone)) {
			throw new ContractError('cloneJSONRecord: cloned value is not a record', {
				code: 'clone',
				context: { shape: 'json' },
			})
		}
		return clone
	}, 'cloneJSONRecord')
}

/**
 * Deep-clones a JSON Schema graph into an owned frozen snapshot.
 *
 * @remarks
 * Walks arrays and records iteratively with a memo, preserving shared
 * references and closing cyclic edges onto their cloned nodes. Primitive
 * values and own enumerable string-keyed edges are copied; record nodes use
 * null prototypes, arrays retain only their intrinsic array prototype, and
 * every produced object is frozen after its edges are wired. Hostile traversal
 * throws a clone-coded {@link ContractError}, never a caller-owned raw error.
 * Each call creates a fresh {@link SchemaCloner}; use the class directly when
 * terminal success or failure identity must be replayed without another read.
 *
 * @param schema - The JSON Schema graph to snapshot
 * @returns A deeply cloned and frozen JSON Schema graph
 * @throws {ContractError} When hostile schema traversal prevents ownership
 *
 * @example
 * ```ts
 * const child = { type: 'string' }
 * const clone = cloneSchema({ anyOf: [child, child] })
 * clone.anyOf?.[0] === clone.anyOf?.[1] // true
 * ```
 */
export function cloneSchema(schema: JSONSchema): JSONSchema {
	return contain(() => {
		return new SchemaCloner(schema).clone()
	}, 'cloneSchema')
}

/**
 * Deep-clones a contract shape graph into an owned frozen snapshot.
 *
 * @remarks
 * A fresh public {@link ShapeCloner} preserves shared-child identity while
 * building the candidate snapshot, owns raw schemas, validates the exact
 * completed root, applies deferred fidelity, and translates unexpected hostile
 * failures. Inside the engine, each node's own data discriminant and every
 * declared field are captured descriptor-first from two agreeing reads, and the
 * carried population alone supplies its shallow shell, semantic checks, child
 * scheduling, and later edge wiring. An inherited field is refused through a
 * non-invoking presence check, and a revealed accessor is refused without
 * invocation except for the builder's `pattern` contract: two fresh frozen
 * genuine `RegExp` values with equal source and flags are captured as owned
 * source/flags semantics.
 *
 * Literal and union members retain their own-index descriptor/repeated-read
 * checks; property entries retain descriptor/first/second agreement plus two
 * exactly equal ordered key populations; raw schemas delegate to
 * {@link cloneSchema}. Before return, a fresh {@link ShapeValidator} independently
 * validates the exact cloned root. Ownership never erases a structural edge or
 * normalizes an invalid scalar/bound into a plausible declaration: those
 * inputs throw their coded structure/bound error. Hostile traversal remains
 * distinct and throws a clone-coded {@link ContractError}.
 *
 * @param shape - The contract shape graph to snapshot
 * @returns A deeply cloned and frozen shape graph
 * @throws {ContractError} When the declaration cannot be copied faithfully or hostile shape or raw-schema traversal prevents ownership
 *
 * @example
 * ```ts
 * const child = arrayShape(stringShape())
 * const clone = cloneShape(objectShape({ first: child, second: child }))
 * clone.type === 'object' && clone.properties.first === clone.properties.second // true
 * ```
 */
export function cloneShape(shape: StringShape): StringShape
export function cloneShape(shape: ContractShape): ContractShape
export function cloneShape(shape: ContractShape): ContractShape {
	return contain(() => {
		return new ShapeCloner(shape).clone()
	}, 'cloneShape')
}

/**
 * Takes ownership of a contract shape node as an independent {@link cloneShape}
 * snapshot of its graph.
 *
 * @remarks
 * Every successful return is a deeply frozen caller-independent graph, and
 * "frozen" here means frozen by the `Object.freeze` this package captured while
 * it loaded, not by whatever `Object.freeze` names when the call is made. The
 * distinction is the whole guarantee: under `Object.freeze = (value) => value`
 * this door used to SUCCEED and publish a mutable graph, with no throw and no
 * signal a caller could read. A frozen caller root receives no identity
 * exception: shallow freezing cannot establish ownership of nested collections,
 * child nodes, raw schemas, or `RegExp` internal state, and the fidelity clone
 * has already paid the traversal cost needed to prove and carry those values.
 *
 * @param shape - The contract shape to own
 * @returns A deeply cloned frozen snapshot
 * @throws {ContractError} When the declaration cannot be copied faithfully, when hostile shape or raw-schema traversal prevents ownership, or when a frozen root fails validation
 *
 * @example
 * ```ts
 * const authored = stringShape()
 * ownShape(authored) === authored // false
 * ```
 */
export function ownShape(shape: ContractShape): ContractShape {
	return contain(() => {
		const frozen = holds(() => INTRINSICS.frozen(shape))
		const fidelity = attempt(() => cloneShape(shape))
		if (fidelity.success) return fidelity.value
		if (isContractError(fidelity.error) && fidelity.error.code !== 'clone') {
			throw fidelity.error
		}
		if (!frozen) throw fidelity.error
		const validation = attempt(() => new ShapeValidator(shape).validate())
		if (!validation.success && isContractError(validation.error)) throw validation.error
		throw fidelity.error
	}, 'ownShape')
}
