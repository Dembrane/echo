import { t } from "@lingui/core/macro";
import {
	useEffect,
	useLayoutEffect,
	useState,
	useSyncExternalStore,
} from "react";
import { cn } from "@/lib/utils";
import classes from "./BeautifulLoading.module.css";
import { LOADING_QUOTES } from "./quotes";
import { loadingStore } from "./store";

/** The hand-drawn mark from the eyebrow of dembrane.com: a vertical strip of
 * 42 sketches (a fingerprint, a QR code, a phone, a voice, an ear, a
 * transcript, a report, a network). index.html preloads it, so the loader
 * never shows an empty box while the page it stands in for is on its way. */
export const LOADING_SKETCHES_SRC = "/loading/mark-anim.png";

// One full pass of the sketches, so each quote gets the whole story once.
const QUOTE_MS = 7000;
// Past this many characters a quote steps down a size, so it keeps its shape.
const LONG_QUOTE = 110;
// How long the stage stays after the last wait ends, so the next step of the
// same load (the page after the project, the data after the page) carries on
// instead of starting over.
const LINGER_MS = 250;
// The fade out once nothing has taken over.
const LEAVE_MS = 160;

interface BeautifulLoadingProps {
	/** Cover the positioned parent (for content that is already on screen)
	 * instead of taking a place in the flow. */
	overlay?: boolean;
	className?: string;
}

/** Marks a part of the page as loading: parchment where it will be, and a
 * count in with the LoadingStage, which draws the sketches and the quote. It
 * holds no state worth keeping, so it simply disappears when the page
 * arrives. */
export const BeautifulLoading = ({
	overlay = false,
	className,
}: BeautifulLoadingProps) => {
	useLayoutEffect(() => loadingStore.hold(), []);

	return (
		// biome-ignore lint/a11y/useSemanticElements: <output> is for a calculation's result; this is a region that is waiting
		<div
			className={cn(classes.root, overlay && classes.overlay, className)}
			role="status"
			aria-busy="true"
		>
			<span className="sr-only">{t`Loading`}</span>
		</div>
	);
};

type Box = { top: number; left: number; width: number; height: number };

/** The page's content area when the app shell is up, else the whole window. */
const measure = (): Box => {
	const root = document.querySelector("[data-app-scroll-root]");
	if (!root) {
		return {
			height: window.innerHeight,
			left: 0,
			top: 0,
			width: window.innerWidth,
		};
	}
	const r = root.getBoundingClientRect();
	return {
		height: Math.round(r.height),
		left: Math.round(r.left),
		top: Math.round(r.top),
		width: Math.round(r.width),
	};
};

const sameBox = (a: Box, b: Box) =>
	a.top === b.top &&
	a.left === b.left &&
	a.width === b.width &&
	a.height === b.height;

/** The one loader on screen: parchment over the content area, the sketches
 * cycling and a quote beside them, for as long as anything is waiting. It
 * lives once, at the root of the app, so it never restarts between the steps
 * of a load. */
export const LoadingStage = () => {
	const waiting = useSyncExternalStore(
		loadingStore.subscribe,
		loadingStore.getSnapshot,
		() => false,
	);
	const [phase, setPhase] = useState<"hidden" | "shown" | "leaving">("hidden");
	const [box, setBox] = useState<Box | null>(null);
	const [index, setIndex] = useState(() =>
		Math.floor(Math.random() * LOADING_QUOTES.length),
	);

	useEffect(() => {
		if (waiting) {
			setPhase("shown");
			return;
		}
		const linger = setTimeout(() => {
			setPhase((p) => (p === "shown" ? "leaving" : p));
		}, LINGER_MS);
		const leave = setTimeout(() => setPhase("hidden"), LINGER_MS + LEAVE_MS);
		return () => {
			clearTimeout(linger);
			clearTimeout(leave);
		};
	}, [waiting]);

	const visible = phase !== "hidden";

	// Follow the content area while it settles: the sidebar arrives after
	// sign-in, and collapses or expands under the loader.
	useLayoutEffect(() => {
		if (!visible) return;
		let frame = 0;
		const track = () => {
			const next = measure();
			setBox((prev) => (prev && sameBox(prev, next) ? prev : next));
			frame = requestAnimationFrame(track);
		};
		track();
		return () => cancelAnimationFrame(frame);
	}, [visible]);

	useEffect(() => {
		if (!visible) return;
		const id = setInterval(
			() => setIndex((i) => (i + 1) % LOADING_QUOTES.length),
			QUOTE_MS,
		);
		return () => clearInterval(id);
	}, [visible]);

	if (!visible || !box) return null;

	const quote = LOADING_QUOTES[index];

	return (
		<div
			className={cn(classes.stageHost, phase === "leaving" && classes.leaving)}
			style={box}
			aria-hidden="true"
		>
			<div className={classes.stage}>
				<span className={classes.sketches}>
					<img
						src={LOADING_SKETCHES_SRC}
						alt=""
						width={150}
						height={6300}
						decoding="sync"
					/>
				</span>
				<figure key={index} className={classes.quote}>
					<blockquote
						className={cn(
							classes.text,
							quote.text.length > LONG_QUOTE && classes.long,
						)}
					>
						{quote.text}
					</blockquote>
					<figcaption className={classes.author}>{quote.author}</figcaption>
				</figure>
			</div>
		</div>
	);
};
