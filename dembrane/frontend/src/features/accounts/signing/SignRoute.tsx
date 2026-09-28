import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Box,
	Button,
	Checkbox,
	Container,
	Group,
	Image,
	Loader,
	Modal,
	Paper,
	Progress,
	Radio,
	Stack,
	Text,
	TextInput,
	ThemeIcon,
	Title,
	UnstyledButton,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { ArrowLeftIcon, CheckIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { useV2Me } from "@/hooks/useV2Me";
import { presentError } from "@/lib/errors/present";
import { AccountsApiError, call } from "../api/client";
import {
	accountKeys,
	useAccountsMutation,
	useDocument,
	usePdfData,
	usePdfHref,
} from "../api/hooks";
import type { DocumentDetailT, DocumentFieldT } from "../contract/contract.gen";
import { formatDateTime } from "../format";
import { AccountsI18n } from "../i18n";
import { type PageBox, PdfPages } from "../pdf/PdfPages";
import {
	asksDpaQuestion,
	confirmationTemplate,
	fillConfirmation,
	type Images,
	isFilled,
	nextStop,
	orderFields,
	previousField,
	progress,
	requestValues,
	todayForDocument,
	type Values,
} from "./fieldStepper";
import { type CapturedImage, SignatureCapture } from "./SignatureCapture";

/**
 * Signing: the document as it will be signed, its fields on the pages, and one panel at
 * the bottom that walks the signer field by field. It sits outside the dashboard chrome so
 * a named signer who is not a member lands on the document alone, on a phone as well.
 */
export const SignRoute = () => (
	<AccountsI18n>
		<SignScreen />
	</AccountsI18n>
);

const SignScreen = () => {
	const { organisationId, docId } = useParams<{
		organisationId: string;
		docId: string;
	}>();
	const { data: doc, isLoading, error } = useDocument(organisationId, docId);
	useDocumentTitle(doc ? `${doc.title} | dembrane` : t`Sign | dembrane`);

	return (
		<Box mih="100dvh" style={{ background: "var(--mantine-color-gray-1)" }}>
			{isLoading && (
				<Stack align="center" pt="20vh">
					<Loader />
				</Stack>
			)}
			{error && (
				<Container size="xs" pt="15vh">
					<Alert color="red">
						{error instanceof AccountsApiError && error.status === 403 ? (
							<Trans>
								This document is not shared with you. Sign in with the email
								address the link was sent to.
							</Trans>
						) : (
							<Trans>This document could not be loaded.</Trans>
						)}
					</Alert>
				</Container>
			)}
			{doc && organisationId && <Signing doc={doc} orgId={organisationId} />}
		</Box>
	);
};

function Header({
	doc,
	orgId,
	children,
}: {
	doc: DocumentDetailT;
	orgId: string;
	children?: React.ReactNode;
}) {
	return (
		<Paper
			radius={0}
			px="md"
			py="xs"
			withBorder
			pos="sticky"
			top={0}
			style={{ borderLeft: 0, borderRight: 0, borderTop: 0, zIndex: 20 }}
		>
			<Group justify="space-between" wrap="nowrap" maw={860} mx="auto" gap="sm">
				<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
					{doc.access !== "signer" && (
						<I18nLink
							to={`/o/${orgId}/account`}
							aria-label={t`Back to account`}
						>
							<ThemeIcon variant="subtle" color="gray" size="md">
								<ArrowLeftIcon size={18} />
							</ThemeIcon>
						</I18nLink>
					)}
					<Text fw={500} truncate>
						{doc.title}
					</Text>
				</Group>
				{children}
			</Group>
		</Paper>
	);
}

function Signing({ doc, orgId }: { doc: DocumentDetailT; orgId: string }) {
	const viewed = useRef(false);
	const queryClient = useQueryClient();
	useEffect(() => {
		// Marks the offer as viewed for the staff timeline, once per visit.
		if (viewed.current || doc.status !== "sent") return;
		viewed.current = true;
		call("viewDocument", { params: { docId: doc.id, orgId } })
			.then(() => queryClient.invalidateQueries({ queryKey: accountKeys.all }))
			.catch(() => {});
	}, [doc.id, doc.status, orgId, queryClient]);

	if (doc.status === "signed") return <Signed doc={doc} orgId={orgId} />;
	if (doc.status !== "sent" && doc.status !== "viewed") {
		return (
			<>
				<Header doc={doc} orgId={orgId} />
				<Container size="xs" pt="10vh">
					<Alert color="gray">
						{doc.status === "declined" ? (
							<Trans>
								This document was declined. Ask us a question on your account
								page if that was a mistake.
							</Trans>
						) : (
							<Trans>This document is no longer open for signing.</Trans>
						)}
					</Alert>
				</Container>
			</>
		);
	}
	return <Walk doc={doc} orgId={orgId} />;
}

function Walk({ doc, orgId }: { doc: DocumentDetailT; orgId: string }) {
	const { i18n } = useLingui();
	const { data: me } = useV2Me();
	const pdf = usePdfData(doc.file_url);
	const fileHref = usePdfHref(pdf.data ? doc.file_url : null);
	const fields = useMemo(() => orderFields(doc.fields), [doc.fields]);

	const [values, setValues] = useState<Values>(() => {
		const initial: Values = {};
		for (const f of doc.fields)
			if (f.kind === "date") initial[f.id] = todayForDocument();
		return initial;
	});
	const [signature, setSignature] = useState<CapturedImage | null>(null);
	const [initials, setInitials] = useState<CapturedImage | null>(null);
	const images: Images = {
		initials: Boolean(initials),
		signature: Boolean(signature),
	};
	const [visited, setVisited] = useState<Set<string>>(new Set());
	const [current, setCurrent] = useState<string | null>(null);
	const [finishing, setFinishing] = useState(false);
	const [dpa, setDpa] = useState<"yes" | "no" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [submitting, setSubmitting] = useState(false);
	const [signerOpen, setSignerOpen] = useState(false);
	const queryClient = useQueryClient();

	// The signer's name is the one thing we know; fill it once so they only check it.
	useEffect(() => {
		const name = me?.display_name;
		if (!name) return;
		setValues((v) => {
			const next = { ...v };
			for (const f of doc.fields)
				if (f.kind === "name" && !next[f.id]) next[f.id] = name;
			return next;
		});
	}, [me?.display_name, doc.fields]);

	const field = fields.find((f) => f.id === current) ?? null;
	const { done, total } = progress(fields, values, images);

	const goTo = (f: DocumentFieldT | null) => {
		setError(null);
		if (!f) {
			setCurrent(null);
			setFinishing(true);
			return;
		}
		setFinishing(false);
		setCurrent(f.id);
		setVisited((v) => new Set(v).add(f.id));
		requestAnimationFrame(() => {
			document
				.querySelector(`[data-field-id="${f.id}"]`)
				?.scrollIntoView({ behavior: "smooth", block: "center" });
		});
	};

	const next = () => goTo(nextStop(fields, values, images, current, visited));
	const back = () => {
		if (finishing) return goTo(fields[fields.length - 1] ?? null);
		const prev = previousField(fields, current);
		if (prev) goTo(prev);
	};

	const nameValue = (() => {
		const f = fields.find((x) => x.kind === "name");
		const v = f ? values[f.id] : "";
		return typeof v === "string" ? v : "";
	})();

	const asksDpa = asksDpaQuestion(doc);
	const template = confirmationTemplate(doc, dpa !== "no");
	const confirmation = template
		? fillConfirmation(template, fields, values)
		: null;
	const complete =
		nextStop(fields, values, images, null, new Set(fields.map((f) => f.id))) ===
		null;
	const canSign =
		complete &&
		Boolean(signature || !fields.some((f) => f.kind === "signature")) &&
		(!asksDpa || dpa !== null);

	const submit = async () => {
		if (!doc.sha256) return;
		setSubmitting(true);
		setError(null);
		try {
			const sig = signature ?? initials;
			if (!sig) throw new Error(t`Add your signature first.`);
			await call("signDocument", {
				body: {
					confirmation_text: confirmation ?? doc.title,
					dpa_authorised: dpa !== "no",
					initials: initials
						? { method: initials.method, png_base64: initials.png_base64 }
						: null,
					sha256: doc.sha256,
					signature: { method: sig.method, png_base64: sig.png_base64 },
					values: requestValues(fields, values),
				},
				params: { docId: doc.id, orgId },
			});
			await queryClient.invalidateQueries({ queryKey: accountKeys.all });
		} catch (e) {
			setError((await presentError(e, i18n)).message);
		} finally {
			setSubmitting(false);
		}
	};

	const overlay = (box: PageBox) =>
		fields
			.filter((f) => f.page === box.page)
			.map((f) => (
				<FieldBox
					key={f.id}
					field={f}
					box={box}
					active={f.id === current}
					filled={isFilled(f, values, images)}
					value={values[f.id]}
					image={
						f.kind === "signature"
							? signature
							: f.kind === "initials"
								? (initials ?? signature)
								: null
					}
					onClick={() => goTo(f)}
				/>
			));

	return (
		<>
			<Header doc={doc} orgId={orgId}>
				{doc.access === "member" && (
					<Anchor
						component="button"
						size="sm"
						onClick={() => setSignerOpen(true)}
						style={{ whiteSpace: "nowrap" }}
					>
						<Trans>Someone else signs</Trans>
					</Anchor>
				)}
			</Header>
			<Box maw={860} mx="auto" px={{ base: 8, sm: "md" }} pt="md" pb={360}>
				{pdf.data ? (
					<PdfPages data={pdf.data} overlay={overlay} fileHref={fileHref} />
				) : pdf.isError ? (
					<FileError
						missing={
							pdf.error instanceof AccountsApiError && pdf.error.status === 404
						}
						orgId={orgId}
						retrying={pdf.isFetching}
						onRetry={() => void pdf.refetch()}
						access={doc.access}
					/>
				) : (
					<Stack align="center" py="xl">
						<Loader size="sm" />
					</Stack>
				)}
			</Box>

			<Paper
				pos="fixed"
				bottom={0}
				left={0}
				right={0}
				radius={0}
				shadow="md"
				withBorder
				style={{ borderBottom: 0, borderLeft: 0, borderRight: 0, zIndex: 30 }}
			>
				<Box maw={860} mx="auto" px="md" pt="sm" pb="md">
					<Group gap="xs" mb={8} wrap="nowrap">
						<Progress
							value={total ? (done / total) * 100 : 100}
							size="sm"
							style={{ flex: 1 }}
							aria-label={t`Progress`}
						/>
						<Text
							size="xs"
							c="dimmed"
							data-testid="sign-progress"
							style={{ whiteSpace: "nowrap" }}
						>
							<Trans>
								{done} of {total} filled
							</Trans>
						</Text>
					</Group>

					{!field && !finishing && (
						<Stack gap="xs">
							<Text size="sm">
								{doc.signing_note ?? (
									<Trans>Your signature completes the agreement.</Trans>
								)}
							</Text>
							<Button size="md" onClick={next} data-testid="sign-start">
								<Trans>Start</Trans>
							</Button>
						</Stack>
					)}

					{field && (
						<FieldPanel
							key={field.id}
							field={field}
							value={values[field.id]}
							onValue={(v) => setValues((old) => ({ ...old, [field.id]: v }))}
							signature={signature}
							initials={initials}
							nameForSignature={nameValue}
							// Adopting a signature is the step's decision, so it also moves on.
							onSignature={(img) => {
								setSignature(img);
								goTo(
									nextStop(
										fields,
										values,
										{ ...images, signature: true },
										current,
										visited,
									),
								);
							}}
							onInitials={(img) => {
								setInitials(img);
								goTo(
									nextStop(
										fields,
										values,
										{ ...images, initials: true },
										current,
										visited,
									),
								);
							}}
							canGoBack={previousField(fields, current) !== null}
							onBack={back}
							onNext={next}
							nextDisabled={field.required && !isFilled(field, values, images)}
						/>
					)}

					{finishing && (
						<Stack gap="sm" data-testid="sign-finish">
							<Text fw={500}>
								<Trans>Review and sign</Trans>
							</Text>
							{!complete && (
								<Alert color="yellow" p="xs">
									<Group justify="space-between" gap="xs">
										<Text size="sm">
											<Trans>Some required fields are still empty.</Trans>
										</Text>
										<Button
											size="xs"
											variant="light"
											onClick={() =>
												goTo(
													nextStop(
														fields,
														values,
														images,
														null,
														new Set(fields.map((f) => f.id)),
													),
												)
											}
										>
											<Trans>Go to the next one</Trans>
										</Button>
									</Group>
								</Alert>
							)}
							{doc.signing_note && (
								<Text size="sm" c="dimmed">
									{doc.signing_note}
								</Text>
							)}
							{asksDpa && (
								<Radio.Group
									value={dpa}
									onChange={(v) => setDpa(v as "yes" | "no")}
									label={t`May you also agree to data processing for your organisation?`}
									description={t`If not, the data processing agreement becomes a separate document for someone who may.`}
								>
									<Stack gap={6} mt={6}>
										<Radio
											value="yes"
											label={t`Yes, I may`}
											data-testid="dpa-yes"
										/>
										<Radio
											value="no"
											label={t`No, someone else signs it`}
											data-testid="dpa-no"
										/>
									</Stack>
								</Radio.Group>
							)}
							{confirmation && (!asksDpa || dpa) && (
								<Paper withBorder p="xs" radius="sm" bg="gray.0">
									<Text
										size="sm"
										data-testid="sign-confirmation"
										style={{ overflowWrap: "anywhere" }}
									>
										{confirmation}
									</Text>
								</Paper>
							)}
							{error && (
								<Text size="sm" c="red">
									{error}
								</Text>
							)}
							<Group justify="space-between">
								<Button variant="default" onClick={back}>
									<Trans>Back</Trans>
								</Button>
								<Button
									size="md"
									disabled={!canSign}
									loading={submitting}
									onClick={submit}
									data-testid="sign-submit"
								>
									<Trans>Sign</Trans>
								</Button>
							</Group>
						</Stack>
					)}
				</Box>
			</Paper>

			<NameSignerModal
				opened={signerOpen}
				onClose={() => setSignerOpen(false)}
				orgId={orgId}
				docId={doc.id}
				locale={i18n.locale}
			/>
		</>
	);
}

function FieldBox({
	field,
	box,
	active,
	filled,
	value,
	image,
	onClick,
}: {
	field: DocumentFieldT;
	box: PageBox;
	active: boolean;
	filled: boolean;
	value: string | boolean | undefined;
	image: CapturedImage | null;
	onClick: () => void;
}) {
	const isImage = field.kind === "signature" || field.kind === "initials";
	const color = active
		? "#4169e1"
		: filled
			? "rgba(65,105,225,0.35)"
			: field.required
				? "#e8a33c"
				: "rgba(0,0,0,0.25)";
	return (
		<UnstyledButton
			onClick={onClick}
			data-field-id={field.id}
			data-filled={filled ? "true" : "false"}
			data-active={active ? "true" : undefined}
			aria-label={field.label}
			style={{
				alignItems: "center",
				background: active
					? "rgba(65,105,225,0.12)"
					: filled
						? "rgba(65,105,225,0.05)"
						: "rgba(255,209,102,0.25)",
				border: `1.5px ${filled ? "solid" : "dashed"} ${color}`,
				borderRadius: 3,
				display: "flex",
				height: box.height * field.height,
				left: box.width * field.x,
				minHeight: 14,
				overflow: "hidden",
				padding: "0 4px",
				position: "absolute",
				top: box.height * field.y,
				width: box.width * field.width,
			}}
		>
			{isImage && image ? (
				<img
					src={image.dataUrl}
					alt=""
					style={{ height: "100%", objectFit: "contain" }}
				/>
			) : filled && typeof value === "string" ? (
				<Text
					size="xs"
					truncate
					style={{
						fontSize: Math.max(
							9,
							Math.min(13, box.height * field.height * 0.62),
						),
					}}
				>
					{value}
				</Text>
			) : filled && value === true ? (
				<CheckIcon size={12} />
			) : (
				<Text
					size="xs"
					c="dimmed"
					truncate
					style={{
						fontSize: Math.max(
							8,
							Math.min(12, box.height * field.height * 0.55),
						),
					}}
				>
					{field.label}
				</Text>
			)}
		</UnstyledButton>
	);
}

function FieldPanel({
	field,
	value,
	onValue,
	signature,
	initials,
	nameForSignature,
	onSignature,
	onInitials,
	canGoBack,
	onBack,
	onNext,
	nextDisabled,
}: {
	field: DocumentFieldT;
	value: string | boolean | undefined;
	onValue: (v: string | boolean) => void;
	signature: CapturedImage | null;
	initials: CapturedImage | null;
	nameForSignature: string;
	onSignature: (img: CapturedImage | null) => void;
	onInitials: (img: CapturedImage | null) => void;
	canGoBack: boolean;
	onBack: () => void;
	onNext: () => void;
	nextDisabled: boolean;
}) {
	// The panel is keyed by field, so this resets when the walk moves on.
	const [redo, setRedo] = useState(false);
	const label = (
		<Group gap={6}>
			<Text fw={500} size="sm">
				{field.label}
			</Text>
			{!field.required && (
				<Text size="xs" c="dimmed">
					<Trans>Optional</Trans>
				</Text>
			)}
		</Group>
	);

	const nav = (
		<Group justify="space-between" mt="xs">
			<Button variant="default" onClick={onBack} disabled={!canGoBack}>
				<Trans>Back</Trans>
			</Button>
			<Button
				size="md"
				onClick={onNext}
				disabled={nextDisabled}
				data-testid="sign-next"
			>
				<Trans>Next</Trans>
			</Button>
		</Group>
	);

	if (field.kind === "signature" || field.kind === "initials") {
		const own = field.kind === "signature" ? signature : initials;
		const shown = own ?? (field.kind === "initials" ? signature : null);
		return (
			<Stack gap={6}>
				{label}
				{shown && !redo ? (
					<Group justify="space-between" wrap="nowrap">
						<Image
							src={shown.dataUrl}
							alt={field.label}
							h={56}
							w="auto"
							fit="contain"
						/>
						<Button variant="subtle" size="xs" onClick={() => setRedo(true)}>
							{field.kind === "initials" && !initials ? (
								<Trans>Draw initials instead</Trans>
							) : (
								<Trans>Change</Trans>
							)}
						</Button>
					</Group>
				) : (
					<SignatureCapture
						key={field.id}
						purpose={field.kind}
						suggestedText={nameForSignature}
						onCapture={(img) => {
							(field.kind === "signature" ? onSignature : onInitials)(img);
							setRedo(false);
						}}
					/>
				)}
				{field.kind === "signature" && shown && !redo && (
					<Text size="xs" c="dimmed">
						<Trans>
							Initials fields use this signature unless you draw initials.
						</Trans>
					</Text>
				)}
				{shown && !redo ? (
					nav
				) : (
					<Group mt="xs">
						<Button variant="default" onClick={onBack} disabled={!canGoBack}>
							<Trans>Back</Trans>
						</Button>
					</Group>
				)}
			</Stack>
		);
	}

	if (field.kind === "checkbox") {
		return (
			<Stack gap={6}>
				<Checkbox
					label={field.label}
					checked={value === true}
					onChange={(e) => onValue(e.currentTarget.checked)}
					size="md"
				/>
				{nav}
			</Stack>
		);
	}

	return (
		<Stack gap={6}>
			<TextInput
				key={field.id}
				label={label}
				size="md"
				autoFocus
				value={typeof value === "string" ? value : ""}
				onChange={(e) => onValue(e.currentTarget.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !nextDisabled) onNext();
				}}
				placeholder={field.kind === "date" ? "dd-mm-yyyy" : undefined}
				autoComplete={
					field.kind === "name"
						? "name"
						: field.key === "organisation"
							? "organization"
							: field.key === "address"
								? "street-address"
								: "off"
				}
				data-testid="sign-field-input"
			/>
			{nav}
		</Stack>
	);
}

