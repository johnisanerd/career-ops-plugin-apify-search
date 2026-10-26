---
name: career-ops-plugin-apify-search
description: How to run a cost-checked role and location search on LinkedIn, Indeed, Wellfound and Google Jobs with the apify-search provider, and what it adds to the pipeline.
license: MIT
---

# apify-search

A keyed provider. It never auto-detects; it runs only for a `portals.yml`
`job_boards` entry that sets `provider: apify-search`, and only when
`APIFY_TOKEN` is in `.env`.

## How to run it

1. Add or edit an entry in `portals.yml`:

   ```yaml
   job_boards:
     - name: "Apify: product manager, London"
       provider: apify-search
       query: "product manager"
       location: "London, UK"
       country: GB
   ```

2. Run `node scan.mjs` (or `node scan.mjs --dry-run`). The plugin prints a
   cost estimate per board and a total, and starts nothing.

3. Show that estimate to the user. Paid runs start only after the user sets
   `confirm_spend: true` under `plugins.apify-search` in `config/plugins.yml`,
   and only when the total is under `max_usd`. Leave those two settings to
   the user: don't turn `confirm_spend` on or raise `max_usd` yourself.

4. With spending confirmed, the next `node scan.mjs` runs the search, and new
   postings land in `data/pipeline.md` like any other scan result.

## What it produces

Job entries with `title`, `url`, `company`, `location`, and when the source has
them `postedAt`, `description`, a yearly `salary`, and a `note` of the form
`via <Board> <board URL>`. `url` is the employer's apply link when the listing
has one, else the board's job page. Error rows and free-tier notice rows from
the Actors are dropped and summarized in the scan log.

## Settings

In `config/plugins.yml` under `plugins.apify-search`: `confirm_spend`
(default false), `max_usd` (default 1.00, per search), `max_results` (default
25, never above 50 per board), `timeout_secs` (default 300), and `boards.<id>`
with `enabled`, `actor`, `max_results` and `input` for each of `linkedin`,
`indeed`, `wellfound` and `google_jobs`.

In the `portals.yml` entry: `query` (required), `location`, `country`,
`boards` (a subset) and `max_results`.
