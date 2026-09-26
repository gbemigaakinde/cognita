// js/app.js
// Cognita main app behavior. Talks to the Worker exclusively through
// window.Auth.authedFetch — never calls Groq/OpenRouter/Paystack/etc
// directly, and never constructs a request containing a provider or
// model name. The Worker decides all of that.
//
// Exports mount(), called once by js/router.js the first time the chat
// view is opened. Sidebar chrome (collapse/account menu/sign-out) is
// owned by js/shell.js, not here.

import { escapeHtml, showToast, closeMobileSidebar, renderAccountInfo } from './shell.js';

const WORKER_URL = 'https://api.cognita.com.ng';
const HISTORY_KEY = 'cognita:conversations';

const QUALITY_META = {
  standard: { label: 'Standard' },
  advanced: { label: 'Advanced' },
  thorough: { label: 'Thorough' },
  v0: { label: 'v0 (Admin)' },
};

// Short phrases only — long sentences don't fit well as a placeholder.
const PLACEHOLDERS = [
  'Message Cognita',
  'Ask anything',
  'Draft, plan, explain',
  "What's on your mind?",
];

const TYPE_SPEED_MS = 65;      // per character while typing
const DELETE_SPEED_MS = 35;    // per character while deleting
const HOLD_AFTER_TYPE_MS = 1800; // pause once a phrase is fully typed
const RESUME_AFTER_IDLE_MS = 4000; // wait after user goes idle before resuming

// Image types we'll try to send to the vision model. Anything else (pdf,
// docx, etc.) is either extracted client-side (see below) or flagged to
// the user rather than silently dropped.
const IMAGE_MIME_RE = /^image\/(png|jpe?g|webp|gif)$/i;
const TEXT_FILE_RE = /\.(txt|csv)$/i;
const TEXT_MIME_TYPES = ['text/plain', 'text/csv'];
const PDF_FILE_RE = /\.pdf$/i;
const PDF_MIME = 'application/pdf';
const DOCX_FILE_RE = /\.docx$/i;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const DOC_FILE_RE = /\.doc$/i; // legacy .doc — mammoth can't read this, flagged unsupported

// Guard against sending enormous extracted text to the model — trim and
// note that it was trimmed rather than silently truncating.
const MAX_EXTRACTED_CHARS = 40000;

// Mime types for AI-generated document downloads, keyed by the "format"
// the /api/document endpoint returns. Kept in sync with document-endpoint.js.
const EXPORT_MIME_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const PENDING_DELETES_KEY = 'cognita:pendingDeletes';
const RECONCILE_THROTTLE_MS = 60000; // don't hit B2's list endpoint more than once a minute
let _lastReconcileAt = 0;

let currentQuality = 'standard';
let conversation = []; // { role: 'user'|'assistant', content: string, attachments?: [...], documentFile?: {...} }
let conversationMeta = [];
// Conversation-scoped record of connected-app write actions the user has
// already approved in THIS conversation (see Bug 4 in the audit doc —
// "confirmation re-asked despite explicit prior consent"). Sent back to
// the backend on every /api/chat call for this conversation so it can
// skip re-prompting for the exact same provider+scope+action; never
// copied to a different conversation, never sent for a different one.
// Shape: [{ provider, scope, approvedActionClasses: string[] }]
let conversationApprovals = [];
let currentConversationId = null;
let isSending = false;
let activeThinkingTimers = {};
let freshAssistantIndex = -1; // index of the just-received assistant reply to type out; -1 = none pending

let placeholderIndex = 0;
let placeholderTimeoutId = null;
let placeholderResumeTimeoutId = null;
let placeholderRunning = false;

// Attachments staged in the composer before the message is sent.
// { name, kind: 'image'|'text'|'unsupported', dataUrl?, base64?, mimeType?, text? }
let pendingAttachments = [];

let currentAccountPlanId = null;
let currentAccountHasVision = false;
let currentAccountHasDocExport = false;
let currentAccountChatTiers = ['fast'];
// Can this plan actually use connected-app tools (GitHub/Google/Facebook/
// Canva) in chat? Mirrors entitlements.js features.connectorTools —
// see updateConnectorsAvailability, which uses this to lock the
// "Connected apps" entry point instead of letting a Free-tier user
// walk through an OAuth flow that chat will never use.
let currentAccountHasConnectorTools = false;
let visualKind = 'diagram';
let documentDocType = 'letter';
let documentFormat = 'docx';

const THINKING_WORDS = [
  'Thinking',
  'Reasoning',
  'Working through it',
  'Digging into it',
  'Considering the angles',
  'Piecing it together',
];

/* ════════════════════════════════════════════════════════
   INIT
════════════════════════════════════════════════════════ */

export async function mount() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return; // already redirected to login

  renderAccountInfo(user);
  await refreshUsage();
  await refreshAccount();

  renderSidebarHistory();
  updateConversationTitle();
  wireComposer();
  wireAttachMenu();
  wireQualityPicker();
  wireVisualModal();
  wireDocumentModal();
  wireConnectorsModal();
  showConnectorRedirectBanner();
  wireComposerSuggestions();
  startPlaceholderTypewriter();

  window.addEventListener('cognita:new-chat', startNewConversation);

  reconcileIfDue();
  window.addEventListener('focus', reconcileIfDue);

  const overlay = document.getElementById('appLoadingOverlay');
  const contentWrap = document.getElementById('appContentWrap');
  if (overlay) overlay.hidden = true;
  if (contentWrap) contentWrap.hidden = false;
}

/* ════════════════════════════════════════════════════════
   ACCOUNT / USAGE DISPLAY
════════════════════════════════════════════════════════ */

async function refreshAccount() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/account');
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('accountPlan').textContent = data.planName;
    document.getElementById('accountPlan').classList.remove('skeleton');
    document.getElementById('accountEmail').classList.remove('skeleton');

    currentAccountPlanId = data.planId;
    currentAccountHasVision = !!(data.models && data.models.vision);
    currentAccountHasDocExport = !!(data.features && data.features.documentExport);
    currentAccountChatTiers = (data.models && Array.isArray(data.models.chat)) ? data.models.chat : ['fast'];
    currentAccountHasConnectorTools = !!(data.features && data.features.connectorTools);

    // Reveal the admin-panel shortcut for curation staff only. Purely
    // cosmetic — admin.html's own server-side checks (requireAdmin) are
    // what actually gate access, this just avoids showing a dead link.
    const adminPanelLink = document.getElementById('adminPanelLink');
    if (adminPanelLink) adminPanelLink.hidden = !(data.role === 'admin' || data.role === 'moderator');

    const upgradeLink = document.getElementById('upgradeLink');
    if (data.planId !== 'studio' && data.planId !== 'admin') {
      upgradeLink.hidden = false;
    }

    // Vision (image attachment / illustration generation) is gated by
    // plan. Reflect that in the attach menu so lower-plan users get a
    // clear affordance instead of a dead click.
    updateImageAttachAvailability();
    // Same idea for the quality picker: lock out tiers the plan doesn't
    // actually have access to, instead of letting the person pick one
    // and silently get a lower tier back with no explanation.
    updateQualityPickerAvailability();
    // Same idea again for connected apps: Free-tier chat can never
    // actually call a connector tool (see chat-endpoint.js
    // connectorToolsEnabled), so reflect that up front instead of
    // letting the person complete a whole OAuth flow for nothing.
    updateConnectorsAvailability();
  } catch (e) {
    console.error('[app] Could not load account:', e.message);
  }
}

function updateImageAttachAvailability() {
  const illustrationItem = document.getElementById('attachIllustrationItem');
  if (illustrationItem) {
    illustrationItem.classList.toggle('is-locked', !currentAccountHasVision);
    illustrationItem.title = currentAccountHasVision
      ? 'Generate a realistic illustration'
      : 'Realistic illustrations are available on Cognita Plus and above';
  }
}

// Maps a quality-picker option's data-quality value to the internal tier
// key used by entitlements.js / the backend, so availability can be
// checked against the plan's actual allowed chat tiers.
function _tierKeyForQuality(quality) {
  if (quality === 'thorough') return 'reasoning';
  if (quality === 'advanced') return 'advanced';
  if (quality === 'v0') return 'v0';
  return 'fast';
}

// Locks out quality-picker options the current plan isn't entitled to,
// so the person can never successfully select a tier they don't have —
// instead of picking one and silently getting a lower tier back with no
// explanation.
function updateQualityPickerAvailability() {
  document.querySelectorAll('.quality-picker-option').forEach((opt) => {
    const tierKey = _tierKeyForQuality(opt.dataset.quality);
    const entitled = currentAccountChatTiers.includes(tierKey);
    opt.classList.toggle('is-locked', !entitled);
    opt.title = entitled ? '' : 'This quality level requires a higher Cognita plan.';
  });

  // v0 isn't just locked for non-admins, it's not a real option for
  // them at all (see entitlements.js PLANS.admin) — hide it outright
  // rather than showing a lock icon for something no upgrade can buy.
  const v0Option = document.getElementById('qualityOptionV0');
  if (v0Option) {
    const hasV0 = currentAccountChatTiers.includes('v0');
    v0Option.hidden = !hasV0;
    v0Option.title = '';
    // If the account lost admin status mid-session while v0 was
    // selected, fall back to standard instead of leaving the picker
    // showing a quality the account can no longer use.
    if (!hasV0 && currentQuality === 'v0') setQuality('standard');
  }
}

// Locks the "Connected apps" attach-menu entry the same way the
// illustration/quality-picker entries are locked: dimmed, with a lock
// badge and an explanatory tooltip, rather than looking identical to
// every other (fully usable) attach option. Unlike those, this item
// still opens the modal when locked (see wireAttachMenu) rather than
// blocking the click outright, because the modal itself is also where
// someone who downgraded mid-subscription would go to disconnect an
// app they can no longer use — that management action has to stay
// reachable regardless of plan. loadConnectorsList() and
// wireConnectorsModal() are what actually stop a Free-tier user from
// finishing a *new* connection once the modal is open.
function updateConnectorsAvailability() {
  const connectorsItem = document.getElementById('attachConnectorsItem');
  if (connectorsItem) {
    connectorsItem.classList.toggle('is-locked', !currentAccountHasConnectorTools);
    connectorsItem.title = currentAccountHasConnectorTools
      ? 'View and manage connected apps'
      : 'Connecting apps requires Cognita Plus or higher. You can still view this here.';
  }
}

async function refreshUsage() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/usage');
    if (!res.ok) return;
    const data = await res.json();

    const { used, limit } = data.usage.messages;
    const usageEl = document.getElementById('usageMessages');
    // entitlements.js's UNLIMITED sentinel (999999) is a real, comparable
    // number for the backend's quota math, but showing it raw ("3 / 999999")
    // would be a confusing display for an admin account — show "Unlimited"
    // instead once the limit is clearly not a real day-to-day cap.
    const isUnlimited = limit >= 999999;
    usageEl.textContent = isUnlimited ? 'Unlimited' : (used + ' / ' + limit);
    usageEl.classList.remove('skeleton');

    const pct = (!isUnlimited && limit > 0) ? Math.min(100, (used / limit) * 100) : 0;
    const fill = document.getElementById('usageMessagesBar');
    fill.style.width = pct + '%';
    fill.classList.toggle('is-near-limit', pct >= 70 && pct < 100);
    fill.classList.toggle('is-at-limit', pct >= 100);
  } catch (e) {
    console.error('[app] Could not load usage:', e.message);
  }
}

/* ════════════════════════════════════════════════════════
   CONVERSATION TITLE (live, shown in the topbar)
════════════════════════════════════════════════════════ */

function deriveTitle(messages) {
  const firstUser = messages.find((m) => m.role === 'user');
  if (!firstUser) return 'New chat';
  const hasImage = !!(firstUser.attachments && firstUser.attachments.some((a) => a.kind === 'image'));
  const text = (firstUser.content || (hasImage ? 'Image' : '')).trim().replace(/\s+/g, ' ');
  return text.length > 60 ? text.slice(0, 60) + '…' : (text || 'New chat');
}

function updateConversationTitle() {
  const titleEl = document.getElementById('conversationTitle');
  titleEl.textContent = deriveTitle(conversation);
}

/* ════════════════════════════════════════════════════════
   CHAT HISTORY (persisted client-side in localStorage, mirrored to
   Backblaze B2 server-side so it isn't lost if local storage is cleared)
════════════════════════════════════════════════════════ */

function loadAllConversations() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error('[app] Could not read chat history:', e.message);
    return [];
  }
}

function saveAllConversations(list) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('[app] Could not persist chat history:', e.message);
  }
}

function makeConversationId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

// Ensures a conversation id exists before an action that needs one to
// scope server-side data (e.g. generating a document that should be
// retrievable later). Does NOT persist anything by itself — the caller
// still needs to trigger persistCurrentConversation() once there's an
// actual message to save, same as before. This just avoids generating a
// document against a null id and losing the ability to re-fetch it.
function ensureConversationId() {
  if (!currentConversationId) {
    currentConversationId = makeConversationId();
  }
  return currentConversationId;
}

