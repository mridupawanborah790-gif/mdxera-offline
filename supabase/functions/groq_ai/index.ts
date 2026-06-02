// Groq AI Edge Function — replaces the old gemini_ocr function while keeping
// the same request/response contract so the client doesn't have to change.
//
// Request body (unchanged from the Gemini function):
//   { prompt: string, files?: { mimeType: string, data: string }[], model?: string }
//
// Response body (unchanged shape):
//   { success: true, data: { candidates: [{ content: { parts: [{ text }] } }] } }
//   { success: false, error: string }
//
// The client reads `candidates[].content.parts[].text`, so we re-wrap Groq's
// OpenAI-style `choices[0].message.content` into that Gemini shape. This keeps
// services/geminiService.ts:getTextFromResultData working as-is.
//
// Configure via Supabase Dashboard → Edge Functions → Secrets:
//   GROQ_API_KEY        required
//   GROQ_DEFAULT_MODEL  optional, defaults to a vision-capable Llama model.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface FileInput {
  mimeType?: string;
  data?: string;
}

interface RequestBody {
  prompt?: string;
  files?: FileInput[];
  model?: string;
  /** Optional. Generation temperature; defaults to 0 for deterministic OCR. */
  temperature?: number;
  /** Optional. Output token cap; defaults to 4096 (enough for ~50-item bills). */
  max_tokens?: number;
}

const DEFAULT_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';

/** Strip any `data:image/...;base64,` prefix so the value is pure base64. */
const stripDataUrlPrefix = (raw: string): string => raw.replace(/^data:[^;]+;base64,/, '');

/** Build the OpenAI-style messages array Groq expects. */
function buildMessages(prompt: string, files: FileInput[]): unknown[] {
  const content: Array<Record<string, unknown>> = [];
  if (prompt) {
    content.push({ type: 'text', text: prompt });
  }
  for (const file of files) {
    if (!file?.mimeType || !file?.data) continue;
    const base64 = stripDataUrlPrefix(file.data);
    content.push({
      type: 'image_url',
      image_url: { url: `data:${file.mimeType};base64,${base64}` },
    });
  }
  return [{ role: 'user', content: content.length > 1 ? content : (content[0]?.text ?? '') }];
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const apiKey = Deno.env.get('GROQ_API_KEY');
    if (!apiKey) {
      return new Response(
        JSON.stringify({ success: false, error: 'GROQ_API_KEY is not configured in Supabase Secrets.' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return new Response(
        JSON.stringify({ success: false, error: 'Invalid JSON in request body.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const prompt = (body.prompt || '').toString();
    const files = Array.isArray(body.files) ? body.files : [];

    // Pick model: explicit > org-default secret > library default.
    const orgDefault = Deno.env.get('GROQ_DEFAULT_MODEL') || '';
    const model = (body.model && body.model.trim()) || orgDefault || DEFAULT_MODEL;

    const messages = buildMessages(prompt, files);

    const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof body.temperature === 'number' ? body.temperature : 0,
        max_tokens: typeof body.max_tokens === 'number' ? body.max_tokens : 4096,
      }),
    });

    const groqResult: any = await groqResponse.json().catch(() => ({}));

    if (!groqResponse.ok) {
      const errMsg = groqResult?.error?.message || groqResult?.error || `Groq API error (HTTP ${groqResponse.status})`;
      return new Response(
        JSON.stringify({ success: false, error: typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg) }),
        { status: groqResponse.status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    const text = groqResult?.choices?.[0]?.message?.content ?? '';

    // Re-wrap into Gemini's shape so the client's existing parser works.
    const wrapped = {
      candidates: [
        {
          content: {
            parts: [{ text }],
          },
          finishReason: groqResult?.choices?.[0]?.finish_reason ?? 'STOP',
        },
      ],
      usageMetadata: groqResult?.usage,
      modelUsed: groqResult?.model || model,
    };

    return new Response(
      JSON.stringify({ success: true, data: wrapped }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: err?.message || 'Unknown error' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  }
});
