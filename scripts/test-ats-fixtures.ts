import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, Page } from 'playwright';
import { ashby } from '../src/ats/ashby';
import { fillSignIn, loadCredentials } from '../src/ats/credentials';
import { detectHandler } from '../src/ats/detect';
import { fallback } from '../src/ats/fallback';
import { greenhouse } from '../src/ats/greenhouse';
import { fillField } from '../src/ats/helpers';
import { lever } from '../src/ats/lever';
import type { Profile } from '../src/ats/profile';
import { emptyResult } from '../src/ats/types';
import { workday } from '../src/ats/workday';

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
  twitter: 'https://x.com/testy',
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
    'jobs.ashbyhq.com -> Ashby',
    detectHandler('https://jobs.ashbyhq.com/acme/1234-abcd').name === 'Ashby',
  );
  check(
    'myworkdayjobs.com -> Workday',
    detectHandler('https://acme.wd1.myworkdayjobs.com/en-US/careers/job/123').name ===
      'Workday (first page only)',
  );
  check(
    'myworkdaysite.com -> Workday',
    detectHandler('https://acme.wd5.myworkdaysite.com/recruiting/acme/careers').name ===
      'Workday (first page only)',
  );
  check(
    'myworkdayjobs.com.evil.example is NOT Workday',
    detectHandler('https://acme.wd1.myworkdayjobs.com.evil.example/x').name ===
      'Generic (best-effort autofill)',
  );
  check(
    'icims.com -> fallback',
    detectHandler('https://careers-acme.icims.com/jobs/1234/job').name ===
      'Generic (best-effort autofill)',
  );
  check(
    'greenhouse.io.evil.example is NOT Greenhouse',
    detectHandler('https://job-boards.greenhouse.io.evil.example/x').name ===
      'Generic (best-effort autofill)',
  );
  check(
    'garbage URL -> fallback (no throw)',
    detectHandler('not a url at all').name === 'Generic (best-effort autofill)',
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
  check('Twitter/X filled', (await value(page, '#question_twitter')) === 'https://x.com/testy');
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
    [
      'First Name',
      'Last Name',
      'Email',
      'Phone',
      'Country',
      'Resume',
      'LinkedIn',
      'School',
      'Twitter/X',
    ].every((f) => result.filled.includes(f)),
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

async function testAshby(page: Page): Promise<void> {
  console.log('\nAshby handler vs test/fixtures/ashby.html:');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'ashby.html')).href);
  const result = await ashby.fill(page, profile);

  // Résumé uploaded first, and its (simulated) parse-and-overwrite settles
  // before the real values get filled — same ordering fix as Greenhouse/Lever.
  check('Name filled (survives simulated resume-parse overwrite)', (await value(page, '#name')) === 'Testy McTestface');
  check('Email filled (survives simulated resume-parse overwrite)', (await value(page, '#email')) === 'testy@example.com');
  check('Phone filled', (await value(page, '#phone')) === '555-000-1111');
  check('Location filled', (await value(page, '#location')) === 'Testville, TS');
  check('LinkedIn filled', (await value(page, '#linkedin')) === 'https://www.linkedin.com/in/testy');
  check('GitHub filled', (await value(page, '#github')) === 'https://github.com/testy');
  check('Portfolio filled', (await value(page, '#portfolio')) === 'https://testy.example.com');
  check('Twitter/X filled', (await value(page, '#twitter')) === 'https://x.com/testy');
  check('School filled', (await value(page, '#school')) === 'Test University');
  check('Degree filled', (await value(page, '#degree')) === 'B.S. Testing');
  check('Graduation date filled', (await value(page, '#grad_date')) === 'May 2099');

  const resume = await attachedFile(page, '#resume');
  check(
    `Resume attached via setInputFiles (${RESUME_NAME})`,
    resume !== null && resume.name === RESUME_NAME && resume.size > 0,
  );
  check('result.resumeUploaded is true', result.resumeUploaded);

  check('Custom question textarea left blank', (await value(page, '#question_why')) === '');
  check('EEO gender identity text input NOT filled', (await value(page, '#gender_identity')) === '');
  check('EEO veteran select NOT filled', (await value(page, '#veteran')) === '');
  check('EEO disability select NOT filled', (await value(page, '#disability')) === '');

  check(
    'filled list looks right',
    [
      'Name',
      'Email',
      'Phone',
      'Location',
      'Resume',
      'LinkedIn',
      'GitHub',
      'Portfolio/Website',
      'Twitter/X',
      'School',
      'Degree',
      'Graduation Date',
    ].every((f) => result.filled.includes(f)),
  );
}

