/// <reference types="astro/client" />
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />
/// <reference types="vitest/globals" />

/**
 * A wasm binary inlined into the bundle as base64 by `vite-plugin-wasm-bytes`.
 * Returns a fresh ArrayBuffer to hand straight to a jSquash `init()`.
 */
declare module '*.wasm?bytes' {
  const wasmBytes: () => ArrayBuffer;
  export default wasmBytes;
}
