import { randomBytes } from "crypto";

/**
 * Generate a public ID in the format: {jobNumber}-{6-char suffix}
 * Suffix is cryptographically random, base36-encoded.
 */
export function generatePublicId(jobNumber: string): string {
  const suffix = randomBytes(4).toString("hex").slice(0, 6);
  return `${jobNumber}-${suffix}`;
}
