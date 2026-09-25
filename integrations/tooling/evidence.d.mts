export interface Evidence {
  owner: string;
  version: string;
  testedAt: string;
  stale: boolean;
  checks: number;
  live: 'not-run';
}
export function assessEvidence(
  report: unknown,
  id: string,
  bundleSha256: string,
  now?: number,
): Evidence | null;
export function neededLevel(
  item: unknown,
): 'read-only' | 'read-write' | undefined;
export function gatedEvidenceRecorded(item: unknown): boolean;
