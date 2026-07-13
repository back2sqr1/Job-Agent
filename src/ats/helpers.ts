import type { Locator, Page } from 'playwright';
import { FillResult } from './types';

/**
 * Accessible-name patterns for EEO / voluntary self-identification questions.
 * Anything whose label matches this is NEVER auto-filled, no matter what a
 * field spec's patterns match — the Profile deliberately has no such data,
 * and these questions must always be left for the human. This is a hard
 * safety net on top of the fact that no handler even targets these labels.
 */
export const EEO_PATTERN =
  /gender|race|ethnic|hispanic|latino|veteran|disabilit|disabled|sexual orientation|transgender|self.?identif|demographic|pronoun/i;

/** Input types we are willing to type text into. Everything else is skipped. */
const FILLABLE_INPUT_TYPES = new Set(['text', 'email', 'tel', 'url', 'search', '']);

/**
 * One profile-backed form field a handler wants to fill.
 * `labels` are accessible-name patterns (tried in order via page.getByLabel);
 * `fallbackSelectors` are optional last-resort CSS selectors for markup that
 * doesn't associate its labels properly (e.g. Lever's stable `name=` attrs).
 */
export interface FieldSpec {
  /** Human-readable name for FillResult, e.g. "First Name". */
  field: string;
  labels: RegExp[];
  fallbackSelectors?: string[];
  value: string;
}

/**
 * Best-effort accessible/context text for an element: aria-label, associated
 * <label for>, wrapping <label>, plus id/name attributes. Used both to find
 * the resume input and to enforce the EEO guard.
 */
async function contextText(el: Locator): Promise<string> {
  try {
    return await el.evaluate((node) => {
      const e = node as HTMLElement;
      const parts: string[] = [];
      const aria = e.getAttribute('aria-label');
      if (aria) parts.push(aria);
      if (e.id) {
        const label = document.querySelector(`label[for="${CSS.escape(e.id)}"]`);
        if (label?.textContent) parts.push(label.textContent);
      }
      const wrapping = e.closest('label');
      if (wrapping?.textContent) parts.push(wrapping.textContent);
      parts.push(e.id ?? '', e.getAttribute('name') ?? '');
      return parts.join(' ');
    });
  } catch {
    return '';
  }
}

/**
 * Try to fill one concrete element. Returns true only when text actually went
 * in. Refuses (returns false) rather than throwing when the element is:
 *   - matching the EEO guard (never auto-answer those),
 *   - a typeahead/combobox (typing without selecting an option usually does
 *     not register — leave it to the human),
 *   - not a plain text-like <input> (selects, checkboxes, radios, file
 *     inputs, and — deliberately — textareas: free-text answers are never
 *     generated or filled on the user's behalf).
 */
