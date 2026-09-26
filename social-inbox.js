// social-inbox.js
// Owns Firestore reads/writes and the classification/reply logic for the
// AI Inbox feature — same role as social-scheduler.js, imported by the
// thin social-inbox-endpoint.js. See PART 1 of the implementation spec.
//
// The user is ALWAYS the one who taps "send" on a reply. Nothing in this
// file ever sends a reply without sendReply() being explicitly called
// from a user-initiated request — do not add an autosend path.

import { fsGet, fsSet, fsUpdate, fsQuery } from './firestore-rest.js';
import { callWithFallback } from './providers.js';
import { MODEL_TIERS } from './entitlements.js';
import { checkAndIncrement } from './usage.js';
import { extractJson } from './json-extract.js';
import { listPages, replyToFacebookComment, replyToInstagramComment, sendPageDirectMessage, hideComment, subscribePageToWebhooks } from './meta-tools.js';

const CATEGORIES = ['question', 'lead', 'complaint', 'spam', 'positive', 'other'];
const MESSAGING_WINDOW_MS = 24 * 60 * 60 * 1000;

function _nowIso() {
  return new Date().toISOString();
}

/** GET /api/inbox — fsQuery by uid (the only equality filter fsQuery supports), filter the rest in JS. */
export async function listInboxItems(env, uid, { status, category, limit } = {}) {
  const rows = await fsQuery('socialInboxItems', 'uid', uid, 'receivedAt', limit || 50, env, 'DESCENDING');
  return rows.filter((r) => {
    if (status && r.status !== status) return false;
    if (category && r.category !== category) return false;
    return true;
  });
}

/** Fetches an inbox item and verifies it belongs to `uid`. */
export async function getOwnedInboxItem(env, uid, itemId) {
  const item = await fsGet('socialInboxItems/' + itemId, env);
  if (!item || item.uid !== uid) {
    const e = new Error('Inbox item not found.');
    e.isNotFound = true;
    throw e;
  }
  return item;
}

/**
 * Classifies (or re-classifies) an inbox item with the LLM: category,
 * confidence, and a draft reply. On any parse/LLM failure this stores a
 * safe fallback (category: 'other', draftReply: null) rather than
 * throwing — a failed classification must never block the item from
 * showing up in the inbox unclassified.
 */
export async function classifyInboxItem(env, itemId) {
  const item = await fsGet('socialInboxItems/' + itemId, env);
  if (!item) return;

  const systemPrompt = [
    'You triage incoming social media comments and DMs for a small business.',
    'Classify the message into exactly one category: question, lead, complaint, spam, positive, or other.',
    'Draft a short, friendly, on-brand reply for the business owner to review and edit before sending.',
    "If you don't know specific details like prices, hours, or policies, write a generic acknowledging reply and suggest they'll get specifics shortly — never fabricate business details.",
    "If the category is 'spam', set draftReply to null.",
    'Respond with STRICT JSON only, no markdown, in exactly this shape: {"category": "...", "confidence": 0.0, "draftReply": "..." | null}',
  ].join(' ');

  const userPrompt = 'Platform: ' + item.platform + '\nType: ' + item.kind + '\nMessage: ' + item.text;

  let result;
  try {
    result = await callWithFallback(MODEL_TIERS.fast, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], env, { maxTokens: 500 });
  } catch (e) {
    console.error('[social-inbox] classification LLM call failed:', e.message);
    await fsUpdate('socialInboxItems/' + itemId, { category: 'other', draftReply: null, classifiedAt: _nowIso(), updatedAt: _nowIso() }, env).catch(() => {});
    return;
  }

  const parsed = extractJson(result.text);
  const category = parsed && CATEGORIES.includes(parsed.category) ? parsed.category : 'other';
  const confidence = parsed && typeof parsed.confidence === 'number' ? parsed.confidence : null;
  const draftReply = parsed && category !== 'spam' && typeof parsed.draftReply === 'string' ? parsed.draftReply : null;

  await fsUpdate('socialInboxItems/' + itemId, {
    category,
    categoryConfidence: confidence,
    aiDraftReply: draftReply,
    classifiedAt: _nowIso(),
    updatedAt: _nowIso(),
  }, env).catch((e) => console.error('[social-inbox] could not save classification:', e.message));
}

/** User-triggered "regenerate draft" — quota-checked, since each call is an LLM spend. */
export async function regenerateDraft(env, uid, itemId, plan) {
  const item = await getOwnedInboxItem(env, uid, itemId);

  const quota = await checkAndIncrement(uid, 'inboxAiDraft', plan.limits.inboxAiDraftPerDay, env);
  if (!quota.allowed) {
    const e = new Error('Daily AI draft limit reached for your plan.');
    e.isLimit = true;
    throw e;
  }

  await classifyInboxItem(env, item.id);
  return getOwnedInboxItem(env, uid, itemId);
}

function _findPageForItem(pages, item) {
  return pages.find((p) => p.id === item.pageId);
}

