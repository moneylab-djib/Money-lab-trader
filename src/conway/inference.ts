/**
 * Conway Inference Client
 *
 * Wraps Conway's /v1/chat/completions endpoint (OpenAI-compatible).
 * The automaton pays for its own thinking through Conway credits.
 */

import fs from "fs";
import { createLogger } from "../observability/logger.js";
import Anthropic from "@anthropic-ai/sdk";
import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
  InferenceToolDefinition,
} from "../types.js";
import { ResilientHttpClient } from "./http-client.js";

const logger = createLogger("inference");
const INFERENCE_TIMEOUT_MS = 60_000;

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  /** Optional registry lookup — if provided, used before name heuristics */
  getModelProvider?: (modelId: string) => string | undefined;
  /** Anthropic effort level (output_config.effort); omitted = model default. */
  anthropicEffort?: AnthropicEffort;
  /** Offer Anthropic's server-side web search and web fetch tools. */
  anthropicWebTools?: boolean;
}

type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

type InferenceBackend = "conway" | "openai" | "anthropic" | "ollama";

function isLoopbackHttpUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    return parsed.protocol.toLowerCase() === "http:" &&
      (host === "localhost" || host === "127.0.0.1" || host === "::1");
  } catch {
    return false;
  }
}

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const { apiUrl, apiKey, openaiApiKey, anthropicApiKey, ollamaBaseUrl, getModelProvider } = options;
  const httpClient = new ResilientHttpClient({
    baseTimeout: INFERENCE_TIMEOUT_MS,
    retryableStatuses: [429, 500, 502, 503, 504],
    allowHttpOnLoopback: isLoopbackHttpUrl(ollamaBaseUrl),
  });
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    const backend = resolveInferenceBackend(model, {
      openaiApiKey,
      anthropicApiKey,
      ollamaBaseUrl,
      getModelProvider,
    });

    // Newer models (o-series, gpt-5.x, gpt-4.1) require max_completion_tokens.
    // Ollama always uses max_tokens.
    const usesCompletionTokens =
      backend !== "ollama" && /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model);
    const tokenLimit = opts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    if (backend === "anthropic") {
      return chatViaAnthropic({
        model,
        tokenLimit,
        messages,
        tools,
        temperature: opts?.temperature,
        anthropicApiKey: anthropicApiKey as string,
        effort: options.anthropicEffort,
        webTools: options.anthropicWebTools,
        signal: (opts as { signal?: AbortSignal } | undefined)?.signal,
      });
    }

    const openAiLikeApiUrl =
      backend === "openai" ? "https://api.openai.com" :
      backend === "ollama" ? (ollamaBaseUrl as string).replace(/\/$/, "") :
      apiUrl;
    const openAiLikeApiKey =
      backend === "openai" ? (openaiApiKey as string) :
      backend === "ollama" ? "ollama" :
      apiKey;

    return chatViaOpenAiCompatible({
      model,
      body,
      apiUrl: openAiLikeApiUrl,
      apiKey: openAiLikeApiKey,
      backend,
      httpClient,
    });
  };

  /**
   * @deprecated Use InferenceRouter for tier-based model selection.
   * Still functional as a fallback; router takes priority when available.
   */
  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "gpt-5-mini";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}

function formatMessage(
  msg: ChatMessage,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}

/**
 * Resolve which backend to use for a model.
 * When InferenceRouter is available, it uses the model registry's provider field.
 * This function is kept for backward compatibility with direct inference calls.
 */
function resolveInferenceBackend(
  model: string,
  keys: {
    openaiApiKey?: string;
    anthropicApiKey?: string;
    ollamaBaseUrl?: string;
    getModelProvider?: (modelId: string) => string | undefined;
  },
): InferenceBackend {
  // Registry-based routing: most accurate, no name guessing
  if (keys.getModelProvider) {
    const provider = keys.getModelProvider(model);
    if (provider === "ollama" && keys.ollamaBaseUrl) return "ollama";
    if (provider === "anthropic" && keys.anthropicApiKey) return "anthropic";
    if (provider === "openai" && keys.openaiApiKey) return "openai";
    if (provider === "conway") return "conway";
    // provider unknown or key not configured — fall through to heuristics
  }

  // Heuristic fallback (model not in registry yet)
  if (keys.anthropicApiKey && /^claude/i.test(model)) return "anthropic";
  if (keys.openaiApiKey && /^(gpt-[3-9]|gpt-4|gpt-5|o[1-9][-\s.]|o[1-9]$|chatgpt)/i.test(model)) return "openai";
  return "conway";

}

