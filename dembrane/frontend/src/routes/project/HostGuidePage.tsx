/** biome-ignore-all lint/a11y/noStaticElementInteractions: TODO */
import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Button,
	Group,
	Menu,
	Skeleton,
	Switch,
	Text,
} from "@mantine/core";
import { useDebouncedValue, useWindowEvent } from "@mantine/hooks";
import {
	ArrowsOutIcon,
	DotsSixVerticalIcon,
	PlusIcon,
	PrinterIcon,
	TrashIcon,
} from "@phosphor-icons/react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { QRCode as QRCodeLogo } from "react-qrcode-logo";
import { useParams, useSearchParams } from "react-router";
import { lightRoles as roles } from "@/colors";
import {
	useProjectById,
	useUpdateProjectHostGuideMutation,
} from "@/components/project/hooks";
import { useProjectSharingLink } from "@/components/project/ProjectQRCode";
import {
	type ActiveConversation,
	useLiveConversations,
} from "@/hooks/useLiveConversations";
import { openConfirm } from "@/lib/openConfirm";

// ============================================================================
// DESIGN SYSTEM - the app's roles and type ladder, as inline values because
// this page is a print document: it stays light in dark mode, and its QR
// canvases need real colours
// ============================================================================

const colors = {
	action: roles.action,
	graphite: roles.text,
	live: roles.danger,
	muted: roles.muted,
	parchment: roles.bg,
	quiet: roles.quiet,
	surface: roles.surface,
};

// Type ladder (perfect fourth from 14px): 14 / 16 / 18.66 / 24.88 / 33.17 / 44.2
const type = {
	body: { lineHeight: 1.4, size: "18.66px" },
	display: { lineHeight: 1.1, size: "44.2px" },
	headline: { lineHeight: 1.2, size: "33.17px" },
	small: { lineHeight: 1.4, size: "14px" },
	title: { lineHeight: 1.3, size: "24.88px" },
};

// Spacing on the 4 / 8 / 16 / 24 / 32 scale; the page margin is two steps of 32
const space = {
	afterDisplay: "32px", // gap after project name
	afterHeadline: "24px",
	beforeTips: "8px",
	betweenColumns: "32px",
	betweenSteps: "24px",
	betweenTips: "16px",
	page: "64px", // page margin on screen
};

// ============================================================================
// TYPES
// ============================================================================

type TipItem =
	| { text: string }
	| {
			before: string;
			button: string;
			after: string;
			button2: string;
			after2: string;
	  };
type StepItem =
	| { text: string }
	| {
			before: string;
			button: string;
			after?: string;
			button2?: string;
			after2?: string;
	  };

// Editable item with custom highlights
type EditableStep = {
	content: StepItem | string;
	highlights: string[];
};
type EditableTip = {
	content: TipItem | string;
	highlights: string[];
};

// Button keywords to auto-highlight (all languages)
const BUTTON_KEYWORDS = [
	// English
	"Record",
	"Stop",
	"Start",
	"Finish",
	"Resume",
	"Pause",
	// Dutch
	"Opname",
	"starten",
	"Starten",
	"Stoppen",
	"Afronden",
	"Hervatten",
	// German
	"Aufnahme",
	"Beenden",
	"Fortsetzen",
	// French
	"Enregistrer",
	"Terminer",
	"Reprendre",
	"Démarrer",
	// Spanish
	"Grabar",
	"Detener",
	"Finalizar",
	"Continuar",
	"Iniciar",
	// Italian
	"Registra",
	"Termina",
	"Riprendi",
	"Inizia",
];

// Highlight button keywords in text (includes custom words)
const highlightKeywords = (
	text: string,
	customWords: string[] = [],
): ReactNode => {
	const allKeywords = [...BUTTON_KEYWORDS, ...customWords];
	if (allKeywords.length === 0) return text;

	const escaped = allKeywords.map((w) =>
		w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
	);
	const pattern = new RegExp(`\\b(${escaped.join("|")})\\b`, "g");
	const parts = text.split(pattern);

	return parts.map((part) => {
		if (allKeywords.includes(part)) {
			return (
				<span key={part} style={{ color: colors.action, fontStyle: "italic" }}>
					{part}
				</span>
			);
		}
		return part;
	});
};

// Get selected word for context menu
const getSelectedWord = (): string | null => {
	const selection = window.getSelection();
	if (!selection || selection.rangeCount === 0) return null;
	const text = selection.toString().trim();
	// Only return single words (no spaces)
	if (text && !text.includes(" ") && text.length > 0) {
		return text;
	}
	return null;
};

// ============================================================================
// DEFAULT TRANSLATIONS
// Button names styled inline in the action blue
// ============================================================================

