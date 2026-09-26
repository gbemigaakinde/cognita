// social-inbox-endpoint.js
// HTTP handlers for the AI Inbox feature. Thin, like
// social-scheduler-endpoint.js — real logic lives in social-inbox.js
// (storage/classification/reply) and meta-tools.js (Graph API calls).

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccountWithRole } from './subscription.js';
import { planHasAiInbox } from './entitlements.js';
import { hasInboxScope } from './connector-providers.js';
import { getConnectorToken } from './connectors.js';
import {
  listInboxItems,
  regenerateDraft,
  sendReply,
  dismissInboxItem,
  markAsSpam,
  subscribeInbox,
} from './social-inbox.js';

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

async function _requireEntitledIdentity(request, env) {
  const identity = await requireAuth(request, env);
  const account = await resolveAccountWithRole(identity.uid, env);
  if (!planHasAiInbox(account.planId)) {
    const e = new Error('The AI Inbox requires Cognita Plus or higher.');
    e.isForbidden = true;
    throw e;
  }
  return { identity, account };
}

/** Checks the connected Facebook token actually has the four Inbox scopes, not just the scheduler's set. */
async function _requireInboxScope(uid, env) {
  const token = await getConnectorToken(uid, 'facebook', env);
  if (!token) {
    const e = new Error('Connect Facebook in Account Settings > Connections first.');
    e.isConflict = true;
    throw e;
  }
  if (!hasInboxScope(token.scope)) {
    const e = new Error('Reconnect Facebook in Account Settings > Connections to enable the Inbox — it needs a few extra permissions for comments and DMs.');
    e.isConflict = true;
    throw e;
  }
}

async function _authOrError(request, env) {
  try {
    const { identity, account } = await _requireEntitledIdentity(request, env);
    return { identity, account };
  } catch (e) {
    if (e.isForbidden) throw { response: _jsonError(e.message, 403, env) };
    const authErr = describeAuthError(e);
    throw { response: _jsonError(authErr.message, authErr.status, env) };
  }
}

/** GET /api/inbox?status=&category= */
export async function handleInboxList(request, env) {
  let identity;
  try {
    ({ identity } = await _authOrError(request, env));
  } catch (wrapped) {
    return wrapped.response;
  }

  try {
    await _requireInboxScope(identity.uid, env);
  } catch (e) {
    return _jsonError(e.message, 409, env);
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || undefined;
  const category = url.searchParams.get('category') || undefined;

  try {
    const items = await listInboxItems(env, identity.uid, { status, category });
    return new Response(JSON.stringify({ items }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[social-inbox] list failed:', e.message);
    return _jsonError('Could not load your Inbox. Please try again.', 500, env);
  }
}

/** POST /api/inbox/subscribe */
export async function handleInboxSubscribe(request, env) {
  let identity;
  try {
    ({ identity } = await _authOrError(request, env));
  } catch (wrapped) {
    return wrapped.response;
  }

  try {
    await _requireInboxScope(identity.uid, env);
  } catch (e) {
    return _jsonError(e.message, 409, env);
  }

  try {
    const results = await subscribeInbox(env, identity.uid);
    return new Response(JSON.stringify({ subscribed: true, pages: results }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[social-inbox] subscribe failed:', e.message);
    return _jsonError('Could not enable the real-time Inbox. Please try again.', 500, env);
  }
}

/** POST /api/inbox/:id/regenerate */
export async function handleInboxRegenerate(request, env, itemId) {
  let identity, account;
  try {
    ({ identity, account } = await _authOrError(request, env));
  } catch (wrapped) {
    return wrapped.response;
  }

  try {
    const item = await regenerateDraft(env, identity.uid, itemId, account);
    return new Response(JSON.stringify({ item }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    if (e.isNotFound) return _jsonError('Inbox item not found.', 404, env);
    if (e.isLimit) return _jsonError(e.message, 429, env);
    console.error('[social-inbox] regenerate failed:', e.message);
    return _jsonError('Could not regenerate a draft. Please try again.', 500, env);
  }
}

/** POST /api/inbox/:id/reply — body { text } */
export async function handleInboxReply(request, env, itemId) {
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

  try {
    const item = await sendReply(env, identity.uid, itemId, input.text);
    return new Response(JSON.stringify({ item }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    if (e.isNotFound) return _jsonError('Inbox item not found.', 404, env);
    if (e.isConflict) return _jsonError(e.message, 409, env);
    if (e.isWindowExpired) return _jsonError(e.message, 409, env);
    console.error('[social-inbox] reply failed:', e.message);
    return _jsonError(e.message || 'Could not send that reply. Please try again.', 500, env);
  }
}

/** POST /api/inbox/:id/dismiss */
export async function handleInboxDismiss(request, env, itemId) {
  let identity;
  try {
    ({ identity } = await _authOrError(request, env));
  } catch (wrapped) {
    return wrapped.response;
  }

  try {
    await dismissInboxItem(env, identity.uid, itemId);
    return new Response(JSON.stringify({ dismissed: itemId }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    if (e.isNotFound) return _jsonError('Inbox item not found.', 404, env);
    console.error('[social-inbox] dismiss failed:', e.message);
    return _jsonError('Could not dismiss that item. Please try again.', 500, env);
  }
}

/** POST /api/inbox/:id/spam */
export async function handleInboxMarkSpam(request, env, itemId) {
  let identity;
  try {
    ({ identity } = await _authOrError(request, env));
  } catch (wrapped) {
    return wrapped.response;
  }

  try {
    await markAsSpam(env, identity.uid, itemId);
    return new Response(JSON.stringify({ spam: itemId }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    if (e.isNotFound) return _jsonError('Inbox item not found.', 404, env);
    console.error('[social-inbox] mark spam failed:', e.message);
    return _jsonError('Could not mark that item as spam. Please try again.', 500, env);
  }
}