function loadPendingDeletes() {
  try {
    const raw = localStorage.getItem(PENDING_DELETES_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function savePendingDeletes(list) {
  try {
    localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(list));
  } catch (e) {
    console.error('[app] Could not persist pending deletes:', e.message);
  }
}

// Best-effort mirror of a sidebar delete to B2. Returns whether it
// actually succeeded, so callers can track it as pending and retry later
// rather than assuming a fire-and-forget call landed.
async function deleteConversationFromB2(conversationId) {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
    return res.ok;
  } catch (e) {
    console.error('[app] Could not delete conversation from storage:', e.message);
    return false;
  }
}

// Retries any deletes that haven't been confirmed by the server yet.
// Called at the start of every reconciliation pass so a delete made while
// offline doesn't get silently forgotten, and — critically — so a
// not-yet-confirmed delete never gets treated as "missing" and resurrected
// during reconciliation (see reconcileWithB2's pendingDeletes.includes check).
async function flushPendingDeletes() {
  const pending = loadPendingDeletes();
  if (pending.length === 0) return;

  const stillPending = [];
  for (const id of pending) {
    const ok = await deleteConversationFromB2(id);
    if (!ok) stillPending.push(id);
  }
  savePendingDeletes(stillPending);
}

// Best-effort mirror of a conversation to B2. Never blocks the UI and
// never surfaces errors to the user. On success, records the server's own
// timestamp for this save (remoteSyncedAt) so later reconciliation can
// tell "I already have this version" from "the server has something
// newer" without trusting client clocks.
async function syncConversationToB2(entry) {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: entry.id, conversation: entry }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!data.serverUpdatedAt) return;

    const all = loadAllConversations();
    const idx = all.findIndex((c) => c.id === entry.id);
    if (idx >= 0) {
      all[idx].remoteSyncedAt = data.serverUpdatedAt;
      saveAllConversations(all);
    }
  } catch (e) {
    console.error('[app] Could not sync conversation to storage:', e.message);
  }
}

// Fetches one conversation's full body from B2 and merges it into local
// storage, replacing whatever placeholder or stale copy was there. If
// it's the conversation currently open on screen, re-renders it too.
async function fetchAndMergeConversation(id, serverUpdatedAt) {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat/' + id);
    if (!res.ok) return;
    const data = await res.json();
    if (!data.conversation) return;

    const all = loadAllConversations();
    const idx = all.findIndex((c) => c.id === id);
    const merged = { ...data.conversation, id, remoteSyncedAt: serverUpdatedAt, notLoaded: false };
    if (idx >= 0) all[idx] = merged; else all.push(merged);
    saveAllConversations(all);

    if (id === currentConversationId) {
      conversation = merged.messages || [];
      conversationMeta = merged.meta || [];
      conversationApprovals = merged.approvals || [];
      if (merged.quality) setQuality(merged.quality);
      renderConversation();
      updateConversationTitle();
    }
    renderSidebarHistory();
  } catch (e) {
    console.error('[app] Could not fetch conversation from storage:', e.message);
  }
}

// Reconciles local chat history against what B2 actually has. Timestamp
// rule throughout: whichever of "edited" vs "deleted" happened later,
// wins. Never mutates local storage on a failed or malformed server
// response — a network hiccup must never be read as "everything's gone."
async function reconcileWithB2() {
  await flushPendingDeletes();

  let serverList;
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/chat/list');
    if (!res.ok) return;
    const data = await res.json();
    if (!Array.isArray(data.conversations)) return;
    serverList = data.conversations;
  } catch (e) {
    console.error('[app] Could not list remote conversations:', e.message);
    return;
  }

  const pendingDeletes = loadPendingDeletes();
  const serverMap = new Map(serverList.map((c) => [c.conversationId, c]));
  const all = loadAllConversations();
  let changed = false;

  for (const local of all.slice()) {
    if (pendingDeletes.includes(local.id)) continue; // delete not yet confirmed — don't touch

    const remote = serverMap.get(local.id);

    if (!remote) {
      // Server has never seen this one. Only push it if we've never
      // successfully synced it — otherwise it may have fallen off an old
      // listing page or is mid-lifecycle-purge, not worth re-pushing blind.
      if (!local.remoteSyncedAt) syncConversationToB2(local);
      continue;
    }

    if (remote.status === 'deleted') {
      if (local.updatedAt > remote.serverUpdatedAt) {
        // Edited here after it was deleted elsewhere — the edit is the
        // more recent intent, so it wins and gets pushed back up.
        syncConversationToB2(local);
      } else {
        const idx = all.findIndex((c) => c.id === local.id);
        if (idx >= 0) { all.splice(idx, 1); changed = true; }
        if (local.id === currentConversationId) {
          currentConversationId = null;
          conversation = [];
          conversationMeta = [];
          conversationApprovals = [];
          renderConversation();
          updateConversationTitle();
          showToast('This chat was deleted from another device.');
        }
      }
      continue;
    }

    // remote.status === 'live'
    const serverIsNewer = !local.remoteSyncedAt || remote.serverUpdatedAt > local.remoteSyncedAt;
    const localHasNoUnpushedEdit = local.remoteSyncedAt && local.updatedAt <= local.remoteSyncedAt;
    if (serverIsNewer && (localHasNoUnpushedEdit || !local.remoteSyncedAt)) {
      fetchAndMergeConversation(local.id, remote.serverUpdatedAt);
    }
  }

  // Chats that exist on the server but not locally at all (new device, or
  // started elsewhere) — add a lightweight placeholder; full content
  // loads lazily only when opened, so this never downloads N bodies
  // just to populate the sidebar.
  for (const remote of serverList) {
    if (remote.status !== 'live') continue;
    if (all.some((c) => c.id === remote.conversationId)) continue;
    all.push({
      id: remote.conversationId,
      title: 'Untitled chat',
      messages: [],
      meta: [],
      quality: 'standard',
      updatedAt: remote.serverUpdatedAt,
      remoteSyncedAt: remote.serverUpdatedAt,
      notLoaded: true,
    });
    changed = true;
  }

  if (changed) {
    saveAllConversations(all);
    renderSidebarHistory();
  }
}

function reconcileIfDue() {
  const now = Date.now();
  if (now - _lastReconcileAt < RECONCILE_THROTTLE_MS) return;
  _lastReconcileAt = now;
  reconcileWithB2();
}

// Called after every completed exchange so the sidebar and title always
// reflect what's on screen. Creates a new saved entry on first message,
// updates the existing one afterward.
function persistCurrentConversation() {
  if (conversation.length === 0) return;

  if (!currentConversationId) {
    currentConversationId = makeConversationId();
  }

  const all = loadAllConversations();
  const existingIndex = all.findIndex((c) => c.id === currentConversationId);
  const existing = existingIndex >= 0 ? all[existingIndex] : null;

  const entry = {
    id: currentConversationId,
    title: deriveTitle(conversation),
    messages: conversation,
    meta: conversationMeta,
    approvals: conversationApprovals,
    quality: currentQuality,
    updatedAt: Date.now(),
    remoteSyncedAt: existing ? existing.remoteSyncedAt : undefined,
  };

  if (existingIndex >= 0) {
    all[existingIndex] = entry;
  } else {
    all.unshift(entry);
  }

  saveAllConversations(all);
  renderSidebarHistory();
  syncConversationToB2(entry);
}

function renderSidebarHistory() {
  const nav = document.getElementById('sidebarHistory');
  const all = loadAllConversations().sort((a, b) => b.updatedAt - a.updatedAt);

  if (all.length === 0) {
    nav.innerHTML = '<div class="sidebar-history-empty">Your chats will appear here</div>';
    return;
  }

  nav.innerHTML = all.map((c) => (
    '<button class="sidebar-history-item' + (c.id === currentConversationId ? ' is-active' : '') + '" data-id="' + c.id + '">' +
      '<span>' + escapeHtml(c.title) + '</span>' +
      '<span class="history-delete-btn" data-delete-id="' + c.id + '" title="Delete chat"><i class="ph ph-x"></i></span>' +
    '</button>'
  )).join('');

  nav.querySelectorAll('.sidebar-history-item').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-id]')) return;
      loadConversation(btn.dataset.id);
    });
  });

  nav.querySelectorAll('[data-delete-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteConversation(btn.dataset.deleteId);
    });
  });
}

function loadConversation(id) {
  const all = loadAllConversations();
  const entry = all.find((c) => c.id === id);
  if (!entry) return;

  currentConversationId = entry.id;

  if (entry.notLoaded) {
    conversation = [];
    conversationMeta = [];
    conversationApprovals = [];
    renderConversation();
    updateConversationTitle();
    renderSidebarHistory();
    closeMobileSidebar();
    fetchAndMergeConversation(id, entry.remoteSyncedAt);
    return;
  }

  conversation = entry.messages;
  conversationMeta = entry.meta || [];
  conversationApprovals = entry.approvals || [];
  if (entry.quality) setQuality(entry.quality);
  renderConversation();
  updateConversationTitle();
  renderSidebarHistory();
  closeMobileSidebar();
}

function deleteConversation(id) {
  const all = loadAllConversations().filter((c) => c.id !== id);
  saveAllConversations(all);

  const pending = loadPendingDeletes();
  if (!pending.includes(id)) {
    pending.push(id);
    savePendingDeletes(pending);
  }

  deleteConversationFromB2(id).then((ok) => {
    if (ok) savePendingDeletes(loadPendingDeletes().filter((pid) => pid !== id));
  });

  if (id === currentConversationId) {
    currentConversationId = null;
    conversation = [];
    conversationMeta = [];
    conversationApprovals = [];
    renderConversation();
    updateConversationTitle();
  }

  renderSidebarHistory();
}

/* ════════════════════════════════════════════════════════
   SIDEBAR
════════════════════════════════════════════════════════ */

// Reset-to-a-blank-conversation, triggered either by clicking New Chat
// while already on the chat view, or via the 'cognita:new-chat' event
// dispatched by js/router.js when New Chat is clicked from another view.
function startNewConversation() {
  currentConversationId = null;
  conversation = [];
  conversationMeta = [];
  conversationApprovals = [];
  renderConversation();
  updateConversationTitle();
  renderSidebarHistory();
  closeMobileSidebar();
}

/* ════════════════════════��═══════════════════════════════
   QUALITY PICKER
════════════════════════════════════════════════════════ */

function setQuality(quality) {
  currentQuality = quality;
  const meta = QUALITY_META[quality] || QUALITY_META.standard;

  document.getElementById('qualityPickerLabel').textContent = meta.label;

  document.querySelectorAll('.quality-picker-option').forEach((opt) => {
    opt.classList.toggle('is-active', opt.dataset.quality === quality);
  });
}

function wireQualityPicker() {
  const trigger = document.getElementById('qualityPickerTrigger');
  const menu = document.getElementById('qualityPickerMenu');
  const options = document.querySelectorAll('.quality-picker-option');

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
    trigger.setAttribute('aria-expanded', String(!isOpen));
  });

  document.addEventListener('click', () => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  });

  options.forEach((opt) => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      const tierKey = _tierKeyForQuality(opt.dataset.quality);
      if (!currentAccountChatTiers.includes(tierKey)) {
        showToast('This quality level requires a higher Cognita plan. Upgrade to unlock it.');
        menu.hidden = true;
        trigger.setAttribute('aria-expanded', 'false');
        return;
      }
      setQuality(opt.dataset.quality);
      menu.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    });
  });
}

/* ════════════════════════════════════════════════════════
   COMPOSER PLACEHOLDER — TYPEWRITER EFFECT
════════════════════════════════════════════════════════ */

function startPlaceholderTypewriter() {
  if (placeholderRunning) return;
  placeholderRunning = true;
  typeCurrentPlaceholder(0);
}

function stopPlaceholderTypewriter() {
  placeholderRunning = false;
  if (placeholderTimeoutId) {
    clearTimeout(placeholderTimeoutId);
    placeholderTimeoutId = null;
  }
}

function typeCurrentPlaceholder(charIndex) {
  if (!placeholderRunning) return;
  const input = document.getElementById('composerInput');
  if (!input || input.value) { placeholderRunning = false; return; }

  const phrase = PLACEHOLDERS[placeholderIndex];
  input.placeholder = phrase.slice(0, charIndex);

  if (charIndex < phrase.length) {
    placeholderTimeoutId = setTimeout(() => typeCurrentPlaceholder(charIndex + 1), TYPE_SPEED_MS);
  } else {
    placeholderTimeoutId = setTimeout(() => deleteCurrentPlaceholder(phrase.length), HOLD_AFTER_TYPE_MS);
  }
}

