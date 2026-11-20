import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('Codex MCP exposes the job interface, runs a read-only review, and resumes its Codex thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-mcp-test-'));
  const binary = join(root, 'mock-codex');
  const fixture = `#!${process.execPath}
const args = process.argv.slice(2);
const id = '12345678-1234-1234-1234-123456789abc';
if (!args.includes('sandbox_mode="read-only"') ||
    !args.some(arg => arg.includes('env_key="OPENAI_API_KEY"')) ||
    (args.includes('resume') && !args.includes(id)) ||
    process.env.OPENAI_API_KEY !== 'synthetic-test-key') process.exit(2);
process.stdin.resume();
process.stdin.on('end', () => {
  for (const event of [
    { type: 'thread.started', thread_id: id },
    { type: 'item.completed', item: { type: 'agent_message', text: 'review complete' } },
    { type: 'turn.completed', usage: { input_tokens: 2, output_tokens: 3 } },
  ]) console.log(JSON.stringify(event));
});
`;
  await writeFile(binary, fixture);
  await chmod(binary, 0o700);
  const client = new Client({ name: 'codex-adapter-test', version: '1' });
  try {
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: ['src/main.mjs', '--transport', 'stdio'],
      env: { ...process.env, CODEX_MCP_WORKSPACE: root, CODEX_MCP_JOB_DIR: join(root, 'jobs'),
        CODEX_MCP_BINARY: binary, OPENAI_API_KEY: 'synthetic-test-key' },
    }));
    assert.equal(client.getServerVersion().name, 'codex-mcp');
    const tools = (await client.listTools()).tools.map(tool => tool.name);
    assert.ok(tools.includes('generate_image') && tools.includes('review_code'));
    const first = await client.callTool({ name: 'ask', arguments: {
      prompt: 'Review this change', review: true, resumable: true, model: 'gpt-5.4',
    } });
    assert.equal(first.structuredContent.answer, 'review complete');
    assert.equal(first.structuredContent.session.resume_available, true);
    const second = await client.callTool({ name: 'ask', arguments: {
      prompt: 'Check the second change', resume_job_id: first.structuredContent.job_id,
    } });
    assert.equal(second.structuredContent.answer, 'review complete');
  } finally {
    await client.close();
    await rm(root, { force: true, recursive: true });
  }
});
