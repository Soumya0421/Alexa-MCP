import type { ResearchResult } from './research.js';

/** Build a brief answer for Alexa+ without exposing controller diagnostics. */
export function formatResearchResponse(result: ResearchResult): string {
  const research = result.research;
  const findings = research.findings.slice(0, 3);
  const sourceIds = new Set(findings.flatMap((finding) => finding.sourceIds));
  const readableSources = result.sources.filter((source) => sourceIds.has(source.id)
    && !source.fetchError && source.extractedText.trim().length >= 40);
  const sourceNotes = readableSources.slice(0, 5).map((source) => `[${source.id}] ${source.title} - ${source.url}`);
  const findingLines = findings.map((finding, index) => {
    const support = finding.corroborationStatus === 'corroborated'
      ? `Supported by ${finding.independentSourceCount} independent sources.`
      : finding.corroborationStatus === 'disputed'
        ? 'Sources report conflicting details.'
        : finding.corroborationStatus === 'single_source'
          ? 'Reported by one source; independent confirmation was not found.'
          : 'Evidence is insufficient to present this as established.';
    const verify = finding.verificationRequired ? ' This claim needs stronger verification.' : '';
    return `${index + 1}. ${finding.claim}\n   ${support}${verify}`;
  });

  if (!research.coverage.adequate) {
    const topic = result.query.replace(/[?!.]+$/, '');
    if (findingLines.length === 0 || research.coverage.usablePages === 0) {
      return `I couldn't gather enough reliable evidence to summarize ${topic}. The available search results did not provide enough usable source content.`;
    }
    return [
      `I found limited evidence about ${topic}, but not enough to provide a reliable summary.`,
      `Potential findings:\n${findingLines.join('\n')}`,
      sourceNotes.length ? `Sources:\n${sourceNotes.join('\n')}` : '',
    ].filter(Boolean).join('\n\n');
  }

  return [
    `Here are the key findings about ${result.query.replace(/[?!.]+$/, '')}:`,
    findingLines.length ? findingLines.join('\n') : 'I could not extract supported findings from the available sources.',
    research.disagreements.length
      ? `Potential disagreement:\n${research.disagreements.slice(0, 2).map((item) => `- ${item.claims.join(' / ')}`).join('\n')}`
      : '',
    sourceNotes.length ? `Sources:\n${sourceNotes.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
