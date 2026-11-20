import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';

export function registerImage(server, config, success, failed, requestSignal) {
  server.registerTool('generate_image', {
    description: 'Generate one PNG with the OpenAI Images API. Returns a file path on the MCP host.',
    inputSchema: { prompt: z.string().trim().min(1).max(32000) },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ prompt }, extra) => {
    try {
      if (!config.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: 'Bearer ' + config.env.OPENAI_API_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ model: config.env.CODEX_MCP_IMAGE_MODEL || 'gpt-image-2', prompt, n: 1, output_format: 'png' }),
        signal: AbortSignal.any([requestSignal(extra), AbortSignal.timeout(180000)]),
      });
      if (!response.ok) throw new Error('Images API returned HTTP ' + response.status);
      const { data } = await response.json();
      if (!data?.[0]?.b64_json) throw new Error('Images API did not return a PNG');
      await mkdir(config.imagesDir, { recursive: true, mode: 0o700 });
      const path = join(config.imagesDir, randomUUID() + '.png');
      await writeFile(path, Buffer.from(data[0].b64_json, 'base64'), { flag: 'wx', mode: 0o600 });
      return success({ path });
    } catch (error) {
      return failed(error, config);
    }
  });
}