const defaultTranslations = {
	de: {
		steps: [
			{ text: "QR-Code scannen" },
			{ text: "Namen oder Thema eingeben" },
			{ after: " drücken", before: "Auf ", button: "Aufnahme" },
			{
				after: " und ",
				after2: " drücken",
				before: "Fertig? ",
				button: "Stop",
				button2: "Beenden",
			},
		] as StepItem[],
		stepsNoName: [
			{ text: "QR-Code scannen" },
			{ after: " tippen", before: "Auf ", button: "Start" },
			{ after: " drücken", before: "Auf ", button: "Aufnahme" },
			{
				after: " und ",
				after2: " drücken",
				before: "Fertig? ",
				button: "Stop",
				button2: "Beenden",
			},
		] as StepItem[],
		tips: [
			{ text: "Bildschirm muss an bleiben" },
			{
				after: " drücken dann ",
				after2: "",
				before: "Pause nötig? ",
				button: "Stop",
				button2: "Fortsetzen",
			},
			{ text: "Energiesparmodus ausschalten" },
			{
				text: "Fokus-/Nicht-Stören-Modus aktivieren, um Benachrichtigungen auf dem Bildschirm zu vermeiden",
			},
		],
		title: "So nehmen Sie auf",
	},
	en: {
		steps: [
			{ text: "Scan the QR code" },
			{ text: "Enter your name or topic" },
			{ before: "Hit ", button: "Record" },
			{
				after: " and ",
				before: "Done? Press ",
				button: "Stop",
				button2: "Finish",
			},
		] as StepItem[],
		stepsNoName: [
			{ text: "Scan the QR code" },
			{ before: "Tap ", button: "Start" },
			{ before: "Hit ", button: "Record" },
			{
				after: " and ",
				before: "Done? Press ",
				button: "Stop",
				button2: "Finish",
			},
		] as StepItem[],
		tips: [
			{ text: "Keep your screen on during recording" },
			{
				after: " then ",
				after2: " when ready",
				before: "Need a break? Press ",
				button: "Stop",
				button2: "Resume",
			},
			{ text: "Turn off battery saver" },
			{
				text: "Turn on privacy/focus mode to avoid notifications from showing on your screen",
			},
		],
		title: "How to record",
	},
	es: {
		steps: [
			{ text: "Escanea el código QR" },
			{ text: "Ingresa tu nombre o tema" },
			{ before: "Presiona ", button: "Grabar" },
			{
				after: " y ",
				before: "¿Listo? Presiona ",
				button: "Detener",
				button2: "Finalizar",
			},
		] as StepItem[],
		stepsNoName: [
			{ text: "Escanea el código QR" },
			{ before: "Toca ", button: "Iniciar" },
			{ before: "Presiona ", button: "Grabar" },
			{
				after: " y ",
				before: "¿Listo? Presiona ",
				button: "Detener",
				button2: "Finalizar",
			},
		] as StepItem[],
		tips: [
			{ text: "Mantén la pantalla encendida" },
			{
				after: " luego ",
				after2: "",
				before: "¿Necesitas un descanso? Presiona ",
				button: "Detener",
				button2: "Continuar",
			},
			{ text: "Desactiva el ahorro de batería" },
			{
				text: "Activa el modo de concentración/privacidad para evitar que las notificaciones aparezcan en la pantalla",
			},
		],
		title: "Cómo grabar",
	},
	fr: {
		steps: [
			{ text: "Scannez le QR code" },
			{ text: "Entrez votre nom ou sujet" },
			{ before: "Appuyez sur ", button: "Enregistrer" },
			{
				after: " et ",
				before: "Terminé? Appuyez sur ",
				button: "Stop",
				button2: "Terminer",
			},
		] as StepItem[],
		stepsNoName: [
			{ text: "Scannez le QR code" },
			{ before: "Appuyez sur ", button: "Démarrer" },
			{ before: "Appuyez sur ", button: "Enregistrer" },
			{
				after: " et ",
				before: "Terminé? Appuyez sur ",
				button: "Stop",
				button2: "Terminer",
			},
		] as StepItem[],
		tips: [
			{ text: "Gardez votre écran allumé" },
			{
				after: " puis ",
				after2: "",
				before: "Besoin d'une pause? Appuyez sur ",
				button: "Stop",
				button2: "Reprendre",
			},
			{ text: "Désactivez le mode économie d'énergie" },
			{
				text: "Activez le mode concentration/confidentialité pour éviter que les notifications ne s'affichent à l'écran",
			},
		],
		title: "Comment enregistrer",
	},
	it: {
		steps: [
			{ text: "Scansiona il codice QR" },
			{ text: "Inserisci il tuo nome o argomento" },
			{ before: "Premi ", button: "Registra" },
			{
				after: " e ",
				before: "Finito? Premi ",
				button: "Stop",
				button2: "Termina",
			},
		] as StepItem[],
		stepsNoName: [
			{ text: "Scansiona il codice QR" },
			{ before: "Tocca ", button: "Inizia" },
			{ before: "Premi ", button: "Registra" },
			{
				after: " e ",
				before: "Finito? Premi ",
				button: "Stop",
				button2: "Termina",
			},
		] as StepItem[],
		tips: [
			{ text: "Tieni lo schermo acceso" },
			{
				after: " poi ",
				after2: "",
				before: "Hai bisogno di una pausa? Premi ",
				button: "Stop",
				button2: "Riprendi",
			},
			{ text: "Disattiva il risparmio energetico" },
			{
				text: "Attiva la modalità concentrazione/privacy per evitare che le notifiche appaiano sullo schermo",
			},
		],
		title: "Come registrare",
	},
	nl: {
		steps: [
			{ text: "Scan de QR-code" },
			{ text: "Vul je naam of onderwerp in" },
			{ before: "Druk op ", button: "Opname starten" },
			{
				after: " en ",
				before: "Klaar? Druk op ",
				button: "Stoppen",
				button2: "Afronden",
			},
		] as StepItem[],
		stepsNoName: [
			{ text: "Scan de QR-code" },
			{ before: "Tik op ", button: "Starten" },
			{ before: "Druk op ", button: "Opname starten" },
			{
				after: " en ",
				before: "Klaar? Druk op ",
				button: "Stoppen",
				button2: "Afronden",
			},
		] as StepItem[],
		tips: [
			{ text: "Houd je scherm aan tijdens de opname" },
			{
				after: " dan ",
				after2: " als je klaar bent",
				before: "Pauze nodig? Druk op ",
				button: "Stoppen",
				button2: "Hervatten",
			},
			{ text: "Zet batterijbesparing uit" },
			{
				text: "Zet privacy/focusmodus aan om te voorkomen dat meldingen op je scherm verschijnen",
			},
		],
		title: "Hoe neem je op",
	},
} as const;

