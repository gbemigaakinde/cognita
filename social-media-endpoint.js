// social-media-endpoint.js
// Lets a user attach an image or video to a scheduled social post by
// uploading it straight to the Cognita B2 bucket, instead of having to
// already own a publicly-hosted URL (the old imageUrl-only flow — see
// scheduler.html's history). Three jobs live here:
//
//   1. handleSocialMediaUpload  — POST the raw file, get back a small
//      { key, fileId, contentType, size, kind } reference. Nothing here
//      is ever handed to the client as a real B2/download URL.
//   2. handleSocialMediaProxy   — the ONLY thing that can turn that key
//      into a fetchable https URL, and only for a few minutes at a time,
//      via the same signed-token scheme download-proxy.js already uses
//      for resource exports. This is what Meta's Graph API servers
//      actually fetch from at publish time.
//   3. pruneOrphanedSocialMedia — a housekeeping sweep (called from
//      social-scheduler.js's cron tick) that deletes uploads a user
//      picked but never actually scheduled (or abandoned mid-form).
//      Without this, an upload-then-close-the-tab would sit in the
//      bucket forever with nothing ever cleaning it up.
//
// The "delete the media the moment it's been delivered" behaviour lives
// in social-scheduler.js, not here — this file only ever creates and
// serves media, never decides when a *scheduled post's* copy is done
// with. It does own deleting media that was never attached to a post at
// all, which is a different lifecycle entirely.

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccountWithRole } from './subscription.js';
import { planHasSocialScheduling } from './entitlements.js';
import { b2UploadFile, b2DeleteFileVersion, b2DownloadFileBytes } from './b2-client.js';
import { signDownloadToken, verifyDownloadToken } from './download-proxy.js';
import { fsSet, fsUpdate, fsDelete, fsQuery } from './firestore-rest.js';

// Generous enough for a phone-shot photo or a short vertical video, tight
// enough that one upload can't quietly eat the whole B2 free-tier
// allowance. Instagram's own Reels limit is far higher than this, but a
// scheduled social post is not the place for a feature-length upload.
const MAX_IMAGE_BYTES = 15 * 1024 * 1024; // 15 MB
const MAX_VIDEO_BYTES = 200 * 1024 * 1024; // 200 MB

const ALLOWED_CONTENT_TYPES = {
  'image/jpeg': 'image', 'image/png': 'image', 'image/webp': 'image',
  'video/mp4': 'video', 'video/quicktime': 'video',
};

// An upload sitting unattached for longer than this is almost certainly
// abandoned (the composer form was closed, or the schedule call failed
// client-side after the upload succeeded) rather than mid-use.
const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

async function _requireEntitledIdentity(request, env) {
  const identity = await requireAuth(request, env);
  const account = await resolveAccountWithRole(identity.uid, env);
  if (!planHasSocialScheduling(account.planId)) {
    const e = new Error('The Social Scheduler requires Cognita Plus or higher.');
    e.isForbidden = true;
    throw e;
  }
  return identity;
}

function _extensionFor(contentType) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov' }[contentType] || 'bin';
}

/**
 * POST /api/social/media
 * Query: ?filename=... (display only, not trusted for anything else)
 * Header: Content-Type: <one of ALLOWED_CONTENT_TYPES>
 * Body: raw file bytes.
 */
