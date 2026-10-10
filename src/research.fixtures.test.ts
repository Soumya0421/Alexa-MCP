import assert from 'node:assert/strict';
import test from 'node:test';
import { rankSearchResults, researchWebWithSearchProvider, type ResearchOptions, type SearchResult } from './research.js';
import { formatResearchResponse } from './response.js';

type FixtureProvider = Parameters<typeof researchWebWithSearchProvider>[1];

function result(title: string, url: string, publishedDate = new Date().toISOString().slice(0, 10)): SearchResult {
  return { title, url, content: title, score: 0.9, publishedDate };
}

async function withPages<T>(pages: Record<string, string>, callback: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const content = pages[`${url.hostname}${url.pathname}`];
    if (!content) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } });
    const html = content.trimStart().startsWith('<html')
      ? content
      : `<html><head><title>${url.hostname} research</title></head><body><main>${content
        .split('\n').map((paragraph) => `<p>${paragraph}</p>`).join('')}</main></body></html>`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as typeof fetch;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

const verifyQuery: ResearchOptions = {
  query: 'Did anyone solve the Riemann Hypothesis in 2026?',
  max_results: 5,
  recency: 'year',
};

test('major single-source claim triggers two bounded searches, merges sources, and recalculates support', async () => {
  const calls: string[] = [];
  const provider: FixtureProvider = async (query, maxResults, recency) => {
    calls.push(query);
    assert.equal(maxResults, 5);
    assert.equal(recency, 'year');
    if (calls.length === 1) return [result('Claude Riemann Hypothesis report', 'https://initial.example/claim')];
    if (calls.length === 2) return [
      result('Independent Riemann proof review', 'https://research.example/review'),
      result('Duplicate initial result', 'https://initial.example/claim?utm_source=followup'),
    ];
    return [];
  };

  const output = await withPages({
    'initial.example/claim': 'Claude solved the Riemann Hypothesis in 2026, according to a report, but no proof is attached.\nThe article discusses the mathematical claim and its potential implications for number theory.',
    'research.example/review': 'Claude solved the Riemann Hypothesis in 2026, according to an independent report that includes a proof and calculations.\nThe analysis describes a new approach to prime numbers and the zeta function.',
  }, () => researchWebWithSearchProvider(verifyQuery, provider));

  const claim = output.research.findings.find((finding) => finding.type === 'claim');
  assert.ok(claim, 'the major claim should remain labeled as a claim');
  assert.equal(claim.verificationRequired, true);
  assert.equal(claim.corroborationStatus, 'corroborated', JSON.stringify({ claim, sources: output.research.sources }));
  assert.equal(claim.sourceCount, 2);
  assert.equal(claim.independentSourceCount, 2);
  assert.equal(output.sources.length, 2, 'the follow-up URL alias should not create a third source');
  assert.equal(calls.length, 3, 'one initial plus two follow-up searches');
  assert.equal(output.research.searchCount, 3);
  assert.equal(output.research.followupSearchCount, 2);
  assert.equal(output.research.researchDepth, 1);
  assert.equal(calls[1].toLowerCase(), 'riemann hypothesis proof 2026');
  assert.notEqual(calls[1], verifyQuery.query);
  assert.notEqual(calls[2], calls[1]);
  assert.ok(output.research.trace.followupReasons.length > 0);
  assert.ok(output.research.trace.sourcesDiscovered >= output.sources.length);
  assert.equal(output.research.trace.sourcesUsed, 2);
  assert.ok(claim.evidence.every((item) => output.sources.find((source) => source.id === item.sourceId)?.extractedText.includes(item.sentence)));
});

