/* popcorn — live session slides.
   Everything renders from data/*.json; a tab only exists if its file does.
   data/popcorn/<transcriptId>.json files are written incrementally by the
   analysis agents and polled while the session is live. */

(() => {
  /* Embedded in dembrane (window.POPCORN_EMBED set by the server): every
     data/<file> read comes from one bundle document instead of separate
     files, and the drag-and-drop / localStorage demo paths are off. */
  const EMBED = typeof window !== "undefined" && window.POPCORN_EMBED ? window.POPCORN_EMBED : null;
  const BUNDLE_MAX_AGE_MS = 250;
  if (EMBED) {
    // Every data path is relative to the page, so the address must end in a
    // slash; fix it here rather than with a redirect the server would have to
    // build from the request. The saved run to replay comes from the query
    // string for the same reason: the server never echoes it into the page.
    if (!location.pathname.endsWith("/")) {
      history.replaceState(null, "", `${location.pathname}/${location.search}${location.hash}`);
    }
    const requested = new URLSearchParams(location.search).get("version");
    if (requested && /^[0-9a-fA-F-]{36}$/.test(requested)) EMBED.version = requested;
    // A small frame (the intro's sample) asks for the deck scaled down so the
    // stage keeps its proportions instead of cramming full-size phrases.
    const scale = Number(new URLSearchParams(location.search).get("scale"));
    if (scale >= 0.4 && scale <= 1) document.documentElement.style.zoom = String(scale);
  }
  const MARKERS = ["var(--m0)", "var(--m1)", "var(--m2)", "var(--m3)", "var(--m4)", "var(--m5)"];
  const POLL_MS = 3000;           // slide files
  const POP_FAST_POLL_MS = 200;   // empty stage: reserve <500ms for detection + paint
  const POP_POLL_MS = 800;        // warm stage and validation updates
  const POP_HOLD = 10000;    // solid reading time per phrase
  const POP_FADE = 900;
  const POP_GAP = 2400;      // stagger between spawns once the stage is warm
  const POP_MAX = 3;         // phrases the automatic flow keeps up at once (one per band)
  const POP_CAP = 5;         // phrases on stage at once, all told; a keyed pop past this sends the oldest away
  const POP_HOLD_PINNED = 30000;  // a phrase the facilitator popped from the keys lingers
  const POP_EDGE_PX = 18;    // no phrase comes closer than this to the edge of the stage

  // The kind of a popcorn: what the contribution is doing in the conversation
  // (PROMPTS/popcorn-ontology.md, v3). Phosphor bold icons (MIT), inlined so the
  // single-file build works offline; bold so the stroke reads at the weight of the type.
  const POP_KIND_ICONS = {
    observation: "M241,150.65s0,0,0-.05a51.33,51.33,0,0,0-2.53-5.9L196.93,50.18a12,12,0,0,0-2.5-3.65,36,36,0,0,0-50.92,0A12,12,0,0,0,140,55V76H116V55a12,12,0,0,0-3.51-8.48,36,36,0,0,0-50.92,0,12,12,0,0,0-2.5,3.65L17.53,144.7A51.33,51.33,0,0,0,15,150.6s0,0,0,.05A52,52,0,1,0,116,168V100h24v68a52,52,0,1,0,101-17.35ZM80,62.28a12,12,0,0,1,12-1.22v63.15a51.9,51.9,0,0,0-35.9-7.62ZM64,196a28,28,0,1,1,28-28A28,28,0,0,1,64,196ZM164,61.06a12.06,12.06,0,0,1,12,1.22l23.87,54.31a51.9,51.9,0,0,0-35.9,7.62ZM192,196a28,28,0,1,1,28-28A28,28,0,0,1,192,196Z",
    distinction: "M232.49,192.49l-32,32a12,12,0,0,1-17,0l-32-32a12,12,0,0,1,17-17L180,187V141L128,89,76,141V187l11.51-11.52a12,12,0,0,1,17,17l-32,32a12,12,0,0,1-17,0l-32-32a12,12,0,1,1,17-17L52,187V136a12,12,0,0,1,3.51-8.49L116,67V24a12,12,0,0,1,24,0V67l60.49,60.48A12,12,0,0,1,204,136v51l11.51-11.52a12,12,0,0,1,17,17Z",
    need: "M40.14,46.88A12,12,0,0,0,36,56V224a12,12,0,0,0,24,0V181.72c22.84-17.12,42.1-9.12,70.68,5,16.23,8,34.74,17.2,54.8,17.2,14.72,0,30.28-4.94,46.38-18.88A12,12,0,0,0,236,176V56a12,12,0,0,0-19.86-9.07c-24.71,21.41-44.53,13.31-74.82-1.68C113.19,31.27,78.17,13.94,40.14,46.88ZM212,170.26c-22.84,17.13-42.1,9.11-70.68-5C118.16,153.76,90.33,140,60,153.87V61.69c22.84-17.12,42.1-9.12,70.68,5,16.23,8,34.74,17.2,54.8,17.2A63,63,0,0,0,212,78.08Z",
    practice: "M248.92,104,215.3,66.62A20,20,0,0,0,200.44,60H140V32a12,12,0,0,0-24,0V60H40A20,20,0,0,0,20,80v64a20,20,0,0,0,20,20h76v60a12,12,0,0,0,24,0V164h60.44a20,20,0,0,0,14.86-6.62L248.92,120A12,12,0,0,0,248.92,104Zm-50.26,36H44V84H198.66l25.2,28Z",
    idea: "M180,232a12,12,0,0,1-12,12H88a12,12,0,0,1,0-24h80A12,12,0,0,1,180,232Zm40-128a91.51,91.51,0,0,1-35.17,72.35A12.26,12.26,0,0,0,180,186v2a20,20,0,0,1-20,20H96a20,20,0,0,1-20-20v-2a12,12,0,0,0-4.7-9.51A91.57,91.57,0,0,1,36,104.52C35.73,54.69,76,13.2,125.79,12A92,92,0,0,1,220,104Zm-24,0a68,68,0,0,0-69.65-68C89.56,36.88,59.8,67.55,60,104.38a67.71,67.71,0,0,0,26.1,53.19A35.87,35.87,0,0,1,100,184h56.1A36.13,36.13,0,0,1,170,157.49,67.68,67.68,0,0,0,196,104Zm-20.07-5.32a48.5,48.5,0,0,0-31.91-40,12,12,0,0,0-8,22.62,24.31,24.31,0,0,1,16.09,20,12,12,0,0,0,23.86-2.64Z",
    objection: "M188,84a32,32,0,0,0-8,1V60a32,32,0,0,0-43.21-30A32,32,0,0,0,76,44v1A32,32,0,0,0,36,76v76a92,92,0,0,0,184,0V116A32,32,0,0,0,188,84Zm8,68a68,68,0,0,1-136,0V76a8,8,0,0,1,16,0v40a12,12,0,0,0,24,0V44a8,8,0,0,1,16,0v64a12,12,0,0,0,24,0V60a8,8,0,0,1,16,0v65.4A52.09,52.09,0,0,0,116,176a12,12,0,0,0,24,0,28,28,0,0,1,28-28,12,12,0,0,0,12-12V116a8,8,0,0,1,16,0Z",
    question: "M144,180a16,16,0,1,1-16-16A16,16,0,0,1,144,180Zm92-52A108,108,0,1,1,128,20,108.12,108.12,0,0,1,236,128Zm-24,0a84,84,0,1,0-84,84A84.09,84.09,0,0,0,212,128ZM128,64c-24.26,0-44,17.94-44,40v4a12,12,0,0,0,24,0v-4c0-8.82,9-16,20-16s20,7.18,20,16-9,16-20,16a12,12,0,0,0-12,12v8a12,12,0,0,0,23.73,2.56C158.31,137.88,172,122.37,172,104,172,81.94,152.26,64,128,64Z",
    decision: "M253.88,108.11l-25.53-51a20,20,0,0,0-26.83-9L178.34,59.7,131.7,44.58a12.14,12.14,0,0,0-7.4,0L77.66,59.7,54.48,48.11a20,20,0,0,0-26.83,9L2.12,108.11a20,20,0,0,0,9,26.83l26.67,13.34,51.18,37.41A12.15,12.15,0,0,0,93,187.62l62,16a12.27,12.27,0,0,0,3,.38,12,12,0,0,0,8.48-3.52l52.62-52.62,25.83-12.92a20,20,0,0,0,8.95-26.83Zm-58.12,29.15-27.52-26a12,12,0,0,0-16.76.26c-9.66,9.74-25.06,16.81-40.81,9.55l38.19-37h22.72l25.81,51.63ZM47.32,71.37,60.59,78l-22,43.9-13.27-6.63Zm107,107.3L101.23,165l-42-30.66L85.17,82.5,128,68.61l1.69.55L90,107.68l-.13.12a20,20,0,0,0,3.4,31c20.95,13.39,46,12.07,66.33-2.73l19.2,18.15Zm63-56.77-22-43.9,13.27-6.63,21.95,43.9ZM118.55,219a12,12,0,0,1-14.62,8.62l-26.6-6.87a12,12,0,0,1-4.08-1.93L48.92,201a12,12,0,0,1,14.16-19.37l22.47,16.42,24.38,6.29A12,12,0,0,1,118.55,219Z",
  };
  const POP_KIND_ORDER = ["observation", "distinction", "need", "practice", "idea", "objection", "question", "decision"];
  const POP_KIND_WORD = { observation: "how things are, seen or explained", distinction: "two things set apart",
    need: "what has to be true, without the how", practice: "a method that exists somewhere", idea: "something new to try",
    objection: "pushing back on something on the table", question: "left open", decision: "the room committed" };
  const kindIcon = (kind) => POP_KIND_ICONS[kind]
    ? `<span class="pop-kind-wrap" data-tip="${kind.charAt(0).toUpperCase() + kind.slice(1)}"><svg class="pop-kind" viewBox="0 0 256 256" aria-label="${kind}" role="img"><path d="${POP_KIND_ICONS[kind]}"/></svg></span>`
    : "";
  // The extractor strips terminal punctuation; the kind pass says whether the
  // phrase is a question in form, and the screen gives the question mark back.
  // A question-kind phrase not in question form gets no mark: the second pass
  // rewrites those as the question that was asked.
  const phraseText = (item) => {
    const t = item.phrase || "";
    return item.question && !/[?]$/.test(t) ? `${t}?` : t;
  };
  const KEY_DWELL_MS = 120;       // hover this long on a circle before it pops: a sweep pops a few, a pause pops one

  const state = {
    session: null,          // data/session.json
    slides: new Map(),      // slideId -> parsed json (only present files)
    popcorn: new Map(),     // transcriptId -> { done, validated?, items }
    pop: {
      live: [], fresh: {}, recycle: {}, tidTime: {}, lastSpawn: 0, lastTid: null,
      mode: "random",       // "random" (fresh first, tables alternating) or "time" (in order of the scans)
      window: null,         // null = the whole day; { from, to } = fractions along the popcorn axis
      hidden: new Set(),    // transcript ids and popcorn keys the facilitator has hidden
      kindFilter: null,     // null = every kind; { kind, mode: "only" | "except" } from the legend
      cursor: 0,            // position in the time-ordered sequence
    },
    openThemes: new Set(),  // recommendation theme accordions the presenter has opened
    // deck tabs: null = list view; an item id (or "auto" = first) = horizontal slide deck
    deck: { tensions: "auto", recommendations: null, stakeholders: null },
    searches: {},           // per-tab list search strings
    dropped: new Set(),     // data kinds loaded by drag & drop: polling never overwrites these
    active: null,           // active slide id
  };

  const SLIDES = [
    { id: "popcorn", label: "popcorn", render: renderPopcorn },
    // quotes are the registry every other slide cites, not a slide of their
    // own: the file still loads, but it never claims a tab. A quote is read
    // where it is used, in the popover its chip opens.
    { id: "quotes", file: "data/quotes.json", tab: false },
    { id: "recommendations", label: "recommendations", file: "data/recommendations.json", render: renderRecommendations },
    { id: "tensions", label: "tensions", file: "data/tensions.json", render: renderTensions },
    { id: "stakeholders", label: "stakeholders", file: "data/stakeholders.json", render: renderStakeholders },
    // custom slides are appended here as their files arrive — see registerCustom
  ];

  /* Custom slides. Breakthroughs and insights turned out not to be two
     features but one presentation type used twice: a heading, a subheading,
     quotes, and a list of them. So the type is data, not code. A file at
     data/custom/<id>.json names its own tab and supplies its own items, and
     a session declares which ones to fetch:

       session.json  "custom": ["breakthroughs", "insights", "narratives"]
       data/custom/narratives.json
         { "custom": "narratives", "label": "narratives",
           "subheadingLabel": "Where it runs", "glyph": "✦",
           "items": [{ "id": "n1", "heading": "…", "subheading": "…",
                       "quoteIds": ["q6"] }] }

     label, subheadingLabel and glyph are the only knobs: what the tab is
     called, what the second block is called, and an optional mark before the
     heading. A new slide is a new prompt and a new file, never a new render
     path. Ids that would shadow a built-in tab are refused. */

  const CUSTOM_DIR = "data/custom";

  function registerCustom(id, label) {
    if (!id || typeof id !== "string") return null;
    const existing = SLIDES.find((s) => s.id === id);
    if (existing) {
      if (!existing.custom) return null;           // never shadow a built-in tab
      if (label) existing.label = label;
      return existing;
    }
    const slide = {
      id,
      label: label || id,
      file: `${CUSTOM_DIR}/${id}.json`,
      custom: true,
      render: () => renderCustom(id),
    };
    SLIDES.push(slide);
    return slide;
  }

  const stage = document.getElementById("stage");
  const tabsEl = document.getElementById("tabs");

  /* ---------- utilities ---------- */

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function hashTilt(s) {
    let h = 0;
    for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) | 0;
    return ((Math.abs(h) % 9) - 4) * 0.55; // -2.2deg .. 2.2deg
  }

  function transcriptById(id) {
    return (state.session?.transcripts || []).find((t) => t.id === id);
  }
  function markerFor(id) {
    const i = Math.max(0, (state.session?.transcripts || []).findIndex((t) => t.id === id));
    if (i < MARKERS.length) return MARKERS[i];
    // more transcripts than brand accents: keep generating highlighter colors
    const hue = Math.round((i * 137.508) % 360);
    return `hsl(${hue} 95% 80%)`;
  }
  function shortLabel(id) {
    const t = transcriptById(id);
    return t ? (t.short || t.label) : id;
  }

  function attribution(tid) {
    return `<span class="attribution"><span class="chip" style="--marker:${markerFor(tid)}"></span>${esc(shortLabel(tid))}</span>`;
  }

  /* ---------- time on the popcorns ----------
     A conversation's time is the moment its phone scanned in. session.json
     can say it (`time`, ISO 8601) and how long the conversation ran
     (`duration`, seconds); failing the time, the transcript id is read for
     the dembrane export prefix YYYYMMDD_HHMMSS. A popcorn's own moment is
     `at` on the item when the platform knows where in the conversation it
     came from; until it does, a conversation's popcorns are spread evenly
     over its length. A transcript with no time at all sits after every
     timed one. */
  function transcriptTime(t) {
    if (!t) return null;
    if (t.time) {
      const ms = Date.parse(t.time);
      if (!Number.isNaN(ms)) return ms;
    }
    const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/.exec(t.id || "");
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
  }
  const DEFAULT_DURATION_MS = 25 * 60 * 1000;
  const transcriptDuration = (t) => (t?.duration > 0 ? t.duration * 1000 : DEFAULT_DURATION_MS);
  function popcornTime(t, item, idx, n) {
    if (item?.at) {
      const ms = Date.parse(item.at);
      if (!Number.isNaN(ms)) return ms;
    }
    const start = transcriptTime(t);
    return start === null ? null : start + ((idx + 0.5) / Math.max(1, n)) * transcriptDuration(t);
  }

  // Popcorns closer together than this belong to one sitting: five phones at
  // a table within a minute, a room full of them after a coffee break.
  const BUNDLE_GAP_MS = 10 * 60 * 1000;
  // A break between sittings is shrunk to between ten and sixty minutes of
  // axis on a log: a lunch reads wider than a coffee and a day wider than a
  // lunch, without an afternoon flattening the morning to a sliver.
  const breakMs = (gap) => BUNDLE_GAP_MS * Math.min(6, 1 + Math.log2(gap / BUNDLE_GAP_MS));

  // Every popcorn with its moment, in time order, on a compressed axis: time
  // runs to scale inside a sitting and breaks are shrunk. Each event gets
  // `f`, its place along the axis as a fraction, which is what the
  // histogram bins and the crop window work in, so neither depends on the
  // width of the screen.
  const popKey = (tid, idx, item) => (item?.id ? `${tid}#${item.id}` : `${tid}:${idx}`);
  const clockOf = (ms) => ms === null ? "no time"
    : new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  let eventsCache = { session: null, count: -1, value: null };
  function popcornEvents() {
    const count = popcornItemCount();
    if (eventsCache.value && eventsCache.session === state.session && eventsCache.count === count) return eventsCache.value;
    const events = [];
    (state.session?.transcripts || []).forEach((t, order) => {
      const items = state.popcorn.get(t.id)?.items || [];
      items.forEach((item, idx) => events.push({
        tid: t.id, idx, item, order, key: popKey(t.id, idx, item), time: popcornTime(t, item, idx, items.length),
      }));
    });
    events.sort((a, b) => ((a.time ?? Infinity) - (b.time ?? Infinity)) || (a.order - b.order) || (a.idx - b.idx));
    const sittings = [];
    let x = 0, prev = null;
    for (const e of events) {
      if (e.time === null) break;
      const gap = prev === null ? 0 : e.time - prev;
      if (prev === null || gap > BUNDLE_GAP_MS) {
        x += prev === null ? 0 : breakMs(gap);
        sittings.push({ x, time: e.time });
      } else x += gap;
      e.x = x;
      prev = e.time;
    }
    // untimed popcorns sit after the last timed one, in their own sitting
    const untimed = events.filter((e) => e.time === null);
    if (untimed.length) {
      x += prev === null ? 0 : BUNDLE_GAP_MS;
      sittings.push({ x, time: null });
      for (const e of untimed) { e.x = x; x += 30 * 1000; }
    }
    const span = Math.max(x, 1);
    for (const e of events) e.f = e.x / span;
    for (const st of sittings) st.f = st.x / span;
    const byKey = new Map(events.map((e) => [`${e.tid}:${e.idx}`, e]));
    eventsCache = { session: state.session, count, value: { events, sittings, byKey } };
    return eventsCache.value;
  }

  // What the facilitator has hidden, and what the crop window lets through.
  // The window is a pair of fractions along the axis; a popcorn is inside
  // when its moment is.
  const inWindow = (f) => !state.pop.window || (f >= state.pop.window.from && f <= state.pop.window.to);
  const popHiddenItem = (tid, idx) => state.pop.hidden.has(popKey(tid, idx, state.popcorn.get(tid)?.items?.[idx]));
  function popKindAllowed(tid, idx) {
    const f = state.pop.kindFilter;
    if (!f) return true;
    const kind = state.popcorn.get(tid)?.items?.[idx]?.kind;
    return f.mode === "only" ? kind === f.kind : kind !== f.kind;
  }
  function popVisible(tid, idx, ev = popcornEvents()) {
    if (state.pop.hidden.has(tid) || popHiddenItem(tid, idx)) return false;
    if (!popKindAllowed(tid, idx)) return false;
    const e = ev.byKey.get(`${tid}:${idx}`);
    return e ? inWindow(e.f) : true;
  }

  // Anything on stage that the crop or a hide just excluded leaves now,
  // rather than finishing its ten seconds in front of the room.
  function pruneStage() {
    const ev = popcornEvents();
    for (const rec of [...state.pop.live]) {
      if (!popVisible(rec.tid, rec.idx, ev) && rec.beginFade && !rec.el.classList.contains("pop-out")) {
        clearTimeout(rec.timer);
        rec.beginFade();
      }
    }
  }

  function quoteById(id) {
    return (state.slides.get("quotes")?.quotes || []).find((q) => q.id === id);
  }

  function quoteLinks(ids) {
    if (!ids || !ids.length) return "";
    return ids.map((id) => {
      const q = quoteById(id);
      const snip = q
        ? (q.text.length > 36 ? q.text.slice(0, 35).trimEnd() + "…" : q.text)
        : id;
      return `<button type="button" class="quote-link" data-q="${esc(id)}" aria-label="read this quote in full"><span class="ql-mark">❝</span>${esc(snip)}</button>`;
    }).join(" ");
  }


  /* Clicking any quote excerpt opens the full quote in a modal over a veil. */
  const veil = document.createElement("div");
  veil.className = "quote-veil";
  veil.hidden = true;
  veil.setAttribute("aria-hidden", "true");
  document.body.appendChild(veil);
  const tip = document.createElement("div");
  tip.className = "quote-tip";
  tip.hidden = true;
  tip.setAttribute("role", "dialog");
  tip.setAttribute("aria-modal", "true");
  tip.setAttribute("aria-labelledby", "quote-dialog-title");
  tip.setAttribute("aria-describedby", "quote-dialog-text");
  tip.tabIndex = -1;
  document.body.appendChild(tip);

  let quoteOpen = false, screenFrozen = false, focusBeforeModal = null;
  let openQuoteId = null, quoteHideTimer = null;

  // A quote modal stops the room's screen dead: no pointer or keyboard reaches
  // what is behind it, no phrase pops in or fades out, and any data that lands
  // while it is open waits to be drawn until it closes. Reading a quote aloud
  // should never be a race against the stage.
  function freezeScreen(on) {
    if (screenFrozen === on) return;
    screenFrozen = on;
    for (const rec of state.pop.live) {
      if (on) {
        clearTimeout(rec.timer);
        rec.el.classList.remove("pop-out");   // un-fade anything caught mid-exit
      } else if (rec.beginFade) {
        rec.timer = setTimeout(rec.beginFade, POP_HOLD);
      }
    }
    document.querySelectorAll("header.topbar, #stage, footer.colophon")
      .forEach((el) => { el.inert = on; });
    if (!on && state.renderPending) { state.renderPending = false; renderActive(); }
  }
  // only ever follow a link the data actually vouches for
  const httpUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : null);

  // A quote has one presentation: a centred modal over a held screen. There is
  // no anchored variant, so nothing has to be positioned against a chip, and
  // nothing points at an element that may have scrolled or faded away.
  function showQuoteTip(quoteId, returnFocusTo) {
    const q = quoteById(quoteId);
    if (!q) return;
    const href = httpUrl(q.url);
    clearTimeout(quoteHideTimer);
    tip.innerHTML = `<h2 class="sr-only" id="quote-dialog-title">Quoted transcript excerpt</h2>
      <button type="button" class="quote-tip-close" aria-label="Close quote">✕</button>
      <p class="tip-text" id="quote-dialog-text">“${esc(q.text)}”</p>
      ${attribution(q.transcript)}
      ${q.context ? `<p class="quote-context">${esc(q.context)}</p>` : ""}
      ${href ? `<a class="quote-source" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Open the transcript ↗</a>` : ""}`;
    openModal(quoteId, returnFocusTo);
  }

  /* Host only. An unverified phrase opens the passage it most likely came from
     (rarity-weighted word overlap, the same aid the prompt reviewer uses). It
     is labelled as a reading aid, never shown as a quote, and never reaches
     the public page: the server leaves `source` out of the room's bundle. */
  function showSourceTip(item, tid, returnFocusTo) {
    const src = item.source;
    if (!src || !src.text || presenting) return;
    const href = httpUrl(src.url);
    clearTimeout(quoteHideTimer);
    tip.innerHTML = `<h2 class="sr-only" id="quote-dialog-title">Why this phrase</h2>
      <button type="button" class="quote-tip-close" aria-label="Close">✕</button>
      <p class="source-kicker">why this phrase · closest passage, not a quote</p>
      <p class="source-phrase">${esc(item.phrase)}</p>
      <p class="tip-text source-text" id="quote-dialog-text">${esc(src.text)}</p>
      ${attribution(tid)}
      ${href ? `<a class="quote-source" href="${esc(href)}" target="_blank" rel="noopener noreferrer">Open the conversation ↗</a>` : ""}`;
    openModal(null, returnFocusTo);
  }

  function openModal(quoteId, returnFocusTo) {
    tip.hidden = false;
    veil.hidden = false;
    // Let the closed state paint before adding the transition class when the
    // dialog was hidden rather than merely faded out.
    void tip.offsetWidth;
    tip.classList.add("show");
    veil.classList.add("show");
    quoteOpen = true;
    openQuoteId = quoteId;
    focusBeforeModal = returnFocusTo || document.activeElement;
    freezeScreen(true);
    tip.querySelector(".quote-tip-close")?.focus({ preventScroll: true });
  }
  const hideTip = () => {
    if (!quoteOpen) return;
    tip.classList.remove("show");
    veil.classList.remove("show");
    quoteOpen = false;
    const restoreFocus = focusBeforeModal;
    const restoreQuoteId = openQuoteId;
    focusBeforeModal = null;
    openQuoteId = null;
    freezeScreen(false);
    const replacement = restoreFocus?.isConnected ? restoreFocus
      : [...document.querySelectorAll(".quote-link")].find((el) => el.dataset.q === restoreQuoteId);
    replacement?.focus?.({ preventScroll: true });
    clearTimeout(quoteHideTimer);
    quoteHideTimer = setTimeout(() => {
      if (quoteOpen) return;
      tip.hidden = true;
      veil.hidden = true;
    }, 160);
  };

  // dev hook: ?tip=<quoteId> pins the tooltip open, for deterministic screenshots
  const tipDebug = new URLSearchParams(location.search).get("tip");
  if (tipDebug) setTimeout(() => {
    const l = document.querySelector(`.quote-link[data-q="${tipDebug}"]`);
    if (l) { l.scrollIntoView({ block: "center" }); setTimeout(() => showQuoteTip(l.dataset.q, l), 400); }
  }, 1200);

  document.addEventListener("click", (e) => {
    const l = e.target.closest?.(".quote-link");
    if (l) {
      e.preventDefault();
      showQuoteTip(l.dataset.q, l);
      return;
    }
    if (quoteOpen && !tip.contains(e.target)) hideTip();
  });
  tip.addEventListener("click", (e) => {
    if (e.target.closest?.(".quote-tip-close")) hideTip();
  });
  addEventListener("keydown", (e) => {
    if (!quoteOpen) return;
    if (e.key === "Escape") {
      e.preventDefault();
      hideTip();
      return;
    }
    if (e.key !== "Tab") return;
    const focusable = [...tip.querySelectorAll("button:not([disabled]), a[href]")]
      .filter((el) => !el.hidden);
    if (!focusable.length) {
      e.preventDefault();
      tip.focus({ preventScroll: true });
      return;
    }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!tip.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus({ preventScroll: true });
    } else if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  });
  veil.addEventListener("click", hideTip);
  // the anchor moves out from under a pinned popover if the stage scrolls
  stage.addEventListener("scroll", hideTip);

  let bundleCache = { at: 0, promise: null };
  function fetchBundle() {
    const now = Date.now();
    if (!bundleCache.promise || now - bundleCache.at > BUNDLE_MAX_AGE_MS) {
      bundleCache = {
        at: now,
        promise: fetch(`data/bundle.json?t=${now}${presenting ? "&view=room" : ""}${EMBED.version ? `&version=${encodeURIComponent(EMBED.version)}` : ""}`, { cache: "no-store" })
          .then((res) => (res.ok ? res.json() : null))
          .catch(() => null),
      };
    }
    return bundleCache.promise;
  }

  async function fetchJson(url) {
    if (EMBED) {
      const bundle = await fetchBundle();
      const files = bundle && bundle.files;
      if (!files) return null;
      const key = String(url).replace(/^data\//, "");
      return Object.prototype.hasOwnProperty.call(files, key) ? files[key] : null;
    }
    try {
      const res = await fetch(`${url}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  /* ---------- data loading & polling ---------- */

  function applySession() {
    const session = state.session;
    if (!session) return;
    document.getElementById("session-title").textContent = session.title || "session";
    document.getElementById("session-meta").textContent = [session.client, session.date].filter(Boolean).join(" · ");
    document.title = `${session.title || "session"} — popcorn`;
    // The mark in the footer is a setting for hosts on a paid plan.
    const mark = document.querySelector(".made-with");
    if (mark) mark.hidden = session.branding === false;
    renderQrPanel();
  }

  /* The QR panel invites the room to add its voice: the portal link as a brand
     code (graphite modules, blue eyes) on the popcorn stage. session.qr is
     present only while the host has switched it on, so the panel follows the
     session poll and never needs a reload. */
  function renderQrPanel() {
    const host = stage.querySelector(".popcorn");
    if (!host) return;
    const qr = state.session?.qr;
    let panel = host.querySelector(".qr-panel");
    const meta = hostMeta();
    let ghost = host.querySelector(".qr-ghost");
    if (!qr || !(qr.svg || qr.image)) {
      if (panel) panel.remove();
      // Host only: the empty corner offers the code where it would appear.
      if (meta && meta.qrAvailable && !meta.qr) {
        if (!ghost) {
          ghost = document.createElement("button");
          ghost.type = "button";
          ghost.className = "qr-ghost";
          ghost.innerHTML = `<span class="qr-ghost-mark">+</span><span>qr code for the room</span>`;
          ghost.addEventListener("click", () => { postHostSetting({ show_qr: true }); ghost.disabled = true; });
          host.appendChild(ghost);
        }
      } else if (ghost) ghost.remove();
      return;
    }
    if (ghost) ghost.remove();
    if (!panel) {
      panel = document.createElement("aside");
      panel.className = "qr-panel";
      panel.setAttribute("aria-label", "scan to add your voice");
      host.appendChild(panel);
    }
    const label = qr.label || "add your voice";
    // The server draws the code (dembrane logomark in the middle, like the
    // dashboard's QR). Inline SVG so the logo image loads next to the page.
    const code = qr.svg
      ? `<div class="qr-image" role="img" aria-label="QR code: ${esc(label)}">${qr.svg}</div>`
      : `<img class="qr-image" alt="QR code: ${esc(label)}" src="${esc(qr.image)}">`;
    const hide = meta ? `<button type="button" class="qr-hide" title="take the code off the screen" aria-label="take the QR code off the screen">×</button>` : "";
    const next = `${hide}${code}<span class="qr-label">${esc(label)}</span>`;
    if (panel.innerHTML !== next) {
      panel.innerHTML = next;
      panel.querySelector(".qr-hide")?.addEventListener("click", (ev) => { ev.stopPropagation(); postHostSetting({ show_qr: false }); ev.currentTarget.disabled = true; });
    }
  }

  async function loadAll() {
    if (!state.dropped.has("session")) {
      const session = await fetchJson("data/session.json");
      if (session) {
        state.session = session;
        applySession();
      }
    }

    // the session names the custom slides to look for; their files name themselves
    for (const c of state.session?.custom || []) {
      registerCustom(typeof c === "string" ? c : c?.id, typeof c === "string" ? null : c?.label);
    }

    // The live path must not wait for the analytical slides. Put the default
    // popcorn stage on screen and begin its fast poll as soon as the session
    // has told us which transcript files exist.
    if (state.session) {
      const requested = parseHash().slide;
      if (!state.active && (!requested || requested === "popcorn"))
        showSlide("popcorn", null, { replace: true });
      startPopcornPolling();
    }

    // the other slides: file present -> tab present (dropped data wins)
    await Promise.all(SLIDES.map(async (s) => {
      if (!s.file || state.dropped.has(s.id)) return;
      const data = await fetchJson(s.file);
      if (data) {
        const prev = s._raw;
        s._raw = JSON.stringify(data);
        if (s._raw !== prev) {
          if (s.custom && data.label) s.label = data.label;
          state.slides.set(s.id, data);
          if (state.active === s.id) {
            if (screenFrozen) state.renderPending = true; else renderActive();
          }
        }
      } else if (EMBED && state.slides.has(s.id)) {
        // The host hid this tab: its file left the bundle, so the tab leaves
        // the deck, and the room is moved back to popcorn if it was open.
        state.slides.delete(s.id);
        s._raw = undefined;
        if (state.active === s.id) showSlide("popcorn", null, { replace: true });
      }
    }));

    renderTabs();
    renderProgress();
    if (!state.active) {
      const first = visibleSlides()[0];
      if (first) showSlide(parseHash().slide || first.id, parseHash().sub, { replace: true });
    }
  }

  function visibleSlides() {
    return SLIDES.filter((s) => s.tab === false ? false
      : s.id === "popcorn" ? true : state.slides.has(s.id));
  }

  /* ---------- chrome ---------- */

  /* Host mode: the tab row is also where tabs are switched on and off, in
     the row's own idiom. A hidden tab stays in the row as soft-ink text with
     a royal +; a visible optional tab grows a × on hover. The host page gets
     a message and saves the change; the deck follows on its next poll. */
  const HOST = EMBED && EMBED.mode === "host";
  // While the host page is fullscreen the preview *is* the wall: no host
  // affordances, no passages, exactly what the public page shows.
  let presenting = false;
  const hostMeta = () => (HOST && !presenting && state.session && state.session.host) || null;
  if (HOST) {
    window.addEventListener("message", (ev) => {
      const d = ev.data;
      if (!d || d.type !== "dembrane:popcorn:presenting") return;
      presenting = !!d.value;
      document.body.classList.toggle("presenting", presenting);
      renderTabs();
      renderQrPanel();
    });
  }
  function postHostSetting(patch) {
    if (!HOST || !window.parent || window.parent === window) return;
    window.parent.postMessage({ type: "dembrane:popcorn:settings", patch }, "*");
  }

  function renderTabs() {
    const slides = visibleSlides();
    const meta = hostMeta();
    const toggleable = meta ? Object.keys(meta.tabs || {}) : [];
    tabsEl.innerHTML = slides.map((s) => {
      const canHide = meta && toggleable.includes(s.id);
      return `<span class="tab-wrap"><button class="tab" role="tab" aria-selected="${s.id === state.active}" data-slide="${s.id}">${esc(s.label)}</button>${
        canHide ? `<button type="button" class="tab-hide" data-hide="${s.id}" title="hide this tab from the room" aria-label="hide ${esc(s.label)} from the room">×</button>` : ""}</span>`;
    }).join("") + (meta ? toggleable.filter((id) => !meta.tabs[id]).map((id) =>
      `<button type="button" class="tab tab-ghost" data-show="${id}" title="show this tab to the room" aria-label="show ${esc(id)} to the room">${esc(id)} <span class="tab-plus">+</span></button>`
    ).join("") : "");
    tabsEl.querySelectorAll(".tab[data-slide]").forEach((el) =>
      el.addEventListener("click", () => showSlide(el.dataset.slide)));
    tabsEl.querySelectorAll(".tab-hide").forEach((el) =>
      el.addEventListener("click", (ev) => { ev.stopPropagation(); postHostSetting({ tabs: { [el.dataset.hide]: false } }); el.disabled = true; }));
    tabsEl.querySelectorAll(".tab-ghost").forEach((el) =>
      el.addEventListener("click", () => { postHostSetting({ tabs: { [el.dataset.show]: true } }); el.disabled = true; }));
  }

  function renderProgress() {
    const el = document.getElementById("progress-note");
    // Local development only: the host bundle offers the account of what the
    // tick does; the room's bundle never does.
    const flow = hostMeta() && hostMeta().flow;
    let link = document.getElementById("flow-link");
    if (flow && !link) {
      link = document.createElement("a");
      link.id = "flow-link"; link.className = "flow-link"; link.href = flow; link.target = "_blank"; link.rel = "noopener";
      link.textContent = "how popcorn works";
      document.querySelector(".colophon-left")?.appendChild(link);
    } else if (!flow && link) {
      link.remove();
    }
    const total = state.session?.transcripts?.length || 0;
    if (!total) { el.textContent = ""; return; }
    const done = [...state.popcorn.values()].filter((p) => p.done).length;
    const live = done < total;
    if (EMBED) {
      // Say what is happening in words: hosts read this footer to know whether
      // the deck is still working on a table.
      const pending = total - done;
      el.innerHTML = live
        ? `<span class="live-dot"></span>reading ${pending} of ${total} conversation${total === 1 ? "" : "s"}…`
        : `${total} conversation${total === 1 ? "" : "s"} · all read`;
      return;
    }
    el.innerHTML = `${live ? '<span class="live-dot"></span>' : ""}${total} conversation${total === 1 ? "" : "s"} · ${done} read`;
  }

  /* ---------- routing ---------- */

  function parseHash() {
    const [slide, sub] = location.hash.replace(/^#/, "").split("/");
    return { slide: slide || null, sub: sub || null };
  }

  function showSlide(id, sub, { replace } = {}) {
    const slides = visibleSlides();
    if (!slides.some((s) => s.id === id)) id = slides[0]?.id;
    if (!id) return;
    state.active = id;
    if (sub && isDeckTab(id)) state.deck[id] = sub;
    const sel = isDeckTab(id) && state.deck[id] && state.deck[id] !== "auto" ? state.deck[id] : null;
    const hash = `#${id}${sel ? "/" + sel : ""}`;
    if (location.hash !== hash) {
      if (replace) history.replaceState(null, "", hash); else history.pushState(null, "", hash);
    }
    renderTabs();
    renderActive();
    stage.scrollTop = 0;
  }

  window.addEventListener("popstate", () => {
    const { slide, sub } = parseHash();
    if (!slide) return;
    state.active = slide;
    if (isDeckTab(slide)) state.deck[slide] = sub || (slide === "tensions" ? "auto" : null);
    renderTabs();
    renderActive();
  });

  document.addEventListener("keydown", (e) => {
    if (e.target.matches?.("input, textarea, .tl-handle, .tl-grip")) return;
    if (screenFrozen) { if (e.key === "Escape") hideTip(); return; }
    if (e.key === "Escape") {
      if (isDeckTab(state.active) && state.deck[state.active]) {
        state.deck[state.active] = null;
        showSlide(state.active);
        return;
      }
    }
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    // inside an open deck, arrows move between its slides, not between tabs
    if (isDeckTab(state.active) && state.deck[state.active]) {
      const track = document.getElementById("deck-track");
      if (track) {
        track.scrollBy({ left: (e.key === "ArrowRight" ? 1 : -1) * track.clientWidth, behavior: "smooth" });
        return;
      }
    }
    const slides = visibleSlides();
    const i = slides.findIndex((s) => s.id === state.active);
    const next = slides[(i + (e.key === "ArrowRight" ? 1 : -1) + slides.length) % slides.length];
    if (next) showSlide(next.id);
  });

  function renderActive() {
    // popcorn manages its own geometry: the stage ends exactly at the fold
    stage.classList.toggle("stage-flush", state.active === "popcorn");
    const slide = SLIDES.find((s) => s.id === state.active);
    if (slide) slide.render();
  }

  /* ---------- popcorn ----------
     A stage, not a wall. Phrases pop in as agents land them, hold for a
     solid read (POP_HOLD), then fade out. The first phrase to arrive takes
     centre stage; once the fresh queue is dry, phrases recycle so the
     screen never goes dead. */

  // New two-pass files stop only when validation is complete. Legacy files do
  // not have `validated`, so their historical `done` flag remains final.
  function popcornSettled(data) {
    if (!data) return false;
    return Object.prototype.hasOwnProperty.call(data, "validated")
      ? data.validated === true
      : data.done === true;
  }

  const popcornItemCount = () => [...state.popcorn.values()]
    .reduce((n, d) => n + (d.items?.length || 0), 0);

  const popcornHasPendingFiles = () => (state.session?.transcripts || []).some((t) =>
    !state.dropped.has(`popcorn:${t.id}`) && !popcornSettled(state.popcorn.get(t.id)));

  // Fetch every transcript concurrently. Serial requests make the last table
  // pay for every earlier table's round trip, which is incompatible with a
  // two-second first-pop target.
  async function pollPopcorn() {
    const jobs = (state.session?.transcripts || []).map(async (t) => {
      const cached = state.popcorn.get(t.id);
      // Upstream stops asking for a settled file. Here every file rides one
      // bundle request anyway, and a settled conversation can be re-read when
      // its transcript grows, so a settled file is still applied when its
      // revision moved.
      if ((!EMBED && popcornSettled(cached)) || state.dropped.has(`popcorn:${t.id}`)) return;
      const data = await fetchJson(`data/popcorn/${t.id}.json`);
      // A drop may have landed while this request was in flight; dropped data
      // always wins over the development server.
      if (!data || state.dropped.has(`popcorn:${t.id}`)) return;
      if (cached && popcornSettled(cached) && data.revision === cached.revision) return;
      state.popcorn.set(t.id, data);
    });
    await Promise.all(jobs);
    renderProgress();
    if (state.active === "popcorn") {
      const count = popcornItemCount();
      if (count !== state.pop.tailCount) renderPopTail();
    }
  }

  // Poll aggressively only while the room is looking at an empty stage. Once
  // the first recognition is visible, back off to the normal live cadence.
  // Recursive timeouts prevent overlapping polls on a slow filesystem.
  let popPollingStarted = false;
  function startPopcornPolling() {
    if (popPollingStarted) return;
    popPollingStarted = true;
    const run = async () => {
      try {
        await pollPopcorn();
      } finally {
        const needsFirstPhrase = !popcornItemCount() && popcornHasPendingFiles();
        setTimeout(run, needsFirstPhrase ? POP_FAST_POLL_MS : POP_POLL_MS);
      }
    };
    run();
  }


  function renderPopcorn() {
    // The keys strip sits between the stage and the tail and sticks to the
    // bottom of the fold while the stage is showing: the histogram is a
    // keyboard (click a circle and it pops on the stage above), with the
    // play control under it. Scroll down and the strip settles at the top
    // of the list.
    // Three beats on scroll. The stage fills the fold and is pinned there;
    // the first scroll slides the keys strip up over its foot; the next
    // scroll takes the whole fold away and brings the settings (search,
    // hide). Scroll snapping lands on each beat, and a wheel from the very
    // top is steered to the keys so the first beat never gets skipped.
    stage.innerHTML = `<div class="pop-fold" id="pop-fold">
    <section class="popcorn" aria-label="popcorn — moments of recognition from the conversations">
      <div class="pop-stage" id="pop-stage"></div>
    </section>
    <section class="pop-keys" id="pop-keys" aria-label="when the popcorns happened, and how the stage plays">
      <div class="pop-timeline" id="pop-timeline" aria-label="the popcorns over the day; hover one to pop it, click to hold or release it, drag the edges to crop"></div>
      <div class="pop-play" role="group" aria-label="how the stage plays">
        <span class="pop-play-label">play</span>
        <button type="button" class="pop-mode" data-mode="time" aria-pressed="${state.pop.mode === "time"}">in order of time</button>
        <button type="button" class="pop-mode" data-mode="random" aria-pressed="${state.pop.mode === "random"}">at random</button>
        <span class="pop-play-note" id="pop-play-note"></span>
        <span class="pop-keys-hint">hover a circle to pop it, click to hold or release · settings ↓</span>
      </div>
    </section>
    </div>
    <section class="pop-tail" aria-label="all popcorn phrases">
      <p class="pop-disclaimer">popcorn is optimised for latency, not accuracy. popcorns in “quotes” are verified against the conversation; the rest are not direct quotes.</p>
      <div class="quote-tools">
        <input class="quote-search" id="pop-search" type="search" placeholder="search the popcorn…" aria-label="search popcorn phrases" value="${esc(state.popSearch || "")}">
        <div class="kind-legend" id="kind-legend" aria-label="filter the popcorn by kind" hidden></div>
        <span class="quote-count" id="pop-count"></span>
      </div>
      <div class="pop-tables" id="pop-list"></div>
    </section>`;
    state.pop.live = [];
    state.pop.lastSpawn = 0;
    const input = document.getElementById("pop-search");
    input.addEventListener("input", () => {
      state.popSearch = input.value;
      renderPopTables();
    });
    stage.querySelectorAll(".pop-mode").forEach((b) => b.addEventListener("click", () => {
      state.pop.mode = b.dataset.mode;
      state.pop.cursor = 0;
      stage.querySelectorAll(".pop-mode").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    }));
    // hide and unhide: a phrase for itself, a conversation's name for the lot
    document.getElementById("pop-list").addEventListener("click", (ev) => {
      const el = ev.target.closest("[data-hide]");
      if (!el) return;
      togglePopHidden(el.dataset.hide);
    });
    // the keyboard: resting on a circle pops its phrase somewhere on the
    // stage, where it lingers; a click holds one that is up, or releases it
    const keys = document.getElementById("pop-timeline");
    let dwell = null;
    const bounce = (dot) => { dot.classList.remove("popped"); void dot.offsetWidth; dot.classList.add("popped"); };
    keys.addEventListener("mouseover", (ev) => {
      const dot = ev.target.closest(".tl-dot");
      if (!dot || dot === dwell?.dot) return;
      clearTimeout(dwell?.t);
      dwell = { dot, t: setTimeout(() => {
        dwell = null;
        if (!dot.classList.contains("on")) { bounce(dot); popNow(dot.dataset.tid, Number(dot.dataset.idx)); }
      }, KEY_DWELL_MS) };
    });
    keys.addEventListener("mouseout", (ev) => {
      const dot = ev.target.closest(".tl-dot");
      if (dot && dwell?.dot === dot) { clearTimeout(dwell.t); dwell = null; }
    });
    keys.addEventListener("click", (ev) => {
      const dot = ev.target.closest(".tl-dot");
      if (!dot) return;
      clearTimeout(dwell?.t); dwell = null;
      bounce(dot);
      popNow(dot.dataset.tid, Number(dot.dataset.idx), { toggle: true });
    });
    // a wheel from the very top goes to the keys and no further, so the
    // first scroll always reveals the keyboard; trackpad momentum is held
    // off for a moment so it cannot carry straight on to the settings
    if (!state.pop.wheelWired) {
      state.pop.wheelWired = true;
      stage.addEventListener("wheel", (ev) => {
        if (state.active !== "popcorn") return;
        if (state.pop.scrollHold && Date.now() < state.pop.scrollHold) { ev.preventDefault(); return; }
        const keysEl = document.getElementById("pop-keys");
        if (!keysEl || stage.scrollTop > 2 || ev.deltaY <= 0) return;
        ev.preventDefault();
        stage.scrollTo({ top: keysEl.offsetHeight, behavior: "smooth" });
        state.pop.scrollHold = Date.now() + 800;
      }, { passive: false });
    }
    renderPopTail();
    renderQrPanel();
    popTick();
  }

  // Pop this one now, ahead of the queue: whatever is on stage starts
  // leaving and the chosen phrase lands centre-stage at full size. Other
  // open windows of the page (a projector, say) pop it too.
  const popChannel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("popcorn-stage") : null;
  popChannel?.addEventListener("message", (ev) => {
    if (ev.data?.type === "pop" && state.active === "popcorn") popNow(ev.data.tid, ev.data.idx, { relay: true, toggle: !!ev.data.toggle });
  });
  // Pop this one from the keys: it lands somewhere free on the stage and
  // lingers, and nothing already up is disturbed. If it is up already, a
  // hover holds it a while longer and a click (toggle) lets it go. When
  // the stage is crowded with keyed phrases the oldest one gives way.
  const leaveNow = (rec) => {
    if (rec.beginFade && !rec.el.classList.contains("pop-out")) { clearTimeout(rec.timer); rec.beginFade(); }
  };
  function popNow(tid, idx, { relay = false, toggle = false } = {}) {
    const stageEl = document.getElementById("pop-stage");
    if (!stageEl || !state.popcorn.get(tid)?.items?.[idx]) return;
    if (screenFrozen) return;
    stageEl.querySelector(".popcorn-waiting")?.remove();
    const up = state.pop.live.find((l) => l.tid === tid && l.idx === idx);
    if (up) {
      if (toggle) leaveNow(up);
      else if (up.beginFade) { clearTimeout(up.timer); up.el.classList.remove("pop-out"); up.timer = setTimeout(up.beginFade, POP_HOLD_PINNED); }
    } else {
      const staying = state.pop.live.filter((l) => !l.el.classList.contains("pop-out"));
      while (staying.length >= POP_CAP) leaveNow(staying.shift());
      spawnPop(stageEl, { tid, idx }, { pinned: true });
      state.pop.lastSpawn = Date.now();   // the automatic flow waits its turn
    }
    if (!relay) popChannel?.postMessage({ type: "pop", tid, idx, toggle });
  }

  // the circles of whatever is on stage wear a ring
  function markDotsOnStage() {
    const keys = document.getElementById("pop-timeline");
    if (!keys) return;
    keys.querySelectorAll(".tl-dot.on").forEach((d) => d.classList.remove("on"));
    for (const rec of state.pop.live) {
      if (rec.el.classList.contains("pop-out")) continue;
      keys.querySelector(`.tl-dot[data-tid="${CSS.escape(rec.tid)}"][data-idx="${rec.idx}"]`)?.classList.add("on");
    }
  }

  function togglePopHidden(key) {
    if (state.pop.hidden.has(key)) state.pop.hidden.delete(key);
    else state.pop.hidden.add(key);
    pruneStage();
    renderPopTail();
  }

  // the long tail: when the conversations happened, then every phrase so far
  function renderPopTail() {
    if (!document.getElementById("pop-list")) return;
    renderPopTimeline();
    renderPopTables();
    state.pop.tailCount = popcornItemCount();
  }

  /* The timeline: a histogram of the popcorns over the day. The track is
     cut into bins about fourteen pixels wide, every popcorn lands in the
     bin its moment falls in, and each bin stacks its popcorns as circles in
     their conversations' colours, in time order, so tables that ran at the
     same time mix in the same stacks. Time is to scale inside a sitting and
     breaks are shrunk (popcornEvents), and the axis is fractions, so the
     picture re-bins on every width without moving the crop. Two handles
     crop a window; the stage plays only the popcorns inside it. Sittings
     are labelled with the time they began. */
  const TL_BIN_PX = 18;
  const TL_STACK_PX = 72;
  function renderPopTimeline() {
    const host = document.getElementById("pop-timeline");
    if (!host) return;
    const { events, sittings } = popcornEvents();
    if (!events.length) { host.innerHTML = ""; return; }
    const W = host.clientWidth || 800;
    const N = Math.max(24, Math.min(160, Math.round(W / TL_BIN_PX)));
    const bins = Array.from({ length: N }, () => []);
    for (const e of events) bins[Math.min(N - 1, Math.floor(e.f * N))].push(e);
    const tallest = Math.max(1, ...bins.map((b) => b.length));
    const sq = Math.max(3, Math.min(14, Math.floor(W / N) - 4, Math.floor(TL_STACK_PX / tallest) - 1));
    const w = state.pop.window;
    const binIn = (k) => !w || ((k + 1) / N > w.from && k / N < w.to);
    const html = bins.map((b, k) =>
      `<div class="tl-bin${binIn(k) ? "" : " out"}" data-k="${k}">${b.map((e) => {
        const off = state.pop.hidden.has(e.tid) || state.pop.hidden.has(e.key);
        return `<button type="button" class="tl-dot${off ? " off" : ""}" tabindex="-1" data-tid="${esc(e.tid)}" data-idx="${e.idx}" style="--marker:${markerFor(e.tid)}" aria-label="pop: ${esc(e.item.phrase)}"></button>`;
      }).join("")}</div>`).join("");
    const labels = sittings.map((st) =>
      `<span class="tl-time" style="left:min(${(st.f * 100).toFixed(2)}%, calc(100% - 3.4em))">${esc(clockOf(st.time))}</span>`).join("");
    host.innerHTML = `<div class="tl-track"><div class="tl-inner" style="--sq:${sq}px">${html}${labels}
      <div class="tl-window" id="tl-window">
        <span class="tl-grip" tabindex="0" role="slider" aria-label="move the window, keeping its length" aria-valuemin="0" aria-valuemax="${N}" aria-valuenow="${w ? Math.round(w.from * N) : 0}"></span>
        <span class="tl-handle" data-edge="start" tabindex="0" role="slider" aria-label="start of the window" aria-valuemin="0" aria-valuemax="${N}" aria-valuenow="${w ? Math.round(w.from * N) : 0}"></span>
        <span class="tl-handle" data-edge="end" tabindex="0" role="slider" aria-label="end of the window" aria-valuemin="0" aria-valuemax="${N}" aria-valuenow="${w ? Math.round(w.to * N) : N}"></span>
      </div></div></div>`;
    placeWindow();
    wireWindow(N);
    // the bins are cut from the width, so a new width is a new histogram
    if (!state.pop.tlObserver && typeof ResizeObserver !== "undefined") {
      state.pop.tlObserver = new ResizeObserver(() => {
        syncKeysHeight();
        const el = document.getElementById("pop-timeline");
        if (!el || el.dataset.w === String(el.clientWidth)) return;
        el.dataset.w = String(el.clientWidth);
        renderPopTimeline();
      });
    }
    host.dataset.w = String(host.clientWidth);
    if (state.pop.tlObserver) state.pop.tlObserver.observe(host);
    markDotsOnStage();
    syncKeysHeight();
  }

  // the fold is the stage plus the keys strip; the stage stays pinned while
  // the strip slides up over its foot, so the fold must know the strip's height
  function syncKeysHeight() {
    const fold = document.getElementById("pop-fold");
    const keys = document.getElementById("pop-keys");
    if (fold && keys) fold.style.setProperty("--keys-h", `${keys.offsetHeight}px`);
  }

  function placeWindow() {
    const win = document.getElementById("tl-window");
    if (!win) return;
    const w = state.pop.window || { from: 0, to: 1 };
    win.style.left = `${(w.from * 100).toFixed(3)}%`;
    win.style.width = `${((w.to - w.from) * 100).toFixed(3)}%`;
    win.classList.toggle("tl-window-all", !state.pop.window);
    const note = document.getElementById("pop-play-note");
    if (note) {
      const ev = popcornEvents();
      const shown = ev.events.filter((e) => popVisible(e.tid, e.idx, ev));
      const timed = shown.filter((e) => e.time !== null);
      note.textContent = (state.pop.window || state.pop.hidden.size || state.pop.kindFilter) && ev.events.length
        ? `${shown.length} of ${ev.events.length} popcorns${timed.length ? `, ${clockOf(timed[0].time)} to ${clockOf(timed[timed.length - 1].time)}` : ""}`
        : "";
    }
  }

  function wireWindow(N) {
    const inner = document.querySelector("#pop-timeline .tl-inner");
    if (!inner) return;
    const edgeAt = (clientX) => {
      const r = inner.getBoundingClientRect();
      return Math.max(0, Math.min(N, Math.round(((clientX - r.left) / r.width) * N)));
    };
    const applyWindow = (next) => {
      next.from = Math.max(0, next.from);
      next.to = Math.min(1, next.to);
      state.pop.window = (next.from <= 0 && next.to >= 1) ? null : next;
      state.pop.cursor = 0;
      placeWindow();
      inner.querySelectorAll(".tl-bin").forEach((b) => {
        const j = Number(b.dataset.k);
        b.classList.toggle("out", !!state.pop.window && !((j + 1) / N > next.from && j / N < next.to));
      });
      inner.querySelector('.tl-handle[data-edge="start"]')?.setAttribute("aria-valuenow", String(Math.round(next.from * N)));
      inner.querySelector('.tl-handle[data-edge="end"]')?.setAttribute("aria-valuenow", String(Math.round(next.to * N)));
      inner.querySelector(".tl-grip")?.setAttribute("aria-valuenow", String(Math.round(next.from * N)));
      pruneStage();
      renderPopTables();
    };
    const setEdge = (edge, k) => {
      const cur = state.pop.window || { from: 0, to: 1 };
      const step = 1 / N;
      applyWindow(edge === "start"
        ? { from: Math.min(k * step, cur.to - step), to: cur.to }
        : { from: cur.from, to: Math.max(k * step, cur.from + step) });
    };
    // the grip along the top of the window moves the whole window, length kept,
    // snapped to bins, so a length set with the handles can be walked over the day
    const moveWindow = (fromK) => {
      const cur = state.pop.window;
      if (!cur) return;
      const len = cur.to - cur.from;
      const from = Math.max(0, Math.min(1 - len, fromK / N));
      applyWindow({ from, to: from + len });
    };
    const grip = inner.querySelector(".tl-grip");
    if (grip) {
      grip.addEventListener("pointerdown", (ev) => {
        const cur = state.pop.window;
        if (!cur) return;
        ev.preventDefault();
        try { grip.setPointerCapture(ev.pointerId); } catch { /* synthetic pointers have nothing to capture */ }
        grip.classList.add("dragging");
        const r = inner.getBoundingClientRect();
        const startX = ev.clientX, startFrom = cur.from;
        const move = (e) => moveWindow(Math.round((startFrom + (e.clientX - startX) / r.width) * N));
        const up = () => {
          grip.classList.remove("dragging");
          grip.removeEventListener("pointermove", move);
          grip.removeEventListener("pointerup", up);
          grip.removeEventListener("pointercancel", up);
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
        grip.addEventListener("pointercancel", up);
      });
      grip.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        ev.preventDefault();
        ev.stopPropagation();
        const cur = state.pop.window;
        if (!cur) return;
        const at = Math.round(cur.from * N);
        moveWindow(ev.key === "ArrowLeft" ? at - 1 : at + 1);
      });
    }
    inner.querySelectorAll(".tl-handle").forEach((h) => {
      h.addEventListener("pointerdown", (ev) => {
        ev.preventDefault();
        try { h.setPointerCapture(ev.pointerId); } catch { /* synthetic pointers have nothing to capture */ }
        h.classList.add("dragging");
        const move = (e) => setEdge(h.dataset.edge, edgeAt(e.clientX));
        const up = () => {
          h.classList.remove("dragging");
          h.removeEventListener("pointermove", move);
          h.removeEventListener("pointerup", up);
          h.removeEventListener("pointercancel", up);
        };
        h.addEventListener("pointermove", move);
        h.addEventListener("pointerup", up);
        h.addEventListener("pointercancel", up);
      });
      h.addEventListener("keydown", (ev) => {
        if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
        // the page moves between tabs on these keys; a focused handle owns them
        ev.preventDefault();
        ev.stopPropagation();
        const cur = state.pop.window || { from: 0, to: 1 };
        const at = Math.round((h.dataset.edge === "start" ? cur.from : cur.to) * N);
        setEdge(h.dataset.edge, ev.key === "ArrowLeft" ? Math.max(0, at - 1) : Math.min(N, at + 1));
      });
    });
  }

  // Every phrase so far, one group per conversation in the order they
  // scanned in. A phrase is a button that hides itself; the conversation's
  // name hides the lot. A phrase outside the crop window is dimmed.
  // The legend is a filter. One click on a kind keeps only that kind; a second
  // click on the same kind turns it inside out (everything but that kind); a
  // third returns to every kind. Clicking a different kind starts over with it.
  function renderKindLegend() {
    const host = document.getElementById("kind-legend");
    if (!host) return;
    const any = [...state.popcorn.values()].some((f) => (f.items || []).some((it) => it.kind));
    host.hidden = !any;
    if (!any) return;
    const f = state.pop.kindFilter;
    host.innerHTML = POP_KIND_ORDER.map((k) => {
      const mode = f && f.kind === k ? f.mode : "";
      const label = k.charAt(0).toUpperCase() + k.slice(1);
      const glyph = `<svg class="pop-kind" viewBox="0 0 256 256" aria-hidden="true"><path d="${POP_KIND_ICONS[k]}"/></svg>`;
      return `<button type="button" class="kind-key${mode ? ` ${mode}` : ""}${f && !mode ? " dim" : ""}" data-kind="${k}" aria-pressed="${mode ? "true" : "false"}" aria-label="${mode === "only" ? `only ${k}` : mode === "except" ? `everything but ${k}` : k}">${glyph}${label}</button>`;
    }).join("");
    host.querySelectorAll(".kind-key").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.kind, cur = state.pop.kindFilter;
      state.pop.kindFilter = !cur || cur.kind !== k ? { kind: k, mode: "only" }
        : cur.mode === "only" ? { kind: k, mode: "except" } : null;
      state.pop.cursor = 0;
      state.pop.lastSpawn = 0;   // the stage refills at once rather than after the usual stagger
      pruneStage();
      placeWindow();
      renderPopTables();
    }));
  }

  function renderPopTables() {
    const list = document.getElementById("pop-list");
    if (!list) return;
    renderKindLegend();
    const ev = popcornEvents();
    const order = (state.session?.transcripts || [])
      .map((t) => ({ tid: t.id, time: transcriptTime(t), order: (state.session?.transcripts || []).indexOf(t) }))
      .sort((a, b) => ((a.time ?? Infinity) - (b.time ?? Infinity)) || (a.order - b.order));
    const q = (state.popSearch || "").trim().toLowerCase();
    let total = 0, shown = 0, hidden = 0;
    const html = order.map((c) => {
      const items = state.popcorn.get(c.tid)?.items || [];
      if (!items.length) return "";
      total += items.length;
      const tableOff = state.pop.hidden.has(c.tid);
      const rows = items.map((item, idx) => {
        const e = ev.byKey.get(`${c.tid}:${idx}`);
        return { item, idx, key: popKey(c.tid, idx, item), out: (e ? !inWindow(e.f) : false ) || !popKindAllowed(c.tid, idx)};
      }).filter((r) => !q || r.item.phrase.toLowerCase().includes(q) || shortLabel(c.tid).toLowerCase().includes(q));
      shown += rows.length;
      hidden += tableOff ? items.length : items.filter((item, idx) => state.pop.hidden.has(popKey(c.tid, idx, item))).length;
      if (q && !rows.length) return "";
      const allOut = rows.length && rows.every((r) => r.out);
      const stateWord = tableOff ? "hidden" : allOut ? "outside the window" : "";
      return `<section class="pop-table${tableOff ? " hidden" : ""}${allOut ? " out" : ""}">
        <button type="button" class="pop-table-name" data-hide="${esc(c.tid)}" aria-pressed="${tableOff}" title="${tableOff ? "show this conversation" : "hide this conversation"}">
          <span class="chip" style="--marker:${markerFor(c.tid)}"></span>${esc(transcriptById(c.tid)?.label || c.tid)}
          <span class="pop-table-meta">${esc(clockOf(c.time))} · ${items.length}${stateWord ? ` · ${stateWord}` : ""}</span>
        </button>
        <div class="pop-list">${rows.map((r) => {
          const off = state.pop.hidden.has(r.key);
          return `<button type="button" class="tail-phrase${r.out ? " out" : ""}" data-hide="${esc(r.key)}" aria-pressed="${off}" style="--marker:${markerFor(c.tid)}" title="${off ? "show this popcorn" : "hide this popcorn"}${r.out ? " (outside the window)" : ""}">${kindIcon(r.item.kind)}${esc(phraseText(r.item))}</button>`;
        }).join("")}</div>
      </section>`;
    }).join("");
    list.innerHTML = html;
    const count = document.getElementById("pop-count");
    if (count) count.textContent = !total ? "" : q ? `${shown} of ${total}` : `${total} popcorn${total === 1 ? "" : "s"}${hidden ? ` · ${hidden} hidden` : ""}`;
  }

  // three horizontal bands, one phrase each — overlap-free by construction
  const SLOTS = [{ y: 18 }, { y: 45 }, { y: 71 }];   // the keys strip docks over the bottom of the fold

  function popTick() {
    if (screenFrozen) return;
    if (state.active !== "popcorn") return;
    const stageEl = document.getElementById("pop-stage");
    if (!stageEl) return;

    const total = [...state.popcorn.values()].reduce((n, d) => n + (d.items?.length || 0), 0);
    let waiting = stageEl.querySelector(".popcorn-waiting");
    if (!total) {
      // In dembrane the deck reads transcripts that already exist; it never
      // records. Say what is actually happening so a host does not think a
      // microphone is open.
      const transcripts = (state.session?.transcripts || []).length;
      const read = [...state.popcorn.values()].filter((p) => p.done).length;
      // A finished read that found nothing must say so, or a host takes an
      // empty stage for a broken one.
      const msg = !state.session ? "drop your session's JSON files anywhere on this page"
        : EMBED && !transcripts ? "waiting for the first conversation"
        : EMBED && read >= transcripts ? `read ${transcripts} conversation${transcripts === 1 ? "" : "s"}, nothing worth a popcorn yet`
        : EMBED ? "reading the conversations…"
        : "listening…";
      if (!waiting) stageEl.innerHTML = `<p class="popcorn-waiting"><span class="live-dot"></span>&nbsp; ${msg}</p>`;
      else if (!waiting.textContent.includes(msg.slice(0, 8))) waiting.innerHTML = `<span class="live-dot"></span>&nbsp; ${msg}`;
      return;
    }
    waiting?.remove();

    const staying = state.pop.live.filter((l) => !l.el.classList.contains("pop-out"));
    if (staying.length >= POP_CAP || staying.filter((l) => !l.pinned).length >= POP_MAX) return;
    const gap = state.pop.live.length ? POP_GAP : 0; // an empty stage never waits
    if (Date.now() - state.pop.lastSpawn < gap) return;

    const next = nextPopItem();
    if (next) spawnPop(stageEl, next);
  }

  // Which phrase next. Both modes only draw from what the crop window lets
  // through and the facilitator has not hidden.
  // "random": fresh phrases first, alternating conversations, then recycle
  // forever (the live-room default: the screen never goes dead).
  // "time": every popcorn in the order of its moment, tables interleaving
  // where they overlapped, and loop.
  function nextPopItem() {
    const ev = popcornEvents();
    const isLive = (tid, idx) => state.pop.live.some((l) => l.tid === tid && l.idx === idx);

    if (state.pop.mode === "time") {
      const seq = ev.events.filter((e) => popVisible(e.tid, e.idx, ev));
      if (!seq.length) return null;
      for (let k = 0; k < seq.length; k++) {
        const pick = seq[(state.pop.cursor + k) % seq.length];
        if (isLive(pick.tid, pick.idx)) continue;
        state.pop.cursor = (state.pop.cursor + k + 1) % seq.length;
        return { tid: pick.tid, idx: pick.idx };
      }
      return null;
    }

    const tids = (state.session?.transcripts || []).map((t) => t.id).filter((tid) => !state.pop.hidden.has(tid));
    const byLeastRecent = (a, b) => (state.pop.tidTime[a] || 0) - (state.pop.tidTime[b] || 0);
    const notLast = (list) => list.find((id) => id !== state.pop.lastTid) ?? list[0];
    const len = (tid) => state.popcorn.get(tid)?.items?.length || 0;

    // fresh: the next phrase this conversation has not shown yet, skipping what is hidden or cropped out
    const nextFresh = (tid) => {
      let idx = state.pop.fresh[tid] || 0;
      while (idx < len(tid) && !popVisible(tid, idx, ev)) idx++;
      return idx < len(tid) ? idx : null;
    };
    const freshTids = tids.filter((tid) => nextFresh(tid) !== null);
    if (freshTids.length) {
      const tid = notLast(freshTids.sort(byLeastRecent));
      const idx = nextFresh(tid);
      state.pop.fresh[tid] = idx + 1;
      return { tid, idx };
    }

    // recycle: the next visible phrase of the least-recently-shown conversation
    // that still has one to show. A conversation whose phrases are all hidden,
    // cropped, filtered out or already on stage is not a candidate; choosing it
    // and finding nothing used to leave the stage empty until the filter changed.
    const nextRecycled = (tid) => {
      const n = len(tid);
      for (let k = 0; k < n; k++) {
        const idx = ((state.pop.recycle[tid] || 0) + k) % n;
        if (popVisible(tid, idx, ev) && !isLive(tid, idx)) return idx;
      }
      return null;
    };
    const havers = tids.filter((tid) => nextRecycled(tid) !== null);
    if (!havers.length) return null;
    const tid = notLast(havers.sort(byLeastRecent));
    const idx = nextRecycled(tid);
    state.pop.recycle[tid] = idx + 1;
    return { tid, idx };
  }

  // The automatic flow lays phrases in three bands, one each, jittered. A
  // phrase popped from the keys (pinned) lands anywhere free in the open
  // stage instead, tries a few spots to stay clear of the others, and
  // lingers far longer.
  function spawnPop(stageEl, { tid, idx }, { center = false, pinned = false } = {}) {
    const item = state.popcorn.get(tid)?.items?.[idx];
    if (!item) return;

    // an empty stage gets the big opening treatment; so does a popcorn the
    // facilitator asked for by name
    const centerStage = !pinned && (center || !state.pop.live.length);
    let slotIdx = null;
    if (!pinned) {
      const used = new Set(state.pop.live.map((l) => l.slot));
      if (centerStage) {
        slotIdx = 1; // middle band
      } else {
        const free = [0, 1, 2].filter((i) => !used.has(i));
        if (!free.length) return;
        slotIdx = free[Math.floor(Math.random() * free.length)];
      }
    }
    const jx = centerStage ? 0 : Math.random() * 24 - 12;
    const jy = centerStage ? 0 : Math.random() * 2 - 1;

    const rooted = item.quoteId && quoteById(item.quoteId);
    const el = document.createElement("div");
    el.className = "pop" + (centerStage ? " center" : "") + (pinned ? " pinned" : "");
    el.dataset.weight = Math.min(3, Math.max(1, item.weight || 2));
    el.style.setProperty("--tilt", `${hashTilt(item.phrase)}deg`);
    el.innerHTML = `<span class="pop-phrase" style="--marker:${markerFor(tid)}">${kindIcon(item.kind)}${rooted ? `“${esc(phraseText(item))}”` : esc(phraseText(item))}</span>
      <span class="pop-att">${attribution(tid)}</span>`;
    stageEl.appendChild(el);
    // measure at the size it will settle at, not mid pop-in
    el.style.animation = "none";

    // never let phrases collide: step the size down until this one fits clear
    const clashes = () => {
      const r = el.getBoundingClientRect();
      return state.pop.live.some((l) => {
        if (l.el.classList.contains("pop-out")) return false;   // leaving anyway
        const o = l.el.getBoundingClientRect();
        return !(r.right < o.left || o.right < r.left || r.bottom < o.top || o.bottom < r.top);
      });
    };
    // stay on the stage: a phrase too wide for the room steps down first,
    // and any phrase hanging over an edge is nudged back inside before it
    // is judged against its neighbours
    const room = stageEl.getBoundingClientRect();
    const overflows = () => el.getBoundingClientRect().width > room.width - 2 * POP_EDGE_PX;
    const clamp = () => {
      const r = el.getBoundingClientRect();
      let dx = 0, dy = 0;
      if (r.left < room.left + POP_EDGE_PX) dx = room.left + POP_EDGE_PX - r.left;
      else if (r.right > room.right - POP_EDGE_PX) dx = room.right - POP_EDGE_PX - r.right;
      if (r.top < room.top + POP_EDGE_PX) dy = room.top + POP_EDGE_PX - r.top;
      else if (r.bottom > room.bottom - POP_EDGE_PX) dy = room.bottom - POP_EDGE_PX - r.bottom;
      if (dx || dy) {
        el.style.setProperty("--x", `${parseFloat(el.style.getPropertyValue("--x")) + (dx / room.width) * 100}%`);
        el.style.setProperty("--y", `${parseFloat(el.style.getPropertyValue("--y")) + (dy / room.height) * 100}%`);
      }
    };
    let w = Number(el.dataset.weight);
    if (pinned) {
      // scatter: a handful of throws across the open stage; the first that
      // sits inside and clear of the others wins
      el.style.setProperty("--x", "50%");
      el.style.setProperty("--y", "40%");
      while (overflows() && w > 1) el.dataset.weight = --w;
      let placed = false;
      for (let t = 0; t < 12 && !placed; t++) {
        el.style.setProperty("--x", `${18 + Math.random() * 64}%`);
        el.style.setProperty("--y", `${12 + Math.random() * 54}%`);
        clamp();
        placed = !clashes();
      }
    } else {
      el.style.setProperty("--x", `${50 + jx}%`);
      el.style.setProperty("--y", `${SLOTS[slotIdx].y + jy}%`);
      while (overflows() && w > 1) el.dataset.weight = --w;
      clamp();
    }
    // still touching something: step the size down until it fits clear
    while (clashes() && w > 1) { el.dataset.weight = --w; clamp(); }
    el.style.animation = "";

    const rec = { tid, idx, slot: slotIdx, el, pinned };
    state.pop.live.push(rec);
    state.pop.lastSpawn = Date.now();
    if (!pinned) {
      state.pop.lastTid = tid;
      state.pop.tidTime[tid] = Date.now();
    }
    markDotsOnStage();

    const beginFade = () => {
      el.classList.add("pop-out");
      markDotsOnStage();
      rec.timer = setTimeout(() => {
        el.remove();
        state.pop.live = state.pop.live.filter((l) => l !== rec);
      }, POP_FADE + 100);
    };
    rec.beginFade = beginFade;   // the freeze needs to stop and restart this
    rec.timer = setTimeout(beginFade, pinned ? POP_HOLD_PINNED : POP_HOLD);

    // hovering a popcorn holds it on stage; rooted popcorns raise their quote
    el.addEventListener("mouseenter", () => {
      clearTimeout(rec.timer);
      el.classList.remove("pop-out");
    });
    el.addEventListener("mouseleave", () => {
      if (!screenFrozen) rec.timer = setTimeout(beginFade, pinned ? POP_HOLD_PINNED : 3500);
    });
    // the opening click must not also read as a click outside the modal
    if (rooted) {
      el.classList.add("pop-rooted");
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        showQuoteTip(item.quoteId, null);
      });
    } else if (item.source && item.source.text) {
      el.classList.add("pop-sourced");
      el.title = "why this phrase";
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        showSourceTip(item, tid, null);
      });
    }
  }

  /* ---------- recommendations ---------- */

  function renderRecommendations() {
    const data = state.slides.get("recommendations");
    if (!data) return;
    const themes = data.themes || [];
    const allActions = themes.flatMap((t) => t.actions || []);
    const byId = (id) => allActions.find((x) => x.id === id);
    const themeOf = (a) => themes.find((t) => (t.actions || []).includes(a));
    const hl = markMatch("recommendations");
    const q = (state.searches.recommendations || "").trim().toLowerCase();
    const hasDetail = (a) => !!(
      a.why || a.tension || a.conflictsWith?.length || a.quoteIds?.length
    );
    const row = (a, themeLabel) => {
      const interactive = hasDetail(a);
      const tag = interactive ? "button" : "div";
      const meta = [
        a.why ? "context" : null,
        a.tension ? "trade-off" : null,
        a.conflictsWith?.length ? "pulls against" : null,
        a.quoteIds?.length ? `${a.quoteIds.length} quote${a.quoteIds.length === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      return `
      <${tag} class="action-row${interactive ? " action-row-clickable" : ""}"${interactive ? ` data-id="${esc(a.id)}"` : ""}>
        <span class="action-sentence">${hl(a.action)}</span>
        ${meta.length || themeLabel ? `<span class="rec-row-meta">
          ${meta.map((label) => `<span class="rec-meta-tag">${esc(label)}</span>`).join("")}
          ${themeLabel ? `<span class="row-theme">${esc(themeLabel)}</span>` : ""}
        </span>` : ""}
      </${tag}>`;
    };

    const matches = q ? themes.flatMap((t) =>
      (t.actions || []).filter((a) =>
        `${a.action} ${a.why || ""} ${a.tension || ""} ${t.title}`.toLowerCase().includes(q)
      ).map((a) => ({ a, t }))) : null;

    const toolsHtml = searchTools(
      "recommendations",
      "search the recommendations…",
      `${q ? `${matches.length} of ` : ""}${allActions.length} actions`,
      "recommendation-tools"
    );

    const listHtml = q
      ? `<div class="action-list recommendation-list">${matches.map(({ a, t }) => row(a, t.title)).join("")}</div>
         ${!matches.length ? emptyNote(state.searches.recommendations) : ""}`
      : themes.map((theme) => `
        <details class="theme-block" data-theme="${esc(theme.id)}"${state.openThemes.has(theme.id) ? " open" : ""}>
          <summary class="theme-title">
            <span class="theme-name">${esc(theme.title)}</span>
            <span class="theme-count">${(theme.actions || []).length} action${(theme.actions || []).length === 1 ? "" : "s"}</span>
            <span class="acc-mark" aria-hidden="true"></span>
          </summary>
          <div class="theme-body"><div class="action-list recommendation-list">
            ${(theme.actions || []).map((a) => row(a)).join("")}
          </div></div>
        </details>`).join("");

    const recSlide = (a) => {
      const th = themeOf(a);
      return `
        ${th ? `<p class="deck-eyebrow">${esc(th.title)}</p>` : ""}
        <h2 class="deck-headline" data-size="${sizeOf(a.action)}">${esc(a.action)}</h2>
        ${a.why || a.tension || a.conflictsWith?.length ? `<div class="rec-facts">
          ${a.why ? `<div class="rec-fact"><span class="label">Why this came up</span><p>${esc(a.why)}</p></div>` : ""}
          ${a.tension ? `<div class="rec-fact trade"><span class="label">The trade</span><p>${esc(a.tension)}</p></div>` : ""}
          ${a.conflictsWith?.length ? `<div class="rec-fact pulls"><span class="label">Pulls against</span><p>${a.conflictsWith.map((id) => `<a href="#recommendations/${esc(id)}">${esc(byId(id)?.action || id)}</a>`).join("<br>")}</p></div>` : ""}
        </div>` : ""}
        ${a.quoteIds?.length ? `<div class="deck-quotes">${quoteLinks(a.quoteIds)}</div>` : ""}`;
    };

    stage.classList.toggle("stage-flush", !!state.deck.recommendations && allActions.length > 0);
    if (state.deck.recommendations && allActions.length) {
      deckView({ tab: "recommendations", items: allActions, slideHtml: recSlide, toolsHtml, listHtml, hint: "all recommendations" });
    } else {
      stage.innerHTML = `<section aria-label="recommendations">${toolsHtml}${listHtml}</section>`;
    }

    wireSearch("recommendations", renderRecommendations);
    wireRows("recommendations");
    stage.querySelectorAll("details.theme-block").forEach((d) =>
      d.addEventListener("toggle", () => {
        if (d.open) state.openThemes.add(d.dataset.theme);
        else state.openThemes.delete(d.dataset.theme);
      }));
  }

  /* ---------- the deck + list pattern ----------
     Shared by tensions, recommendations, breakthroughs and insights:
     list view with search by default; selecting an item opens a
     horizontal full-screen deck of ALL items, snapped to the selected
     one, with dots along the bottom, ✕ back to the list, and the
     searchable list below the fold. */

  const DECK_TABS = ["tensions", "recommendations", "stakeholders"];
  // every custom slide is a deck tab too, so the set is a question, not a list
  const isDeckTab = (id) => DECK_TABS.includes(id) || !!SLIDES.find((s) => s.id === id)?.custom;
  const sizeOf = (s) => (s.length <= 60 ? "xl" : s.length <= 120 ? "lg" : "md");
  const emptyNote = (q) => `<p class="empty-note" style="margin-top:1em">nothing matches “${esc(q)}” — try fewer words.</p>`;

  function searchTools(tab, placeholder, countText, extraClass = "") {
    return `<div class="quote-tools${extraClass ? ` ${extraClass}` : ""}">
        <input class="quote-search" id="${tab}-search" type="search" placeholder="${placeholder}" value="${esc(state.searches[tab] || "")}" aria-label="${placeholder}">
        <span class="quote-count">${countText}</span>
      </div>`;
  }

  function wireSearch(tab, rerender) {
    const input = document.getElementById(`${tab}-search`);
    if (!input) return;
    input.addEventListener("input", () => {
      state.searches[tab] = input.value;
      const pos = input.selectionStart;
      rerender();
      const again = document.getElementById(`${tab}-search`);
      again.focus();
      again.setSelectionRange(pos, pos);
    });
  }

  function markMatch(tab) {
    const q = (state.searches[tab] || "").trim().toLowerCase();
    return (text) => {
      if (!q) return esc(text);
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) return esc(text);
      return `${esc(text.slice(0, i))}<mark>${esc(text.slice(i, i + q.length))}</mark>${esc(text.slice(i + q.length))}`;
    };
  }

  function wireRows(tab) {
    stage.querySelectorAll("button.action-row").forEach((b) =>
      b.addEventListener("click", () => showSlide(tab, b.dataset.id)));
  }

  function deckView({ tab, items, slideHtml, toolsHtml, listHtml, hint }) {
    const cur = state.deck[tab];
    const idx = Math.max(0, items.findIndex((it) => it.id === cur));
    stage.innerHTML = `<section class="deck" aria-label="${tab} slides">
        <button class="quote-unpin" aria-label="back to the list">✕</button>
        <div class="deck-track" id="deck-track">
          ${items.map((it) => `<div class="deck-slide">${slideHtml(it)}</div>`).join("")}
        </div>
        <div class="deck-dots">
          ${items.map((it, i) => `<button class="deck-dot${i === idx ? " active" : ""}" data-i="${i}" aria-label="${i + 1} of ${items.length}"></button>`).join("")}
        </div>
        <p class="stage-hint">${hint} ↓</p>
      </section>
      <section class="deck-tail">${toolsHtml}${listHtml}</section>`;

    const track = document.getElementById("deck-track");
    track.scrollLeft = idx * track.clientWidth;
    track.addEventListener("scroll", () => {
      // a scroll can land before the track has been laid out; dividing by a
      // zero width gives NaN, which indexes past the end of the deck
      const width = track.clientWidth || 1;
      const i = Math.max(0, Math.min(items.length - 1, Math.round(track.scrollLeft / width)));
      if (!items[i]) return;
      state.deck[tab] = items[i].id;
      stage.querySelectorAll(".deck-dot").forEach((d, n) => d.classList.toggle("active", n === i));
      history.replaceState(null, "", `#${tab}/${items[i].id}`);
    }, { passive: true });
    stage.querySelectorAll(".deck-dot").forEach((d) =>
      d.addEventListener("click", () =>
        track.scrollTo({ left: Number(d.dataset.i) * track.clientWidth, behavior: "smooth" })));
    stage.querySelector(".quote-unpin").addEventListener("click", () => {
      state.deck[tab] = null;
      showSlide(tab);
    });
  }

  /* ---------- tensions ---------- */

  function renderTensions() {
    const data = state.slides.get("tensions");
    if (!data) return;
    const items = data.tensions || [];
    const hl = markMatch("tensions");
    const q = (state.searches.tensions || "").trim().toLowerCase();
    const filtered = q ? items.filter((t) =>
      `${t.poleA} ${t.poleB} ${t.knot || t.narrative || ""} ${t.toResolve || ""}`.toLowerCase().includes(q)) : items;
    const toolsHtml = searchTools("tensions", "search the tensions…", `${q ? `${filtered.length} of ` : ""}${items.length} tensions`);
    const listHtml = `<div class="action-list">
        ${filtered.map((t) => `<button class="action-row" data-id="${esc(t.id)}">
          <span class="action-sentence">${hl(t.poleA)} <span class="row-glyph">⟷</span> ${hl(t.poleB)}</span>
        </button>`).join("")}
      </div>
      ${!filtered.length ? emptyNote(state.searches.tensions) : ""}`;

    const tensionSlide = (t) => `
      <div class="tension-poles">
        <p class="pole-block pole-a">${esc(t.poleA)}</p>
        <div class="rope" aria-hidden="true"></div>
        <p class="pole-block pole-b">${esc(t.poleB)}</p>
      </div>
      ${t.knot ? `<p class="tension-knot">${esc(t.knot)}</p>` : t.narrative ? `<p class="tension-narrative">${esc(t.narrative)}</p>` : ""}
      ${t.toResolve ? `<div class="tension-resolve"><span class="label">To work through</span><p>${esc(t.toResolve)}</p></div>` : ""}
      ${t.quoteIds?.length ? `<div class="deck-quotes tension-quotes">${quoteLinks(t.quoteIds)}</div>` : ""}`;

    stage.classList.toggle("stage-flush", !!state.deck.tensions && items.length > 0);
    if (state.deck.tensions && items.length) {
      deckView({ tab: "tensions", items, slideHtml: tensionSlide, toolsHtml, listHtml, hint: "all tensions" });
    } else {
      stage.innerHTML = `<section aria-label="tensions">${toolsHtml}${listHtml}</section>`;
    }
    wireSearch("tensions", renderTensions);
    wireRows("tensions");
  }

  /* ---------- custom slides ----------
     One renderer for every custom tab. The template is fixed — heading,
     subheading, quotes, and a searchable list of them — and the JSON decides
     what it is called. */

  function renderCustom(id) {
    const data = state.slides.get(id);
    if (!data) return;
    const items = data.items || [];
    const label = data.label || id;
    const glyph = data.glyph ? `<span class="bt-mark">${esc(data.glyph)}</span> ` : "";
    const hl = markMatch(id);
    const q = (state.searches[id] || "").trim().toLowerCase();
    const filtered = q ? items.filter((it) =>
      `${it.heading} ${it.subheading || ""}`.toLowerCase().includes(q)) : items;
    const toolsHtml = searchTools(id, `search the ${label}…`, `${q ? `${filtered.length} of ` : ""}${items.length} ${label}`);
    const listHtml = `<div class="action-list">
        ${filtered.map((it) => `<button class="action-row" data-id="${esc(it.id)}">
          <span class="action-sentence">${glyph}${hl(it.heading)}</span>
        </button>`).join("")}
      </div>
      ${!filtered.length ? emptyNote(state.searches[id]) : ""}`;

    // a named subheading gets the labelled block (insights' "So what"); an
    // unnamed one is just prose under the heading
    const slide = (it) => `
      <h2 class="deck-headline" data-size="${sizeOf(it.heading)}">${glyph}${esc(it.heading)}</h2>
      ${it.subheading
        ? data.subheadingLabel
          ? `<div class="deck-so"><span class="label">${esc(data.subheadingLabel)}</span><p>${esc(it.subheading)}</p></div>`
          : `<p class="deck-desc">${esc(it.subheading)}</p>`
        : ""}
      ${it.quoteIds?.length ? `<div class="deck-quotes">${quoteLinks(it.quoteIds)}</div>` : ""}`;

    stage.classList.toggle("stage-flush", !!state.deck[id] && items.length > 0);
    if (state.deck[id] && items.length) {
      deckView({ tab: id, items, slideHtml: slide, toolsHtml, listHtml, hint: `all ${label}` });
    } else {
      stage.innerHTML = `<section aria-label="${esc(label)}">${toolsHtml}${listHtml}</section>`;
    }
    wireSearch(id, () => renderCustom(id));
    wireRows(id);
  }

  /* ---------- stakeholders ----------
     List view is a map: the groups arranged in a ring, connection lines
     between them (tensions dashed blue), labels at the midpoints.
     Clicking a group opens the deck at its slide. */

  // The evidence ladder. Every group and every connection says how well it is
  // attested: either it cites quotes or it cites the reasoning that produced
  // it. Nothing here filters the map — an inferred group with a high stake
  // has to survive all the way to the coarsest room-facing view, because the
  // whole point is that the density control must never become an erasure
  // control. Older data without these fields reads as `named` / `stated`.
  const RUNG = { voiced: 3, named: 2, inferred: 1 };
  const rungOf = (s) => s.evidence?.rung || "named";
  const stakeOf = (s) => s.weight?.stake ?? 0.5;
  const mentionsOf = (s) => s.weight?.mentions ?? 0.5;
  // Relations are authored as a top-level array, one entry per pair.
  // Three scalars are required and drawn: intensity (line weight),
  // sentiment (line colour), unowned (dashed). Everything descriptive
  // lives in aspects, each grounded in quotes, and shows in the tooltip.
  const relationsOf = (data) => (data.relations || []).map((r) => ({
    intensity: 0.5, sentiment: 0, unowned: false, aspects: [], ...r,
    rung: r.evidence?.rung || "stated",
  }));
  // sentiment colour: five steps, hot red (strained) through magenta and
  // royal blue (neutral) to a bluish green and then a bright green
  // (working), weighted to the poles. Each is the most saturated colour of
  // its hue that clears the contrast it is held to on the parchment: 3.5:1
  // for the red and the magenta, the institution blue as it is at 4.4:1,
  // 3.2:1 for the bluish green, and 2.8:1 for the green pole, deliberately
  // under the 3:1 line because a green that clears it reads as forest, not
  // spark, next to the red. Blue is only for relations the analyst put
  // within a tenth of zero; from 0.2 to 0.5 either way is the mild step,
  // and 0.6 and beyond is the pole, matching the prompt's own line between
  // "cooperative or wary" and "warmth or grievance".
  const SENT_STEPS = ["#FF134E", "#EF00C0", "#4169E1", "#009B79", "#33A900"];
  const sentColor = (v) => {
    const s = Math.max(-1, Math.min(1, v || 0));
    const a = Math.abs(s);
    const k = a < 0.15 ? 0 : a < 0.55 ? 1 : 2;
    return SENT_STEPS[2 + Math.sign(s) * k];
  };
  const relStatus = (r) => r.unowned ? "Unowned"
    : r.sentiment <= -0.5 ? "Strained" : r.sentiment < 0 ? "Friction"
    : r.sentiment >= 0.5 ? "Working well" : r.sentiment > 0 ? "Steady" : "Neutral";
  // Little tags on the closed row: the sentiment word (carrying the line's
  // colour), unowned when nobody holds the relation, then one per evidenced
  // aspect. Neutral says nothing, so it shows nothing.
  const KIND_WORD = { power: "Power", risk: "Risk", opportunity: "Opportunity" };
  const relTags = (r) => {
    const tags = [];
    const sent = r.sentiment <= -0.5 ? "Strained" : r.sentiment < 0 ? "Friction"
      : r.sentiment >= 0.5 ? "Working well" : r.sentiment > 0 ? "Steady" : null;
    if (sent) tags.push({ word: sent, color: sentColor(r.sentiment) });
    if (r.unowned) tags.push({ word: "Unowned" });
    for (const a of r.aspects || []) {
      const word = KIND_WORD[a.kind] || (a.kind ? a.kind.charAt(0).toUpperCase() + a.kind.slice(1) : null);
      if (word && !tags.some((t) => t.word === word)) tags.push({ word });
    }
    return tags;
  };

  // Who to bring into the room next: derived, never authored. High stake,
  // weak evidence, and someone else already speaking in your place is the
  // worst combination and sorts to the top. Every row shows its working so
  // the room can argue with it rather than take it on faith.
  function bringInList(items) {
    return items
      .map((s) => {
        const rung = rungOf(s);
        const invoked = !!s.evidence?.invokedBy;
        const gap = Math.max(0, stakeOf(s) - mentionsOf(s));
        const score = stakeOf(s) * (4 - RUNG[rung]) + gap * 1.2 + (invoked ? 0.8 : 0);
        return { s, rung, invoked, score };
      })
      .filter((r) => r.rung !== "voiced")
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
  }

  // set by buildStakeMap: repaints the map at a detail value by interpolating
  // the precomputed ladder — never re-runs the solver
  let stakePaintHook = null;

  function renderStakeholders() {
    const data = state.slides.get("stakeholders");
    if (!data) return;
    const all = data.stakeholders || [];
    const relations = relationsOf(data);
    // The detail slider no longer filters the data: every group stays in the
    // DOM and the ladder decides who is visible at each detail level, ranked
    // by stake so the coarse view cannot delete the groups nobody talked
    // about. Sliding interpolates between precomputed rungs.
    const detail = state.stakeDetail ?? 1;
    const items = all;
    const byId = (id) => items.find((s) => s.id === id);
    const q = (state.searches.stakeholders || "").trim().toLowerCase();
    const matched = (s) => !q || `${s.name} ${s.role || ""} ${s.stake || ""}`.toLowerCase().includes(q);
    const nMatch = items.filter(matched).length;
    const toolsHtml = searchTools("stakeholders", "search the stakeholders…", `${q ? `${nMatch} of ` : ""}${items.length} stakeholder groups`);
    // past ~9 groups the map goes dense: compact name-only cards, taller canvas
    const dense = items.length > 9;
    const sliderHtml = all.length > 5 ? `<div class="map-tools">
        <label for="stake-detail">detail</label>
        <input type="range" id="stake-detail" min="0" max="1" step="0.01" value="${detail}">
        <span class="map-count">${items.length} of ${all.length} groups</span>
      </div>` : "";
    // The key is swatches with one or two words each; the prose lives in
    // the tooltips and the relation slides.
    const legendHtml = `<div class="flow-key" aria-label="key">
      <span><svg width="34" height="12" aria-hidden="true"><line x1="1" y1="3" x2="33" y2="3" stroke="${sentColor(0)}" stroke-width="1.2"/><line x1="1" y1="9" x2="33" y2="9" stroke="${sentColor(0)}" stroke-width="3.6"/></svg>intensity</span>
      <span>strained<svg width="58" height="8" aria-hidden="true">${SENT_STEPS.map((c, i, all) => `<line x1="${1 + i * 56 / all.length}" y1="4" x2="${1 + (i + 1) * 56 / all.length}" y2="4" stroke="${c}" stroke-width="2.5"/>`).join("")}</svg>working</span>
      <span><svg width="34" height="8" aria-hidden="true"><line x1="1" y1="4" x2="33" y2="4" stroke="${sentColor(0)}" stroke-width="2.5" stroke-dasharray="5 4"/></svg>unowned</span>
      <span><svg width="16" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="9" fill="#FFFFFF" stroke="#2D2D2C" stroke-opacity="0.25"/></svg>spoke for themselves</span>
      <span><svg width="16" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="9" fill="#EAE8E5" stroke="#2D2D2C" stroke-opacity="0.25"/></svg>spoken for</span>
      <span><svg width="16" height="12" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="9" fill="#EAE8E5" stroke="#2D2D2C" stroke-opacity="0.25"/><rect x="4" y="4" width="8" height="4" fill="none" stroke="#2D2D2C" stroke-opacity="0.5" stroke-dasharray="1 1.2"/></svg>inferred</span>
    </div>`;
    const bring = bringInList(all);
    const bringHtml = bring.length ? `<section class="bring-in">
      <h3>who to bring in next</h3>
      <p class="bring-why">Ranked by what is at stake for them against how well the transcripts actually evidence them. Groups who spoke for themselves are not listed.</p>
      <ol>${bring.map((r, i) => `<li>
        <span class="bring-rank">${i + 1}</span>
        <span>
          <span class="bring-name">${esc(r.s.name)}</span>
          <span class="bring-rung${r.rung === "inferred" ? " inferred" : ""}">${r.rung}</span>
          ${r.invoked ? `<span class="bring-rung invoked">spoken for by ${esc(all.find((x) => x.id === r.s.evidence.invokedBy)?.name || "another group")}</span>` : ""}
          <span class="bring-note">${esc(r.s.evidence?.note || r.s.stake || "")}</span>
        </span>
      </li>`).join("")}</ol>
    </section>` : "";
    const listHtml = `${sliderHtml}<div class="stake-map${dense ? " dense" : ""}" id="stake-map"${dense ? ` style="height:${Math.min(680, 320 + items.length * 26)}px"` : ""}></div>${legendHtml}${bringHtml}`;


    // Inbound edges count as well as outbound: relationships are authored
    // once, but appear on both stakeholders' slides.
    const neighboursOf = (s) => {
      const out = [];
      for (const r of relations) {
        const [a, b] = r.between || [];
        const otherId = a === s.id ? b : b === s.id ? a : null;
        if (!otherId || otherId === s.id || !byId(otherId)) continue;
        out.push({ other: byId(otherId), r });
      }
      return out.sort((x, y) => y.r.intensity - x.r.intensity);
    };

    // The group's own slide keeps the map's relationship encodings (weight,
    // colour and dash) in a simpler vertical hierarchy.
    const relStage = (s) => {
      const nbrs = neighboursOf(s);
      state.openRel ??= null; // one relation open at a time on these slides
      const rows = nbrs.map((e) => {
        const sentence = e.r.detail || `${s.name} and ${e.other.name}: ${e.r.label || "connected"}`;
        const dpr = window.devicePixelRatio || 1;
        const w = (Math.round((2 + e.r.intensity * 4) * dpr) / dpr).toFixed(2);
        const color = sentColor(e.r.sentiment);
        const open = state.openRel === e.r.id;
        // the row's tags already name the aspect kinds; the notes stand alone
        const aspects = (e.r.aspects || []).map((a) =>
          `<p class="rel-why">${esc(a.note)}${
            a.quoteIds && a.quoteIds.length ? ` <span class="rel-quotes">${quoteLinks(a.quoteIds)}</span>` : ""}</p>`).join("");
        return `<div class="rel-row${e.r.rung === "inferred" ? " inferred" : ""}">
          <div class="rel-row-words">
            <a class="rel-row-other" href="#stakeholders/${esc(e.other.id)}">${esc(e.other.name)}</a>
            <button type="button" class="rel-row-toggle" data-rid="${esc(e.r.id)}" aria-expanded="${open}"
              aria-label="${esc(e.r.label || relStatus(e.r))}">${relTags(e.r).map((t) =>
                `<span class="rel-tag${t.color ? "" : ""}"${t.color ? ` style="border-color:${t.color}"` : ""}>${esc(t.word)}</span>`).join("")}</button>
          </div>
          <svg class="rel-row-line" height="10" aria-hidden="true" shape-rendering="crispEdges">
            <line x1="0" y1="5" x2="100%" y2="5"
              stroke="${color}" stroke-width="${w}"${e.r.unowned ? ` stroke-dasharray="6 5"` : ""}/>
          </svg>
          <div class="rel-row-body${open ? " open" : ""}"><div class="rel-row-body-in"><div class="rel-row-body-content">
            <p class="rel-sentence">${esc(sentence)}</p>
            ${aspects}
          </div></div></div>
        </div>`;
      }).join("");
      const sr = `<ul class="sr-only">${nbrs.map((e) =>
        `<li>${esc(e.other.name)}${e.r.label ? `: ${esc(e.r.label)}` : ""} (${esc(relStatus(e.r))})</li>`).join("")}</ul>`;
      // The tab already says stakeholders, so the column skips labels and
      // says it in prose: who they are, what they care about, how we know.
      const role = s.role?.replace(/\.$/, "") || "";
      const stake = s.stake
        ? s.stake.charAt(0).toLowerCase() + s.stake.slice(1).replace(/\.$/, "") : "";
      const identityProse = role && stake && /^They\b/.test(role)
        ? `${role}, and care about ${stake}.`
        : [`${role}.`, stake ? `They care about ${stake}.` : ""].filter((p) => p !== "." && p).join(" ");
      const evidenceProse = !s.evidence ? "" : (() => {
        const rung = rungOf(s);
        const by = s.evidence.invokedBy
          ? all.find((x) => x.id === s.evidence.invokedBy)?.name : null;
        if (rung === "voiced") return "They spoke for themselves.";
        if (rung === "inferred") return "Inferred; never mentioned directly.";
        return by ? `Named by others, spoken for by ${by}.` : "Named by others.";
      })();
      return `<article class="rel-slide">
        <header class="rel-id">
          <h2 class="deck-headline" data-size="${sizeOf(s.name)}">${esc(s.name)}</h2>
          ${identityProse ? `<p class="deck-desc">${esc(identityProse)}</p>` : ""}
          ${evidenceProse ? `<p class="rel-evidence">${esc(evidenceProse)}</p>` : ""}
          ${s.quoteIds?.length ? `<div class="deck-quotes">${quoteLinks(s.quoteIds)}</div>` : ""}
        </header>
        ${rows ? `<div class="rel-rows">${rows}</div>` : ""}
      </article>${sr}`;
    };

    const slide = (s) => relStage(s);

    stage.classList.toggle("stage-flush", !!state.deck.stakeholders && items.length > 0);
    if (state.deck.stakeholders && items.length) {
      deckView({ tab: "stakeholders", items, slideHtml: slide, toolsHtml, listHtml, hint: "the stakeholder map" });
    } else {
      stage.innerHTML = `<section aria-label="stakeholders">${toolsHtml}${listHtml}</section>`;
    }
    buildStakeMap(items, relations, matched);
    // Stakeholder rows open on hover, one at a time: hovering a row closes
    // whichever other row is open. Focus does the same for keyboards; click
    // still toggles, which is what touch screens use.
    const setOpenRel = (row, rid) => {
      stage.querySelectorAll(".rel-row-body.open").forEach((b) => {
        if (b.closest(".rel-row") !== row) b.classList.remove("open");
      });
      stage.querySelectorAll(".rel-row-toggle").forEach((t) =>
        t.setAttribute("aria-expanded", String(t.dataset.rid === rid)));
      row.querySelector(".rel-row-body").classList.add("open");
      state.openRel = rid;
      trackRelConnector();
    };
    // The route exists only while a relationship is held open, and it is drawn
    // in that relationship's own hand: its colour, its weight, its dashes. It
    // underlines the group's name, crosses the gap, turns once, and lands on
    // the branch it feeds, so the branch reads as the same stroke continuing.
    // Closed, the slide carries no connector at all.
    // The route is drawn on, starting at the relationship and running back to
    // the group's name — the branch reaching for the stakeholder rather than a
    // line appearing whole. Progress advances the polyline's geometry rather
    // than a dash offset, so a dashed (unowned) route keeps its own dashes and
    // simply grows them one at a time.
    const DRAW_MS = 420;
    const drawEase = (t) => 1 - Math.pow(1 - t, 3);
    const drawRelConnector = () => {
      const dpr = window.devicePixelRatio || 1;
      const snap = (v) => Math.round(v * dpr) / dpr;
      const now = performance.now();
      if (state.relDrawRid !== state.openRel) {
        state.relDrawRid = state.openRel;
        state.relDrawT0 = now;
      }
      const grown = drawEase(Math.min(1, (now - (state.relDrawT0 || 0)) / DRAW_MS));
      stage.querySelectorAll(".rel-slide").forEach((slide) => {
        const rows = slide.querySelector(".rel-rows");
        const head = slide.querySelector(".deck-headline");
        if (!rows || !head) return;
        let svg = slide.querySelector(".rel-connector");
        if (!svg) {
          svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
          svg.setAttribute("class", "rel-connector");
          svg.setAttribute("aria-hidden", "true");
          svg.setAttribute("shape-rendering", "crispEdges");
          svg.innerHTML = `<path fill="none" stroke-linejoin="miter"/>`;
          slide.appendChild(svg);
        }
        const path = svg.querySelector("path");
        const openRow = rows.querySelector(".rel-row-body.open")?.closest(".rel-row");
        const lineEl = openRow?.querySelector(".rel-row-line");
        const src = lineEl?.querySelector("line");
        if (!src) { svg.classList.remove("on"); return; }
        const sr = slide.getBoundingClientRect();
        const rr = rows.getBoundingClientRect();
        const hr = head.getBoundingClientRect();
        const lr = lineEl.getBoundingClientRect();
        const idBox = (slide.querySelector(".rel-id") || head).getBoundingClientRect();
        const w = parseFloat(src.getAttribute("stroke-width")) || 2;
        const half = w / 2;
        const hx = snap(hr.left - sr.left);
        const ty = snap(hr.bottom - sr.top - half);
        const sx = snap(rr.left - sr.left);
        const by = snap(Math.min(Math.max(lr.top + lr.height / 2, rr.top), rr.bottom) - sr.top);
        // The drop runs down the gutter, not down the branches' own edge, so it
        // passes the relationships it isn't about without touching them. It
        // turns back in at the branch it feeds and stops where that branch
        // starts, which makes the two one continuous stroke.
        const idRight = idBox.right - sr.left;
        const vx = snap(idRight + (sx - idRight) * 0.45);
        // authored branch-first, so revealing it by length draws it that way
        const pts = [[sx, by], [vx, by], [vx, ty], [hx, ty]];
        const legs = pts.slice(1).map((p, i) =>
          Math.abs(p[0] - pts[i][0]) + Math.abs(p[1] - pts[i][1]));
        let left = legs.reduce((a, b) => a + b, 0) * grown;
        let d = `M${pts[0][0]} ${pts[0][1]}`;
        for (let i = 0; i < legs.length && left > 0; i++) {
          const t = legs[i] ? Math.min(1, left / legs[i]) : 1;
          const x = pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t;
          const y = pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t;
          d += `L${+x.toFixed(2)} ${+y.toFixed(2)}`;
          left -= legs[i];
        }
        path.setAttribute("d", d);
        path.setAttribute("stroke", src.getAttribute("stroke"));
        path.setAttribute("stroke-width", w);
        // The connector lives outside the relation row, so it does not inherit
        // the reduced opacity used to mark an inferred relation. Mirror the
        // source line's effective opacity to keep the route one continuous tone.
        const lineOpacity = Number(getComputedStyle(lineEl).opacity);
        const strokeOpacity = Number(getComputedStyle(src).strokeOpacity);
        const effectiveOpacity =
          (Number.isFinite(lineOpacity) ? lineOpacity : 1) *
          (Number.isFinite(strokeOpacity) ? strokeOpacity : 1);
        path.setAttribute("stroke-opacity", effectiveOpacity);
        const dash = src.getAttribute("stroke-dasharray");
        if (dash) path.setAttribute("stroke-dasharray", dash);
        else path.removeAttribute("stroke-dasharray");
        svg.classList.add("on");
      });
    };
    // A ResizeObserver alone is not a reliable clock for a running transition:
    // it coalesces, and it goes quiet whenever the browser stops its rendering
    // steps. While a row is opening or closing, follow the branch frame by
    // frame instead, so the route lands on it the whole way rather than only
    // where the observer happened to look.
    let relRaf = 0, relRafUntil = 0;
    const trackRelConnector = () => {
      drawRelConnector();
      relRafUntil = performance.now() + 520;  // the accordion and the draw, plus slack
      if (relRaf) return;
      const step = () => {
        drawRelConnector();
        relRaf = performance.now() < relRafUntil ? requestAnimationFrame(step) : 0;
      };
      relRaf = requestAnimationFrame(step);
    };
    drawRelConnector();
    if (state.relConnRO) state.relConnRO.disconnect();
    state.relConnRO = new ResizeObserver(drawRelConnector);
    // rows are height-capped, so an opening accordion changes the row's size
    // rather than the column's: observe both, and follow the column's scroll
    stage.querySelectorAll(".rel-rows").forEach((el) => {
      state.relConnRO.observe(el);
      el.addEventListener("scroll", drawRelConnector, { passive: true });
      el.querySelectorAll(".rel-row").forEach((r) => state.relConnRO.observe(r));
    });

    // hovering the identity column clears the stage: every open row folds
    stage.querySelectorAll(".rel-id").forEach((head) => head.addEventListener("mouseenter", () => {
      stage.querySelectorAll(".rel-row-body.open").forEach((b) => b.classList.remove("open"));
      stage.querySelectorAll(".rel-row-toggle").forEach((t) => t.setAttribute("aria-expanded", "false"));
      state.openRel = null;
      trackRelConnector();
    }));
    stage.querySelectorAll(".rel-row-toggle").forEach((t) =>
      t.classList.toggle("overflowing", t.scrollWidth > t.clientWidth + 1));
    stage.querySelectorAll(".rel-row").forEach((row) => {
      const btn = row.querySelector(".rel-row-toggle");
      if (!btn) return;
      const rid = btn.dataset.rid;
      row.addEventListener("mouseenter", () => setOpenRel(row, rid));
      btn.addEventListener("focus", () => setOpenRel(row, rid));
      btn.addEventListener("click", () => {
        const body = row.querySelector(".rel-row-body");
        if (body.classList.contains("open")) {
          body.classList.remove("open");
          btn.setAttribute("aria-expanded", "false");
          state.openRel = null;
          trackRelConnector();
        } else setOpenRel(row, rid);
      });
    });
    wireSearch("stakeholders", renderStakeholders);
    const slider = document.getElementById("stake-detail");
    if (slider) slider.addEventListener("input", (e) => {
      state.stakeDetail = Number(e.target.value);
      if (stakePaintHook) stakePaintHook(state.stakeDetail);
      else renderStakeholders(); // uncertified fallback has no ladder
    });
  }

  // Stakeholder map layout, in two stages.
  //
  // Topology (assets/planar.js): the exact crossing number of the graph is
  // computed by iterative deepening on a planarity oracle, and the certified
  // crossing-minimal planarization — crossings, if any, become invisible bend
  // points — is drawn crossing-free (Chrobak–Payne). That drawing seeds the
  // geometry stage and its crossing set is a hard invariant from then on.
  //
  // Geometry: a small multicriteria descent in the spirit of (SGD)^2
  // [Ahmed et al., TVCG 2022] — stress + rectangle overlap + label placement.
  // Each iteration is guarded PrEd-style: if it would change the crossing
  // set, positions are bisected back toward the last valid geometry, so the
  // drawing provably keeps the minimal number of crossings at rest.
  //
  // If the topology search blows its budget (pathological dropped data) the
  // old soft heuristic runs instead — the console says so. Deterministic:
  // same data and size, same layout.
  const stakeTopoCache = { key: null, topo: null };
  const stakeLayoutCache = { key: null, state: null };
  function buildStakeMap(items, relations, matched) {
    const map = document.getElementById("stake-map");
    if (!map || !items.length) return;
    const W = map.clientWidth, H = map.clientHeight;

    // undirected edge list (deduped); each conn remembers its edge index
    const ids = items.map((s) => s.id);
    const idSet = new Set(ids);
    const conns = [];
    const edgeList = [];
    const edgeIdx = new Map();
    for (const r of relations) {
      const [a, b] = r.between || [];
      if (!idSet.has(a) || !idSet.has(b) || a === b) continue;
      const key = a < b ? a + "\x1f" + b : b + "\x1f" + a;
      if (!edgeIdx.has(key)) { edgeIdx.set(key, edgeList.length); edgeList.push([a, b]); }
      conns.push({ from: a, to: b, label: r.label, t: 0.5, e: edgeIdx.get(key), r });
    }

    // certified crossing-minimal topology (cached per graph, not per resize)
    const topoKey = JSON.stringify(edgeList) + "|" + ids.join(",");
    if (stakeTopoCache.key !== topoKey) {
      let topo = null;
      if (typeof PopcornPlanar !== "undefined") {
        try {
          topo = PopcornPlanar.certifiedTopology(ids, edgeList, { kmax: 3, budgetMs: 700, variants: 6 });
        } catch (err) {
          console.warn("[stakeholders] topology engine failed:", err);
          topo = null;
        }
        if (topo && !topo.certified) {
          console.info(`[stakeholders] topology search gave up (${topo.reason}); using heuristic layout`);
          topo = null;
        }
        if (topo) console.info(`[stakeholders] certified crossing number: ${topo.k}`);
      }
      stakeTopoCache.key = topoKey;
      stakeTopoCache.topo = topo;
    }
    const topo = stakeTopoCache.topo;
    const certified = !!topo;

    // layout nodes: stakeholder cards, plus invisible bend points at the
    // certified crossings (present only when the data is genuinely non-planar)
    const nodes = items.map((s, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / items.length;
      return { id: s.id, s, x: W / 2 + W * 0.32 * Math.cos(a), y: H / 2 + H * 0.32 * Math.sin(a) };
    });
    if (certified) for (const d of topo.dummies) nodes.push({ id: d, dummy: true, x: W / 2, y: H / 2 });
    const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

    // every conn renders as a polyline along its edge's chain; for planar
    // data every chain is a single straight segment
    const chains = certified ? topo.chains : edgeList.map((e) => [e[0], e[1]]);
    for (const c of conns) {
      const chain = chains[c.e];
      c.chain = chain[0] === c.from ? chain : [...chain].reverse();
    }

    // seed from one of the certified crossing-free drawings, uniformly scaled
    const circleSeed = nodes.map((n) => [n.x, n.y]);
    const seedFrom = (pos) => {
      if (!pos) {
        nodes.forEach((n, i) => { n.x = circleSeed[i][0]; n.y = circleSeed[i][1]; });
        for (const c of conns) c.t = 0.5;
        return;
      }
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pos.values()) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
        minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
      }
      const sc = Math.min((W * 0.8) / Math.max(1, maxX - minX), (H * 0.8) / Math.max(1, maxY - minY));
      for (const n of nodes) {
        const p = pos.get(n.id);
        if (!p) continue;
        n.x = W / 2 + (p[0] - (minX + maxX) / 2) * sc;
        n.y = H / 2 + (p[1] - (minY + maxY) / 2) * sc;
      }
      for (const c of conns) c.t = 0.5;
    };
    if (certified) seedFrom(topo.pos);

    // Flow states that run in two directions at once (tension pulling apart,
    // unowned meeting in the middle) need two polylines: same geometry, both
    // pointed at the midpoint, animated in opposite senses. Everything else
    // is a single line.
    const lineHtml = conns.map((c, i) => {
      const cls = `stake-line${c.r.unowned ? " rel-unowned" : ""} rung-${c.r.rung}`;
      const w = (1.4 + c.r.intensity * 3.2).toFixed(2);
      // one unbroken line per connection; valence is carried by colour
      // direction is deliberately not drawn for now: an arrow on every
      // deference edge turns the map into a power diagram, which is a
      // different (and heavier) claim than the one this slide is making
      return `<polyline class="${cls}" data-seg="${i}" data-half="0" fill="none" style="--w:${w};stroke:${sentColor(c.r.sentiment)}"></polyline>`;
    }).join("");

    map.innerHTML = `<svg width="${W}" height="${H}" aria-hidden="true">${lineHtml}</svg>`
      + conns.map((c, i) => c.label ? `<span class="stake-line-label" data-i="${i}">${esc(c.label)}</span>` : "").join("")
      + nodes.filter((n) => !n.dummy).map((n) => {
        const rung = rungOf(n.s);
        // stake drives card size, so the coarse read is who has most riding
        // on this rather than who happened to talk most
        const scale = (0.86 + stakeOf(n.s) * 0.34).toFixed(3);
        return `<button class="stake-node rung-${rung}${matched(n.s) ? "" : " dim"}" data-id="${esc(n.id)}" style="--stake-scale:${scale}">
          ${rung === "inferred" ? `<span class="rung-mark">inferred</span>` : ""}
          <span class="stake-name">${esc(n.s.name)}</span>
          ${n.s.role ? `<span class="stake-role">${esc(n.s.role)}</span>` : ""}
        </button>`;
      }).join("");

    const nodeEls = {};
    map.querySelectorAll(".stake-node").forEach((el) => { nodeEls[el.dataset.id] = el; });
    for (const n of nodes) {
      if (n.dummy) { n.w = 0; n.h = 0; continue; }
      const el = nodeEls[n.id];
      n.w = el.offsetWidth; n.h = el.offsetHeight;
    }
    const labelEls = {};
    map.querySelectorAll(".stake-line-label").forEach((el) => { labelEls[el.dataset.i] = el; });
    conns.forEach((c, i) => {
      const el = labelEls[i];
      if (el) { c.lw = el.offsetWidth; c.lh = el.offsetHeight; }
    });
    const segEls = {};
    map.querySelectorAll(".stake-line").forEach((el) => {
      (segEls[el.dataset.seg] ||= []).push(el);
    });

    // graph-theoretic distances for the stress term, over the planarization
    // (bend points are ordinary degree-4 nodes here)
    const N = nodes.length;
    const idx = Object.fromEntries(nodes.map((n, i) => [n.id, i]));
    const adj = nodes.map(() => []);
    for (const chain of chains) for (let i = 0; i + 1 < chain.length; i++) {
      adj[idx[chain[i]]].push(idx[chain[i + 1]]);
      adj[idx[chain[i + 1]]].push(idx[chain[i]]);
    }
    const hops = nodes.map((_, i) => {
      const d = Array(N).fill(Infinity);
      d[i] = 0;
      const q = [i];
      while (q.length) {
        const u = q.shift();
        for (const v of adj[u]) if (d[v] === Infinity) { d[v] = d[u] + 1; q.push(v); }
      }
      return d;
    });
    const L = Math.min(W * 0.34, Math.min(W, H) * 0.68, Math.sqrt((W * H) / items.length) * 1.15);
    // fans get longer spokes: extra ideal length around high-degree nodes
    // opens up the faces where their neighbors have to fit
    const deg = adj.map((a) => a.length);
    const target = (i, j) => {
      const fan = hops[i][j] === 1 ? 1 + 0.05 * Math.max(0, deg[i] + deg[j] - 4) : 1;
      return Math.min((hops[i][j] === Infinity ? 1.6 : hops[i][j]) * L * fan, Math.max(W, H) * 0.8);
    };

    let pinned = null;
    const shift = (n, dx, dy) => { if (n !== pinned) { n.x += dx; n.y += dy; } };
    const clampNode = (n) => {
      n.x = Math.max(n.w / 2 + 4, Math.min(W - n.w / 2 - 4, n.x));
      n.y = Math.max(n.h / 2 + 4, Math.min(H - n.h / 2 - 4, n.y));
    };

    // Use the room. Two one-sided terms, split by adjacency — nothing here
    // pulls the drawing back in once it has spread, because inside a fixed
    // topology a long edge costs nothing and empty canvas costs legibility.

    // an even-spacing radius: how far apart 15 cards would sit if they shared
    // the canvas evenly. Non-adjacent pairs push out to it, so the drawing
    // expands into empty space instead of settling into a dense island.
    const R = Math.max(Math.sqrt((W * H) / Math.max(1, N)) * 1.5, Math.min(W, H) * 0.5);

    const forceOn = (i) => {
      const a = nodes[i];
      let fx = 0, fy = 0;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const b = nodes[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.hypot(dx, dy) || 1;
        if (hops[i][j] === 1) {
          // adjacent: full pull when cramped, nearly free to stretch
          const excess = d - target(i, j);
          const w = 0.55 * (excess > 0 ? 0.1 : 1);
          fx += dx * (excess / d) * w;
          fy += dy * (excess / d) * w;
        } else {
          const room = Math.max(target(i, j), R);
          if (d >= room) continue;
          const push = ((room - d) / d) * 0.2;
          fx -= dx * push;
          fy -= dy * push;
        }
      }
      // (An explicit face-inflation force — pushing each corner out from a
      // starved face's centroid — was tried here and measured worse: it wins
      // no extra spread over the two terms above and pushes cards onto edges
      // on the way. Face area earns its keep as a score, not as a force.)

      // Edges must not run through cards. This has to be a force during
      // annealing, not a repair afterwards: by the time the layout has
      // settled, a card pinned between an edge and its own neighbours has
      // nowhere legal left to go, and only a global rearrangement helps.
      if (!a.dummy) {
        for (const [p, q] of segs) {
          if (p === a || q === a) continue;
          const ex = q.x - p.x, ey = q.y - p.y;
          const len = Math.hypot(ex, ey) || 1;
          const ux = -ey / len, uy = ex / len;
          const sd = (a.x - p.x) * ux + (a.y - p.y) * uy;
          const reach = Math.abs(ux) * (a.w / 2 + 8) + Math.abs(uy) * (a.h / 2 + 8);
          if (Math.abs(sd) >= reach || !segHitsCard(p, q, a, 8)) continue;
          const s = sd >= 0 ? 1 : -1;
          const pen = reach - Math.abs(sd);
          fx += ux * s * pen * 0.4;
          fy += uy * s * pen * 0.4;
        }
      }
      return [fx, fy];
    };

    // Move one node at a time, as far as the topology allows (PrEd-style line
    // search). Bisecting a whole iteration instead — the way `guarded` does —
    // lets a single blocked pair freeze all fifteen cards, which is why the
    // map used to settle long before it ran out of canvas.
    // `strict` adds the readability constraints to the line search. Early on,
    // while the layout is still fluid, only the topology is protected and the
    // drawing is free to rearrange; once it starts settling, a move that
    // parks a card on an edge is refused outright rather than left for the
    // repair passes, which by then have nowhere to put it.
    const expandStep = (mu, strict) => {
      for (let i = 0; i < N; i++) {
        const n = nodes[i];
        if (n === pinned) continue;
        const [fx, fy] = forceOn(i);
        const x0 = n.x, y0 = n.y;
        const wasHits = strict ? cardLineHits(n, 6) : 0;
        let placed = false;
        for (const f of [1, 0.5, 0.25]) {
          n.x = x0 + fx * mu * f;
          n.y = y0 + fy * mu * f;
          clampNode(n);
          if (certified && nodeCrosses(n)) continue;
          if (strict && cardLineHits(n, 6) > wasHits) continue;
          placed = true;
          break;
        }
        if (!placed) { n.x = x0; n.y = y0; }
      }
    };

    // unique straight segments across all chains — the geometry the topology
    // invariant is checked on
    const segs = [];
    {
      const seen = new Set();
      for (const chain of chains) for (let i = 0; i + 1 < chain.length; i++) {
        const a = chain[i], b = chain[i + 1];
        const k = a < b ? a + "\x1f" + b : b + "\x1f" + a;
        if (!seen.has(k)) { seen.add(k); segs.push([nodeById[a], nodeById[b]]); }
      }
    }

    // The faces of the certified drawing: the polygons the edges cut the
    // canvas into. Readability is mostly a property of these rather than of
    // the nodes — a drawing feels airy when no face is starved, and cramped
    // when one is, however evenly the cards themselves are spread.
    const faceRings = ((certified && topo.faces) || [])
      .map((ids) => ids.map((id) => nodeById[id]).filter(Boolean))
      .filter((ring) => new Set(ring).size >= 3);
    const faceArea = faceRings.map(() => 0);
    let outerFace = -1;
    const measureFaces = () => {
      let big = -1;
      faceRings.forEach((ring, fi) => {
        let a2 = 0; // shoelace
        for (let i = 0; i < ring.length; i++) {
          const p = ring[i], q = ring[(i + 1) % ring.length];
          a2 += p.x * q.y - q.x * p.y;
        }
        faceArea[fi] = Math.abs(a2 / 2);
        // the unbounded face wraps all the others, so it is the largest
        if (faceArea[fi] > big) { big = faceArea[fi]; outerFace = fi; }
      });
    };
    // how many certified drawings to settle and compare (see `readability`)
    const VARIANTS = 4;

    const orient = (a, b, c) => Math.sign((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x));
    const crossing = (a, b, c, d) => {
      const o1 = orient(a, b, c), o2 = orient(a, b, d);
      const o3 = orient(c, d, a), o4 = orient(c, d, b);
      return o1 !== o2 && o3 !== o4 && o1 !== 0 && o2 !== 0;
    };
    const hasCrossing = () => {
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const [a, b] = segs[i], [c, d] = segs[j];
        if (a === c || a === d || b === c || b === d) continue;
        if (crossing(a, b, c, d)) return true;
      }
      return false;
    };
    // The local guard: after moving one node, only that node's own segments
    // can newly cross, so only they need re-testing. Same invariant as
    // hasCrossing at a fraction of the cost — this is what makes the detail
    // ladder (and the full solve) fast. Multi-node steps still use the
    // global check via guarded().
    const segsOf = new Map(nodes.map((n) => [n, []]));
    for (const sgm of segs) { segsOf.get(sgm[0]).push(sgm); segsOf.get(sgm[1]).push(sgm); }
    const nodeCrosses = (n) => {
      for (const [a, b] of segsOf.get(n) || []) {
        for (const [c, d] of segs) {
          if (a === c || a === d || b === c || b === d) continue;
          if (crossing(a, b, c, d)) return true;
        }
      }
      return false;
    };

    // PrEd-style hard constraint: the planarized drawing starts crossing-free
    // and must stay that way. An iteration that would break the invariant is
    // bisected back toward the last valid geometry (f = 0 restores it).
    const guarded = (step) => {
      if (!certified) { step(); return; }
      const before = nodes.map((n) => [n.x, n.y]);
      step();
      if (!hasCrossing()) return;
      const after = nodes.map((n) => [n.x, n.y]);
      for (const f of [0.5, 0.25, 0.12, 0.06, 0]) {
        nodes.forEach((n, i) => {
          n.x = before[i][0] + (after[i][0] - before[i][0]) * f;
          n.y = before[i][1] + (after[i][1] - before[i][1]) * f;
        });
        if (!hasCrossing()) return;
      }
    };

    // soft uncrossing push — only the uncertified fallback needs it
    const crossingStep = (mu) => {
      for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) {
        const [a, b] = segs[i], [c, d] = segs[j];
        if (a === c || a === d || b === c || b === d) continue;
        if (!crossing(a, b, c, d)) continue;
        let vx = (a.x + b.x - c.x - d.x) / 2, vy = (a.y + b.y - c.y - d.y) / 2;
        const len = Math.hypot(vx, vy);
        if (len < 1) { vx = -(b.y - a.y); vy = b.x - a.x; }
        const l2 = Math.hypot(vx, vy) || 1;
        const push = 34 * mu;
        vx = (vx / l2) * push; vy = (vy / l2) * push;
        shift(a, vx, vy); shift(b, vx, vy);
        shift(c, -vx, -vy); shift(d, -vx, -vy);
      }
    };

    // the point (and local direction) at arc-length parameter c.t along the
    // conn's polyline chain
    const labelFrame = (c) => {
      const pts = c.chain.map((id) => nodeById[id]);
      const lens = [];
      let total = 0;
      for (let i = 0; i + 1 < pts.length; i++) {
        const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y) || 0.001;
        lens.push(l); total += l;
      }
      let d = c.t * total;
      let i = 0;
      while (i < lens.length - 1 && d > lens[i]) { d -= lens[i]; i += 1; }
      const f = Math.max(0, Math.min(1, d / lens[i]));
      const ux = (pts[i + 1].x - pts[i].x) / lens[i], uy = (pts[i + 1].y - pts[i].y) / lens[i];
      return {
        x: pts[i].x + f * (pts[i + 1].x - pts[i].x),
        y: pts[i].y + f * (pts[i + 1].y - pts[i].y),
        ux, uy, total,
      };
    };
    const labelPos = labelFrame;
    const bodies = [
      ...nodes.map((n) => ({ n })),
      ...conns.filter((c) => c.label).map((c) => ({ c })),
    ];
    const rectOf = (b) => {
      if (b.n) {
        // bend points get a small keep-out so cards don't sit on a crossing
        if (b.n.dummy) return { x: b.n.x, y: b.n.y, w: 26, h: 26 };
        return { x: b.n.x, y: b.n.y, w: b.n.w + 30, h: b.n.h + 24 };
      }
      const p = labelPos(b.c);
      return { x: p.x, y: p.y, w: b.c.lw + 20, h: b.c.lh + 14 };
    };
    // a label's slide range keeps it clear of its own endpoint cards (in
    // pixels, so short edges near big cards still push the label to daylight)
    const tRange = (c) => {
      const a = nodeById[c.from], b = nodeById[c.to];
      const len = labelFrame(c).total || 1;
      const lo = Math.min(0.42, ((a.w + a.h) / 4 + (c.lw || 40) * 0.3 + 6) / len);
      const hi = Math.max(0.58, 1 - ((b.w + b.h) / 4 + (c.lw || 40) * 0.3 + 6) / len);
      return lo <= hi ? [lo, hi] : [0.35, 0.65];
    };
    const pushRect = (b, dx, dy) => {
      if (b.n) { shift(b.n, dx, dy); return; }
      // labels only slide along their own polyline
      const f = labelFrame(b.c);
      const [lo, hi] = tRange(b.c);
      b.c.t = Math.max(lo, Math.min(hi, b.c.t + (dx * f.ux + dy * f.uy) / f.total));
    };
    // Gauss-Seidel: each pair reads live geometry, so pushes don't cancel
    const overlapStep = (k) => {
      for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
        const A = rectOf(bodies[i]), B = rectOf(bodies[j]);
        const ox = (A.w + B.w) / 2 - Math.abs(A.x - B.x);
        const oy = (A.h + B.h) / 2 - Math.abs(A.y - B.y);
        if (ox <= 0 || oy <= 0) continue;
        // in card-vs-label collisions the card yields extra space, since the
        // label can only slide along its own line
        const fA = bodies[i].n && bodies[j].c ? 2 : 1;
        const fB = bodies[j].n && bodies[i].c ? 2 : 1;
        if (ox < oy) {
          const s = (A.x < B.x ? -1 : 1) * ox * 0.5 * k;
          pushRect(bodies[i], s * fA, 0); pushRect(bodies[j], -s * fB, 0);
        } else {
          const s = (A.y < B.y ? -1 : 1) * oy * 0.5 * k;
          pushRect(bodies[i], 0, s * fA); pushRect(bodies[j], 0, -s * fB);
        }
      }
    };

    // labels shouldn't sit on lines they aren't labeling: slide the label
    // away along its own line, and (unless the user is arranging things)
    // nudge the offending line's endpoints off
    const segKey = (a, b) => (a.id < b.id ? a.id + "\x1f" + b.id : b.id + "\x1f" + a.id);
    const labelLineStep = (k, moveNodes = true) => {
      for (const c of conns) {
        if (!c.label) continue;
        const own = new Set();
        for (let i = 0; i + 1 < c.chain.length; i++)
          own.add(segKey(nodeById[c.chain[i]], nodeById[c.chain[i + 1]]));
        const p = labelPos(c);
        const hw = (c.lw + 26) / 2, hh = (c.lh + 18) / 2;
        for (const [a, b] of segs) {
          if (own.has(segKey(a, b))) continue;
          const ex = b.x - a.x, ey = b.y - a.y;
          const len2 = ex * ex + ey * ey || 1;
          let t = ((p.x - a.x) * ex + (p.y - a.y) * ey) / len2;
          t = Math.max(0, Math.min(1, t));
          const qx = a.x + t * ex, qy = a.y + t * ey;
          const dx = p.x - qx, dy = p.y - qy;
          if (Math.abs(dx) >= hw || Math.abs(dy) >= hh) continue;
          const pen = Math.min(hw - Math.abs(dx), hh - Math.abs(dy));
          let ux = dx, uy = dy;
          const ul = Math.hypot(ux, uy);
          if (ul < 0.5) { const l = Math.hypot(ex, ey) || 1; ux = -ey / l; uy = ex / l; }
          else { ux /= ul; uy /= ul; }
          const push = Math.min(pen, 26) * k;
          pushRect({ c }, ux * push, uy * push);
          if (moveNodes) {
            shift(a, -ux * push * 0.15, -uy * push * 0.15);
            shift(b, -ux * push * 0.15, -uy * push * 0.15);
          }
        }
      }
    };

    // Ink that actually touches, ignoring the breathing room the descent
    // likes to keep. A move is judged against this, not against the padded
    // rectangles — otherwise every sideways nudge "increases overlap" by
    // eating slack, and nothing is ever allowed to move.
    const rawRect = (b) => {
      if (b.n) return { x: b.n.x, y: b.n.y, w: b.n.dummy ? 0 : b.n.w + 4, h: b.n.dummy ? 0 : b.n.h + 4 };
      const p = labelPos(b.c);
      return { x: p.x, y: p.y, w: b.c.lw + 4, h: b.c.lh + 4 };
    };
    // cards only: two cards touching is the collision that must never happen,
    // while a label can always slide along its own edge to get out of the way
    const cardCollisions = () => {
      const real = nodes.filter((n) => !n.dummy);
      let c = 0;
      for (let i = 0; i < real.length; i++) for (let j = i + 1; j < real.length; j++) {
        const A = rawRect({ n: real[i] }), B = rawRect({ n: real[j] });
        if (Math.abs(A.x - B.x) < (A.w + B.w) / 2 && Math.abs(A.y - B.y) < (A.h + B.h) / 2) c += 1;
      }
      return c;
    };

    // Liang–Barsky: does segment a-b enter n's padded rectangle?
    const segHitsCard = (a, b, n, pad) => {
      const hw = n.w / 2 + pad, hh = n.h / 2 + pad;
      const dx = b.x - a.x, dy = b.y - a.y;
      const p = [-dx, dx, -dy, dy];
      const q = [a.x - (n.x - hw), n.x + hw - a.x, a.y - (n.y - hh), n.y + hh - a.y];
      let t0 = 0, t1 = 1;
      for (let i = 0; i < 4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return false; continue; }
        const r = q[i] / p[i];
        if (p[i] < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
        else { if (r < t0) return false; if (r < t1) t1 = r; }
      }
      return t1 >= t0;
    };

    const cardLineHits = (n, pad) => {
      if (n.dummy) return 0;
      let c = 0;
      for (const [a, b] of segs) {
        if (a === n || b === n) continue; // a card's own edges may touch it
        if (segHitsCard(a, b, n, pad)) c += 1;
      }
      return c;
    };
    const cardOnLine = (n, pad) => cardLineHits(n, pad) > 0;

    // A card sitting on an edge reads as a break in that edge — the line
    // appears to stop at the card and start again on the far side. Push the
    // card clear, trying the smallest move first and keeping the first
    // direction that neither creates a fresh overlap nor costs a crossing.
    const nodeLineStep = (pad) => {
      for (const n of nodes) {
        if (n.dummy || n === pinned) continue;
        // one offending edge at a time; each accepted move strictly reduces
        // the count, so this terminates
        for (let attempt = 0; attempt < 4; attempt++) {
          const beforeHits = cardLineHits(n, pad);
          if (!beforeHits) break;
          // deal with the edge cutting closest to the card's centre first
          let a = null, b = null, worst = Infinity;
          for (const [p, q] of segs) {
            if (p === n || q === n || !segHitsCard(p, q, n, pad)) continue;
            const ex = q.x - p.x, ey = q.y - p.y, len = Math.hypot(ex, ey) || 1;
            const d = Math.abs((n.x - p.x) * (-ey / len) + (n.y - p.y) * (ex / len));
            if (d < worst) { worst = d; a = p; b = q; }
          }
          if (!a) break;
          const hw = n.w / 2 + pad, hh = n.h / 2 + pad;
          const ex = b.x - a.x, ey = b.y - a.y;
          const len = Math.hypot(ex, ey) || 1;
          const nx = -ey / len, ny = ex / len; // unit normal to the edge
          const dist = (n.x - a.x) * nx + (n.y - a.y) * ny; // signed, centre to line
          const reach = Math.abs(nx) * hw + Math.abs(ny) * hh; // rect extent along it
          const need = reach - Math.abs(dist) + 1;
          if (need <= 0) break;
          const s = dist >= 0 ? 1 : -1; // clear on the side the card already sits
          const cands = [[nx * s * need, ny * s * need]];
          if (Math.abs(ny) > 0.15) cands.push([0, (s * need) / ny]);
          if (Math.abs(nx) > 0.15) cands.push([(s * need) / nx, 0]);
          cands.sort((u, v) => Math.hypot(u[0], u[1]) - Math.hypot(v[0], v[1]));
          const beforeCards = cardCollisions();
          const x0 = n.x, y0 = n.y;
          let placed = false;
          for (const [mx, my] of cands) {
            n.x = x0 + mx; n.y = y0 + my;
            clampNode(n);
            if (certified && nodeCrosses(n)) continue;
            if (cardCollisions() > beforeCards) continue; // the direction that costs an overlap
            if (cardLineHits(n, pad) >= beforeHits) continue; // no progress, or clamped short
            placed = true;
            break;
          }
          if (placed) continue;
          n.x = x0; n.y = y0;
          // The card is boxed in. Move the edge instead: slide both its
          // endpoints away along the same normal. Same relief, opposite party.
          const keep = [[a.x, a.y], [b.x, b.y]];
          const away = -s * need * 0.7;
          shift(a, nx * away, ny * away);
          shift(b, nx * away, ny * away);
          clampNode(a); clampNode(b);
          if ((certified && (nodeCrosses(a) || nodeCrosses(b))) || cardCollisions() > beforeCards
              || cardLineHits(n, pad) >= beforeHits) {
            a.x = keep[0][0]; a.y = keep[0][1];
            b.x = keep[1][0]; b.y = keep[1][1];
            break;
          }
        }
      }
    };

    const clampAll = () => {
      for (const n of nodes) {
        if (n === pinned) continue;
        n.x = Math.max(n.w / 2 + 4, Math.min(W - n.w / 2 - 4, n.x));
        n.y = Math.max(n.h / 2 + 4, Math.min(H - n.h / 2 - 4, n.y));
      }
      // nodes moved: re-clamp every label into its valid stretch of line
      for (const c of conns) {
        if (!c.label) continue;
        const [lo, hi] = tRange(c);
        c.t = Math.max(lo, Math.min(hi, c.t));
      }
    };

    // stretch the settled arrangement to fill the canvas: a per-axis affine
    // map keeps lines straight and crossings identical, it just uses the room
    const normalize = () => {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const n of nodes) {
        minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
      }
      const padX = Math.max(...nodes.map((n) => n.w)) / 2 + 12;
      const padY = Math.max(...nodes.map((n) => n.h)) / 2 + 10;
      const sx = (W - 2 * padX) / Math.max(1, maxX - minX);
      const sy = (H - 2 * padY) / Math.max(1, maxY - minY);
      for (const n of nodes) {
        n.x = padX + (n.x - minX) * sx;
        n.y = padY + (n.y - minY) * sy;
      }
    };

    // last-resort overlap resolution with per-pair rollback: apply one pair's
    // separation at a time, and if that single move would break the certified
    // topology, undo just those two bodies — overlap fixes elsewhere survive
    const resolveOverlapsExact = (rounds) => {
      for (let r = 0; r < rounds; r++) {
        let moved = false;
        for (let i = 0; i < bodies.length; i++) for (let j = i + 1; j < bodies.length; j++) {
          const A = rectOf(bodies[i]), B = rectOf(bodies[j]);
          const ox = (A.w + B.w) / 2 - Math.abs(A.x - B.x);
          const oy = (A.h + B.h) / 2 - Math.abs(A.y - B.y);
          if (ox <= 0 || oy <= 0) continue;
          const fA = bodies[i].n && bodies[j].c ? 2 : 1;
          const fB = bodies[j].n && bodies[i].c ? 2 : 1;
          // separating two cards must not park either of them on an edge
          const wasOnLine = [bodies[i], bodies[j]].map((b) => b.n && cardOnLine(b.n, 5));
          const apply = (axis, k) => {
            const save = [bodies[i], bodies[j]].map((b) =>
              b.n ? { b, x: b.n.x, y: b.n.y } : { b, t: b.c.t });
            if (axis === "x") {
              const s = (A.x < B.x ? -1 : 1) * ox * 0.5 * k;
              pushRect(bodies[i], s * fA, 0); pushRect(bodies[j], -s * fB, 0);
            } else {
              const s = (A.y < B.y ? -1 : 1) * oy * 0.5 * k;
              pushRect(bodies[i], 0, s * fA); pushRect(bodies[j], 0, -s * fB);
            }
            for (const b of [bodies[i], bodies[j]]) if (b.n) clampNode(b.n);
            const landedOnLine = [bodies[i], bodies[j]].some(
              (b, k) => b.n && !wasOnLine[k] && cardOnLine(b.n, 5));
            const crossed = certified && [bodies[i], bodies[j]].some((b) => b.n && nodeCrosses(b.n));
            if (crossed || landedOnLine) {
              for (const s2 of save) {
                if (s2.x !== undefined) { s2.b.n.x = s2.x; s2.b.n.y = s2.y; }
                else s2.b.c.t = s2.t;
              }
              return false;
            }
            return true;
          };
          // separate along the least-penetration axis; if the topology vetoes
          // it, the other axis — or a shorter step — often has room
          const first = ox < oy ? "x" : "y";
          const second = ox < oy ? "y" : "x";
          if (apply(first, 1) || apply(second, 1) || apply(first, 0.4) || apply(second, 0.4))
            moved = true;
        }
        if (!moved) break;
      }
    };

    const optimize = (iters, muMax) => {
      for (let it = 0; it < iters; it++) {
        const mu = muMax * (1 - it / iters) + 0.02;
        // placement is per-node and self-guarding; the remaining terms are
        // guarded one at a time, so a veto on one doesn't undo the others
        expandStep(mu, mu < 0.35 * muMax);
        // certified layouts hold crossings at the proven minimum by
        // construction; only the fallback needs the soft uncrossing push
        if (!certified) crossingStep(Math.max(mu, 0.3 * muMax));
        guarded(() => overlapStep(Math.min(1, mu * 1.5)));
        guarded(() => labelLineStep(Math.min(1, mu * 1.5)));
        guarded(() => clampAll());
      }
      normalize(); // affine, so the crossing set is untouched
      // polish: guarantee nothing overlaps at rest
      for (let it = 0; it < 60; it++) {
        if (!certified) crossingStep(0.25);
        expandStep(0.3, true);
        guarded(() => overlapStep(0.85));
        guarded(() => labelLineStep(0.6, false));
        guarded(() => clampAll());
      }
      normalize(); // polish may have shrunk the arrangement: reclaim the room
      for (let it = 0; it < 40; it++) {
        guarded(() => overlapStep(0.9));
        guarded(() => labelLineStep(0.5, false));
        guarded(() => clampAll());
      }
      resolveOverlapsExact(60);
      // last: alternate lifting cards off the edges running through them with
      // repairing whatever overlap that shakes loose. Each pass refuses to
      // undo the other's work, so the two converge instead of trading places.
      for (let round = 0; round < 8; round++) {
        nodeLineStep(5);
        resolveOverlapsExact(10);
      }
      nodeLineStep(5);
      // labels last. They can always slide along their own edge, and the
      // overlap pass refuses to park a card back on a line, so this settles
      // the labels without undoing the card placement above.
      resolveOverlapsExact(20);
    };

    // overlap-only settle: respects wherever the user has put things
    const settle = (iters) => {
      for (let it = 0; it < iters; it++) {
        guarded(() => overlapStep(0.8));
        guarded(() => labelLineStep(0.5, false));
        guarded(() => clampAll());
      }
    };

    const render = () => {
      for (const n of nodes) {
        if (n.dummy) continue;
        nodeEls[n.id].style.transform = `translate(${n.x}px, ${n.y}px) translate(-50%, -50%)`;
        // the hover grow uses the `scale` property, which applies outside the
        // transform above and so would scale the translate with it; pinning
        // the origin to the anchor point makes the card swell around itself
        nodeEls[n.id].style.transformOrigin = `${n.x}px ${n.y}px`;
      }
      conns.forEach((c, i) => {
        const els = segEls[i] || [];
        const pts = c.chain.map((id) => nodeById[id]);
        if (els.length) els[0].setAttribute("points", pts.map((n) => `${n.x},${n.y}`).join(" "));
        if (!c.label) return;
        const p = labelPos(c);
        const lab = labelEls[i];
        lab.style.left = `${p.x}px`;
        lab.style.top = `${p.y}px`;
      });
    };

    // How readable is the arrangement? Ranked the way the eye complains:
    // cards colliding first, then edges running through cards, then how much
    // of the canvas is actually used.
    // airiness: the smallest polygon decides how cramped a drawing feels, the
    // total decides how much of the canvas it uses. Both in px so they add.
    const airiness = () => {
      measureFaces();
      let min = Infinity, total = 0;
      faceRings.forEach((_, fi) => {
        if (fi === outerFace) return;
        min = Math.min(min, faceArea[fi]);
        total += faceArea[fi];
      });
      if (!Number.isFinite(min)) return 0;
      return Math.sqrt(min) + 0.5 * Math.sqrt(total);
    };
    const readability = () => {
      let onLines = 0;
      for (const n of nodes) onLines += cardLineHits(n, 5);
      let labelsOnCards = 0;
      for (const c of conns) {
        if (!c.label) continue;
        const L = rawRect({ c });
        for (const n of nodes) {
          if (n.dummy) continue;
          const A = rawRect({ n });
          if (Math.abs(L.x - A.x) < (L.w + A.w) / 2 && Math.abs(L.y - A.y) < (L.h + A.h) / 2)
            labelsOnCards += 1;
        }
      }
      return cardCollisions() * 2000 + onLines * 400 + labelsOnCards * 300 - airiness();
    };

    const snapshot = () => ({ p: nodes.map((n) => [n.x, n.y]), t: conns.map((c) => c.t) });
    const restore = (s) => {
      nodes.forEach((n, i) => { n.x = s.p[i][0]; n.y = s.p[i][1]; });
      conns.forEach((c, i) => { c.t = s.t[i]; });
    };

    /* ---------- the detail ladder ----------
       Coarser views of the same map, precomputed so the detail slider only
       interpolates and never runs a solver. Built top-down: rung sets are
       nested (highest-stake groups survive to the coarsest view), each rung
       is seeded from the finer one — a subset of a crossing-free drawing is
       crossing-free, so every rung inherits the certificate — and a guarded
       proximal pull toward the full drawing keeps the shape the reader has
       memorised while the rung breathes into the freed space. */
    const LEVELS = 12, FLOOR = 4;
    const rankedIds = items.map((s) => s.id)
      .sort((a, b) => stakeOf(nodeById[b].s) - stakeOf(nodeById[a].s));
    const rungSets = [];
    for (let i = 0; i < LEVELS; i++) {
      const k = Math.round(Math.min(FLOOR, rankedIds.length)
        + (rankedIds.length - Math.min(FLOOR, rankedIds.length)) * (i / (LEVELS - 1)));
      const real = new Set(rankedIds.slice(0, k));
      for (const chain of chains)
        if (real.has(chain[0]) && real.has(chain[chain.length - 1]))
          for (const id of chain) real.add(id);
      rungSets.push(real);
    }

    // solve one coarser rung, live-engine style: the same one-sided descent
    // terms restricted to the rung's subgraph, the local guard, and the
    // stability pull applied as a proximal step (as a plain term it is
    // drowned out by the expansion it should restrain — measured in the lab)
    const solveRung = (active, canonical, alpha, iters) => {
      const live = nodes.filter((n) => active.has(n.id));
      const liveSegs = segs.filter(([a, b]) => active.has(a.id) && active.has(b.id));
      const liveSegsOf = new Map(live.map((n) => [n, liveSegs.filter(([a, b]) => a === n || b === n)]));
      const rungCrosses = (n) => {
        for (const [a, b] of liveSegsOf.get(n) || []) for (const [c, d] of liveSegs) {
          if (a === c || a === d || b === c || b === d) continue;
          if (crossing(a, b, c, d)) return true;
        }
        return false;
      };
      const rungHits = (n, pad) => {
        if (n.dummy) return 0;
        let c = 0;
        for (const [a, b] of liveSegs) {
          if (a === n || b === n) continue;
          if (segHitsCard(a, b, n, pad)) c += 1;
        }
        return c;
      };
      const li = new Map(live.map((n, i) => [n, i]));
      const ladj = live.map(() => []);
      for (const [a, b] of liveSegs) { ladj[li.get(a)].push(li.get(b)); ladj[li.get(b)].push(li.get(a)); }
      const lhops = live.map((_, i) => {
        const d = Array(live.length).fill(Infinity); d[i] = 0; const q = [i];
        while (q.length) { const u = q.shift(); for (const v of ladj[u]) if (d[v] === Infinity) { d[v] = d[u] + 1; q.push(v); } }
        return d;
      });
      const ldeg = ladj.map((a) => a.length);
      const lR = Math.max(Math.sqrt((W * H) / Math.max(1, live.length)) * 1.5, Math.min(W, H) * 0.5);
      const ltarget = (i, j) => {
        const fan = lhops[i][j] === 1 ? 1 + 0.05 * Math.max(0, ldeg[i] + ldeg[j] - 4) : 1;
        return Math.min((lhops[i][j] === Infinity ? 1.6 : lhops[i][j]) * L * fan, Math.max(W, H) * 0.8);
      };
      for (let it = 0; it < iters; it++) {
        const mu = (1 - it / iters) + 0.02;
        const strict = it > iters * 0.6;
        for (let i = 0; i < live.length; i++) {
          const n = live[i];
          let gx = 0, gy = 0;
          for (let j = 0; j < live.length; j++) {
            if (i === j) continue;
            const m = live[j];
            const dx = m.x - n.x, dy = m.y - n.y;
            const d = Math.hypot(dx, dy) || 1;
            if (lhops[i][j] === 1) {
              const excess = d - ltarget(i, j);
              const w = 0.55 * (excess > 0 ? 0.1 : 1);
              gx += dx * (excess / d) * w; gy += dy * (excess / d) * w;
            } else {
              const room = Math.max(ltarget(i, j), lR);
              if (d >= room) continue;
              const push = ((room - d) / d) * 0.2;
              gx -= dx * push; gy -= dy * push;
            }
          }
          const wasHits = strict && !n.dummy ? rungHits(n, 6) : 0;
          const x0 = n.x, y0 = n.y;
          let placed = false;
          for (const f of [1, 0.5, 0.25]) {
            n.x = x0 + gx * mu * f; n.y = y0 + gy * mu * f;
            clampNode(n);
            if (certified && rungCrosses(n)) continue;
            if (strict && !n.dummy && rungHits(n, 6) > wasHits) continue;
            placed = true; break;
          }
          if (!placed) { n.x = x0; n.y = y0; }
          const c = canonical.get(n.id);
          if (c) {
            const pull = alpha * (0.30 - 0.22 * (it / iters));
            const sx = n.x, sy = n.y;
            n.x += (c[0] - n.x) * pull; n.y += (c[1] - n.y) * pull;
            clampNode(n);
            if ((certified && rungCrosses(n)) || (strict && !n.dummy && rungHits(n, 6) > wasHits)) { n.x = sx; n.y = sy; }
          }
        }
      }
      // rectangle separation with per-pair rollback, cards only (labels keep
      // their full-detail slot; they follow their edges through the blend)
      for (let round = 0; round < 30; round++) {
        let moved = false;
        for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
          const A = live[i], B = live[j];
          if (A.dummy && B.dummy) continue;
          const ox = ((A.dummy ? 26 : A.w + 30) + (B.dummy ? 26 : B.w + 30)) / 2 - Math.abs(A.x - B.x);
          const oy = ((A.dummy ? 26 : A.h + 24) + (B.dummy ? 26 : B.h + 24)) / 2 - Math.abs(A.y - B.y);
          if (ox <= 0 || oy <= 0) continue;
          const apply = (axis, k) => {
            const save = [[A.x, A.y], [B.x, B.y]];
            if (axis === "x") { const s = (A.x < B.x ? -1 : 1) * ox * 0.5 * k; A.x += s; B.x -= s; }
            else { const s = (A.y < B.y ? -1 : 1) * oy * 0.5 * k; A.y += s; B.y -= s; }
            clampNode(A); clampNode(B);
            if (certified && (rungCrosses(A) || rungCrosses(B))) {
              A.x = save[0][0]; A.y = save[0][1]; B.x = save[1][0]; B.y = save[1][1];
              return false;
            }
            return true;
          };
          const first = ox < oy ? "x" : "y", second = ox < oy ? "y" : "x";
          if (apply(first, 1) || apply(second, 1) || apply(first, 0.4) || apply(second, 0.4)) moved = true;
        }
        if (!moved) break;
      }
      const out = new Map();
      for (const n of live) out.set(n.id, [n.x, n.y]);
      return out;
    };

    const buildLadder = () => {
      const full = new Map(nodes.map((n) => [n.id, [n.x, n.y]]));
      const ladder = new Array(LEVELS);
      ladder[LEVELS - 1] = full;
      for (let r = LEVELS - 2; r >= 0; r--) {
        // seed from the finer rung, then let this rung breathe
        for (const n of nodes) {
          const p = ladder[r + 1].get(n.id);
          if (p) { n.x = p[0]; n.y = p[1]; }
        }
        ladder[r] = solveRung(rungSets[r], full, 0.95, 110);
      }
      // restore full-detail positions after the rung solves
      for (const n of nodes) { const p = full.get(n.id); n.x = p[0]; n.y = p[1]; }
      // Certified while sliding, not just at rest. The persistent geometry
      // never crosses mid-blend (asserted below); the edges that CAN cross
      // are the arriving ones, drawn full-length at their destination while
      // everything else is still travelling. So each arriving edge gets a
      // fade gate: the latest blend moment it still crosses anything, plus a
      // margin — it becomes visible only once the drawing is clear for it.
      const fadeStarts = [];
      for (let r = 0; r + 1 < LEVELS; r++) {
        const fs = new Map();
        const present = rungSets[r + 1];
        const posAt = (t) => {
          const m = new Map();
          for (const id of present) {
            const a = ladder[r].get(id), b = ladder[r + 1].get(id);
            m.set(id, a && b ? [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] : (b || a));
          }
          return m;
        };
        // arriving edges: gate their fade past their last crossing moment
        conns.forEach((c, ci) => {
          if (!c.chain.every((id) => present.has(id))) return;
          if (c.chain.every((id) => rungSets[r].has(id))) return;
          let last = -1;
          for (let s2 = 1; s2 <= 19; s2++) {
            const t = s2 / 20;
            const pos = posAt(t);
            const P = (id) => ({ x: pos.get(id)[0], y: pos.get(id)[1] });
            let hit = false;
            for (let i = 0; i + 1 < c.chain.length && !hit; i++) {
              const a = c.chain[i], b = c.chain[i + 1];
              for (const [cc, dd] of segs) {
                if (!pos.has(cc.id) || !pos.has(dd.id)) continue;
                if (cc.id === a || cc.id === b || dd.id === a || dd.id === b) continue;
                if (crossing(P(a), P(b), P(cc.id), P(dd.id))) { hit = true; break; }
              }
            }
            if (hit) last = t;
          }
          if (last >= 0) fs.set(ci, Math.min(0.97, last + 0.08));
        });
        fadeStarts.push(fs);
        // and assert the part that must hold unconditionally: edges present
        // at BOTH rungs never cross each other mid-blend
        for (const t of [0.25, 0.5, 0.75]) {
          const pos = posAt(t);
          const rs = segs.filter(([a, b]) => rungSets[r].has(a.id) && rungSets[r].has(b.id));
          let c = 0;
          for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) {
            const [a, b] = rs[i], [cc, d] = rs[j];
            if (a === cc || a === d || b === cc || b === d) continue;
            const A = { x: pos.get(a.id)[0], y: pos.get(a.id)[1] }, B = { x: pos.get(b.id)[0], y: pos.get(b.id)[1] };
            const C = { x: pos.get(cc.id)[0], y: pos.get(cc.id)[1] }, D = { x: pos.get(d.id)[0], y: pos.get(d.id)[1] };
            if (crossing(A, B, C, D)) c += 1;
          }
          if (c > topo.k) console.info(`[stakeholders] ${c - topo.k} persistent transient crossing(s) in gap ${r}`);
        }
      }
      stakeLayoutCache.fadeStarts = fadeStarts;
      return ladder;
    };

    // paint one detail position: pure interpolation between two rungs —
    // never a solve, so the slider costs microseconds per frame
    const smooth = (t) => t * t * (3 - 2 * t);
    const paintDetail = (detail) => {
      const ladder = stakeLayoutCache.ladder;
      if (!ladder) { render(); return; }
      const pos = detail * (LEVELS - 1);
      const r0 = Math.max(0, Math.min(LEVELS - 1, Math.floor(pos)));
      const r1 = Math.min(LEVELS - 1, r0 + 1);
      const t = smooth(Math.max(0, Math.min(1, pos - r0)));
      const A = ladder[r0], B = ladder[r1];
      let visible = 0;
      for (const n of nodes) {
        const a = A.get(n.id), b = B.get(n.id);
        if (a && b) { n.x = a[0] + (b[0] - a[0]) * t; n.y = a[1] + (b[1] - a[1]) * t; n.alpha = 1; }
        else if (b) { n.x = b[0]; n.y = b[1]; n.alpha = t; }        // arriving
        else { n.alpha = 0; }
        if (!n.dummy && n.alpha > 0.5) visible += 1;
        const el = nodeEls[n.id];
        if (el) { el.style.opacity = n.alpha; el.style.pointerEvents = n.alpha > 0.5 ? "" : "none"; }
      }
      render();
      conns.forEach((c, i) => {
        let alpha = Math.min(...c.chain.map((id) => nodeById[id].alpha ?? 0));
        // arriving edges wait for their fade gate: visible only from the
        // moment the blend is crossing-free for them
        const fs = stakeLayoutCache.fadeStarts?.[r0]?.get(i);
        if (fs !== undefined && alpha > 0 && alpha < 1)
          alpha = t <= fs ? 0 : (t - fs) / (1 - fs);
        for (const el of segEls[i] || []) el.style.opacity = alpha * alpha;
        const lab = labelEls[i];
        if (lab) lab.style.opacity = alpha > 0.6 ? 1 : 0;
      });
      const count = document.querySelector(".map-count");
      if (count) count.textContent = `${visible} of ${items.length} groups`;
      return visible;
    };
    stakePaintHook = paintDetail;

    // Geometry is cached per graph *and* per canvas size: searching only
    // re-dims cards, and re-optimising on every keystroke would both cost
    // 150ms and jump the map around under the reader.
    const layoutKey = topoKey + "|" + W + "x" + H + "|" + nodes.map((n) => n.w).join(",");
    const saveLayout = () => {
      stakeLayoutCache.key = layoutKey;
      stakeLayoutCache.state = snapshot();
      stakeLayoutCache.ladder = buildLadder();
    };

    if (stakeLayoutCache.key === layoutKey && stakeLayoutCache.state
        && stakeLayoutCache.state.p.length === nodes.length) {
      restore(stakeLayoutCache.state);
      if (!stakeLayoutCache.ladder) stakeLayoutCache.ladder = buildLadder();
    } else {
      // Each certified outer face is a different crossing-minimal drawing.
      // Screen them cheaply, then spend the full budget on the best one —
      // a card boxed in against an edge has nowhere legal to go, so the
      // rearrangement has to come from the starting configuration.
      const seeds = certified && topo.variants && topo.variants.length > 1
        ? topo.variants.slice(0, VARIANTS) : [certified ? topo.pos : null];
      if (seeds.length > 1) {
        // Score each candidate fully settled, not part-way: a half-converged
        // layout ranks on noise. Variant 0 is the drawing the single-seed
        // path would have used, so the winner is never worse than before.
        let best = null, bestScore = Infinity;
        for (const seed of seeds) {
          seedFrom(seed);
          optimize(320, 1);
          const score = readability();
          if (score < bestScore) { bestScore = score; best = snapshot(); }
        }
        restore(best);
      } else {
        seedFrom(seeds[0]);
        optimize(520, 1);
      }
      saveLayout();
    }
    paintDetail(state.stakeDetail ?? 1);

    // drag to rearrange (the rest of the layout re-optimises around the
    // pinned node); a click without real movement opens the group's slide
    const mapRect = () => map.getBoundingClientRect();
    map.querySelectorAll(".stake-node").forEach((el) => {
      const n = nodes.find((x) => x.id === el.dataset.id);
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { el.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
        const sx = e.clientX, sy = e.clientY;
        let moved = false;
        let lastX = n.x, lastY = n.y; // the furthest legal spot so far
        const move = (ev) => {
          if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
          if (!moved && (state.stakeDetail ?? 1) < 1) {
            // rearranging is an act on the full arrangement: snap to full
            // detail so the drag edits the drawing every rung derives from
            state.stakeDetail = 1;
            const sl = document.getElementById("stake-detail");
            if (sl) sl.value = 1;
            paintDetail(1);
          }
          moved = true;
          const r = mapRect();
          pinned = n;
          const tx = ev.clientX - r.left, ty = ev.clientY - r.top;
          n.x = tx; n.y = ty;
          // The certified crossing count is a property of the drawing, not
          // just of how it was first laid out: rearranging by hand may not
          // spend it either. The card tracks the cursor until the move would
          // cross an edge, then stops at the boundary — bisecting toward the
          // cursor so it slides along the obstacle rather than sticking.
          if (certified && nodeCrosses(n)) {
            let lo = 0, hi = 1;
            for (let k = 0; k < 12; k++) {
              const mid = (lo + hi) / 2;
              n.x = lastX + (tx - lastX) * mid;
              n.y = lastY + (ty - lastY) * mid;
              if (nodeCrosses(n)) hi = mid; else lo = mid;
            }
            n.x = lastX + (tx - lastX) * lo;
            n.y = lastY + (ty - lastY) * lo;
          }
          lastX = n.x; lastY = n.y;
          settle(4); // others dodge the dragged card; no global reflow
          render();
        };
        const up = () => {
          el.removeEventListener("pointermove", move);
          el.removeEventListener("pointerup", up);
          if (!moved) { showSlide("stakeholders", el.dataset.id); return; }
          pinned = null;
          settle(30); // resolve overlaps but keep the user's arrangement
          render();
          saveLayout(); // a searched-for card mustn't undo where you put things
        };
        el.addEventListener("pointermove", move);
        el.addEventListener("pointerup", up);
      });
    });
  }

  // A re-render blows the size-keyed layout cache, so every intermediate width
  // during a window drag pays for a full crossing-guarded solve and ladder
  // rebuild. Only the size the presenter lands on should. The connector keeps
  // up meanwhile through its own ResizeObserver.
  let stakeResizeT = null;
  window.addEventListener("resize", () => {
    if (state.active !== "stakeholders") return;
    clearTimeout(stakeResizeT);
    stakeResizeT = setTimeout(() => {
      stakeResizeT = null;
      if (state.active === "stakeholders") renderStakeholders();
    }, 150);
  });

  /* ---------- drag & drop ingestion ----------
     The published demo has no server: JSON files (or a whole data folder)
     dropped anywhere on the page are recognised by their content and merged
     in. Loaded data persists in localStorage across reloads. */

  function classify(obj) {
    if (!obj || typeof obj !== "object") return null;
    if (Array.isArray(obj.transcripts)) return { kind: "session" };
    if (obj.transcript && Array.isArray(obj.items)) return { kind: "popcorn", tid: obj.transcript };
    if (Array.isArray(obj.quotes)) return { kind: "quotes" };
    if (Array.isArray(obj.themes)) return { kind: "recommendations" };
    if (Array.isArray(obj.tensions)) return { kind: "tensions" };
    if (Array.isArray(obj.stakeholders)) return { kind: "stakeholders" };
    // a custom slide names itself, so dropping one is enough to make its tab
    if (typeof obj.custom === "string" && Array.isArray(obj.items)) return { kind: obj.custom, custom: true, label: obj.label };
    return null;
  }

  function ingestObject(obj) {
    const c = classify(obj);
    if (!c) return false;
    if (c.kind === "session") {
      state.session = obj;
      state.dropped.add("session");
      applySession();
    } else if (c.kind === "popcorn") {
      state.popcorn.set(c.tid, obj);
      state.dropped.add(`popcorn:${c.tid}`);
    } else if (c.custom) {
      if (!registerCustom(c.kind, c.label)) return false;
      const s = SLIDES.find((x) => x.id === c.kind);
      s._raw = JSON.stringify(obj);
      state.slides.set(c.kind, obj);
      state.dropped.add(c.kind);
    } else {
      const s = SLIDES.find((x) => x.id === c.kind);
      if (!s) return false;
      s._raw = JSON.stringify(obj);
      state.slides.set(c.kind, obj);
      state.dropped.add(c.kind);
    }
    return true;
  }

  function persistLocal() {
    try {
      localStorage.setItem("popcorn-data", JSON.stringify({
        session: state.session,
        slides: Object.fromEntries(state.slides),
        popcorn: Object.fromEntries(state.popcorn),
        dropped: [...state.dropped],
      }));
      document.getElementById("reset-data").hidden = false;
    } catch { /* storage unavailable: drops still work for this page view */ }
  }

  function restoreLocal() {
    try {
      const raw = localStorage.getItem("popcorn-data");
      if (!raw) return;
      const d = JSON.parse(raw);
      if (d.session) { state.session = d.session; applySession(); }
      for (const [k, v] of Object.entries(d.slides || {})) {
        state.slides.set(k, v);
        if (typeof v?.custom === "string") registerCustom(v.custom, v.label);
        const s = SLIDES.find((x) => x.id === k);
        if (s) s._raw = JSON.stringify(v);
      }
      for (const [k, v] of Object.entries(d.popcorn || {})) state.popcorn.set(k, v);
      for (const k of d.dropped || []) state.dropped.add(k);
      document.getElementById("reset-data").hidden = false;
    } catch { /* corrupt store: ignore */ }
  }

  document.getElementById("reset-data").addEventListener("click", () => {
    try { localStorage.removeItem("popcorn-data"); } catch {}
    location.reload();
  });

  async function filesFromDataTransfer(dt) {
    const out = [];
    const walkEntry = (entry) => new Promise((resolve) => {
      if (entry.isFile) {
        entry.file((f) => { out.push(f); resolve(); }, () => resolve());
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => reader.readEntries(async (entries) => {
          if (!entries.length) return resolve();
          for (const e of entries) await walkEntry(e);
          readBatch();
        }, () => resolve());
        readBatch();
      } else resolve();
    });
    const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) { for (const e of entries) await walkEntry(e); }
    else out.push(...dt.files);
    return out;
  }

  // Dropping raw transcripts only means anything when something is there to
  // cook them: the published build has no server and quietly ignores them.
  async function serverPresent() {
    try {
      const r = await fetch("api/health", { cache: "no-store" });
      return r.ok;
    } catch { return false; }
  }

  async function sendTranscripts(files) {
    const zip = files.find((f) => f.name.toLowerCase().endsWith(".zip"));
    let body, headers;
    if (zip) {
      body = await zip.arrayBuffer();
      headers = { "Content-Type": "application/zip" };
    } else {
      const texts = [];
      for (const f of files) texts.push({ name: f.name, text: await f.text() });
      body = JSON.stringify({ files: texts });
      headers = { "Content-Type": "application/json" };
    }
    const res = await fetch("api/ingest", { method: "POST", headers, body });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || `ingest failed (${res.status})`);
    return out;
  }

  async function handleDroppedFiles(files) {
    const transcripts = files.filter((f) => /\.(zip|md|txt)$/i.test(f.name));
    if (transcripts.length && await serverPresent()) {
      dropVeil.querySelector("p").textContent = "starting…";
      dropVeil.classList.add("show");
      try {
        await sendTranscripts(transcripts);
        // Dropped state pins slides against the poll loop, so a fresh batch
        // starts from a clean page rather than fighting the last one.
        try { localStorage.removeItem("popcorn-data"); } catch {}
        location.reload();
        return;
      } catch (err) {
        dropVeil.querySelector("p").textContent = String(err.message || err);
        setTimeout(() => {
          dropVeil.classList.remove("show");
          dropVeil.querySelector("p").textContent = "drop transcripts or JSON";
        }, 3000);
        return;
      }
    }
    let loaded = 0;
    for (const f of files) {
      if (!f.name.endsWith(".json")) continue;
      try { if (ingestObject(JSON.parse(await f.text()))) loaded++; } catch { /* not JSON we know */ }
    }
    if (!loaded) return;
    persistLocal();
    renderTabs();
    renderProgress();
    if (state.active === "popcorn") renderPopTail();
    renderActive();
  }

  const dropVeil = document.createElement("div");
  dropVeil.className = "drop-veil";
  dropVeil.innerHTML = `<p>drop transcripts or JSON</p>`;
  document.body.appendChild(dropVeil);
  let dragDepth = 0;
  if (!EMBED) {
    window.addEventListener("dragenter", (e) => { e.preventDefault(); if (++dragDepth === 1) dropVeil.classList.add("show"); });
    window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; dropVeil.classList.remove("show"); } });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      dragDepth = 0;
      dropVeil.classList.remove("show");
      handleDroppedFiles(await filesFromDataTransfer(e.dataTransfer));
    });
  }

  /* ---------- boot ---------- */

  if (!EMBED) restoreLocal();
  loadAll().then(() => {
    const { slide, sub } = parseHash();
    if (slide) showSlide(slide, sub, { replace: true });
  });
  setInterval(loadAll, POLL_MS);
  setInterval(popTick, 300);
})();
