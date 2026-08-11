'use strict';

const crypto = require('crypto');

const COOKIE_NAME = 'admin_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 hours

/**
 * All signing uses HMAC-SHA256 keyed by the ADMIN_PASSWORD environment
 * variable. That variable is the ONLY secret this project requires, and it
 * never leaves the server: the browser only ever sees the resulting signed,
 * httpOnly session cookie, not the password itself.
 */
function getSecret() {
  const secret = process.env.ADMIN_PASSWORD;
  if (!secret) {
    throw new Error('ADMIN_PASSWORD environment variable is not set.');
  }
  return secret;
}

function sign(payload) {
  return crypto.createHmac('sha256', getSecret()).update(payload).digest('hex');
}

function makeSessionToken() {
  const expiresAt = Date.now() + SESSION_TTL_SECONDS * 1000;
  const payload = String(expiresAt);
  const signature = sign(payload);
  return Buffer.from(`${payload}.${signature}`, 'utf8').toString('base64');
}

function verifySessionToken(token) {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const dotIndex = decoded.indexOf('.');
    if (dotIndex === -1) return false;
    const payload = decoded.slice(0, dotIndex);
    const signature = decoded.slice(dotIndex + 1);
    const expected = sign(payload);

    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (sigBuf.length !== expBuf.length) return false;
    if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

    const expiresAt = parseInt(payload, 10);
    if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

    return true;
  } catch (err) {
    return false;
  }
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  cookieHeader.split(';').forEach((part) => {
    const eq = part.indexOf('=');
    if (eq === -1) return;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) return;
    try {
      out[key] = decodeURIComponent(value);
    } catch (err) {
      out[key] = value;
    }
  });
  return out;
}

function getCookieHeader(event) {
  return (event.headers && (event.headers.cookie || event.headers.Cookie)) || '';
}

function isRequestSecure(event) {
  const proto =
    (event.headers && (event.headers['x-forwarded-proto'] || event.headers['X-Forwarded-Proto'])) || '';
  // Netlify's production edge always sets x-forwarded-proto: https. Locally
  // (netlify dev, plain http) we skip the Secure attribute so the cookie is
  // still usable for local testing.
  return proto.toLowerCase() === 'https';
}

function hasValidSession(event) {
  const cookies = parseCookies(getCookieHeader(event));
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function buildSessionCookie(event) {
  const token = makeSessionToken();
  const attrs = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    `Max-Age=${SESSION_TTL_SECONDS}`,
    'HttpOnly',
    'SameSite=Strict',
  ];
  if (isRequestSecure(event)) attrs.push('Secure');
  return attrs.join('; ');
}

function buildLogoutCookie(event) {
  const attrs = [`${COOKIE_NAME}=`, 'Path=/', 'Max-Age=0', 'HttpOnly', 'SameSite=Strict'];
  if (isRequestSecure(event)) attrs.push('Secure');
  return attrs.join('; ');
}

module.exports = {
  COOKIE_NAME,
  SESSION_TTL_SECONDS,
  hasValidSession,
  buildSessionCookie,
  buildLogoutCookie,
};
