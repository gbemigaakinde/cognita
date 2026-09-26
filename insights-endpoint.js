// insights-endpoint.js
// HTTP handlers for the AI Insights Digest feature. Thin, like
// social-scheduler-endpoint.js — real logic lives in insights-digest.js
// and meta-tools.js.

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccountWithRole } from './subscription.js';
import { planHasInsightsDigest } from './entitlements.js';
import { checkAndIncrement } from './usage.js';
import { fsGet, fsSet } from './firestore-rest.js';
import { listPages } from './meta-tools.js';
import { verifyDownloadToken } from './download-proxy.js';
import { b2DownloadFileBytes } from './b2-client.js';
import {
  generateDigest,
  listDigests,
  buildInsightsFileUrl,
  buildWhatsAppShareUrl,
} from './insights-digest.js';

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

async function _requireEntitledIdentity(request, env) {
  const identity = await requireAuth(request, env);
  const account = await resolveAccountWithRole(identity.uid, env);
  if (!planHasInsightsDigest(account.planId)) {
    const e = new Error('The AI Insights Digest requires Cognita Plus or higher.');
    e.isForbidden = true;
    throw e;
  }
  return { identity, account };
}

async function _authOrError(request, env) {
  try {
    return await _requireEntitledIdentity(request, env);
  } catch (e) {
    if (e.isForbidden) throw { response: _jsonError(e.message, 403, env) };
    const authErr = describeAuthError(e);
    throw { response: _jsonError(authErr.message, authErr.status, env) };
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** GET /api/insights/schedule */
export async function handleInsightsScheduleGet(request, env) {
  let identity;
  try {
    ({ identity } = await _authOrError(request, env));
  } catch (wrapped) {
    return wrapped.response;
  }

  try {
    const schedule = await fsGet('insightsSchedules/' + identity.uid, env);
    return new Response(JSON.stringify({
      schedule: schedule || {
        uid: identity.uid, enabled: false, frequency: 'weekly', pageIds: [],
        deliverEmail: true, deliverInApp: true, emailAddress: null, lastSentAt: null,
      },
    }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[insights] schedule get failed:', e.message);
    return _jsonError('Could not load your delivery preferences.', 500, env);
  }
}

/** PUT /api/insights/schedule */
export async function handleInsightsScheduleUpsert(request, env) {
  let identity;
  try {
    ({ identity } = await _authOrError(request, env));
  } catch (wrapped) {
    return wrapped.response;
  }

  let input;
  try {
    input = await request.json();
  } catch (e) {
    return _jsonError('Invalid request body.', 400, env);
  }

  if (!['weekly', 'monthly'].includes(input.frequency)) {
    return _jsonError('frequency must be "weekly" or "monthly".', 400, env);
  }
  if (input.emailAddress && !EMAIL_RE.test(input.emailAddress)) {
    return _jsonError('That email address does not look valid.', 400, env);
  }

  // Re-validate pageIds server-side against the user's real connected
  // Pages — never trust the client's list, same defense-in-depth as
  // social-scheduler.js's _validateScheduleInput.
  let ownedPageIds = [];
  try {
    const pages = await listPages(identity.uid, env);
    const ownedIds = new Set(pages.map((p) => p.id));
    ownedPageIds = (Array.isArray(input.pageIds) ? input.pageIds : []).filter((id) => ownedIds.has(id));
  } catch (e) {
    if (e.message === 'NOT_CONNECTED') return _jsonError('Connect Facebook in Account Settings > Connections first.', 409, env);
    if (e.message === 'NEEDS_RECONNECT') return _jsonError('Your Facebook connection needs to be reconnected.', 409, env);
    console.error('[insights] page validation failed:', e.message);
    return _jsonError('Could not verify your connected Pages.', 500, env);
  }

  const now = new Date().toISOString();
  const record = {
    uid: identity.uid,
    enabled: !!input.enabled,
    frequency: input.frequency,
    pageIds: ownedPageIds,
    deliverEmail: !!input.deliverEmail,
    deliverInApp: true,
    emailAddress: input.emailAddress || null,
    lastSentAt: null,
    updatedAt: now,
    createdAt: now,
  };

  try {
    const existing = await fsGet('insightsSchedules/' + identity.uid, env).catch(() => null);
    if (existing) {
      record.lastSentAt = existing.lastSentAt || null;
      record.createdAt = existing.createdAt || now;
    }
    await fsSet('insightsSchedules/' + identity.uid, record, env);
    return new Response(JSON.stringify({ schedule: record }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[insights] schedule upsert failed:', e.message);
    return _jsonError('Could not save your delivery preferences.', 500, env);
  }
}

/** POST /api/insights/generate — body { pageIds, deliverEmail?, emailAddress? } */
export async function handleInsightsGenerate(request, env) {
  let identity, account;
  try {
    ({ identity, account } = await _authOrError(request, env));
  } catch (wrapped) {
    return wrapped.response;
  }

  let input;
  try {
    input = await request.json();
  } catch (e) {
    input = {};
  }

  if (!Array.isArray(input.pageIds) || input.pageIds.length === 0) {
    return _jsonError('Select at least one connected Page.', 400, env);
  }

  const quota = await checkAndIncrement(identity.uid, 'insightsDigestGenerate', account.limits.insightsDigestPerDay, env);
  if (!quota.allowed) {
    return _jsonError('Daily Insights Digest limit reached for your plan.', 429, env);
  }

  try {
    const digest = await generateDigest(env, identity.uid, {
      pageIds: input.pageIds,
      deliverEmail: input.deliverEmail,
      emailAddress: input.emailAddress,
    });
    const pdfUrl = await buildInsightsFileUrl(env, digest.pdfKey);
    const whatsappShareUrl = buildWhatsAppShareUrl(digest.summary ? 'Performance Digest' : 'Digest', pdfUrl);
    return new Response(JSON.stringify({ digest, pdfUrl, whatsappShareUrl }), { status: 201, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[insights] generate failed:', e.message);
    return _jsonError('Could not generate your digest. Please try again.', 500, env);
  }
}

/** GET /api/insights/history */
export async function handleInsightsHistory(request, env) {
  let identity;
  try {
    ({ identity } = await _authOrError(request, env));
  } catch (wrapped) {
    return wrapped.response;
  }

  try {
    const digests = await listDigests(env, identity.uid);
    const withUrls = await Promise.all(digests.map(async (d) => {
      if (d.status !== 'ready' || !d.pdfKey) return { ...d, pdfUrl: null, whatsappShareUrl: null };
      const pdfUrl = await buildInsightsFileUrl(env, d.pdfKey);
      return { ...d, pdfUrl, whatsappShareUrl: buildWhatsAppShareUrl('Performance Digest', pdfUrl) };
    }));
    return new Response(JSON.stringify({ digests: withUrls }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[insights] history failed:', e.message);
    return _jsonError('Could not load your digest history.', 500, env);
  }
}

/**
 * GET /api/insights/file?token=...
 * Signed-URL proxy — no Authorization header possible (email link
 * clicks, WhatsApp preview fetches), same pattern as
 * handleSocialMediaProxy in social-media-endpoint.js.
 */
export async function handleInsightsFileProxy(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  let payload;
  try {
    payload = await verifyDownloadToken(env, token);
  } catch (e) {
    return _jsonError('This link is invalid or has expired.', 401, env);
  }
  if (payload.scope !== 'insights-pdf' || !payload.key || !payload.key.startsWith('insights/')) {
    return _jsonError('This link is invalid.', 401, env);
  }

  let fileRes;
  try {
    fileRes = await b2DownloadFileBytes(env, payload.key);
  } catch (e) {
    console.error('[insights] file proxy fetch failed:', e.message);
    return _jsonError('Could not load that file.', 502, env);
  }
  if (!fileRes) return _jsonError('That file is no longer available.', 404, env);

  return new Response(fileRes.body, {
    status: 200,
    headers: {
      'Content-Type': payload.contentType || 'application/pdf',
      'Cache-Control': 'private, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
