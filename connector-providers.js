// connector-providers.js
// The ONLY module that knows each provider's specific OAuth quirks —
// authorize URL shape, token endpoint, whether it wants JSON or
// form-encoded, Basic-auth vs body credentials, and whether refresh
// tokens exist at all. Everything above this file (connectors-endpoint.js)
// talks to all four providers through the same three functions:
// buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken.
//
// Scopes are intentionally hardcoded here, not passed in from the
// frontend — a scope list is a security decision, not a UI preference.

// Maps each provider to its Client ID / Secret env var names, matching
// exactly what was pushed via `wrangler secret put`.
const ENV_VARS = {
  github: { id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET' },
  google: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  facebook: { id: 'FACEBOOK_CLIENT_ID', secret: 'FACEBOOK_CLIENT_SECRET' },
  canva: { id: 'CANVA_CLIENT_ID', secret: 'CANVA_CLIENT_SECRET' },
};

// Graph API version pinned in one place — bump this, not the literal
// string, when Meta deprecates the current version.
const META_GRAPH_VERSION = 'v21.0';

function _creds(provider, env) {
  const vars = ENV_VARS[provider];
  const id = env[vars.id];
  const secret = env[vars.secret];
  if (!id || !secret) {
    throw new Error('Server misconfiguration: ' + vars.id + '/' + vars.secret + ' not set.');
  }
  return { id, secret };
}

function _redirectUri(provider, env) {
  // All four callbacks live at the same shape on this Worker — see
  // worker.js routing. WORKER_ORIGIN must be set to the Worker's own
  // deployed URL (not APP_ORIGIN, which is the frontend).
  const origin = env.WORKER_ORIGIN || 'https://api.cognita.com.ng';
  return origin + '/auth/' + provider + '/callback';
}

function _form(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

function _basicAuthHeader(id, secret) {
  return 'Basic ' + btoa(id + ':' + secret);
}

// ── Per-provider scopes ─────────────────────────────────────────────
// Keep these as narrow as the actual features need — see the scope
// discussion for Figma and Canva. Widening a scope later is a small,
// visible change here; requesting broad scopes up front is not
// reversible for users who already granted them.
const SCOPES = {
  github: 'repo', // full read/write on public AND private repos — see hasSufficientScope() below
  // Narrowed (2026-09) to only scopes Google classifies as "sensitive" or
  // "non-sensitive" — NOT "restricted". Restricted scopes (drive,
  // gmail.modify, gmail.readonly, gmail.compose, etc.) force the app
  // through an annual third-party CASA security assessment before going
  // to production, on top of normal OAuth verification. See
  // https://support.google.com/cloud/answer/13464325 for Google's
  // authoritative restricted-scope list; this project deliberately stays
  // off of it:
  //   - calendar.events + calendar.readonly: sensitive, NOT restricted —
  //     full CRUD on events across any calendar the user can see, plus
  //     listing the calendars themselves. No CASA required.
  //   - drive.file: non-sensitive, NOT restricted — read/write only on
  //     files this app itself created (or that a Picker flow explicitly
  //     hands it, which this app does not implement). This is narrower
  //     than the old blanket 'drive' scope: Cognita can no longer browse
  //     or search a user's pre-existing Drive files, only ones it made.
  //   - gmail.send: sensitive, NOT restricted — send mail only.
  //   - gmail.labels: non-sensitive, NOT restricted — create/list/update/
  //     delete label *definitions* only. It does NOT allow applying or
  //     removing labels on a message, reading message content, searching
  //     mail, creating drafts, or trashing mail — all of those require
  //     gmail.modify/gmail.compose/gmail.readonly, which are restricted.
  //     Those tools have been removed from google-tools.js accordingly.
  google: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.readonly',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/gmail.send',
    'https://www.googleapis.com/auth/gmail.labels',
  ].join(' '),
  // A single Facebook Login for Business consent screen grants both the
  // Page-management scopes and the Instagram ones together — Instagram
  // posting is done through a Page's linked Instagram Business Account,
  // there is no separate "Instagram OAuth". Kept to exactly what
  // meta-tools.js uses:
  //   - pages_show_list / pages_read_engagement: list the user's Pages
  //     and read basic engagement metrics.
  //   - pages_manage_posts / pages_manage_metadata: create Page feed
  //     posts and read the Page's own metadata (incl. its linked IG
  //     account id via the instagram_business_account field).
  //   - instagram_basic / instagram_content_publish: read the linked IG
  //     Business account and publish media to it.
  //   - read_insights: Page and IG account insights (reach, impressions).
  //   - business_management: required by Meta for most Page-posting
  //     scopes when the Page is owned by a Business Portfolio.
  facebook: [
    'pages_show_list', 'pages_read_engagement', 'pages_manage_posts', 'pages_manage_metadata',
    'instagram_basic', 'instagram_content_publish', 'read_insights', 'business_management',
    // ── AI Inbox scopes (comments + DMs) — see hasInboxScope() below.
    // NOTE: 'pages_manage_engagement' is this codebase's best-current-
    // knowledge name for Facebook Page comment moderation/reply under
    // Graph API v21.0 (meta-tools.js's GRAPH_VERSION) — confirm against
    // Meta's live App Review docs before submitting, since Meta renames
    // permissions periodically.
    'pages_messaging', 'instagram_manage_messages', 'instagram_manage_comments', 'pages_manage_engagement',
  ].join(','),
  canva: 'folder:permission:read design:content:read design:content:write asset:read profile:read design:meta:read asset:write folder:read',
};

// ── Scope sufficiency check ─────────────────────────────────────────
// Only meaningful for GitHub right now. Tokens issued before the scope
// changed from 'public_repo' to 'repo' still work but can't see private
// repos — this lets getValidToken() (connectors.js) detect that and
// force a reconnect instead of quietly returning an incomplete result.
// GitHub returns granted scopes as a comma-separated string, e.g.
// "repo,gist" — split defensively in case of stray spaces.
export function hasSufficientScope(provider, storedScope) {
  if (provider === 'github') {
    const granted = (storedScope || '').split(',').map((s) => s.trim());
    return granted.includes('repo');
  }
  if (provider === 'google') {
    // Google returns granted scopes space-separated. Accounts connected
    // before the 2026-09 narrowing may have the old restricted set
    // (bare 'drive', 'gmail.modify') instead of the current one
    // ('drive.file', no gmail.modify) — either mismatch means the stored
    // token doesn't match what google-tools.js now expects, so force a
    // reconnect instead of letting tools silently 403 or (worse) run
    // against stale broader access than we mean to use.
    const granted = (storedScope || '').split(' ').map((s) => s.trim());
    return (
      granted.includes('https://www.googleapis.com/auth/drive.file') &&
      !granted.includes('https://www.googleapis.com/auth/gmail.modify') &&
      granted.includes('https://www.googleapis.com/auth/gmail.send') &&
      granted.includes('https://www.googleapis.com/auth/gmail.labels')
    );
  }
  if (provider === 'facebook') {
    // Facebook returns granted scopes comma-separated. The three scopes
    // that actually gate what meta-tools.js can do (list Pages, post to
    // a Page, publish to Instagram) — if a pre-existing connection is
    // missing any of these (e.g. connected before Instagram publishing
    // was added), force a reconnect rather than letting posting silently
    // fail with a Graph API permission error mid-tool-call.
    const granted = (storedScope || '').split(',').map((s) => s.trim());
    return (
      granted.includes('pages_manage_posts') &&
      granted.includes('instagram_content_publish') &&
      granted.includes('pages_show_list')
    );
  }
  return true; // not implemented for canva yet
}

// ── AI Inbox scope check — deliberately separate from
// hasSufficientScope('facebook', ...) above. A user can have the
// Social Scheduler's scopes without the Inbox's (or vice versa, in
// theory) — someone who never re-consents to the newer four scopes
// should keep scheduling working while just being told to reconnect
// for the Inbox specifically, rather than being locked out of both.
export function hasInboxScope(storedScope) {
  const granted = (storedScope || '').split(',').map((s) => s.trim());
  return (
    granted.includes('pages_messaging') &&
    granted.includes('instagram_manage_messages') &&
    granted.includes('instagram_manage_comments') &&
    granted.includes('pages_manage_engagement')
  );
}

// ── 1. Authorize URL (redirect the user here) ──────────────────────

/**
 * Builds the URL to send the user's browser to, to start the provider's
 * consent screen. `state` is always required (CSRF protection, see
 * connectors.js createOAuthState). `codeChallenge` is only used for
 * Canva; harmless to pass undefined for the other three.
 */
export function buildAuthorizeUrl(provider, env, { state, codeChallenge }) {
  const { id } = _creds(provider, env);
  const redirectUri = _redirectUri(provider, env);
  const scope = SCOPES[provider];

  if (provider === 'github') {
    return 'https://github.com/login/oauth/authorize?' + _form({
      client_id: id, redirect_uri: redirectUri, scope, state,
    });
  }

  if (provider === 'google') {
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + _form({
      client_id: id, redirect_uri: redirectUri, response_type: 'code', scope, state,
      // access_type=offline + prompt=consent are both required to reliably
      // get a refresh_token back — without prompt=consent, Google only
      // issues one on a user's very first-ever authorization, silently
      // omitting it on every reconnect after that.
      access_type: 'offline', prompt: 'consent',
    });
  }

  if (provider === 'facebook') {
    return 'https://www.facebook.com/' + META_GRAPH_VERSION + '/dialog/oauth?' + _form({
      client_id: id, redirect_uri: redirectUri, state, scope, response_type: 'code',
    });
  }

  if (provider === 'canva') {
    return 'https://www.canva.com/api/oauth/authorize?' + _form({
      client_id: id, redirect_uri: redirectUri, response_type: 'code', scope, state,
      code_challenge_method: 's256', code_challenge: codeChallenge,
    });
  }

  throw new Error('Unknown connector provider: ' + provider);
}

// ── 2. Exchange an authorization code for tokens ───────────────────

/**
 * Normalizes every provider's token response into the same shape:
 * { accessToken, refreshToken, expiresAt (epoch ms or null), scope,
 *   providerAccountId }. Throws on any non-2xx or malformed response —
 * callers must treat that as "connection failed, don't save anything."
 */
export async function exchangeCodeForToken(provider, env, { code, codeVerifier }) {
  const { id, secret } = _creds(provider, env);
  const redirectUri = _redirectUri(provider, env);
  const now = Date.now();

  if (provider === 'github') {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: id, client_secret: secret, code, redirect_uri: redirectUri }),
    });
    const data = await _mustJson(res, 'github');
    if (data.error) throw new Error('github_oauth_error:' + data.error + ': ' + data.error_description);
    return {
      accessToken: data.access_token,
      refreshToken: null, // classic GitHub OAuth Apps issue non-expiring tokens
      expiresAt: null,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  if (provider === 'google') {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: _form({
        grant_type: 'authorization_code', code, client_id: id, client_secret: secret, redirect_uri: redirectUri,
      }),
    });
    const data = await _mustJson(res, 'google');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: now + (data.expires_in || 3600) * 1000,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  if (provider === 'facebook') {
    // Step 1: exchange the code for a short-lived (~1-2h) user token.
    // This is a GET on Meta's endpoint, not a POST — unlike every other
    // provider here.
    const shortRes = await fetch('https://graph.facebook.com/' + META_GRAPH_VERSION + '/oauth/access_token?' + _form({
      client_id: id, client_secret: secret, redirect_uri: redirectUri, code,
    }));
    const shortData = await _mustJson(shortRes, 'facebook');
    if (shortData.error) throw new Error('facebook_oauth_error:' + shortData.error.message);

    // Step 2: immediately exchange that for a long-lived (~60 day) user
    // token — this is what actually gets stored. Page tokens derived
    // from a long-lived user token (see meta-tools.js listPages) are
    // themselves effectively non-expiring, so this single exchange is
    // what makes scheduled posts able to publish unattended weeks later.
    const longData = await _exchangeLongLivedToken(id, secret, shortData.access_token);

    // providerAccountId: the Facebook user id, purely for diagnostic
    // logging (see connectors.js handleCallback) — never used for auth.
    let providerAccountId = null;
    try {
      const meRes = await fetch('https://graph.facebook.com/' + META_GRAPH_VERSION + '/me?' + _form({
        access_token: longData.access_token, fields: 'id',
      }));
      const meData = await meRes.json().catch(() => null);
      providerAccountId = meData && meData.id ? meData.id : null;
    } catch (e) {
      // Non-fatal — the connection still works without this.
    }

    return {
      accessToken: longData.access_token,
      // Meta has no separate refresh-token concept for this flow; the
      // long-lived user token itself is what gets re-exchanged to renew
      // it (see refreshAccessToken below), so it doubles as its own
      // "refresh token" here purely so the generic storage/refresh shape
      // in connectors.js keeps working unmodified for this provider too.
      refreshToken: longData.access_token,
      expiresAt: now + (longData.expires_in || 5184000) * 1000, // ~60 days
      scope: SCOPES.facebook,
      providerAccountId,
    };
  }

  if (provider === 'canva') {
    const res = await fetch('https://api.canva.com/rest/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: _basicAuthHeader(id, secret),
      },
      body: _form({
        grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri,
      }),
    });
    const data = await _mustJson(res, 'canva');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: now + (data.expires_in || 14400) * 1000,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  throw new Error('Unknown connector provider: ' + provider);
}