type LanguageCode = keyof typeof defaultTranslations;

// Data state type for the host guide
type HostGuideData = {
	title: string;
	steps: EditableStep[];
	tips: EditableTip[];
};

// Persisted on project.host_guide; a language switch falls back to defaults
type StoredHostGuide = HostGuideData & { language: string };

const parseStoredGuide = (
	raw: unknown,
	language: string,
): HostGuideData | null => {
	if (!raw || typeof raw !== "object") return null;
	const guide = raw as Partial<StoredHostGuide>;
	if (guide.language !== language) return null;
	if (typeof guide.title !== "string") return null;
	if (!guide.steps?.length || !guide.tips?.length) return null;
	return { steps: guide.steps, tips: guide.tips, title: guide.title };
};

// ============================================================================
// PRINT STYLES - Uniform margins
// ============================================================================

const printStyles = `
@media print {
  @page {
    size: A4 landscape;
    margin: 12mm;
  }
  html, body {
    background: #ffffff !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  .no-print { display: none !important; }
  .print-only { display: block !important; }
  .print-page {
    height: auto !important;
    padding: 32px !important;
    background: #ffffff !important;
  }
  .qr-screen { display: none !important; }
  .qr-print { display: block !important; }
}
@media screen {
  .print-only { display: none !important; }
  .qr-print { display: none !important; }
}
`;

// ============================================================================
// COMPONENTS
// ============================================================================

// Helper to render step content with auto-highlighted button keywords + custom highlights
const renderStepContent = (
	step: StepItem | string,
	customHighlights: string[] = [],
) => {
	// For strings, auto-highlight known button keywords + custom
	if (typeof step === "string") {
		return highlightKeywords(step, customHighlights);
	}
	if ("text" in step) {
		return highlightKeywords(step.text, customHighlights);
	}
	// For structured items, use explicit styling for buttons + highlight custom words in other parts
	return (
		<>
			{highlightKeywords(step.before, customHighlights)}
			<span style={{ color: colors.action, fontStyle: "italic" }}>
				{step.button}
			</span>
			{step.after && highlightKeywords(step.after, customHighlights)}
			{step.button2 && (
				<span style={{ color: colors.action, fontStyle: "italic" }}>
					{step.button2}
				</span>
			)}
			{step.after2 && highlightKeywords(step.after2, customHighlights)}
		</>
	);
};

// Get plain text from step for editing
const getStepText = (step: StepItem | string): string => {
	if (typeof step === "string") return step;
	if ("text" in step) return step.text;
	return `${step.before}${step.button}${step.after || ""}${step.button2 || ""}${step.after2 || ""}`;
};

// Get content from editable step (handles both old and new format)

// Get highlights from editable step

const StepRow = ({
	id,
	number,
	step,
	highlights,
	onChange,
	onContextMenu,
	onDelete,
	showDelete,
}: {
	id: string;
	number: number;
	step: StepItem | string;
	highlights: string[];
	onChange: (v: string) => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onDelete?: () => void;
	showDelete?: boolean;
}) => {
	const [hovered, setHovered] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const textValue = getStepText(step);

	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });

	const style = {
		opacity: isDragging ? 0.5 : 1,
		transform: CSS.Transform.toString(transform),
		transition,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<div
				style={{
					alignItems: "baseline",
					display: "flex",
					marginBottom: space.betweenSteps,
					position: "relative",
				}}
			>
				<div
					{...attributes}
					{...listeners}
					className="no-print"
					style={{
						alignItems: "center",
						cursor: "grab",
						display: "flex",
						left: "-24px",
						opacity: hovered ? 0.4 : 0,
						position: "absolute",
						top: "4px",
						transition: "opacity 0.15s",
					}}
				>
					<DotsSixVerticalIcon size={16} color={colors.graphite} />
				</div>
				<span
					style={{
						color: colors.action,
						flexShrink: 0,
						fontSize: type.title.size,
						lineHeight: type.title.lineHeight,
						width: "40px",
					}}
				>
					{number}.
				</span>
				<span
					contentEditable
					suppressContentEditableWarning
					onFocus={() => setIsEditing(true)}
					onContextMenu={onContextMenu}
					onBlur={(e) => {
						setIsEditing(false);
						const newVal = (e.target as HTMLElement).innerText;
						if (newVal !== textValue) onChange(newVal);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							(e.target as HTMLElement).blur();
						}
					}}
					style={{
						backgroundColor: hovered ? colors.quiet : "transparent",
						color: colors.graphite,
						cursor: isEditing ? "text" : "pointer",
						flex: 1,
						fontSize: type.title.size,
						lineHeight: type.title.lineHeight,
						margin: "-4px -8px",
						outline: "none",
						padding: "4px 8px",
						transition: "background-color 0.15s",
					}}
				>
					{isEditing ? textValue : renderStepContent(step, highlights)}
				</span>
				{showDelete && onDelete && (
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						onClick={onDelete}
						className="no-print"
						style={{
							marginLeft: "8px",
							opacity: hovered ? 0.5 : 0,
							transition: "opacity 0.15s",
						}}
					>
						<TrashIcon size={20} />
					</ActionIcon>
				)}
			</div>
		</div>
	);
};

// Helper to render tip content with auto-highlighted button keywords + custom highlights
const renderTipContent = (
	tip: TipItem | string,
	customHighlights: string[] = [],
) => {
	// For strings, auto-highlight known button keywords + custom
	if (typeof tip === "string") {
		return highlightKeywords(tip, customHighlights);
	}
	if ("text" in tip) {
		return highlightKeywords(tip.text, customHighlights);
	}
	// For structured items, use explicit styling for buttons + highlight custom words in other parts
	return (
		<>
			{highlightKeywords(tip.before, customHighlights)}
			<span style={{ color: colors.action, fontStyle: "italic" }}>
				{tip.button}
			</span>
			{highlightKeywords(tip.after, customHighlights)}
			<span style={{ color: colors.action, fontStyle: "italic" }}>
				{tip.button2}
			</span>
			{highlightKeywords(tip.after2, customHighlights)}
		</>
	);
};

