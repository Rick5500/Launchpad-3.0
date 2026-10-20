// Best-effort hints for a staff order form. Nothing here creates an order.

const MONTHS = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

function pad(value) {
  return String(value).padStart(2, '0');
}

function validDate(year, month, day) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
    return '';
  }
  return `${year}-${pad(month)}-${pad(day)}`;
}

function normalizeDate(raw) {
  const text = String(raw || '').trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (match) return validDate(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(text);
  if (match) {
    let year = Number(match[3]);
    if (year < 100) year += 2000;
    return validDate(year, Number(match[1]), Number(match[2]));
  }
  match = /^([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(\d{4})$/.exec(text);
  if (match) {
    const month = MONTHS[match[1].toLowerCase()];
    if (!month) return '';
    return validDate(Number(match[3]), month, Number(match[2]));
  }
  match = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})$/.exec(text);
  if (match) {
    const month = MONTHS[match[2].toLowerCase()];
    if (!month) return '';
    return validDate(Number(match[3]), month, Number(match[1]));
  }
  return '';
}

function firstMatch(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[1]) return String(match[1]).trim();
  }
  return '';
}

function cleanSubject(subject) {
  return String(subject || '')
    .replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseDraft(subject, body) {
  const clean = cleanSubject(subject);
  const text = `${clean}\n${body || ''}`;
  const poRaw = firstMatch(text, [
    /\b(?:purchase\s+order|P\.?\s*O\.?(?:\s*(?:number|no\.?|#))?)\s*[:#-]?\s*(?!box\b)([A-Za-z0-9][A-Za-z0-9\-]{1,39})/i,
  ]);
  const quantity = firstMatch(text, [
    /\b(?:qty|quantity)\s*[:#-]?\s*(\d{1,7})\b/i,
    /\b(\d{1,7})\s*(?:copies|pcs|pieces|ea|each|sets|set)\b/i,
  ]);
  const dueRaw = firstMatch(text, [
    /\b(?:due|needed|deliver(?:y)?)\s*(?:date|by|on)?\s*[:\-]?\s*(\d{4}-\d{2}-\d{2})\b/i,
    /\b(?:due|needed|deliver(?:y)?)\s*(?:date|by|on)?\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\b/i,
    /\b(?:due|needed|deliver(?:y)?)\s*(?:date|by|on)?\s*[:\-]?\s*([A-Za-z]+\s+\d{1,2}(?:st|nd|rd|th)?(?:,)?\s+\d{4})\b/i,
    /\b(?:due|needed|deliver(?:y)?)\s*(?:date|by|on)?\s*[:\-]?\s*(\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]+\s+\d{4})\b/i,
  ]);
  const job = firstMatch(text, [
    /\b(?:job|description|project)\s*[:\-]\s*([^\n]{2,180})/i,
  ]).replace(/\s+/g, ' ').trim();
  const project = (job || clean).slice(0, 160);
  const notes = [job, quantity ? `Quantity: ${quantity}` : ''].filter(Boolean).join('\n\n').slice(0, 2000);
  return {
    po_number: poRaw.replace(/[^A-Za-z0-9\-]/g, '').slice(0, 80),
    due_date: normalizeDate(dueRaw),
    quantity: quantity || '',
    job_description: job.slice(0, 500),
    project_name: project,
    notes,
  };
}

function emailDomain(value) {
  const text = String(value || '').trim().toLowerCase();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) return '';
  return text.slice(at + 1);
}

function matchSender(customers, fromAddress) {
  const email = String(fromAddress || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return { customer: null, match: null, candidates: [] };
  }
  const exact = (customers || []).filter((row) => {
    const address = String(row.email || '').trim().toLowerCase();
    const username = String(row.username || '').trim().toLowerCase();
    return address === email || username === email;
  });
  if (exact.length === 1) return { customer: exact[0], match: 'email', candidates: exact };
  if (exact.length > 1) return { customer: null, match: null, candidates: exact };
  const domain = emailDomain(email);
  if (!domain) return { customer: null, match: null, candidates: [] };
  const domainMatches = (customers || []).filter((row) => emailDomain(row.email) === domain);
  if (domainMatches.length === 1) {
    return { customer: domainMatches[0], match: 'domain', candidates: domainMatches };
  }
  return { customer: null, match: null, candidates: domainMatches };
}

module.exports = {
  parseDraft,
  normalizeDate,
  matchSender,
};