async function chatViaOpenAiCompatible(params: {
  model: string;
  body: Record<string, unknown>;
  apiUrl: string;
  apiKey: string;
  backend: "conway" | "openai" | "ollama";
  httpClient: ResilientHttpClient;
}): Promise<InferenceResponse> {
  const resp = await params.httpClient.request(`${params.apiUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization:
        params.backend === "openai" || params.backend === "ollama"
          ? `Bearer ${params.apiKey}`
          : params.apiKey,
    },
    body: JSON.stringify(params.body),
    timeout: INFERENCE_TIMEOUT_MS,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `Inference error (${params.backend}): ${resp.status}: ${text}`,
    );
  }

  const data = await resp.json() as any;
  const choice = data.choices?.[0];

  if (!choice) {
    throw new Error("No completion choice returned from inference");
  }

  const message = choice.message;
  const usage: TokenUsage = {
    promptTokens: data.usage?.prompt_tokens || 0,
    completionTokens: data.usage?.completion_tokens || 0,
    totalTokens: data.usage?.total_tokens || 0,
  };

  const toolCalls: InferenceToolCall[] | undefined =
    message.tool_calls?.map((tc: any) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: message.role,
      content: message.content || "",
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: choice.finish_reason || "stop",
  };
}

/** Models with the dynamic-filtering web tools (web_search/web_fetch _20260209). */
const ANTHROPIC_WEB_TOOL_MODELS = new Set([
  "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-opus-4-8",
]);
/** Models that accept output_config.effort (Haiku 4.5 rejects it). */
const ANTHROPIC_EFFORT_MODELS = new Set([
  "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-opus-4-8",
]);
const WEB_SEARCH_MAX_USES = 5;
const WEB_FETCH_MAX_USES = 5;
const WEB_FETCH_MAX_TOKENS = 15_000;
/** Web search is billed $10 per 1,000 searches. */
const WEB_SEARCH_CENTS = 1;
const MAX_PAUSE_CONTINUATIONS = 3;

/**
 * Server tool results are not replayed (the loop rebuilds its history from
 * text and client tool calls), so keep a compact trace of what was searched
 * and read: the agent can fetch a source again or cite it later.
 */
function webResearchDigest(content: any[]): string {
  const queries: string[] = [];
  const fetched: string[] = [];
  const sources: string[] = [];
  const errors: string[] = [];
  for (const block of content) {
    if (block?.type === "server_tool_use" && block.name === "web_search" && block.input?.query) {
      queries.push(String(block.input.query));
    }
    if (block?.type === "server_tool_use" && block.name === "web_fetch" && block.input?.url) {
      fetched.push(String(block.input.url));
    }
    if (block?.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content) {
        if (r?.type === "web_search_result" && r.url) sources.push(`${r.title ?? ""} — ${r.url}`);
      }
    }
    // Server tool errors come back as a result whose content is an error
    // object (HTTP 200): surface them instead of dropping them silently.
    if ((block?.type === "web_search_tool_result" || block?.type === "web_fetch_tool_result") &&
      block.content && !Array.isArray(block.content) && block.content.error_code) {
      errors.push(`${block.type === "web_search_tool_result" ? "web_search" : "web_fetch"}: ${block.content.error_code}`);
    }
  }
  if (errors.length) logger.warn(`[WEB TOOLS] ${errors.join("; ")}`);
  if (queries.length + fetched.length === 0) return "";
  return [
    "[Web research this turn]",
    queries.length ? `Searched: ${queries.map((q) => `"${q}"`).join(", ")}` : "",
    fetched.length ? `Read: ${fetched.join(", ")}` : "",
    sources.length ? `Results:\n${sources.slice(0, 10).map((s) => `- ${s}`).join("\n")}` : "",
    errors.length ? `Errors: ${errors.join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

/** Models that accept the server-side refusal fallback in its "default" form. */
const ANTHROPIC_DEFAULT_FALLBACK_MODELS = new Set(["claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1"]);

async function chatViaAnthropic(params: {
  model: string;
  tokenLimit: number;
  messages: ChatMessage[];
  tools?: InferenceToolDefinition[];
  temperature?: number;
  anthropicApiKey: string;
  effort?: AnthropicEffort;
  webTools?: boolean;
  signal?: AbortSignal;
}): Promise<InferenceResponse> {
  const transformed = transformMessagesForAnthropic(params.messages);
  if (transformed.messages.length === 0) {
    throw new Error("Cannot send empty message array to Anthropic API");
  }

  // Thinking blocks are never replayed: the agent loop rebuilds its history
  // every turn, so replaying them would fail the API's history check. The
  // model still thinks within each turn (adaptive thinking is the default).
  const body: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.tokenLimit,
    messages: transformed.messages,
  };
  if (transformed.system) {
    const split = splitVolatileSystem(transformed.system, params.model, transformed.messages);
    if (split) {
      // Stable system blocks, then the history (cached up to its last block),
      // then the live state as a trailing system message: the history is
      // read from the cache on the next turn instead of being re-billed.
      body.system = split.system;
      transformed.messages = [...split.messages, { role: "system", content: split.volatile }];
      body.messages = transformed.messages;
    } else {
      body.system = anthropicSystemBlocks(transformed.system);
    }
  }
  if (params.temperature !== undefined) body.temperature = params.temperature;
  if (params.effort && ANTHROPIC_EFFORT_MODELS.has(params.model)) body.output_config = { effort: params.effort };
  // Server tools first, so the cache breakpoint on the last client tool
  // covers the whole (stable) tool list.
  // Only agent turns (which carry client tools) get them, not summaries.
  const serverTools = params.webTools && (params.tools?.length ?? 0) > 0 && ANTHROPIC_WEB_TOOL_MODELS.has(params.model)
    ? [
      { type: "web_search_20260209", name: "web_search", max_uses: WEB_SEARCH_MAX_USES },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: WEB_FETCH_MAX_USES, max_content_tokens: WEB_FETCH_MAX_TOKENS },
    ]
    : [];
  const clientTools = (params.tools ?? []).map((tool, index, all) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
    // The tool list is identical on every turn: cache it.
    ...(index === all.length - 1 ? { cache_control: { type: "ephemeral" } } : {}),
  }));
  if (serverTools.length + clientTools.length > 0) {
    body.tools = [...serverTools, ...clientTools];
    body.tool_choice = { type: "auto" };
  }
  const betas: string[] = [];
  if (ANTHROPIC_DEFAULT_FALLBACK_MODELS.has(params.model)) {
    // On a safety decline the API re-runs the request on a suitable model.
    body.fallbacks = "default";
    betas.push("server-side-fallback-2026-07-01");
  }

  const client = new Anthropic({ apiKey: params.anthropicApiKey });
  const send = async (requestBody: Record<string, unknown>): Promise<any> => {
    try {
      return await client.beta.messages.create(
        { ...requestBody, ...(betas.length ? { betas } : {}) } as any,
        params.signal ? { signal: params.signal } : undefined,
      );
    } catch (error) {
      if (error instanceof Anthropic.APIError) {
        throw new Error(`Inference error (anthropic): ${error.status}: ${error.message}`);
      }
      throw error;
    }
  };
  let data: any = await send(body);
  const content: any[] = Array.isArray(data.content) ? [...data.content] : [];
  const usageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, searches: 0 };
  const addUsage = (u: any) => {
    usageTotals.input += u?.input_tokens || 0;
    usageTotals.output += u?.output_tokens || 0;
    usageTotals.cacheRead += u?.cache_read_input_tokens || 0;
    usageTotals.cacheWrite += u?.cache_creation_input_tokens || 0;
    usageTotals.searches += u?.server_tool_use?.web_search_requests || 0;
  };
  addUsage(data.usage);
  // A long server-side tool loop (web search/fetch) pauses: re-send the
  // assistant turn as is and the API resumes where it stopped.
  for (let i = 0; data.stop_reason === "pause_turn" && i < MAX_PAUSE_CONTINUATIONS; i++) {
    data = await send({
      ...body,
      messages: [...transformed.messages, { role: "assistant", content: [...content] }],
    });
    if (Array.isArray(data.content)) content.push(...data.content);
    addUsage(data.usage);
  }
  const toolUseBlocks = content.filter((c) => c?.type === "tool_use");
  const toolCalls: InferenceToolCall[] | undefined =
    toolUseBlocks.length > 0
      ? toolUseBlocks.map((tool) => ({
          id: tool.id,
          type: "function" as const,
          function: {
            name: tool.name,
            arguments: JSON.stringify(tool.input || {}),
          },
        }))
      : undefined;

  const research = webResearchDigest(content);
  const textContent = [
    content
      .filter((c) => c?.type === "text")
      .map((block) => String(block.text || ""))
      .join("\n")
      .trim(),
    research,
  ].filter(Boolean).join("\n\n");

  const cacheReadTokens = usageTotals.cacheRead;
  const cacheWriteTokens = usageTotals.cacheWrite;
  const promptTokens = usageTotals.input + cacheReadTokens + cacheWriteTokens;
  const completionTokens = usageTotals.output;
  const usage: TokenUsage = {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    cacheReadTokens,
    cacheWriteTokens,
    serverToolCents: usageTotals.searches * WEB_SEARCH_CENTS,
  };

  if (data.stop_reason === "refusal") {
    // The whole fallback chain declined: report it instead of failing the turn.
    return {
      id: data.id || "",
      model: data.model || params.model,
      message: { role: "assistant", content: textContent || "[refused by the model safety system]" },
      usage,
      finishReason: "refusal",
    };
  }

  if (!textContent && !toolCalls?.length) {
    throw new Error("No completion content returned from anthropic inference");
  }

  return {
    id: data.id || "",
    model: data.model || params.model,
    message: {
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls,
    },
    toolCalls,
    usage,
    finishReason: normalizeAnthropicFinishReason(data.stop_reason),
  };
}

