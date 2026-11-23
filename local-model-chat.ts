// Server-only Ollama transport. Never substitutes a model or an inference host.
export async function requestLocalChat(
  endpoint: string,
  body: { model: string; messages: unknown[]; format?: unknown; purpose?: unknown },
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  const clarification = body.purpose === "workflow-clarification";
  const started = Date.now();
  const response = await transport(`${endpoint}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model: body.model,
      messages: body.messages,
      stream: false,
      ...(clarification ? { think: false } : {}),
      ...(body.format === "json" ? { format: "json" } : {}),
      options: {
        temperature: body.format === "json" ? 0.1 : 0.7,
        ...(clarification ? { num_predict: 2048, num_ctx: 32768 } : {}),
      },
    }),
  });
  const payload = await response.json() as {
    message?: { content?: string };
    error?: string;
    done_reason?: string;
    eval_count?: number;
    prompt_eval_count?: number;
    load_duration?: number;
  };
  if (!response.ok || payload.error)
    throw Error(payload.error || `Ollama returned HTTP ${response.status}`);
  const message = payload.message?.content?.trim();
  if (!message)
    throw Error("The selected local model returned no answer text. It may have exhausted its output budget on reasoning; no draft was created. Try a smaller local model or inspect Ollama's log.");
  return {
    message,
    elapsedMs: Date.now() - started,
    truncated: payload.done_reason === "length",
    metrics: {
      generatedTokens: payload.eval_count,
      promptTokens: payload.prompt_eval_count,
      loadMs: typeof payload.load_duration === "number" ? Math.round(payload.load_duration / 1e6) : undefined,
    },
  };
}

// OpenAI-compatible provider transport (user-supplied API keys). The server never
// exposes the key to the client; the caller supplies it per request.
export async function requestProviderChat(
  baseUrl: string,
  apiKey: string,
  body: { model: string; messages: unknown[] },
  signal: AbortSignal,
  transport: typeof fetch = fetch,
) {
  const started = Date.now();
  const root = baseUrl.replace(/\/+$/, "");
  const response = await transport(`${root}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal,
    body: JSON.stringify({
      model: body.model,
      messages: body.messages,
      stream: false,
      temperature: 0.7,
    }),
  });
  let payload: {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    error?: { message?: string } | string;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } = {};
  try {
    payload = (await response.json()) as typeof payload;
  } catch {
    /* non-JSON body handled below */
  }
  const errorDetail =
    typeof payload.error === "string"
      ? payload.error
      : payload.error?.message || (payload.error ? "Provider error" : undefined);
  if (!response.ok || errorDetail) {
    throw Error(`Provider rejected the request: ${errorDetail || `HTTP ${response.status}`}`);
  }
  const choice = payload.choices?.[0];
  const message = choice?.message?.content?.trim();
  if (!message)
    throw Error("The provider returned no answer text. Check the model name and account quota.");
  return {
    message,
    elapsedMs: Date.now() - started,
    truncated: choice?.finish_reason === "length",
    metrics: {
      generatedTokens: payload.usage?.completion_tokens,
      promptTokens: payload.usage?.prompt_tokens,
      loadMs: undefined as number | undefined,
    },
  };
}
