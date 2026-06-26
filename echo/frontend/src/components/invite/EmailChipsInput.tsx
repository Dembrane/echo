import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	ActionIcon,
	Box,
	Combobox,
	Group,
	Stack,
	Text,
	TextInput,
	useCombobox,
} from "@mantine/core";
import { IconX } from "@tabler/icons-react";
import { type ChangeEvent, type KeyboardEvent, useMemo, useState } from "react";

export interface EmailChip {
	id: string;
	value: string;
	// "valid" | "invalid" (bad format) | "self" (self-invite)
	state: "valid" | "invalid" | "self";
}

// A person already known to the org, offered as an autocomplete suggestion.
export interface MemberSuggestion {
	email: string;
	displayName?: string | null;
}

interface Props {
	chips: EmailChip[];
	onChipsChange: (next: EmailChip[]) => void;
	selfEmail?: string | null;
	autoFocus?: boolean;
	// When provided (org admins), the input offers these people as a dropdown.
	// Absent → plain free-text behaviour, unchanged for everyone else.
	suggestions?: MemberSuggestion[];
	"data-testid"?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SEPARATORS = /[\s,;]+/;

function classify(
	value: string,
	selfEmail: string | null | undefined,
): EmailChip["state"] {
	const trimmed = value.trim().toLowerCase();
	if (!EMAIL_RE.test(trimmed)) return "invalid";
	if (selfEmail && trimmed === selfEmail.toLowerCase()) return "self";
	return "valid";
}

function makeChip(
	value: string,
	selfEmail: string | null | undefined,
): EmailChip {
	return {
		id: `${value}-${Math.random().toString(36).slice(2, 8)}`,
		state: classify(value, selfEmail),
		value: value.trim(),
	};
}

function dedupeAppend(
	existing: EmailChip[],
	additions: EmailChip[],
): EmailChip[] {
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
// When `suggestions` is passed, the input also offers an autocomplete dropdown of
// known people (org admins). Typing an email that isn't a known person still works:
// it just becomes a chip on Enter/comma, and never appears as a dropdown option.
export function EmailChipsInput({
	chips,
	onChipsChange,
	selfEmail,
	autoFocus,
	suggestions,
	"data-testid": dataTestId,
}: Props) {
	const [draft, setDraft] = useState("");
	// Two-step Backspace delete: first highlights the last chip, second removes it.
	const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

	const suggestionsEnabled = Boolean(suggestions && suggestions.length > 0);
	const combobox = useCombobox({
		onDropdownClose: () => combobox.resetSelectedOption(),
		onDropdownOpen: () => combobox.resetSelectedOption(),
	});

	// Already-added emails so we don't re-offer someone the admin just picked.
	const addedLookup = useMemo(
		() => new Set(chips.map((c) => c.value.toLowerCase())),
		[chips],
	);

	// Suggestions matching the current draft, minus self and already-added. New
	// (unknown) emails never enter this list, so they can't show in the dropdown.
	const filteredSuggestions = useMemo(() => {
		if (!suggestionsEnabled) return [];
		const self = selfEmail?.toLowerCase();
		const q = draft.trim().toLowerCase();
		return (suggestions ?? [])
			.filter((s) => {
				const email = s.email.toLowerCase();
				if (self && email === self) return false;
				if (addedLookup.has(email)) return false;
				if (!q) return true;
				return (
					email.includes(q) ||
					(s.displayName ? s.displayName.toLowerCase().includes(q) : false)
				);
			})
			.slice(0, 50);
	}, [suggestionsEnabled, suggestions, selfEmail, draft, addedLookup]);

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

	// Add a single email picked from the dropdown; keep the dropdown open for multi-pick.
	const commitEmail = (email: string) => {
		onChipsChange(dedupeAppend(chips, [makeChip(email, selfEmail)]));
		setDraft("");
		combobox.resetSelectedOption();
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
		if (suggestionsEnabled) {
			combobox.openDropdown();
			combobox.resetSelectedOption();
		}
	};

	const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		if (suggestionsEnabled) {
			if (e.key === "ArrowDown") {
				combobox.openDropdown();
				combobox.selectNextOption();
				e.preventDefault();
				return;
			}
			if (e.key === "ArrowUp") {
				combobox.openDropdown();
				combobox.selectPreviousOption();
				e.preventDefault();
				return;
			}
			if (e.key === "Escape" && combobox.dropdownOpened) {
				combobox.closeDropdown();
				return;
			}
			// Enter only picks a suggestion when one is actively highlighted; otherwise
			// it falls through to commit the typed draft (the invite-new path).
			if (
				e.key === "Enter" &&
				combobox.dropdownOpened &&
				combobox.getSelectedOptionIndex() >= 0 &&
				filteredSuggestions.length > 0
			) {
				e.preventDefault();
				combobox.clickSelectedOption();
				return;
			}
		}
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

	const handleFocus = () => {
		if (suggestionsEnabled) combobox.openDropdown();
	};

	const handleBlur = () => {
		if (draft.trim().length > 0) {
			commitDraft(draft);
		}
		if (suggestionsEnabled) combobox.closeDropdown();
	};

	const removeChip = (id: string) => {
		onChipsChange(chips.filter((c) => c.id !== id));
	};

	const invalidCount = chips.filter((c) => c.state !== "valid").length;

	const inputBox = (
		<Box
			p={6}
			style={{
				border: "1px solid var(--mantine-color-gray-3)",
				borderRadius: 6,
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
							? suggestionsEnabled
								? t`Search people, or type an email`
								: t`name@example.com, name2@example.com`
							: ""
					}
					value={draft}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					onPaste={handlePaste}
					onFocus={handleFocus}
					onBlur={handleBlur}
					autoFocus={autoFocus}
					styles={{ input: { minWidth: 220 } }}
					style={{ flex: 1 }}
					data-testid={dataTestId ? `${dataTestId}-input` : undefined}
				/>
			</Group>
		</Box>
	);

	const helper = (
		<Group justify="space-between">
			<Text size="xs" c="dimmed">
				{suggestionsEnabled ? (
					<Trans>
						Pick from your organisation, or type an email to invite.
					</Trans>
				) : (
					<Trans>Separate with commas, spaces, or new lines.</Trans>
				)}
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
	);

	if (!suggestionsEnabled) {
		return (
			<Stack gap={6} data-testid={dataTestId}>
				{inputBox}
				{helper}
			</Stack>
		);
	}

	return (
		<Stack gap={6} data-testid={dataTestId}>
			<Combobox store={combobox} onOptionSubmit={(value) => commitEmail(value)}>
				<Combobox.DropdownTarget>{inputBox}</Combobox.DropdownTarget>
				<Combobox.Dropdown hidden={filteredSuggestions.length === 0}>
					<Combobox.Options mah={240} style={{ overflowY: "auto" }}>
						{filteredSuggestions.map((s) => (
							<Combobox.Option value={s.email} key={s.email}>
								<Group gap="xs" wrap="nowrap">
									<Text size="sm">{s.displayName || s.email}</Text>
									{s.displayName && <Text size="xs">- {s.email}</Text>}
								</Group>
							</Combobox.Option>
						))}
					</Combobox.Options>
				</Combobox.Dropdown>
			</Combobox>
			{helper}
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
			? {
					bg: "var(--mantine-color-gray-1)",
					border: "var(--mantine-color-gray-3)",
					fg: "var(--mantine-color-gray-9)",
				}
			: {
					bg: "var(--mantine-color-red-0)",
					border: "var(--mantine-color-red-3)",
					fg: "var(--mantine-color-red-9)",
				};
	// "Armed" highlight before second-Backspace delete.
	const tone = highlighted
		? {
				bg: "var(--mantine-primary-color-light)",
				border: "var(--mantine-primary-color-filled)",
				fg: "var(--mantine-primary-color-filled)",
			}
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
