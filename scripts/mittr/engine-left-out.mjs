import fs from 'node:fs';
import path from 'node:path';

export const LEFT_OUT_FILE = 'left-out.json';

const CLOSED_CHUNK = /^agent-sdk-[a-z0-9]+\.mjs$/;
const PROVIDER_PLUGIN = /"(opencode\.provider\.[a-z-]+-agent)"/g;

export const leaveOutClosedEngineParts = ({ serverDir }) => {
  const chunksDir = path.join(serverDir, 'chunks');
  const names = fs.readdirSync(chunksDir).filter((name) => name.endsWith('.mjs'));
  const closed = names.filter((name) => CLOSED_CHUNK.test(name));
  if (closed.length !== 1) throw new Error(`expected one engine chunk under a closed licence in ${chunksDir}, found ${closed.length}`);
  const [chunk] = closed;
  const sources = [...names.filter((name) => name !== chunk).map((name) => path.join(chunksDir, name)), path.join(serverDir, 'serve.mjs')]
    .map((file) => ({ file, text: fs.readFileSync(file, 'utf8') }))
    .filter(({ text }) => text.includes(chunk));
  const lazy = `import("./${chunk}").catch(`;
  if (sources.length !== 1 || sources[0].text.split(chunk).length !== 2 || !sources[0].text.includes(lazy)) {
    throw new Error(`${chunk} is no longer loaded only on demand with a fallback; leaving it out could break the engine`);
  }
  const plugins = [...new Set([...sources[0].text.matchAll(PROVIDER_PLUGIN)].map((match) => match[1]))];
  if (plugins.length !== 1) throw new Error(`expected one provider plugin beside ${chunk}, found ${plugins.length}`);
  fs.rmSync(path.join(chunksDir, chunk));
  fs.writeFileSync(path.join(serverDir, LEFT_OUT_FILE), `${JSON.stringify({ plugins }, null, 2)}\n`);
  return { chunk, plugins };
};

export const verifyLeftOut = ({ serverDir }) => {
  const closed = fs.readdirSync(path.join(serverDir, 'chunks')).filter((name) => CLOSED_CHUNK.test(name));
  if (closed.length > 0) throw new Error(`the packed engine carries a chunk under a closed licence: ${closed.join(', ')}`);
  const { plugins } = JSON.parse(fs.readFileSync(path.join(serverDir, LEFT_OUT_FILE), 'utf8'));
  if (!Array.isArray(plugins) || plugins.length !== 1) throw new Error(`${LEFT_OUT_FILE} does not name the provider plugin that goes with it`);
  return plugins;
};
