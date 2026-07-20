import type { Page } from 'playwright';
import { sweepAutofill } from './autofill';
import { hasVisiblePasswordField } from './credentials';
import { isCaptchaPresent, uploadResume, waitForResumeParseToSettle } from './helpers';
import type { Profile } from './profile';
import { AtsHandler, FillResult, emptyResult } from './types';

/**
 * Catch-all for ATS platforms without a dedicated handler (iCIMS,
 * SmartRecruiters, custom career sites, ...). Formerly this filled nothing;
 * now it runs the generic autofill sweep (see autofill.ts): enumerate every
 * fillable input on the page, classify by label/placeholder/context, and
 * fill what maps unambiguously to the profile — same safety rails as the
 * dedicated handlers (EEO hard-refused, no free text, no selects, no
 * submit, CAPTCHA stops everything).
 *
 * Sign-in walls stop the run without filling credentials: on an unknown
 * site there is no per-ATS credentials key, and quietly sending the same
 * password to arbitrary career sites is not a behavior worth automating.
 */
export const fallback: AtsHandler = {
  name: 'Generic (best-effort autofill)',

  detect(): boolean {
    // Accepts anything; detect.ts keeps it last in the handler list.
    return true;
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

    if (await hasVisiblePasswordField(page)) {
      result.notes.push(
        'This site is asking you to sign in / create an account first — do that yourself, ' +
          'navigate to the application form, then re-run this command. (Credential autofill is ' +
          'only enabled for recognized ATSes.)',
      );
      return result;
    }

    await uploadResume(page, profile.resumePath, result);
    if (result.resumeUploaded) {
      await waitForResumeParseToSettle(page);
      if (await isCaptchaPresent(page)) {
        result.notes.push(
          'A CAPTCHA / verification challenge appeared after the résumé upload — the rest of ' +
            'the form was not filled. Solve it yourself, then fill out the rest by hand.',
        );
        return result;
      }
    }

    await sweepAutofill(page, profile, result);

    result.notes.push(
      'This ATS has no dedicated handler — the generic autofill did its best from field ' +
        'labels. Review every field carefully before submitting.',
    );
    result.notes.push(
      'EEO / voluntary self-identification questions (if any) were left untouched, as always.',
    );

    return result;
  },
};
