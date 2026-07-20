import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Locator, Page } from 'playwright';
import { ROOT } from '../core/scan';
import { contextText, isCaptchaPresent } from './helpers';
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
  /**
   * Second, separate opt-in: when true, account-creation forms are completed
   * fully automatically — including ticking the "I agree to the terms"
   * checkbox and clicking Create Account. Setting this flag IS you
   * delegating that terms-of-service agreement to the tool; leave it off
   * (the default) to keep the ToS checkbox and final click manual.
   */
  createAccounts?: boolean;
}

export class CredentialsError extends Error {}

/**
 * Resolved at call time (not import time) so tests can point at a temp file
 * via JOB_AGENT_CREDENTIALS without ever touching the user's real config.
 */
export function credentialsPath(): string {
  return process.env.JOB_AGENT_CREDENTIALS ?? path.join(ROOT, 'config', 'credentials.json');
}

/**
 * Load credentials for one ATS key (e.g. "workday"). Returns null when the
 * file doesn't exist or has no entry for that key — callers treat null as
 * "feature not enabled" and fall back to manual sign-in. Malformed content
 * throws, same fail-loud pattern as the profile/filter loaders.
 */
export function loadCredentials(key: string, filePath: string = credentialsPath()): AtsCredentials | null {
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
  if ('createAccounts' in obj && typeof obj['createAccounts'] !== 'boolean') {
    throw new CredentialsError(`${filePath}: "${key}.createAccounts" must be true or false if present`);
  }

  return {
    email: obj['email'] as string | undefined,
    password: obj['password'],
    createAccounts: obj['createAccounts'] === true,
  };
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
  | 'account-created' // createAccounts opt-in: ToS agreed + Create Account clicked
  | 'failed'; // couldn't fill — human takes over

/** Checkbox labels that read as a terms/privacy agreement — the ONLY kind of
 * checkbox the createAccounts flow will tick. Anything else (marketing
 * opt-ins, job-alert subscriptions, ...) is left alone. */
const TOS_PATTERN = /\bagree|terms\s+(of|and)|terms of (use|service)|privacy (policy|statement)/i;

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
    if (!creds.createAccounts) {
      result.notes.push(
        'Account-creation form detected: your email and password were filled in, but the ' +
          'terms-of-service checkbox and the Create Account button are left to you. Finish account ' +
          'creation, get to the application form, then re-run this command. (Optional: set ' +
          '"createAccounts": true in config/credentials.json to automate this step too.)',
      );
      return 'account-creation';
    }

    // createAccounts opt-in: tick agreement checkboxes (ONLY ones whose
    // label reads as terms/privacy — marketing opt-ins stay untouched) and
    // click Create Account. Setting the flag is the user's delegation of
    // that agreement; see AtsCredentials.createAccounts.
    for (const box of await visibleAll(page.locator('input[type="checkbox"]'))) {
      try {
        if (TOS_PATTERN.test(await contextText(box)) && !(await box.isChecked())) {
          await box.check({ timeout: 3_000 });
        }
      } catch {
        // leave it for the human; the Create Account click below may then
        // fail validation, which the wall re-check surfaces
      }
    }
    try {
      await page
        .getByRole('button', { name: /create\s*account|sign\s*up|register/i })
        .first()
        .click({ timeout: 3_000 });
    } catch {
      result.notes.push(
        'Filled the account-creation form but no Create Account button was found — click it ' +
          'yourself, then re-run this command.',
      );
      return 'account-creation';
    }
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    await page.waitForTimeout(500);
    result.notes.push(
      'Created an account with the credentials from config/credentials.json (createAccounts is ' +
        'on). If the tenant asks for an email verification code, that step is yours.',
    );
    return 'account-created';
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
  result.notes.push('Submitted the sign-in form with the credentials from config/credentials.json.');
  return 'signed-in';
}

/** True if the page shows a visible password input — the sign-in-wall tell. */
export async function hasVisiblePasswordField(page: Page): Promise<boolean> {
  const passwordFields = page.locator('input[type="password"]');
  const count = await passwordFields.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    if (await passwordFields.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

/** Click the sign-in page's "Create Account" link/button, if there is one. */
async function clickCreateAccountLink(page: Page): Promise<boolean> {
  const byRole = (role: 'link' | 'button') =>
    page.getByRole(role, { name: /create\s*account|sign\s*up/i }).first();
  for (const candidate of [byRole('link'), byRole('button')]) {
    try {
      await candidate.click({ timeout: 3_000 });
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(300);
      return true;
    } catch {
      // try the next shape
    }
  }
  return false;
}

/**
 * Shared sign-in-wall flow for every ATS handler. If the page shows a
 * password field, resolve it using the user's opt-in credentials for
 * `atsKey` (config/credentials.json): sign in, pivot to account creation on
 * a bounce when createAccounts is on, and re-check for CAPTCHAs / a
 * still-standing wall afterwards.
 *
 * Returns true when the caller should continue filling the application form
 * (no wall, or the wall was cleared); false when the run should stop with
 * the notes already explaining why.
 */
export async function handleSignInWall(
  page: Page,
  atsKey: string,
  fallbackEmail: string,
  result: FillResult,
): Promise<boolean> {
  if (!(await hasVisiblePasswordField(page))) return true;

  const creds = loadCredentials(atsKey);
  if (!creds) {
    result.notes.push(
      'This site is asking you to sign in / create an account first — do that yourself, ' +
        'navigate to the application form, then re-run this command to fill it. (Optional: copy ' +
        `config/credentials.example.json to config/credentials.json with a "${atsKey}" entry to ` +
        'let this step sign in for you.)',
    );
    return false;
  }

  let outcome = await fillSignIn(page, creds, fallbackEmail, result);

  // Sign-in submitted but the wall is still up — on a tenant where no
  // account exists yet that's the expected bounce. With createAccounts on,
  // pivot to the Create Account form and let fillSignIn complete it (it
  // agrees to the ToS and clicks Create Account per that opt-in).
  if (
    outcome === 'signed-in' &&
    creds.createAccounts &&
    !(await isCaptchaPresent(page)) &&
    (await hasVisiblePasswordField(page))
  ) {
    result.notes.push(
      'Sign-in bounced (probably no account on this tenant yet) — trying account creation, ' +
        'since createAccounts is on.',
    );
    if (await clickCreateAccountLink(page)) {
      outcome = await fillSignIn(page, creds, fallbackEmail, result);
    }
  }

  if (outcome !== 'signed-in' && outcome !== 'account-created') return false;

  if (await isCaptchaPresent(page)) {
    result.notes.push(
      'A CAPTCHA / verification challenge appeared after signing in — the form was not filled. ' +
        'Solve it yourself, then re-run this command.',
    );
    return false;
  }
  if (await hasVisiblePasswordField(page)) {
    result.notes.push(
      'Still on the sign-in/creation page after submitting credentials — they may be wrong for ' +
        'this tenant, or email verification is needed. Finish signing in yourself, then re-run ' +
        'this command.',
    );
    return false;
  }
  return true;
}
