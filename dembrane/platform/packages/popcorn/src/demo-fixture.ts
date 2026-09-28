import { ValidationError } from "@dembrane/core";
import type { DemoCorpusEntry } from "./demo";
import { demoIdentity } from "./demo";
import { dict, type Json, list, pyStr } from "./py";
import { defaultSettings } from "./settings";
import { freshState } from "./state";
import { ANALYSIS_VIEWS, fingerprint } from "./tick/run";

/**
 * The seed inputs of an authored demo fixture (dembrane/demos/<slug>/fixture.json), made the
 * way server/scripts/popcorn_demo.py prepare() makes them, so a TypeScript caller (the
 * accounts demo seed) seeds the same deck without Python. The parity demo script still
 * goes through Python, which keeps this port honest against the original.
 */
export interface FixtureInputs {
  readonly session: Json;
  readonly corpus: DemoCorpusEntry[];
  readonly out: Record<string, { state: Json; settings: Json }>;
}

export function demoFromFixture(fixture: Json, portalUrl: string): FixtureInputs {
  const slug = pyStr(fixture.slug);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug))
    throw new ValidationError("The demo slug must be lowercase words separated by hyphens");
  if (fixture.synthetic !== true)
    throw new ValidationError("Only explicitly synthetic fixtures can be exported");
  const language = pyStr(fixture.language);
  const tagged = `${portalUrl}${portalUrl.includes("?") ? "&" : "?"}utm_source=popcorn_demo&utm_campaign=${encodeURIComponent(slug)}`;
  const state = freshState();
  state.run = 1;
  state.demo = {
    synthetic: true,
    public_sources_only: fixture.public_sources_only === true,
    language,
    portal_url: tagged,
    portal_urls: { [language]: tagged },
    disclosure: {
      text: pyStr(fixture.disclosure ?? ""),
      invitation_title: pyStr(fixture.invitation_title ?? ""),
      invitation_text: pyStr(fixture.invitation_text ?? ""),
    },
    notice: { text: pyStr(fixture.notice ?? "") },
  };
  const quotes = state.quotes as Json[];
  const order = state.order as string[];
  const conversations = state.conversations as Json;
  const quoteIds: Record<string, string> = {};
  const corpus: DemoCorpusEntry[] = [];
  for (const [i, raw] of list(fixture.conversations).entries()) {
    const c = dict(raw);
    const cid = demoIdentity(slug, pyStr(c.id));
    const transcript = pyStr(c.transcript);
    const lines = transcript.split("\n").map((l) => {
      const at = l.indexOf(": ");
      return at < 0 ? l : l.slice(at + 2);
    });
    const items: Json[] = [];
    for (const itemRaw of list(c.items)) {
      const item = dict(itemRaw);
      const sentence = lines.find((l) => l.includes(pyStr(item.phrase)));
      if (sentence === undefined)
        throw new ValidationError(`Phrase ${pyStr(item.id)} is not in its transcript`);
      const quoteId = `q${quotes.length + 1}`;
      quoteIds[pyStr(item.id)] = quoteId;
      quotes.push({ id: quoteId, transcript: cid, text: sentence });
      items.push({ ...item, quoteId, verbatim: true, rooted: true });
    }
    const print = fingerprint(`${transcript.trim()}\x1f`);
    order.push(cid);
    conversations[cid] = {
      label: c.label,
      short: c.theme,
      items,
      done: true,
      revision: 1,
      fingerprint: print,
      validated_fingerprint: print,
    };
    corpus.push({
      id: pyStr(c.id),
      label: pyStr(c.label),
      start: `2026-06-12T10:${String(i + 1).padStart(2, "0")}:00+02:00`,
      chunks: transcript.split("\n").filter((l) => l.trim()),
    });
  }
  const cite = (entry: Json): Json => {
    const out: Json = { ...entry };
    if (Array.isArray(out.quoteIds))
      out.quoteIds = (out.quoteIds as unknown[]).map((r) => quoteIds[pyStr(r)] as string);
    if (Array.isArray(out.aspects))
      out.aspects = (out.aspects as unknown[]).map((a) => cite(dict(a)));
    return out;
  };
  const analysis = dict(fixture.analysis);
  const read = fingerprint(
    order.map((cid) => `${cid}:${pyStr(dict(conversations[cid]).fingerprint)}`).join("|"),
  );
  const stakeholders = dict(analysis.stakeholders);
  state.analysis = {
    fingerprints: Object.fromEntries(ANALYSIS_VIEWS.map((v) => [v, read])),
    tensions: { tensions: list(dict(analysis.tensions).tensions).map((t) => cite(dict(t))) },
    stakeholders: {
      stakeholders: list(stakeholders.stakeholders).map((s) => cite(dict(s))),
      relations: list(stakeholders.relations).map((r) => cite(dict(r))),
    },
  };
  const settings = defaultSettings(pyStr(fixture.title), pyStr(fixture.organisation));
  Object.assign(settings, {
    show_qr: true,
    public_labels: "names",
    public: true,
    intro: { enabled: true, title: fixture.title, subtitle: fixture.subtitle },
    data: { enabled: true },
  });
  return {
    session: {
      slug,
      organisation: fixture.organisation,
      synthetic: true,
      public_sources_only: true,
      title: { [language]: fixture.title },
      subtitle: { [language]: fixture.subtitle },
    },
    corpus,
    out: { [language]: { state, settings } },
  };
}
