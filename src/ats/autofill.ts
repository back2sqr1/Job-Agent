import type { Locator, Page } from 'playwright';
import { EEO_PATTERN, contextText, tryFillElement } from './helpers';
import type { Profile } from './profile';
import { FillResult } from './types';

/**
 * Generic autofill sweep — the answer to "the handlers keep missing fields".
 *
 * The per-ATS handlers LOOK FOR specific labels ("First Name", "LinkedIn"),
 * so any form that words a field differently gets skipped. This module flips
 * the direction: enumerate every fillable input actually on the page, read
 * each one's label/placeholder/name/aria context, and classify it against
 * the profile. Handlers run their precise pass first (resume ordering,
 * comboboxes, autocompletes), then call sweepAutofill() to catch whatever
 * their patterns missed; the fallback handler uses the sweep as its entire
 * fill strategy, which makes unknown ATSes (iCIMS, SmartRecruiters, custom
 * career sites) partially supported instead of fully manual.
 *
 * Unmatched fields are never guessed at — they're named in the notes so the
 * human knows exactly what's left. Optionally, setting ANTHROPIC_API_KEY
 * enables an LLM assist that classifies leftover labels (see llmMapFields —
 * only the page's field labels are sent, never profile values).
 *
 * Safety invariants (all enforced at the shared fill layer, not here):
 * EEO / self-identification fields are hard-refused, selects/comboboxes/
 * textareas are never filled, passwords only via the credentials opt-in,
 * and nothing is ever submitted.
 */

interface Matcher {
  field: string;
  value: (p: Profile) => string;
  pattern: RegExp;
  /** Rejects lookalikes, e.g. "Company name" must not match the name field. */
  negative?: RegExp;
}

/**
 * Ordered, most-specific first — the first matcher whose pattern hits (and
 * whose negative doesn't) claims the input. firstName/lastName must precede
 * fullName; city/state must precede the combined location matcher.
 */
function matchers(p: Profile): Matcher[] {
  const NOT_A_PERSON = /company|employer|organi[sz]|school|universit|college|reference|emergency|middle\s*name|user\s*name|nick/i;
  return [
    { field: 'First Name', value: () => p.firstName, pattern: /first\s*name|given\s*name|\bfname\b|forename/i },
    { field: 'Last Name', value: () => p.lastName, pattern: /last\s*name|family\s*name|surname|\blname\b/i },
    {
      field: 'Full Name',
      value: () => `${p.firstName} ${p.lastName}`,
      pattern: /full\s*(legal\s*)?name|legal\s*name|your\s*name|^\s*name\s*[*✱]?\s*$/i,
      negative: NOT_A_PERSON,
    },
    { field: 'Email', value: () => p.email, pattern: /e-?mail/i },
    {
      field: 'Phone',
      value: () => p.phone,
      pattern: /phone|mobile|\bcell\b|telephone|\btel\b/i,
      negative: /country|device|type|extension/i,
    },
    { field: 'LinkedIn', value: () => p.linkedin, pattern: /linked\s*-?in/i },
    { field: 'GitHub', value: () => p.github, pattern: /git\s*-?hub/i },
    { field: 'Twitter/X', value: () => p.twitter ?? '', pattern: /twitter|x\.com|\bx\s*\(/i },
    {
      field: 'Portfolio/Website',
      value: () => p.portfolio,
      pattern: /portfolio|personal\s*(web\s*)?site|\bwebsite\b|\bblog\b/i,
    },
    { field: 'City', value: () => p.city, pattern: /\bcity\b|\btown\b/i },
    {
      field: 'State',
      value: () => p.state,
      pattern: /\bstate\b|province|\bregion\b/i,
    },
    {
      field: 'Location',
      value: () => `${p.city}, ${p.state}`,
      pattern: /location|where\s+(are\s+you|do\s+you)\s+\w+|based/i,
    },
    { field: 'Country', value: () => p.country, pattern: /country/i },
    {
      field: 'School',
      value: () => p.school,
      pattern: /school|universit|college|alma\s*mater|institution/i,
    },
    { field: 'Degree', value: () => p.degree, pattern: /degree|qualification/i },
    {
      field: 'Graduation Date',
      value: () => `${p.graduationMonth} ${p.graduationYear}`,
      pattern: /graduat/i,
    },
  ];
}

interface Candidate {
  el: Locator;
  /** label + placeholder + name/id/aria context, for classification. */
  context: string;
}

/** Every visible, empty, text-like input the sweep is allowed to consider. */
async function collectCandidates(page: Page): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const inputs = page.locator('input');
  const count = await inputs.count().catch(() => 0);
  for (let i = 0; i < count; i++) {
    const el = inputs.nth(i);
    try {
      if (!(await el.isVisible())) continue;
      const shape = await el.evaluate((node) => {
        const e = node as HTMLInputElement;
        return {
          type: (e.getAttribute('type') ?? 'text').toLowerCase(),
          value: e.value,
          placeholder: e.getAttribute('placeholder') ?? '',
          disabled: e.disabled,
          readOnly: e.readOnly,
        };
      });
      if (!['text', 'email', 'tel', 'url', 'search', ''].includes(shape.type)) continue;
      if (shape.disabled || shape.readOnly) continue;
      if (shape.value.trim() !== '') continue; // never overwrite existing content
      const context = `${await contextText(el)} ${shape.placeholder}`.trim();
      if (context === '') continue; // nothing to classify against
      out.push({ el, context });
    } catch {
      // element went stale mid-scan — skip it
    }
  }
  return out;
}

