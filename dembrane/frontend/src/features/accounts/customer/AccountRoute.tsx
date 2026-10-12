import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Alert, Loader, Stack, Title } from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useParams } from "react-router";
import { PageContainer } from "@/components/layout/PageContainer";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useV2Me } from "@/hooks/useV2Me";
import { AccountsApiError } from "../api/client";
import { useAccountPage } from "../api/hooks";
import type { AccountPageT } from "../contract/contract.gen";
import { AccountsI18n, useAccountsCatalog } from "../i18n";
import { BillingForm } from "./BillingForm";
import { BookCallModal } from "./BookCallModal";
import { DocumentsTable } from "./DocumentsTable";
import { NextSteps } from "./NextSteps";
import { localToday, planAccount } from "./plan";
import { TalkToUs } from "./TalkToUs";
import { ToPay } from "./ToPay";

/**
 * Everything between dembrane and a customer organisation, spread over the organisation's
 * own pages. The overview carries what is open (what to pay, what to do, what is coming)
 * and a way to reach us; Tasks holds the whole list with the finished ones and the billing
 * details; Documents holds the record. Each part hides when it has nothing to show, and
 * all of it is absent for someone who cannot see the account (members who are not admins
 * or billing contacts). Signing is its own screen, opened from a task or a document.
 */

/** /o/:id/account, the old single page: emails and signing screens still link to it. */
export const AccountRedirect = () => (
	<Navigate to="../overview" relative="path" replace />
);

/** What to pay, what to do and what is coming, at the top of the organisation overview. */
export function AccountOverviewWork({ orgId }: { orgId: string }) {
	const ready = useAccountsCatalog();
	const { data } = useAccountPage(orgId);
	const { data: me } = useV2Me();
	const navigate = useI18nNavigate();
	const [booking, setBooking] = useState(false);
	if (!ready || !data) return null;
	const today = localToday();
	const plan = planAccount(data.tasks, data.documents, today, me?.email);
	// One primary action on the page: paying, when it can be done online, else the first task.
	const payFirst = Boolean(plan.toPay[0]?.invoice?.payment_url);
	return (
		<>
			<ToPay invoices={plan.toPay} today={today} primary={payFirst} />
			{/* Finished tasks live on Tasks; the overview shows only what is still open. */}
			<NextSteps
				orgId={orgId}
				plan={{ ...plan, done: [] }}
				primary={!payFirst}
				onBilling={() => navigate(`/o/${orgId}/tasks#billing`)}
				onBookCall={() => setBooking(true)}
			/>
			<BookCall
				data={data}
				orgId={orgId}
				opened={booking}
				onClose={() => setBooking(false)}
			/>
		</>
	);
}

/** "Talk to us", at the foot of the organisation overview. */
export function AccountOverviewContact({ orgId }: { orgId: string }) {
	const ready = useAccountsCatalog();
	const { data } = useAccountPage(orgId);
	const [booking, setBooking] = useState(false);
	if (!ready || !data) return null;
	return (
		<>
			<TalkToUs
				orgId={orgId}
				tickets={data.tickets}
				onBookCall={bookingIsAStep(data) ? undefined : () => setBooking(true)}
			/>
			<BookCall
				data={data}
				orgId={orgId}
				opened={booking}
				onClose={() => setBooking(false)}
			/>
		</>
	);
}

/** /o/:id/tasks: every task, the finished ones folded away, and the billing details. */
export const AccountTasksRoute = () => (
	<AccountsI18n>
		<AccountPage title={<Trans>Tasks</Trans>} docTitle={t`Tasks`}>
			{(orgId, data) => <TasksBody orgId={orgId} data={data} />}
		</AccountPage>
	</AccountsI18n>
);

/** /o/:id/documents: every offer, agreement and invoice, with its PDF. */
export const AccountDocumentsRoute = () => (
	<AccountsI18n>
		<AccountPage title={<Trans>Documents</Trans>} docTitle={t`Documents`}>
			{(orgId, data) => (
				<DocumentsTable orgId={orgId} documents={data.documents} title={null} />
			)}
		</AccountPage>
	</AccountsI18n>
);

