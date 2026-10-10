import * as cheerio from 'cheerio';
import { isIP } from 'node:net';

const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const SEARCH_TIMEOUT_MS = 8_000;
const PAGE_TIMEOUT_MS = 6_000;
const BROWSER_TIMEOUT_MS = 8_000;
const MAX_SEARCH_RESPONSE_BYTES = 1_000_000;
const MAX_PAGE_BYTES = 2_000_000;
const MAX_EXTRACTED_TEXT_CHARS = 40_000;
const MAX_FOLLOWUP_CLAIMS = 2;
const MAX_FOLLOWUP_SEARCHES = 2;
const MAX_INITIAL_FETCH_CANDIDATES = 4;
const MAX_UNIQUE_FETCH_ATTEMPTS = 6;

export type Recency = 'day' | 'week' | 'month' | 'year' | 'any';

export interface ResearchOptions {
  query: string;
  max_results: number;
  recency: Recency;
}

export interface ResearchSource {
  id: string;
  title: string;
  url: string;
  canonicalUrl: string | null;
  domain: string;
  sourceType: SourceType;
  retrievedAt: string;
  duplicateResults: Array<{ title: string; url: string; publishedAt: string | null; relevanceScore: number | null; snippet: string }>;
  publishedAt: string | null;
  updatedAt: string | null;
  searchPageAge: string | null;
  searchSnippet: string;
  extractedText: string;
  relevanceScore: number | null;
  queryRelevance: number;
  targetRelevance: number;
  selectionScore: number;
  selectionReasons: string[];
  selectionOutcome: 'selected' | 'replacement' | 'duplicate' | 'skipped' | 'fetch_limit';
  truncated: boolean;
  requiresBrowserRendering: boolean;
  browserRenderingAttempted: boolean;
  browserRenderingError?: string;
  fetchError?: string;
}

export type SourceType = 'primary' | 'news' | 'academic' | 'government' | 'company' | 'reference' | 'blog' | 'video' | 'unknown';
export type FindingStatus = 'corroborated' | 'single_source' | 'disputed' | 'insufficient_evidence';

export type FindingType = 'fact' | 'claim' | 'opinion' | 'prediction' | 'background' | 'unknown';
export interface Evidence { sourceId: string; sentence: string; snippet: string; publishedAt: string | null }
export interface Finding {
  claim: string;
  type: FindingType;
  verificationRequired: boolean;
  /** Kept as a compatibility alias for existing consumers. */
  claimType: FindingType;
  sourceIds: string[];
  contradictingSourceIds: string[];
  evidence: Evidence[];
  publishedAt: string | null;
  corroborationCount: number;
  status: FindingStatus;
  sourceCount: number;
  independentSourceCount: number;
  corroborationStatus: FindingStatus;
  relevanceScore: number;
  targetRelevance: number;
  materialFigures: Array<{ raw: string; metric: string; normalizedValue: number; unit: string }>;
}
export interface ResearchSummary {
  query: string;
  retrievedAt: string;
  researchMode: 'bounded_agentic';
  searchCount: number;
  followupSearchCount: number;
  researchDepth: 0 | 1;
  trace: ResearchTrace;
  researchTarget: string;
  sourceSelection: SourceSelectionSummary;
  coverage: { searchResults: number; uniqueSources: number; fetchedPages: number; usablePages: number; failedPages: number; distinctDomains: number; distinctDevelopments: number; recentDevelopments: number; independentCorroboratingSources: number; unresolvedMaterialConflicts: number; adequate: boolean; adequacyReasons: string[] };
  findings: Finding[];
  sources: Array<{ id: string; title: string; url: string; domain: string; sourceType: SourceType; publishedAt: string | null; relevanceScore: number | null; queryRelevance: number; targetRelevance: number; selectionScore: number; selectionReasons: string[]; selectionOutcome: ResearchSource['selectionOutcome']; truncated: boolean; requiresBrowserRendering: boolean; browserRenderingAttempted: boolean; browserRenderingError?: string; retrievedAt: string; fetchError?: string }>;
  corroboration: Array<{ claim: string; sourceIds: string[]; corroborationCount: number; status: FindingStatus }>;
  disagreements: Array<{ claims: string[]; sourceIds: string[]; reason: string }>;
  limitations: string[];
}

export interface SourceSelectionSummary {
  totalResultsDiscovered: number;
  candidatesRanked: number;
  fetchAttempts: number;
  pagesSuccessfullyFetched: number;
  usablePages: number;
  failedPages: number;
  truncatedPages: number;
  replacementsUsed: boolean;
  replacementCandidatesAttempted: number;
  adequatelyAnswersTarget: boolean;
  candidates: Array<{ title: string; url: string; score: number; reasons: string[]; decision: string; sourceId?: string }>;
}

export interface ResearchTrace {
  initialSearches: number;
  followupSearches: number;
  sourcesDiscovered: number;
  sourcesUsed: number;
  claimsExtracted: number;
  followupReasons: string[];
}

export interface ResearchResult {
  query: string;
  recency: Recency;
  sources: ResearchSource[];
  research: ResearchSummary;
}

export interface SearchResult {
  title: string;
  url: string;
  content: string;
  score: number | null;
  publishedDate: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a response in chunks so unexpectedly large pages cannot use unlimited memory. */
async function readTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new Error(`Response exceeded the ${maxBytes} byte limit.`);
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder().decode(bytes);
}

function chooseSearchTopic(query: string): 'general' | 'news' {
  // Require an explicit news signal; words such as "latest" alone stay general.
  return /\b(news|headlines?|breaking(?: news)?|current events|news coverage|news reports?)\b/i.test(query)
    ? 'news'
    : 'general';
}

function normalizeTavilyResults(value: unknown, maxResults: number): SearchResult[] {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new Error('Tavily Search returned an unexpected response format (missing results array).');
  }

  return value.results.slice(0, maxResults).flatMap((item): SearchResult[] => {
    if (!isRecord(item) || typeof item.title !== 'string' || typeof item.url !== 'string') return [];

    return [{
      title: item.title,
      url: item.url,
      content: typeof item.content === 'string' ? item.content : '',
      score: typeof item.score === 'number' && Number.isFinite(item.score) ? item.score : null,
      publishedDate: typeof item.published_date === 'string' ? item.published_date : null,
    }];
  });
}

async function getTavilyErrorMessage(response: Response): Promise<string | null> {
  try {
    const text = await readTextWithLimit(response, MAX_SEARCH_RESPONSE_BYTES);
    const payload: unknown = JSON.parse(text);
    if (!isRecord(payload)) return null;

    const detail = payload.detail;
    if (typeof detail === 'string') return detail.slice(0, 300);
    if (isRecord(detail) && typeof detail.error === 'string') return detail.error.slice(0, 300);
  } catch {
    // The HTTP status still gives us a useful error if the body is not JSON.
  }

  return null;
}

