'use strict';

const crypto = require('crypto');
const { hasValidSession, buildSessionCookie, buildLogoutCookie } = require('./_lib/session');

function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...(extraHeaders || {}),
    },
    body: JSON.stringify(body),
  };
}

function timingSafeEqualStrings(a, b) {
  const aBuf = Buffer.from(String(a));
  const bBuf = Buffer.from(String(b));
  if (aBuf.length !== bBuf.length) {
    // Still run a comparison of equal length to avoid leaking length via timing.
    crypto.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.timingSafeEqual(aBuf, bBuf);
}

exports.handler = async (event) => {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return json(500, {
      error:
        'This deployment is missing the ADMIN_PASSWORD environment variable. Set it in Site settings -> Environment variables and redeploy.',
    });
  }

  const method = event.httpMethod;
  const queryAction = (event.queryStringParameters && event.queryStringParameters.action) || null;

  // GET /admin?action=check — does the caller already have a valid session?
  if (method === 'GET') {
    if (queryAction && queryAction !== 'check') {
      return json(400, { error: 'Unknown action.' });
    }
    return json(200, { authenticated: hasValidSession(event) });
  }

  if (method !== 'POST') {
    return json(405, { error: 'Method not allowed.' });
  }

  let payload = {};
  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return json(400, { error: 'Invalid JSON body.' });
  }

  const action = payload.action || queryAction || 'login';

  if (action === 'check') {
    return json(200, { authenticated: hasValidSession(event) });
  }

  if (action === 'logout') {
    return json(200, { ok: true }, { 'Set-Cookie': buildLogoutCookie(event) });
  }

  if (action === 'login') {
    const { password } = payload;
    if (typeof password !== 'string' || password.length === 0) {
      return json(400, { error: 'Password is required.' });
    }

    if (!timingSafeEqualStrings(password, adminPassword)) {
      return json(401, { error: 'Incorrect password.' });
    }

    return json(200, { ok: true }, { 'Set-Cookie': buildSessionCookie(event) });
  }

  return json(400, { error: 'Unknown action.' });
};
