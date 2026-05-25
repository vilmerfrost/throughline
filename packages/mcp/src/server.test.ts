import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Graph } from '@throughline/core';
import { GraphCache } from './graphCache.js';
import { createServer } from './server.js';
import { sampleGraph } from './__fixtures__/sampleGraph.js';

function clone(g: Graph): Graph {
  return JSON.parse(JSON.stringify(g));
}

async function connectTestClient(cache: GraphCache): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer(cache);
  const client = new Client({ name: 'throughline-test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test('server advertises onboarding instructions plus target/about tools and resource', async () => {
  const cache = new GraphCache('/repo', async () => clone(sampleGraph), 'argv');
  await cache.init();
  const { client, close } = await connectTestClient(cache);

  try {
    assert.match(client.getInstructions() ?? '', /get_analysis_target/);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.ok(names.includes('about_throughline'));
    assert.ok(names.includes('get_analysis_target'));
    assert.ok(names.includes('set_analysis_target'));

    const resources = await client.listResources();
    assert.ok(resources.resources.some((resource) => resource.uri === 'throughline://about'));
  } finally {
    await close();
  }
});

test('server get_analysis_target and about_throughline return structured facts', async () => {
  const cache = new GraphCache('/repo', async () => clone(sampleGraph), 'default');
  await cache.init();
  const { client, close } = await connectTestClient(cache);

  try {
    const target = await client.callTool({ name: 'get_analysis_target', arguments: {} });
    const targetFacts = target.structuredContent as {
      repoPath: string;
      resolved_from: string;
      ready: boolean;
      counts: { contracts: number };
    };
    assert.equal(targetFacts.repoPath, '/repo');
    assert.equal(targetFacts.resolved_from, 'default');
    assert.equal(targetFacts.ready, true);
    assert.equal(targetFacts.counts.contracts, 1);

    const about = await client.callTool({ name: 'about_throughline', arguments: {} });
    const aboutFacts = about.structuredContent as {
      summary: string;
      trustTiers: Record<string, string>;
      recommendedWorkflow: string[];
      limits: string[];
      readOnlyGuarantee: string;
    };
    assert.match(aboutFacts.summary, /contract-centric/i);
    assert.match(aboutFacts.trustTiers.asserted, /trust me/i);
    assert.ok(aboutFacts.recommendedWorkflow.some((step) => step.includes('set_analysis_target')));
    assert.ok(aboutFacts.limits.some((limit) => limit.includes('Python')));
    assert.match(aboutFacts.readOnlyGuarantee, /grounded in disk analysis/i);
  } finally {
    await close();
  }
});

test('server set_analysis_target reports tool errors for invalid paths', async () => {
  const cache = new GraphCache('/repo', async () => clone(sampleGraph), 'argv');
  await cache.init();
  const { client, close } = await connectTestClient(cache);

  try {
    const result = await client.callTool({
      name: 'set_analysis_target',
      arguments: { path: '/definitely/not/a/real/repo' },
    });
    const content = result.content as Array<{ type: string; text?: string }>;
    assert.equal(result.isError, true);
    assert.match(content[0].type === 'text' ? content[0].text ?? '' : '', /does not exist/);
    assert.equal(cache.graph.repoPath, '/repo');
  } finally {
    await close();
  }
});
