// @wc-ignore-file
/** Test helpers: the fixture drops and what willow25 says they contain. */
import { readFileSync } from 'node:fs';

export interface Expected {
  namespace: string;
  subspace: string;
  path: string[];
  /** willow25's `Display` for the path. */
  pathDisplay: string;
  timestamp: string;
  /** willow25 0.7.9's own UTC reading of the timestamp, via hifitime. */
  willow25UnixMillis: string;
  payloadLength: string;
  payloadDigest: string;
  capability: string;
  payload: string | null;
}

/** Written by fixtures/generate with willow25 0.7.9, the reference implementation. */
export const expected: { drops: Record<string, Expected[]> } = JSON.parse(
  readFileSync(new URL('./fixtures/expected.json', import.meta.url), 'utf8'),
);

export const drop = (name: string) =>
  new Uint8Array(
    readFileSync(new URL(`./fixtures/${name}.drop`, import.meta.url)),
  );

export const bytes = (text: string) => new Uint8Array(Buffer.from(text));
