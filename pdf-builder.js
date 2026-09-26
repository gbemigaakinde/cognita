// pdf-builder.js
// Builds a minimal, valid, and *designed* PDF from plain text or
// structured { title, sections } content — no external PDF library
// (Workers can't load native ones), so this hand-writes PDF syntax
// directly: object table, one content stream per page, xref, trailer.
//
// Design: driven by a design-templates.js template (palette + a PDF
// standard-14 font family — Helvetica/Times/Courier, no embedding
// needed), selected per-resource by resources-endpoint.js and passed in
// as a templateId. Falls back to the 'classic' template if none is given,
// so callers that don't care about templates (e.g. document-endpoint.js)
// keep working unchanged.
//
// Text encoding: PDF's built-in fonts use WinAnsiEncoding (~Windows-1252),
// not UTF-8. AI-generated text often contains curly quotes, em dashes,
// ellipses, and bullet characters that corrupt a PDF literal string if
// written as raw UTF-8 bytes. Text is sanitized to WinAnsi-safe single-byte
// characters before being placed in a content stream, and content streams
// are encoded 1 char = 1 byte (Latin-1), never UTF-8.

import { getTemplate, getDefaultTemplate, getPdfFontFamily } from './design-templates.js';

/* ── Page geometry ── */
const PAGE_WIDTH = 595.28;   // A4
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 64;
const MARGIN_TOP = 76;
const MARGIN_BOTTOM = 56;    // reserved for footer rule + page number
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
const CONTENT_TOP = PAGE_HEIGHT - MARGIN_TOP;
const CONTENT_BOTTOM = MARGIN_BOTTOM;

const TITLE_SIZE = 21;
const TITLE_LINE_HEIGHT = 25;
const HEADING_SIZE = 12.5;
const HEADING_LINE_HEIGHT = 16;
const HEADING_SPACE_BEFORE = 20;
const HEADING_SPACE_AFTER = 8;
const BODY_SIZE = 10.5;
const BODY_LINE_HEIGHT = 15.5;
const BULLET_SIZE = 10.5;
const BULLET_LINE_HEIGHT = 14.5;
const BULLET_ITEM_GAP = 4;
const PARAGRAPH_GAP_AFTER = 10;
const LIST_GAP_AFTER = 12;
const BULLET_INDENT = 16;
const FOOTER_SIZE = 8;

/* ── Template resolution ── */
function _resolveTheme(templateId) {
  const template = getTemplate(templateId) || getDefaultTemplate();
  return {
    colors: {
      accent: _hexToRgb(template.colors.accent),
      ink: _hexToRgb(template.colors.ink),
      muted: _hexToRgb(template.colors.muted),
      rule: _hexToRgb(template.colors.rule),
    },
    family: getPdfFontFamily(template.id),
  };
}

