// Turn mailbox HTML into plain text. Tags are removed, including the contents
// of script and style, so the staff page can render the result as text.

function decodeNumeric(code) {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10FFFF) return '';
  if (code < 32 && code !== 9 && code !== 10 && code !== 13) return '';
  try {
    return String.fromCodePoint(code);
  } catch (err) {
    return '';
  }
}

function decodeEntities(value) {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex) => decodeNumeric(parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (match, digits) => decodeNumeric(Number(digits)));
}

function stripTags(value) {
  return value
    .replace(/<\s*(script|style|iframe|object|embed|noscript)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table|blockquote|section|article|pre)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '');
}

function tidy(value, limit) {
  let text = String(value || '');
  text = text.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.slice(0, limit);
}

function htmlToText(value) {
  let text = String(value == null ? '' : value);
  for (let pass = 0; pass < 3; pass += 1) {
    const next = decodeEntities(stripTags(text));
    if (next === text) break;
    text = next;
  }
  return tidy(text, 100000);
}

function plainText(value) {
  return tidy(value, 100000);
}

function singleLine(value) {
  return htmlToText(value).replace(/\s+/g, ' ').trim().slice(0, 500);
}

module.exports = {
  htmlToText,
  plainText,
  singleLine,
};