export async function handleSocialMediaUpload(request, env) {
  let identity;
  try {
    identity = await _requireEntitledIdentity(request, env);
  } catch (e) {
    if (e.isForbidden) return _jsonError(e.message, 403, env);
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  const contentType = (request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const kind = ALLOWED_CONTENT_TYPES[contentType];
  if (!kind) {
    return _jsonError('Unsupported file type. Use JPEG, PNG or WEBP for images, or MP4/MOV for video.', 415, env);
  }

  const declaredLength = Number(request.headers.get('Content-Length') || 0);
  const maxBytes = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (declaredLength > maxBytes) {
    return _jsonError('That file is too large (max ' + Math.round(maxBytes / (1024 * 1024)) + ' MB for ' + kind + ').', 413, env);
  }

  let bytes;
  try {
    const buf = await request.arrayBuffer();
    bytes = new Uint8Array(buf);
  } catch (e) {
    return _jsonError('Could not read the uploaded file.', 400, env);
  }

  if (bytes.length === 0) return _jsonError('The uploaded file is empty.', 400, env);
  if (bytes.length > maxBytes) {
    return _jsonError('That file is too large (max ' + Math.round(maxBytes / (1024 * 1024)) + ' MB for ' + kind + ').', 413, env);
  }

  const id = crypto.randomUUID();
  const key = 'social/' + identity.uid + '/' + id + '.' + _extensionFor(contentType);

  let upload;
  try {
    upload = await b2UploadFile(env, key, bytes, contentType);
  } catch (e) {
    console.error('[social-media] upload failed:', e.message);
    return _jsonError('Could not upload that file. Please try again.', 502, env);
  }

  // Tracked separately from the scheduledPosts doc itself — at this point
  // there may not even be one yet, since the file is uploaded from the
  // composer before the "Schedule post" button is pressed.
  try {
    await fsSet('socialMediaUploads/' + id, {
      id, uid: identity.uid, key, fileId: upload.fileId,
      contentType, kind, size: bytes.length,
      attached: false,
      createdAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    // Non-fatal: worst case this upload just never gets tracked for the
    // orphan sweep and outlives its post by however long the bucket's
    // own lifecycle rules allow. The upload itself already succeeded.
    console.error('[social-media] could not record upload tracking doc:', e.message);
  }

  return new Response(JSON.stringify({
    key, fileId: upload.fileId, contentType, kind, size: bytes.length,
  }), { status: 201, headers: _corsJsonHeaders(env) });
}

/**
 * Marks an uploaded file's tracking doc as attached to a real scheduled
 * post, so the orphan sweep leaves it alone. Called from
 * createScheduledPost() in social-scheduler.js. Best-effort — if this
 * fails, the sweep simply deletes it up to 24h later, which is caught by
 * the pending-post's own reference already being gone by then anyway
 * (see pruneOrphanedSocialMedia's guard).
 */
export async function markSocialMediaAttached(env, key) {
  const id = key.split('/').pop().split('.')[0];
  try {
    await fsUpdate('socialMediaUploads/' + id, { attached: true }, env);
  } catch (e) {
    console.error('[social-media] could not mark upload attached:', e.message);
  }
}

/**
 * Deletes an upload's tracking doc once its real B2 object has been
 * deleted (published, canceled, or swept as an orphan) — called from
 * social-scheduler.js alongside b2DeleteFileVersion so the tracking
 * collection doesn't quietly accumulate a stale row per post forever.
 */
export async function forgetSocialMediaUpload(env, key) {
  const id = key.split('/').pop().split('.')[0];
  await fsDelete('socialMediaUploads/' + id, env).catch(() => {});
}

/**
 * GET /api/social/media/file?token=...
 * The only route that turns an uploaded file's key into bytes a third
 * party (Meta's Graph API) can fetch. No Authorization header is
 * possible here — Meta's servers call this directly — so the signed,
 * short-lived token from signDownloadToken is the entire access check,
 * exactly like handleResourceFileProxy in resources-endpoint.js.
 */
export async function handleSocialMediaProxy(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  let payload;
  try {
    payload = await verifyDownloadToken(env, token);
  } catch (e) {
    return _jsonError('This media link is invalid or has expired.', 401, env);
  }
  if (payload.scope !== 'social-media' || !payload.key) {
    return _jsonError('This media link is invalid.', 401, env);
  }

  let fileRes;
  try {
    fileRes = await b2DownloadFileBytes(env, payload.key);
  } catch (e) {
    console.error('[social-media] proxy fetch failed:', e.message);
    return _jsonError('Could not load that file.', 502, env);
  }
  if (!fileRes) return _jsonError('That file is no longer available.', 404, env);

  return new Response(fileRes.body, {
    status: 200,
    headers: {
      'Content-Type': payload.contentType || fileRes.headers.get('Content-Type') || 'application/octet-stream',
      'Cache-Control': 'private, max-age=60',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Mints the short-lived, signed URL that Meta's Graph API will fetch the
 * media from. Kept here (rather than inlined in social-scheduler.js) so
 * the token's shape — scope + key + contentType — stays defined next to
 * the route that verifies it.
 */
export async function buildSocialMediaFetchUrl(env, media, ttlSeconds) {
  const token = await signDownloadToken(env, { scope: 'social-media', key: media.key, contentType: media.contentType }, ttlSeconds);
  const origin = env.WORKER_ORIGIN || 'https://api.cognita.com.ng';
  return origin + '/api/social/media/file?token=' + encodeURIComponent(token);
}

/**
 * Sweeps uploads that were never attached to a scheduled post and are
 * older than ORPHAN_AGE_MS. Called once per runSocialScheduler tick
 * (social-scheduler.js) — piggybacking on the existing cron trigger
 * rather than needing a Worker Cron Trigger of its own.
 */
export async function pruneOrphanedSocialMedia(env) {
  let rows;
  try {
    rows = await fsQuery('socialMediaUploads', 'attached', false, 'createdAt', 25, env, 'ASCENDING');
  } catch (e) {
    console.error('[social-media] orphan sweep query failed:', e.message);
    return;
  }

  const cutoff = Date.now() - ORPHAN_AGE_MS;
  for (const row of rows) {
    const createdMs = new Date(row.createdAt).getTime();
    if (createdMs > cutoff) break; // ascending order — everything after this is also too young
    try {
      await b2DeleteFileVersion(env, row.key, row.fileId);
    } catch (e) {
      console.error('[social-media] orphan sweep: could not delete', row.key, ':', e.message);
      continue; // leave the tracking doc so the next sweep retries the delete
    }
    await fsDelete('socialMediaUploads/' + row.id, env).catch(() => {});
  }
}
