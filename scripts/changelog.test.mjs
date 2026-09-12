import { describe, expect, it } from 'vitest';
import { cutRelease, notesFor, versions } from './changelog.mjs';

const REPO = 'https://github.com/sixra/blakstrip';

/** The shape of the real file, small enough to read in a failure message. */
const changelog = `# Changelog

Preamble.

## [Unreleased]

### Added

- **Thing**: a thing that was added.

## [2.1.0] - 2026-09-12

A summary of 2.1.0.

### Added

- **Compress**: a third tool.

## [2.0.0] - 2026-08-08

A summary of 2.0.0.

<!-- On release, update these refs and add the new version. See RELEASING.md. -->

[Unreleased]: ${REPO}/compare/v2.1.0...HEAD
[2.1.0]: ${REPO}/compare/v2.0.0...v2.1.0
[2.0.0]: ${REPO}/releases/tag/v2.0.0
`;

describe('notesFor', () => {
  it('returns the section body without its heading', () => {
    const notes = notesFor(changelog, '2.1.0');
    expect(notes).toContain('A summary of 2.1.0.');
    expect(notes).toContain('- **Compress**: a third tool.');
  });

  it('stops at the next release rather than running to the end of the file', () => {
    expect(notesFor(changelog, '2.1.0')).not.toContain('2.0.0');
  });

  it('does not pick up the link references', () => {
    expect(notesFor(changelog, '2.0.0')).not.toContain('[Unreleased]:');
  });

  it('throws on a version that is not there', () => {
    // The alternative is a release published with an empty body, which reads as
    // though nothing changed.
    expect(() => notesFor(changelog, '9.9.9')).toThrow(/no section for 9\.9\.9/);
  });

  it('throws on a section that exists but carries nothing', () => {
    const empty = '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n## [0.9.0] - 2025-12-01\n\nText.\n';
    expect(() => notesFor(empty, '1.0.0')).toThrow(/is empty/);
  });
});

describe('versions', () => {
  it('lists released versions newest first and ignores Unreleased', () => {
    expect(versions(changelog)).toEqual(['2.1.0', '2.0.0']);
  });
});

describe('cutRelease', () => {
  const cut = cutRelease(changelog, '2.2.0', '2026-10-01', REPO);

  it('moves what was under Unreleased into the new section', () => {
    expect(notesFor(cut, '2.2.0')).toContain('- **Thing**: a thing that was added.');
  });

  it('leaves Unreleased behind, empty', () => {
    expect(cut).toContain('## [Unreleased]\n\n## [2.2.0] - 2026-10-01');
  });

  it('adds the compare link and repoints Unreleased at the new tag', () => {
    expect(cut).toContain(`[Unreleased]: ${REPO}/compare/v2.2.0...HEAD`);
    expect(cut).toContain(`[2.2.0]: ${REPO}/compare/v2.1.0...v2.2.0`);
  });

  it('leaves older link references alone, including the first entry', () => {
    // The oldest entry points at a tag rather than a compare range, and a
    // rewrite that assumed the compare form would corrupt it.
    expect(cut).toContain(`[2.0.0]: ${REPO}/releases/tag/v2.0.0`);
  });

  it('keeps the releases below it intact', () => {
    expect(notesFor(cut, '2.1.0')).toContain('A summary of 2.1.0.');
  });

  it('refuses when nothing is under Unreleased', () => {
    const nothing = changelog.replace('### Added\n\n- **Thing**: a thing that was added.\n\n', '');
    expect(() => cutRelease(nothing, '2.2.0', '2026-10-01', REPO)).toThrow(/nothing is under/);
  });

  it('refuses to cut a version that already exists', () => {
    expect(() => cutRelease(changelog, '2.1.0', '2026-10-01', REPO)).toThrow(/already has/);
  });

  it('refuses when the Unreleased link reference is not where it expects', () => {
    // A silent no-op here would ship a release with no compare link and an
    // [Unreleased] still pointing at the previous tag.
    const moved = changelog.replace(
      `[Unreleased]: ${REPO}/compare/v2.1.0...HEAD`,
      '[Unreleased]: elsewhere'
    );
    expect(() => cutRelease(moved, '2.2.0', '2026-10-01', REPO)).toThrow(/no .* line to update/);
  });
});
