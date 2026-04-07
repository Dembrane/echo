import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Collapse,
	Group,
	Modal,
	Stack,
	Text,
	Textarea,
	TextInput,
	UnstyledButton,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { CaretDownIcon, CaretRightIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { VerificationTopicMetadata } from "@/lib/api";
import { testId } from "@/lib/testUtils";

const MAX_LABEL_LENGTH = 100;
const MAX_PROMPT_LENGTH = 1000;
const MAX_ICON_LENGTH = 10;

const EMOJI_REGEX = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;

const SUPPORTED_LANGUAGES = [
	{ code: "en-US", label: "English" },
	{ code: "nl-NL", label: "Nederlands" },
	{ code: "de-DE", label: "Deutsch" },
	{ code: "fr-FR", label: "Français" },
	{ code: "es-ES", label: "Español" },
	{ code: "it-IT", label: "Italiano" },
	{ code: "uk-UA", label: "Ukrainian" },
] as const;

type CustomTopicModalProps = {
	opened: boolean;
	onClose: () => void;
	mode: "create" | "edit";
	topic?: VerificationTopicMetadata | null;
	onSubmit: (data: {
		label: string;
		prompt: string;
		icon: string;
		translations: Record<string, string>;
	}) => void;
	isLoading?: boolean;
};

export const CustomTopicModal = ({
	opened,
	onClose,
	mode,
	topic,
	onSubmit,
	isLoading = false,
}: CustomTopicModalProps) => {
	const [
		translationsOpen,
		{ toggle: toggleTranslations, close: closeTranslations },
	] = useDisclosure(false);
	const [labels, setLabels] = useState<Record<string, string>>({});
	const [prompt, setPrompt] = useState("");
	const [icon, setIcon] = useState("");

	useEffect(() => {
		if (!opened) return;

		if (mode === "edit" && topic) {
			const translationLabels: Record<string, string> = {};
			for (const lang of SUPPORTED_LANGUAGES) {
				translationLabels[lang.code] =
					topic.translations?.[lang.code]?.label ?? "";
			}
			setLabels(translationLabels);
			setPrompt(topic.prompt ?? "");
			setIcon(topic.icon ?? "");
		} else {
			setLabels({});
			setPrompt("");
			setIcon("");
		}
		closeTranslations();
	}, [opened, mode, topic, closeTranslations]);

	const enUsLabel = labels["en-US"]?.trim() ?? "";

	const hasChanges = (() => {
		if (mode === "create") return true;
		if (!topic) return true;

		if (enUsLabel !== (topic.translations?.["en-US"]?.label ?? "")) return true;
		if (prompt.trim() !== (topic.prompt ?? "")) return true;
		if (icon.trim() !== (topic.icon ?? "")) return true;

		for (const lang of SUPPORTED_LANGUAGES) {
			if (lang.code === "en-US") continue;
			const current = labels[lang.code]?.trim() ?? "";
			const original = topic.translations?.[lang.code]?.label ?? "";
			if (current !== original) return true;
		}

		return false;
	})();

	const canSubmit =
		enUsLabel.length > 0 && prompt.trim().length > 0 && hasChanges;

	const handleSubmit = () => {
		if (!canSubmit) return;

		const translations: Record<string, string> = {};
		for (const lang of SUPPORTED_LANGUAGES) {
			const val = labels[lang.code]?.trim();
			if (val) {
				translations[lang.code] = val;
			}
		}

		onSubmit({
			icon: icon.trim(),
			label: enUsLabel,
			prompt: prompt.trim(),
			translations,
		});
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			title={
				mode === "create" ? (
					<Trans>Add Custom Topic</Trans>
				) : (
					<Trans>Edit Custom Topic</Trans>
				)
			}
			size="lg"
			radius="md"
			padding="xl"
			{...testId("custom-topic-modal")}
		>
			<Stack gap="md">
				<TextInput
					label={t`Topic label`}
					placeholder={t`Required`}
					value={labels["en-US"] ?? ""}
					onChange={(e) => {
						const val = e.currentTarget.value;
						setLabels((prev) => ({ ...prev, "en-US": val }));
					}}
					maxLength={MAX_LABEL_LENGTH}
					required
					{...testId("custom-topic-label-en-US")}
				/>

				<Stack gap={4}>
					<UnstyledButton onClick={toggleTranslations}>
						<Text
							size="sm"
							style={{
								alignItems: "center",
								display: "flex",
								gap: "0.2rem",
							}}
						>
							{translationsOpen ? (
								<CaretDownIcon size={14} style={{ display: "inline" }} />
							) : (
								<CaretRightIcon size={14} style={{ display: "inline" }} />
							)}{" "}
							<Trans>Add translations</Trans>
						</Text>
					</UnstyledButton>

					<Collapse in={translationsOpen}>
						<Stack gap="xs" pt="xs" pl="md">
							{SUPPORTED_LANGUAGES.filter((l) => l.code !== "en-US").map(
								(lang) => (
									<TextInput
										key={lang.code}
										label={lang.label}
										placeholder={t`Optional (falls back to English)`}
										value={labels[lang.code] ?? ""}
										onChange={(e) => {
											const val = e.currentTarget.value;
											setLabels((prev) => ({
												...prev,
												[lang.code]: val,
											}));
										}}
										maxLength={MAX_LABEL_LENGTH}
										{...testId(`custom-topic-label-${lang.code}`)}
									/>
								),
							)}
						</Stack>
					</Collapse>
				</Stack>

				<Textarea
					label={t`Prompt`}
					description={
						<Trans>Instructions for generating the verification outcome</Trans>
					}
					placeholder={t`Describe what the language model should extract or summarize from the conversation...`}
					value={prompt}
					onChange={(e) => setPrompt(e.currentTarget.value)}
					maxLength={MAX_PROMPT_LENGTH}
					autosize
					minRows={4}
					required
					{...testId("custom-topic-prompt")}
				/>

				<TextInput
					label={t`Emoji`}
					description={
						<Trans>Emoji shown next to the topic e.g. 💡 🔍 📊</Trans>
					}
					placeholder={t`Optional`}
					value={icon}
					onChange={(e) => {
						const emojis = e.currentTarget.value.match(EMOJI_REGEX);
						setIcon(emojis ? emojis.join("") : "");
					}}
					maxLength={MAX_ICON_LENGTH}
					{...testId("custom-topic-icon")}
				/>

				<Group justify="flex-end" mt="md">
					<Button variant="subtle" onClick={onClose}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						onClick={handleSubmit}
						disabled={!canSubmit}
						loading={isLoading}
						{...testId("custom-topic-submit")}
					>
						{mode === "create" ? <Trans>Create</Trans> : <Trans>Save</Trans>}
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
};