// ── 3. Refresh an access token ──────────────────────────────────────

/**
 * Returns the same normalized shape as exchangeCodeForToken. Throws if
 * the provider has no refresh token to use, or if the provider rejects
 * the refresh (revoked/expired) — callers (connectors.js getValidToken)
 * must treat any throw here as "this connection needs to be redone,"
 * never retry silently.
 */
export async function refreshAccessToken(provider, env, refreshTokenValue) {
  if (!refreshTokenValue) {
    throw new Error('No refresh token available for ' + provider + ' — reconnect required.');
  }

  const { id, secret } = _creds(provider, env);
  const now = Date.now();

  if (provider === 'google') {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: _form({ grant_type: 'refresh_token', refresh_token: refreshTokenValue, client_id: id, client_secret: secret }),
    });
    const data = await _mustJson(res, 'google');
    return {
      accessToken: data.access_token,
      // Google does not re-issue a refresh_token on refresh — keep the one we had.
      refreshToken: refreshTokenValue,
      expiresAt: now + (data.expires_in || 3600) * 1000,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  if (provider === 'facebook') {
    // "Refreshing" here means re-running the long-lived-token exchange
    // using the current (not-yet-expired) long-lived token as input —
    // this resets its ~60-day clock. Meta rejects this once the token
    // has actually expired, which correctly surfaces as NEEDS_RECONNECT
    // via the catch in connectors.js getValidToken.
    const longData = await _exchangeLongLivedToken(id, secret, refreshTokenValue);
    return {
      accessToken: longData.access_token,
      refreshToken: longData.access_token,
      expiresAt: now + (longData.expires_in || 5184000) * 1000,
      scope: SCOPES.facebook,
      providerAccountId: null,
    };
  }

  if (provider === 'canva') {
    const res = await fetch('https://api.canva.com/rest/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: _basicAuthHeader(id, secret),
      },
      body: _form({ grant_type: 'refresh_token', refresh_token: refreshTokenValue }),
    });
    const data = await _mustJson(res, 'canva');
    return {
      accessToken: data.access_token,
      // Canva DOES rotate the refresh token on every refresh — the old
      // one becomes invalid, so the new value must always be saved.
      refreshToken: data.refresh_token,
      expiresAt: now + (data.expires_in || 14400) * 1000,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  if (provider === 'github') {
    throw new Error('GitHub classic OAuth App tokens do not expire — refresh should never be called for this provider.');
  }

  throw new Error('Unknown connector provider: ' + provider);
}

