/** Pimp-My-Ride style loading screen that fills the 3D viewport: a warm yellow-orange field with
 *  drifting translucent orange circles, a white "Loading" word and our logo bobbing above a small
 *  stage line. App decides when to show it (after a ~150 ms delay) and supplies the friendly label. */
export function ViewportLoading({ label }: { label: string }) {
  return (
    <div className="viewport-loading" role="status" aria-live="polite">
      <div className="vp-circles" aria-hidden>
        <span className="vp-circle vp-circle-1" />
        <span className="vp-circle vp-circle-2" />
        <span className="vp-circle vp-circle-3" />
        <span className="vp-circle vp-circle-4" />
      </div>
      <div className="vp-loading-inner">
        <div className="vp-loading-word">Loading</div>
        <img className="vp-loading-logo" src="/logo.svg" alt="" aria-hidden />
        <div className="vp-loading-stage">{label}</div>
      </div>
    </div>
  );
}