// Get plain text from tip for editing
const getTipText = (tip: TipItem | string): string => {
	if (typeof tip === "string") return tip;
	if ("text" in tip) return tip.text;
	return `${tip.before}${tip.button}${tip.after}${tip.button2}${tip.after2}`;
};

// Get content from editable tip (handles both old and new format)

// Get highlights from editable tip

// Tip row that can render button names in the action blue
const TipRow = ({
	id,
	tip,
	highlights,
	onChange,
	onContextMenu,
	onDelete,
	showDelete,
}: {
	id: string;
	tip: TipItem | string;
	highlights: string[];
	onChange: (v: string) => void;
	onContextMenu: (e: React.MouseEvent) => void;
	onDelete?: () => void;
	showDelete?: boolean;
}) => {
	const [hovered, setHovered] = useState(false);
	const [isEditing, setIsEditing] = useState(false);
	const textValue = getTipText(tip);

	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id });

	const style = {
		opacity: isDragging ? 0.5 : 1,
		transform: CSS.Transform.toString(transform),
		transition,
	};

	return (
		<div
			ref={setNodeRef}
			style={style}
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
		>
			<div
				style={{
					alignItems: "baseline",
					display: "flex",
					marginBottom: space.betweenTips,
					position: "relative",
				}}
			>
				<div
					{...attributes}
					{...listeners}
					className="no-print"
					style={{
						alignItems: "center",
						cursor: "grab",
						display: "flex",
						left: "-24px",
						opacity: hovered ? 0.4 : 0,
						position: "absolute",
						top: "4px",
						transition: "opacity 0.15s",
					}}
				>
					<DotsSixVerticalIcon size={16} color={colors.graphite} />
				</div>
				<span
					style={{
						color: colors.action,
						flexShrink: 0,
						fontSize: type.body.size,
						lineHeight: type.body.lineHeight,
						paddingLeft: "4px",
						width: "40px",
					}}
				>
					•
				</span>
				<span
					contentEditable
					suppressContentEditableWarning
					onFocus={() => setIsEditing(true)}
					onContextMenu={onContextMenu}
					onBlur={(e) => {
						setIsEditing(false);
						const newVal = (e.target as HTMLElement).innerText;
						if (newVal !== textValue) onChange(newVal);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter") {
							e.preventDefault();
							(e.target as HTMLElement).blur();
						}
					}}
					style={{
						backgroundColor: hovered ? colors.quiet : "transparent",
						color: colors.graphite,
						cursor: isEditing ? "text" : "pointer",
						flex: 1,
						fontSize: type.body.size,
						lineHeight: type.body.lineHeight,
						margin: "-4px -8px",
						outline: "none",
						padding: "4px 8px",
						transition: "background-color 0.15s",
					}}
				>
					{isEditing ? textValue : renderTipContent(tip, highlights)}
				</span>
				{showDelete && onDelete && (
					<ActionIcon
						variant="subtle"
						color="gray"
						size="sm"
						onClick={onDelete}
						className="no-print"
						style={{
							marginLeft: "8px",
							opacity: hovered ? 0.5 : 0,
							transition: "opacity 0.15s",
						}}
					>
						<TrashIcon size={20} />
					</ActionIcon>
				)}
			</div>
		</div>
	);
};

const AddButton = ({
	onClick,
	label,
}: {
	onClick: () => void;
	label: string;
}) => {
	const [hovered, setHovered] = useState(false);
	return (
		<div
			className="no-print"
			onMouseEnter={() => setHovered(true)}
			onMouseLeave={() => setHovered(false)}
			style={{ height: "24px", marginLeft: "40px" }}
		>
			<Button
				variant="subtle"
				size="xs"
				color="gray"
				leftSection={<PlusIcon size={20} />}
				onClick={onClick}
				style={{ opacity: hovered ? 1 : 0, transition: "opacity 0.15s" }}
			>
				{label}
			</Button>
		</div>
	);
};

