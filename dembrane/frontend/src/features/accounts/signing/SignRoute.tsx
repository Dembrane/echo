import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Plural, Trans } from "@lingui/react/macro";
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
import {
	accountKeys,
	useDocument,
	useLegalHref,
	usePdfData,
	usePdfHref,
} from "../api/hooks";
import type { DocumentDetailT, DocumentFieldT } from "../contract/contract.gen";
import { DocumentPreview } from "../customer/DocumentPreview";
import { mayRemind, RemindSigner } from "../customer/RemindSigner";
import { SendToSomeoneElse } from "../customer/SendToSomeoneElse";
import { secondary } from "../customer/TaskLine";
import { FitLabel, fitting } from "../FitLabel";
import { formatDateTime, formatMoney } from "../format";
import { AccountsI18n } from "../i18n";
import { type PageBox, PdfPages } from "../pdf/PdfPages";
import {
	asksDpaQuestion,
	confirmationTemplate,
	documentDate,
	fillConfirmation,
	type Images,
	inputDate,
	isFilled,
	localIsoDate,
	nextStop,
	orderFields,
	previousField,
	progress,
	requestValues,
	todayForDocument,
	type Values,
} from "./fieldStepper";
import { DocumentLoadError } from "./DocumentLoadError";
import { clearDraft, readDraft, writeDraft } from "./signingDraft";
import { captureSigning, SIGNING_EVENTS } from "./signingEvents";
import { type CapturedImage, SignatureCapture } from "./SignatureCapture";

/**
 * Signing: the document as it will be signed, its fields on the pages, and one panel
 * beside it (below it on a phone) that walks the signer field by field. It sits outside
 * the dashboard chrome so a named signer who is not a member lands on the document alone,
 * on a phone as well.
 */
export const SignRoute = () => (
	<AccountsI18n signing>
		<SignScreen />
	</AccountsI18n>
);

