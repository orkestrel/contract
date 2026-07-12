# Guides

A dual-axis index into this repository's guides — by concept, and by directory (AGENTS §22).

## By concept

| Concept  | Spec                                 | Source                    | Tests                                 |
| -------- | ------------------------------------ | ------------------------- | ------------------------------------- |
| Contract | [`src/contract.md`](src/contract.md) | [`src/core`](../src/core) | [`tests/src/core`](../tests/src/core) |

## By directory

| Directory  | Guide                                |
| ---------- | ------------------------------------ |
| `src/core` | [`src/contract.md`](src/contract.md) |

## Dependency reference

[`src/guide.md`](src/guide.md) is a byte-identical mirror of the guide for
`@orkestrel/guide` — this package's guides-parity devDependency. It documents
**that package's** surface (`GuideInterface` / `SourceInterface`, the pure
comparison leaves, and the factories), not anything sourced in this repo; it is
kept here so a reader of `tests/guides/src/parity.test.ts` can see the
primitives the drop-in is built from without leaving this guide set.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; §22 documentation-as-contracts.