async function testWorkday(page: Page): Promise<void> {
  console.log('\nWorkday handler vs test/fixtures/workday.html:');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'workday.html')).href);
  const result = await workday.fill(page, profile);

  // First/Last/Phone/City have no associated <label> in the fixture (as on
  // real Workday) — these prove the data-automation-id fallbacks work.
  check(
    'First Name filled via data-automation-id fallback',
    (await value(page, '[data-automation-id="legalNameSection_firstName"]')) === 'Testy',
  );
  check(
    'Last Name filled via data-automation-id fallback',
    (await value(page, '[data-automation-id="legalNameSection_lastName"]')) === 'McTestface',
  );
  check('Email filled (proper label)', (await value(page, '#email')) === 'testy@example.com');
  check(
    'Phone filled via data-automation-id fallback',
    (await value(page, '[data-automation-id="phone-number"]')) === '555-000-1111',
  );
  check(
    'City filled via data-automation-id fallback',
    (await value(page, '[data-automation-id="addressSection_city"]')) === 'Testville',
  );

  const deviceType = await page
    .locator('[data-automation-id="phone-device-type"]')
    .textContent();
  check('Phone device type dropdown (button) left alone', (deviceType ?? '').trim() === 'Select One');
  const country = await page.locator('[data-automation-id="countryDropdown"]').textContent();
  check('Country dropdown (button) left alone', (country ?? '').trim() === 'Select One');

  check('No resume uploaded (no file input on this page)', !result.resumeUploaded);
  check('Resume reported in skipped', result.skipped.includes('Resume'));
  check(
    'Note explains resume belongs on the My Experience step',
    result.notes.some((n) => /my experience/i.test(n)),
  );
  check(
    'Note says first-page-only, rest of wizard is manual',
    result.notes.some((n) => /first page only/i.test(n)),
  );
  check(
    'filled list looks right',
    ['First Name', 'Last Name', 'Email', 'Phone', 'City'].every((f) => result.filled.includes(f)),
  );
}

async function testWorkdaySignInWall(page: Page): Promise<void> {
  console.log('\nWorkday handler: stops at the sign-in wall, never touches credentials:');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'workday.html')).href);
  // Simulate the tenant demanding sign-in/account creation before the form.
  await page.evaluate(() => {
    const email = document.createElement('input');
    email.type = 'email';
    email.setAttribute('data-automation-id', 'signIn-email');
    const pw = document.createElement('input');
    pw.type = 'password';
    pw.setAttribute('data-automation-id', 'password');
    document.body.prepend(pw);
    document.body.prepend(email);
  });

  const result = await workday.fill(page, profile);
  check('Nothing filled behind a sign-in wall', result.filled.length === 0);
  check('Password field untouched', (await value(page, '[data-automation-id="password"]')) === '');
  check(
    'Note tells the user to sign in themselves and re-run',
    result.notes.some((n) => /sign in/i.test(n) && /re-?run/i.test(n)),
  );
  check(
    'Form fields behind the wall also untouched',
    (await value(page, '[data-automation-id="legalNameSection_firstName"]')) === '',
  );
}

async function testWorkdayCredentialSignIn(page: Page): Promise<void> {
  console.log('\nWorkday credentials (opt-in): signs in, then the normal fill works:');
  check(
    'loadCredentials returns null for a missing file (feature off by default)',
    loadCredentials('workday', path.join(ROOT, 'no-such-credentials.json')) === null,
  );

  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'workday-signin.html')).href);
  const result = emptyResult();
  const outcome = await fillSignIn(
    page,
    { password: 'test-secret-pw' }, // email omitted -> falls back to profile email
    profile.email,
    result,
  );

  check('outcome is signed-in', outcome === 'signed-in');
  check('sign-in wall is gone after the click', !(await page.locator('#signin-wall').isVisible()));
  check('application form revealed', await page.locator('#application-form').isVisible());
  check(
    'email fell back to the profile email',
    (await value(page, '#signin-email')) === 'testy@example.com',
  );
  check(
    'password value never appears in any note',
    result.notes.every((n) => !n.includes('test-secret-pw')),
  );

  // The "re-run after sign-in" story: the handler now sees the form, no wall.
  const fillResult = await workday.fill(page, profile);
  check(
    'First Name filled after sign-in',
    (await value(page, '#first-name')) === 'Testy',
  );
  check(
    'filled list looks right post-sign-in',
    ['First Name', 'Last Name', 'Email', 'Phone'].every((f) => fillResult.filled.includes(f)),
  );
}