function deleteCurrentPlaceholder(charIndex) {
  if (!placeholderRunning) return;
  const input = document.getElementById('composerInput');
  if (!input || input.value) { placeholderRunning = false; return; }

  const phrase = PLACEHOLDERS[placeholderIndex];
  input.placeholder = phrase.slice(0, charIndex);

  if (charIndex > 0) {
    placeholderTimeoutId = setTimeout(() => deleteCurrentPlaceholder(charIndex - 1), DELETE_SPEED_MS);
  } else {
    placeholderIndex = (placeholderIndex + 1) % PLACEHOLDERS.length;
    placeholderTimeoutId = setTimeout(() => typeCurrentPlaceholder(0), 300);
  }
}

// Called on any composer activity: pause the effect immediately, and
// schedule it to resume a few seconds after the user goes quiet again.
function notifyComposerActivity() {
  stopPlaceholderTypewriter();
  if (placeholderResumeTimeoutId) clearTimeout(placeholderResumeTimeoutId);

  placeholderResumeTimeoutId = setTimeout(() => {
    const input = document.getElementById('composerInput');
    if (input && !input.value) {
      startPlaceholderTypewriter();
    }
  }, RESUME_AFTER_IDLE_MS);
}

/* ════════════════════════════════════════════════════════
   "+" ATTACH MENU
════════════════════════════════════════════════════════ */

function wireAttachMenu() {
  const trigger = document.getElementById('attachMenuTrigger');
  const menu = document.getElementById('attachMenuList');
  const filesItem = document.getElementById('attachFilesItem');
  const diagramItem = document.getElementById('attachDiagramItem');
  const illustrationItem = document.getElementById('attachIllustrationItem');
  const documentItem = document.getElementById('attachDocumentItem');
  const connectorsItem = document.getElementById('attachConnectorsItem');
  const noteTakerItem = document.getElementById('attachNoteTakerItem');
  const fileInput = document.getElementById('fileInput');

  function closeMenu() {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
    trigger.setAttribute('aria-expanded', String(!isOpen));
  });

  document.addEventListener('click', closeMenu);
  menu.addEventListener('click', (e) => e.stopPropagation());

  filesItem.addEventListener('click', () => {
    closeMenu();
    fileInput.click();
  });

  diagramItem.addEventListener('click', () => {
    closeMenu();
    openVisualModal('diagram');
  });

  illustrationItem.addEventListener('click', () => {
    closeMenu();
    openVisualModal('illustration');
  });

  documentItem.addEventListener('click', () => {
    closeMenu();
    openDocumentModal();
  });

  connectorsItem.addEventListener('click', () => {
  closeMenu();
  openConnectorsModal();
  });
  noteTakerItem.addEventListener('click', () => {
  closeMenu();
  window.dispatchEvent(new CustomEvent('cognita:open-note-taker'));
  });
  }

/* ════════════════════════════════════════════════════════
   COMPOSER + ATTACHMENTS + SENDING MESSAGES
════════════════════════════════════════════════════════ */

// Detects whether this device's primary input is touch (phones/tablets)
// rather than a mouse/trackpad with a real keyboard. Used to decide
// whether Enter should send the message or just insert a line break —
// on touch devices there's no reliable Shift key, so intercepting Enter
// there makes it impossible to ever add a line break.
function _isTouchPrimaryDevice() {
  return window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
}

function wireComposer() {
  const input = document.getElementById('composerInput');
  const sendBtn = document.getElementById('sendBtn');
  const fileInput = document.getElementById('fileInput');

  function refreshSendEnabled() {
    sendBtn.disabled = (!input.value.trim() && pendingAttachments.length === 0) || isSending;
  }

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    refreshSendEnabled();
    notifyComposerActivity();
  });

  input.addEventListener('focus', notifyComposerActivity);

  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;

    // Never treat Enter as "send" while an IME composition is in
    // progress (e.g. typing accented characters, or Chinese/Japanese/
    // Korean input) — that Enter is confirming the composed character,
    // not submitting the message. e.keyCode === 229 is the older
    // cross-browser signal some engines still rely on alongside
    // isComposing.
    if (e.isComposing || e.keyCode === 229) return;

    // On touch-primary devices (phones/tablets) there's no dependable
    // Shift key, so Enter always inserts a line break there — sending
    // happens via the send button instead. On keyboard-primary devices,
    // Enter sends and Shift+Enter inserts a line break, as before.
    if (_isTouchPrimaryDevice()) return;

    if (e.shiftKey) return;

    e.preventDefault();
    if (!sendBtn.disabled) sendMessage(input.value.trim());
  });

  sendBtn.addEventListener('click', () => {
    sendMessage(input.value.trim());
  });

  // Single picker handles images, plain text/csv, PDFs, and Word docs —
  // routed by mime type/extension once a file is chosen.
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;

    await handlePickedFile(file);
    renderComposerAttachments();
    refreshSendEnabled();
    input.focus();
  });
}

async function handlePickedFile(file) {
  const isImage = IMAGE_MIME_RE.test(file.type);
  const isTextLike = TEXT_MIME_TYPES.includes(file.type) || TEXT_FILE_RE.test(file.name);
  const isPdf = file.type === PDF_MIME || PDF_FILE_RE.test(file.name);
  const isDocx = file.type === DOCX_MIME || DOCX_FILE_RE.test(file.name);
  const isLegacyDoc = DOC_FILE_RE.test(file.name) && !isDocx;

  if (isImage) {
    await handleImageFile(file);
    return;
  }

  if (isTextLike) {
    try {
      const text = await file.text();
      pendingAttachments.push({ name: file.name, kind: 'text', text: _capText(text) });
    } catch (err) {
      console.error('[app] Could not read file:', err.message);
      showToast('Could not read that file.');
    }
    return;
  }

  if (isPdf) {
    if (!window.pdfjsLib) {
      pendingAttachments.push({ name: file.name, kind: 'unsupported' });
      showToast('PDF reading is still loading — try again in a moment.');
      return;
    }
    try {
      const text = await extractPdfText(file);
      pendingAttachments.push({ name: file.name, kind: 'text', text: _capText(text) });
    } catch (err) {
      console.error('[app] Could not read PDF:', err.message);
      pendingAttachments.push({ name: file.name, kind: 'unsupported' });
      showToast('Could not extract text from that PDF.');
    }
    return;
  }

  if (isDocx) {
    if (!window.mammoth) {
      pendingAttachments.push({ name: file.name, kind: 'unsupported' });
      showToast('Word document reading is still loading — try again in a moment.');
      return;
    }
    try {
      const text = await extractDocxText(file);
      pendingAttachments.push({ name: file.name, kind: 'text', text: _capText(text) });
    } catch (err) {
      console.error('[app] Could not read Word document:', err.message);
      pendingAttachments.push({ name: file.name, kind: 'unsupported' });
      showToast('Could not extract text from that document.');
    }
    return;
  }

  if (isLegacyDoc) {
    // Legacy binary .doc isn't readable by mammoth (which only handles
    // .docx). Flag it rather than pretending to read it.
    pendingAttachments.push({ name: file.name, kind: 'unsupported' });
    showToast('Old .doc files aren\'t supported yet — please use .docx.');
    return;
  }

  // pptx, xlsx, and anything else not yet wired for extraction.
  pendingAttachments.push({ name: file.name, kind: 'unsupported' });
}

function _capText(text) {
  if (text.length <= MAX_EXTRACTED_CHARS) return text;
  return text.slice(0, MAX_EXTRACTED_CHARS) + '\n\n[Content truncated — file was longer than could be included.]';
}

async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  if (window.pdfjsLib.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  const pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let text = '';
  const maxPages = Math.min(pdf.numPages, 30); // guard against huge scans
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((item) => item.str).join(' ') + '\n\n';
  }
  if (pdf.numPages > maxPages) {
    text += '[Only the first ' + maxPages + ' of ' + pdf.numPages + ' pages were read.]';
  }
  return text.trim();
}

async function extractDocxText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const result = await window.mammoth.extractRawText({ arrayBuffer });
  return (result.value || '').trim();
}

async function handleImageFile(file) {
  if (!IMAGE_MIME_RE.test(file.type)) {
    pendingAttachments.push({ name: file.name, kind: 'unsupported' });
    return;
  }
  if (!currentAccountHasVision) {
    showToast('Image understanding is available on Cognita Plus and above.');
    return;
  }

  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.split(',')[1];
    pendingAttachments.push({
      name: file.name,
      kind: 'image',
      dataUrl,
      base64,
      mimeType: file.type,
    });
  } catch (err) {
    console.error('[app] Could not read image:', err.message);
    showToast('Could not read that image.');
  }
}

function renderComposerAttachments() {
  const wrap = document.getElementById('composerAttachments');
  if (pendingAttachments.length === 0) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }

  wrap.hidden = false;
  wrap.innerHTML = pendingAttachments.map((att, i) => {
    if (att.kind === 'image') {
      return '<span class="attachment-chip attachment-chip-image">' +
        '<img src="' + att.dataUrl + '" alt="">' +
        '<span class="attachment-chip-name">' + escapeHtml(att.name) + '</span>' +
        '<button type="button" data-remove-attachment="' + i + '"><i class="ph ph-x"></i></button>' +
      '</span>';
    }
    const icon = att.kind === 'unsupported' ? 'warning' : 'file-text';
    const suffix = att.kind === 'unsupported' ? ' (not readable yet)' : '';
    return '<span class="attachment-chip">' +
      '<i class="ph ph-' + icon + '"></i>' +
      '<span class="attachment-chip-name">' + escapeHtml(att.name) + suffix + '</span>' +
      '<button type="button" data-remove-attachment="' + i + '"><i class="ph ph-x"></i></button>' +
    '</span>';
  }).join('');

  wrap.querySelectorAll('[data-remove-attachment]').forEach((btn) => {
    btn.addEventListener('click', () => {
      pendingAttachments.splice(parseInt(btn.dataset.removeAttachment, 10), 1);
      renderComposerAttachments();
      const input = document.getElementById('composerInput');
      document.getElementById('sendBtn').disabled = !input.value.trim() && pendingAttachments.length === 0;
    });
  });
}

// The four prompt chips live at the top of the composer now (not in the
// empty state), and are meant to be a brief nudge on a fresh sign-in —
// not a permanent fixture the user has to look past every time they
// open the chat. sessionStorage means they reappear on the next real
// login (new tab/session) but not on every view switch within one.
//
// Behaviour:
//  - Tapping a chip only FILLS the message box with that prompt (and
//    focuses it) so the user can edit it before sending. Nothing is sent.
//  - The auto-hide countdown is paused while the user is interacting
//    with the chips (touching, scrolling, hovering, keyboard focus) and
//    starts again from the full delay once they let go.
const SUGGESTIONS_SEEN_KEY = 'cognita:composerSuggestionsSeen';
const SUGGESTIONS_AUTOHIDE_MS = 6000;

function wireComposerSuggestions() {
  const el = document.getElementById('composerSuggestions');
  if (!el) return;

  if (sessionStorage.getItem(SUGGESTIONS_SEEN_KEY)) {
    el.remove();
    return;
  }
  sessionStorage.setItem(SUGGESTIONS_SEEN_KEY, '1');

  const input = document.getElementById('composerInput');

  let hidden = false;
  let autohideTimer = null;

  const stopTimer = () => {
    if (autohideTimer) { clearTimeout(autohideTimer); autohideTimer = null; }
  };
  const hide = () => {
    if (hidden) return;
    hidden = true;
    stopTimer();
    el.classList.add('is-hidden');
    setTimeout(() => el.remove(), 400);
  };
  // (Re)starts the full countdown. Calling it again always resets it.
  const startTimer = () => {
    if (hidden) return;
    stopTimer();
    autohideTimer = setTimeout(hide, SUGGESTIONS_AUTOHIDE_MS);
  };

  startTimer();

  // Pause while the user is interacting with the chips; restart the
  // countdown once they stop.
  el.addEventListener('pointerdown', stopTimer);
  el.addEventListener('pointerup', startTimer);
  el.addEventListener('pointercancel', startTimer); // browser took over the touch to scroll
  el.addEventListener('mouseenter', stopTimer);
  el.addEventListener('mouseleave', startTimer);
  el.addEventListener('focusin', stopTimer);
  el.addEventListener('focusout', startTimer);
  // Sideways swiping (including the momentum after the finger lifts):
  // every scroll tick resets the countdown, so it only runs once the
  // strip has stopped moving.
  el.addEventListener('scroll', startTimer, { passive: true });

  // As soon as the user types anything themselves, the chips have done
  // their job.
  if (input) {
    input.addEventListener('input', hide, { once: true });
  }

  el.querySelectorAll('.composer-suggestion-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (!input) return;
      input.value = chip.dataset.prompt || '';
      // Fire the normal "input" handler so the box resizes to fit the
      // text, the send button becomes enabled, and the animated
      // placeholder stops — exactly as if the user had typed it.
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      // Put the cursor at the end so the user can keep typing/editing.
      const end = input.value.length;
      input.setSelectionRange(end, end);
      hide();
    });
  });
}

