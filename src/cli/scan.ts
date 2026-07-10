import path from 'node:path';
import { Store } from '../db/store';
import {
  DEFAULT_CONFIG,
  FilterConfigError,
  loadFilterConfig,
} from '../matching/filterConfig';
import { matches } from '../matching/matcher';
import { SimplifyRepoScraper } from '../scrapers/simplifyRepo';
import { SndshReadmeScraper } from '../scrapers/sndshReadme';
import { Listing, Scraper } from '../scrapers/types';

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PATH = path.join(ROOT, 'data', 'listings.sqlite');
const FILTERS_PATH = path.join(ROOT, 'config', 'filters.yaml');

const SCRAPERS: Scraper[] = [
  new SimplifyRepoScraper({
    repoSlug: 'SimplifyJobs/New-Grad-Positions',
    source: 'simplify-newgrad',
    // Active entries in this repo currently carry no term tags, so no
    // term filter here — active + visible is the meaningful cut.
  }),
  new SimplifyRepoScraper({
    repoSlug: 'SimplifyJobs/Summer2026-Internships',
    source: 'simplify-summer2026',
    // This repo mixes many terms (Fall 2026, Winter 2027, ...). Keep the
    // source-level cut broad — Summer 2026 plus adjacent 2026/2027 terms —
    // and let config/filters.yaml narrow further.
    termFilter: [
      'Summer 2026',
      'Fall 2026',
      'Winter 2026',
      'Spring 2026',
      'Summer 2027',
      'Fall 2027',
      'Winter 2027',
      'Spring 2027',
    ],
  }),
  new SndshReadmeScraper(),
];

async function main(): Promise<void> {
  // 1. Load filter config (or fall back to match-everything defaults).
  let config;
  try {
    config = loadFilterConfig(FILTERS_PATH);
  } catch (err) {
    if (err instanceof FilterConfigError) {
      console.error(`Filter config error: ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
  if (config === null) {
    console.warn(
      'No config/filters.yaml found — every new listing will be marked a candidate.\n' +
        'To set your own criteria:  cp config/filters.example.yaml config/filters.yaml  and edit it.\n',
    );
    config = { ...DEFAULT_CONFIG };
  }

  // 2. Fetch all sources. One broken source (looking at you, markdown
  //    table) must not take down the whole scan.
  const results = await Promise.allSettled(SCRAPERS.map((s) => s.fetch()));
  const fetched: { scraper: Scraper; listings: Listing[] }[] = [];
  let failures = 0;
  results.forEach((result, i) => {
    const scraper = SCRAPERS[i];
    if (result.status === 'fulfilled') {
      fetched.push({ scraper, listings: result.value });
    } else {
      failures += 1;
      console.error(`  ${scraper.name}: FAILED — ${result.reason}`);
    }
  });
  if (fetched.length === 0) {
    console.error('All sources failed; nothing to do.');
    process.exitCode = 1;
    return;
  }

  // 3. Upsert into SQLite (dedupe by id/hash) and match the new rows.
  const store = new Store(DB_PATH);
  let totalNew = 0;
  const newCandidates: Listing[] = [];
  try {
    for (const { scraper, listings } of fetched) {
      const { inserted, alreadySeen } = store.upsertAll(listings);
      let candidates = 0;
      for (const listing of inserted) {
        if (matches(listing, config)) {
          store.setStatus(listing.id, 'candidate');
          newCandidates.push(listing);
          candidates += 1;
        }
      }
      totalNew += inserted.length;
      console.log(
        `  ${scraper.name}: ${listings.length} active listings — ` +
          `${inserted.length} new, ${candidates} candidates, ${alreadySeen} already seen`,
      );
    }
  } finally {
    store.close();
  }

  if (newCandidates.length > 0) {
    console.log('\nNew candidates:');
    for (const l of newCandidates) {
      console.log(
        `  - ${l.company} — ${l.title} (${l.locations.join('; ') || 'location n/a'})\n    ${l.url}`,
      );
    }
  }

  const suffix = failures > 0 ? ` (${failures} source(s) failed)` : '';
  console.log(`\n${totalNew} new, ${newCandidates.length} candidates${suffix}`);
}

main().catch((err) => {
  console.error('scan failed:', err);
  process.exitCode = 1;
});
