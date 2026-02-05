import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Checkbox,
	Group,
	Stack,
	Text,
} from "@mantine/core";
import { IconBulb, IconCheck, IconLock } from "@tabler/icons-react";
import { useParams } from "react-router";
import { useProjectChatContext } from "@/components/chat/hooks";
import { useProjectById } from "@/components/project/hooks";
import { analytics } from "@/lib/analytics";
import { AnalyticsEvents as events } from "@/lib/analyticsEvents";
import { SalesLinks } from "@/lib/links";
import {
	useAddChatContextMutation,
	useDeleteChatContextMutation,
} from "./hooks";

export const AutoSelectConversations = () => {
	const { chatId, projectId } = useParams();

	const { data: project } = useProjectById({
		projectId: projectId ?? "",
		query: {
			fields: ["is_enhanced_audio_processing_enabled"],
		},
	});

	const projectChatContextQuery = useProjectChatContext(chatId ?? "");
	const addChatContextMutation = useAddChatContextMutation();
	const deleteChatContextMutation = useDeleteChatContextMutation();

	// Get the auto_select_bool value from the chat context
	const autoSelect = projectChatContextQuery.data?.auto_select_bool ?? false;

	const isDisabled = !project?.is_enhanced_audio_processing_enabled;
	const isAvailableButNotEnabled = !autoSelect && !isDisabled;

	const handleCheckboxChange = (checked: boolean) => {
		if (isDisabled) {
			return;
		}

		if (checked) {
			addChatContextMutation.mutate({
				auto_select_bool: true,
				chatId: chatId ?? "",
			});
		} else {
			deleteChatContextMutation.mutate({
				auto_select_bool: false,
				chatId: chatId ?? "",
			});
		}
	};

	const enableAutoSelect = () => {
		if (!isDisabled) {
			addChatContextMutation.mutate({
				auto_select_bool: true,
				chatId: chatId ?? "",
			});
		} else {
			try {
				analytics.trackEvent(events.AUTO_SELECT_CONTACT_SALES);
			} catch (error) {
				console.warn("Analytics tracking failed:", error);
			}
			window.open(SalesLinks.AUTO_SELECT_CONTACT, "_blank");
		}
	};

	// Feature state indicator
	const renderFeatureIndicator = () => {
		if (autoSelect) {
			return (
				<Badge
					color="green"
					variant="light"
					leftSection={<IconCheck size={14} />}
				>
					<Trans>Enabled</Trans>
				</Badge>
			);
		} else if (isAvailableButNotEnabled) {
			return (
				<Badge
					color="primary"
					variant="light"
					leftSection={<IconBulb size={14} />}
				>
					<Trans>Available</Trans>
				</Badge>
			);
		} else {
			return (
				<Badge
					color="gray"
					variant="light"
					leftSection={<IconLock size={14} />}
				>
					<Trans>Upgrade</Trans>
				</Badge>
			);
		}
	};

	return (
		<Box className="relative cursor-pointer border border-gray-200 hover:bg-gray-50">
			<Badge
				className="absolute right-0 top-0 -translate-y-1/3 translate-x-1/3"
				color="red"
				size="sm"
			>
				<Trans>New</Trans>
			</Badge>

			<Group
				justify="space-between"
				p="md"
				wrap="nowrap"
				className={isDisabled ? "opacity-50" : ""}
			>
				<Stack gap="xs" style={{ flexGrow: 1 }}>
					<Group gap="xs">
						<Text className="font-medium">
							<Trans>Auto-select</Trans>
						</Text>

						{renderFeatureIndicator()}
					</Group>
					<Text size="xs" c="gray.6">
						<Trans>
							Automatically includes relevant conversations for analysis without
							manual selection
						</Trans>
					</Text>
				</Stack>
				<Checkbox
					size="md"
					checked={autoSelect}
					disabled={isDisabled}
					color="green"
					onClick={(e) => e.stopPropagation()}
					onChange={(e) => handleCheckboxChange(e.currentTarget.checked)}
				/>
			</Group>

			{isDisabled && (
				<Box className="border-t border-gray-200 bg-gray-50 p-4">
					<Stack gap="sm">
						<Text size="xs" fw={500}>
							<Trans>
								Upgrade to unlock Auto-select and analyze 10x more conversations
								in half the time—no more manual selection, just deeper insights
								instantly.
							</Trans>
						</Text>
						<Button
							size="xs"
							onClick={enableAutoSelect}
							rightSection={<IconLock size={14} />}
						>
							<Trans>Request Access</Trans>
						</Button>
					</Stack>
				</Box>
			)}
		</Box>
	);
};
