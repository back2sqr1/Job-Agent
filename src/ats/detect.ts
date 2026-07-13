import { ashby } from './ashby';
import { fallback } from './fallback';
import { greenhouse } from './greenhouse';
import { lever } from './lever';
import { workday } from './workday';
import { AtsHandler } from './types';

/**
 * All handlers, in match order. `fallback.detect()` accepts everything, so it
 * must stay last — it is the answer for any URL no real handler recognizes.
 */
export const HANDLERS: AtsHandler[] = [greenhouse, lever, ashby, workday, fallback];

/** Route a URL (by hostname) to the handler that claims it; fallback otherwise. */
export function detectHandler(url: string): AtsHandler {
  return HANDLERS.find((h) => h.detect(url)) ?? fallback;
}
