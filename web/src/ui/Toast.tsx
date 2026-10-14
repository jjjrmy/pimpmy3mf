import { createContext, useCallback, useContext, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export type ToastKind = 'warning' | 'error' | 'success' | 'info';

export interface ToastInput {
  kind: ToastKind;
  title: string;
  message?: string;
}
interface ToastItem extends ToastInput {
  id: number;
}

/** How long each kind stays before auto-dismiss (errors stay until closed). */
const DURATION: Record<ToastKind, number> = { warning: 8000, error: Infinity, success: 3000, info: 5000 };
const ICON: Record<ToastKind, string> = { warning: '⚠', error: '⛔', success: '✓', info: 'ℹ' };
const MAX_VISIBLE = 3;

const ToastContext = createContext<(t: ToastInput) => void>(() => {});
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(1);
  const timers = useRef<Map<number, number>>(new Map());

  const clearTimer = useCallback((id: number) => {
    const h = timers.current.get(id);
    if (h !== undefined) {
      clearTimeout(h);
      timers.current.delete(id);
    }
  }, []);

  const dismiss = useCallback(
    (id: number) => {
      clearTimer(id);
      setToasts((prev) => prev.filter((t) => t.id !== id));
    },
    [clearTimer],
  );

  const arm = useCallback(
    (id: number, kind: ToastKind) => {
      const d = DURATION[kind];
      if (!Number.isFinite(d)) return;
      clearTimer(id);
      timers.current.set(id, window.setTimeout(() => dismiss(id), d));
    },
    [clearTimer, dismiss],
  );

  const toast = useCallback(
    (t: ToastInput) => {
      setToasts((prev) => {
        // dedupe identical visible toasts
        if (prev.some((p) => p.kind === t.kind && p.title === t.title && p.message === t.message)) return prev;
        const id = idRef.current++;
        arm(id, t.kind);
        const next = [...prev, { id, ...t }];
        if (next.length > MAX_VISIBLE) {
          const dropped = next.slice(0, next.length - MAX_VISIBLE);
          dropped.forEach((d) => clearTimer(d.id));
          return next.slice(next.length - MAX_VISIBLE);
        }
        return next;
      });
    },
    [arm, clearTimer],
  );

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div className="toaster" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role={t.kind === 'error' ? 'alert' : 'status'}
            onMouseEnter={() => clearTimer(t.id)}
            onMouseLeave={() => arm(t.id, t.kind)}
          >
            <span className="toast-icon" aria-hidden>
              {ICON[t.kind]}
            </span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              {t.message && <div className="toast-msg">{t.message}</div>}
            </div>
            <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => dismiss(t.id)}>
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
