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
attachments, EXIF/GPS, optional-content layers) is still present in it, and (3) the redacted regions
actually read black in the output raster (a pixel-coverage check, so a box that visually
under-covers a glyph is caught before download rather than certified "clean").

Verify does not block the download. It shows you exactly what survived and labels the button
"Download anyway" when anything did, because an imperfect file is sometimes still the file you want.
Anything listed in red means the output still leaks: cancel, fix the redaction, and export again.

Verify cannot reason about content it was never told to redact. Redact everything sensitive, review
the audit panel on load, and read the verify dialog before downloading.

## Known limitations

- **EXIF/GPS inside a photo is detected, not stripped.** Metadata _attached_ to an embedded image is
  removed, but camera and GPS data baked into the JPEG's own bytes would require re-encoding the
  image. Both the audit and the verify dialog flag it. To remove it, draw a redaction box anywhere
  on the page holding that image: the page is then rasterized and re-encoded, and the EXIF goes
  with it.
- **Optional-content (layer) PDFs are not fully cleaned.** On a page copied verbatim, layer content
  stays in the file, and the exported file loses the layer visibility settings, so a layer that was
  hidden may become visible. blakstrip detects this and refuses a clean verdict; to actually remove
  it, redact something on every page that uses layers so those pages get flattened.
- **Encrypted PDFs are refused.** pdf-lib cannot decrypt, so a password- or permission-protected
  file has to be re-saved without protection first.
- **Untouched pages keep selectable text.** Only pages you redact are rasterized. That is what keeps
  the rest of the document searchable, and it is why the verify dialog lists what is still readable.
