import { t } from "@lingui/core/macro";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import classes from "./BeautifulLoading.module.css";
import { LOADING_QUOTES } from "./quotes";

/** The hand-drawn mark from the eyebrow of dembrane.com: a vertical strip of
 * 42 sketches (a fingerprint, a QR code, a phone, a voice, an ear, a
 * transcript, a report, a network). index.html preloads it, so the loader
 * never shows an empty box while the page it stands in for is on its way. */
export const LOADING_SKETCHES_SRC = "/loading/mark-anim.png";

// One full pass of the sketches, so each quote gets the whole story once.
const QUOTE_MS = 7000;
// Past this many characters a quote steps down a size, so it keeps its shape.
const LONG_QUOTE = 110;

interface BeautifulLoadingProps {
	/** Cover the positioned parent (for content that is already on screen)
	 * instead of taking a place in the flow. */
	overlay?: boolean;
	className?: string;
}

/** What a page shows while it loads: parchment, the sketches cycling, and a
 * quote about listening beside them. It holds no state worth keeping, so it
 * simply disappears when the page arrives. */
export const BeautifulLoading = ({
	overlay = false,
	className,
}: BeautifulLoadingProps) => {
	const [index, setIndex] = useState(() =>
		Math.floor(Math.random() * LOADING_QUOTES.length),
	);

	useEffect(() => {
		const id = setInterval(
			() => setIndex((i) => (i + 1) % LOADING_QUOTES.length),
			QUOTE_MS,
		);
		return () => clearInterval(id);
	}, []);

	const quote = LOADING_QUOTES[index];

	return (
		// biome-ignore lint/a11y/useSemanticElements: <output> is for a calculation's result and holds phrasing content only; this holds a figure
		<div
			className={cn(classes.root, overlay && classes.overlay, className)}
			role="status"
			aria-busy="true"
		>
			<span className="sr-only">{t`Loading`}</span>
			<div className={classes.stage} aria-hidden="true">
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
