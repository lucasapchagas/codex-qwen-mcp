#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import fg from "fast-glob";
import { PDFParse } from "pdf-parse";
import sharp from "sharp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const DEFAULT_BASE_URL = "http://localhost:8081";
const BASE_URL = normalizeBaseUrl(process.env.QWEN_BASE_URL ?? DEFAULT_BASE_URL);
const DEFAULT_MODEL = process.env.QWEN_MODEL ?? "";
const DEFAULT_TIMEOUT_MS = parseIntEnv("QWEN_TIMEOUT_MS", 120000);
const DEFAULT_ASYNC_TIMEOUT_MS = parseIntEnv("QWEN_ASYNC_TIMEOUT_MS", 15 * 60 * 1000);
const DEFAULT_MAX_TOKENS = parseIntEnv("QWEN_MAX_TOKENS", 4096);
const DEFAULT_ENABLE_THINKING = parseBoolEnv("QWEN_ENABLE_THINKING", true);
const THINKING_MIN_MAX_TOKENS = parseIntEnv("QWEN_THINKING_MIN_MAX_TOKENS", 8192);
const DEFAULT_TEMPERATURE = parseFloatEnv("QWEN_TEMPERATURE", 0.2);
const DEFAULT_MAX_TOTAL_BYTES = parseIntEnv("QWEN_MAX_TOTAL_BYTES", 1_200_000);
const DEFAULT_MAX_FILE_BYTES = parseIntEnv("QWEN_MAX_FILE_BYTES", 240_000);
const DEFAULT_MAX_PDF_BYTES = parseIntEnv("QWEN_MAX_PDF_BYTES", 20_000_000);
const DEFAULT_MAX_IMAGE_BYTES = parseIntEnv("QWEN_MAX_IMAGE_BYTES", 20_000_000);
const DEFAULT_IMAGE_MAX_DIMENSION = parseIntEnv("QWEN_IMAGE_MAX_DIMENSION", 2048);
const HARD_MAX_TOTAL_BYTES = parseIntEnv("QWEN_HARD_MAX_TOTAL_BYTES", 8_000_000);
const HARD_MAX_PDF_BYTES = parseIntEnv("QWEN_HARD_MAX_PDF_BYTES", 100_000_000);
const HARD_MAX_IMAGE_BYTES = parseIntEnv("QWEN_HARD_MAX_IMAGE_BYTES", 100_000_000);
const JOB_TTL_MS = parseIntEnv("QWEN_JOB_TTL_MS", 60 * 60 * 1000);

const jobs = new Map();

const IGNORE_GLOBS = [
  "**/.git/**",
  "**/node_modules/**",
  "**/.next/**",
  "**/dist/**",
  "**/build/**",
  "**/target/**",
  "**/.venv/**",
  "**/venv/**",
  "**/__pycache__/**",
  "**/*.png",
  "**/*.jpg",
  "**/*.jpeg",
  "**/*.gif",
  "**/*.webp",
  "**/*.ico",
  "**/*.zip",
  "**/*.7z",
  "**/*.gz",
  "**/*.tar",
  "**/*.exe",
  "**/*.dll",
  "**/*.bin",
  "**/*.gguf"
];

const server = new McpServer(
  {
    name: "codex-qwen-local",
    version: "0.1.0"
  },
  {
    instructions:
      "Use these tools only when the local Qwen llama.cpp server is available. Prefer file/path based digest tools for large context so the main model does not need to load full file contents."
  }
);

server.registerTool(
  "qwen_status",
  {
    description:
      "Check whether the local Qwen llama.cpp server is online and list available models/context metadata.",
    inputSchema: z.object({})
  },
  async () => {
    const status = await getStatus();
    return textResult(JSON.stringify(status, null, 2), !status.online);
  }
);

