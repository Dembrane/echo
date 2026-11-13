import { Trans } from "@lingui/react/macro";
import { Button } from "@mantine/core";
import type { ReactNode } from "react";
import { I18nLink } from "@/components/common/i18nLink";

/** Where a document is read and signed. */
export const signPath = (orgId: string, docId: string) =>
	`/o/${orgId}/account/documents/${docId}/sign`;

/** The sign-in that lands back on `next`, the document. */
export const logInPath = (next: string) =>
	`/login?next=${encodeURIComponent(next)}`;

export function LogInButton({
	next,
	children,
}: {
	next: string;
	children?: ReactNode;
}) {
	return (
		<Button
			component={I18nLink}
			to={logInPath(next)}
			size="md"
			variant="filled"
			data-testid="sign-log-in"
		>
			{children ?? <Trans>Log in</Trans>}
		</Button>
	);
}