/**
 * Sends the user-approved reply. Routes to the correct Graph API call
 * based on kind/platform. For DMs, refuses client-side if outside
 * Meta's 24-hour messaging window BEFORE ever calling the API, and also
 * surfaces Meta's own rejection (meta-tools.js's isWindowExpired) if the
 * client-side check was somehow stale.
 */
export async function sendReply(env, uid, itemId, replyText) {
  const item = await getOwnedInboxItem(env, uid, itemId);
  if (item.status === 'replied') {
    const e = new Error('This item has already been replied to.');
    e.isConflict = true;
    throw e;
  }
  if (!replyText || !replyText.trim()) {
    throw new Error('Reply text is required.');
  }

  const pages = await listPages(uid, env);
  const page = _findPageForItem(pages, item);
  if (!page) throw new Error('That connected Page is no longer accessible.');

  if (item.kind === 'dm') {
    const receivedMs = new Date(item.receivedAt).getTime();
    if (!receivedMs || Date.now() - receivedMs > MESSAGING_WINDOW_MS) {
      const e = new Error('Too much time has passed since their last message — Meta only allows a reply within 24 hours.');
      e.isWindowExpired = true;
      throw e;
    }
    await sendPageDirectMessage(page.pageAccessToken, page.id, item.authorId, replyText);
  } else if (item.kind === 'comment' && item.platform === 'facebook') {
    await replyToFacebookComment(page.pageAccessToken, item.externalId, replyText);
  } else if (item.kind === 'comment' && item.platform === 'instagram') {
    await replyToInstagramComment(page.pageAccessToken, item.externalId, replyText);
  } else {
    throw new Error('Unsupported inbox item type.');
  }

  await fsUpdate('socialInboxItems/' + itemId, {
    status: 'replied', sentReply: replyText, repliedAt: _nowIso(), updatedAt: _nowIso(),
  }, env);

  return getOwnedInboxItem(env, uid, itemId);
}

/** POST /api/inbox/:id/dismiss */
export async function dismissInboxItem(env, uid, itemId) {
  await getOwnedInboxItem(env, uid, itemId); // ownership check
  await fsUpdate('socialInboxItems/' + itemId, { status: 'dismissed', updatedAt: _nowIso() }, env);
}

/**
 * POST /api/inbox/:id/spam — marks the item and, for comments, also
 * hides it via the Graph API so it stops showing publicly, not just in
 * our own inbox.
 */
export async function markAsSpam(env, uid, itemId) {
  const item = await getOwnedInboxItem(env, uid, itemId);

  if (item.kind === 'comment') {
    try {
      const pages = await listPages(uid, env);
      const page = _findPageForItem(pages, item);
      if (page) await hideComment(page.pageAccessToken, item.externalId, true);
    } catch (e) {
      // Non-fatal: the item is still marked spam in our own inbox even
      // if the Graph API hide call fails (e.g. token expired).
      console.error('[social-inbox] could not hide comment on Meta side:', e.message);
    }
  }

  await fsUpdate('socialInboxItems/' + itemId, { status: 'spam', updatedAt: _nowIso() }, env);
}

/**
 * Writes/refreshes pageOwners reverse-lookup docs for every Page (and
 * linked IG account) this uid has connected — this is how the webhook
 * handler knows which uid an incoming event belongs to. Called from
 * /api/inbox/subscribe (social-inbox-endpoint.js).
 */
export async function syncPageOwners(env, uid) {
  const pages = await listPages(uid, env);
  const now = _nowIso();
  for (const page of pages) {
    await fsSet('pageOwners/' + page.id, {
      id: page.id, uid, kind: 'page', pageId: page.id, name: page.name, updatedAt: now,
    }, env).catch((e) => console.error('[social-inbox] pageOwners write failed for', page.id, ':', e.message));

    if (page.instagram) {
      await fsSet('pageOwners/' + page.instagram.id, {
        id: page.instagram.id, uid, kind: 'instagram', pageId: page.id, name: page.instagram.username || page.name, updatedAt: now,
      }, env).catch((e) => console.error('[social-inbox] pageOwners write failed for', page.instagram.id, ':', e.message));
    }
  }
  return pages;
}

/**
 * Subscribes every connected Page to the webhook fields the Inbox needs,
 * and syncs pageOwners at the same time (a Page can't be looked up by
 * the webhook handler until pageOwners exists for it). Idempotent —
 * safe to call every time the user opens the Inbox page, not just once.
 */
export async function subscribeInbox(env, uid) {
  const pages = await syncPageOwners(env, uid);
  const results = [];
  for (const page of pages) {
    try {
      await subscribePageToWebhooks(page.pageAccessToken, page.id);
      results.push({ pageId: page.id, subscribed: true });
    } catch (e) {
      console.error('[social-inbox] webhook subscribe failed for', page.id, ':', e.message);
      results.push({ pageId: page.id, subscribed: false, error: e.message });
    }
  }
  return results;
}
