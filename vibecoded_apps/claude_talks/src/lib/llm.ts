/**
 * LLM text generation abstraction (Gemini-first).
 * Pure TS — no framework deps. Works in browser and Node.
 *
 * Usage:
 *   const llm = createLLM({ apiKey });
 *   const text = await llm("How does AI work?");
 *   const city = await llm.json<City>("Tell me about Paris", schema);
 *   for await (const chunk of llm.stream("Write a story")) { ... }
 */

import { GoogleGenAI } from '@google/genai';

// --- Types ---

export interface Part {
  text?: string;
  inlineData?: { data: string; mimeType: string };
}

export interface Message {
  role: 'user' | 'assistant';
  content: string | Part[];
}

export type Input = string | Message[];

export interface LLMConfig {
  apiKey: string;
  model?: string;
  system?: string;
}

export interface CallOptions {
  system?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  thinking?: 'off' | 'low' | 'medium' | 'high';
}

export interface LLM {
  (input: Input, options?: CallOptions): Promise<string>;
  stream(input: Input, options?: CallOptions): AsyncGenerator<string>;
  json<T>(input: Input, schema: object, options?: CallOptions): Promise<T>;
}

// --- Client cache ---

const clients = new Map<string, GoogleGenAI>();

function getClient(apiKey: string): GoogleGenAI {
  let client = clients.get(apiKey);
  if (!client) {
    client = new GoogleGenAI({ apiKey });
    clients.set(apiKey, client);
  }
  return client;
}

// --- Internals ---

function toContents(input: Input) {
  if (typeof input === 'string') {
    return [{ role: 'user', parts: [{ text: input }] }];
  }
  return input.map((m) => ({
    role: m.role === 'assistant' ? 'model' : m.role,
    parts: typeof m.content === 'string'
      ? [{ text: m.content }]
      : m.content,
  }));
}

function toConfig(
  defaults: LLMConfig,
  opts?: CallOptions,
  json?: { schema: object },
): Record<string, unknown> {
  const config: Record<string, unknown> = {};

  const system = opts?.system ?? defaults.system;
  if (system) config.systemInstruction = system;

  if (opts?.temperature != null) config.temperature = opts.temperature;
  if (opts?.maxTokens != null) config.maxOutputTokens = opts.maxTokens;

  if (opts?.thinking) {
    const level = opts.thinking === 'off' ? 'NONE' : opts.thinking.toUpperCase();
    config.thinkingConfig = { thinkingLevel: level };
  }

  if (json) {
    config.responseMimeType = 'application/json';
    config.responseSchema = json.schema;
  }

  return config;
}

// --- Factory ---

const DEFAULT_MODEL = 'gemini-3-flash-preview';

export function createLLM(cfg: LLMConfig): LLM {
  const client = getClient(cfg.apiKey);
  const model = cfg.model ?? DEFAULT_MODEL;

  const generate = async (input: Input, opts?: CallOptions): Promise<string> => {
    const response = await client.models.generateContent({
      model: opts?.model ?? model,
      contents: toContents(input),
      config: toConfig(cfg, opts),
    });
    return response.text ?? '';
  };

  generate.stream = async function* (input: Input, opts?: CallOptions): AsyncGenerator<string> {
    const response = await client.models.generateContentStream({
      model: opts?.model ?? model,
      contents: toContents(input),
      config: toConfig(cfg, opts),
    });
    for await (const chunk of response) {
      if (chunk.text) yield chunk.text;
    }
  };

  generate.json = async function <T>(input: Input, schema: object, opts?: CallOptions): Promise<T> {
    const response = await client.models.generateContent({
      model: opts?.model ?? model,
      contents: toContents(input),
      config: toConfig(cfg, opts, { schema }),
    });
    return JSON.parse(response.text ?? '{}') as T;
  };

  return generate as LLM;
}
