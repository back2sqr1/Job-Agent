import path from 'node:path';
import { Store } from '../db/store';
import {
  DEFAULT_CONFIG,
  FilterConfig,
  FilterConfigError,
  loadFilterConfig,
} from '../matching/filterConfig';
import { matches } from '../matching/matcher';
import { SimplifyRepoScraper } from '../scrapers/simplifyRepo';
import { SndshReadmeScraper } from '../scrapers/sndshReadme';
import { Listing, Scraper } from '../scrapers/types';

export const ROOT = path.resolve(__dirname, '..', '..');
export const DB_PATH = path.join(ROOT, 'data', 'listings.sqlite');
export const FILTERS_PATH = path.join(ROOT, 'config', 'filters.yaml');

export const SCRAPERS: Scraper[] = [
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

export interface ScanSummary {
  totalNew: number;
  totalCandidates: number;
  failures: number;
  perSource: {
    name: string;
    fetched: number;
    inserted: number;
    candidates: number;
    alreadySeen: number;
  }[];
  errors: string[];
  newCandidates: Listing[];
  /**
   * Previously-seen listings (status 'new' or 'candidate') that were
   * re-evaluated against the *current* filters.yaml this run. Because
   * upstream repos publish thousands of listings, most of a scan's
   * "new" rows never get looked at again once inserted — without this,
   * editing config/filters.yaml only ever affects listings fetched
   * *after* the edit, never the backlog already sitting in the DB.
   */
  promotedFromBacklog: number;
  demotedToBacklog: number;
}

/**
 * Load the filter config, warning (not throwing) when config/filters.yaml
 * hasn't been created yet — callers still get a usable (match-everything)
 * config back so scan/server can proceed.
 */
export function loadConfigOrDefault(): { config: FilterConfig; warning?: string } {
  let config: FilterConfig | null;
  try {
    config = loadFilterConfig(FILTERS_PATH);
  } catch (err) {
    if (err instanceof FilterConfigError) {
      throw err;
    }
    throw err;
  }
  if (config === null) {
    return {
      config: { ...DEFAULT_CONFIG },
      warning:
        'No config/filters.yaml found — every new listing will be marked a candidate. ' +
        'To set your own criteria: cp config/filters.example.yaml config/filters.yaml and edit it.',
    };
  }
  return { config };
}

/**
 * Re-run the matcher against every listing still sitting in 'new' or
 * 'candidate' status (i.e. everything the user hasn't applied/declined yet),
 * promoting newly-matching rows and demoting ones that no longer match. This
 * is what makes editing config/filters.yaml actually take effect on listings
 * that were already fetched in a previous scan, not just brand-new ones.
 * Rows the user has already acted on ('applied'/'dismissed'/'queued') are
 * left alone — this never overrides a human decision.
 */
function reconcileBacklog(store: Store, config: FilterConfig): { promoted: number; demoted: number } {
  const rows = store.getByStatuses(['new', 'candidate']);
  let promoted = 0;
  let demoted = 0;
  for (const row of rows) {
    const isMatch = matches(row, config);
    if (isMatch && row.status !== 'candidate') {
      store.setStatus(row.id, 'candidate');
      promoted += 1;
    } else if (!isMatch && row.status !== 'new') {
      store.setStatus(row.id, 'new');
      demoted += 1;
    }
  }
  return { promoted, demoted };
}

/**
 * Fetch all three sources, upsert into SQLite (dedupe by id/hash), then
 * re-run the matcher over both newly-inserted rows AND the existing backlog
 * (see reconcileBacklog above), and return a summary. Shared by the CLI
 * (`npm run scan`), the server's hourly background poll, and the `/refresh`
 * route so there is exactly one implementation of "what a scan does".
 */
export async function runScan(): Promise<ScanSummary> {
  const { config, warning } = loadConfigOrDefault();
  const errors: string[] = [];
  if (warning) errors.push(warning);

  const results = await Promise.allSettled(SCRAPERS.map((s) => s.fetch()));
  const fetched: { scraper: Scraper; listings: Listing[] }[] = [];
  let failures = 0;
  results.forEach((result, i) => {
    const scraper = SCRAPERS[i];
    if (result.status === 'fulfilled') {
      fetched.push({ scraper, listings: result.value });
    } else {
      failures += 1;
      errors.push(`${scraper.name}: FAILED — ${result.reason}`);
    }
  });

  const summary: ScanSummary = {
    totalNew: 0,
    totalCandidates: 0,
    failures,
    perSource: [],
    errors,
    newCandidates: [],
    promotedFromBacklog: 0,
    demotedToBacklog: 0,
  };

  if (fetched.length === 0) {
    errors.push('All sources failed; nothing to do.');
    return summary;
  }

  const store = new Store(DB_PATH);
  try {
    for (const { scraper, listings } of fetched) {
      const { inserted, alreadySeen } = store.upsertAll(listings);
      let candidates = 0;
      for (const listing of inserted) {
        if (matches(listing, config)) {
          store.setStatus(listing.id, 'candidate');
          summary.newCandidates.push(listing);
          candidates += 1;
        }
      }
      summary.totalNew += inserted.length;
      summary.totalCandidates += candidates;
      summary.perSource.push({
        name: scraper.name,
        fetched: listings.length,
        inserted: inserted.length,
        candidates,
        alreadySeen,
      });
    }

    const { promoted, demoted } = reconcileBacklog(store, config);
    summary.promotedFromBacklog = promoted;
    summary.demotedToBacklog = demoted;
    summary.totalCandidates += promoted;
  } finally {
    store.close();
  }

  return summary;
}