// Builds the text actually sent to the API for a given conversation
// message: the user's typed text plus any attached file content/notes.
// This is kept separate from what's rendered on screen, so a big PDF,
// DOCX, or text file never dumps its raw content into the visible chat
// bubble — only the typed text and a small attachment chip show up there.
function buildEffectiveContent(msg) {
  let text = msg.content || '';
  if (msg.attachments && msg.attachments.length) {
    const fileAtts = msg.attachments.filter((a) => a.kind === 'file');
    const unsupportedAtts = msg.attachments.filter((a) => a.kind === 'unsupported');

    if (fileAtts.length) {
      text += fileAtts.map((a) =>
        '\n\n--- Content of attached file "' + a.name + '" ---\n' + a.text
      ).join('');
    }
    if (unsupportedAtts.length) {
      text += unsupportedAtts.map((a) =>
        '\n\n[The user attached "' + a.name + '" but this file type cannot be read yet — let them know.]'
      ).join('');
    }
  }
  return text.trim();
}

async function sendMessage(text) {
  if (isSending || (!text && pendingAttachments.length === 0)) return;
  isSending = true;

  const input = document.getElementById('composerInput');
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('sendBtn').disabled = true;
  notifyComposerActivity();

  // Attachments kept for display (thumbnails/chips) — never the raw
  // base64 string or full file text is put into the visible message.
  const attachmentsForMessage = pendingAttachments.map((a) => {
    if (a.kind === 'image') return { kind: 'image', name: a.name, dataUrl: a.dataUrl, mimeType: a.mimeType };
    if (a.kind === 'text') return { kind: 'file', name: a.name, text: a.text };
    return { kind: 'unsupported', name: a.name };
  });

  // What actually goes to the vision model — base64 + mime only, never
  // rendered as text anywhere.
  const outgoingImages = pendingAttachments
    .filter((a) => a.kind === 'image')
    .map((a) => ({ base64: a.base64, mimeType: a.mimeType }));

  pendingAttachments = [];
  renderComposerAttachments();

  const userMessage = { role: 'user', content: text || '' };
  if (attachmentsForMessage.length > 0) userMessage.attachments = attachmentsForMessage;
  conversation.push(userMessage);
  renderConversation();
  updateConversationTitle();

  const payload = {
    messages: conversation.map((m) => ({ role: m.role, content: buildEffectiveContent(m) })),
    quality: currentQuality,
    approvals: conversationApprovals,
  };
  if (outgoingImages.length > 0) payload.images = outgoingImages;

  await runStreamedTurn(payload);
  isSending = false;
}

/* Shared by a fresh message send and a confirmed tool-call resume (see
 * resolvePendingToolCall) — both are just a POST to /api/chat that comes
 * back as an SSE stream of `round` / `step` / `error` / `done` events
 * (see the big comment above the streaming section in chat-endpoint.js).
 * This drives a single live indicator bubble in real time as each event
 * arrives, then commits the finished turn into `conversation` /
 * `conversationMeta` exactly once, on `done`. */
async function runStreamedTurn(payload) {
  const live = createLiveTurnIndicator();
  const startedAt = performance.now();
  let settled = false;

  const finishWithError = (message, status) => {
    if (settled) return;
    settled = true;
    live.remove();
    appendSystemNotice(message || 'Something went wrong. Please try again.', status === 429 ? 'limit' : 'error');
  };

  const finishWithData = (data) => {
    if (settled) return;
    settled = true;
    live.remove();
    const elapsedMs = performance.now() - startedAt;
    conversation.push({ role: 'assistant', content: data.reply || '' });
    conversationMeta[conversation.length - 1] = {
      // `thinking`, when present, is already the sanitized, on-brand
      // version of the model's real reasoning — see
      // _cleanReasoningForDisplay in chat-endpoint.js. `thinkingHeading`
      // is the fallback for turns where nothing safe enough survived
      // that cleaning, or where tools were used. Never both.
      thinking: data.thinking || null,
      thinkingHeading: data.thinkingHeading || null,
      sources: data.sources || null,
      elapsedMs,
      pendingToolCall: data.pendingToolCall ? { ...data.pendingToolCall, status: 'pending' } : null,
      // `steps` is the full recorded action chain for this turn (Bug 2) —
      // may contain several entries (read → write → verify, etc.), not
      // just one. Falls back to the legacy single-object `toolExecuted`
      // field for compatibility with any cached older responses.
      steps: Array.isArray(data.steps) ? data.steps : (data.toolExecuted ? [data.toolExecuted] : []),
    };
    // The backend echoes back the full, updated approvals list — including
    // anything newly approved this turn — so this conversation never
    // re-asks for the same write again (Bug 4).
    if (Array.isArray(data.approvals)) conversationApprovals = data.approvals;
    freshAssistantIndex = conversation.length - 1;
    renderConversation();
    refreshUsage();
    persistCurrentConversation();
  };

  try {
    await streamChatSSE(WORKER_URL + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, {
      onRound: () => live.addPendingRow(),
      onStep: (step) => live.addStep(step),
      onDone: (data) => finishWithData(data),
      onError: (data) => finishWithError(data && data.message, data && data.status),
      onFatal: (message, status) => finishWithError(message, status),
    });
  } catch (e) {
    console.error('[app] chat stream failed:', e.message);
    finishWithError('Could not reach Cognita. Please check your connection.', 0);
    return;
  }

  // The connection closed without ever sending an `error` or `done`
  // event — e.g. the Worker crashed mid-stream, or a proxy cut the
  // connection. Never leave the user staring at a spinner forever, and
  // never silently pretend the turn succeeded.
  if (!settled) {
    finishWithError('Connection to Cognita was interrupted before a response was received.', 0);
  }
}

/* ── SSE client ──────────────────────────────────────────────────────
 * Parses a text/event-stream response from /api/chat by hand (rather
 * than EventSource, which can't send the Authorization header or a POST
 * body). Buffers raw bytes across chunk boundaries and splits on the
 * blank-line event separator per the SSE spec; `: ping` heartbeat
 * comments (sent periodically by the backend to keep the connection
 * alive during long tool-call rounds) are recognized and ignored. */