async function testWorkdayAccountCreation(page: Page): Promise<void> {
  console.log('\nWorkday credentials: account creation stops before ToS (createAccounts off):');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'workday-signin.html')).href);
  await page.click('#create-account-link');

  const result = emptyResult();
  const outcome = await fillSignIn(page, { password: 'test-secret-pw' }, profile.email, result);

  check('outcome is account-creation', outcome === 'account-creation');
  check('password filled', (await value(page, '#create-password')) === 'test-secret-pw');
  check('confirm-password filled too', (await value(page, '#create-confirm')) === 'test-secret-pw');
  check('ToS checkbox NOT ticked', !(await page.locator('#tos-agree').isChecked()));
  check(
    'Create Account not clicked — the creation wall is still showing',
    await page.locator('#create-wall').isVisible(),
  );
  check(
    'note hands ToS + Create Account to the human',
    result.notes.some((n) => /terms/i.test(n) && /create account/i.test(n)),
  );
}

async function testWorkdayCreateAccountsOptIn(page: Page): Promise<void> {
  console.log('\nWorkday credentials: createAccounts opt-in pivots and creates the account end-to-end:');
  // Full handler path: real credentials file (temp, via JOB_AGENT_CREDENTIALS
  // so the user's config/credentials.json is never touched) with the
  // createAccounts flag on, against a tenant where sign-in bounces because
  // no account exists yet.
  const tmpCreds = path.join(os.tmpdir(), `job-agent-test-creds-${process.pid}.json`);
  writeFileSync(
    tmpCreds,
    JSON.stringify({
      workday: { email: 'testy@example.com', password: 'test-secret-pw', createAccounts: true },
    }),
  );
  process.env.JOB_AGENT_CREDENTIALS = tmpCreds;
  try {
    await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'workday-signin.html')).href);
    await page.evaluate(() => {
      (window as unknown as { NO_ACCOUNT_EXISTS: boolean }).NO_ACCOUNT_EXISTS = true;
    });

    const result = await workday.fill(page, profile);

    check('ToS agreement checkbox ticked (that is what the opt-in delegates)', await page.locator('#tos-agree').isChecked());
    check('marketing checkbox NOT ticked', !(await page.locator('#marketing-optin').isChecked()));
    check('account created — application form revealed', await page.locator('#application-form').isVisible());
    check(
      'note records the pivot to account creation',
      result.notes.some((n) => /sign-in bounced/i.test(n)),
    );
    check(
      'note records the account creation + email-verification heads-up',
      result.notes.some((n) => /created an account/i.test(n) && /verification/i.test(n)),
    );
    check('form filled after account creation', (await value(page, '#first-name')) === 'Testy');
    check(
      'password value never appears in any note',
      result.notes.every((n) => !n.includes('test-secret-pw')),
    );
  } finally {
    delete process.env.JOB_AGENT_CREDENTIALS;
    unlinkSync(tmpCreds);
  }
}

async function testAshbySignInWall(page: Page): Promise<void> {
  console.log('\nAshby handler: same shared wall flow (stop without creds, sign in with them):');
  // No credentials -> stop at the wall, fill nothing.
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'workday-signin.html')).href);
  const noCreds = await ashby.fill(page, profile);
  check('nothing filled behind a wall without credentials', noCreds.filled.length === 0);
  check(
    'note points at a credentials entry under the "ashby" key',
    noCreds.notes.some((n) => /sign in/i.test(n) && /"ashby"/.test(n)),
  );

  // With credentials under the "ashby" key -> signs in and fills the form.
  const tmpCreds = path.join(os.tmpdir(), `job-agent-test-ashby-creds-${process.pid}.json`);
  writeFileSync(
    tmpCreds,
    JSON.stringify({ ashby: { email: 'testy@example.com', password: 'test-secret-pw' } }),
  );
  process.env.JOB_AGENT_CREDENTIALS = tmpCreds;
  try {
    await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'workday-signin.html')).href);
    const result = await ashby.fill(page, profile);
    check('signed in — application form revealed', await page.locator('#application-form').isVisible());
    check('First Name filled after sign-in', (await value(page, '#first-name')) === 'Testy');
    check(
      'filled list looks right post-sign-in',
      ['First Name', 'Last Name', 'Email', 'Phone'].every((f) => result.filled.includes(f)),
    );
    check(
      'password value never appears in any note',
      result.notes.every((n) => !n.includes('test-secret-pw')),
    );
  } finally {
    delete process.env.JOB_AGENT_CREDENTIALS;
    unlinkSync(tmpCreds);
  }
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
  check('Twitter/X URL filled', (await value(page, '#url-twitter')) === 'https://x.com/testy');
  check('Portfolio (absent on page) reported in skipped', result.skipped.includes('Portfolio'));

  check('Additional information textarea left blank', (await value(page, '#comments')) === '');

  check('EEO gender select NOT filled', (await value(page, '#eeo-gender')) === '');
  check('EEO race select NOT filled', (await value(page, '#eeo-race')) === '');
  check('EEO veteran select NOT filled', (await value(page, '#eeo-veteran')) === '');

  check(
    'filled list looks right',
    [
      'Full Name',
      'Email',
      'Phone',
      'Current Location',
      'Resume',
      'LinkedIn',
      'GitHub',
      'Twitter/X',
    ].every((f) => result.filled.includes(f)),
  );
}

