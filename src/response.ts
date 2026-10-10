import { publicationTimestamp } from './research.js';
import type { Finding, ResearchResult } from './research.js';

interface FindingGroup {
  main: Finding;
  related: Finding[];
}

/** Format a short research brief, without exposing internal controller diagnostics. */
export function formatResearchResponse(result: ResearchResult): string {
  const research = result.research;
  const broad = isBroadNews(result.query);
  const findings = research.findings.filter((finding) => !finding.claim.trim().endsWith('?'));
  const groups = groupRelatedFindings(findings).slice(0, broad ? 5 : 3);
  const sourceIds = new Set(groups.flatMap((group) => [group.main, ...group.related].flatMap((finding) => finding.sourceIds)));
  const sources = result.sources.filter((source) => sourceIds.has(source.id) && !source.fetchError);
  const sourceNotes = sources.slice(0, 6).map((source) => `[${source.id}] ${source.title} — ${source.url}`);
  const findingLines = groups.map((group, index) => renderFindingGroup(group, index + 1));
  const answersTarget = research.sourceSelection.adequatelyAnswersTarget;
  const topic = broad ? broadTopic(result.query) : result.query.replace(/[?!.]+$/, '');

  if (findingLines.length === 0 || research.sourceSelection.usablePages === 0) {
    if (broad) {
      return `I couldn't identify current developments about ${topic} in the readable pages. Some results were outside the requested time window or did not provide usable article text. That does not mean nothing happened.`;
    }
    return `The search did not return enough readable, relevant source material to answer “${topic}.”`;
  }

  const summary = buildSummary(groups[0], answersTarget, broad);
  const sections = [
    `Research brief — ${topic}`,
    `**Summary**\n${summary}`,
    `**Key findings**\n${findingLines.join('\n')}`,
    research.disagreements.length
      ? `**Disagreements**\n${research.disagreements.slice(0, 2).map((item) => `- ${item.claims.join(' / ')} (${item.reason})`).join('\n')}`
      : '',
    sourceNotes.length ? `**Sources**\n${sourceNotes.join('\n')}` : '',
    formatLimitations(result, broad, !research.coverage.adequate || !answersTarget),
  ];
  return sections.filter(Boolean).join('\n\n');
}

function buildSummary(group: FindingGroup, answersTarget: boolean, broad: boolean): string {
  const prefix = group.main.corroborationStatus === 'corroborated'
    ? `Across ${group.main.independentSourceCount} independent sources, the central finding is:`
    : group.main.corroborationStatus === 'disputed'
      ? 'The reviewed sources report conflicting accounts:'
      : 'A fetched source reports:';
  const claim = group.main.claim.replace(/^Claim reported by source:\s*/i, '').replace(/[.!?]+$/, '');
  const caveat = !answersTarget
    ? ' The available material supports only a partial answer.'
    : broad ? ' This is a summary of the fetched reports, not an exhaustive roundup.' : '';
  return `${prefix} “${claim}.”${caveat}`;
}

function renderFindingGroup(group: FindingGroup, index: number): string {
  const main = group.main;
  const sources = [...new Set(main.sourceIds)];
  const evidenceIds = sources.length ? sources.join(', ') : 'no source IDs available';
  const status = main.corroborationStatus === 'corroborated'
    ? `Corroborated across ${main.independentSourceCount} independent domains (heuristic).`
    : main.corroborationStatus === 'disputed'
      ? 'Material details are disputed across sources.'
      : main.corroborationStatus === 'single_source'
        ? 'Single-source report; independent confirmation was not found.'
        : 'Evidence is insufficient to present this as established.';
  const date = publicationDateLabel(main.publishedAt);
  const first = `${index}. **${capitalize(main.type)}${date ? ` — ${date}` : ''}:** ${main.claim} [${evidenceIds}] ${status}`;
  const related = group.related.map((finding) => {
    const ids = [...new Set(finding.sourceIds)].join(', ');
    const detailStatus = finding.corroborationStatus === 'corroborated'
      ? `corroborated across ${finding.independentSourceCount} independent domains`
      : finding.corroborationStatus === 'disputed'
        ? 'disputed'
        : 'reported by one source';
    return `   Related detail: ${finding.claim} [${ids}; ${detailStatus}].`;
  });
  return [first, ...related].join('\n');
}

