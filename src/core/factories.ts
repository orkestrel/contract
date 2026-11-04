import type { ContractInterface, ContractShape, Infer } from './types.js'
import { contain } from './helpers.js'
import { ContractCompiler } from './ContractCompiler.js'
import { LazyContract } from './LazyContract.js'
import { ShapePass } from './ShapePass.js'

// The entity door over the compiler engine. Every other door in `compilers.ts`
// requests one artifact root and returns that artifact; this one returns the
// live `ContractInterface` bundle, which is an entity rather than a compiled
// projection, so it sits in the factory kind file its `create*` form names.

/**
 * Compiles a {@link ContractShape} into a {@link ContractInterface} — the
 * lockstep outputs from one declaration, lockstep meaning derived from one
 * owned snapshot rather than accepting the same values.
 *
 * @remarks
 * Creates ONE {@link ContractCompiler} and returns that compiler's exact
 * `contract` bundle. One ownership population governs the whole contract: the
 * declaration is owned once through {@link ownShape}, that owned graph is
 * validated once, and every artifact is compiled from it. There is no
 * discarded pre-ownership pass over the caller's declaration and no second
 * snapshot — ownership already refuses a malformed structural slot, scalar
 * field, or bound rather than normalizing it, so a second walk of the caller's
 * live source only added a population that could disagree with the one the
 * artifacts actually use. A declaration made entirely by this package's builders
 * is frozen and validated all the way down already, so it is that owned graph.
 * Every artifact compiles once, so `audit`, `explain` and `generate` re-walk and
 * re-gate nothing on a later call; `contract.audit` and `compileAuditor` run the
 * same compiled plan reached by different names.
 * A declaration made entirely by builders compiles its schema at this call and
 * its function members together on the first call to any of them, so a module
 * can declare contracts as data and pay only for the ones it uses. Any other
 * declaration, and a bare leaf, compiles every member at this call. Either way
 * the members are plain data properties, so `const { is, parse } =
 * createContract(shape)` destructures those exact values, a spread of the result
 * copies them, and neither compiles anything. A malformed declaration refuses at
 * this call rather than at the first read of whichever member a caller happens
 * to touch, so the failure arrives at the call the caller made — carrying the
 * authoring door's own diagnosis, which this door adopts rather than rewraps.
 * Every compiled member is self-contained, and the compiler this call builds
 * releases its working set once every member has compiled. The contract keeps
 * part of the declaration even so: the auditor and reporter plans close over the
 * leaf and array nodes they read their bounds from, and a contract with deferred
 * members retains its declaration. Nothing the caller keeps reaches back into the
 * compiler. A deferred member compiled on a host whose members were replaced after
 * this call would outlive the replacement, so it refuses to compile until they are
 * restored: until then its guard answers `false`, its parser `undefined`, and its
 * diagnostics and generator refuse.
 *
 * @param shape - The shape to compile
 * @returns A contract bundling `schema` / `is` / `parse` / `audit` / `explain` / `generate`
 *
 * @example Compiling a contract
 * ```ts
 * import {
 * 	createContract,
 * 	integerShape,
 * 	objectShape,
 * 	seededRandom,
 * 	stringShape,
 * } from '@orkestrel/contract'
 *
 * const user = createContract(objectShape({ name: stringShape({ min: 1 }), age: integerShape() }))
 *
 * user.is({ name: 'Ada', age: 36 }) // true — a typed guard (narrows to Infer<typeof shape>)
 * user.parse({ name: 'Ada', age: '36' }) // { name: 'Ada', age: 36 } — coerces, or undefined
 * user.parse({ name: '', age: 36 }) // undefined — '' violates name min:1 (parse enforces refinements, like is)
 * user.explain({ name: '', age: 36 }) // [{ reason: 'constraint', path: ['name'], expected: 'string', constraint: 'min', limit: 1, received: '""' }]
 * user.schema // the owned, deeply frozen { type: 'object', properties: { … }, required: ['name', 'age'], additionalProperties: false }
 * user.generate(seededRandom(42)) // reproducible seed data; omit the arg for a wall-clock-seeded source
 * ```
 */
export function createContract<S extends ContractShape>(shape: S): ContractInterface<Infer<S>>
export function createContract(shape: ContractShape): ContractInterface<unknown>
export function createContract(shape: ContractShape): ContractInterface<unknown> {
	return contain(() => {
		const compiler = new ContractCompiler(shape)
		const expansion = ShapePass.expansionOf(shape)
		if (expansion === undefined || expansion === 1) return compiler.contract
		return new LazyContract(shape, compiler).publish(compiler.schema)
	}, 'createContract')
}