async function streamChatSSE(url, options, handlers) {
  let res;
  try {
    res = await window.Auth.authedFetch(url, options);
  } catch (e) {
    handlers.onFatal && handlers.onFatal('Could not reach Cognita. Please check your connection.', 0);
    return;
  }

  if (!res.ok) {
    // A failure caught before the stream ever opened (auth, quota, plan
    // checks, request validation) still comes back as a plain JSON error
    // with a real HTTP status — see the top of handleChatRequest.
    let data = {};
    try { data = await res.json(); } catch (_) {}
    handlers.onFatal && handlers.onFatal(data.error, res.status);
    return;
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    // Streaming reads aren't available in this environment. Fall back to
    // treating the whole response as one JSON payload in case the server
    // ever answers this way.
    try {
      const data = await res.json();
      handlers.onDone && handlers.onDone(data);
    } catch (e) {
      handlers.onFatal && handlers.onFatal('Could not read the response from Cognita.', 500);
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const dispatch = (eventName, data) => {
    if (eventName === 'round') handlers.onRound && handlers.onRound(data);
    else if (eventName === 'step') handlers.onStep && handlers.onStep(data);
    else if (eventName === 'error') handlers.onError && handlers.onError(data);
    else if (eventName === 'done') handlers.onDone && handlers.onDone(data);
    // Unknown event names are ignored rather than treated as fatal, so a
    // future server-added event type never breaks older clients.
  };

  const consumeBuffered = () => {
    let sepIndex;
    while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
      const rawEvent = buffer.slice(0, sepIndex);
      buffer = buffer.slice(sepIndex + 2);
      if (!rawEvent || rawEvent.startsWith(':')) continue; // heartbeat/comment-only

      let eventName = 'message';
      const dataLines = [];
      for (const line of rawEvent.split('\n')) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      const dataStr = dataLines.join('\n');
      if (!dataStr) continue;
      let data;
      try {
        data = JSON.parse(dataStr);
      } catch (e) {
        continue; // malformed frame — skip rather than crash the whole turn
      }
      dispatch(eventName, data);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeBuffered();
    }
    // Flush any trailing decoder state and process a final frame that
    // wasn't terminated by a trailing blank line.
    buffer += decoder.decode();
    consumeBuffered();
  } catch (e) {
    console.error('[app] SSE read failed:', e.message);
    handlers.onFatal && handlers.onFatal('Connection to Cognita was interrupted.', 0);
  }
}

/* Live, streaming version of appendThinkingIndicator(): starts identical
 * (rotating word + timer), then morphs in place into a growing action
 * trace the instant the first `round`/`step` event arrives — each tool
 * step appears the moment it actually finishes on the backend, never a
 * client-side replay of an already-known array (see the removed
 * animateToolTrace()). Text is inserted via textContent throughout, not
 * innerHTML, since step summaries can contain user- or repo-controlled
 * strings (file names, issue titles, etc.). */
function createLiveTurnIndicator() {
  const list = document.getElementById('messageList');
  const id = 'live-' + Date.now() + '-' + Math.floor(Math.random() * 1e6);
  const el = document.createElement('div');
  el.className = 'message is-assistant';
  el.id = id;
  el.innerHTML =
    '<div class="message-avatar"><img src="/assets/cognita.png" alt="" style="width:16px;height:16px;"></div>' +
    '<div class="message-body">' +
      '<div class="thinking-indicator" data-role="idle-indicator">' +
        '<span class="thinking-dot"></span>' +
        '<span class="thinking-word" data-role="word"></span>' +
        '<span class="thinking-timer" data-role="timer">0.0s</span>' +
      '</div>' +
      '<div class="tool-trace-list" data-role="live-trace" style="display:none;"></div>' +
    '</div>';
  document.getElementById('emptyState').hidden = true;
  list.hidden = false;
  list.appendChild(el);
  scrollToBottom();

  const wordEl = el.querySelector('[data-role="word"]');
  const timerEl = el.querySelector('[data-role="timer"]');
  const traceEl = el.querySelector('[data-role="live-trace"]');
  const idleEl = el.querySelector('[data-role="idle-indicator"]');
  if (wordEl) wordEl.textContent = THINKING_WORDS[0];

  const startedAt = performance.now();
  let wordIdx = 0;
  const wordInterval = setInterval(() => {
    wordIdx = (wordIdx + 1) % THINKING_WORDS.length;
    if (wordEl) wordEl.textContent = THINKING_WORDS[wordIdx];
  }, 2200);
  const timerInterval = setInterval(() => {
    const elapsed = (performance.now() - startedAt) / 1000;
    if (timerEl) timerEl.textContent = elapsed.toFixed(1) + 's';
  }, 100);
  activeThinkingTimers[id] = { wordInterval, timerInterval };

  let pendingRow = null; // the single "working on the next step…" placeholder, if any

  function reveal() {
    if (idleEl) idleEl.style.display = 'none';
    if (traceEl) traceEl.style.display = '';
  }

  function addPendingRow() {
    reveal();
    if (!traceEl || pendingRow) return; // only one placeholder at a time
    const row = document.createElement('div');
    row.className = 'tool-trace-card tool-trace-card--pending';
    const icon = document.createElement('i');
    icon.className = 'ph ph-circle-notch trace-spin';
    const label = document.createElement('span');
    label.className = 'tool-trace-card-label';
    label.textContent = 'Working\u2026';
    row.appendChild(icon);
    row.appendChild(label);
    traceEl.appendChild(row);
    pendingRow = row;
    scrollToBottom();
  }

  function addStep(step) {
    if (!step) return;
    reveal();
    if (!traceEl) return;

    // "awaiting_confirmation" isn't rendered as its own trace row (the
    // confirm/cancel card that appears once the turn commits already
    // covers it) — it just closes out any pending placeholder.
    if (step.type === 'awaiting_confirmation') {
      if (pendingRow) { pendingRow.remove(); pendingRow = null; }
      return;
    }

    const ok = step.ok !== false;
    const finalIcon = step.type === 'blocked' ? 'ph-question' : (ok ? 'ph-check-circle' : 'ph-warning-circle');
    const statusClass = step.type === 'blocked' ? 'tool-trace-card--blocked' : (ok ? 'tool-trace-card--ok' : 'tool-trace-card--error');

    const row = pendingRow || document.createElement('div');
    if (!pendingRow) traceEl.appendChild(row);
    row.className = 'tool-trace-card ' + statusClass;
    row.innerHTML = '';
    const icon = document.createElement('i');
    icon.className = 'ph ' + finalIcon;
    const label = document.createElement('span');
    label.className = 'tool-trace-card-label';
    label.textContent = step.summary || step.name || 'Action performed.';
    row.appendChild(icon);
    row.appendChild(label);
    pendingRow = null;
    scrollToBottom();
  }

  function remove() {
    const timers = activeThinkingTimers[id];
    if (timers) {
      clearInterval(timers.wordInterval);
      clearInterval(timers.timerInterval);
      delete activeThinkingTimers[id];
    }
    el.remove();
  }

  return { id, addPendingRow, addStep, remove };
}

/* ════════════════════════════════════════════════════════
   CONVERSATION RENDERING
════════════════════════════════════════════════════════ */

function renderConversation() {
  const emptyState = document.getElementById('emptyState');
  const list = document.getElementById('messageList');

  if (conversation.length === 0) {
    emptyState.hidden = false;
    list.hidden = true;
    list.innerHTML = '';
    return;
  }

  emptyState.hidden = true;
  list.hidden = false;
  list.innerHTML = conversation.map(renderMessage).join('');
  scrollToBottom();
  wireMessageActionButtons();
  wireDocumentDownloadButtons(list);
  wireCodeCopyButtons(list);
  renderMathInElement(list);

  // Type out only the reply that was just received, once, then clear the
  // flag so later re-renders (edits, resizes, unrelated updates) don't
  // replay the animation on old messages.
  if (freshAssistantIndex !== -1 && conversation[freshAssistantIndex] && conversation[freshAssistantIndex].role === 'assistant') {
    const idx = freshAssistantIndex;
    freshAssistantIndex = -1;
    const messageEls = list.querySelectorAll('.message.is-assistant');
    const targetEl = messageEls[messageEls.length - 1];
    const contentEl = targetEl ? targetEl.querySelector('.message-content') : null;

    const startTypewriter = () => {
      if (!contentEl) return;
      const fullText = conversation[idx].content || '';
      const sources = (conversationMeta[idx] || {}).sources || null;
      typewriterReveal(contentEl, fullText, sources, () => {
        // Copy/code-copy/math only need to run once, against the final,
        // fully-revealed HTML — re-wiring on every in-progress frame
        // would be wasteful and would re-render KaTeX repeatedly.
        wireCodeCopyButtons(targetEl);
        renderMathInElement(targetEl);
      });
    };

    // Order on screen is: thought box → step trace → reply text. The
    // step trace itself was already shown live, step by step, as it
    // actually happened (see createLiveTurnIndicator/runStreamedTurn) —
    // this commit render just re-renders it in its final, settled state,
    // with no replay animation needed. Only the reply text still types
    // out here.
    startTypewriter();
  } else {
    freshAssistantIndex = -1;
  }
}

/* ── Typewriter reveal ─────────────────────────────────────────────
   The reply arrives as one finished block (the backend is not
   streamed), so this simulates a human-typed response purely on the
   client. Unlike revealing text inside an already-fully-built DOM
   (which reserves the final height up front and makes the bottom of
   the message sit empty while the top fills in), this grows the
   message from nothing: each tick it re-renders a slightly longer
   slice of the *raw* markdown, so the bubble grows downward exactly
   like real typing — paragraphs, list items, code fences and table
   rows appear as they're completed, not as pre-sized empty space.
   KaTeX math and code-copy buttons are wired only once, after the
   full text has been revealed, via the onDone callback. */
function typewriterReveal(contentEl, fullText, sources, onDone) {
  if (!fullText) {
    onDone && onDone();
    return;
  }

  const totalChars = fullText.length;

  // Calm, steady reveal speed:
  // ~35ms per character, with sensible limits for very short/long responses.
  const totalDurationMs = Math.min(
    Math.max(totalChars * 35, 700),
    10000
  );

  const tickMs = 40;

  const charsPerTick = Math.max(
    1,
    Math.round(totalChars / (totalDurationMs / tickMs))
  );

  contentEl.classList.add('is-typing');

  let revealed = 0;

  const interval = setInterval(() => {
    revealed = Math.min(
      totalChars,
      revealed + charsPerTick
    );

    contentEl.innerHTML = renderMarkdownLite(
      fullText.slice(0, revealed),
      sources
    );

    scrollToBottom();

    if (revealed >= totalChars) {
      clearInterval(interval);
      contentEl.classList.remove('is-typing');
      onDone && onDone();
    }
  }, tickMs);
}

function renderMessage(msg, index) {
  const isUser = msg.role === 'user';
  const avatarContent = isUser ? 'Y' : '<img src="/assets/cognita.png" alt="" style="width:16px;height:16px;">';
  const meta = conversationMeta[index] || {};

  // Attachments render as thumbnails/chips only — never as raw base64
  // strings or a full file text dump in the visible bubble.
  let attachmentsHtml = '';
  if (isUser && msg.attachments && msg.attachments.length) {
    const imageAtts = msg.attachments.filter((a) => a.kind === 'image');
    const otherAtts = msg.attachments.filter((a) => a.kind !== 'image');

    let imagesHtml = '';
    if (imageAtts.length) {
      imagesHtml = '<div class="message-image-grid">' +
        imageAtts.map((a) => '<img src="' + a.dataUrl + '" alt="' + escapeHtml(a.name) + '" class="message-image">').join('') +
      '</div>';
    }

    let chipsHtml = '';
    if (otherAtts.length) {
      chipsHtml = '<div class="message-attachments">' +
        otherAtts.map((a) => {
          const icon = a.kind === 'unsupported' ? 'warning' : 'file-text';
          return '<span class="attachment-chip attachment-chip-static">' +
            '<i class="ph ph-' + icon + '"></i>' +
            '<span class="attachment-chip-name">' + escapeHtml(a.name) + '</span>' +
          '</span>';
        }).join('') +
      '</div>';
    }

    attachmentsHtml = imagesHtml + chipsHtml;
  }

  // A turn that used tools (Array of steps is non-empty once you filter
  // out the pure "awaiting_confirmation" placeholder, which is rendered
  // separately by the confirm card) never shows the model's raw
  // reasoning in the thought box — only a short deterministic heading
  // (see _thinkingHeadingFromSteps in chat-endpoint.js). Raw reasoning
  // is reserved for plain, tool-free turns.
  const rawStepList = !isUser && Array.isArray(meta.steps) ? meta.steps : [];
  const traceSteps = rawStepList.filter((s) => s && s.type !== 'awaiting_confirmation');
  const hasSteps = traceSteps.length > 0;

  // `meta.thinking` is only ever the sanitized, first-person version of
  // the model's real reasoning (see _cleanReasoningForDisplay in
  // chat-endpoint.js) — never raw text, so it's always safe to render
  // as-is here. `meta.thinkingHeading` is the fallback used whenever
  // there wasn't a clean, trustworthy version to show (or the turn used
  // tools) — the two are mutually exclusive, never both set.
  let thoughtHtml = '';
  if (!isUser && (meta.thinking || meta.thinkingHeading || hasSteps)) {
    const secs = meta.elapsedMs ? (meta.elapsedMs / 1000).toFixed(1) : null;
    const label = secs ? 'Thought for ' + secs + 's' : 'Thought process';
    const bodyHtml = meta.thinking
      ? '<div class="thought-content">' + renderMarkdownLite(meta.thinking) + '</div>'
      : '<div class="thought-content thought-content--heading">' + escapeHtml(meta.thinkingHeading || 'Working on your request') + '</div>';
    thoughtHtml =
      '<details class="thought-block">' +
        '<summary>' +
          '<i class="ph ph-caret-right thought-caret"></i>' +
          '<span>' + label + '</span>' +
        '</summary>' +
        bodyHtml +
      '</details>';
  }

  let sourcesHtml = '';
  if (!isUser && meta.sources && meta.sources.length) {
    sourcesHtml =
      '<div class="message-sources">' +
        '<div class="message-sources-label">Sources</div>' +
        '<ol class="message-sources-list">' +
          meta.sources.map((s) =>
            '<li><a href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener noreferrer">' +
              escapeHtml(s.title || s.url) + '</a></li>'
          ).join('') +
        '</ol>' +
      '</div>';
  }

  // Generated document (docx/pdf/pptx) attached to this assistant message.
  // Rendered as a chip that re-fetches the actual bytes on click, via
  // wireDocumentDownloadButtons — this is what makes the file
  // re-downloadable after a reload, unlike a one-time blob URL.
  let documentFileHtml = '';
  if (!isUser && msg.documentFile) {
    const df = msg.documentFile;
    documentFileHtml =
      '<button type="button" class="document-download-chip" ' +
        'data-conversation-id="' + escapeHtml(df.conversationId || '') + '" ' +
        'data-file-id="' + escapeHtml(df.fileId || '') + '" ' +
        'data-filename="' + escapeHtml(df.filename || '') + '" ' +
        'data-mime="' + escapeHtml(df.mimeType || '') + '">' +
        '<i class="ph ph-file-arrow-down"></i>' +
        '<span class="document-download-chip-name">' + escapeHtml(df.filename || 'document') + '</span>' +
        '<span class="document-download-chip-state"></span>' +
      '</button>';
  }

  // Action Trace: a persistent, ordered record of every step the agent
  // loop actually ran to produce this reply (Bug 2's "recorded thought
  // chain") — e.g. "Looking at README.md" → "Updating README.md" →
  // a terminal row showing how the turn actually ended. Read-only steps
  // and already-approved writes never show a confirm card, so without
  // this list they'd leave zero visible trace that anything happened.
  //
  // The terminal row used to always say "Completed", even when the turn
  // had actually just paused for the user's OK on a write, or ended
  // mid-task — a misleading signal. It now reflects the real end state:
  //   • no pendingToolCall at all           → "Completed"
  //   • pendingToolCall, status "pending"   → an inline Confirm/Cancel
  //                                            row, so approving a write
  //                                            reads as the natural next
  //                                            step in the trace itself
  //                                            rather than a separate
  //                                            floating card below the
  //                                            reply text
  //   • pendingToolCall, status "cancelled" → "Cancelled — no changes
  //                                            were made"
  //   • pendingToolCall, status "confirmed" → "Confirmed — continued
  //                                            below" (the actual run
  //                                            landed in the next
  //                                            message once approved)
  //
  // Rendered right after the thought box and BEFORE the reply text (see
  // the returned template below) — never trailing under the answer.
  // `traceSteps`/`hasSteps` come from just above.
  //
  // The trace was already revealed live, step by step, as each one
  // actually completed on the backend (see createLiveTurnIndicator /
  // runStreamedTurn) — this render just shows its final, settled state.
  // History reloads and regenerated re-renders land here identically.
  const ptc = !isUser ? meta.pendingToolCall : null;
  let actionTraceHtml = '';
  if (hasSteps || ptc) {
    const cardsHtml = traceSteps.map((te) => {
      const ok = te.ok !== false;
      const finalIcon = te.type === 'blocked' ? 'ph-question' : (ok ? 'ph-check-circle' : 'ph-warning-circle');
      const statusClass = te.type === 'blocked' ? 'tool-trace-card--blocked' : (ok ? 'tool-trace-card--ok' : 'tool-trace-card--error');
      return (
        '<div class="tool-trace-card ' + statusClass + '">' +
          '<i class="ph ' + finalIcon + '"></i>' +
          '<span class="tool-trace-card-label">' + escapeHtml(te.summary || te.name || 'Action performed.') + '</span>' +
        '</div>'
      );
    }).join('');

    let terminalHtml;
    if (!ptc) {
      terminalHtml =
        '<div class="tool-trace-card tool-trace-card--done">' +
          '<i class="ph ph-check-circle"></i>' +
          '<span class="tool-trace-card-label">Completed</span>' +
        '</div>';
    } else if (ptc.status === 'pending') {
      terminalHtml =
        '<div class="tool-trace-card tool-trace-card--confirm" data-index="' + index + '">' +
          '<i class="ph ph-hand-palm"></i>' +
          '<span class="tool-trace-card-label">' + escapeHtml(ptc.summary || 'Perform this action?') + '</span>' +
          '<div class="tool-trace-card-actions">' +
            '<button class="tool-confirm-btn tool-confirm-btn--confirm" data-tool-action="confirm" data-index="' + index + '">' +
              '<i class="ph ph-check"></i> Confirm' +
            '</button>' +
            '<button class="tool-confirm-btn tool-confirm-btn--cancel" data-tool-action="cancel" data-index="' + index + '">' +
              '<i class="ph ph-x"></i> Cancel' +
            '</button>' +
          '</div>' +
        '</div>';
    } else if (ptc.status === 'cancelled') {
      terminalHtml =
        '<div class="tool-trace-card tool-trace-card--blocked">' +
          '<i class="ph ph-x-circle"></i>' +
          '<span class="tool-trace-card-label">Cancelled — no changes were made.</span>' +
        '</div>';
    } else {
      // status === 'confirmed' — the actual run happened as the next
      // message once the user approved it.
      terminalHtml =
        '<div class="tool-trace-card tool-trace-card--done">' +
          '<i class="ph ph-check-circle"></i>' +
          '<span class="tool-trace-card-label">Confirmed — continued below</span>' +
        '</div>';
    }

    actionTraceHtml = '<div class="tool-trace-list">' + cardsHtml + terminalHtml + '</div>';
  }

  return (
    '<div class="message ' + (isUser ? 'is-user' : 'is-assistant') + '">' +
      '<div class="message-avatar">' + avatarContent + '</div>' +
      '<div class="message-body">' +
        thoughtHtml +
        actionTraceHtml +
        attachmentsHtml +
        // The freshly-received reply starts as an empty content div —
        // typewriterReveal (called from renderConversation right after
        // this HTML is inserted, and after any step-reveal animation
        // above has finished) fills it in. This avoids a flash of the
        // full text before the typing animation takes over.
        (msg.content ? '<div class="message-content">' + (!isUser && index === freshAssistantIndex ? '' : renderMarkdownLite(msg.content, isUser ? null : meta.sources)) + '</div>' : '') +
        documentFileHtml +
        sourcesHtml +
        (isUser ? '' :
          '<div class="message-actions">' +
            '<button class="message-action-btn" data-action="copy" data-index="' + index + '" title="Copy"><i class="ph ph-copy"></i></button>' +
            '<button class="message-action-btn" data-action="regenerate" data-index="' + index + '" title="Regenerate"><i class="ph ph-arrow-clockwise"></i></button>' +
          '</div>'
        ) +
      '</div>' +
    '</div>'
  );
}

function wireMessageActionButtons() {
  document.querySelectorAll('[data-action="copy"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      const messageEl = btn.closest('.message');
      const contentEl = messageEl ? messageEl.querySelector('.message-content') : null;
      copyMessageContent(contentEl, conversation[idx] ? conversation[idx].content : '');
      showToast('Copied to clipboard.');
    });
  });

  document.querySelectorAll('[data-action="regenerate"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = parseInt(btn.dataset.index, 10);
      const priorUserMsg = [...conversation.slice(0, idx)].reverse().find((m) => m.role === 'user');
      if (!priorUserMsg) return;
      conversation = conversation.slice(0, idx);
      conversationMeta = conversationMeta.slice(0, idx);
      renderConversation();
      await sendMessage(priorUserMsg.content);
    });
  });

  document.querySelectorAll('[data-tool-action="confirm"]').forEach((btn) => {
    btn.addEventListener('click', () => resolvePendingToolCall(parseInt(btn.dataset.index, 10), true));
  });
  document.querySelectorAll('[data-tool-action="cancel"]').forEach((btn) => {
    btn.addEventListener('click', () => resolvePendingToolCall(parseInt(btn.dataset.index, 10), false));
  });
}

