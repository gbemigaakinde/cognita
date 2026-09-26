// insights-digest.js
// Core logic for the AI Insights Digest feature — pulls Facebook/
// Instagram insights, has the LLM turn them into a plain-language
// digest, renders a branded PDF, uploads it to B2, and delivers it by
// email plus an in-app "Share to WhatsApp" link.
//
// NOTE ON WHATSAPP: per the user's explicit direction, this does NOT use
// Twilio's WhatsApp Business API (no Twilio account, no per-message
// cost, no separate approval process). Instead, deliverDigest() builds a
// wa.me deep link pre-filled with a short message + the signed PDF URL,
// and the frontend (insights.html) shows a "Share to WhatsApp" button
// that opens it — the user picks the contact and taps send themselves,
// exactly like Part 1's "user always taps send" rule for the Inbox. This
// is why insightsSchedules has no automatic WhatsApp delivery: wa.me
// cannot send on its own, only pre-fill a compose screen for a human.

import { fsGet, fsSet, fsUpdate, fsQuery } from './firestore-rest.js';
import { b2UploadFile } from './b2-client.js';
import { signDownloadToken } from './download-proxy.js';
import { callWithFallback } from './providers.js';
import { MODEL_TIERS } from './entitlements.js';
import { extractJson } from './json-extract.js';
import { getPageInsights, getInstagramInsights, listPages } from './meta-tools.js';
import { buildStructuredPdfBytes } from './pdf-builder.js';
import { sendEmail } from './emails/mailer.js';

// Cloudflare Cron Trigger execution limits — same reasoning as
// social-scheduler.js's BATCH_SIZE: if there could be many due
// schedules, process a bounded batch per tick rather than looping
// unboundedly. Anything left over just waits for the next 5-minute tick.
const BATCH_SIZE = 5;

function _nowIso() {
  return new Date().toISOString();
}

function _periodLabel(periodStart, periodEnd) {
  const s = new Date(periodStart);
  const e = new Date(periodEnd);
  const opts = { month: 'long', day: 'numeric' };
  return s.toLocaleDateString('en-US', opts) + ' – ' + e.toLocaleDateString('en-US', opts);
}

/**
 * Core generation: pulls insights for the given pages, asks the LLM to
 * summarize them, builds + uploads a PDF, and delivers it. Callable
 * on-demand ("Generate now") or from the scheduled job.
 */
