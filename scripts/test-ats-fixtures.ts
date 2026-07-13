import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, Page } from 'playwright';
import { detectHandler } from '../src/ats/detect';
import { greenhouse } from '../src/ats/greenhouse';
import { fillField } from '../src/ats/helpers';
import { lever } from '../src/ats/lever';
import type { Profile } from '../src/ats/profile';
import { emptyResult } from '../src/ats/types';

/**
 * Fixture tests for the ATS handlers: launches Playwright against the local
 * static pages in test/fixtures/ (file:// URLs) and asserts the handlers
 * filled/skipped the right things, that setInputFiles really attached the
 * resume, and that EEO / custom-question fields were left strictly alone.
 *
 * Run with: npm run test:ats   (i.e. tsx scripts/test-ats-fixtures.ts)
 *
 * Deliberately not a test framework — this project has no test runner, and a
 * plain script that prints PASS/FAIL and exits non-zero on failure is enough.
 * Headless on purpose (unlike the apply flow, which is always headed per
 * playwright.config.ts): nothing here needs a human watching, and it must
 * run in displayless environments.
 */

const ROOT = path.resolve(__dirname, '..');
const RESUME = path.join(ROOT, 'resumes', 'DZ_SWE_Resume.pdf');
const RESUME_NAME = path.basename(RESUME);

// Self-contained fake test data — never reads config/profile.json. Only the
// resume file itself is real, so setInputFiles is exercised against a real PDF.
const profile: Profile = {
  firstName: 'Testy',
  lastName: 'McTestface',
  email: 'testy@example.com',
  phone: '555-000-1111',
  city: 'Testville',
  state: 'TS',
  school: 'Test University',
  degree: 'B.S. Testing',
  graduationMonth: 'May',
  graduationYear: 2099,
  linkedin: 'https://www.linkedin.com/in/testy',
  github: 'https://github.com/testy',
  portfolio: 'https://testy.example.com',
  resumePath: RESUME,
  country: 'United States',
};

const failures: string[] = [];
function check(name: string, cond: boolean): void {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures.push(name);
  }
}

async function value(page: Page, selector: string): Promise<string> {
  return page.locator(selector).inputValue();
}

async function attachedFile(page: Page, selector: string): Promise<{ name: string; size: number } | null> {
  return page.locator(selector).evaluate((node) => {
    const input = node as HTMLInputElement;
    const f = input.files && input.files[0];
    return f ? { name: f.name, size: f.size } : null;
  });
}

function testDetection(): void {
  console.log('\ndetect.ts routing:');
  check(
    'job-boards.greenhouse.io -> Greenhouse',
    detectHandler('https://job-boards.greenhouse.io/acme/jobs/123').name === 'Greenhouse',
  );
  check(
    'boards.greenhouse.io -> Greenhouse',
    detectHandler('https://boards.greenhouse.io/acme/jobs/123').name === 'Greenhouse',
  );
  check(
    'jobs.lever.co -> Lever',
    detectHandler('https://jobs.lever.co/acme/1234-abcd/apply').name === 'Lever',
  );
  check(
    'myworkdayjobs.com -> fallback',
    detectHandler('https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123').name ===
      'Manual (unsupported ATS)',
  );
  check(
    'greenhouse.io.evil.example is NOT Greenhouse',
    detectHandler('https://job-boards.greenhouse.io.evil.example/x').name ===
      'Manual (unsupported ATS)',
  );
  check(
    'garbage URL -> fallback (no throw)',
    detectHandler('not a url at all').name === 'Manual (unsupported ATS)',
  );
}

