import { DATA_COPY, type DataCopy, SYNTHETIC_COPY } from "./copy";
import { asId, dict, isRecord, type Json, list, orStr, parseDt, pyStr, strip, truthy } from "./py";
import { qrSvgMarkup } from "./qr";
import { PARTICIPANT_LANGUAGE_CODES, screenLanguage, TOGGLEABLE_TABS } from "./settings";
import { attributes } from "./text";
import { sampleFiles } from "./view";

/**
 * Everything the presentation polls, as one document keyed by the file paths the page
 * would otherwise fetch, assembled from the session state. The public and in-app pages
 * render the same thing; the host variant adds what the room must not see.
 */

export const DEFAULT_LEGAL_BASIS = "client-managed";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** The portal start link, tagged so PostHog can tell a popcorn scan apart. */
export function participantUrl(project: Json, participantBaseUrl: string): string | null {
  const projectId = asId(project.id);
  if (!projectId || !truthy(project.is_conversation_allowed)) return null;
  const language = orStr(project.language, "en");
  const code = PARTICIPANT_LANGUAGE_CODES[language.split("-")[0] ?? ""] ?? "en-US";
  return `${participantBaseUrl.replace(/\/+$/, "")}/${code}/${projectId}/start?utm_source=popcorn_qr`;
}

export function conversationUrl(project: Json, conversationId: string, adminBaseUrl: string) {
  const workspaceId = asId(project.workspace_id) ?? "";
  const projectId = asId(project.id) ?? "";
  return `${adminBaseUrl.replace(/\/+$/, "")}/en-US/w/${workspaceId}/projects/${projectId}/conversations/${conversationId}`;
}

/** `_session_day`: the report's date in its own zone, ISO. */
function sessionDay(value: unknown, now: Date): string {
  const d = parseDt(value) ?? now;
  return d.toISOString().slice(0, 10);
}

