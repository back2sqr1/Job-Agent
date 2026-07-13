import express from 'express';
import { DB_PATH, runScan, ScanSummary } from './core/scan';
import { Store } from './db/store';
import { PositionFilter, renderDashboard, renderHistory } from './web/render';

/** Reads ?type= off a request, defaulting to 'all' for anything unrecognized. */
function parseTypeFilter(raw: unknown): PositionFilter {
  return raw === 'new-grad' || raw === 'internship' ? raw : 'all';
}

/** Where a POST action should redirect back to, preserving the active tab. */
function dashboardRedirect(activeType: PositionFilter): string {
  return activeType === 'all' ? '/' : `/?type=${activeType}`;
}

const PORT = Number(process.env.PORT) || 3000;
const HOURLY_MS = 60 * 60 * 1000;

let lastScanSummary: ScanSummary | null = null;
let lastScanAt: number | null = null;
let scanInFlight: Promise<ScanSummary> | null = null;

/** Runs a scan, guarding against overlapping runs (boot scan vs. /refresh vs. the hourly timer). */
async function scanOnce(label: string): Promise<ScanSummary> {
  if (scanInFlight) {
    console.log(`[scan] ${label}: a scan is already in progress, waiting for it instead`);
    return scanInFlight;
  }
  console.log(`[scan] ${label}: starting`);
  scanInFlight = runScan()
    .then((summary) => {
      lastScanSummary = summary;
      lastScanAt = Math.floor(Date.now() / 1000);
      console.log(
        `[scan] ${label}: done — ${summary.totalNew} new, ${summary.totalCandidates} candidates` +
          (summary.promotedFromBacklog > 0 ? `, +${summary.promotedFromBacklog} promoted from backlog` : '') +
          (summary.demotedToBacklog > 0 ? `, -${summary.demotedToBacklog} demoted back to new` : '') +
          (summary.failures > 0 ? ` (${summary.failures} source(s) failed)` : ''),
      );
      for (const err of summary.errors) console.error(`[scan] ${label}: ${err}`);
      return summary;
    })
    .catch((err) => {
      console.error(`[scan] ${label}: failed —`, err);
      throw err;
    })
    .finally(() => {
      scanInFlight = null;
    });
  return scanInFlight;
}

const app = express();
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => {
  const activeType = parseTypeFilter(req.query.type);
  const store = new Store(DB_PATH);
  let candidates;
  try {
    candidates = store.getByStatusWithMeta('candidate');
  } finally {
    store.close();
  }
  const counts = {
    all: candidates.length,
    newGrad: candidates.filter((l) => l.positionType === 'New Grad').length,
    internship: candidates.filter((l) => l.positionType === 'Internship').length,
  };
  const filtered =
    activeType === 'all'
      ? candidates
      : candidates.filter(
          (l) => l.positionType === (activeType === 'new-grad' ? 'New Grad' : 'Internship'),
        );
  const flash = lastScanAt
    ? `Last scan: ${new Date(lastScanAt * 1000).toLocaleString()} — ` +
      `${lastScanSummary?.totalNew ?? 0} new, ${lastScanSummary?.totalCandidates ?? 0} candidates` +
      (lastScanSummary && lastScanSummary.promotedFromBacklog > 0
        ? ` (+${lastScanSummary.promotedFromBacklog} promoted from backlog after your filters.yaml changes)`
        : '') +
      (lastScanSummary && lastScanSummary.failures > 0
        ? ` (${lastScanSummary.failures} source(s) failed)`
        : '')
    : undefined;
  res.send(renderDashboard(filtered, flash, activeType, counts));
});

app.get('/history', (_req, res) => {
  const store = new Store(DB_PATH);
  let applied, dismissed;
  try {
    applied = store.getByStatusWithMeta('applied');
    dismissed = store.getByStatusWithMeta('dismissed');
  } finally {
    store.close();
  }
  res.send(renderHistory(applied, dismissed));
});

app.post('/listings/:id/apply', (req, res) => {
  const activeType = parseTypeFilter(req.query.type);
  const store = new Store(DB_PATH);
  let ok;
  try {
    ok = store.setStatus(req.params.id, 'applied');
  } finally {
    store.close();
  }
  if (!ok) {
    res.status(404).send('Listing not found');
    return;
  }
  res.redirect(dashboardRedirect(activeType));
});

app.post('/listings/:id/decline', (req, res) => {
  const activeType = parseTypeFilter(req.query.type);
  const store = new Store(DB_PATH);
  let ok;
  try {
    ok = store.setStatus(req.params.id, 'dismissed');
  } finally {
    store.close();
  }
  if (!ok) {
    res.status(404).send('Listing not found');
    return;
  }
  res.redirect(dashboardRedirect(activeType));
});

app.post('/refresh', (req, res) => {
  const activeType = parseTypeFilter(req.query.type);
  scanOnce('manual /refresh')
    .then(() => res.redirect(dashboardRedirect(activeType)))
    .catch(() => res.redirect(dashboardRedirect(activeType)));
});

app.listen(PORT, () => {
  console.log(`Job-Agent listening on http://localhost:${PORT}`);
  console.log(`  GET  /            dashboard of candidate listings`);
  console.log(`  GET  /history     applied + declined listings`);
  console.log(`  POST /refresh     trigger an immediate scan`);
  console.log(`Polling the three sources every hour in the background. Running an initial scan now...`);

  // Boot-time scan so the dashboard has data without waiting an hour, then
  // repeat hourly for as long as the process stays up.
  scanOnce('startup').catch(() => {
    /* already logged in scanOnce */
  });
  setInterval(() => {
    scanOnce('hourly poll').catch(() => {
      /* already logged in scanOnce */
    });
  }, HOURLY_MS);
});