// Live Recording Indicator component
const LiveRecordingIndicator = ({
	conversations,
	maxVisible = 4,
}: {
	conversations: ActiveConversation[];
	maxVisible?: number;
}) => {
	const count = conversations.length;
	const visibleConversations = conversations.slice(0, maxVisible);

	return (
		<div style={{ marginTop: "16px", paddingLeft: "8px" }}>
			{/* Header with pulsing dot */}
			<div
				style={{
					alignItems: "center",
					display: "flex",
					gap: "8px",
					marginBottom: "4px",
				}}
			>
				<span
					style={{
						display: "flex",
						height: "10px",
						position: "relative",
						width: "10px",
					}}
				>
					{count > 0 && (
						<span
							className="live-pulse"
							style={{
								backgroundColor: colors.live,
								borderRadius: "9999px",
								height: "100%",
								left: 0,
								opacity: 0.4,
								position: "absolute",
								top: 0,
								width: "100%",
							}}
						/>
					)}
					<span
						style={{
							backgroundColor:
								count > 0 ? colors.live : "var(--app-control-rule)",
							borderRadius: "9999px",
							display: "inline-flex",
							height: "10px",
							position: "relative",
							width: "10px",
						}}
					/>
				</span>
				<span
					className={count > 0 ? undefined : "app-muted"}
					style={{
						color: count > 0 ? colors.graphite : colors.muted,
						fontSize: type.small.size,
						lineHeight: type.small.lineHeight,
					}}
				>
					{count === 0 ? (
						<Trans>Waiting for conversations...</Trans>
					) : (
						<Trans>{count} on record</Trans>
					)}
				</span>
			</div>

			{/* List with fade */}
			{visibleConversations.length > 0 && (
				<div
					style={{
						maskImage:
							visibleConversations.length >= maxVisible
								? "linear-gradient(to bottom, black 70%, transparent 100%)"
								: undefined,
						paddingLeft: "16px",
						WebkitMaskImage:
							visibleConversations.length >= maxVisible
								? "linear-gradient(to bottom, black 70%, transparent 100%)"
								: undefined,
					}}
				>
					{visibleConversations.map((conv) => (
						<div
							key={conv.id}
							className="live-item app-muted"
							style={{
								color: colors.muted,
								fontSize: type.small.size,
								lineHeight: type.small.lineHeight,
							}}
						>
							{conv.participantName || t`Conversation ${conv.id.slice(-6)}`}
						</div>
					))}
				</div>
			)}

			{/* CSS for animations */}
			<style>
				{`
					@keyframes gentlePulse {
						0%, 100% {
							transform: scale(1);
							opacity: 0.4;
						}
						50% {
							transform: scale(1.5);
							opacity: 0;
						}
					}
					@keyframes fadeIn {
						from {
							opacity: 0;
							transform: translateY(-4px);
						}
						to {
							opacity: 1;
							transform: translateY(0);
						}
					}
					.live-pulse {
						animation: gentlePulse 2s ease-in-out infinite;
					}
					.live-item {
						animation: fadeIn 0.3s ease-out;
					}
				`}
			</style>
		</div>
	);
};

// QR Code component
// Renders two QR canvases: parchment background for screen, white for print.
// CSS print styles can't recolor canvas pixels, so we swap which one is visible.
const BrandQRCode = ({ value }: { value: string }) => (
	<>
		<div className="qr-screen">
			<QRCodeLogo
				value={value}
				logoImage="/dembrane-logomark-cropped.png"
				logoWidth={50}
				logoHeight={50}
				bgColor={colors.parchment}
				fgColor={colors.graphite}
				eyeColor={colors.graphite}
				logoPadding={4}
				removeQrCodeBehindLogo
				logoPaddingStyle="circle"
				size={200}
			/>
		</div>
		<div className="qr-print">
			<QRCodeLogo
				value={value}
				logoImage="/dembrane-logomark-cropped.png"
				logoWidth={50}
				logoHeight={50}
				bgColor={colors.surface}
				fgColor={colors.graphite}
				eyeColor={colors.graphite}
				logoPadding={4}
				removeQrCodeBehindLogo
				logoPaddingStyle="circle"
				size={200}
			/>
		</div>
	</>
);

// ============================================================================
// MAIN PAGE
// ============================================================================

// Context menu state type
type ContextMenuState = {
	x: number;
	y: number;
	type: "step" | "tip";
	index: number;
	word: string;
} | null;

