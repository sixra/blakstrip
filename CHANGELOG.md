# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-07-30

### Added

- In-browser PDF redaction that rasterizes redacted pages, burning the black boxes into the pixels
  so the underlying text and vectors are removed rather than covered. Untouched pages are copied
  verbatim and keep selectable text.
- Audit-on-load that enumerates leak vectors (metadata, XMP, annotations, form values, attachments,
  embedded JavaScript) and flags scanned pages.
- Verify-on-export that re-opens the output and checks for recoverable text, surviving structure,
  and a pixel-coverage backstop before allowing the download.
- Metadata stripping with mark-sweep garbage collection of orphaned objects.
- Strict `connect-src 'none'` Content-Security-Policy in production and offline PWA support.

[Unreleased]: https://github.com/sixra/blakstrip/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/sixra/blakstrip/releases/tag/v1.0.0
