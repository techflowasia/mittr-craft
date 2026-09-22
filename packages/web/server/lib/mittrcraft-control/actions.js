/**
 * Two capabilities, two tools.
 *
 * Controlling sessions and driving a page are different intents, and a single
 * tool description covering both is vaguer than either — which is how a model
 * ends up calling the wrong one. Separate tools also mean turning one off
 * removes it entirely, parameters included, rather than leaving its inputs
 * visible in a shared schema.
 */
export const MITTRCRAFT_CONTROL_ACTION_DEFINITIONS = Object.freeze([
  { action: 'projects.list', title: 'List configured projects', description: 'List configured projects; no parameters' },
  { action: 'models.list', title: 'Show model preferences', description: 'Show default, favorite, and recent model preferences; no parameters' },
  { action: 'session.list', title: 'List sessions', description: 'List sessions; optional directory, limit (default 10), all, or withStatus' },
  { action: 'session.create', title: 'Create a session', description: 'Create a session in the current directory by default; prompt is optional' },
  { action: 'session.send', title: 'Send a prompt', description: 'Send a new prompt to sessionId; scope with projectId or directory' },
  { action: 'session.fork', title: 'Fork a session', description: 'Fork sessionId; messageId selects the boundary; prompt is optional' },
  { action: 'session.status', title: 'Check session status', description: 'Check sessionId status; directory defaults to the current session' },
  { action: 'session.messages', title: 'Read session messages', description: 'Read text-only messages and current sessionStatus for sessionId; directory and limit 10 are defaults' },
  { action: 'schedule.status', title: 'Check scheduler status', description: 'Check scheduler status; no parameters', agentExposed: false },
  { action: 'schedule.list', title: 'List scheduled tasks', description: 'List tasks and scheduler status; scope with projectId or directory' },
  { action: 'schedule.create', title: 'Create a scheduled task', description: 'Create task; requires name, prompt, model, and one schedule selector' },
  { action: 'schedule.run', title: 'Run a scheduled task', description: 'Run taskId; scope with projectId or directory' },
  { action: 'schedule.delete', title: 'Delete a scheduled task', description: 'Delete taskId; scope with projectId or directory' },
  { action: 'schedule.toggle', title: 'Enable or disable a scheduled task', description: 'Enable or disable taskId; requires the disabled boolean' },
]);

const MITTRCRAFT_CONTROL_ACTIONS = Object.freeze(
  MITTRCRAFT_CONTROL_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Reads one Jira card live, through the SAME Integrations credential the settings screen
 * already manages (base URL + email + API token, per user) — never a second connection an
 * agent or a machine has to authorize on its own. Belongs beside `session.*`/`schedule.*` in
 * the one control tool rather than a tool of its own: it is one more thing this account can
 * read, not a distinct capability with its own inputs to hide when off.
 */
export const MITTRCRAFT_JIRA_ACTION_DEFINITIONS = Object.freeze([
  { action: 'jira.get_issue', title: 'Read a Jira card', description: 'Read one Jira issue by key (e.g. MRKB-2122): summary, description, status, priority, assignee' },
]);

const MITTRCRAFT_JIRA_ACTIONS = Object.freeze(
  MITTRCRAFT_JIRA_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const MITTRCRAFT_AGENT_TOOL_ACTION_DEFINITIONS = Object.freeze([
  ...MITTRCRAFT_CONTROL_ACTION_DEFINITIONS.filter(({ agentExposed }) => agentExposed !== false),
  ...MITTRCRAFT_JIRA_ACTION_DEFINITIONS,
]);

export const MITTRCRAFT_AGENT_TOOL_ACTIONS = Object.freeze(
  MITTRCRAFT_AGENT_TOOL_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const MITTRCRAFT_WEB_ACTION_DEFINITIONS = Object.freeze([
  { action: 'browser.open', title: 'Open a page in the browser panel', description: 'Open url in the in-app browser panel; use it to look at the running app. Set viewport to mobile, tablet or desktop to lay the page out at that size' },
  { action: 'browser.snapshot', title: 'Read the open page', description: 'Read the open page: url, title, visible text, and interactive elements with the selectors the other browser actions accept. Pass selector to read only that part of a long page. Reports any errors the page logged' },
  { action: 'browser.click', title: 'Click on the open page', description: 'Click an element; give selector, or text to match a link or button by its visible label' },
  { action: 'browser.type', title: 'Type into the open page', description: 'Type value into the field matched by selector; set submit to press Enter afterwards' },
  { action: 'browser.scroll', title: 'Scroll the open page', description: 'Scroll the page; direction is up, down, top, or bottom, or pass selector to bring one element into view' },
  { action: 'browser.back', title: 'Go back in the browser panel', description: 'Return to the previous page in this tab; no parameters' },
  { action: 'browser.forward', title: 'Go forward in the browser panel', description: 'Move forward again in this tab; no parameters' },
  { action: 'browser.inspect', title: 'Read how an element renders', description: 'Read the computed styles of the element matched by selector — colours, fonts, spacing, borders — as the page actually renders them' },
  { action: 'browser.capture', title: 'Save a screenshot of the page', description: 'Save what is currently visible in the browser panel as an image file in the project and see it directly — the image is attached to the result, so a change can be checked visually rather than described. Pass label to name it (for example before-fix); the result also reports the page, layout and path to reference in your answer' },
  { action: 'browser.resize', title: 'Change the page viewport', description: 'Lay the open page out at a different size; viewport is mobile, tablet, desktop, or fill to use the whole panel' },
]);

export const MITTRCRAFT_WEB_ACTIONS = Object.freeze(
  MITTRCRAFT_WEB_ACTION_DEFINITIONS.map(({ action }) => action),
);

/**
 * Desktop control via the bundled `cua-driver` — a separate tool from
 * `mittrcraft_web` because it acts on the whole screen, not one page in the
 * panel. Only read/activate actions today; clicking or typing blind against a
 * live desktop is deferred until each action's exact argument shape has been
 * verified against a running driver, not guessed from its help text.
 */
export const MITTRCRAFT_COMPUTER_ACTION_DEFINITIONS = Object.freeze([
  { action: 'computer.list_apps', title: 'List desktop apps', description: 'List running and installed apps on the desktop, with name, pid, and running state; no parameters' },
  { action: 'computer.bring_to_front', title: 'Bring an app to the front', description: 'Activate app (by name, case-insensitive) and try to bring its main window to the front; report which window it targeted' },
  { action: 'computer.screenshot', title: 'Screenshot the desktop', description: 'Screenshot the whole desktop and see it directly — the image is attached to the result, and also saved as a file in the project whose path is returned; no parameters' },
]);

export const MITTRCRAFT_COMPUTER_ACTIONS = Object.freeze(
  MITTRCRAFT_COMPUTER_ACTION_DEFINITIONS.map(({ action }) => action),
);

/** Everything the callback route will dispatch, whichever tool asked. */
export const MITTRCRAFT_ALL_ACTIONS = Object.freeze([
  ...MITTRCRAFT_CONTROL_ACTIONS,
  ...MITTRCRAFT_JIRA_ACTIONS,
  ...MITTRCRAFT_WEB_ACTIONS,
  ...MITTRCRAFT_COMPUTER_ACTIONS,
]);
