# Releasing

blakstrip follows [Semantic Versioning](https://semver.org) and keeps a
[Keep a Changelog](https://keepachangelog.com)-style `CHANGELOG.md`. Changes accumulate under the
`[Unreleased]` heading as they land, so cutting a release is mostly bookkeeping.

## Cutting a release

Pick the new version `X.Y.Z` per SemVer (MAJOR = breaking, MINOR = features, PATCH = fixes), then:

1. **Changelog.** In `CHANGELOG.md`:
   - Rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` and add a one-line summary under it.
   - Add a fresh, empty `## [Unreleased]` above it.
   - Update the link references at the bottom (easy to forget):
     ```markdown
     [Unreleased]: https://github.com/sixra/blakstrip/compare/vX.Y.Z...HEAD
     [X.Y.Z]: https://github.com/sixra/blakstrip/compare/vPREV...vX.Y.Z
     ```
     The very first entry points at `releases/tag/v1.0.0` instead of a compare range.
2. **Version.** Bump `"version"` in `package.json` to `X.Y.Z`.
3. **Commit.** `chore: release vX.Y.Z` (subject line only).
4. **Tag.** `git tag -a vX.Y.Z -m "vX.Y.Z"`.
5. **Push.** `git push --follow-tags`. The pre-push hook runs `pnpm verify` (coverage, build, e2e).
6. **GitHub Release.** Create it from the tag, mirroring the changelog highlights:
   ```sh
   gh release create vX.Y.Z --verify-tag --title "blakstrip vX.Y.Z" --notes "..."
   ```
   Keep the notes to a short summary, a **Highlights** section, and a **Try it** block, then link
   back to `CHANGELOG.md`.

## Conventions

- Changelog bullets lead with a bold label: `- **Feature name**: what it does.`
- Commits are [Conventional Commits](https://www.conventionalcommits.org), subject line only, with
  no attribution trailers.
