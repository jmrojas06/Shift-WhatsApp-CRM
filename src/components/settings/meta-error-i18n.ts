/**
 * Client-side translation of the Meta failures the WhatsApp config route
 * reports.
 *
 * The server (`src/lib/whatsapp/meta-error-explain.ts`) builds its
 * `error` / `message` text in English and attaches a `meta` object with
 * the raw `code`, `subcode` and `step`. This module reads that `meta`
 * and picks a next-intl message (`Settings.whatsapp.metaError.*`) that
 * says what happened and what to do, in the visitor's language.
 *
 * The classification mirrors `explainMetaError` branch by branch, in the
 * same order and with the same codes — nothing here is a guess about
 * Meta. When no branch matches, `localizeMetaError` returns a generic
 * message that names the step; the original Meta text still travels in
 * the `meta.message` line the screen already renders under it.
 *
 * Pure: no I/O, no React. The caller hands in a translator.
 */

/** Wire values of `meta.step`, as emitted by POST/GET /api/whatsapp/config. */
const KNOWN_STEPS = [
  'verify_number',
  'waba_phone_numbers',
  'register',
  'subscribe_waba',
  'subscribed_apps',
] as const;

/** The subset of the route's `meta` object this module reads. */
export interface MetaErrorInput {
  code: number | null;
  subcode: number | null;
  step: string;
  message?: string | null;
}

export type MetaErrorKind =
  | 'tokenExpired'
  | 'tokenRevoked'
  | 'tokenInvalid'
  | 'permissions'
  | 'businessAccess'
  | 'notFoundPhone'
  | 'notFoundWaba'
  | 'pinRejected'
  | 'badParam'
  | 'phoneNotRegistered'
  | 'pinWrong'
  | 'pinLocked'
  | 'reverify'
  | 'recentlyDeleted'
  | 'accountRestricted'
  | 'policyBlock'
  | 'rateLimit'
  | 'temporary'
  | 'wabaMismatch'
  | 'generic';

// Same sets as meta-error-explain.ts.
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056]);
const TEMPORARY_CODES = new Set([1, 2, 131000, 133004, 133016]);

// Same pattern the server uses to recognise "that id does not exist".
const MISSING_OBJECT_RE =
  /unsupported (get|post) request|does not exist|cannot be loaded due to missing permissions|unknown path components/i;

// Literal the route puts in `meta.message` when the phone number is not
// listed under the WABA the user typed (config/route.ts).
const WABA_MISMATCH_MESSAGE = 'phone_number_id is not listed under waba_id';

/** Steps that address the phone number; the others address the WABA. */
function targetsPhone(step: string): boolean {
  return step === 'verify_number' || step === 'register';
}

export function classifyMetaError(meta: MetaErrorInput): MetaErrorKind {
  const { code, subcode, step } = meta;
  const message = meta.message ?? '';

  if (
    step === 'waba_phone_numbers' &&
    code === null &&
    message === WABA_MISMATCH_MESSAGE
  ) {
    return 'wabaMismatch';
  }

  if (code === 190) {
    if (subcode === 463) return 'tokenExpired';
    if (subcode === 460 || subcode === 467) return 'tokenRevoked';
    return 'tokenInvalid';
  }

  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return 'permissions';
  }
  if (code === 131005) return 'businessAccess';

  if (
    code === 33 ||
    (code === 100 && subcode === 33) ||
    (code === 100 && MISSING_OBJECT_RE.test(message))
  ) {
    return targetsPhone(step) ? 'notFoundPhone' : 'notFoundWaba';
  }

  if (code === 100) {
    if (step === 'register' && /pin/i.test(message)) return 'pinRejected';
    return 'badParam';
  }

  if (code === 133010) return 'phoneNotRegistered';
  if (code === 133005 || code === 136025) return 'pinWrong';
  if (code === 133008 || code === 133009) return 'pinLocked';
  if (code === 133006) return 'reverify';
  if (code === 133015) return 'recentlyDeleted';
  if (code === 131031) return 'accountRestricted';
  if (code === 368) return 'policyBlock';

  if (code !== null && RATE_LIMIT_CODES.has(code)) return 'rateLimit';
  if (code !== null && TEMPORARY_CODES.has(code)) return 'temporary';

  return 'generic';
}

/** `t` from `useTranslations('Settings.whatsapp')`, loosely typed. */
export type MetaErrorTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

/**
 * Localised, actionable text for a failed Meta call, or `null` when the
 * response carried no `meta` (validation errors, auth errors and the like
 * are already translated by the server — show those as they come).
 */
export function localizeMetaError(
  meta: MetaErrorInput | null | undefined,
  t: MetaErrorTranslate,
): string | null {
  if (!meta || typeof meta.step !== 'string') return null;

  const kind = classifyMetaError(meta);
  if (kind === 'temporary') {
    return t('metaError.temporary', { code: meta.code ?? 0 });
  }
  if (kind === 'generic') {
    const known = (KNOWN_STEPS as readonly string[]).includes(meta.step);
    return t('metaError.generic', {
      step: t(known ? `metaStep.${meta.step}` : 'metaStep.unknown'),
    });
  }
  return t(`metaError.${kind}`);
}
