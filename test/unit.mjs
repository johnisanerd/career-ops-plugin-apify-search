// Offline unit tests: ctx.fetch is a mock that answers like api.apify.com, so
// nothing here touches the network or spends anything. Run: node test/unit.mjs
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import plugin, { searchBoards } from '../index.mjs';
import { BOARDS, rowProblem, parseAgo, pickUrl } from '../lib/boards.mjs';
import { estimateRun, currentPriceEntry, eventPrice, formatUsd } from '../lib/cost.mjs';
import { readSettings, HARD_MAX_RESULTS } from '../lib/settings.mjs';
import { normalizeActorId, waitForRun } from '../lib/apify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(path.join(here, 'fixtures', name), 'utf8'));
const ACTORS = load('actors.json');
const ROWS = {
  linkedin: load('rows-linkedin.json'),
  indeed: load('rows-indeed.json'),
  wellfound: load('rows-wellfound.json'),
  google_jobs: load('rows-google.json'),
};
const ACTOR_BOARD = {
  'johnvc~linkedin-jobs-api': 'linkedin',
  'johnvc~indeed-jobs-api': 'indeed',
  'johnvc~wellfound-jobs-api': 'wellfound',
  'johnvc~Google-Jobs-Scraper': 'google_jobs',
};
const NOW = Date.parse('2026-10-25T12:00:00Z');
const TOKEN = 'apify_api_test_token_value';

// ── mock api.apify.com ─────────────────────────────────────────────────────
function httpError(status, msg) {
  const err = new Error(`HTTP ${status}: ${msg}`);
  err.status = status;
  return err;
}

/** A ctx like the engine's, with a recording mock in place of the guarded fetch. */
function makeCtx({ settings = {}, dryRun = false, actors = ACTORS, rows = ROWS, runStatus = 'SUCCEEDED', failRun = [] } = {}) {
  const calls = [];
  const lines = [];
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  async function mockApify(url, opts = {}) {
    const u = new URL(url);
    const method = opts.method || 'GET';
    calls.push({ method, url: u, opts, body: opts.body ? JSON.parse(opts.body) : undefined });
    assert.equal(u.hostname, 'api.apify.com');
    assert.equal(opts.headers?.authorization, `Bearer ${TOKEN}`);
    assert.ok(!url.includes(TOKEN), 'the token never goes in a URL');
    let m;
    if (method === 'GET' && (m = /^\/v2\/acts\/([^/]+)$/.exec(u.pathname))) {
      const actor = actors[decodeURIComponent(m[1])];
      if (!actor) throw httpError(404, 'Actor not found');
      return reply({ data: actor });
    }
    if (method === 'POST' && (m = /^\/v2\/acts\/([^/]+)\/runs$/.exec(u.pathname))) {
      const board = ACTOR_BOARD[decodeURIComponent(m[1])];
      if (failRun.includes(board)) throw httpError(402, 'Not enough usage left');
      return reply({ data: { id: `run-${board}`, status: 'READY', defaultDatasetId: `ds-${board}` } });
    }
    if (method === 'GET' && (m = /^\/v2\/actor-runs\/run-([a-z_]+)$/.exec(u.pathname))) {
      return reply({ data: { id: `run-${m[1]}`, status: runStatus, defaultDatasetId: `ds-${m[1]}` } });
    }
    if (method === 'POST' && /^\/v2\/actor-runs\/[^/]+\/abort$/.test(u.pathname)) return reply({ data: {} });
    if (method === 'GET' && (m = /^\/v2\/datasets\/ds-([a-z_]+)\/items$/.exec(u.pathname))) {
      return reply(rows[m[1]] || []);
    }
    throw httpError(404, `no mock for ${method} ${u.pathname}`);
  }
  // Same contract as the engine's ctx.aggregatorPostingId for the two boards
  // career-ops maps (LinkedIn job id, Indeed jk).
  function aggregatorPostingId(raw) {
    let u;
    try { u = new URL(raw); } catch { return null; }
    if (/(^|\.)linkedin\.com$/.test(u.hostname)) {
      const id = /\/jobs\/view\/(?:[^/]*-)?(\d+)/.exec(u.pathname)?.[1];
      return id ? { domain: 'linkedin.com', id } : null;
    }
    if (/(^|\.)indeed\.com$/.test(u.hostname)) {
      const jk = u.searchParams.get('jk');
      return jk ? { domain: 'indeed.com', id: jk } : null;
    }
    return null;
  }
  const ctx = {
    fetch: mockApify,
    env: { APIFY_TOKEN: TOKEN },
    settings,
    dryRun,
    log: (...args) => lines.push(args.join(' ')),
    normalizePostingUrl: (raw) => {
      try { const u = new URL(raw); u.hash = ''; return u.href.replace(/\/$/, ''); } catch { return ''; }
    },
    aggregatorPostingId,
  };
  return { ctx, calls, lines };
}