server.registerTool(
  "qwen_chat",
  {
    description:
      "Ask local Qwen a direct question. Good for secondary reasoning, code generation drafts, and agentic planning when the server is online.",
    inputSchema: z.object({
      prompt: z.string().min(1),
      system: z.string().optional(),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      max_tokens: z.number().int().positive().max(65536).optional(),
      enable_thinking: z.boolean().optional(),
      include_reasoning: z.boolean().optional()
    })
  },
  async (args) => {
    return guardedQwenCall(async () => {
      const completion = await chatCompletion({
        messages: buildMessages(args.system, args.prompt),
        model: args.model,
        temperature: args.temperature,
        maxTokens: args.max_tokens,
      enableThinking: args.enable_thinking ?? DEFAULT_ENABLE_THINKING
      });
      return textResult(extractMessageText(completion, args.include_reasoning ?? false));
    });
  }
);

server.registerTool(
  "qwen_context_digest",
  {
    description:
      "Compress pasted or provided long context into a structured digest for Codex. Prefer qwen_files_digest when the context exists in files.",
    inputSchema: z.object({
      content: z.string().min(1),
      task: z.string().min(1),
      focus: z.string().optional(),
      enable_thinking: z.boolean().optional(),
      max_tokens: z.number().int().positive().max(65536).optional()
    })
  },
  async (args) => {
    return guardedQwenCall(async () => {
      const prompt = digestPrompt(args.task, args.focus, args.content);
      const completion = await chatCompletion({
        messages: buildMessages(digestSystemPrompt(), prompt),
        maxTokens: args.max_tokens ?? 2048,
        temperature: 0.1,
        enableThinking: args.enable_thinking ?? DEFAULT_ENABLE_THINKING
      });
      return textResult(extractMessageText(completion, false));
    });
  }
);

server.registerTool(
  "qwen_image_chat",
  {
    description:
      "Send a local image to Qwen for multimodal analysis. The MCP server reads the image path, converts formats such as WebP to PNG, optionally resizes large images, and sends only the normalized image to Qwen.",
    inputSchema: z.object({
      image_path: z.string().min(1),
      prompt: z.string().min(1).default("Describe this image in detail."),
      system: z.string().optional(),
      cwd: z.string().optional(),
      model: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
      max_tokens: z.number().int().positive().max(65536).optional(),
      enable_thinking: z.boolean().optional(),
      include_reasoning: z.boolean().optional(),
      max_image_bytes: z.number().int().positive().max(HARD_MAX_IMAGE_BYTES).optional(),
      max_dimension: z.number().int().positive().max(8192).optional()
    })
  },
  async (args) => {
    return guardedQwenCall(async () => {
      const image = await normalizeImageForQwen(args.image_path, {
        cwd: args.cwd,
        maxImageBytes: args.max_image_bytes ?? DEFAULT_MAX_IMAGE_BYTES,
        maxDimension: args.max_dimension ?? DEFAULT_IMAGE_MAX_DIMENSION
      });
      const completion = await chatCompletion({
        messages: buildImageMessages(args.system, args.prompt, image.dataUrl),
        model: args.model,
        temperature: args.temperature,
        maxTokens: args.max_tokens ?? 1024,
        enableThinking: args.enable_thinking ?? false
      });
      const response = extractMessageText(completion, args.include_reasoning ?? false);
      return textResult(
        `${response}\n\n[image: ${image.relativePath || image.path}, original=${image.originalBytes} bytes ${image.originalFormat || "unknown"} ${image.originalWidth || "?"}x${image.originalHeight || "?"}, sent=PNG ${image.outputBytes} bytes ${image.outputWidth || "?"}x${image.outputHeight || "?"}]`
      );
    });
  }
);

