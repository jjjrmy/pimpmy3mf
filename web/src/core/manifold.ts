// Loads + sets up the manifold-3d WASM once, shared by the whole pipeline.
import type { ManifoldToplevel } from 'manifold-3d';
import Module from 'manifold-3d';

let instance: ManifoldToplevel | null = null;
let loading: Promise<ManifoldToplevel> | null = null;

/**
 * Loads + sets up the manifold WASM once. In the browser pass the Vite `?url` of manifold.wasm
 * (routed through emscripten's locateFile); under bun omit it and the packaged .wasm is used.
 */
export async function initManifold(opts?: { wasmUrl?: string }): Promise<ManifoldToplevel> {
  if (instance) return instance;
  if (loading) return loading;
  loading = (async () => {
    const url = opts?.wasmUrl;
    const wasm = url ? await Module({ locateFile: () => url }) : await Module();
    wasm.setup();
    instance = wasm;
    return wasm;
  })();
  return loading;
}
