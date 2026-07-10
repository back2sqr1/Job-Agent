import { classifyPositionType } from './classify';
import { Listing, ListingSource, PositionType, Scraper } from './types';

/**
 * Raw entry shape in the SimplifyJobs listings.json files.
 * Verified against live data (dev branch, .github/scripts/listings.json).
 */
interface SimplifyRawListing {
  id?: string;
  company_name?: string;
  title?: string;
  url?: string;
  locations?: string[];
  terms?: string[];
  sponsorship?: string;
  category?: string;
  active?: boolean;
  is_visible?: boolean;
  date_posted?: number;
  date_updated?: number;
}

export interface SimplifyRepoOptions {
  /** GitHub repo slug, e.g. "SimplifyJobs/Summer2026-Internships". */
  repoSlug: string;
  source: ListingSource;
  /**
   * If non-empty, only keep listings whose `terms` intersect this list.
   * Listings with an empty `terms` array are kept regardless, because some
   * repos (e.g. New-Grad-Positions) leave `terms` empty on active entries.
   */
  termFilter?: string[];
  /** What this repo's listings are assumed to be, absent a title override. */
  defaultPositionType: PositionType;
}

/**
 * Scraper for the SimplifyJobs-style repos, which publish a machine-readable
 * JSON array on the `dev` branch. One implementation serves both repos —
 * parameterized by slug.
 *
 * The file is ~11MB and mostly inactive/historical entries, so we filter on
 * `active === true && is_visible === true` (plus the optional term filter).
 */
export class SimplifyRepoScraper implements Scraper {
  readonly name: string;
  readonly source: ListingSource;
  private readonly url: string;
  private readonly termFilter: string[];
  private readonly defaultPositionType: PositionType;

  constructor(opts: SimplifyRepoOptions) {
    this.name = opts.repoSlug;
    this.source = opts.source;
    this.url = `https://raw.githubusercontent.com/${opts.repoSlug}/dev/.github/scripts/listings.json`;
    this.termFilter = opts.termFilter ?? [];
    this.defaultPositionType = opts.defaultPositionType;
  }

  async fetch(): Promise<Listing[]> {
    const res = await fetch(this.url);
    if (!res.ok) {
      throw new Error(`${this.name}: HTTP ${res.status} fetching ${this.url}`);
    }
    const raw: unknown = await res.json();
    if (!Array.isArray(raw)) {
      throw new Error(`${this.name}: expected a JSON array, got ${typeof raw}`);
    }

    const out: Listing[] = [];
    for (const entry of raw as SimplifyRawListing[]) {
      if (!entry || entry.active !== true || entry.is_visible !== true) continue;
      if (!entry.id || !entry.company_name || !entry.title || !entry.url) continue;

      const terms = Array.isArray(entry.terms) ? entry.terms.filter((t) => typeof t === 'string') : [];
      if (this.termFilter.length > 0 && terms.length > 0) {
        const hit = terms.some((t) => this.termFilter.includes(t));
        if (!hit) continue;
      }

      out.push({
        id: entry.id,
        source: this.source,
        positionType: classifyPositionType(entry.title.trim(), this.defaultPositionType),
        company: entry.company_name.trim(),
        title: entry.title.trim(),
        url: entry.url.trim(),
        locations: Array.isArray(entry.locations)
          ? entry.locations.filter((l) => typeof l === 'string')
          : [],
        terms,
        sponsorship: entry.sponsorship || undefined,
        category: entry.category || undefined,
        datePosted: typeof entry.date_posted === 'number' ? entry.date_posted : 0,
      });
    }
    return out;
  }
}
