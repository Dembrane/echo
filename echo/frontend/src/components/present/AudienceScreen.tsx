import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { ActionIcon, Loader, Tabs, Text, Tooltip } from "@mantine/core";
import {
	ArrowsInIcon,
	ArrowsOutIcon,
	PauseIcon,
	PlayIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { QRCode } from "@/components/common/QRCode";
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
	deckVisibilityCommand,
	isDeckChromeEvent,
	isDeckOpeningEvent,
	isDeckReadyEvent,
	PUBLIC_AUDIENCE_REVALIDATE_MS,
	postDeckMessage,
} from "./audienceContract";
import {
	type PresentationBlock as AudienceBlock,
	orderedBlocks,
} from "./blocks";

type AudienceResponse = {
	id: string;
	manifest: {
		version: number;
		blocks: AudienceBlock[];
		opening: AudienceBlock | null;
	};
	bundle: {
		files?: Record<string, unknown>;
	};
};

export type AudienceScreenProps = {
	presentationId?: string;
	publicToken?: string;
	embedded?: boolean;
	draft?: boolean;
	draftRevision?: number;
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
		dataPolicy: "Zásady pro data",
		fullscreen: "Celá obrazovka",
		intro: "Úvod",
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
		dataPolicy: "Datenrichtlinie",
		fullscreen: "Vollbild",
		intro: "Einführung",
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
		dataPolicy: "Data policy",
		fullscreen: "Fullscreen",
		intro: "Introduction",
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
		dataPolicy: "Política de datos",
		fullscreen: "Pantalla completa",
		intro: "Introducción",
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
		dataPolicy: "Politique des données",
		fullscreen: "Plein écran",
		intro: "Introduction",
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
		dataPolicy: "Politica sui dati",
		fullscreen: "Schermo intero",
		intro: "Introduzione",
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
		dataPolicy: "Databeleid",
		fullscreen: "Volledig scherm",
		intro: "Introductie",
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
		dataPolicy: "Політика даних",
		fullscreen: "На весь екран",
		intro: "Вступ",
		pause: "Пауза",
		play: "Відтворити",
		waiting: "Результати готуються.",
	},
};

