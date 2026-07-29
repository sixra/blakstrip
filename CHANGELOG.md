# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-07-30

First stable release. blakstrip redacts PDFs entirely in the browser: redacted pages are rasterized
so removed content is gone rather than covered, hidden metadata is stripped, and the output is
re-verified before you can download it. No file ever leaves your device.

### Added

- **Rasterizing redaction**: pages you redact are flattened to an image with the black boxes burned
  into the pixels, so the underlying text and vectors are removed rather than hidden. Untouched
  pages are copied verbatim and keep selectable text.
- **Audit on load**: enumerates leak vectors (metadata, XMP, annotations, form values, attachments,
  embedded JavaScript) and flags scanned pages.
- **Verify on export**: re-opens the output and checks for recoverable text, surviving structure,
  and a pixel-coverage backstop before allowing the download.
- **Metadata stripping**: clears document and embedded metadata, then mark-sweep garbage-collects
  the orphaned objects.
- **No network egress**: a strict `connect-src 'none'` Content-Security-Policy in production, plus
  offline PWA support.

<!-- On release, update these refs and add the new version. See RELEASING.md. -->

[Unreleased]: https://github.com/sixra/blakstrip/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/sixra/blakstrip/releases/tag/v1.0.0