// Runs (or cancels) a write action the model proposed earlier in the
// conversation — see the tool-confirm card in renderMessage() and the
// confirmToolCall handling in chat-endpoint.js. Cancelling never calls
// the backend at all: the user simply declined, nothing to undo.
async function resolvePendingToolCall(index, approved) {
  const meta = conversationMeta[index];
  if (!meta || !meta.pendingToolCall || meta.pendingToolCall.status !== 'pending') return;
  const ptc = meta.pendingToolCall;

  if (!approved) {
    meta.pendingToolCall = { ...ptc, status: 'cancelled' };
    renderConversation();
    persistCurrentConversation();
    return;
  }

  meta.pendingToolCall = { ...ptc, status: 'confirmed' };
  renderConversation();

  await runStreamedTurn({
    messages: conversation.slice(0, index + 1).map((m) => ({ role: m.role, content: buildEffectiveContent(m) })),
    quality: currentQuality,
    confirmToolCall: { name: ptc.name, args: ptc.args },
    approvals: conversationApprovals,
  });
}

// Copies what the person actually SEES (rendered bold, lists, tables,
// etc.) rather than the raw markdown source. Writes both a rich text/html
// version (so pasting into Word, Gmail, Docs, Notion, etc. keeps the
// formatting) and a plain-text fallback derived from the rendered content
// (so pasting into a plain text field shows clean text, not **asterisks**
// and other markdown syntax). Falls back to the old plain writeText
// behavior on browsers/contexts that don't support rich clipboard writes
// (e.g. non-HTTPS, older Safari, some in-app browsers).
async function copyMessageContent(contentEl, fallbackRawText) {
  const plainText = contentEl ? contentEl.innerText : (fallbackRawText || '');

  if (contentEl && window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    try {
      const htmlBlob = new Blob([contentEl.innerHTML], { type: 'text/html' });
      const textBlob = new Blob([plainText], { type: 'text/plain' });
      await navigator.clipboard.write([
        new ClipboardItem({ 'text/html': htmlBlob, 'text/plain': textBlob }),
      ]);
      return;
    } catch (e) {
      console.error('[app] Rich copy failed, falling back to plain text:', e.message);
    }
  }

  try {
    await navigator.clipboard.writeText(plainText);
  } catch (e) {
    console.error('[app] Copy failed:', e.message);
  }
}

// Wires the re-download chip for AI-generated documents. Each click
// fetches the file's base64 content fresh from /api/files (authenticated,
// scoped to the owning conversation) and triggers a real browser download
// — this works after a reload, on another device, or days later, right
// up until the conversation is deleted (see chat-storage.js's
// deleteGeneratedFilesForConversation).
function wireDocumentDownloadButtons(container) {
  container.querySelectorAll('.document-download-chip').forEach((btn) => {
    btn.addEventListener('click', () => downloadGeneratedFile(btn));
  });
}

async function downloadGeneratedFile(btn) {
  const conversationId = btn.dataset.conversationId;
  const fileId = btn.dataset.fileId;
  const filename = btn.dataset.filename;
  const mimeType = btn.dataset.mime || 'application/octet-stream';
  const stateEl = btn.querySelector('.document-download-chip-state');

  if (!conversationId || !fileId || !filename) {
    showToast('This file is no longer available for download.');
    return;
  }

  if (btn.disabled) return;
  btn.disabled = true;
  if (stateEl) stateEl.innerHTML = '<i class="ph ph-spinner ph-spin"></i>';

  try {
    const url = WORKER_URL + '/api/files/' + encodeURIComponent(conversationId) +
      '/' + encodeURIComponent(fileId) + '?filename=' + encodeURIComponent(filename);
    const res = await window.Auth.authedFetch(url);
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Could not download that file.');
      return;
    }

    const byteChars = atob(data.content);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
    const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
    const blobUrl = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  } catch (e) {
    console.error('[app] Could not download generated file:', e.message);
    showToast('Could not reach Cognita. Please try again.');
  } finally {
    btn.disabled = false;
    if (stateEl) stateEl.innerHTML = '';
  }
}

function wireCodeCopyButtons(container) {
  container.querySelectorAll('.code-copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.copyTarget);
      if (!target) return;
      navigator.clipboard.writeText(target.textContent).then(() => {
        btn.classList.add('is-copied');
        btn.innerHTML = '<i class="ph ph-check"></i> Copied';
        setTimeout(() => {
          btn.classList.remove('is-copied');
          btn.innerHTML = '<i class="ph ph-copy"></i> Copy';
        }, 1800);
      });
    });
  });
}

function renderMathInElement(container) {
  if (!window.katex) return; // KaTeX script hasn't loaded yet
  container.querySelectorAll('.katex-target').forEach((el) => {
    const expr = el.textContent;
    const display = el.dataset.display === 'true';
    try {
      window.katex.render(expr, el, { throwOnError: false, displayMode: display });
    } catch (e) {
      console.error('[app] KaTeX render failed:', e.message);
    }
  });
}

function appendThinkingIndicator() {
  const list = document.getElementById('messageList');
  const id = 'thinking-' + Date.now();
  const el = document.createElement('div');
  el.className = 'message is-assistant';
  el.id = id;
  el.innerHTML =
    '<div class="message-avatar"><img src="/assets/cognita.png" alt="" style="width:16px;height:16px;"></div>' +
    '<div class="message-body">' +
      '<div class="thinking-indicator">' +
        '<span class="thinking-dot"></span>' +
        '<span class="thinking-word" id="' + id + '-word">' + THINKING_WORDS[0] + '</span>' +
        '<span class="thinking-timer" id="' + id + '-timer">0.0s</span>' +
      '</div>' +
    '</div>';
  document.getElementById('emptyState').hidden = true;
  list.hidden = false;
  list.appendChild(el);
  scrollToBottom();

  const startedAt = performance.now();
  const wordEl = document.getElementById(id + '-word');
  const timerEl = document.getElementById(id + '-timer');
  let wordIdx = 0;

  const wordInterval = setInterval(() => {
    wordIdx = (wordIdx + 1) % THINKING_WORDS.length;
    if (wordEl) wordEl.textContent = THINKING_WORDS[wordIdx];
  }, 2200);

  const timerInterval = setInterval(() => {
    const elapsed = (performance.now() - startedAt) / 1000;
    if (timerEl) timerEl.textContent = elapsed.toFixed(1) + 's';
  }, 100);

  activeThinkingTimers[id] = { wordInterval, timerInterval };
  return id;
}

function removeThinkingIndicator(id) {
  const timers = activeThinkingTimers[id];
  if (timers) {
    clearInterval(timers.wordInterval);
    clearInterval(timers.timerInterval);
    delete activeThinkingTimers[id];
  }
  const el = document.getElementById(id);
  if (el) el.remove();
}

function appendSystemNotice(text, kind) {
  const list = document.getElementById('messageList');
  const el = document.createElement('div');
  el.className = 'message is-assistant';
  el.innerHTML =
    '<div class="message-avatar"><i class="ph ph-warning" style="font-size:14px;"></i></div>' +
    '<div class="message-body"><div class="message-content" style="color:var(--text-3);">' +
      escapeHtml(text) +
    '</div></div>';
  list.appendChild(el);
  scrollToBottom();
}

function scrollToBottom() {
  const conv = document.getElementById('conversation');
  conv.scrollTop = conv.scrollHeight;
}

/* ── Markdown-lite + LaTeX renderer ── */

// A short, fixed whitelist of harmless inline formatting tags the AI
// sometimes emits directly (mainly <br> inside table cells, since
// markdown tables can't contain real line breaks any other way).
// escapeHtml() turns every "<" into "&lt;" for safety — this step
// re-allows ONLY these exact escaped tags back into real tags. Nothing
// else the AI outputs can ever pass through this, so this cannot be used
// to smuggle in a script tag or any other unsafe markup.
const _ALLOWED_RAW_TAG_RE =
  /&lt;(br|\/?b|\/?i|\/?u|\/?em|\/?strong|\/?sup|\/?sub|hr)\s*\/?&gt;/gi;

function _unescapeAllowedTags(html) {
  return html.replace(_ALLOWED_RAW_TAG_RE, (match, tagName) => {
    const lower = tagName.toLowerCase();
    if (lower === 'br' || lower === 'hr') return '<' + lower + '>';
    return '<' + lower + '>';
  });
}