test('Riemann verification recognizes readable direct answers and ignores idiomatic and inaccessible proof mentions', async () => {
  const searches: string[] = [];
  const provider: FixtureProvider = async (query) => {
    searches.push(query);
    return [
      result("Claude's progress on the Riemann hypothesis", 'https://www.anthropic.com/research/riemann-zeta', '2026-08-10'),
      result('Did Claude prove the Riemann Hypothesis?', 'https://mindstudio.example/claude-riemann', '2026-08-13'),
      result('Why no one is trying to solve math’s greatest mystery', 'https://www.scientificamerican.com/article/riemann', '2026-06-01'),
      result('A Direct Proof of the Riemann Hypothesis - 2026', 'https://www.youtube.com/watch?v=example', '2026-09-14'),
    ];
  };
  const output = await withPages({
    'www.anthropic.com/research/riemann-zeta': 'Claude did take a real stab at the Riemann Hypothesis, but it did not succeed. An unreleased research model improved a related lower bound from 41.6% to 67.2%. Even though it could not resolve the Riemann Hypothesis itself, this was progress on a related problem. No one has yet been able to prove or disprove the Riemann Hypothesis.',
    'mindstudio.example/claude-riemann': 'The Riemann Hypothesis remains unproven. Claude did not prove the Riemann Hypothesis, but improved a specific related numerical bound from 41.6 to 67.2. This does not amount to a proof of the conjecture.',
    'www.scientificamerican.com/article/riemann': 'The Riemann hypothesis has proved to be a font of surprising connections in mathematics. In 2000, a bounty was offered to anyone who solved the Riemann hypothesis. Mathematicians continue to study this historical conjecture.',
    // YouTube intentionally returns a thin HTML shell and must not contribute evidence.
  }, () => researchWebWithSearchProvider(verifyQuery, provider));

  const direct = output.research.findings.find((finding) => /no one has yet|remains unproven|did not prove|could not resolve|did not succeed/i.test(finding.claim));
  assert.ok(direct, JSON.stringify(output.research.findings.map((finding) => finding.claim)));
  assert.ok(direct.targetRelevance >= 0.6);
  assert.equal(direct.independentSourceCount, 2, JSON.stringify(output.research.findings.map(({ claim, sourceIds, type, targetRelevance }) => ({ claim, sourceIds, type, targetRelevance }))));
  assert.ok(output.research.sourceSelection.adequatelyAnswersTarget, JSON.stringify(output.research.sourceSelection));
  assert.ok(output.research.coverage.adequate, JSON.stringify(output.research.coverage));
  assert.ok(searches.length <= 3, 'verification follow-ups remain within the existing three-search cap');
  assert.ok(!output.research.findings.some((finding) => /font of surprising connections|bounty was offered/i.test(finding.claim)));
  assert.ok(!output.research.findings.some((finding) => finding.claim.includes('Direct Proof of the Riemann')));
  assert.match(formatResearchResponse(output), /Across 2 independent sources|remains unproven|did not prove/i);
  assert.match(formatResearchResponse(output), /inaccessible and excluded as evidence/i);
});

test('an ordinary background question does not automatically trigger follow-up', async () => {
  let searches = 0;
  const provider: FixtureProvider = async () => {
    searches += 1;
    return [result('What the Riemann Hypothesis means', 'https://math.example/overview')];
  };
  const output = await withPages({
    'math.example/overview': 'The Riemann Hypothesis is a conjecture that all nontrivial zeros of the zeta function have real part one half.\nIt was proposed by Bernhard Riemann in 1859.',
  }, () => researchWebWithSearchProvider({ query: 'What is the Riemann Hypothesis?', max_results: 5, recency: 'year' }, provider));

  assert.equal(searches, 1);
  assert.equal(output.research.researchDepth, 0);
  assert.equal(output.research.searchCount, 1);
  assert.equal(output.research.followupSearchCount, 0);
});

test('disagreements remain visible and the controller never searches recursively', async () => {
  let searches = 0;
  const provider: FixtureProvider = async (query) => {
    searches += 1;
    if (searches === 1) return [
      result('Company X launched Product Y on October 2', 'https://news-one.example/story'),
      result('Company X launch date reported as October 3', 'https://news-two.example/story'),
    ];
    // Even if a follow-up might itself reveal another weak claim, this provider
    // receives no recursive calls after the two planned follow-up searches.
    assert.notEqual(query, 'Company X Product Y launch');
    return [];
  };
  const output = await withPages({
    'news-one.example/story': 'Company X launched Product Y on October 2, 2026, according to a statement issued by the company.\nThe release describes its main features and availability.',
    'news-two.example/story': 'Company X launched Product Y on October 3, 2026, according to an announcement published by the company.\nThe report describes its features and planned availability.',
  }, () => researchWebWithSearchProvider({ query: 'Company X Product Y launch', max_results: 5, recency: 'week' }, provider));

  assert.equal(searches, 3);
  assert.equal(output.research.searchCount, 3);
  assert.equal(output.research.researchDepth, 1);
  assert.ok(output.research.disagreements.length > 0);
  assert.ok(output.research.findings.some((finding) => finding.corroborationStatus === 'disputed'));
  assert.ok(output.research.limitations.some((item) => item.includes('Follow-up search did not find new independent sources')));
});