function Signed({ doc, orgId }: { doc: DocumentDetailT; orgId: string }) {
	const { i18n } = useLingui();
	const href = usePdfHref(doc.signed_pdf_url);
	return (
		<>
			<Header doc={doc} orgId={orgId} />
			<Container size="xs" pt="10vh" px="md">
				<Stack align="center" gap="md" ta="center" data-testid="sign-result">
					<ThemeIcon size={56} radius="xl" color="green" variant="light">
						<CheckIcon size={28} />
					</ThemeIcon>
					<Title order={3} fw={400}>
						<Trans>Signed</Trans>
					</Title>
					<Text c="dimmed">
						{doc.signature ? (
							<Trans>
								{doc.signature.name} signed on{" "}
								{formatDateTime(doc.signature.signed_at, i18n.locale)}. The
								signed copy is in your documents.
							</Trans>
						) : (
							<Trans>The signed copy is in your documents.</Trans>
						)}
					</Text>
					<Group justify="center">
						<Button
							component="a"
							href={href ?? undefined}
							target="_blank"
							rel="noreferrer"
							disabled={!href}
							data-testid="signed-pdf-link"
						>
							<Trans>Open the signed PDF</Trans>
						</Button>
						{doc.access !== "signer" && (
							<Button
								component={I18nLink}
								to={`/o/${orgId}/account`}
								variant="default"
							>
								<Trans>Back to account</Trans>
							</Button>
						)}
					</Group>
				</Stack>
			</Container>
		</>
	);
}

