/**
 * Reading and cutting the Keep a Changelog file.
 *
 * Pure string in, string out. The release workflow reads a version's notes out
 * of here rather than out of a tag annotation, because the prose in CHANGELOG.md
 * is the one written for people; a tag message is a copy that drifts.
 *
 * Every function throws rather than returning something empty. A release whose
 * notes silently came out blank is the failure worth making loud.
 */

/** `## [1.2.3] - 2026-09-12`, capturing the version. */
const RELEASE_HEADING = /^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/;
const UNRELEASED_HEADING = '## [Unreleased]';

/** The compare links at the foot of the file, newest first. */
const linkRef = (version) => `[${version}]:`;

/**
 * Where a section stops. The next heading, or the foot of the file: the oldest
 * release has no heading after it, and without this its notes would carry the
 * whole link-reference block into the release body.
 */
const endsSection = (line) =>
  line.startsWith('## ') || line.startsWith('<!--') || /^\[[^\]]+\]:\s/.test(line);

/**
 * The body of one release's section: everything under its heading, up to the
 * next heading. Throws if the version is absent or carries nothing.
 */
export function notesFor(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((line) => RELEASE_HEADING.exec(line)?.[1] === version);
  if (start === -1) throw new Error(`CHANGELOG.md has no section for ${version}`);

  const rest = lines.slice(start + 1);
  const end = rest.findIndex(endsSection);
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();

  if (!body) throw new Error(`the ${version} section in CHANGELOG.md is empty`);
  return body;
}

/** Every released version in the file, newest first. */
export function versions(changelog) {
  return changelog
    .split('\n')
    .map((line) => RELEASE_HEADING.exec(line)?.[1])
    .filter((version) => version !== undefined);
}

/**
 * Move everything under `[Unreleased]` into a new release section, and add its
 * compare link.
 *
 * Refuses an empty `[Unreleased]`, because that is the state that produces a
 * release with nothing in it, which is exactly what the notes lookup would then
 * fail on much later and much less legibly.
 */
export function cutRelease(changelog, version, date, repoUrl) {
  if (versions(changelog).includes(version)) {
    throw new Error(`CHANGELOG.md already has a ${version} section`);
  }

  const lines = changelog.split('\n');
  const unreleased = lines.indexOf(UNRELEASED_HEADING);
  if (unreleased === -1) throw new Error(`CHANGELOG.md has no ${UNRELEASED_HEADING} heading`);

  const rest = lines.slice(unreleased + 1);
  const end = rest.findIndex(endsSection);
  const carried = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  if (!carried) throw new Error('nothing is under [Unreleased], so there is no release to cut');

  const previous = versions(changelog)[0];
  if (!previous) throw new Error('CHANGELOG.md has no previous release to compare against');

  const withSection = [
    ...lines.slice(0, unreleased + 1),
    '',
    `## [${version}] - ${date}`,
    '',
    carried,
    ...(end === -1 ? [] : rest.slice(end - 1)),
  ].join('\n');

  return withSection
    .replace(
      `[Unreleased]: ${repoUrl}/compare/v${previous}...HEAD`,
      `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD\n` +
        `${linkRef(version)} ${repoUrl}/compare/v${previous}...v${version}`
    )
    .replace(/\n{3,}/g, '\n\n');
}
