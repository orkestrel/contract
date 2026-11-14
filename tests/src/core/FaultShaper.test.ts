import type { AuditFault, Infer, AuditFaultShape } from '@src/core'
import { auditFaultShape, createContract } from '@src/core'
import { FaultShaper } from '../../../src/core/FaultShaper.js'
import { describe, expect, expectTypeOf, it } from 'vitest'

describe('FaultShaper', () => {
	it('reuses the lazy declaration and builds independent equivalent declarations', () => {
		expect(auditFaultShape()).toBe(FaultShaper.shape)
		expect(auditFaultShape()).toBe(auditFaultShape())
		const fresh = new FaultShaper().build()
		expect(fresh).not.toBe(auditFaultShape())
		expect(fresh).toEqual(auditFaultShape())
		expect(createContract(fresh).is({ reason: 'extra', path: [] })).toBe(true)
		expectTypeOf<Infer<AuditFaultShape>>().toExtend<AuditFault>()
	})

	it('admits a type fault that expected a function', () => {
		expect(
			createContract(new FaultShaper().build()).is({
				reason: 'type',
				path: ['upgrade'],
				expected: 'function',
				received: '"migrate"',
			}),
		).toBe(true)
	})
})