function NameSignerModal({
	opened,
	onClose,
	orgId,
	docId,
}: {
	opened: boolean;
	onClose: () => void;
	orgId: string;
	docId: string;
	locale: string;
}) {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [role, setRole] = useState("");
	const mutation = useAccountsMutation("nameSigner", { docId, orgId });
	const fieldError = (key: string) =>
		mutation.error instanceof AccountsApiError
			? mutation.error.fields[key]
			: undefined;
	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={t`Someone else signs`}
			centered
		>
			<Stack gap="sm">
				<Text size="sm" c="dimmed">
					<Trans>We send them their own link to this document.</Trans>
				</Text>
				<TextInput
					label={t`Name`}
					value={name}
					onChange={(e) => setName(e.currentTarget.value)}
					error={fieldError("name")}
				/>
				<TextInput
					label={t`Email`}
					type="email"
					value={email}
					onChange={(e) => setEmail(e.currentTarget.value)}
					error={fieldError("email")}
				/>
				<TextInput
					label={t`Role`}
					description={t`Optional`}
					value={role}
					onChange={(e) => setRole(e.currentTarget.value)}
				/>
				<Group justify="flex-end">
					<Button
						loading={mutation.isPending}
						onClick={() =>
							mutation.mutate(
								{ body: { email, name, role } },
								{
									onSuccess: () => {
										toast.success(t`Sent to ${name}`);
										onClose();
									},
								},
							)
						}
					>
						<Trans>Send the link</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}