server.registerTool(
  "qwen_files_digest",
  {
    description:
      "Read local files or globs inside the MCP process and ask Qwen to produce a compact, task-focused digest. Use this to offload large codebase context without first loading file bodies into Codex.",
    inputSchema: z.object({
      paths: z.array(z.string().min(1)).min(1),
      task: z.string().min(1),
      focus: z.string().optional(),
      cwd: z.string().optional(),
      max_total_bytes: z.number().int().positive().max(HARD_MAX_TOTAL_BYTES).optional(),
      max_file_bytes: z.number().int().positive().max(HARD_MAX_TOTAL_BYTES).optional(),
      max_pdf_bytes: z.number().int().positive().max(HARD_MAX_PDF_BYTES).optional(),
      enable_thinking: z.boolean().optional(),
      max_tokens: z.number().int().positive().max(65536).optional(),
      timeout_ms: z.number().int().positive().max(60 * 60 * 1000).optional()
    })
  },
  async (args) => {
    return guardedQwenCall(async () => {
      return textResult(await qwenFilesDigestText(args));
    });
  }
);

server.registerTool(
  "qwen_files_digest_async",
  {
    description:
      "Start a long-running file/glob digest as a background job and return immediately. Use this instead of qwen_files_digest when Qwen may exceed the MCP client's tool-call timeout.",
    inputSchema: z.object({
      paths: z.array(z.string().min(1)).min(1),
      task: z.string().min(1),
      focus: z.string().optional(),
      cwd: z.string().optional(),
      max_total_bytes: z.number().int().positive().max(HARD_MAX_TOTAL_BYTES).optional(),
      max_file_bytes: z.number().int().positive().max(HARD_MAX_TOTAL_BYTES).optional(),
      max_pdf_bytes: z.number().int().positive().max(HARD_MAX_PDF_BYTES).optional(),
      enable_thinking: z.boolean().optional(),
      max_tokens: z.number().int().positive().max(65536).optional(),
      timeout_ms: z.number().int().positive().max(60 * 60 * 1000).optional()
    })
  },
  async (args) => {
    const status = await getStatus();
    if (!status.online) {
      return textResult(
        `Qwen server is offline or unreachable at ${BASE_URL}. Details: ${status.error}`,
        true
      );
    }

    const job = startJob("qwen_files_digest", summarizeFilesDigestArgs(args), async () => {
      return qwenFilesDigestText(args, {
        timeoutMs: args.timeout_ms ?? DEFAULT_ASYNC_TIMEOUT_MS
      });
    });

    return textResult(
      JSON.stringify(
        {
          job_id: job.id,
          status: job.status,
          kind: job.kind,
          started_at: job.started_at,
          message:
            "Digest job started. Poll qwen_job_status with this job_id, then call qwen_job_result when status is completed."
        },
        null,
        2
      )
    );
  }
);

server.registerTool(
  "qwen_job_status",
  {
    description:
      "Check the status of a background Qwen job started by qwen_files_digest_async.",
    inputSchema: z.object({
      job_id: z.string().min(1),
      include_result: z.boolean().optional()
    })
  },
  async ({ job_id, include_result = false }) => {
    cleanupJobs();
    const job = jobs.get(job_id);
    if (!job) {
      return textResult(`No Qwen job found for id: ${job_id}`, true);
    }
    return textResult(JSON.stringify(serializeJob(job, include_result), null, 2), job.status === "failed");
  }
);

server.registerTool(
  "qwen_job_result",
  {
    description:
      "Fetch the final result for a completed Qwen background job.",
    inputSchema: z.object({
      job_id: z.string().min(1),
      clear: z.boolean().optional()
    })
  },
  async ({ job_id, clear = false }) => {
    cleanupJobs();
    const job = jobs.get(job_id);
    if (!job) {
      return textResult(`No Qwen job found for id: ${job_id}`, true);
    }
    if (job.status === "running") {
      return textResult(
        `Qwen job ${job_id} is still running. Started at ${job.started_at}. Poll qwen_job_status later.`,
        true
      );
    }
    if (job.status === "failed") {
      return textResult(`Qwen job ${job_id} failed:\n${job.error}`, true);
    }
    const result = job.result ?? "(empty result)";
    if (clear) {
      jobs.delete(job_id);
    }
    return textResult(result);
  }
);

