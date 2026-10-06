import type { I18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { type PresentedError, say } from "@/lib/errors/present";

export const SUPPORT_EMAIL = "support@dembrane.com";

/** Where an action leads, or what it runs; null when the action has no button. */
export interface ActionTarget {
	readonly label: string;
	readonly href?: string;
	readonly onClick?: () => void;
}

const LABELS = {
	contactAdmin: msg({
		id: "error.action.contact_admin",
		message: "Email your admin",
	}),
	contactAdminNamed: msg({
		id: "error.action.contact_admin_named",
		message: "Email {name}",
	}),
	contactSupport: msg({
		id: "error.action.contact_support",
		message: "Contact support",
	}),
	retry: msg({ id: "error.action.retry", message: "Try again" }),
	signIn: msg({ id: "error.action.sign_in", message: "Log in again" }),
	upgrade: msg({ id: "error.action.upgrade", message: "See plans" }),
};

function currentOrganisation(): string | null {
	const m = window.location.pathname.match(/\/o\/([^/]+)/);
	return m?.[1] ?? null;
}

/**
 * The button for a presented error. retry needs the caller's retry function; fix_input,
 * wait and none have no button (the message says what to do); contact_admin has one only
 * when the API named the admin's email.
 */
export function actionTarget(
	presented: PresentedError,
	i18n: I18n,
	opts: { onRetry?: () => void } = {},
): ActionTarget | null {
	switch (presented.action) {
		case "retry":
			return opts.onRetry
				? { label: i18n._(LABELS.retry), onClick: opts.onRetry }
				: null;
		case "sign_in": {
			const next = `${window.location.pathname}${window.location.search}`;
			return {
				href: `/login?next=${encodeURIComponent(next)}`,
				label: i18n._(LABELS.signIn),
			};
		}
		case "upgrade": {
			const fromParams = presented.params.organisation_id;
			const org =
				typeof fromParams === "string" ? fromParams : currentOrganisation();
			return {
				href: org ? `/o/${org}/settings/billing` : "/o",
				label: i18n._(LABELS.upgrade),
			};
		}
		case "contact_admin": {
			const email = presented.admin?.email;
			if (!email) return null;
			const name = presented.admin?.name;
			return {
				href: `mailto:${email}`,
				label: name
					? say(i18n, LABELS.contactAdminNamed, { name })
					: i18n._(LABELS.contactAdmin),
			};
		}
		case "contact_support": {
			const subject = presented.code
				? `dembrane: ${presented.code}`
				: "dembrane: something went wrong";
			return {
				href: `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}`,
				label: i18n._(LABELS.contactSupport),
			};
		}
		default:
			return null;
	}
}
