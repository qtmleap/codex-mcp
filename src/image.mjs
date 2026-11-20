import { constants } from 'node:fs';
import { mkdir, open, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { openaiBaseUrl } from './openai-base-url.mjs';
import { resolveWorkspace } from './workspace.mjs';

const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const maxBytes = 8 * 1024 * 1024;
const maxEncodedLength = 4 * Math.ceil(maxBytes / 3);
// Allow space for the JSON-RPC envelope, prompt and padded base64 parts.
export const imageRequestLimit = maxEncodedLength + 512 * 1024;
const sizeError = 'Reference images must total at most 8 MiB';
const reference = z.union([
  z.strictObject({ path: z.string().min(1).max(4096) }),
  z.strictObject({
    mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    data: z.string().min(1).max(maxEncodedLength),
  }),
]);

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(pngSignature)) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Expected a PNG, JPEG or WebP reference image');
}

async function readWorkspaceImage(path, config, remaining) {
  const canonical = await realpath(resolve(config.root, path));
  const parent = await resolveWorkspace(dirname(canonical), config.root, config.mountedRoots);
  const file = await open(join(parent.cwd, basename(canonical)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Reference path must name a regular file');
    if (info.size > remaining) throw new Error(sizeError);
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Reference file changed while being read');
      offset += bytesRead;
    }
    return bytes;
  } finally {
    await file.close();
  }
}

async function editBody(fields, references, config) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, String(value));
  let remaining = maxBytes;
  for (const [index, input] of references.entries()) {
    let bytes;
    if ('path' in input) {
      bytes = await readWorkspaceImage(input.path, config, remaining);
    } else {
      if (input.data.length > 4 * Math.ceil(remaining / 3)) throw new Error(sizeError);
      bytes = Buffer.from(input.data, 'base64');
      if (bytes.length > remaining) throw new Error(sizeError);
      if (bytes.toString('base64') !== input.data) throw new Error('Invalid reference image base64');
    }
    const type = imageType(bytes);
    if (input.mime_type && input.mime_type !== type) throw new Error('Reference MIME type does not match the image');
    const extension = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length);
    form.append('image[]', new Blob([bytes], { type }), `reference-${index + 1}.${extension}`);
    remaining -= bytes.length;
  }
  return form;
}

export function registerImage(server, config, success, failed, requestSignal) {
  server.registerTool('generate_image', {
    description: 'Generate a PNG, optionally guided by ordered reference images. Returns a file path on the MCP host.',
    inputSchema: {
      prompt: z.string().trim().min(1).max(32000),
      reference_images: z.array(reference).max(16).optional().describe(
        'Up to 16 PNG, JPEG or WebP images, 8 MiB total. Use a path under a mounted MCP-host workspace, or mime_type and raw base64 data for a client attachment. Order is preserved.',
      ),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ prompt, reference_images = [] }, extra) => {
    try {
      if (!config.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is required');
      const fields = { model: config.env.CODEX_MCP_IMAGE_MODEL || 'gpt-image-2', prompt, n: 1 };
      const headers = { authorization: 'Bearer ' + config.env.OPENAI_API_KEY };
      let endpoint = 'generations';
      let body;
      if (reference_images.length) {
        endpoint = 'edits';
        body = await editBody({ ...fields, output_format: 'png' }, reference_images, config);
      } else {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(fields);
      }
      const response = await fetch(openaiBaseUrl(config.env.CODEX_MCP_BASE_URL) + '/images/' + endpoint, {
        method: 'POST', redirect: 'error', headers, body,
        signal: AbortSignal.any([requestSignal(extra), AbortSignal.timeout(180000)]),
      });
      if (!response.ok) {
        const hint = [401, 403].includes(response.status) ? ' Check the API key and its permission for this endpoint.' : '';
        throw new Error(`Images API returned HTTP ${response.status} for POST /images/${endpoint}.${hint}`);
      }
      const { data } = await response.json();
      const encoded = data?.[0]?.b64_json;
      const bytes = typeof encoded === 'string' ? Buffer.from(encoded, 'base64') : null;
      if (!bytes?.subarray(0, 8).equals(pngSignature)) throw new Error('Images API did not return a PNG');
      await mkdir(config.imagesDir, { recursive: true, mode: 0o700 });
      const path = join(config.imagesDir, randomUUID() + '.png');
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
      return success({ path });
    } catch (error) {
      return failed(error, config);
    }
  });
}
