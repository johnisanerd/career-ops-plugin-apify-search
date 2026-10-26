// @ts-check
// Apify REST calls for apify-search. Every request goes through ctx.fetch, so
// the engine's allowedHosts pin (api.apify.com) and SSRF guard apply, and the
// token travels only in the Authorization header, never in a URL.

const API = 'https://api.apify.com/v2';
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

// "owner/name" or "owner~name", the same shape the bundled apify plugin
// accepts, or a 17-character Actor id. Strict so a typo in config can't steer
// the bearer token to some other path on api.apify.com.
const ACTOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*[~/][A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACTOR_ID_RE = /^[A-Za-z0-9]{17}$/;

/** @param {unknown} actor */
export function normalizeActorId(actor) {
  if (typeof actor === 'string' && ACTOR_ID_RE.test(actor)) return actor;
  if (typeof actor !== 'string' || !ACTOR_NAME_RE.test(actor)) {
    throw new Error(`invalid actor ${JSON.stringify(actor)}, expected "owner/actor-name"`);
  }
  const [owner, name] = actor.split(/[~/]/, 2);
  return `${encodeURIComponent(owner)}~${encodeURIComponent(name)}`;
}

function auth(token, extra = {}) {
  return { authorization: `Bearer ${token}`, accept: 'application/json', ...extra };
}

async function getData(ctx, url, token, timeoutMs) {
  const res = await ctx.fetch(url, { headers: auth(token), timeoutMs });
  const body = await res.json();
  return body && typeof body === 'object' ? body.data : undefined;
}

/** The Actor object, which carries pricingInfos and defaultRunOptions. */
export async function getActor(ctx, actor, token) {
  const data = await getData(ctx, `${API}/acts/${normalizeActorId(actor)}`, token, 15_000);
  if (!data || typeof data !== 'object') throw new Error('the Apify API returned no Actor object');
  return data;
}

/**
 * Start a run. maxItems and maxTotalChargeUsd are Apify's own run limits, so
 * the platform stops charging at the estimate even if the Actor overshoots.
 */
export async function startRun(ctx, actor, input, token, { maxItems, maxTotalChargeUsd, timeoutSecs }) {
  const qs = new URLSearchParams({ timeout: String(timeoutSecs), maxItems: String(maxItems) });
  if (maxTotalChargeUsd != null) qs.set('maxTotalChargeUsd', String(maxTotalChargeUsd));
  const res = await ctx.fetch(`${API}/acts/${normalizeActorId(actor)}/runs?${qs}`, {
    method: 'POST',
    headers: auth(token, { 'content-type': 'application/json' }),
    body: JSON.stringify(input),
    timeoutMs: 30_000,
  });
  const body = await res.json();
  const run = body && typeof body === 'object' ? body.data : undefined;
  if (!run || typeof run.id !== 'string') throw new Error('the Apify API did not return a run id');
  return run;
}

/** Best effort: stop a run we gave up waiting on, so it stops charging. */
export async function abortRun(ctx, runId, token) {
  try {
    await ctx.fetch(`${API}/actor-runs/${encodeURIComponent(runId)}/abort`, {
      method: 'POST', headers: auth(token), timeoutMs: 10_000,
    });
  } catch { /* the run's own timeout still ends it */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a run to end. waitForFinish makes Apify hold each poll open for up
 * to 30 s, so a three-minute run costs a handful of requests. If the server
 * answers early anyway, the loop waits pollFloorMs before asking again.
 */
export async function waitForRun(ctx, runId, token, { deadline, pollFloorMs = 2_000 }) {
  while (Date.now() < deadline) {
    const waitSecs = Math.max(1, Math.min(30, Math.floor((deadline - Date.now()) / 1000)));
    const started = Date.now();
    const run = await getData(
      ctx,
      `${API}/actor-runs/${encodeURIComponent(runId)}?waitForFinish=${waitSecs}`,
      token,
      (waitSecs + 15) * 1000,
    );
    if (run && TERMINAL.has(run.status)) return run;
    const elapsed = Date.now() - started;
    if (elapsed < pollFloorMs) await sleep(pollFloorMs - elapsed);
  }
  await abortRun(ctx, runId, token);
  throw new Error(`run ${runId} did not finish in time and was aborted`);
}

/** Dataset rows, capped at `limit`. */
export async function fetchItems(ctx, datasetId, token, limit) {
  const qs = new URLSearchParams({ clean: 'true', format: 'json', limit: String(limit) });
  const res = await ctx.fetch(`${API}/datasets/${encodeURIComponent(datasetId)}/items?${qs}`, {
    headers: auth(token), timeoutMs: 30_000,
  });
  const items = await res.json();
  if (!Array.isArray(items)) throw new Error('the dataset read did not return a list');
  return items;
}
