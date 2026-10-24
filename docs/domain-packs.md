# Domain packs

A domain pack is the vocabulary plugins map into. Keeping it outside the
engine means one engine serves rentals, CRM, issue trackers or anything else,
and every plugin for a domain produces the same operations.

```ts
import type { DomainPack } from 'connector-hub'

export const tasksDomain = {
  domain: 'tasks',
  version: '0.1.0',
  description: 'To-do items grouped in projects.',
  entities: {
    task: {
      key: ['external_id'],
      fields: {
        external_id: 'string',
        project: 'string',
        title: 'string',
        done: 'bool',
        priority: { enum: ['low', 'normal', 'high'] },
        due: { type: 'date', description: 'Local date, YYYY-MM-DD' },
      },
    },
  },
  operations: {
    upsert_task: { entity: 'task', kind: 'upsert' },
    complete_task: { entity: 'task', kind: 'patch' },
    delete_task: { entity: 'task', kind: 'delete' },
  },
} satisfies DomainPack
```

## Entities

- `key`: the fields that together identify a record. Every emit must set them,
  and sinks diff and batch by them.
- `fields`: name → type. Types are `string`, `int`, `double`, `bool`, `date`,
  `timestamp` and `json`, written either as the bare type or as
  `{type, description}`. `{enum: [...]}` declares a string with fixed values.

## Operations

- `upsert`: create the record or replace the given fields.
- `patch`: change only the given fields of an existing record.
- `delete`: remove the record; only the key is meaningful.

How each kind is applied is up to the host.

## Versioning

Plugins name a caret range (`domain: { name: tasks, version: ^0.1 }`).
Adding entities, fields or operations is a minor change; renaming or removing
them, or changing a key, is a major one (or a minor one while below 1.0).

## Published packs

| Package | Domain |
| --- | --- |
| `connector-hub/str` | short-term rentals: `listing`, `calendar_day`, `booking` |
| `connector-hub/contacts` | CRM: `person`, `organisation` |

New packs are welcome; see [CONTRIBUTING.md](../CONTRIBUTING.md).
