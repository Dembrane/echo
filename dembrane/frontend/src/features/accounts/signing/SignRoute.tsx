import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import {
	Alert,
	Box,
	Button,
	Checkbox,
	Container,
	Group,
	Image,
	Loader,
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
import { useDocumentTitle, useMediaQuery } from "@mantine/hooks";
import { ArrowLeftIcon, CheckIcon } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { useV2Me } from "@/hooks/useV2Me";
import { presentError } from "@/lib/errors/present";
import { AccountsApiError, call } from "../api/client";
import { accountKeys, useDocument, usePdfData, usePdfHref } from "../api/hooks";
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
 * Signing: the document as it will be signed, its fields on the pages, and one panel
 * beside it (below it on a phone) that walks the signer field by field. It sits outside
 * the dashboard chrome so a named signer who is not a member lands on the document alone,
 * on a phone as well.
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
		<Box mih="100dvh" style={{ background: "var(--app-quiet)" }}>
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
					<Text truncate>{doc.title}</Text>
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
	if (doc.access === "member" && doc.signer)
		return <MaybeWaiting doc={doc} orgId={orgId} signer={doc.signer} />;
	return <Walk doc={doc} orgId={orgId} />;
}

/**
 * Once someone else is named to sign, a member opening the link sees who it waits on, not
 * a signing walk that would refuse them at the end. The named person signs in their own
 * name, from their own invitation.
 */
function MaybeWaiting({
	doc,
	orgId,
	signer,
}: {
	doc: DocumentDetailT;
	orgId: string;
	signer: NonNullable<DocumentDetailT["signer"]>;
}) {
	const { data: me, isLoading } = useV2Me();
	if (isLoading)
		return (
			<Stack align="center" pt="20vh">
				<Loader />
			</Stack>
		);
	if (me?.email && me.email.toLowerCase() === signer.email.toLowerCase())
		return <Walk doc={doc} orgId={orgId} />;
	const name = signer.name || signer.email;
	return (
		<>
			<Header doc={doc} orgId={orgId} />
			<Container size="xs" pt="10vh">
				<Stack gap="md" data-testid="sign-waiting">
					<Title order={3}>
						<Trans>Waiting on {name} to sign</Trans>
					</Title>
					<Text>
						<Trans>
							We sent {signer.email} a link to sign {doc.title}. You'll see it
							signed on your account page.
						</Trans>
					</Text>
					<Group>
						<Button
							component={I18nLink}
							to={`/o/${orgId}/account`}
							size="md"
							variant="filled"
						>
							<Trans>Back to account</Trans>
						</Button>
					</Group>
				</Stack>
			</Container>
		</>
	);
}

/** Below the sticky header, so the panel and the field brought into view clear it. */
const HEADER_HEIGHT = 50;

/**
 * The signer's own values to start from: today's date, and the organisation and address
 * when we know them. Their name follows once their profile has loaded.
 */
const initialValues = (doc: DocumentDetailT): Values => {
	const initial: Values = {};
	for (const f of doc.fields) {
		if (f.kind === "date") initial[f.id] = todayForDocument();
		if (
			f.kind === "text" &&
			f.key === "organisation" &&
			doc.prefill.organisation
		)
			initial[f.id] = doc.prefill.organisation;
		if (f.kind === "text" && f.key === "address" && doc.prefill.address)
			initial[f.id] = doc.prefill.address;
	}
	return initial;
};

/**
 * The walk: the document on the left, scrolling, and on the right a panel that stays put
 * and always has one blue button saying what to do next. While a field is empty that
 * button names it ("Fill in your organisation"); pressing it says what is missing. The
 * field the panel asks for is brought to the middle of the screen. On a phone the panel
 * sits at the bottom instead.
 */
