import type {
	AuditorFunction,
	ContractInterface,
	ContractRefusal,
	ContractShape,
	Guard,
	OwnerFunction,
	Parser,
	RandomFunction,
	ReporterFunction,
	Result,
	SeederFunction,
} from './types.js'
import { INTRINSICS } from './constants.js'
import { ContractError } from './errors.js'
import { attempt, contain, failure, isFailure } from './helpers.js'
import { ContractCompiler } from './ContractCompiler.js'
import { ShapePass } from './ShapePass.js'

/**
 * Owns a contract whose function members compile together on the first call to any.
 *
 * @remarks
 * For a declaration made entirely by builders, where preparation and the schema have
 * already asked everything that can refuse. A module that declares its contracts as
 * data then pays for a contract only when something uses it, and each member is a
 * plain function with one identity, so destructuring and spreading compile nothing.
 *
 * A compile can still fail for the host's reasons: a first call near the stack limit,
 * or a host whose members were replaced after this contract was created, which it
 * refuses to compile on since the result would outlive the replacement. Neither says
 * anything about a later call, which compiles afresh. Until then a guard answers
 * `false`, a parser `undefined`, and `own` a refusal carrying the failure as its
 * cause, and the diagnostic and seed members publish the failure as their doors do.
 */
export class LazyContract {
	readonly #shape: ContractShape
	#pending: ContractCompiler | undefined
	#settled: ContractCompiler | undefined
	#bundle: ContractInterface<unknown> | undefined

	/**
	 * Retains a declaration and the compiler already prepared from it.
	 *
	 * @param shape - The sealed declaration
	 * @param compiler - The compiler that owns its prepared index
	 */
	constructor(shape: ContractShape, compiler: ContractCompiler) {
		this.#shape = shape
		this.#pending = compiler
	}

	/**
	 * Compiles the schema, which refuses a bad declaration, and publishes the bundle.
	 *
	 * @param schema - The schema the prepared compiler emitted
	 * @returns The frozen bundle, in the key order the compiler's own bundle uses
	 */
	publish(schema: ContractInterface<unknown>['schema']): ContractInterface<unknown> {
		return INTRINSICS.freeze({
			schema,
			is: this.#is(),
			parse: this.#parse(),
			audit: this.#audit(),
			explain: this.#explain(),
			generate: this.#generate(),
			own: this.#own(),
		})
	}

	#is(): Guard<unknown> {
		return (value: unknown): value is unknown => {
			const bundle = this.#bundle ?? this.#attempt()
			return bundle !== undefined && bundle.is(value)
		}
	}

	#parse(): Parser<unknown> {
		return (value: unknown): unknown => {
			const bundle = this.#bundle ?? this.#attempt()
			return bundle === undefined ? undefined : bundle.parse(value)
		}
	}

	#audit(): AuditorFunction {
		return (value: unknown, path: readonly string[] = []) =>
			(this.#settled ?? this.#settle('compileAuditor')).auditor(value, path)
	}

	#explain(): ReporterFunction {
		return (value: unknown, path: readonly string[] = []) =>
			(this.#settled ?? this.#settle('compileReporter')).reporter(value, path)
	}

	#generate(): SeederFunction<unknown> {
		return (random?: RandomFunction): unknown =>
			(this.#settled ?? this.#settle('compileGenerator')).generator(random)
	}

	// A compile that fails is a refusal like any other read failure, because `own` never throws.
	#own(): OwnerFunction<unknown> {
		return <V>(value: V): Result<V, ContractRefusal> => {
			const settled = attempt(() => this.#settled ?? this.#settle('own'))
			if (isFailure(settled)) return failure({ faults: [], cause: settled.error })
			return settled.value.owner(value)
		}
	}

	#attempt(): ContractInterface<unknown> | undefined {
		attempt(() => this.#settle('createContract'))
		return this.#bundle
	}

	// The pending compiler is dropped before it compiles, because a failure settles a
	// compiler for good, and this one must not answer a later call.
	#settle(door: string): ContractCompiler {
		return contain(() => {
			if (ShapePass.tampered()) {
				throw new ContractError(
					`${door}: a host member this contract compiles on was replaced after it was created`,
					{ code: 'structure', context: { path: [], shape: 'contract' } },
				)
			}
			const compiler = this.#pending ?? new ContractCompiler(this.#shape)
			this.#pending = undefined
			this.#bundle = compiler.contract
			this.#settled = compiler
			return compiler
		}, door)
	}
}
