import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import { Checkbox, Stack, Text, Textarea } from "@mantine/core";
import { useCallback, useEffect, useState } from "react";
import focusOptionsData from "@/data/reportFocusOptions.json";

interface ReportFocusSelectorProps {
	value: string;
	onChange: (value: string) => void;
	language: string;
}

type LangKey = "en" | "nl" | "de" | "fr" | "it" | "es";

function getLabel(labels: Record<string, string>, language: string): string {
	return labels[language as LangKey] ?? labels.en ?? "";
}

/** Parse a combined instruction string back into selected option IDs. */
function parseSelectedIds(value: string): Set<string> {
	const ids = new Set<string>();
	for (const opt of focusOptionsData.options) {
		if (value.includes(opt.instruction)) {
			ids.add(opt.id);
		}
	}
	return ids;
}

/** Strip all known preset instructions from a value to get the custom part. */
function extractCustomText(value: string): string {
	let remaining = value;
	for (const opt of focusOptionsData.options) {
		remaining = remaining.replace(opt.instruction, "");
	}
	return remaining.replace(/\n{2,}/g, "\n").trim();
}

export const ReportFocusSelector = ({
	value,
	onChange,
	language,
}: ReportFocusSelectorProps) => {
	const options = focusOptionsData.options;

	const [selectedIds, setSelectedIds] = useState<Set<string>>(() =>
		parseSelectedIds(value),
	);
	const [customText, setCustomText] = useState(() => extractCustomText(value));
	const [showCustom, setShowCustom] = useState(
		() => !!extractCustomText(value),
	);

	// Build combined instruction string from selected IDs + custom text
	const buildValue = useCallback(
		(ids: Set<string>, custom: string) => {
			const parts: string[] = [];
			for (const opt of options) {
				if (ids.has(opt.id)) {
					parts.push(opt.instruction);
				}
			}
			if (custom.trim()) {
				parts.push(custom.trim());
			}
			return parts.join("\n\n");
		},
		[options],
	);

	const handlePresetsChange = (ids: string[]) => {
		if (ids.length > 2) return;
		const next = new Set(ids);
		setSelectedIds(next);
		onChange(buildValue(next, customText));
	};

	const handleCustomTextChange = (text: string) => {
		setCustomText(text);
		onChange(buildValue(selectedIds, text));
	};

	const handleToggleCustom = () => {
		if (showCustom) {
			setShowCustom(false);
			setCustomText("");
			onChange(buildValue(selectedIds, ""));
		} else {
			setShowCustom(true);
		}
	};

	// Sync if value changes externally (e.g. reset on modal open)
	useEffect(() => {
		const ids = parseSelectedIds(value);
		const custom = extractCustomText(value);
		setSelectedIds(ids);
		setCustomText(custom);
		setShowCustom(!!custom);
	}, [value]);

	const atLimit = selectedIds.size >= 2;

	return (
		<Stack gap="sm">
			<Text size="sm">
				<Trans>Guide the report</Trans>{" "}
				<Text span size="sm" c="dimmed">
					<Trans>(optional)</Trans>
				</Text>
			</Text>
			<Text size="xs" c="dimmed">
				<Trans>Select up to 2 focus areas for your report</Trans>
			</Text>
			{/* A list you pick from: a checkbox per row (a joined chip row wrapped). */}
			<Checkbox.Group value={[...selectedIds]} onChange={handlePresetsChange}>
				<Stack gap="sm">
					{options.map((option) => (
						<Checkbox
							key={option.id}
							value={option.id}
							label={getLabel(option.labels, language)}
							disabled={atLimit && !selectedIds.has(option.id)}
						/>
					))}
				</Stack>
			</Checkbox.Group>
			<Checkbox
				checked={showCustom}
				onChange={handleToggleCustom}
				label={<Trans>Or write your own</Trans>}
			/>

			{showCustom && (
				<Textarea
					placeholder={t`e.g. "Focus on sustainability themes" or "What do participants think about the new policy?"`}
					value={customText}
					onChange={(e) => handleCustomTextChange(e.currentTarget.value)}
					minRows={2}
					maxRows={4}
					autosize
				/>
			)}
		</Stack>
	);
};