function _hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16) / 255;
  const g = parseInt(clean.slice(2, 4), 16) / 255;
  const b = parseInt(clean.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/* ── WinAnsi-safe text sanitizing ── */
const WIN_ANSI_MAP = {
  0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94,
  0x2013: 0x96, 0x2014: 0x97, 0x2022: 0x95, 0x2026: 0x85,
  0x00a0: 0x20, 0x2039: 0x8b, 0x203a: 0x9b,
  // AI-generated text ("thirty-four", "step-by-step") frequently uses
  // Unicode hyphen/dash/minus variants instead of the plain ASCII
  // hyphen-minus (0x2D, already < 0x80 and passed through untouched).
  // None of these have a WinAnsi/cp1252 code point, so without an
  // explicit mapping they fell through to the '?' fallback below —
  // this is the "hyphen turns into a question mark in the PDF" bug.
  // Mapping them to a plain ASCII hyphen keeps the text correct and
  // renders identically to what a reader expects.
  0x2010: 0x2d, // hyphen
  0x2011: 0x2d, // non-breaking hyphen
  0x2012: 0x2d, // figure dash
  0x2015: 0x97, // horizontal bar -> em dash glyph
  0x2212: 0x2d, // minus sign
};

function _sanitizeForWinAnsi(str) {
  let out = '';
  for (const ch of String(str == null ? '' : str)) {
    const code = ch.codePointAt(0);
    if (code < 0x80) { out += ch; continue; }
    if (WIN_ANSI_MAP[code] !== undefined) { out += String.fromCharCode(WIN_ANSI_MAP[code]); continue; }
    if (code <= 0xff) { out += ch; continue; } // already a single WinAnsi-compatible byte
    out += '?'; // unsupported glyph — safe single-byte fallback rather than corrupting the stream
  }
  return out.replace(/[\r\n\t]/g, ' ');
}

function _escapePdfText(str) {
  return _sanitizeForWinAnsi(str)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

// Content streams must be exactly one byte per character once sanitized
// (never UTF-8 multi-byte) — TextEncoder would double-encode anything
// above 0x7F and corrupt both the string data and the /Length byte count.
function _latin1Bytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
}

function _base64ToBytesLocal(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Minimal baseline-JPEG dimension reader — walks marker segments looking
// for a Start Of Frame (SOFn) segment, which always carries the pixel
// height/width regardless of which SOF variant it is. A PDF Image XObject
// MUST declare /Width and /Height explicitly, and Workers AI only hands
// back raw JPEG bytes (no metadata sidecar), so this is the only way to
// get real dimensions without pulling in an image-parsing library (which
// Workers can't load anyway).
function _jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null; // not a JPEG (missing SOI)
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) { i++; continue; }
    const marker = bytes[i + 1];
    // Markers with no payload length to skip.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) break; // EOI
    const segmentLength = (bytes[i + 2] << 8) | bytes[i + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      return { width, height };
    }
    i += 2 + segmentLength;
  }
  return null;
}

/* ── Text measurement (approximate — no real font metrics without
   embedding a font, but close enough that lines don't visibly overflow
   the margin in practice). Width factor comes from the resolved template
   family, since Times/Courier/Helvetica have meaningfully different
   average glyph widths. ── */
function _avgCharWidth(size, bold, family) {
  return size * (bold ? family.boldWidthFactor : family.widthFactor);
}

