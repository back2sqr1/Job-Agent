/** Which upstream repo a listing came from. */
export type ListingSource =
  | 'simplify-newgrad'
  | 'simplify-summer2026'
  | 'sndsh-summer2027';

/**
 * Normalized listing shape used everywhere downstream of the scrapers,
 * regardless of what the upstream source looks like.
 */
export interface Listing {
  /**
   * Stable dedupe key. For the SimplifyJobs sources this is the upstream UUID;
   * for the sndsh404 README (which has no ids) it is a sha1 hash of
   * normalized company + title + url.
   */
  id: string;
  source: ListingSource;
  company: string;
  title: string;
  /** Direct application URL (points at the company's ATS). */
  url: string;
  locations: string[];
  /** e.g. ["Summer 2026"]. May be empty when the source doesn't tag terms. */
  terms: string[];
  /** e.g. "Does Not Sponsor", "U.S. Citizenship is Required". */
  sponsorship?: string;
  /** e.g. "Software Engineering", "AI/ML/Data". */
  category?: string;
  /** Unix seconds. */
  datePosted: number;
}

/**
 * Every source implements this interface so scan can treat them uniformly
 * and a broken scraper can be fixed (or skipped) independently.
 */
export interface Scraper {
  /** Human-readable name for logging. */
  readonly name: string;
  readonly source: ListingSource;
  fetch(): Promise<Listing[]>;
}