/**
 * Section markers of the agent system prompt (system-prompt.ts) after which
 * the content changes more often: the worklog is rewritten by the agent, and
 * the Money Lab rules carry the live balance. Everything before each marker
 * is cached; a prompt without markers is sent as one uncached block.
 */
const SYSTEM_CACHE_BOUNDARIES = ["--- WORKLOG.md", "--- MONEY LAB RULES"];

/** Start of the per-turn system content (Money Lab rules, skills, live status). */
const VOLATILE_SYSTEM_MARKER = "--- MONEY LAB RULES";
/** Models that accept a role "system" message inside messages (no beta header). */
const MID_CONVERSATION_SYSTEM_MODELS = new Set([
  "claude-sonnet-5-5", "claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-opus-4-8",
]);

export function splitVolatileSystem(
  system: string,
  model: string,
  messages: Array<Record<string, unknown>>,
): { system: Array<Record<string, unknown>>; messages: Array<Record<string, unknown>>; volatile: string } | null {
  const at = system.indexOf(VOLATILE_SYSTEM_MARKER);
  const last = messages[messages.length - 1];
  if (at <= 0 || !MID_CONVERSATION_SYSTEM_MODELS.has(model) || !last || last.role !== "user") return null;
  const blocks = anthropicSystemBlocks(system.slice(0, at));
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: { type: "ephemeral" } };
  const content = typeof last.content === "string"
    ? [{ type: "text", text: last.content }]
    : [...(last.content as Array<Record<string, unknown>>)];
  content[content.length - 1] = { ...content[content.length - 1], cache_control: { type: "ephemeral" } };
  return {
    system: blocks,
    messages: [...messages.slice(0, -1), { ...last, content }],
    volatile: system.slice(at),
  };
}

