import { ListingSource } from '../scrapers/types';
import { StoredListing } from '../db/store';

const SOURCE_LABELS: Record<ListingSource, string> = {
  'simplify-newgrad': 'SimplifyJobs — New Grad Positions',
  'simplify-summer2026': 'SimplifyJobs — Summer 2026 Internships',
  'sndsh-summer2027': 'sndsh404 — Summer 2027 Internships',
};

const SOURCE_ORDER: ListingSource[] = [
  'simplify-newgrad',
  'simplify-summer2026',
  'sndsh-summer2027',
];

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(unixSeconds: number): string {
  if (!unixSeconds) return 'date unknown';
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function layout(title: string, activeNav: 'dashboard' | 'history', body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Job-Agent</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; line-height: 1.4; }
  header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem; }
  h1 { font-size: 1.4rem; margin: 0; }
  nav a { margin-right: 1rem; text-decoration: none; }
  nav a.active { font-weight: bold; text-decoration: underline; }
  .source-group { margin-bottom: 2rem; }
  .source-group h2 { font-size: 1.05rem; border-bottom: 1px solid #8884; padding-bottom: 0.25rem; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 0.5rem; }
  th, td { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { font-size: 0.8rem; text-transform: uppercase; opacity: 0.7; }
  .muted { opacity: 0.65; font-size: 0.85rem; }
  .actions form { display: inline; }
  button { cursor: pointer; padding: 0.3rem 0.7rem; border-radius: 4px; border: 1px solid #8886; background: transparent; font-size: 0.85rem; }
  button.apply { border-color: #2a8f4b; color: #2a8f4b; }
  button.decline { border-color: #b3403a; color: #b3403a; }
  .refresh-btn { padding: 0.4rem 0.9rem; }
  .empty { opacity: 0.6; font-style: italic; padding: 1rem 0; }
  .flash { background: #8882; padding: 0.5rem 0.75rem; border-radius: 4px; margin-bottom: 1rem; font-size: 0.9rem; }
  .status-tag { font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 3px; border: 1px solid #8886; }
  .status-tag.applied { color: #2a8f4b; border-color: #2a8f4b; }
  .status-tag.dismissed { color: #b3403a; border-color: #b3403a; }
  .type-tag { font-size: 0.75rem; padding: 0.1rem 0.4rem; border-radius: 3px; border: 1px solid #8886; white-space: nowrap; }
  .type-tag.new-grad { color: #3a6fb0; border-color: #3a6fb0; }
  .type-tag.internship { color: #9a6a1f; border-color: #9a6a1f; }
  .apply-cmd { font-size: 0.7rem; word-break: break-all; background: #8881; padding: 0.2rem 0.35rem; border-radius: 3px; display: inline-block; user-select: all; }
</style>
</head>
<body>
<header>
  <h1>Job-Agent</h1>
  <nav>
    <a href="/" class="${activeNav === 'dashboard' ? 'active' : ''}">Dashboard</a>
    <a href="/history" class="${activeNav === 'history' ? 'active' : ''}">History</a>
  </nav>
</header>
${body}
</body>
</html>`;
}

function typeTag(l: StoredListing): string {
  const cls = l.positionType === 'Internship' ? 'internship' : 'new-grad';
  return `<span class="type-tag ${cls}">${escapeHtml(l.positionType)}</span>`;
}

function listingRow(l: StoredListing, actions: string): string {
  const locations = l.locations.length ? escapeHtml(l.locations.join('; ')) : '—';
  const terms = l.terms.length ? escapeHtml(l.terms.join(', ')) : '—';
  return `<tr>
  <td>${escapeHtml(l.company)}</td>
  <td>${escapeHtml(l.title)}</td>
  <td>${typeTag(l)}</td>
  <td>${locations}</td>
  <td>${terms}</td>
  <td class="muted">${fmtDate(l.datePosted)}</td>
  <td><a href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">Open posting →</a></td>
  <td><code class="apply-cmd">npm run apply -- ${escapeHtml(l.id)}</code></td>
  <td class="actions">${actions}</td>
</tr>`;
}

function groupBySource(listings: StoredListing[]): Map<ListingSource, StoredListing[]> {
  const map = new Map<ListingSource, StoredListing[]>();
  for (const src of SOURCE_ORDER) map.set(src, []);
  for (const l of listings) {
    if (!map.has(l.source)) map.set(l.source, []);
    map.get(l.source)!.push(l);
  }
  return map;
}

export function renderDashboard(candidates: StoredListing[], flash?: string): string {
  const grouped = groupBySource(candidates);
  let body = '';
  body += `<form method="post" action="/refresh" style="margin-bottom: 1rem;">
    <button type="submit" class="refresh-btn">Refresh now</button>
    <span class="muted"> — also auto-refreshes hourly in the background while the server runs.</span>
  </form>`;
  if (flash) body += `<div class="flash">${escapeHtml(flash)}</div>`;

  if (candidates.length === 0) {
    body += `<p class="empty">No candidate listings right now. Run a scan, or widen config/filters.yaml.</p>`;
  }

  for (const [source, items] of grouped) {
    if (items.length === 0) continue;
    body += `<div class="source-group">
  <h2>${escapeHtml(SOURCE_LABELS[source] ?? source)} <span class="muted">(${items.length})</span></h2>
  <table>
    <thead><tr><th>Company</th><th>Title</th><th>Type</th><th>Location</th><th>Term</th><th>Posted</th><th>Link</th><th>Apply via CLI</th><th>Action</th></tr></thead>
    <tbody>
      ${items
        .map((l) =>
          listingRow(
            l,
            `<form method="post" action="/listings/${encodeURIComponent(l.id)}/apply">
              <button type="submit" class="apply">Apply</button>
            </form>
            <form method="post" action="/listings/${encodeURIComponent(l.id)}/decline">
              <button type="submit" class="decline">Decline</button>
            </form>`,
          ),
        )
        .join('\n')}
    </tbody>
  </table>
</div>`;
  }

  return layout('Dashboard', 'dashboard', body);
}

export function renderHistory(applied: StoredListing[], dismissed: StoredListing[]): string {
  let body = '';

  body += `<div class="source-group">
  <h2>Applied <span class="muted">(${applied.length})</span></h2>
  ${
    applied.length === 0
      ? '<p class="empty">Nothing marked applied yet.</p>'
      : `<table>
    <thead><tr><th>Company</th><th>Title</th><th>Type</th><th>Location</th><th>Term</th><th>Posted</th><th>Link</th><th>Apply via CLI</th><th></th></tr></thead>
    <tbody>
      ${applied.map((l) => listingRow(l, `<span class="status-tag applied">applied</span>`)).join('\n')}
    </tbody>
  </table>`
  }
</div>`;

  body += `<div class="source-group">
  <h2>Declined <span class="muted">(${dismissed.length})</span></h2>
  ${
    dismissed.length === 0
      ? '<p class="empty">Nothing declined yet.</p>'
      : `<table>
    <thead><tr><th>Company</th><th>Title</th><th>Type</th><th>Location</th><th>Term</th><th>Posted</th><th>Link</th><th>Apply via CLI</th><th></th></tr></thead>
    <tbody>
      ${dismissed.map((l) => listingRow(l, `<span class="status-tag dismissed">declined</span>`)).join('\n')}
    </tbody>
  </table>`
  }
</div>`;

  return layout('History', 'history', body);
}
