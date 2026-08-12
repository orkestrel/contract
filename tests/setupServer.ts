// Node-only test seams. `workspace.md`'s project matrix lists this file as
// `src:server`'s setup, and `vite.config.ts` honours that: no project loads it
// through `setupFiles`, and `src:core` still loads only `setup.ts`. Ten
// `src:core` test files nevertheless IMPORT it directly, which is stated here
// rather than left for a reader to infer from the import graph.
//
// The reason is that the boundary is unavoidable, not convenient. A genuine
// foreign realm and a real collection round are host seams; a core test that
// simulated either would be the behavioural fake the test rules forbid, and
// cross-realm acceptance plus release-before-publication are core claims that
// no host-independent construction can drive. The `src:core` project runs in a
// Node environment, so the import resolves; what it does NOT do is make
// `src/core` itself host-dependent, because nothing here is reachable from the
// published graph. The rule this sits beside governs which setup a project
// LOADS; a test's direct import of a host seam is the narrower thing, and it is
// confined to the assertions that genuinely need a host.
import { setImmediate } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import { setFlagsFromString } from 'node:v8'

/**
 * Request collection of weakly referenced objects from the real V8 collector.
 *
 * @param references - Weak references to request collection for
 * @returns A promise that settles after bounded pressure and collection rounds
 */
export async function requestWeakReferenceCollection(
	references: ReadonlyArray<WeakRef<object>>,
): Promise<void> {
	setFlagsFromString('--expose_gc')
	try {
		const collector: unknown = runInNewContext('gc')
		if (typeof collector !== 'function') throw new Error('expected an exposed collector')

		for (
			let round = 0;
			round < 40 && references.some((reference) => reference.deref() !== undefined);
			round += 1
		) {
			await setImmediate()
			const pressure = Array.from({ length: 2_000 }, () => new Uint8Array(4_096))
			Reflect.apply(collector, undefined, [])
			pressure.length = 0
		}
	} finally {
		setFlagsFromString('--no-expose_gc')
	}
}

export function createForeignRegExp(source: string, flags = ''): unknown {
	return runInNewContext('new RegExp(source, flags)', { flags, source })
}

/**
 * Create a minimal string declaration in a genuine foreign JavaScript realm.
 *
 * @returns A foreign-realm `{ type: 'string' }` record as `unknown`
 */
export function createForeignStringShape(): unknown {
	return runInNewContext("({ type: 'string' })")
}

/**
 * Create a fresh foreign JavaScript realm's own `Object.prototype`.
 *
 * @remarks
 * Every call builds a new realm, so a test may install an inherited member on
 * the returned prototype without polluting this realm's `Object.prototype` or
 * any other fixture's.
 *
 * @returns A genuine foreign realm's `Object.prototype`
 * @throws {Error} When the foreign realm does not yield an object prototype
 *
 * @example
 * ```ts
 * Object.setPrototypeOf(node, createForeignPrototype()) // still a plain record
 * ```
 */
export function createForeignPrototype(): object {
	const prototype: unknown = runInNewContext('Object.prototype')
	if (typeof prototype !== 'object' || prototype === null) {
		throw new Error('createForeignPrototype: expected a foreign object prototype')
	}
	return prototype
}

/**
 * Create an ordinary record in a genuine foreign JavaScript realm.
 *
 * @returns A foreign-realm `{ value: 1 }` record as `unknown`
 *
 * @example
 * ```ts
 * isRecord(createForeignRecord()) // true
 * ```
 */
export function createForeignRecord(): unknown {
	return runInNewContext('({ value: 1 })')
}
