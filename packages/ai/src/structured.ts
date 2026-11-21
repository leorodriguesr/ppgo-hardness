import { z } from 'zod';
import type { ChatProvider, ChatRequest, ChatResult } from './types';

/** Ajusta um JSON Schema para o modo estrito (objetos fechados, todos os campos obrigatórios). */
export function toStrictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictJsonSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === '$schema') continue;
    out[k] = toStrictJsonSchema(v);
  }
  if (out.type === 'object' && out.properties && typeof out.properties === 'object') {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  return out;
}

/** Extrai o primeiro objeto JSON de uma resposta (tolera cercas de código). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error('Resposta não contém JSON válido');
  }
}

/**
 * Chamada com saída estruturada validada por Zod. Em caso de JSON inválido, tenta
 * novamente uma vez informando o erro ao modelo.
 */
export async function chatJson<S extends z.ZodType>(
  provider: ChatProvider,
  req: Omit<ChatRequest, 'jsonSchema'>,
  schema: S,
  name: string,
): Promise<{ data: z.infer<S>; raw: ChatResult }> {
  const jsonSchema = toStrictJsonSchema(z.toJSONSchema(schema)) as Record<string, unknown>;
  let messages = req.messages;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await provider.chat({ ...req, messages, jsonSchema: { name, schema: jsonSchema } });
    try {
      const data = schema.parse(extractJson(raw.content));
      return { data, raw };
    } catch (err) {
      lastError = err;
      messages = [
        ...req.messages,
        { role: 'assistant', content: raw.content.slice(0, 2000) },
        { role: 'user', content: 'A resposta anterior não seguiu o esquema JSON exigido. Responda apenas com JSON válido conforme o esquema.' },
      ];
    }
  }
  throw new Error(`Saída estruturada inválida: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}
