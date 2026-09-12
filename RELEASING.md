# Releasing

blakstrip follows [Semantic Versioning](https://semver.org) and keeps a
[Keep a Changelog](https://keepachangelog.com)-style `CHANGELOG.md`. Changes accumulate under the
`[Unreleased]` heading as they land, so cutting a release is mostly bookkeeping, and the bookkeeping
is automated.

A release is not a deploy. Cloudflare Pages builds from `main` on its own, so the site is usually
live before the release exists. Releasing records what shipped; it does not ship it.

## Cutting a release

Pick the new version `X.Y.Z` per SemVer (MAJOR = breaking, MINOR = features, PATCH = fixes), then:

1. **Prepare.** On a branch:

   ```sh
   node scripts/release-prepare.mjs X.Y.Z
   ```

   It moves everything under `## [Unreleased]` into `## [X.Y.Z] - YYYY-MM-DD`, leaves a fresh empty
   `[Unreleased]`, adds the compare link, and sets the version in `package.json`. Write the summary
   paragraph under the new heading yourself: it is the one part of a release that has to be read by
   a person before it is written by one.

2. **Merge.** Open a PR and merge it. That is the whole release.

When the version lands on `main`, `.github/workflows/release.yml` runs `pnpm verify`, tags the
commit `vX.Y.Z`, and publishes the GitHub Release with that version's changelog section as its
notes. Nothing to remember, and the tag cannot end up on the wrong commit.

Merge the release PR promptly. If another PR lands on `main` first, the tag will contain a change
the changelog does not describe, which is what happened to v2.1.0.

## What the automation refuses to do

Each of these fails the run rather than publishing something wrong:

- the version in `package.json` is already tagged, in which case it does nothing at all, which is
  what every ordinary push to `main` looks like
- the version is not a plain `major.minor.patch`
- `CHANGELOG.md` has no section for it, or the section is empty
- `pnpm verify` fails

`node scripts/release-notes.mjs X.Y.Z` prints exactly what the release body will be, so you can read
it before merging.

## Conventions

- Changelog bullets lead with a bold label: `- **Feature name**: what it does.`
- Commits are [Conventional Commits](https://www.conventionalcommits.org), subject line only, with
  no attribution trailers.
- Tags created by the workflow are unsigned. The tags for 1.0.0, 2.0.0 and 2.1.0 were made by hand
  from a machine holding the signing key and are SSH-signed; later ones are not.
