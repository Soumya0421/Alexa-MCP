import { createServer } from 'node:http';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { researchWeb } from './research.js';
import { formatResearchResponse } from './response.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';
const allowedHosts = (process.env.MCP_ALLOWED_HOSTS ?? 'localhost,127.0.0.1,[::1]')
  .split(',').map((value) => value.trim()).filter(Boolean);

function createServerWithTools(): McpServer {
  const server = new McpServer({ name: 'alexa-live-web-research-mcp', version: '0.1.0' });
  server.registerTool('research_web', {
    title: 'Research the live web',
    description: 'Search the live web, fetch relevant webpages, extract evidence, and compare claims across sources.',
    inputSchema: z.object({
      query: z.string().trim().min(1).max(400).describe('The topic or question to research.'),
      max_results: z.number().int().min(1).max(5).default(3).describe('Maximum number of webpages to return (1-5).'),
      recency: z.enum(['day', 'week', 'month', 'year', 'any']).default('any')
        .describe('Limit search results to the past day, week, month, year, or any time.'),
    }),
  }, async ({ query, max_results, recency }) => {
    try {
      const result = await researchWeb({ query, max_results, recency });
      return { content: [{ type: 'text', text: formatResearchResponse(result) }], structuredContent: result };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Web research failed.';
      return {
        content: [{ type: 'text', text: `Web research failed: ${message}` }],
        structuredContent: {
          query, recency, sources: [],
          research: {
            query, retrievedAt: new Date().toISOString(),
            researchMode: 'bounded_agentic', searchCount: 1, followupSearchCount: 0, researchDepth: 0,
            trace: { initialSearches: 1, followupSearches: 0, sourcesDiscovered: 0, sourcesUsed: 0, claimsExtracted: 0, followupReasons: [] },
            researchTarget: query,
            sourceSelection: { totalResultsDiscovered: 0, candidatesRanked: 0, fetchAttempts: 0, pagesSuccessfullyFetched: 0, usablePages: 0, failedPages: 0, truncatedPages: 0, replacementsUsed: false, replacementCandidatesAttempted: 0, adequatelyAnswersTarget: false, candidates: [] },
            coverage: { searchResults: 0, uniqueSources: 0, fetchedPages: 0, usablePages: 0, failedPages: 0, distinctDomains: 0, distinctDevelopments: 0, recentDevelopments: 0, independentCorroboratingSources: 0, unresolvedMaterialConflicts: 0, adequate: false, adequacyReasons: ['search did not complete'] },
            findings: [], sources: [], corroboration: [], disagreements: [], limitations: [message],
          },
          error: message,
        },
        isError: true,
      };
    }
  });
  return server;
}

// The SDK serves modern clients and also supports stateless 2025-era clients,
// which Alexa+ currently documents as its supported protocol family.
const mcpHandler = createMcpHandler(createServerWithTools, { legacy: 'stateless' });
const handleMcpRequest = toNodeHandler(mcpHandler);
const validateHost = hostHeaderValidation(allowedHosts);
const validateOrigin = originValidation(allowedHosts);

const httpServer = createServer(async (request, response) => {
  const requestPath = new URL(request.url ?? '/', 'http://localhost').pathname;
  if (requestPath !== '/mcp') {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found. The MCP endpoint is /mcp.');
    return;
  }
  if (!validateHost(request, response) || !validateOrigin(request, response)) return;
  try { await handleMcpRequest(request, response); }
  catch (error) {
    console.error('MCP request failed:', error);
    if (!response.headersSent) response.writeHead(500);
    response.end();
  }
});

httpServer.listen(port, host, () => {
  console.log(`Alexa+ Live Web Research MCP listening at http://${host}:${port}/mcp`);
  console.log(`Allowed Host/Origin values: ${allowedHosts.join(', ')}`);
});
