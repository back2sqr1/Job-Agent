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

To use the Playwright-assisted apply flow (optional — everything else works
without it):

```bash
npx playwright install chromium
cp config/profile.example.json config/profile.json
# edit config/profile.json — name, contact info, school, links, resumePath
# put your resume at the path resumePath points to, e.g. resumes/your-resume.pdf
```

`config/profile.json` and everything under `resumes/` are gitignored — your
real details and resume never end up in git; only `profile.example.json` is
tracked.

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

### Playwright-assisted apply

```bash
npm run apply -- <listing-id>
```

Grab a listing id from the dashboard or straight from SQLite:

```bash
sqlite3 data/listings.sqlite "select id, company, title from listings where status='candidate' limit 20;"
```

What it does:

1. Looks the listing up in the local DB (warns — but proceeds — if you've
   already applied/dismissed it) and loads + validates `config/profile.json`.
2. Opens the listing's application page in a **headed** browser
   (`playwright.config.ts` — the browser is always visible, never headless).
3. Detects the ATS by hostname — **Greenhouse** (`job-boards.greenhouse.io`,
   `boards.greenhouse.io`), **Lever** (`jobs.lever.co`), **Ashby**
   (`jobs.ashbyhq.com`), and **Workday** (`*.myworkdayjobs.com` — first form
   page only; Workday is a multi-step wizard, usually behind a sign-in, and
   the remaining steps stay manual) have real handlers; everything else
   (iCIMS, SmartRecruiters, custom sites, ...) falls back to "page is open,
   fill it in yourself".

   Workday sign-in is manual by default. Optionally, copy
   `config/credentials.example.json` to `config/credentials.json`
   (gitignored) to have the tool sign in to Workday tenants with your own
   account: it fills email + password and clicks Sign In. The password sits
   in **plaintext on your disk** (consider `chmod 600`), is never printed or
   logged. By default account *creation* still stops before the
   terms-of-service checkbox and Create Account button; setting
   `"createAccounts": true` in the file is a second, separate opt-in that
   automates those too (when sign-in bounces on a tenant with no account
   yet, it pivots to Create Account, agrees to the terms **on your
   delegation**, and creates the account — marketing checkboxes are never
   ticked, and email-verification codes remain yours to enter). Delete the
   file to turn the whole feature off.
4. Fills the fields that map directly to your profile (name, email, phone,
   location, links, resume upload) and prints a summary of what was filled
   vs skipped. Free-text questions ("Why do you want to work here?") are
   **always left blank** — nothing is ever written on your behalf — and
   EEO / voluntary self-identification questions (gender, race/ethnicity,
   veteran or disability status) are **never touched**, period.
5. Pauses. You review, complete, and — only if it looks right — submit the
   form yourself in the browser. There is no auto-submit anywhere.
6. After you press Enter in the terminal, it asks whether to mark the listing
   `applied` in the local DB.

The handler test suite (local HTML fixtures, no network) runs with:

```bash
npm run test:ats
```

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
  ats/          per-ATS Playwright form-filling handlers + profile loader
  web/          server-rendered HTML views (no frontend build step)
  cli/          scan + apply entry points (npm run scan / npm run apply)
  server.ts     Express app + hourly background poll (npm start)
config/         filters.example.yaml / profile.example.json (copy + edit)
test/fixtures/  local static HTML pages the ATS handler tests run against
scripts/        test-ats-fixtures.ts (npm run test:ats)
data/           gitignored — the SQLite DB lives here at runtime, purely local
resumes/        gitignored — your resume PDF(s) live here, purely local
```

This is a fully local app: nothing here talks to git, GitHub Actions, or any
CI system, and no data is ever auto-committed anywhere.

## Roadmap

- **Phase 1 (done)** — scan, dedupe, filter, store, and a local review website
  (apply/decline/history).
- **Phase 2 (this)** — Playwright-assisted form filling for Greenhouse,
  Lever, Ashby, and Workday's first form page (`npm run apply -- <id>`), with
  a manual-mode fallback for everything else. The dashboard's Apply button is
  unchanged — it still just marks status; the browser flow is a separate CLI
  command. Greenhouse and Lever have been corrected against live postings;
  Ashby and Workday are fixture-tested best guesses awaiting their first real
  runs.
- **Phase 3** — Workday's full multi-step wizard, more ATSs (iCIMS,
  SmartRecruiters), application-history export, and further polish.

## Ethical use & limitations

This is a personal tool for managing **your own** job applications:

- Be gentle with the source repos: they are community-maintained and fetched
  from raw GitHub. The hourly background poll is deliberately infrequent —
  don't lower the interval into a tight loop.
- The apply flow **never** bypasses CAPTCHAs or evades bot detection — if a
  site challenges, the human takes over.
- **No auto-submit, anywhere.** The flow is fill-then-pause: the browser is
  headed, the handler never clicks submit, and you review and submit every
  application by hand before it reaches a real employer.
- Free-text answers are never generated on your behalf, and EEO / voluntary
  self-identification questions (gender, race/ethnicity, veteran status,
  disability status) are never auto-answered — `profile.json` deliberately
  doesn't even have fields for them, and the fill helpers hard-refuse any
  field whose label looks like one.
- **Live-verification caveat**: the Greenhouse and Lever handlers use
  Playwright's accessible-name locators (labels, not brittle CSS ids) and are
  tested against local HTML fixtures mirroring those platforms' well-known
  field labels — but they have **not** been verified against live production
  postings from within the development environment this was built in (its
  network policy blocks those hosts). Do one supervised trial run against a
  real posting — watching every step — before trusting the flow for anything
  that matters. If a field doesn't fill, it lands in the "skipped" list and
  you fill it by hand; the handler never guesses.
- No personal data belongs in this repo. `config/profile.json` and `resumes/`
  are gitignored; only `*.example.*` templates are ever committed.
  `data/listings.sqlite` (public, non-sensitive listing metadata) stays local
  too — it is gitignored, not committed by anything.
