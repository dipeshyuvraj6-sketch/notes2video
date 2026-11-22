const fs = require('fs');
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const config = require('./config');

async function extractText(filePath) {
  const buffer = await fs.promises.readFile(filePath);
  const data = await pdfParse(buffer);
  return { text: data.text || '', pages: data.numpages };
}

function prepareText(rawText) {
  let text = (rawText || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^\s*\d{1,3}\s*$/gm, '')
    .trim();
  const truncated = text.length > config.MAX_INPUT_CHARS;
  if (truncated) text = text.slice(0, config.MAX_INPUT_CHARS);
  return { text, truncated };
}

function classifyPdfError(error) {
  const message = error && error.message ? error.message : '';
  if (/password|encrypt/i.test(message)) {
    return { code: 'PDF_ENCRYPTED', message: 'Password-protected PDFs are not supported.' };
  }
  return { code: 'PDF_UNREADABLE', message: 'This PDF appears to be damaged or unreadable.' };
}

module.exports = { extractText, prepareText, classifyPdfError };
