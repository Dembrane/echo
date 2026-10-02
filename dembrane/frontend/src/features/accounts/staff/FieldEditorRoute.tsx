import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Alert,
	Anchor,
	Badge,
	Box,
	Button,
	Group,
	Loader,
	Paper,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	TextInput,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { I18nLink } from "@/components/common/i18nLink";
import { toast } from "@/components/common/Toaster";
import { notifyError } from "@/components/error/notifyError";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { call } from "../api/client";
import { accountKeys, useDocument, usePdfData } from "../api/hooks";
import type { DocumentFieldT } from "../contract/contract.gen";
import { AccountsI18n } from "../i18n";
import { type PageBox, PdfPages } from "../pdf/PdfPages";
import { StaffOnly } from "./AccountCardRoute";

type Kind = DocumentFieldT["kind"];

/** A field being edited: the contract's input shape plus a local id for React. */
export interface DraftField {
	uid: string;
	page: number;
	x: number;
	y: number;
	width: number;
	height: number;
	kind: Kind;
	label: string;
	required: boolean;
	key: string | null;
}

const SIZE: Record<Kind, [number, number]> = {
	checkbox: [0.03, 0.022],
	date: [0.2, 0.025],
	initials: [0.12, 0.05],
	name: [0.4, 0.025],
	role: [0.4, 0.025],
	signature: [0.3, 0.06],
	text: [0.4, 0.025],
};

const kindLabel = (kind: Kind): string =>
	({
		checkbox: t`Checkbox`,
		date: t`Date`,
		initials: t`Initials`,
		name: t`Name`,
		role: t`Role`,
		signature: t`Signature`,
		text: t`Text`,
	})[kind];

const clamp = (v: number, min: number, max: number) =>
	Math.min(max, Math.max(min, v));

/**
 * Staff: place signing fields on an uploaded PDF, as in DocuSeal's template builder.
 * Add a field, drag it into place, resize it from its corner, set what it asks, save, send.
 */
export const FieldEditorRoute = () => (
	<AccountsI18n>
		<StaffOnly>
			<Editor />
		</StaffOnly>
	</AccountsI18n>
);

