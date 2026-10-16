// Code 128 pattern table (bar/space widths). Index is the symbol value.
// 103 start A, 104 start B, 105 start C, 106 stop.
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

if (PATTERNS.length !== 107
  || PATTERNS[103] !== '211412'
  || PATTERNS[104] !== '211214'
  || PATTERNS[105] !== '211232'
  || PATTERNS[106] !== '2331112') {
  throw new Error('Code 128 pattern table is invalid');
}

const PATTERN_INDEX = new Map(PATTERNS.map((pattern, index) => [pattern, index]));

function gcd(left, right) {
  let a = Math.abs(left);
  let b = Math.abs(right);
  while (b) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
}

function attr(source, name) {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source);
  return match ? match[1] : '';
}

function barsFromSvg(svg) {
  const bars = [];
  const rectRe = /<rect\b([^>]*?)\/?>/g;
  let match = rectRe.exec(svg);
  while (match) {
    const attrs = match[1];
    const fill = attr(attrs, 'fill').toLowerCase();
    const style = attr(attrs, 'style').toLowerCase();
    const white = fill === '#ffffff' || fill === '#fff' || fill === 'white'
      || style.includes('fill:#ffffff') || style.includes('fill:#fff') || style.includes('fill:white');
    const width = Number(attr(attrs, 'width'));
    const x = Number(attr(attrs, 'x') || 0);
    if (!white && Number.isFinite(width) && width > 0 && Number.isFinite(x)) {
      bars.push({ x, width });
    }
    match = rectRe.exec(svg);
  }
  bars.sort((left, right) => left.x - right.x);
  return bars;
}

function modulesFromBars(bars) {
  if (bars.length < 6) {
    throw new Error('Barcode does not contain enough bars');
  }
  const samples = [];
  for (let index = 0; index < bars.length; index += 1) {
    samples.push(Math.round(bars[index].width));
    if (index < bars.length - 1) {
      const gap = bars[index + 1].x - (bars[index].x + bars[index].width);
      if (gap > 0.5) samples.push(Math.round(gap));
    }
  }
  const moduleWidth = samples.reduce((current, sample) => gcd(current, sample), samples[0]);
  if (!moduleWidth) throw new Error('Could not measure barcode modules');

  const units = [];
  for (let index = 0; index < bars.length; index += 1) {
    units.push(Math.round(bars[index].width / moduleWidth));
    if (index < bars.length - 1) {
      const gap = bars[index + 1].x - (bars[index].x + bars[index].width);
      units.push(Math.round(gap / moduleWidth));
    }
  }
  return units;
}

function readSymbols(units) {
  const symbols = [];
  let index = 0;
  while (index < units.length) {
    if (units.slice(index, index + 7).join('') === PATTERNS[106]) {
      symbols.push(106);
      index += 7;
      break;
    }
    const pattern = units.slice(index, index + 6).join('');
    if (!PATTERN_INDEX.has(pattern)) {
      throw new Error(`Unrecognized Code 128 pattern at module ${index}`);
    }
    symbols.push(PATTERN_INDEX.get(pattern));
    index += 6;
  }
  if (!symbols.length || symbols[symbols.length - 1] !== 106) {
    throw new Error('Code 128 stop symbol was not found');
  }
  if (index !== units.length) {
    throw new Error('Code 128 symbol has trailing modules');
  }
  return symbols;
}

function code128Character(set, value) {
  if (set === 'A') {
    if (value >= 0 && value <= 63) return String.fromCharCode(value + 32);
    if (value >= 64 && value <= 95) return String.fromCharCode(value - 64);
  }
  if (set === 'B') {
    if (value >= 0 && value <= 94) return String.fromCharCode(value + 32);
  }
  if (set === 'C') {
    if (value >= 0 && value <= 99) return String(value).padStart(2, '0');
  }
  throw new Error(`Unsupported Code 128 value ${value} in set ${set}`);
}

function decodeSymbols(symbols) {
  const start = symbols[0];
  let set = null;
  if (start === 103) set = 'A';
  else if (start === 104) set = 'B';
  else if (start === 105) set = 'C';
  else throw new Error('Code 128 start symbol was not found');

  const checksum = symbols[symbols.length - 2];
  const data = symbols.slice(1, -2);
  let total = start;
  data.forEach((value, index) => {
    total += value * (index + 1);
  });
  if (total % 103 !== checksum) {
    throw new Error('Code 128 checksum does not match');
  }

  let text = '';
  let shift = null;
  for (let index = 0; index < data.length; index += 1) {
    const value = data[index];
    const active = shift || set;
    shift = null;

    if (active === 'C' && value === 100) {
      set = 'B';
      continue;
    }
    if (active === 'C' && value === 101) {
      set = 'A';
      continue;
    }
    if (active === 'B' && value === 99) {
      set = 'C';
      continue;
    }
    if (active === 'B' && value === 101) {
      set = 'A';
      continue;
    }
    if (active === 'A' && value === 99) {
      set = 'C';
      continue;
    }
    if (active === 'A' && value === 100) {
      set = 'B';
      continue;
    }
    if ((active === 'A' && value === 98) || (active === 'B' && value === 98)) {
      shift = active === 'A' ? 'B' : 'A';
      continue;
    }
    text += code128Character(active, value);
  }
  return text;
}

function decodeCode128Svg(svg) {
  if (typeof svg !== 'string' || !svg.includes('<svg')) {
    throw new Error('Barcode SVG is missing');
  }
  return decodeSymbols(readSymbols(modulesFromBars(barsFromSvg(svg))));
}

module.exports = {
  decodeCode128Svg,
};
