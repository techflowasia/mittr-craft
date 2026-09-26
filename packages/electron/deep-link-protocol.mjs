/**
 * The URL scheme the desktop app answers to.
 *
 * Shared between the main process, which asks the OS to route the scheme to
 * this app, and the packaging check, which asserts the built bundle declares
 * it. They were separate values once and drifted: the packaging config never
 * declared a scheme at all, so on macOS `setAsDefaultProtocolClient` had
 * nothing to bind to — LaunchServices only routes a scheme an app declares in
 * its Info.plist — and every deep link into a packaged build was dead while
 * the code that registered it looked correct.
 */
export const DEEP_LINK_PROTOCOL = 'mittrcraft';
