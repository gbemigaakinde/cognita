// worker.js
// Main Cloudflare Worker entry point. 

import { handlePlansRequest } from './plans-endpoint.js';
import { handleChatRequest } from './chat-endpoint.js';
import { handleImageRequest } from './image-endpoint.js';
import { handleDocumentRequest } from './document-endpoint.js';
import {
  handleResourceGenerate,
  handleResourceDownload,
  handleResourceFileProxy,
  handleResourceImageProxy,
  handleResourceCardImage,
  handleResourceList,
  handleResourceEdit,
  handleResourceRegenerate,
} from './resources-endpoint.js';
import { handlePaymentInitialize, handlePaymentStatus } from './payment-endpoint.js';
import { handlePaystackWebhook } from './webhook-endpoint.js';
import { handleAccountRequest, handleUsageRequest } from './account-endpoint.js';
import { handleSubscriptionCancel } from './cancel-endpoint.js';
import { handleChatSave, handleChatDelete, handleChatList, handleChatGet } from './chat-sync-endpoint.js';
import { handleFilesList, handleFileGet } from './files-endpoint.js';
import {
  handleAdminResourceCreate,
  handleAdminResourceBatchCreate,
  handleAdminResourceEdit,
  handleAdminResourceTransition,
  handleAdminResourceList,
  handleAdminResourceGet,
  handleAdminResourceVersions,
  handleAdminResourceDelete,
} from './admin-resources-endpoint.js';
import {
  handleCollectionCreate,
  handleCollectionEdit,
  handleCollectionResourceEdit,
  handleAdminCollectionList,
  handleCollectionDelete,
  handlePublicCollectionList,
} from './collections-endpoint.js';
import {
  handleLibraryList,
  handleLibraryGet,
  handleLibraryDownload,
  handleLibraryFileProxy,
  handleLibraryCollectionGet,
} from './library-endpoint.js';
import {
  handleAdminBootstrap,
  handleAdminWhoAmI,
  handleAdminRoleList,
  handleAdminRoleGrant,
  handleAdminRoleRevoke,
  handleAdminRoleLookupEmail,
} from './admin-roles-endpoint.js';
import {
  handleNoteSessionCreate,
  handleNoteSession,
  handleNoteSessionSegment,
  handleNoteChunkTranscribe,
} from './note-taker-endpoint.js';
import { handleSendVerificationEmail, handleSendPasswordReset } from './emails/auth-email-endpoint.js';
import { handleSendWelcomeEmail, handlePasswordChangedNotice } from './emails/account-email-endpoint.js';
import {
  handleConnectorStart,
  handleConnectorCallback,
  handleConnectorStatus,
  handleConnectorDisconnect,
} from './connectors-endpoint.js';
import {
  handleFacebookDataDeletion,
  handleDataDeletionStatus,
  handleLinkFacebookLogin,
} from './facebook-data-deletion.js';
import {
  handleReminderCreate,
  handleReminderList,
  handleReminderUpdate,
  handleReminderDelete,
  handleSubscribe,
  handleUnsubscribe,
  handleTestNotification,
} from './reminders/reminders-endpoint.js';
import { runReminderScheduler } from './reminders/reminders-scheduler.js';
import {
  handleSocialPagesList,
  handleScheduleCreate,
  handleScheduleList,
  handleScheduleCancel,
  handleSocialMediaUpload,
  handleSocialMediaProxy,
} from './social-scheduler-endpoint.js';
import { runSocialScheduler } from './social-scheduler.js';
import {
  handleInboxList,
  handleInboxSubscribe,
  handleInboxRegenerate,
  handleInboxReply,
  handleInboxDismiss,
  handleInboxMarkSpam,
} from './social-inbox-endpoint.js';
import { handleMetaWebhookVerify, handleMetaWebhookEvent } from './webhooks/meta-webhook-endpoint.js';
import {
  handleInsightsScheduleGet,
  handleInsightsScheduleUpsert,
  handleInsightsGenerate,
  handleInsightsHistory,
  handleInsightsFileProxy,
} from './insights-endpoint.js';
import { runInsightsDigestScheduler } from './insights-digest.js';

