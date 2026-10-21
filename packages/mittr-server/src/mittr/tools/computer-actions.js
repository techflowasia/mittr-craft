import { isRecord } from '../values.js';
import { MITTR_TOOLS, MittrToolError } from './registry.js';
import { NO_SCREENSHOT_DIRECTORY, fitsAttachment, imageOf, saveScreenshot } from './screenshots.js';

export const APP_NAME_PATTERN = /^[\w .()&-]{1,80}$/;

export const COMPUTER_TOOL_DESCRIPTION = "Look at and act on the user's whole desktop, not just MittrCraft's own panels — use only when a task genuinely needs another app. Use one action per call. computer.list_apps first to see what is running and get an exact app name; if the app you need is not running, computer.open_app launches it by name; computer.bring_to_front activates a running app by that name; computer.screenshot to see the current desktop — the image is attached to the result for you to read directly when it is small enough to attach (the result says if it is not; then it is only saved as a file), so there is no need to open it with a file-reading tool. Clicking or typing into other apps is not available yet. This is a live, real desktop the user can see moving in front of them — never use it for anything the user has not clearly asked for.";

const COMPUTER_PARAMETERS = Object.freeze({
  app: { type: 'string', description: 'App name (as list_apps reports it, or its ordinary name to launch it), for computer.bring_to_front and computer.open_app' },
});

const SCREEN_RECORDING = 'Screen Recording';
const ACCESSIBILITY = 'Accessibility';
const GRANTS = [SCREEN_RECORDING, ACCESSIBILITY];
const AMBIGUOUS_WINDOW = 'ambiguous_window_target';

const grantRefusal = (grant) => new MittrToolError(
  `MittrCraft needs the ${grant} permission for CuaDriver. Turn it on in System Settings → Privacy & Security → ${grant}.`,
  403,
);

const grantsNamedIn = (text) => GRANTS.filter((grant) => text.toLowerCase().includes(grant.toLowerCase()));

const preferring = (grants, ownGrant) => (grants.includes(ownGrant) ? ownGrant : grants[0] ?? null);

const missingGrant = (text, ownGrant) => {
  if (!/grant|permission/i.test(text)) return null;
  const notGranted = text.split(/[.,;\n]+/).filter((clause) => /not granted/i.test(clause)).flatMap(grantsNamedIn);
  const grant = preferring(notGranted, ownGrant) ?? preferring(grantsNamedIn(text), ownGrant);
  if (grant) return grant;
  return /permissions grant/i.test(text) ? ownGrant : null;
};

const plainText = (value) => (value === String(value) && value.trim() ? value.trim() : null);

const appNameOf = (input, action) => {
  const name = plainText(input.app);
  if (!name) throw new MittrToolError(`app is required for ${action}`, 400);
  if (!APP_NAME_PATTERN.test(name) || /^[-.]/.test(name) || !/\w/.test(name)) throw new MittrToolError('app must be a plain app name', 400);
  return name;
};

const appsOf = (listed) => (isRecord(listed) && Array.isArray(listed.apps) ? listed.apps.filter(isRecord) : []);

const DEFINITIONS = Object.freeze([
  {
    action: 'computer.list_apps',
    title: 'List desktop apps',
    description: 'List running and installed apps on the desktop, with name, pid, and running state; no parameters',
    effect: 'read',
  },
  {
    action: 'computer.open_app',
    title: 'Open an app',
    description: 'Launch app by name if it is not already running (macOS "open -a"). Use this first when computer.list_apps shows it is not running; opening does not itself bring its window to the front, so follow with computer.bring_to_front',
    effect: 'change',
  },
  {
    action: 'computer.bring_to_front',
    title: 'Bring an app to the front',
    description: 'Activate app (by name, case-insensitive) and try to bring its main window to the front; report which window it targeted',
    effect: 'change',
  },
  {
    action: 'computer.screenshot',
    title: 'Screenshot the desktop',
    description: 'Screenshot the whole desktop and see it directly when the image is small enough to attach; it is also saved as a file in the project whose path is returned; no parameters',
    effect: 'read',
  },
]);

