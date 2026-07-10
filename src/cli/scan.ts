import { runScan } from '../core/scan';

async function main(): Promise<void> {
  const summary = await runScan();

  for (const s of summary.perSource) {
    console.log(
      `  ${s.name}: ${s.fetched} active listings — ` +
        `${s.inserted} new, ${s.candidates} candidates, ${s.alreadySeen} already seen`,
    );
  }
  for (const err of summary.errors) {
    console.error(`  ${err}`);
  }

  if (summary.newCandidates.length > 0) {
    console.log('\nNew candidates:');
    for (const l of summary.newCandidates) {
      console.log(
        `  - ${l.company} — ${l.title} (${l.locations.join('; ') || 'location n/a'})\n    ${l.url}`,
      );
    }
  }

  const suffix = summary.failures > 0 ? ` (${summary.failures} source(s) failed)` : '';
  console.log(`\n${summary.totalNew} new, ${summary.totalCandidates} candidates${suffix}`);
}

main().catch((err) => {
  console.error('scan failed:', err);
  process.exitCode = 1;
});