function Walk({ doc, orgId }: { doc: DocumentDetailT; orgId: string }) {
	const { i18n } = useLingui();
	const { data: me } = useV2Me();
	const wide = useMediaQuery("(min-width: 62em)") ?? false;
	const pdf = usePdfData(doc.file_url);
	// Only for showing the file when the browser cannot draw it; there is no download
	// before signing, only of the signed copy.
	const fileHref = usePdfHref(pdf.data ? doc.file_url : null);
	const fields = useMemo(() => orderFields(doc.fields), [doc.fields]);

	const [values, setValues] = useState<Values>(() => initialValues(doc));
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
		if (prev) return goTo(prev);
		// Before the first field is the start.
		setCurrent(null);
		setFinishing(false);
		window.scrollTo({ behavior: "smooth", top: 0 });
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
	const firstEmpty = nextStop(
		fields,
		values,
		images,
		null,
		new Set(fields.map((f) => f.id)),
	);
	const complete =
		firstEmpty === null &&
		Boolean(signature || !fields.some((f) => f.kind === "signature"));

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

	const panel = (
		<Stack gap="md" data-testid="sign-panel">
			<Group gap="xs" wrap="nowrap">
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
				<Stack gap="md">
					<Text>
						{doc.signing_note ?? (
							<Trans>Your signature completes the agreement.</Trans>
						)}
					</Text>
					<Button
						variant="filled"
						size="md"
						fullWidth
						onClick={next}
						data-testid="sign-start"
					>
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
					filled={isFilled(field, values, images)}
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
					onBack={back}
					onNext={next}
				/>
			)}

			{finishing && (
				<FinishStep
					doc={doc}
					complete={complete}
					asksDpa={asksDpa}
					dpa={dpa}
					onDpa={setDpa}
					confirmation={confirmation}
					error={error}
					submitting={submitting}
					onBack={back}
					onFill={() => goTo(firstEmpty)}
					onSign={submit}
				/>
			)}
		</Stack>
	);

	const pages = pdf.data ? (
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
	);

	return (
		<>
			<Header doc={doc} orgId={orgId} />
			{wide ? (
				<Group
					align="flex-start"
					gap="xl"
					wrap="nowrap"
					maw={1280}
					mx="auto"
					px="lg"
					py="lg"
				>
					<Box style={{ flex: 1, minWidth: 0 }} maw={860}>
						{pages}
					</Box>
					<Box
						w={380}
						style={{
							alignSelf: "flex-start",
							flexShrink: 0,
							position: "sticky",
							top: HEADER_HEIGHT + 24,
						}}
					>
						<Paper withBorder p="lg">
							{panel}
						</Paper>
					</Box>
				</Group>
			) : (
				<>
					<Box maw={860} mx="auto" px={8} pt="md" pb={380}>
						{pages}
					</Box>
					<Paper
						pos="fixed"
						bottom={0}
						left={0}
						right={0}
						shadow="md"
						withBorder
						style={{
							borderBottom: 0,
							borderLeft: 0,
							borderRight: 0,
							zIndex: 30,
						}}
					>
						<Box maw={860} mx="auto" px="md" pt="sm" pb="md">
							{panel}
						</Box>
					</Paper>
				</>
			)}
		</>
	);
}

/** Back on the left, the one primary action on the right, always on one row. */
function ActionRow({
	onBack,
	primary,
}: {
	onBack?: () => void;
	primary: ReactNode;
}) {
	return (
		<Group justify="space-between" wrap="nowrap" gap="sm">
			{onBack ? (
				<Button onClick={onBack} data-testid="sign-back">
					<Trans>Back</Trans>
				</Button>
			) : (
				<span />
			)}
			{primary}
		</Group>
	);
}

/**
 * What the blue button says while a field is empty, and what pressing it then says. In
 * the viewer's language: the field's own label is in the document's.
 */
