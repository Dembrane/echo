import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Container,
	Group,
	Loader,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useRef, useState } from "react";
import { useParams } from "react-router";
import { AccountsApiError } from "../api/client";
import { useAccountPage } from "../api/hooks";
import { AccountsI18n } from "../i18n";
import { BillingForm } from "./BillingForm";
import { BookCallButton, BookCallModal } from "./BookCallButton";
import { DocumentsTable } from "./DocumentsTable";
import { NextSteps } from "./NextSteps";
import { Questions } from "./Questions";

/**
 * The customer's account: everything between dembrane and this organisation on one page.
 * Next steps first, because that is why someone opens it; then documents, billing
 * details and questions. Signing is its own screen, opened from a step.
 */
export const AccountRoute = () => (
	<AccountsI18n>
		<AccountPage />
	</AccountsI18n>
);

const AccountPage = () => {
	const { organisationId } = useParams<{ organisationId: string }>();
	const { data, isLoading, error } = useAccountPage(organisationId);
	const billingRef = useRef<HTMLDivElement>(null);
	const [booking, setBooking] = useState(false);
	useDocumentTitle(
		data ? `${data.organisation.name} | dembrane` : t`Tasks | dembrane`,
	);

	if (isLoading) {
		return (
			<Stack align="center" pt="15vh">
				<Loader />
			</Stack>
		);
	}
	if (error || !data || !organisationId) {
		return (
			<Container size="sm" py="xl">
				<Alert
					color={
						error instanceof AccountsApiError && error.status === 403
							? "gray"
							: "red"
					}
				>
					{error instanceof AccountsApiError && error.status === 403 ? (
						<Trans>
							Only the organisation's admins and billing contacts see the
							account.
						</Trans>
					) : (
						<Trans>
							The account could not be loaded. Try again in a moment.
						</Trans>
					)}
				</Alert>
			</Container>
		);
	}

	const billingTask = data.tasks.find(
		(task) => task.kind === "billing_details",
	);
	const prospect = data.organisation.account_stage === "prospect";
	// A prospect is asked for billing details with their first offer, not before; until
	// then the form and an empty documents list would only be noise on their first visit.
	const billingHidden = billingTask ? billingTask.locked : prospect;
	const documentsHidden = prospect && data.documents.length === 0;
	// While "Book a call with us" is a step, the step is where a call is booked.
	const bookingStep = data.tasks.some(
		(task) =>
			task.code === "book_call" &&
			(task.status === "open" || task.status === "changes_requested"),
	);

	return (
		<Container size="md" px={{ base: "md", sm: "lg" }} py="xl">
			<Stack gap={36}>
				<Title order={3} fw={400}>
					{data.organisation.name}
				</Title>

				<NextSteps
					orgId={organisationId}
					tasks={data.tasks}
					onBilling={() =>
						billingRef.current?.scrollIntoView({
							behavior: "smooth",
							block: "start",
						})
					}
					onBookCall={() => setBooking(true)}
				/>

				{!documentsHidden && (
					<DocumentsTable orgId={organisationId} documents={data.documents} />
				)}

				{!billingHidden && (
					<div ref={billingRef}>
						<BillingForm orgId={organisationId} billing={data.billing} />
					</div>
				)}

				<Questions
					orgId={organisationId}
					tickets={data.tickets}
					extraAction={
						bookingStep ? undefined : (
							<BookCallButton
								orgId={organisationId}
								reference={data.needs_form_reference}
								orgName={data.organisation.name}
							/>
						)
					}
				/>
			</Stack>
			<BookCallModal
				opened={booking}
				onClose={() => setBooking(false)}
				orgId={organisationId}
				reference={data.needs_form_reference}
				orgName={data.organisation.name}
			/>
		</Container>
	);
};