function _corsPreflight(env) {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': env.APP_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Note-Language',
      'Access-Control-Max-Age': '86400',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return _corsPreflight(env);

  const url = new URL(request.url);

  if (request.method === 'POST' && url.pathname === '/api/note-sessions') return handleNoteSessionCreate(request, env);
  if (/^\/api\/note-sessions\/[^/]+\/segments$/.test(url.pathname) && request.method === 'POST') return handleNoteSessionSegment(request, env, url.pathname.split('/')[3]);
  if (/^\/api\/note-sessions\/[^/]+\/transcribe$/.test(url.pathname) && request.method === 'POST') return handleNoteChunkTranscribe(request, env, url.pathname.split('/')[3]);
  if (/^\/api\/note-sessions\/[^/]+$/.test(url.pathname) && ['GET', 'PATCH'].includes(request.method)) return handleNoteSession(request, env, url.pathname.split('/')[3]);

  if (request.method === 'GET' && url.pathname === '/') {
      return new Response('Cognita Worker is running.', { status: 200 });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/send-verification') {
      return handleSendVerificationEmail(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/send-password-reset') {
      return handleSendPasswordReset(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/send-welcome') {
      return handleSendWelcomeEmail(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/notify-password-changed') {
      return handlePasswordChangedNotice(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/plans') {
      return handlePlansRequest(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/account') {
      return handleAccountRequest(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/usage') {
      return handleUsageRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/chat') {
      return handleChatRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/chat/save') {
      return handleChatSave(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/chat/delete') {
      return handleChatDelete(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/chat/list') {
      return handleChatList(request, env);
    }

    if (request.method === 'GET' && /^\/api\/chat\/[^/]+$/.test(url.pathname)) {
      const conversationId = url.pathname.split('/')[3];
      return handleChatGet(request, env, conversationId);
    }

    if (request.method === 'POST' && url.pathname === '/api/image') {
      return handleImageRequest(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/document') {
      return handleDocumentRequest(request, env);
    }

    if (request.method === 'GET' && /^\/api\/files\/[^/]+$/.test(url.pathname)) {
      const conversationId = url.pathname.split('/')[3];
      return handleFilesList(request, env, conversationId);
    }

    if (request.method === 'GET' && /^\/api\/files\/[^/]+\/[^/]+$/.test(url.pathname)) {
      const parts = url.pathname.split('/');
      const conversationId = parts[3];
      const fileId = parts[4];
      return handleFileGet(request, env, conversationId, fileId);
    }

    if (request.method === 'POST' && url.pathname === '/api/resources/generate') {
      return handleResourceGenerate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/resources/list') {
      return handleResourceList(request, env);
    }

    if (request.method === 'POST' && /^\/api\/resources\/[^/]+\/download$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceDownload(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/resources\/[^/]+\/file$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceFileProxy(request, env, resourceId);
    }

    // Makes the picture for one flashcard (one small request per card).
    if (request.method === 'POST' && /^\/api\/resources\/[^/]+\/cards\/\d+\/image$/.test(url.pathname)) {
      const parts = url.pathname.split('/');
      return handleResourceCardImage(request, env, parts[3], parts[5]);
    }

    if (request.method === 'GET' && /^\/api\/resources\/[^/]+\/image$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceImageProxy(request, env, resourceId);
    }

    if (request.method === 'POST' && /^\/api\/resources\/[^/]+\/edit$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceEdit(request, env, resourceId);
    }

    if (request.method === 'POST' && /^\/api\/resources\/[^/]+\/regenerate$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[3];
      return handleResourceRegenerate(request, env, resourceId);
    }

    if (request.method === 'POST' && url.pathname === '/api/payment/initialize') {
      return handlePaymentInitialize(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/payment/status') {
      return handlePaymentStatus(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/payment/webhook') {
      return handlePaystackWebhook(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/subscription/cancel') {
      return handleSubscriptionCancel(request, env);
    }

    // ── Reminders ──────────────────────────────────────

    if (request.method === 'POST' && url.pathname === '/api/reminders') {
      return handleReminderCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/reminders') {
      return handleReminderList(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/reminders/subscribe') {
      return handleSubscribe(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/reminders/unsubscribe') {
      return handleUnsubscribe(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/reminders/test-notification') {
      return handleTestNotification(request, env);
    }

    if (request.method === 'PATCH' && /^\/api\/reminders\/[^/]+$/.test(url.pathname)) {
      const reminderId = url.pathname.split('/')[3];
      return handleReminderUpdate(request, env, reminderId);
    }

    if (request.method === 'DELETE' && /^\/api\/reminders\/[^/]+$/.test(url.pathname)) {
      const reminderId = url.pathname.split('/')[3];
      return handleReminderDelete(request, env, reminderId);
    }

    // ── Social Scheduler (Facebook/Instagram, via the Facebook connector) ─
    // Placed above the generic /api/connectors/:provider routes below only
    // because it lives right next to them conceptually — order doesn't
    // matter here since none of these paths overlap /api/connectors/*.

    if (request.method === 'GET' && url.pathname === '/api/social/pages') {
      return handleSocialPagesList(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/social/schedule') {
      return handleScheduleCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/social/schedule') {
      return handleScheduleList(request, env);
    }

    if (request.method === 'DELETE' && /^\/api\/social\/schedule\/[^/]+$/.test(url.pathname)) {
      const postId = url.pathname.split('/')[4];
      return handleScheduleCancel(request, env, postId);
    }

    // Upload a photo/video to attach to a scheduled post (requireAuth,
    // like every other /api/social/* route above).
    if (request.method === 'POST' && url.pathname === '/api/social/media') {
      return handleSocialMediaUpload(request, env);
    }

    // Hit directly by Meta's Graph API servers when publishing a post
    // that has media attached — never by the browser, so it deliberately
    // sits outside requireAuth. See social-media-endpoint.js's header
    // comment for why a signed token is the access check here instead.
    if (request.method === 'GET' && url.pathname === '/api/social/media/file') {
      return handleSocialMediaProxy(request, env);
    }

    // ── AI Inbox (unified Facebook/Instagram comment + DM triage) ──────
    // Sits right after Social Scheduler, same style of comment header.

    if (request.method === 'GET' && url.pathname === '/api/inbox') {
      return handleInboxList(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/inbox/subscribe') {
      return handleInboxSubscribe(request, env);
    }

    if (request.method === 'POST' && /^\/api\/inbox\/[^/]+\/regenerate$/.test(url.pathname)) {
      const itemId = url.pathname.split('/')[3];
      return handleInboxRegenerate(request, env, itemId);
    }

    if (request.method === 'POST' && /^\/api\/inbox\/[^/]+\/reply$/.test(url.pathname)) {
      const itemId = url.pathname.split('/')[3];
      return handleInboxReply(request, env, itemId);
    }

    if (request.method === 'POST' && /^\/api\/inbox\/[^/]+\/dismiss$/.test(url.pathname)) {
      const itemId = url.pathname.split('/')[3];
      return handleInboxDismiss(request, env, itemId);
    }

    if (request.method === 'POST' && /^\/api\/inbox\/[^/]+\/spam$/.test(url.pathname)) {
      const itemId = url.pathname.split('/')[3];
      return handleInboxMarkSpam(request, env, itemId);
    }

    // Hit directly by Meta's servers — Webhooks product, separate from
    // the OAuth login flow. No Authorization header will ever be
    // present, same category as the Data Deletion callback above, so it
    // deliberately sits outside requireAuth; handleMetaWebhookEvent does
    // its own HMAC-signature check on the raw body instead.
    if (request.method === 'GET' && url.pathname === '/webhooks/meta') {
      return handleMetaWebhookVerify(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/meta') {
      return handleMetaWebhookEvent(request, env, ctx);
    }

    // ── AI Insights Digest (AI-written performance report as PDF) ─────

    if (request.method === 'GET' && url.pathname === '/api/insights/schedule') {
      return handleInsightsScheduleGet(request, env);
    }

    if (request.method === 'PUT' && url.pathname === '/api/insights/schedule') {
      return handleInsightsScheduleUpsert(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/insights/generate') {
      return handleInsightsGenerate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/insights/history') {
      return handleInsightsHistory(request, env);
    }

    // Hit directly by the browser (email link click) or a WhatsApp link
    // preview fetch — no Authorization header possible, signed token is
    // the access check, same pattern as /api/social/media/file above.
    if (request.method === 'GET' && url.pathname === '/api/insights/file') {
      return handleInsightsFileProxy(request, env);
    }

    // ── Connectors (GitHub, Google, Facebook, Canva) ─────

    // Must come before the /:provider/start check below, since both
    // match a "/api/connectors/<segment>" shape.
    if (request.method === 'GET' && url.pathname === '/api/connectors/status') {
      return handleConnectorStatus(request, env);
    }

    if (request.method === 'GET' && /^\/api\/connectors\/[^/]+\/start$/.test(url.pathname)) {
      const provider = url.pathname.split('/')[3];
      return handleConnectorStart(request, env, provider);
    }

    if (request.method === 'POST' && /^\/api\/connectors\/[^/]+\/disconnect$/.test(url.pathname)) {
      const provider = url.pathname.split('/')[3];
      return handleConnectorDisconnect(request, env, provider);
    }

    // Hit directly by the provider's redirect after the user approves
    // (or denies) access — not an /api/ route, no Authorization header
    // will ever be present here. See connectors-endpoint.js for why.
    if (request.method === 'GET' && /^\/auth\/[^/]+\/callback$/.test(url.pathname)) {
      const provider = url.pathname.split('/')[2];
      return handleConnectorCallback(request, env, provider);
    }

    // ── Meta "Data Deletion Request" callback ──────────────────────────
    // Hit directly by Meta's servers (both the login app and the social/
    // connector app point at this same URL — see facebook-data-deletion.js
    // for how it tells the two apart). No Authorization header, no CORS
    // concerns: this is a server-to-server POST, never a browser fetch.
    if (request.method === 'POST' && url.pathname === '/auth/facebook/data-deletion') {
      return handleFacebookDataDeletion(request, env);
    }

    // Public status lookup for the confirmation code the callback above
    // hands back to Meta (and that a person may be shown by Meta's UI).
    if (request.method === 'GET' && /^\/api\/data-deletion-status\/[^/]+$/.test(url.pathname)) {
      const code = url.pathname.split('/')[3];
      return handleDataDeletionStatus(request, env, code);
    }

    // Called by the frontend right after "Continue with Facebook" signs
    // someone in, so a later data-deletion callback from the login app
    // can be traced back to this uid. Authenticated — see js/auth.js.
    if (request.method === 'POST' && url.pathname === '/api/auth/link-facebook') {
      return handleLinkFacebookLogin(request, env);
    }

    // ── One-time first-admin bootstrap ────────────────────────────────

    if (request.method === 'POST' && url.pathname === '/api/admin/bootstrap') {
      return handleAdminBootstrap(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/whoami') {
      return handleAdminWhoAmI(request, env);
    }

    // ── Admin/moderator role management (requires role: 'admin') ─────

    if (request.method === 'GET' && url.pathname === '/api/admin/roles') {
      return handleAdminRoleList(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/roles/grant') {
      return handleAdminRoleGrant(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/roles/revoke') {
      return handleAdminRoleRevoke(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/roles/lookup-email') {
      return handleAdminRoleLookupEmail(request, env);
    }

    // ── Admin: resources ──────────────────────────────────────────────

    if (request.method === 'POST' && url.pathname === '/api/admin/resources/batch') {
      return handleAdminResourceBatchCreate(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/admin/resources') {
      return handleAdminResourceCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/resources') {
      return handleAdminResourceList(request, env);
    }

    // Must come before the plain "/api/admin/resources/:id" checks below,
    // since /transition and /versions both match a two-segment tail too.
    if (request.method === 'POST' && /^\/api\/admin\/resources\/[^/]+\/transition$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceTransition(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/admin\/resources\/[^/]+\/versions$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceVersions(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/admin\/resources\/[^/]+$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceGet(request, env, resourceId);
    }

    if (request.method === 'POST' && /^\/api\/admin\/resources\/[^/]+$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceEdit(request, env, resourceId);
    }

    if (request.method === 'DELETE' && /^\/api\/admin\/resources\/[^/]+$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleAdminResourceDelete(request, env, resourceId);
    }

    // ── Admin: collections ───────────────────────────────────────────

    if (request.method === 'POST' && url.pathname === '/api/admin/collections') {
      return handleCollectionCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/admin/collections') {
      return handleAdminCollectionList(request, env);
    }

    if (request.method === 'POST' && /^\/api\/admin\/collections\/[^/]+\/resources$/.test(url.pathname)) {
      const collectionId = url.pathname.split('/')[4];
      return handleCollectionResourceEdit(request, env, collectionId);
    }

    if (request.method === 'POST' && /^\/api\/admin\/collections\/[^/]+$/.test(url.pathname)) {
      const collectionId = url.pathname.split('/')[4];
      return handleCollectionEdit(request, env, collectionId);
    }

    if (request.method === 'DELETE' && /^\/api\/admin\/collections\/[^/]+$/.test(url.pathname)) {
      const collectionId = url.pathname.split('/')[4];
      return handleCollectionDelete(request, env, collectionId);
    }

    // ── User-facing library (published curated resources) ────────────

    if (request.method === 'GET' && url.pathname === '/api/library/collections') {
      return handlePublicCollectionList(request, env);
    }

    if (request.method === 'GET' && /^\/api\/library\/collections\/[^/]+$/.test(url.pathname)) {
      const collectionId = url.pathname.split('/')[4];
      return handleLibraryCollectionGet(request, env, collectionId);
    }

    if (request.method === 'GET' && url.pathname === '/api/library/resources') {
      return handleLibraryList(request, env);
    }

    if (request.method === 'POST' && /^\/api\/library\/resources\/[^/]+\/download$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleLibraryDownload(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/library\/resources\/[^/]+\/file$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleLibraryFileProxy(request, env, resourceId);
    }

    if (request.method === 'GET' && /^\/api\/library\/resources\/[^/]+$/.test(url.pathname)) {
      const resourceId = url.pathname.split('/')[4];
      return handleLibraryGet(request, env, resourceId, ctx);
    }

    return new Response(JSON.stringify({ error: 'Not found.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  // Fires on the Cron Trigger set in wrangler.jsonc (currently every 5
  // minutes — frequent enough for all four jobs below without changing
  // any of their existing latency).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runReminderScheduler(env));
    ctx.waitUntil(runSocialScheduler(env));
    ctx.waitUntil(runInsightsDigestScheduler(env));
  },
};