function askFor(field: DocumentFieldT): { action: string; empty: string } {
	if (field.kind === "name")
		return { action: t`Fill in your name`, empty: t`Your name is empty.` };
	if (field.kind === "role")
		return {
			action: t`Fill in your job title`,
			empty: t`Your job title is empty.`,
		};
	if (field.kind === "date")
		return { action: t`Fill in the date`, empty: t`The date is empty.` };
	if (field.kind === "checkbox")
		return { action: t`Tick the box`, empty: t`The box is not ticked yet.` };
	switch (field.key) {
		case "organisation":
			return {
				action: t`Fill in your organisation`,
				empty: t`Your organisation is empty.`,
			};
		case "address":
			return {
				action: t`Fill in your address`,
				empty: t`Your address is empty.`,
			};
		case "vat_number":
			return {
				action: t`Fill in your VAT number`,
				empty: t`Your VAT number is empty.`,
			};
		case "po_number":
			return {
				action: t`Fill in your PO number`,
				empty: t`Your PO number is empty.`,
			};
	}
	const label = field.label;
	return { action: t`Fill in ${label}`, empty: t`${label} is empty.` };
}

function FieldPanel({
	field,
	value,
	onValue,
	filled,
	signature,
	initials,
	nameForSignature,
	onSignature,
	onInitials,
	onBack,
	onNext,
}: {
	field: DocumentFieldT;
	value: string | boolean | undefined;
	onValue: (v: string | boolean) => void;
	filled: boolean;
	signature: CapturedImage | null;
	initials: CapturedImage | null;
	nameForSignature: string;
	onSignature: (img: CapturedImage | null) => void;
	onInitials: (img: CapturedImage | null) => void;
	onBack: () => void;
	onNext: () => void;
}) {
	// The panel is keyed by field, so these reset when the walk moves on.
	const [redo, setRedo] = useState(false);
	const [tried, setTried] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const ask = askFor(field);
	const missing = field.required && !filled;
	const label = (
		<Group gap={6}>
			<Text size="sm">{field.label}</Text>
			{!field.required && (
				<Text size="xs" c="dimmed">
					<Trans>Optional</Trans>
				</Text>
			)}
		</Group>
	);

	const advance = () => {
		if (missing) {
			setTried(true);
			input.current?.focus();
			return;
		}
		onNext();
	};

	const row = (
		<ActionRow
			onBack={onBack}
			primary={
				<Button
					variant="filled"
					size="md"
					onClick={advance}
					data-testid="sign-next"
					data-missing={missing ? "true" : undefined}
				>
					{missing ? ask.action : <Trans>Next</Trans>}
				</Button>
			}
		/>
	);

	if (field.kind === "signature" || field.kind === "initials") {
		const own = field.kind === "signature" ? signature : initials;
		const shown = own ?? (field.kind === "initials" ? signature : null);
		if (!shown || redo)
			return (
				<Stack gap={6}>
					{label}
					<SignatureCapture
						key={field.id}
						purpose={field.kind}
						suggestedText={nameForSignature}
						onBack={onBack}
						onCapture={(img) => {
							(field.kind === "signature" ? onSignature : onInitials)(img);
							setRedo(false);
						}}
					/>
				</Stack>
			);
		return (
			<Stack gap="sm">
				{label}
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
				{field.kind === "signature" && (
					<Text size="xs" c="dimmed">
						<Trans>
							Initials fields use this signature unless you draw initials.
						</Trans>
					</Text>
				)}
				{row}
			</Stack>
		);
	}

	if (field.kind === "checkbox") {
		return (
			<Stack gap="sm">
				<Checkbox
					ref={input}
					label={field.label}
					checked={value === true}
					onChange={(e) => {
						onValue(e.currentTarget.checked);
						setTried(false);
					}}
					error={tried && missing ? ask.empty : undefined}
					size="md"
				/>
				{row}
			</Stack>
		);
	}

	return (
		<Stack gap="sm">
			<TextInput
				ref={input}
				key={field.id}
				label={label}
				size="md"
				autoFocus
				value={typeof value === "string" ? value : ""}
				onChange={(e) => {
					onValue(e.currentTarget.value);
					setTried(false);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") advance();
				}}
				error={tried && missing ? ask.empty : undefined}
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
			{row}
		</Stack>
	);
}

