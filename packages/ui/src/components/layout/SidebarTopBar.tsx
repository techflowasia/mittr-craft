import React from 'react';

import { useUIStore } from '@/stores/useUIStore';

/**
 * Strip at the top of the desktop sidebar that keeps the session list below the
 * header line and, when the sidebar occupies the window's top-left corner,
 * reserves room for the persistent {@link TitlebarLeftControls} overlay (sidebar
 * toggle + project actions). Its height tracks the header via
 * `--oc-header-height`.
 *
 * The overlay is pinned to the window's top-left corner and does not follow the
 * sidebar (see `TitlebarLeftControls` for the rule and the rejected
 * alternatives), so only a left-docked sidebar sits underneath it. Docked right,
 * the sidebar's top strip covers no window chrome and no overlay: reserving the
 * inset there would leave a blank gap, and carving a no-drag region there would
 * remove draggable titlebar area for nothing. It is a plain drag strip instead;
 * the header takes over the reservation.
 *
 * When it does sit under the overlay the strip is split into two regions so it
 * stays a window drag area while the overlay buttons remain clickable: a
 * `no-drag` carve matching the overlay footprint (the overlay sits on top of it;
 * an OS drag region here would steal the buttons' clicks, since a
 * separate-subtree `no-drag` can't carve a drag region in Electron/macOS) plus a
 * `drag` remainder for window dragging.
 */
export const SidebarTopBar: React.FC = () => {
  const sidebarSide = useUIStore((state) => state.sidebarSide);

  if (sidebarSide === 'right') {
    return (
      <div
        aria-hidden
        className="app-region-drag flex shrink-0"
        style={{ height: 'var(--oc-header-height, 3rem)' }}
      />
    );
  }

  return (
    <div
      aria-hidden
      className="flex shrink-0"
      style={{ height: 'var(--oc-header-height, 3rem)' }}
    >
      {/* Drag region for the window-controls inset (traffic lights). */}
      <div
        className="app-region-drag shrink-0"
        style={{ width: 'var(--oc-titlebar-left-inset, 0.75rem)' }}
      />
      {/* No-drag carve under the overlay buttons so they stay clickable. */}
      <div
        className="app-region-no-drag shrink-0"
        style={{ width: 'calc(var(--oc-titlebar-controls-width, 5.5rem) + 0.5rem)' }}
      />
      {/* Draggable remainder of the strip. */}
      <div className="app-region-drag flex-1" />
    </div>
  );
};