export function anthropicSystemBlocks(system: string): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  let start = 0;
  for (const marker of SYSTEM_CACHE_BOUNDARIES) {
    const at = system.indexOf(marker, start);
    if (at <= start) continue;
    blocks.push({ type: "text", text: system.slice(start, at), cache_control: { type: "ephemeral" } });
    start = at;
  }
  blocks.push({ type: "text", text: system.slice(start) });
  return blocks;
}

function transformMessagesForAnthropic(
  messages: ChatMessage[],
): { system?: string; messages: Array<Record<string, unknown>> } {
  const systemParts: string[] = [];
  const transformed: Array<Record<string, unknown>> = [];
  // Screenshots (view_page) are sent as images for the most recent results
  // only; older ones stay as text to bound the request size.
  const imageBudget = { remaining: recentImagePaths(messages, MAX_IMAGES_PER_REQUEST) };

  for (const msg of messages) {
    if (msg.role === "system") {
      if (msg.content) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "user") {
      // Merge consecutive user messages
      const last = transformed[transformed.length - 1];
      if (last && last.role === "user" && typeof last.content === "string") {
        last.content = last.content + "\n" + msg.content;
        continue;
      }
      // Text after tool results joins the same user turn, after the results.
      if (last && last.role === "user" && Array.isArray(last.content)) {
        (last.content as Array<Record<string, unknown>>).push({ type: "text", text: msg.content });
        continue;
      }
      transformed.push({
        role: "user",
        content: msg.content,
      });
      continue;
    }

    if (msg.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content && msg.content.trim()) {
        content.push({ type: "text", text: msg.content });
      }
      for (const toolCall of msg.tool_calls || []) {
        content.push({
          type: "tool_use",
          id: toolCall.id,
          name: toolCall.function.name,
          input: parseToolArguments(toolCall.function.arguments),
        });
      }
      if (content.length === 0) {
        continue; // the API rejects empty text blocks
      }
      // Merge consecutive assistant messages
      const last = transformed[transformed.length - 1];
      if (last && last.role === "assistant" && Array.isArray(last.content)) {
        (last.content as Array<Record<string, unknown>>).push(...content);
        continue;
      }
      transformed.push({
        role: "assistant",
        content,
      });
      continue;
    }

    if (msg.role === "tool") {
      // Merge consecutive tool messages into a single user message
      // with multiple tool_result content blocks
      const toolResultBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id || "unknown_tool_call",
        content: toolResultContent(msg.content, imageBudget),
      };

      const last = transformed[transformed.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        // Append tool_result to existing user message with content blocks
        (last.content as Array<Record<string, unknown>>).push(toolResultBlock);
        continue;
      }

      transformed.push({
        role: "user",
        content: [toolResultBlock],
      });
    }
  }

  // The API needs a user turn first and last (no assistant prefill on
  // current models); a trimmed history can start or end with the agent.
  if (transformed.length > 0 && transformed[0].role === "assistant") {
    transformed.unshift({ role: "user", content: "[system] Earlier turns were trimmed." });
  }
  if (transformed.length > 0 && transformed[transformed.length - 1].role === "assistant") {
    transformed.push({ role: "user", content: "[system] Continue." });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: transformed,
  };
}