/** `_session_date`: "27 September 2026". */
function sessionDate(value: unknown, now: Date): string {
  const d = parseDt(value) ?? now;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** One legend entry: a number in deck order when names are hidden. */
function transcriptEntry(conv: Json, cid: string, index: number, showNames: boolean): Json {
  const name = showNames ? strip(orStr(conv.label)) : "";
  let label: string;
  let short: string;
  if (name) {
    label = name;
    short = strip(orStr(conv.short)) || name;
  } else {
    label = `Conversation ${index}`;
    short = label;
  }
  const entry: Json = { id: cid, label, short };
  if (typeof conv.created_at === "string" && conv.created_at) entry.time = conv.created_at;
  const duration = conv.duration;
  if (typeof duration === "number" && duration > 0) entry.duration = duration;
  return entry;
}

/**
 * The disclosure and notice the room sees, only when switched on and worded. A synthetic
 * demo's come with the demo: always on, in the demo's words or the standard ones.
 */
export function openingScreens(settings: Json, demo: Json): Json {
  if (demo.synthetic === true) {
    const copy = SYNTHETIC_COPY[demo.language === "nl" ? "nl" : "en"];
    const own = dict(demo.disclosure);
    const invitation =
      truthy(own.invitation_title) || truthy(own.invitation_text)
        ? own
        : { invitation_title: copy.invitation_title, invitation_text: copy.invitation_text };
    const notice = dict(demo.notice);
    return {
      disclosure: {
        text: orStr(own.text) || copy.disclosure,
        invitation_title: orStr(invitation.invitation_title),
        invitation_text: orStr(invitation.invitation_text),
      },
      notice: { text: orStr(notice.text) || copy.notice },
    };
  }
  const disclosure = dict(settings.disclosure);
  const notice = dict(settings.notice);
  const screens: Json = {};
  if (truthy(disclosure.enabled) && truthy(disclosure.text))
    screens.disclosure = Object.fromEntries(
      ["text", "invitation_title", "invitation_text"].map((k) => [
        k,
        truthy(disclosure[k]) ? disclosure[k] : "",
      ]),
    );
  if (truthy(notice.enabled) && truthy(notice.text)) screens.notice = { text: notice.text };
  return screens;
}

/**
 * What happens to the room's data, from the project's own settings. `legal_basis` is the
 * effective basis when the caller resolved it; a bare row falls back to the default.
 */
export function dataScreen(project: Json, language: string): Json {
  const copy = (DATA_COPY[language] ?? DATA_COPY.en) as DataCopy;
  const talk = truthy(project.anonymize_transcripts) ? "talk-anon" : "talk-public";
  const basis = orStr(project.legal_basis, DEFAULT_LEGAL_BASIS);
  const links: Json[] = [copy.trust];
  const screen: Json = {
    title: copy.title,
    steps: [
      { image: "scan", text: copy.scan },
      { image: talk, text: copy[talk] },
      { image: "understand", text: copy.understand },
    ],
    notes: [copy.legal[basis], copy.hood].filter((t): t is string => truthy(t)),
    links,
  };
  const policy = project.privacy_policy_url;
  if (
    basis === "consent" &&
    typeof policy === "string" &&
    (policy.startsWith("https://") || policy.startsWith("http://"))
  )
    links.unshift({ url: policy, label: copy.policy });
  return screen;
}

/** Keep provenance on individual files, including published-object overlays. */
export function markSyntheticFiles(files: Json): Json {
  if (!truthy(dict(dict(files["session.json"]).demo).synthetic)) return files;
  const out: Json = {};
  for (const [name, file] of Object.entries(files)) {
    if (!isRecord(file)) {
      out[name] = file;
      continue;
    }
    const marked: Json = { ...file, synthetic: true };
    for (const key of ["items", "quotes", "tensions", "stakeholders", "relations", "transcripts"])
      if (Array.isArray(file[key]))
        marked[key] = (file[key] as unknown[]).map((e) =>
          isRecord(e) ? { ...e, synthetic: true } : e,
        );
    out[name] = marked;
  }
  return out;
}

/**
 * A saved run as the room may see it. Runs saved before 6 September 2026 hold the host's
 * bundle: this strips the passages, dashboard links, host block and coverage, and numbers
 * the legend when the setting says so. Newer runs pass through unchanged.
 */
export function roomFiles(files: Json, neutralLabels: boolean): Json {
  const out: Json = {};
  for (const [name, file] of Object.entries(files)) {
    if (!isRecord(file)) {
      out[name] = file;
      continue;
    }
    if (name === "session.json") {
      const session: Json = Object.fromEntries(Object.entries(file).filter(([k]) => k !== "host"));
      const transcripts: Json[] = [];
      list(session.transcripts).forEach((t, i) => {
        if (!isRecord(t)) return;
        const index = i + 1;
        transcripts.push(
          neutralLabels
            ? { ...t, label: `Conversation ${index}`, short: `Conversation ${index}` }
            : t,
        );
      });
      session.transcripts = transcripts;
      out[name] = session;
    } else if (name.startsWith("popcorn/")) {
      out[name] = {
        ...Object.fromEntries(Object.entries(file).filter(([k]) => k !== "coverage")),
        items: list(file.items).map((i) =>
          isRecord(i) ? Object.fromEntries(Object.entries(i).filter(([k]) => k !== "source")) : i,
        ),
      };
    } else if (name === "quotes.json") {
      out[name] = {
        ...file,
        quotes: list(file.quotes).map((q) =>
          isRecord(q) ? Object.fromEntries(Object.entries(q).filter(([k]) => k !== "url")) : q,
        ),
      };
    } else out[name] = file;
  }
  return out;
}

export interface BuildArgs {
  readonly state: Json;
  readonly settings: Json;
  readonly report: Json;
  readonly project: Json;
  readonly participantBaseUrl: string;
  readonly adminBaseUrl?: string;
  readonly host?: boolean;
  readonly dev?: boolean;
  readonly now?: Date;
}

/**
 * The deck from the session state. A hidden tab is simply a missing file. Nothing under
 * an item's `review` leaves here, and a phrase's closest passage reaches the host only.
 */
export function buildBundle(a: BuildArgs): Json {
  const { state, settings, report, project, participantBaseUrl } = a;
  const adminBaseUrl = a.adminBaseUrl ?? "";
  const host = a.host ?? false;
  const now = a.now ?? new Date();
  const files: Json = {};
  const conversations = dict(state.conversations);
  const order = list(state.order)
    .map((c) => pyStr(c))
    .filter((cid) => cid in conversations);
  const analysis = dict(state.analysis);
  const run = truthy(state.run) ? Math.trunc(Number(state.run)) : 0;
  const showNames = host || settings.public_labels === "names";

  const session: Json = {
    title: settings.title,
    client: truthy(settings.client) ? settings.client : "",
    date: sessionDate(report.date_created, now),
    branding: truthy(settings.show_branding ?? true),
    intro: truthy(settings.intro) ? settings.intro : {},
    transcripts: order.map((cid, i) =>
      transcriptEntry(dict(conversations[cid]), cid, i + 1, showNames),
    ),
  };
  const demo = dict(state.demo);
  if (demo.synthetic === true)
    session.demo = {
      synthetic: true,
      public_sources_only: demo.public_sources_only === true,
      language: demo.language === "nl" ? "nl" : "en",
      // A prospect's demo leads on to their own organisation; only a web link is shown.
      ...(typeof demo.continue_url === "string" &&
        /^https?:\/\//.test(demo.continue_url) && { continue_url: demo.continue_url }),
    };
  Object.assign(session, openingScreens(settings, demo));
  session.language = screenLanguage(settings, demo, project);
  session.date_iso = sessionDay(report.date_created, now);
  if (truthy(dict(settings.data).enabled))
    session.data = dataScreen(project, session.language as string);
  // The host guide: the code to take part and how, between the data policy and the outcomes.
  const guide = dict(settings.guide);
  const guideSteps = orStr(guide.steps)
    .split("\n")
    .map((step) => step.trim())
    .filter(Boolean);
  const takePart = participantUrl(project, participantBaseUrl);
  if (!demo.synthetic && truthy(guide.enabled) && guideSteps.length && takePart)
    session.guide = {
      title: orStr(guide.title),
      steps: guideSteps,
      qr: { url: takePart, svg: qrSvgMarkup(takePart) },
    };
  if (truthy(settings.show_qr)) {
    // A demo's QR opens dembrane's sales portal, in the screen's language where there is one.
    const portals = dict(demo.portal_urls);
    const url = demo.synthetic
      ? portals[session.language as string] || demo.portal_url
      : participantUrl(project, participantBaseUrl);
    if (truthy(url)) {
      const qr: Json = { url, svg: qrSvgMarkup(pyStr(url)) };
      if (demo.synthetic)
        qr.label = session.language === "nl" ? "Feedback voor dembrane" : "Feedback for dembrane";
      session.qr = qr;
    }
  }
  if (host) {
    const tabs = dict(settings.tabs);
    const hostBlock: Json = {
      tabs: Object.fromEntries(TOGGLEABLE_TABS.map((t) => [t, truthy(tabs[t] ?? true)])),
      qr: truthy(settings.show_qr),
      qrAvailable: participantUrl(project, participantBaseUrl) !== null,
    };
    // Local development only: the deck's footer links to the account of what the tick does.
    if (a.dev) hostBlock.flow = "flow/";
    session.host = hostBlock;
  }
  files["session.json"] = session;

  for (const cid of order) {
    const conv = dict(conversations[cid]);
    const itemsOut: Json[] = [];
    for (const item of list(conv.items)) {
      if (!isRecord(item) || !truthy(item.phrase)) continue;
      const entry: Json = { id: item.id, phrase: item.phrase };
      if (truthy(demo.synthetic)) entry.synthetic = true;
      if (truthy(item.question)) entry.question = true;
      // A verbatim phrase may be drawn in quotation marks; a rooted paraphrase may not.
      if (truthy(item.verbatim)) entry.verbatim = true;
      if (truthy(item.kind)) {
        entry.kind = item.kind;
        entry.qualifiers = list(item.qualifiers).map((q) => pyStr(q));
      }
      if (truthy(item.quoteId)) entry.quoteId = item.quoteId;
      if (host && isRecord(item.source) && !truthy(item.quoteId))
        entry.source = {
          text: item.source.text ?? null,
          url: adminBaseUrl ? conversationUrl(project, cid, adminBaseUrl) : null,
        };
      itemsOut.push(entry);
    }
    const popcornFile: Json = {
      transcript: cid,
      revision: truthy(conv.revision) ? Math.trunc(Number(conv.revision)) : 1,
      done: truthy(conv.done),
      // The second pass finished for the transcript as it stands.
      validated:
        truthy(conv.done) &&
        truthy(conv.fingerprint) &&
        pyEqualScalar(conv.validated_fingerprint, conv.fingerprint),
      // Phrases the second pass could not root: a count, never their text.
      held_back: list(dict(conv.review).dropped).length,
      items: itemsOut,
    };
    const clipped = truthy(conv.clipped) ? Math.trunc(Number(conv.clipped)) : 0;
    if (host && clipped > 0)
      popcornFile.coverage = {
        chars: truthy(conv.chars) ? Math.trunc(Number(conv.chars)) : 0,
        clipped,
      };
    files[`popcorn/${cid}.json`] = popcornFile;
    if (truthy(demo.synthetic)) popcornFile.synthetic = true;
  }

  const tabs = dict(settings.tabs);
  const registry = list(state.quotes);
  if (registry.length || truthy(state.analysis)) {
    const quotes = registry.map((q) => {
      const entry: Json = { ...dict(q) };
      // A registry written before the attribution rule may still carry a speaker.
      if (truthy(entry.context) && attributes(pyStr(entry.context))) delete entry.context;
      const transcript = dict(q).transcript;
      if (host && adminBaseUrl && truthy(transcript))
        entry.url = conversationUrl(project, pyStr(transcript), adminBaseUrl);
      return entry;
    });
    files["quotes.json"] = { quotes };
  }
  if (truthy(state.analysis))
    for (const kind of TOGGLEABLE_TABS) {
      const slide = analysis[kind];
      if (truthy(tabs[kind] ?? true) && isRecord(slide))
        files[`${kind}.json`] = demo.synthetic ? { ...slide, synthetic: true } : slide;
    }

  return { run, files: markSyntheticFiles(files) };
}

function pyEqualScalar(a: unknown, b: unknown): boolean {
  return a === b || (a !== undefined && b !== undefined && JSON.stringify(a) === JSON.stringify(b));
}

/** Upstream's fictional deck, for trying popcorn with no conversations and no model call. */
export function sampleBundle(): Json {
  return { run: 0, sample: true, files: sampleFiles() };
}
