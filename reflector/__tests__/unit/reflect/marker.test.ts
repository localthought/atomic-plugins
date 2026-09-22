import { describe, expect, it } from 'vitest';
import {
  embedMarker,
  hasMarker,
  parseMarker,
  renderMarker,
  stripMarker,
  type OriginRef,
} from '../../../src/reflect/marker.js';

const ref: OriginRef = { system: 'octo/source', kind: 'issue', id: '42' };

describe('origin marker codec', () => {
  it('round-trips embed -> parse', () => {
    const body = embedMarker('Something is broken.', ref);
    expect(parseMarker(body)).toEqual(ref);
    expect(hasMarker(body)).toBe(true);
  });

  it('renders an invisible HTML comment that keeps the visible text', () => {
    const body = embedMarker('Visible text', ref);
    expect(body).toContain('Visible text');
    expect(body).toContain('<!-- reflector:origin');
    expect(body.trimEnd().endsWith('-->')).toBe(true);
  });

  it('is idempotent — re-embedding does not stack markers', () => {
    const once = embedMarker('body', ref);
    const twice = embedMarker(once, ref);
    expect(twice).toBe(once);
    expect(twice.match(/reflector:origin/g)).toHaveLength(1);
  });

  it('updates the marker in place when the ref changes', () => {
    const first = embedMarker('body', ref);
    const moved = embedMarker(first, { ...ref, id: '99' });
    expect(parseMarker(moved)?.id).toBe('99');
    expect(moved.match(/reflector:origin/g)).toHaveLength(1);
  });

  it('reports no marker for a plain body', () => {
    expect(hasMarker('just a normal issue body')).toBe(false);
    expect(parseMarker('just a normal issue body')).toBeUndefined();
  });

  it('survives extra user text around the marker', () => {
    const body = `${renderMarker(ref)}\n\nsomeone replied here\nand here`;
    expect(parseMarker(body)).toEqual(ref);
    expect(stripMarker(body)).toBe('someone replied here\nand here');
  });

  it('encodes values so they cannot close the comment early', () => {
    const tricky: OriginRef = {
      system: 'a/b',
      kind: 'issue',
      // contains characters that would break a naive marker
      id: 'x --> <script> y',
    };
    const body = embedMarker('hi', tricky);
    // The only `-->` in the body is the marker terminator.
    expect(body.match(/-->/g)).toHaveLength(1);
    expect(parseMarker(body)).toEqual(tricky);
  });

  it('embeds into an empty body as just the marker', () => {
    const body = embedMarker('', ref);
    expect(body).toBe(renderMarker(ref));
    expect(parseMarker(body)).toEqual(ref);
  });

  it('treats a marker missing a required key as absent', () => {
    const partial = '<!-- reflector:origin system=octo%2Fsource kind=issue -->';
    expect(parseMarker(partial)).toBeUndefined();
  });
});