/** Trim a context string down to a short human-readable field label. */
function shortLabel(context: string): string {
  const cleaned = context.replace(/\s+/g, ' ').replace(/[*✱]/g, '').trim();
  return cleaned.length > 60 ? `${cleaned.slice(0, 57)}...` : cleaned;
}

/**
 * Optional LLM assist for labels the heuristics can't classify. Opt-in via
 * ANTHROPIC_API_KEY (the standard Anthropic SDK env var) — without it this
 * is never called. ONLY the page's field labels and the profile FIELD NAMES
 * are sent; profile values never leave the machine through this path.
 * Returns index -> field-name (must be one of the given names) or 'none'.
 */
async function llmMapFields(
  labels: string[],
  fieldNames: string[],
): Promise<Map<number, string>> {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic();

  const schema = {
    type: 'object',
    properties: {
      mappings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer' },
            field: { type: 'string', enum: [...fieldNames, 'none'] },
          },
          required: ['index', 'field'],
          additionalProperties: false,
        },
      },
    },
    required: ['mappings'],
    additionalProperties: false,
  } as const;

  const response = await client.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 2048,
    output_config: { format: { type: 'json_schema', schema } },
    messages: [
      {
        role: 'user',
        content:
          'These are field labels from a job application form. Map each to the matching ' +
          'applicant-profile field, or "none" if it does not correspond to one (e.g. custom ' +
          'questions, salary, references, demographic/EEO questions are always "none").\n\n' +
          `Profile fields: ${fieldNames.join(', ')}\n\n` +
          labels.map((l, i) => `${i}: ${l}`).join('\n'),
      },
    ],
  });

  const map = new Map<number, string>();
  const block = response.content[0];
  if (block && block.type === 'text') {
    const parsed = JSON.parse(block.text) as { mappings: { index: number; field: string }[] };
    for (const m of parsed.mappings) {
      if (m.field !== 'none' && fieldNames.includes(m.field)) map.set(m.index, m.field);
    }
  }
  return map;
}

/**
 * Run the generic sweep over whatever the handler's precise pass left
 * unfilled. Fills only inputs that map unambiguously to a profile field;
 * names everything else in the notes so nothing is silently dropped.
 */
export async function sweepAutofill(
  page: Page,
  profile: Profile,
  result: FillResult,
): Promise<void> {
  const specs = matchers(profile);
  const candidates = await collectCandidates(page);
  const unmatched: Candidate[] = [];

  for (const candidate of candidates) {
    if (EEO_PATTERN.test(candidate.context)) continue; // never touched, never listed
    const spec = specs.find(
      (s) =>
        s.pattern.test(candidate.context) &&
        !(s.negative && s.negative.test(candidate.context)) &&
        s.value(profile).trim() !== '',
    );
    if (!spec) {
      unmatched.push(candidate);
      continue;
    }
    if (await tryFillElement(candidate.el, spec.value(profile))) {
      if (!result.filled.includes(spec.field)) result.filled.push(spec.field);
      // A field the precise pass reported as skipped but the sweep then
      // filled is no longer skipped.
      result.skipped = result.skipped.filter((f) => f !== spec.field);
    } else {
      unmatched.push(candidate);
    }
  }

  // LLM assist for the leftovers — opt-in via ANTHROPIC_API_KEY.
  let stillUnmatched = unmatched;
  if (unmatched.length > 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      const mapping = await llmMapFields(
        unmatched.map((c) => shortLabel(c.context)),
        specs.map((s) => s.field),
      );
      const remaining: Candidate[] = [];
      for (let i = 0; i < unmatched.length; i++) {
        const fieldName = mapping.get(i);
        const spec = fieldName ? specs.find((s) => s.field === fieldName) : undefined;
        // tryFillElement re-applies the EEO guard and input policy, so even
        // a bad LLM mapping cannot fill anything the rules forbid.
        if (spec && spec.value(profile).trim() !== '' && (await tryFillElement(unmatched[i].el, spec.value(profile)))) {
          if (!result.filled.includes(spec.field)) result.filled.push(spec.field);
          result.skipped = result.skipped.filter((f) => f !== spec.field);
        } else {
          remaining.push(unmatched[i]);
        }
      }
      stillUnmatched = remaining;
    } catch (err) {
      result.notes.push(
        `LLM field-mapping assist failed (${(err as Error).message}) — falling back to listing unmatched fields.`,
      );
    }
  }

  if (stillUnmatched.length > 0) {
    const names = stillUnmatched.slice(0, 8).map((c) => `"${shortLabel(c.context)}"`);
    const more = stillUnmatched.length > 8 ? ` (+${stillUnmatched.length - 8} more)` : '';
    result.notes.push(
      `${stillUnmatched.length} field(s) need your attention — no profile data maps to them: ` +
        `${names.join(', ')}${more}.` +
        (process.env.ANTHROPIC_API_KEY
          ? ''
          : ' (Optional: set ANTHROPIC_API_KEY to let Claude classify unusual labels automatically.)'),
    );
  }
}
