// entitlements.js
// SINGLE SOURCE OF TRUTH for plan names, pricing, limits, and model access.
// Nothing else in the codebase should hard-code a plan name, a limit number,
// or a price. Frontend pages fetch this via /api/plans; the Worker imports
// it directly for enforcement.

// Workers AI's free vision-capable model, used for image understanding.
// It's on the Workers AI free tier (10,000 neurons/day), so it never
// touches the paid Groq/OpenRouter usage the rest of this app relies on —
// it's gated by plan (models.vision) and metered separately
// (limits.visionPerDay) below.
export const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

// Sentinel used for staff limits that are functionally unlimited. Kept
// as a real (large) number rather than Infinity so it survives
// JSON.stringify to the frontend and still compares correctly against
// usage.js's KV counters. Chosen to be display-friendly: the frontend
// treats any limit >= this as "Unlimited" rather than printing the raw
// number (see js/app.js).
export const UNLIMITED = 999999;

export const PLANS = {
  free: {
    id: 'free',
    name: 'Cognita Starter',
    public: true, // shown on the marketing pricing page / returned by /api/plans
    priceNGN: 0,
    priceUSD: 0,
    paystackPlanCode: null, // no recurring charge for free tier
    limits: {
      messagesPerDay: 25,
      advancedModelPerDay: 0,      // no access to higher-tier models
      imageGenPerDay: 2,
      documentGenPerDay: 3,
      resourceGenPerDay: 3,
      fileUploadsPerDay: 5,
      maxFileSizeMB: 5,
      maxContextMessages: 8,       // how much conversation history is sent
      visionPerDay: 0,             // no image-understanding on Starter
      toolCallsPerDay: 0,          // no connector tool-use on Starter
      noteTakerSessionsPerDay: 3,
      noteTakerChunksPerDay: 200,   // ~8s/chunk -> roughly 27 minutes/day
      // Real, AI-generated illustrations rendered onto flashcard faces
      // (Cloudflare Workers AI, same model as illustration image gen).
      // Free users never get these — text-only flashcards only.
      flashcardImagePerDay: 0,
      activeReminders: 10,
      // AI Inbox and Insights Digest are both gated off entirely on
      // Starter via planHasAiInbox/planHasInsightsDigest below (same
      // features.connectorTools-style flag pattern), so these limits
      // are never actually reached on this plan — kept at 0 anyway so
      // the shape of `limits` stays identical across every plan.
      inboxAiDraftPerDay: 0,
      insightsDigestPerDay: 0,
    },
    models: {
      chat: ['fast'],              // maps to internal model tier keys below
      vision: false,
      // Can this plan attach real generated images to flashcards at all?
      // Kept distinct from `vision` (image *understanding*) even though
      // Starter happens to be false for both right now, because these are
      // conceptually different capabilities that could diverge later.
      flashcardImages: false,
    },
    features: {
      documentExport: true,        // docx/pdf export, basic
      prioritySupport: false,
      longContext: false,
      designTemplates: false,
      connectorTools: false,       // chat cannot call connected-app tools
      aiInbox: false,               // AI Inbox (comment/DM triage) — see planHasAiInbox
      insightsDigest: false,        // AI Insights Digest — see planHasInsightsDigest
    },
  },
  plus: {
    id: 'plus',
    name: 'Cognita Plus',
    public: true, // shown on the marketing pricing page / returned by /api/plans
    priceNGN: 4500,
    priceUSD: 6,
    paystackPlanCode: 'PLN_yoh2zim6qlr20c0',
    limits: {
      messagesPerDay: 300,
      advancedModelPerDay: 60,
      imageGenPerDay: 25,
      documentGenPerDay: 30,
      resourceGenPerDay: 30,
      fileUploadsPerDay: 40,
      maxFileSizeMB: 20,
      maxContextMessages: 24,
      visionPerDay: 15,
      toolCallsPerDay: 30,
      noteTakerSessionsPerDay: 30,
      noteTakerChunksPerDay: 2000,  // roughly 4.4 hours/day
      // One deck's worth of illustrated cards per day, roughly — kept
      // well below imageGenPerDay since a single flashcard deck can
      // burn through many images in one generation call.
      flashcardImagePerDay: 20,
      activeReminders: 40,
      inboxAiDraftPerDay: 30,
      insightsDigestPerDay: 4,
    },
    models: {
      chat: ['fast', 'advanced'],
      vision: true,
      flashcardImages: true,
    },
    features: {
      documentExport: true,
      prioritySupport: false,
      longContext: true,
      designTemplates: true,
      connectorTools: true,
      aiInbox: true,
      insightsDigest: true,
    },
  },
  studio: {
    id: 'studio',
    name: 'Cognita Studio',
    public: true, // shown on the marketing pricing page / returned by /api/plans
    priceNGN: 12000,
    priceUSD: 16,
    paystackPlanCode: 'PLN_23azph4eskh5wwj',
    limits: {
      messagesPerDay: 1200,
      advancedModelPerDay: 400,
      imageGenPerDay: 100,
      documentGenPerDay: 150,
      resourceGenPerDay: 150,
      fileUploadsPerDay: 150,
      maxFileSizeMB: 50,
      maxContextMessages: 60,
      visionPerDay: 60,
      toolCallsPerDay: 150,
      noteTakerSessionsPerDay: 150,
      noteTakerChunksPerDay: 8000,  // roughly 17.8 hours/day
      flashcardImagePerDay: 80,
      activeReminders: 150,
      inboxAiDraftPerDay: 150,
      insightsDigestPerDay: 20,
    },
    models: {
      chat: ['fast', 'advanced', 'reasoning'],
      vision: true,
      flashcardImages: true,
    },
    features: {
      documentExport: true,
      prioritySupport: true,
      longContext: true,
      designTemplates: true,
      connectorTools: true,
      aiInbox: true,
      insightsDigest: true,
    },
  },

  // ─────────────────────────────────────────────────────────────────
  // Staff-only pseudo-plan. Never purchasable, never returned by
  // subscription.js on its own — it is only ever applied as an
  // override, and only for a Firestore admins/{uid} doc with
  // role: 'admin' specifically (never 'moderator', never a plain
  // user). See subscription.js#resolveAccountWithRole, the single
  // place that decides who gets this. Moderators and regular users
  // always resolve to one of the plans above, exactly as before.
  // ─────────────────────────────────────────────────────────────────
  admin: {
    id: 'admin',
    name: 'Cognita Admin',
    public: false, // staff-only override — must NEVER be returned by /api/plans
    priceNGN: 0,
    priceUSD: 0,
    paystackPlanCode: null,
    limits: {
      messagesPerDay: UNLIMITED,
      advancedModelPerDay: UNLIMITED,
      imageGenPerDay: UNLIMITED,
      documentGenPerDay: UNLIMITED,
      resourceGenPerDay: UNLIMITED,
      fileUploadsPerDay: UNLIMITED,
      maxFileSizeMB: 50,
      maxContextMessages: 60,
      visionPerDay: UNLIMITED,
      toolCallsPerDay: UNLIMITED,
      noteTakerSessionsPerDay: UNLIMITED,
      noteTakerChunksPerDay: UNLIMITED,
      flashcardImagePerDay: UNLIMITED,
      activeReminders: UNLIMITED,
      inboxAiDraftPerDay: UNLIMITED,
      insightsDigestPerDay: UNLIMITED,
    },
    models: {
      // Every tier a regular plan can reach, PLUS 'v0' — the Vercel v0
      // provider — which is exclusive to this plan. Nothing outside
      // this admin override ever includes 'v0' in its chat tiers, so
      // moderators/users can never select or be routed to it even if
      // they tamper with a client-side request (chat-endpoint.js
      // re-validates the requested tier against the plan resolved
      // server-side from the verified uid, same as every other tier).
      chat: ['fast', 'advanced', 'reasoning', 'v0'],
      vision: true,
      flashcardImages: true,
    },
    features: {
      documentExport: true,
      prioritySupport: true,
      longContext: true,
      designTemplates: true,
      connectorTools: true,
      aiInbox: true,
      insightsDigest: true,
    },
  },
};

