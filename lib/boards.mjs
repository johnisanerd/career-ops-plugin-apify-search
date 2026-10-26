// @ts-check
// The four boards: how a search becomes each Actor's input, which charge
// events that input triggers, and how a dataset row becomes a scanner Job.
// Field names were read from each Actor's dataset schema; see the README.

/**
 * @typedef {{ query: string, location: string, country: string }} Search
 * @typedef {{ title: string, url: string, company: string, location: string,
 *   postedAt?: number, description?: string,
 *   salary?: { min?: number, max?: number, currency?: string },
 *   note?: string, boardUrl?: string }} Job
 */

// Multi-employer sites. An apply link on one of these is not the employer's
// own page, so it doesn't win over the board's URL (source policy rule 2).
const AGGREGATOR_HOSTS = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'monster.com',
  'simplyhired.com', 'careerbuilder.com', 'dice.com', 'wellfound.com', 'talent.com',
  'jooble.org', 'adzuna.com', 'lensa.com', 'bebee.com', 'salary.com', 'builtin.com',
  'jobrapido.com', 'snagajob.com', 'jobright.ai', 'whatjobs.com', 'jobleads.com',
  'learn4good.com', 'flexjobs.com', 'ladders.com', 'theladders.com', 'getwork.com',
  'virtualvocations.com', 'joblist.com', 'recruit.net', 'tallo.com', 'google.com',
];

/** The value as an https URL string, or '' for anything else. */
export function httpsUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

export function isAggregatorHost(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  return AGGREGATOR_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * Employer first: the first apply link that isn't on an aggregator. After
 * that, the board's own URL, then any https apply link. Google Jobs flips the
 * last two, because a listing page on LinkedIn or Indeed is closer to the
 * employer than a Google search link.
 * @param {unknown[]} applyLinks
 * @param {string} boardUrl
 */
export function pickUrl(applyLinks, boardUrl, { boardLast = false } = {}) {
  const links = applyLinks.map(httpsUrl).filter(Boolean);
  const employer = links.find((u) => !isAggregatorHost(u));
  if (employer) return employer;
  return (boardLast ? links[0] || boardUrl : boardUrl || links[0]) || '';
}

/** Epoch ms from an ISO date, or undefined. Future dates are dropped. */
export function parseDate(value, now = Date.now()) {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) && t > 0 && t <= now + 86_400_000 ? t : undefined;
}

const AGO_UNITS = { minute: 60e3, min: 60e3, hour: 3600e3, hr: 3600e3, day: 86400e3, week: 604800e3, month: 2592000e3 };

/** Epoch ms from "3 days ago", "30+ days ago", "just posted", or undefined. */
export function parseAgo(text, now = Date.now()) {
  if (typeof text !== 'string') return undefined;
  if (/\b(just posted|today|just now)\b/i.test(text)) return now;
  if (/\byesterday\b/i.test(text)) return now - AGO_UNITS.day;
  const m = /(\d+)\s*\+?\s*(minute|min|hour|hr|day|week|month)s?\s+ago/i.exec(text);
  return m ? now - Number(m[1]) * AGO_UNITS[m[2].toLowerCase()] : undefined;
}

const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');

/** Build a Job, or null when title or URL is missing. */
function makeJob(label, { title, url, boardUrl, company, location, postedAt, description, salary }) {
  const job = { title: text(title), url, company: text(company), location: text(location) };
  if (!job.title || !job.url) return null;
  if (postedAt) job.postedAt = postedAt;
  if (typeof description === 'string' && description.trim()) job.description = description.trim();
  if (salary) job.salary = salary;
  // The board's own page rides along as secondary attribution when the main
  // URL points at the employer.
  if (boardUrl && boardUrl !== url) job.note = `via ${label} ${boardUrl}`;
  if (boardUrl) job.boardUrl = boardUrl;
  return job;
}

function annualSalary(min, max, currency) {
  const lo = typeof min === 'number' && min > 0 ? min : undefined;
  const hi = typeof max === 'number' && max > 0 ? max : undefined;
  if (lo === undefined && hi === undefined) return undefined;
  const out = {};
  if (lo !== undefined) out.min = lo;
  if (hi !== undefined) out.max = hi;
  if (typeof currency === 'string' && currency) out.currency = currency.toUpperCase();
  return out;
}

/**
 * Why a row is not a job, or null when it is one. Error rows carry
 * result_type "error" (or error: true on Google Jobs); free-tier notice rows
 * carry free_tier_notice and no result_type.
 * @returns {null | { kind: 'notice' | 'error', message: string }}
 */
export function rowProblem(row) {
  if (!row || typeof row !== 'object') return { kind: 'error', message: 'row is not an object' };
  if (row.free_tier_notice) return { kind: 'notice', message: text(row.message) || 'free tier notice' };
  if (row.error === true) return { kind: 'error', message: text(row.error_message) || 'error row' };
  if (row.result_type != null && row.result_type !== 'job') {
    return { kind: 'error', message: text(row.error_message) || `result_type ${row.result_type}` };
  }
  return null;
}

