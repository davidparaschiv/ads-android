// @ts-check
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { root } from './core.mjs';

let template = await readFile(resolve(root, '.env.backend.example'), 'utf8');
try {
  const app = parseEnv(await readFile(resolve(root, '.env'), 'utf8'));
  // Copy only public client settings. Never execute/shell-source the uploaded .env.
  for (const [key, value] of [['SUPABASE_URL', app.VITE_SUPABASE_URL], ['SUPABASE_PUBLISHABLE_KEY', app.VITE_SUPABASE_ANON_KEY]]) {
    if (value && !/[\r\n]/.test(value)) template = template.replace(`${key}=\n`, `${key}=${JSON.stringify(value)}\n`);
  }
} catch { /* Public defaults are optional. */ }
try {
  await writeFile(resolve(root, '.env.backend.local'), template, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.backend.local. Review the target, fill credentials, set the project ref and enable tests. Read BACKEND-TESTS.md.');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env.backend.local already exists; nothing overwritten.');
  else { console.error('Could not create .env.backend.local.'); process.exitCode = 1; }
}
