import { existsSync, readFileSync } from 'node:fs';
import yaml from 'js-yaml';

/**
 * User filter criteria, loaded from config/filters.yaml.
 * Every list is optional; an empty/omitted list means "no constraint".
 */
export interface FilterConfig {
  /**
   * Terms to accept, e.g. ["Summer 2026", "Summer 2027"].
   * Listings with an empty terms array (some sources don't tag terms)
   * always pass this check.
   */
  terms: string[];
  /** Case-insensitive substrings matched against title + category. */
  includeKeywords: string[];
  /** Case-insensitive substrings in the title that reject a listing. */
  excludeKeywords: string[];
  /** Location allow-list (substring match). Empty = anywhere. */
  locationsAllow: string[];
  /** Location deny-list (substring match). Checked after the allow-list. */
  locationsDeny: string[];
  /**
   * If true, reject listings whose sponsorship field indicates
   * "does not sponsor" or a citizenship requirement.
   */
  requireSponsorship: boolean;
  /** Companies to never surface (case-insensitive exact match). */
  companyBlocklist: string[];
  /**
   * Position types to accept, e.g. ["New Grad"] or ["Internship"]. Empty
   * (the default) means both. See src/scrapers/classify.ts for how a
   * listing's type is decided.
   */
  positionTypes: string[];
  /**
   * If true, only keep listings with at least one recognizably-US location
   * (see src/matching/usLocations.ts for the heuristic). Listings with no
   * location info always pass, same as the allow/deny lists above.
   */
  usOnly: boolean;
}

export const DEFAULT_CONFIG: FilterConfig = {
  terms: [],
  includeKeywords: [],
  excludeKeywords: [],
  locationsAllow: [],
  locationsDeny: [],
  requireSponsorship: false,
  companyBlocklist: [],
  positionTypes: [],
  usOnly: false,
};

export class FilterConfigError extends Error {}

/**
 * Load and validate config/filters.yaml. Returns null when the file does not
 * exist (caller decides whether to fall back to defaults or instruct the user
 * to copy filters.example.yaml). Throws FilterConfigError on malformed YAML
 * or wrong field types, so typos fail loudly instead of silently matching
 * everything.
 */
export function loadFilterConfig(filePath: string): FilterConfig | null {
  if (!existsSync(filePath)) return null;

  let doc: unknown;
  try {
    doc = yaml.load(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new FilterConfigError(`Could not parse ${filePath}: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) return { ...DEFAULT_CONFIG };
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    throw new FilterConfigError(`${filePath}: expected a YAML mapping at the top level`);
  }

  const obj = doc as Record<string, unknown>;
  const known = [
    'terms',
    'include_keywords',
    'exclude_keywords',
    'locations_allow',
    'locations_deny',
    'require_sponsorship',
    'company_blocklist',
    'position_types',
    'us_only',
  ];
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      throw new FilterConfigError(
        `${filePath}: unknown key "${key}" (known keys: ${known.join(', ')})`,
      );
    }
  }

  return {
    terms: stringList(obj, 'terms', filePath),
    includeKeywords: stringList(obj, 'include_keywords', filePath),
    excludeKeywords: stringList(obj, 'exclude_keywords', filePath),
    locationsAllow: stringList(obj, 'locations_allow', filePath),
    locationsDeny: stringList(obj, 'locations_deny', filePath),
    requireSponsorship: bool(obj, 'require_sponsorship', filePath),
    companyBlocklist: stringList(obj, 'company_blocklist', filePath),
    positionTypes: stringList(obj, 'position_types', filePath),
    usOnly: bool(obj, 'us_only', filePath),
  };
}

function stringList(obj: Record<string, unknown>, key: string, file: string): string[] {
  const v = obj[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new FilterConfigError(`${file}: "${key}" must be a list of strings`);
  }
  return v as string[];
}

function bool(obj: Record<string, unknown>, key: string, file: string): boolean {
  const v = obj[key];
  if (v === undefined || v === null) return false;
  if (typeof v !== 'boolean') {
    throw new FilterConfigError(`${file}: "${key}" must be true or false`);
  }
  return v;
}