const ENTRY = { name: 'Apify search: data engineer, Berlin', provider: 'apify-search', query: 'data engineer', location: 'Berlin, Germany', country: 'DE' };
const OPTS = { pollFloorMs: 0, now: NOW };
const runCalls = (calls) => calls.filter((c) => c.method === 'POST' && c.url.pathname.endsWith('/runs'));
const runFor = (calls, actor) => runCalls(calls).find((c) => c.url.pathname.includes(actor));

// ── tiny runner ────────────────────────────────────────────────────────────
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── settings and caps ──────────────────────────────────────────────────────
test('max_results is clamped to the hard ceiling and a warning is kept', () => {
  const cfg = readSettings({ max_results: 500 }, ENTRY);
  assert.equal(HARD_MAX_RESULTS, 50);
  assert.ok(cfg.boards.every((b) => b.cap === 50));
  assert.match(cfg.warnings[0], /above the ceiling of 50/);
  assert.equal(readSettings({}, { ...ENTRY, max_results: 0 }).boards[0].cap, 1);
  assert.equal(readSettings({}, ENTRY).boards[0].cap, 25);
});

test('a per-board max_results is a ceiling for that board only', () => {
  const cfg = readSettings({ boards: { google_jobs: { max_results: 10 } } }, { ...ENTRY, max_results: 40 });
  const caps = Object.fromEntries(cfg.boards.map((b) => [b.id, b.cap]));
  assert.deepEqual(caps, { linkedin: 40, indeed: 40, wellfound: 40, google_jobs: 10 });
});

test('boards can be turned off in settings or narrowed per entry', () => {
  assert.deepEqual(readSettings({ boards: { wellfound: { enabled: false } } }, ENTRY).boards.map((b) => b.id), ['linkedin', 'indeed', 'google_jobs']);
  assert.deepEqual(readSettings({}, { ...ENTRY, boards: ['indeed'] }).boards.map((b) => b.id), ['indeed']);
  assert.throws(() => readSettings({}, { ...ENTRY, boards: ['monster'] }), /unknown board/);
});

test('a board that is off by default runs only when settings or the entry ask for it', () => {
  const saved = BOARDS.google_jobs.defaultEnabled;
  BOARDS.google_jobs.defaultEnabled = false;
  try {
    assert.deepEqual(readSettings({}, ENTRY).boards.map((b) => b.id), ['linkedin', 'indeed', 'wellfound']);
    assert.ok(readSettings({ boards: { google_jobs: { enabled: true } } }, ENTRY).boards.some((b) => b.id === 'google_jobs'));
    assert.deepEqual(readSettings({}, { ...ENTRY, boards: ['google_jobs'] }).boards.map((b) => b.id), ['google_jobs']);
  } finally {
    BOARDS.google_jobs.defaultEnabled = saved;
  }
});

test('an entry without a query is rejected', () => {
  assert.throws(() => readSettings({}, { name: 'x' }), /needs a query/);
});

