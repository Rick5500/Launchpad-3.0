const { DOMImplementation, XMLSerializer } = require('@xmldom/xmldom');
const JsBarcode = require('jsbarcode');

// Space through tilde: the characters Code 128 set B can draw, capped at 80.
const PRINTABLE_BARCODE = /^[\x20-\x7E]{1,80}$/;

function isPrintableBarcode(value) {
  return PRINTABLE_BARCODE.test(String(value ?? '').trim());
}

function barcodeValueError(value) {
  if (isPrintableBarcode(value)) return null;
  const error = new Error('Barcode value must be 1 to 80 printable ASCII characters');
  error.status = 400;
  return error;
}

// JsBarcode is MIT-licensed. It draws Code 128 as black bars on a white SVG.
function code128Svg(value) {
  const invalid = barcodeValueError(value);
  if (invalid) throw invalid;
  const text = String(value ?? '').trim();

  const document = new DOMImplementation().createDocument('http://www.w3.org/1999/xhtml', 'html', null);
  const svgNode = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  JsBarcode(svgNode, text, {
    format: 'CODE128',
    xmlDocument: document,
    displayValue: false,
    margin: 0,
    height: 64,
    width: 2,
    background: '#ffffff',
    lineColor: '#000000',
  });
  svgNode.setAttribute('role', 'img');
  svgNode.setAttribute('aria-label', `Code 128 ${text}`);
  return new XMLSerializer().serializeToString(svgNode);
}

module.exports = {
  PRINTABLE_BARCODE,
  isPrintableBarcode,
  code128Svg,
};