function renderMarkdownLite(text, sources) {
  let raw = escapeHtml(text);
  raw = _unescapeAllowedTags(raw);

  // Protect LaTeX before anything else touches the string.
  const mathBlocks = [];
  raw = raw.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    mathBlocks.push({ expr, display: true });
    return '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });
  raw = raw.replace(/\\\[([\s\S]+?)\\\]/g, (_, expr) => {
    mathBlocks.push({ expr, display: true });
    return '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });
  raw = raw.replace(/(^|[^$])\$([^$\n]+?)\$(?!\$)/g, (_, pre, expr) => {
    mathBlocks.push({ expr, display: false });
    return pre + '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });
  raw = raw.replace(/\\\(([\s\S]+?)\\\)/g, (_, expr) => {
    mathBlocks.push({ expr, display: false });
    return '\x00MATH' + (mathBlocks.length - 1) + '\x00';
  });

  const codeBlocks = [];
  raw = raw.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
    return '\x00CODEBLOCK' + (codeBlocks.length - 1) + '\x00';
  });

  raw = raw.replace(/`([^`\n]+)`/g, '<code>$1</code>');

  // Links: [label](url) markdown syntax becomes a real clickable anchor.
  // Must run before bold/italic (a label may itself contain other
  // markdown-looking characters) and before the bare-URL autolink pass
  // below, so a properly-formed [label](url) is never re-wrapped.
  // escapeHtml already turned "&" into "&amp;" etc. inside url/label, so
  // unescape the url portion just enough to produce a valid href while
  // still escaping it correctly for the attribute.
  // At this point `raw` is already escapeHtml()'d, so both the label and
  // the url below are already entity-safe for direct use in an href
  // attribute (e.g. a literal "&" is already "&amp;") — no further
  // escaping or unescaping needed.
  const linkPlaceholders = [];
  raw = raw.replace(/\[([^\[\]\n]+)\]\((https?:\/\/[^\s()]+)\)/g, (_, label, url) => {
    const html = '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    linkPlaceholders.push(html);
    return '\x00LINK' + (linkPlaceholders.length - 1) + '\x00';
  });

  // Bare URLs (not already part of a markdown link) become clickable too,
  // so a model that forgets the [label](url) form still doesn't leave a
  // dead-looking raw link sitting in the reply.
  raw = raw.replace(/(^|[\s(])((?:https?:\/\/)[^\s<>()]+[^\s<>()".,!?:;'])/g, (whole, pre, url) => {
    const html = '<a href="' + url + '" target="_blank" rel="noopener noreferrer">' + url + '</a>';
    linkPlaceholders.push(html);
    return pre + '\x00LINK' + (linkPlaceholders.length - 1) + '\x00';
  });

  // Headings — must run before bold/italic so "#" lines aren't eaten.
  raw = raw.replace(/^###### (.+)$/gm, '<h6>$1</h6>');
  raw = raw.replace(/^##### (.+)$/gm, '<h5>$1</h5>');
  raw = raw.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  raw = raw.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  raw = raw.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  raw = raw.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Blockquotes: consecutive "> " lines become one <blockquote>. Must run
  // before paragraph-wrapping so the block survives as a unit.
  raw = raw.replace(/^[ \t]*&gt;[ \t]?(.*)$/gm, '\x00BQ\x00$1');
  raw = raw.replace(/(?:\x00BQ\x00.*(?:\n|$))+/g, (block) => {
    const lines = block.split('\x00BQ\x00').filter((s) => s.length > 0 || s === '');
    const inner = lines.map((l) => l.trim()).join('<br>');
    return '<blockquote>' + inner + '</blockquote>';
  });

  // Horizontal rules: a line that's only ---, ***, or ___ (3+ chars).
  raw = raw.replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, '<hr>');

  // Emphasis, resolved inside-out so mixed **bold*italic*** combinations
  // don't leave stray asterisks behind.
  raw = raw.replace(/\*\*\*([^*]+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  raw = raw.replace(/___([^_]+?)___/g, '<strong><em>$1</em></strong>');
  raw = raw.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
  raw = raw.replace(/__([^_]+?)__/g, '<strong>$1</strong>');
  raw = raw.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, (_, pre, content) => pre + '<em>' + content + '</em>');
  raw = raw.replace(/\b_([^_\n]+?)_\b/g, '<em>$1</em>');

  if (sources && sources.length) {
    raw = raw.replace(/\[(\d+)\]/g, (whole, n) => {
      const i = parseInt(n, 10) - 1;
      if (i < 0 || i >= sources.length) return whole;
      const src = sources[i];
      return '<a class="citation-marker" href="' + escapeHtml(src.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(src.title || src.url) + '">[' + n + ']</a>';
    });
  }

  // Any remaining [bracketed text] at this point is not a markdown link
  // (those were already pulled out into \x00LINK tokens above) and not a
  // resolved citation marker — it's almost always a fill-in-the-blank
  // template placeholder (e.g. "[target market]") that a reply is using
  // on purpose. Left as bare text it reads like a broken/failed link, so
  // it gets a distinct placeholder style instead of plain paragraph text.
  raw = raw.replace(/\[([^\[\]\n]{1,80})\]/g, '<span class="md-placeholder">[$1]</span>');

  // Tables: any block of 2+ consecutive lines that each contain at least
  // one "|", where the second line looks like a separator row, is
  // treated as a table. Cell content may now legitimately contain real
  // <br> (and the other whitelisted tags) thanks to _unescapeAllowedTags
  // above, so a cell's line breaks render correctly instead of showing
  // literal "<br>" text.
  raw = raw.replace(/((?:^.*\|.*$\n?){2,})/gm, (block) => {
    const lines = block.replace(/\n$/, '').split('\n');
    if (lines.length < 2) return block;
    if (!/^[\s|:-]+$/.test(lines[1])) return block;

    const parseCells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    const headerCells = parseCells(lines[0]);
    const bodyLines = lines.slice(2).filter((l) => l.trim() !== '');
    if (bodyLines.length === 0) return block;

    const thead = '<thead><tr>' + headerCells.map((c) => '<th>' + c + '</th>').join('') + '</tr></thead>';
    const tbody = '<tbody>' + bodyLines.map((line) =>
      '<tr>' + parseCells(line).map((c) => '<td>' + c + '</td>').join('') + '</tr>'
    ).join('') + '</tbody>';

    return '<div class="md-table-wrap"><table class="md-table">' + thead + tbody + '</table></div>';
  });

  raw = raw.replace(/^[ \t]*[-*•][ \t]+(.+)$/gm, '\x00ULI\x00$1');
  raw = raw.replace(/(?:\x00ULI\x00.+(?:\n|$))+/g, (block) => {
    const items = block.split('\x00ULI\x00').filter((s) => s.trim());
    return '<ul>' + items.map((i) => '<li>' + i.trim() + '</li>').join('') + '</ul>';
  });

  raw = raw.replace(/^[ \t]*\d+\.[ \t]+(.+)$/gm, '\x00OLI\x00$1');
  raw = raw.replace(/(?:\x00OLI\x00.+(?:\n|$))+/g, (block) => {
    const items = block.split('\x00OLI\x00').filter((s) => s.trim());
    return '<ol>' + items.map((i) => '<li>' + i.trim() + '</li>').join('') + '</ol>';
  });

  const blocks = raw.split(/\n\s*\n/);
  raw = blocks.map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^<(ul|ol|table|div|pre|h[1-6]|blockquote|hr)/.test(trimmed)) return trimmed;
    if (/^\x00CODEBLOCK\d+\x00$/.test(trimmed)) return trimmed;
    if (/^\x00MATH\d+\x00$/.test(trimmed)) return trimmed;
    return '<p>' + trimmed.replace(/\n/g, '<br>') + '</p>';
  }).join('');

  raw = raw.replace(/\x00CODEBLOCK(\d+)\x00/g, (_, i) => {
    const block = codeBlocks[parseInt(i, 10)];
    const id = 'code-' + Math.random().toString(36).slice(2, 9);
    return '<div class="code-block-wrap">' +
      '<button class="code-copy-btn" data-copy-target="' + id + '"><i class="ph ph-copy"></i> Copy</button>' +
      '<pre><code id="' + id + '">' + block.code + '</code></pre>' +
    '</div>';
  });

  raw = raw.replace(/\x00MATH(\d+)\x00/g, (_, i) => {
    const m = mathBlocks[parseInt(i, 10)];
    const id = 'math-' + Math.random().toString(36).slice(2, 9);
    const tag = m.display ? 'div' : 'span';
    return '<' + tag + ' class="katex-target" id="' + id + '" data-display="' + m.display + '">' +
      escapeHtml(m.expr) + '</' + tag + '>';
  });

  raw = raw.replace(/\x00LINK(\d+)\x00/g, (_, i) => linkPlaceholders[parseInt(i, 10)]);

  return raw;
}

/* ════════════════════════════════════════════════════════
   VISUAL GENERATION MODAL (diagram / illustration)
════════════════════════════════════════════════════════ */

function openVisualModal(presetKind) {
  if (presetKind === 'illustration' && !currentAccountHasVision) {
    showToast('Realistic illustrations are available on Cognita Plus and above. Upgrade to generate one.');
    return;
  }

  const modal = document.getElementById('visualModal');
  const promptInput = document.getElementById('visualPromptInput');
  const typeOptions = document.querySelectorAll('#visualModal .visual-type-option');

  visualKind = presetKind || 'diagram';
  typeOptions.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.kind === visualKind));

  modal.hidden = false;
  promptInput.value = '';
  promptInput.focus();
}

function wireVisualModal() {
  const modal = document.getElementById('visualModal');
  const closeBtn = document.getElementById('visualModalClose');
  const submitBtn = document.getElementById('visualSubmitBtn');
  const promptInput = document.getElementById('visualPromptInput');
  const typeOptions = document.querySelectorAll('#visualModal .visual-type-option');

  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

  typeOptions.forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.kind === 'illustration' && !currentAccountHasVision) {
        showToast('Realistic illustrations are available on Cognita Plus and above.');
        return;
      }
      typeOptions.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      visualKind = btn.dataset.kind;
    });
  });

  submitBtn.addEventListener('click', async () => {
    const prompt = promptInput.value.trim();
    if (!prompt) return;

    setModalLoading(submitBtn, true);

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, kind: visualKind }),
      });

      const data = await res.json();
      setModalLoading(submitBtn, false);

      if (!res.ok) {
        showToast(data.error || 'Could not generate the visual.');
        return;
      }

      modal.hidden = true;
      insertVisualIntoConversation(data, prompt);
    } catch (e) {
      setModalLoading(submitBtn, false);
      showToast('Could not reach Cognita. Please try again.');
      console.error('[app] visual request failed:', e.message);
    }
  });
}

function setModalLoading(btn, isLoading) {
  btn.disabled = isLoading;
  btn.querySelector('.btn-label').hidden = isLoading;
  btn.querySelector('.btn-spinner').hidden = !isLoading;
}

function insertVisualIntoConversation(data, promptText) {
  let contentHtml;
  if (data.type === 'svg') {
    contentHtml = data.content;
  } else {
    contentHtml = '<img src="data:image/jpeg;base64,' + data.content + '" alt="' + escapeHtml(promptText) + '" style="border-radius:12px;max-width:100%;">';
  }

  conversation.push({ role: 'user', content: 'Generate a visual: ' + promptText });
  conversation.push({ role: 'assistant', content: '__VISUAL__' });

  renderConversation();
  updateConversationTitle();

  const list = document.getElementById('messageList');
  const lastMsg = list.lastElementChild;
  if (lastMsg) {
    const contentEl = lastMsg.querySelector('.message-content');
    if (contentEl) contentEl.innerHTML = contentHtml;
  }

  conversation = conversation.map((m) =>
    m.content === '__VISUAL__' ? { ...m, content: '[Generated a visual for: ' + promptText + ']' } : m
  );

  persistCurrentConversation();
}

/* ════════════════════════════════════════���═══════════════
   DOCUMENT GENERATION MODAL (letter / report / essay / memo)
════════════════════════════════════════════════════════ */

function openDocumentModal() {
  const modal = document.getElementById('documentModal');
  const topicInput = document.getElementById('documentTopicInput');
  const typeOptions = document.querySelectorAll('#documentTypeToggle .visual-type-option');
  const formatOptions = document.querySelectorAll('#documentFormatToggle .visual-type-option');

  documentDocType = 'letter';
  documentFormat = 'docx';
  typeOptions.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.doctype === documentDocType));
  formatOptions.forEach((btn) => btn.classList.toggle('is-active', btn.dataset.format === documentFormat));

  modal.hidden = false;
  topicInput.value = '';
  topicInput.focus();
}

function wireDocumentModal() {
  const modal = document.getElementById('documentModal');
  const closeBtn = document.getElementById('documentModalClose');
  const submitBtn = document.getElementById('documentSubmitBtn');
  const topicInput = document.getElementById('documentTopicInput');
  const typeOptions = document.querySelectorAll('#documentTypeToggle .visual-type-option');
  const formatOptions = document.querySelectorAll('#documentFormatToggle .visual-type-option');

  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

  typeOptions.forEach((btn) => {
    btn.addEventListener('click', () => {
      typeOptions.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      documentDocType = btn.dataset.doctype;
    });
  });

  formatOptions.forEach((btn) => {
    btn.addEventListener('click', () => {
      formatOptions.forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
      documentFormat = btn.dataset.format;
    });
  });

  submitBtn.addEventListener('click', async () => {
    const topic = topicInput.value.trim();
    if (!topic) return;

    setModalLoading(submitBtn, true);

    // A document generated in a brand-new chat still needs somewhere to
    // be scoped for later retrieval — make sure a conversationId exists
    // before asking the server to build (and persist) the file.
    const conversationId = ensureConversationId();

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, docType: documentDocType, format: documentFormat, conversationId }),
      });

      const data = await res.json();
      setModalLoading(submitBtn, false);

      if (!res.ok) {
        showToast(data.error || 'Could not generate the document.');
        return;
      }

      modal.hidden = true;
      insertDocumentIntoConversation(data, topic, documentDocType, conversationId);
    } catch (e) {
      setModalLoading(submitBtn, false);
      showToast('Could not reach Cognita. Please try again.');
      console.error('[app] document request failed:', e.message);
    }
  });
}

function insertDocumentIntoConversation(data, topicText, docType, conversationId) {
  conversation.push({ role: 'user', content: 'Create a ' + docType + ' about: ' + topicText });

  const mimeType = EXPORT_MIME_TYPES[data.format];

  if (mimeType) {
    const assistantMessage = { role: 'assistant', content: '[Generated a ' + docType + ' document: ' + data.filename + ']' };

    // If the server confirmed it persisted the file (fileId present),
    // attach that metadata to the message so it travels with the
    // conversation to B2 and survives a reload — this is what the
    // re-download chip in renderMessage reads from. If persistence
    // failed server-side (fileId missing), the person still gets this
    // one-time download below, they just won't be able to re-fetch it
    // later — flagged so it's an honest degradation, not a silent one.
    if (data.fileId) {
      assistantMessage.documentFile = {
        fileId: data.fileId,
        conversationId: data.conversationId || conversationId,
        filename: data.filename,
        mimeType,
      };
    }

    conversation.push(assistantMessage);
    renderConversation();
    updateConversationTitle();

    if (!data.fileId) {
      // Fallback: no persisted copy exists, so give an immediate one-time
      // download via a blob URL built from this response's own bytes.
      const byteChars = atob(data.content);
      const byteNumbers = new Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
      const blob = new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
      const url = URL.createObjectURL(blob);

      const list = document.getElementById('messageList');
      const lastMsg = list.lastElementChild;
      if (lastMsg) {
        const contentEl = lastMsg.querySelector('.message-content');
        if (contentEl) {
          contentEl.innerHTML =
            '<a class="document-download-chip" href="' + url + '" download="' + escapeHtml(data.filename) + '">' +
              '<i class="ph ph-file-arrow-down"></i>' +
              '<span>' + escapeHtml(data.filename) + '</span>' +
            '</a>';
        }
      }
      showToast('This file could not be saved for later — download it now before leaving this chat.');
    }
  } else {
    // Free plan: plain text only, shown directly as the reply.
    conversation.push({ role: 'assistant', content: data.content });
    renderConversation();
    updateConversationTitle();
  }

  persistCurrentConversation();
}

/* ════════════════════════════════════════════════════════
   CONNECTED APPS MODAL (connectors: view/connect/disconnect)
════════════════════════════════════════════════════════ */

// Display-only metadata — same list as account.html's Connections
// section. The actual scopes and OAuth handling are entirely
// server-side; this is purely what icon/description to render.
const CONNECTOR_META = {
  github: {
    label: 'GitHub', icon: 'ph-github-logo', desc: 'List repos, read files, open issues.',
    hint: 'You need to be signed in to GitHub in this browser to connect it.',
  },
  google: { label: 'Google', icon: 'ph-google-logo', desc: 'Calendar (full read/write), Drive (files Cognita creates), and Gmail (send + labels only).' },
  facebook: { label: 'Facebook & Instagram', icon: 'ph-facebook-logo', desc: 'Post to a Facebook Page and its linked Instagram account, and schedule posts.' },
  canva: { label: 'Canva', icon: 'ph-image-square', desc: 'List and create designs.' },
};
const CONNECTOR_ORDER = ['github', 'google', 'facebook', 'canva'];

// Google and Facebook require their brand mark to appear in its standard
// multi-color form — a monochrome icon-font glyph doesn't satisfy that, so
// those two get the real logo as inline SVG (mirrors account.html).
// GitHub's mark is officially single-color by design (github.com/logos:
// "do not modify... including changing the color") — there is no
// multi-color GitHub logo to use, so recoloring it would itself be a
// violation. This is the exact official Octocat path, rendered in
// currentColor so it still goes dark-on-light / light-on-dark like their
// own "Invertocat" usage.
// Canva DOES publish a downloadable logo pack (canva.dev/docs/apps/
// rest-apis/brand-guidelines: "you can download assets of the Canva logo" —
// asset zip at canva.dev/assets/connect/Canva-logos.zip). Their guide says
// to use the "icon logo" specifically for surfaces below 50px, which is
// this row, so it's referenced as a real asset file rather than redrawn —
// see /assets/canva-icon-logo.svg (drop the icon-logo SVG from that zip in
// at that path; don't recolor or reshape it per their "Don't" list).
const CONNECTOR_BRAND_SVG = {
  github: '<svg class="connector-row-icon" width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" fill="currentColor" style="color: var(--text-2);">' +
    '<path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/>' +
    '</svg>',
  google: '<svg class="connector-row-icon" width="20" height="20" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84c-.21 1.13-.84 2.09-1.79 2.73v2.27h2.9c1.7-1.56 2.69-3.87 2.69-6.64z"/>' +
    '<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.27c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.34C2.44 15.98 5.48 18 9 18z"/>' +
    '<path fill="#FBBC05" d="M3.95 10.69A5.4 5.4 0 0 1 3.68 9c0-.59.1-1.16.27-1.69V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.34z"/>' +
    '<path fill="#EA4335" d="M9 3.58c1.32 0 2.51.46 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0 5.48 0 2.44 2.02.96 4.97l2.99 2.34C4.66 5.17 6.65 3.58 9 3.58z"/>' +
    '</svg>',
  facebook: '<svg class="connector-row-icon" width="20" height="20" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path fill="#1877F2" d="M18 9a9 9 0 1 0-10.4 8.9v-6.3H5.3V9h2.3V6.9c0-2.3 1.4-3.6 3.5-3.6.7 0 1.5.1 2.2.2v2.4h-1.2c-1.2 0-1.5.7-1.5 1.5V9h2.6l-.4 2.6h-2.2v6.3A9 9 0 0 0 18 9Z"/>' +
    '</svg>',
  canva: '<img class="connector-row-icon" src="/assets/canva-icon-logo.svg" width="20" height="20" alt="" />',
};

// `locked` = this plan's connectorTools feature is off (see
// currentAccountHasConnectorTools). A locked, not-yet-connected row
// still gets a real "Connect" button rather than a disabled one — same
// reasoning as the quality picker's locked options — so a screen
// reader or a quick tap still gets the upgrade explanation instead of
// silent nothing. wireConnectorsModal is what actually stops the
// connect action when locked. A row that's already connected (e.g. the
// account was Plus and just downgraded) is never locked — disconnecting
// must always stay available.
function connectorRowHtml(provider, connected, locked) {
  const meta = CONNECTOR_META[provider];
  const isLockedRow = locked && !connected;
  const icon = CONNECTOR_BRAND_SVG[provider] || ('<i class="ph ' + meta.icon + '"></i>');
  return (
    '<div class="connector-row' + (isLockedRow ? ' is-locked' : '') + '" data-provider="' + provider + '">' +
      icon +
      '<div class="connector-row-text">' +
        '<span class="connector-row-name">' + meta.label + '</span>' +
        '<span class="connector-row-desc' + (connected ? ' is-connected' : '') + '">' +
          (connected ? 'Connected' : meta.desc) +
        '</span>' +
        (!connected && meta.hint ? '<span class="connector-row-hint">' + meta.hint + '</span>' : '') +
      '</div>' +
      (connected
        ? '<button class="connector-row-cta is-danger connector-modal-disconnect-btn" data-provider="' + provider + '">Disconnect</button>'
        : '<button class="connector-row-cta' + (isLockedRow ? ' is-locked' : '') + ' connector-modal-connect-btn" data-provider="' + provider + '">' +
            (isLockedRow ? '<i class="ph ph-lock-simple"></i> Upgrade' : 'Connect') +
          '</button>') +
    '</div>'
  );
}

async function loadConnectorsList() {
  const list = document.getElementById('connectorsList');
  const planNote = document.getElementById('connectorsPlanNote');
  if (planNote) {
    // Only Free-tier users need the explanation — Plus/Studio/Admin all
    // have connectorTools, so hide it for everyone else rather than
    // showing a permanently-true banner.
    planNote.hidden = currentAccountHasConnectorTools;
  }
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/connectors/status');
    const status = await res.json();
    if (!res.ok) throw new Error(status.error || 'Failed to load connected apps.');

    list.innerHTML = CONNECTOR_ORDER
      .map((p) => connectorRowHtml(p, !!status[p], !currentAccountHasConnectorTools))
      .join('');
  } catch (e) {
    list.innerHTML = '<p style="color:var(--text-3); padding: var(--space-3);">Could not load connected apps.</p>';
    console.error('[app] connectors status failed:', e.message);
  }
}

function openConnectorsModal() {
  const modal = document.getElementById('connectorsModal');
  modal.hidden = false;
  loadConnectorsList();
}

function wireConnectorsModal() {
  const modal = document.getElementById('connectorsModal');
  const closeBtn = document.getElementById('connectorsModalClose');
  const list = document.getElementById('connectorsList');

  closeBtn.addEventListener('click', () => { modal.hidden = true; });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.hidden = true; });

  // Event delegation — rows are replaced wholesale on every
  // loadConnectorsList() call, so listeners live on the stable container.
  list.addEventListener('click', async (e) => {
    const connectBtn = e.target.closest('.connector-modal-connect-btn');
    const disconnectBtn = e.target.closest('.connector-modal-disconnect-btn');

    if (connectBtn) {
      const provider = connectBtn.dataset.provider;

      // Same pattern as the quality picker's locked options: the
      // button stays clickable so the person gets an explanation
      // instead of a dead click, but the actual OAuth flow never
      // starts. connectors-endpoint.js enforces this same check
      // server-side too, so this is purely about giving a clear
      // reason here rather than a generic failure after redirecting
      // away to the provider.
      if (!currentAccountHasConnectorTools) {
        showToast('Connected apps require Cognita Plus or higher. Upgrade to connect ' + CONNECTOR_META[provider].label + '.');
        return;
      }

      connectBtn.disabled = true;
      connectBtn.textContent = 'Connecting…';
      try {
        // returnTo=chat: this modal was opened from the chat page, so the
        // provider's callback should send the user back here (app.html),
        // not to account.html — see connectors-endpoint.js.
        const res = await window.Auth.authedFetch(WORKER_URL + '/api/connectors/' + provider + '/start?returnTo=chat');
        const data = await res.json();
        if (!res.ok || !data.url) throw new Error(data.error || 'Could not start connection.');
        // Full-page navigation — the provider's consent screen redirects
        // back to this same chat page when done; the conversation is
        // saved and will still be here afterward.
        window.location.href = data.url;
      } catch (err) {
        showToast('Could not connect ' + CONNECTOR_META[provider].label + ': ' + err.message);
        connectBtn.disabled = false;
        connectBtn.textContent = 'Connect';
      }
      return;
    }

    if (disconnectBtn) {
      const provider = disconnectBtn.dataset.provider;
      const confirmed = confirm('Disconnect ' + CONNECTOR_META[provider].label + '? Cognita will no longer be able to use it in chat until you reconnect.');
      if (!confirmed) return;

      disconnectBtn.disabled = true;
      disconnectBtn.textContent = 'Disconnecting…';
      try {
        const res = await window.Auth.authedFetch(WORKER_URL + '/api/connectors/' + provider + '/disconnect', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not disconnect.');
        loadConnectorsList();
      } catch (err) {
        showToast('Could not disconnect ' + CONNECTOR_META[provider].label + ': ' + err.message);
        disconnectBtn.disabled = false;
        disconnectBtn.textContent = 'Disconnect';
      }
    }
  });
}

// Landed here from a provider's OAuth redirect (returnTo=chat)? Show a
// one-line result banner inside the Connected Apps modal and open the
// modal so it's actually visible, then strip the query params so a
// refresh doesn't re-show it. Mirrors account.html's banner for the
// three outcomes connectors-endpoint.js can redirect back with:
// connected, denied (user cancelled — not an error), and error.
function showConnectorRedirectBanner() {
  const params = new URLSearchParams(window.location.search);
  const provider = params.get('connector');
  const status = params.get('status');
  const reason = params.get('reason');
  if (!provider || !status) return;

  const label = CONNECTOR_META[provider] ? CONNECTOR_META[provider].label : provider;
  const messages = {
    connected: label + ' connected.',
    denied: label + ' connection was cancelled.',
    error: reason === 'session_expired'
      ? 'Your sign-in session with ' + label + ' expired before the connection finished. This happens if ' + label + ' asked for extra verification and it took a while to complete. Try connecting again, and stay in the same tab until it is done.'
      : 'Something went wrong connecting ' + label + '. Please try again.',
  };

  const banner = document.getElementById('connectorsBanner');
  if (banner && messages[status]) {
    banner.textContent = messages[status];
    banner.classList.toggle('is-error', status === 'error');
    banner.hidden = false;
  }

  openConnectorsModal();

  // Clean the URL so refreshing doesn't re-show the banner or re-open
  // the modal.
  window.history.replaceState({}, '', window.location.pathname);
}

// ── Recover from a stuck "Connecting…"/"Disconnecting…" button ──────
// Same bfcache issue as account.html: window.location.href leaves this
// page's state untouched until the browser actually navigates away, so
// a back-button return or interrupted navigation can restore this page
// from bfcache with a button still stuck disabled mid-label. `pageshow`
// with event.persisted fires exactly on that restore (never on a normal
// fresh load), so this can't clobber a click that's genuinely about to
// navigate away. Re-running loadConnectorsList() rebuilds every row from
// real, freshly-fetched status, which never renders a "Connecting…" /
// "Disconnecting…" state — only "Connect" or "Disconnect" — so this
// covers both button kinds and any number of connector rows at once.
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !document.getElementById('connectorsModal').hidden) {
    loadConnectorsList();
  }
});
