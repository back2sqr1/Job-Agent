# Job-Agent

A personal tool that watches three community-maintained GitHub repos of
internship / new-grad job listings, normalizes and dedupes new postings into a
local SQLite database, and filters them against your own criteria. Run it once
a day and it tells you what's new and what matches you.

## Sources

| Source | Format | Dedupe key |
| --- | --- | --- |
| [SimplifyJobs/New-Grad-Positions](https://github.com/SimplifyJobs/New-Grad-Positions) | JSON feed (`dev` branch) | upstream UUID |
| [SimplifyJobs/Summer2026-Internships](https://github.com/SimplifyJobs/Summer2026-Internships) | JSON feed (`dev` branch) | upstream UUID |
| [sndsh404/summer-2027-internships](https://github.com/sndsh404/summer-2027-internships) | README markdown table | sha1(company + title + url) |

All fetched over plain HTTPS from `raw.githubusercontent.com` — no auth, no API keys.

## Setup

Requires Node.js 20+.

```bash
npm install
cp config/filters.example.yaml config/filters.yaml
# edit config/filters.yaml — terms, keywords, locations, sponsorship, blocklist
```

`config/filters.yaml` is gitignored; only the `.example.yaml` template is
tracked, so your personal criteria never end up in git. If you skip this step,
`scan` still works but treats every new listing as a candidate.

## Usage

```bash
npm run scan
```

This fetches all three sources, filters to active/visible listings, upserts
into `data/listings.sqlite` (already-seen listings are skipped, so re-running
is cheap and idempotent), runs the matcher over the newly inserted rows, and
prints a summary like:

```
14 new, 6 candidates
```

Listings live in one `listings` table with a `status` column
(`new` → `candidate` → `dismissed` / `queued` / `applied`). Phase 1 only sets
`new` and `candidate`; the rest are reserved for the upcoming review/apply
workflow. To poke at the data:

```bash
sqlite3 data/listings.sqlite "select company, title, status from listings where status='candidate' limit 20;"
```

## Project layout

```
src/
  scrapers/     shared Listing/Scraper types + one scraper per source shape
  matching/     filters.yaml loader + matcher
  db/           better-sqlite3 store + schema
  cli/          scan entry point
config/         filters.example.yaml (copy to filters.yaml)
data/           gitignored — the SQLite DB lives here at runtime
```

## Roadmap

- **Phase 1 (this)** — scan, dedupe, filter, store.
- **Phase 2** — interactive review CLI and Playwright-assisted form filling
  for known ATS platforms (Greenhouse, Lever, Workday), with a manual-mode
  fallback for everything else. `playwright.config.ts` is a stub for this.
- **Phase 3** — application-history export and scheduling notes.

## Ethical use

This is a personal tool for managing **your own** job applications:

- Be gentle with the source repos: they are community-maintained and fetched
  from raw GitHub. Poll on a human timescale (a few times a day at most), not
  in a tight loop.
- Phase 2 will **never** bypass CAPTCHAs or evade bot detection — if a site
  challenges, the human takes over.
- Phase 2 defaults to **fill-then-manual-review**: the browser stops before
  the submit button so you check every application before it goes to a real
  employer. No auto-submit.
- No personal data belongs in this repo. Profile/resume data lives in
  gitignored local files (`config/profile.json`, `resumes/` — Phase 2), and
  only `*.example.*` templates are ever committed.
