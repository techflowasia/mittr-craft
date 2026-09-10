import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { useProjectActionsContext } from '@/hooks/useProjectActionsContext';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { invokeDesktop } from '@/lib/desktop';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';

const ICON_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary hover:bg-interactive-hover transition-colors';

/**
 * Persistent top-left titlebar controls (sidebar toggle + project actions).
 *
 * Rendered exactly once as an absolutely-positioned overlay above both the
 * sidebar and the header, so the buttons never migrate / re-mount between the
 * two while the sidebar animates open or closed — the panels slide *underneath*
 * a fixed control cluster instead. Its height tracks `--oc-header-height` and
 * its left padding clears the OS window controls via `--oc-titlebar-left-inset`.
 * The cluster's measured width is published as `--oc-titlebar-controls-width`
 * so whichever pane owns the window's top-left corner can reserve matching space.
 *
 * ## Placement rule (deliberate): the cluster never follows the sidebar.
 *
 * It stays pinned to the window's top-left corner on every platform and for
 * both `sidebarSide` values. This cluster is titlebar chrome, not sidebar
 * chrome: it hosts the frameless window controls when the user puts them on the
 * left, and the native app-menu button. Window chrome must not migrate because
 * a *content* panel was docked to the other side.
 *
 * The rejected alternatives, and why:
 * - "Follow the sidebar unconditionally" breaks two cases outright. On frameless
 *   Windows/Linux with left-side window controls, the close/minimize/maximize
 *   buttons live inside this cluster and would be dragged away from the corner
 *   the user asked for; with right-side window controls, the cluster would land
 *   on the corner those controls own.
 * - "Follow the sidebar only when the target corner is free of window controls"
 *   is collision-safe but makes the same product behave differently per
 *   platform — the cluster would sit right on macOS and left on Windows for
 *   identical settings. Runtime divergence is worth paying for when the platform
 *   forces it (traffic-light insets do); it is not worth paying for here, where
 *   one stable rule works everywhere.
 *
 * What does move is the *reservation*: whichever pane covers the top-left corner
 * reserves the cluster footprint and carves the matching no-drag region — the
 * sidebar's `SidebarTopBar` when the sidebar is open and docked left, the header
 * otherwise (closed, or docked right). The toggle icon mirrors to match the side
 * the sidebar is actually on.
 */
export const TitlebarLeftControls: React.FC = () => {
  const { t } = useI18n();
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const sidebarSide = useUIStore((state) => state.sidebarSide);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const projectActionsContext = useProjectActionsContext();
  const clusterRef = React.useRef<HTMLDivElement | null>(null);

  const toggleShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_sidebar', shortcutOverrides));
  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const handleOpenWindowsAppMenu = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    void invokeDesktop('desktop_show_app_menu', {
      x: rect.left,
      y: rect.bottom,
    }).catch((error) => {
      console.warn('[titlebar] failed to open app menu', error);
    });
  }, []);

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    const node = clusterRef.current;
    if (!node) {
      return;
    }

    const publishWidth = () => {
      // Prefer scrollWidth so negative child margins / overflow cannot under-report
      // the space the overlay actually occupies over the header.
      const width = Math.max(node.getBoundingClientRect().width, node.scrollWidth);
      document.documentElement.style.setProperty('--oc-titlebar-controls-width', `${Math.round(width)}px`);
    };

    publishWidth();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(publishWidth);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    // The overlay is a CSS no-drag zone so its buttons stay clickable. The
    // header / sidebar strip beneath carve a matching no-drag region under it
    // and remain drag regions everywhere else, so window dragging still works
    // in the empty parts of the strip.
    <div
      className="app-region-no-drag absolute left-0 top-0 z-30 flex select-none items-center pr-2"
      style={{
        height: 'var(--oc-header-height, 3rem)',
        paddingLeft: 'var(--oc-titlebar-left-inset, 0.75rem)',
      }}
    >
      <div ref={clusterRef} className="flex items-center gap-2">
        {usesFramelessChrome && windowControlsSide === 'left' ? (
          <WindowsWindowControls visible position="left" />
        ) : null}

        {usesFramelessChrome ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenWindowsAppMenu}
                aria-label={t('header.actions.openAppMenuAria')}
                className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
              >
                <Icon name="menu-2" className="h-[18px] w-[18px]" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>{t('header.actions.openAppMenu')}</p>
            </TooltipContent>
          </Tooltip>
        ) : null}

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={toggleSidebar}
              aria-label={t('header.actions.openSessionsAria')}
              className={cn(ICON_BUTTON_CLASS, 'shrink-0')}
            >
              {/* The button stays put; only the glyph mirrors, so it keeps
                  pointing at the edge the sidebar is actually docked to. */}
              <Icon
                name={sidebarSide === 'right' ? 'layout-right' : 'layout-left'}
                className="h-[18px] w-[18px]"
              />
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>{t('header.actions.openSessionsWithShortcut', { shortcut: toggleShortcut })}</p>
          </TooltipContent>
        </Tooltip>

        {projectActionsContext ? (
          <ProjectActionsButton
            projectRef={projectActionsContext.projectRef}
            directory={projectActionsContext.directory}
          />
        ) : null}
      </div>
    </div>
  );
};
