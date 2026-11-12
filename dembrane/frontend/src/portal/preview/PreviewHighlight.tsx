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
			const el = document.querySelector<HTMLElement>(selector);
			tries += 1;
			if (el) {
				el.setAttribute(MARK, target);
				el.style.outline = "2px solid var(--app-action)";
				el.style.outlineOffset = "4px";
				el.scrollIntoView({
					behavior: reduce ? "auto" : "smooth",
					block: "center",
				});
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
