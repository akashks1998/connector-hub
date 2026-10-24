import { DomainPack } from '../../spec/index.js'
import { expect, it } from 'vitest'
import { contactsDomain } from './index.js'

it('is a valid domain pack', () => {
  expect(DomainPack.safeParse(contactsDomain).success).toBe(true)
})
