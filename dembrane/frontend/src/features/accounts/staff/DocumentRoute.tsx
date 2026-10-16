import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	CopyButton,
	Group,
	Loader,
	Stack,
	Text,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { openPdf } from "../api/client";
import {
	useAccountCard,
	useAccountsMutation,
	useDocument,
	usePdfData,
	usePdfHref,
} from "../api/hooks";
import {
	documentKindLabel,
	documentStatusColor,
	documentStatusLabel,
	formatDate,
	formatMoney,
} from "../format";
import { AccountsI18n } from "../i18n";
import { PdfPages } from "../pdf/PdfPages";
import { StaffOnly } from "./AccountCardRoute";
import { PushOfferModal } from "./PushOfferModal";
import { CustomerEmailModal, SendOfferConfirmModal } from "./SendOfferModals";

/**
 * Staff: one document as the customer will get it. A draft offer is read here, changed
 * and sent; this is the page sam links the deal owner to. A document that was sent shows
 * what went out and where it stands. Only staff open it: the API refuses anyone else.
 */
export const DocumentRoute = () => (
	<AccountsI18n>
		<StaffOnly>
			<DocumentPage />
		</StaffOnly>
	</AccountsI18n>
);

function DocumentPage() {
	const { orgId, docId } = useParams<{ orgId: string; docId: string }>();
	const { i18n } = useLingui();
	const doc = useDocument(orgId, docId, true);
	const card = useAccountCard(orgId);
	const pdf = usePdfData(doc.data?.file_url, doc.data?.sha256);
	const fileHref = usePdfHref(doc.data?.file_url);
	const send = useAccountsMutation("sendDocument", { orgId: orgId ?? "" });
	const [editing, setEditing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [emailOpen, setEmailOpen] = useState(false);
	useDocumentTitle(doc.data ? `${doc.data.title} | dembrane` : "dembrane");

	if (doc.isLoading) return <Loader m="xl" size="sm" />;
	if (!doc.data || !orgId || !docId) {
		return (
			<Alert color="red" m="xl">
				<Trans>This document could not be loaded.</Trans>
			</Alert>
		);
	}
	const d = doc.data;
	const draft = d.status === "draft";
	const draftOffer = draft && d.kind === "offer";
	const orgName = card.data?.organisation.name ?? "";
	const facts = [
		documentKindLabel(d.kind),
		d.reference,
		d.total_cents === null
			? null
			: t`${formatMoney(d.total_cents, d.currency, i18n.locale)} incl. VAT`,
		draft
			? null
			: d.signed_at
				? t`Signed ${formatDate(d.signed_at, i18n.locale)}`
				: d.sent_at
					? t`Sent ${formatDate(d.sent_at, i18n.locale)}`
					: null,
		!draft && d.kind === "offer" && d.valid_until && !d.signed_at
			? t`Valid until ${formatDate(d.valid_until, i18n.locale)}`
			: null,
	].filter(Boolean);

	return (
		<Box px={{ base: "md", sm: "lg" }} py="lg" data-testid="staff-document">
			<Stack gap="md" maw={860}>
				{/* Sticky, so Send stays in reach while reading a later page. */}
				<Group
					justify="space-between"
					align="flex-end"
					gap="sm"
					pos="sticky"
					top={0}
					py="xs"
					style={{ background: "var(--app-background)", zIndex: 5 }}
				>
					<Stack gap="xs" style={{ flex: "1 1 260px", minWidth: 0 }}>
						<Anchor
							component={I18nLink}
							to={`/admin/accounts/${orgId}`}
							size="sm"
							c="dimmed"
						>
							<Group gap={4}>
								<ArrowLeftIcon size={16} />
								{orgName || <Trans>Back to the account</Trans>}
							</Group>
						</Anchor>
						<Group gap="xs" wrap="nowrap">
							<Text truncate>{d.title}</Text>
							<Badge
								size="sm"
								variant="light"
								color={documentStatusColor(d)}
								style={{ flexShrink: 0 }}
								data-testid="staff-document-status"
							>
								{documentStatusLabel(d)}
							</Badge>
						</Group>
						<Text size="sm" c="dimmed">
							{facts.join(" · ")}
						</Text>
					</Stack>
					<Group gap="xs">
						{draftOffer && (
							<>
								<Button
									variant="default"
									onClick={() => setEditing(true)}
									data-testid="draft-change"
								>
									<Trans>Change</Trans>
								</Button>
								<Button
									variant="filled"
									onClick={() => setConfirming(true)}
									data-testid="draft-send"
								>
									<Trans>Send offer</Trans>
								</Button>
							</>
						)}
						{draft && !draftOffer && d.requires_signature && (
							<Button
								variant="default"
								component={I18nLink}
								to={`/admin/accounts/${orgId}/documents/${docId}/fields`}
							>
								<Trans>Place fields</Trans>
							</Button>
						)}
						{d.signed_pdf_url && (
							<Button
								variant="default"
								onClick={() => void openPdf(d.signed_pdf_url as string)}
							>
								<Trans>Open signed PDF</Trans>
							</Button>
						)}
					</Group>
				</Group>
				{draftOffer && (
					<Text size="sm" c="dimmed" data-testid="draft-note">
						<Trans>
							Only staff see this draft. When you send it, it gets that day's
							date and is valid for 14 days.
						</Trans>
					</Text>
				)}
				{d.customer_links && !d.signed_at && (
					<Stack gap="xs" data-testid="customer-links">
						<Text size="sm" c="dimmed">
							<Trans>
								No email went to the customer. Send them these links in your own
								email.
							</Trans>
						</Text>
						{d.customer_email && (
							<Box>
								<Button
									size="compact-sm"
									variant="subtle"
									onClick={() => setEmailOpen(true)}
									data-testid="show-email-again"
								>
									<Trans>Show the email again</Trans>
								</Button>
							</Box>
						)}
						{[
							{ label: t`Sign-in link`, value: d.customer_links.sign_in },
							{ label: t`Offer link`, value: d.customer_links.document },
						].map(({ label, value }) => (
							<Stack key={label} gap={0} style={{ minWidth: 0 }}>
								<Group gap="xs" align="center">
									<Text size="sm" c="dimmed">
										{label}
									</Text>
									<CopyButton value={value}>
										{({ copied, copy }) => (
											<Button
												size="compact-sm"
												variant="subtle"
												onClick={copy}
												aria-label={t`Copy ${label}`}
											>
												{copied ? <Trans>Copied</Trans> : <Trans>Copy</Trans>}
											</Button>
										)}
									</CopyButton>
								</Group>
								<Text size="sm" style={{ overflowWrap: "anywhere" }}>
									{value}
								</Text>
							</Stack>
						))}
					</Stack>
				)}
				{pdf.data ? (
					<PdfPages data={pdf.data} fileHref={fileHref} />
				) : pdf.isError ? (
					<Alert color="gray">
						<Trans>This document has no PDF.</Trans>
					</Alert>
				) : (
					<Loader size="sm" />
				)}
			</Stack>
			{draftOffer && (
				<SendOfferConfirmModal
					opened={confirming}
					orgName={orgName}
					loading={send.isPending}
					onCancel={() => setConfirming(false)}
					onApprove={() =>
						send.mutate(
							{ body: { notify: false }, params: { docId } },
							{
								onError: (e) => void notifyError(e),
								onSuccess: (sent) => {
									setConfirming(false);
									if (sent.customer_email) setEmailOpen(true);
									else
										toast.success(
											t`Offer sent. It is in the customer's account; no email went out.`,
										);
								},
							},
						)
					}
				/>
			)}
			<CustomerEmailModal
				opened={emailOpen}
				onClose={() => setEmailOpen(false)}
				email={d.customer_email}
				contactName={
					card.data?.members.find((m) => m.email === d.customer_email?.to)
						?.name ?? null
				}
			/>
			{draftOffer && (
				<PushOfferModal
					opened={editing}
					onClose={() => setEditing(false)}
					orgId={orgId}
					orgName={orgName}
					draft={d}
				/>
			)}
		</Box>
	);
}
