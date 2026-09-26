// meta-tools.js
// Tool schemas + executors for the Facebook connector — which, via a
// single Meta ("Facebook Login for Business") OAuth grant, covers both
// posting to a Facebook Page and publishing to that Page's linked
// Instagram professional (Business/Creator) account. There is no
// separate "Instagram provider" — see connector-providers.js's
// SCOPES.facebook comment for why.
//
// Same TOOLS/describe/execute/approvalScope shape as github-tools.js —
// see that file's header comment for the contract. Two tools here write
// (REQUIRES_CONFIRMATION): posting to Facebook and posting to Instagram.
// Everything else is read-only.
//
// listPages() below is also imported directly (not through the chat
// tool-calling path) by social-scheduler-endpoint.js, to populate the
// page picker in the Social Scheduler UI, and by social-scheduler.js,
// to resolve a fresh Page access token at publish time.

import { getValidToken } from './connectors.js';

const GRAPH_VERSION = 'v21.0';
const GRAPH_BASE = 'https://graph.facebook.com/' + GRAPH_VERSION;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'facebook_list_pages',
      description: 'Lists the Facebook Pages the user has connected, and for each one, whether it has a linked Instagram professional account that can also be posted to. Use this first if you do not already know which Page or Instagram account to act on.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_create_post',
      description: 'Publishes a post to a Facebook Page\'s feed right now. For a post scheduled for later, tell the user to use the Social Scheduler instead — this tool always posts immediately.',
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: "The Facebook Page's id, from facebook_list_pages." },
          message: { type: 'string', description: 'The post text.' },
          link: { type: 'string', description: 'Optional URL to attach to the post (Facebook renders a link preview card).' },
        },
        required: ['pageId', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'instagram_create_post',
      description: "Publishes an image post to a Page's linked Instagram professional account right now. Instagram requires a publicly reachable image URL — it cannot accept an uploaded file directly. For a post scheduled for later, tell the user to use the Social Scheduler instead.",
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: "The Facebook Page's id whose linked Instagram account should post, from facebook_list_pages." },
          imageUrl: { type: 'string', description: 'Publicly reachable URL of the image to post.' },
          caption: { type: 'string', description: 'The post caption.' },
        },
        required: ['pageId', 'imageUrl'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'facebook_get_page_insights',
      description: "Reads a Facebook Page's recent performance: impressions and engaged users over the last 7 days.",
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: "The Facebook Page's id, from facebook_list_pages." },
        },
        required: ['pageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'instagram_get_account_insights',
      description: "Reads a linked Instagram account's recent performance: reach and profile views over the last 7 days.",
      parameters: {
        type: 'object',
        properties: {
          pageId: { type: 'string', description: "The Facebook Page id whose linked Instagram account's insights to read, from facebook_list_pages." },
        },
        required: ['pageId'],
      },
    },
  },
];

export const REQUIRES_CONFIRMATION = ['facebook_create_post', 'instagram_create_post'];

export function describe(name, args) {
  args = args || {};
  if (name === 'facebook_list_pages') return 'Looking at your connected Facebook Pages.';
  if (name === 'facebook_create_post') {
    const preview = String(args.message || '').slice(0, 60);
    return 'Posting to Facebook: "' + preview + (preview.length === 60 ? '…' : '') + '".';
  }
  if (name === 'instagram_create_post') {
    const preview = String(args.caption || '').slice(0, 60);
    return 'Posting to Instagram: "' + preview + (preview.length === 60 ? '…' : '') + '".';
  }
  if (name === 'facebook_get_page_insights') return "Checking your Facebook Page's insights.";
  if (name === 'instagram_get_account_insights') return "Checking your Instagram account's insights.";
  return 'Working in Facebook/Instagram.';
}

// Both write tools take a pageId — scoping approval to one Page (and its
// linked Instagram account, since posting to it is authorized through
// that same Page) means approving posts on one Page never silently
// approves posting through a different one.
export function approvalScope(_name, args) {
  args = args || {};
  return args.pageId || 'unscoped';
}

async function _metaFetch(path, params, options = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(GRAPH_BASE + path + (qs ? '?' + qs : ''), options);
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    const code = data && data.error ? data.error.code : res.status;
    // Meta's OAuthException (code 190) is the "token invalid/expired/
    // revoked" signal — treat exactly like every other provider's 401.
    if (code === 190 || res.status === 401) throw new Error('NEEDS_RECONNECT');
    const msg = data && data.error ? data.error.message : 'HTTP ' + res.status;
    throw new Error('Meta Graph API error: ' + msg);
  }
  return data;
}

