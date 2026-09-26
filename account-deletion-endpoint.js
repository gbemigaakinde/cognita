// account-deletion-endpoint.js
// POST /api/account/delete
//
// The confirmation itself (multi-step "here's what happens" → type your
// email, paste disabled → final confirm) lives in the account.html UI —
// see account.html's #deleteAccountModal. This endpoint is the last,
// server-side check: it re-verifies confirmEmail against the verified
// identity's OWN email (never a client-supplied uid), so a tampered or
// replayed request still can't delete the wrong account.
import { requireAuth, describeAuthError } from './auth-middleware.js';
import { deleteAccountData } from './account-deletion.js';
import { getAccount } from './subscription.js';

export async function handleAccountDeletionRequest(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return _jsonError('Invalid request body.', 400, env);
  }

  const confirmEmail = String(body?.confirmEmail || '').trim().toLowerCase();
  const actualEmail = String(identity.email || '').trim().toLowerCase();

  // No email on the account at all (e.g. a phone-only sign-in some other
  // provider allowed through) — refuse rather than silently accepting an
  // empty match, since an empty confirmEmail would otherwise "match" an
  // empty actualEmail and skip the confirmation entirely.
  if (!actualEmail) {
    return _jsonError(
      'Your account has no email on file to confirm against. Please contact support to delete your account.',
      400, env
    );
  }
  if (!confirmEmail || confirmEmail !== actualEmail) {
    return _jsonError('That email does not match the one on your account. Nothing was deleted.', 400, env);
  }

  // Block deletion while a paid subscription is still actively billing —
  // getAccount() applies expiry rules first (cancel-endpoint.js's own
  // comment notes this: "an already-expired plan is seen as free"), so
  // this only fires for a genuinely live, still-charging subscription,
  // not a lapsed one. 'cancelled' is allowed through: that status means
  // Paystack has already been told to stop, the person is just riding
  // out the paid period they already bought.
  let account;
  try {
    account = await getAccount(identity.uid, env);
  } catch (e) {
    console.error('[account-deletion] account lookup failed for uid ' + identity.uid + ': ' + e.message);
    return _jsonError('Could not verify your subscription status right now. Please try again.', 500, env);
  }
  if (account && account.planId !== 'free' && (account.status === 'active' || account.status === 'past_due')) {
    return _jsonError(
      'You have an active subscription. Please cancel it first from the Plan section, then come back to delete your account.',
      409, env
    );
  }

  let result;
  try {
    result = await deleteAccountData(identity.uid, identity.email, env);
  } catch (e) {
    // deleteAccountData only throws for the final, point-of-no-return
    // Auth-user deletion (everything before that swallows its own
    // errors) — so this means the person's data IS gone but their
    // account record technically still exists. Tell them plainly rather
    // than claiming success.
    console.error('[account-deletion] final account removal failed for uid ' + identity.uid + ': ' + e.message);
    return _jsonError(
      'Your data was deleted, but we could not fully close your account. Please contact support with this reference: ' + identity.uid,
      500, env
    );
  }

  return new Response(JSON.stringify({
    ok: true,
    confirmationCode: result.code,
    statusUrl: (env.APP_ORIGIN || 'https://app.cognita.com.ng') + '/data-deletion-status.html?id=' + result.code,
    partial: result.warnings.length > 0,
  }), { status: 200, headers: _corsJsonHeaders(env) });
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}
function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
