import { useEffect } from "react";
import type {
	PreviewHighlight as Highlight,
	PreviewScreen,
} from "@/lib/portalPreview/protocol";

/** Where each part the dashboard can point at sits in the participant screens. */
const TARGETS: Record<Highlight, string> = {
	description: '[data-testid="portal-conversation-description"]',
	"event-cta": '[data-testid="portal-finish-event-cta"]',
	explore: '[data-testid="portal-explore-messages-container"]',
	"finish-text": '[data-testid="portal-finish-custom-message"]',
	name: '[data-testid="portal-initiate-name-input"]',
	notifications: '[data-testid="portal-finish-notification-section"]',
	privacy: '[data-testid^="portal-onboarding-slide-"]',
	tags: '[data-testid="portal-initiate-tags-select"]',
	title: '[data-testid="portal-conversation-title"]',
	tutorial: '[data-testid^="portal-onboarding-slide-"]',
	"verify-summary": '[data-testid="portal-verify-artefact-content"]',
	"verify-topics": '[data-testid="portal-verify-selection-container"]',
};

const MARK = "data-preview-highlight";

export const scrollParent = (el: HTMLElement): HTMLElement | null => {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const { overflowY } = getComputedStyle(p);
		if (
			(overflowY === "auto" || overflowY === "scroll") &&
			p.scrollHeight > p.clientHeight
		)
			return p;
	}
	return null;
};

/**
 * Outlines the part of the screen the open option changes and scrolls it into view
 * (ECHO-1060). The screens render as their data arrives, so it looks until it finds it.
 */
export const PreviewHighlight = ({
	target,
	screen,
}: {
	target: Highlight | null;
	screen: PreviewScreen;
}) => {
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new screen is a new page to look in
	useEffect(() => {
		const clear = () => {
			for (const el of document.querySelectorAll<HTMLElement>(`[${MARK}]`)) {
				el.removeAttribute(MARK);
				el.style.outline = "";
				el.style.outlineOffset = "";
			}
		};
		clear();
		if (!target) return;
		const selector = TARGETS[target];
		const reduce = window.matchMedia?.(
			"(prefers-reduced-motion: reduce)",
		).matches;
		let tries = 0;
		const timer = window.setInterval(() => {
			const found = document.querySelector<HTMLElement>(selector);
			// A field's outline goes round its label and box, which draw their own focus ring.
			const el =
				found?.closest<HTMLElement>(".mantine-InputWrapper-root") ?? found;
			tries += 1;
			if (el) {
				el.setAttribute(MARK, target);
				el.style.outline = "2px solid var(--app-action)";
				el.style.outlineOffset = "4px";
				// Not scrollIntoView: that scrolls the dashboard around the frame too.
				const box = scrollParent(el);
				if (box) {
					const top =
						el.getBoundingClientRect().top -
						box.getBoundingClientRect().top +
						box.scrollTop -
						box.clientHeight / 3;
					box.scrollTo({
						behavior: reduce ? "auto" : "smooth",
						top: Math.max(0, top),
					});
				}
				window.clearInterval(timer);
			} else if (tries > 40) window.clearInterval(timer);
		}, 100);
		return () => {
			window.clearInterval(timer);
			clear();
		};
	}, [target, screen]);
	return null;
};
