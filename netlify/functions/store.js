'use strict';

const { getStore } = require('@netlify/blobs');
const { hasValidSession } = require('./_lib/session');

const STORE_NAME = 'attendance-tracker';

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

function isValidKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 200 && !/[\s/\\'"]/.test(key);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// Maximum attempts for optimistic-concurrency retries on merge/arrayAdd writes.
const MAX_MERGE_ATTEMPTS = 8;

/** Small randomized backoff between retries so two requests that collide
 * repeatedly don't just hammer each other in lockstep (a "retry storm").
 * Skipped on the very first attempt so the common (uncontended) case stays
 * fast. */
function retryDelayMs(attempt) {
  if (attempt === 0) return 0;
  return 15 + Math.floor(Math.random() * 45) * attempt;
}
function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * Atomically read-modify-write a JSON object stored at `key`, applying
 * `applyPatch(base) -> newValue` to whatever is currently stored (or `{}` if
 * nothing is stored yet), using Netlify Blobs' conditional writes
 * (onlyIfMatch / onlyIfNew) to detect a concurrent writer and retry instead
 * of silently clobbering their change.
 *
 * IMPORTANT: `store` must be opened with `consistency: 'strong'` (see
 * getStore() below). Netlify Blobs' conditional writes are always
 * evaluated against the true, current origin state regardless of
 * consistency mode — so onlyIfMatch/onlyIfNew can never actually
 * overwrite someone else's newer write, even under eventual consistency.
 * What eventual consistency *would* affect is the plain reads this
 * function (and the rest of the app) does to decide what to merge onto —
 * those could momentarily see stale data and need an extra retry, and
 * separately, anyone reading the key right after a save (a page refresh,
 * the background sync poll, an admin re-opening the edit form) could see
 * up to ~60s-old data. Strong consistency removes that gap entirely.
 */
async function atomicUpdateJson(store, key, applyPatch) {
  for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
    await sleep(retryDelayMs(attempt));

    let existing = null;
    let etag = null;
    try {
      const entry = await store.getWithMetadata(key, { type: 'json' });
      if (entry) {
        existing = isPlainObject(entry.data) ? entry.data : {};
        etag = entry.etag;
      }
    } catch (err) {
      // No entry yet, or it wasn't valid JSON — start fresh.
      existing = null;
      etag = null;
    }

    const base = existing || {};
    const next = applyPatch({ ...base });

    const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
    let result;
    try {
      result = await store.set(key, JSON.stringify(next), writeOpts);
    } catch (err) {
      console.error('atomicUpdateJson set failed', key, err);
      result = { modified: false };
    }

    if (result && result.modified !== false) {
      return next;
    }
    // Someone else wrote to this key between our read and write — the
    // condition correctly rejected us (this is validated against true
    // origin state, so a newer write is never silently lost here) — loop
    // and retry against whatever is now current.
  }
  throw new Error(`Could not update "${key}" after ${MAX_MERGE_ATTEMPTS} attempts due to concurrent writes.`);
}

/**
 * Same idea as the `merge` action below, but one level deeper: `patch` is
 * `{ recordId: { field: value, field2: null } | null }`. Each named
 * record's fields are merged individually (a `null` field value deletes
 * just that field) rather than the whole `recordId` sub-object being
 * replaced wholesale — a `null` at the recordId level still deletes the
 * entire record. This is what lets two different users edit two
 * *different fields of the same record* (e.g. one browser changing an
 * employee's attendance status while another is still saving that same
 * employee's performance numbers) without either overwriting the other.
 */
function applyFieldMerge(base, patch) {
  const next = { ...base };
  for (const recordId of Object.keys(patch)) {
    const fieldPatch = patch[recordId];
    if (fieldPatch === null) {
      delete next[recordId];
      continue;
    }
    if (!isPlainObject(fieldPatch)) continue; // defensive: ignore malformed entries
    const currentRecord = isPlainObject(next[recordId]) ? next[recordId] : {};
    const newRecord = { ...currentRecord };
    for (const field of Object.keys(fieldPatch)) {
      if (fieldPatch[field] === null) delete newRecord[field];
      else newRecord[field] = fieldPatch[field];
    }
    next[recordId] = newRecord;
  }
  return next;
}