const slug = (s) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** @type {Record<string, any>} */
export const BOARDS = {
  linkedin: {
    label: 'LinkedIn',
    defaultEnabled: true,
    actor: 'johnvc/linkedin-jobs-api',
    /** @param {Search} s @param {number} cap @param {object} extra */
    input(s, cap, extra) {
      const input = { keyword: s.query, ...extra };
      if (s.location && input.location === undefined) input.location = s.location;
      if (s.country && input.country === undefined) input.country = s.country.toUpperCase();
      delete input.jobUrls; // job URLs ignore maxJobs, so they stay out of a capped search
      input.keyword = s.query;
      input.maxJobs = cap;
      return input;
    },
    plan(input, cap) {
      return { perResult: ['job-scraped'], results: cap };
    },
    toJob(row, now) {
      const boardUrl = httpsUrl(row.jobUrl);
      return makeJob('LinkedIn', {
        title: row.title,
        url: pickUrl([row.applyUrl], boardUrl),
        boardUrl,
        company: row.companyName,
        location: row.location,
        postedAt: parseDate(row.postedDate, now) ?? parseAgo(row.postedAgo, now),
        description: row.description,
      });
    },
  },

  indeed: {
    label: 'Indeed',
    defaultEnabled: true,
    actor: 'johnvc/indeed-jobs-api',
    input(s, cap, extra) {
      const input = {
        country: (s.country || 'US').toUpperCase(),
        descriptionFormat: 'text',
        includeCompanyDetails: false,
        uniqueJobsOnly: true,
        ...extra,
      };
      if (s.location && input.location === undefined) input.location = s.location;
      // One keyword, because maxResultsPerInput is a per-keyword limit.
      input.mode = 'search';
      input.keywords = [s.query];
      input.maxResultsPerInput = cap;
      return input;
    },
    plan(input, cap) {
      const perResult = ['job-scraped'];
      // Charged per distinct employer, so at most once per result.
      if (input.includeCompanyDetails) perResult.push('company-details-added');
      return { perResult, results: cap };
    },
    toJob(row, now) {
      if (row.isExpired === true) return null;
      const boardUrl = httpsUrl(row.jobUrl);
      const yearly = row.salaryPeriod === 'YEARLY' && row.salaryIsEstimated !== true;
      return makeJob('Indeed', {
        title: row.jobTitle,
        url: pickUrl([row.applyUrl], boardUrl),
        boardUrl,
        company: row.companyName,
        location: row.location || row.jobLocation,
        postedAt: parseDate(row.datePosted, now) ?? parseAgo(row.datePostedText, now),
        description: row.descriptionText || row.descriptionMarkdown,
        salary: yearly ? annualSalary(row.salaryMin, row.salaryMax, row.salaryCurrency) : undefined,
      });
    },
  },

  wellfound: {
    label: 'Wellfound',
    defaultEnabled: true,
    actor: 'johnvc/wellfound-jobs-api',
    input(s, cap, extra) {
      const input = { roles: [s.query], includeDescription: false, fetchJobDetails: false, ...extra };
      if (s.location && input.locations === undefined && input.remoteOnly === undefined) {
        // Wellfound takes location slugs ("san-francisco"), so use the city
        // part of "San Francisco, CA". "Remote" maps to its remote filter.
        if (/^\s*remote\b/i.test(s.location)) input.remoteOnly = true;
        else input.locations = [slug(s.location.split(',')[0])].filter(Boolean);
      }
      input.maxItems = cap; // across all role x location threads
      return input;
    },
    plan(input, cap) {
      const perResult = ['job-listing'];
      if (input.includeDescription !== false) perResult.push('job-description');
      if (input.fetchJobDetails === true) perResult.push('job-detail');
      return { perResult, results: cap };
    },
    toJob(row, now) {
      const boardUrl = httpsUrl(row.url);
      const places = Array.isArray(row.locationNames) ? row.locationNames.filter((p) => typeof p === 'string') : [];
      const location = places.join(' / ') || (row.remote === true ? 'Remote' : '');
      return makeJob('Wellfound', {
        title: row.title,
        url: boardUrl,
        boardUrl,
        company: row.company?.name,
        location,
        postedAt: parseDate(row.postedAt, now) ?? parseDate(row.datePosted, now),
        description: row.description,
        salary: annualSalary(row.salaryMin, row.salaryMax, row.salaryCurrency),
      });
    },
  },

  google_jobs: {
    label: 'Google Jobs',
    defaultEnabled: true,
    actor: 'johnvc/Google-Jobs-Scraper',
    input(s, cap, extra) {
      const input = { ...extra };
      if (s.location && input.location === undefined) input.location = s.location;
      if (s.country && input.country === undefined) input.country = s.country.toLowerCase();
      input.query = s.query;
      // The Actor's minimum is 10 results. Billing is per results page of
      // about 10, so the page count is pinned too.
      input.num_results = Math.max(10, cap);
      input.max_pagination = Math.ceil(input.num_results / 10);
      return input;
    },
    plan(input) {
      return { perResult: [], perPage: 'page_processed', pages: input.max_pagination, results: input.num_results };
    },
    toJob(row, now) {
      const options = Array.isArray(row.apply_options) ? row.apply_options : [];
      const boardUrl = httpsUrl(row.share_link);
      return makeJob('Google Jobs', {
        title: row.title,
        url: pickUrl(options.map((o) => o?.link), boardUrl, { boardLast: true }),
        boardUrl,
        company: row.company_name,
        location: row.location,
        postedAt: parseAgo(row.detected_extensions?.posted_at, now),
        description: row.description,
      });
    },
  },
};

export const BOARD_IDS = Object.keys(BOARDS);
