const TEN_DIGIT_REGEX = /^\d{10}$/;

/**
 * Normalize input to a 10-digit local mobile number.
 * Payload is expected as 10 digits; legacy values with a 91 prefix are also accepted.
 */
export const normalizeTenDigitMobile = (mobile) => {
  const digits = String(mobile ?? '').replace(/\D/g, '');

  if (digits.length === 12 && digits.startsWith('91')) {
    return digits.slice(2);
  }

  return digits;
};

/**
 * Validate and return a 10-digit Indian mobile number.
 * Any starting digit is allowed.
 */
export const validateTenDigitMobile = (mobile) => {
  const local = normalizeTenDigitMobile(mobile);
  return TEN_DIGIT_REGEX.test(local) ? local : null;
};

/**
 * Format a validated mobile for outbound SMS/WhatsApp (91 + 10 digits).
 */
export const formatIndianMobileForSend = (mobile) => {
  const local = validateTenDigitMobile(mobile);

  if (!local) {
    throw new Error('Invalid mobile number');
  }

  return `91${local}`;
};
