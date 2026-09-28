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
import { useRef } from "react";
import { useParams } from "react-router";
import { AccountsApiError } from "../api/client";
import { useAccountPage } from "../api/hooks";
import { AccountsI18n } from "../i18n";
import { BillingForm } from "./BillingForm";
import { BookCallButton } from "./BookCallButton";
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
	useDocumentTitle(t`Account | dembrane`);

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
	const billingLocked = billingTask?.locked === true;

	return (
		<Container size="md" px={{ base: "md", sm: "lg" }} py="xl">
			<Stack gap={36}>
				<Group justify="space-between" align="flex-end" gap="sm">
					<Stack gap={2}>
						<Title order={3} fw={400}>
							<Trans>Account</Trans>
						</Title>
						<Text size="sm" c="dimmed">
							{data.organisation.name}
						</Text>
					</Stack>
					<BookCallButton
						orgId={organisationId}
						reference={data.needs_form_reference}
						orgName={data.organisation.name}
					/>
				</Group>

				<NextSteps
					orgId={organisationId}
					tasks={data.tasks}
					onBilling={() =>
						billingRef.current?.scrollIntoView({
							behavior: "smooth",
							block: "start",
						})
					}
				/>

				<DocumentsTable orgId={organisationId} documents={data.documents} />

				{!billingLocked && (
					<div ref={billingRef}>
						<BillingForm orgId={organisationId} billing={data.billing} />
					</div>
				)}

				<Questions orgId={organisationId} tickets={data.tickets} />
			</Stack>
		</Container>
	);
};