const MAX_IMAGES_PER_REQUEST = 2;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const IMAGE_MARKER = /\[\[image:([^\]\s]+\.(?:png|jpe?g))\]\]/g;

/** Media type from the file's first bytes; null when it is not a PNG or JPEG. */
function imageMediaType(data: Buffer): string | null {
  if (data.length > 8 && data.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  return null;
}

function recentImagePaths(messages: ChatMessage[], limit: number): Set<string> {
  const paths: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "tool" || !msg.content) continue;
    for (const m of msg.content.matchAll(IMAGE_MARKER)) paths.push(m[1]);
  }
  return new Set(paths.slice(-limit));
}

function toolResultContent(text: string, budget: { remaining: Set<string> }): unknown {
  if (!text || !text.includes("[[image:")) return text;
  const images: Array<Record<string, unknown>> = [];
  const stripped = text.replace(IMAGE_MARKER, (_all, file: string) => {
    if (!budget.remaining.has(file)) return "(older screenshot not shown)";
    try {
      const data = fs.readFileSync(file);
      if (data.length > MAX_IMAGE_BYTES) return "(screenshot too large to show)";
      // A file that is not really an image would make every request fail.
      const mediaType = imageMediaType(data);
      if (!mediaType) return "(not a PNG or JPEG image)";
      images.push({ type: "image", source: { type: "base64", media_type: mediaType, data: data.toString("base64") } });
      return "";
    } catch {
      return "(screenshot file missing)";
    }
  }).trim();
  if (images.length === 0) return stripped || "(no content)";
  return [{ type: "text", text: stripped || "Screenshot:" }, ...images];
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { _raw: raw };
  }
}

function normalizeAnthropicFinishReason(reason: unknown): string {
  if (typeof reason !== "string") return "stop";
  if (reason === "tool_use") return "tool_calls";
  // The loop sleeps after a text-only "stop"; Anthropic says end_turn.
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  if (reason === "max_tokens") return "length";
  return reason;
}
