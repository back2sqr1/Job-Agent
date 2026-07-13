import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { ROOT } from '../core/scan';
import { FillResult } from './types';

/**
 * Optional ATS account credentials, loaded from config/credentials.json
 * (gitignored — see config/credentials.example.json). This is an OPT-IN
 * convenience: if the file doesn't exist, sign-in walls are simply left to
 * the human, same as before.
 *
 * The password is stored in plaintext on your own disk. That's the same
 * trade-off as ~/.netrc or a .env file — acceptable for a personal machine,
 * but know what you're opting into (consider `chmod 600` on the file).
 * The value is never printed, logged, or included in a fill summary.
 */
export interface AtsCredentials {
  /** Sign-in email. Falls back to the profile email if omitted. */
  email?: string;
  password: string;
}

export class CredentialsError extends Error {}

export const CREDENTIALS_PATH = path.join(ROOT, 'config', 'credentials.json');

/**
 * Load credentials for one ATS key (e.g. "workday"). Returns null when the
 * file doesn't exist or has no entry for that key — callers treat null as
 * "feature not enabled" and fall back to manual sign-in. Malformed content
 * throws, same fail-loud pattern as the profile/filter loaders.
 */
export function loadCredentials(key: string, filePath: string = CREDENTIALS_PATH): AtsCredentials | null {
  if (!existsSync(filePath)) return null;

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new CredentialsError(`Could not parse ${filePath}: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new CredentialsError(`${filePath}: expected a JSON object at the top level`);
  }

  const entry = (doc as Record<string, unknown>)[key];
  if (entry === undefined || entry === null) return null;
  if (typeof entry !== 'object' || Array.isArray(entry)) {
    throw new CredentialsError(`${filePath}: "${key}" must be an object like {"email": "...", "password": "..."}`);
  }

  const obj = entry as Record<string, unknown>;
  if (typeof obj['password'] !== 'string' || obj['password'] === '') {
    throw new CredentialsError(`${filePath}: "${key}.password" must be a non-empty string`);
  }
  if ('email' in obj && (typeof obj['email'] !== 'string' || obj['email'] === '')) {
    throw new CredentialsError(`${filePath}: "${key}.email" must be a non-empty string if present`);
  }

  return { email: obj['email'] as string | undefined, password: obj['password'] };
}

/** Visible elements matched by a locator, in DOM order. */
async function visibleAll(loc: Locator): Promise<Locator[]> {
  const out: Locator[] = [];
  const count = await loc.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = loc.nth(i);
    if (await el.isVisible().catch(() => false)) out.push(el);
  }
  return out;
}

export type SignInOutcome =
  | 'signed-in' // credentials filled AND the sign-in button was clicked
  | 'account-creation' // fields filled, but ToS/create-account left to the human
  | 'failed'; // couldn't fill — human takes over

/**
 * Fill an ATS sign-in / account-creation form with the user's own
 * credentials. This is the ONE deliberate exception to "never touch
 * password fields", and it exists only behind the opt-in credentials file.
 *
 * - One visible password field  -> sign-in: fill email + password, click the
 *   sign-in button, and let the caller re-check what page came up.
 * - Two+ visible password fields -> account creation: fill email + password +
 *   confirm-password, but do NOT tick terms-of-service checkboxes and do NOT
 *   click "Create Account" — agreeing to a company's terms is the human's
 *   decision, so the run stops there for review.
 *
 * The password value never goes into result.filled/notes — only the fact
 * that a sign-in was attempted.
 */
export async function fillSignIn(
  page: Page,
  creds: AtsCredentials,
  fallbackEmail: string,
  result: FillResult,
): Promise<SignInOutcome> {
  const email = creds.email ?? fallbackEmail;

  const passwords = await visibleAll(page.locator('input[type="password"]'));
  if (passwords.length === 0) return 'failed';

  // Email/username field: prefer a real email input, then label match, then
  // Workday's automation id.
  const emailCandidates = [
    ...(await visibleAll(page.locator('input[type="email"]'))),
    ...(await visibleAll(page.getByLabel(/e-?mail|username/i))),
    ...(await visibleAll(page.locator('[data-automation-id="email"]'))),
  ];
  let emailFilled = false;
  for (const el of emailCandidates) {
    try {
      await el.fill(email, { timeout: 3_000 });
      emailFilled = true;
      break;
    } catch {
      // try the next candidate
    }
  }

  let passwordsFilled = 0;
  for (const el of passwords) {
    try {
      await el.fill(creds.password, { timeout: 3_000 });
      passwordsFilled += 1;
    } catch {
      // leave it; the human can finish
    }
  }
  if (passwordsFilled === 0) return 'failed';

  if (passwords.length >= 2) {
    result.notes.push(
      'Account-creation form detected: your email and password were filled in, but the ' +
        'terms-of-service checkbox and the Create Account button are left to you. Finish account ' +
        'creation, get to the application form, then re-run this command.',
    );
    return 'account-creation';
  }

  if (!emailFilled) {
    result.notes.push(
      'Password was filled in but no email/username field was found — complete the sign-in ' +
        'yourself, then re-run this command.',
    );
    return 'failed';
  }

  try {
    await page
      .getByRole('button', { name: /sign\s*in|log\s*in/i })
      .first()
      .click({ timeout: 3_000 });
  } catch {
    result.notes.push(
      'Credentials were filled in but no Sign In button was found — click it yourself, then ' +
        're-run this command to fill the application form.',
    );
    return 'failed';
  }

  // Give the post-login navigation a moment to happen; the caller decides
  // what the resulting page is (application form, still the wall, a CAPTCHA).
  await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(500);
  result.notes.push('Signed in with the credentials from config/credentials.json.');
  return 'signed-in';
}
