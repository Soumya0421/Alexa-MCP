import assert from 'node:assert/strict';
import test from 'node:test';
import { researchWebWithSearchProvider, type ResearchOptions, type SearchResult } from './research.js';
import { formatResearchResponse } from './response.js';

type FixtureProvider = Parameters<typeof researchWebWithSearchProvider>[1];

function result(title: string, url: string, publishedDate = '2026-10-02'): SearchResult {
  return { title, url, content: title, score: 0.9, publishedDate };
}

async function withPages<T>(pages: Record<string, string>, callback: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = input instanceof URL ? input : new URL(typeof input === 'string' ? input : input.url);
    const content = pages[`${url.hostname}${url.pathname}`];
    if (!content) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } });
    const html = `<html><head><title>${url.hostname} research</title></head><body><main>${content
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
  assert.equal(claim.corroborationStatus, 'corroborated');
  assert.equal(claim.sourceCount, 2);
  assert.equal(claim.independentSourceCount, 2);
  assert.equal(output.sources.length, 2, 'the follow-up URL alias should not create a third source');
  assert.equal(calls.length, 3, 'one initial plus two follow-up searches');
  assert.equal(output.research.searchCount, 3);
  assert.equal(output.research.followupSearchCount, 2);
  assert.equal(output.research.researchDepth, 1);
  assert.match(calls[1].toLowerCase(), /claude.*riemann.*hypothesis/);
  assert.notEqual(calls[1], verifyQuery.query);
  assert.notEqual(calls[2], calls[1]);
  assert.ok(output.research.trace.followupReasons.length > 0);
  assert.ok(output.research.trace.sourcesDiscovered >= output.sources.length);
  assert.equal(output.research.trace.sourcesUsed, 2);
  assert.ok(claim.evidence.every((item) => output.sources.find((source) => source.id === item.sourceId)?.extractedText.includes(item.sentence)));
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

  assert.equal(calls.length, 2, 'one inadequate initial search triggers one bounded recovery search');
  assert.equal(calls[1], 'AI news this week');
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

  assert.equal(searches, 2);
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
      result('Artificial intelligence research this week', 'https://beta.example/research'),
    ];
  };
  const output = await withPages({
    'alpha.example/news': 'AI systems are being used by hospitals to summarize patient notes, according to published reports. This report describes the hospital software workflow and privacy controls.',
    'beta.example/research': 'AI systems are being used by hospitals to summarize patient notes, according to published reports. This article discusses clinical documentation and how staff review the generated summaries.',
  }, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));

  assert.equal(output.research.coverage.adequacyReasons.some((reason) => reason.includes('search adequacy recovery')), false);
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

  assert.equal(searches, 2, 'the failed recovery attempt remains within the search bound');
  assert.match(text, /couldn't gather enough reliable evidence/i);
  assert.match(text, /did not provide enough usable source content/i);
  assert.doesNotMatch(text, /MarketBeat|Research completed using|searches and \d+ sources/i);
  assert.ok(output.research.limitations.includes('A follow-up search failed; the initial research results are retained.'));
});

test('successful recovery summarizes findings without exposing internal counters', async () => {
  let searches = 0;
  const provider: FixtureProvider = async () => {
    searches += 1;
    return searches === 1
      ? [result('MarketBeat Week in Review', 'https://marketbeat.example/review')]
      : [
        result('AI company announced a new model this week', 'https://alpha.example/news'),
        result('AI research publication this week', 'https://beta.example/research'),
      ];
  };
  const output = await withPages({
    'marketbeat.example/review': 'No useful AI news appears in this short market recap.',
    'alpha.example/news': 'An AI company announced a new model this week, according to its official newsroom. The model is available to customers starting today.',
    'beta.example/research': 'Researchers published AI findings this week describing a new method for training language models. The paper reports evaluation results across several tasks.',
  }, () => researchWebWithSearchProvider(
    { query: 'What happened in AI this week?', max_results: 5, recency: 'week' }, provider,
  ));
  const text = formatResearchResponse(output);

  assert.equal(output.research.coverage.adequate, true);
  assert.match(text, /key findings about What happened in AI this week/i);
  assert.doesNotMatch(text, /Research completed using|searchCount|followupSearchCount|sourcesDiscovered|claimsExtracted/);
});
