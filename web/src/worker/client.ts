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

export class PipelineClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker = new Worker(new URL('./pipeline.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<Response>) => this.handle(e.data);
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Worker crashed.');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private handle(msg: Response): void {
    if (msg.type === 'progress') {
      this.pending.get(msg.reqId)?.onProgress?.(msg.stage, msg.fraction);
      return;
    }
    const p = this.pending.get(msg.reqId);
    if (!p) return;
    this.pending.delete(msg.reqId);
    if (msg.type === 'error') {
      p.reject(msg.name === 'Cancelled' ? new CancelledError() : Object.assign(new Error(msg.message), { name: msg.name }));
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
      this.pending.set(reqId, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage(build(reqId), transfer ?? []);
    });
  }

  setImage(blob: Blob, name: string): Promise<ImageInfo> {
    return this.send((reqId) => ({ type: 'setImage', reqId, blob, name }));
  }

  setModel(bytes: ArrayBuffer, filename: string): Promise<ModelInfo> {
    return this.send((reqId) => ({ type: 'setModel', reqId, bytes, filename }), [bytes]);
  }

  clearModel(): Promise<void> {
    return this.send((reqId) => ({ type: 'clearModel', reqId }));
  }

  /** Latest-wins: a fresh run cancels the previous one, which rejects with a CancelledError. */
  run(params: Params, useModel: boolean, onProgress?: ProgressFn): Promise<Result> {
    return this.send((reqId) => ({ type: 'run', reqId, params, useModel }), undefined, onProgress);
  }

  export(kind: ExportKind, opts: ExportOpts): Promise<ExportResult> {
    return this.send((reqId) => ({ type: 'export', reqId, kind, opts }));
  }

  dispose(): void {
    this.send((reqId) => ({ type: 'dispose', reqId })).finally(() => this.worker.terminate());
  }
}
