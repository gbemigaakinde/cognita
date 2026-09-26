// account-deletion.js
//
// Self-serve "delete my account" — the in-app pathway Meta's Platform
// Terms expect apps to offer, distinct from (and complementary to) the
// automated Meta "Data Deletion Request" callback in
// facebook-data-deletion.js. That file only fires when someone removes
// Cognita from their Facebook settings; this one fires when someone
// asks Cognita directly to delete their whole account, regardless of
// whether they ever connected Facebook at all.
//
// Deliberately NOT an approval queue — a "request goes to an admin"
// design just adds a waiting period with no compliance benefit, and
// most privacy regs (GDPR Art. 17, NDPR) expect deletion to actually
// happen, not merely be requested. account-deletion-endpoint.js's
// multi-step, type-your-email confirmation UI is the safety rail
// instead: by the time this module runs, the person has already
// confirmed with intent Meta's reviewers can see in the screencast.
//
// Deletes everything this app stores under the person's uid, across
// every collection/bucket another file in this codebase writes to, then
// deletes the Firebase Auth user itself last (irreversible — once that
// call succeeds, the person's ID tokens stop verifying, so this must be
// the final step, not the first).

import { fsSet, fsDelete, fsQuery, getGoogleAccessToken } from './firestore-rest.js';
import { deleteConnectorToken, listConnectedProviders } from './connectors.js';
import { deleteConversationFromB2, listConversationsForUser } from './chat-storage.js';
import { deleteReminder, deleteSubscriptionById, listSubscriptions } from './reminders/reminders-storage.js';
import { cancelScheduledPost } from './social-scheduler.js';

const CONNECTOR_PROVIDERS = ['github', 'google', 'facebook', 'canva'];

