import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Button, Loader, Modal, Stack } from "@mantine/core";
import { lazy, Suspense, useState } from "react";

// The cal.com step and its script load when the dialog opens, never with the page.
const BookCall = lazy(() => import("./BookCall"));

export function BookCallButton({
	orgId,
	reference,
	orgName,
}: {
	orgId: string;
	reference: string | null;
	orgName: string;
}) {
	const [open, setOpen] = useState(false);
	return (
		<>
			<Button
				size="xs"
				variant="default"
				onClick={() => setOpen(true)}
				data-testid="book-call"
			>
				<Trans>Book a call</Trans>
			</Button>
			<Modal
				opened={open}
				onClose={() => setOpen(false)}
				title={t`Book a call`}
				size="lg"
				fullScreen={false}
			>
				{open && (
					<Suspense
						fallback={
							<Stack align="center" py="xl">
								<Loader size="sm" />
							</Stack>
						}
					>
						<BookCall orgId={orgId} reference={reference ?? orgName} />
					</Suspense>
				)}
			</Modal>
		</>
	);
}
