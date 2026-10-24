import type { CompiledExpression } from '../cel/index.js'
import type { JsonValue, Paginate } from '../spec/index.js'
import { ConnectorError } from './errors.js'
import { canonical } from './values.js'

export type Page = Record<string, JsonValue>

export function firstPage(paginate: Paginate): Page {
  switch (paginate.type) {
    case 'none':
      return {}
    case 'offset':
      return { offset: 0, limit: paginate.limit }
    case 'page':
      return { number: paginate.start }
    case 'cursor':
      return { cursor: null }
  }
}

/** The next page, or null when the list is exhausted. Offset and page paging stop on an empty page. */
export function nextPage(
  paginate: Paginate,
  next: CompiledExpression | undefined,
  page: Page,
  count: number,
  vars: Record<string, unknown>,
  seen: Set<string>,
): Page | null {
  switch (paginate.type) {
    case 'none':
      return null
    case 'offset':
      return count === 0 ? null : { offset: (page.offset as number) + count, limit: paginate.limit }
    case 'page':
      return count === 0 ? null : { number: (page.number as number) + 1 }
    case 'cursor': {
      const value = next!.evaluate(vars) as JsonValue
      if (value === null || value === undefined || value === '') return null
      const id = `cursor:${canonical(value)}`
      if (seen.has(id)) throw new ConnectorError('permanent', 'pagination cursor repeated an earlier value')
      seen.add(id)
      return { cursor: value }
    }
  }
}

/** Refuses a page identical to an earlier one, which would otherwise loop forever. */
export function checkRepeat(list: JsonValue[], seen: Set<string>, where: string): void {
  if (list.length === 0) return
  const fingerprint = canonical(list)
  if (seen.has(fingerprint)) throw new ConnectorError('permanent', `${where}: the provider returned the same page twice`)
  seen.add(fingerprint)
}
