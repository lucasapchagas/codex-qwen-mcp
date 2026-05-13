# codex-qwen-mcp

Local MCP bridge that lets Codex use a locally running Qwen model through a llama.cpp/OpenAI-compatible server.

The original target is Qwen 3.6 running at:

```text
http://localhost:8081
```

The bridge is designed for three workflows:

1. **Context offload**: let Qwen read and digest large file sets or logs so Codex can keep its own context focused.
2. **Ping-pong review**: ask Qwen to draft or refine code, then have Codex audit it, then send concrete feedback back to Qwen.
3. **Local helper agent**: use Qwen for secondary planning, code review, broad codebase analysis, and agentic side tasks when the local server is online.

## How It Works

This project runs a local stdio MCP server. Codex starts it as a child process, then calls its tools. The MCP server talks to Qwen through the llama.cpp OpenAI-compatible API:

```text
GET  /v1/models
POST /v1/chat/completions
```

Every Qwen tool first checks whether the local server is reachable. If Qwen is offline, the tool returns a clear MCP error instead of blocking the Codex task.

Some MCP clients time out a single tool call after roughly 120 seconds. For slow large-context digests, use the async job workflow: start `qwen_files_digest_async`, poll `qwen_job_status`, then fetch the completed text with `qwen_job_result`.

Async jobs use `QWEN_ASYNC_TIMEOUT_MS` instead of the normal `QWEN_TIMEOUT_MS`, so the MCP call can return immediately while the local Qwen HTTP request continues in the background.

Qwen thinking is enabled by default. The bridge sends:

```json
{
  "chat_template_kwargs": {
    "enable_thinking": true
  }
}
```

When Qwen returns hidden reasoning as `reasoning_content`, the MCP bridge strips it from the normal tool response and returns only the final `content`. This preserves Qwen's reasoning quality without filling Codex's context with the hidden chain of thought. Thinking still costs local generation time and completion tokens, so the bridge gives thinking-enabled calls a larger token budget.

If Qwen spends the whole completion budget thinking and never emits final `content`, the bridge returns a short diagnostic instead of exposing hidden reasoning. Increase `max_tokens`, raise `QWEN_THINKING_MIN_MAX_TOKENS`, narrow the task, or disable thinking for that specific call.

## Tools

### `qwen_status`

Checks whether the local Qwen server is online and reports model metadata.

### `qwen_chat`

Asks Qwen a direct question. Use for secondary reasoning, planning, draft code, or alternative implementation ideas.

Thinking is always enabled for this tool and cannot be disabled by tool arguments. Hidden reasoning is stripped from MCP output.

### `qwen_image_chat`

Sends a local image file to Qwen for multimodal analysis. The MCP server reads the file path, normalizes orientation, resizes large images, converts the image to PNG, and sends it as a data URL to Qwen. This supports formats such as WebP even when llama.cpp rejects the original image format.

### `qwen_context_digest`

Compresses pasted/provided context into a task-focused digest.

Prefer `qwen_files_digest` when the content already exists in files.

### `qwen_files_digest`

Reads local files or globs inside the MCP process and asks Qwen to summarize them for a specific task. This is the main context-offload tool because Codex can pass paths instead of loading huge files into its own context first.

Use this only for small or narrowed digests that should finish inside the MCP client's tool-call timeout.

Text-based PDFs are supported: the bridge extracts embedded PDF text before sending context to Qwen. Scanned/image-only PDFs still need OCR and will be reported as having no extractable text.

### `qwen_files_digest_async`

Starts a file/glob digest as a background job and returns a `job_id` immediately. Use this for real-world repository scans, long logs, or thinking-enabled digests that may take more than 120 seconds.

### `qwen_job_status`

Polls a background job and reports whether it is `running`, `completed`, or `failed`.

### `qwen_job_result`

Fetches the final text from a completed background job. Pass `clear: true` when the result is no longer needed.

### `qwen_code_review`

Asks Qwen for an independent code review of code, diffs, or focused file bundles.

Thinking is always enabled for this tool and cannot be disabled by tool arguments. Hidden reasoning is stripped from MCP output.

### `qwen_refine_code`

Sends Qwen original code plus Codex feedback and asks it to refine the implementation.

Thinking is always enabled for this tool and cannot be disabled by tool arguments. Hidden reasoning is stripped from MCP output.

## Requirements

- Node.js 20+
- npm
- A local llama.cpp server or compatible OpenAI-style server
- Codex with MCP server configuration support

## Install

```powershell
git clone https://github.com/YOUR-USERNAME/codex-qwen-mcp.git
cd codex-qwen-mcp
npm install
```

## Smoke Test

Start your local Qwen server, then run:

```powershell
npm run smoke
```

Expected output includes:

```json
{
  "online": true,
  "content": "qwen-online"
}
```

## Codex Configuration

Add this to your Codex `config.toml`.

On Windows:

```toml
[mcp_servers."qwen-local"]
command = 'C:\Program Files\nodejs\node.exe'
args = ['D:\Repos\codex-qwen-mcp\src\index.mjs']

[mcp_servers."qwen-local".env]
QWEN_BASE_URL = "http://localhost:8081"
QWEN_ENABLE_THINKING = "true"
QWEN_THINKING_MIN_MAX_TOKENS = "8192"
QWEN_ASYNC_TIMEOUT_MS = "900000"
QWEN_MAX_TOTAL_BYTES = "1200000"
QWEN_MAX_FILE_BYTES = "240000"
QWEN_MAX_PDF_BYTES = "20000000"
QWEN_MAX_IMAGE_BYTES = "20000000"
QWEN_IMAGE_MAX_DIMENSION = "2048"
```

On macOS/Linux:

```toml
[mcp_servers."qwen-local"]
command = 'node'
args = ['/path/to/codex-qwen-mcp/src/index.mjs']

[mcp_servers."qwen-local".env]
QWEN_BASE_URL = "http://localhost:8081"
QWEN_ENABLE_THINKING = "true"
QWEN_THINKING_MIN_MAX_TOKENS = "8192"
QWEN_ASYNC_TIMEOUT_MS = "900000"
QWEN_MAX_TOTAL_BYTES = "1200000"
QWEN_MAX_FILE_BYTES = "240000"
QWEN_MAX_PDF_BYTES = "20000000"
QWEN_MAX_IMAGE_BYTES = "20000000"
QWEN_IMAGE_MAX_DIMENSION = "2048"
```

Restart or reload Codex after changing MCP config.

## Environment Variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `QWEN_BASE_URL` | `http://localhost:8081` | Base URL for the local Qwen server. |
| `QWEN_MODEL` | First model from `/v1/models` | Optional explicit model id. |
| `QWEN_ENABLE_THINKING` | `true` | Enables Qwen thinking by default. |
| `QWEN_THINKING_MIN_MAX_TOKENS` | `8192` | Minimum completion budget when thinking is enabled. |
| `QWEN_MAX_TOKENS` | `4096` | Default completion budget before thinking minimum is applied. |
| `QWEN_TIMEOUT_MS` | `120000` | HTTP timeout for Qwen calls. |
| `QWEN_ASYNC_TIMEOUT_MS` | `900000` | HTTP timeout for background async Qwen jobs. |
| `QWEN_MAX_TOTAL_BYTES` | `1200000` | Default max total bytes read by file digest calls. |
| `QWEN_MAX_FILE_BYTES` | `240000` | Default max bytes per text file, or extracted text bytes per PDF, read by file digest calls. |
| `QWEN_MAX_PDF_BYTES` | `20000000` | Default max raw PDF file size accepted for text extraction. |
| `QWEN_MAX_IMAGE_BYTES` | `20000000` | Default max raw image file size accepted by image chat calls. |
| `QWEN_IMAGE_MAX_DIMENSION` | `2048` | Max width or height sent to Qwen after image normalization. |
| `QWEN_HARD_MAX_TOTAL_BYTES` | `8000000` | Hard cap for file digest input size. |
| `QWEN_HARD_MAX_PDF_BYTES` | `100000000` | Hard cap for raw PDF file size accepted by tool input. |
| `QWEN_HARD_MAX_IMAGE_BYTES` | `100000000` | Hard cap for raw image file size accepted by tool input. |
| `QWEN_JOB_TTL_MS` | `3600000` | How long completed/failed background jobs stay in memory. |

## Async Digest Workflow

For large jobs, avoid holding a single MCP call open:

1. Discover paths without reading target file contents. Good examples: `rg --files`, `git diff --name-only`, directory listings, or known paths from the user.
2. Call `qwen_files_digest_async` with paths/globs, `cwd`, `task`, and optional `focus`.
3. Keep the returned `job_id`.
4. Poll `qwen_job_status` every 20-60 seconds.
5. When the job is `completed`, call `qwen_job_result`.
6. Use the digest as a map, then inspect only the specific source sections needed to verify claims and implement changes.

Avoid pre-reading target file contents with `cat`, `Get-Content`, `rg` content searches, `sed`, `nl`, or similar tools when the goal is context offload. If Codex reads the files first, the MCP bridge cannot undo that context cost.

If a job still fails with `request timed out`, increase `QWEN_ASYNC_TIMEOUT_MS` or pass `timeout_ms` directly to `qwen_files_digest_async`.

Background jobs live in the MCP server process memory. They are lost if Codex restarts the MCP server.

## Suggested Codex Usage Policy

Add this to your personal Codex instructions if you want Codex to proactively use the bridge:

```markdown
When a coding or agentic task has broad context, many files, long logs, draft-code generation, or a useful second-review pass, check the `qwen-local` MCP server with `qwen_status`. Use it when online; skip it without blocking when offline.

Prefer `qwen_files_digest_async` for large file sets so Codex does not need to load all file contents into its own context or hold a single MCP call open past the client timeout. For first-pass context offload, do not read target file contents before calling Qwen; use path-only discovery and pass paths/globs directly. Use synchronous `qwen_files_digest` only for small narrowed inputs. Use `qwen_chat`, `qwen_code_review`, and `qwen_refine_code` for secondary planning, independent review, and Qwen-to-Codex-to-Qwen refinement. Treat Qwen output as advisory and verify important claims in source files before editing or reporting.
```

## Development

Run syntax validation:

```powershell
node --check src/index.mjs
```

Run the server manually:

```powershell
npm start
```

The MCP server uses stdio, so normal MCP clients should start it directly instead of calling it over HTTP.