test('an irrelevant failed result triggers a recovery search', async () => {
  const calls: string[] = [];
  const provider: FixtureProvider = async (query) => {
    calls.push(query);
    if (calls.length === 1) return [result('MarketBeat Week in Review', 'https://marketbeat.example/review')];
    return [];
  };
  const output = await withPages({}, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));

  assert.equal(calls.length, 3, 'narrow broad-news results trigger both bounded discovery searches');
  assert.match(calls[1], /ai latest launches research company updates this week/i);
  assert.match(calls[2], /ai policy safety legal funding research reports this week/i);
  assert.ok(output.research.trace.followupReasons.some((reason) => reason.includes('search adequacy recovery')));
  assert.equal(output.research.coverage.usablePages, 0);
});

test('zero usable page text triggers recovery even when Tavily returns a result', async () => {
  let searches = 0;
  const provider: FixtureProvider = async (query) => {
    searches += 1;
    return searches === 1
      ? [result('AI research this week', 'https://blocked.example/ai')]
      : [];
  };
  const output = await withPages({ 'blocked.example/ai': 'Short page.' }, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));

  assert.equal(searches, 3);
  assert.ok(output.research.trace.followupReasons[0].includes('no usable fetched pages'));
});

test('one result for a broad news query is inadequate and causes recovery', async () => {
  let firstSearchQuery = '';
  const provider: FixtureProvider = async (query, _max, _recency) => {
    if (!firstSearchQuery) firstSearchQuery = query;
    if (firstSearchQuery === query) return [result('AI companies announced research this week', 'https://single.example/ai')];
    return [];
  };
  const output = await withPages({
    'single.example/ai': 'AI companies announced several research projects this week, according to their public updates. The projects cover model training and data tools.',
  }, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));

  assert.ok(output.research.followupSearchCount > 0);
  assert.ok(output.research.coverage.adequacyReasons.includes('fewer than two relevant results for a broad current-events query'));
});

test('adequate broad-news coverage does not trigger unnecessary recovery', async () => {
  let searches = 0;
  const provider: FixtureProvider = async () => {
    searches += 1;
    return [
      result('AI company announced a new model this week', 'https://alpha.example/news'),
      result('Researchers disclosed an AI training vulnerability this week', 'https://beta.example/research'),
      result('AI startup funding round reported this week', 'https://gamma.example/funding'),
    ];
  };
  const output = await withPages({
    'alpha.example/news': 'An AI company announced a new model this week, according to its public newsroom. The model is available to customers starting today.',
    'beta.example/research': 'Researchers disclosed an AI training vulnerability this week. The security team reported that the flaw could expose model credentials.',
    'gamma.example/funding': 'An AI startup reported a funding round this week. The company said it will use the investment to expand its engineering team.',
  }, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));

  assert.equal(output.research.coverage.adequate, true, JSON.stringify(output.research.coverage));
  assert.ok(searches <= 3, 'adequate first-pass coverage must not cause an adequacy recovery');
});

test('failed recovery returns an honest insufficient-evidence answer without irrelevant sources', async () => {
  let searches = 0;
  const provider: FixtureProvider = async () => {
    searches += 1;
    if (searches === 1) return [result('MarketBeat Week in Review', 'https://marketbeat.example/review')];
    throw new Error('Fixture recovery search failed.');
  };
  const output = await withPages({}, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));
  const text = formatResearchResponse(output);

  assert.equal(searches, 3, 'the bounded broad-news controller uses its remaining discovery search after a failed recovery');
  assert.match(text, /couldn't identify current developments about AI/i);
  assert.match(text, /does not mean nothing happened/i);
  assert.doesNotMatch(text, /MarketBeat|Research completed using|searches and \d+ sources/i);
  assert.ok(output.research.limitations.includes('A follow-up search failed; the initial research results are retained.'));
});

test('successful recovery summarizes findings without exposing internal counters', async () => {
  let searches = 0;
  const provider: FixtureProvider = async () => {
    searches += 1;
    if (searches === 1) return [result('MarketBeat Week in Review', 'https://marketbeat.example/review')];
    if (searches === 2) return [
        result('AI company announced a new model this week', 'https://alpha.example/news'),
        result('AI research publication this week', 'https://beta.example/research'),
      ];
    return [result('AI startup funding news this week', 'https://gamma.example/funding')];
  };
  const output = await withPages({
    'marketbeat.example/review': 'No useful AI news appears in this short market recap.',
    'alpha.example/news': 'An AI company announced a new model this week, according to its official newsroom. The model is available to customers starting today.',
    'beta.example/research': 'Researchers published AI findings this week describing a new method for training language models. The paper reports evaluation results across several tasks.',
    'gamma.example/funding': 'An AI startup announced new funding this week, according to its company statement. The investment will support additional AI model development and hiring.',
  }, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));
  const text = formatResearchResponse(output);

  assert.equal(output.research.coverage.adequate, true, JSON.stringify(output.research.coverage));
  assert.match(text, /Research brief — AI/i);
  assert.doesNotMatch(text, /Research completed using|searchCount|followupSearchCount|sourcesDiscovered|claimsExtracted/);
});

