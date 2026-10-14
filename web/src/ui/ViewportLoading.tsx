/** Loading overlay for the 3D viewport: a translucent scrim, a spinning glossy hubcap and a bold
 *  stage label. The previous render stays visible underneath. App decides when to show it (after a
 *  ~150 ms delay) and supplies the friendly label. */
export function ViewportLoading({ label }: { label: string }) {
  return (
    <div className="viewport-loading" role="status" aria-live="polite">
      <div className="vp-scrim" aria-hidden />
      <div className="vp-loading-card">
        <div className="vp-spinner" aria-hidden>
          <span className="vp-spinner-gloss" />
        </div>
        <div className="vp-loading-label">{label}</div>
      </div>
    </div>
  );
}
