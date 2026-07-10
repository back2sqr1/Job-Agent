import readline from 'node:readline/promises';
import { chromium } from 'playwright';
import playwrightConfig from '../../playwright.config';
import { detectHandler } from '../ats/detect';
import { ProfileError, loadProfile } from '../ats/profile';
import { FillResult } from '../ats/types';
import { DB_PATH } from '../core/scan';
import { Store } from '../db/store';

/**
 * `npm run apply -- <listing-id>`
 *
 * Opens the listing's application page in a HEADED browser (per
 * playwright.config.ts — the one shared launch configuration), fills what the
 * detected ATS handler can from config/profile.json, then pauses. The browser
 * stays open and untouched while YOU review, complete, and (if it looks
 * right) submit the form by hand — nothing is ever submitted automatically.
 */
async function main(): Promise<void> {
  const id = process.argv[2];
  if (!id) {
    console.error('Usage: npm run apply -- <listing-id>');
    console.error(
      `List candidate ids with: sqlite3 data/listings.sqlite ` +
        `"select id, company, title from listings where status='candidate' limit 20;"`,
    );
    process.exitCode = 1;
    return;
  }

  // 1. Look up the listing.
  const store = new Store(DB_PATH);
  const listing = store.getById(id);
  if (!listing) {
    console.error(`No listing with id "${id}" in ${DB_PATH}.`);
    console.error('Run `npm run scan` first, or double-check the id.');
    store.close();
    process.exitCode = 1;
    return;
  }
  if (listing.status !== 'candidate' && listing.status !== 'queued') {
    console.warn(
      `Warning: this listing's status is "${listing.status}" (not candidate/queued) — proceeding anyway.`,
    );
  }

  // 2. Load and validate the profile before opening any browser.
  let profile;
  try {
    profile = loadProfile();
  } catch (err) {
    if (err instanceof ProfileError) {
      console.error(err.message);
      store.close();
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  console.log(`\nApplying to: ${listing.company} — ${listing.title}`);
  console.log(`URL: ${listing.url}\n`);

  // 3. Headed browser per the shared config: the user watches everything.
  const browser = await chromium.launch(playwrightConfig.launchOptions);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const page = await browser.newPage();

    // 4. Navigate. A failed/slow load is not fatal — the browser stays open
    // so the user can retry or continue by hand in the same window.
    try {
      await page.goto(listing.url, {
        timeout: playwrightConfig.navigationTimeoutMs,
        waitUntil: 'domcontentloaded',
      });
      await page.waitForLoadState('load', { timeout: playwrightConfig.navigationTimeoutMs }).catch(() => {});
    } catch (err) {
      console.warn(`Navigation problem (continuing anyway): ${(err as Error).message}`);
    }

    // 5. Pick a handler from the FINAL url (listing links can redirect).
    const finalUrl = page.url() && page.url() !== 'about:blank' ? page.url() : listing.url;
    const handler = detectHandler(finalUrl);
    console.log(`ATS handler: ${handler.name}\n`);

    // 6. Fill what we can; a handler crash still leaves the browser open.
    let result: FillResult;
    try {
      result = await handler.fill(page, profile);
    } catch (err) {
      console.warn(`Handler error (form left as-is): ${(err as Error).message}`);
      result = {
        filled: [],
        skipped: [],
        resumeUploaded: false,
        notes: ['Handler hit an unexpected error — fill the form manually.'],
      };
    }
    printResult(result);

    // 7. Hands off: the human reviews, completes, and submits.
    await ask(
      rl,
      '\nReview the form in the browser, submit it yourself if it looks right, ' +
        'then press Enter here to continue...',
    );

    // 8. Only the human decides whether this counts as applied.
    const answer = (await ask(rl, 'Mark this listing as applied? (y/n): ')).trim().toLowerCase();
    if (answer === 'y' || answer === 'yes') {
      store.setStatus(id, 'applied');
      console.log(`Marked ${listing.company} — ${listing.title} as applied.`);
    } else {
      console.log(`Left status as "${listing.status}".`);
    }
  } finally {
    rl.close();
    await browser.close().catch(() => {});
    store.close();
  }
}

/**
 * rl.question, but stdin closing (Ctrl-D / piped input running out) answers
 * "" instead of throwing — which downstream reads as "no status change".
 */
async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  try {
    return await rl.question(prompt);
  } catch {
    console.log('\n(stdin closed — leaving the listing status unchanged)');
    return '';
  }
}

function printResult(result: FillResult): void {
  console.log('Fill summary:');
  console.log(
    `  Filled (${result.filled.length}): ${result.filled.length ? result.filled.join(', ') : '—'}`,
  );
  console.log(
    `  Skipped (${result.skipped.length}): ${result.skipped.length ? result.skipped.join(', ') : '—'}`,
  );
  console.log(`  Resume uploaded: ${result.resumeUploaded ? 'yes' : 'no'}`);
  for (const note of result.notes) {
    console.log(`  Note: ${note}`);
  }
}

main().catch((err) => {
  console.error('apply failed:', err);
  process.exitCode = 1;
});
