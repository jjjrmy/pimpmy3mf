// Typed wrapper around the pipeline Web Worker. The UI talks only to this class; it never touches
// the raw worker or runs geometry on the main thread.

import type { Params, Result } from '../core/types';
import type {
  ExportKind,
  ExportOpts,
  ExportResult,
  ImageInfo,
  ModelInfo,
  Request,
  Response,
} from './messages';

type ProgressFn = (stage: string, fraction?: number) => void;

interface Pending {
  kind: Request['type'];
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  onProgress?: ProgressFn;
}

export class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'Cancelled';
  }
}

/**
 * Stages that run as one long synchronous call (inside-surface detection, shell erosion, texture re-meshing). The worker can't
 * see a newer run until they return, so a run superseded during one of them is stopped by replacing the worker.
 */
const UNINTERRUPTIBLE = new Set(['inside', 'shell', 'texture']);

export class PipelineClient {
  private worker!: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  /** What the worker holds, kept so a replacement worker can be brought back to the same state. */
  private image: { blob: Blob; name: string } | null = null;
  private model: { bytes: ArrayBuffer; filename: string } | null = null;
  /** The run the worker is busy with, and the last stage it reported. */
  private active: { reqId: number; stage: string | null } | null = null;
  /** Resolves once a replacement worker has its image and model back. */
  private ready: Promise<void> = Promise.resolve();
  /** Bumped by cancel() and every run, so a run still waiting on `ready` knows it was dropped. */
  private runGen = 0;
  /** Times the worker was replaced (scripts / debugging). */
  restarts = 0;

  constructor() {
    this.spawn();
  }

  private spawn(): void {
    this.worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Response>) => this.handle(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Worker crashed.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.active = null;
      this.restart();
    };
  }

  /**
   * Replace the worker and reload its image and model. In-flight runs reject as cancelled (a newer run
   * replaces them); in-flight image / model loads settle with the reload's answer; an export is lost.
   */
  private restart(): void {
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    const carried = [...this.pending.values()];
    this.pending.clear();
    this.active = null;
    this.restarts++;
    this.spawn();
    const image = this.image;
    const model = this.model;
    const settle = (kind: Request['type'], value: unknown, err?: Error) => {
      for (const p of carried) if (p.kind === kind) (err ? p.reject(err) : p.resolve(value));
    };
    for (const p of carried) {
      if (p.kind === 'run') p.reject(new CancelledError());
      else if (p.kind === 'export') p.reject(new Error('The export was interrupted. Try again.'));
    }
    this.ready = (async () => {
      if (image) {
        try {
          settle('setImage', await this.send((reqId) => ({ type: 'setImage', reqId, blob: image.blob, name: image.name })));
        } catch (e) {
          settle('setImage', null, e as Error);
        }
      }
      if (model) {
        const bytes = model.bytes.slice(0);
        try {
          settle('setModel', await this.send((reqId) => ({ type: 'setModel', reqId, bytes, filename: model.filename }), [bytes]));
        } catch (e) {
          settle('setModel', null, e as Error);
        }
      }
      settle('clearModel', undefined);
    })();
  }

  private handle(msg: Response): void {
    if (msg.type === 'progress') {
      if (this.active?.reqId === msg.reqId) this.active.stage = msg.stage;
      this.pending.get(msg.reqId)?.onProgress?.(msg.stage, msg.fraction);
      return;
    }
    if (this.active?.reqId === msg.reqId) this.active = null;
    const p = this.pending.get(msg.reqId);
    if (!p) return;
    this.pending.delete(msg.reqId);
    if (msg.type === 'error') {
      p.reject(msg.name === 'Cancelled' ? new CancelledError() : Object.assign(new Error(msg.message), { name: msg.name }));
      // a WASM trap can leave the module unusable: start the next run on a fresh worker
      if (msg.name === 'RuntimeError') this.restart();
      return;
    }
    switch (msg.type) {
      case 'setImage:ok':
        p.resolve(msg.info);
        break;
      case 'setModel:ok':
        p.resolve(msg.info);
        break;
      case 'run:ok':
        p.resolve(msg.result);
        break;
      case 'export:ok':
        p.resolve(msg.result);
        break;
      case 'clearModel:ok':
      case 'dispose:ok':
        p.resolve(undefined);
        break;
    }
  }

  private send<T>(build: (reqId: number) => Request, transfer?: Transferable[], onProgress?: ProgressFn): Promise<T> {
    const reqId = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const msg = build(reqId);
      this.pending.set(reqId, { kind: msg.type, resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage(msg, transfer ?? []);
    });
  }

  async setImage(blob: Blob, name: string): Promise<ImageInfo> {
    await this.ready;
    this.image = { blob, name };
    return this.send((reqId) => ({ type: 'setImage', reqId, blob, name }));
  }

  async setModel(bytes: ArrayBuffer, filename: string): Promise<ModelInfo> {
    await this.ready;
    // the bytes are transferred to the worker; keep a copy to reload a replacement worker
    this.model = { bytes: bytes.slice(0), filename };
    return this.send((reqId) => ({ type: 'setModel', reqId, bytes, filename }), [bytes]);
  }

  async clearModel(): Promise<void> {
    await this.ready;
    this.model = null;
    return this.send((reqId) => ({ type: 'clearModel', reqId }));
  }

  /**
   * Latest-wins: a fresh run cancels the previous one, which rejects with a CancelledError. If the previous
   * run is inside an uninterruptible stage, the worker is replaced so the new run doesn't wait behind it.
   */
  async run(params: Params, useModel: boolean, onProgress?: ProgressFn): Promise<Result> {
    if (this.active && this.active.stage && UNINTERRUPTIBLE.has(this.active.stage)) this.restart();
    const gen = ++this.runGen;
    await this.ready;
    if (gen !== this.runGen) throw new CancelledError();
    const reqId = this.nextId;
    this.active = { reqId, stage: null };
    return this.send((id) => ({ type: 'run', reqId: id, params, useModel }), undefined, onProgress);
  }

  /**
   * Stop the run in flight right away (even mid-WASM) by replacing the worker; it rejects with a
   * CancelledError. Returns whether there was a run to stop.
   */
  cancel(): boolean {
    this.runGen++;
    const hasRun = !!this.active || [...this.pending.values()].some((p) => p.kind === 'run');
    if (hasRun) this.restart();
    return hasRun;
  }

  async export(kind: ExportKind, opts: ExportOpts): Promise<ExportResult> {
    await this.ready;
    return this.send((reqId) => ({ type: 'export', reqId, kind, opts }));
  }

  dispose(): void {
    this.send((reqId) => ({ type: 'dispose', reqId })).finally(() => this.worker.terminate());
  }
}
