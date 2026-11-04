import type { AuditFaultShape } from './types.js'
import { FAULT_CONSTRAINTS, FAULT_KINDS } from './constants.js'
import { pinMembers } from './helpers.js'
import {
	arrayShape,
	booleanShape,
	integerShape,
	literalShape,
	numberShape,
	objectShape,
	optionalShape,
	stringShape,
	unionShape,
} from './shapers.js'

/**
 * Retains a lazily built fault declaration without building shapes during module evaluation.
 *
 * @example
 * ```ts
 * FaultShaper.shape === FaultShaper.shape // true
 * ```
 */
export class FaultShaper {
	static #shape: AuditFaultShape | undefined

	/** Returns the shared fault declaration, building it on the first read. */
	static get shape(): AuditFaultShape {
		return (FaultShaper.#shape ??= new FaultShaper().build())
	}

	/**
	 * Builds a closed fault union whose inferred values satisfy the audit fault contract.
	 *
	 * @example
	 * ```ts
	 * createContract(new FaultShaper().build()).is({ reason: 'extra', path: [] }) // true
	 * ```
	 */
	build() {
		const path = unionShape(stringShape(), arrayShape(stringShape()))
		const expected = literalShape(FAULT_KINDS)
		const hints = arrayShape(unionShape(stringShape(), numberShape(), booleanShape()))
		return unionShape(
			objectShape({ reason: literalShape(['type']), path, expected, received: stringShape() }),
			objectShape({ reason: literalShape(['missing']), path, expected }),
			objectShape({
				reason: literalShape(['constraint']),
				path,
				expected,
				constraint: literalShape(FAULT_CONSTRAINTS),
				limit: optionalShape(unionShape(numberShape(), stringShape())),
				received: stringShape(),
			}),
			objectShape({ reason: literalShape(['variant']), path, variants: integerShape({ min: 0 }) }),
			objectShape({
				reason: literalShape(['variant']),
				path,
				variants: integerShape({ min: 0 }),
				key: stringShape(),
				expected: hints,
			}),
			objectShape({ reason: literalShape(['oneOf']), path, matched: integerShape({ min: 0 }) }),
			objectShape({
				reason: literalShape(['oneOf']),
				path,
				matched: integerShape({ min: 0 }),
				key: stringShape(),
				expected: hints,
			}),
			objectShape({ reason: literalShape(['extra']), path }),
		)
	}

	static {
		pinMembers(FaultShaper.prototype, 'FaultShaper')
	}
}