export function registerComputerActions(registry, { control, launchApp, writeScreenshot, offered }) {
  const driver = async (tool, args, { signal }, ownGrant) => {
    try {
      return await control.request(tool, args, { signal });
    } catch (error) {
      const grant = error instanceof MittrToolError ? null : missingGrant(String(error?.message ?? ''), ownGrant);
      throw grant ? grantRefusal(grant) : error;
    }
  };

  const listApps = async (_input, ctx) => ({
    apps: appsOf(await driver('list_apps', {}, ctx, ACCESSIBILITY)).map((app) => ({
      name: app.name,
      pid: app.pid,
      running: app.running === true,
      bundleId: app.bundle_id ?? null,
    })),
  });

  const openApp = async (input, ctx) => {
    const name = appNameOf(input, 'computer.open_app');
    try {
      await launchApp(name, { signal: ctx.signal });
    } catch (error) {
      if (error instanceof MittrToolError) throw error;
      throw new MittrToolError(`Could not open "${name}": ${error instanceof Error ? error.message : String(error)}`, 502);
    }
    return { launched: true, app: name };
  };

  const bringToFront = async (input, ctx) => {
    const name = appNameOf(input, 'computer.bring_to_front');
    const listed = appsOf(await driver('list_apps', {}, ctx, ACCESSIBILITY));
    const match = listed.find((app) => app.running === true && String(app.name).toLowerCase() === name.toLowerCase());
    if (!match) throw new MittrToolError(`No running app named "${name}"`, 404);
    const result = await driver('bring_to_front', { pid: match.pid }, ctx, ACCESSIBILITY);
    if (result?.code === AMBIGUOUS_WINDOW) {
      return {
        activated: false,
        reason: AMBIGUOUS_WINDOW,
        candidates: (Array.isArray(result.candidates) ? result.candidates : []).map((candidate) => ({ windowId: candidate.window_id, title: candidate.title || null })),
        hint: 'Several windows belong to this app; this action does not pick one for you yet.',
      };
    }
    return {
      activated: result?.process_activated === true,
      windowVerified: result?.exact_window_effect?.verified === true,
    };
  };

  const screenshot = async (_input, ctx) => {
    const directory = plainText(ctx.directory);
    if (!directory) throw new MittrToolError(NO_SCREENSHOT_DIRECTORY, 400);
    const result = await driver('get_desktop_state', {}, ctx, SCREEN_RECORDING);
    const base64 = plainText(result?.screenshot_png_b64);
    if (!base64) {
      const grant = missingGrant(JSON.stringify(result ?? null), SCREEN_RECORDING);
      throw grant ? grantRefusal(grant) : new MittrToolError('The desktop screenshot came back without an image', 502);
    }
    const image = imageOf({ base64, mime: plainText(result.screenshot_mime_type) ?? 'image/png' });
    if (!image) throw new MittrToolError('The desktop screenshot is not a PNG, JPEG or WebP image', 502);
    const saved = await saveScreenshot({ control: { writeScreenshot }, directory, base64: image.base64, mime: image.mime, label: 'desktop' });
    const attached = fitsAttachment(image.base64);
    return {
      path: saved.path,
      hint: attached
        ? `The image is attached for you to view directly; write ![](${saved.path}) in your reply to also show it to the user.`
        : `Write ![](${saved.path}) in your reply to show it to the user.`,
      width: result.screen_width ?? null,
      height: result.screen_height ?? null,
      image: saved.image,
    };
  };

  const executes = {
    'computer.list_apps': listApps,
    'computer.open_app': openApp,
    'computer.bring_to_front': bringToFront,
    'computer.screenshot': screenshot,
  };

  registry.defineTool({ name: MITTR_TOOLS.computer, description: COMPUTER_TOOL_DESCRIPTION, parameters: COMPUTER_PARAMETERS });
  const available = () => control.available === true && Boolean(offered());
  for (const definition of DEFINITIONS) {
    registry.register({ ...definition, tool: MITTR_TOOLS.computer, available, execute: executes[definition.action] });
  }
}
