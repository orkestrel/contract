import type {
	AuditFault,
	ContractShape,
	Fault,
	Guard,
	Infer,
	JSONSchema,
	Parser,
	RandomFunction,
} from './types.js'
import { contain, refuseExpansion } from './helpers.js'
import { ContractCompiler } from './ContractCompiler.js'
import { ShapeValidator } from './ShapeValidator.js'

// The public function boundaries over two engines. `ShapeValidator` owns the
// stateful declaration walk; `ContractCompiler` owns ownership, preparation and
// the six artifact families. Each function below is a real typed door — its own
// overloads, its own containment, its own diagnostics — that requests exactly
// the root it is named for and nothing else, so asking for a guard never
// compiles a generator. Recursion lives in the compiler, not here: the earlier
// shape of this module re-entered its own public functions per node, which
// re-owned and re-validated the subgraph at every level.

// === Validation

/**
 * Gates recursive compiler work on shape structure, depth, and cycles.
 *
 * @remarks
 * Constructs a fresh {@link ShapeValidator} and eagerly validates the graph.
 * The validator walks iteratively with explicit stack space and observes each
 * unique node exactly ONCE per call, so a shared-child DAG costs its AUTHORED
 * nodes and edges rather than its paths. Every incoming edge is still inspected:
 * where an `optional` node is legal depends on the slot it arrived through, and
 * depth is measured over the captured graph afterwards rather than by walking
 * each path.
 *
 * This is also where the compilers' expansion bound lives. Every compiled
 * artifact is a tree, so a DAG's cost is the size of the tree it expands into —
 * `objectShape({ left: node, right: node })` nested thirty times is thirty-one
 * authored nodes and more than a billion emitted ones. The validator counts
 * that expansion and {@link refuseExpansion} refuses past
 * {@link COMPILE_NODE_LIMIT} with an `expansion`-coded {@link ContractError}, so
 * every standalone compiler and {@link createContract} answer a shared-child
 * declaration in bounded time instead of not answering. {@link cloneShape} /
 * {@link ownShape} are deliberately NOT bounded by it: they preserve
 * shared-child identity, so ownership of the same declaration stays
 * proportional to its authored nodes.
 * Every structural child slot must contain a shape node before it can enter the
 * walk; every scalar field must hold its declared runtime domain before a
 * compiler can use it; and a missing child, corrupt container, inherited
 * discriminant, or unrecognized node reports `structure`. This is the SOLE
 * eager well-formedness pass — there is no second prepass and no alias for it:
 * it enforces every bound domain and range used by the artifacts, including
 * non-empty literal/union vocabularies, finite literal numbers, integer-range
 * satisfiability, unflagged string patterns, optional-shape placement, and the
 * recursively supported raw-schema vocabulary where every present property or
 * dense union member is a record.
 * Active ancestors are tracked so shared children remain legal. Every
 * standalone compiler reaches this same validation once, over its owned
 * snapshot, through {@link ContractCompiler} preparation.
 * Failures have deterministic precedence independent of traversal order: depth,
 * then structure, then cycle, then field and vocabulary policy.
 *
 * @param shape - The shape graph to gate
 * @returns Nothing; successful return means recursive compilation is structurally safe, depth-safe, and bounded in emitted nodes
 * @throws {ContractError} When a node or structural slot is corrupt, a bound or vocabulary is outside its declared domain, the graph is cyclic, it exceeds the compilation depth limit, or it expands past the compilation node limit
 *
 * @example
 * ```ts
 * validateShape(stringShape({ min: 1 })) // returns; the declaration is compilable
 * ```
 */
export function validateShape(shape: ContractShape): void {
	return contain(() => {
		const validator = new ShapeValidator(shape)
		validator.validate()
		refuseExpansion(validator.expansion)
	}, 'validateShape')
}

// === Schema

/**
 * Compile a {@link ContractShape} into a JSON Schema document.
 *
 * @remarks
 * Object shapes emit `additionalProperties: false` (unless opened) and list only
 * required keys in `required`; nullable shapes emit an `anyOf` with `{ type:
 * 'null' }`. The result is an owned deeply frozen graph; raw schemas are cloned
 * rather than retained by reference. Emission only — it never inspects a
 * runtime value. It requests exactly the `schema` root of a fresh
 * {@link ContractCompiler}, so the declaration is owned once and validated once
 * and no other artifact family is built. Shared declaration identity survives
 * into the emitted document: two slots holding one authored node hold one
 * emitted subschema, while structurally equal distinct nodes stay distinct.
 *
 * @param shape - The shape to compile
 * @returns The emitted JSON Schema
 *
 * @example
 * ```ts
 * compileSchema(stringShape({ min: 1 })) // { type: 'string', minLength: 1 }
 * ```
 */
export function compileSchema(shape: ContractShape): JSONSchema {
	return contain(() => new ContractCompiler(shape).schema, 'compileSchema')
}

// === Guard

