import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { loadConfig } from '../src/config.mjs';
import { startHttp } from '../src/server.mjs';

// Real, one-pixel images exercise format recognition without an image dependency.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mPQsooCAAFQAL/Rfn3VAAAAAElFTkSuQmCC', 'base64');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCcAKIr/9k=', 'base64');
const webp = Buffer.from('UklGRjIAAABXRUJQVlA4ICYAAABQAQCdASoBAAEAAUAmJQBOgCgAAP74BD/UT2Ed94S4NkimuwAAAA==', 'base64');
const limit = 8 * 1024 * 1024;
const inline = (mime_type, bytes) => ({mime_type, data: bytes.toString('base64')});

// Insert a valid ancillary text chunk immediately before IEND, yielding an
// exact decoded byte count while remaining a complete, readable PNG.
function pngOfSize(size) {
  const length = size - png.length - 12;
  const chunk = Buffer.alloc(length + 12, 0x61);
  chunk.writeUInt32BE(length);
  chunk.write('tEXtNote\0', 4, 'ascii');
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
}

async function fixture(t, mode = 'http') {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'codex-image-refs-')));
  const root = join(dir, 'workspace');
  const mount = join(dir, 'assets');
  const outputs = join(dir, 'outputs');
  await Promise.all([mkdir(root), mkdir(mount)]);
  const requests = [];
  const upstream = createServer(async (req, res) => {
    try {
      const body = new Response(req, {headers: req.headers});
      const record = {url: req.url, method: req.method, auth: req.headers.authorization};
      requests.push(record);
      if (req.headers['content-type']?.startsWith('multipart/form-data')) {
        const form = await body.formData();
        record.fields = Object.fromEntries([...form].filter(([, part]) => typeof part === 'string'));
        record.files = [];
        for (const [field, part] of form) {
          if (typeof part === 'string') continue;
          record.files.push({field, name: part.name, type: part.type, bytes: Buffer.from(await part.arrayBuffer())});
        }
      } else record.fields = await body.json();
      res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({data: [{b64_json: png.toString('base64')}]}));
    } catch (error) {
      res.writeHead(400);
      res.end(error.message);
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const config = loadConfig({
    PORT: '0', CLAUDE_MCP_WORKSPACE: root, CLAUDE_MCP_MOUNTED_ROOTS: [root, mount].join(','),
    CLAUDE_MCP_JOB_DIR: join(dir, 'state'), CODEX_MCP_IMAGE_MODEL: 'fixture-image-model',
    CODEX_MCP_BASE_URL: `http://127.0.0.1:${upstream.address().port}/v1`, OPENAI_API_KEY: 'fixture-image-key',
  });
  const app = mode === 'http' ? await startHttp({...config, codex: true, imagesDir: outputs}) : null;
  const transport = app
    ? new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.port}/mcp`))
    : new StdioClientTransport({
        command: process.execPath, args: [fileURLToPath(new URL('../src/main.mjs', import.meta.url)), '--transport', 'stdio'],
        env: {...config.env, CODEX_MCP_IMAGES_DIR: outputs, CODEX_MCP_ENV_FILE: join(dir, 'empty.env')}, stderr: 'pipe',
      });
  const client = new Client({name: 'reference-image-test', version: '1'});
  t.after(async () => {
    await client.close();
    await app?.close();
    await new Promise(resolve => upstream.close(resolve));
    await rm(dir, {recursive: true, force: true});
  });
  await client.connect(transport);
  const call = args => client.callTool({name: 'generate_image', arguments: {prompt: 'Match this character', ...args}});
  return {client, call, dir, root, mount, outputs, requests};
}

test('tools/list advertises ordered, optional image references', async t => {
  const {client} = await fixture(t);
  const {tools} = await client.listTools();
  const tool = tools.find(tool => tool.name === 'generate_image');
  const schema = tool.inputSchema;
  assert.equal(schema.properties.reference_images?.type, 'array');
  assert.equal(schema.properties.reference_images.maxItems, 16);
  assert.ok(schema.required.includes('prompt'));
  assert.ok(!schema.required.includes('reference_images'));
  for (const field of ['mime_type', 'data', 'path', 'image/jpeg', 'image/png', 'image/webp']) {
    assert.ok(JSON.stringify(schema.properties.reference_images.items).includes(JSON.stringify(field)), field);
  }
});

test('mixed inline, relative and mounted absolute references arrive in order as multipart image files', async t => {
  const {call, root, mount, outputs, requests} = await fixture(t);
  const big = pngOfSize(640 * 1024);
  await writeFile(join(root, 'portrait.jpeg'), jpeg);
  const card = join(mount, 'card.webp');
  await writeFile(card, webp);
  const result = await call({reference_images: [inline('image/png', big), {path: 'portrait.jpeg'}, {path: card}]});
  assert.ok(!result.isError, 'Expected a successful SDK call larger than 512 KiB');
  assert.equal(requests.length, 1);
  const [up] = requests;
  assert.equal(up.method, 'POST');
  assert.equal(up.url, '/v1/images/edits');
  assert.equal(up.auth, 'Bearer fixture-image-key');
  assert.deepEqual(up.fields, {prompt: 'Match this character', model: 'fixture-image-model', n: '1', output_format: 'png'});
  assert.deepEqual(up.files.map(file => file.field), ['image[]', 'image[]', 'image[]']);
  assert.deepEqual(up.files.map(file => file.type), ['image/png', 'image/jpeg', 'image/webp']);
  assert.equal(up.files[0].name, 'reference-1.png');
  assert.match(up.files[1].name, /^reference-2\.jpe?g$/);
  assert.equal(up.files[2].name, 'reference-3.webp');
  assert.deepEqual(up.files.map(file => file.bytes), [big, jpeg, webp]);
  assert.equal(dirname(result.structuredContent.path), outputs);
  assert.deepEqual(await readFile(result.structuredContent.path), png);
});

test('absent or empty references retain prompt-only JSON generation and path result', async t => {
  const {call, requests, outputs} = await fixture(t);
  for (const args of [{}, {reference_images: []}]) {
    const result = await call(args);
    assert.ok(!result.isError);
    assert.equal(dirname(result.structuredContent.path), outputs);
    assert.deepEqual(await readFile(result.structuredContent.path), png);
  }
  assert.equal(requests.length, 2);
  for (const req of requests) {
    assert.equal(req.url, '/v1/images/generations');
    assert.deepEqual(req.fields, {model: 'fixture-image-model', prompt: 'Match this character', n: 1, output_format: 'png'});
    assert.equal(req.files, undefined);
  }
});

test('invalid choices, noncanonical base64 and mismatching image signatures are rejected before upload', async t => {
  const {call, root, requests} = await fixture(t);
  await writeFile(join(root, 'broken.png'), 'not an image');
  const canonical = webp.toString('base64');
  const noncanonical = canonical.slice(0, -3) + 'B==';
  assert.deepEqual(Buffer.from(noncanonical, 'base64'), webp, 'Fixture should differ only in unused base64 pad bits');
  const rejected = [
    ['non-array', inline('image/png', png)], ['missing source', [{}]],
    ['partial inline source', [{mime_type: 'image/png'}]],
    ['mixed sources', [{path: 'broken.png', ...inline('image/png', png)}]],
    ['unsupported MIME', [inline('image/gif', png)]],
    ['whitespace in base64', [{mime_type: 'image/webp', data: canonical + '\n'}]],
    ['invalid base64', [{mime_type: 'image/png', data: 'image!'}]],
    ['base64 pad bits', [{mime_type: 'image/webp', data: noncanonical}]],
    ['declared MIME mismatch', [inline('image/png', jpeg)]],
    ['invalid file signature', [{path: 'broken.png'}]],
    ['too many references', Array(17).fill(inline('image/png', png))],
  ];
  for (const [label, refs] of rejected) {
    const result = await call({reference_images: refs});
    assert.equal(result.isError, true, label);
  }
  assert.equal(requests.length, 0);
});

test('path references stay inside a mounted workspace, including symlink targets', async t => {
  const {call, dir, root, requests} = await fixture(t);
  const outside = join(dir, 'outside.png');
  await writeFile(outside, png);
  await symlink(outside, join(root, 'external.png'));
  for (const path of [outside, '../outside.png', 'external.png', '.']) {
    const result = await call({reference_images: [{path}]});
    assert.equal(result.isError, true, path);
  }
  assert.equal(requests.length, 0);
});

test('the decoded byte budget counts all sources and accepts its exact limit', async t => {
  const {call, root, requests} = await fixture(t);
  const size = limit - webp.length;
  const path = join(root, 'large.png');
  const refs = [{path}, inline('image/webp', webp)];
  await writeFile(path, pngOfSize(size));
  const exact = await call({reference_images: refs});
  assert.ok(!exact.isError, 'exactly 8 MiB of images should fit');
  assert.deepEqual(requests[0].files.map(file => file.bytes.length), [size, webp.length]);
  await writeFile(path, pngOfSize(size + 1));
  const over = await call({reference_images: refs});
  assert.equal(over.isError, true, 'an extra decoded byte across two sources should fail');
  assert.equal(requests.length, 1);
});

test('sixteen references are accepted in one edit', async t => {
  const {call, requests} = await fixture(t);
  const result = await call({reference_images: Array(16).fill(inline('image/png', png))});
  assert.ok(!result.isError);
  assert.deepEqual(requests[0].files.map(file => file.name), Array.from({length: 16}, (_, i) => `reference-${i + 1}.png`));
});

test('stdio edits one reference and produces a single output PNG', async t => {
  const {call, outputs, requests} = await fixture(t, 'stdio');
  const result = await call({reference_images: [inline('image/webp', webp)]});
  assert.ok(!result.isError);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/v1/images/edits');
  assert.equal(requests[0].fields.n, '1');
  assert.deepEqual(requests[0].files, [{field: 'image[]', name: 'reference-1.webp', type: 'image/webp', bytes: webp}]);
  const files = await readdir(outputs);
  assert.equal(files.length, 1);
  assert.equal(result.structuredContent.path, join(outputs, files[0]));
  assert.deepEqual(await readFile(result.structuredContent.path), png);
});

test('an initialized HTTP session retains the 512 KiB limit for non-image tools', async t => {
  const {client, requests} = await fixture(t);
  await assert.rejects(client.callTool({name: 'review_code', arguments: {diff: 'x'.repeat(512 * 1024)}}),
    error => error.code === 413);
  assert.equal(requests.length, 0);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'generate_image'));
});