async function tryFillElement(el: Locator, value: string): Promise<boolean> {
  try {
    if (!(await el.isVisible())) return false;
    if (EEO_PATTERN.test(await contextText(el))) return false;

    const shape = await el.evaluate((node) => {
      const e = node as HTMLInputElement;
      return {
        tag: e.tagName,
        type: (e.getAttribute('type') ?? '').toLowerCase(),
        role: e.getAttribute('role') ?? '',
        autocomplete: e.getAttribute('aria-autocomplete') ?? '',
        disabled: e.disabled === true,
        readOnly: e.readOnly === true,
      };
    });
    if (shape.tag !== 'INPUT') return false;
    if (!FILLABLE_INPUT_TYPES.has(shape.type)) return false;
    if (shape.disabled || shape.readOnly) return false;
    if (shape.role === 'combobox' || shape.autocomplete === 'list') return false;

    await el.fill(value, { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

/** Try every element a locator matches until one accepts the value. */
async function tryFillLocator(loc: Locator, value: string): Promise<boolean> {
  let count = 0;
  try {
    count = await loc.count();
  } catch {
    return false;
  }
  for (let i = 0; i < count; i++) {
    if (await tryFillElement(loc.nth(i), value)) return true;
  }
  return false;
}

/**
 * Fill one field per its spec, recording the outcome in `result`. A field
 * that can't be found or safely filled lands in `skipped` — never an
 * exception. The whole flow degrades to "partially filled, human finishes".
 */
export async function fillField(page: Page, spec: FieldSpec, result: FillResult): Promise<boolean> {
  for (const pattern of spec.labels) {
    if (await tryFillLocator(page.getByLabel(pattern), spec.value)) {
      result.filled.push(spec.field);
      return true;
    }
  }
  for (const selector of spec.fallbackSelectors ?? []) {
    if (await tryFillLocator(page.locator(selector), spec.value)) {
      result.filled.push(spec.field);
      return true;
    }
  }
  result.skipped.push(spec.field);
  return false;
}

/**
 * Upload the resume into the page's resume/CV file input.
 * Preference order: a file input whose label/context mentions resume or CV;
 * otherwise, if the page has exactly one file input, use it. If there are
 * several and none is identifiably the resume (e.g. resume + cover letter,
 * neither labelled), skip rather than guess wrong. File inputs are often
 * hidden behind styled buttons, so no visibility requirement here.
 *
 * Some ATS's (confirmed live on Greenhouse) bind upload state to an actual
 * click on the file input and throw when a file just appears on it without
 * that click ever happening ("Cannot read properties of undefined (reading
 * 'uploadFile')") — their JS was expecting to initialize an uploader object
 * on click, before the change event fires. So this clicks the (possibly
 * hidden) input for real and intercepts the resulting native file-chooser
 * dialog via Playwright's `filechooser` event, rather than writing to the
 * input directly — that's a real click, so whatever the site's onClick does
 * still happens. Falls back to setting the input directly for pages with no
 * such click handler (a plain file input never fires `filechooser` from a
 * forced click in that case, so the click leg just times out harmlessly).
 */
export async function uploadResume(
  page: Page,
  resumePath: string,
  result: FillResult,
): Promise<boolean> {
  const fileInputs = page.locator('input[type="file"]');
  let count = 0;
  try {
    count = await fileInputs.count();
  } catch {
    count = 0;
  }

  let target: Locator | null = null;
  for (let i = 0; i < count; i++) {
    const el = fileInputs.nth(i);
    const text = await contextText(el);
    if (EEO_PATTERN.test(text)) continue;
    if (/resume|\bc\.?v\b/i.test(text)) {
      target = el;
      break;
    }
  }
  if (!target && count === 1) target = fileInputs.first();

  if (!target) {
    result.skipped.push('Resume');
    return false;
  }

  try {
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5_000 }),
      target.click({ force: true, timeout: 3_000 }),
    ]);
    await chooser.setFiles(resumePath);
    result.filled.push('Resume');
    result.resumeUploaded = true;
    return true;
  } catch {
    // No filechooser fired (or the click itself failed) — fall back to
    // writing the input directly.
  }

  try {
    await target.setInputFiles(resumePath, { timeout: 10_000 });
    result.filled.push('Resume');
    result.resumeUploaded = true;
    return true;
  } catch {
    result.skipped.push('Resume');
    return false;
  }
}

/**
 * Fill a react-select-style searchable combobox (confirmed live on
 * Greenhouse: a country-code picker next to the phone number field —
 * `role="combobox"`, `aria-autocomplete="list"`, a plain-looking text input
 * that filters a popup list of options as you type). These are deliberately
 * excluded from the generic tryFillElement path (typing without picking an
 * option from the list usually doesn't register with the page), so this
 * does the real thing: type into the input to trigger the site's own
 * filtering, wait for a matching option to actually appear, and click it —
 * never just write the text and hope. Skips cleanly if no matching option
 * shows up, rather than leaving the combobox in a half-typed state.
 */
