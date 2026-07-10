const US_STATE_ABBRS = new Set([
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA',
  'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
  'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT',
  'VA', 'WA', 'WV', 'WI', 'WY', 'DC',
]);

const US_STATE_NAMES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut',
  'Delaware', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan',
  'Minnesota', 'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada',
  'New Hampshire', 'New Jersey', 'New Mexico', 'New York', 'North Carolina',
  'North Dakota', 'Ohio', 'Oklahoma', 'Oregon', 'Pennsylvania', 'Rhode Island',
  'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah', 'Vermont',
  'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
];
// \b-wrapped, longest names first so "New Mexico" matches before "Mexico" would (it wouldn't
// anyway since "Mexico" isn't in the list, but this keeps multi-word names intact generally).
const STATE_NAME_RE = new RegExp(
  `\\b(${US_STATE_NAMES.slice().sort((a, b) => b.length - a.length).join('|')})\\b`,
  'i',
);

// Cities commonly listed without a trailing state (mostly tech hubs). Not
// exhaustive — if a location you care about is missing, add it here or
// just write your posting's location as "City, ST" upstream doesn't control
// this, but the heuristic favors comma+state whenever it's present.
const BARE_US_CITIES = new Set([
  'san francisco', 'new york', 'new york city', 'nyc', 'sf', 'la', 'los angeles',
  'chicago', 'boston', 'seattle', 'austin', 'atlanta', 'denver', 'miami', 'dallas',
  'houston', 'philadelphia', 'san jose', 'san diego', 'portland', 'phoenix',
  'nashville', 'charlotte', 'pittsburgh', 'detroit', 'minneapolis', 'cincinnati',
  'cleveland', 'columbus', 'raleigh', 'durham', 'salt lake city', 'sacramento',
  'las vegas', 'orlando', 'tampa', 'baltimore', 'washington dc', 'washington, d.c.',
  'bay area', 'silicon valley',
]);

/**
 * Simple heuristic for "is this a US location" — good enough for a personal
 * filter, not exhaustive (there's no geocoding here). Matches, in order:
 * "USA"/"United States"/a standalone "US", a "City, ST" US state code, a
 * full US state name anywhere in the string, a bare well-known US city
 * (see BARE_US_CITIES), or a bare "Remote" with no country mentioned (in
 * these feeds a bare "Remote" is almost always a US company hiring
 * remotely within the US; remote-elsewhere is tagged "Remote in <Country>").
 */
export function isUSLocation(location: string): boolean {
  const loc = location.trim();
  if (/\b(usa|u\.s\.a\.|united states|us)\b/i.test(loc)) return true;
  if (/^remote$/i.test(loc)) return true;

  const stateMatch = loc.match(/,\s*([A-Za-z]{2})\b/);
  if (stateMatch && US_STATE_ABBRS.has(stateMatch[1].toUpperCase())) return true;

  if (STATE_NAME_RE.test(loc)) return true;

  if (BARE_US_CITIES.has(loc.toLowerCase())) return true;

  return false;
}
