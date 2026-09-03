# Guides

A dual-axis index into this repository's guides — by concept, and by directory (`AGENTS.md`, Documentation contract).

## By concept

| Concept  | Spec                         | Source                    | Tests                                 |
| -------- | ---------------------------- | ------------------------- | ------------------------------------- |
| Contract | [`contract.md`](contract.md) | [`src/core`](../src/core) | [`tests/src/core`](../tests/src/core) |

## By directory

| Directory  | Guide                        |
| ---------- | ---------------------------- |
| `src/core` | [`contract.md`](contract.md) |

## Dependency reference

[`guide.md`](guide.md), [`probe.md`](probe.md), [`scaffold.md`](scaffold.md) and
[`test.md`](test.md) are byte-identical mirrors of the guides for
`@orkestrel/guide`, `@orkestrel/probe`, `@orkestrel/scaffold` and
`@orkestrel/test`, this package's development dependencies. Each documents that
package's own surface, not anything sourced here, and each is kept so a reader of
`tests/guides.test.ts` can see the primitives the drop-in is built from without
leaving this guide set. Their relative links address the upstream tree, so they
sit outside local-link parity.

## See also

- [`AGENTS.md`](../AGENTS.md) — the rules; see § Documentation contract.
