/** Full-page overlay shown while files are dragged over the window. Purely visual; App owns the
 *  window drag listeners and the drag-depth counter that keeps it from flickering on child elements. */
export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="drop-overlay" aria-hidden>
      <div className="drop-overlay-card">
        <div className="drop-overlay-icon">⬇</div>
        <div className="drop-overlay-title">Drop an image or a model</div>
        <div className="drop-overlay-sub">png · jpg · webp · gif · bmp — or stl · 3mf · obj</div>
      </div>
    </div>
  );
}
