// Order-status texts. Twilio is optional: when the account is not configured
// the message is logged and nothing is sent. Callers must not let a failure
// roll back the order status that triggered the text.

const READY_LABEL = 'Ready for Pickup';
const SMS_CONSENT = 'I agree to receive order status texts from Accent Corporate Graphics. Msg & data rates may apply. Reply STOP to opt out.';

function twilioAccount() {
  const sid = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  const token = process.env.TWILIO_AUTH_TOKEN == null ? '' : String(process.env.TWILIO_AUTH_TOKEN);
  const from = normalizeE164(process.env.TWILIO_FROM_NUMBER);
  if (!sid || !token || !from) return null;
  if (sid.length > 64 || /[\s/]/.test(sid)) return null;
  return { sid, token, from };
}

function apiBase() {
  const fallback = 'https://api.twilio.com';
  if (process.env.NODE_ENV !== 'test') return fallback;
  const override = String(process.env.TWILIO_API_BASE || '').trim().replace(/\/+$/, '');
  if (!override) return fallback;
  try {
    const parsed = new URL(override);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fallback;
    return override;
  } catch (err) {
    return fallback;
  }
}

// US numbers are the default. 10 digits become +1. 11 digits starting with 1
// keep that country code. A leading + is kept when the rest is E.164.
function normalizeE164(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  if (!raw || /[\u0000-\u001F]/.test(raw)) return null;
  const hasPlus = raw.startsWith('+');
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  let e164 = null;
  if (hasPlus) e164 = `+${digits}`;
  else if (digits.length === 10) e164 = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith('1')) e164 = `+${digits}`;
  if (!e164 || !/^\+[1-9]\d{7,14}$/.test(e164)) return null;
  return e164;
}

function flattenAddress(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.replace(/[\u0000-\u001F]+/g, ' ').trim())
    .filter(Boolean)
    .join(', ');
}

function pickupSmsBody({ orderNumber, locationName, locationAddress, locationPhone }) {
  const number = String(orderNumber || 'your order').replace(/[\r\n]+/g, ' ').trim() || 'your order';
  const placeName = String(locationName || '').replace(/[\r\n]+/g, ' ').trim();
  const place = placeName ? `our ${placeName} location` : 'our shop';
  const address = flattenAddress(locationAddress);
  const where = address ? `${place}, ${address}` : place;
  const phone = String(locationPhone || '').replace(/[\r\n]+/g, ' ').trim();
  const questions = phone ? ` Questions? ${phone}` : '';
  return `Accent Corporate Graphics: Order #${number} is ready for pickup at ${where}.${questions}`.replace(/[ \t]{2,}/g, ' ').trim();
}

async function sendSms({ to, body }) {
  const destination = normalizeE164(to);
  const text = String(body || '').trim();
  if (!destination || !text) return { status: 'invalid', to: destination };
  const account = twilioAccount();
  if (!account) {
    console.log(`SMS dry-run: to=${destination} body=${text}`);
    return { status: 'dry_run', to: destination };
  }
  const params = new URLSearchParams({
    To: destination,
    From: account.from,
    Body: text,
  });
  const authorization = Buffer.from(`${account.sid}:${account.token}`).toString('base64');
  const url = `${apiBase()}/2010-04-01/Accounts/${encodeURIComponent(account.sid)}/Messages.json`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authorization}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.error('SMS SEND ERROR:', response.status);
      return { status: 'failed', to: destination };
    }
    return { status: 'sent', to: destination };
  } catch (err) {
    console.error('SMS SEND ERROR:', err && err.name ? err.name : 'failed');
    return { status: 'failed', to: destination };
  }
}

module.exports = {
  READY_LABEL,
  SMS_CONSENT,
  normalizeE164,
  flattenAddress,
  pickupSmsBody,
  sendSms,
  twilioAccount,
};