test('search-result ranking prefers relevant results over irrelevant ones', () => {
  const ranked = rankSearchResults('latest AI model research', [
    result('Local weather and sports results', 'https://weather.example/page'),
    { ...result('AI model research results', 'https://lab.example/paper'), content: 'Latest AI model research reports evaluation results.' },
  ]);
  assert.match(ranked[0].result.title, /AI model research/i);
});

test('direct-answer pages rank above generic background pages for verification questions', () => {
  const ranked = rankSearchResults('Did anyone solve the Riemann Hypothesis in 2026?', [
    { ...result('History and definition of the Riemann Hypothesis', 'https://reference.example/history'), content: 'History of the Riemann Hypothesis, proposed in 1859.' },
    { ...result('Riemann Hypothesis proof status in 2026', 'https://math.example/status'), content: 'The Riemann Hypothesis remains unproven in 2026; no proof has been published.' },
  ]);
  assert.equal(ranked[0].result.url, 'https://math.example/status');
  assert.ok(ranked[0].reasons.some((reason) => reason.includes('directly addresses')));
});

test('recent dates receive a ranking preference for current-events queries', () => {
  const ranked = rankSearchResults('AI news this week', [
    { ...result('AI company news report', 'https://old.example/story', '2020-01-01'), content: 'AI company news report this week.' },
    { ...result('AI company news update', 'https://new.example/story', new Date().toISOString().slice(0, 10)), content: 'AI company news update this week.' },
  ]);
  assert.equal(ranked[0].result.url, 'https://new.example/story');
});

test('domain diversity can break close ranking ties without overriding relevance', () => {
  const ranked = rankSearchResults('AI news this week', [
    { ...result('AI news report alpha', 'https://alpha.example/a'), content: 'AI news report this week.' },
    { ...result('AI news report beta', 'https://alpha.example/b'), content: 'AI news report this week.' },
    { ...result('AI news report gamma', 'https://beta.example/c'), content: 'AI news report this week.' },
  ]);
  assert.equal(new URL(ranked[0].result.url).hostname, 'alpha.example');
  assert.equal(new URL(ranked[1].result.url).hostname, 'beta.example');
  assert.ok(ranked[1].reasons.includes('adds a distinct source domain'));
});

test('normalized duplicate URLs are not fetched twice', async () => {
  let searches = 0;
  const provider: FixtureProvider = async () => {
    searches += 1;
    return [
      result('Riemann Hypothesis overview', 'https://math.example/overview?utm_source=one'),
      result('Riemann Hypothesis overview', 'https://math.example/overview#section'),
    ];
  };
  const output = await withPages({
    'math.example/overview': 'The Riemann Hypothesis is a conjecture about the nontrivial zeros of the zeta function. It remains an important mathematical problem.',
  }, () => researchWebWithSearchProvider({ query: 'What is the Riemann Hypothesis?', max_results: 5, recency: 'year' }, provider));
  assert.equal(output.research.sourceSelection.fetchAttempts, 1);
  assert.equal(output.sources.length, 1);
  assert.equal(output.research.sourceSelection.totalResultsDiscovered, 2);
  assert.equal(searches, 1);
});

test('only four adequate top candidates are fetched and lower candidates are recorded as skipped', async () => {
  const provider: FixtureProvider = async () => Array.from({ length: 5 }, (_, index) =>
    result(`Riemann Hypothesis overview ${index + 1}`, `https://site${index + 1}.example/paper`));
  const pages = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [
    `site${index + 1}.example/paper`,
    'The Riemann Hypothesis is a conjecture about the nontrivial zeros of the zeta function and remains a central mathematical problem.',
  ]));
  const output = await withPages(pages, () => researchWebWithSearchProvider(
    { query: 'What is the Riemann Hypothesis?', max_results: 5, recency: 'any' }, provider,
  ));
  assert.equal(output.research.sourceSelection.fetchAttempts, 4, JSON.stringify(output.sources.map((source) => ({ id: source.id, textLength: source.extractedText.length, target: source.targetRelevance, error: source.fetchError }))));
  assert.ok(output.research.sourceSelection.candidates.some((candidate) => candidate.decision.includes('four usable pages already selected')));
});

