// @ts-check
// Dollar estimate for one capped run, read from the Actor object's
// pricingInfos at run time. Nothing here is hardcoded per Actor except the
// event names each board expects (lib/boards.mjs); prices always come live.

// Synthetic events Apify charges on any pay-per-event Actor that declares them.
const START_EVENT = 'apify-actor-start';
const ITEM_EVENT = 'apify-default-dataset-item';

/**
 * The pricingInfos entry in force now: the latest one whose startedAt has
 * passed. An entry scheduled for later is a pending change, not the price.
 * @param {any} actor
 */
export function currentPriceEntry(actor, now = Date.now()) {
  const list = Array.isArray(actor?.pricingInfos) ? actor.pricingInfos : [];
  let best = null;
  let bestAt = -Infinity;
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const parsed = Date.parse(entry.startedAt ?? entry.createdAt ?? '');
    const at = Number.isFinite(parsed) ? parsed : 0;
    if (at > now) continue;
    if (at >= bestAt) { best = entry; bestAt = at; }
  }
  return best;
}

// The highest of the numbers found. A tiered price lists one value per Apify
// plan, and the plan behind the token isn't known here, so the estimate takes
// the list price (the highest tier) and errs high.
function highest(values) {
  const nums = values.filter((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0);
  return nums.length ? Math.max(...nums) : null;
}

function tierValues(tiers, key) {
  if (!tiers || typeof tiers !== 'object') return [];
  return Object.values(tiers).map((t) => (typeof t === 'number' ? t : t?.[key]));
}

/** @param {any} event one entry of pricingPerEvent.actorChargeEvents */
export function eventPrice(event) {
  if (typeof event === 'number') return highest([event]);
  if (!event || typeof event !== 'object') return null;
  return highest([event.eventPriceUsd, ...tierValues(event.eventTieredPricingUsd, 'tieredEventPriceUsd')]);
}

function unitPrice(entry) {
  return highest([entry.pricePerUnitUsd, ...tierValues(entry.tieredPricing, 'tieredPricePerUnitUsd')]);
}

/** "$0.27", or four decimals below a cent so tiny runs don't read as $0.00. */
export function formatUsd(usd) {
  return usd > 0 && usd < 0.01 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`;
}

const shortUsd = (n) => `$${Number(n.toPrecision(3))}`;

/**
 * Estimate one board's run.
 * @param {any} actor Actor object from GET /v2/acts/{id}
 * @param {{ perResult: string[], perPage?: string, pages?: number, results: number }} plan
 * @returns {{ usd: number, basis: string, upperBound: boolean, minCharge: number|null }}
 */
export function estimateRun(actor, plan, now = Date.now()) {
  const entry = currentPriceEntry(actor, now);
  if (!entry) throw new Error('the Actor lists no pricingInfos');
  const model = entry.pricingModel;

  if (model === 'PRICE_PER_DATASET_ITEM') {
    const unit = unitPrice(entry);
    if (unit == null) throw new Error('per-result price missing from pricingInfos');
    return { usd: unit * plan.results, basis: `${plan.results} results x ${shortUsd(unit)}`, upperBound: false, minCharge: null };
  }
  if (model !== 'PAY_PER_EVENT') {
    // FREE and rental Actors bill platform usage to the caller, which can't be
    // known before the run. No estimate means no run.
    throw new Error(`pricingModel ${model || 'unknown'} has no per-run price to estimate`);
  }

  const events = entry.pricingPerEvent?.actorChargeEvents;
  if (!events || typeof events !== 'object') throw new Error('pay-per-event Actor with no actorChargeEvents');

  let usd = 0;
  const parts = [];
  const add = (name, count) => {
    const price = eventPrice(events[name]);
    if (price == null || !(count > 0)) return;
    usd += price * count;
    parts.push(`${name} ${count} x ${shortUsd(price)}`);
  };

  // apify-actor-start is charged once per GB of run memory, at least once.
  const memory = Number(actor?.defaultRunOptions?.memoryMbytes) || 1024;
  add(START_EVENT, Math.max(1, Math.ceil(memory / 1024)));
  add(ITEM_EVENT, plan.results);

  const known = plan.perResult.filter((name) => name in events);
  const pageKnown = Boolean(plan.perPage && plan.perPage in events);
  let upperBound = false;
  if (known.length > 0 || pageKnown) {
    for (const name of known) add(name, plan.results);
    if (pageKnown && plan.perPage) add(plan.perPage, plan.pages ?? 0);
  } else {
    // None of the expected event names is listed (a custom Actor, or a renamed
    // event). Count every remaining event once per result: it over-counts,
    // which is the safe side for a spend gate.
    upperBound = true;
    for (const name of Object.keys(events)) {
      if (name !== START_EVENT && name !== ITEM_EVENT) add(name, plan.results);
    }
  }
  if (parts.length === 0) throw new Error('no chargeable events listed');

  const minCharge = typeof entry.minimalMaxTotalChargeUsd === 'number' ? entry.minimalMaxTotalChargeUsd : null;
  return { usd, basis: parts.join(' + '), upperBound, minCharge };
}
