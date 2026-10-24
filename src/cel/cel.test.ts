import { describe, expect, it } from 'vitest'
import { CelEnvironment, ExpressionError } from './index.js'

const env = new CelEnvironment({ variables: { record: 'map', row: 'map', config: 'map', batch: 'map' } })

describe('compile', () => {
  it('lists the paths an expression reads', () => {
    const e = env.compile('has(record.code) ? record.code : "HA-" + string(record.id)')
    expect([...e.refs].sort()).toEqual(['record.code', 'record.id'])
  })

  it('follows string index access as a path', () => {
    expect([...env.compile('record["first-name"] + row.city').refs].sort()).toEqual(['record.first-name', 'row.city'])
  })

  it('records comprehension variables as paths into the list', () => {
    expect([...env.compile('batch.changes.map(c, c.row.price)').refs]).toEqual(['batch.changes', 'batch.changes[].row.price'])
  })

  it('rejects undeclared variables', () => {
    expect(() => env.compile('secret.token')).toThrow(ExpressionError)
  })

  it('rejects nested comprehensions', () => {
    expect(() => env.compile('batch.changes.map(c, record.items.map(i, i))')).toThrow(/nested "map"/)
  })

  it('rejects oversized expressions', () => {
    const big = Array.from({ length: 400 }, (_, i) => `record.f${i}`).join(' + ')
    expect(() => env.compile(big)).toThrow(ExpressionError)
  })
})

describe('evaluate', () => {
  it('treats integral JSON numbers as int and returns plain numbers', () => {
    expect(env.compile('record.rate / 100').evaluate({ record: { rate: 1250 } })).toBe(12)
    expect(env.compile('record.rate * 2.0').evaluate({ record: { rate: 1.5 } })).toBe(3)
  })

  it('converts money exactly', () => {
    expect(env.compile('toMinor(record.price, 2)').evaluate({ record: { price: 12.34 } })).toBe(1234)
    expect(() => env.compile('toMinor(record.price, 2)').evaluate({ record: { price: 12.345 } })).toThrow(/decimal places/)
    expect(env.compile('fromMinor(row.minor, 2)').evaluate({ row: { minor: 1999 } })).toBe(19.99)
  })

  it('works with dates in a time zone and currency digits', () => {
    const at = { record: { now: '2026-10-24T20:30:00Z' } }
    expect(env.compile('dateIn(record.now, "Asia/Bangkok")').evaluate(at)).toBe('2026-10-25')
    expect(env.compile('dateIn(record.now, "UTC")').evaluate(at)).toBe('2026-10-24')
    expect(() => env.compile('dateIn(record.now, "Mars/Base")').evaluate(at)).toThrow(/time zone/)
    expect(env.compile('addDays("2026-12-31", 1)').evaluate({})).toBe('2027-01-01')
    expect(env.compile('addDays("2026-03-01", -1)').evaluate({})).toBe('2026-02-28')
    expect(() => env.compile('addDays("2026-02-30x", 1)').evaluate({})).toThrow(/not a date/)
    expect(env.compile('[currencyDigits("THB"), currencyDigits("JPY"), currencyDigits("KWD")]').evaluate({})).toEqual([2, 0, 3])
    expect(() => env.compile('currencyDigits("thb")').evaluate({})).toThrow(/currency/)
    expect(env.compile('upper("thb")').evaluate({})).toBe('THB')
    expect(env.compile('replaceAll("a-b-c", "-", "")').evaluate({})).toBe('abc')
    expect(env.compile('daysBetween("2026-12-30", "2027-01-02")').evaluate({})).toBe(3)
  })

  it('signs, compares and encodes for webhooks', () => {
    expect(env.compile('hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog")').evaluate({})).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    )
    expect(env.compile('[secureEquals("abc", "abc"), secureEquals("abc", "abd"), secureEquals("abc", "abcd")]').evaluate({})).toEqual([
      true,
      false,
      false,
    ])
    expect(env.compile('base64("acct:pässword")').evaluate({})).toBe(Buffer.from('acct:pässword').toString('base64'))
    const id = env.compile('uuidFrom("req-1")').evaluate({}) as string
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(env.compile('uuidFrom("req-1")').evaluate({})).toBe(id)
    expect(env.compile('uuidFrom("req-2")').evaluate({})).not.toBe(id)
  })

  it('builds maps from pairs and drops null fields', () => {
    expect(env.compile('compact({"a": 1, "b": null, "c": {"d": null}})').evaluate({})).toEqual({ a: 1, c: { d: null } })
    expect(env.compile('compact(record)').evaluate({ record: { a: null, b: 'x' } })).toEqual({ b: 'x' })
    expect(env.compile('fromEntries(record.ids.map(p, [p.code, p.id]))').evaluate({ record: { ids: [{ code: 'airbnb', id: '1' }] } })).toEqual({ airbnb: '1' })
    expect(env.compile('size(fromEntries([]))').evaluate({})).toBe(0)
    expect(() => env.compile('fromEntries([["a", 1], ["a", 2]])').evaluate({})).toThrow(/twice/)
    expect(() => env.compile('fromEntries([[1, 1]])').evaluate({})).toThrow(/pairs/)
  })

  it('builds maps and lists', () => {
    const e = env.compile('{"date": row.date, "price": row.price, "flags": [row.open, false]}')
    expect(e.evaluate({ row: { date: '2026-10-01', price: 100, open: true } })).toEqual({
      date: '2026-10-01',
      price: 100,
      flags: [true, false],
    })
  })

  it('wraps runtime failures with the source', () => {
    try {
      env.compile('record.missing').evaluate({ record: {} })
      expect.fail('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ExpressionError)
      expect((e as ExpressionError).source).toBe('record.missing')
    }
  })
})

describe('compileTemplate', () => {
  it('renders holes and URL-encodes their values', () => {
    const t = env.compileTemplate('/v1/listings/{row.id}/calendar/{row.name}')
    expect(t.evaluate({ row: { id: 7, name: 'a b/c' } })).toBe('/v1/listings/7/calendar/a%20b%2Fc')
    expect([...t.refs].sort()).toEqual(['row.id', 'row.name'])
  })

  it('rejects an unclosed hole', () => {
    expect(() => env.compileTemplate('/v1/{row.id')).toThrow(/unclosed/)
  })
})