/**
 * Lists the user's connected Facebook Pages, each with its own
 * Page access token and (if linked) Instagram Business Account id.
 * Page tokens derived from a long-lived user token are themselves
 * effectively non-expiring, which is what lets the Social Scheduler
 * publish unattended. Exported for reuse by social-scheduler-endpoint.js
 * and social-scheduler.js — neither should re-implement this call.
 */
export async function listPages(uid, env) {
  const userToken = await getValidToken(uid, 'facebook', env);
  const data = await _metaFetch('/me/accounts', {
    fields: 'id,name,access_token,instagram_business_account{id,username,profile_picture_url}',
    access_token: userToken,
  });
  return (data.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    pageAccessToken: p.access_token,
    instagram: p.instagram_business_account
      ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username || null }
      : null,
  }));
}

async function _getPageOrThrow(uid, args, env) {
  if (!args.pageId) throw new Error('pageId is required.');
  const pages = await listPages(uid, env);
  const page = pages.find((p) => p.id === args.pageId);
  if (!page) throw new Error('That Facebook Page is not connected, or is no longer accessible with the current connection.');
  return page;
}

async function _listPagesTool(uid, _args, env) {
  const pages = await listPages(uid, env);
  return pages.map((p) => ({
    id: p.id,
    name: p.name,
    instagram: p.instagram ? { id: p.instagram.id, username: p.instagram.username } : null,
  }));
}

/**
 * Low-level publish, split out from the chat-tool executor below so
 * social-scheduler.js can call it directly with a Page access token it
 * already has, without going through getValidToken/listPages again.
 */
