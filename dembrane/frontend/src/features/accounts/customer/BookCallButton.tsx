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
			<BookCallModal
				opened={open}
				onClose={() => setOpen(false)}
				orgId={orgId}
				reference={reference}
				orgName={orgName}
			/>
		</>
	);
}

/** The booking dialog on its own, for the "Book a call with us" step. */
export function BookCallModal({
	opened,
	onClose,
	orgId,
	reference,
	orgName,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	reference: string | null;
	orgName: string;
}) {
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Book a call`}
			size="lg"
			fullScreen={false}
		>
			{opened && (
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
	);
}
