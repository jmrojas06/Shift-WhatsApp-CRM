/**
 * Shared display config for message_templates.status.
 *
 * The DB stores Meta's raw enum (DRAFT / APPROVED / PENDING / REJECTED /
 * PAUSED / DISABLED / IN_APPEAL / PENDING_DELETION) — the UI maps it to
 * a human label + semantic badge classes (theme tokens) here so the template manager,
 * inbox picker, and broadcast picker stay aligned.
 */

import type { MessageTemplateStatus } from '@/types';
import { getT } from '@/lib/i18n/translate';

export interface TemplateStatusDisplay {
  label: string;
  classes: string;
}

const t = getT('TemplateStatus');

export const templateStatusConfig: Record<
  MessageTemplateStatus,
  TemplateStatusDisplay
> = {
  DRAFT: {
    label: t('DRAFT'),
    classes: 'bg-muted text-muted-foreground border-border',
  },
  PENDING: {
    label: t('PENDING'),
    classes: 'bg-warning/10 text-warning border-warning/30',
  },
  APPROVED: {
    label: t('APPROVED'),
    classes: 'bg-success/10 text-success border-success/30',
  },
  REJECTED: {
    label: t('REJECTED'),
    classes: 'bg-destructive/10 text-destructive border-destructive/30',
  },
  PAUSED: {
    label: t('PAUSED'),
    classes: 'bg-warning/10 text-warning border-warning/30',
  },
  DISABLED: {
    label: t('DISABLED'),
    classes: 'bg-destructive/10 text-destructive border-destructive/30',
  },
  IN_APPEAL: {
    label: t('IN_APPEAL'),
    classes: 'bg-info/10 text-info border-info/30',
  },
  PENDING_DELETION: {
    label: t('PENDING_DELETION'),
    classes: 'bg-muted text-muted-foreground border-border',
  },
};