function _wrapToWidth(text, widthPts, size, bold, family) {
  const maxChars = Math.max(4, Math.floor(widthPts / _avgCharWidth(size, bold, family)));
  const words = String(text == null ? '' : text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/* ── Layout engine: turns { title, sections } into pages of absolute-
   positioned draw operations, breaking pages by accumulated height
   rather than a fixed line count. Takes a resolved theme (colors +
   font family) so every block is drawn in the chosen template. ── */

function _newLayoutState() {
  return { pages: [[]], cursorY: CONTENT_TOP, page: 0, images: [] };
}

function _ensureSpace(state, height) {
  if (state.cursorY - height < CONTENT_BOTTOM) {
    state.page += 1;
    state.pages.push([]);
    state.cursorY = CONTENT_TOP;
  }
}

function _pushOp(state, op) {
  state.pages[state.page].push(op);
}

function _drawTextLine(state, text, { x, size, bold, color }) {
  _pushOp(state, { cmd: 'text', x, y: state.cursorY, size, bold, color, text });
}

function _drawRect(state, { x, y, w, h, color }) {
  _pushOp(state, { cmd: 'rect', x, y, w, h, color });
}

// Registers an image (raw JPEG bytes) with the layout state's shared
// image list (deduped by the base64 source so the same illustration used
// twice, however unlikely, is only embedded once) and returns its PDF
// XObject resource name. Draws it as a positioned block at the current
// cursor, top-anchored like every other block in this layout engine.
function _layoutImage(state, imageBase64, theme, maxWidth, maxHeight) {
  if (!imageBase64) return;

  let bytes, dims;
  try {
    bytes = _base64ToBytesLocal(imageBase64);
    dims = _jpegDimensions(bytes);
  } catch (e) {
    return; // corrupt/undecodable image data — skip it, don't fail the export
  }
  if (!dims || !dims.width || !dims.height) return;

  let existingIndex = state.images.findIndex((img) => img.base64 === imageBase64);
  if (existingIndex === -1) {
    existingIndex = state.images.length;
    state.images.push({ base64: imageBase64, bytes, width: dims.width, height: dims.height });
  }

  const aspect = dims.width / dims.height;
  let drawW = maxWidth;
  let drawH = drawW / aspect;
  if (drawH > maxHeight) {
    drawH = maxHeight;
    drawW = drawH * aspect;
  }

  _ensureSpace(state, drawH + 10);
  state.cursorY -= drawH;
  _pushOp(state, {
    cmd: 'image',
    x: MARGIN_X,
    y: state.cursorY,
    w: drawW,
    h: drawH,
    name: 'Im' + existingIndex,
  });
  state.cursorY -= 10;
}

function _layoutTitle(state, title, theme) {
  const lines = _wrapToWidth(title, CONTENT_WIDTH, TITLE_SIZE, true, theme.family).slice(0, 3);
  lines.forEach((line) => {
    _ensureSpace(state, TITLE_LINE_HEIGHT);
    state.cursorY -= (TITLE_LINE_HEIGHT - 4);
    _drawTextLine(state, line, { x: MARGIN_X, size: TITLE_SIZE, bold: true, color: theme.colors.ink });
    state.cursorY -= 4;
  });
  // Accent underline beneath the title block.
  _ensureSpace(state, 18);
  state.cursorY -= 6;
  _drawRect(state, { x: MARGIN_X, y: state.cursorY - 2, w: 54, h: 2.5, color: theme.colors.accent });
  state.cursorY -= 22;
}

function _layoutHeading(state, text, theme) {
  const lines = _wrapToWidth(text, CONTENT_WIDTH, HEADING_SIZE, true, theme.family);
  _ensureSpace(state, HEADING_SPACE_BEFORE + lines.length * HEADING_LINE_HEIGHT);
  state.cursorY -= HEADING_SPACE_BEFORE;
  lines.forEach((line) => {
    state.cursorY -= (HEADING_LINE_HEIGHT - 4);
    _drawTextLine(state, line, { x: MARGIN_X, size: HEADING_SIZE, bold: true, color: theme.colors.accent });
    state.cursorY -= 4;
  });
  state.cursorY -= HEADING_SPACE_AFTER;
}

function _layoutParagraph(state, text, theme) {
  if (!text || !String(text).trim()) return;
  const lines = _wrapToWidth(text, CONTENT_WIDTH, BODY_SIZE, false, theme.family);
  lines.forEach((line) => {
    _ensureSpace(state, BODY_LINE_HEIGHT);
    state.cursorY -= (BODY_LINE_HEIGHT - 4);
    _drawTextLine(state, line, { x: MARGIN_X, size: BODY_SIZE, bold: false, color: theme.colors.ink });
    state.cursorY -= 4;
  });
  state.cursorY -= PARAGRAPH_GAP_AFTER;
}

function _layoutBullets(state, items, theme) {
  const textWidth = CONTENT_WIDTH - BULLET_INDENT;
  (items || []).forEach((item) => {
    const lines = _wrapToWidth(item, textWidth, BULLET_SIZE, false, theme.family);
    lines.forEach((line, i) => {
      _ensureSpace(state, BULLET_LINE_HEIGHT);
      state.cursorY -= (BULLET_LINE_HEIGHT - 3.5);
      if (i === 0) {
        _drawTextLine(state, '\u2022', { x: MARGIN_X + 2, size: BULLET_SIZE, bold: false, color: theme.colors.accent });
      }
      _drawTextLine(state, line, { x: MARGIN_X + BULLET_INDENT, size: BULLET_SIZE, bold: false, color: theme.colors.ink });
      state.cursorY -= 3.5;
    });
    state.cursorY -= BULLET_ITEM_GAP;
  });
  state.cursorY -= (LIST_GAP_AFTER - BULLET_ITEM_GAP);
}

function _layoutStructured(structured, title, theme) {
  const state = _newLayoutState();
  _layoutTitle(state, title || structured.title || '', theme);

  (structured.sections || []).forEach((s) => {
    if (s.heading) _layoutHeading(state, s.heading, theme);
    if (s.type === 'bullets') {
      _layoutBullets(state, s.content, theme);
    } else if (s.content && String(s.content).trim()) {
      _layoutParagraph(state, s.content, theme);
    }
  });

  return state;
}

const CARD_IMAGE_MAX_WIDTH = 220;
const CARD_IMAGE_MAX_HEIGHT = 165;
const CARD_RULE_GAP = 16;

// Dedicated flashcards layout — unlike the generic {title, sections}
// path, each card is a self-contained block: an optional illustration
// (see resources-endpoint.js#_attachCardImages, which attaches a real
// Workers-AI-generated image per card when the user asked for images and
// their plan allows it), the question, and the answer, with a light rule
// separating cards. Falls back gracefully to a text-only card when a
// card has no `image` field, so decks generated before this feature (or
// on the free plan) still export identically to before.
function _layoutFlashcards(structured, title, theme) {
  const state = _newLayoutState();
  _layoutTitle(state, title || structured.title || 'Flashcards', theme);

  const cards = Array.isArray(structured.cards) ? structured.cards : [];
  cards.forEach((card, index) => {
    const label = 'Card ' + (card.number || index + 1) +
      (card.difficulty ? '  \u2014  ' + String(card.difficulty).toUpperCase() : '');
    _layoutHeading(state, label, theme);

    if (card.image && card.image.data) {
      _layoutImage(state, card.image.data, theme, CARD_IMAGE_MAX_WIDTH, CARD_IMAGE_MAX_HEIGHT);
    }

    if (card.front) _layoutParagraph(state, 'Q: ' + card.front, theme);
    if (card.back) _layoutParagraph(state, 'A: ' + card.back, theme);

    // Separator rule between cards (skip after the last one).
    if (index < cards.length - 1) {
      _ensureSpace(state, CARD_RULE_GAP);
      state.cursorY -= 4;
      _drawRect(state, { x: MARGIN_X, y: state.cursorY, w: CONTENT_WIDTH, h: 0.75, color: theme.colors.rule });
      state.cursorY -= (CARD_RULE_GAP - 4);
    }
  });

  return state;
}

/* ── Page content stream + PDF object assembly ── */

function _colorOp(color) {
  return color[0] + ' ' + color[1] + ' ' + color[2] + ' rg';
}

function _buildContentStream(ops, pageIndex, pageCount, theme) {
  let stream = '';
  ops.forEach((op) => {
    if (op.cmd === 'rect') {
      stream += _colorOp(op.color) + '\n';
      stream += op.x.toFixed(2) + ' ' + op.y.toFixed(2) + ' ' + op.w.toFixed(2) + ' ' + op.h.toFixed(2) + ' re\nf\n';
    } else if (op.cmd === 'image') {
      // Place the image XObject: scale the unit square to (w, h) and
      // translate to (x, y), same convention PDF uses for every image.
      stream += 'q\n' + op.w.toFixed(2) + ' 0 0 ' + op.h.toFixed(2) + ' ' + op.x.toFixed(2) + ' ' + op.y.toFixed(2) + ' cm\n' +
        '/' + op.name + ' Do\nQ\n';
    } else {
      const font = op.bold ? '/F2' : '/F1';
      stream += 'BT\n' + _colorOp(op.color) + '\n' + font + ' ' + op.size + ' Tf\n' +
        op.x.toFixed(2) + ' ' + op.y.toFixed(2) + ' Td\n' +
        '(' + _escapePdfText(op.text) + ') Tj\nET\n';
    }
  });

  // Footer: light rule + centered page number, same on every page.
  const footerY = MARGIN_BOTTOM - 18;
  stream += _colorOp(theme.colors.rule) + '\n';
  stream += MARGIN_X.toFixed(2) + ' ' + (footerY + 14).toFixed(2) + ' ' + CONTENT_WIDTH.toFixed(2) + ' 0.75 re\nf\n';
  const footerText = 'Page ' + (pageIndex + 1) + ' of ' + pageCount;
  const footerX = PAGE_WIDTH / 2 - footerText.length * FOOTER_SIZE * 0.24;
  stream += 'BT\n' + _colorOp(theme.colors.muted) + '\n/F1 ' + FOOTER_SIZE + ' Tf\n' +
    footerX.toFixed(2) + ' ' + footerY.toFixed(2) + ' Td\n' +
    '(' + _escapePdfText(footerText) + ') Tj\nET\n';

  return stream;
}

function _assemblePdf(pages, theme, images, asBytes) {
  images = images || [];
  const pageCount = pages.length;
  // Object numbering: 1 = Catalog, 2 = Pages, 3 = Font regular, 4 = Font
  // bold, 5..(4+imageCount) = one Image XObject per embedded image, then
  // content stream / page object pairs for each page.
  const imageObjectIds = images.map((_, i) => 5 + i);
  const pageStart = 5 + images.length;
  const pageObjectIds = pages.map((_, i) => pageStart + 1 + 2 * i);
  const contentObjectIds = pages.map((_, i) => pageStart + 2 * i);
  const maxId = pageStart + 2 * (pageCount - 1) + 1;

  const objects = new Map();
  objects.set(1, { body: '<< /Type /Catalog /Pages 2 0 R >>' });
  const kids = pageObjectIds.map((id) => id + ' 0 R').join(' ');
  objects.set(2, { body: '<< /Type /Pages /Kids [ ' + kids + ' ] /Count ' + pageCount + ' >>' });
  objects.set(3, { body: '<< /Type /Font /Subtype /Type1 /BaseFont /' + theme.family.regular + ' /Encoding /WinAnsiEncoding >>' });
  objects.set(4, { body: '<< /Type /Font /Subtype /Type1 /BaseFont /' + theme.family.bold + ' /Encoding /WinAnsiEncoding >>' });

  images.forEach((img, i) => {
    objects.set(imageObjectIds[i], {
      raw: true,
      bytes: img.bytes,
      dict: '<< /Type /XObject /Subtype /Image /Width ' + img.width + ' /Height ' + img.height +
        ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + img.bytes.length + ' >>',
    });
  });

  // Every page's Resources dict lists every embedded image (by its
  // fixed /ImN name — see _layoutImage), whether or not that particular
  // page uses it. An unused /XObject entry is legal PDF and far simpler
  // than tracking per-page usage; viewers don't care.
  const xObjectDict = images.length
    ? ' /XObject << ' + images.map((_, i) => '/Im' + i + ' ' + imageObjectIds[i] + ' 0 R').join(' ') + ' >>'
    : '';

  pages.forEach((ops, i) => {
    const stream = _buildContentStream(ops, i, pageCount, theme);
    objects.set(contentObjectIds[i], { raw: true, bytes: _latin1Bytes(stream) });
    objects.set(pageObjectIds[i], {
      body: '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>' + xObjectDict + ' >> ' +
        '/MediaBox [0 0 ' + PAGE_WIDTH + ' ' + PAGE_HEIGHT + '] /Contents ' + contentObjectIds[i] + ' 0 R >>',
    });
  });

  // Serialize sequentially as a byte array (not a JS string built with
  // TextEncoder) so byte offsets stay exact even though content streams
  // may include WinAnsi bytes above 0x7F.
  const chunks = [];
  let length = 0;
  function push(strOrBytes) {
    const bytes = typeof strOrBytes === 'string' ? _latin1Bytes(strOrBytes) : strOrBytes;
    chunks.push(bytes);
    length += bytes.length;
    return length;
  }

  push('%PDF-1.4\n');
  const offsets = new Map();

  for (let id = 1; id <= maxId; id++) {
    if (!objects.has(id)) continue;
    offsets.set(id, length);
    const obj = objects.get(id);
    push(id + ' 0 obj\n');
    if (obj.raw) {
      const dict = obj.dict || ('<< /Length ' + obj.bytes.length + ' >>');
      push(dict + '\nstream\n');
      push(obj.bytes);
      push('\nendstream\nendobj\n');
    } else {
      push(obj.body + '\nendobj\n');
    }
  }

  const xrefOffset = length;
  const sortedIds = [...offsets.keys()].sort((a, b) => a - b);
  const highestId = sortedIds[sortedIds.length - 1];

  let xref = 'xref\n0 ' + (highestId + 1) + '\n0000000000 65535 f \n';
  for (let id = 1; id <= highestId; id++) {
    const offset = offsets.get(id);
    xref += offset === undefined
      ? '0000000000 00000 f \n'
      : String(offset).padStart(10, '0') + ' 00000 n \n';
  }
  push(xref);
  push('trailer\n<< /Size ' + (highestId + 1) + ' /Root 1 0 R >>\n');
  push('startxref\n' + xrefOffset + '\n%%EOF');

  const total = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) { total.set(c, offset); offset += c.length; }

  if (asBytes) return total;
  return _bytesToBase64Fast(total);
}

// Converts bytes to base64 in big chunks. The old one-character-at-a-time
// loop was extremely slow for PDFs that contain pictures (a single
// picture cost ~45 ms of CPU; this costs ~7 ms).
function _bytesToBase64Fast(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Builds a designed .pdf from the structured { title, sections } shape —
 * headings, paragraphs, and bullet lists as real, positioned blocks —
 * in the given design template's palette and font family.
 *
 * @param {{title: string, sections: Array<{heading: string, type: 'paragraph'|'bullets', content: string|string[]}>}} structured
 * @param {string} title
 * @param {string} [templateId] - a design-templates.js id; defaults to
 *   'classic' if omitted or unrecognized. Callers are responsible for
 *   entitlement-checking the id before passing it in — this function
 *   trusts whatever it's given and just falls back safely if it's bad.
 */
export async function buildStructuredPdf(structured, title, templateId) {
  const theme = _resolveTheme(templateId);
  const state = _layoutStructured(structured, title, theme);
  return _assemblePdf(state.pages, theme, state.images);
}

/**
 * Builds a designed .pdf from plain text content and a title — used as a
 * fallback path when structured content isn't available. Internally this
 * is just a structured document with one untitled paragraph section per
 * input paragraph, so it goes through the same layout engine and the
 * same design template as buildStructuredPdf.
 *
 * @param {string} content - plain text, paragraphs separated by blank lines
 * @param {string} title
 * @param {string} [templateId]
 */
export async function buildSimplePdf(content, title, templateId) {
  const paragraphs = String(content || '').split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  const structured = {
    title,
    sections: paragraphs.map((p) => ({ heading: '', type: 'paragraph', content: p })),
  };
  const theme = _resolveTheme(templateId);
  const state = _layoutStructured(structured, title, theme);
  return _assemblePdf(state.pages, theme, state.images);
}

/**
 * Builds a designed .pdf specifically for a flashcards deck: one block
 * per card (heading, optional real illustration, question, answer),
 * instead of flattening cards into generic paragraphs. Images come from
 * `card.image.data` (base64 JPEG) — see resources-endpoint.js's
 * `_attachCardImages`, which only ever populates that field for
 * entitled, quota-checked plans. Cards without an image (free plan, or
 * `includeImages` wasn't requested) render as plain text blocks exactly
 * like before this feature existed.
 *
 * @param {{title: string, cards: Array<{number:number, front:string, back:string, difficulty:string, image?: {type:string, data:string}}>}} structuredContent
 * @param {string} title
 * @param {string} [templateId]
 */
export async function buildFlashcardsPdf(structuredContent, title, templateId) {
  const theme = _resolveTheme(templateId);
  const state = _layoutFlashcards(structuredContent, title, theme);
  return _assemblePdf(state.pages, theme, state.images);
}

// Same as buildFlashcardsPdf, but returns the raw PDF bytes instead of a
// base64 string. Lets the caller upload straight to storage without the
// costly encode-then-decode round trip.
export async function buildFlashcardsPdfBytes(structuredContent, title, templateId) {
  const theme = _resolveTheme(templateId);
  const state = _layoutFlashcards(structuredContent, title, theme);
  return _assemblePdf(state.pages, theme, state.images, true);
}

// Same as buildStructuredPdf, but returns raw PDF bytes instead of a
// base64 string — used by insights-digest.js so the Insights Digest PDF
// can go straight to b2UploadFile without an encode-then-decode round
// trip, exactly the same reasoning as buildFlashcardsPdfBytes above.
export async function buildStructuredPdfBytes(structured, title, templateId) {
  const theme = _resolveTheme(templateId);
  const state = _layoutStructured(structured, title, theme);
  return _assemblePdf(state.pages, theme, state.images, true);
}
