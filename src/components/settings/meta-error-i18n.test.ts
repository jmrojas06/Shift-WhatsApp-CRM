import { describe, expect, it } from 'vitest';

import { explainMetaError } from '@/lib/whatsapp/meta-error-explain';
import {
  classifyMetaError,
  localizeMetaError,
  type MetaErrorInput,
  type MetaErrorTranslate,
} from './meta-error-i18n';

const meta = (over: Partial<MetaErrorInput> = {}): MetaErrorInput => ({
  code: null,
  subcode: null,
  step: 'verify_number',
  message: null,
  ...over,
});

// A translator that exposes the key and values it was called with.
const echo: MetaErrorTranslate = (key, values) =>
  values ? `${key}|${JSON.stringify(values)}` : key;

describe('classifyMetaError', () => {
  it.each([
    [{ code: 190, subcode: 463 }, 'tokenExpired'],
    [{ code: 190, subcode: 460 }, 'tokenRevoked'],
    [{ code: 190, subcode: 467 }, 'tokenRevoked'],
    [{ code: 190, subcode: null }, 'tokenInvalid'],
    [{ code: 10 }, 'permissions'],
    [{ code: 200 }, 'permissions'],
    [{ code: 299 }, 'permissions'],
    [{ code: 131005 }, 'businessAccess'],
    [{ code: 33 }, 'notFoundPhone'],
    [{ code: 100, subcode: 33 }, 'notFoundPhone'],
    [{ code: 100, message: 'Unsupported get request' }, 'notFoundPhone'],
    [{ code: 33, step: 'subscribe_waba' }, 'notFoundWaba'],
    [{ code: 100, message: 'Invalid parameter' }, 'badParam'],
    [{ code: 100, step: 'register', message: 'Invalid PIN' }, 'pinRejected'],
    [{ code: 133010 }, 'phoneNotRegistered'],
    [{ code: 133005 }, 'pinWrong'],
    [{ code: 136025 }, 'pinWrong'],
    [{ code: 133008 }, 'pinLocked'],
    [{ code: 133009 }, 'pinLocked'],
    [{ code: 133006 }, 'reverify'],
    [{ code: 133015 }, 'recentlyDeleted'],
    [{ code: 131031 }, 'accountRestricted'],
    [{ code: 368 }, 'policyBlock'],
    [{ code: 4 }, 'rateLimit'],
    [{ code: 80007 }, 'rateLimit'],
    [{ code: 131056 }, 'rateLimit'],
    [{ code: 2 }, 'temporary'],
    [{ code: 133016 }, 'temporary'],
    [{ code: 999999 }, 'generic'],
    [{ code: null }, 'generic'],
  ] as [Partial<MetaErrorInput>, string][])('%j -> %s', (input, expected) => {
    expect(classifyMetaError(meta(input))).toBe(expected);
  });

  it('recognises the WABA / phone mismatch the route reports without a code', () => {
    expect(
      classifyMetaError(
        meta({
          step: 'waba_phone_numbers',
          message: 'phone_number_id is not listed under waba_id',
        }),
      ),
    ).toBe('wabaMismatch');
  });

  // The server decides what the user sees in English; the client must
  // reach the same conclusion from the `meta` payload alone. Guard the
  // two classifiers against drifting apart.
  it.each([
    [{ code: 190, subcode: 463, message: 'Session has expired' }, 'verify_number', 'access_token'],
    [{ code: 190, subcode: 460, message: 'Changed password' }, 'verify_number', 'access_token'],
    [{ code: 10, message: 'Permission denied' }, 'subscribe_waba', 'access_token'],
    [{ code: 131005, message: 'Access denied' }, 'subscribe_waba', 'access_token'],
    [{ code: 100, message: 'Unsupported get request' }, 'verify_number', 'phone_number_id'],
    [{ code: 100, message: 'Unsupported get request' }, 'waba_phone_numbers', 'waba_id'],
    [{ code: 133010, message: 'Not registered' }, 'register', 'pin'],
    [{ code: 133005, message: 'Wrong pin' }, 'register', 'pin'],
    [{ code: 133006, message: 'Reverify' }, 'register', 'meta_account'],
    [{ code: 131031, message: 'Locked' }, 'verify_number', 'meta_account'],
  ])('agrees with the server on field for %j at %s', (err, step, field) => {
    const explained = explainMetaError(err, step as never);
    expect(explained.field).toBe(field);
    expect(classifyMetaError(meta({ code: explained.code, subcode: explained.subcode, step, message: explained.metaMessage }))).not.toBe('generic');
  });
});

describe('localizeMetaError', () => {
  it('returns null without a meta object so server-translated text is shown as-is', () => {
    expect(localizeMetaError(null, echo)).toBeNull();
    expect(localizeMetaError(undefined, echo)).toBeNull();
  });

  it('maps a classified error to its message key', () => {
    expect(localizeMetaError(meta({ code: 190, subcode: 463 }), echo)).toBe(
      'metaError.tokenExpired',
    );
  });

  it('passes the code to the temporary-error message', () => {
    expect(localizeMetaError(meta({ code: 133016 }), echo)).toBe(
      'metaError.temporary|{"code":133016}',
    );
  });

  it('names the step in the generic message', () => {
    expect(localizeMetaError(meta({ code: 424242, step: 'register' }), echo)).toBe(
      'metaError.generic|{"step":"metaStep.register"}',
    );
  });

  it('falls back to an unknown step label', () => {
    expect(localizeMetaError(meta({ step: 'something_new' }), echo)).toBe(
      'metaError.generic|{"step":"metaStep.unknown"}',
    );
  });
});
