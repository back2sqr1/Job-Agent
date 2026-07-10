import { Listing } from '../scrapers/types';
import { FilterConfig } from './filterConfig';
import { isUSLocation } from './usLocations';

/**
 * Sponsorship values (from the Simplify data + the sndsh404 emoji
 * conventions) that mean visa sponsorship is NOT available.
 */
const NO_SPONSORSHIP_PATTERNS = [
  'does not sponsor',
  'does not offer sponsorship',
  'citizenship',
  'security clearance',
];

/** Decide whether a single listing passes the user's filter config. */
export function matches(listing: Listing, config: FilterConfig): boolean {
  // Company blocklist (exact, case-insensitive).
  const company = listing.company.toLowerCase();
  if (config.companyBlocklist.some((c) => c.toLowerCase() === company)) return false;

  // Position type (New Grad / Internship).
  if (config.positionTypes.length > 0) {
    const wanted = config.positionTypes.map((t) => t.toLowerCase());
    if (!wanted.includes(listing.positionType.toLowerCase())) return false;
  }

  // Terms: listings without term tags always pass (some sources don't tag).
  if (config.terms.length > 0 && listing.terms.length > 0) {
    const wanted = config.terms.map((t) => t.toLowerCase());
    if (!listing.terms.some((t) => wanted.includes(t.toLowerCase()))) return false;
  }

  const haystack = `${listing.title} ${listing.category ?? ''}`.toLowerCase();

  // Exclude keywords beat everything else.
  if (config.excludeKeywords.some((k) => haystack.includes(k.toLowerCase()))) return false;

  // Include keywords: at least one must hit (if any are configured).
  if (
    config.includeKeywords.length > 0 &&
    !config.includeKeywords.some((k) => haystack.includes(k.toLowerCase()))
  ) {
    return false;
  }

  // Locations: deny first, then allow. Listings with no location info pass
  // the allow check (better a false positive than silently hiding rows).
  const locations = listing.locations.map((l) => l.toLowerCase());
  if (
    config.locationsDeny.length > 0 &&
    locations.length > 0 &&
    locations.every((loc) => config.locationsDeny.some((d) => loc.includes(d.toLowerCase())))
  ) {
    return false;
  }
  if (config.locationsAllow.length > 0 && locations.length > 0) {
    const allowed = locations.some((loc) =>
      config.locationsAllow.some((a) => loc.includes(a.toLowerCase())),
    );
    if (!allowed) return false;
  }

  // US-only: reject if the listing has locations and none of them are US.
  if (config.usOnly && listing.locations.length > 0) {
    if (!listing.locations.some((loc) => isUSLocation(loc))) return false;
  }

  // Sponsorship requirement.
  if (config.requireSponsorship && listing.sponsorship) {
    const s = listing.sponsorship.toLowerCase();
    if (NO_SPONSORSHIP_PATTERNS.some((p) => s.includes(p))) return false;
  }

  return true;
}

/** Filter a batch of listings down to the ones matching the config. */
export function findCandidates(listings: Listing[], config: FilterConfig): Listing[] {
  return listings.filter((l) => matches(l, config));
}
