import { APP_FLAVOR, flavorEnvironment } from './app-flavor.mjs';

for (const [key, value] of Object.entries(flavorEnvironment(APP_FLAVOR))) {
  if (!String(process.env[key] ?? '').trim()) process.env[key] = value;
}