test('custom actor IDs replace the defaults and are validated', () => {
  const cfg = readSettings({ boards: { indeed: { actor: 'someone/indeed-scraper' } } }, ENTRY);
  assert.equal(cfg.boards.find((b) => b.id === 'indeed').actor, 'someone/indeed-scraper');
  assert.equal(normalizeActorId('johnvc/linkedin-jobs-api'), 'johnvc~linkedin-jobs-api');
  assert.equal(normalizeActorId('8gL3E4qLSkxxDyeDl'), '8gL3E4qLSkxxDyeDl');
  assert.throws(() => normalizeActorId('johnvc/../../users/me'), /invalid actor/);
  assert.throws(() => normalizeActorId('johnvc/x?token=1'), /invalid actor/);
});

// ── actor inputs ───────────────────────────────────────────────────────────
const S = { query: 'data engineer', location: 'Berlin, Germany', country: 'de' };

test('LinkedIn input: keyword, location, country, maxJobs pinned to the cap', () => {
  const input = BOARDS.linkedin.input(S, 25, { maxJobs: 500, jobUrls: ['https://www.linkedin.com/jobs/view/1'], timeRange: 'past-week' });
  assert.deepEqual(input, { keyword: 'data engineer', location: 'Berlin, Germany', country: 'DE', timeRange: 'past-week', maxJobs: 25 });
});

test('Indeed input: one keyword in search mode, per-keyword cap pinned', () => {
  const input = BOARDS.indeed.input(S, 20, { keywords: ['a', 'b', 'c'], mode: 'company', maxResultsPerInput: 1000, datePosted: 'Last 7 days' });
  assert.equal(input.mode, 'search');
  assert.deepEqual(input.keywords, ['data engineer']);
  assert.equal(input.maxResultsPerInput, 20);
  assert.equal(input.country, 'DE');
  assert.equal(input.includeCompanyDetails, false);
  assert.equal(input.datePosted, 'Last 7 days');
  assert.equal(BOARDS.indeed.input({ query: 'x', location: '', country: '' }, 5, {}).country, 'US');
});

test('Wellfound input: role, city slug or remote flag, maxItems pinned', () => {
  const input = BOARDS.wellfound.input({ query: 'data engineer', location: 'São Paulo, Brazil', country: '' }, 30, { maxItems: 999 });
  assert.deepEqual(input.roles, ['data engineer']);
  assert.deepEqual(input.locations, ['sao-paulo']);
  assert.equal(input.maxItems, 30);
  assert.equal(input.includeDescription, false);
  const remote = BOARDS.wellfound.input({ query: 'designer', location: 'Remote', country: '' }, 5, {});
  assert.equal(remote.remoteOnly, true);
  assert.equal(remote.locations, undefined);
});

test('Google Jobs input: at least 10 results and the page count pinned', () => {
  assert.deepEqual(BOARDS.google_jobs.input(S, 25, { num_results: 1000, max_pagination: 0 }), {
    location: 'Berlin, Germany', country: 'de', query: 'data engineer', num_results: 25, max_pagination: 3,
  });
  const small = BOARDS.google_jobs.input(S, 4, {});
  assert.equal(small.num_results, 10);
  assert.equal(small.max_pagination, 1);
});

// ── cost estimate from pricingInfos ────────────────────────────────────────
test('the live pricingInfos entry wins over a scheduled one', () => {
  const entry = currentPriceEntry(ACTORS['johnvc~indeed-jobs-api'], NOW);
  assert.equal(entry.startedAt, '2026-08-18T00:00:00.000Z');
});

test('tiered event prices use the highest tier (list price)', () => {
  assert.equal(eventPrice({ eventPriceUsd: 0.0038, eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.004 } } }), 0.004);
  assert.equal(eventPrice({ eventPriceUsd: 0.01 }), 0.01);
  assert.equal(eventPrice(undefined), null);
});

test('per-result estimate: Indeed 25 jobs at $0.004', () => {
  const input = BOARDS.indeed.input(S, 25, {});
  const est = estimateRun(ACTORS['johnvc~indeed-jobs-api'], BOARDS.indeed.plan(input, 25), NOW);
  assert.ok(Math.abs(est.usd - 0.1) < 1e-9);
  assert.equal(est.upperBound, false);
  assert.match(est.basis, /job-scraped 25 x \$0\.004/);
});

