// Enforce Conventional Commits (checked by the Lefthook commit-msg hook).
// e.g. "feat: add search-redact", "fix: clamp redaction box to run", "chore: bump deps".
export default { extends: ['@commitlint/config-conventional'] };
