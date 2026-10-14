// Typed message protocol between the UI (src/worker/client.ts) and the pipeline Web Worker
// (src/worker/pipeline.worker.ts). No runtime side effects here so both sides can import it safely.

import type { Params, Result } from '../core/types';

export type ExportKind = 'stl-zip' | 'plain-3mf' | 'bambu-3mf' | 'preview-png';

export interface ExportOpts {
  /** Current, possibly user-edited, hex per region (filament order). */
  hexes: string[];
  printerId: string;
  plate: string;
}

export interface ExportResult {
  filename: string;
  bytes: Uint8Array;
  mime: string;
  warnings: string[];
}

export interface ImageInfo {
  width: number;
  height: number;
}

export interface ModelInfo {
  triangles: number;
  /** Structure as loaded: object names with their part names (3MF objects/parts; STL/OBJ = 1 × 1). */
  objects: { name: string; parts: string[] }[];
}

// ---- UI -> worker
export type Request =
  | { type: 'setImage'; reqId: number; blob: Blob; name: string }
  | { type: 'setModel'; reqId: number; bytes: ArrayBuffer; filename: string }
  | { type: 'clearModel'; reqId: number }
  | { type: 'run'; reqId: number; params: Params; useModel: boolean }
  | { type: 'export'; reqId: number; kind: ExportKind; opts: ExportOpts }
  | { type: 'dispose'; reqId: number };

// ---- worker -> UI
export type Response =
  | { type: 'progress'; reqId: number; stage: string; fraction?: number }
  | { type: 'setImage:ok'; reqId: number; info: ImageInfo }
  | { type: 'setModel:ok'; reqId: number; info: ModelInfo }
  | { type: 'clearModel:ok'; reqId: number }
  | { type: 'run:ok'; reqId: number; result: Result }
  | { type: 'export:ok'; reqId: number; result: ExportResult }
  | { type: 'dispose:ok'; reqId: number }
  | { type: 'error'; reqId: number; name: string; message: string };