async function testCaptchaGuard(page: Page): Promise<void> {
  console.log('\nCAPTCHA guard: stops entirely rather than filling past it:');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'greenhouse.html')).href);
  // Simulate a CAPTCHA widget having appeared on the page (e.g. a Cloudflare
  // Turnstile / reCAPTCHA challenge) before any filling happens.
  await page.evaluate(() => {
    const div = document.createElement('div');
    div.className = 'g-recaptcha';
    div.setAttribute('data-sitekey', 'test');
    div.style.cssText = 'width: 300px; height: 76px;';
    document.body.prepend(div);
  });

  const result = await greenhouse.fill(page, profile);
  check('Nothing filled while a CAPTCHA is showing', result.filled.length === 0);
  check('Nothing reported skipped either (fill never even attempted)', result.skipped.length === 0);
  check(
    'A clear note explains the CAPTCHA blocked filling',
    result.notes.some((n) => /captcha/i.test(n)),
  );
  check('First Name left untouched', (await value(page, '#first_name')) === '');
}

async function testCaptchaAfterResumeUpload(page: Page): Promise<void> {
  console.log('\nCAPTCHA guard: also catches a challenge that appears after the résumé upload:');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'greenhouse.html')).href);
  // Simulate a CAPTCHA that only appears once the résumé finishes uploading
  // (not present at page load) — this is what "appears partway through"
  // looks like, and is exactly why there's a second check after the upload.
  await page.evaluate(() => {
    document.getElementById('resume')!.addEventListener('change', () => {
      setTimeout(() => {
        const div = document.createElement('div');
        div.className = 'h-captcha';
        div.setAttribute('data-sitekey', 'test');
        div.style.cssText = 'width: 300px; height: 78px;';
        document.body.prepend(div);
      }, 50);
    });
  });

  const result = await greenhouse.fill(page, profile);
  check('Résumé was still uploaded (captcha appeared only after)', result.resumeUploaded);
  check(
    'Nothing else filled once the post-upload CAPTCHA appeared',
    result.filled.length === 1 && result.filled[0] === 'Resume',
  );
  check(
    'Note explains the CAPTCHA appeared after the résumé upload',
    result.notes.some((n) => /captcha/i.test(n) && /résumé|resume/i.test(n)),
  );
  // Note: First Name isn't necessarily empty here — the fixture's own
  // simulated resume-parse script overwrites it independently of our code.
  // What matters is that OUR handler never wrote its value into it.
  check(
    'Our code never filled First Name (stopped before reaching it)',
    (await value(page, '#first_name')) !== profile.firstName,
  );
}

