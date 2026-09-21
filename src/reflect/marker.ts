/**
 * Origin markers for reflected records — see `devonian/reflect`'s own
 * `marker.ts` for the full explanation of what these are and why.
 *
 * This is a thin wrapper pinning the marker namespace to `reflector` (the
 * tag reflector has always used, `<!-- reflector:origin ... -->`), so
 * existing markers already embedded in production records keep parsing the
 * same way after the underlying codec moved to `devonian` (localthought/
 * atomic-plugins#6).
 */
import * as devonianMarker from 'devonian/reflect';
import type { OriginRef } from 'devonian/reflect';

export type { OriginRef };

const NAMESPACE = 'reflector';

export function renderMarker(ref: OriginRef): string {
  return devonianMarker.renderMarker(ref, NAMESPACE);
}

export function hasMarker(body: string): boolean {
  return devonianMarker.hasMarker(body, NAMESPACE);
}

export function parseMarker(body: string): OriginRef | undefined {
  return devonianMarker.parseMarker(body, NAMESPACE);
}

export function stripMarker(body: string): string {
  return devonianMarker.stripMarker(body, NAMESPACE);
}

export function embedMarker(body: string, ref: OriginRef): string {
  return devonianMarker.embedMarker(body, ref, NAMESPACE);
}
