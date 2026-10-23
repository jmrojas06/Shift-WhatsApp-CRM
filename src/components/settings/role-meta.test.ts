import { describe, expect, it } from 'vitest';

import { ROLE_META } from './role-meta';
import { CHIP_VARIANTS } from './settings-chip';

// Fixed Tailwind palette colours don't adapt to light/dark mode (the
// old amber owner chip was unreadable on white). Chips must use tokens.
const PALETTE =
  /\b(?:bg|text|border)-(?:red|amber|emerald|green|blue|violet|rose|slate|zinc|gray|yellow|orange|sky|indigo|purple|pink)-\d/;

describe('settings chips', () => {
  it('chip variants only use theme tokens', () => {
    for (const classes of Object.values(CHIP_VARIANTS)) {
      expect(classes).not.toMatch(PALETTE);
    }
  });

  it('role chips only use theme tokens', () => {
    for (const meta of Object.values(ROLE_META)) {
      expect(meta.className).not.toMatch(PALETTE);
    }
  });

  it('role chip strings match their SettingsChip variant', () => {
    expect(ROLE_META.owner.className).toBe(CHIP_VARIANTS[ROLE_META.owner.variant]);
    expect(ROLE_META.admin.className).toBe(CHIP_VARIANTS[ROLE_META.admin.variant]);
    expect(ROLE_META.agent.className).toBe(CHIP_VARIANTS[ROLE_META.agent.variant]);
  });
});