test('optional add-on events are counted when the input turns them on', () => {
  const input = BOARDS.indeed.input(S, 10, { includeCompanyDetails: true });
  const est = estimateRun(ACTORS['johnvc~indeed-jobs-api'], BOARDS.indeed.plan(input, 10), NOW);
  assert.ok(Math.abs(est.usd - 10 * (0.004 + 0.006)) < 1e-9);
  const wf = BOARDS.wellfound.input(S, 10, { includeDescription: true });
  const wfEst = estimateRun(ACTORS['johnvc~wellfound-jobs-api'], BOARDS.wellfound.plan(wf, 10), NOW);
  assert.ok(Math.abs(wfEst.usd - 10 * (0.001 + 0.0006)) < 1e-9);
});

test('per-page estimate: Google Jobs pages plus start and dataset-item events', () => {
  const input = BOARDS.google_jobs.input(S, 25, {});
  const est = estimateRun(ACTORS['johnvc~Google-Jobs-Scraper'], BOARDS.google_jobs.plan(input, 25), NOW);
  assert.ok(Math.abs(est.usd - (0.00005 + 25 * 0.00001 + 3 * 0.09)) < 1e-9, String(est.usd));
  assert.equal(est.minCharge, 0.5);
});

test('unknown event names give an upper bound, not a guess', () => {
  const actor = { pricingInfos: [{ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: { 'result-a': { eventPriceUsd: 0.002 }, 'result-b': { eventPriceUsd: 0.001 } } } }] };
  const est = estimateRun(actor, { perResult: ['job-scraped'], results: 10 }, NOW);
  assert.equal(est.upperBound, true);
  assert.ok(Math.abs(est.usd - 0.03) < 1e-9);
});

test('pay-per-result Actors use pricePerUnitUsd; free and rental Actors are not estimated', () => {
  const perItem = { pricingInfos: [{ pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.003 }] };
  assert.ok(Math.abs(estimateRun(perItem, { perResult: [], results: 20 }, NOW).usd - 0.06) < 1e-9);
  assert.throws(() => estimateRun({ pricingInfos: [{ pricingModel: 'FREE' }] }, { perResult: [], results: 5 }, NOW), /FREE/);
  assert.throws(() => estimateRun({ pricingInfos: [{ pricingModel: 'FLAT_PRICE_PER_MONTH', pricePerUnitUsd: 20 }] }, { perResult: [], results: 5 }, NOW), /FLAT_PRICE_PER_MONTH/);
  assert.throws(() => estimateRun({}, { perResult: [], results: 5 }, NOW), /no pricingInfos/);
});

test('formatUsd keeps sub-cent amounts readable', () => {
  assert.equal(formatUsd(0.27), '$0.27');
  assert.equal(formatUsd(0.00025), '$0.0003');
  assert.equal(formatUsd(0), '$0.00');
});

// ── row mapping ────────────────────────────────────────────────────────────
const mapAll = (board) => ROWS[board].filter((r) => !rowProblem(r)).map((r) => BOARDS[board].toJob(r, NOW)).filter(Boolean);

test('error and notice rows are recognised on every board', () => {
  assert.equal(rowProblem(ROWS.linkedin[2]).kind, 'error');
  assert.equal(rowProblem(ROWS.wellfound[2]).kind, 'error');
  assert.equal(rowProblem(ROWS.google_jobs[3]).kind, 'error');
  assert.equal(rowProblem(ROWS.indeed[4]).kind, 'notice');
  assert.match(rowProblem(ROWS.indeed[4]).message, /Free monthly allowance/);
  assert.equal(rowProblem(ROWS.linkedin[0]), null);
  assert.equal(rowProblem(ROWS.google_jobs[0]), null);
});

