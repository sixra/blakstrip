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
      exclude: ['src/**/*.test.ts', 'src/lib/pdf/types.ts'],
      thresholds: { statements: 100, branches: 100, functions: 100, lines: 100 },
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