export async function generateDigest(env, uid, { pageIds, periodDays = 7, deliverEmail, emailAddress } = {}) {
  const id = crypto.randomUUID();
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - periodDays * 24 * 60 * 60 * 1000);

  await fsSet('insightsDigests/' + id, {
    id, uid, periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), pageIds,
    summary: null, pdfKey: null, pdfFileId: null,
    deliveredTo: { email: false, whatsapp: false },
    status: 'generating',
    createdAt: _nowIso(),
  }, env);

  try {
    const pageData = [];
    for (const pageId of pageIds) {
      try {
        const fb = await getPageInsights(uid, pageId, env);
        pageData.push({ platform: 'facebook', ...fb });
      } catch (e) {
        console.error('[insights-digest] page insights failed for', pageId, ':', e.message);
      }
      try {
        const ig = await getInstagramInsights(uid, pageId, env);
        if (ig.instagram) pageData.push({ platform: 'instagram', ...ig });
      } catch (e) {
        console.error('[insights-digest] instagram insights failed for', pageId, ':', e.message);
      }
    }

    const systemPrompt = [
      'You write short, plain-language social media performance digests for a small business owner who is not a data analyst.',
      'Ground everything ONLY in the numbers given to you — never invent metrics, numbers, or facts you were not given.',
      'Be warm, encouraging, and concrete. Suggest specific, actionable next steps.',
      'Respond with STRICT JSON only, no markdown, in exactly this shape: ' +
      '{"highlights": ["..."], "whatWorked": "...", "whatDidnt": "...", "contentSuggestions": ["..."], "recommendedPostingTimes": ["..."]}',
    ].join(' ');

    const userPrompt = 'Raw data for the last ' + periodDays + ' days:\n' + JSON.stringify(pageData, null, 2).slice(0, 12000);

    const result = await callWithFallback(MODEL_TIERS.fast, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], env, { maxTokens: 3500 });

    const parsed = extractJson(result.text);
    const summary = parsed && typeof parsed === 'object' ? {
      highlights: Array.isArray(parsed.highlights) ? parsed.highlights : [],
      whatWorked: typeof parsed.whatWorked === 'string' ? parsed.whatWorked : '',
      whatDidnt: typeof parsed.whatDidnt === 'string' ? parsed.whatDidnt : '',
      contentSuggestions: Array.isArray(parsed.contentSuggestions) ? parsed.contentSuggestions : [],
      recommendedPostingTimes: Array.isArray(parsed.recommendedPostingTimes) ? parsed.recommendedPostingTimes : [],
    } : {
      highlights: [], whatWorked: 'Not enough data to summarize this period.', whatDidnt: '',
      contentSuggestions: [], recommendedPostingTimes: [],
    };

    const title = 'Your ' + _periodLabel(periodStart, periodEnd) + ' Performance Digest';
    const structured = {
      title,
      sections: [
        { heading: 'Highlights', type: 'bullets', content: summary.highlights },
        { heading: 'What worked', type: 'paragraph', content: summary.whatWorked },
        { heading: "What didn't", type: 'paragraph', content: summary.whatDidnt },
        { heading: 'Suggestions for next period', type: 'bullets', content: summary.contentSuggestions },
        { heading: 'Best times to post', type: 'bullets', content: summary.recommendedPostingTimes },
      ],
    };

    const pdfBytes = await buildStructuredPdfBytes(structured, title, 'classic');
    const pdfKey = 'insights/' + uid + '/' + id + '.pdf';
    const upload = await b2UploadFile(env, pdfKey, pdfBytes, 'application/pdf');

    await fsUpdate('insightsDigests/' + id, {
      status: 'ready', summary, pdfKey, pdfFileId: upload.fileId,
    }, env);

    await deliverDigest(env, uid, id, { deliverEmail, emailAddress });

    return getDigest(env, uid, id);
  } catch (e) {
    console.error('[insights-digest] generation failed:', e.message);
    await fsUpdate('insightsDigests/' + id, { status: 'failed', error: e.message }, env).catch(() => {});
    throw e;
  }
}

export async function getDigest(env, uid, digestId) {
  const digest = await fsGet('insightsDigests/' + digestId, env);
  if (!digest || digest.uid !== uid) {
    const e = new Error('Digest not found.');
    e.isNotFound = true;
    throw e;
  }
  return digest;
}

/** GET /api/insights/history — fsQuery by uid, ordered by createdAt desc. */
export async function listDigests(env, uid, limit = 25) {
  return fsQuery('insightsDigests', 'uid', uid, 'createdAt', limit, env, 'DESCENDING');
}

/**
 * Mints the signed proxy URL for a digest's PDF (used by both the email
 * button and the WhatsApp share link) — same signed-token pattern as
 * buildSocialMediaFetchUrl in social-media-endpoint.js, just a different
 * scope string and B2 prefix.
 */
export async function buildInsightsFileUrl(env, pdfKey, ttlSeconds = 7 * 24 * 60 * 60) {
  const token = await signDownloadToken(env, { scope: 'insights-pdf', key: pdfKey, contentType: 'application/pdf' }, ttlSeconds);
  const origin = env.WORKER_ORIGIN || 'https://api.cognita.com.ng';
  return origin + '/api/insights/file?token=' + encodeURIComponent(token);
}

/** Builds a wa.me share link pre-filled with a short message + the signed PDF URL. Requires a human tap to actually send — see file header note. */
export function buildWhatsAppShareUrl(title, pdfUrl) {
  const text = 'Here is my ' + title + ' from Cognita: ' + pdfUrl;
  return 'https://wa.me/?text=' + encodeURIComponent(text);
}

