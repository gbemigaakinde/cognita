// social-scheduler-endpoint.js
// HTTP handlers for the Social Scheduler feature. Thin, like
// connectors-endpoint.js — real logic lives in social-scheduler.js
// (storage/scheduling) and meta-tools.js (Graph API calls).

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccountWithRole } from './subscription.js';
import { planHasSocialScheduling } from './entitlements.js';
import { listPages } from './meta-tools.js';
import {
  createScheduledPost,
  listScheduledPosts,
  cancelScheduledPost,
} from './social-scheduler.js';

// Re-exported so worker.js can import every Social Scheduler route (media
// included) from this one endpoint module, the same way it already does
// for pages/schedule/cancel — social-media-endpoint.js stays a plain
// implementation module, not something worker.js reaches into directly.
export { handleSocialMediaUpload, handleSocialMediaProxy } from './social-media-endpoint.js';

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

async function _requireEntitledIdentity(request, env) {
  const identity = await requireAuth(request, env); // throws — caller catches via describeAuthError
  const account = await resolveAccountWithRole(identity.uid, env);
  if (!planHasSocialScheduling(account.planId)) {
    const e = new Error('The Social Scheduler requires Cognita Plus or higher.');
    e.isForbidden = true;
    throw e;
  }
  return identity;
}

/**
 * GET /api/social/pages
 * Lists the user's connected Facebook Pages (and each one's linked
 * Instagram account, if any) — populates the picker in the scheduler UI.
 * Returns a friendly NOT_CONNECTED-shaped error rather than a raw 500 if
 * Facebook isn't connected yet, since that's the single most likely
 * reason this call fails for a first-time visitor to the page.
 */
export async function handleSocialPagesList(request, env) {
  let identity;
  try {
    identity = await _requireEntitledIdentity(request, env);
  } catch (e) {
    if (e.isForbidden) return _jsonError(e.message, 403, env);
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  try {
    const pages = await listPages(identity.uid, env);
    return new Response(JSON.stringify({ pages }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    if (e.message === 'NOT_CONNECTED') {
      return _jsonError('Connect Facebook in Account Settings > Connections first.', 409, env);
    }
    if (e.message === 'NEEDS_RECONNECT') {
      return _jsonError('Your Facebook connection needs to be reconnected in Account Settings > Connections.', 409, env);
    }
    console.error('[social-scheduler] pages list failed:', e.message);
    return _jsonError('Could not load your Facebook Pages. Please try again.', 500, env);
  }
}

/**
 * POST /api/social/schedule
 * Body: { target: 'facebook'|'instagram', pageId, message, imageUrl?,
 *         link?, scheduledFor (ISO string) }
 */
export async function handleScheduleCreate(request, env) {
  let identity;
  try {
    identity = await _requireEntitledIdentity(request, env);
  } catch (e) {
    if (e.isForbidden) return _jsonError(e.message, 403, env);
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  let input;
  try {
    input = await request.json();
  } catch (e) {
    return _jsonError('Invalid request body.', 400, env);
  }

  // Confirm the Page (and, for Instagram, its linked account) is real and
  // still connected before ever writing a scheduled post for it — this
  // is also where the human-readable label stored on the post comes from.
  let page;
  try {
    const pages = await listPages(identity.uid, env);
    page = pages.find((p) => p.id === input.pageId);
  } catch (e) {
    if (e.message === 'NOT_CONNECTED') return _jsonError('Connect Facebook in Account Settings > Connections first.', 409, env);
    if (e.message === 'NEEDS_RECONNECT') return _jsonError('Your Facebook connection needs to be reconnected in Account Settings > Connections.', 409, env);
    console.error('[social-scheduler] page lookup failed:', e.message);
    return _jsonError('Could not verify that Page. Please try again.', 500, env);
  }
  if (!page) return _jsonError('That Facebook Page is not connected.', 404, env);
  if (input.target === 'instagram' && !page.instagram) {
    return _jsonError('That Page has no linked Instagram professional account.', 400, env);
  }

  const pageLabel = input.target === 'instagram' && page.instagram
    ? page.name + ' (Instagram: @' + (page.instagram.username || page.instagram.id) + ')'
    : page.name;

  try {
    const post = await createScheduledPost(env, identity.uid, input, pageLabel);
    return new Response(JSON.stringify({ post }), { status: 201, headers: _corsJsonHeaders(env) });
  } catch (e) {
    const status = e.isLimit ? 429 : 400;
    return _jsonError(e.message, status, env);
  }
}

/** GET /api/social/schedule — lists the caller's scheduled posts, soonest first. */
export async function handleScheduleList(request, env) {
  let identity;
  try {
    identity = await _requireEntitledIdentity(request, env);
  } catch (e) {
    if (e.isForbidden) return _jsonError(e.message, 403, env);
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  try {
    const posts = await listScheduledPosts(env, identity.uid);
    return new Response(JSON.stringify({ posts }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[social-scheduler] list failed:', e.message);
    return _jsonError('Could not load your scheduled posts.', 500, env);
  }
}

/** DELETE /api/social/schedule/:id — cancels a pending post. */
export async function handleScheduleCancel(request, env, postId) {
  let identity;
  try {
    identity = await _requireEntitledIdentity(request, env);
  } catch (e) {
    if (e.isForbidden) return _jsonError(e.message, 403, env);
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  try {
    await cancelScheduledPost(env, identity.uid, postId);
    return new Response(JSON.stringify({ canceled: postId }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    if (e.isNotFound) return _jsonError('Scheduled post not found.', 404, env);
    if (e.isConflict) return _jsonError(e.message, 409, env);
    console.error('[social-scheduler] cancel failed:', e.message);
    return _jsonError('Could not cancel that post. Please try again.', 500, env);
  }
}
