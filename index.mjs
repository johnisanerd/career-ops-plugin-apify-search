// @ts-check
// apify-search: a career-ops provider plugin. One portals.yml job_boards entry
// with `provider: apify-search` is one role + location search across LinkedIn,
// Indeed, Wellfound and Google Jobs through Apify Actors.
//
// Order of events for each entry:
//   1. read every enabled board's live price (GET /v2/acts/<actor>) and print
//      what the capped search would cost;
//   2. stop there unless config/plugins.yml sets confirm_spend: true, the
//      estimate fits under max_usd, and this is not a --dry-run;
//   3. start one run per board, capped in its input and by Apify's own
//      maxItems / maxTotalChargeUsd run limits;
//   4. map the rows to Jobs, drop error and notice rows and duplicates, and
//      hand them to the scanner, which filters, dedups against history and
//      writes data/pipeline.md.
//
// Egress only through ctx.fetch (allowedHosts: api.apify.com).

import { getActor, startRun, waitForRun, fetchItems } from './lib/apify.mjs';
import { estimateRun, formatUsd } from './lib/cost.mjs';
import { rowProblem } from './lib/boards.mjs';
import { readSettings } from './lib/settings.mjs';

const ID = 'apify-search';

/** The requisition id an aggregator URL carries (LinkedIn job id, Indeed jk)
 * as "domain:id", or '' when the engine doesn't know one. */
function aggregatorKey(ctx, url) {
  const agg = url && typeof ctx.aggregatorPostingId === 'function' ? ctx.aggregatorPostingId(url) : null;
  return agg && agg.domain && agg.id ? `${agg.domain}:${agg.id}` : '';
}

/** Dedup keys for a Job, built the way the tracker and scanner build theirs:
 * the normalized URL plus any aggregator id, from the main URL and the board
 * page. '' means "no key" and is never compared. */
function postingKeys(ctx, job) {
  const norm = typeof ctx.normalizePostingUrl === 'function' ? ctx.normalizePostingUrl(job.url) : job.url;
  return [norm, aggregatorKey(ctx, job.url), aggregatorKey(ctx, job.boardUrl)].filter(Boolean);
}

const centsUp = (usd) => Math.ceil(usd * 100 - 1e-9) / 100;

async function estimateBoard(ctx, token, board, search, now) {
  const input = board.def.input(search, board.cap, board.extra);
  const plan = board.def.plan(input, board.cap);
  try {
    const actor = await getActor(ctx, board.actor, token);
    return { ...board, input, estimate: estimateRun(actor, plan, now) };
  } catch (err) {
    return { ...board, input, skip: err instanceof Error ? err.message : String(err) };
  }
}

async function runBoard(ctx, token, board, cfg, opts) {
  const { estimate } = board;
  const limit = Math.max(estimate.minCharge ?? 0, centsUp(estimate.usd));
  const run = await startRun(ctx, board.actor, board.input, token, {
    maxItems: board.def.plan(board.input, board.cap).results,
    maxTotalChargeUsd: limit,
    timeoutSecs: cfg.timeoutSecs,
  });
  const done = await waitForRun(ctx, run.id, token, {
    deadline: Date.now() + (cfg.timeoutSecs + 60) * 1000,
    pollFloorMs: opts.pollFloorMs,
  });
  if (!done.defaultDatasetId) throw new Error(`run ${run.id} ended ${done.status} with no dataset`);
  // Rows from a run that timed out or was aborted were still paid for, so
  // they are read too; the status is reported either way.
  const rows = await fetchItems(ctx, done.defaultDatasetId, token, Math.min(200, board.cap * 2 + 10));
  const now = opts.now ?? Date.now();
  const jobs = [];
  const problems = [];
  for (const row of rows) {
    const problem = rowProblem(row);
    if (problem) { problems.push(problem); continue; }
    const job = board.def.toJob(row, now);
    if (job && jobs.length < board.cap) jobs.push(job);
  }
  return { status: done.status, jobs, problems };
}

/**
 * The provider hook (provider.fetch). Exported for the tests, which pass
 * `opts` to shorten polling and pin the clock.
 * @param {any} entry portals.yml entry
 * @param {any} ctx plugin ctx from the engine
 * @param {{ pollFloorMs?: number, now?: number }} [opts]
 */