const SignScreen = () => {
	const { organisationId, docId } = useParams<{
		organisationId: string;
		docId: string;
	}>();
	const {
		data: doc,
		isLoading,
		error,
		isFetching,
		refetch,
	} = useDocument(organisationId, docId);
	useDocumentTitle(doc ? `${doc.title} | dembrane` : t`Sign | dembrane`);

	return (
		<Box mih="100dvh" style={{ background: "var(--app-quiet)" }}>
			{isLoading && (
				<Stack align="center" pt="20vh">
					<Loader />
				</Stack>
			)}
			{error && (
				<DocumentLoadError
					error={error}
					orgId={organisationId ?? ""}
					docId={docId ?? ""}
					other={
						<Container size="xs" pt="15vh">
							<FileError
								missing={false}
								orgId={organisationId ?? ""}
								retrying={isFetching}
								onRetry={() => void refetch()}
								access="signer"
							/>
						</Container>
					}
				/>
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
	const { data: me } = useV2Me();
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
	// A document that asks for more than one signature: once the viewer's is in, or none
	// is left for the customer, they wait for the others.
	const signedByMe = doc.signatures.some(
		(s) => me?.email && s.email.toLowerCase() === me.email.toLowerCase(),
	);
	if (doc.awaiting_signatures.length && (signedByMe || !doc.fields.length))
		return <PartlySigned doc={doc} orgId={orgId} />;
	if (doc.access === "member" && doc.signer)
		return <MaybeWaiting doc={doc} orgId={orgId} signer={doc.signer} />;
	return <Walk doc={doc} orgId={orgId} />;
}

/** Signed by some, waiting for the rest: who signed, and whose signature comes next. */
function PartlySigned({ doc, orgId }: { doc: DocumentDetailT; orgId: string }) {
	const { i18n } = useLingui();
	const next = doc.awaiting_signatures.includes("dembrane")
		? t`dembrane signs next.`
		: t`Someone else from your organisation signs next.`;
	return (
		<>
			<Header doc={doc} orgId={orgId} />
			<Container size="xs" pt="10vh" px="md">
				<Stack align="center" gap="md" ta="center" data-testid="sign-partly">
					<Title order={3}>
						<Trans>Your signature is in</Trans>
					</Title>
					{doc.signatures.map((s) => {
						const when = formatDateTime(s.signed_at, i18n.locale);
						const name = s.name;
						return (
							<Text key={`${s.slot}-${s.email}`} c="dimmed">
								<Trans>
									{name} signed on {when}.
								</Trans>
							</Text>
						);
					})}
					<Text>{next}</Text>
					{doc.access !== "signer" && (
						<Button
							component={I18nLink}
							to={`/o/${orgId}/account`}
							variant="default"
						>
							<Trans>Back to account</Trans>
						</Button>
					)}
				</Stack>
			</Container>
		</>
	);
}

/**
 * Once someone else is named to sign, a member opening the link sees whom it is assigned
 * to, not a signing walk that would refuse them at the end, and can hand it to someone
 * else instead. The named person signs in their own name, from their own invitation.
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
	const [reassigning, setReassigning] = useState(false);
	if (isLoading)
		return (
			<Stack align="center" pt="20vh">
				<Loader />
			</Stack>
		);
	if (me?.email && me.email.toLowerCase() === signer.email.toLowerCase())
		return <Walk doc={doc} orgId={orgId} />;
	const name = signer.name || signer.email;
	const jobTitle = signer.role;
	const assignee = jobTitle ? `${name}, ${jobTitle}` : name;
	const email = signer.email;
	const firstName = signer.name?.split(" ")[0] || signer.email;
	const days =
		signer.named_at == null
			? null
			: Math.floor((Date.now() - Date.parse(signer.named_at)) / 864e5);
	// Read along, not sign: the document under a band saying whose it is. Nothing here is
	// the viewer's to finish, so there is no pill; Back is in the header.
	return (
		<>
			<Header doc={doc} orgId={orgId} />
			<Container size="md" py="xl">
				<Stack gap="md" data-testid="sign-waiting">
					<Stack gap={4}>
						<Title order={2} size="h4">
							{doc.title}
						</Title>
						<Text size="xs" c="dimmed" data-testid="sign-waiting-on">
							<Trans>Waiting on {assignee}</Trans>
							{" · "}
							{email}
							{days != null && (
								<>
									{" · "}
									{days < 1 ? (
										<Trans>sent today</Trans>
									) : (
										<Plural value={days} one="# day" other="# days" />
									)}
								</>
							)}
						</Text>
					</Stack>
					<Group gap="md">
						{mayRemind(signer) && (
							<RemindSigner orgId={orgId} docId={doc.id} name={firstName} />
						)}
						<Button
							{...secondary}
							onClick={() => setReassigning(true)}
							data-testid="sign-reassign"
						>
							<Trans>Send to someone else</Trans>
						</Button>
					</Group>
					<DocumentPreview doc={doc} who={assignee} />
				</Stack>
			</Container>
			<SendToSomeoneElse
				orgId={orgId}
				docId={doc.id}
				current={signer}
				opened={reassigning}
				onClose={() => setReassigning(false)}
			/>
		</>
	);
}

/** Below the sticky header, so the panel and the field brought into view clear it. */
const HEADER_HEIGHT = 50;

/**
 * The signer's own values to start from: today's date, the organisation and address when
 * we know them, and the reference the offer carries, to confirm or change. Their name
 * follows once their profile has loaded.
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
		if (f.kind === "text" && f.key === "po_number" && doc.prefill.po_number)
			initial[f.id] = doc.prefill.po_number;
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
	const allFields = useMemo(() => orderFields(doc.fields), [doc.fields]);
	// Exactly one option to pick: their tick boxes are one step, a choice between them.
	const pickOne = doc.content?.choose === "one";
	const optionFields = useMemo(
		() => allFields.filter(isOptionField),
		[allFields],
	);
	const fields = useMemo(() => {
		const first = optionFields[0];
		if (!pickOne || !first) return allFields;
		return allFields.flatMap((f) =>
			!isOptionField(f)
				? [f]
				: f.id === first.id
					? [{ ...f, id: PICK_STEP, label: t`Your choice`, required: true }]
					: [],
		);
	}, [allFields, optionFields, pickOne]);

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
	const draft = useSigningDraft({
		current,
		doc,
		fields: allFields,
		finishing,
		hasImage: Boolean(signature || initials),
		owner: me?.directus_user_id ?? null,
		pickOne,
		restore: (d) => {
			setValues((v) => ({ ...v, ...d.values }));
			setVisited(new Set(d.visited));
			if (d.finishing) setFinishing(true);
			else if (d.current) setCurrent(d.current);
			captureSigning(SIGNING_EVENTS.resumed, doc, {
				step_index: d.finishing
					? fields.length
					: Math.max(
							0,
							fields.findIndex((f) => f.id === d.current),
						),
			});
		},
		values,
		visited,
	});
	const step = stepOf(fields, current, finishing);
	useSigningEvents(doc, draft.started, step);

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
					values: requestValues(allFields, values),
				},
				params: { docId: doc.id, orgId },
			});
			draft.signed();
			signedDocs.add(doc.id);
			captureSigning(SIGNING_EVENTS.signed, doc);
			await queryClient.invalidateQueries({ queryKey: accountKeys.all });
		} catch (e) {
			setError((await presentError(e, i18n)).message);
		} finally {
			setSubmitting(false);
		}
	};

	const overlay = (box: PageBox) =>
		allFields
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
					onClick={() =>
						goTo(
							pickOne && isOptionField(f)
								? (fields.find((x) => x.id === PICK_STEP) ?? null)
								: f,
						)
					}
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
						onClick={() => {
							// Once per walk: back to the start and on again is not a new one.
							if (!draft.started) captureSigning(SIGNING_EVENTS.started, doc);
							draft.start();
							next();
						}}
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
					options={field.id === PICK_STEP ? optionFields : null}
					values={values}
					onPick={(id) =>
						setValues((old) => ({
							...old,
							[PICK_STEP]: true,
							...Object.fromEntries(
								optionFields.map((f) => [f.id, f.id === id]),
							),
						}))
					}
					signature={signature}
					initials={initials}
					nameForSignature={nameValue}
					dateRange={{
						max: localIsoDate(),
						min: doc.sent_at ? localIsoDate(new Date(doc.sent_at)) : undefined,
					}}
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
					choice={choiceLine(doc, optionFields, values, i18n.locale)}
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
						{/* Parchment with a quiet outline, so its white fields read as fields. */}
						<Paper
							p="lg"
							bg="var(--app-background)"
							style={{ border: "var(--app-stroke) solid var(--app-quiet)" }}
						>
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
						bg="var(--app-background)"
						style={{
							borderTop: "var(--app-stroke) solid var(--app-quiet)",
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

/** The step that stands for the tick boxes of an offer whose signer picks exactly one. */
const PICK_STEP = "pick-one-option";

/** Where the walk is, for the step events: its place and what kind of step it is. */
const stepOf = (
	fields: readonly DocumentFieldT[],
	current: string | null,
	finishing: boolean,
): { index: number; kind: string } | null => {
	if (finishing) return { index: fields.length, kind: "review" };
	const index = fields.findIndex((f) => f.id === current);
	const f = fields[index];
	if (!f) return null;
	return { index, kind: f.id === PICK_STEP ? "choice" : f.kind };
};

/**
 * Keeps what the signer filled in for this browser session (never the drawn signature),
 * puts it back after a reload, and warns before the page is left while something would be
 * lost: a drawn signature, or any input when the browser does not keep it.
 */
function useSigningDraft({
	doc,
	owner,
	fields,
	pickOne,
	values,
	current,
	finishing,
	visited,
	hasImage,
	restore,
}: {
	doc: DocumentDetailT;
	owner: string | null;
	fields: readonly DocumentFieldT[];
	pickOne: boolean;
	values: Values;
	current: string | null;
	finishing: boolean;
	visited: ReadonlySet<string>;
	hasImage: boolean;
	restore: (d: NonNullable<ReturnType<typeof readDraft>>) => void;
}) {
	const extraIds = useMemo(() => (pickOne ? [PICK_STEP] : []), [pickOne]);
	const restored = useRef(false);
	const [started, setStarted] = useState(false);
	const [kept, setKept] = useState(true);
	const done = useRef(false);
	const restoreRef = useRef(restore);
	restoreRef.current = restore;

	useEffect(() => {
		if (restored.current || !owner) return;
		restored.current = true;
		const d = readDraft(doc.id, {
			extraIds,
			fields,
			owner,
			sha256: doc.sha256,
		});
		if (!d) return;
		setStarted(true);
		restoreRef.current(d);
	}, [doc.id, doc.sha256, extraIds, fields, owner]);

	useEffect(() => {
		if (!owner || !restored.current || done.current) return;
		if (!started && current === null && !finishing) return;
		setKept(
			writeDraft(
				doc.id,
				{
					current,
					finishing,
					owner,
					sha256: doc.sha256,
					values,
					visited: [...visited],
				},
				fields,
				extraIds,
			),
		);
	}, [
		current,
		doc.id,
		doc.sha256,
		extraIds,
		fields,
		finishing,
		owner,
		started,
		values,
		visited,
	]);

	const unsaved =
		(started || current !== null || finishing) && (hasImage || !kept);
	useEffect(() => {
		if (!unsaved) return;
		const warn = (e: BeforeUnloadEvent) => {
			if (done.current) return;
			e.preventDefault();
			// Older browsers show the prompt only when returnValue is set.
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [unsaved]);

	return {
		signed: () => {
			done.current = true;
			clearDraft(doc.id);
		},
		start: () => setStarted(true),
		started: started || current !== null || finishing,
		unsaved,
	};
}

/**
 * The step events: each step once as it shows, and leaving before signing. Only the
 * document's id and kind and the step's place and kind; nothing the signer typed.
 */
function useSigningEvents(
	doc: DocumentDetailT,
	started: boolean,
	step: { index: number; kind: string } | null,
) {
	const ref = useMemo(
		() => ({ id: doc.id, kind: doc.kind }),
		[doc.id, doc.kind],
	);
	const last = useRef<{ index: number; kind: string } | null>(null);
	const index = step?.index ?? null;
	const kind = step?.kind ?? null;
	useEffect(() => {
		if (index === null || kind === null) return;
		last.current = { index, kind };
		captureSigning(SIGNING_EVENTS.stepViewed, ref, {
			step_index: index,
			step_kind: kind,
		});
	}, [index, kind, ref]);

	// Left before signing: the page closed, reloaded or was navigated away from.
	useEffect(() => {
		if (!started) return;
		// Mounted again straight after an unmount (React's development double mount, or
		// the same walk coming back): that unmount was not a leave.
		const pending = pendingLeave.get(ref.id);
		if (pending !== undefined) {
			clearTimeout(pending);
			pendingLeave.delete(ref.id);
		}
		const leave = () => {
			if (signedDocs.has(ref.id) || abandonedDocs.has(ref.id)) return;
			abandonedDocs.add(ref.id);
			captureSigning(SIGNING_EVENTS.abandoned, ref, {
				step_index: last.current?.index ?? 0,
			});
		};
		window.addEventListener("pagehide", leave);
		return () => {
			window.removeEventListener("pagehide", leave);
			// Deferred, so a mount that follows at once can call it off.
			pendingLeave.set(
				ref.id,
				setTimeout(() => {
					pendingLeave.delete(ref.id);
					leave();
				}, 0),
			);
		};
	}, [ref, started]);
}

/**
 * Per page life, by document: signed here, so leaving the thank-you screen is not
 * "abandoned"; already sent as abandoned, so it is sent once; and an unmount whose
 * abandoned event waits to see whether the walk mounts again.
 */
const signedDocs = new Set<string>();
const abandonedDocs = new Set<string>();
const pendingLeave = new Map<string, ReturnType<typeof setTimeout>>();

const isOptionField = (f: DocumentFieldT) =>
	f.kind === "checkbox" && Boolean(f.key?.startsWith("option:"));

/**
 * What the signer chose and what the offer then comes to, for the last step: the offer's
 * total with the chosen options' lines added. Null for an offer without options.
 */
function choiceLine(
	doc: DocumentDetailT,
	optionFields: readonly DocumentFieldT[],
	values: Values,
	locale: string,
): string | null {
	if (!optionFields.length || doc.total_cents == null || !doc.currency)
		return null;
	const chosen = optionFields
		.filter((f) => values[f.id] === true)
		.map((f) => f.label);
	const extra = (doc.lines ?? [])
		.filter((l) => l.option && chosen.includes(l.option))
		.reduce((sum, l) => sum + l.total_cents, 0);
	const total = formatMoney(doc.total_cents + extra, doc.currency, locale);
	if (!chosen.length) return t`No options chosen. Total ${total} incl. VAT.`;
	const names = chosen.join(", ");
	return t`You chose ${names}. Total ${total} incl. VAT.`;
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
				<Button
					onClick={onBack}
					data-testid="sign-back"
					style={{ flexShrink: 0 }}
				>
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
	dateRange,
	onSignature,
	onInitials,
	onBack,
	onNext,
	options = null,
	values = {},
	onPick = () => {},
}: {
	field: DocumentFieldT;
	value: string | boolean | undefined;
	onValue: (v: string | boolean) => void;
	filled: boolean;
	/** The options to pick exactly one of, on the step that stands for their tick boxes. */
	options?: readonly DocumentFieldT[] | null;
	values?: Values;
	onPick?: (fieldId: string) => void;
	signature: CapturedImage | null;
	initials: CapturedImage | null;
	nameForSignature: string;
	/** The days a date field accepts: from the day the document was sent to today. */
	dateRange: { min: string | undefined; max: string };
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
					{...fitting}
					variant="filled"
					size="md"
					onClick={advance}
					data-testid="sign-next"
					data-missing={missing ? "true" : undefined}
				>
					<FitLabel>{missing ? ask.action : <Trans>Next</Trans>}</FitLabel>
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

	if (options) {
		const picked = options.find((o) => values[o.id] === true)?.id ?? null;
		return (
			<Stack gap="sm">
				<Radio.Group
					value={picked}
					onChange={(v) => {
						onPick(v);
						setTried(false);
					}}
					label={t`Choose one`}
					error={tried && !picked ? t`Choose one to continue.` : undefined}
					data-testid="sign-choice"
				>
					<Stack gap={6} mt={6}>
						{options.map((o) => (
							<Radio key={o.id} value={o.id} label={o.label} />
						))}
					</Stack>
				</Radio.Group>
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

	const isDate = field.kind === "date";
	return (
		<Stack gap="sm">
			<TextInput
				ref={input}
				key={field.id}
				label={label}
				size="md"
				autoFocus
				// A date is picked, not typed; the document keeps it as day-month-year.
				type={isDate ? "date" : undefined}
				min={isDate ? dateRange.min : undefined}
				max={isDate ? dateRange.max : undefined}
				value={
					typeof value === "string" ? (isDate ? inputDate(value) : value) : ""
				}
				onChange={(e) => {
					const v = e.currentTarget.value;
					onValue(isDate ? documentDate(v) : v);
					setTried(false);
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter") advance();
				}}
				error={tried && missing ? ask.empty : undefined}
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
	choice,
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
	/** What the signer chose and the total it comes to; null without options. */
	choice: string | null;
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
			{choice && (
				<Text size="sm" data-testid="sign-choice-summary">
					{choice}
				</Text>
			)}
			<LegalDocuments doc={doc} />
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
							{...fitting}
							variant="filled"
							size="md"
							onClick={onFill}
							data-testid="sign-fill-next"
						>
							<FitLabel>
								<Trans>Fill in what is left</Trans>
							</FitLabel>
						</Button>
					) : (
						<Button
							{...fitting}
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
								<FitLabel>
									<Trans>Answer the question</Trans>
								</FitLabel>
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

/** What the agreement includes, as each text stood when the document was sent. */
const legalName = (kind: string) =>
	kind === "terms"
		? t`General terms and conditions`
		: kind === "sla"
			? t`Service level agreement`
			: t`Data processing agreement`;

/**
 * The legal documents the agreement is made of, each opening the version this document
 * pinned (the pages above are drawn on a canvas, so the links inside them do nothing). The
 * DPA is its own document: its text is the page being signed.
 */
export function LegalDocuments({ doc }: { doc: DocumentDetailT }) {
	const pins = doc.legal.filter((l) => l.text_url);
	if (doc.kind === "dpa" || pins.length === 0) return null;
	return (
		<Stack gap={4} data-testid="sign-documents">
			<Text size="sm">
				<Trans>Documents that form the agreement</Trans>
			</Text>
			{pins.map((pin) => (
				<LegalLink key={pin.kind} pin={pin} />
			))}
		</Stack>
	);
}

function LegalLink({ pin }: { pin: DocumentDetailT["legal"][number] }) {
	const href = useLegalHref(pin);
	const name = legalName(pin.kind);
	return (
		<Anchor
			href={href ?? undefined}
			target="_blank"
			rel="noreferrer"
			size="sm"
			data-testid={`sign-document-${pin.kind}`}
		>
			{name} ({pin.version})
		</Anchor>
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
	// Signed here or elsewhere: nothing half-filled is kept for it.
	useEffect(() => clearDraft(doc.id), [doc.id]);
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
