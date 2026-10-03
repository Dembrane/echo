// The rendered half of the design-grammar checks (the static half is
// scripts/check-grammar.mjs). grammarAudit runs inside the page through
// page.evaluate, so it must stay self-contained: no imports, no closures over
// module scope. Every finding is named by its rule id.

export type Finding = { rule: string; target: string; detail: string };
export type AuditResult = {
	hard: Finding[];
	soft: Finding[];
	/** Findings per rule before the per-rule cap. */
	counts: Record<string, number>;
};
export type AuditOptions = { phone: boolean; portal: boolean };

export function grammarAudit(opts: AuditOptions): AuditResult {
	const PER_RULE = 25;
	const hard: Finding[] = [];
	const soft: Finding[] = [];
	const counts: Record<string, number> = {};

	// ---------- tokens ----------
	const WHITE = "rgb(255, 255, 255)";
	const FIELD_LINE = "rgb(135, 135, 133)"; // #878785
	const LINE_COLOURS = new Set([
		"rgb(230, 227, 223)", // #e6e3df faint rule
		FIELD_LINE,
		"rgb(41, 87, 223)", // #2957df active
		"rgb(192, 67, 78)", // #c0434e error
		"rgba(0, 0, 0, 0)",
	]);
	const WEIGHTS = new Set([240, 320, 600]);
	const LADDER = [14, 16, 18.66, 24.88, 33.17, 44.2];
	const ladder = opts.portal
		? [...LADDER, ...LADDER.map((s) => s * 0.9)]
		: LADDER;
	// Round things the grammar allows: the primary pill, avatars, the radio and
	// its dot, the switch thumb, loaders. Anything roughly square with a
	// radius of half its side is a dot and is allowed too (rule below).
	const RADIUS_ALLOW = [
		'.mantine-Button-root[data-variant="filled"]',
		'.mantine-Button-root[data-variant="filled"] *',
		".mantine-Avatar-root",
		".mantine-Avatar-root *",
		".mantine-Radio-radio",
		".mantine-Radio-icon",
		".mantine-Switch-thumb",
		".mantine-Loader-root",
		".mantine-Loader-root *",
		".mantine-Slider-thumb",
		".mantine-ColorSwatch-root",
		".mantine-Indicator-indicator",
		"svg *",
	];
	// Icons drawn larger on purpose (illustrations, empty states).
	const ICON_ALLOW = ["[data-illustration] svg", ".app-illustration svg"];
	// Markdown prose sizes are a follow-up (canon: out of scope).
	const PROSE = ".prose, .mdxeditor, [data-markdown]";
	const SEPARATORS =
		"h1, h2, h3, h4, h5, h6, .mantine-Title-root, .mantine-Divider-root, hr, legend, [role=separator]";
	const MODALS =
		".mantine-Modal-root, .mantine-Drawer-root, [role=dialog], .mantine-Popover-dropdown, .mantine-Menu-dropdown";

	// ---------- helpers ----------
	const target = (el: Element): string => {
		const tag = el.tagName.toLowerCase();
		const tid = el.getAttribute("data-testid");
		const cls = [...el.classList]
			.filter((c) => c.startsWith("mantine-") || c.startsWith("app-"))
			.slice(0, 2)
			.map((c) => `.${c}`)
			.join("");
		const text = (el.textContent ?? "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 40);
		return `${tag}${tid ? `[data-testid=${tid}]` : ""}${cls}${text ? ` "${text}"` : ""}`;
	};
	const add = (
		list: Finding[],
		rule: string,
		el: Element | null,
		detail: string,
	) => {
		counts[rule] = (counts[rule] ?? 0) + 1;
		if (counts[rule] > PER_RULE) return;
		list.push({ detail, rule, target: el ? target(el) : "document" });
	};
	const fail = (rule: string, el: Element | null, detail: string) =>
		add(hard, rule, el, detail);
	const warn = (rule: string, el: Element | null, detail: string) =>
		add(soft, rule, el, detail);
	const visible = (el: Element): boolean => {
		const r = el.getBoundingClientRect();
		if (r.width === 0 && r.height === 0) return false;
		const anyEl = el as Element & {
			checkVisibility?: (o: Record<string, boolean>) => boolean;
		};
		if (anyEl.checkVisibility)
			return anyEl.checkVisibility({
				opacityProperty: true,
				visibilityProperty: true,
			});
		const cs = getComputedStyle(el);
		return cs.visibility !== "hidden" && cs.display !== "none";
	};
	const all = (sel: string): Element[] =>
		[...document.querySelectorAll(sel)].filter(visible);
	const px = (v: string) => Number.parseFloat(v) || 0;
	const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
	const borders = (el: Element) => {
		const cs = getComputedStyle(el);
		return {
			bottom: px(cs.borderBottomWidth),
			colours: {
				bottom: cs.borderBottomColor,
				left: cs.borderLeftColor,
				right: cs.borderRightColor,
				top: cs.borderTopColor,
			},
			left: px(cs.borderLeftWidth),
			right: px(cs.borderRightWidth),
			top: px(cs.borderTopWidth),
		};
	};
	const shape = (b: ReturnType<typeof borders>) =>
		`top ${b.top} right ${b.right} bottom ${b.bottom} left ${b.left}`;
	const inMapDark = (el: Element) => Boolean(el.closest("[data-map-dark]"));
	const lineChecked = new Set<Element>();
	const checkLines = (el: Element) => {
		if (inMapDark(el) || lineChecked.has(el)) return;
		lineChecked.add(el);
		const b = borders(el);
		for (const side of ["top", "right", "bottom", "left"] as const) {
			if (b[side] > 0 && !LINE_COLOURS.has(b.colours[side]))
				fail("grammar.line-colour", el, `${side} border is ${b.colours[side]}`);
		}
	};

	// ---------- border grammar ----------
	// Read: a rule above and below.
	for (const el of all(
		".mantine-Paper-root[data-with-border], .mantine-Card-root[data-with-border]",
	)) {
		if (
			el.matches(
				".app-do, a, button, [role=button], .mantine-Menu-dropdown, .mantine-Combobox-dropdown",
			)
		)
			continue;
		if (inMapDark(el)) continue;
		const b = borders(el);
		if (!(near(b.top, 1) && near(b.bottom, 1) && b.left === 0 && b.right === 0))
			fail(
				"grammar.read",
				el,
				`a card reads between two rules; got ${shape(b)}`,
			);
		checkLines(el);
	}
	// Set: sides only, on white.
	for (const el of all('.mantine-Input-input:not([data-variant="unstyled"])')) {
		if (inMapDark(el)) continue;
		const b = borders(el);
		if (!(near(b.left, 1) && near(b.right, 1) && b.top === 0 && b.bottom === 0))
			fail("grammar.set", el, `a field has side rules only; got ${shape(b)}`);
		const bg = getComputedStyle(el).backgroundColor;
		if (bg !== WHITE) fail("grammar.set", el, `a field is white; got ${bg}`);
		checkLines(el);
	}
	// Do: the full box.
	for (const el of all(
		'.mantine-Button-root[data-variant="outline"], .mantine-Button-root[data-variant="default"], .app-do',
	)) {
		if (inMapDark(el)) continue;
		const b = borders(el);
		if (![b.top, b.right, b.bottom, b.left].every((w) => near(w, 1)))
			fail(
				"grammar.do",
				el,
				`something you press has the full box; got ${shape(b)}`,
			);
		checkLines(el);
	}
	// Context: no border.
	for (const el of all(".mantine-Badge-root")) {
		if (el.matches("a, button, [role=button]")) continue;
		const b = borders(el);
		if (b.top + b.right + b.bottom + b.left > 0)
			fail("grammar.context", el, `a tag has no border; got ${shape(b)}`);
	}

	// ---------- shape ----------
	for (const el of document.body.querySelectorAll("*")) {
		const cs = getComputedStyle(el);
		const corners = [
			cs.borderTopLeftRadius,
			cs.borderTopRightRadius,
			cs.borderBottomRightRadius,
			cs.borderBottomLeftRadius,
		];
		if (corners.every((c) => px(c) === 0)) continue;
		if (!visible(el) || inMapDark(el)) continue;
		if (RADIUS_ALLOW.some((s) => el.matches(s))) continue;
		const r = el.getBoundingClientRect();
		const maxR = Math.max(...corners.map(px));
		const dot =
			Math.abs(r.width - r.height) <= 2 &&
			(maxR >= Math.min(r.width, r.height) / 2 - 0.5 ||
				corners.every((c) => c === "50%"));
		if (dot) continue;
		fail("shape.radius", el, `border-radius ${cs.borderRadius}`);
	}

	// ---------- type ----------
	for (const el of document.body.querySelectorAll("*")) {
		const hasText = [...el.childNodes].some(
			(n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim(),
		);
		if (
			!hasText ||
			el.closest("svg") ||
			["SCRIPT", "STYLE", "NOSCRIPT"].includes(el.tagName)
		)
			continue;
		if (!visible(el)) continue;
		const cs = getComputedStyle(el);
		const w = Number.parseFloat(cs.fontWeight);
		if (!WEIGHTS.has(w))
			fail("type.weight", el, `font-weight ${cs.fontWeight}`);
		if (!el.closest(PROSE)) {
			const fs = px(cs.fontSize);
			if (fs < 14 - 0.1)
				fail(
					"type.size",
					el,
					`font-size ${cs.fontSize} is under the 14px floor`,
				);
			else if (!ladder.some((s) => near(fs, s, 0.1)))
				fail(
					"type.size",
					el,
					`font-size ${cs.fontSize} is off the ladder (14/16/18.66/24.88/33.17/44.2)`,
				);
		}
		if (cs.textTransform !== "none")
			fail("type.transform", el, `text-transform ${cs.textTransform}`);
		if (cs.letterSpacing !== "normal" && px(cs.letterSpacing) !== 0)
			fail("type.tracking", el, `letter-spacing ${cs.letterSpacing}`);
	}

	// ---------- rule 01: controls are white ----------
	const controlLine = (el: Element, what: string) => {
		const b = borders(el);
		for (const side of ["top", "right", "bottom", "left"] as const)
			if (b[side] > 0 && b.colours[side] !== FIELD_LINE)
				fail("rule01", el, `${what} line is ${b.colours[side]}, not #878785`);
	};
	for (const el of all(
		".mantine-Radio-radio:not(:checked):not(:disabled), .mantine-Checkbox-input:not(:checked):not(:disabled):not([data-indeterminate])",
	)) {
		const bg = getComputedStyle(el).backgroundColor;
		if (bg !== WHITE) fail("rule01", el, `an empty choice is white; got ${bg}`);
		if (el !== document.activeElement) controlLine(el, "the control");
	}
	for (const input of document.querySelectorAll(
		".mantine-Switch-input:not(:checked):not(:disabled)",
	)) {
		const track = input.nextElementSibling;
		if (!track?.matches(".mantine-Switch-track") || !visible(track)) continue;
		const bg = getComputedStyle(track).backgroundColor;
		if (bg !== WHITE)
			fail("rule01", track, `an off switch track is white; got ${bg}`);
		controlLine(track, "the switch track");
	}

	// ---------- rule 02: a control's size changes height, never text ----------
	const scale = opts.portal ? [1, 0.9] : [1];
	const controlText = (el: Element, allowed: number[], what: string) => {
		const fs = px(getComputedStyle(el).fontSize);
		if (!allowed.some((a) => scale.some((s) => near(fs, a * s, 0.1))))
			fail(
				"rule02",
				el,
				`${what} text is ${fs}px, not ${allowed.join(" or ")}`,
			);
	};
	for (const el of all(".mantine-Button-root, .mantine-Input-input"))
		controlText(el, [14, 16], "control");
	for (const el of all(".mantine-Badge-root")) controlText(el, [14], "tag");

	// ---------- rule 06: disabled keeps its shape ----------
	for (const el of all(
		".mantine-ActionIcon-root:disabled, .mantine-ActionIcon-root[data-disabled]",
	)) {
		const bg = getComputedStyle(el).backgroundColor;
		if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent")
			fail("rule06", el, `a disabled icon button gains no fill; got ${bg}`);
	}

	// ---------- rule 05: labels hug fields ----------
	const wrappers = all(".mantine-InputWrapper-root");
	for (const w of wrappers) {
		const own = (sel: string) =>
			[...w.querySelectorAll(sel)].find(
				(p) => p.closest(".mantine-InputWrapper-root") === w && visible(p),
			) ?? null;
		const parts = [
			own(".mantine-InputWrapper-label"),
			own(".mantine-InputWrapper-description"),
			own(".mantine-Input-wrapper") ?? own(".mantine-Input-input"),
			own(".mantine-InputWrapper-error"),
		].filter((p): p is Element => p !== null);
		for (let i = 1; i < parts.length; i++) {
			const a = parts[i - 1].getBoundingClientRect();
			const b = parts[i].getBoundingClientRect();
			if (b.top < a.top) continue; // laid out side by side
			const gap = b.top - a.bottom;
			if (Math.abs(gap - 4) > 1)
				fail(
					"rule05",
					parts[i],
					`${parts[i - 1].className.match(/mantine-\w+-\w+/)?.[0]} to this is ${gap.toFixed(1)}px, not 4`,
				);
		}
	}
	// Two things are neighbours when their branches under the lowest common
	// ancestor are consecutive visible siblings with no heading or divider between.
	const branches = (a: Element, b: Element) => {
		let lca: Element | null = a.parentElement;
		while (lca && !lca.contains(b)) lca = lca.parentElement;
		if (!lca) return null;
		const childOf = (x: Element) => {
			let c: Element = x;
			while (c.parentElement !== lca) c = c.parentElement as Element;
			return c;
		};
		return { ca: childOf(a), cb: childOf(b) };
	};
	const neighbours = (a: Element, b: Element) => {
		const br = branches(a, b);
		if (!br) return false;
		let n = br.ca.nextElementSibling;
		while (n && n !== br.cb && !visible(n)) n = n.nextElementSibling;
		if (n !== br.cb) return false;
		return !all(SEPARATORS).some(
			(s) =>
				!a.contains(s) &&
				!b.contains(s) &&
				a.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING &&
				s.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING,
		);
	};
	for (let i = 1; i < wrappers.length; i++) {
		const a = wrappers[i - 1];
		const b = wrappers[i];
		if (a.contains(b) || b.contains(a)) continue;
		const ra = a.getBoundingClientRect();
		const rb = b.getBoundingClientRect();
		if (Math.abs(ra.left - rb.left) > 2 || rb.top < ra.bottom - 1) continue;
		if (!neighbours(a, b)) continue;
		const gap = rb.top - ra.bottom;
		if (Math.abs(gap - 16) > 1)
			fail("rule05", b, `field to field is ${gap.toFixed(1)}px, not 16`);
	}
	const actions = all(
		'button[type="submit"], .mantine-Button-root[data-variant="filled"]',
	).filter((btn) => !btn.closest(".mantine-InputWrapper-root"));
	const seenRows = new Set<string>();
	for (const btn of actions) {
		const before = wrappers.filter(
			(w) =>
				!w.contains(btn) &&
				w.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING,
		);
		const field = before[before.length - 1];
		if (!field || !neighbours(field, btn)) continue;
		const rf = field.getBoundingClientRect();
		const rbtn = btn.getBoundingClientRect();
		if (rbtn.top < rf.bottom - 1) continue;
		const key = `${Math.round(rf.bottom)}:${Math.round(rbtn.top)}`;
		if (seenRows.has(key)) continue;
		seenRows.add(key);
		const gap = rbtn.top - rf.bottom;
		if (Math.abs(gap - 24) > 1)
			fail(
				"rule05",
				btn,
				`last field to its action row is ${gap.toFixed(1)}px, not 24`,
			);
	}

	// ---------- flow ----------
	const filled = all('.mantine-Button-root[data-variant="filled"]');
	const pagePrimaries = filled.filter((b) => !b.closest(MODALS));
	if (pagePrimaries.length > 1)
		fail(
			"flow.one-primary",
			null,
			`${pagePrimaries.length} filled buttons outside dialogs: ${pagePrimaries.map(target).join("; ")}`,
		);
	for (const btn of filled) {
		let box: Element | null = btn.parentElement;
		for (let depth = 0; box && depth < 4; depth++, box = box.parentElement) {
			const cs = getComputedStyle(box);
			if (!cs.display.includes("flex")) continue;
			const kids = [...box.children].filter(
				(k) =>
					visible(k) &&
					(k.matches(".mantine-Button-root") ||
						k.querySelector(".mantine-Button-root")),
			);
			if (kids.length < 2) continue;
			const mine = kids.find((k) => k === btn || k.contains(btn)) as Element;
			const column = cs.flexDirection.startsWith("column");
			const pos = (k: Element) =>
				column ? k.getBoundingClientRect().top : k.getBoundingClientRect().left;
			if (kids.some((k) => k !== mine && pos(k) < pos(mine) - 1))
				fail(
					"flow.primary-first",
					btn,
					`the filled button is not ${column ? "top" : "leftmost"} in its row`,
				);
			break;
		}
	}

	// ---------- icons ----------
	for (const svg of all('svg[viewBox="0 0 256 256"]')) {
		if (ICON_ALLOW.some((s) => svg.matches(s))) continue;
		const w = Math.round(svg.getBoundingClientRect().width);
		if (w !== 16 && w !== 20)
			fail(
				"icon.size",
				svg.parentElement ?? svg,
				`icon is ${w}px, not 16 or 20`,
			);
	}

	// ---------- rule 04: narrow widths drop words, never wrap structure ----------
	if (opts.phone) {
		const doc = document.documentElement;
		if (doc.scrollWidth > doc.clientWidth + 1) {
			const wide = [...document.body.querySelectorAll("*")]
				.filter(
					(el) =>
						visible(el) &&
						el.getBoundingClientRect().right > doc.clientWidth + 1,
				)
				.filter(
					(el) =>
						![...el.children].some(
							(c) => c.getBoundingClientRect().right > doc.clientWidth + 1,
						),
				)
				.slice(0, 5);
			fail(
				"rule04",
				null,
				`the page scrolls sideways (${doc.scrollWidth} > ${doc.clientWidth}); widest: ${wide.map(target).join("; ")}`,
			);
		}
		for (const steps of all(".mantine-Stepper-steps")) {
			const tops = all(".mantine-Stepper-step")
				.filter((s) => steps.contains(s))
				.map((s) => Math.round(s.getBoundingClientRect().top));
			if (tops.length && Math.max(...tops) - Math.min(...tops) > 2)
				fail("rule04", steps, "Stepper steps wrap onto more than one line");
		}
		for (const group of all(".app-joined")) {
			if (getComputedStyle(group).flexDirection.startsWith("column")) continue;
			const tops = [...group.children]
				.filter(visible)
				.map((c) => Math.round(c.getBoundingClientRect().top));
			if (tops.length > 1 && Math.max(...tops) - Math.min(...tops) > 2)
				fail(
					"rule04",
					group,
					"a joined row breaks part-way instead of stacking as a whole",
				);
		}
		for (const el of document.body.querySelectorAll("*")) {
			const cs = getComputedStyle(el);
			if (cs.textOverflow !== "ellipsis" || !visible(el)) continue;
			const h = el as HTMLElement;
			if (h.scrollWidth > h.clientWidth && h.clientWidth < 48)
				warn("rule04.truncated", el, `text cut to ${h.clientWidth}px`);
		}
	}

	return { counts, hard, soft };
}