test('failed selected candidates are replaced with the next ranked URL', async () => {
  const provider: FixtureProvider = async () => Array.from({ length: 5 }, (_, index) =>
    result(`Riemann Hypothesis overview ${index + 1}`, `https://candidate${index + 1}.example/paper`));
  const output = await withPages({
    'candidate5.example/paper': 'The Riemann Hypothesis is a conjecture about the nontrivial zeros of the zeta function and remains a central mathematical problem.',
  }, () => researchWebWithSearchProvider(
    { query: 'What is the Riemann Hypothesis?', max_results: 5, recency: 'any' }, provider,
  ));
  assert.equal(output.research.sourceSelection.fetchAttempts, 5);
  assert.equal(output.research.sourceSelection.replacementsUsed, true);
  assert.ok(output.research.sourceSelection.candidates.some((candidate) => candidate.decision.includes('replacement selected and usable')));
});

test('six unique page-fetch attempts is a hard per-request limit across searches', async () => {
  let searchNumber = 0;
  const provider: FixtureProvider = async () => {
    searchNumber += 1;
    const prefix = searchNumber === 1 ? 'initial' : `round${searchNumber}`;
    return Array.from({ length: 5 }, (_, index) => result(
      `Riemann Hypothesis proof status ${prefix} ${index}`,
      `https://${prefix}${index}.example/status`,
    ));
  };
  const pages: Record<string, string> = {};
  for (const prefix of ['initial', 'round2', 'round3']) {
    for (let index = 0; index < 5; index += 1) {
      pages[`${prefix}${index}.example/status`] = 'The Riemann Hypothesis remains unproven in 2026, according to mathematicians studying the problem.';
    }
  }
  const output = await withPages(pages, () => researchWebWithSearchProvider(verifyQuery, provider));
  assert.equal(output.research.searchCount, 3);
  assert.ok(output.research.sourceSelection.fetchAttempts <= 6);
  assert.equal(output.research.sourceSelection.fetchAttempts, 6);
});

test('search snippets are never factual evidence when webpage fetching fails', async () => {
  const provider: FixtureProvider = async () => [{
    ...result('Riemann Hypothesis solved in 2026', 'https://unavailable.example/proof'),
    content: 'The Riemann Hypothesis was proved in 2026 by a team of mathematicians.',
  }];
  const output = await withPages({}, () => researchWebWithSearchProvider(verifyQuery, provider));
  const failed = output.sources.find((source) => source.fetchError);
  assert.ok(failed);
  assert.equal(failed.extractedText, '');
  assert.equal(output.research.findings.length, 0);
  assert.ok(output.research.limitations.some((item) => item.includes('was not used as evidence')));
});

test('HTML extraction keeps readable article text and removes scripts, navigation, and boilerplate', async () => {
  const provider: FixtureProvider = async () => [result('AI research report', 'https://content.example/article')];
  const html = `<html><head><title>AI research report</title><meta property="article:published_time" content="2026-10-09"></head><body>
    <nav>AI research site navigation menu</nav><article><h1>AI research results</h1>
    <p>AI research teams published a new evaluation of language models across scientific tasks this week.</p>
    <h2>Key findings</h2><ul><li>The evaluation measured model accuracy across five research categories.</li></ul>
    <table><caption>AI research evaluation results</caption><tr><th>Measure</th><td>Accuracy improved</td></tr></table>
    <p>Copyright All rights reserved. Subscribe now to our newsletter.</p></article>
    <script>window.secretNavigation = 'AI research fake finding';</script></body></html>`;
  const output = await withPages({ 'content.example/article': html }, () => researchWebWithSearchProvider(
    { query: 'AI research evaluation', max_results: 5, recency: 'any' }, provider,
  ));
  const text = output.sources[0].extractedText;
  assert.match(text, /AI research results/);
  assert.match(text, /evaluation measured model accuracy/);
  assert.match(text, /Accuracy improved/);
  assert.doesNotMatch(text, /site navigation|secretNavigation|Copyright All rights reserved|Subscribe now/);
  assert.equal(output.sources[0].publishedAt, '2026-10-09');
});

test('pages exceeding the extraction cap are visibly marked as truncated', async () => {
  const provider: FixtureProvider = async () => [result('AI research long report', 'https://long.example/report')];
  const longParagraph = `AI research studies language models and evaluation methods. ${'Additional relevant AI research tests model accuracy across scientific tasks. '.repeat(900)}`;
  const output = await withPages({ 'long.example/report': `<html><head><title>AI research long report</title></head><body><article><p>${longParagraph}</p></article></body></html>` }, () => researchWebWithSearchProvider(
    { query: 'AI research model evaluation', max_results: 1, recency: 'any' }, provider,
  ));
  assert.equal(output.sources[0].extractedText.length, 40_000);
  assert.equal(output.sources[0].truncated, true);
  assert.equal(output.research.sourceSelection.truncatedPages, 1);
});

