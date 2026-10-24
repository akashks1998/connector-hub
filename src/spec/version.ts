/** Version of the plugin contract this release of the engine implements. */
export const ENGINE_CONTRACT = '0.1.0'

type Semver = [number, number, number]

function parse(v: string): Semver | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(v.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null
}

/**
 * Caret-range check (`^1.2`, `^0.1.3`) or an exact version. Below 1.0 the minor
 * version is treated as breaking, as npm does.
 */
export function satisfies(version: string, range: string): boolean {
  const v = parse(version)
  if (!v) return false
  const r = range.trim()
  if (!r.startsWith('^')) {
    const exact = parse(r)
    return !!exact && exact.every((n, i) => n === v[i])
  }
  const min = parse(r.slice(1))
  if (!min) return false
  if (compare(v, min) < 0) return false
  if (min[0] > 0) return v[0] === min[0]
  if (min[1] > 0) return v[0] === 0 && v[1] === min[1]
  return v[0] === 0 && v[1] === 0 && v[2] === min[2]
}

function compare(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!
  return 0
}