/**
 * The file behind the document did not arrive. A 404 means it is missing on our side,
 * which the signer cannot fix, so the next step is telling us; anything else may be the
 * connection, so the next step is trying again.
 */
function FileError({
	missing,
	orgId,
	retrying,
	onRetry,
	access,
}: {
	missing: boolean;
	orgId: string;
	retrying: boolean;
	onRetry: () => void;
	access: DocumentDetailT["access"];
}) {
	return (
		<Alert
			color={missing ? "orange" : "red"}
			data-testid={missing ? "pdf-missing" : "pdf-load-failed"}
		>
			<Stack gap="xs">
				<Text size="sm">
					{missing ? (
						<Trans>
							The file for this document is missing on our side, so it cannot be
							signed yet. Tell us with a question on your account page and we
							will send it again.
						</Trans>
					) : (
						<Trans>
							The document could not be loaded. Check your connection and try
							again.
						</Trans>
					)}
				</Text>
				<Group gap="xs">
					<Button
						size="xs"
						variant="light"
						loading={retrying}
						onClick={onRetry}
						data-testid="pdf-retry"
					>
						<Trans>Try again</Trans>
					</Button>
					{missing && access !== "signer" && (
						<Button
							size="xs"
							variant="subtle"
							component={I18nLink}
							to={`/o/${orgId}/account`}
						>
							<Trans>Go to the account page</Trans>
						</Button>
					)}
				</Group>
			</Stack>
		</Alert>
	);
}
