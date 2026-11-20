#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const binary = process.env.CODEX_MCP_BINARY || 'codex';
const option = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
const emit = value => console.log(JSON.stringify(value));
const ownId = option('--session-id') || option('--resume');
const fail = message => {
  emit({ type: 'result', subtype: 'error', is_error: true, errors: [message], session_id: ownId });
  process.exitCode = 1;
};

async function run() {
  if (args.includes('--version')) {
    const child = spawn(binary, ['--version'], { stdio: 'inherit' });
    return new Promise(resolve => {
      child.once('error', () => { process.exitCode = 1; resolve(); });
      child.once('close', code => { process.exitCode = code ?? 1; resolve(); });
    });
  }
  if (!process.env.OPENAI_API_KEY) return fail('OPENAI_API_KEY is required');
  if (option('--max-budget-usd')) return fail('Codex CLI does not enforce a per-call USD budget');

  const persistent = Boolean(ownId);
  const home = persistent ? process.env.CLAUDE_CONFIG_DIR : await mkdtemp(join(tmpdir(), 'codex-mcp-'));
  try {
    const marker = join(home, 'codex-thread-id');
    const resuming = Boolean(option('--resume'));
    const thread = resuming ? (await readFile(marker, 'utf8')).trim() : null;
    if (resuming && !/^[0-9a-f-]{36}$/i.test(thread)) return fail('Invalid Codex thread ID');
    const mode = option('--permission-mode');
    const sandbox = args.includes('--bare') || mode !== 'acceptEdits' ? 'read-only' : 'workspace-write';
    const flags = [
      '-a', 'never', '-c', 'model_provider="openai_platform"',
      '-c', 'model_providers.openai_platform={name="OpenAI Platform",base_url="https://api.openai.com/v1",env_key="OPENAI_API_KEY",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}',
      '-c', 'web_search="disabled"',
      '-c', 'shell_environment_policy.exclude=["OPENAI_API_KEY","CODEX_MCP_TOKEN","CLAUDE_MCP_TOKEN"]',
      '-c', 'sandbox_mode="'+sandbox+'"', 'exec', ...(resuming ? ['resume'] : []),
      '--json', '--skip-git-repo-check', ...(!persistent ? ['--ephemeral'] : []),
    ];
    const model = option('--model') || process.env.CODEX_MCP_DEFAULT_MODEL || 'gpt-5.4';
    flags.push('--model', model);
    const roots = args.filter(value => value.startsWith('--add-dir=')).map(value => value.slice(10));
    if (sandbox === 'workspace-write' && roots.length) {
      flags.push('-c', 'sandbox_workspace_write.writable_roots=' + JSON.stringify(roots));
    }
    if (thread) flags.push(thread);
    flags.push('-');
    const env = { ...process.env, CODEX_HOME: home };
    delete env.CODEX_ACCESS_TOKEN;
    delete env.CODEX_API_KEY;
    delete env.OPENAI_BASE_URL;
    const child = spawn(binary, flags, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    const exited = new Promise(resolve => {
      child.once('error', () => resolve(null));
      child.once('close', resolve);
    });
    const instruction = option('--append-system-prompt');
    child.stdin.on('error', () => {});
    if (instruction) child.stdin.write(instruction + '\n\n');
    process.stdin.pipe(child.stdin);
    let answer, usage, threadId, failed;
    for await (const line of createInterface({ input: child.stdout })) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type === 'thread.started') threadId = event.thread_id;
      if (event.type === 'turn.failed') failed = true;
      if (event.type === 'turn.completed') usage = event.usage;
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        answer = event.item.text;
        if (args.includes('stream-json')) {
          emit({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } });
        }
      }
    }
    const code = await exited;
    if (code !== 0 || failed || typeof answer !== 'string') return fail('Codex execution failed; check the API key, model access, and workspace permissions');
    if (persistent) {
      if (typeof threadId !== 'string' || !/^[0-9a-f-]{36}$/i.test(threadId) || (thread && threadId !== thread)) {
        return fail('Codex returned an unexpected thread ID');
      }
      await writeFile(marker, threadId, { mode: 0o600 });
    }
    emit({ type: 'result', subtype: 'success', is_error: false, result: answer, session_id: ownId,
      usage: usage && { ...usage, cache_read_input_tokens: usage.cached_input_tokens } });
  } finally {
    if (!persistent) await rm(home, { recursive: true, force: true });
  }
}

run().catch(() => fail('Codex CLI adapter failed'));
