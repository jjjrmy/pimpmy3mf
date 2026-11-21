// Typed message protocol between the UI (src/worker/client.ts) and the pipeline Web Worker
// (src/worker/pipeline.worker.ts). No runtime side effects here so both sides can import it safely.

import type { Rigid } from '../core/assembly';
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
  /** Assembly: where each part came from (aligned with objects[j].parts[k]): file item and its own object / part. */
  sources: { itemId: string; object: number; part: number }[][];
  /** Assembly: the loaded files in order, with their current placement. */
  items: { itemId: string; fileName: string; transform: Rigid; parts: number; triangles: number }[];
  /** Build plates of a multi-plate Bambu / Orca project (2+); absent = one plate. */
  plates?: number;
}

export interface Placement {
  itemId: string;
  R: number[];
  t: [number, number, number];
}

/** The assembly layout a run painted: every file's placement and the composed parts' sources. */
export interface RunLayout {
  items: Placement[];
  sources: ModelInfo['sources'];
}

// ---- UI -> worker
export type Request =
  | { type: 'setImage'; reqId: number; blob: Blob; name: string }
  | { type: 'setModel'; reqId: number; bytes: ArrayBuffer; filename: string; itemId?: string }
  | {
      type: 'addModelFile';
      reqId: number;
      itemId: string;
      bytes: ArrayBuffer;
      filename: string;
      /** List position (default: the end). */
      index?: number;
      /** Placement (default: beside the assembly). */
      transform?: { R: number[]; t: [number, number, number] };
    }
  | { type: 'removeModelFile'; reqId: number; itemId: string }
  | { type: 'setPlacements'; reqId: number; placements: Placement[] }
  | { type: 'clearModel'; reqId: number }
  | { type: 'run'; reqId: number; params: Params; useModel: boolean }
  | { type: 'export'; reqId: number; kind: ExportKind; opts: ExportOpts }
  | { type: 'dispose'; reqId: number };

// ---- worker -> UI
export type Response =
  | { type: 'progress'; reqId: number; stage: string; fraction?: number }
  | { type: 'setImage:ok'; reqId: number; info: ImageInfo }
  | { type: 'setModel:ok'; reqId: number; info: ModelInfo }
  | { type: 'assembly:ok'; reqId: number; info: ModelInfo }
  | { type: 'clearModel:ok'; reqId: number }
  | { type: 'run:ok'; reqId: number; result: Result; layout: RunLayout }
  | { type: 'export:ok'; reqId: number; result: ExportResult }
  | { type: 'dispose:ok'; reqId: number }
  | { type: 'error'; reqId: number; name: string; message: string };
