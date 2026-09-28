import type { I18n } from "@lingui/core";
import { i18n as globalI18n } from "@lingui/core";
import { toast } from "@/components/common/Toaster";
import { presentError } from "@/lib/errors/present";
import { actionTarget } from "./actions";

/**
 * A toast for a failed request: the friendly message and its action button. Replaces
 * `toast.error(error.message)` and its variants. Toasts with the same code replace each
 * other, so a burst of failures shows one notice.
 */
export async function notifyError(
	error: unknown,
	opts: { onRetry?: () => void; i18n?: I18n } = {},
): Promise<void> {
	const i18n = opts.i18n ?? globalI18n;
	const presented = await presentError(error, i18n);
	const target = actionTarget(
		presented,
		i18n,
		opts.onRetry ? { onRetry: opts.onRetry } : {},
	);
	toast.error(presented.message, {
		id: `error:${presented.code ?? presented.status ?? "unknown"}`,
		...(target && {
			action: {
				label: target.label,
				onClick: () => {
					if (target.onClick) target.onClick();
					else if (target.href) window.location.assign(target.href);
				},
			},
		}),
	});
}