server.registerTool(
  "qwen_code_review",
  {
    description:
      "Ask Qwen for an independent code review of code, diffs, or file bundles. Codex should audit the result before trusting it.",
    inputSchema: z.object({
      code_or_diff: z.string().min(1),
      review_goal: z.string().default("Find correctness bugs, regressions, security risks, and missing tests."),
      max_tokens: z.number().int().positive().max(65536).optional(),
      enable_thinking: z.boolean().optional()
    })
  },
  async (args) => {
    return guardedQwenCall(async () => {
      const completion = await chatCompletion({
        messages: buildMessages(
          "You are an independent senior code reviewer. Prioritize concrete bugs with file/line references when possible. Do not praise. If no serious issue is found, say so and list residual risks.",
          `Review goal: ${args.review_goal}\n\nCode or diff:\n${args.code_or_diff}`
        ),
        maxTokens: args.max_tokens ?? 4096,
        temperature: 0.1,
        enableThinking: args.enable_thinking ?? DEFAULT_ENABLE_THINKING
      });
      return textResult(extractMessageText(completion, false));
    });
  }
);

server.registerTool(
  "qwen_refine_code",
  {
    description:
      "Ask Qwen to refine previously generated code using Codex/GPT feedback. Useful for the Qwen -> Codex audit -> Qwen refine ping-pong workflow.",
    inputSchema: z.object({
      original_code: z.string().min(1),
      feedback: z.string().min(1),
      constraints: z.string().optional(),
      max_tokens: z.number().int().positive().max(65536).optional(),
      enable_thinking: z.boolean().optional()
    })
  },
  async (args) => {
    return guardedQwenCall(async () => {
      const prompt = [
        "Revise the code according to the feedback.",
        args.constraints ? `Constraints:\n${args.constraints}` : "",
        `Feedback:\n${args.feedback}`,
        `Original code:\n${args.original_code}`,
        "Return the refined code first, then a short changelog."
      ]
        .filter(Boolean)
        .join("\n\n");

      const completion = await chatCompletion({
        messages: buildMessages("You are a careful coding agent that applies review feedback precisely.", prompt),
        maxTokens: args.max_tokens ?? 8192,
        temperature: 0.15,
        enableThinking: args.enable_thinking ?? DEFAULT_ENABLE_THINKING
      });
      return textResult(extractMessageText(completion, false));
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`codex-qwen-local MCP server running on stdio; Qwen base URL: ${BASE_URL}`);
}

main().catch((error) => {
  console.error("Fatal MCP server error:", error);
  process.exit(1);
});

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function parseIntEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseFloatEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function textResult(text, isError = false) {
  return {
    isError,
    content: [{ type: "text", text: text || "(empty response)" }]
  };
}

function startJob(kind, inputSummary, fn) {
  cleanupJobs();
  const now = new Date().toISOString();
  const job = {
    id: randomUUID(),
    kind,
    status: "running",
    input_summary: inputSummary,
    started_at: now,
    updated_at: now,
    result: undefined,
    error: undefined
  };
  jobs.set(job.id, job);

  Promise.resolve()
    .then(fn)
    .then((result) => {
      job.status = "completed";
      job.result = result;
      job.updated_at = new Date().toISOString();
    })
    .catch((error) => {
      job.status = "failed";
      job.error = error?.stack || error?.message || String(error);
      job.updated_at = new Date().toISOString();
    });

  return job;
}

function cleanupJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    const updatedAt = Date.parse(job.updated_at);
    if (Number.isFinite(updatedAt) && updatedAt < cutoff) {
      jobs.delete(id);
    }
  }
}

function serializeJob(job, includeResult) {
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    input_summary: job.input_summary,
    started_at: job.started_at,
    updated_at: job.updated_at,
    result: includeResult && job.status === "completed" ? job.result : undefined,
    error: job.status === "failed" ? job.error : undefined
  };
}