test('LinkedIn: external apply link first, board URL as attribution, ISO and relative dates', () => {
  const jobs = mapAll('linkedin');
  assert.equal(jobs.length, 2, 'the http-only row is dropped');
  assert.deepEqual(
    { ...jobs[0], description: undefined },
    {
      title: 'Senior Data Engineer',
      url: 'https://boards.greenhouse.io/northwind/jobs/7001',
      company: 'Northwind Analytics',
      location: 'Berlin, Germany',
      postedAt: Date.parse('2026-10-20T00:00:00.000Z'),
      description: undefined,
      note: 'via LinkedIn https://www.linkedin.com/jobs/view/4286961888',
      boardUrl: 'https://www.linkedin.com/jobs/view/4286961888',
    },
  );
  assert.equal(jobs[1].url, 'https://www.linkedin.com/jobs/view/4286961999', 'a LinkedIn-hosted apply link loses to the job page');
  assert.equal(jobs[1].note, undefined);
  assert.equal(jobs[1].postedAt, NOW - 3 * 86400e3);
});

test('Indeed: employer apply link, yearly employer salary only, expired rows dropped', () => {
  const jobs = mapAll('indeed');
  assert.deepEqual(jobs.map((j) => j.title), ['Data Engineer (Python, Spark)', 'Junior Data Engineer', 'Data Platform Engineer']);
  assert.equal(jobs[0].url, 'https://jobs.lever.co/tailspin/0f7c2b1e');
  assert.equal(jobs[0].note, 'via Indeed https://de.indeed.com/viewjob?jk=a1b2c3d4e5f60718');
  assert.deepEqual(jobs[0].salary, { min: 70000, max: 85000, currency: 'EUR' });
  assert.equal(jobs[0].description, 'You will own our ingestion layer.');
  assert.equal(jobs[1].url, 'https://de.indeed.com/viewjob?jk=0a0b0c0d0e0f1011');
  assert.equal(jobs[1].salary, undefined, 'monthly pay is not annualized by guesswork');
  assert.equal(jobs[1].postedAt, NOW);
  assert.equal(jobs[2].salary, undefined, "Indeed's own estimate is not the employer's figure");
  assert.equal(jobs[2].location, 'Alexanderplatz 1, 10178 Berlin');
});

test('Wellfound: canonical job URL, company object, locations, salary', () => {
  const jobs = mapAll('wellfound');
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].url, 'https://wellfound.com/jobs/4353862-founding-data-engineer');
  assert.equal(jobs[0].company, 'Blue Yonder Labs');
  assert.equal(jobs[0].location, 'Berlin');
  assert.equal(jobs[0].postedAt, Date.parse('2026-10-21T12:00:00+00:00'));
  assert.deepEqual(jobs[0].salary, { min: 90000, max: 120000, currency: 'EUR' });
  assert.equal(jobs[0].note, undefined);
  assert.equal(jobs[1].location, 'Remote');
  assert.equal(jobs[1].postedAt, undefined);
});

