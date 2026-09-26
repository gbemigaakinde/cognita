// json-extract.js
// Tiny shared helper for parsing strict-JSON responses out of an LLM's
// text output. Models frequently wrap JSON in ```json fences even when
// told not to — this strips that defensively before parsing, the same
// way image-endpoint.js's _extractSvg strips fences before looking for
// <svg>. Used by social-inbox.js (classifyInboxItem) and
// insights-digest.js (generateDigest) so the stripping/parsing logic
// only lives in one place.
//
// Returns the parsed object, or null on any failure — callers are
// expected to fall back to a safe default rather than throw, since a
// bad LLM response should never block the underlying record (an inbox
// item, a digest) from existing in an "unclassified"/"failed" state.

export function extractJson(text) {
  if (!text) return null;
  const clean = String(text).replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(clean.slice(start, end + 1));
  } catch (e) {
    return null;
  }
}
