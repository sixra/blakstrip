# Contributing to blakstrip

Thanks for your interest in improving blakstrip. This is a privacy-focused, fully in-browser PDF
redactor, so the bar for anything touching the redaction engine is high: correctness and the
no-network-egress guarantee come first.

By taking part you agree to the [Code of Conduct](./CODE_OF_CONDUCT.md).

## Development setup

Requires Node 24+ (see `.nvmrc`) and pnpm (the repo pins a version via `packageManager`; Corepack picks it up
automatically).

```sh
pnpm install
pnpm dev        # dev server at http://localhost:4321
```

Note that the strict Content-Security-Policy and the PWA only exist in a production build
(`pnpm build && pnpm preview`), not in `pnpm dev`.

## Tests and checks

```sh
pnpm test           # Vitest (node + real-Chromium browser projects)
pnpm test:e2e       # Playwright redaction flow + axe accessibility checks
pnpm validate       # format:check + lint + type-check + build
pnpm verify         # test:coverage + build + test:e2e (also runs on pre-push on main)
```

The engine is held to a **100% coverage gate on `src/lib/**`** (enforced in `vitest.config.ts` and
in CI). New engine code needs matching tests, or coverage fails.

## Invariants

- **No network egress.** Nothing in `src/` may fetch, upload, or otherwise send the user's file
  anywhere. The production build ships a strict `connect-src 'none'` CSP that enforces this, and it
  is a core promise of the product. Do not loosen it.
- **Redaction removes, it does not cover.** Redacted pages are rasterized so the underlying content
  is gone; keep it that way.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org)
(`feat|fix|chore|docs|refactor|test|perf: ...`), enforced by commitlint via a git hook. Keep the
subject line focused; no attribution trailers.

## Security

Please do not open public issues for security problems (a way to recover redacted content, surviving
hidden data, or any network egress). Report them privately: see [SECURITY.md](./SECURITY.md).

## Releasing

Maintainers: see [RELEASING.md](./RELEASING.md) for the version, changelog, tag, and release steps.