function Editor() {
	const { orgId, docId } = useParams<{ orgId: string; docId: string }>();
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const doc = useDocument(orgId, docId, true);
	const saved = useQuery({
		enabled: Boolean(orgId && docId),
		queryFn: () =>
			call("staffDocumentFields", {
				params: { docId: docId as string, orgId: orgId as string },
			}),
		queryKey: accountKeys.fields(orgId ?? "", docId ?? ""),
	});
	const pdf = usePdfData(doc.data?.file_url);
	const [fields, setFields] = useState<DraftField[] | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [dirty, setDirty] = useState(false);
	const [busy, setBusy] = useState<"save" | "send" | null>(null);
	const [page, setPage] = useState(1);
	useDocumentTitle(
		doc.data ? `${doc.data.title} | ${t`Fields`}` : t`Fields | dembrane`,
	);

	useEffect(() => {
		if (!saved.data || fields) return;
		setFields(
			saved.data.fields.map((f) => ({
				height: f.height,
				key: f.key,
				kind: f.kind,
				label: f.label,
				page: f.page,
				required: f.required,
				uid: f.id,
				width: f.width,
				x: f.x,
				y: f.y,
			})),
		);
	}, [saved.data, fields]);

	if (doc.isLoading || saved.isLoading || !fields)
		return <Loader m="xl" size="sm" />;
	if (!doc.data || !orgId || !docId) {
		return (
			<Alert color="red" m="xl">
				<Trans>This document could not be loaded.</Trans>
			</Alert>
		);
	}
	const editable = doc.data.status === "draft";
	const pageCount = saved.data?.page_count ?? doc.data.page_count ?? 1;
	const current = fields.find((f) => f.uid === selected) ?? null;
	// The backend refuses to send a document to sign without both: the name goes into the
	// signature record and the confirmation sentence.
	const hasSignature = fields.some((f) => f.kind === "signature");
	const hasName = fields.some((f) => f.kind === "name");
	const readyToSend = hasSignature && hasName;

	const change = (uid: string, patch: Partial<DraftField>) => {
		setFields((fs) =>
			(fs ?? []).map((f) => (f.uid === uid ? { ...f, ...patch } : f)),
		);
		setDirty(true);
	};

	const add = (kind: Kind) => {
		const [w, h] = SIZE[kind];
		const onPage = fields.filter((f) => f.page === page).length;
		const field: DraftField = {
			height: h,
			key: null,
			kind,
			label: kindLabel(kind),
			page,
			required: true,
			uid: crypto.randomUUID(),
			width: w,
			x: 0.1,
			y: clamp(0.1 + onPage * 0.07, 0, 1 - h),
		};
		setFields((fs) => [...(fs ?? []), field]);
		setSelected(field.uid);
		setDirty(true);
	};

	const save = async () => {
		setBusy("save");
		try {
			const res = await call("setDocumentFields", {
				body: {
					fields: fields.map((f) => ({
						height: f.height,
						key: f.kind === "text" ? f.key : null,
						kind: f.kind,
						label: f.label,
						page: f.page,
						required: f.required,
						signer_role: "signer" as const,
						width: f.width,
						x: f.x,
						y: f.y,
					})),
				},
				params: { docId, orgId },
			});
			queryClient.setQueryData(accountKeys.fields(orgId, docId), res);
			setFields(res.fields.map((f) => ({ ...f, uid: f.id })));
			setSelected(null);
			setDirty(false);
			toast.success(t`Fields saved`);
		} catch (e) {
			void notifyError(e);
		} finally {
			setBusy(null);
		}
	};

	const send = async () => {
		setBusy("send");
		try {
			await call("sendDocument", { params: { docId, orgId } });
			await queryClient.invalidateQueries({ queryKey: accountKeys.all });
			toast.success(t`Sent. The customer has a signing task.`);
			navigate(`/admin/accounts/${orgId}`);
		} catch (e) {
			void notifyError(e);
		} finally {
			setBusy(null);
		}
	};

	const overlay = (box: PageBox) =>
		fields
			.filter((f) => f.page === box.page)
			.map((f) => (
				<FieldHandle
					key={f.uid}
					field={f}
					box={box}
					selected={f.uid === selected}
					editable={editable}
					onSelect={() => {
						setSelected(f.uid);
						setPage(f.page);
					}}
					onChange={(patch) => change(f.uid, patch)}
				/>
			));

	return (
		<Box px={{ base: "md", sm: "lg" }} py="lg">
			<Stack gap="md">
				{/* Sticky, so Save and Send stay in reach while placing fields on a later page. */}
				<Group
					justify="space-between"
					gap="sm"
					pos="sticky"
					top={0}
					py="xs"
					style={{ background: "var(--app-background)", zIndex: 5 }}
				>
					<Stack gap={2} style={{ minWidth: 0 }}>
						<Anchor
							component={I18nLink}
							to={`/admin/accounts/${orgId}`}
							size="sm"
							c="dimmed"
						>
							<Group gap={4}>
								<ArrowLeftIcon size={14} />
								<Trans>Back to the account</Trans>
							</Group>
						</Anchor>
						<Group gap="xs">
							<Text truncate>{doc.data.title}</Text>
							<Badge
								size="sm"
								variant="light"
								color={editable ? "gray" : "blue"}
							>
								{editable ? t`Draft` : t`Sent`}
							</Badge>
						</Group>
					</Stack>
					{editable && (
						<Group gap="xs">
							<Button
								variant="default"
								onClick={save}
								disabled={!dirty}
								loading={busy === "save"}
								data-testid="fields-save"
							>
								<Trans>Save</Trans>
							</Button>
							<Button
								onClick={send}
								disabled={dirty || !readyToSend}
								loading={busy === "send"}
								data-testid="fields-send"
							>
								<Trans>Send to sign</Trans>
							</Button>
						</Group>
					)}
				</Group>
				{!editable && (
					<Alert color="gray" p="xs">
						<Trans>
							This document was sent. Its fields are fixed; send a new version
							to change them.
						</Trans>
					</Alert>
				)}

				<Group
					align="flex-start"
					gap="lg"
					wrap="nowrap"
					style={{ flexDirection: "row" }}
				>
					<Box
						style={{ flex: 1, maxWidth: 820, minWidth: 0 }}
						data-testid="field-editor-pages"
					>
						{pdf.data ? (
							<PdfPages data={pdf.data} overlay={overlay} />
						) : (
							<Loader size="sm" />
						)}
					</Box>
					{editable && (
						<Paper
							withBorder
							radius="md"
							p="sm"
							w={280}
							pos="sticky"
							top={88}
							style={{ flexShrink: 0 }}
							data-testid="field-panel"
						>
							<Stack gap="sm">
								<Stack gap={6}>
									<Group justify="space-between">
										<Text size="sm">
											<Trans>Add a field</Trans>
										</Text>
										<Select
											size="xs"
											w={96}
											aria-label={t`Page`}
											value={String(page)}
											onChange={(v) => v && setPage(Number(v))}
											data={Array.from({ length: pageCount }, (_, i) => ({
												label: t`Page ${i + 1}`,
												value: String(i + 1),
											}))}
											allowDeselect={false}
										/>
									</Group>
									<SimpleGrid cols={2} spacing={6}>
										{(
											[
												"signature",
												"initials",
												"name",
												"role",
												"date",
												"text",
												"checkbox",
											] as Kind[]
										).map((k) => (
											<Button
												key={k}
												size="xs"
												variant="light"
												onClick={() => add(k)}
												data-testid={`add-${k}`}
											>
												{kindLabel(k)}
											</Button>
										))}
									</SimpleGrid>
								</Stack>
								{current ? (
									<Stack gap="xs" data-testid="field-settings">
										<Select
											label={t`Kind`}
											size="xs"
											value={current.kind}
											onChange={(v) =>
												v && change(current.uid, { kind: v as Kind })
											}
											data={(Object.keys(SIZE) as Kind[]).map((k) => ({
												label: kindLabel(k),
												value: k,
											}))}
											allowDeselect={false}
										/>
										<TextInput
											label={t`Label`}
											size="xs"
											value={current.label}
											onChange={(e) =>
												change(current.uid, { label: e.currentTarget.value })
											}
											data-testid="field-label"
										/>
										{current.kind === "text" && (
											<Select
												label={t`Asks for`}
												description={t`So the signature record can read it`}
												size="xs"
												clearable
												value={current.key}
												onChange={(v) => change(current.uid, { key: v })}
												data={[
													{ label: t`Organisation`, value: "organisation" },
													{ label: t`Address`, value: "address" },
													{ label: t`VAT number`, value: "vat_number" },
													{ label: t`PO number`, value: "po_number" },
												]}
											/>
										)}
										<Switch
											label={t`Required`}
											size="xs"
											checked={current.required}
											onChange={(e) =>
												change(current.uid, {
													required: e.currentTarget.checked,
												})
											}
										/>
										<Button
											size="xs"
											variant="subtle"
											color="red"
											onClick={() => {
												setFields((fs) =>
													(fs ?? []).filter((f) => f.uid !== current.uid),
												);
												setSelected(null);
												setDirty(true);
											}}
										>
											<Trans>Remove field</Trans>
										</Button>
									</Stack>
								) : (
									<Text size="xs" c="dimmed">
										<Trans>
											Select a field to set its kind, label and whether it is
											required. Drag to move, pull the corner to resize.
										</Trans>
									</Text>
								)}
								<Text size="xs" c="dimmed">
									<Plural
										value={fields.length}
										one="# field"
										other="# fields"
									/>
								</Text>
								{!readyToSend && (
									<Text size="xs" c="orange.8" data-testid="send-blocked">
										{!hasName && !hasSignature ? (
											<Trans>
												To send, add a name field and a signature field.
											</Trans>
										) : !hasName ? (
											<Trans>
												To send, add a name field: it names the signer.
											</Trans>
										) : (
											<Trans>To send, add a signature field.</Trans>
										)}
									</Text>
								)}
							</Stack>
						</Paper>
					)}
				</Group>
			</Stack>
		</Box>
	);
}

