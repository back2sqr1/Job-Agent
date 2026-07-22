import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Loads a `.env` file from the repo root into process.env, if one exists.
 * Import this FIRST in every entry point (before anything that reads an env
 * var) so a root `.env` works without exporting variables in the shell.
 *
 * Uses Node's built-in `process.loadEnvFile` (Node 20.12+ / 21.7+) — no
 * dependency. `.env` is gitignored, so secrets like ANTHROPIC_API_KEY stay
 * local. Values already set in the real environment win: loadEnvFile does
 * not override an existing process.env entry, so `ANTHROPIC_API_KEY=... npm
 * run apply` still takes precedence over the file.
 */
const ENV_PATH = path.resolve(__dirname, '..', '.env');

if (existsSync(ENV_PATH)) {
  const loader = (process as NodeJS.Process & { loadEnvFile?: (p: string) => void }).loadEnvFile;
  if (typeof loader === 'function') {
    try {
      loader(ENV_PATH);
    } catch {
      // Malformed .env or an unsupported Node build — fall through; real
      // environment variables still work, we just couldn't read the file.
    }
  }
}
