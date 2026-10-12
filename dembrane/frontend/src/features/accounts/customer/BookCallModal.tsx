import { t } from "@lingui/core/macro";
import { Loader, Modal, Stack } from "@mantine/core";
import { lazy, Suspense } from "react";

// The cal.com step and its script load when the dialog opens, never with the page.
const BookCall = lazy(() => import("./BookCall"));

/** The booking dialog, opened from the "Book a call with us" step or from Talk to us. */
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
