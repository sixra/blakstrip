# Security Policy

blakstrip redacts sensitive documents entirely in the browser. Security is the product, so we
take reports seriously.

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Instead, report privately through
GitHub's [private vulnerability reporting](https://github.com/sixra/blakstrip/security/advisories/new)
("Report a vulnerability" under the repository's **Security** tab).

Include, where possible:

- what leaks or fails (residual text, visible ink under a box, surviving metadata, network egress),
- a minimal PDF or steps that reproduce it (redact synthetic data, never real personal data),
- the browser and version.

We aim to acknowledge a report within a few days and to ship a fix or mitigation before any public
disclosure.

## Scope

In scope: anything that breaks the core promise, such as content that survives a redaction, hidden data
that export fails to strip, or any network request leaving the page (the production build ships a
strict `connect-src 'none'` Content-Security-Policy).

Out of scope: issues that require a compromised device, a malicious browser extension, or a modified
build.

## Threat model and known limitations

blakstrip is honest about what it proves. Redacted pages are **rasterized**: rendered to a flat
image with the black boxes burned into the pixels, so the text and vectors underneath are gone,
not merely hidden. Untouched pages are copied verbatim and keep selectable text.

Verify-on-export re-opens the output and checks three things: (1) no redacted term is still
recoverable as text, (2) no structural leak vector (metadata, XMP, annotations, forms, JavaScript,
attachments, EXIF/GPS, optional-content layers) remains, and (3) the redacted regions actually read
black in the output raster (a pixel-coverage check, so a box that visually under-covers a glyph is
caught before download rather than certified "clean"). If any check fails, download is blocked.

Verify cannot reason about content it was never told to redact. Redact everything sensitive, review
the audit panel on load, and read the verify dialog before downloading.