function TasksBody({ orgId, data }: { orgId: string; data: AccountPageT }) {
	const billingRef = useRef<HTMLDivElement>(null);
	const [booking, setBooking] = useState(false);
	const { hash } = useLocation();
	const { data: me } = useV2Me();
	const today = localToday();
	const plan = planAccount(data.tasks, data.documents, today, me?.email);
	const billingTask = data.tasks.find(
		(task) => task.kind === "billing_details",
	);
	// A prospect is asked for billing details with their first offer, not before.
	const billingHidden = billingTask
		? billingTask.locked
		: data.organisation.account_stage === "prospect";
	const payFirst = Boolean(plan.toPay[0]?.invoice?.payment_url);
	const toBilling = () =>
		billingRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

	// "Fill in" on the overview lands here with #billing.
	useEffect(() => {
		if (hash === "#billing") billingRef.current?.scrollIntoView();
	}, [hash]);

	const nothing =
		plan.toPay.length +
			plan.toDo.length +
			plan.withUs.length +
			plan.later.length +
			plan.done.length ===
		0;

	return (
		<>
			{nothing && billingHidden && (
				<Alert color="gray">
					<Trans>Nothing to do right now.</Trans>
				</Alert>
			)}
			<ToPay invoices={plan.toPay} today={today} primary={payFirst} />
			<NextSteps
				orgId={orgId}
				plan={plan}
				primary={!payFirst}
				onBilling={toBilling}
				onBookCall={() => setBooking(true)}
			/>
			{!billingHidden && (
				// The margin keeps the title clear of the page header after "Fill in" scrolls here.
				<div ref={billingRef} style={{ scrollMarginTop: 16 }}>
					<BillingForm
						orgId={orgId}
						billing={data.billing}
						pending={
							billingTask?.status === "open" ||
							billingTask?.status === "changes_requested"
						}
					/>
				</div>
			)}
			<BookCall
				data={data}
				orgId={orgId}
				opened={booking}
				onClose={() => setBooking(false)}
			/>
		</>
	);
}

/** The frame of Tasks and Documents: the page's title, then its sections. */
function AccountPage({
	title,
	docTitle,
	children,
}: {
	title: ReactNode;
	docTitle: string;
	children: (orgId: string, data: AccountPageT) => ReactNode;
}) {
	const { organisationId } = useParams<{ organisationId: string }>();
	const { data, isLoading, error } = useAccountPage(organisationId);
	useDocumentTitle(
		data
			? `${docTitle} · ${data.organisation.name} | dembrane`
			: `${docTitle} | dembrane`,
	);

	if (isLoading) {
		return (
			<Stack align="center" pt="15vh">
				<Loader />
			</Stack>
		);
	}
	const denied = error instanceof AccountsApiError && error.status === 403;
	return (
		<PageContainer>
			<Stack gap="xl">
				<Title order={2}>{title}</Title>
				{error || !data || !organisationId ? (
					<Alert color={denied ? "gray" : "red"}>
						{denied ? (
							<Trans>
								Only the organisation's admins and billing contacts see this
								page.
							</Trans>
						) : (
							<Trans>
								This page could not be loaded. Try again in a moment.
							</Trans>
						)}
					</Alert>
				) : (
					children(organisationId, data)
				)}
			</Stack>
		</PageContainer>
	);
}

/** While "Book a call with us" is a step, the step is where a call is booked. */
const bookingIsAStep = (data: AccountPageT) =>
	data.tasks.some(
		(task) =>
			task.code === "book_call" &&
			(task.status === "open" || task.status === "changes_requested"),
	);

function BookCall({
	data,
	orgId,
	opened,
	onClose,
}: {
	data: AccountPageT;
	orgId: string;
	opened: boolean;
	onClose: () => void;
}) {
	return (
		<BookCallModal
			opened={opened}
			onClose={onClose}
			orgId={orgId}
			reference={data.needs_form_reference}
			orgName={data.organisation.name}
		/>
	);
}