/** Group overlapping statements only when they share a fetched source. */
function groupRelatedFindings(findings: Finding[]): FindingGroup[] {
  const groups: FindingGroup[] = [];
  for (const finding of findings) {
    const group = groups.find((item) => {
      if (item.main.corroborationStatus === 'disputed' || finding.corroborationStatus === 'disputed') return false;
      if (!finding.sourceIds.some((id) => item.main.sourceIds.includes(id))) return false;
      return tokenSimilarity(item.main.claim, finding.claim) >= 0.18;
    });
    if (group) group.related.push(finding);
    else groups.push({ main: finding, related: [] });
  }
  return groups;
}

function tokenSimilarity(left: string, right: string): number {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'a', 'an', 'to', 'of', 'by', 'in', 'on', 'it', 'its', 'as', 'be', 'their']);
  const tokens = (value: string) => new Set(value.toLowerCase().replace(/\bartificial general intelligence\b/g, 'agi')
    .match(/[a-z0-9]+/g)?.filter((token) => !stopWords.has(token)) ?? []);
  const a = tokens(left);
  const b = tokens(right);
  const union = new Set([...a, ...b]);
  return [...a].filter((token) => b.has(token)).length / Math.max(1, union.size);
}

function publicationDateLabel(value: string | null): string | null {
  const timestamp = publicationTimestamp(value);
  if (timestamp === null || !value) return null;
  if (/\b(19|20)\d{2}\b/.test(value)) {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(timestamp);
  }
  const monthDay = value.match(/\b(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+(\d{1,2})\b/i)
    ?? value.match(/\b(\d{1,2})\s+(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\b/i);
  if (!monthDay) return value;
  const month = /\d/.test(monthDay[1]) ? monthDay[2] : monthDay[1];
  const day = /\d/.test(monthDay[1]) ? monthDay[1] : monthDay[2];
  return `${month.slice(0, 3)} ${Number(day)}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatLimitations(result: ResearchResult, broad: boolean, incomplete: boolean): string {
  const limitations: string[] = [];
  if (incomplete) limitations.push(broad
    ? 'Coverage is partial and may omit other developments in the requested period.'
    : 'The fetched pages provide a partial overview, not a comprehensive account.');
  if (result.research.sourceSelection.failedPages > 0) {
    limitations.push(`${result.research.sourceSelection.failedPages} page${result.research.sourceSelection.failedPages === 1 ? ' was' : 's were'} inaccessible and excluded as evidence.`);
  }
  const browserPages = result.sources.filter((source) => source.requiresBrowserRendering).length;
  if (browserPages > 0) limitations.push(`${browserPages} page${browserPages === 1 ? ' requires' : 's require'} browser rendering; that content was not verified.`);
  if (result.research.sourceSelection.truncatedPages > 0) limitations.push('Some extracted page text was truncated.');
  return limitations.length ? `**Limitations**\n${limitations.map((item) => `- ${item}`).join('\n')}` : '';
}

function isBroadNews(query: string): boolean {
  return /\b(news|headlines?|what happened|current events|this week|this month|today|latest|recent|developments?)\b/i.test(query)
    && !isVerificationQuestion(query);
}

function broadTopic(query: string): string {
  return query.replace(/[?!.]+$/, '')
    .replace(/^\s*(?:what happened in|what happened to|what happened|what(?:'s| is) happening in|latest developments in|recent developments in|tell me about)\s+/i, '')
    .replace(/\s+\b(?:today|yesterday|this week|this month|this year|recently)\b.*$/i, '')
    .trim() || query.replace(/[?!.]+$/, '');
}

function isVerificationQuestion(query: string): boolean {
  return /\b(is it true|did anyone|has anyone|was .* proven|has .* been proven|solved|disproved|disproven|proof|prove|verified|verify|confirmed|confirm|found a solution)\b/i.test(query);
}