function summarizeFilesDigestArgs(args) {
  return {
    paths: args.paths,
    cwd: args.cwd ?? process.cwd(),
    task: args.task,
    focus: args.focus,
    max_total_bytes: args.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES,
    max_file_bytes: args.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES,
    max_pdf_bytes: args.max_pdf_bytes ?? DEFAULT_MAX_PDF_BYTES,
    enable_thinking: args.enable_thinking ?? DEFAULT_ENABLE_THINKING,
    max_tokens: args.max_tokens ?? 3072,
    timeout_ms: args.timeout_ms ?? DEFAULT_ASYNC_TIMEOUT_MS
  };
}

async function guardedQwenCall(fn) {
  const status = await getStatus();
  if (!status.online) {
    return textResult(
      `Qwen server is offline or unreachable at ${BASE_URL}. Details: ${status.error}`,
      true
    );
  }
  try {
    return await fn();
  } catch (error) {
    return textResult(`Qwen call failed: ${error.message}`, true);
  }
}

async function getStatus() {
  try {
    const data = await requestJson("/v1/models", { method: "GET", timeoutMs: 5000 });
    const models = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : [];
    return {
      online: true,
      base_url: BASE_URL,
      default_model: DEFAULT_MODEL || models[0]?.id || models[0]?.model || models[0]?.name || "",
      models: models.map((model) => ({
        id: model.id ?? model.model ?? model.name ?? "",
        context_train_tokens: model.meta?.n_ctx_train,
        parameters: model.meta?.n_params,
        size_bytes: model.meta?.size,
        capabilities: model.capabilities
      }))
    };
  } catch (error) {
    return { online: false, base_url: BASE_URL, error: error.message };
  }
}

function buildMessages(system, prompt) {
  const messages = [];
  if (system) {
    messages.push({ role: "system", content: system });
  }
  messages.push({ role: "user", content: prompt });
  return messages;
}

function buildImageMessages(system, prompt, dataUrl) {
  const messages = [];
  if (system) {
    messages.push({ role: "system", content: system });
  }
  messages.push({
    role: "user",
    content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: dataUrl } }
    ]
  });
  return messages;
}