async function testGreenhouse(page: Page): Promise<void> {
  console.log('\nGreenhouse handler vs test/fixtures/greenhouse.html:');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'greenhouse.html')).href);
  const result = await greenhouse.fill(page, profile);

  check('First Name filled', (await value(page, '#first_name')) === 'Testy');
  check('Last Name filled', (await value(page, '#last_name')) === 'McTestface');
  check('Email filled', (await value(page, '#email')) === 'testy@example.com');
  check('Phone filled', (await value(page, '#phone')) === '555-000-1111');
  check(
    'Country combobox filled by typing + clicking the matching option',
    (await value(page, '#country-value')) === 'United States',
  );
  check('Location filled', (await value(page, '#candidate-location')) === 'Testville, TS');
  check(
    'LinkedIn filled',
    (await value(page, '#question_linkedin')) === 'https://www.linkedin.com/in/testy',
  );
  check('Website filled with portfolio', (await value(page, '#question_website')) === 'https://testy.example.com');
  check('School filled (plain text input)', (await value(page, '#school')) === 'Test University');
  check('Graduation date filled', (await value(page, '#grad_date')) === 'May 2099');

  const resume = await attachedFile(page, '#resume');
  check(
    `Resume attached via setInputFiles (${RESUME_NAME})`,
    resume !== null && resume.name === RESUME_NAME && resume.size > 0,
  );
  check('result.resumeUploaded is true', result.resumeUploaded);
  const cover = await attachedFile(page, '#cover_letter');
  check('Cover letter input left empty (not guessed at)', cover === null);

  check('Degree <select> not filled (selects are never set)', (await value(page, '#degree')) === '');
  check('Degree reported in skipped', result.skipped.includes('Degree'));
  check('GitHub (absent on page) reported in skipped', result.skipped.includes('GitHub'));

  check('Custom question textarea left blank', (await value(page, '#question_why')) === '');
  check('Desired salary left blank', (await value(page, '#question_salary')) === '');

  // EEO / voluntary self-identification: never auto-answered, ever.
  check('EEO gender identity text input NOT filled', (await value(page, '#gender_identity')) === '');
  check('EEO Hispanic/Latino select NOT filled', (await value(page, '#hispanic')) === '');
  check('EEO veteran select NOT filled', (await value(page, '#veteran')) === '');
  check('EEO disability select NOT filled', (await value(page, '#disability')) === '');

  check(
    'note about free-text questions present',
    result.notes.some((n) => /free-text question/.test(n)),
  );
  check(
    'filled list looks right',
    ['First Name', 'Last Name', 'Email', 'Phone', 'Country', 'Resume', 'LinkedIn', 'School'].every(
      (f) => result.filled.includes(f),
    ),
  );

  // Hard-guard test: even a hostile field spec that MATCHES an EEO label by
  // accessible name must be refused by the helper layer.
  const probe = emptyResult();
  await fillField(
    page,
    { field: 'EEO guard probe', labels: [/gender identity/i], value: 'must-not-appear' },
    probe,
  );
  check('EEO guard blocks a direct label match on a text input', (await value(page, '#gender_identity')) === '');
  check('EEO guard probe reported as skipped', probe.skipped.includes('EEO guard probe'));
}

async function testLever(page: Page): Promise<void> {
  console.log('\nLever handler vs test/fixtures/lever.html:');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'lever.html')).href);
  const result = await lever.fill(page, profile);

  check('Full name filled (first + last)', (await value(page, '#name')) === 'Testy McTestface');
  check('Email filled', (await value(page, '#email')) === 'testy@example.com');
  check('Phone filled', (await value(page, '#phone')) === '555-000-1111');
  check(
    'Current location: state-matching suggestion picked, not just the first one',
    (await value(page, '#location')) === 'Testville, TS, USA',
  );
  check(
    'Current location: hidden selectedLocation set via click (not just typed text)',
    (await value(page, '#selected-location')) === 'Testville, TS, USA',
  );
  check('Current company left blank (no profile mapping)', (await value(page, '#org')) === '');

  const resume = await attachedFile(page, '#resume-upload');
  check(
    `Resume attached via setInputFiles (${RESUME_NAME})`,
    resume !== null && resume.name === RESUME_NAME && resume.size > 0,
  );
  check('result.resumeUploaded is true', result.resumeUploaded);

  check(
    'LinkedIn URL filled',
    (await value(page, '#url-linkedin')) === 'https://www.linkedin.com/in/testy',
  );
  check('GitHub URL filled', (await value(page, '#url-github')) === 'https://github.com/testy');
  check('Portfolio (absent on page) reported in skipped', result.skipped.includes('Portfolio'));

  check('Additional information textarea left blank', (await value(page, '#comments')) === '');

  check('EEO gender select NOT filled', (await value(page, '#eeo-gender')) === '');
  check('EEO race select NOT filled', (await value(page, '#eeo-race')) === '');
  check('EEO veteran select NOT filled', (await value(page, '#eeo-veteran')) === '');

  check(
    'filled list looks right',
    ['Full Name', 'Email', 'Phone', 'Current Location', 'Resume', 'LinkedIn', 'GitHub'].every(
      (f) => result.filled.includes(f),
    ),
  );
}

async function main(): Promise<void> {
  if (!existsSync(RESUME)) {
    console.error(`Resume file not found at ${RESUME} — this test uploads a real PDF.`);
    process.exit(1);
  }

  testDetection();

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await testGreenhouse(page);
    await testLever(page);
  } finally {
    await browser.close();
  }

  console.log('');
  if (failures.length > 0) {
    console.error(`FAIL — ${failures.length} assertion(s) failed.`);
    process.exit(1);
  }
  console.log('PASS — all ATS fixture assertions passed.');
}

main().catch((err) => {
  console.error('test-ats-fixtures crashed:', err);
  process.exit(1);
});
