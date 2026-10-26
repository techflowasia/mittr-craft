import fs from 'node:fs';

export const SECRET_FILE_VARIABLES = Object.freeze({
  MITTR_AD_CLIENT_SECRET_FILE: 'MITTR_AD_CLIENT_SECRET',
  MITTR_AD_BIND_PASSWORD_FILE: 'MITTR_AD_BIND_PASSWORD',
});

export const readSecretFiles = (env, { readFile = (file) => fs.readFileSync(file, 'utf8') } = {}) => {
  const next = { ...env };
  for (const [fileVariable, variable] of Object.entries(SECRET_FILE_VARIABLES)) {
    const file = String(next[fileVariable] ?? '').trim();
    delete next[fileVariable];
    if (!file) continue;
    let content;
    try {
      content = readFile(file);
    } catch (error) {
      throw new Error(`${fileVariable} names a file that could not be read (${error?.code ?? error?.name ?? 'error'}); refusing to start without company sign-in`);
    }
    next[variable] = String(content).replace(/\r?\n$/, '');
  }
  return next;
};
