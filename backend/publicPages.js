const {
  SMS_CONSENT,
  SMS_DISCLOSURE,
  SMS_SAVE_LABEL,
  SMS_PREVIEW_LABEL,
  PRIVACY_SHARING,
  PRIVACY_TRANSACTIONAL,
  COMPANY_CONTACT,
} = require('./sms');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page({ title, main }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} — LaunchPad 3.0</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif; background: #F4F7FB; color: #1B2838; }
    header { background: #0A2F6E; color: #fff; padding: 28px 20px 24px; }
    .wrap { max-width: 920px; margin: 0 auto; }
    .logo-plate { background: #fff; display: inline-block; border-radius: 8px; padding: 8px 12px; }
    .logo-plate img { height: 48px; width: auto; display: block; }
    h1 { font-size: 2.4rem; line-height: 1.15; margin: 18px 0 0; }
    nav { display: flex; flex-wrap: wrap; gap: 18px; margin-top: 14px; }
    nav a { color: #fff; font-size: 1.2rem; font-weight: 800; }
    main { max-width: 920px; margin: 0 auto; padding: 28px 20px 12px; }
    .card { background: #fff; border: 1px solid #E2E8F0; border-top: 4px solid #F58220; border-radius: 8px; padding: 28px 24px; }
    .note { background: #FFF6E8; border: 2px solid #F58220; border-radius: 8px; padding: 18px 20px; margin-bottom: 16px; }
    .note strong { display: block; color: #0A2F6E; font-size: 1.45rem; line-height: 1.35; }
    .note p { font-size: 1.2rem; line-height: 1.5; margin: 8px 0 0; }
    h2 { color: #0A2F6E; font-size: 1.6rem; margin: 1.4rem 0 0.4rem; }
    p, label, .disclosure { font-size: 1.25rem; line-height: 1.55; }
    a { color: #0A2F6E; font-weight: 800; }
    form { display: grid; gap: 14px; max-width: 720px; }
    input[type="tel"] { font-size: 1.25rem; padding: 12px 14px; border: 1px solid #5E6A78; border-radius: 6px; width: 100%; box-sizing: border-box; }
    .check { display: flex; gap: 10px; align-items: flex-start; font-weight: 600; }
    .check input { width: 1.3rem; height: 1.3rem; margin-top: 0.25rem; }
    button { justify-self: start; background: #0A2F6E; color: #fff; border: 0; border-radius: 6px; font-size: 1.15rem; font-weight: 800; padding: 12px 18px; }
    footer { text-align: center; padding: 8px 20px 28px; }
    .logos { display: flex; gap: 8px; justify-content: center; align-items: center; }
    .logos img { height: 36px; width: auto; }
    .credit { font-weight: 800; color: #0A2F6E; font-size: 12px; margin: 8px 0 0; }
  </style>
</head>
<body>
  <header>
    <div class="wrap">
      <div class="logo-plate"><img src="/brand/logo.png" alt="Launchpad" /></div>
      <h1>${escapeHtml(title)}</h1>
      <nav>
        <a href="/sms-opt-in">Text opt-in</a>
        <a href="/terms">Terms of Service</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="/login">Sign in</a>
      </nav>
    </div>
  </header>
  <main>${main}</main>
  <footer>
    <div class="logos">
      <img src="/brand/accent-imaging-logo.png" alt="Accent Imaging" />
      <img src="/brand/acg-logo.png" alt="Accent Corporate Graphics" />
    </div>
    <p class="credit">A service of Accent Imaging and Accent Corporate Graphics</p>
  </footer>
</body>
</html>`;
}

function termsHtml() {
  return page({
    title: 'Terms of Service',
    main: `<div class="card">
      <p>Accent Corporate Graphics is a division of Accent Imaging, Inc. These terms cover Launchpad and the optional order-status text messages a customer can turn on inside a Launchpad account.</p>
      <h2>Order status texts</h2>
      <p>${escapeHtml(SMS_CONSENT)} ${escapeHtml(SMS_DISCLOSURE)}</p>
      <p>${escapeHtml(PRIVACY_TRANSACTIONAL)} A text may tell you when an order is ready for pickup. Message frequency is about 1 message per order. Message and data rates may apply. Reply HELP for help or STOP to cancel at any time. Consent is not required to make a purchase.</p>
      <h2>Using Launchpad</h2>
      <p>Place orders only for work you are authorized to request. Keep your password to yourself. Information you enter on an order is used to produce and deliver that job. Turning texts on or off does not change whether Accent Imaging can accept an order.</p>
      <h2>Contact</h2>
      <p>Contact ${escapeHtml(COMPANY_CONTACT)}. You can also read the <a href="/privacy">Privacy Policy</a> and see <a href="/sms-opt-in">how customers opt in</a>.</p>
    </div>`,
  });
}

function privacyHtml() {
  return page({
    title: 'Privacy Policy',
    main: `<div class="card">
      <p>Accent Corporate Graphics, a division of Accent Imaging, Inc., uses Launchpad to take orders and to tell customers about those orders.</p>
      <h2>Mobile numbers and text messages</h2>
      <p>${escapeHtml(PRIVACY_TRANSACTIONAL)} They are messages about an order you placed, such as when that order is ready for pickup. They are not marketing messages.</p>
      <p>${escapeHtml(PRIVACY_SHARING)}</p>
      <p>If you add a mobile number and check the consent box in your Launchpad account, we store that number and that consent so we can send those order notifications. You can turn texts off in your account, or reply STOP to a message. Consent is not required to make a purchase.</p>
      <h2>Other order details</h2>
      <p>Launchpad stores the company, contact, address, and job details you submit so Accent Imaging can produce the order, share proofs and files with you, and show you the status of your own work. Staff see the orders they are allowed to work on. Another customer cannot open your orders.</p>
      <h2>Contact</h2>
      <p>Contact ${escapeHtml(COMPANY_CONTACT)}. Questions about these texts can also go to that address. See the <a href="/terms">Terms of Service</a> and <a href="/sms-opt-in">how customers opt in</a>.</p>
    </div>`,
  });
}

function smsOptInHtml() {
  return page({
    title: 'Text message opt-in',
    main: `<div class="note">
      <strong>${escapeHtml(SMS_PREVIEW_LABEL)}</strong>
      <p>This page is a preview of the form on Place an order. It does not create an account, save a mobile number, or turn texts on.</p>
    </div>
    <div class="card" style="border-top:0;border-left:6px solid #0A2F6E;">
      <h2 style="margin-top:0;">Order status texts</h2>
      <p>Add a mobile number if you want a text when an order is ready for pickup. This stays off until you agree.</p>
      <form action="#" method="get" onsubmit="return false">
        <label for="preview-mobile">Mobile phone</label>
        <input id="preview-mobile" name="mobile" type="tel" placeholder="919-555-0100" autocomplete="off" readonly />
        <label class="check">
          <input type="checkbox" aria-label="${escapeHtml(SMS_CONSENT)}" onclick="return false" />
          <span>${escapeHtml(SMS_CONSENT)}</span>
        </label>
        <p class="disclosure">${escapeHtml(SMS_DISCLOSURE)}</p>
        <p><a href="/terms">Terms of Service</a> and <a href="/privacy">Privacy Policy</a></p>
        <button type="button">${escapeHtml(SMS_SAVE_LABEL)}</button>
      </form>
    </div>`,
  });
}

function publicPageHtml(urlPath) {
  if (urlPath === '/terms') return termsHtml();
  if (urlPath === '/privacy') return privacyHtml();
  if (urlPath === '/sms-opt-in') return smsOptInHtml();
  return null;
}

module.exports = {
  publicPageHtml,
};