export async function searchBoards(entry, ctx, opts = {}) {
  const log = typeof ctx?.log === 'function' ? ctx.log : console.log;
  const token = ctx?.env?.APIFY_TOKEN;
  if (!token) throw new Error(`${ID}: APIFY_TOKEN is not set; add it to .env`);

  const cfg = readSettings(ctx.settings, entry);
  for (const w of cfg.warnings) log(`${ID}: ${w}`);
  const where = cfg.search.location ? ` in ${cfg.search.location}` : '';
  if (cfg.boards.length === 0) {
    log(`${ID}: "${cfg.search.query}"${where}: every board is turned off, nothing to do.`);
    return [];
  }

  const now = opts.now ?? Date.now();
  const planned = await Promise.all(cfg.boards.map((b) => estimateBoard(ctx, token, b, cfg.search, now)));
  const runnable = planned.filter((b) => b.estimate);
  const total = runnable.reduce((sum, b) => sum + b.estimate.usd, 0);

  log(`${ID}: "${cfg.search.query}"${where}, estimated cost before anything runs:`);
  for (const b of planned) {
    const head = `  ${b.def.label.padEnd(12)}${b.actor.padEnd(27)}`;
    if (b.skip) log(`${head} skipped, no estimate: ${b.skip}`);
    else log(`${head} up to ${b.cap} jobs  ${formatUsd(b.estimate.usd)}${b.estimate.upperBound ? ' (upper bound)' : ''}  [${b.estimate.basis}]`);
  }
  log(`  Total ${formatUsd(total)} at list price (paid Apify plans pay less). Ceiling: max_usd ${formatUsd(cfg.maxUsd)}.`);

  if (runnable.length === 0) throw new Error(`${ID}: no board could be estimated, so nothing was run`);
  const dryRun = ctx.dryRun === true || process.argv.includes('--dry-run');
  if (dryRun) {
    log(`${ID}: dry run, nothing was started.`);
    return [];
  }
  if (!cfg.confirmSpend) {
    log(`${ID}: nothing was started. To run this search, set confirm_spend: true under plugins.${ID} in config/plugins.yml.`);
    return [];
  }
  if (total > cfg.maxUsd) {
    log(`${ID}: the estimate ${formatUsd(total)} is above max_usd ${formatUsd(cfg.maxUsd)}, nothing was started. Lower max_results or raise max_usd.`);
    return [];
  }

  const settled = await Promise.allSettled(runnable.map((b) => runBoard(ctx, token, b, cfg, opts)));
  const out = [];
  const seen = new Set();
  const failures = [];
  const summary = [];
  settled.forEach((result, i) => {
    const b = runnable[i];
    if (result.status === 'rejected') {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason);
      failures.push(`${b.def.label}: ${msg}`);
      log(`${ID}: ${b.def.label} failed: ${msg}`);
      return;
    }
    const { status, jobs, problems } = result.value;
    let kept = 0;
    for (const job of jobs) {
      const keys = postingKeys(ctx, job);
      const dupe = keys.some((k) => seen.has(k));
      for (const k of keys) seen.add(k);
      delete job.boardUrl;
      if (dupe) continue;
      out.push(job);
      kept++;
    }
    const notes = [];
    if (status !== 'SUCCEEDED') notes.push(`run ended ${status}`);
    const errors = problems.filter((p) => p.kind === 'error');
    const notices = problems.filter((p) => p.kind === 'notice');
    if (errors.length) notes.push(`${errors.length} error row(s): ${errors[0].message.slice(0, 160)}`);
    if (notices.length) notes.push(`notice: ${notices[0].message.slice(0, 200)}`);
    summary.push(`${b.def.label} ${kept}${notes.length ? ` (${notes.join('; ')})` : ''}`);
  });
  if (summary.length) log(`${ID}: jobs handed to the scanner: ${summary.join(', ')}.`);
  if (failures.length === runnable.length) throw new Error(`${ID}: every board failed. ${failures.join(' | ')}`);
  return out;
}

export default {
  provider: {
    id: ID,
    // A keyed provider never auto-detects; it runs only on an explicit
    // `provider: apify-search` entry (the engine forces this too).
    detect: () => null,
    fetch: searchBoards,
  },
};
