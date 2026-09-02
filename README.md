# @orkestrel/contract

The zero-dependency contract toolkit — runtime type guards, guard combinators, coerce-and-extract
parsers, and a shape DSL that compiles once into a JSON Schema, a guard, a parser, a strict audit, a
parse report, and a generator, every one of them derived from a single owned snapshot of the
declaration. The foundation package of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/contract
```

## Requirements

- Node.js >= 22.12
- TypeScript-first (ships its own `.d.ts` types)

## Usage

```ts
import {
	createContract,
	integerShape,
	objectShape,
	seededRandom,
	stringShape,
} from '@orkestrel/contract'

const user = createContract(
	objectShape({
		name: stringShape({ min: 1 }),
		age: integerShape({ min: 0, max: 120 }),
	}),
)

user.is({ name: 'Ada', age: 36 }) // true
user.parse({ name: 'Ada', age: '36' }) // { name: 'Ada', age: 36 } — coerces, or undefined
user.explain({ name: '', age: 36 }) // [{ reason: 'constraint', path: ['name'], constraint: 'min', limit: 1, … }]
user.audit({ name: 'Ada', age: 36, extra: true }) // [{ reason: 'extra', path: ['extra'] }] — parse drops it, audit names it
user.schema // the owned, deeply frozen compiled JSON Schema
user.generate(seededRandom(42)) // reproducible seed data; omit the arg for a wall-clock-seeded source
```

## Guide

For the full surface — guards, combinators, parsers, the JSON boundary, and the shape DSL — see
[`guides/contract.md`](https://github.com/orkestrel/contract/blob/main/guides/contract.md).
The guide is not published in the npm tarball (`files` ships `dist/src` and this README), so the
link is absolute on purpose: a relative one resolves in the repository and is dead in the package.

## Package

Published as a single typed entry point per the `exports` field in `package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
