import { checkpointLine, recordCheckpoint, removeCheckpoints, sweepCheckpoints } from './checkpoints.js';
import { loopSigns, summarizeTurn } from './loop-signs.js';
import { createTurnReader } from './turn-reader.js';

const REASON_CHARS = 200;
const TRACKED_SESSIONS = 200;

const stallWarningFor = (sign) => [
  `Progress check: your work ${sign.detail}.`,
  'If you are waiting on something outside this folder, such as CI, a review or a service, say so in your report. Otherwise change your approach, or stop and report plainly what blocks you.',
].join(' ');

const warningFor = (signs) => (signs.every((sign) => sign.kind === 'stalled') ? stallWarningFor(signs[0]) : [
  `Loop check: your last run repeated itself. It ${signs.map((sign) => sign.detail).join('; it ')}.`,
  'Do not repeat those steps. Change your approach, or if you cannot make progress, stop and report plainly what blocks you.',
].join(' '));

const blockReasonFor = (signs) => `looping: ${signs.map((sign) => sign.reason).join(', ')}`.slice(0, REASON_CHARS);

const errorText = (error) => (error instanceof Error ? error.message : String(error));

export const createGoalGuard = ({
  opencode,
  logger,
  readTurn = createTurnReader({ opencode }),
  probe = (directory, sessionId) => recordCheckpoint({ directory, sessionId }),
  sweep = (directory) => sweepCheckpoints({ directory }),
  remove = (directory, sessionId) => removeCheckpoints({ directory, sessionId }),
}) => {
  const sessions = new Map();
  const sweptFolders = new Set();

  const sweepOnce = async (directory) => {
    if (sweptFolders.has(directory)) return;
    sweptFolders.add(directory);
    await sweep(directory).catch((error) => logger.warn(`[mittr] goal checkpoint sweep failed in ${directory}:`, errorText(error)));
  };

  const stateFor = (sessionId, goalId) => {
    const known = sessions.get(sessionId);
    const state = known?.goalId === goalId
      ? known
      : { goalId, directory: '', turnKey: null, answer: null, warning: '', stalledTurns: 0, head: null, tree: null };
    sessions.delete(sessionId);
    sessions.set(sessionId, state);
    if (sessions.size > TRACKED_SESSIONS) sessions.delete(sessions.keys().next().value);
    return state;
  };

  const review = async ({ sessionId, directory, goalId, resumed }) => {
    const state = stateFor(sessionId, goalId);
    const turn = await readTurn(sessionId).catch((error) => {
      logger.warn(`[mittr] goal loop check could not read the turn of ${sessionId}:`, errorText(error));
      return null;
    });
    if (!resumed && turn && turn.key === state.turnKey && state.answer) return state.answer;

    if (directory) {
      state.directory = directory;
      await sweepOnce(directory);
    }
    const saved = directory
      ? await probe(directory, sessionId).catch((error) => {
        logger.warn(`[mittr] goal checkpoint failed in ${directory}:`, errorText(error));
        return null;
      })
      : null;
    const summary = turn ? summarizeTurn(turn.records) : null;
    const committed = Boolean(saved?.head && state.head && saved.head !== state.head);
    const treeChanged = Boolean(saved?.tree && state.tree && saved.tree !== state.tree);
    if (saved && (turn || resumed)) {
      state.head = saved.head;
      state.tree = saved.tree;
    }

    let warning = '';
    let answer = null;
    if (resumed) {
      state.warning = '';
      state.stalledTurns = 0;
    } else if (summary) {
      state.stalledTurns = summary.changedFiles || committed || treeChanged ? 0 : state.stalledTurns + 1;
      const signs = loopSigns(summary, { stalledTurns: state.stalledTurns });
      const warned = Boolean(state.warning) && String(turn.opener ?? '').includes(state.warning);
      if (warned && signs.some((sign) => sign.kind !== 'stalled')) answer = { block: blockReasonFor(signs) };
      else if (signs.length > 0) warning = warningFor(signs);
      state.warning = warning;
    }
    answer ??= { note: [warning, checkpointLine(saved?.refs ?? [], saved?.newFiles)].filter(Boolean).join('\n\n') };
    if (turn) {
      state.turnKey = turn.key;
      state.answer = answer;
    }
    return answer;
  };

  const ended = async ({ sessionId, directory, reason }) => {
    const folder = sessions.get(sessionId)?.directory || directory;
    sessions.delete(sessionId);
    if (!folder || (reason !== 'complete' && reason !== 'cleared')) return;
    await remove(folder, sessionId).catch((error) => logger.warn(`[mittr] could not remove the goal checkpoints of ${sessionId}:`, errorText(error)));
  };

  return { review, ended };
};
