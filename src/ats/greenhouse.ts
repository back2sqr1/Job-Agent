import type { Page } from 'playwright';
import { countBlankTextareas, customQuestionNote, fillCombobox, fillField, uploadResume } from './helpers';
import type { Profile } from './profile';
import { AtsHandler, FillResult, emptyResult } from './types';

const HOSTNAMES = new Set(['job-boards.greenhouse.io', 'boards.greenhouse.io']);

/**
 * Greenhouse job boards (job-boards.greenhouse.io — the current React-based
 * board — and the legacy boards.greenhouse.io). Field lookup is by accessible
 * label first (resilient to markup churn), with the legacy board's stable
 * element ids as a last-resort fallback.
 *
 * Not verified against live production postings from inside the development
 * sandbox (network policy blocks these hosts there) — do one supervised trial
 * run before trusting it. See README "Ethical use & limitations".
 */
export const greenhouse: AtsHandler = {
  name: 'Greenhouse',

  detect(url: string): boolean {
    try {
      return HOSTNAMES.has(new URL(url).hostname.toLowerCase());
    } catch {
      return false;
    }
  },

  async fill(page: Page, profile: Profile): Promise<FillResult> {
    const result = emptyResult();

    await fillField(
      page,
      {
        field: 'First Name',
        labels: [/first\s*name/i],
        fallbackSelectors: ['#first_name'],
        value: profile.firstName,
      },
      result,
    );
    await fillField(
      page,
      {
        field: 'Last Name',
        labels: [/last\s*name/i],
        fallbackSelectors: ['#last_name'],
        value: profile.lastName,
      },
      result,
    );
    await fillField(
      page,
      { field: 'Email', labels: [/e-?mail/i], fallbackSelectors: ['#email'], value: profile.email },
      result,
    );
    await fillField(
      page,
      { field: 'Phone', labels: [/phone/i], fallbackSelectors: ['#phone'], value: profile.phone },
      result,
    );
    // The phone number's country code is often a separate react-select
    // combobox next to the number itself (confirmed live on Greenhouse),
    // not a plain <select> — needs the type-and-pick-option flow, not a
    // plain fill.
    await fillCombobox(page, [/^\s*country/i], profile.country, 'Country', result);

    await uploadResume(page, profile.resumePath, result);

    await fillField(
      page,
      { field: 'LinkedIn', labels: [/linkedin/i], value: profile.linkedin },
      result,
    );
    await fillField(page, { field: 'GitHub', labels: [/github/i], value: profile.github }, result);
    await fillField(
      page,
      { field: 'Website/Portfolio', labels: [/portfolio/i, /website/i], value: profile.portfolio },
      result,
    );
    if (profile.twitter) {
      await fillField(
        page,
        { field: 'Twitter/X', labels: [/twitter/i, /x\s*\(\s*twitter\s*\)/i, /^\s*x\s*$/i], value: profile.twitter },
        result,
      );
    }
    await fillField(
      page,
      {
        field: 'Location/City',
        labels: [/location\s*\(city\)/i, /^\s*location/i, /^\s*city/i],
        value: `${profile.city}, ${profile.state}`,
      },
      result,
    );

    // School/Degree are usually typeahead comboboxes on Greenhouse; the
    // helper refuses to type into those (typing without picking an option
    // doesn't register), so these land in `skipped` on most live boards and
    // only fill when they are plain text inputs.
    await fillField(page, { field: 'School', labels: [/school/i], value: profile.school }, result);
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

    const blanks = await countBlankTextareas(page);
    const note = customQuestionNote(blanks);
    if (note) result.notes.push(note);
    result.notes.push(
      'EEO / voluntary self-identification questions (if any) were left untouched, as always.',
    );

    return result;
  },
};