test('thin JavaScript-rendered pages are marked as requiring browser rendering', async () => {
  const provider: FixtureProvider = async () => [result('AI research application', 'https://javascript.example/app')];
  const html = '<html><head><title>AI research application</title></head><body><div id="app"></div><script>renderResearchPage()</script></body></html>';
  const output = await withPages({ 'javascript.example/app': html }, () => researchWebWithSearchProvider(
    { query: 'What is AI research?', max_results: 1, recency: 'any' }, provider,
    async () => { throw new Error('fixture browser unavailable'); },
  ));
  assert.equal(output.sources[0].requiresBrowserRendering, true);
  assert.equal(output.sources[0].browserRenderingAttempted, true);
  assert.match(output.sources[0].browserRenderingError ?? '', /fixture browser unavailable/);
  assert.ok(output.research.limitations.some((item) => item.includes('remained unreadable after browser rendering')));
});

test('Playwright fallback uses rendered article text after HTTP returns a JavaScript shell', async () => {
  const provider: FixtureProvider = async () => [result('What is AGI?', 'https://javascript.example/agi')];
  const shell = '<html><head><title>What is AGI?</title></head><body><div id="app"></div><script>render()</script></body></html>';
  let renderedUrl = '';
  const output = await withPages({ 'javascript.example/agi': shell }, () => researchWebWithSearchProvider(
    { query: 'What is AGI?', max_results: 1, recency: 'any' }, provider,
    async (url) => {
      renderedUrl = url;
      return { html: '<html><head><title>AGI explained</title></head><body><article><h1>Artificial general intelligence (AGI)</h1><p>Artificial general intelligence is a research goal for systems that can perform a broad range of intellectual tasks.</p><p>Researchers study AGI as a long-term objective in artificial intelligence.</p></article></body></html>', truncated: false };
    },
  ));
  const source = output.sources[0];
  assert.equal(renderedUrl, 'https://javascript.example/agi');
  assert.equal(source.browserRenderingAttempted, true);
  assert.equal(source.requiresBrowserRendering, false);
  assert.match(source.extractedText, /broad range of intellectual tasks/);
  assert.ok(output.research.findings.some((finding) => finding.sourceIds.includes(source.id)));
});

test('Riemann verification findings outrank historical background', async () => {
  const provider: FixtureProvider = async () => [result('Riemann Hypothesis proof status', 'https://math.example/status')];
  const output = await withPages({
    'math.example/status': 'The Riemann Hypothesis was proposed by Bernhard Riemann in 1859. The Riemann Hypothesis remains unproven in 2026, and no verified proof has been published.',
  }, () => researchWebWithSearchProvider(verifyQuery, provider));
  assert.match(output.research.findings[0].claim, /remains unproven in 2026/i);
  assert.match(output.research.researchTarget, /Determine whether Riemann Hypothesis in 2026 was proved or disproved/i);
});

test('prediction findings retain prediction in the compatibility claimType field', async () => {
  const provider: FixtureProvider = async () => [result('AI research forecast', 'https://forecast.example/report')];
  const output = await withPages({
    'forecast.example/report': 'AI research may discover a new method to improve language models in the next decade.',
  }, () => researchWebWithSearchProvider({ query: 'AI research may discover', max_results: 1, recency: 'any' }, provider));
  const prediction = output.research.findings.find((finding) => finding.type === 'prediction');
  assert.ok(prediction);
  assert.equal(prediction.claimType, 'prediction');
});

test('likely unreadable social pages rank below similarly relevant readable reporting', () => {
  const ranked = rankSearchResults('AI news this week', [
    { ...result('AI news this week: new model released', 'https://instagram.com/post/1'), content: 'AI news this week: a new model was released.' },
    { ...result('AI news this week: new model released', 'https://report.example/story'), content: 'AI news this week: a new model was released.' },
  ]);
  assert.equal(ranked[0].result.url, 'https://report.example/story');
  assert.ok(ranked[1].reasons.some((reason) => reason.includes('may need browser rendering')));
});

test('a roundup page can yield multiple separately attributed developments', async () => {
  const provider: FixtureProvider = async () => [result('AI weekly developments roundup', 'https://roundup.example/week')];
  const output = await withPages({ 'roundup.example/week': [
    'An AI company announced a new language model this week, according to its newsroom.',
    'Researchers disclosed a security vulnerability affecting an AI agent platform.',
    'A media company filed a lawsuit against an AI developer over copyrighted articles.',
    'An open source AI penetration testing tool was withdrawn by its maintainers.',
  ].join('\n') }, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));
  assert.ok(output.research.findings.length >= 3, JSON.stringify(output.research.findings.map((item) => item.claim)));
  assert.ok(output.research.findings.every((finding) => finding.sourceIds.length === 1));
  assert.equal(output.research.coverage.distinctDomains, 1);
  assert.equal(output.research.coverage.independentCorroboratingSources, 1, 'one roundup article remains one independent source despite several findings');
});