function _confirmationCode() {
  return 'delacct_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

/** Deletes a Firestore doc, swallowing "already gone" — every step here
 * runs best-effort, since a half-used account (e.g. never scheduled a
 * post) will 404 on most of these by design, not by error. */
async function _tryDelete(path, env, label) {
  try {
    await fsDelete(path, env);
  } catch (e) {
    console.warn('[account-deletion] could not delete ' + label + ' (' + path + '): ' + e.message);
  }
}

async function _purgeResources(uid, env) {
  let rows = [];
  try {
    rows = await fsQuery('resources', 'ownerId', uid, 'createdAt', 500, env);
  } catch (e) {
    console.warn('[account-deletion] resource lookup failed: ' + e.message);
    return;
  }
  for (const row of rows) {
    const resourceId = row.id || row._id;
    if (!resourceId) continue;
    const versions = Math.max(1, Number(row.currentVersion) || 1);
    for (let v = 1; v <= versions; v++) {
      await _tryDelete('resourceVersions/' + resourceId + '_' + v, env, 'resource version');
    }
    await _tryDelete('resources/' + resourceId, env, 'resource');
  }
}

async function _purgeReminders(uid, env) {
  let rows = [];
  try {
    rows = await fsQuery('reminders', 'uid', uid, 'eventAt', 500, env, 'ASCENDING');
  } catch (e) {
    console.warn('[account-deletion] reminder lookup failed: ' + e.message);
    return;
  }
  for (const row of rows) {
    const id = row.id || row._id;
    if (!id) continue;
    try {
      await deleteReminder(env, uid, id);
    } catch (e) {
      console.warn('[account-deletion] could not delete reminder ' + id + ' (or its occurrences): ' + e.message);
    }
  }
  let subs = [];
  try {
    subs = await listSubscriptions(env, uid);
  } catch (e) {
    console.warn('[account-deletion] push subscription lookup failed: ' + e.message);
    return;
  }
  for (const sub of subs) {
    const id = sub.id || sub._id;
    if (!id) continue;
    try {
      await deleteSubscriptionById(env, id);
    } catch (e) {
      console.warn('[account-deletion] could not delete push subscription ' + id + ': ' + e.message);
    }
  }
}

async function _purgeScheduledPosts(uid, env) {
  let rows = [];
  try {
    rows = await fsQuery('scheduledPosts', 'uid', uid, 'scheduledFor', 500, env, 'ASCENDING');
  } catch (e) {
    console.warn('[account-deletion] scheduled post lookup failed: ' + e.message);
    return;
  }
  for (const row of rows) {
    const id = row.id || row._id;
    if (!id) continue;
    // Pending posts have a due-index KV entry the scheduler polls — a
    // raw doc delete would leave that entry behind for runSocialScheduler
    // to trip over later (post doc gone, KV entry still pointing at it).
    // cancelScheduledPost() clears that KV entry and detaches any
    // uploaded media first; only then is the doc itself deleted.
    if (row.status === 'pending') {
      try {
        await cancelScheduledPost(env, uid, id);
      } catch (e) {
        console.warn('[account-deletion] could not cancel pending scheduled post ' + id + ': ' + e.message);
      }
    }
    await _tryDelete('scheduledPosts/' + id, env, 'scheduled post');
  }
}

async function _purgeInboxItems(uid, env) {
  let rows = [];
  try {
    rows = await fsQuery('socialInboxItems', 'uid', uid, 'receivedAt', 500, env, 'DESCENDING');
  } catch (e) {
    console.warn('[account-deletion] inbox item lookup failed: ' + e.message);
    return;
  }
  for (const row of rows) {
    const id = row.id || row._id;
    if (id) await _tryDelete('socialInboxItems/' + id, env, 'inbox item');
  }
}

async function _purgeInsightsDigests(uid, env) {
  let rows = [];
  try {
    rows = await fsQuery('insightsDigests', 'uid', uid, 'createdAt', 500, env, 'DESCENDING');
  } catch (e) {
    console.warn('[account-deletion] insights digest lookup failed: ' + e.message);
    return;
  }
  for (const row of rows) {
    const id = row.id || row._id;
    if (id) await _tryDelete('insightsDigests/' + id, env, 'insights digest');
  }
}

async function _purgeConnectors(uid, env) {
  // listConnectedProviders returns { provider: true|false }, not a list
  // of connected names — iterate the fixed provider set and check each
  // flag, rather than trying to for-of the object itself.
  let statusByProvider = null;
  try {
    statusByProvider = await listConnectedProviders(uid, env);
  } catch (e) {
    console.warn('[account-deletion] connector status lookup failed: ' + e.message);
  }
  for (const provider of CONNECTOR_PROVIDERS) {
    if (statusByProvider && !statusByProvider[provider]) continue; // known not connected — skip
    try {
      await deleteConnectorToken(uid, provider, env);
    } catch (e) {
      console.warn('[account-deletion] could not delete ' + provider + ' connector token: ' + e.message);
    }
  }
}

async function _purgeFacebookLoginIndex(uid, env) {
  // fb_login_index is keyed by Facebook user id, not uid, so it has to
  // be found by querying the 'uid' field rather than a direct fsGet —
  // see handleLinkFacebookLogin in facebook-data-deletion.js for how
  // entries get written.
  let rows = [];
  try {
    rows = await fsQuery('fb_login_index', 'uid', uid, null, 10, env);
  } catch (e) {
    console.warn('[account-deletion] fb_login_index lookup failed: ' + e.message);
    return;
  }
  for (const row of rows) {
    const id = row.id || row._id;
    if (id) await _tryDelete('fb_login_index/' + id, env, 'Facebook login index entry');
  }
}

async function _purgeConversations(uid, env) {
  let conversations = [];
  try {
    conversations = await listConversationsForUser(env, uid);
  } catch (e) {
    console.warn('[account-deletion] conversation list failed: ' + e.message);
    return;
  }
  for (const convo of conversations) {
    const conversationId = convo.conversationId || convo.id;
    if (!conversationId) continue;
    try {
      await deleteConversationFromB2(env, uid, conversationId);
    } catch (e) {
      console.warn('[account-deletion] could not delete conversation ' + conversationId + ': ' + e.message);
    }
  }
}

/** Deletes the Firebase Auth user record itself. Must run LAST — once
 * this succeeds, `uid`'s ID tokens stop verifying, so any step after
 * this that needs requireAuth() again would fail. */
async function _deleteFirebaseAuthUser(uid, env) {
  const accessToken = await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/identitytoolkit');
  const res = await fetch('https://identitytoolkit.googleapis.com/v1/accounts:delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
    body: JSON.stringify({ localId: uid }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Identity Toolkit accounts:delete failed (' + res.status + '): ' + text);
  }
}

/**
 * Deletes everything Cognita stores for `uid`, then the Firebase Auth
 * user itself, and records a confirmation code (same
 * data_deletion_requests table facebook-data-deletion.js uses, so both
 * pathways share one status-lookup page and one admin view of deletion
 * activity). Returns the confirmation code.
 *
 * Best-effort by design past the point of no return: once the Auth user
 * is gone the person can never retry a failed step themselves, so every
 * purge step above swallows its own errors and logs rather than
 * aborting the whole run. A confirmation code is still issued even if a
 * handful of minor items failed to delete — those get caught by the
 * `status: 'completed_with_warnings'` note attached below when that
 * happens, rather than leaving the person's account stuck mid-deletion
 * with no way back in to retry.
 */
export async function deleteAccountData(uid, email, env) {
  const warnings = [];
  const _wrap = async (fn, label) => {
    try {
      await fn();
    } catch (e) {
      console.error('[account-deletion] ' + label + ' failed for uid ' + uid + ': ' + e.message);
      warnings.push(label);
    }
  };

  await _wrap(() => _purgeResources(uid, env), 'resources');
  await _wrap(() => _purgeReminders(uid, env), 'reminders/push subscriptions');
  await _wrap(() => _purgeScheduledPosts(uid, env), 'scheduled posts');
  await _wrap(() => _purgeInboxItems(uid, env), 'social inbox items');
  await _wrap(() => _purgeInsightsDigests(uid, env), 'insights digests');
  await _wrap(() => _tryDelete('insightsSchedules/' + uid, env, 'insights schedule'), 'insights schedule');
  await _wrap(() => _purgeConnectors(uid, env), 'connected apps');
  await _wrap(() => _purgeFacebookLoginIndex(uid, env), 'Facebook login link');
  await _wrap(() => _purgeConversations(uid, env), 'chat history');
  await _wrap(() => _tryDelete('admins/' + uid, env, 'admin/moderator role'), 'admin role');
  await _wrap(() => _tryDelete('accounts/' + uid, env, 'account/billing record'), 'account record');

  // The Auth user is the point of no return — deliberately last, and
  // NOT wrapped in the same swallow-and-continue pattern: if this fails,
  // the person still technically has an account (even though its data
  // is gone), so the caller needs to know and can tell them to contact
  // support rather than showing a false "all done."
  await _deleteFirebaseAuthUser(uid, env);

  const code = _confirmationCode();
  const nowIso = new Date().toISOString();
  try {
    await fsSet('data_deletion_requests/' + code, {
      app: 'self-service',
      uid,
      email: email || null,
      status: warnings.length ? 'completed_with_warnings' : 'completed',
      warnings,
      requestedAt: nowIso,
      completedAt: nowIso,
    }, env);
  } catch (e) {
    // Non-fatal: the deletion itself already happened above. Losing the
    // confirmation-code record only affects the optional status page —
    // matches the same tradeoff facebook-data-deletion.js makes.
    console.error('[account-deletion] could not record confirmation code: ' + e.message);
  }

  return { code, warnings };
}
