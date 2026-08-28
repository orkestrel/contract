import type { ContractInterface, ContractShape, Infer } from './types.js'
import { contain } from './helpers.js'
import { ContractCompiler } from './ContractCompiler.js'

// The entity door over the compiler engine. Every other door in `compilers.ts`
// requests one artifact root and returns that artifact; this one returns the
// live `ContractInterface` bundle, which is an entity rather than a compiled
// projection, so it sits in the factory kind file its `create*` form names.

/**
 * Compile a {@link ContractShape} into a {@link ContractInterface} — the six
 * lockstep outputs from one declaration, lockstep meaning derived from one
 * owned snapshot rather than accepting the same values.
 *
 * @remarks
 * Creates ONE {@link ContractCompiler} and returns that compiler's exact
 * `contract` bundle. One ownership population governs the whole contract: the
 * declaration is owned once through {@link ownShape}, that owned graph is
 * validated once, and the six artifacts are compiled from it. There is no
 * discarded pre-ownership pass over the caller's declaration and no second
 * snapshot — ownership already refuses a malformed structural slot, scalar
 * field, or bound rather than normalizing it, so a second walk of the caller's
 * live source only added a population that could disagree with the one the
 * artifacts actually use.
 * All six artifacts are precompiled, so `audit`, `explain` and `generate` no
 * longer re-walk and re-gate the declaration on every call the way they used
 * to; `contract.audit` and `compileAuditor` are the same compiled function
 * reached two ways.
 *
 * @param shape - The shape to compile
 * @returns A contract bundling `schema` / `is` / `parse` / `audit` / `explain` / `generate`
 *
 * @example
 * ```ts
 * const user = createContract(objectShape({ name: stringShape(), age: integerShape() }))
 * user.is({ name: 'Ada', age: 36 })        // true
 * user.parse({ name: 'Ada', age: '36' })   // { name: 'Ada', age: 36 }
 * user.schema                              // { type: 'object', properties: { … }, … }
 * ```
 */
export function createContract<S extends ContractShape>(shape: S): ContractInterface<Infer<S>>
export function createContract(shape: ContractShape): ContractInterface<unknown>
export function createContract(shape: ContractShape): ContractInterface<unknown> {
	return contain(() => new ContractCompiler(shape).contract, 'createContract')
}
