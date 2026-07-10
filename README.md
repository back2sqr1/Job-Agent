# Job-Agent

A personal tool that watches three community-maintained GitHub repos of
internship / new-grad job listings, normalizes and dedupes new postings into a
local SQLite database, filters them against your own criteria, and serves a
small local website where you can review candidates and mark them
**Apply** or **Decline**. It never fills out or submits an application for
you — clicking through to a posting just opens the real application page in a
new tab so you can apply yourself.

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
the app still runs but treats every new listing as a candidate.

## Usage

### Run the website (recommended)

```bash
npm start
```

This starts a local Express server (default `http://localhost:3000`) that:

- runs an initial scan on startup, then re-scans all three sources every hour
  in the background for as long as the process stays running (no external
  scheduler — a plain `setInterval`), and
- serves the review UI:
  - `GET /` — dashboard of `candidate` listings (matched your filter config),
    grouped by source, each with company/title/location/term and a link that
    opens the real posting in a new tab. Every row has **Apply** and
    **Decline** buttons.
  - `POST /listings/:id/apply` — marks a listing `applied`; it disappears from
    the dashboard.
  - `POST /listings/:id/decline` — marks a listing `dismissed`; it disappears
    from the dashboard.
  - `GET /history` — shows everything you've marked `applied` or `dismissed`.
    "Removing" a row from the dashboard never deletes data — it just moves it
    here.
  - `POST /refresh` — triggers an immediate scan (the same function the
    hourly background poll uses) and redirects back to `/`.

Set `PORT` to change the port, e.g. `PORT=4000 npm start`.

### One-off CLI scan

```bash
npm run scan
```

Useful for scripting/debugging without starting the server. Fetches all three
sources, filters to active/visible listings, upserts into
`data/listings.sqlite` (already-seen listings are skipped, so re-running is
cheap and idempotent), runs the matcher over the newly inserted rows, and
prints a summary like:

```
14 new, 6 candidates
```

Both entry points share the same core scan/match logic (`src/core/scan.ts`),
so `npm run scan` and the server's background poll behave identically.

Listings live in one SQLite table with a `status` column
(`new` → `candidate` → `dismissed` / `queued` / `applied`). To poke at the
data directly:

```bash
sqlite3 data/listings.sqlite "select company, title, status from listings where status='candidate' limit 20;"
```

## Project layout

```
src/
  scrapers/     shared Listing/Scraper types + one scraper per source shape
  matching/     filters.yaml loader + matcher
  db/           SQLite store + schema
  core/         shared scan/match orchestration used by both entry points
  web/          server-rendered HTML views (no frontend build step)
  cli/          scan entry point (npm run scan)
  server.ts     Express app + hourly background poll (npm start)
config/         filters.example.yaml (copy to filters.yaml)
data/           gitignored — the SQLite DB lives here at runtime, purely local
```

This is a fully local app: nothing here talks to git, GitHub Actions, or any
CI system, and no data is ever auto-committed anywhere.

## Roadmap

- **Phase 1 (this)** — scan, dedupe, filter, store, and a local review website
  (apply/decline/history).
- **Phase 2** — Playwright-assisted form filling for known ATS platforms
  (Greenhouse, Lever, Workday), with a manual-mode fallback for everything
  else. `playwright.config.ts` is a stub for this; `src/ats/` does not exist
  yet and this phase does not open a browser automatically anywhere.
- **Phase 3** — application-history export and further polish.

## Ethical use

This is a personal tool for managing **your own** job applications:

- Be gentle with the source repos: they are community-maintained and fetched
  from raw GitHub. The hourly background poll is deliberately infrequent —
  don't lower the interval into a tight loop.
- Phase 2 will **never** bypass CAPTCHAs or evade bot detection — if a site
  challenges, the human takes over.
- Phase 2 will default to **fill-then-manual-review**: the browser stops
  before the submit button so you check every application before it goes to a
  real employer. No auto-submit. This phase (Phase 1) doesn't even open a
  browser automatically — the Apply button on the dashboard just links out to
  the real posting for you to apply by hand.
- No personal data belongs in this repo. Profile/resume data (Phase 2) will
  live in gitignored local files, and only `*.example.*` templates are ever
  committed. `data/listings.sqlite` (public, non-sensitive listing metadata)
  stays local too — it is gitignored, not committed by anything.
