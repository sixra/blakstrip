/**
 * Verify-on-export: re-inspect the bytes we just produced and demonstrate what
 * is (and isn't) still recoverable. A proof shown before download, not a
 * reassurance. Runs the same extraction an attacker would.
 */
import { inspectStructure } from './inspect';
import { loadPdf } from './render';
import { extractAllText } from './textlayer';
import type { VerifyReport } from './types';

/** Text still extractable from the output, de-duplicated and trimmed. */
async function recoverableStrings(bytes: Uint8Array): Promise<string[]> {
  const doc = await loadPdf(bytes.slice().buffer);
  try {
    const text = await extractAllText(doc);
    const lines = text
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return [...new Set(lines)];
  } finally {
    await doc.loadingTask.destroy(); // free the throwaway worker spun up per verify
  }
}

/**
 * Verify exported bytes against the terms the user redacted. A term counts as
 * leaked if it still appears in the recoverable text of the output.
 */
export async function verifyExport(
  bytes: Uint8Array,
  redactedTerms: string[] = []
): Promise<VerifyReport> {
  const strings = await recoverableStrings(bytes);
  const remaining = await inspectStructure(bytes);

  const haystack = strings.join('\n').toLowerCase();
  const leakedTerms = redactedTerms.filter(
    (t) => t.trim().length > 0 && haystack.includes(t.toLowerCase())
  );

  return {
    clean: remaining.length === 0 && leakedTerms.length === 0,
    recoverableStrings: strings,
    remaining,
    leakedTerms,
  };
}
