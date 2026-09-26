// webhooks/meta-webhook-endpoint.js
// Meta's real-time Webhooks product (comments + DMs), separate from the
// OAuth login flow already built in connectors.js/connector-providers.js.
// This is what feeds the AI Inbox (social-inbox.js) — see PART 1.2 of the
// implementation spec this file was built against.
//
// Two handlers:
//   handleMetaWebhookVerify — GET, Meta's subscription handshake.
//   handleMetaWebhookEvent  — POST, actual comment/message events.
//
// Signature verification follows the EXACT same discipline as
// webhook-endpoint.js's Paystack handler: verify the HMAC on the RAW
// body before doing anything else, including before parsing JSON.

import { fsGet, fsSet } from '../firestore-rest.js';
import { classifyInboxItem } from '../social-inbox.js';

/**
 * GET /webhooks/meta
 * Meta calls this with ?hub.mode=subscribe&hub.verify_token=...&hub.challenge=...
 * at subscription-setup time. FACEBOOK_WEBHOOK_VERIFY_TOKEN is a new
 * Worker secret — its value is whatever you choose at deploy time and
 * enter into Meta's App Dashboard webhook config to match.
 */
export function handleMetaWebhookVerify(request, env) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token && env.FACEBOOK_WEBHOOK_VERIFY_TOKEN && token === env.FACEBOOK_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge || '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

async function _verifySignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const provided = signatureHeader.slice('sha256='.length).trim().toLowerCase();

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const computedHex = Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, '0')).join('');

  if (computedHex.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) diff |= computedHex.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

function _nowIso() {
  return new Date().toISOString();
}

/**
 * Writes one socialInboxItems doc from a webhook change/messaging event.
 * `ownerUid` comes from the pageOwners reverse-lookup — see 1.3.
 */
async function _writeInboxItem(env, ownerUid, item) {
  const id = crypto.randomUUID();
  const now = _nowIso();
  const doc = {
    id,
    uid: ownerUid,
    pageId: item.pageId,
    kind: item.kind,
    platform: item.platform,
    externalId: item.externalId,
    conversationId: item.conversationId || null,
    authorName: item.authorName || null,
    authorId: item.authorId || null,
    text: item.text || '',
    postId: item.postId || null,
    status: 'new',
    category: null,
    categoryConfidence: null,
    aiDraftReply: null,
    sentReply: null,
    receivedAt: item.receivedAt || now,
    classifiedAt: null,
    repliedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await fsSet('socialInboxItems/' + id, doc, env);
  return id;
}

/** Resolves a Page or IG Business Account id to the Cognita uid that owns it. */
async function _resolveOwnerUid(env, entryId) {
  try {
    const owner = await fsGet('pageOwners/' + entryId, env);
    return owner ? owner.uid : null;
  } catch (e) {
    return null;
  }
}

/**
 * POST /webhooks/meta
 * Meta expects a fast 200 — AI classification happens in the background
 * via ctx.waitUntil, never synchronously in this handler.
 */
export async function handleMetaWebhookEvent(request, env, ctx) {
  const rawBody = await request.text();
  const signature = request.headers.get('X-Hub-Signature-256');

  const valid = await _verifySignature(rawBody, signature, env.FACEBOOK_CLIENT_SECRET);
  if (!valid) {
    console.error('[meta-webhook] signature verification failed');
    return new Response('Forbidden', { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    // Bad JSON after a valid signature is unusual, but still answer 200 —
    // Meta will not usefully retry a malformed payload, and a 4xx/5xx
    // here just burns into Meta's retry/disable-subscription budget.
    console.error('[meta-webhook] could not parse event body');
    return new Response('OK', { status: 200 });
  }

  const entries = payload.entry || [];
  const itemIdsToClassify = [];

  for (const entry of entries) {
    const entryId = entry.id; // Page id or IG Business Account id
    const ownerUid = await _resolveOwnerUid(env, entryId);
    if (!ownerUid) {
      // No pageOwners doc yet (e.g. user hasn't opened the Inbox to
      // trigger the sync in 1.2 step 3) — nothing we can do with this
      // event, so drop it rather than erroring the whole webhook call.
      continue;
    }

    for (const change of entry.changes || []) {
      try {
        if (change.field === 'feed' && change.value && change.value.item === 'comment' && change.value.verb === 'add') {
          const id = await _writeInboxItem(env, ownerUid, {
            pageId: entryId,
            kind: 'comment',
            platform: 'facebook',
            externalId: change.value.comment_id,
            authorName: change.value.from ? change.value.from.name : null,
            authorId: change.value.from ? change.value.from.id : null,
            text: change.value.message || '',
            postId: change.value.post_id || null,
          });
          itemIdsToClassify.push(id);
        } else if (change.field === 'comments' && change.value) {
          const id = await _writeInboxItem(env, ownerUid, {
            pageId: entryId,
            kind: 'comment',
            platform: 'instagram',
            externalId: change.value.id,
            authorName: change.value.from ? change.value.from.username : null,
            authorId: change.value.from ? change.value.from.id : null,
            text: change.value.text || '',
            postId: change.value.media ? change.value.media.id : null,
          });
          itemIdsToClassify.push(id);
        }
      } catch (e) {
        console.error('[meta-webhook] failed to write comment inbox item:', e.message);
      }
    }

    for (const message of entry.messaging || []) {
      if (!message.message || message.message.is_echo) continue; // skip our own sent messages
      try {
        const id = await _writeInboxItem(env, ownerUid, {
          pageId: entryId,
          kind: 'dm',
          platform: payload.object === 'instagram' ? 'instagram' : 'facebook',
          externalId: message.message.mid,
          conversationId: message.sender ? message.sender.id : null,
          authorId: message.sender ? message.sender.id : null,
          text: message.message.text || '',
          receivedAt: message.timestamp ? new Date(message.timestamp).toISOString() : undefined,
        });
        itemIdsToClassify.push(id);
      } catch (e) {
        console.error('[meta-webhook] failed to write DM inbox item:', e.message);
      }
    }
  }

  for (const itemId of itemIdsToClassify) {
    ctx.waitUntil(classifyInboxItem(env, itemId));
  }

  return new Response('OK', { status: 200 });
}
