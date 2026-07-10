import type { Page } from 'playwright';
import type { Profile } from './profile';

/**
 * What a handler's fill() pass accomplished. Nothing in here is fatal:
 * a field the handler looked for but couldn't find lands in `skipped`,
 * and the human finishes the form by hand.
 */
export interface FillResult {
  /** Human-readable field names successfully filled, e.g. "First Name", "Resume". */
  filled: string[];
  /** Fields the handler looked for but couldn't find/fill — NOT fatal, just reported. */
  skipped: string[];
  resumeUploaded: boolean;
  /** Anything worth telling the user, e.g. "custom questions left blank for you to answer". */
  notes: string[];
}

/**
 * One per supported ATS platform (plus the fallback). Handlers only ever
 * fill fields that map directly and unambiguously to a Profile field; they
 * never answer free-text/custom questions, never touch EEO / voluntary
 * self-identification questions, and never click submit.
 */
export interface AtsHandler {
  readonly name: string;
  /** True if this handler recognizes the URL (by hostname). */
  detect(url: string): boolean;
  /** Fill what it can on an already-navigated page; degrade, never throw, on missing fields. */
  fill(page: Page, profile: Profile): Promise<FillResult>;
}

export function emptyResult(): FillResult {
  return { filled: [], skipped: [], resumeUploaded: false, notes: [] };
}
