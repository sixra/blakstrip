/// <reference types="astro/client" />
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vitest/globals" />

/**
 * Any binary file inlined into the bundle as base64 by `vite-plugin-inline-bytes`.
 * Returns a fresh ArrayBuffer: a codec module for jSquash's `init()`, or a sample
 * file for the build-time audits on the hub.
 */
declare module '*?bytes' {
  const inlineBytes: () => ArrayBuffer;
  export default inlineBytes;
}
