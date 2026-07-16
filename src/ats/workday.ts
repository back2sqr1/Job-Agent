import type { Page } from 'playwright';
import { fillSignIn, loadCredentials } from './credentials';
import {
  fillField,
  isCaptchaPresent,
  uploadResume,
  waitForResumeParseToSettle,
} from './helpers';
import type { Profile } from './profile';
import { AtsHandler, FillResult, emptyResult } from './types';

/**
 * Workday job boards (<tenant>.wd<N>.myworkdayjobs.com / myworkdaysite.com).
 *
 * Workday is a multi-step wizard ("My Information" -> "My Experience" ->
 * application questions -> voluntary disclosures -> review), usually behind
 * an account sign-in. This handler deliberately covers ONLY the first form
 * page it lands on — it fills what maps to the Profile, then hands the rest
 * of the wizard to the human. It never clicks Next/Continue, and as
 * everywhere else: no submit, no CAPTCHA handling, EEO questions untouched.
 * Sign-in is manual by default; if the user opts in via
 * config/credentials.json, the sign-in form is filled and submitted with
 * their own credentials (account creation still stops before the ToS
 * checkbox / Create Account click — see credentials.ts).
 *
 * Field lookup is by accessible label first, with Workday's long-stable
 * `data-automation-id` attributes as fallbacks (these survive Workday's UI
 * re-skins far better than classes/ids do).
 *
 * UNVERIFIED against a live tenant — built best-guess like Greenhouse/Lever
 * originally were, fixture-tested only. Expect a correction round: report
 * the exact label/behavior of anything skipped or wrong.
 */
/** Click the sign-in page's "Create Account" link/button, if there is one. */
async function clickCreateAccountLink(page: Page): Promise<boolean> {
  const byRole = (role: 'link' | 'button') =>
    page.getByRole(role, { name: /create\s*account|sign\s*up/i }).first();
  for (const candidate of [byRole('link'), byRole('button')]) {
    try {
      await candidate.click({ timeout: 3_000 });
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
      await page.waitForTimeout(300);
      return true;
    } catch {
      // try the next shape
    }
  }
  return false;
}

async function hasVisiblePasswordField(page: Page): Promise<boolean> {
  const passwordFields = page.locator('input[type="password"]');
  const count = await passwordFields.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    if (await passwordFields.nth(i).isVisible().catch(() => false)) return true;
  }
  return false;
}

export const workday: AtsHandler = {
  name: 'Workday (first page only)',

  detect(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host.endsWith('.myworkdayjobs.com') || host.endsWith('.myworkdaysite.com');
    } catch {
      return false;
    }
  },

  async fill(page: Page, profile: Profile): Promise<FillResult> {
    const result = emptyResult();

    if (await isCaptchaPresent(page)) {
      result.notes.push(
        'A CAPTCHA / verification challenge is showing on this page — nothing was filled. ' +
          'Solve it yourself, then fill out the form by hand.',
      );
      return result;
    }

    // Workday tenants usually gate the application behind account
    // sign-in/creation. By default that's left to the human; if the user has
    // opted in via config/credentials.json (see credentials.ts — their own
    // account, their own machine), the sign-in form is filled and submitted
    // for them. Account creation is never fully automated: the ToS checkbox
    // and Create Account button always stay with the human.
    if (await hasVisiblePasswordField(page)) {
      const creds = loadCredentials('workday');
      if (!creds) {
        result.notes.push(
          'This Workday tenant is asking you to sign in / create an account first — do that ' +
            'yourself, navigate to the application form, then re-run this command to fill it. ' +
            '(Optional: copy config/credentials.example.json to config/credentials.json to let ' +
            'this step sign in for you.)',
        );
        return result;
      }

      let outcome = await fillSignIn(page, creds, profile.email, result);

      // Sign-in submitted but the wall is still up — on a tenant where no
      // account exists yet that's the expected bounce. With createAccounts
      // on, pivot to the Create Account form and let fillSignIn complete it
      // (it agrees to the ToS and clicks Create Account per that opt-in).
      if (
        outcome === 'signed-in' &&
        creds.createAccounts &&
        !(await isCaptchaPresent(page)) &&
        (await hasVisiblePasswordField(page))
      ) {
        result.notes.push(
          'Sign-in bounced (probably no account on this tenant yet) — trying account creation, ' +
            'since createAccounts is on.',
        );
        if (await clickCreateAccountLink(page)) {
          outcome = await fillSignIn(page, creds, profile.email, result);
        }
      }

      if (outcome !== 'signed-in' && outcome !== 'account-created') return result;

      if (await isCaptchaPresent(page)) {
        result.notes.push(
          'A CAPTCHA / verification challenge appeared after signing in — the form was not ' +
            'filled. Solve it yourself, then re-run this command.',
        );
        return result;
      }
      if (await hasVisiblePasswordField(page)) {
        result.notes.push(
          'Still on the sign-in/creation page after submitting credentials — they may be wrong ' +
            'for this tenant, or email verification is needed. Finish signing in yourself, then ' +
            're-run this command.',
        );
        return result;
      }
    }

    // Some tenants offer a resume upload ("Autofill with Resume" / Quick
    // Apply) up front; most put it on the "My Experience" page instead. If
    // there is no file input on this page, this lands in `skipped` — that is
    // expected, not a failure (see note below).
    await uploadResume(page, profile.resumePath, result);
    if (result.resumeUploaded) {
      await waitForResumeParseToSettle(page);
      if (await isCaptchaPresent(page)) {
        result.notes.push(
          'A CAPTCHA / verification challenge appeared after the résumé upload — the rest of the ' +
            'form was not filled. Solve it yourself, then fill out the rest by hand.',
        );
        return result;
      }
    } else {
      result.notes.push(
        'No resume upload found on this page — Workday usually asks for it on the ' +
          '"My Experience" step, so attach it there yourself.',
      );
    }

    await fillField(
      page,
      {
        field: 'First Name',
        labels: [/first\s*name/i],
        fallbackSelectors: ['[data-automation-id="legalNameSection_firstName"]'],
        value: profile.firstName,
      },
      result,
    );
    await fillField(
      page,
      {
        field: 'Last Name',
        labels: [/last\s*name/i],
        fallbackSelectors: ['[data-automation-id="legalNameSection_lastName"]'],
        value: profile.lastName,
      },
      result,
    );
    await fillField(
      page,
      {
        field: 'Email',
        labels: [/e-?mail/i],
        fallbackSelectors: ['[data-automation-id="email"]'],
        value: profile.email,
      },
      result,
    );
    await fillField(
      page,
      {
        field: 'Phone',
        labels: [/phone\s*number/i, /phone/i],
        fallbackSelectors: ['[data-automation-id="phone-number"]'],
        value: profile.phone,
      },
      result,
    );
    await fillField(
      page,
      {
        field: 'City',
        labels: [/^\s*city/i],
        fallbackSelectors: ['[data-automation-id="addressSection_city"]'],
        value: profile.city,
      },
      result,
    );

    // Country, state, "How did you hear about us?", and phone device type
    // are Workday custom dropdowns (button-driven, not plain inputs) — the
    // helpers refuse those by design, so they land in `skipped` for the
    // human to pick. Address line / postal code aren't in the Profile.

    result.notes.push(
      'Workday support covers this first page only — continue through the remaining wizard ' +
        'steps (experience, questions, disclosures) yourself. Dropdowns like Country or phone ' +
        'device type must be picked by hand.',
    );
    result.notes.push(
      'EEO / voluntary self-identification questions (if any) were left untouched, as always.',
    );

    return result;
  },
};
