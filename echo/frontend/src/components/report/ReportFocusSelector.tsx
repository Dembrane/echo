import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Group,
	Stack,
	Text,
	Textarea,
	UnstyledButton,
} from "@mantine/core";
import { IconCheck, IconPencil } from "@tabler/icons-react";
import { useCallback, useEffect, useState } from "react";
import focusOptionsData from "@/data/reportFocusOptions.json";

interface ReportFocusSelectorProps {
	value: string;
	onChange: (value: string) => void;
	language: string;
}

type LangKey = "en" | "nl" | "de" | "fr" | "it" | "es";

function getLabel(
	labels: Record<string, string>,
	language: string,
): string {
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

	const [selectedIds, setSelectedIds] = useState<Set<string>>(
		() => parseSelectedIds(value),
	);
	const [customText, setCustomText] = useState(
		() => extractCustomText(value),
	);
	const [showCustom, setShowCustom] = useState(() => !!extractCustomText(value));

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

	const handleTogglePreset = (id: string) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			onChange(buildValue(next, customText));
			return next;
		});
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

	return (
		<Stack gap="sm">
			<Text size="sm" fw={500}>
				<Trans>Guide the report</Trans>{" "}
				<Text span size="sm" c="dimmed" fw={400}>
					<Trans>(optional)</Trans>
				</Text>
			</Text>
			<Group gap={8} wrap="wrap">
				{options.map((option) => {
					const isActive = selectedIds.has(option.id);
					return (
						<UnstyledButton
							key={option.id}
							onClick={() => handleTogglePreset(option.id)}
							px="xs"
							py={4}
							style={{
								borderRadius: 20,
								border: isActive
									? "1.5px solid var(--mantine-color-teal-5)"
									: "1.5px solid var(--mantine-color-gray-3)",
								backgroundColor: isActive
									? "var(--mantine-color-teal-0)"
									: undefined,
								transition: "all 0.15s ease",
							}}
						>
							<Group gap={6} wrap="nowrap">
								{isActive && (
									<IconCheck
										size={12}
										color="var(--mantine-color-teal-6)"
									/>
								)}
								<Text
									size="xs"
									c={isActive ? "teal.8" : undefined}
									fw={isActive ? 500 : 400}
								>
									{getLabel(option.labels, language)}
								</Text>
							</Group>
						</UnstyledButton>
					);
				})}

				{/* Write your own */}
				<UnstyledButton
					onClick={handleToggleCustom}
					px="sm"
					py={6}
					style={{
						borderRadius: 20,
						border: showCustom
							? "1.5px dashed var(--mantine-color-teal-5)"
							: "1.5px dashed var(--mantine-color-gray-5)",
						transition: "all 0.15s ease",
					}}
				>
					<Group gap={5} wrap="nowrap">
						<IconPencil
							size={12}
							color={
								showCustom
									? "var(--mantine-color-teal-6)"
									: "var(--mantine-color-gray-6)"
							}
						/>
						<Text
							size="xs"
							c={showCustom ? "teal.7" : "gray.7"}
							fw={showCustom ? 500 : 400}
						>
							<Trans>Or write your own</Trans>
						</Text>
					</Group>
				</UnstyledButton>
			</Group>

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