// ── 4. Revoke a token (best-effort, called on disconnect) ──────────
// Not every provider has a clean single-call revoke; where one exists,
// disconnectProvider() in connectors.js calls this before deleting the
// local record, so an old token can't be replayed by whoever last had
// the browser session. Failures here are swallowed by the caller — a
// revoke failing should never block the user from disconnecting locally.

export async function revokeToken(provider, env, token) {
  if (provider === 'google') {
    await fetch('https://oauth2.googleapis.com/revoke?' + _form({ token }), { method: 'POST' });
    return;
  }
  if (provider === 'canva') {
    const { id, secret } = _creds(provider, env);
    await fetch('https://api.canva.com/rest/v1/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: _basicAuthHeader(id, secret) },
      body: _form({ token }),
    });
    return;
  }
  if (provider === 'github') {
    const { id, secret } = _creds(provider, env);
    await fetch('https://api.github.com/applications/' + id + '/grant', {
      method: 'DELETE',
      headers: {
        Authorization: _basicAuthHeader(id, secret),
        'Content-Type': 'application/json',
        'User-Agent': 'cognita-app',
      },
      body: JSON.stringify({ access_token: token }),
    });
    return;
  }
  if (provider === 'facebook') {
    // Revokes every permission this app was granted, not just one scope
    // — matches the "disconnect fully" intent of the disconnect button.
    await fetch('https://graph.facebook.com/' + META_GRAPH_VERSION + '/me/permissions?' + _form({ access_token: token }), {
      method: 'DELETE',
    });
    return;
  }
}

async function _exchangeLongLivedToken(clientId, clientSecret, shortLivedToken) {
  const res = await fetch('https://graph.facebook.com/' + META_GRAPH_VERSION + '/oauth/access_token?' + _form({
    grant_type: 'fb_exchange_token', client_id: clientId, client_secret: clientSecret, fb_exchange_token: shortLivedToken,
  }));
  const data = await _mustJson(res, 'facebook');
  if (data.error) throw new Error('facebook_oauth_error:' + data.error.message);
  return data;
}

async function _mustJson(res, provider) {
  const text = await res.text().catch(() => '');
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(provider + '_non_json_response: ' + text.slice(0, 200));
  }
  if (!res.ok) {
    throw new Error(provider + '_' + res.status + ': ' + text.slice(0, 200));
  }
  return data;
}