/**
 * Compile a {@link ContractShape} into a runtime type guard.
 *
 * @remarks
 * Reuses the combinators for structural and refined shapes, including
 * {@link literalOf} for SameValueZero literal matching. Compiled object shapes
 * observe own enumerable string keys through {@link enumerableKeys}, the same
 * key view their parser, reporter, auditor, and inference use for both open and
 * closed objects — the view is shared, the verdict on an undeclared key is not
 * (this guard rejects the object; the parser drops the key).
 * Like every guard it is total — it never throws (AGENTS §14). It requests
 * exactly the `guard` root of a fresh {@link ContractCompiler}, which owns the
 * declaration once through {@link ownShape} and validates that snapshot once,
 * so an unfrozen caller-owned graph compiles from a snapshot and excessive
 * nesting, cycles, and excessive expansion are rejected before any guard is
 * built.
 *
 * @param shape - The shape to compile
 * @returns A guard narrowing to the shape's inferred type
 *
 * @example
 * ```ts
 * const isUser = compileGuard(objectShape({ name: stringShape() }))
 * isUser({ name: 'Ada' }) // true
 * ```
 */
export function compileGuard<S extends ContractShape>(shape: S): Guard<Infer<S>>
export function compileGuard(shape: ContractShape): Guard<unknown>
export function compileGuard(shape: ContractShape): Guard<unknown> {
	return contain(() => new ContractCompiler(shape).guard, 'compileGuard')
}

// === Parser

/**
 * Compile a {@link ContractShape} into an input parser.
 *
 * @remarks
 * Reuses the leaf parsers (`parseString` / `parseInteger` / `parseNumber` /
 * `parseBoolean`) and coerces structurally. An object fails as a
 * whole on any required-field failure; a union returns a guard-valid value
 * unchanged, otherwise the first variant that both parses and guards wins.
 *
 * After coercing a leaf, it re-applies that leaf's REFINEMENTS through the same
 * combinators {@link compileGuard} uses — `stringOf` for a string's
 * length/pattern, `boundsOf` for a number's value and an array's length, and
 * {@link literalOf} for literal membership — so a value that coerces but
 * violates a bound parses to `undefined`. The result is full parse↔guard
 * soundness (AGENTS §14): a
 * non-`undefined` parse always satisfies the contract's `is`, refinements
 * included — a statement about the OUTPUT, never about the input, which may be
 * a value `is` rejects. Object presence and extra-key processing read the same
 * own-enumerable-string key view as the guard, reporter, auditor, and inference
 * — one key set, deliberately different verdicts: this parser drops an
 * undeclared key that {@link compileGuard} rejects and {@link compileAuditor}
 * faults. It requests exactly the `parser` root of a fresh
 * {@link ContractCompiler}, which owns and validates the declaration once; a
 * union's variant selection is a guard question, so a declaration containing one
 * also builds the compiler's guard plan.
 *
 * @param shape - The shape to compile
 * @returns A parser yielding the shape's inferred type or `undefined`
 *
 * @example
 * ```ts
 * const parseUser = compileParser(objectShape({ name: stringShape() }))
 * parseUser({ name: 'Ada' }) // { name: 'Ada' }
 * ```
 */
export function compileParser<S extends ContractShape>(shape: S): Parser<Infer<S>>
export function compileParser(shape: ContractShape): Parser<unknown>
export function compileParser(shape: ContractShape): Parser<unknown> {
	return contain(() => new ContractCompiler(shape).parser, 'compileParser')
}

// === Generator

/**
 * Compile a {@link ContractShape} into a deterministic seed value.
 *
 * @remarks
 * The same shape and the same `random` source always produce the same value, so
 * seed data is reproducible. Defaults to a {@link seededRandom} source seeded
 * from the wall clock when none is supplied. Shape-generation failures throw a
 * {@link ContractError} with code `'generate'`; {@link drawRandom} failures use
 * code `'random'` and retain the consuming shape category in context.
 * Failures include a pattern-constrained `stringShape` whose generated sample
 * cannot satisfy the pattern, an invalid random sample, and a `rawShape` whose
 * arbitrary embedded schema cannot be auto-generated. Degenerate empty
 * literal/union vocabularies fail earlier with the shared gate's `empty` code.
 * It requests exactly the `generator` root of a fresh
 * {@link ContractCompiler} and invokes it once, so the declaration is owned and
 * validated once before any draw. Union candidates are bounded by
 * {@link GENERATION_ATTEMPT_LIMIT} and accepted only when they satisfy the
 * union's compiled guard, which is why a declaration containing a union also
 * builds the compiler's guard plan.
 *
 * @param shape - The shape to generate from
 * @param random - A seeded random source (defaults to a wall-clock seed drawn inside the door's boundary)
 * @returns A value matching the shape
 * @throws {ContractError} When the shape or random source cannot produce a valid value
 *
 * @example
 * ```ts
 * compileGenerator(stringShape({ min: 1, max: 4 })) // a random string of 1-4 characters (seed a RandomFunction for determinism)
 * ```
 */