export async function fillCombobox(
  page: Page,
  labels: RegExp[],
  value: string,
  fieldName: string,
  result: FillResult,
): Promise<boolean> {
  for (const pattern of labels) {
    const input = page.getByLabel(pattern).first();
    try {
      if ((await input.count()) === 0) continue;
      await input.click({ timeout: 3_000 });
      await input.fill(value, { timeout: 3_000 });
      const option = page.getByRole('option', { name: value, exact: false }).first();
      await option.waitFor({ state: 'visible', timeout: 3_000 });
      await option.click({ timeout: 3_000 });
      result.filled.push(fieldName);
      return true;
    } catch {
      // This label matched an element, but it didn't behave like a
      // fillable combobox (or no option ever appeared) — try the next
      // label pattern before giving up.
    }
  }
  result.skipped.push(fieldName);
  return false;
}

const STATE_ABBREVIATIONS: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO',
  montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY',
};

/**
 * Converts a full US state name (e.g. "Texas") to its 2-letter abbreviation
 * ("TX"). Passes anything not recognized straight through unchanged (already
 * an abbreviation, or a non-US region) — used to match location-autocomplete
 * suggestions, which tend to show abbreviations, against a profile that
 * might have the full name.
 */
export function toStateAbbreviation(state: string): string {
  return STATE_ABBREVIATIONS[state.trim().toLowerCase()] ?? state;
}

/**
 * Fill a custom (non-ARIA) autocomplete/typeahead: type into `input`, wait
 * for `resultsSelector` to produce at least one match, click the one whose
 * text contains `preferredText` (case-insensitive) if any does, otherwise
 * click the first result rather than leaving it unset.
 *
 * Confirmed live on Lever: "Current Location" is a plain <div> results list
 * (`.dropdown-location` rows, no ARIA role) that only registers a selection
 * when a row is clicked — typed text alone doesn't populate Lever's hidden
 * `selectedLocation` field. This is the same "type, wait for a real option,
 * click it" principle as fillCombobox above, just for a widget with no ARIA
 * semantics to hook into, so the results have to be found by a caller-given
 * CSS selector instead of role="option".
 */
export async function fillAutocomplete(
  page: Page,
  input: Locator,
  typedValue: string,
  resultsSelector: string,
  preferredText: string | null,
  fieldName: string,
  result: FillResult,
): Promise<boolean> {
  try {
    await input.click({ timeout: 3_000 });
    await input.fill(typedValue, { timeout: 3_000 });
    const results = page.locator(resultsSelector);
    await results.first().waitFor({ state: 'visible', timeout: 5_000 });

    let target = results.first();
    if (preferredText) {
      const count = await results.count();
      for (let i = 0; i < count; i++) {
        const text = (await results.nth(i).textContent()) ?? '';
        if (text.toLowerCase().includes(preferredText.toLowerCase())) {
          target = results.nth(i);
          break;
        }
      }
    }
    await target.click({ timeout: 3_000 });
    result.filled.push(fieldName);
    return true;
  } catch {
    result.skipped.push(fieldName);
    return false;
  }
}

/**
 * Count visible, still-empty <textarea>s — a decent proxy for free-text
 * custom questions ("Why do you want to work here?"), which are always left
 * for the human to answer. Used to add a heads-up note to the FillResult.
 */
export async function countBlankTextareas(page: Page): Promise<number> {
  try {
    const areas = page.locator('textarea');
    const count = await areas.count();
    let blank = 0;
    for (let i = 0; i < count; i++) {
      const el = areas.nth(i);
      if (!(await el.isVisible().catch(() => false))) continue;
      const value = await el.inputValue().catch(() => '');
      if (value.trim() === '') blank += 1;
    }
    return blank;
  } catch {
    return 0;
  }
}

/** Shared note appended by handlers when custom questions remain. */
export function customQuestionNote(blankTextareas: number): string | null {
  if (blankTextareas === 0) return null;
  const s = blankTextareas === 1 ? '' : 's';
  return `${blankTextareas} free-text question${s} left blank for you to answer — nothing is ever written on your behalf.`;
}
