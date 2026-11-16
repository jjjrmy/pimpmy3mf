// One monochrome icon family for the whole UI: 24×24 grid, round 2.2 stroke in currentColor, sized by
// the parent's font-size (1em). Emoji render differently per OS, so the UI uses these instead.
import type { ReactElement } from 'react';

export type IconName =
  | 'lay'
  | 'brush'
  | 'texture'
  | 'eraser'
  | 'wrench'
  | 'download'
  | 'cube'
  | 'warning'
  | 'error'
  | 'check'
  | 'info'
  | 'busy'
  | 'spinner'
  | 'chevron-left'
  | 'chevron-right'
  | 'chevron-down'
  | 'close'
  | 'edit';

const PATHS: Record<IconName, ReactElement> = {
  lay: (
    <>
      <path d="M3 20.5h18" />
      <rect x="6" y="11" width="12" height="6.5" rx="1.5" />
      <path d="M12 2.5v5.5M9.5 5.5 12 8l2.5-2.5" />
    </>
  ),
  brush: (
    <>
      <path d="M20.5 3.5 12.6 11.4" />
      <path d="m10.4 10.6 3 3" />
      <path d="M10.4 13.6c-1.5-1.5-4-1.3-5 .5-.9 1.6-.4 3.6-1.9 5.4 2.4.4 5.1-.2 6.6-1.8 1.3-1.4 1.6-2.9.3-4.1Z" />
    </>
  ),
  texture: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M3.5 12 12 3.5M5.2 18.8 18.8 5.2M12 20.5l8.5-8.5" />
      <path d="M12 3.5 20.5 12M5.2 5.2l13.6 13.6M3.5 12l8.5 8.5" />
    </>
  ),
  eraser: (
    <>
      <path d="M9 20.5h11.5" />
      <path d="m3.9 14.6 9.2-9.2a2 2 0 0 1 2.8 0l2.8 2.8a2 2 0 0 1 0 2.8l-8.7 8.7a2.4 2.4 0 0 1-1.7.7H7.1a2.4 2.4 0 0 1-1.7-.7l-1.5-1.5a2 2 0 0 1 0-2.6Z" />
      <path d="m8.6 9.9 5.6 5.6" />
    </>
  ),
  wrench: (
    <path d="M15.2 3.6a5.2 5.2 0 0 0-6 6.9l-5.5 5.5a2.2 2.2 0 1 0 3.2 3.2l5.5-5.5a5.2 5.2 0 0 0 6.9-6l-3 3-2.9-.4-.4-2.9 3-3Z" />
  ),
  download: (
    <>
      <path d="M12 3.5v11.5" />
      <path d="m6.5 9.5 5.5 5.5 5.5-5.5" />
      <path d="M4.5 20h15" />
    </>
  ),
  cube: (
    <>
      <path d="M12 2.8 4 7.3v9.4l8 4.5 8-4.5V7.3l-8-4.5Z" />
      <path d="M4 7.3 12 12l8-4.7M12 12v9.2" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 4.1 2.6 17.6A2 2 0 0 0 4.3 20.6h15.4a2 2 0 0 0 1.7-3L13.7 4.1a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4.5M12 17.2h.01" />
    </>
  ),
  error: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  check: <path d="m4.5 12.5 4.8 4.8L19.5 7" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.6h.01" />
    </>
  ),
  busy: (
    <>
      <path d="M6.5 3h11M6.5 21h11" />
      <path d="M8 3v2.4a4 4 0 0 0 1.4 3L12 12l2.6-3.6a4 4 0 0 0 1.4-3V3" />
      <path d="M8 21v-2.4a4 4 0 0 1 1.4-3L12 12l2.6 3.6a4 4 0 0 1 1.4 3V21" />
    </>
  ),
  // a bright arc over a faint ring; CSS (.icon-spin) turns it
  spinner: (
    <>
      <circle cx="12" cy="12" r="8.5" opacity="0.28" />
      <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" />
    </>
  ),
  'chevron-left': <path d="M15 5 8 12l7 7" />,
  'chevron-right': <path d="m9 5 7 7-7 7" />,
  'chevron-down': <path d="m5 9 7 7 7-7" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  edit: (
    <>
      <path d="M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 10.5-10.5Z" />
      <path d="m13.5 6.5 3 3" />
    </>
  ),
};

/** Decorative by default (aria-hidden): give the surrounding button or text its own label. */
export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