test('equivalent financial units merge while retaining source evidence', async () => {
  const provider: FixtureProvider = async () => [
    result('TypeSafe raises $870M at $7.5B valuation', 'https://sourcea.example/story'),
    result('TypeSafe raised $0.87B at a $7.5B valuation', 'https://sourceb.example/story'),
  ];
  const article = 'TypeSafe raised $870M at a $7.5B valuation in its latest funding round, according to company representatives.';
  const output = await withPages({
    'sourcea.example/story': article,
    'sourceb.example/story': 'TypeSafe raised $0.87B at a $7.5B valuation in its latest funding round, according to company representatives.',
  }, () => researchWebWithSearchProvider({ query: 'TypeSafe funding round', max_results: 5, recency: 'year' }, provider));
  assert.equal(output.research.disagreements.length, 0, JSON.stringify({ findings: output.research.findings, disagreements: output.research.disagreements }));
  const finding = output.research.findings.find((item) => /TypeSafe raised/i.test(item.claim));
  assert.ok(finding);
  assert.equal(finding.sourceIds.length, 2);
  assert.equal(finding.materialFigures.find((figure) => figure.metric === 'funding_amount')?.normalizedValue, 870_000_000);
});

test('different funding and valuation figures stay separate and disputed', async () => {
  const provider: FixtureProvider = async () => [
    result('TypeSafe raises $870M at $7.5B valuation', 'https://sourcea.example/story'),
    result('TypeSafe raises $8.7B at $75B valuation', 'https://sourceb.example/story'),
  ];
  const output = await withPages({
    'sourcea.example/story': 'TypeSafe raised $870M at a $7.5B valuation in a funding round, according to the report.',
    'sourceb.example/story': 'TypeSafe raised $8.7B at a $75B valuation in a funding round, according to the report.',
  }, () => researchWebWithSearchProvider({ query: 'TypeSafe funding round', max_results: 5, recency: 'year' }, provider));
  assert.ok(output.research.disagreements.some((item) => item.sourceIds.length === 2));
  const disputed = output.research.findings.filter((item) => item.status === 'disputed');
  assert.ok(disputed.length >= 2);
  assert.ok(disputed.some((item) => item.materialFigures.some((figure) => figure.normalizedValue === 870_000_000)));
  assert.ok(disputed.some((item) => item.materialFigures.some((figure) => figure.normalizedValue === 8_700_000_000)));
});

test('copied reports across domains do not inflate independent corroboration', async () => {
  const article = 'The AI company announced its model launch on October 2, 2026, according to a statement issued by its team. The model is available to customers starting today.';
  const provider: FixtureProvider = async () => [
    result('AI company announced model launch', 'https://one.example/story'),
    result('AI company announced model launch', 'https://two.example/story'),
  ];
  const output = await withPages({ 'one.example/story': article, 'two.example/story': article }, () => researchWebWithSearchProvider(
    { query: 'AI model launch', max_results: 5, recency: 'year' }, provider,
  ));
  const finding = output.research.findings.find((item) => /AI company announced its model launch/i.test(item.claim));
  assert.ok(finding);
  assert.equal(finding.sourceCount, 2);
  assert.equal(finding.independentSourceCount, 1);
  assert.equal(finding.corroborationStatus, 'single_source');
});

