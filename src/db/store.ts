import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { Listing, ListingSource } from '../scrapers/types';

export type ListingStatus = 'new' | 'candidate' | 'dismissed' | 'queued' | 'applied';

export interface UpsertResult {
  /** Listings that were not in the DB before this call (status = 'new'). */
  inserted: Listing[];
  /** Count of listings we had already seen (only last_seen_at was bumped). */
  alreadySeen: number;
}

interface ListingRow {
  id: string;
  source: string;
  company: string;
  title: string;
  url: string;
  locations: string;
  terms: string;
  sponsorship: string | null;
  category: string | null;
  date_posted: number;
  status: string;
  first_seen_at: number;
  last_seen_at: number;
}

/**
 * Thin synchronous wrapper around better-sqlite3.
 * Dedupe is by primary key `id` — re-running scan never reprocesses a
 * listing it has already stored, and never resets a status the user
 * (or the matcher) has moved past 'new'.
 */
export class Store {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(schema);
  }

  /** Insert unseen listings; for already-seen ones just bump last_seen_at. */
  upsertAll(listings: Listing[]): UpsertResult {
    const now = Math.floor(Date.now() / 1000);
    const insert = this.db.prepare(`
      INSERT INTO listings
        (id, source, company, title, url, locations, terms, sponsorship,
         category, date_posted, status, first_seen_at, last_seen_at)
      VALUES
        (@id, @source, @company, @title, @url, @locations, @terms, @sponsorship,
         @category, @datePosted, 'new', @now, @now)
      ON CONFLICT (id) DO UPDATE SET last_seen_at = @now
    `);
    const exists = this.db.prepare('SELECT 1 FROM listings WHERE id = ?');

    const inserted: Listing[] = [];
    let alreadySeen = 0;

    const run = this.db.transaction((items: Listing[]) => {
      for (const l of items) {
        const wasThere = exists.get(l.id) !== undefined;
        insert.run({
          id: l.id,
          source: l.source,
          company: l.company,
          title: l.title,
          url: l.url,
          locations: JSON.stringify(l.locations),
          terms: JSON.stringify(l.terms),
          sponsorship: l.sponsorship ?? null,
          category: l.category ?? null,
          datePosted: l.datePosted,
          now,
        });
        if (wasThere) alreadySeen += 1;
        else inserted.push(l);
      }
    });
    run(listings);

    return { inserted, alreadySeen };
  }

  setStatus(id: string, status: ListingStatus): void {
    this.db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(status, id);
  }

  getByStatus(status: ListingStatus): Listing[] {
    const rows = this.db
      .prepare('SELECT * FROM listings WHERE status = ? ORDER BY date_posted DESC')
      .all(status) as ListingRow[];
    return rows.map(rowToListing);
  }

  countByStatus(status: ListingStatus): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM listings WHERE status = ?')
      .get(status) as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

function rowToListing(row: ListingRow): Listing {
  return {
    id: row.id,
    source: row.source as ListingSource,
    company: row.company,
    title: row.title,
    url: row.url,
    locations: safeJsonArray(row.locations),
    terms: safeJsonArray(row.terms),
    sponsorship: row.sponsorship ?? undefined,
    category: row.category ?? undefined,
    datePosted: row.date_posted,
  };
}

function safeJsonArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
