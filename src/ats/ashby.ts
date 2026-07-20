import type { Page } from 'playwright';
import { sweepAutofill } from './autofill';
import { handleSignInWall } from './credentials';
import {
  countBlankTextareas,
  customQuestionNote,
  fillField,
  isCaptchaPresent,
  uploadResume,
  waitForResumeParseToSettle,
} from './helpers';
import type { Profile } from './profile';
import { AtsHandler, FillResult, emptyResult } from './types';

const HOSTNAMES = new Set(['jobs.ashbyhq.com']);

/**
 * Ashby job boards (jobs.ashbyhq.com). A single-page React application form,
 * architecturally similar to Greenhouse/Lever. Field lookup is by accessible
 * label (resilient to markup churn).
 *
 * UNVERIFIED against a live posting — built the same way Greenhouse/Lever
 * originally were (best-guess field labels from Ashby's general conventions,
 * fixture-tested only), then corrected once real usage showed what actually
 * needed fixing. Expect the same: try it, and if a field is skipped or wrong,
 * report the exact label/behavior the same way you did for Greenhouse/Lever
 * so it can be fixed precisely rather than guessed at again.
 *
 * Built in the résumé-first order from the start (upload + let any parse
 * settle, THEN fill text fields, with a CAPTCHA re-check after the upload)
 * since that turned out to be necessary on both Greenhouse and Lever — no
 * confirmed evidence Ashby does the same, but there's no downside to
 * ordering it this way regardless.
 */
export const ashby: AtsHandler = {
  name: 'Ashby',

  detect(url: string): boolean {
    try {
      return HOSTNAMES.has(new URL(url).hostname.toLowerCase());
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

    // Ashby applications are usually open (no account), but if this one is
    // gated behind a sign-in, the shared wall flow resolves it (manual by
    // default; opt-in credentials under an "ashby" key per credentials.ts).
    if (!(await handleSignInWall(page, 'ashby', profile.email, result))) {
      return result;
    }

    await uploadResume(page, profile.resumePath, result);
    await waitForResumeParseToSettle(page);

    if (await isCaptchaPresent(page)) {
      result.notes.push(
        'A CAPTCHA / verification challenge appeared after the résumé upload — the rest of the ' +
          'form was not filled. Solve it yourself, then fill out the rest by hand.',
      );
      return result;
    }

    // Best-guess label patterns (unverified) — try a single "Name" field
    // first (Ashby's minimal-form convention leans this way, like Lever),
    // falling back to split First/Last if that's what a given posting uses.
    await fillField(
      page,
      {
        field: 'Name',
        labels: [/^\s*name\s*[*]?\s*$/i, /full\s*name/i],
        value: `${profile.firstName} ${profile.lastName}`,
      },
      result,
    );
    if (result.skipped.includes('Name')) {
      result.skipped = result.skipped.filter((f) => f !== 'Name');
      await fillField(
        page,
        { field: 'First Name', labels: [/first\s*name/i], value: profile.firstName },
        result,
      );
      await fillField(
        page,
        { field: 'Last Name', labels: [/last\s*name/i], value: profile.lastName },
        result,
      );
    }

    await fillField(
      page,
      { field: 'Email', labels: [/e-?mail/i], value: profile.email },
      result,
    );
    await fillField(page, { field: 'Phone', labels: [/phone/i], value: profile.phone }, result);
    await fillField(
      page,
      {
        field: 'Location',
        labels: [/^\s*location/i, /current\s*location/i],
        value: `${profile.city}, ${profile.state}`,
      },
      result,
    );
    await fillField(
      page,
      { field: 'LinkedIn', labels: [/linkedin/i], value: profile.linkedin },
      result,
    );
    await fillField(page, { field: 'GitHub', labels: [/github/i], value: profile.github }, result);
    await fillField(
      page,
      { field: 'Portfolio/Website', labels: [/portfolio/i, /website/i], value: profile.portfolio },
      result,
    );
    if (profile.twitter) {
      await fillField(
        page,
        {
          field: 'Twitter/X',
          labels: [/twitter/i, /x\s*\(\s*twitter\s*\)/i, /^\s*x\s*$/i],
          value: profile.twitter,
        },
        result,
      );
    }
    await fillField(page, { field: 'School', labels: [/school|university/i], value: profile.school }, result);
    await fillField(page, { field: 'Degree', labels: [/degree/i], value: profile.degree }, result);
    await fillField(
      page,
      {
        field: 'Graduation Date',
        labels: [/graduation/i],
        value: `${profile.graduationMonth} ${profile.graduationYear}`,
      },
      result,
    );

    // Custom questions, "How did you hear about us", and any other
    // company-specific fields are deliberately left alone — they don't map
    // unambiguously to a Profile field, and free text is never generated on
    // the user's behalf.

    // Generic sweep: catch profile-mappable fields this handler's label
    // patterns missed (unusually-worded labels, posting-specific questions).
    await sweepAutofill(page, profile, result);

    const blanks = await countBlankTextareas(page);
    const note = customQuestionNote(blanks);
    if (note) result.notes.push(note);
    result.notes.push(
      'EEO / voluntary self-identification questions (if any) were left untouched, as always.',
    );

    return result;
  },
};
