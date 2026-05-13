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

### `qwen_context_digest`

Compresses pasted/provided context into a task-focused digest.

Prefer `qwen_files_digest` when the content already exists in files.

### `qwen_files_digest`

Reads local files or globs inside the MCP process and asks Qwen to summarize them for a specific task. This is the main context-offload tool because Codex can pass paths instead of loading huge files into its own context first.

Use this only for small or narrowed digests that should finish inside the MCP client's tool-call timeout.

### `qwen_files_digest_async`

Starts a file/glob digest as a background job and returns a `job_id` immediately. Use this for real-world repository scans, long logs, or thinking-enabled digests that may take more than 120 seconds.

### `qwen_job_status`

Polls a background job and reports whether it is `running`, `completed`, or `failed`.

### `qwen_job_result`

Fetches the final text from a completed background job. Pass `clear: true` when the result is no longer needed.

### `qwen_code_review`

Asks Qwen for an independent code review of code, diffs, or focused file bundles.

### `qwen_refine_code`

Sends Qwen original code plus Codex feedback and asks it to refine the implementation.

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
QWEN_MAX_TOTAL_BYTES = "1200000"
QWEN_MAX_FILE_BYTES = "240000"
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
QWEN_MAX_TOTAL_BYTES = "1200000"
QWEN_MAX_FILE_BYTES = "240000"
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
| `QWEN_MAX_TOTAL_BYTES` | `1200000` | Default max total bytes read by file digest calls. |
| `QWEN_MAX_FILE_BYTES` | `240000` | Default max bytes per file read by file digest calls. |
| `QWEN_HARD_MAX_TOTAL_BYTES` | `8000000` | Hard cap for file digest input size. |
| `QWEN_JOB_TTL_MS` | `3600000` | How long completed/failed background jobs stay in memory. |

## Async Digest Workflow

For large jobs, avoid holding a single MCP call open:

1. Call `qwen_files_digest_async`.
2. Keep the returned `job_id`.
3. Poll `qwen_job_status` every 20-60 seconds.
4. When the job is `completed`, call `qwen_job_result`.

Background jobs live in the MCP server process memory. They are lost if Codex restarts the MCP server.

## Suggested Codex Usage Policy

Add this to your personal Codex instructions if you want Codex to proactively use the bridge:

```markdown
When a coding or agentic task has broad context, many files, long logs, draft-code generation, or a useful second-review pass, check the `qwen-local` MCP server with `qwen_status`. Use it when online; skip it without blocking when offline.

Prefer `qwen_files_digest_async` for large file sets so Codex does not need to load all file contents into its own context or hold a single MCP call open past the client timeout. Use synchronous `qwen_files_digest` only for small narrowed inputs. Use `qwen_chat`, `qwen_code_review`, and `qwen_refine_code` for secondary planning, independent review, and Qwen-to-Codex-to-Qwen refinement. Treat Qwen output as advisory and verify important claims in source files before editing or reporting.
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
