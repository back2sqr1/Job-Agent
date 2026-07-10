export type PositionType = 'New Grad' | 'Internship';

/**
 * Classifies a listing's position type from its title, falling back to the
 * source repo's own default when the title doesn't say otherwise. A title
 * mentioning "intern"/"co-op" wins even in the New-Grad repo (a few listings
 * really are internships/co-ops there), and "new grad"/"early career" wins
 * even in an internship repo.
 */
export function classifyPositionType(title: string, defaultType: PositionType): PositionType {
  const t = title.toLowerCase();
  if (/\bintern(ship)?\b|\bco-?op\b/.test(t)) return 'Internship';
  if (/\bnew grad|university grad|early career|entry level\b/.test(t)) return 'New Grad';
  return defaultType;
}