export const HostGuidePage = () => {
	const { projectId } = useParams();
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [showLiveRecordings, setShowLiveRecordings] = useState(() => {
		try {
			const saved = localStorage.getItem("host-guide-live-toggle");
			return saved !== null ? JSON.parse(saved) : true;
		} catch {
			return true;
		}
	});
	const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);

	// Persist live toggle setting
	useEffect(() => {
		try {
			localStorage.setItem(
				"host-guide-live-toggle",
				JSON.stringify(showLiveRecordings),
			);
		} catch {
			/* ignore */
		}
	}, [showLiveRecordings]);

	// Live conversations polling
	const { conversations: liveConversations } = useLiveConversations(
		projectId,
		showLiveRecordings,
	);

	useEffect(() => {
		const style = document.createElement("style");
		style.innerHTML = printStyles;
		document.head.appendChild(style);
		return () => {
			document.head.removeChild(style);
		};
	}, []);

	const { data: project, isLoading } = useProjectById({
		projectId: projectId ?? "",
		query: {
			fields: [
				"id",
				"name",
				"language",
				"is_conversation_allowed",
				"default_conversation_ask_for_participant_name",
				"host_guide",
			],
		},
	});

	const sharingLink = useProjectSharingLink(project, "host_guide");
	const langCode = (project?.language?.slice(0, 2) || "en") as LanguageCode;
	const defaults = defaultTranslations[langCode] || defaultTranslations.en;
	const askForName =
		project?.default_conversation_ask_for_participant_name ?? true;

	// Pre-server localStorage key, read once as a migration seed
	const legacyStorageKey = `host-guide-v14-${projectId}-${langCode}`;

	// Convert old format to new format with highlights
	const migrateToNewFormat = (
		steps: (StepItem | string | EditableStep)[],
		tips: (TipItem | string | EditableTip)[],
	) => ({
		steps: steps.map((s) =>
			typeof s === "object" && "content" in s
				? s
				: { content: s, highlights: [] },
		) as EditableStep[],
		tips: tips.map((t) =>
			typeof t === "object" && "content" in t
				? t
				: { content: t, highlights: [] },
		) as EditableTip[],
	});

	const getDefaultData = useCallback(() => {
		const rawSteps = askForName ? defaults.steps : defaults.stepsNoName;
		const rawTips = defaults.tips;
		return {
			...migrateToNewFormat(
				[...rawSteps] as (StepItem | string)[],
				[...rawTips] as (TipItem | string)[],
			),
			title: defaults.title,
		};
		// biome-ignore lint/correctness/useExhaustiveDependencies: TODO
	}, [defaults, askForName, migrateToNewFormat]);

	const clearLegacyGuide = useCallback(() => {
		for (let i = localStorage.length - 1; i >= 0; i--) {
			const key = localStorage.key(i);
			if (key?.startsWith("host-guide-") && key.includes(`-${projectId}`)) {
				localStorage.removeItem(key);
			}
		}
	}, [projectId]);

	const readLegacyGuide = useCallback((): HostGuideData | null => {
		try {
			const saved = localStorage.getItem(legacyStorageKey);
			if (saved) {
				const parsed = JSON.parse(saved);
				if (parsed.steps?.length >= 1 && parsed.tips?.length >= 1) {
					// Migrate if needed (old format without highlights)
					if (
						parsed.steps[0] &&
						typeof parsed.steps[0] === "object" &&
						!("content" in parsed.steps[0])
					) {
						return {
							...migrateToNewFormat(parsed.steps, parsed.tips),
							title: parsed.title,
						};
					}
					return parsed;
				}
			}
		} catch {
			/* ignore */
		}
		return null;
		// biome-ignore lint/correctness/useExhaustiveDependencies: TODO
	}, [legacyStorageKey, migrateToNewFormat]);

	// Initialize data as null, load after project is available
	const [data, setData] = useState<HostGuideData | null>(null);
	// Download event printouts opens the guide with ?print: once it has drawn,
	// the browser's print dialog saves it as a PDF.
	const [params] = useSearchParams();
	const printOnOpen = params.has("print");
	const ready = !!data;
	useEffect(() => {
		if (!printOnOpen || !ready) return;
		const timer = window.setTimeout(() => window.print(), 500);
		return () => window.clearTimeout(timer);
	}, [printOnOpen, ready]);

	// Only user edits mark dirty, so viewing alone never writes
	const dirtyRef = useRef(false);

	const saveGuideMutation = useUpdateProjectHostGuideMutation();
	// Stable ref so the autosave effect doesn't re-fire every render
	const saveGuideRef = useRef(saveGuideMutation);
	saveGuideRef.current = saveGuideMutation;

	// Hydrate: server copy first, then legacy localStorage, then defaults
	useEffect(() => {
		if (!project || data) return;
		const stored = parseStoredGuide(project.host_guide, langCode);
		if (stored) {
			clearLegacyGuide();
			setData(stored);
			return;
		}
		const legacy = readLegacyGuide();
		if (legacy) {
			dirtyRef.current = true;
			setData(legacy);
			return;
		}
		setData(getDefaultData());
	}, [
		project,
		data,
		langCode,
		clearLegacyGuide,
		readLegacyGuide,
		getDefaultData,
	]);

	// Debounced autosave; last write wins between hosts
	const [debouncedData] = useDebouncedValue(data, 800);
	useEffect(() => {
		if (!debouncedData || !dirtyRef.current || !projectId) return;
		dirtyRef.current = false;
		clearLegacyGuide();
		saveGuideRef.current.mutate({
			hostGuide: { ...debouncedData, language: langCode },
			id: projectId,
		});
	}, [debouncedData, projectId, langCode, clearLegacyGuide]);

	// Flush a pending edit on leave so edit-and-navigate isn't lost
	const dataRef = useRef(data);
	dataRef.current = data;
	useEffect(
		() => () => {
			if (dirtyRef.current && dataRef.current && projectId) {
				dirtyRef.current = false;
				saveGuideRef.current.mutate({
					hostGuide: { ...dataRef.current, language: langCode },
					id: projectId,
				});
			}
		},
		[projectId, langCode],
	);

	const editData = (updater: (d: HostGuideData) => HostGuideData) => {
		dirtyRef.current = true;
		setData((d) => (d ? updater(d) : d));
	};

	const updateTitle = (v: string) => editData((d) => ({ ...d, title: v }));

	const updateStep = (i: number, v: string) =>
		editData((d) => ({
			...d,
			steps: d.steps.map((s: EditableStep, idx: number) =>
				idx === i ? { ...s, content: v } : s,
			),
		}));

	const toggleStepHighlight = (i: number, word: string) =>
		editData((d) => ({
			...d,
			steps: d.steps.map((s: EditableStep, idx: number) => {
				if (idx !== i) return s;
				const highlights = s.highlights || [];
				const hasWord = highlights.includes(word);
				return {
					...s,
					highlights: hasWord
						? highlights.filter((w) => w !== word)
						: [...highlights, word],
				};
			}),
		}));

	const addStep = () =>
		editData((d) => ({
			...d,
			steps: [...d.steps, { content: "New step", highlights: [] }],
		}));

	const deleteStep = (i: number) => {
		if (data && data.steps.length > 1)
			editData((d) => ({
				...d,
				steps: d.steps.filter((_: EditableStep, idx: number) => idx !== i),
			}));
	};

	const updateTip = (i: number, v: string) =>
		editData((d) => ({
			...d,
			tips: d.tips.map((t: EditableTip, idx: number) =>
				idx === i ? { ...t, content: v } : t,
			),
		}));

	const toggleTipHighlight = (i: number, word: string) =>
		editData((d) => ({
			...d,
			tips: d.tips.map((t: EditableTip, idx: number) => {
				if (idx !== i) return t;
				const highlights = t.highlights || [];
				const hasWord = highlights.includes(word);
				return {
					...t,
					highlights: hasWord
						? highlights.filter((w) => w !== word)
						: [...highlights, word],
				};
			}),
		}));

	const addTip = () =>
		editData((d) => ({
			...d,
			tips: [...d.tips, { content: "New tip", highlights: [] }],
		}));

	const deleteTip = (i: number) => {
		if (data && data.tips.length > 1)
			editData((d) => ({
				...d,
				tips: d.tips.filter((_: EditableTip, idx: number) => idx !== i),
			}));
	};

	const resetData = () => {
		// Clear dirty so a pending debounce doesn't resurrect old content
		dirtyRef.current = false;
		setData(getDefaultData());
		clearLegacyGuide();
		if (projectId) {
			saveGuideRef.current.mutate({ hostGuide: null, id: projectId });
		}
	};

	// Context menu handlers
	const handleContextMenu = (
		e: React.MouseEvent,
		type: "step" | "tip",
		index: number,
	) => {
		e.preventDefault();
		const word = getSelectedWord();
		setContextMenu({
			index,
			type,
			word: word || "",
			x: e.clientX,
			y: e.clientY,
		});
	};

	const handleToggleHighlight = () => {
		if (!contextMenu || !contextMenu.word) return;
		if (contextMenu.type === "step") {
			toggleStepHighlight(contextMenu.index, contextMenu.word);
		} else {
			toggleTipHighlight(contextMenu.index, contextMenu.word);
		}
		setContextMenu(null);
	};

	// Close context menu on click outside
	useWindowEvent("click", () => {
		if (contextMenu) setContextMenu(null);
	});

	// Close context menu on Escape, exit fullscreen on Escape
	useWindowEvent("keydown", (event) => {
		if (event.key === "Escape") {
			if (contextMenu) setContextMenu(null);
			if (isFullscreen) setIsFullscreen(false);
		}
	});

	// DnD Kit setup
	const sensors = useSensors(
		useSensor(PointerSensor),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	// These are only used after the early return check for !data
	const stepIds =
		data?.steps.map((_: EditableStep, i: number) => `step-${i}`) ?? [];
	const tipIds =
		data?.tips.map((_: EditableTip, i: number) => `tip-${i}`) ?? [];

	const handleStepDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (over && active.id !== over.id) {
			const oldIndex = stepIds.indexOf(active.id as string);
			const newIndex = stepIds.indexOf(over.id as string);
			editData((d) => ({
				...d,
				steps: arrayMove(d.steps, oldIndex, newIndex),
			}));
		}
	};

	const handleTipDragEnd = (event: DragEndEvent) => {
		const { active, over } = event;
		if (over && active.id !== over.id) {
			const oldIndex = tipIds.indexOf(active.id as string);
			const newIndex = tipIds.indexOf(over.id as string);
			editData((d) => ({
				...d,
				tips: arrayMove(d.tips, oldIndex, newIndex),
			}));
		}
	};

	const contextMenuWord = contextMenu?.word ?? "";

	if (isLoading || !data) {
		return (
			<Box
				aria-busy
				aria-label={t`Loading host guide`}
				style={{
					backgroundColor: colors.parchment,
					color: colors.graphite,
					minHeight: "100vh",
					padding: space.page,
					paddingTop: `calc(${space.page} + 48px)`,
				}}
			>
				<Box style={{ margin: "0 auto", maxWidth: "900px" }}>
					<Skeleton height={48} width="50%" mb={32} />
					<Skeleton height={40} width="35%" mb={24} />
					<Skeleton height={32} mb={24} />
					<Skeleton height={32} mb={24} />
					<Skeleton height={32} width="70%" />
				</Box>
			</Box>
		);
	}

	return (
		<Box
			className="print-page"
			style={{
				backgroundColor: colors.parchment,
				color: colors.graphite,
				display: "flex",
				flexDirection: "column",
				height: isFullscreen ? "100vh" : undefined,
				left: isFullscreen ? 0 : undefined,
				minHeight: "100vh",
				overflowY: isFullscreen ? "auto" : undefined,
				padding: space.page,
				paddingTop: isFullscreen ? space.page : `calc(${space.page} + 48px)`,
				position: isFullscreen ? "fixed" : "relative",
				top: isFullscreen ? 0 : undefined,
				transition: "padding-top 0.2s",
				width: isFullscreen ? "100vw" : "100%",
				zIndex: isFullscreen ? 1000 : undefined,
			}}
		>
			{/* Fullscreen exit zone — thin invisible strip at top edge */}
			{isFullscreen && (
				<div
					className="no-print"
					onMouseEnter={() => setIsFullscreen(false)}
					style={{
						height: "6px",
						left: 0,
						position: "fixed",
						right: 0,
						top: 0,
						zIndex: 1001,
					}}
				/>
			)}

			{/* Permanent header toolbar */}
			<Box
				className="no-print"
				style={{
					left: 0,
					position: isFullscreen ? "fixed" : "absolute",
					right: 0,
					top: 0,
					transform: isFullscreen ? "translateY(-100%)" : "translateY(0)",
					transition: "transform 0.2s",
					zIndex: 1000,
				}}
			>
				<Group
					justify="flex-start"
					gap="md"
					style={{
						backgroundColor: colors.surface,
						boxShadow: "var(--app-float)",
						padding: "8px 16px",
					}}
				>
					<Button
						variant="filled"
						size="xs"
						leftSection={<PrinterIcon size={20} />}
						onClick={() => window.print()}
					>
						<Trans>Download event printouts</Trans>
					</Button>
					<Button
						size="xs"
						leftSection={<ArrowsOutIcon size={20} />}
						onClick={() => setIsFullscreen(true)}
					>
						<Trans>Go fullscreen</Trans>
					</Button>
					<Button
						variant="subtle"
						color="gray"
						size="xs"
						onClick={() =>
							openConfirm({
								children: t`Your edits to this guide are lost and it goes back to the default text.`,
								danger: true,
								labels: { confirm: t`Reset guide` },
								onConfirm: resetData,
								title: t`Reset the guide?`,
							})
						}
					>
						<Trans>Reset</Trans>
					</Button>
					<Switch
						checked={showLiveRecordings}
						onChange={(event) =>
							setShowLiveRecordings(event.currentTarget.checked)
						}
						label={<Trans>Live recordings</Trans>}
					/>
					<Group gap="xs">
						<Text size="sm" c="dimmed">
							<Trans>Click to edit</Trans>
						</Text>
						<Text size="sm" c="dimmed">
							·
						</Text>
						<Text size="sm" c="dimmed">
							<Trans>Right-click to highlight</Trans>
						</Text>
						<Text size="sm" c="dimmed">
							·
						</Text>
						<Text size="sm" c="dimmed">
							<Trans>Drag to reorder</Trans>
						</Text>
					</Group>
				</Group>
			</Box>

			{/* Content */}
			<Box
				style={{
					display: "flex",
					flexDirection: "column",
					margin: "0 auto",
					maxWidth: "900px",
					width: "100%",
				}}
			>
				{/* PROJECT NAME */}
				<Text
					style={{
						color: colors.graphite,
						fontSize: type.display.size,
						lineHeight: type.display.lineHeight,
						marginBottom: space.afterDisplay,
					}}
				>
					{project?.name}
				</Text>

				{/* Main row: Left content + Right QR */}
				<div style={{ display: "flex", gap: space.betweenColumns }}>
					{/* Left column */}
					<div style={{ flex: 1 }}>
						{/* HOW TO RECORD - aligns with QR code top */}
						<div style={{ marginBottom: space.afterHeadline }}>
							<span
								contentEditable
								suppressContentEditableWarning
								onBlur={(e) => updateTitle((e.target as HTMLElement).innerText)}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.preventDefault();
										(e.target as HTMLElement).blur();
									}
								}}
								style={{
									color: colors.graphite,
									fontSize: type.headline.size,
									lineHeight: type.headline.lineHeight,
									outline: "none",
								}}
							>
								{data.title}
							</span>
						</div>

						{/* STEPS */}
						<DndContext
							sensors={sensors}
							collisionDetection={closestCenter}
							onDragEnd={handleStepDragEnd}
						>
							<SortableContext
								items={stepIds}
								strategy={verticalListSortingStrategy}
							>
								{data.steps.map((step: EditableStep, i: number) => (
									<StepRow
										key={stepIds[i]}
										id={stepIds[i]}
										number={i + 1}
										step={step.content}
										highlights={step.highlights || []}
										onChange={(v) => updateStep(i, v)}
										onContextMenu={(e) => handleContextMenu(e, "step", i)}
										onDelete={() => deleteStep(i)}
										showDelete={data.steps.length > 1}
									/>
								))}
							</SortableContext>
						</DndContext>
						<AddButton onClick={addStep} label={t`Add step`} />

						{/* TIPS */}
						<div style={{ marginTop: space.beforeTips }}>
							<Text
								style={{
									color: colors.graphite,
									fontSize: type.body.size,
									lineHeight: type.body.lineHeight,
									marginBottom: space.betweenTips,
								}}
							>
								Tips
							</Text>
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								onDragEnd={handleTipDragEnd}
							>
								<SortableContext
									items={tipIds}
									strategy={verticalListSortingStrategy}
								>
									{data.tips.map((tip: EditableTip, i: number) => (
										<TipRow
											key={tipIds[i]}
											id={tipIds[i]}
											tip={tip.content}
											highlights={tip.highlights || []}
											onChange={(v) => updateTip(i, v)}
											onContextMenu={(e) => handleContextMenu(e, "tip", i)}
											onDelete={() => deleteTip(i)}
											showDelete={data.tips.length > 1}
										/>
									))}
								</SortableContext>
							</DndContext>
							<AddButton onClick={addTip} label={t`Add tip`} />
						</div>
					</div>

					{/* Right: QR Code + Live recordings */}
					<div style={{ flexShrink: 0 }}>
						{sharingLink ? (
							<BrandQRCode value={sharingLink} />
						) : (
							<div
								style={{
									alignItems: "center",
									backgroundColor: colors.quiet,
									display: "flex",
									height: "200px",
									justifyContent: "center",
									width: "200px",
								}}
							>
								<Text size="xs" c="dimmed" ta="center">
									<Trans>Enable participation</Trans>
								</Text>
							</div>
						)}

						{/* Live recording indicator - below QR code */}
						{showLiveRecordings && (
							<div className="no-print">
								<LiveRecordingIndicator conversations={liveConversations} />
							</div>
						)}
					</div>
				</div>
			</Box>

			{/* FOOTER - Fixed at bottom right */}
			<div
				style={{
					bottom: space.page,
					position: "fixed",
					right: space.page,
				}}
			>
				<img
					src="/dembrane-wordmark.png"
					alt="dembrane"
					style={{ height: "58px" }}
				/>
			</div>

			{/* Context menu for highlight toggle, anchored at the click point */}
			{contextMenu && (
				<Menu
					key={`${contextMenu.x}-${contextMenu.y}`}
					opened
					onClose={() => setContextMenu(null)}
					position="bottom-start"
					offset={0}
					trapFocus={false}
					returnFocus={false}
					zIndex={1001}
				>
					<Menu.Target>
						<div
							className="no-print"
							style={{
								height: 0,
								left: contextMenu.x,
								position: "fixed",
								top: contextMenu.y,
								width: 0,
							}}
						/>
					</Menu.Target>
					<Menu.Dropdown className="no-print">
						{contextMenuWord ? (
							<Menu.Item onClick={handleToggleHighlight}>
								<Trans>Toggle highlight "{contextMenuWord}"</Trans>
							</Menu.Item>
						) : (
							<Menu.Label>
								<Trans>Select a word first</Trans>
							</Menu.Label>
						)}
					</Menu.Dropdown>
				</Menu>
			)}
		</Box>
	);
};

export default HostGuidePage;