// Can this plan use connected-app tools (GitHub/Google/Facebook/Canva)
export function planHasConnectorTools(planId) {
  return !!getPlan(planId).features.connectorTools;
}

// The Social Scheduler (social-scheduler-endpoint.js) is gated on the
// same flag as connector tools generally, rather than a new per-plan
// field — it depends on the Facebook connector exactly the same way the
// in-chat Facebook/Instagram tools do, so there is no plan configuration
// where these two should ever disagree. Kept as its own named function
// (instead of every caller importing planHasConnectorTools directly) so
// that if scheduling ever does need its own flag, only this one line
// changes.
export function planHasSocialScheduling(planId) {
  return planHasConnectorTools(planId);
}

// AI Inbox (unified comment/DM triage with AI-drafted replies) — its own
// flag rather than reusing planHasConnectorTools, since this is a
// heavier, LLM-per-item feature that a plan could reasonably gate
// differently from generic connector tool-use later.
export function planHasAiInbox(planId) {
  return !!getPlan(planId).features.aiInbox;
}

// AI Insights Digest (scheduled/on-demand AI performance report as PDF).
export function planHasInsightsDigest(planId) {
  return !!getPlan(planId).features.insightsDigest;
}

// Internal model tier -> actual provider/model mapping.
// Changing a provider or model string only ever happens here.
//
// Each tier is a CHAIN: primary, then `fallback`, then `fallback.fallback`,
// and so on (as many levels deep as needed). providers.js walks this chain
// in order and only gives up once every step has failed. Every step in a
// chain should be able to carry tool-calls EXCEPT the very last "dumb"
// catch-all step, which exists purely so plain chat never goes fully dark
// even if every real provider is down — Workers AI never supports tools
// and must always be the final link, never the only fallback.
export const MODEL_TIERS = {
  fast: {
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
    fallback: {
      // OpenRouter's free router still supports tool-calling, so a Groq
      // rate limit (this tier's most common failure) no longer kills the
      // whole request — it lands here instead of failing outright.
      provider: 'openrouter',
      model: 'openrouter/free',
      fallback: {
        // Last resort only: no tool support, but keeps plain chat alive.
        provider: 'workersai',
        model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      },
    },
  },
  advanced: {
    provider: 'groq',
    model: 'openai/gpt-oss-120b',
    fallback: {
      provider: 'openrouter',
      model: 'openrouter/free',
      fallback: {
        // Still tool-capable and still "same tier" in spirit — much better
        // last resort than dropping straight to Workers AI.
        provider: 'groq',
        model: 'openai/gpt-oss-20b',
      },
    },
  },
  reasoning: {
    provider: 'openrouter',
    model: 'deepseek/deepseek-r1:free',
    fallback: {
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      fallback: { provider: 'groq', model: 'openai/gpt-oss-20b' },
    },
  },
  // Admin-only. See PLANS.admin — no regular plan's models.chat ever
  // includes 'v0', so this tier is unreachable outside a verified
  // admins/{uid} role: 'admin' override.
  //
  // NOTE: this does not actually call a v0 model. The real v0 models
  // (v0-1.0-md/v0-1.5-md) are excluded from Vercel AI Gateway's free
  // $5/month tier — they're billed-only, and this project doesn't have
  // Gateway billing enabled. Until that changes, this tier is routed
  // to a real, free-tier-eligible Gateway model instead so the "v0
  // (Admin)" option in the UI still works end-to-end at zero cost. To
  // switch to the genuine v0 model later: enable AI Gateway billing on
  // the Vercel team, then change `model` below to 'vercel/v0-1.0-md'
  // (or 'vercel/v0-1.5-md') — nothing else needs to change, since
  // provider 'vercel_v0' already points at the Gateway endpoint.
  v0: {
    provider: 'vercel_v0',
    model: 'deepseek/deepseek-v3.2',
    fallback: {
      provider: 'groq',
      model: 'openai/gpt-oss-120b',
      fallback: { provider: 'groq', model: 'openai/gpt-oss-20b' },
    },
  },
};

