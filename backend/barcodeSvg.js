const { DOMImplementation, XMLSerializer } = require('@xmldom/xmldom');
const JsBarcode = require('jsbarcode');

// JsBarcode is MIT-licensed. It draws Code 128 as black bars on a white SVG.
function code128Svg(value) {
  const text = String(value || '').trim();
  if (!text) {
    const error = new Error('barcode value is required');
    error.status = 400;
    throw error;
  }
  if (text.length > 80) {
    const error = new Error('barcode value is too long');
    error.status = 400;
    throw error;
  }

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
  code128Svg,
};