/** A placed field: drag the body to move it, the corner to resize it, in page fractions. */
function FieldHandle({
	field,
	box,
	selected,
	editable,
	onSelect,
	onChange,
}: {
	field: DraftField;
	box: PageBox;
	selected: boolean;
	editable: boolean;
	onSelect: () => void;
	onChange: (patch: Partial<DraftField>) => void;
}) {
	const start = useRef<{
		px: number;
		py: number;
		f: DraftField;
		mode: "move" | "resize";
	} | null>(null);

	const onPointerDown =
		(mode: "move" | "resize") => (e: React.PointerEvent) => {
			e.stopPropagation();
			onSelect();
			if (!editable) return;
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			start.current = { f: field, mode, px: e.clientX, py: e.clientY };
		};
	const onPointerMove = (e: React.PointerEvent) => {
		const s = start.current;
		if (!s) return;
		const dx = (e.clientX - s.px) / box.width;
		const dy = (e.clientY - s.py) / box.height;
		if (s.mode === "move") {
			onChange({
				x: clamp(s.f.x + dx, 0, 1 - s.f.width),
				y: clamp(s.f.y + dy, 0, 1 - s.f.height),
			});
		} else {
			onChange({
				height: clamp(s.f.height + dy, 0.012, 1 - s.f.y),
				width: clamp(s.f.width + dx, 0.02, 1 - s.f.x),
			});
		}
	};
	const onPointerUp = () => {
		start.current = null;
	};

	return (
		<Box
			onPointerDown={onPointerDown("move")}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			data-testid="placed-field"
			data-kind={field.kind}
			style={{
				background: selected
					? "rgba(65,105,225,0.18)"
					: "rgba(65,105,225,0.08)",
				border: `1.5px solid ${selected ? "#4169e1" : "rgba(65,105,225,0.5)"}`,
				borderRadius: 3,
				cursor: editable ? "move" : "default",
				height: box.height * field.height,
				left: box.width * field.x,
				overflow: "visible",
				position: "absolute",
				top: box.height * field.y,
				touchAction: "none",
				userSelect: "none",
				width: box.width * field.width,
			}}
		>
			<Text
				size="xs"
				c="blue.8"
				px={4}
				truncate
				style={{
					fontSize: 10,
					lineHeight: `${Math.max(12, box.height * field.height - 3)}px`,
				}}
			>
				{field.label}
				{field.required ? " *" : ""}
			</Text>
			{editable && selected && (
				<Box
					onPointerDown={onPointerDown("resize")}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					data-testid="resize-handle"
					style={{
						background: "#4169e1",
						borderRadius: 2,
						bottom: -5,
						cursor: "nwse-resize",
						height: 10,
						position: "absolute",
						right: -5,
						width: 10,
					}}
				/>
			)}
		</Box>
	);
}
