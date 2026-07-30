## What and why

Briefly describe the change and the motivation.

Closes #

## Checklist

- [ ] `pnpm verify` passes locally (coverage, build, e2e).
- [ ] Engine changes under `src/lib/**` have matching tests (the 100% coverage gate is enforced).
- [ ] No network egress introduced; the strict CSP (`connect-src 'none'`) is intact.
- [ ] Commits follow Conventional Commits.