const normalizeAudience = (value: AudienceResponse): AudienceResponse => {
	const blocks = orderedBlocks(value.manifest.blocks ?? []);
	return {
		...value,
		manifest: {
			...value.manifest,
			blocks,
			opening:
				value.manifest.opening && blocks.includes(value.manifest.opening)
					? value.manifest.opening
					: (blocks[0] ?? null),
		},
	};
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
	className,
}: AudienceScreenProps) => {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const shellRef = useRef<HTMLDivElement>(null);
	const reloadSequenceRef = useRef(0);
	const eventRefreshTimerRef = useRef<ReturnType<
		typeof globalThis.setTimeout
	> | null>(null);
	const deckReadyRef = useRef(false);
	const pendingDeckRefreshRef = useRef(false);
	const [audience, setAudience] = useState<AudienceResponse | null>(null);
	const [activeBlock, setActiveBlock] = useState<AudienceBlock | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [eventRevision, setEventRevision] = useState(0);
	const [playbackPaused, setPlaybackPaused] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const [fullscreenError, setFullscreenError] = useState(false);
	const [openingOpen, setOpeningOpen] = useState(false);
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
	const reloadAudience = useCallback(
		async (signal?: AbortSignal) => {
			if (!urls) {
				setAudience(null);
				setActiveBlock(null);
				setError("Missing presentation identity.");
				return;
			}
			const sequence = ++reloadSequenceRef.current;
			try {
				const response = await fetch(urls.audience, {
					credentials: "include",
					headers: { Accept: "application/json" },
					signal,
				});
				if (!response.ok) {
					throw new Error(`Presentation request failed (${response.status})`);
				}
				const next = normalizeAudience(
					(await response.json()) as AudienceResponse,
				);
				if (sequence !== reloadSequenceRef.current) return;
				setAudience(next);
				setActiveBlock((current) =>
					current && next.manifest.blocks.includes(current)
						? current
						: next.manifest.opening,
				);
				setError(null);
			} catch (reason) {
				if (signal?.aborted || sequence !== reloadSequenceRef.current) return;
				setAudience(null);
				setActiveBlock(null);
				setError(reason instanceof Error ? reason.message : String(reason));
			}
		},
		[urls],
	);
	const deckSrc = useMemo(() => {
		if (!urls || !audience) return null;
		const query = new URLSearchParams({
			embedded: "1",
			presentationId: audience.id,
			...(embedded ? { preview: "1" } : {}),
		});
		return `${urls.deck}?${query}`;
	}, [audience, urls, embedded]);
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
			void reloadAudience();
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

	useServerEvents(urls?.events ?? null, ["update"], scheduleEventRefresh);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a saved draft revision must reload its audience projection.
	useEffect(() => {
		const controller = new AbortController();
		void reloadAudience(controller.signal);
		return () => controller.abort();
	}, [reloadAudience, draftRevision]);

	useEffect(() => {
		const interval = globalThis.setInterval(
			() => {
				if (publicToken) {
					requestDeckRefresh();
					setEventRevision((current) => current + 1);
					void reloadAudience();
					return;
				}
				scheduleEventRefresh();
			},
			publicToken ? PUBLIC_AUDIENCE_REVALIDATE_MS : AUDIENCE_SAFETY_REFRESH_MS,
		);
		return () => globalThis.clearInterval(interval);
	}, [publicToken, reloadAudience, requestDeckRefresh, scheduleEventRefresh]);

	useEffect(() => {
		if (!draft || !presentationId || draftRevision === 0) return;
		requestDeckRefresh();
	}, [draft, draftRevision, presentationId, requestDeckRefresh]);
	const audienceCopy = useMemo(() => {
		const session = audience?.bundle.files?.["session.json"] as
			| { language?: unknown; ui_language?: unknown }
			| undefined;
		const language =
			typeof session?.ui_language === "string"
				? session.ui_language
				: typeof session?.language === "string"
					? session.language
					: "en";
		return AUDIENCE_COPY[language] ?? AUDIENCE_COPY.en;
	}, [audience]);
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
			command: "block" | "visibility" | "opening",
			extra: Record<string, unknown>,
		) => {
			if (!audience) return;
			const message =
				command === "visibility"
					? deckVisibilityCommand(audience.id, extra.visible === true)
					: command === "opening"
						? deckOpeningCommand(audience.id, extra.screen as "intro" | "data")
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
			if (!audience || !activeBlock) return;
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
		[activeBlock, audience, selectBlock],
	);

	useEffect(() => {
		if (embedded) return;
		globalThis.addEventListener("keydown", handleKeyDown);
		return () => globalThis.removeEventListener("keydown", handleKeyDown);
	}, [embedded, handleKeyDown]);

	if (error) {
		return (
			<div
				className="flex h-full min-h-[24rem] items-center justify-center p-6"
				role="alert"
			>
				<div className="text-center">
					<Text size="lg">
						<Trans>This presentation could not be loaded.</Trans>
					</Text>
				</div>
			</div>
		);
	}

	if (!audience) {
		return (
			<div
				className="flex h-full min-h-[24rem] items-center justify-center"
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
		>
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
								<Tabs.Tab className={classes.tab} key={block} value={block}>
									{audienceCopy.blocks[block]}
								</Tabs.Tab>
							))}
						</Tabs.List>
					</div>
				</div>
			</header>
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
							((activeBlock === "map" && !openingOpen) ||
								(!deckReady && !openingOpen)) &&
								"invisible pointer-events-none",
						)}
						onLoad={() => {
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
								(activeBlock !== "map" || openingOpen) && "hidden",
							)}
						>
							<AudienceMapAdapter
								active={activeBlock === "map" && !openingOpen}
								endpoint={urls?.map ?? ""}
								revision={eventRevision + draftRevision}
								waitingLabel={audienceCopy.waiting}
							/>
						</div>
					)}
				</Tabs.Panel>
				{frameDetails.qrUrl && (
					<aside
						className={cn(classes.qrPanel, qrMinimized && classes.qrMinimized)}
						aria-label={frameDetails.qrLabel || deckChrome?.qrLabel || "QR"}
						data-testid="audience-qr"
					>
						{qrMinimized ? (
							<button
								type="button"
								className={classes.qrChip}
								aria-label={deckChrome?.qrShow || "QR"}
								onClick={() => setQrMinimized(false)}
							>
								QR
							</button>
						) : (
							<>
								<button
									type="button"
									className={classes.qrMinimize}
									aria-label={deckChrome?.qrFold || "QR"}
									onClick={() => setQrMinimized(true)}
								>
									−
								</button>
								<QRCode
									value={frameDetails.qrUrl}
									href={frameDetails.qrUrl}
									className={classes.qrCode}
								/>
								{(frameDetails.qrLabel || deckChrome?.qrLabel) && (
									<span className={classes.qrLabel}>
										{frameDetails.qrLabel || deckChrome?.qrLabel}
									</span>
								)}
							</>
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
						<Tooltip label={audienceCopy.fullscreen}>
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
	return (
		<AudienceScreen
			presentationId={presentationId}
			publicToken={token}
			className="h-dvh min-h-dvh"
		/>
	);
};
