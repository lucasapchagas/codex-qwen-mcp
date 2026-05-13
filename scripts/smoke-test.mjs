#!/usr/bin/env node

const baseUrl = (process.env.QWEN_BASE_URL ?? "http://localhost:8081").replace(/\/+$/, "");
const enableThinking = (process.env.QWEN_ENABLE_THINKING ?? "true").toLowerCase() !== "false";
const maxTokens = enableThinking
  ? Number.parseInt(process.env.QWEN_THINKING_MIN_MAX_TOKENS ?? "1024", 10)
  : 32;

const modelsResponse = await fetch(`${baseUrl}/v1/models`);
if (!modelsResponse.ok) {
  throw new Error(`models failed: ${modelsResponse.status} ${modelsResponse.statusText}`);
}
const models = await modelsResponse.json();
const model = models?.data?.[0]?.id ?? models?.models?.[0]?.model ?? models?.models?.[0]?.name;

const chatResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: "Final answer must be exactly qwen-online and no explanation." }],
    max_tokens: maxTokens,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: enableThinking }
  })
});

if (!chatResponse.ok) {
  throw new Error(`chat failed: ${chatResponse.status} ${chatResponse.statusText}`);
}

const chat = await chatResponse.json();
console.log(JSON.stringify({
  online: true,
  model,
  content: chat?.choices?.[0]?.message?.content ?? "",
  usage: chat?.usage
}, null, 2));
