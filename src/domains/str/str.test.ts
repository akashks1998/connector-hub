import { DomainPack } from '../../spec/index.js'
import { expect, it } from 'vitest'
import { strDomain } from './index.js'

it('is a valid domain pack', () => {
  expect(DomainPack.safeParse(strDomain).success).toBe(true)
})
