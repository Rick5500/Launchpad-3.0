function mobileDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function nationalDigits(digits) {
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

export function sameMobile(left, right) {
  const a = mobileDigits(left);
  const b = mobileDigits(right);
  if (a === b) return true;
  const na = nationalDigits(a);
  const nb = nationalDigits(b);
  return Boolean(na) && na === nb;
}

export function formatMobileDisplay(value) {
  const national = nationalDigits(mobileDigits(value));
  if (national.length === 10) {
    return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
  }
  return String(value || '').trim();
}

// True when the box is ticked, texts were turned off, or the mobile number
// differs from the saved profile. Formatting differences such as
// "(919) 555-0100" and "+19195550100" are the same number.
export function textingNeedsSave(user, mobilePhone, smsOptIn) {
  if (!user) return false;
  if (Boolean(smsOptIn) !== Boolean(user.sms_opt_in)) return true;
  return !sameMobile(mobilePhone, user.mobile_phone);
}
