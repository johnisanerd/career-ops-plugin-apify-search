# career-ops-plugin-apify-search

A provider plugin for [career-ops](https://github.com/career-ops-hq/career-ops). It searches LinkedIn, Indeed, Wellfound and Google Jobs for a role and location through Apify Actors, and hands what it finds to `scan.mjs` like any other source. It answers career-ops-hq/career-ops#2584.

The default Actors are mine (johnvc on Apify); every actor ID is configurable.

Apify runs cost money, so the plugin tells you what a search will cost before it spends anything. Out of the box it only prints that estimate.

## How a search runs

Each `job_boards` entry in `portals.yml` with `provider: apify-search` is one search. When `node scan.mjs` gets to it, the plugin reads the current price of every enabled board's Actor from the Apify API and prints what the search would cost at the capped result count. Then it stops, unless `confirm_spend: true` is set and the estimate is under `max_usd`.

If both hold, it starts one run per board, waits for them, and returns the jobs. The scanner does the rest as it would for any provider: title, location and blacklist filters, dedup against the tracker, the pipeline and `data/scan-history.tsv`, and new postings appended to `data/pipeline.md`.

## Install

```bash
# from the registry, once it is listed
node plugins.mjs add apify-search

# before that, straight from this repo at a pinned commit
node plugins.mjs add johnisanerd/career-ops-plugin-apify-search --sha <40-hex-commit>

node plugins.mjs enable apify-search            # shows the capability card
node plugins.mjs enable apify-search --confirm  # grants it
```

Then put your Apify token in `.env`. Without it the plugin stays off.

```
APIFY_TOKEN=apify_api_...
```

## Add a search

In `portals.yml`:

```yaml
job_boards:
  - name: "Apify: data engineer, Berlin"
    provider: apify-search
    query: "data engineer"
    location: "Berlin, Germany"
    country: DE                     # optional; Indeed uses it to pick its country site (default US)
    # boards: [linkedin, indeed]    # optional: only these boards for this search
    # max_results: 20               # optional: per board, never above 50
```

Run `node scan.mjs`. The first time, you get the estimate and no jobs:

```
apify-search: "data engineer" in Berlin, Germany, estimated cost before anything runs:
  LinkedIn    johnvc/linkedin-jobs-api    up to 25 jobs  $0.0003  [job-scraped 25 x $0.00001]
  Indeed      johnvc/indeed-jobs-api      up to 25 jobs  $0.10  [job-scraped 25 x $0.004]
  Wellfound   johnvc/wellfound-jobs-api   up to 25 jobs  $0.03  [job-listing 25 x $0.001]
  Google Jobs johnvc/Google-Jobs-Scraper  up to 25 jobs  $0.27  [apify-actor-start 1 x $0.00005 + apify-default-dataset-item 25 x $0.00001 + page_processed 3 x $0.09]
  Total $0.40 at list price (paid Apify plans pay less). Ceiling: max_usd $1.00.
apify-search: nothing was started. To run this search, set confirm_spend: true under plugins.apify-search in config/plugins.yml.
```

Those figures come from the test fixtures. The real ones are read from Apify on every scan.

## Settings

Under `plugins.apify-search` in `config/plugins.yml`. Every key is optional.

```yaml
plugins:
  apify-search:
    enabled: true
    confirm_spend: false    # true lets scan.mjs start paid runs
    max_usd: 1.00           # a search whose estimate is above this doesn't run
    max_results: 25         # per board, per search; clamped to 1..50
    timeout_secs: 300       # per run; 60..900
    boards:
      linkedin:    { actor: johnvc/linkedin-jobs-api }
      indeed:      { actor: johnvc/indeed-jobs-api, input: { datePosted: "Last 7 days" } }
      wellfound:   { enabled: false }
      google_jobs: { actor: johnvc/Google-Jobs-Scraper, max_results: 10 }
```

Per board you can set `enabled`, `actor`, `max_results` (a lower ceiling for that board) and `input`, which is merged into the Actor's input for filters like date or job type. The query, location and result cap always come from the plugin, so `input` can't widen a run.

## What keeps the spend down

- Nothing runs until you set `confirm_spend: true`. Until then each scan prints the estimate and returns no jobs.
- `node scan.mjs --dry-run` never starts a run, even with `confirm_spend` on.
- A board returns at most 50 jobs per search whatever the config says. The default is 25.
- The estimate comes from each Actor's `pricingInfos`, fetched at run time, times the capped count. Where a price is tiered by Apify plan it takes the highest tier, so on a paid plan you pay less than it says.
- Every run starts with Apify's own `maxItems` and `maxTotalChargeUsd` limits, set to the cap and to the estimate (or to the Actor's minimum allowed limit, if that is higher), so Apify stops charging there even if an Actor overshoots.
- A board whose price can't be read is skipped, not run blind. So is a free or rental Actor, because the platform usage it bills to you can't be known in advance.
- `max_usd` is per search entry. Two entries can each spend up to it.
- Once confirmed, every `node scan.mjs` repeats the search and pays for it again, even when the scanner then drops everything as already seen. Set `enabled: false` on the entry when you don't want it on every scan, or run it alone with `node scan.mjs --company "Apify:"`.

## What comes back

| Board | `url` is | Posted date from |
|---|---|---|
| LinkedIn | the employer's apply link (`applyUrl`) when it is off LinkedIn, else the LinkedIn job page | `postedDate`, or `postedAgo` |
| Indeed | the employer's apply link (`applyUrl`) when it is off Indeed, else the Indeed job page | `datePosted`, or `datePostedText` |
| Wellfound | the Wellfound job page | `postedAt` |
| Google Jobs | the first apply option that isn't a job board, else any apply option, else Google's share link | `detected_extensions.posted_at` ("3 days ago") |

That order follows the source policy in career-ops CONTRIBUTING: the employer's own link first. When the main link is the employer's, the board page rides along in the pipeline line as `note: via LinkedIn <url>`.

Title, company and location map straight across. Salary is passed only when the source states a yearly figure from the employer (Indeed rows marked `YEARLY` and not estimated, and Wellfound's salary range). Error rows, free-tier notice rows and expired Indeed listings are dropped and counted in the scan log.

The same posting often turns up on two boards. Before the jobs reach the scanner the plugin merges them on `ctx.normalizePostingUrl` and `ctx.aggregatorPostingId`, so a Greenhouse link found on LinkedIn and on Google Jobs, or one LinkedIn job id under two URL shapes, comes through once.

## About the boards

Job boards set their own terms for automated access, and LinkedIn's and Indeed's restrict it. These Actors read public listing pages and never sign in to an account. If you'd rather not use a board, set `enabled: false` for it.

## Tests

```bash
node test/smoke.mjs   # the template's check: the entry imports and its hooks match the manifest
node test/unit.mjs    # mocked Apify API: estimates, caps, the spend gate, each board's mapping
```

Both run offline and spend nothing.

## License

MIT