async function testCaptchaDuringLocationFill(page: Page): Promise<void> {
  console.log('\nCAPTCHA guard: also catches a challenge triggered by the location autocomplete:');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'lever.html')).href);
  // Simulate the location field's live lookup itself triggering a CAPTCHA
  // (confirmed live on Lever) — attached after the fixture's own listener,
  // so it runs second and wipes out the real suggestions in favor of a
  // captcha, mirroring "typing shows a challenge instead of results."
  await page.evaluate(() => {
    document.getElementById('location')!.addEventListener('input', () => {
      document.querySelector('.dropdown-results')!.innerHTML = '';
      if (!document.querySelector('.h-captcha')) {
        const div = document.createElement('div');
        div.className = 'h-captcha';
        div.setAttribute('data-sitekey', 'test');
        div.style.cssText = 'width: 300px; height: 78px;';
        document.body.prepend(div);
      }
    });
  });

  const result = await lever.fill(page, profile);
  check('Résumé was still uploaded (captcha appeared only later)', result.resumeUploaded);
  check(
    'Full Name/Email/Phone were still filled (captcha appeared only at location)',
    ['Full Name', 'Email', 'Phone'].every((f) => result.filled.includes(f)),
  );
  check('Current Location itself was not filled', !result.filled.includes('Current Location'));
  check(
    'Nothing after Current Location was filled either',
    !['LinkedIn', 'GitHub', 'Twitter/X'].some((f) => result.filled.includes(f)),
  );
  check(
    'Note explains the CAPTCHA appeared while filling in location',
    result.notes.some((n) => /captcha/i.test(n) && /location/i.test(n)),
  );
}

async function testGenericSweep(page: Page): Promise<void> {
  console.log('\nGeneric sweep (fallback handler) vs test/fixtures/generic.html:');
  await page.goto(pathToFileURL(path.join(ROOT, 'test', 'fixtures', 'generic.html')).href);
  const result = await fallback.fill(page, profile);

  // Labels deliberately worded differently from what any handler looks for —
  // classified by context, not by expected label strings.
  check('"Given name" filled with first name', (await value(page, '#given')) === 'Testy');
  check('"Surname" filled with last name', (await value(page, '#surname')) === 'McTestface');
  check('"E-mail address" filled', (await value(page, '#mail')) === 'testy@example.com');
  check(
    '"Confirm e-mail address" filled too (both email inputs)',
    (await value(page, '#mail2')) === 'testy@example.com',
  );
  check('"Mobile number" filled with phone', (await value(page, '#mobile')) === '555-000-1111');
  check(
    '"Where are you currently based?" filled with city, state',
    (await value(page, '#based')) === 'Testville, TS',
  );
  check(
    'placeholder-only LinkedIn input filled (no label at all)',
    (await value(page, '#li')) === 'https://www.linkedin.com/in/testy',
  );
  check('"Alma mater" filled with school', (await value(page, '#alma')) === 'Test University');

  const resume = await attachedFile(page, '#resume');
  check(
    `Résumé attached via the generic flow (${RESUME_NAME})`,
    resume !== null && resume.name === RESUME_NAME && resume.size > 0,
  );

  check('pre-filled reference code NOT overwritten', (await value(page, '#ref')) === 'JOB-1234');
  check('"Current company name" NOT mistaken for the applicant name', (await value(page, '#company')) === '');
  check('"Expected compensation" left blank (no matcher guesses)', (await value(page, '#salary')) === '');
  check('free-text "Why do you want this role?" left blank', (await value(page, '#why')) === '');
  check('EEO gender input NOT filled', (await value(page, '#gender')) === '');
  check(
    'EEO field NOT listed among fields needing attention',
    !result.notes.some((n) => /gender/i.test(n)),
  );
  check(
    'unmatched fields are NAMED in the notes, not silently dropped',
    result.notes.some((n) => /need your attention/.test(n) && /Expected compensation/.test(n)),
  );
  check(
    'note mentions the ANTHROPIC_API_KEY opt-in when no key is set',
    result.notes.some((n) => /ANTHROPIC_API_KEY/.test(n)),
  );
  check(
    'filled list looks right',
    ['First Name', 'Last Name', 'Email', 'Phone', 'Location', 'LinkedIn', 'School', 'Resume'].every(
      (f) => result.filled.includes(f),
    ),
  );
}

async function main(): Promise<void> {
  // The sweep's LLM assist activates on ANTHROPIC_API_KEY — keep the test
  // suite deterministic and fully offline regardless of the environment.
  delete process.env.ANTHROPIC_API_KEY;

  if (!existsSync(RESUME)) {
    console.error(`Resume file not found at ${RESUME} — this test uploads a real PDF.`);
    process.exit(1);
  }

  testDetection();

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await testGreenhouse(page);
    await testAshby(page);
    await testLever(page);
    await testWorkday(page);
    await testWorkdaySignInWall(page);
    await testWorkdayCredentialSignIn(page);
    await testWorkdayAccountCreation(page);
    await testWorkdayCreateAccountsOptIn(page);
    await testAshbySignInWall(page);
    await testCaptchaGuard(page);
    await testCaptchaAfterResumeUpload(page);
    await testCaptchaDuringLocationFill(page);
    await testGenericSweep(page);
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
