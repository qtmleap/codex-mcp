import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openaiBaseUrl } from '../src/openai-base-url.mjs';
test('normalizes the default and configured base URLs',()=>{
 assert.equal(openaiBaseUrl(), 'https://api.openai.com/v1');
 assert.equal(openaiBaseUrl('https://ai.qleap.jp/v1/'), 'https://ai.qleap.jp/v1');
});
test('rejects credential-bearing and malformed URLs without echoing them',()=>{
 for(const url of ['https://user:secret@example.com/v1','https://example.com/v1?key=secret','https://example.com/#secret','file:///secret','not-a-url']) {
  assert.throws(()=>openaiBaseUrl(url),e=>e.message==='Invalid CODEX_MCP_BASE_URL');
 }
});

test('Compose lets the optional environment file supply the API base URL', async () => {
 const { readFile } = await import('node:fs/promises');
 const compose = await readFile(new URL('../compose.yaml', import.meta.url), 'utf8');
 assert.doesNotMatch(compose, /^\s+CODEX_MCP_BASE_URL:/m);
 assert.match(compose, /env_file:/);
});
