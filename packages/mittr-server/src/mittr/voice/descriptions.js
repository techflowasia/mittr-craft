export const CONTROL_TOOL_DESCRIPTION = "Control MittrCraft projects, sessions, and scheduled tasks on the user's behalf. Sessions and scheduled tasks you create are for the user to follow and interact with; never use this tool to delegate parts of your own current task. Use one action per call. Scope with projectId or directory; omit both to use the current session directory. Session dispatches return immediately by default and you receive no notification when a dispatched session finishes, so never promise to report back on it; the user follows it in MittrCraft; a dispatched session needs no follow-up from you. If the user later asks how it went, use session.messages (add wait to block until it is idle, lastAssistant for just the final answer) — session.send always sends a NEW prompt and never just waits. Set wait only when the user asks or the next step requires the completed result. Session and worktree deletion are unavailable. jira.get_issue reads one Jira card by key (e.g. MRKB-2122) and plane.get_issue reads one Plane work item by its link or key (e.g. MITRAI-12), both through whatever this account already connected on the Integrations settings page — nothing else to set up. A Plane link is a sign-in page to a plain fetch; read it with plane.get_issue.";

export const WEB_TOOL_DESCRIPTION = "Look at and interact with a web page in MittrCraft's browser panel, so you can check your own work rather than describing what you expect. Use one action per call. Open a page, snapshot it to read its text and its interactive elements, then click, type or scroll using the selectors the snapshot returned; snapshots also report any errors the page logged. Pass a selector to browser.snapshot to read one part of a long page. browser.inspect returns computed styles when the question is how something renders. Set viewport to check a layout at mobile, tablet or desktop size. The page runs with the user's real logins, so treat what you see as their live session.";

export const VOICE_TOOL_DESCRIPTION = 'Voice-only actions. session.stop stops a running MittrCraft session and needs a spoken yes from the person first. session.read_reply returns the latest assistant answer of sessionId as plain speakable text; prefer it over session.messages to tell the person what an agent produced. chrome.allow_site allows Chrome on every site for the rest of this conversation; call it with the host of the first site_approval_required result, only after you asked the person once whether you may use Chrome in this conversation and they clearly said yes. After that, never ask about Chrome or a site again in this conversation.';

export const END_TOOL_DESCRIPTION = 'End this voice conversation, as if the person pressed End. Call it only when the person wants to stop talking with you altogether and asks for nothing else in the same sentence (bye, that is all, end the conversation, จบการสนทนา, เลิกคุย, บ๊ายบาย), with a one-sentence goodbye in the same reply. If they also ask for something, do that instead and keep talking.';

export const CONTROL_ACTION_DEFINITIONS = Object.freeze([
  { action: 'projects.list', title: 'List configured projects', description: 'List configured projects; no parameters' },
  { action: 'models.list', title: 'Show model preferences', description: 'Show default, favorite, and recent model preferences; no parameters' },
  { action: 'session.list', title: 'List sessions', description: 'List sessions; optional directory, limit (default 10), all, or withStatus' },
  { action: 'session.create', title: 'Create a session', description: 'Create a session in the current directory by default; prompt is optional' },
  { action: 'session.send', title: 'Send a prompt', description: 'Send a new prompt to sessionId; scope with projectId or directory' },
  { action: 'session.fork', title: 'Fork a session', description: 'Fork sessionId; messageId selects the boundary; prompt is optional' },
  { action: 'session.status', title: 'Check session status', description: 'Check sessionId status; directory defaults to the current session' },
  { action: 'session.messages', title: 'Read session messages', description: 'Read text-only messages and current sessionStatus for sessionId; directory and limit 10 are defaults' },
  { action: 'schedule.list', title: 'List scheduled tasks', description: 'List tasks and scheduler status; scope with projectId or directory' },
  { action: 'schedule.create', title: 'Create a scheduled task', description: 'Create task; requires name, prompt, model, and one schedule selector' },
  { action: 'schedule.run', title: 'Run a scheduled task', description: 'Run taskId; scope with projectId or directory' },
  { action: 'schedule.delete', title: 'Delete a scheduled task', description: 'Delete taskId; scope with projectId or directory' },
  { action: 'schedule.toggle', title: 'Enable or disable a scheduled task', description: 'Enable or disable taskId; requires the disabled boolean' },
]);

export const WEB_ACTION_DEFINITIONS = Object.freeze([
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

export const VOICE_ACTION_DEFINITIONS = Object.freeze([
  { action: 'session.stop', title: 'Stop a session', description: 'Stop the running session sessionId; directory defaults to the current session' },
  { action: 'session.read_reply', title: "Read a session's latest answer", description: 'Latest assistant answer of sessionId as plain speakable text, capped in length' },
  { action: 'chrome.allow_site', title: 'Allow Chrome for this conversation', description: 'Allow Chrome on every site for the rest of this conversation, after the person clearly said yes to the one question asked at the first site_approval_required result (pass its host); never saved' },
]);