exports.handler = async (event) => {
  // Give an explicit response instead of letting an oversized JSON payload
  // surface as an unrelated client-side save error.
  if (event && event.body && Buffer.byteLength(event.body, 'utf8') > 5 * 1024 * 1024) {
    return json(413, { error: 'Request is too large. Please use a smaller screenshot or reduce the amount of data being saved.' });
  }

  let store;
  try {
    // Strong consistency: every read/write on this store always reflects
    // the true current state immediately (at the cost of slightly slower
    // reads, which is a good trade for this app's traffic level). This is
    // what closes the "stale browser data" / "page refresh right after
    // saving" gap — see the comment on atomicUpdateJson above.
    const blobSiteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID || process.env.NETLIFY_SITE_ID_VALUE;
    const blobToken = process.env.NETLIFY_AUTH_TOKEN || process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_TOKEN;

    // Netlify normally injects Blobs environment variables automatically.
    // If this deployment does not, explicitly provide the site ID + token
    // through secure Netlify environment variables.
    if (blobSiteID && blobToken) {
      store = getStore({
        name: STORE_NAME,
        consistency: 'strong',
        siteID: blobSiteID,
        token: blobToken
      });
    } else {
      // Preserve Netlify's automatic Blobs configuration when available.
      store = getStore({ name: STORE_NAME, consistency: 'strong' });
    }
  } catch (err) {
    console.error('Could not open Netlify Blobs store', err);
    const detail = err && err.name === 'MissingBlobsEnvironmentError'
      ? 'Netlify Blobs is not configured. Add NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID (or SITE_ID) in Netlify environment variables, then redeploy.'
      : 'Storage is not available on this deployment.';
    return json(500, { error: detail });
  }

  const method = event.httpMethod;

  try {
    // ---- READ ----------------------------------------------------------
    if (method === 'GET') {
      const key = event.queryStringParameters && event.queryStringParameters.key;
      if (!isValidKey(key)) return json(400, { error: 'A valid "key" query parameter is required.' });

      const value = await store.get(key, { type: 'text' });
      return json(200, { key, value: value === undefined ? null : value });
    }

    // ---- WRITE / DELETE --------------------------------------------------
    if (method === 'POST' || method === 'DELETE') {
      let payload = {};
      try {
        payload = event.body ? JSON.parse(event.body) : {};
      } catch (err) {
        return json(400, { error: 'Invalid JSON body.' });
      }

      const { key, value, merge, fieldMerge, arrayAdd } = payload;
      const isProtected = !!payload.protected;

      if (!isValidKey(key)) return json(400, { error: 'A valid "key" field is required.' });

      // Sensitive operations (roster uploads/clears, reconciliation report
      // uploads, and editing/deleting leave or attendance history) are
      // flagged by the client as `protected`. Those are re-verified here
      // against the signed admin session cookie — the browser cannot forge
      // this without first passing the real password check in /admin.
      if (isProtected && !hasValidSession(event)) {
        return json(401, { error: 'Admin authentication required.' });
      }

      const wantsDelete = method === 'DELETE';

      if (wantsDelete) {
        await store.delete(key);
        return json(200, { key, deleted: true });
      }

      // ---- MERGE: atomic partial update of a JSON object -----------------
      // Body: { key, merge: { fieldA: valueA, fieldB: null } }
      // Shallow-merges `merge` into whatever object is currently stored at
      // `key` (treating it as `{}` if absent). A `null` value for a field
      // deletes that field. Uses conditional writes + retry so concurrent
      // merges to *different* top-level keys of the same object never
      // clobber each other, regardless of write order. Used for whole-record
      // writes (e.g. an admin replacing one employee's entire attendance
      // record, or deleting it) where the caller intentionally supplies the
      // complete replacement value.
      if (merge !== undefined) {
        if (!isPlainObject(merge)) {
          return json(400, { error: 'The "merge" field must be a JSON object.' });
        }
        try {
          const result = await atomicUpdateJson(store, key, (base) => {
            const next = { ...base };
            for (const field of Object.keys(merge)) {
              if (merge[field] === null) {
                delete next[field];
              } else {
                next[field] = merge[field];
              }
            }
            return next;
          });
          return json(200, { key, ok: true, value: result });
        } catch (err) {
          console.error('store merge conflict', key, err);
          return json(409, { error: 'Could not save due to a conflicting concurrent update. Please retry.' });
        }
      }

      // ---- FIELD MERGE: atomic partial update, one level deeper ----------
      // Body: { key, fieldMerge: { empId: { status: 'Present', lateTime: null } } }
      // See applyFieldMerge() above. This is the hot path for live
      // attendance editing (status changes and performance-field saves),
      // so that a status change and a concurrent performance-field save for
      // the *same* employee merge cleanly instead of one clobbering the
      // other's fields.
      if (fieldMerge !== undefined) {
        if (!isPlainObject(fieldMerge)) {
          return json(400, { error: 'The "fieldMerge" field must be a JSON object.' });
        }
        try {
          const result = await atomicUpdateJson(store, key, (base) => applyFieldMerge(base, fieldMerge));
          return json(200, { key, ok: true, value: result });
        } catch (err) {
          console.error('store fieldMerge conflict', key, err);
          return json(409, { error: 'Could not save due to a conflicting concurrent update. Please retry.' });
        }
      }

      // ---- ARRAY ADD: atomic "ensure value is present in a JSON array" --
      // Body: { key, arrayAdd: "2026-08-11" }
      // Used for small index lists (like the set of known attendance
      // dates) that can also be appended to by two users at once.
      if (arrayAdd !== undefined) {
        try {
          let finalArray = [];
          for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
            await sleep(retryDelayMs(attempt));
            let existingArr = [];
            let etag = null;
            try {
              const entry = await store.getWithMetadata(key, { type: 'json' });
              if (entry) {
                existingArr = Array.isArray(entry.data) ? entry.data : [];
                etag = entry.etag;
              }
            } catch (err) {
              existingArr = [];
              etag = null;
            }
            if (existingArr.includes(arrayAdd)) {
              finalArray = existingArr;
              break;
            }
            const nextArr = [...existingArr, arrayAdd].sort();
            const writeOpts = etag ? { onlyIfMatch: etag } : { onlyIfNew: true };
            const result = await store.set(key, JSON.stringify(nextArr), writeOpts);
            if (result && result.modified !== false) {
              finalArray = nextArr;
              break;
            }
            if (attempt === MAX_MERGE_ATTEMPTS - 1) {
              return json(409, { error: 'Could not update index due to a conflicting concurrent update. Please retry.' });
            }
          }
          return json(200, { key, ok: true, value: finalArray });
        } catch (err) {
          console.error('store arrayAdd error', key, err);
          return json(500, { error: 'Internal storage error.' });
        }
      }

      if (value === undefined || value === null) {
        return json(400, { error: 'A "value", "merge", "fieldMerge", or "arrayAdd" field is required to set a key.' });
      }

      await store.set(key, String(value));
      return json(200, { key, ok: true });
    }

    return json(405, { error: 'Method not allowed.' });
  } catch (err) {
    console.error('store function error', err);
    return json(500, { error: 'Internal storage error.' });
  }
};
