import type { Completer, Completion, CompletionRequest, Embedder } from "./complete";
import type { ModelGroup } from "./models";

export type FakeAnswer =
  | string
  | Partial<Completion>
  | ((
      request: CompletionRequest,
    ) => string | Partial<Completion> | Promise<string | Partial<Completion>>);

/**
 * A completer for tests: each call takes the first rule whose matcher accepts the request
 * (by system prompt, user text or schema) and answers with its recorded output. Every
 * request is kept in `calls`, so a test can assert what was asked and how often.
 */
export class FakeCompleter implements Completer {
  readonly calls: CompletionRequest[] = [];
  private readonly rules: { match: (r: CompletionRequest) => boolean; answer: FakeAnswer }[] = [];

  constructor(private readonly identity: (group: ModelGroup) => string = (g) => `fake/${g}`) {}

  /** Answers requests whose system prompt or user text contains `needle`. */
  on(needle: string | ((r: CompletionRequest) => boolean), answer: FakeAnswer): this {
    const match =
      typeof needle === "function"
        ? needle
        : (r: CompletionRequest) =>
            (r.system ?? "").includes(needle) ||
            (typeof r.user === "string" ? r.user : r.user.join("\n")).includes(needle);
    this.rules.push({ match, answer });
    return this;
  }

  async complete(request: CompletionRequest): Promise<Completion> {
    this.calls.push(request);
    const rule = this.rules.find((r) => r.match(request));
    if (!rule) throw new Error("FakeCompleter has no answer for this request");
    const raw = typeof rule.answer === "function" ? await rule.answer(request) : rule.answer;
    const part = typeof raw === "string" ? { text: raw } : raw;
    return {
      text: part.text ?? "",
      finishReason: part.finishReason ?? "STOP",
      usage: part.usage ?? { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      sources: part.sources ?? [],
    };
  }

  modelIdentity(group: ModelGroup): string {
    return this.identity(group);
  }
}

/** Deterministic vectors from the text's characters, so equal texts embed equally. */
export class FakeEmbedder implements Embedder {
  readonly model: string;
  readonly endpoint = "fake:local";
  readonly calls: string[] = [];

  constructor(
    readonly dimensions = 8,
    model = "fake/embedding",
  ) {
    this.model = model;
  }

  async embed(text: string): Promise<number[]> {
    this.calls.push(text);
    const v: number[] = new Array<number>(this.dimensions).fill(0);
    for (const [i, ch] of [...text].entries()) {
      const k = i % this.dimensions;
      v[k] = (v[k] as number) + ((ch.codePointAt(0) ?? 0) % 97) / 97;
    }
    if (!v.some((x) => x !== 0)) v[0] = 1;
    return v.map((x) => Math.round(x * 1e6) / 1e6);
  }
}
