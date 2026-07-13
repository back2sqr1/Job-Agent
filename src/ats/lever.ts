import type { Page } from 'playwright';
import {
  countBlankTextareas,
  customQuestionNote,
  fillAutocomplete,
  fillField,
  isCaptchaPresent,
  toStateAbbreviation,
  uploadResume,
  waitForResumeParseToSettle,
} from './helpers';
import type { Profile } from './profile';
import { AtsHandler, FillResult, emptyResult } from './types';

/**
 * Lever job boards (jobs.lever.co). Lever uses a single "Full name" field and
 * historically renders its labels as plain divs rather than associated
 * <label> elements, so each field also carries Lever's long-stable `name=`
 * attributes as fallback selectors after the accessible-label attempt.
 *
 * Not verified against live production postings from inside the development
 * sandbox (network policy blocks these hosts there) — do one supervised trial
 * run before trusting it. See README "Ethical use & limitations".
 */
export const lever: AtsHandler = {
  name: 'Lever',

  detect(url: string): boolean {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === 'jobs.lever.co' || host === 'jobs.eu.lever.co';
    } catch {
      return false;
    }
  },

  async fill(page: Page, profile: Profile): Promise<FillResult> {
    const result = emptyResult();

    // Never click or type past a CAPTCHA/verification challenge — stop
    // entirely and leave the whole page untouched for the human.
    if (await isCaptchaPresent(page)) {
      result.notes.push(
        'A CAPTCHA / verification challenge is showing on this page — nothing was filled. ' +
          'Solve it yourself, then fill out the form by hand.',
      );
      return result;
    }

    // Upload the résumé FIRST and let any parse-and-autofill settle before
    // touching anything else. Confirmed live (both Greenhouse and Lever):
    // the ATS parses the PDF and auto-populates matching fields (name,
    // email, phone, location, ...) a moment after upload — if those fields
    // were filled beforehand, the parser's async population silently
    // overwrites them. Uploading first and waiting it out means the
    // profile's real values always go in last.
    await uploadResume(page, profile.resumePath, result);
    await waitForResumeParseToSettle(page);

    // The parse can take a few seconds, which is also enough time for a
    // CAPTCHA to appear that wasn't there at the start — check again rather
    // than filling past it.
    if (await isCaptchaPresent(page)) {
      result.notes.push(
        'A CAPTCHA / verification challenge appeared after the résumé upload — the rest of the ' +
          'form was not filled. Solve it yourself, then fill out the rest by hand.',
      );
      return result;
    }

    await fillField(
      page,
      {
        field: 'Full Name',
        labels: [/full\s*name/i, /^\s*name\s*[*✱]?\s*$/i],
        fallbackSelectors: ['input[name="name"]'],
        value: `${profile.firstName} ${profile.lastName}`,
      },
      result,
    );
    await fillField(
      page,
      {
        field: 'Email',
        labels: [/e-?mail/i],
        fallbackSelectors: ['input[name="email"]'],
        value: profile.email,
      },
      result,
    );
    await fillField(
      page,
      {
        field: 'Phone',
        labels: [/phone/i],
        fallbackSelectors: ['input[name="phone"]'],
        value: profile.phone,
      },
      result,
    );
    // Confirmed live: Lever's "Current Location" is a custom autocomplete —
    // typing shows a <div class="dropdown-location"> suggestion list that
    // must be clicked; plain typed text alone isn't recognized as selected.
    await fillAutocomplete(
      page,
      page.locator('input[name="location"], #location-input').first(),
      profile.city,
      '.dropdown-location',
      toStateAbbreviation(profile.state),
      'Current Location',
      result,
    );

    await fillField(
      page,
      {
        field: 'LinkedIn',
        labels: [/linkedin/i],
        fallbackSelectors: ['input[name="urls[LinkedIn]"]'],
        value: profile.linkedin,
      },
      result,
    );
    await fillField(
      page,
      {
        field: 'GitHub',
        labels: [/github/i],
        fallbackSelectors: ['input[name="urls[GitHub]"]'],
        value: profile.github,
      },
      result,
    );
    await fillField(
      page,
      {
        field: 'Portfolio',
        labels: [/portfolio/i],
        fallbackSelectors: ['input[name="urls[Portfolio]"]'],
        value: profile.portfolio,
      },
      result,
    );
    if (profile.twitter) {
      await fillField(
        page,
        {
          field: 'Twitter/X',
          labels: [/twitter/i, /x\s*\(\s*twitter\s*\)/i, /^\s*x\s*$/i],
          fallbackSelectors: ['input[name="urls[Twitter]"]'],
          value: profile.twitter,
        },
        result,
      );
    }

    // "Current company", "Additional information", and any custom questions
    // are deliberately not filled: they don't map unambiguously to a Profile
    // field, and free text is never written on the user's behalf.

    const blanks = await countBlankTextareas(page);
    const note = customQuestionNote(blanks);
    if (note) result.notes.push(note);
    result.notes.push(
      'EEO / voluntary self-identification questions (if any) were left untouched, as always.',
    );

    return result;
  },
};
