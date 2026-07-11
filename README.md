# @orkestrel/contracts

The zero-dependency contract toolkit — runtime type guards, guard combinators, coerce-and-extract
parsers, and a shape DSL that compiles once into a guard, parser, JSON Schema, and generator that
can never drift. The foundation package of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/contracts
```

## Requirements

- Node.js >= 24
- TypeScript-first (ships its own `.d.ts` types)

## Usage

```ts
import { createContract, integerShape, objectShape, stringShape } from '@orkestrel/contracts'

const user = createContract(
	objectShape({
		name: stringShape({ min: 1 }),
		age: integerShape({ min: 0, max: 120 }),
	}),
)

user.is({ name: 'Ada', age: 36 }) // true
user.parse({ name: 'Ada', age: '36' }) // { name: 'Ada', age: 36 } — coerces, or undefined
user.schema // the compiled JSON Schema
```

## Guide

For the full surface — guards, combinators, parsers, the JSON boundary, and the shape DSL — see
[`guides/src/contracts.md`](./guides/src/contracts.md).

## Package

Published as a single typed entry point per the `exports` field in `package.json`.
