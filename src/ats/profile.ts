import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../core/scan';

/**
 * The user's application profile, loaded from config/profile.json (gitignored;
 * copy config/profile.example.json to create it).
 *
 * Deliberately excludes EEO / voluntary self-identification data (gender,
 * race/ethnicity, veteran status, disability status). Those questions are
 * never auto-answered by any handler, full stop — see src/ats/helpers.ts.
 */
export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  school: string;
  degree: string;
  /** e.g. "May" */
  graduationMonth: string;
  /** e.g. 2027 */
  graduationYear: number;
  linkedin: string;
  github: string;
  portfolio: string;
  /**
   * Path to the resume PDF. In config/profile.json this may be relative to
   * the repo root (e.g. "resumes/your-resume.pdf"); loadProfile() resolves it
   * to an absolute path and verifies the file exists before returning.
   */
  resumePath: string;
}

export class ProfileError extends Error {}

export const PROFILE_PATH = path.join(ROOT, 'config', 'profile.json');

const STRING_FIELDS = [
  'firstName',
  'lastName',
  'email',
  'phone',
  'city',
  'state',
  'school',
  'degree',
  'graduationMonth',
  'linkedin',
  'github',
  'portfolio',
  'resumePath',
] as const;

/**
 * Load and validate config/profile.json. Same defensive, fail-loud pattern as
 * src/matching/filterConfig.ts: a missing file, malformed JSON, an unknown
 * key, or a wrong-typed/empty field throws a clear ProfileError instead of
 * silently proceeding with half a profile — better to fix the config than to
 * send an employer a half-filled application.
 */
export function loadProfile(filePath: string = PROFILE_PATH): Profile {
  if (!existsSync(filePath)) {
    throw new ProfileError(
      `${filePath} not found. Copy config/profile.example.json to config/profile.json ` +
        `and fill in your details (it is gitignored, so your data stays local).`,
    );
  }

  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new ProfileError(`Could not parse ${filePath}: ${(err as Error).message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new ProfileError(`${filePath}: expected a JSON object at the top level`);
  }

  const obj = doc as Record<string, unknown>;
  const known: string[] = [...STRING_FIELDS, 'graduationYear'];
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      throw new ProfileError(
        `${filePath}: unknown key "${key}" (known keys: ${known.join(', ')})`,
      );
    }
  }

  for (const key of STRING_FIELDS) {
    const v = obj[key];
    if (typeof v !== 'string' || v.trim() === '') {
      throw new ProfileError(
        `${filePath}: "${key}" must be a non-empty string ` +
          `(see config/profile.example.json for the expected shape)`,
      );
    }
  }
  const year = obj['graduationYear'];
  if (typeof year !== 'number' || !Number.isInteger(year)) {
    throw new ProfileError(
      `${filePath}: "graduationYear" must be an integer (e.g. 2027), ` +
        `see config/profile.example.json`,
    );
  }

  // Resolve the resume path against the repo root (absolute paths pass
  // through unchanged) and make sure the file is really there — erroring now
  // beats silently "uploading" nothing during an application.
  const resumePath = path.resolve(ROOT, obj['resumePath'] as string);
  if (!existsSync(resumePath)) {
    throw new ProfileError(
      `Resume file not found at ${resumePath} (from "resumePath" in ${filePath}). ` +
        `Put your resume there, or point "resumePath" at the right file.`,
    );
  }

  return {
    firstName: obj['firstName'] as string,
    lastName: obj['lastName'] as string,
    email: obj['email'] as string,
    phone: obj['phone'] as string,
    city: obj['city'] as string,
    state: obj['state'] as string,
    school: obj['school'] as string,
    degree: obj['degree'] as string,
    graduationMonth: obj['graduationMonth'] as string,
    graduationYear: year,
    linkedin: obj['linkedin'] as string,
    github: obj['github'] as string,
    portfolio: obj['portfolio'] as string,
    resumePath,
  };
}
