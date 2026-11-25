/**
 * Wire stubs for tests: the two providers' HTTP APIs answering from canned bodies, with every
 * request kept. They stand where the network would, so a test drives the real AI SDK clients
 * (Vertex and the OpenAI-compatible one) and can assert which provider a call reached.
 */
export interface WireRequest {
  readonly url: string;
  readonly body: string;
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const sse = (chunks: unknown[]) =>
  new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

export interface WireStubOptions {
  /** Text every answer carries. */
  readonly text?: string;
  /** Called before a Vertex request is answered; throw to fail the test at the request. */
  readonly vertexGuard?: (r: WireRequest) => void;
  /** Called before a compatible-provider request is answered. */
  readonly compatGuard?: (r: WireRequest) => void;
  /** Answers every compatible-provider chat or embedding request with this status instead. */
  readonly compatStatus?: number;
  /** Answers every Vertex request with this status instead. */
  readonly vertexStatus?: number;
  /** The words the speech endpoint hears. */
  readonly speech?: string;
  readonly dimensions?: number;
}

async function read(input: Request | string | URL, init?: RequestInit): Promise<WireRequest> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const raw = init?.body ?? (input instanceof Request ? await input.clone().text() : "");
  let body = "";
  if (typeof raw === "string") body = raw;
  else if (raw instanceof FormData)
    body = [...raw.entries()]
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : "(file)"}`)
      .join("&");
  return { url, body };
}

/** Stands in for Google's credentials: the Vertex client asks it for a token and never reaches Google for one. */
export const STUB_VERTEX_AUTH = {
  googleAuthOptions: { authClient: { getAccessToken: async () => ({ token: "stub" }) } as never },
};

export function wireStubs(o: WireStubOptions = {}) {
  const text = o.text ?? "stub answer";
  const dimensions = o.dimensions ?? 8;
  const seen = { vertex: [] as WireRequest[], compat: [] as WireRequest[] };
  const vertex = (async (input: Request | string | URL, init?: RequestInit) => {
    const r = await read(input, init);
    seen.vertex.push(r);
    o.vertexGuard?.(r);
    if (o.vertexStatus) return new Response("{}", { status: o.vertexStatus });
    if (r.url.includes(":predict"))
      return json({
        predictions: [
          { embeddings: { values: Array(dimensions).fill(0.1), statistics: { token_count: 1 } } },
        ],
      });
    const candidate = {
      content: { role: "model", parts: [{ text }] },
      finishReason: "STOP",
    };
    const usageMetadata = { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 };
    if (r.url.includes("streamGenerateContent"))
      return sse([{ candidates: [candidate], usageMetadata }]);
    return json({ candidates: [candidate], usageMetadata });
  }) as typeof fetch;
  const compat = (async (input: Request | string | URL, init?: RequestInit) => {
    const r = await read(input, init);
    seen.compat.push(r);
    o.compatGuard?.(r);
    if (o.compatStatus) return new Response("{}", { status: o.compatStatus });
    if (r.url.endsWith("/audio/transcriptions"))
      return json({
        text: o.speech ?? "heard",
        duration: 5,
        segments: [{ start: 0, end: 5, text: o.speech ?? "heard" }],
      });
    if (r.url.endsWith("/embeddings"))
      return json({
        object: "list",
        data: [{ object: "embedding", index: 0, embedding: Array(dimensions).fill(0.1) }],
        model: "embedding",
        usage: { prompt_tokens: 1, total_tokens: 1 },
      });
    const base = { id: "c1", object: "chat.completion", created: 0, model: "glm-5.3" };
    const usage = { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 };
    if (r.body.includes('"stream":true')) {
      const chunk = (delta: object, finish: string | null, extra: object = {}) =>
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
      return new Response(
        [
          chunk({ role: "assistant", content: text }, null),
          chunk({}, "stop", { usage }),
          "data: [DONE]\n\n",
        ].join(""),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return json({
      ...base,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage,
    });
  }) as typeof fetch;
  return { vertex, compat, seen };
}