async function chatCompletion({
  messages,
  model,
  temperature = DEFAULT_TEMPERATURE,
  maxTokens = DEFAULT_MAX_TOKENS,
  enableThinking = DEFAULT_ENABLE_THINKING,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  const status = await getStatus();
  const resolvedModel = (model ?? DEFAULT_MODEL) || status.default_model;
  const body = {
    messages,
    temperature,
    max_tokens: enableThinking ? Math.max(maxTokens, THINKING_MIN_MAX_TOKENS) : maxTokens,
    chat_template_kwargs: {
      enable_thinking: enableThinking
    }
  };
  if (resolvedModel) {
    body.model = resolvedModel;
  }
  return requestJson("/v1/chat/completions", {
    method: "POST",
    body,
    timeoutMs
  });
}

async function qwenFilesDigestText(args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const bundle = await readPathBundle(args.paths, {
    cwd: args.cwd,
    maxTotalBytes: args.max_total_bytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxFileBytes: args.max_file_bytes ?? DEFAULT_MAX_FILE_BYTES,
    maxPdfBytes: args.max_pdf_bytes ?? DEFAULT_MAX_PDF_BYTES
  });

  const prompt = digestPrompt(
    args.task,
    args.focus,
    `${bundle.summary}\n\n${bundle.content}`
  );
  const completion = await chatCompletion({
    messages: buildMessages(digestSystemPrompt(), prompt),
    maxTokens: args.max_tokens ?? 3072,
    temperature: 0.1,
    enableThinking: args.enable_thinking ?? DEFAULT_ENABLE_THINKING,
    timeoutMs
  });
  return extractMessageText(completion, false);
}

async function requestJson(endpoint, { method, body, timeoutMs }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1000)}`);
    }
    return text ? JSON.parse(text) : {};
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractMessageText(completion, includeReasoning) {
  const message = completion?.choices?.[0]?.message ?? {};
  const content = normalizeContent(message.content);
  const reasoning = normalizeContent(message.reasoning_content);
  const finish = completion?.choices?.[0]?.finish_reason;
  const usage = completion?.usage
    ? `\n\n[usage: prompt=${completion.usage.prompt_tokens ?? "?"}, completion=${completion.usage.completion_tokens ?? "?"}, finish=${finish ?? "?"}]`
    : "";

  if (includeReasoning && reasoning) {
    return `${content || "(no final content)"}\n\n[reasoning]\n${reasoning}${usage}`;
  }
  if (content) {
    return `${content}${usage}`;
  }
  if (reasoning) {
    return `(Qwen returned hidden reasoning but no final content before the token budget ended. Retry with larger max_tokens, a higher QWEN_THINKING_MIN_MAX_TOKENS, a narrower task, or enable_thinking=false for that call.)${usage}`;
  }
  return `(empty Qwen response)${usage}`;
}

function normalizeContent(content) {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text ?? ""))
      .join("")
      .trim();
  }
  return "";
}

function digestSystemPrompt() {
  return [
    "You compress large technical context for another coding agent.",
    "Return a dense, accurate digest with these sections:",
    "1. Task-relevant facts",
    "2. Architecture and control flow",
    "3. APIs, types, files, and symbols to preserve",
    "4. Risks, edge cases, and likely bugs",
    "5. Recommended next actions",
    "Keep quotations short. Prefer concrete filenames, functions, invariants, and decisions over broad summary."
  ].join("\n");
}

function digestPrompt(task, focus, content) {
  return [
    `Task: ${task}`,
    focus ? `Focus: ${focus}` : "",
    "Context follows. Digest it for a coding agent that cannot keep all of it in its own context window.",
    content
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function readPathBundle(patterns, { cwd, maxTotalBytes, maxFileBytes, maxPdfBytes }) {
  const base = path.resolve(cwd ?? process.cwd());
  const resolved = await expandPatterns(patterns, base);
  let totalBytes = 0;
  const parts = [];
  const skipped = [];

  for (const filePath of resolved) {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      skipped.push(`${filePath}: stat failed (${error.message})`);
      continue;
    }
    if (!stat.isFile()) {
      skipped.push(`${filePath}: not a file`);
      continue;
    }
    const isPdf = filePath.toLowerCase().endsWith(".pdf");
    if (!isPdf && stat.size > maxFileBytes) {
      skipped.push(`${filePath}: ${stat.size} bytes exceeds max_file_bytes ${maxFileBytes}`);
      continue;
    }
    if (isPdf && stat.size > maxPdfBytes) {
      skipped.push(`${filePath}: PDF size ${stat.size} bytes exceeds max_pdf_bytes ${maxPdfBytes}`);
      continue;
    }

    let buffer;
    try {
      buffer = await fs.readFile(filePath);
    } catch (error) {
      skipped.push(`${filePath}: read failed (${error.message})`);
      continue;
    }
    if (isPdf) {
      const extracted = await extractPdfText(buffer, filePath, skipped);
      if (!extracted) {
        continue;
      }
      const textBytes = Buffer.byteLength(extracted, "utf8");
      if (textBytes > maxFileBytes) {
        skipped.push(`${filePath}: extracted PDF text ${textBytes} bytes exceeds max_file_bytes ${maxFileBytes}`);
        continue;
      }
      if (totalBytes + textBytes > maxTotalBytes) {
        skipped.push(`${filePath}: skipped because extracted PDF text would exceed max_total_bytes ${maxTotalBytes}`);
        continue;
      }
      totalBytes += textBytes;
      const rel = path.relative(base, filePath) || path.basename(filePath);
      parts.push(`\n\n--- FILE: ${rel} (${textBytes} extracted text bytes from ${buffer.length} PDF bytes) ---\n${extracted}`);
      continue;
    }

    if (totalBytes + buffer.length > maxTotalBytes) {
      skipped.push(`${filePath}: skipped because max_total_bytes ${maxTotalBytes} would be exceeded`);
      continue;
    }
    if (looksBinary(buffer)) {
      skipped.push(`${filePath}: binary-looking content`);
      continue;
    }
    totalBytes += buffer.length;
    const rel = path.relative(base, filePath) || path.basename(filePath);
    parts.push(`\n\n--- FILE: ${rel} (${buffer.length} bytes) ---\n${buffer.toString("utf8")}`);
  }

  return {
    summary: [
      `Base directory: ${base}`,
      `Files included: ${parts.length}`,
      `Bytes included: ${totalBytes}`,
      skipped.length ? `Skipped:\n${skipped.map((item) => `- ${item}`).join("\n")}` : "Skipped: none"
    ].join("\n"),
    content: parts.join("")
  };
}

async function extractPdfText(buffer, filePath, skipped) {
  let parser;
  try {
    parser = new PDFParse({ data: buffer });
    const result = await parser.getText();
    const text = (result.text ?? "").trim();
    if (!text) {
      skipped.push(`${filePath}: PDF text extraction returned no text; OCR may be required for scanned/image PDFs`);
      return "";
    }
    return text;
  } catch (error) {
    skipped.push(`${filePath}: PDF text extraction failed (${error.message})`);
    return "";
  } finally {
    if (parser) {
      await parser.destroy().catch(() => {});
    }
  }
}

async function normalizeImageForQwen(imagePath, { cwd, maxImageBytes, maxDimension }) {
  const base = path.resolve(cwd ?? process.cwd());
  const resolved = path.isAbsolute(imagePath)
    ? path.resolve(imagePath)
    : path.resolve(base, imagePath);
  const stat = await fs.stat(resolved);
  if (!stat.isFile()) {
    throw new Error(`${resolved} is not a file`);
  }
  if (stat.size > maxImageBytes) {
    throw new Error(`${resolved} is ${stat.size} bytes, exceeding max_image_bytes ${maxImageBytes}`);
  }

  const input = await fs.readFile(resolved);
  const pipeline = sharp(input, { failOn: "none" }).rotate();
  const metadata = await pipeline.metadata();
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  const longest = Math.max(width, height);
  if (longest > maxDimension) {
    pipeline.resize({
      width: width >= height ? maxDimension : undefined,
      height: height > width ? maxDimension : undefined,
      fit: "inside",
      withoutEnlargement: true
    });
  }

  const output = await pipeline.png().toBuffer();
  const outputMeta = await sharp(output).metadata();
  return {
    path: resolved,
    relativePath: path.relative(base, resolved),
    originalBytes: stat.size,
    outputBytes: output.length,
    originalFormat: metadata.format,
    originalWidth: width,
    originalHeight: height,
    outputWidth: outputMeta.width,
    outputHeight: outputMeta.height,
    dataUrl: `data:image/png;base64,${output.toString("base64")}`
  };
}

async function expandPatterns(patterns, cwd) {
  const files = new Set();
  for (const pattern of patterns) {
    const normalizedPattern = pattern.replaceAll("\\", "/");
    const hasMagic = fg.isDynamicPattern(normalizedPattern);
    if (path.isAbsolute(pattern) && !hasMagic) {
      files.add(path.resolve(pattern));
      continue;
    }
    const matches = await fg(normalizedPattern, {
      cwd,
      absolute: true,
      onlyFiles: true,
      dot: true,
      ignore: IGNORE_GLOBS,
      unique: true
    });
    for (const match of matches) {
      files.add(path.resolve(match));
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b));
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  if (sample.includes(0)) return true;
  const text = sample.toString("utf8");
  return text.includes("\uFFFD");
}

export const __dirname = path.dirname(fileURLToPath(import.meta.url));
