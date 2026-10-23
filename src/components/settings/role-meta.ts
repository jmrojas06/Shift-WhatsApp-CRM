import {
  Crown,
  Shield,
  UserCog,
  UserIcon,
  type LucideIcon,
} from 'lucide-react';

import type { AccountRole } from '@/lib/auth/roles';
import { CHIP_VARIANTS, type ChipVariant } from './settings-chip';

/**
 * Single source of truth for per-role chip metadata across settings
 * surfaces (the Overview identity chip and the Members roster/invite
 * chips). Previously duplicated in both files; hoisted here so a label,
 * icon, or colour change lands once.
 *
 * `variant` drives the token-based <SettingsChip>; `className` is the
 * same token colours as a plain string for the Members tab's own spans
 * (derived from CHIP_VARIANTS so the two can't drift). All of them are
 * theme tokens with AA contrast in light and dark mode.
 */
export const ROLE_META: Record<
  AccountRole,
  { icon: LucideIcon; label: string; variant: ChipVariant; className: string }
> = {
  owner: {
    icon: Crown,
    label: 'owner',
    variant: 'owner',
    className: CHIP_VARIANTS.owner,
  },
  admin: {
    icon: Shield,
    label: 'admin',
    variant: 'admin',
    className: CHIP_VARIANTS.admin,
  },
  agent: {
    icon: UserCog,
    label: 'agent',
    variant: 'muted',
    className: CHIP_VARIANTS.muted,
  },
  viewer: {
    icon: UserIcon,
    label: 'viewer',
    variant: 'muted',
    // Outline-only so it stays quieter than the filled Agent chip in
    // both modes — bg-card would blend into a card surface in light mode.
    className: 'border-border bg-transparent text-muted-foreground',
  },
};
