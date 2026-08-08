/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';
import { playwright } from '@vitest/browser-playwright';

// Two projects: pure pdf-lib logic runs in Node (uses Buffer/zlib); the
// canvas + pdf.js worker code runs in a real Chromium via browser mode.
// Coverage is aggregated across both, gated at 100% for the engine.
export default getViteConfig({
  test: {
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/lib/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/lib/pdf/types.ts',
        // The v8 provider cannot see inside a Worker, so this file reports 0%
        // while being one of the most exercised in the repo: not one test in
        // tests/browser/compress.test.ts can pass unless it decodes, resizes and
        // encodes. Left in, it is a false zero that drags the gate down and
        // spends headroom that should be protecting code the gate can actually
        // measure. Its behaviour is covered there; only the numbers are missing.
        'src/lib/media/compress.worker.ts',
      ],
      // 90 globally rather than 100. A 100% gate buys its last few points by
      // testing defensive branches that cannot be reached, or by marking them
      // ignored, and neither makes the code safer. The number is a floor to stop
      // drift, not a target.
      //
      // One global floor was not enough, because aggregation hid both ends at
      // once. `lib/pdf` sits at 100% and `lib/media` at 88.2% branch, which is
      // already *under* the global floor and passes only because pdf's 100%
      // lifts the mean to 92.9%. So the redaction engine could lose ten points
      // unnoticed, while the least-covered file in the repo stayed invisible.
      //
      // Glob thresholds are checked *in addition* to the global ones (the global
      // set still covers every file, glob-matched or not), so this constrains
      // rather than relaxes. Note glob entries do not inherit `perFile`.
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 90,
        lines: 90,
        // The redaction engine is at 100% today and this is what keeps it there.
        'src/lib/pdf/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        // Pinned at where the media engine actually is, not where it should be:
        // set to 90 it fails immediately on `exif.ts` (69% branch). This stops
        // further drift; raise it as those branches get tests.
        'src/lib/media/**': { statements: 94, branches: 88, functions: 94, lines: 96 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'browser',
          include: ['tests/browser/**/*.test.ts'],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }],
          },
        },
      },
    ],
  },
});