export async function publishFacebookPost(pageAccessToken, pageId, { message, link }) {
  const body = new URLSearchParams({ message: message || '', access_token: pageAccessToken });
  if (link) body.set('link', link);
  const res = await fetch(GRAPH_BASE + '/' + encodeURIComponent(pageId) + '/feed', { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error('Facebook post failed: ' + (data && data.error ? data.error.message : res.status));
  }
  return data.id; // "{page-id}_{post-id}"
}

/** Two-step Instagram publish: create a media container, then publish it. */
export async function publishInstagramPost(pageAccessToken, igAccountId, { imageUrl, caption }) {
  const createBody = new URLSearchParams({
    image_url: imageUrl, caption: caption || '', access_token: pageAccessToken,
  });
  const createRes = await fetch(GRAPH_BASE + '/' + encodeURIComponent(igAccountId) + '/media', { method: 'POST', body: createBody });
  const createData = await createRes.json().catch(() => null);
  if (!createRes.ok || (createData && createData.error)) {
    throw new Error('Instagram media creation failed: ' + (createData && createData.error ? createData.error.message : createRes.status));
  }

  const publishBody = new URLSearchParams({ creation_id: createData.id, access_token: pageAccessToken });
  const publishRes = await fetch(GRAPH_BASE + '/' + encodeURIComponent(igAccountId) + '/media_publish', { method: 'POST', body: publishBody });
  const publishData = await publishRes.json().catch(() => null);
  if (!publishRes.ok || (publishData && publishData.error)) {
    throw new Error('Instagram publish failed: ' + (publishData && publishData.error ? publishData.error.message : publishRes.status));
  }
  return publishData.id;
}

/**
 * Publishes a video to Instagram as a Reel (image posts use
 * publishInstagramPost above; video always goes through the REELS
 * container type, which is the Graph API's only video path now that
 * classic IGTV/feed-video containers are deprecated).
 *
 * Video containers process asynchronously on Meta's side, so unlike the
 * image path this polls the container's status_code until it flips to
 * FINISHED (or ERROR) before attempting media_publish — publishing a
 * still-IN_PROGRESS container just fails outright. The poll is bounded
 * (~10 tries, 3s apart = ~30s) so one Worker invocation can't hang
 * indefinitely; if the video simply needs longer, the caller's own
 * retry loop (social-scheduler.js's RETRY_DELAYS_MS) will try again
 * later against the same still-live upload.
 */
export async function publishInstagramVideo(pageAccessToken, igAccountId, { videoUrl, caption }) {
  const createBody = new URLSearchParams({
    video_url: videoUrl, caption: caption || '', media_type: 'REELS', access_token: pageAccessToken,
  });
  const createRes = await fetch(GRAPH_BASE + '/' + encodeURIComponent(igAccountId) + '/media', { method: 'POST', body: createBody });
  const createData = await createRes.json().catch(() => null);
  if (!createRes.ok || (createData && createData.error)) {
    throw new Error('Instagram video upload failed: ' + (createData && createData.error ? createData.error.message : createRes.status));
  }

  const creationId = createData.id;
  const MAX_POLLS = 10;
  const POLL_DELAY_MS = 3000;
  let statusCode = 'IN_PROGRESS';

  for (let i = 0; i < MAX_POLLS && statusCode === 'IN_PROGRESS'; i++) {
    await new Promise((r) => setTimeout(r, POLL_DELAY_MS));
    const statusRes = await fetch(
      GRAPH_BASE + '/' + encodeURIComponent(creationId) + '?fields=status_code&access_token=' + encodeURIComponent(pageAccessToken)
    );
    const statusData = await statusRes.json().catch(() => null);
    statusCode = (statusData && statusData.status_code) || 'IN_PROGRESS';
    if (statusCode === 'ERROR') {
      throw new Error('Instagram could not process that video.');
    }
  }

  if (statusCode !== 'FINISHED') {
    throw new Error('Instagram is still processing that video — it will be retried shortly.');
  }

  const publishBody = new URLSearchParams({ creation_id: creationId, access_token: pageAccessToken });
  const publishRes = await fetch(GRAPH_BASE + '/' + encodeURIComponent(igAccountId) + '/media_publish', { method: 'POST', body: publishBody });
  const publishData = await publishRes.json().catch(() => null);
  if (!publishRes.ok || (publishData && publishData.error)) {
    throw new Error('Instagram publish failed: ' + (publishData && publishData.error ? publishData.error.message : publishRes.status));
  }
  return publishData.id;
}

/** Publishes a single photo to a Facebook Page's feed, with an optional caption. */
export async function publishFacebookPhoto(pageAccessToken, pageId, { photoUrl, message }) {
  const body = new URLSearchParams({ url: photoUrl, access_token: pageAccessToken });
  if (message) body.set('caption', message);
  const res = await fetch(GRAPH_BASE + '/' + encodeURIComponent(pageId) + '/photos', { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error('Facebook photo post failed: ' + (data && data.error ? data.error.message : res.status));
  }
  return data.post_id || data.id;
}

/** Publishes a video to a Facebook Page, with an optional description. */
export async function publishFacebookVideo(pageAccessToken, pageId, { videoUrl, message }) {
  const body = new URLSearchParams({ file_url: videoUrl, access_token: pageAccessToken });
  if (message) body.set('description', message);
  const res = await fetch(GRAPH_BASE + '/' + encodeURIComponent(pageId) + '/videos', { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error('Facebook video post failed: ' + (data && data.error ? data.error.message : res.status));
  }
  return data.id;
}

// ── AI Inbox: reply / hide (Part 1.4) ───────────────────────────────
// Same URLSearchParams-body, same-error-shape style as
// publishFacebookPost/publishInstagramPost above.

/** Replies to a Facebook Page comment. `commentId` is the Graph API comment id. */
export async function replyToFacebookComment(pageAccessToken, commentId, message) {
  const body = new URLSearchParams({ message: message || '', access_token: pageAccessToken });
  const res = await fetch(GRAPH_BASE + '/' + encodeURIComponent(commentId) + '/comments', { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error('Facebook comment reply failed: ' + (data && data.error ? data.error.message : res.status));
  }
  return data.id;
}

/** Replies to an Instagram comment. `commentId` is the IG comment id. */
export async function replyToInstagramComment(pageAccessToken, commentId, message) {
  const body = new URLSearchParams({ message: message || '', access_token: pageAccessToken });
  const res = await fetch(GRAPH_BASE + '/' + encodeURIComponent(commentId) + '/replies', { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error('Instagram comment reply failed: ' + (data && data.error ? data.error.message : res.status));
  }
  return data.id;
}

/**
 * Sends a Page/Instagram DM reply. `pageId` is the Page (or, for an IG
 * DM, the linked IG account's own messaging endpoint is the Page id
 * too — Meta unifies this under /{page-id}/messages for both).
 * Callers (social-inbox.js) are responsible for the 24-hour messaging
 * window check BEFORE calling this — this function still surfaces
 * Meta's own rejection if that check was somehow stale, but does not
 * re-derive it itself since it has no access to receivedAt here.
 */
export async function sendPageDirectMessage(pageAccessToken, pageId, recipientId, text) {
  const body = new URLSearchParams({
    recipient: JSON.stringify({ id: recipientId }),
    message: JSON.stringify({ text: text || '' }),
    access_token: pageAccessToken,
  });
  const res = await fetch(GRAPH_BASE + '/' + encodeURIComponent(pageId) + '/messages', { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    const err = data && data.error;
    // Meta's "outside the 24-hour messaging window" rejection — code/
    // subcode combination per current docs; surfaced with a clear
    // isWindowExpired flag so social-inbox.js can give the user a
    // specific message instead of a generic failure. Verify this
    // code/subcode pair against Meta's live docs at deploy time, since
    // Meta has changed these before.
    if (err && (err.code === 10 || err.error_subcode === 2018278)) {
      const e = new Error('Too much time has passed since their last message — Meta only allows a reply within 24 hours.');
      e.isWindowExpired = true;
      throw e;
    }
    throw new Error('Message send failed: ' + (err ? err.message : res.status));
  }
  return data.message_id || data.id;
}

/** Hides (or un-hides) a Facebook/Instagram comment. */
export async function hideComment(pageAccessToken, commentId, hidden = true) {
  const body = new URLSearchParams({ is_hidden: String(hidden), access_token: pageAccessToken });
  const res = await fetch(GRAPH_BASE + '/' + encodeURIComponent(commentId), { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error('Could not hide that comment: ' + (data && data.error ? data.error.message : res.status));
  }
  return true;
}

/**
 * Subscribes a Page to the webhook fields the AI Inbox needs
 * (comments/messages). Called once per Page, lazily, the first time a
 * user opens the Inbox page — see social-inbox.js's syncPageOwners /
 * social-inbox-endpoint.js's /api/inbox/subscribe. Instagram comments
 * ride on the Page's own 'feed' subscription once the linked IG
 * account is set up (per current Graph API v21.0 docs) — verify this
 * still holds at deploy time, since Meta has occasionally required a
 * separate 'instagram' object subscription instead.
 */
export async function subscribePageToWebhooks(pageAccessToken, pageId) {
  const body = new URLSearchParams({
    subscribed_fields: 'feed,messages,messaging_postbacks',
    access_token: pageAccessToken,
  });
  const res = await fetch(GRAPH_BASE + '/' + encodeURIComponent(pageId) + '/subscribed_apps', { method: 'POST', body });
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.error)) {
    throw new Error('Could not subscribe Page to webhooks: ' + (data && data.error ? data.error.message : res.status));
  }
  return true;
}

// ── Insights Digest: public wrappers (Part 2.1) ─────────────────────
// Thin exported wrappers around the same Graph API insights calls the
// chat tool executors already use (_getPageInsights/_getInstagramInsights
// below), pulling a fuller metric set for a digest rather than the
// narrow set the chat tool asks for. Kept as separate functions rather
// than widening the chat tool's own metric list, since a chat answer
// wants a short read, not a full report's worth of numbers.

/**
 * Facebook Page insights + this period's post-level performance, for
 * the Insights Digest. Field/metric names should be re-verified against
 * current Graph API v21.0 docs at deploy time — Meta renames Page
 * insight metrics periodically (this is the same caution the original
 * chat tool's _getPageInsights already carries for its narrower set).
 */
export async function getPageInsights(uid, pageId, env) {
  const pages = await listPages(uid, env);
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new Error('That Facebook Page is not connected.');

  const [pageMetrics, posts] = await Promise.all([
    _metaFetch('/' + encodeURIComponent(page.id) + '/insights', {
      metric: 'page_impressions,page_engaged_users,page_fan_adds,page_fan_removes',
      period: 'week',
      access_token: page.pageAccessToken,
    }).catch(() => ({ data: [] })),
    _metaFetch('/' + encodeURIComponent(page.id) + '/posts', {
      fields: 'message,created_time,insights.metric(post_impressions,post_engaged_users)',
      limit: 25,
      access_token: page.pageAccessToken,
    }).catch(() => ({ data: [] })),
  ]);

  return {
    pageId: page.id,
    pageName: page.name,
    metrics: (pageMetrics.data || []).map((m) => ({
      metric: m.name,
      latestValue: m.values && m.values.length ? m.values[m.values.length - 1].value : null,
    })),
    posts: (posts.data || []).map((p) => ({
      message: (p.message || '').slice(0, 200),
      createdAt: p.created_time,
      insights: ((p.insights && p.insights.data) || []).map((i) => ({
        metric: i.name,
        value: i.values && i.values.length ? i.values[0].value : null,
      })),
    })),
  };
}

/** Instagram account insights + recent media performance, for the Insights Digest. */
export async function getInstagramInsights(uid, pageId, env) {
  const pages = await listPages(uid, env);
  const page = pages.find((p) => p.id === pageId);
  if (!page) throw new Error('That Facebook Page is not connected.');
  if (!page.instagram) return { pageId: page.id, pageName: page.name, instagram: false, metrics: [], media: [] };

  const [igMetrics, media] = await Promise.all([
    _metaFetch('/' + encodeURIComponent(page.instagram.id) + '/insights', {
      metric: 'reach,profile_views,follower_count',
      period: 'week',
      access_token: page.pageAccessToken,
    }).catch(() => ({ data: [] })),
    _metaFetch('/' + encodeURIComponent(page.instagram.id) + '/media', {
      fields: 'caption,timestamp,like_count,comments_count,insights.metric(reach,engagement)',
      limit: 25,
      access_token: page.pageAccessToken,
    }).catch(() => ({ data: [] })),
  ]);

  return {
    pageId: page.id,
    pageName: page.name,
    instagram: true,
    instagramUsername: page.instagram.username,
    metrics: (igMetrics.data || []).map((m) => ({
      metric: m.name,
      latestValue: m.values && m.values.length ? m.values[m.values.length - 1].value : null,
    })),
    media: (media.data || []).map((m) => ({
      caption: (m.caption || '').slice(0, 200),
      timestamp: m.timestamp,
      likeCount: m.like_count,
      commentsCount: m.comments_count,
      insights: ((m.insights && m.insights.data) || []).map((i) => ({
        metric: i.name,
        value: i.values && i.values.length ? i.values[0].value : null,
      })),
    })),
  };
}

async function _createFacebookPost(uid, args, env) {
  if (!args.message) throw new Error('message is required.');
  const page = await _getPageOrThrow(uid, args, env);
  const postId = await publishFacebookPost(page.pageAccessToken, page.id, { message: args.message, link: args.link });
  return { posted: true, postId, pageName: page.name };
}

async function _createInstagramPost(uid, args, env) {
  if (!args.imageUrl) throw new Error('imageUrl is required.');
  const page = await _getPageOrThrow(uid, args, env);
  if (!page.instagram) throw new Error('That Page has no linked Instagram professional account.');
  const postId = await publishInstagramPost(page.pageAccessToken, page.instagram.id, { imageUrl: args.imageUrl, caption: args.caption });
  return { posted: true, postId, instagramUsername: page.instagram.username };
}

async function _getPageInsights(uid, args, env) {
  const page = await _getPageOrThrow(uid, args, env);
  const data = await _metaFetch('/' + encodeURIComponent(page.id) + '/insights', {
    metric: 'page_impressions,page_engaged_users',
    period: 'week',
    access_token: page.pageAccessToken,
  });
  return (data.data || []).map((m) => ({
    metric: m.name,
    latestValue: m.values && m.values.length ? m.values[m.values.length - 1].value : null,
  }));
}

async function _getInstagramInsights(uid, args, env) {
  const page = await _getPageOrThrow(uid, args, env);
  if (!page.instagram) throw new Error('That Page has no linked Instagram professional account.');
  const data = await _metaFetch('/' + encodeURIComponent(page.instagram.id) + '/insights', {
    metric: 'reach,profile_views',
    period: 'week',
    access_token: page.pageAccessToken,
  });
  return (data.data || []).map((m) => ({
    metric: m.name,
    latestValue: m.values && m.values.length ? m.values[m.values.length - 1].value : null,
  }));
}

export async function execute(name, args, uid, env) {
  if (name === 'facebook_list_pages') return _listPagesTool(uid, args, env);
  if (name === 'facebook_create_post') return _createFacebookPost(uid, args, env);
  if (name === 'instagram_create_post') return _createInstagramPost(uid, args, env);
  if (name === 'facebook_get_page_insights') return _getPageInsights(uid, args, env);
  if (name === 'instagram_get_account_insights') return _getInstagramInsights(uid, args, env);
  throw new Error('Unknown Facebook/Instagram tool: ' + name);
}