/**
 * Delivers a ready digest by email (automatic) and prepares its
 * WhatsApp share link (manual — see file header). `deliverEmail`/
 * `emailAddress` are explicit overrides for the on-demand "generate +
 * send me this one now" case; otherwise falls back to the user's saved
 * insightsSchedules/{uid} preferences.
 */
export async function deliverDigest(env, uid, digestId, overrides = {}) {
  const digest = await getDigest(env, uid, digestId);
  if (digest.status !== 'ready') return digest;

  let schedule = null;
  try {
    schedule = await fsGet('insightsSchedules/' + uid, env);
  } catch (e) {
    // No saved schedule yet is fine for the on-demand path.
  }

  const wantsEmail = overrides.deliverEmail !== undefined ? overrides.deliverEmail : !!(schedule && schedule.deliverEmail);
  const toAddress = overrides.emailAddress || (schedule && schedule.emailAddress) || null;

  const pdfUrl = await buildInsightsFileUrl(env, digest.pdfKey);
  const deliveredTo = { email: false, whatsapp: false };

  if (wantsEmail && toAddress) {
    try {
      const highlightsHtml = (digest.summary.highlights || []).map((h) => '<li>' + h + '</li>').join('');
      await sendEmail(env, toAddress, {
        subject: 'Your latest Cognita performance digest',
        html: '<h2>Your performance digest is ready</h2><ul>' + highlightsHtml + '</ul>' +
          '<p><a href="' + pdfUrl + '">Download the full PDF report</a></p>',
        text: 'Your performance digest is ready. Download it here: ' + pdfUrl,
      });
      deliveredTo.email = true;
    } catch (e) {
      console.error('[insights-digest] email delivery failed:', e.message);
    }
  }

  // WhatsApp is never sent automatically — see file header. We just
  // record that a share link is available; insights.html renders the
  // actual "Share to WhatsApp" button from pdfUrl on the frontend.
  deliveredTo.whatsapp = false;

  await fsUpdate('insightsDigests/' + digestId, { deliveredTo }, env).catch(() => {});
  return { ...digest, deliveredTo, pdfUrl };
}

function _isDue(schedule, now) {
  if (!schedule.lastSentAt) return true;
  const last = new Date(schedule.lastSentAt).getTime();
  if (schedule.frequency === 'weekly') return now - last >= 7 * 24 * 60 * 60 * 1000;
  if (schedule.frequency === 'monthly') {
    const lastDate = new Date(schedule.lastSentAt);
    const nowDate = new Date(now);
    const monthsElapsed = (nowDate.getFullYear() - lastDate.getFullYear()) * 12 + (nowDate.getMonth() - lastDate.getMonth());
    return monthsElapsed >= 1;
  }
  return false;
}

/**
 * Scheduled job, wired into worker.js's scheduled() the same way as
 * runReminderScheduler/runSocialScheduler. Queries insightsSchedules
 * for enabled==true (single-field equality — fsQuery's one supported
 * filter), checks which are actually due, and generates+delivers for
 * each, in a bounded batch per tick.
 */
export async function runInsightsDigestScheduler(env) {
  let rows;
  try {
    rows = await fsQuery('insightsSchedules', 'enabled', true, 'lastSentAt', 100, env, 'ASCENDING');
  } catch (e) {
    console.error('[insights-digest] scheduler query failed:', e.message);
    return;
  }

  const now = Date.now();
  const due = rows.filter((s) => _isDue(s, now)).slice(0, BATCH_SIZE);

  for (const schedule of due) {
    try {
      const periodDays = schedule.frequency === 'monthly' ? 30 : 7;
      await generateDigest(env, schedule.uid, {
        pageIds: schedule.pageIds || [],
        periodDays,
        deliverEmail: schedule.deliverEmail,
        emailAddress: schedule.emailAddress,
      });
      await fsUpdate('insightsSchedules/' + schedule.uid, { lastSentAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() }, env);
    } catch (e) {
      // Per-schedule try/catch, same discipline as runSocialScheduler —
      // one user's failure must never block the rest of the batch.
      console.error('[insights-digest] scheduled generation failed for', schedule.uid, ':', e.message);
    }
  }
}
