import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Group,
	Stack,
	Text,
	TextInput,
} from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { useState, type KeyboardEvent, type ChangeEvent } from "react";

export interface EmailChip {
	id: string;
	value: string;
	// "valid" | "invalid" (bad format) | "self" (self-invite)
	state: "valid" | "invalid" | "self";
}

interface Props {
	chips: EmailChip[];
	onChipsChange: (next: EmailChip[]) => void;
	selfEmail?: string | null;
	autoFocus?: boolean;
	"data-testid"?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEPARATORS = /[\s,;]+/;

function classify(value: string, selfEmail: string | null | undefined): EmailChip["state"] {
	const trimmed = value.trim().toLowerCase();
	if (!EMAIL_RE.test(trimmed)) return "invalid";
	if (selfEmail && trimmed === selfEmail.toLowerCase()) return "self";
	return "valid";
}

function makeChip(value: string, selfEmail: string | null | undefined): EmailChip {
	return {
		id: `${value}-${Math.random().toString(36).slice(2, 8)}`,
		value: value.trim(),
		state: classify(value, selfEmail),
	};
}

function dedupeAppend(existing: EmailChip[], additions: EmailChip[]): EmailChip[] {
	const seen = new Set(existing.map((c) => c.value.toLowerCase()));
	const out = [...existing];
	for (const chip of additions) {
		const key = chip.value.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(chip);
	}
	return out;
}

// Splits on commas/spaces/newlines, renders chips with per-chip validation. Self-invite caught inline.
export function EmailChipsInput({
	chips,
	onChipsChange,
	selfEmail,
	autoFocus,
	"data-testid": dataTestId,
}: Props) {
	const [draft, setDraft] = useState("");
	// Two-step Backspace delete: first highlights the last chip, second removes it.
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

	const commitDraft = (raw: string) => {
		const tokens = raw.split(SEPARATORS).filter((tok) => tok.length > 0);
		if (tokens.length === 0) {
			setDraft("");
			return;
		}
		const additions = tokens.map((tok) => makeChip(tok, selfEmail));
		onChipsChange(dedupeAppend(chips, additions));
		setDraft("");
	};

	const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
		const value = e.currentTarget.value;
		if (pendingDeleteId) setPendingDeleteId(null);
		// Flush on separator so chips appear as the user types.
		if (SEPARATORS.test(value)) {
			commitDraft(value);
			return;
		}
		setDraft(value);
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter" || e.key === "Tab") {
			if (draft.trim().length > 0) {
				e.preventDefault();
				commitDraft(draft);
			}
			setPendingDeleteId(null);
			return;
		}
		if (e.key === "Backspace" && draft.length === 0 && chips.length > 0) {
			const lastChip = chips[chips.length - 1];
			if (pendingDeleteId === lastChip.id) {
				onChipsChange(chips.slice(0, -1));
				setPendingDeleteId(null);
			} else {
				setPendingDeleteId(lastChip.id);
			}
			return;
		}
		if (pendingDeleteId) setPendingDeleteId(null);
	};

	const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
		const pasted = e.clipboardData.getData("text");
		if (SEPARATORS.test(pasted)) {
			e.preventDefault();
			// Separator between draft and pasted avoids fusing "alice@x.com" + "bob@y.com" into one token.
			const joined = draft.length > 0 ? `${draft} ${pasted}` : pasted;
			commitDraft(joined);
		}
	};

	const handleBlur = () => {
		if (draft.trim().length > 0) {
			commitDraft(draft);
		}
	};

	const removeChip = (id: string) => {
		onChipsChange(chips.filter((c) => c.id !== id));
	};

	const invalidCount = chips.filter((c) => c.state !== "valid").length;

	return (
		<Stack gap={6} data-testid={dataTestId}>
			<Box
				p={6}
				style={{
					borderRadius: 6,
					border: "1px solid var(--mantine-color-gray-3)",
					minHeight: 44,
				}}
			>
				<Group gap={6} wrap="wrap">
					{chips.map((chip) => (
						<EmailChipPill
							key={chip.id}
							chip={chip}
							highlighted={chip.id === pendingDeleteId}
							onRemove={() => removeChip(chip.id)}
						/>
					))}
					<TextInput
						variant="unstyled"
						placeholder={
							chips.length === 0
								? t`name@example.com, name2@example.com`
								: ""
						}
						value={draft}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						onBlur={handleBlur}
						autoFocus={autoFocus}
						styles={{ input: { minWidth: 220 } }}
						style={{ flex: 1 }}
						data-testid={dataTestId ? `${dataTestId}-input` : undefined}
					/>
				</Group>
			</Box>
			<Group justify="space-between">
				<Text size="xs" c="dimmed">
					<Trans>Separate with commas, spaces, or new lines.</Trans>
				</Text>
				{invalidCount > 0 && (
					<Text size="xs" c="red">
						{invalidCount === 1 ? (
							<Trans>1 address needs attention</Trans>
						) : (
							<Trans>{invalidCount} addresses need attention</Trans>
						)}
					</Text>
				)}
			</Group>
		</Stack>
	);
}

function EmailChipPill({
	chip,
	highlighted,
	onRemove,
}: {
	chip: EmailChip;
	highlighted?: boolean;
	onRemove: () => void;
}) {
	const baseTone =
		chip.state === "valid"
			? { bg: "var(--mantine-color-gray-1)", fg: "var(--mantine-color-gray-9)", border: "var(--mantine-color-gray-3)" }
			: { bg: "var(--mantine-color-red-0)", fg: "var(--mantine-color-red-9)", border: "var(--mantine-color-red-3)" };
	// "Armed" highlight before second-Backspace delete.
	const tone = highlighted
		? { bg: "var(--mantine-primary-color-light)", fg: "var(--mantine-primary-color-filled)", border: "var(--mantine-primary-color-filled)" }
		: baseTone;
	const title =
		chip.state === "self"
			? t`You can't invite yourself.`
			: chip.state === "invalid"
				? t`Not a valid email.`
				: chip.value;
	return (
		<Group
			gap={4}
			wrap="nowrap"
			px={8}
			py={2}
			style={{
				backgroundColor: tone.bg,
				border: `1px solid ${tone.border}`,
				borderRadius: 999,
			}}
			title={title}
		>
			<Text size="xs" c={tone.fg}>
				{chip.value}
			</Text>
			<ActionIcon
				size="xs"
				variant="subtle"
				color={chip.state === "valid" ? "gray" : "red"}
				onClick={onRemove}
				aria-label={t`Remove ${chip.value}`}
			>
				<IconX size={12} />
			</ActionIcon>
		</Group>
	);
}