test('Google Jobs: employer apply option, then any listing, then the Google link', () => {
  const jobs = mapAll('google_jobs');
  assert.equal(jobs.length, 3);
  assert.equal(jobs[0].url, 'https://boards.greenhouse.io/northwind/jobs/7001');
  assert.match(jobs[0].note, /^via Google Jobs https:\/\/www\.google\.com\/search/);
  assert.equal(jobs[0].postedAt, NOW - 5 * 86400e3);
  assert.match(jobs[1].url, /^https:\/\/de\.linkedin\.com\/jobs\/view\//);
  assert.equal(jobs[1].postedAt, NOW - 30 * 86400e3);
  assert.match(jobs[2].url, /^https:\/\/www\.google\.com\/search/);
  assert.equal(jobs[2].note, undefined);
});

test('parseAgo and pickUrl edge cases', () => {
  assert.equal(parseAgo('2 hours ago', NOW), NOW - 2 * 3600e3);
  assert.equal(parseAgo('Posted 1 week ago', NOW), NOW - 7 * 86400e3);
  assert.equal(parseAgo('sometime', NOW), undefined);
  assert.equal(pickUrl(['javascript:alert(1)', 'http://x.example/job'], 'https://www.linkedin.com/jobs/view/1'), 'https://www.linkedin.com/jobs/view/1');
  assert.equal(pickUrl([], ''), '');
});

// ── the provider hook end to end, with ctx.fetch mocked ────────────────────
test('the default export is a provider that never auto-detects', () => {
  assert.equal(plugin.provider.id, 'apify-search');
  assert.equal(plugin.provider.detect(), null);
  assert.equal(plugin.provider.fetch, searchBoards);
});

test('no APIFY_TOKEN: nothing is called', async () => {
  const { ctx, calls } = makeCtx();
  ctx.env = {};
  await assert.rejects(searchBoards(ENTRY, ctx, OPTS), /APIFY_TOKEN is not set/);
  assert.equal(calls.length, 0);
});

test('without confirm_spend the first call only prints the estimate', async () => {
  const { ctx, calls, lines } = makeCtx({ settings: {} });
  const jobs = await searchBoards(ENTRY, ctx, OPTS);
  assert.deepEqual(jobs, []);
  assert.ok(calls.every((c) => c.method === 'GET' && /^\/v2\/acts\/[^/]+$/.test(c.url.pathname)), 'only Actor reads, no runs');
  assert.equal(calls.length, 4);
  const out = lines.join('\n');
  assert.match(out, /estimated cost before anything runs/);
  assert.match(out, /Indeed\s+johnvc\/indeed-jobs-api\s+up to 25 jobs\s+\$0\.10/);
  assert.match(out, /Google Jobs johnvc\/Google-Jobs-Scraper\s+up to 25 jobs\s+\$0\.27/);
  assert.match(out, /Total \$0\.40 at list price/);
  assert.match(out, /set confirm_spend: true under plugins\.apify-search/);
});

test('ctx.dryRun never starts a run, even with confirm_spend', async () => {
  const { ctx, calls, lines } = makeCtx({ settings: { confirm_spend: true }, dryRun: true });
  assert.deepEqual(await searchBoards(ENTRY, ctx, OPTS), []);
  assert.equal(runCalls(calls).length, 0);
  assert.match(lines.join('\n'), /dry run, nothing was started/);
});

test('an estimate above max_usd starts nothing', async () => {
  const { ctx, calls, lines } = makeCtx({ settings: { confirm_spend: true, max_usd: 0.25 } });
  assert.deepEqual(await searchBoards(ENTRY, ctx, OPTS), []);
  assert.equal(runCalls(calls).length, 0);
  assert.match(lines.join('\n'), /above max_usd \$0\.25/);
});

test('confirmed: one capped run per board, Apify run limits set, rows merged and deduplicated', async () => {
  const { ctx, calls, lines } = makeCtx({ settings: { confirm_spend: true } });
  const jobs = await searchBoards(ENTRY, ctx, OPTS);

  assert.equal(runCalls(calls).length, 4);
  const indeedRun = runFor(calls, 'johnvc~indeed-jobs-api');
  assert.equal(indeedRun.url.searchParams.get('maxItems'), '25');
  assert.equal(indeedRun.url.searchParams.get('maxTotalChargeUsd'), '0.1');
  assert.equal(indeedRun.url.searchParams.get('timeout'), '300');
  assert.deepEqual(indeedRun.body.keywords, ['data engineer']);
  const googleRun = runFor(calls, 'johnvc~Google-Jobs-Scraper');
  assert.equal(googleRun.url.searchParams.get('maxTotalChargeUsd'), '0.5', 'raised to the Actor minimum');
  assert.equal(googleRun.body.max_pagination, 3);
  assert.equal(runFor(calls, 'johnvc~linkedin-jobs-api').url.searchParams.get('maxTotalChargeUsd'), '0.01');

  // Each dataset is read with a bounded limit.
  for (const c of calls.filter((x) => x.url.pathname.startsWith('/v2/datasets/'))) {
    assert.equal(c.url.searchParams.get('limit'), '60');
  }

  // LinkedIn 2 + Indeed 3 + Wellfound 2 + Google 3 = 10 mapped; Google's
  // Northwind (same employer URL as LinkedIn) and Contoso (same LinkedIn job
  // id as the LinkedIn row) are dropped as duplicates.
  assert.equal(jobs.length, 8);
  const urls = jobs.map((j) => j.url);
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(urls.filter((u) => u.includes('greenhouse.io/northwind')).length, 1);
  assert.ok(jobs.every((j) => !('boardUrl' in j)), 'internal fields are stripped');
  assert.ok(jobs.every((j) => j.title && j.url.startsWith('https://')));

  const out = lines.join('\n');
  assert.match(out, /Indeed 3 \(notice: Free monthly allowance reached/);
  assert.match(out, /LinkedIn 2 \(1 error row\(s\): One search page could not be read/);
  assert.match(out, /Google Jobs 1 \(1 error row/);
});

test('per-board result cap holds even if an Actor returns more rows', async () => {
  const many = Array.from({ length: 40 }, (_, i) => ({
    result_type: 'job', title: `Data Engineer ${i}`, companyName: 'Acme', location: 'Berlin',
    jobUrl: `https://www.linkedin.com/jobs/view/${1000 + i}`,
  }));
  const { ctx } = makeCtx({ settings: { confirm_spend: true, boards: { indeed: { enabled: false }, wellfound: { enabled: false }, google_jobs: { enabled: false } } }, rows: { linkedin: many } });
  const jobs = await searchBoards({ ...ENTRY, max_results: 5 }, ctx, OPTS);
  assert.equal(jobs.length, 5);
});

test('one board failing does not sink the others; all failing is an error', async () => {
  const some = makeCtx({ settings: { confirm_spend: true }, failRun: ['indeed'] });
  const jobs = await searchBoards(ENTRY, some.ctx, OPTS);
  assert.ok(jobs.length > 0);
  assert.match(some.lines.join('\n'), /Indeed failed: HTTP 402/);

  const all = makeCtx({ settings: { confirm_spend: true }, failRun: ['linkedin', 'indeed', 'wellfound', 'google_jobs'] });
  await assert.rejects(searchBoards(ENTRY, all.ctx, OPTS), /every board failed/);
});

test('a board with no readable price is skipped and never run', async () => {
  const actors = { ...ACTORS };
  delete actors['johnvc~wellfound-jobs-api'];
  const { ctx, calls, lines } = makeCtx({ settings: { confirm_spend: true }, actors });
  await searchBoards(ENTRY, ctx, OPTS);
  assert.equal(runFor(calls, 'wellfound'), undefined);
  assert.equal(runCalls(calls).length, 3);
  assert.match(lines.join('\n'), /Wellfound\s+johnvc\/wellfound-jobs-api\s+skipped, no estimate: HTTP 404/);

  const none = makeCtx({ settings: { confirm_spend: true }, actors: {} });
  await assert.rejects(searchBoards(ENTRY, none.ctx, OPTS), /no board could be estimated/);
  assert.equal(runCalls(none.calls).length, 0);
});

test('a run that times out on Apify still returns the rows it paid for, with the status logged', async () => {
  const { ctx, lines } = makeCtx({ settings: { confirm_spend: true, boards: { linkedin: { enabled: false }, wellfound: { enabled: false }, google_jobs: { enabled: false } } }, runStatus: 'TIMED-OUT' });
  const jobs = await searchBoards(ENTRY, ctx, OPTS);
  assert.equal(jobs.length, 3);
  assert.match(lines.join('\n'), /Indeed 3 \(run ended TIMED-OUT/);
});

test('waitForRun aborts the run when the client deadline passes', async () => {
  const { ctx, calls } = makeCtx();
  await assert.rejects(waitForRun(ctx, 'run-x', TOKEN, { deadline: Date.now() - 1, pollFloorMs: 0 }), /did not finish in time/);
  assert.ok(calls.some((c) => c.method === 'POST' && c.url.pathname === '/v2/actor-runs/run-x/abort'));
});

// ── run ────────────────────────────────────────────────────────────────────
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log(`✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`✗ ${name}\n  ${err && err.stack ? err.stack.split('\n').slice(0, 4).join('\n  ') : err}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