export function compileGenerator<S extends ContractShape>(
	shape: S,
	random?: RandomFunction,
): Infer<S>
export function compileGenerator(shape: ContractShape, random?: RandomFunction): unknown
export function compileGenerator(shape: ContractShape, random?: RandomFunction): unknown {
	return contain(() => new ContractCompiler(shape).generator(random), 'compileGenerator', {
		code: 'generate',
	})
}

// === Reporter

/**
 * Compile a {@link ContractShape} into a structured fault report for a value —
 * the diagnostic counterpart of {@link compileGuard} / {@link compileParser}.
 *
 * @remarks
 * MIRROR-PARSE semantics: reuses the exact leaf parsers/guards
 * {@link compileParser} uses (`parseString` / `parseNumber` / `parseBoolean` /
 * `isJSONValue` / …), so the soundness invariant
 * `compileReporter(shape, v).length === 0 ⟺ compileParser(shape)(v) !== undefined`
 * holds structurally — `explain` mirrors `parse`, not the stricter `is` (a
 * coercible value like `'42'` against a `numberShape` reports no fault, the
 * same leniency `parse` grants, even though the strict guard would reject it).
 * The invariant relates two separate calls, so it holds for a value whose reads
 * are stable across calls; see the read-stability precondition on
 * {@link ContractInterface}. {@link compileAuditor} is the counterpart report
 * for the strict domain, mirroring {@link compileGuard} the way this one
 * mirrors {@link compileParser}.
 *
 * Faults are collected in stable pre-order (declared key/index order); every
 * call — object, array, and union alike, including a union's `oneOf` "no
 * match" / "no consensus" summary fault prepended to its closest variant's
 * faults — slices its return to at most {@link FAULT_LIMIT} entries, so the
 * bound holds at every level of nesting, not just the outermost container, on
 * adversarial input (a huge array, a wide record, a wide union of wide
 * records). A closed object's extra keys never
 * fault — `parse` silently drops them, so `explain` mirrors that leniency, and
 * {@link compileAuditor} is where they do fault; an open object with a
 * constraining `additionalProperties` shape recurses extras against it instead.
 * A hostile getter or throwing `Proxy` trap is contained via {@link attempt}
 * and surfaces as a single top-level type fault, never a throw (AGENTS §14).
 * It requests exactly the `reporter` root of a fresh {@link ContractCompiler}
 * and applies it once, so one call owns and validates the declaration once
 * rather than re-gating every node it descends into. Reuse the compiler (or a
 * contract's `explain`) when many values are reported against one shape.
 *
 * @param shape - The shape to report against
 * @param value - The value to check
 * @param path - The path prefix for faults produced at this call (defaults to the root)
 * @returns The faults found, empty when the value parses successfully
 *
 * @example
 * ```ts
 * const user = objectShape({ name: stringShape({ min: 1 }) })
 * compileReporter(user, { name: '' })
 * // [{ reason: 'constraint', path: ['name'], expected: 'string', constraint: 'min', limit: 1, received: '""' }]
 * compileReporter(user, { name: 'Ada' }) // []
 * ```
 */
export function compileReporter(
	shape: ContractShape,
	value: unknown,
	path: readonly string[] = [],
): readonly Fault[] {
	return contain(() => new ContractCompiler(shape).reporter(value, path), 'compileReporter')
}

/**
 * Audit a value against the strict acceptance domain of a {@link ContractShape}.
 *
 * @remarks
 * The diagnostic for the domain {@link compileGuard} and {@link compileSchema}
 * describe, where {@link compileReporter} diagnoses the wider preimage
 * {@link compileParser} maps into it. This walk therefore mirrors the guard:
 * leaf coercions are faults, closed-object extras are faults, and union
 * acceptance is decided from each variant's strict audit emptiness, so the
 * soundness invariant
 * `compileAuditor(shape, v).length === 0 ⟺ compileGuard(shape)(v)` holds
 * structurally. The shared declaration gate rejects structural and bound-domain
 * malformations before either artifact is built, so the invariant is only
 * evaluated for a valid declaration. The invariant relates two
 * separate calls, so it holds for a value whose reads are stable across calls;
 * see the read-stability precondition on {@link ContractInterface}. Every
 * recursive call returns at most {@link FAULT_LIMIT} entries. Hostile property
 * access raises the shared coded read refusal with the current container path
 * and shape, so unreadability never masquerades as a type mismatch.
 * It requests exactly the `auditor` root of a fresh {@link ContractCompiler}
 * and applies it once; reuse the compiler (or a contract's `audit`) when many
 * values are audited against one shape.
 *
 * @param shape - The shape to audit against
 * @param value - The value to check
 * @param path - The path prefix for faults produced at this call
 * @returns The strict faults found, empty exactly when the compiled guard accepts a stably-read value
 *
 * @example
 * ```ts
 * const user = objectShape({ name: stringShape() })
 * compileAuditor(user, { name: 'Ada', extra: true })
 * // [{ reason: 'extra', path: ['extra'] }]
 * ```
 */
export function compileAuditor(
	shape: ContractShape,
	value: unknown,
	path: readonly string[] = [],
): readonly AuditFault[] {
	return contain(() => new ContractCompiler(shape).auditor(value, path), 'compileAuditor')
}