/**
 * The last step: the sentence the signature confirms, the data processing question on an
 * offer, and Sign. Until everything is filled and answered, the blue button names what is
 * left instead of signing.
 */
function FinishStep({
	doc,
	complete,
	asksDpa,
	dpa,
	onDpa,
	confirmation,
	error,
	submitting,
	onBack,
	onFill,
	onSign,
}: {
	doc: DocumentDetailT;
	complete: boolean;
	asksDpa: boolean;
	dpa: "yes" | "no" | null;
	onDpa: (v: "yes" | "no") => void;
	confirmation: string | null;
	error: string | null;
	submitting: boolean;
	onBack: () => void;
	onFill: () => void;
	onSign: () => void;
}) {
	const [tried, setTried] = useState(false);
	const unanswered = asksDpa && dpa === null;
	return (
		<Stack gap="sm" data-testid="sign-finish">
			<Text size="lg">
				<Trans>Review and sign</Trans>
			</Text>
			{!complete && (
				<Text size="sm" c="var(--app-warning)">
					<Trans>Some required fields are still empty.</Trans>
				</Text>
			)}
			{asksDpa && (
				<Radio.Group
					value={dpa}
					onChange={(v) => onDpa(v as "yes" | "no")}
					label={t`May you also agree to data processing for your organisation?`}
					description={t`If not, the data processing agreement becomes a separate document for someone who may.`}
					error={tried && unanswered ? t`Choose one to continue.` : undefined}
				>
					<Stack gap={6} mt={6}>
						<Radio value="yes" label={t`Yes, I may`} data-testid="dpa-yes" />
						<Radio
							value="no"
							label={t`No, someone else signs it`}
							data-testid="dpa-no"
						/>
					</Stack>
				</Radio.Group>
			)}
			{confirmation && !unanswered && (
				<Paper withBorder p="xs" bg="var(--app-quiet)">
					<Text
						size="sm"
						data-testid="sign-confirmation"
						style={{ overflowWrap: "anywhere" }}
					>
						{confirmation}
					</Text>
				</Paper>
			)}
			{complete && !unanswered && (
				<Text size="xs" c="dimmed" data-testid="sign-consent">
					<Trans>
						By selecting Sign, you sign electronically. Your electronic
						signature is as binding as one made by hand.
					</Trans>
				</Text>
			)}
			{error && (
				<Text size="sm" c="red">
					{error}
				</Text>
			)}
			<ActionRow
				onBack={onBack}
				primary={
					!complete ? (
						<Button
							variant="filled"
							size="md"
							onClick={onFill}
							data-testid="sign-fill-next"
						>
							<Trans>Fill in what is left</Trans>
						</Button>
					) : (
						<Button
							variant="filled"
							size="md"
							loading={submitting}
							disabled={!doc.sha256}
							onClick={() => {
								if (unanswered) return setTried(true);
								onSign();
							}}
							data-testid="sign-submit"
						>
							{unanswered ? (
								<Trans>Answer the question</Trans>
							) : (
								<Trans>Sign</Trans>
							)}
						</Button>
					)
				}
			/>
		</Stack>
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

function Signed({ doc, orgId }: { doc: DocumentDetailT; orgId: string }) {
	const { i18n } = useLingui();
	const href = usePdfHref(doc.signed_pdf_url);
	return (
		<>
			<Header doc={doc} orgId={orgId} />
			<Container size="xs" pt="10vh" px="md">
				<Stack align="center" gap="md" ta="center" data-testid="sign-result">
					<ThemeIcon size={56} color="green" variant="light">
						<CheckIcon size={28} />
					</ThemeIcon>
					<Title order={3}>
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
