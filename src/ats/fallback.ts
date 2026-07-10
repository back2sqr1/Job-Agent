import type { Page } from 'playwright';
import type { Profile } from './profile';
import { AtsHandler, FillResult, emptyResult } from './types';

/**
 * Catch-all for ATS platforms without a dedicated handler (Workday, iCIMS,
 * SmartRecruiters, custom career sites, ...). The page is already open in the
 * headed browser — this handler fills nothing and just says so, rather than
 * guessing at unknown form structures.
 */
export const fallback: AtsHandler = {
  name: 'Manual (unsupported ATS)',

  detect(): boolean {
    // Accepts anything; detect.ts keeps it last in the handler list.
    return true;
  },

  async fill(_page: Page, _profile: Profile): Promise<FillResult> {
    const result = emptyResult();
    result.notes.push(
      'This ATS is not supported yet (only Greenhouse and Lever are) — nothing was filled. ' +
        'The page is open in the browser; fill the application in manually.',
    );
    return result;
  },
};