async function searchWeb(query: string, maxResults: number, recency: Recency): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY is not set. Set it in the server environment to enable web search.');
  }

  let response: Response;
  try {
    response = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        max_results: maxResults,
        time_range: recency === 'any' ? null : recency,
        topic: chooseSearchTopic(query),
        search_depth: 'basic',
        include_published_date: true,
        include_answer: false,
        include_raw_content: false,
      }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Tavily Search timed out after ${SEARCH_TIMEOUT_MS / 1_000} seconds.`);
    }
    throw new Error('Could not reach the Tavily Search API. Check the network connection and try again.');
  }

  if (response.status === 429) {
    throw new Error('Tavily Search rate limit reached. Wait briefly before trying again.');
  }
  if (!response.ok) {
    const detail = await getTavilyErrorMessage(response);
    const reason = detail ? ` ${detail}` : '';
    throw new Error(`Tavily Search returned HTTP ${response.status}.${reason}`);
  }

  let data: unknown;
  let text: string;
  try {
    text = await readTextWithLimit(response, MAX_SEARCH_RESPONSE_BYTES);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Response exceeded')) throw error;
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`Tavily Search timed out after ${SEARCH_TIMEOUT_MS / 1_000} seconds.`);
    }
    throw new Error('Could not read the Tavily Search response.');
  }

  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new Error('Tavily Search returned malformed JSON.');
  }

  return normalizeTavilyResults(data, maxResults);
}

function readPublicationDates($: cheerio.CheerioAPI): { publishedAt: string | null; updatedAt: string | null } {
  const publishedAt =
    $('meta[property="article:published_time"]').attr('content') ??
    $('meta[name="datePublished" i]').attr('content') ??
    $('meta[name="date" i]').attr('content') ??
    $('meta[name="pubdate" i]').attr('content') ??
    $('time[datetime]').first().attr('datetime') ??
    null;

  let updatedAt =
    $('meta[property="article:modified_time"]').attr('content') ??
    $('meta[name="dateModified" i]').attr('content') ??
    $('meta[name="last-modified" i]').attr('content') ??
    null;

  // Many sites publish dates in JSON-LD. Read the common Article fields when present.
  for (const script of $('script[type="application/ld+json"]').toArray()) {
    try {
      const json = JSON.parse($(script).text()) as Record<string, unknown> | Record<string, unknown>[];
      const items = Array.isArray(json) ? json : [json];
      for (const item of items) {
        const graph = Array.isArray(item['@graph']) ? (item['@graph'] as Record<string, unknown>[]) : [item];
        for (const entry of graph) {
          if (typeof entry.datePublished === 'string') return {
            publishedAt: publishedAt ?? entry.datePublished,
            updatedAt: updatedAt ?? (typeof entry.dateModified === 'string' ? entry.dateModified : null),
          };
          if (!updatedAt && typeof entry.dateModified === 'string') updatedAt = entry.dateModified;
        }
      }
    } catch {
      // Ignore malformed JSON-LD and keep checking the page's other metadata.
    }
  }

  return { publishedAt, updatedAt };
}

function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parsePublicPageUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Only HTTP and HTTPS pages can be fetched.');
  }
  if (url.username || url.password) throw new Error('URLs containing credentials cannot be fetched.');
  if (
    isIP(hostname) ||
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Local and IP-address URLs cannot be fetched.');
  }

  return url;
}

async function fetchHtmlPage(initialUrl: string): Promise<Response> {
  let pageUrl = parsePublicPageUrl(initialUrl);
  const timeoutSignal = AbortSignal.timeout(PAGE_TIMEOUT_MS);

  // Validate each redirect instead of allowing fetch() to follow it blindly.
  for (let redirectCount = 0; redirectCount <= 3; redirectCount += 1) {
    const response = await fetch(pageUrl, {
      headers: {
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
        'User-Agent': 'AlexaLiveWebResearchMCP/0.1 (+web research tool)',
      },
      signal: timeoutSignal,
      redirect: 'manual',
    });

    if (![301, 302, 303, 307, 308].includes(response.status)) return response;

    const location = response.headers.get('location');
    if (!location) return response;
    if (redirectCount === 3) throw new Error('Page exceeded the 3 redirect limit.');

    await response.body?.cancel();
    pageUrl = parsePublicPageUrl(new URL(location, pageUrl).toString());
  }

  throw new Error('Page could not be fetched.');
}

function isBoilerplate(text: string): boolean {
  return /\b(cookie settings|accept cookies|privacy policy|terms of service|all rights reserved|subscribe now|sign in|log in|newsletter|share this article|leave a comment|skip to content|advertisement|sponsored content|enable javascript|your browser)\b/i.test(text)
    || /^\s*(copyright|©|home\s*[|>]|menu\s*[|>])/i.test(text);
}

interface ExtractedPageText { text: string; truncated: boolean; requiresBrowserRendering: boolean }

interface RenderedPage { html: string; truncated: boolean }
type BrowserRenderer = (url: string) => Promise<RenderedPage>;
interface BrowserRoute {
  request(): { url(): string; resourceType(): string; method(): string };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}
interface BrowserPage {
  setDefaultNavigationTimeout(timeout: number): void;
  setDefaultTimeout(timeout: number): void;
  goto(url: string, options: { waitUntil: 'domcontentloaded'; timeout: number }): Promise<{ status(): number } | null>;
  locator(selector: string): { evaluate<T>(callback: (element: { outerHTML: string; innerText: string }) => T): Promise<T> };
  waitForTimeout(timeout: number): Promise<void>;
}
interface BrowserContext {
  route(pattern: string, handler: (route: BrowserRoute) => Promise<void>): Promise<void>;
  newPage(): Promise<BrowserPage>;
  close(): Promise<void>;
}
interface BrowserInstance {
  newContext(options: { javaScriptEnabled: boolean; acceptDownloads: boolean; serviceWorkers: 'block' }): Promise<BrowserContext>;
  close(): Promise<void>;
}
interface PlaywrightModule {
  chromium: { launch(options: { headless: boolean; timeout: number }): Promise<BrowserInstance> };
}

/** Use Chromium only when ordinary HTTP returns an empty JavaScript shell. */
async function renderPageWithPlaywright(initialUrl: string): Promise<RenderedPage> {
  // A variable specifier keeps local fixture typechecking possible when the
  // optional browser package has not yet been installed in a restricted env.
  const packageName = 'playwright';
  const { chromium } = await import(packageName) as PlaywrightModule;
  const browser = await chromium.launch({ headless: true, timeout: BROWSER_TIMEOUT_MS });
  try {
    const context = await browser.newContext({ javaScriptEnabled: true, acceptDownloads: false, serviceWorkers: 'block' });
    await context.route('**/*', async (route) => {
      try {
        // Validate every navigation, redirect, script, and API request. This
        // keeps browser rendering under the same URL restrictions as HTTP.
        parsePublicPageUrl(route.request().url());
        if (!['GET', 'HEAD'].includes(route.request().method())) {
          await route.abort('blockedbyclient');
          return;
        }
        if (['image', 'font', 'media'].includes(route.request().resourceType())) {
          await route.abort();
        } else {
          await route.continue();
        }
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    const page = await context.newPage();
    page.setDefaultNavigationTimeout(BROWSER_TIMEOUT_MS);
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
    const response = await page.goto(parsePublicPageUrl(initialUrl).toString(), { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
    if (response && response.status() >= 400) throw new Error(`Rendered page returned HTTP ${response.status()}.`);
    // Some sites hydrate their article just after DOMContentLoaded. Give that
    // client-side render a short, bounded window before reading the DOM.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const bodyLength = await page.locator('body').evaluate((element) => element.innerText.trim().length);
      if (bodyLength >= 80) break;
      await page.waitForTimeout(500);
    }
    const html = await page.locator('html').evaluate((element) => element.outerHTML.slice(0, 2_000_000));
    const truncated = Buffer.byteLength(html, 'utf8') >= 2_000_000;
    await context.close();
    return { html, truncated };
  } finally {
    await browser.close();
  }
}

function extractRelevantText($: cheerio.CheerioAPI, query: string, title: string, hadScripts = false): ExtractedPageText {
  const contentRoot = $('article, main, [role="main"]').first();
  const root = contentRoot.length ? contentRoot : $('body');
  const nodes = root.find('h1, h2, h3, h4, p, li, caption, figcaption, blockquote, tr').toArray();
  const seen = new Set<string>();
  const blocks = nodes.map((element, index) => {
    const $element = $(element);
    const text = cleanText($element.is('tr')
      ? $element.find('th,td').map((_i, cell) => cleanText($(cell).text())).get().join(' | ')
      : $element.text());
    const tag = ($(element).prop('tagName') ?? '').toLowerCase();
    return { text, index, heading: /^h[1-4]$/.test(tag), contentBlock: ['li', 'caption', 'figcaption', 'tr', 'blockquote'].includes(tag) };
  }).filter(({ text, heading }) => {
    const key = normalizedTitle(text);
    if (text.length < (heading ? 4 : 25) || isBoilerplate(text) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const ranked = blocks.map((block) => ({ ...block, score: scoreRelevance(query, block.text, title, '') }));
  const relevant = ranked.filter((block) => block.score >= 0.12 || block.heading || block.contentBlock);
  const chosen = (relevant.length ? relevant : ranked.filter((item) => item.text.length >= 80))
    .sort((left, right) => right.score - left.score || left.index - right.index);
  let text = '';
  let truncated = false;
  for (const block of chosen) {
    const addition = `${text ? '\n\n' : ''}${block.text}`;
    if (text.length + addition.length > MAX_EXTRACTED_TEXT_CHARS) {
      const remaining = MAX_EXTRACTED_TEXT_CHARS - text.length;
      if (remaining > 0) text += addition.slice(0, remaining);
      truncated = true;
      break;
    }
    text += addition;
  }
  const requiresBrowserRendering = text.length < 80 && (hadScripts || /enable javascript|javascript required/i.test($('body').text()));
  return { text, truncated, requiresBrowserRendering };
}

function extractHtmlForSource(html: string, source: ResearchSource, query: string, htmlTruncated = false): ExtractedPageText {
  const $ = cheerio.load(html);
  const dates = readPublicationDates($);
  const pageTitle = $('meta[property="og:title"]').attr('content') ?? $('title').first().text();
  if (pageTitle.trim()) source.title = cleanText(pageTitle).slice(0, 300);
  const canonical = $('link[rel="canonical"]').attr('href') ?? $('meta[property="og:url"]').attr('content');
  if (canonical) {
    try { source.canonicalUrl = new URL(canonical, source.url).toString(); } catch { /* Ignore invalid canonical metadata. */ }
  }
  source.publishedAt = dates.publishedAt ?? source.publishedAt;
  source.updatedAt = dates.updatedAt ?? source.updatedAt;
  const hadScripts = $('script').length > 0;
  $('script, style, noscript, nav, footer, header, aside, form, svg, iframe, [aria-hidden="true"], [hidden], [style*="display:none"], [style*="visibility:hidden"]').remove();
  const extraction = extractRelevantText($, query, source.title, hadScripts);
  source.extractedText = extraction.text;
  source.truncated = extraction.truncated || htmlTruncated;
  source.requiresBrowserRendering = extraction.requiresBrowserRendering;
  source.queryRelevance = scoreRelevance(query, source.extractedText, source.title, source.searchSnippet);
  source.targetRelevance = scoreTargetRelevance(query, source.extractedText, source.title);
  return extraction;
}

function normalizeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = 'https:';
    url.port = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_.+|fbclid|gclid|mc_cid|mc_eid|ref_src)$/i.test(key)) url.searchParams.delete(key);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
    return url.toString();
  } catch { return null; }
}

function normalizedTitle(title: string): string {
  return title.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function domainOf(value: string): string {
  try { return new URL(value).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'unknown'; }
}

function classifySource(url: string, query: string): SourceType {
  const host = domainOf(url);
  const path = (() => { try { return new URL(url).pathname.toLowerCase(); } catch { return ''; } })();
  if (/(^|\.)gov(?:\.[a-z]{2})?$/.test(host)) return 'government';
  if (/(^|\.)(arxiv\.org|doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|nature\.com|science\.org|sciencedirect\.com|springer\.com|ieee\.org|acm\.org|jstor\.org)$/.test(host) || /\.(edu|ac\.uk)$/.test(host) || /\/(doi|paper|publication|journal)\//.test(path)) return 'academic';
  if (/(^|\.)(youtube\.com|youtu\.be|vimeo\.com)$/.test(host)) return 'video';
  if (/(^|\.)(anthropic\.com|openai\.com|deepmind\.google|ai\.google|microsoft\.com|nvidia\.com)$/.test(host)) return 'company';
  if (/(^|\.)(scientificamerican\.com|technologyreview\.com|quantamagazine\.org)$/.test(host)) return 'news';
  if (/(^|\.)(reuters\.com|apnews\.com|bbc\.com|bbc\.co\.uk|cnn\.com|nytimes\.com|washingtonpost\.com|theguardian\.com|bloomberg\.com|npr\.org|aljazeera\.com|axios\.com|politico\.com|techcrunch\.com|theverge\.com|arstechnica\.com|wired\.com)$/.test(host) || /\.news$/.test(host)) return 'news';
  if (/(^|\.)(wikipedia\.org|britannica\.com|encyclopedia\.com|dictionary\.com)$/.test(host)) return 'reference';
  if (/(^|\.)(medium\.com|substack\.com|wordpress\.com|blogspot\.com)$/.test(host) || /(^|\/)blog\//.test(path) || /^blog\./.test(host)) return 'blog';
  if (/(^|\.)(prnewswire\.com|businesswire\.com|globenewswire\.com)$/.test(host) || /\/(press|newsroom|investor-relations|investors)\//.test(path)) return 'primary';
  const hostWords = host.split(/[.-]/);
  if (meaningfulTokens(query).some((token) => token.length >= 3 && hostWords.includes(token))) return 'company';
  return 'unknown';
}

function duplicateInfo(result: SearchResult) {
  return { title: result.title.slice(0, 300), url: result.url, publishedAt: result.publishedDate, relevanceScore: result.score, snippet: result.content.slice(0, 300) };
}

function prepareSearchResults(results: SearchResult[]): Array<SearchResult & { duplicates: ReturnType<typeof duplicateInfo>[] }> {
  const kept: Array<SearchResult & { duplicates: ReturnType<typeof duplicateInfo>[] }> = [];
  const urls = new Map<string, number>();
  const titles = new Map<string, number>();
  for (const result of results) {
    const canonical = normalizeUrl(result.url);
    if (!canonical) continue;
    const titleKey = normalizedTitle(result.title);
    const sameUrl = urls.get(canonical);
    const sameDomainTitle = titleKey ? titles.get(`${domainOf(result.url)}|${titleKey}`) : undefined;
    const likelyRepost = titleKey.length > 50 ? kept.findIndex((item) => {
      const otherKey = normalizedTitle(item.title);
      return otherKey === titleKey && domainOf(item.url) !== domainOf(result.url);
    }) : -1;
    const existingIndex = sameUrl ?? sameDomainTitle ?? (likelyRepost >= 0 ? likelyRepost : undefined);
    if (existingIndex !== undefined) {
      kept[existingIndex].duplicates.push(duplicateInfo(result));
      continue;
    }
    const index = kept.length;
    kept.push({ ...result, duplicates: [] });
    urls.set(canonical, index);
    if (titleKey) titles.set(`${domainOf(result.url)}|${titleKey}`, index);
  }
  return kept;
}

async function fetchSource(
  result: SearchResult & { duplicates: ReturnType<typeof duplicateInfo>[] },
  id: string,
  query: string,
  browserRenderer: BrowserRenderer,
): Promise<ResearchSource> {
  const source: ResearchSource = {
    id,
    title: result.title.slice(0, 300),
    url: result.url,
    canonicalUrl: null,
    domain: domainOf(result.url),
    sourceType: classifySource(result.url, query),
    retrievedAt: new Date().toISOString(),
    duplicateResults: result.duplicates,
    publishedAt: result.publishedDate,
    updatedAt: null,
    searchPageAge: null,
    searchSnippet: result.content.slice(0, 700),
    extractedText: '',
    relevanceScore: result.score,
    queryRelevance: scoreRelevance(query, result.content, result.title, ''),
    targetRelevance: scoreTargetRelevance(query, result.content, result.title),
    selectionScore: 0,
    selectionReasons: [],
    selectionOutcome: 'selected',
    truncated: false,
    requiresBrowserRendering: false,
    browserRenderingAttempted: false,
  };

  try {
    const response = await fetchHtmlPage(result.url);

    if (!response.ok) throw new Error(`Page returned HTTP ${response.status}.`);

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
      throw new Error('Page did not return HTML.');
    }

    const html = await readTextWithLimit(response, MAX_PAGE_BYTES);
    let extraction = extractHtmlForSource(html, source, query);
    if (extraction.requiresBrowserRendering) {
      source.browserRenderingAttempted = true;
      try {
        const rendered = await browserRenderer(result.url);
        extraction = extractHtmlForSource(rendered.html, source, query, rendered.truncated);
        source.requiresBrowserRendering = extraction.requiresBrowserRendering;
      } catch (error) {
        source.browserRenderingError = error instanceof Error ? error.message : 'Browser rendering failed.';
        source.requiresBrowserRendering = true;
      }
    }
  } catch (error) {
    source.fetchError = error instanceof Error ? error.message : 'The page could not be fetched.';
    // Search snippets remain discovery metadata and never become evidence.
    source.extractedText = '';
  }

  return source;
}

const STOP_WORDS = new Set('the and for with from that this what when where who why how latest recent today yesterday week month year research developments development about find explain compare sources reporting has have had was were are is be been being into over after before since according their they them its your in on a an to of by at as we my i it still remain open happened change changes changed did anyone solve solves solved'.split(' '));
const OPINION_PATTERN = /\b(i think|we believe|in my opinion|my feelings|i feel|personally|from my perspective|should|best|worst|it seems to me)\b/i;
const PREDICTION_PATTERN = /\b(may|might|could|will|likely|unlikely|expects? to|forecast|predict(?:s|ed|ion)?|project(?:s|ed|ion)?)\b.{0,70}\b(solve|prove|discover|reach|become|increase|decrease|happen|launch|grow|fall|change)\b/i;
const CLAIM_PATTERN = /\b(solved|proven|proved|breakthrough|first ever|first to|discovered|discovery|cure for|revolutionary|unprecedented|claims? to have|reportedly)\b/i;
const FACT_PATTERN = /\b(is|are|was|were|has|have|had|released|announced|said|approved|found|published|discovered|detected|launched|reported|disclosed|grew|fell|recorded|reached|increased|decreased|showed|demonstrated|confirmed|proposed|formulated|remains|states?|contains|includes|measured|observed|estimates?)\b|\b\d{4}\b|\b\d+(?:\.\d+)?\s?(?:%|percent|million|billion|trillion|dollars|usd|euros)?\b/i;
const BACKGROUND_PATTERN = /\b(introduced by|historically|(?:is|remains) an? open problem|open problem|remains unsolved|is named after|first described|was born|was published in|conjecture)\b/i;
const BOILERPLATE_SENTENCE_PATTERN = /\b(copyright|all rights reserved|privacy policy|terms of service|cookie settings|subscribe to our newsletter|sign in to continue|share this (?:article|story)|click here|read more|advertisement|skip to content|accept all cookies)\b/i;

function meaningfulTokens(text: string): string[] {
  const launchWords = new Set(['announce', 'announces', 'announced', 'announcement', 'release', 'releases', 'released', 'launch', 'launches', 'launched']);
  const expanded = text.replace(/\bartificial general intelligence\b/gi, 'AGI');
  return [...new Set((expanded.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((token) => (token.length > 1 || /^[A-Z]$/.test(token)) && !STOP_WORDS.has(token.toLowerCase()))
    .map((token) => token.toLowerCase())
    .map((token) => launchWords.has(token) ? 'launch' : token))];
}

function researchTargetFor(query: string): string {
  if (!isVerificationQuery(query)) return query.trim();
  const words = meaningfulTokens(query).filter((word) => !FOLLOWUP_STOP_WORDS.has(word));
  const years = words.filter((word) => /^20\d{2}$/.test(word));
  const topic = words.filter((word) => !years.includes(word)).join(' ') || query;
  return `Determine whether ${topic}${years.length ? ` in ${years.join(', ')}` : ''} was proved or disproved.`;
}

function scoreTargetRelevance(query: string, text: string, title = '', context = ''): number {
  const base = scoreRelevance(query, text, title, context);
  if (!isVerificationQuery(query)) return base;
  const combined = `${title} ${text} ${context}`;
  const directEvidence = isDirectVerificationEvidence(query, combined);
  const year = query.match(/\b20\d{2}\b/)?.[0];
  const yearMatch = year && combined.includes(year) ? 0.12 : 0;
  const historicalOnly = /\b(born|proposed|formulated|introduced|published in 18\d{2}|history of)\b/i.test(combined) && !directEvidence;
  return Math.max(0, Math.min(1, base + (directEvidence ? 0.3 : 0) + yearMatch - (historicalOnly ? 0.25 : 0)));
}

/** Detect an answer to a verification question, not every historical mention of its keywords. */
function isDirectVerificationEvidence(query: string, text: string): boolean {
  const topicTerms = meaningfulTokens(query)
    .filter((word) => !/^20\d{2}$/.test(word) && !/^(?:solve|solved|prove|proof|verified|verify|confirm|confirmed|anyone|disprove|disproved)$/.test(word));
  const matchedTerms = topicTerms.filter((word) => text.toLowerCase().includes(word.toLowerCase()));
  if (matchedTerms.length < Math.min(2, topicTerms.length)) return false;
  const answerPattern = /\b(?:remains? (?:unproven|unsolved|open)|(?:no one|nobody) has (?:yet )?(?:been able to )?(?:prove|disprove|solve)|has not been (?:proved|proven|solved)|was not (?:proved|proven|solved)|did not (?:prove|solve|resolve)|could not (?:prove|solve|resolve)|couldn['’]t (?:prove|solve|resolve)|no verified proof (?:has been )?(?:published|found)|no proof (?:has been )?(?:published|found)|(?:was|has been|is) (?:successfully )?(?:proved|proven|solved)|(?:proved|proven|solved) by|(?:solved|proved|proven) (?:the )?(?:riemann|hypothesis|conjecture))\b/i;
  return answerPattern.test(text) && !/\b(?:proved to be a (?:font|source|foundation)|problem to be solved|bounty to anyone who solved)\b/i.test(text);
}

function verificationPolarity(query: string, text: string): 'positive' | 'negative' | null {
  if (!isDirectVerificationEvidence(query, text)) return null;
  return /\b(?:remains? (?:unproven|unsolved|open)|no one|nobody|not been (?:proved|proven|solved)|was not (?:proved|proven|solved)|did not (?:prove|solve|resolve)|could not (?:prove|solve|resolve)|couldn['’]t (?:prove|solve|resolve)|no (?:verified )?proof (?:has been )?(?:published|found)|unable to (?:prove|solve|resolve))\b/i.test(text)
    ? 'negative' : 'positive';
}

function scoreRelevance(query: string, sentence: string, title: string, context: string): number {
  const terms = meaningfulTokens(query);
  if (terms.length === 0) return 0.35;
  const sentenceWords = meaningfulTokens(sentence);
  const contextWords = meaningfulTokens(context);
  const titleWords = meaningfulTokens(title);
  const weights = terms.map((term) => term.length >= 7 ? 1.5 : term.length >= 4 ? 1.15 : 0.8);
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  let sentenceMatch = 0; let titleMatch = 0; let contextMatch = 0; let repeats = 0;
  terms.forEach((term, index) => {
    const count = sentenceWords.filter((word) => word === term).length;
    if (count > 0) sentenceMatch += weights[index];
    if (titleWords.includes(term)) titleMatch += weights[index];
    if (contextWords.includes(term)) contextMatch += weights[index];
    repeats += Math.min(2, Math.max(0, count - 1));
  });
  const sentenceCoverage = sentenceMatch / totalWeight;
  let score = sentenceCoverage * 0.68 + (titleMatch / totalWeight) * 0.17 + (contextMatch / totalWeight) * 0.10 + Math.min(0.05, repeats * 0.025);
  if (sentence.length < 45 || sentence.length > 320) score -= 0.08;
  if (OPINION_PATTERN.test(sentence) && sentenceCoverage < 0.8) score -= 0.2;
  if (BOILERPLATE_SENTENCE_PATTERN.test(sentence)) score = 0;
  return Math.max(0, Math.min(1, score));
}

function splitSentences(text: string): string[] {
  return text.split(/\n+|(?<=[.!?])\s+(?=[A-Z0-9“"'])/u).map(cleanText).filter(Boolean);
}

interface MaterialFigure { raw: string; metric: string; normalizedValue: number; unit: string }
interface Candidate { text: string; source: ResearchSource; type: FindingType; tokens: Set<string>; values: string; figures: MaterialFigure[]; relevance: number; targetRelevance: number; verificationRequired: boolean; context: string }

/** Normalize common financial units while retaining the exact source wording. */
function materialFigures(sentence: string): MaterialFigure[] {
  const figures: MaterialFigure[] = [];
  const money = /([$€£])\s*(\d[\d,]*(?:\.\d+)?)\s*(billion|bn|b|million|m|thousand|k)?/gi;
  for (const match of sentence.matchAll(money)) {
    const raw = match[0].trim();
    const scale = /^(?:billion|bn|b)$/i.test(match[3] ?? '') ? 1_000_000_000
      : /^(?:million|m)$/i.test(match[3] ?? '') ? 1_000_000
        : /^(?:thousand|k)$/i.test(match[3] ?? '') ? 1_000 : 1;
    const before = sentence.slice(Math.max(0, (match.index ?? 0) - 28), match.index).toLowerCase();
    const after = sentence.slice((match.index ?? 0) + match[0].length, (match.index ?? 0) + match[0].length + 18).toLowerCase();
    const metric = /valu(?:ation|ed)/.test(`${before.slice(-12)} ${after}`) ? 'valuation'
      : /rais(?:e|ed)|fund(?:ing|raise)|investment|round/.test(`${before} ${after.slice(0, 12)}`) ? 'funding_amount' : 'money_amount';
    figures.push({ raw, metric, normalizedValue: Number(match[2].replace(/,/g, '')) * scale, unit: match[1] });
  }
  const percent = /\b(\d+(?:\.\d+)?)\s*%/g;
  for (const match of sentence.matchAll(percent)) figures.push({ raw: match[0], metric: 'percentage', normalizedValue: Number(match[1]), unit: '%' });
  const date = sentence.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*20\d{2})?|\b20\d{2}-\d{2}-\d{2}\b/i);
  if (date) figures.push({ raw: date[0], metric: 'date', normalizedValue: Date.parse(date[0]), unit: 'date' });
  const year = sentence.match(/\b20\d{2}\b/);
  if (year && !figures.some((figure) => figure.metric === 'date' && figure.raw.includes(year[0]))) {
    figures.push({ raw: year[0], metric: 'year', normalizedValue: Number(year[0]), unit: 'year' });
  }
  const counts = sentence.matchAll(/\b(?:about|approximately|nearly|over|more than|reached|total(?:ed)?|with)\s+(\d[\d,]*)\s+(people|users|models|papers|companies|sites|tasks|employees|jobs|cases|products)\b/gi);
  for (const match of counts) figures.push({ raw: `${match[1]} ${match[2]}`, metric: `count_${match[2].toLowerCase()}`, normalizedValue: Number(match[1].replace(/,/g, '')), unit: match[2].toLowerCase() });
  return figures;
}

function figuresConflict(left: Candidate, right: Candidate): boolean {
  for (const a of left.figures) for (const b of right.figures) {
    const tolerance = a.metric === 'date' ? 60_000 : Math.max(1, Math.abs(a.normalizedValue) * 0.001);
    if (a.metric === b.metric && a.unit === b.unit && Number.isFinite(a.normalizedValue) && Number.isFinite(b.normalizedValue)
      && Math.abs(a.normalizedValue - b.normalizedValue) > tolerance) return true;
  }
  return false;
}

function classifyStatement(sentence: string): FindingType {
  if (OPINION_PATTERN.test(sentence)) return 'opinion';
  if (PREDICTION_PATTERN.test(sentence)) return 'prediction';
  if (CLAIM_PATTERN.test(sentence)) return 'claim';
  if (BACKGROUND_PATTERN.test(sentence)) return 'background';
  if (FACT_PATTERN.test(sentence)) return 'fact';
  return 'unknown';
}

function requiresVerification(sentence: string): boolean {
  if (/\bproved to be a (?:font|source|foundation)\b/i.test(sentence)) return false;
  return /\b(solved|proven|proved|proof|breakthrough|first[- ]ever|first to|discovered|detected|discovery|cure|unprecedented|revolutionary|mathematical proof|scientific proof|launch(?:ed)?|announced)\b/i.test(sentence)
    || /\b\d{1,3}(?:,\d{3}){2,}\b/.test(sentence)
    || /[$€£]\s?\d+(?:\.\d+)?\s?(?:billion|million|trillion)?/i.test(sentence);
}

function extractCandidates(query: string, sources: ResearchSource[], recency: Recency = 'any'): Candidate[] {
  const candidates: Candidate[] = [];
  const recentQuery = /\b(latest|recent|today|this week|this month|developments?|updates?|news)\b/i.test(query);
  const academicQuery = /\b(research|paper|study|scientific|theorem|proof)\b/i.test(query);
  for (const source of sources) {
    if (source.fetchError || source.extractedText.trim().length < 80 || !sourceMatchesTimeWindow(query, source.publishedAt, recency)) continue;
    const sentences = splitSentences(source.extractedText);
    const sourceCandidates: Candidate[] = [];
    sentences.forEach((sentence, index) => {
      // Headings phrased as questions are useful page structure, not evidence.
      if (sentence.length < 40 || sentence.length > 400 || /\?\s*$/.test(sentence) || BOILERPLATE_SENTENCE_PATTERN.test(sentence)
        || /\bthis issue is built from (?:the )?links\b/i.test(sentence)) return;
      const context = [sentences[index - 1], sentences[index + 1]].filter(Boolean).join(' ');
      const relevance = scoreTargetRelevance(query, sentence, source.title, context);
      if (relevance < 0.40) return;
      const directAnswer = isVerificationQuery(query) && isDirectVerificationEvidence(query, `${sentence} ${context} ${source.title}`);
      const detectedType = classifyStatement(sentence);
      if (detectedType === 'unknown') return;
      // A direct positive or negative answer is a report about the problem's
      // status; the word "proved" alone should not turn a denial into a claim.
      const type = directAnswer && verificationPolarity(query, `${sentence} ${context} ${source.title}`) === 'negative'
        ? 'fact' : detectedType;
      const requestedYear = query.match(/\b20\d{2}\b/)?.[0];
      const sentenceYears = [...sentence.matchAll(/\b(?:18|19|20)\d{2}\b/g)].map((match) => match[0]);
      const historicalSideDetail = isVerificationQuery(query) && !directAnswer
        && ((requestedYear && sentenceYears.some((year) => year !== requestedYear))
          || /\bproved to be a (?:font|source|foundation)\b/i.test(sentence));
      if (historicalSideDetail) return;
      const historicalBackground = isVerificationQuery(query) && type === 'background' && !directAnswer;
      const figures = materialFigures(sentence);
      const values = figures.map((figure) => `${figure.metric}:${figure.normalizedValue}`).sort().join('|');
      const explicitStatusAnswer = directAnswer && /\b(remains? (?:unproven|unsolved|open)|no one has (?:yet )?(?:been able to )?(?:prove|disprove|solve)|has not been (?:proved|proven|solved)|no verified proof (?:has been )?(?:published|found))\b/i.test(sentence) ? 0.14 : 0;
      const priority = relevance + (directAnswer ? 0.42 : 0) + explicitStatusAnswer - (historicalBackground ? 0.32 : 0) + (recentQuery && source.publishedAt ? 0.04 : 0) + (academicQuery && source.sourceType === 'academic' ? 0.08 : 0) + (source.sourceType === 'primary' ? 0.03 : 0) + Math.min(0.04, source.extractedText.length / 20_000);
      sourceCandidates.push({ text: sentence, source, type, tokens: new Set(meaningfulTokens(sentence)), values, figures, relevance: priority, targetRelevance: priority, verificationRequired: requiresVerification(sentence) || figures.length > 0, context });
    });
    // Roundups contain several distinct stories; retaining more candidates lets
    // separate developments survive without treating them as corroboration.
    candidates.push(...sourceCandidates.sort((a, b) => b.relevance - a.relevance).slice(0, 10));
  }
  return candidates;
}

function similarity(left: Candidate, right: Candidate): number {
  const a = left.tokens; const b = right.tokens;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / Math.max(1, new Set([...a, ...b]).size);
}

function independentDomain(host: string): string {
  const labels = host.split('.');
  const publicSecondLevels = new Set(['co.uk', 'org.uk', 'gov.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'com.cn']);
  if (labels.length >= 3 && publicSecondLevels.has(labels.slice(-2).join('.'))) return labels.slice(-3).join('.');
  return labels.slice(-2).join('.');
}

function evidenceFor(candidate: Candidate): Evidence {
  const contextTokens = new Set(meaningfulTokens(candidate.context));
  const overlap = [...contextTokens].filter((token) => candidate.tokens.has(token)).length;
  const includeContext = overlap / Math.max(1, contextTokens.size) >= 0.35;
  const snippet = includeContext ? `${candidate.text} ${candidate.context}`.slice(0, 320) : candidate.text.slice(0, 320);
  return { sourceId: candidate.source.id, sentence: candidate.text, snippet, publishedAt: candidate.source.publishedAt };
}

function independentSourceCount(sources: ResearchSource[]): number {
  const independent: ResearchSource[] = [];
  for (const source of sources) {
    const domain = independentDomain(source.domain);
    if (independent.some((item) => independentDomain(item.domain) === domain)) continue;
    const copied = independent.some((item) => likelyCopiedArticle(source.extractedText, item.extractedText));
    if (!copied) independent.push(source);
  }
  return independent.length;
}

function likelyCopiedArticle(leftText: string, rightText: string): boolean {
  const leftWords = new Set(meaningfulTokens(leftText));
  const rightWords = new Set(meaningfulTokens(rightText));
  const sharedWords = [...leftWords].filter((word) => rightWords.has(word)).length;
  const wholePageSimilarity = sharedWords / Math.max(1, new Set([...leftWords, ...rightWords]).size);
  if (wholePageSimilarity >= 0.68) return true;

  const leftSentences = splitSentences(leftText);
  const rightSentences = splitSentences(rightText);
  const matchedRight = new Set<number>();
  let similarSentencePairs = 0;
  for (const leftSentence of leftSentences) {
    const left = new Set(meaningfulTokens(leftSentence));
    const matchIndex = rightSentences.findIndex((rightSentence, index) => {
      if (matchedRight.has(index)) return false;
      const right = new Set(meaningfulTokens(rightSentence));
      const overlap = [...left].filter((word) => right.has(word)).length;
      return overlap / Math.max(1, new Set([...left, ...right]).size) >= 0.60;
    });
    if (matchIndex >= 0) { matchedRight.add(matchIndex); similarSentencePairs += 1; }
  }
  return similarSentencePairs >= 2;
}

function makeFinding(group: Candidate[], status: FindingStatus, contradictingSourceIds: string[] = []): Finding {
  const supportingSources = [...new Map(group.map((item) => [item.source.id, item.source])).values()];
  const sourceIds = supportingSources.map((source) => source.id);
  const independentCount = independentSourceCount(supportingSources);
  const type = group[0].type;
  const selected = [...group].sort((left, right) => right.relevance - left.relevance || left.text.length - right.text.length)[0];
  const claim = type === 'claim' ? `Claim reported by source: ${selected.text}` : selected.text;
  const finalStatus = type === 'opinion' || type === 'prediction' || type === 'unknown' ? 'insufficient_evidence' : status;
  return {
    claim, type, verificationRequired: group.some((item) => item.verificationRequired),
    claimType: type, sourceIds, contradictingSourceIds,
    evidence: group.map(evidenceFor), publishedAt: selected.source.publishedAt,
    corroborationCount: independentCount, status: finalStatus, sourceCount: sourceIds.length,
    independentSourceCount: independentCount, corroborationStatus: finalStatus,
    relevanceScore: Math.max(...group.map((item) => item.relevance)),
    targetRelevance: Math.max(...group.map((item) => item.targetRelevance)),
    materialFigures: [...new Map(group.flatMap((item) => item.figures).map((figure) => [`${figure.metric}:${figure.normalizedValue}`, figure])).values()],
  };
}

function buildFindings(query: string, sources: ResearchSource[], recency: Recency = 'any'): { findings: Finding[]; disagreements: ResearchSummary['disagreements'] } {
  const candidates = extractCandidates(query, sources, recency);
  const groups: Candidate[][] = [];
  const assigned = new Set<Candidate>();
  for (const item of candidates) {
    if (assigned.has(item)) continue;
    const group = [item];
    assigned.add(item);
    for (const other of candidates) {
      if (assigned.has(other) || item.source.id === other.source.id || item.type !== other.type) continue;
      const sameVerificationAnswer = isVerificationQuery(query)
        && verificationPolarity(query, item.text) !== null
        && verificationPolarity(query, item.text) === verificationPolarity(query, other.text);
      if (similarity(item, other) >= 0.42 || sameVerificationAnswer) { group.push(other); assigned.add(other); }
    }
    groups.push(group);
  }

  const findings: Finding[] = [];
  const disagreements: ResearchSummary['disagreements'] = [];
  for (const group of groups) {
    const variants: Candidate[][] = [];
    for (const item of group) {
      const compatible = variants.find((variant) => {
        const representative = variant[0];
        return similarity(representative, item) >= 0.42 && !figuresConflict(representative, item);
      });
      if (compatible) compatible.push(item); else variants.push([item]);
    }
    const hasConflict = variants.length > 1 && variants.some((variant) => variant.some((item) => item.values));
    if (hasConflict) {
      for (const variant of variants) {
        const otherIds = [...new Set(variants.flatMap((other) => other).filter((item) => !variant.includes(item)).map((item) => item.source.id))];
        findings.push(makeFinding(variant, 'disputed', otherIds));
      }
      disagreements.push({ claims: variants.map((variant) => variant[0].text), sourceIds: [...new Set(variants.flatMap((variant) => variant.map((item) => item.source.id)))], reason: 'Sources report materially different dates or numeric details; this tool does not decide which account is correct.' });
      continue;
    }
      const independentCount = independentSourceCount([...new Map(group.map((item) => [item.source.id, item.source])).values()]);
      const status: FindingStatus = ['opinion', 'prediction', 'unknown'].includes(group[0].type)
        ? 'insufficient_evidence' : independentCount > 1 ? 'corroborated' : 'single_source';
      findings.push(makeFinding(group, status));
  }

  findings.sort((left, right) => right.targetRelevance - left.targetRelevance || Number(right.verificationRequired) - Number(left.verificationRequired) || right.independentSourceCount - left.independentSourceCount);
  return { findings: findings.slice(0, 10), disagreements };
}

type SearchProvider = (query: string, maxResults: number, recency: Recency) => Promise<SearchResult[]>;

interface SearchAdequacy {
  adequate: boolean;
  reasons: string[];
}

function isBroadCurrentEventsQuery(query: string): boolean {
  // A focused request for the latest models/papers is still a targeted
  // research question. Only treat explicit news/roundup/time-window wording
  // as broad coverage discovery.
  return /\b(news|headlines?|current events|what happened|what's happening|this week|this month|since yesterday|today|yesterday)\b/i.test(query);
}

function requestedWindowDays(query: string, recency: Recency = 'any'): number {
  if (recency === 'day') return 1;
  if (recency === 'week') return 7;
  if (recency === 'month') return 31;
  if (recency === 'year') return 366;
  if (recency === 'any') return Number.POSITIVE_INFINITY;
  // Keep query wording as a fallback for internal calls without a tool value.
  if (/\b(today)\b/i.test(query)) return 1;
  if (/\b(since yesterday|yesterday)\b/i.test(query)) return 2;
  if (/\bthis week\b/i.test(query)) return 7;
  if (/\bthis month\b/i.test(query)) return 31;
  if (/\bthis year\b/i.test(query)) return 366;
  return 30; // “latest” and “recent” mean recent, but do not specify an exact window.
}

/** Parse full dates and common month/day strings such as “Tue, 06 Oct”. */
export function publicationTimestamp(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const yearMatch = value.match(/\b(19|20)\d{2}\b/);
  if (yearMatch) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? timestamp : null;
  }
  const monthNames = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
  const monthDate = value.match(/\b(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+(\d{1,2})\b/i);
  const dayMonth = value.match(/\b(\d{1,2})\s+(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\b/i);
  const monthName = monthDate?.[1] ?? dayMonth?.[2];
  const day = Number(monthDate?.[2] ?? dayMonth?.[1]);
  if (monthName && day >= 1 && day <= 31) {
    const month = monthNames.findIndex((name) => monthName.toLowerCase().startsWith(name));
    if (month >= 0) {
      const current = new Date(now);
      let timestamp = Date.UTC(current.getUTCFullYear(), month, day);
      if (timestamp > now + 2 * 86_400_000) timestamp = Date.UTC(current.getUTCFullYear() - 1, month, day);
      return timestamp;
    }
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function sourceMatchesTimeWindow(_query: string, publishedAt: string | null, recency: Recency = 'any'): boolean {
  if (!publishedAt) return true;
  if (recency === 'any') return true;
  const timestamp = publicationTimestamp(publishedAt);
  // An unparsable date is unknown, so do not silently label it stale.
  return timestamp === null || (Date.now() - timestamp) / 86_400_000 <= requestedWindowDays(_query, recency);
}

function makeRecoveryQuery(query: string, variant = 0): string {
  if (isVerificationQuery(query)) {
    const words = meaningfulTokens(query).filter((word) => !FOLLOWUP_STOP_WORDS.has(word));
    const year = words.find((word) => /^20\d{2}$/.test(word));
    const topic = words.filter((word) => word !== year).join(' ') || query;
    return variant === 0
      ? `${topic} proof ${year ?? ''}`.trim()
      : `${topic} solved ${year ?? ''} mathematicians`.trim();
  }
  const topicTerms = meaningfulTokens(query).filter((word) => !FOLLOWUP_STOP_WORDS.has(word));
  const topic = topicTerms.slice(0, 3).join(' ') || 'current events';
  const broad = isBroadCurrentEventsQuery(query);
  if (broad) {
    const timeWindow = query.match(/\b(today|yesterday|this week|this month|this year|since yesterday)\b/i)?.[0] ?? 'recent';
    return variant === 0
      ? `${topic} latest launches research company updates ${timeWindow}`.trim()
      : `${topic} policy safety legal funding research reports ${timeWindow}`.trim();
  }
  return `${topic} additional relevant sources`.trim();
}

function checkSearchAdequacy(query: string, searchResults: SearchResult[], batchSources: ResearchSource[], recency: Recency = 'any'): SearchAdequacy {
  const reasons: string[] = [];
  const broad = isBroadCurrentEventsQuery(query);
  const verification = isVerificationQuery(query);
  const relevantSources = batchSources.filter((source) => source.queryRelevance >= 0.30 && sourceMatchesTimeWindow(query, source.publishedAt, recency));
  const usableSources = batchSources.filter((source) => !source.fetchError && source.extractedText.trim().length >= 80 && source.targetRelevance >= 0.15 && sourceMatchesTimeWindow(query, source.publishedAt, recency));
  const extractedFindings = buildFindings(query, batchSources, recency).findings;
  const directDomains = new Set(batchSources.filter((source) => !source.fetchError && source.extractedText.trim().length >= 80
    && sourceMatchesTimeWindow(query, source.publishedAt, recency)
    && source.extractedText.split(/\n+|(?<=[.!?])\s+/u).some((sentence) => isDirectVerificationEvidence(query, sentence)))
    .map((source) => independentDomain(source.domain)));

  if (broad && relevantSources.length < 2) reasons.push('fewer than two relevant results for a broad current-events query');
  if (!verification && searchResults.length > 0 && relevantSources.length < Math.ceil(searchResults.length / 2)) reasons.push('most search results appear irrelevant to the query');
  if (usableSources.length === 0) reasons.push('no usable fetched pages');
  if (extractedFindings.length === 0) reasons.push('no relevant findings could be extracted');
  if (verification && directDomains.size === 0) {
    reasons.push('no direct-answer evidence was found for the verification target');
  }
  if (verification && directDomains.size === 1) reasons.push('direct-answer evidence is available from only one source domain');
  if (broad && new Set(relevantSources.map((source) => independentDomain(source.domain))).size < 2) {
    reasons.push('insufficient source-domain diversity for a broad current-events query');
  }
  if (broad && extractedFindings.length < 3) reasons.push('fewer than three distinct developments were identified');
  if (broad) {
    const dated = batchSources.filter((source) => source.publishedAt).map((source) => publicationTimestamp(source.publishedAt)).filter((timestamp): timestamp is number => timestamp !== null);
    if (dated.length && !dated.some((timestamp) => (Date.now() - timestamp) / 86_400_000 <= requestedWindowDays(query, recency))) {
      reasons.push('available dated sources fall outside the requested recent time window');
    }
  }

  return { adequate: reasons.length === 0, reasons };
}

export interface RankedSearchCandidate {
  result: SearchResult & { duplicates: ReturnType<typeof duplicateInfo>[] };
  score: number;
  reasons: string[];
}

function likelyCopiedSnippet(left: string, right: string): boolean {
  const leftWords = new Set(meaningfulTokens(left));
  const rightWords = new Set(meaningfulTokens(right));
  if (leftWords.size < 8 || rightWords.size < 8) return false;
  const shared = [...leftWords].filter((word) => rightWords.has(word)).length;
  return shared / Math.max(1, new Set([...leftWords, ...rightWords]).size) >= 0.82;
}

export function rankSearchResults(query: string, results: SearchResult[], existingDomains: string[] = [], priorFailedDomains: string[] = [], recency: Recency = 'any'): RankedSearchCandidate[] {
  const recent = /\b(latest|recent|today|yesterday|this week|this month|this year|news|developments?|updates?)\b/i.test(query);
  const verification = isVerificationQuery(query);
  const seenDomains = new Set(existingDomains.map((domain) => independentDomain(domain)));
  const failedDomains = new Set(priorFailedDomains.map((domain) => independentDomain(domain)));
  const prepared = prepareSearchResults(results);
  const candidates = prepared.map((result) => {
    const relevance = scoreTargetRelevance(query, result.content, result.title);
    const reasons = [`query/title/snippet relevance ${relevance.toFixed(2)}`];
    let score = relevance * 0.62 + (result.score ?? 0.5) * 0.12;
    const copied = prepared.some((other) => other !== result
      && independentDomain(domainOf(other.url)) !== independentDomain(domainOf(result.url))
      && likelyCopiedSnippet(result.content, other.content));
    const sourceType = classifySource(result.url, query);
    if (failedDomains.has(independentDomain(domainOf(result.url)))) {
      score -= 0.06;
      reasons.push('another URL on this domain failed earlier in this request');
    }
    if (['primary', 'government', 'academic'].includes(sourceType)) {
      score += 0.07;
      reasons.push(`${sourceType} source indicator (small heuristic preference)`);
    }
    if (sourceType === 'news') score += 0.025;
    if (/youtube\.com|youtu\.be|instagram\.com|tiktok\.com|x\.com|twitter\.com|facebook\.com|reddit\.com/i.test(result.url)) {
      score -= 0.24;
      reasons.push('source may need browser rendering and return limited HTTP text');
    }
    if (verification && isDirectVerificationEvidence(query, `${result.title} ${result.content}`)) {
      score += 0.22;
      reasons.push('directly addresses the verification question');
    }
    const background = /\b(definition|what is|history|overview|introduction|explained|encyclopedia)\b/i.test(result.title);
    if (background && (recent || verification)) {
      score -= 0.15;
      reasons.push('likely background page; less direct for this query');
    }
    if (recent && result.publishedDate) {
      const timestamp = publicationTimestamp(result.publishedDate);
      const ageDays = timestamp === null ? Number.NaN : Math.max(0, (Date.now() - timestamp) / 86_400_000);
      if (Number.isFinite(ageDays)) {
        const outsideRequestedWindow = isBroadCurrentEventsQuery(query) && ageDays > requestedWindowDays(query, recency);
        const freshness = outsideRequestedWindow ? -0.45 : ageDays <= 7 ? 0.12 : 0;
        score += freshness;
        reasons.push(outsideRequestedWindow ? 'publication falls outside the requested time window' : freshness > 0 ? 'recent publication date' : 'publication date recorded');
      }
    }
    const requestedYear = query.match(/\b20\d{2}\b/)?.[0];
    if (requestedYear && result.publishedDate) {
      const matchingYear = result.publishedDate.startsWith(requestedYear);
      score += matchingYear ? 0.10 : -0.08;
      reasons.push(matchingYear ? `publication matches requested year ${requestedYear}` : `publication does not match requested year ${requestedYear}`);
    }
    if (result.duplicates.length > 0) {
      score -= 0.08;
      reasons.push('duplicate or syndicated result grouped with this URL');
    }
    if (copied) {
      score -= 0.12;
      reasons.push('snippet closely resembles reporting from another domain');
    }
    return { result, score, reasons, copied };
  });

  // Greedy domain diversity only breaks close scores; direct relevance remains
  // the dominant part of the ranking.
  const ranked: RankedSearchCandidate[] = [];
  while (candidates.length) {
    candidates.sort((left, right) => {
      const leftBonus = seenDomains.has(independentDomain(domainOf(left.result.url))) || left.copied ? 0 : 0.035;
      const rightBonus = seenDomains.has(independentDomain(domainOf(right.result.url))) || right.copied ? 0 : 0.035;
      return (right.score + rightBonus) - (left.score + leftBonus);
    });
    const next = candidates.shift()!;
    const domain = independentDomain(domainOf(next.result.url));
    const diversityBonus = seenDomains.has(domain) || next.copied ? 0 : 0.035;
    seenDomains.add(domain);
    ranked.push({
      ...next,
      score: next.score + diversityBonus,
      reasons: diversityBonus ? [...next.reasons, 'adds a distinct source domain'] : next.reasons,
    });
  }
  return ranked;
}

interface CandidateDiagnostic { title: string; url: string; score: number; reasons: string[]; decision: string; sourceId?: string }
interface FetchSelectionState {
  attempts: number;
  attemptedUrls: Set<string>;
  candidates: CandidateDiagnostic[];
  replacementsUsed: boolean;
  replacementCandidatesAttempted: number;
}

function findDuplicateSource(result: SearchResult, sources: ResearchSource[]): ResearchSource | undefined {
  const normalized = normalizeUrl(result.url);
  const title = normalizedTitle(result.title);
  return sources.find((source) => {
    if (normalized && [source.url, source.canonicalUrl ?? ''].some((url) => normalizeUrl(url) === normalized)) return true;
    if (domainOf(result.url) === source.domain && title === normalizedTitle(source.title)) return true;
    return title.length > 50 && title === normalizedTitle(source.title);
  });
}

async function addSearchResults(
  results: SearchResult[],
  query: string,
  recency: Recency,
  existingSources: ResearchSource[],
  selection: FetchSelectionState,
  browserRenderer: BrowserRenderer,
): Promise<number> {
  const ranked = rankSearchResults(query, results, existingSources.map((source) => source.domain), existingSources.filter((source) => source.fetchError || source.requiresBrowserRendering).map((source) => source.domain), recency);
  let added = 0;
  let usableAdded = 0;
  for (let index = 0; index < ranked.length; index += 1) {
    const candidate = ranked[index];
    const result = candidate.result;
    const diagnostic: CandidateDiagnostic = { title: result.title, url: result.url, score: candidate.score, reasons: candidate.reasons, decision: 'ranked' };
    selection.candidates.push(diagnostic);
    if (usableAdded >= MAX_INITIAL_FETCH_CANDIDATES) {
      diagnostic.decision = 'skipped; four usable pages already selected for this search';
      continue;
    }
    const duplicate = findDuplicateSource(result, existingSources);
    if (duplicate) {
      duplicate.duplicateResults.push(duplicateInfo(result), ...result.duplicates);
      diagnostic.sourceId = duplicate.id;
      diagnostic.decision = 'duplicate; existing fetched page reused';
      continue;
    }
    const normalized = normalizeUrl(result.url);
    const initial = index < MAX_INITIAL_FETCH_CANDIDATES;
    diagnostic.decision = initial ? 'selected among initial candidates' : 'replacement candidate';
    if (!normalized || selection.attemptedUrls.has(normalized)) {
      diagnostic.decision = 'skipped; URL already attempted or invalid';
      continue;
    }
    if (candidate.score < 0.16) {
      diagnostic.decision = 'skipped; relevance is too low to justify a fetch attempt';
      continue;
    }
    if (!sourceMatchesTimeWindow(query, result.publishedDate, recency)) {
      diagnostic.decision = 'skipped; search-result publication date is outside the requested time window';
      continue;
    }
    if (selection.attempts >= MAX_UNIQUE_FETCH_ATTEMPTS) {
      diagnostic.decision = 'not fetched; six-attempt request limit reached';
      continue;
    }
    selection.attempts += 1;
    if (!initial) {
      selection.replacementsUsed = true;
      selection.replacementCandidatesAttempted += 1;
    }
    selection.attemptedUrls.add(normalized);
    const source = await fetchSource(result, `S${existingSources.length + 1}`, query, browserRenderer);
    source.selectionScore = candidate.score;
    source.selectionReasons = candidate.reasons;
    source.selectionOutcome = initial ? 'selected' : 'replacement';
    diagnostic.sourceId = source.id;
    existingSources.push(source);
    added += 1;
    if (!source.fetchError && source.extractedText.trim().length >= 80 && source.targetRelevance >= 0.15 && sourceMatchesTimeWindow(query, source.publishedAt, recency)) {
      usableAdded += 1;
      diagnostic.decision = initial ? 'selected and usable' : 'replacement selected and usable';
    } else {
      source.selectionOutcome = initial ? 'selected' : 'replacement';
      diagnostic.decision = source.fetchError
        ? `fetch failed: ${source.fetchError}`
        : !sourceMatchesTimeWindow(query, source.publishedAt, recency) ? 'fetched but excluded; page publication date is outside the requested time window'
        : source.requiresBrowserRendering ? 'thin JavaScript shell; browser rendering required' : 'thin or low-relevance extracted page; replacement considered';
    }
    // Fetch four usable candidates per search where available. Failed/thin
    // pages consume attempts and let the next ranked URL replace them.
  }
  return added;
}

const FOLLOWUP_STOP_WORDS = new Set([
  'did', 'does', 'do', 'anyone', 'someone', 'whether', 'verify', 'verified', 'verification', 'reported', 'report', 'but', 'post',
  'true', 'truth', 'solved', 'solve', 'solving', 'prove', 'proven', 'proof', 'confirmed',
  'confirm', 'claim', 'claimed', 'reports', 'reported', 'source', 'sources', 'article',
  'online', 'viral', 'says', 'said', 'that', 'what', 'latest', 'recent', 'developments',
  'development', 'happened', 'happening', 'this', 'week', 'month', 'year', 'today', 'yesterday',
  'news', 'headline', 'headlines', 'current', 'events', 'changed', 'changes',
]);

function isVerificationQuery(query: string): boolean {
  return /\b(is it true|did anyone|has anyone|was .* proven|has .* been proven|solved|disproved|disproven|proof|prove|verified|verify|confirmed|confirm|found a solution)\b/i.test(query);
}

function followupReason(finding: Finding, verificationQuestion: boolean): string | null {
  if (finding.type === 'opinion' || finding.type === 'prediction' || finding.type === 'unknown') return null;
  if (finding.type === 'background' && !finding.verificationRequired && !verificationQuestion && finding.corroborationStatus !== 'disputed') return null;
  if (finding.corroborationStatus === 'disputed') return 'sources materially disagree';
  if (verificationQuestion) {
    const direct = finding.evidence.some((item) => isDirectVerificationEvidence(finding.claim, item.sentence));
    if (direct && (finding.verificationRequired || finding.corroborationStatus !== 'corroborated')) return 'direct answer needs independent verification';
    return null;
  }
  if (finding.verificationRequired) return 'a significant claim requires stronger verification';
  if (finding.corroborationStatus === 'single_source') return 'a relevant finding has only one source';
  if (finding.corroborationStatus === 'insufficient_evidence' && finding.type === 'claim') return 'a claim has insufficient evidence';
  return null;
}

function followupTerms(query: string, finding: Finding): string[] {
  const words = [...meaningfulTokens(finding.claim), ...meaningfulTokens(query)];
  return [...new Set(words.filter((word) => !FOLLOWUP_STOP_WORDS.has(word)))].slice(0, 5);
}

function generateFollowupQueries(query: string, findings: Finding[], reasons: string[]): Array<{ query: string; reason: string; finding: Finding }> {
  const verificationQuestion = isVerificationQuery(query);
  const candidates = findings
    .map((finding) => ({ finding, reason: followupReason(finding, verificationQuestion) }))
    .filter((item): item is { finding: Finding; reason: string } => item.reason !== null)
    .sort((left, right) => Number(right.finding.verificationRequired) - Number(left.finding.verificationRequired)
      || right.finding.targetRelevance - left.finding.targetRelevance);
  const selected = candidates.slice(0, MAX_FOLLOWUP_CLAIMS);
  reasons.push(...selected.map(({ finding, reason }) => `${reason}: ${finding.claim.slice(0, 120)}`));

  if (verificationQuestion && selected.length > 0) {
    const words = meaningfulTokens(query).filter((word) => !FOLLOWUP_STOP_WORDS.has(word));
    const year = words.find((word) => /^20\d{2}$/.test(word));
    const topic = words.filter((word) => word !== year).join(' ');
    const queries = [
      `${topic} proof ${year ?? ''}`.trim(),
      `${topic} solved ${year ?? ''} mathematicians`.trim(),
    ];
    return queries.map((searchQuery, index) => ({
      query: searchQuery,
      reason: selected[Math.min(index, selected.length - 1)].reason,
      finding: selected[Math.min(index, selected.length - 1)].finding,
    })).slice(0, MAX_FOLLOWUP_SEARCHES);
  }

  const searches: Array<{ query: string; reason: string; finding: Finding }> = [];
  const makeSearch = (finding: Finding, variant: number): string => {
    const terms = followupTerms(query, finding);
    const topic = terms.join(' ');
    const claimText = finding.claim.toLowerCase();
    let suffixes: [string, string];
    if (/\b(theorem|hypothesis|mathemat|proof|scientific|study|research|discovered|breakthrough)\b/.test(`${query} ${claimText}`)) {
      suffixes = ['proof independent verification', 'independent researchers mathematicians verification'];
    } else if (/\b(product|launch|company|announced|released|model)\b/.test(claimText)) {
      suffixes = ['official announcement primary source', 'independent reporting verification'];
    } else if (/\b(financial|revenue|profit|billion|million|usd|dollar)\b/.test(claimText)) {
      suffixes = ['official filing financial figures', 'independent financial verification'];
    } else {
      suffixes = ['independent verification primary sources', 'official sources independent reporting'];
    }
    return `${topic} ${suffixes[variant]}`.trim().slice(0, 160);
  };

  if (selected.length === 1) {
    for (let variant = 0; variant < 2; variant += 1) {
      searches.push({ query: makeSearch(selected[0].finding, variant), reason: selected[0].reason, finding: selected[0].finding });
    }
  } else {
    selected.forEach((item, index) => searches.push({ query: makeSearch(item.finding, index), reason: item.reason, finding: item.finding }));
  }
  const initialKey = normalizedTitle(query);
  return searches.filter((item, index, all) => normalizedTitle(item.query) !== initialKey
    && all.findIndex((other) => normalizedTitle(other.query) === normalizedTitle(item.query)) === index)
    .slice(0, MAX_FOLLOWUP_SEARCHES);
}

function sortedSources(query: string, sources: ResearchSource[]): ResearchSource[] {
  const recentQuery = /\b(latest|recent|today|this week|this month|developments?|updates?|news)\b/i.test(query);
  const academicQuery = /\b(research|paper|study|scientific|theorem|proof)\b/i.test(query);
  const pagePriority = (source: ResearchSource): number => {
    const published = source.publishedAt ? Date.parse(source.publishedAt) : Number.NaN;
    const ageDays = Number.isFinite(published) ? Math.max(0, (Date.now() - published) / 86_400_000) : null;
    const datePreference = recentQuery && ageDays !== null ? Math.max(-0.15, 0.15 - ageDays / 120) : 0;
    return source.targetRelevance * 0.7 + source.queryRelevance * 0.3 + (source.fetchError ? -0.2 : 0.1)
      + Math.min(0.08, source.extractedText.length / 20_000) + datePreference
      + (academicQuery && source.sourceType === 'academic' ? 0.08 : 0)
      + (source.sourceType === 'primary' ? 0.03 : 0)
      + (source.relevanceScore ?? 0) * 0.05;
  };
  return [...sources].sort((left, right) => pagePriority(right) - pagePriority(left));
}

export async function researchWebWithSearchProvider(
  options: ResearchOptions,
  searchProvider: SearchProvider,
  browserRenderer: BrowserRenderer = renderPageWithPlaywright,
): Promise<ResearchResult> {
  // This controller has exactly one optional follow-up pass. Follow-up results
  // are never passed back into followup selection, so researchDepth cannot exceed 1.
  const initialResults = await searchProvider(options.query, options.max_results, options.recency);
  const allSources: ResearchSource[] = [];
  const selection: FetchSelectionState = { attempts: 0, attemptedUrls: new Set(), candidates: [], replacementsUsed: false, replacementCandidatesAttempted: 0 };
  await addSearchResults(initialResults.slice(0, options.max_results), options.query, options.recency, allSources, selection, browserRenderer);
  const initialFindings = buildFindings(options.query, allSources, options.recency).findings;

  const followupReasons: string[] = [];
  const broadDiscovery = isBroadCurrentEventsQuery(options.query) && !isVerificationQuery(options.query);
  const plannedClaimFollowups = broadDiscovery ? [] : generateFollowupQueries(options.query, initialFindings, followupReasons);
  const limitations: string[] = [];
  const initialIndependentCounts = new Map(initialFindings.map((finding) => [finding.sourceIds.join('|'), finding.independentSourceCount]));
  let searchCount = 1;
  let discoveredCount = initialResults.length;
  const initialAdequacy = checkSearchAdequacy(options.query, initialResults, allSources, options.recency);
  const allSearchResults = [...initialResults];
  let recoveryUsed = false;
  const followups: Array<{ query: string; reason: string; finding?: Finding; isRecovery?: boolean }> = [];
  if (!initialAdequacy.adequate && searchCount < 3) {
    const recoveryQuery = makeRecoveryQuery(options.query);
    followups.push({ query: recoveryQuery, reason: initialAdequacy.reasons.join('; '), isRecovery: true });
    followupReasons.unshift(`search adequacy recovery: ${initialAdequacy.reasons.join('; ')}`);
    recoveryUsed = true;
  }
  followups.push(...plannedClaimFollowups.map((item) => ({ ...item })));
  // An adequacy-recovery query can be identical to a planned claim check.
  // Execute that query once and preserve the next distinct search variation.
  const seenFollowupQueries = new Set<string>();
  for (let index = followups.length - 1; index >= 0; index -= 1) {
    const key = normalizedTitle(followups[index].query);
    if (seenFollowupQueries.has(key)) followups.splice(index, 1);
    else seenFollowupQueries.add(key);
  }
  let nextRecoveryVariant = 1;

  // Deliberately sequential and capped: never more than two follow-up searches.
  for (let index = 0; index < followups.length && searchCount < 1 + MAX_FOLLOWUP_SEARCHES; index += 1) {
    const followup = followups[index];
    searchCount += 1;
    let results: SearchResult[];
    try {
      results = await searchProvider(followup.query, options.max_results, options.recency);
    } catch {
      limitations.push('A follow-up search failed; the initial research results are retained.');
      if ((!recoveryUsed || broadDiscovery) && searchCount < 1 + MAX_FOLLOWUP_SEARCHES) {
        const reason = 'a follow-up search failed before returning results';
        const recoveryQuery = makeRecoveryQuery(options.query, nextRecoveryVariant++);
        if (!followups.slice(index + 1).some((item) => normalizedTitle(item.query) === normalizedTitle(recoveryQuery))) {
          followups.splice(index + 1, 0, { query: recoveryQuery, reason, isRecovery: true });
        }
        followupReasons.push(`search adequacy recovery: ${reason}`);
        recoveryUsed = true;
      }
      continue;
    }
    discoveredCount += results.length;
    allSearchResults.push(...results);
    const sourceCountBefore = allSources.length;
    const added = await addSearchResults(results.slice(0, options.max_results), options.query, options.recency, allSources, selection, browserRenderer);
    if (results.length === 0 || added === 0) {
      limitations.push('Follow-up search did not find new independent sources; this absence is not evidence that a claim is false.');
    }
    const batchSources = allSources.slice(sourceCountBefore);
    const adequacy = checkSearchAdequacy(options.query, results, batchSources, options.recency);
    if (!adequacy.adequate && (!recoveryUsed || broadDiscovery) && searchCount < 1 + MAX_FOLLOWUP_SEARCHES) {
      const recoveryQuery = makeRecoveryQuery(options.query, nextRecoveryVariant++);
      if (!followups.slice(index + 1).some((item) => normalizedTitle(item.query) === normalizedTitle(recoveryQuery))) {
        followups.splice(index + 1, 0, {
          query: recoveryQuery,
          reason: adequacy.reasons.join('; '),
          isRecovery: true,
        });
      }
      followupReasons.push(`search adequacy recovery: ${adequacy.reasons.join('; ')}`);
      recoveryUsed = true;
    }
  }

  const finalSources = sortedSources(options.query, allSources);
  const { findings, disagreements } = buildFindings(options.query, finalSources, options.recency);
  const finalAdequacy = checkSearchAdequacy(options.query, allSearchResults, finalSources, options.recency);
  const adequacyReasons = finalAdequacy.reasons;
  for (const followup of followups.filter((item) => item.finding)) {
    const originalFinding = followup.finding!;
    const finalFinding = findings.find((finding) => finding.sourceIds.some((id) => originalFinding.sourceIds.includes(id)));
    const previousCount = initialIndependentCounts.get(originalFinding.sourceIds.join('|')) ?? originalFinding.independentSourceCount;
    if (!finalFinding || finalFinding.independentSourceCount <= previousCount) {
      limitations.push(`Follow-up search did not find independent confirmation for: ${originalFinding.claim.slice(0, 120)}.`);
    }
  }

  const failedPages = finalSources.filter((source) => source.fetchError);
  const usablePages = finalSources.filter((source) => !source.fetchError && source.extractedText.trim().length >= 80 && source.targetRelevance >= 0.15 && sourceMatchesTimeWindow(options.query, source.publishedAt, options.recency));
  const distinctDomains = new Set(usablePages.map((source) => independentDomain(source.domain))).size;
  const independentCorroboratingSources = independentSourceCount(usablePages);
  const broadNews = isBroadCurrentEventsQuery(options.query) && !isVerificationQuery(options.query);
  const recentDevelopments = findings.filter((finding) => {
    const published = publicationTimestamp(finding.publishedAt);
    return published !== null && (Date.now() - published) / 86_400_000 <= requestedWindowDays(options.query, options.recency);
  }).length;
  limitations.unshift(
    'Source-type labels use simple domain and URL-pattern heuristics. They are descriptive and are not an authoritative classification or quality ranking.',
    'Relevance, statement type, follow-up selection, and claim grouping use deterministic heuristics; they do not establish truth.',
    'Independent-source counts estimate domain and copied-page differences; duplicated reporting may still be counted as independent.',
    'Only fetched pages with at least 80 characters of relevant extracted text are considered usable evidence.',
  );
  for (const source of failedPages) limitations.push(`${source.id} (${source.domain}) was not used as evidence: ${source.requiresBrowserRendering ? 'the page requires browser rendering.' : source.fetchError}`);
  for (const source of finalSources.filter((item) => item.browserRenderingAttempted && !item.extractedText.trim())) limitations.push(`${source.id} (${source.domain}) remained unreadable after browser rendering${source.browserRenderingError ? `: ${source.browserRenderingError}` : '.'}`);
  for (const source of finalSources.filter((item) => item.requiresBrowserRendering && !item.browserRenderingAttempted)) limitations.push(`${source.id} (${source.domain}) returned a JavaScript-rendered shell; browser rendering was not attempted.`);
  for (const source of finalSources.filter((item) => !item.fetchError && (item.extractedText.trim().length < 80 || item.targetRelevance < 0.15))) limitations.push(`${source.id} (${source.domain}) returned too little relevant readable text to support findings.`);
  for (const source of finalSources.filter((item) => !sourceMatchesTimeWindow(options.query, item.publishedAt, options.recency))) limitations.push(`${source.id} (${source.domain}) was excluded from current findings because its publication date is outside the requested time window.`);
  for (const source of finalSources.filter((item) => item.truncated)) limitations.push(`${source.id} (${source.domain}) extracted text was truncated at ${MAX_EXTRACTED_TEXT_CHARS} characters.`);
  if (findings.length === 0) limitations.push('No relevant factual claims could be extracted from the fetched pages.');
  if (usablePages.length < 2) limitations.push('Research coverage is limited because fewer than two pages yielded usable extracted text.');

  const retrievedAt = new Date().toISOString();
  const summarySources = finalSources.map(({ id, title, url, domain, sourceType, publishedAt, relevanceScore, queryRelevance, targetRelevance, selectionScore, selectionReasons, selectionOutcome, truncated, requiresBrowserRendering, browserRenderingAttempted, browserRenderingError, retrievedAt: sourceRetrievedAt, fetchError }) => ({ id, title, url, domain, sourceType, publishedAt, relevanceScore, queryRelevance, targetRelevance, selectionScore, selectionReasons, selectionOutcome, truncated, requiresBrowserRendering, browserRenderingAttempted, ...(browserRenderingError ? { browserRenderingError } : {}), retrievedAt: sourceRetrievedAt, ...(fetchError ? { fetchError } : {}) }));
  const trace: ResearchTrace = {
    initialSearches: 1,
    followupSearches: searchCount - 1,
    sourcesDiscovered: discoveredCount,
    sourcesUsed: usablePages.length,
    claimsExtracted: findings.length,
    followupReasons,
  };
  const research: ResearchSummary = {
    query: options.query,
    retrievedAt,
    researchMode: 'bounded_agentic',
    searchCount,
    followupSearchCount: searchCount - 1,
    researchDepth: searchCount > 1 ? 1 : 0,
    trace,
    researchTarget: researchTargetFor(options.query),
    sourceSelection: {
      totalResultsDiscovered: discoveredCount,
      candidatesRanked: selection.candidates.length,
      fetchAttempts: selection.attempts,
      pagesSuccessfullyFetched: finalSources.filter((source) => !source.fetchError).length,
      usablePages: usablePages.length,
      failedPages: failedPages.length,
      truncatedPages: finalSources.filter((source) => source.truncated).length,
      replacementsUsed: selection.replacementsUsed,
      replacementCandidatesAttempted: selection.replacementCandidatesAttempted,
      adequatelyAnswersTarget: isVerificationQuery(options.query)
        ? new Set(finalSources.filter((source) => !source.fetchError
          && source.extractedText.trim().length >= 80
          && sourceMatchesTimeWindow(options.query, source.publishedAt, options.recency)
          && source.extractedText.split(/\n+|(?<=[.!?])\s+/u).some((sentence) => isDirectVerificationEvidence(options.query, sentence)))
          .map((source) => independentDomain(source.domain))).size >= 2
        : finalAdequacy.adequate && findings.some((finding) => finding.targetRelevance >= 0.60),
      candidates: selection.candidates,
    },
    coverage: { searchResults: discoveredCount, uniqueSources: finalSources.length, fetchedPages: selection.attempts, usablePages: usablePages.length, failedPages: failedPages.length, distinctDomains, distinctDevelopments: findings.length, recentDevelopments: broadNews ? recentDevelopments : findings.length, independentCorroboratingSources, unresolvedMaterialConflicts: disagreements.length, adequate: finalAdequacy.adequate, adequacyReasons },
    findings,
    sources: summarySources,
    corroboration: findings.map(({ claim, sourceIds, corroborationCount, status }) => ({ claim, sourceIds, corroborationCount, status })),
    disagreements,
    limitations: [...new Set(limitations)],
  };

  return { query: options.query, recency: options.recency, sources: finalSources, research };
}

export async function researchWeb(options: ResearchOptions): Promise<ResearchResult> {
  return researchWebWithSearchProvider(options, searchWeb);
}
