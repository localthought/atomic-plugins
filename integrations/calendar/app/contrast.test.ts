// @wc-ignore-file
/**
 * DESIGN.md §7: event fills are 14% (light) / 22% (dark) of the calendar's
 * colour over the surface, and `--pl-text` must stay at or above 4.5:1 on
 * them. Checked for Google Calendar's 24 classic calendar colours with the
 * fallback tokens (the host's own values are checked by the e2e).
 */
import { describe, expect, it } from 'vitest';
import { contrast, mix } from './ui/theme.js';

/** Google Calendar's classic calendar colours (calendarList `backgroundColor`). */
export const GOOGLE_COLORS = [
  '#ac725e',
  '#d06b64',
  '#f83a22',
  '#fa573c',
  '#ff7537',
  '#ffad46',
  '#42d692',
  '#16a765',
  '#7bd148',
  '#b3dc6c',
  '#fbe983',
  '#fad165',
  '#92e1c0',
  '#9fe1e7',
  '#9fc6e7',
  '#4986e7',
  '#9a9cff',
  '#b99aff',
  '#c2c2c2',
  '#cabdbf',
  '#cca6ac',
  '#f691b2',
  '#cd74e6',
  '#a47ae2',
];

const THEMES = {
  light: { surface: '#f5f6f8', text: '#1b1e22', muted: '#626a73', tint: 14 },
  dark: { surface: '#1d2024', text: '#e8eaed', muted: '#9aa2ab', tint: 22 },
};

describe('event tint contrast', () => {
  for (const [name, t] of Object.entries(THEMES))
    it(`keeps text at 4.5:1 or more on every tint (${name})`, () => {
      const worst = GOOGLE_COLORS.map(color => ({
        color,
        text: contrast(t.text, mix(color, t.tint, t.surface)),
        // `.ev-m`: the time line, 60% text and 40% muted (calendarStyles.ts).
        meta: contrast(mix(t.text, 60, t.muted), mix(color, t.tint, t.surface)),
      }));
      expect(worst.filter(w => w.text < 4.5)).toEqual([]);
      // The time line is 11px, so it is held to 4.5:1 too. Plain
      // `--pl-muted` fails on 9 (light) and 17 (dark) of these tints.
      expect(worst.filter(w => w.meta < 4.5)).toEqual([]);
    });
});
