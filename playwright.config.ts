import type { LaunchOptions } from 'playwright';

/**
 * Stub configuration for Phase 2 (Playwright-assisted application filling).
 * Nothing in Phase 1 uses this — it exists so the Phase 2 `apply` flow can
 * build on a single, agreed-upon launch configuration.
 *
 * Phase 2 safety defaults (firm, see README "Ethical use"):
 *   - headed browser, never headless: the user watches every application
 *   - fill-then-pause: the handler stops BEFORE the submit click; the user
 *     reviews and submits by hand
 *   - no CAPTCHA solving or bot-detection evasion, ever
 */
export interface JobAgentPlaywrightConfig {
  launchOptions: LaunchOptions;
  /** Milliseconds to wait for ATS pages to settle before filling. */
  navigationTimeoutMs: number;
}

const config: JobAgentPlaywrightConfig = {
  launchOptions: {
    headless: false,
    slowMo: 50,
  },
  navigationTimeoutMs: 30_000,
};

export default config;
