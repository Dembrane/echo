import { plural, t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Container, Loader, Stack, Text, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useRef, useState } from "react";
import { useParams } from "react-router";
import { useV2Me } from "@/hooks/useV2Me";
import { AccountsApiError } from "../api/client";
import { useAccountPage } from "../api/hooks";
import { AccountsI18n } from "../i18n";
import { BillingForm } from "./BillingForm";
import { BookCallModal } from "./BookCallModal";
import { DocumentsTable } from "./DocumentsTable";
import { NextSteps } from "./NextSteps";
import { type AccountPlan, localToday, planAccount } from "./plan";
import { TalkToUs } from "./TalkToUs";
import { ToPay } from "./ToPay";

/**
 * The customer's account: everything between dembrane and this organisation on one page,
 * ordered by who has the next move. What to pay, then what to do, then what is coming;
 * the record (documents, billing details) and a way to reach us below. Signing is its
 * own screen, opened from a task or a document.
 */
export const AccountRoute = () => (
	<AccountsI18n>
		<AccountPage />
	</AccountsI18n>
);

const AccountPage = () => {
	const { organisationId } = useParams<{ organisationId: string }>();
	const { data, isLoading, error } = useAccountPage(organisationId);
	const { data: me } = useV2Me();
	const billingRef = useRef<HTMLDivElement>(null);
	const [booking, setBooking] = useState(false);
	useDocumentTitle(
		data ? `${data.organisation.name} | dembrane` : t`Account | dembrane`,
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

	const today = localToday();
	const plan = planAccount(data.tasks, data.documents, today, me?.email);
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
	// One primary action on the page: paying, when it can be done online, else the first task.
	const payFirst = Boolean(plan.toPay[0]?.invoice?.payment_url);

	return (
		<Container size="md" px={{ base: "md", sm: "lg" }} py="xl">
			<Stack gap="xl">
				<Stack gap="xs">
					<Title order={1} size="h2" style={{ overflowWrap: "anywhere" }}>
						{data.organisation.name}
					</Title>
					<Summary plan={plan} />
				</Stack>

				<ToPay invoices={plan.toPay} today={today} primary={payFirst} />

				<NextSteps
					orgId={organisationId}
					plan={plan}
					primary={!payFirst}
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
					// The margin keeps the title clear of the page header after "Fill in" scrolls here.
					<div ref={billingRef} style={{ scrollMarginTop: 16 }}>
						<BillingForm
							orgId={organisationId}
							billing={data.billing}
							pending={
								billingTask?.status === "open" ||
								billingTask?.status === "changes_requested"
							}
						/>
					</div>
				)}

				<TalkToUs
					orgId={organisationId}
					tickets={data.tickets}
					onBookCall={bookingStep ? undefined : () => setBooking(true)}
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

/** One sentence under the name: whose move it is. */
function Summary({ plan }: { plan: AccountPlan }) {
	const mine = plan.toPay.length + plan.toDo.length;
	const ours = plan.withUs.length;
	const text =
		mine > 0
			? plural(mine, {
					one: "One thing needs you.",
					other: "# things need you.",
				})
			: ours > 0
				? t`Nothing needs you right now. We are working on our part.`
				: t`You are all set. Nothing needs you right now.`;
	return (
		<Text c="dimmed" data-testid="account-summary">
			{text}
		</Text>
	);
}
