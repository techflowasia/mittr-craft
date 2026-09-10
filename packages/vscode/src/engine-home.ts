/**
 * Shared with packages/web/server/lib/opencode/home.js via esbuild bundling.
 * Keep this module as a thin re-export so web and VS Code cannot diverge: two
 * copies of "where does the engine live" is how the extension would end up
 * writing to the shared engine home this exists to stop using.
 */
export { engineConfigDir, engineDataDir } from '../../web/server/lib/opencode/home.js';
