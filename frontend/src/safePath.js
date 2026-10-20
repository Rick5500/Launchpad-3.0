export function safeAppPath(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > 300) return '';
  if (!text.startsWith('/') || text.startsWith('//')) return '';
  if (/[\u0000-\u001F\\]/.test(text)) return '';
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch (err) {
    return '';
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//')) return '';
  if (decoded.includes('://') || decoded.includes('\\')) return '';
  if (decoded.startsWith('/login')) return '';
  return text;
}
