import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

/** Message keys under `Contacts.form` for each inline field error. */
export interface ContactFormErrors {
  phone?: 'phoneRequired' | 'phoneNeedsCountryCode';
  email?: 'emailInvalid';
}

// Deliberately loose: it only catches obvious typos (missing @ or
// domain). The browser's own `type="email"` check is off (`noValidate`)
// so the message can be shown inline and in the app language.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Field checks for the contact form, as message keys. Mirrors the rules
 * the form already enforced: the phone is the only required field and,
 * when it was typed or changed here, it must carry its country code
 * (see issue #586). Name, email and company stay optional.
 */
export function validateContactFields({
  phone,
  email,
  phoneChanged,
}: {
  phone: string;
  email: string;
  phoneChanged: boolean;
}): ContactFormErrors {
  const errors: ContactFormErrors = {};
  if (!phone.trim()) {
    errors.phone = 'phoneRequired';
  } else if (phoneChanged && !parseInternationalPhone(phone)) {
    errors.phone = 'phoneNeedsCountryCode';
  }
  const trimmedEmail = email.trim();
  if (trimmedEmail && !EMAIL_SHAPE.test(trimmedEmail)) {
    errors.email = 'emailInvalid';
  }
  return errors;
}