export const PLAN_HIERARCHY = ['free', 'plus', 'studio', 'admin'];

export function planRank(planId) {
  const i = PLAN_HIERARCHY.indexOf(planId);
  return i === -1 ? 0 : i;
}

export function getPlan(planId) {
  return PLANS[planId] || PLANS.free;
}

// Is `requiredPlan` satisfied by `userPlan`? (studio satisfies plus, etc.)
export function planSatisfies(userPlan, requiredPlan) {
  return planRank(userPlan) >= planRank(requiredPlan);
}

// Which model tiers can this plan use for chat?
export function allowedChatTiers(planId) {
  return getPlan(planId).models.chat;
}

// Resolve a requested tier down to the highest tier the plan actually permits.
// Never lets a request "upgrade" a user — only ever downgrades to what they're entitled to.
export function resolveChatTier(planId, requestedTier) {
  const allowed = allowedChatTiers(planId);
  if (allowed.includes(requestedTier)) return requestedTier;
  // fall back to the richest tier the plan actually has
  return allowed[allowed.length - 1];
}

// Can this plan attach images to a chat message?
export function planHasVision(planId) {
  return !!getPlan(planId).models.vision;
}

// Can this plan generate real illustrated images on flashcards?
export function planHasFlashcardImages(planId) {
  return !!getPlan(planId).models.flashcardImages;
}
