import { describe, expect, it } from 'vitest'
import { satisfies } from './version.js'

describe('satisfies', () => {
  it.each([
    ['1.4.0', '^1.2', true],
    ['2.0.0', '^1.2', false],
    ['1.1.9', '^1.2', false],
    ['0.1.5', '^0.1', true],
    ['0.2.0', '^0.1', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.0.0', '1.0.0', true],
    ['1.0.1', '1.0.0', false],
  ])('%s in %s → %s', (v, r, ok) => expect(satisfies(v, r)).toBe(ok))
})
