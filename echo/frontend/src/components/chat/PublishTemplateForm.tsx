import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Group,
	Paper,
	Radio,
	Stack,
	Text,
	Textarea,
} from "@mantine/core";
import { useState } from "react";

const ALLOWED_TAGS = [
	"Workshop",
	"Interview",
	"Focus Group",
	"Meeting",
	"Research",
	"Community",
	"Education",
	"Analysis",
];

type PublishTemplateFormProps = {
	template: {
		id: string;
		title: string;
		content: string;
	};
	onPublish: (payload: {
		templateId: string;
		payload: {
			description?: string | null;
			tags?: string[] | null;
			language?: string | null;
			is_anonymous?: boolean;
		};
	}) => void;
	onCancel: () => void;
	isPublishing?: boolean;
	defaultLanguage?: string;
	userName?: string | null;
};

export const PublishTemplateForm = ({
	template,
	onPublish,
	onCancel,
	isPublishing = false,
	defaultLanguage,
	userName,
}: PublishTemplateFormProps) => {
	const [description, setDescription] = useState("");
	const [selectedTags, setSelectedTags] = useState<string[]>([]);
	const [identity, setIdentity] = useState<"named" | "anonymous">(
		userName ? "named" : "anonymous",
	);

	const toggleTag = (tag: string) => {
		setSelectedTags((prev) => {
			if (prev.includes(tag)) {
				return prev.filter((t) => t !== tag);
			}
			if (prev.length >= 3) return prev;
			return [...prev, tag];
		});
	};

	const handleSubmit = () => {
		onPublish({
			templateId: template.id,
			payload: {
				description: description.trim() || null,
				tags: selectedTags.length > 0 ? selectedTags : null,
				language: defaultLanguage ?? null,
				is_anonymous: identity === "anonymous",
			},
		});
	};

	return (
		<Paper p="md" withBorder bg="blue.0">
			<Stack gap="sm">
				<Text size="sm" fw={500}>
					<Trans>Share with the community</Trans>
				</Text>

				{/* Preview */}
				<Paper p="sm" bg="white" radius="sm" withBorder>
					<Text size="sm" fw={500}>
						{template.title}
					</Text>
					<Text size="xs" c="dimmed" lineClamp={3} mt={4}>
						{template.content}
					</Text>
				</Paper>

				{/* Description */}
				<Textarea
					placeholder={t`Describe how this template is useful...`}
					value={description}
					onChange={(e) => setDescription(e.currentTarget.value)}
					maxLength={500}
					minRows={2}
					maxRows={4}
					autosize
				/>

				{/* Tags */}
				<Stack gap={4}>
					<Text size="xs" c="dimmed">
						<Trans>Tags (max 3)</Trans>
					</Text>
					<Group gap={4}>
						{ALLOWED_TAGS.map((tag) => (
							<Badge
								key={tag}
								size="sm"
								variant={
									selectedTags.includes(tag) ? "filled" : "light"
								}
								color={
									selectedTags.includes(tag) ? "blue" : "gray"
								}
								className="cursor-pointer"
								onClick={() => toggleTag(tag)}
								style={{
									opacity:
										!selectedTags.includes(tag) &&
										selectedTags.length >= 3
											? 0.5
											: 1,
								}}
							>
								{tag}
							</Badge>
						))}
					</Group>
				</Stack>

				{/* Identity */}
				<Radio.Group
					value={identity}
					onChange={(v) => setIdentity(v as "named" | "anonymous")}
				>
					<Group gap="md">
						{userName && (
							<Radio
								value="named"
								label={userName}
							/>
						)}
						<Radio
							value="anonymous"
							label={t`Anonymous host`}
						/>
					</Group>
				</Radio.Group>

				<Text size="xs" c="dimmed">
					<Trans>
						Other hosts can see and copy your template. You can unpublish at any time.
					</Trans>
				</Text>

				{/* Actions */}
				<Group justify="flex-end" gap="xs">
					<Button variant="default" size="xs" onClick={onCancel}>
						<Trans>Cancel</Trans>
					</Button>
					<Button
						size="xs"
						onClick={handleSubmit}
						loading={isPublishing}
					>
						<Trans>Publish</Trans>
					</Button>
				</Group>
			</Stack>
		</Paper>
	);
};
