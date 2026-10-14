import { useCallback, useId, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';

interface DropZoneProps {
  accept: string;
  label: string;
  hint?: string;
  compact?: boolean;
  onFile: (file: File) => void;
  children?: ReactNode;
}

/** A drag-and-drop target that is also a click-to-pick file input. */
export function DropZone({ accept, label, hint, compact, onFile, children }: DropZoneProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const id = useId();

  const pick = useCallback(() => inputRef.current?.click(), []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) onFile(file);
    },
    [onFile],
  );

  return (
    <div
      className={`dropzone${over ? ' is-over' : ''}${compact ? ' is-compact' : ''}`}
      role="button"
      tabIndex={0}
      aria-labelledby={id}
      onClick={pick}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && pick()}
      onDragOver={(e: DragEvent) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
          e.target.value = '';
        }}
      />
      {children ?? (
        <div className="dropzone-prompt">
          <div className="dropzone-icon" aria-hidden>
            ⬆
          </div>
          <div id={id} className="dropzone-label">
            {label}
          </div>
          {hint && <div className="dropzone-hint">{hint}</div>}
        </div>
      )}
    </div>
  );
}
