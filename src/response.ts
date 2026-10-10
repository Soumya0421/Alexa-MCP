import type { ResearchResult } from './research.js';

/** Build a brief answer for Alexa+ without exposing controller diagnostics. */
export function formatResearchResponse(result: ResearchResult): string {
  const research = result.research;
  const findings = research.findings.slice(0, isBroadNews(result.query) ? 5 : 3);
  const sourceIds = new Set(findings.flatMap((finding) => finding.sourceIds));
  const readableSources = result.sources.filter((source) => sourceIds.has(source.id)
    && !source.fetchError && source.extractedText.trim().length >= 40);
  const sourceNotes = readableSources.slice(0, 5).map((source) => `[${source.id}] ${source.title} - ${source.url}`);
  const findingLines = findings.map((finding, index) => {
    const evidenceSource = result.sources.find((source) => finding.sourceIds.includes(source.id) && !source.fetchError);
    const date = finding.publishedAt ? ` Date: ${finding.publishedAt.slice(0, 10)}.` : '';
    const evidence = finding.evidence[0];
    const nearbyContext = evidence?.snippet.replace(evidence.sentence, '').trim();
    const impact = nearbyContext && /\b(will|could|may|risk|allow|help|because|impact|aim|support|enable|result(?:ed)? in)\b/i.test(nearbyContext)
      ? ` Reported impact: ${nearbyContext.slice(0, 180)}` : '';
    const support = finding.corroborationStatus === 'corroborated'
      ? `Supported by ${finding.independentSourceCount} independent sources.`
      : finding.corroborationStatus === 'disputed'
        ? 'Sources report conflicting details.'
        : finding.corroborationStatus === 'single_source'
          ? 'Reported by one source; independent confirmation was not found.'
          : 'Evidence is insufficient to present this as established.';
    const verify = finding.verificationRequired ? ' This claim needs stronger verification.' : '';
    const sourceLink = evidenceSource ? ` Source: ${evidenceSource.url}` : '';
    return `${index + 1}. ${finding.claim}${date}\n   Type: ${finding.type}. ${support}${verify}${impact}${sourceLink}`;
  });

  const answersTarget = research.sourceSelection.adequatelyAnswersTarget;
  if (!research.coverage.adequate || !answersTarget) {
    const topic = result.query.replace(/[?!.]+$/, '');
    if (findingLines.length === 0 || research.sourceSelection.usablePages === 0) {
      return `I couldn't gather enough reliable evidence to summarize ${topic}. The available search results did not provide enough usable source content.`;
    }
    return [
      `I found limited evidence about ${topic}, but not enough to provide a reliable summary.`,
      `${isBroadNews(result.query) ? 'Partial developments found:' : 'Potential findings:'}\n${findingLines.join('\n')}`,
      sourceNotes.length ? `Sources:\n${sourceNotes.join('\n')}` : '',
      research.sourceSelection.failedPages > 0 || result.sources.some((source) => source.requiresBrowserRendering)
        ? 'Some pages could not be verified because they were inaccessible or require browser rendering.'
        : '',
      research.sourceSelection.truncatedPages > 0 ? 'Some fetched page text was truncated.' : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    isVerificationQuestion(result.query) && findings[0]?.targetRelevance >= 0.60
      ? `Best-supported answer: ${findings[0].claim}`
    : `Key findings about ${result.query.replace(/[?!.]+$/, '')}${isBroadNews(result.query) ? ' (distinct developments)' : ''}:`,
    findingLines.length ? findingLines.join('\n') : 'I could not extract supported findings from the available sources.',
    research.disagreements.length
      ? `Potential disagreement:\n${research.disagreements.slice(0, 2).map((item) => `- ${item.claims.join(' / ')}`).join('\n')}`
      : '',
    sourceNotes.length ? `Sources:\n${sourceNotes.join('\n')}` : '',
    research.sourceSelection.failedPages > 0
      ? `${research.sourceSelection.failedPages} selected source${research.sourceSelection.failedPages === 1 ? ' was' : 's were'} inaccessible and were not used as evidence.`
      : '',
    research.sourceSelection.truncatedPages > 0 ? 'Some fetched page text was truncated at the extraction limit.' : '',
    result.sources.some((source) => source.requiresBrowserRendering)
      ? 'Some pages require browser rendering; it was not attempted.'
      : '',
  ].filter(Boolean).join('\n\n');
}

function isBroadNews(query: string): boolean {
  return /\b(news|headlines?|what happened|current events|this week|this month|today|latest|recent|developments?)\b/i.test(query)
    && !isVerificationQuestion(query);
}

function isVerificationQuestion(query: string): boolean {
  return /\b(is it true|did anyone|has anyone|was .* proven|has .* been proven|solved|disproved|disproven|proof|prove|verified|verify|confirmed|confirm|found a solution)\b/i.test(query);
}
