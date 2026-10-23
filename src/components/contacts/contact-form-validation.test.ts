import { describe, expect, it } from 'vitest';
import { validateContactFields } from './contact-form-validation';

describe('validateContactFields', () => {
  it('requires the phone', () => {
    expect(
      validateContactFields({ phone: '  ', email: '', phoneChanged: true }),
    ).toEqual({ phone: 'phoneRequired' });
  });

  it('asks for the country code when a typed number lacks it', () => {
    expect(
      validateContactFields({ phone: '3001234567', email: '', phoneChanged: true }),
    ).toEqual({ phone: 'phoneNeedsCountryCode' });
  });

  it('accepts a Colombian number written with spaces', () => {
    expect(
      validateContactFields({ phone: '+57 300 123 4567', email: '', phoneChanged: true }),
    ).toEqual({});
  });

  it('does not re-check an untouched phone on edit', () => {
    expect(
      validateContactFields({ phone: '573001234567', email: '', phoneChanged: false }),
    ).toEqual({});
  });

  it('treats name-less contacts as valid (name is optional)', () => {
    expect(
      validateContactFields({ phone: '+573001234567', email: '', phoneChanged: true }),
    ).toEqual({});
  });

  it('flags an email without a domain', () => {
    expect(
      validateContactFields({ phone: '+573001234567', email: 'nombre@', phoneChanged: true }),
    ).toEqual({ email: 'emailInvalid' });
  });

  it('accepts a normal email and reports both errors together', () => {
    expect(
      validateContactFields({ phone: '+573001234567', email: 'nombre@correo.com', phoneChanged: true }),
    ).toEqual({});
    expect(
      validateContactFields({ phone: '', email: 'sin-arroba', phoneChanged: true }),
    ).toEqual({ phone: 'phoneRequired', email: 'emailInvalid' });
  });
});
