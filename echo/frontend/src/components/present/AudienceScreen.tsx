import { i18n } from "@lingui/core";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Loader, Tabs, Text, Tooltip } from "@mantine/core";
import {
	ArrowsInIcon,
	ArrowsOutIcon,
	MoonIcon,
	PauseIcon,
	PlayIcon,
	QrCodeIcon,
	SunIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { QRCode } from "@/components/common/QRCode";
import type { PopcornSettingsPatch } from "@/components/popcorn/hooks";
import { SUPPORTED_LANGUAGES } from "@/config";
import { useServerEvents } from "@/hooks/useServerEvents";
import { cn } from "@/lib/utils";
import { AudienceMapAdapter } from "./AudienceMapAdapter";
import classes from "./AudienceScreen.module.css";
import {
	AUDIENCE_EVENT_REFRESH_MS,
	AUDIENCE_SAFETY_REFRESH_MS,
	audienceUrls,
	type DeckChromeMessage,
	deckBlockCommand,
	deckOpeningCommand,
	deckThemeCommand,
	deckVisibilityCommand,
	isDeckChromeEvent,
	isDeckEditEvent,
	isDeckOpeningEvent,
	isDeckReadyEvent,
	postDeckMessage,
} from "./audienceContract";
import type { PresentationBlock as AudienceBlock } from "./blocks";
import { useAudience } from "./hooks/useAudience";
import { type AudienceTheme, useAudienceTheme } from "./hooks/useAudienceTheme";

export type AudienceScreenProps = {
	presentationId?: string;
	publicToken?: string;
	embedded?: boolean;
	draft?: boolean;
	draftRevision?: number;
	/**
	 * The page around an embedded preview already follows this presentation's
	 * event stream; each event it receives raises this number. With it set the
	 * shell opens no stream of its own.
	 */
	eventTick?: number;
	/**
	 * A host who may edit types straight into the opening's words on the slide.
	 * Given, the deck makes those words editable and each finished edit arrives
	 * here as the settings patch the presentation editor would have sent; a
	 * rejected promise puts the old words back. The room's public link never
	 * edits, whatever is passed.
	 */
	onEditOpening?: (patch: PopcornSettingsPatch) => Promise<unknown>;
	/** Told the presentation's interface language once it is known. */
	onLanguage?: (code: string) => void;
	className?: string;
};

const AUDIENCE_COPY: Record<
	string,
	{
		blocks: Record<AudienceBlock, string>;
		waiting: string;
		pause: string;
		play: string;
		fullscreen: string;
		darkScreen: string;
		lightScreen: string;
		intro: string;
		dataPolicy: string;
	}
> = {
	cs: {
		blocks: {
			map: "Mapa",
			popcorn: "Popcorn",
			stakeholders: "Zainteresované strany",
			tensions: "Napětí",
		},
		darkScreen: "Tmavá obrazovka",
		dataPolicy: "Zásady pro data",
		fullscreen: "Celá obrazovka",
		intro: "Úvod",
		lightScreen: "Světlá obrazovka",
		pause: "Pozastavit",
		play: "Přehrát",
		waiting: "Výsledky se připravují.",
	},
	de: {
		blocks: {
			map: "Karte",
			popcorn: "Popcorn",
			stakeholders: "Interessengruppen",
			tensions: "Spannungsfelder",
		},
		darkScreen: "Dunkler Bildschirm",
		dataPolicy: "Datenrichtlinie",
		fullscreen: "Vollbild",
		intro: "Einführung",
		lightScreen: "Heller Bildschirm",
		pause: "Pause",
		play: "Abspielen",
		waiting: "Die Ergebnisse werden vorbereitet.",
	},
	en: {
		blocks: {
			map: "Map",
			popcorn: "Popcorn",
			stakeholders: "Stakeholders",
			tensions: "Tensions",
		},
		darkScreen: "Dark screen",
		dataPolicy: "Data policy",
		fullscreen: "Fullscreen",
		intro: "Introduction",
		lightScreen: "Light screen",
		pause: "Pause",
		play: "Play",
		waiting: "The results are being prepared.",
	},
	es: {
		blocks: {
			map: "Mapa",
			popcorn: "Popcorn",
			stakeholders: "Grupos de interés",
			tensions: "Tensiones",
		},
		darkScreen: "Pantalla oscura",
		dataPolicy: "Política de datos",
		fullscreen: "Pantalla completa",
		intro: "Introducción",
		lightScreen: "Pantalla clara",
		pause: "Pausar",
		play: "Reproducir",
		waiting: "Los resultados se están preparando.",
	},
	fr: {
		blocks: {
			map: "Carte",
			popcorn: "Popcorn",
			stakeholders: "Parties prenantes",
			tensions: "Tensions",
		},
		darkScreen: "Écran sombre",
		dataPolicy: "Politique des données",
		fullscreen: "Plein écran",
		intro: "Introduction",
		lightScreen: "Écran clair",
		pause: "Pause",
		play: "Lire",
		waiting: "Les résultats sont en cours de préparation.",
	},
	it: {
		blocks: {
			map: "Mappa",
			popcorn: "Popcorn",
			stakeholders: "Portatori di interesse",
			tensions: "Tensioni",
		},
		darkScreen: "Schermo scuro",
		dataPolicy: "Politica sui dati",
		fullscreen: "Schermo intero",
		intro: "Introduzione",
		lightScreen: "Schermo chiaro",
		pause: "Pausa",
		play: "Riprendi",
		waiting: "I risultati sono in preparazione.",
	},
	nl: {
		blocks: {
			map: "Kaart",
			popcorn: "Popcorn",
			stakeholders: "Belanghebbenden",
			tensions: "Spanningen",
		},
		darkScreen: "Donker scherm",
		dataPolicy: "Databeleid",
		fullscreen: "Volledig scherm",
		intro: "Introductie",
		lightScreen: "Licht scherm",
		pause: "Pauzeren",
		play: "Afspelen",
		waiting: "De resultaten worden voorbereid.",
	},
	uk: {
		blocks: {
			map: "Карта",
			popcorn: "Popcorn",
			stakeholders: "Зацікавлені сторони",
			tensions: "Суперечності",
		},
		darkScreen: "Темний екран",
		dataPolicy: "Політика даних",
		fullscreen: "На весь екран",
		intro: "Вступ",
		lightScreen: "Світлий екран",
		pause: "Пауза",
		play: "Відтворити",
		waiting: "Результати готуються.",
	},
};

const AudienceBranding = ({ copy }: { copy: string }) => {
	const wordmark = "dembrane";
	const index = copy.lastIndexOf(wordmark);
	if (index < 0) return copy;
	return (
		<>
			{copy.slice(0, index)}
			<span className={classes.wordmark}>{wordmark}</span>
			{copy.slice(index + wordmark.length)}
		</>
	);
};

export const AudienceScreen = ({
	presentationId,
	publicToken,
	embedded = false,
	draft = false,
	draftRevision = 0,
	eventTick,
	onEditOpening,
	onLanguage,
	className,
}: AudienceScreenProps) => {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const shellRef = useRef<HTMLDivElement>(null);
	const eventRefreshTimerRef = useRef<ReturnType<
		typeof globalThis.setTimeout
	> | null>(null);
	const deckReadyRef = useRef(false);
	const pendingDeckRefreshRef = useRef(false);
	const [activeBlock, setActiveBlock] = useState<AudienceBlock | null>(null);
	const [eventRevision, setEventRevision] = useState(0);
	const [playbackPaused, setPlaybackPaused] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [fullscreenError, setFullscreenError] = useState(false);
	const [openingOpen, setOpeningOpen] = useState(false);
	const [openingLocked, setOpeningLocked] = useState(false);
	const [openingScreen, setOpeningScreen] = useState<"intro" | "data" | null>(
		null,
	);
	const [deckChrome, setDeckChrome] = useState<{
		live: boolean;
		madeWith: string;
		progress: string;
		qrFold: string;
		qrLabel: string;
		qrShow: string;
	} | null>(null);
	const [qrMinimized, setQrMinimized] = useState(embedded);
	const qrToggleLabel =
		(qrMinimized ? deckChrome?.qrShow : deckChrome?.qrFold) || "QR";
	// The room's own switch, in the footer beside play and fullscreen. It is
	// known before any data loads, so every state of this screen is lit by it.
	const [theme, setTheme] = useAudienceTheme();
	const dark = theme === "dark";
	const darkTheme = dark ? "dark" : undefined;
	const openingPresentationRef = useRef<string | null>(null);
	useEffect(() => {
		const changed = () =>
			setFullscreen(document.fullscreenElement === shellRef.current);
		document.addEventListener("fullscreenchange", changed);
		return () => document.removeEventListener("fullscreenchange", changed);
	}, []);
	const toggleFullscreen = async () => {
		try {
			setFullscreenError(false);
			if (document.fullscreenElement === shellRef.current)
				await document.exitFullscreen();
			else await shellRef.current?.requestFullscreen();
		} catch {
			setFullscreenError(true);
		}
	};

	const urls = useMemo(
		() => audienceUrls({ draft, presentationId, publicToken }),
		[presentationId, publicToken, draft],
	);
	// "gone": the link was switched off or access withdrawn. "failed": nothing
	// has loaded yet and the read keeps being retried.
	const { audience, error, reload } = useAudience(
		urls?.audience ?? null,
		draftRevision,
	);
	const reloadAudience = useCallback(() => void reload(), [reload]);
	// A reload keeps the block on screen when the presentation still has it.
	useEffect(() => {
		setActiveBlock((current) =>
			!audience
				? null
				: current && audience.manifest.blocks.includes(current)
					? current
					: audience.manifest.opening,
		);
	}, [audience]);
	// The theme this presentation's deck was mounted with. It only spares a dark
	// room a light first paint: a later flip is told over the bridge, and must
	// not change this address (that would reload the deck).
	const mountedThemeRef = useRef<{ id: string; dark: boolean } | null>(null);
	const deckSrc = useMemo(() => {
		if (!urls || !audience) return null;
		if (mountedThemeRef.current?.id !== audience.id) {
			mountedThemeRef.current = { dark, id: audience.id };
		}
		const query = new URLSearchParams({
			embedded: "1",
			presentationId: audience.id,
			...(embedded ? { preview: "1" } : {}),
			...(mountedThemeRef.current.dark ? { theme: "dark" } : {}),
		});
		return `${urls.deck}?${query}`;
	}, [audience, urls, embedded, dark]);
	const deckOrigin = useMemo(
		() =>
			urls
				? new URL(urls.deck, globalThis.location.origin).origin
				: globalThis.location.origin,
		[urls],
	);
	const audienceId = audience?.id ?? null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new iframe source has not completed the verified ready handshake.
	useEffect(() => {
		deckReadyRef.current = false;
		setDeckChrome(null);
	}, [deckSrc]);

	// Typing happens inside the deck's own page, so no key handler of this
	// shell hears it. The deck only offers it when told to here, after every
	// ready (a reloaded deck starts plain), and never saves anything itself.
	const canEditOpening = Boolean(onEditOpening) && !publicToken;
	const onEditOpeningRef = useRef(onEditOpening);
	onEditOpeningRef.current = onEditOpening;
	useEffect(() => {
		if (!audienceId) return;
		const expected = () => ({
			origin: deckOrigin,
			presentationId: audienceId,
			source: iframeRef.current?.contentWindow ?? null,
		});
		const shell = {
			presentationId: audienceId,
			source: "dembrane-present-shell",
			version: 1,
		} as const;
		const deckWindow = () => iframeRef.current?.contentWindow ?? null;
		// A deck is plain until told otherwise, so a viewer's deck hears nothing.
		if (!canEditOpening) return;
		const tell = (editable = true) =>
			postDeckMessage(deckWindow(), deckOrigin, {
				...shell,
				command: "editing",
				editable,
			});
		tell();
		const handleDeckEdit = (event: MessageEvent) => {
			if (!isDeckEditEvent(event, expected())) {
				if (isDeckReadyEvent(event, expected())) tell();
				return;
			}
			const { field, value } = event.data;
			const [block, key] = field.split(".");
			const patch = { [block]: { [key]: value } } as PopcornSettingsPatch;
			(async () => onEditOpeningRef.current?.(patch))().catch(() =>
				postDeckMessage(deckWindow(), deckOrigin, {
					...shell,
					command: "edit-rejected",
					field,
				}),
			);
		};
		globalThis.addEventListener("message", handleDeckEdit);
		return () => {
			globalThis.removeEventListener("message", handleDeckEdit);
			tell(false);
		};
	}, [audienceId, canEditOpening, deckOrigin]);

	const requestDeckRefresh = useCallback(() => {
		pendingDeckRefreshRef.current = true;
		if (!deckReadyRef.current || !audienceId) return;
		pendingDeckRefreshRef.current = false;
		postDeckMessage(iframeRef.current?.contentWindow ?? null, deckOrigin, {
			command: "refresh",
			presentationId: audienceId,
			source: "dembrane-present-shell",
			version: 1,
		});
	}, [audienceId, deckOrigin]);

	const scheduleEventRefresh = useCallback(() => {
		requestDeckRefresh();
		if (eventRefreshTimerRef.current !== null) return;
		eventRefreshTimerRef.current = globalThis.setTimeout(() => {
			eventRefreshTimerRef.current = null;
			setEventRevision((current) => current + 1);
			reloadAudience();
		}, AUDIENCE_EVENT_REFRESH_MS);
	}, [reloadAudience, requestDeckRefresh]);

	useEffect(
		() => () => {
			if (eventRefreshTimerRef.current !== null) {
				globalThis.clearTimeout(eventRefreshTimerRef.current);
			}
		},
		[],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: discard delayed work from the previous presentation event stream.
	useEffect(() => {
		if (eventRefreshTimerRef.current !== null) {
			globalThis.clearTimeout(eventRefreshTimerRef.current);
			eventRefreshTimerRef.current = null;
		}
		pendingDeckRefreshRef.current = false;
	}, [urls?.events]);

	// The server ends a stream whose access was withdrawn, and the browser
	// cannot tell that from a network drop. Each drop asks the server instead.
	const handleStreamEvent = useCallback(
		(event: { type: string }) => {
			if (event.type === "disconnected") reloadAudience();
			else scheduleEventRefresh();
		},
		[reloadAudience, scheduleEventRefresh],
	);
	useServerEvents(
		error === "gone" || eventTick !== undefined ? null : (urls?.events ?? null),
		["update", "disconnected"],
		handleStreamEvent,
	);
	const seenEventTick = useRef(eventTick);
	useEffect(() => {
		if (eventTick === seenEventTick.current) return;
		seenEventTick.current = eventTick;
		scheduleEventRefresh();
	}, [eventTick, scheduleEventRefresh]);

	// The same safety read the standalone deck makes: a lost nudge heals here,
	// and a link that was switched back on comes back.
	useEffect(() => {
		const interval = globalThis.setInterval(
			scheduleEventRefresh,
			AUDIENCE_SAFETY_REFRESH_MS,
		);
		return () => globalThis.clearInterval(interval);
	}, [scheduleEventRefresh]);

	useEffect(() => {
		if (!draft || !presentationId || draftRevision === 0) return;
		requestDeckRefresh();
	}, [draft, draftRevision, presentationId, requestDeckRefresh]);
	const audienceCopyAndLanguage = useMemo(() => {
		const session = audience?.bundle.files?.["session.json"] as
			| { language?: unknown; ui_language?: unknown }
			| undefined;
		const language =
			typeof session?.ui_language === "string"
				? session.ui_language
				: typeof session?.language === "string"
					? session.language
					: "en";
		return { copy: AUDIENCE_COPY[language] ?? AUDIENCE_COPY.en, language };
	}, [audience]);
	const audienceLanguage = audience ? audienceCopyAndLanguage.language : null;
	useEffect(() => {
		if (audienceLanguage) onLanguage?.(audienceLanguage);
	}, [audienceLanguage, onLanguage]);
	const audienceCopy = audienceCopyAndLanguage.copy;
	const sessionIdentity = useMemo(() => {
		const session = audience?.bundle.files?.["session.json"] as
			| {
					client?: unknown;
					date?: unknown;
					date_iso?: unknown;
					language?: unknown;
					title?: unknown;
					ui_language?: unknown;
			  }
			| undefined;
		const language =
			typeof session?.ui_language === "string"
				? session.ui_language
				: typeof session?.language === "string"
					? session.language
					: "en";
		let date = typeof session?.date === "string" ? session.date : "";
		if (
			typeof session?.date_iso === "string" &&
			/^\d{4}-\d{2}-\d{2}$/.test(session.date_iso)
		) {
			try {
				const [year, month, day] = session.date_iso.split("-").map(Number);
				date = new Intl.DateTimeFormat(language === "en" ? "en-GB" : language, {
					day: "numeric",
					month: "long",
					timeZone: "UTC",
					year: "numeric",
				}).format(Date.UTC(year, month - 1, day));
			} catch {
				// Keep the server-formatted date when this locale is unavailable.
			}
		}
		return {
			meta: [typeof session?.client === "string" ? session.client : "", date]
				.filter(Boolean)
				.join(" · "),
			title:
				typeof session?.title === "string" && session.title.trim()
					? session.title
					: "popcorn",
		};
	}, [audience]);
	const frameDetails = useMemo(() => {
		const files = audience?.bundle.files ?? {};
		const session = files["session.json"] as
			| {
					branding?: unknown;
					notice?: { text?: unknown };
					qr?: { label?: unknown; url?: unknown };
			  }
			| undefined;
		let qrUrl: string | null = null;
		if (typeof session?.qr?.url === "string") {
			try {
				const parsed = new URL(session.qr.url);
				if (parsed.protocol === "http:" || parsed.protocol === "https:") {
					qrUrl = parsed.href;
				}
			} catch {
				qrUrl = null;
			}
		}
		return {
			branding: session?.branding !== false,
			notice:
				typeof session?.notice?.text === "string"
					? session.notice.text.trim()
					: "",
			qrLabel:
				typeof session?.qr?.label === "string" ? session.qr.label.trim() : "",
			qrUrl,
		};
	}, [audience]);
	const openingAvailability = useMemo(() => {
		const session = audience?.bundle.files?.["session.json"] as
			| {
					data?: unknown;
					disclosure?: {
						invitation_text?: unknown;
						invitation_title?: unknown;
						text?: unknown;
					};
					intro?: { enabled?: unknown };
			  }
			| undefined;
		return {
			data: Boolean(session?.data),
			intro: Boolean(
				session?.intro?.enabled ||
					session?.disclosure?.text ||
					session?.disclosure?.invitation_title ||
					session?.disclosure?.invitation_text,
			),
		};
	}, [audience]);
	useEffect(() => {
		if (!audience || openingPresentationRef.current === audience.id) return;
		openingPresentationRef.current = audience.id;
		const firstOpening = openingAvailability.intro
			? "intro"
			: openingAvailability.data
				? "data"
				: null;
		setOpeningScreen(firstOpening);
		setOpeningOpen(firstOpening !== null);
	}, [audience, openingAvailability]);
	const deckReady = useMemo(() => {
		if (!audience || !activeBlock || activeBlock === "map") return false;
		const files = audience.bundle.files ?? {};
		if (activeBlock === "popcorn") {
			return Boolean(files["session.json"]);
		}
		return Boolean(files[`${activeBlock}.json`]);
	}, [activeBlock, audience]);

	const postDeckCommand = useCallback(
		(
			command: "block" | "visibility" | "opening" | "theme",
			extra: Record<string, unknown>,
		) => {
			if (!audience) return;
			const message =
				command === "visibility"
					? deckVisibilityCommand(audience.id, extra.visible === true)
					: command === "opening"
						? deckOpeningCommand(audience.id, extra.screen as "intro" | "data")
						: command === "theme"
							? deckThemeCommand(audience.id, extra.theme as AudienceTheme)
							: deckBlockCommand(
									audience.id,
									extra.block as Exclude<AudienceBlock, "map">,
								);
			postDeckMessage(
				iframeRef.current?.contentWindow ?? null,
				deckOrigin,
				message,
			);
		},
		[audience, deckOrigin],
	);

	// The deck paints its own page, so it is told which room it is standing in.
	useEffect(() => {
		postDeckCommand("theme", { theme });
	}, [postDeckCommand, theme]);

	useEffect(() => {
		if (!activeBlock) return;
		postDeckCommand("visibility", {
			visible:
				(openingOpen || (activeBlock !== "map" && deckReady)) &&
				!(activeBlock === "popcorn" && playbackPaused),
		});
		if (activeBlock !== "map" && deckReady) {
			postDeckCommand("block", { block: activeBlock });
		}
	}, [activeBlock, deckReady, openingOpen, postDeckCommand, playbackPaused]);

	useEffect(() => {
		if (!audience) return;
		const handleDeckReady = (event: MessageEvent) => {
			if (
				isDeckChromeEvent(event, {
					origin: deckOrigin,
					presentationId: audience.id,
					source: iframeRef.current?.contentWindow ?? null,
				})
			) {
				const message = event.data as DeckChromeMessage;
				setDeckChrome({
					live: message.live,
					madeWith: message.madeWith,
					progress: message.progress,
					qrFold: message.qrFold,
					qrLabel: message.qrLabel,
					qrShow: message.qrShow,
				});
				return;
			}
			if (
				isDeckOpeningEvent(event, {
					origin: deckOrigin,
					presentationId: audience.id,
					source: iframeRef.current?.contentWindow ?? null,
				})
			) {
				setOpeningOpen(event.data.open);
				setOpeningLocked(event.data.open && event.data.locked === true);
				setOpeningScreen(event.data.open ? (event.data.screen ?? null) : null);
				return;
			}
			if (
				!isDeckReadyEvent(event, {
					origin: deckOrigin,
					presentationId: audience.id,
					source: iframeRef.current?.contentWindow ?? null,
				})
			) {
				return;
			}
			deckReadyRef.current = true;
			if (pendingDeckRefreshRef.current) requestDeckRefresh();
			postDeckCommand("visibility", {
				visible:
					(openingOpen || (activeBlock !== "map" && deckReady)) &&
					!(activeBlock === "popcorn" && playbackPaused),
			});
			if (activeBlock && activeBlock !== "map" && deckReady) {
				postDeckCommand("block", { block: activeBlock });
			}
		};
		globalThis.addEventListener("message", handleDeckReady);
		return () => globalThis.removeEventListener("message", handleDeckReady);
	}, [
		activeBlock,
		audience,
		deckOrigin,
		deckReady,
		postDeckCommand,
		playbackPaused,
		openingOpen,
		requestDeckRefresh,
	]);

	const selectBlock = useCallback(
		(block: AudienceBlock) => {
			setActiveBlock(block);
			if (audience)
				postDeckMessage(iframeRef.current?.contentWindow ?? null, deckOrigin, {
					command: "dismiss-opening",
					presentationId: audience.id,
					source: "dembrane-present-shell",
					version: 1,
				});
		},
		[audience, deckOrigin],
	);

	const handleKeyDown = useCallback(
		(event: globalThis.KeyboardEvent) => {
			if (!audience || !activeBlock || openingLocked) return;
			if (
				event.target instanceof Element &&
				event.target.closest("input, textarea, select, [contenteditable=true]")
			)
				return;
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			event.preventDefault();
			const index = audience.manifest.blocks.indexOf(activeBlock);
			const direction = event.key === "ArrowRight" ? 1 : -1;
			const next =
				audience.manifest.blocks[
					(index + direction + audience.manifest.blocks.length) %
						audience.manifest.blocks.length
				];
			selectBlock(next);
		},
		[activeBlock, audience, openingLocked, selectBlock],
	);

	useEffect(() => {
		if (embedded) return;
		globalThis.addEventListener("keydown", handleKeyDown);
		return () => globalThis.removeEventListener("keydown", handleKeyDown);
	}, [embedded, handleKeyDown]);

	// No presentation id and no token: there is nothing to ask the server for.
	if (error || !urls) {
		return (
			<div
				className={cn(
					"flex h-full min-h-[24rem] items-center justify-center p-6",
					classes.state,
				)}
				data-theme={darkTheme}
				role="alert"
			>
				<div className="text-center">
					<Text size="lg">
						{error === "gone" ? (
							<Trans>This presentation is not available.</Trans>
						) : (
							<Trans>This presentation could not be loaded.</Trans>
						)}
					</Text>
					<Text size="sm" c="dimmed" mt="xs">
						{error === "gone" ? (
							<Trans>Its link may have been switched off. Ask the host.</Trans>
						) : error === "failed" ? (
							<Trans>Trying again…</Trans>
						) : null}
					</Text>
				</div>
			</div>
		);
	}

	if (!audience) {
		return (
			<div
				className={cn(
					"flex h-full min-h-[24rem] items-center justify-center",
					classes.state,
				)}
				data-theme={darkTheme}
				aria-live="polite"
			>
				<Loader color="primary" />
			</div>
		);
	}

	if (!deckSrc) return null;

	return (
		<Tabs
			ref={shellRef}
			value={activeBlock ?? "opening"}
			onChange={(value) => {
				if (value) selectBlock(value as AudienceBlock);
			}}
			className={cn(
				"relative flex h-full min-h-[24rem] flex-col",
				classes.shell,
				className,
			)}
			data-opening={openingOpen || undefined}
			data-framed={frameDetails.notice ? true : undefined}
			data-theme={darkTheme}
		>
			{/* The frame goes round the whole screen: its notice is the top edge,
			    above the title and the tabs, and its colour runs down both sides
			    and along the bottom. */}
			{frameDetails.notice && (
				<aside className={classes.notice} data-testid="audience-notice">
					<span>{frameDetails.notice}</span>
					{openingAvailability.intro && (
						<button
							type="button"
							onClick={() => {
								setOpeningOpen(true);
								setOpeningScreen("intro");
								postDeckCommand("opening", { screen: "intro" });
							}}
						>
							{audienceCopy.intro}
						</button>
					)}
				</aside>
			)}
			<header className={classes.chrome}>
				<div className={classes.sessionId}>
					<span className={classes.sessionTitle}>{sessionIdentity.title}</span>
					{sessionIdentity.meta && (
						<span className={classes.sessionMeta}>{sessionIdentity.meta}</span>
					)}
				</div>
				<div className={classes.navigation}>
					{(openingAvailability.intro || openingAvailability.data) && (
						<nav
							className={classes.openingLinks}
							aria-label={t`Opening screens`}
						>
							{openingAvailability.intro && (
								<button
									type="button"
									className={classes.openingTab}
									data-active={
										openingOpen && openingScreen === "intro" ? true : undefined
									}
									aria-current={
										openingOpen && openingScreen === "intro"
											? "page"
											: undefined
									}
									onClick={() => {
										setOpeningOpen(true);
										setOpeningScreen("intro");
										postDeckCommand("opening", { screen: "intro" });
									}}
								>
									{audienceCopy.intro}
								</button>
							)}
							{openingAvailability.data && (
								<button
									type="button"
									className={classes.openingTab}
									data-active={
										openingOpen && openingScreen === "data" ? true : undefined
									}
									aria-current={
										openingOpen && openingScreen === "data" ? "page" : undefined
									}
									onClick={() => {
										setOpeningOpen(true);
										setOpeningScreen("data");
										postDeckCommand("opening", { screen: "data" });
									}}
								>
									{audienceCopy.dataPolicy}
								</button>
							)}
						</nav>
					)}
					<div className={classes.tabs}>
						<Tabs.List
							className={classes.tabList}
							aria-label={t`Presentation activities`}
						>
							{audience.manifest.blocks.map((block) => (
								<Tabs.Tab
									className={classes.tab}
									key={block}
									value={block}
									disabled={openingLocked}
								>
									{audienceCopy.blocks[block]}
								</Tabs.Tab>
							))}
						</Tabs.List>
					</div>
				</div>
			</header>
			<div className={classes.contentFrame}>
				<Tabs.Panel
					value={activeBlock ?? "opening"}
					className="relative min-h-0 flex-1 overflow-hidden"
				>
					<iframe
						ref={iframeRef}
						src={deckSrc}
						title="Presentation"
						className={cn(
							"absolute inset-0 h-full w-full border-0",
							openingOpen && "z-10",
							// Opening copy is read, not glanced at: it sits beside the QR
							// card, never under it. The standalone deck's intro covered
							// its QR; in the shell both are on screen together.
							openingOpen &&
								frameDetails.qrUrl &&
								!qrMinimized &&
								classes.deckBesideQr,
							((activeBlock === "map" && !openingOpen) ||
								(!deckReady && !openingOpen)) &&
								"invisible pointer-events-none",
						)}
						onLoad={() => {
							// A deck that reloaded is told the room again.
							postDeckCommand("theme", { theme });
							postDeckCommand("visibility", {
								visible:
									(openingOpen || (activeBlock !== "map" && deckReady)) &&
									!(activeBlock === "popcorn" && playbackPaused),
							});
							if (activeBlock !== "map" && deckReady) {
								postDeckCommand("block", { block: activeBlock });
							}
						}}
						allow="fullscreen"
					/>
					{activeBlock !== "map" && !deckReady && !openingOpen && (
						<div className="absolute inset-0 flex items-center justify-center p-6">
							<Text size="lg" ta="center" maw={560}>
								{audience.manifest.blocks.length ? (
									audienceCopy.waiting
								) : (
									<Trans>
										No activities are selected for this presentation.
									</Trans>
								)}
							</Text>
						</div>
					)}
					{audience.manifest.blocks.includes("map") && (
						<div
							className={cn(
								"absolute inset-0",
								classes.mapPane,
								(activeBlock !== "map" || openingOpen) && "hidden",
							)}
						>
							<AudienceMapAdapter
								active={activeBlock === "map" && !openingOpen}
								endpoint={urls?.map ?? ""}
								revision={eventRevision + draftRevision}
								theme={theme}
								// A public link is opened without a session, so it never
								// asks for a model-written title. The host's own screen and
								// the preview are behind the session already.
								titles={!publicToken}
								waitingLabel={audienceCopy.waiting}
							/>
						</div>
					)}
				</Tabs.Panel>
				{frameDetails.qrUrl && !qrMinimized && (
					<aside
						className={classes.qrPanel}
						aria-label={frameDetails.qrLabel || deckChrome?.qrLabel || "QR"}
						data-testid="audience-qr"
					>
						<QRCode
							value={frameDetails.qrUrl}
							href={frameDetails.qrUrl}
							aria-label={frameDetails.qrLabel || deckChrome?.qrLabel || "QR"}
							className={classes.qrCode}
							inverted={dark}
						/>
						{(frameDetails.qrLabel || deckChrome?.qrLabel) && (
							<span className={classes.qrLabel}>
								{frameDetails.qrLabel || deckChrome?.qrLabel}
							</span>
						)}
					</aside>
				)}
			</div>
			<footer className={classes.footer} data-testid="audience-frame-footer">
				<div className={classes.progress} aria-live="polite">
					{deckChrome?.progress && (
						<>
							{deckChrome.live && (
								<span className={classes.liveDot} aria-hidden="true" />
							)}
							<span>{deckChrome.progress}</span>
						</>
					)}
				</div>
				<div className={classes.footerEnd}>
					{frameDetails.branding && deckChrome?.madeWith && (
						<span className={classes.branding}>
							<AudienceBranding copy={deckChrome.madeWith} />
						</span>
					)}
					<div
						className={classes.controls}
						role="toolbar"
						aria-label={t`Playback and fullscreen`}
					>
						{activeBlock === "popcorn" && !openingOpen && (
							<Tooltip
								label={playbackPaused ? audienceCopy.play : audienceCopy.pause}
								classNames={{ tooltip: classes.tooltip }}
								// The tooltip floats out of the shell, so it carries the
								// theme itself instead of inheriting it.
								data-theme={darkTheme}
							>
								<ActionIcon
									className={classes.control}
									variant="subtle"
									size="lg"
									radius="md"
									aria-label={
										playbackPaused ? audienceCopy.play : audienceCopy.pause
									}
									aria-pressed={playbackPaused}
									onClick={() => setPlaybackPaused((paused) => !paused)}
								>
									{playbackPaused ? (
										<PlayIcon size={20} />
									) : (
										<PauseIcon size={20} />
									)}
								</ActionIcon>
							</Tooltip>
						)}
						{frameDetails.qrUrl && (
							<Tooltip
								label={qrToggleLabel}
								classNames={{ tooltip: classes.tooltip }}
								data-theme={darkTheme}
							>
								<ActionIcon
									className={classes.control}
									variant="subtle"
									size="lg"
									radius="md"
									aria-label={qrToggleLabel}
									aria-pressed={!qrMinimized}
									onClick={() => setQrMinimized((minimized) => !minimized)}
									data-testid="audience-qr-toggle"
								>
									<QrCodeIcon size={20} />
								</ActionIcon>
							</Tooltip>
						)}
						<Tooltip
							label={dark ? audienceCopy.lightScreen : audienceCopy.darkScreen}
							classNames={{ tooltip: classes.tooltip }}
							data-theme={darkTheme}
						>
							<ActionIcon
								className={classes.control}
								variant="subtle"
								size="lg"
								radius="md"
								aria-label={
									dark ? audienceCopy.lightScreen : audienceCopy.darkScreen
								}
								aria-pressed={dark}
								onClick={() => setTheme(dark ? "light" : "dark")}
								data-testid="audience-theme-toggle"
							>
								{dark ? <SunIcon size={20} /> : <MoonIcon size={20} />}
							</ActionIcon>
						</Tooltip>
						<Tooltip
							label={audienceCopy.fullscreen}
							classNames={{ tooltip: classes.tooltip }}
							data-theme={darkTheme}
						>
							<ActionIcon
								className={classes.control}
								variant="subtle"
								size="lg"
								radius="md"
								aria-label={audienceCopy.fullscreen}
								aria-pressed={fullscreen}
								onClick={() => void toggleFullscreen()}
							>
								{fullscreen ? (
									<ArrowsInIcon size={20} />
								) : (
									<ArrowsOutIcon size={20} />
								)}
							</ActionIcon>
						</Tooltip>
					</div>
				</div>
			</footer>
			{fullscreenError && (
				<Text size="sm" role="alert" px="md">
					<Trans>Fullscreen is unavailable in this browser.</Trans>
				</Text>
			)}
		</Tabs>
	);
};

export const AudienceScreenRoute = () => {
	const { presentationId, token } = useParams<{
		presentationId: string;
		token: string;
	}>();
	// The whole page is the room's screen, so everything Lingui renders on it
	// (the Map's controls) follows the presentation's language, not the last
	// dashboard language this browser happened to store. Nothing is persisted.
	const followLanguage = useCallback((code: string) => {
		const locale = SUPPORTED_LANGUAGES.find(
			(entry) => entry.split("-")[0] === code,
		);
		if (locale && i18n.locale !== locale) i18n.activate(locale);
	}, []);
	// The room screen is for showing, not for writing: the opening slides are
	// reworded in the dashboard's preview on the Present page, never on the
	// projector. Without `onEditOpening` the deck never gets the editing command.
	return (
		<AudienceScreen
			presentationId={presentationId}
			publicToken={token}
			onLanguage={followLanguage}
			className="h-dvh min-h-dvh"
		/>
	);
};