test('broad current-week answers exclude stale tracker claims and lead with a useful partial roundup', async () => {
  const searches: string[] = [];
  const provider: FixtureProvider = async (query) => {
    searches.push(query);
    if (searches.length > 1) return [];
    return [
      result('AI News: Artificial Intelligence Stories, Ranked', 'https://aiweekly.example/issue', 'Tue, 06 Oct'),
      result('AI Safety Funding Tracker (170 deals)', 'https://newmarketpitch.example/tracker', '2026-02-18'),
    ];
  };
  const output = await withPages({
    'aiweekly.example/issue': '<html><head><title>AI Weekly #536</title></head><body><article><h1>#536 Top AI models failed a test of inventing new AI research</h1><p>This issue is built from links the AI experts we follow shared over the past three days.</p></article></body></html>',
    'newmarketpitch.example/tracker': '<html><head><title>AI Safety Funding Tracker (170 deals)</title><meta property="article:published_time" content="2026-02-18"></head><body><article><p>AI safety is already a multibillion-dollar venture market, but the typical startup is still raising single-digit millions. This analysis describes several AI safety market categories.</p></article></body></html>',
  }, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));
  const text = formatResearchResponse(output);

  assert.equal(searches.length, 3, 'inadequate coverage consumes no more than two recovery searches');
  assert.ok(output.research.findings.length >= 1, JSON.stringify({ sources: output.sources.map(({ id, url, fetchError, publishedAt, extractedText }) => ({ id, url, fetchError, publishedAt, text: extractedText })), candidates: output.research.sourceSelection.candidates }));
  assert.ok(output.research.findings.every((finding) => !/single-digit millions|multibillion-dollar venture market/i.test(finding.claim)));
  assert.match(text, /Coverage is partial/i);
  assert.doesNotMatch(text, /I found limited evidence|single-digit millions|multibillion-dollar venture market|Tue, 06 Oc\./i);
  assert.match(text, /Oct 6/);
  assert.ok(output.research.sourceSelection.candidates.some((item) => item.decision.includes('outside the requested time window')));
  assert.equal(output.research.coverage.recentDevelopments, output.research.findings.length);
});

test('answer formatter presents AGI research as a concise brief with grouped claims and clean dates', async () => {
  const provider: FixtureProvider = async () => [
    result('What is AGI? - Artificial General Intelligence Explained - AWS', 'https://aws.example/agi'),
    result('What is Artificial General Intelligence?', 'https://databricks.example/agi'),
  ];
  const output = await withPages({
    'aws.example/agi': '<html><head><title>What is AGI? - Artificial General Intelligence Explained - AWS</title><meta property="article:published_time" content="Sun, 06 Sep 2026 03:00:00 GMT"></head><body><article><h1>What is AGI (Artificial General Intelligence)?</h1><p>AGI with human abilities remains a theoretical concept and research goal.</p><p>Artificial general intelligence is a field of theoretical AI research that attempts to create software with human-like intelligence and the ability to self-teach.</p></article></body></html>',
    'databricks.example/agi': '<html><head><title>What is Artificial General Intelligence?</title><meta property="article:published_time" content="Sun, 06 Sep 2026 03:00:00 GMT"></head><body><article><p>AGI with human abilities remains a theoretical concept and research goal. The term describes a long-term objective in artificial intelligence research.</p></article></body></html>',
  }, () => researchWebWithSearchProvider(
    { query: 'What is AGI?', max_results: 5, recency: 'any' }, provider,
  ));
  const text = formatResearchResponse(output);

  assert.match(text, /Research brief — What is AGI/i);
  assert.match(text, /\*\*Summary\*\*/);
  assert.match(text, /\*\*Key findings\*\*/);
  assert.match(text, /Sep 6, 2026/);
  assert.match(text, /AWS/);
  assert.match(text, /databricks\.example/, JSON.stringify(output.research.sourceSelection.candidates));
  assert.doesNotMatch(text, /I found limited evidence|Potential findings|What is AGI \(Artificial General Intelligence\)\?/i);
  assert.doesNotMatch(text, /03:00:00 GMT/);
});

test('a focused latest-model query honors recency year instead of being treated as a 30-day news roundup', async () => {
  const query = 'What are the latest AI models that use genetic algorithms or evolutionary learning?';
  const candidate = result(
    'New AI model for DNA learns from evolution to unlock secrets of the human genome - Berkeley News',
    'https://news.berkeley.example/ai-dna-evolution',
    '2026-09-09',
  );
  candidate.content = 'Researchers introduced a new AI model for DNA that learns from evolution to identify patterns in the human genome.';
  const provider: FixtureProvider = async (searchQuery) => searchQuery === query ? [candidate] : [];
  const output = await withPages({
    'news.berkeley.example/ai-dna-evolution': '<html><head><title>New AI model learns from evolution</title><meta property="article:published_time" content="2026-09-09"></head><body><article><p>Researchers introduced a new AI model for DNA that learns from evolution to identify patterns in the human genome. The model learns evolutionary patterns from genomes and supports new genetic research.</p></article></body></html>',
  }, () => researchWebWithSearchProvider({ query, max_results: 5, recency: 'year' }, provider));

  assert.ok(output.sources.some((source) => source.url === candidate.url));
  assert.ok(output.sources.find((source) => source.url === candidate.url)?.extractedText.length! >= 80);
  assert.ok(!output.research.sourceSelection.candidates.some((item) => item.url === candidate.url && item.decision.includes('outside the requested time window')));
  assert.ok(!output.research.limitations.some((item) => item.includes('outside the requested time window')));
});
