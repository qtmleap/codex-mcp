# codex-mcp

Codex CLI MCP server derived from [qtmleap/claude-mcp](https://github.com/qtmleap/claude-mcp).
Worker calls use a separate ChatGPT login or an OpenAI Platform API key.
The Codex client connecting to this MCP keeps its own authentication.

## Tools

| Tools | Behavior |
| --- | --- |
| `models`, `execution_context` | Discover models and probe the configured workspace or execution profile |
| `ask`, `start_job`, `get_job`, `list_jobs`, `cancel_job`, `delete_job` | Run and manage Codex jobs using the same receipt, polling, cancellation, and idempotency interface as Claude MCP |
| `review_code` | Submit a supplied diff for read-only review |
| `generate_image` | Generate a PNG with optional reference images and return its path on the MCP host |

Use `review:true` with `ask` for workspace-based reviews. Local review sessions
can opt into continuation with `resumable:true` and an explicit model, then
continue with `resume_job_id`. Default execution is read-only. To allow edits
under the configured workspace, set `CODEX_MCP_PERMISSION_MODE=acceptEdits`.
Review mode remains read-only. Codex does not expose the Claude-specific
per-invocation USD budget cap, so calls specifying `max_budget_usd` fail
before a model request.

## Run

For native setup, install dependencies and run the test script with Bun. The
server runs on Node.js 22 or newer and requires Codex CLI on PATH. Set
`CODEX_MCP_BINARY`
to an absolute executable path if needed. For API billing, set
`OPENAI_API_KEY` in the process environment or a mode-600
`~/.config/codex-mcp/env` file. For subscription usage, sign in to a dedicated
Codex home without setting the API key:

```sh
mkdir -p -m 700 "$HOME/.local/state/codex-mcp/auth"
CODEX_HOME="$HOME/.local/state/codex-mcp/auth" \
  codex -c 'cli_auth_credentials_store="file"' login --device-auth
```

```sh
bun install
bun run test
node src/main.mjs --transport stdio
```

Register stdio from the checkout with:

```sh
codex mcp add codex-mcp -- "$(command -v node)" "$PWD/src/main.mjs" --transport stdio
```

For a local HTTP service:

```sh
node src/main.mjs --transport http
codex mcp add codex-mcp --url http://127.0.0.1:8879/mcp
```

For Docker, use the same loopback endpoint:

```sh
docker compose up -d --build
```

An exported `OPENAI_API_KEY` takes precedence over a key in the optional
`~/.config/codex-mcp/env` file. If neither is set, log in once in the container:

```sh
docker compose exec codex-mcp \
  codex -c 'cli_auth_credentials_store="file"' login --device-auth
```

The Docker state volume retains the login across container recreation. Recreate
the container after changing the API key. A failed API-key request remains on
the API route. Start a fresh review session after changing authentication mode.
Image generation uses the Images API and requires an API key.

For an OpenAI-compatible API, set `CODEX_MCP_BASE_URL=https://ai.qleap.jp/v1`
and set `OPENAI_API_KEY` to the provider's key. The base URL is used for
Codex API requests, model discovery, and image generation. It defaults to
`https://api.openai.com/v1`; include the API path such as `/v1`.
The provider must support the Responses API for Codex and the Images API
for image generation. The setting does not change subscription login routing.
For Docker Compose, set `CODEX_MCP_BASE_URL` in the optional
`~/.config/codex-mcp/env` file (or the file selected by
`CODEX_MCP_HOST_ENV_FILE`) and recreate the container after changing it. Do not put credentials in the URL.

The working directory defaults to the current directory for native runs and
`/workspace` in Docker. Configure `CODEX_MCP_WORKSPACE`,
`CODEX_MCP_HOST_WORKSPACE`, or `CODEX_MCP_MOUNTED_ROOTS` when required.
Docker execution profiles are opt-in via `compose.docker.yaml`. Select the
Codex adapter executable as the profile's CLI and provide Codex CLI on its PATH.
The profile containers must have Node.js installed.

For HTTP, `CODEX_MCP_TOKEN` is an optional separate MCP bearer token.
With it enabled, supply the token using the client's bearer-token environment
variable setting. The health endpoint is `/healthz` and makes no API calls.
Docker publishes the MCP endpoint on loopback.

Images default to `gpt-image-2` and the native
`~/.local/share/codex-mcp/images` directory. Docker stores them in
`/state/images` inside the named state volume. Set
`CODEX_MCP_IMAGE_MODEL` and `CODEX_MCP_IMAGES_DIR` to override them.

Pass `reference_images` to guide a generation with up to 16 PNG, JPEG or WebP
images (8 MiB total before base64 encoding). The list is ordered, so a prompt
can refer to “the first image” and “the second image.” For example:

```json
{
  "prompt": "Use the first image for the pose and the second for the outfit.",
  "reference_images": [
    {"path": "art/pose.png"},
    {"path": "art/outfit.webp"}
  ]
}
```

Paths are relative to the MCP host's workspace or absolute inside its mounted
roots. For an attachment on another machine, supply an object such as
`{"mime_type":"image/png","data":"<base64-encoded file contents>"}` in the
same list. The data field takes plain padded base64. The provider must support
multipart `POST /images/edits` for reference inputs. Omitting the list or passing
an empty list uses the existing `POST /images/generations` request.
