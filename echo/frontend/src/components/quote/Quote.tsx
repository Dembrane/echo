import { ActionIcon, Group, Paper, Pill, Text, Tooltip } from "@mantine/core";
import {
	IconBulb,
	IconChevronDown,
	IconChevronUp,
	IconQuote,
} from "@tabler/icons-react";
import { Box } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { useCopyQuote } from "@/components/aspect/hooks/useCopyQuote";
import { cn } from "@/lib/utils";
import { CopyIconButton } from "../common/CopyIconButton";
import { I18nLink } from "../common/i18nLink";
import { RedactedText } from "../common/RedactedText";

// replacement for AspectSegment
export const Quote = ({
	data,
	className,
}: {
	data: AspectSegment;
	className?: string;
}) => {
	const { projectId } = useParams();
	const [showTranscript, setShowTranscript] = useState(false);
	const { copyQuote, copied } = useCopyQuote();

	let conversationId: string | undefined;
	try {
		conversationId =
			((data.segment as ConversationSegment)?.conversation_id as Conversation)
				?.id ?? "";
	} catch (e) {
		console.error(e);
	}

	// Parse the relevant_index to extract the portion of transcript
	const getTranscriptExcerpt = () => {
		if (!data.verbatim_transcript || !data.relevant_index) return null;

		const [startStr, endStr] = data.relevant_index.split(":");
		const start = Number.parseInt(startStr);
		const end = Number.parseInt(endStr);

		if (Number.isNaN(start) || Number.isNaN(end)) return null;

		return data.verbatim_transcript.slice(start, end);
	};

	const transcriptExcerpt = getTranscriptExcerpt();
	const hasTranscript = !!data.verbatim_transcript;

	return (
		<Paper
			p="md"
			className={cn("transition-all duration-200", className)}
			withBorder
			radius="md"
		>
			{/* Main insight/reason */}
			<Group justify="space-between" align="flex-start" mb="sm">
				<div className="flex-1">
					<Group mb="xs">
						<IconBulb
							size={16}
							className="mt-0.5 flex-shrink-0 text-blue-500"
						/>
						<Text size="sm" c="dimmed" fw={500}>
							Insight
						</Text>
					</Group>
					<Text size="md" fw={500} mb="xs">
						{data.description}
					</Text>
				</div>

				<CopyIconButton
					onCopy={() => copyQuote(data.description || "")}
					copied={copied}
					copyTooltip="Copy"
					size={16}
				/>
			</Group>

			{/* Supporting transcript */}
			{transcriptExcerpt && (
				<div className="mt-3 border-t border-gray-200 pt-3 dark:border-gray-700">
					<Group justify="space-between" align="center" mb="xs">
						<Group gap="xs">
							<IconQuote size={14} className="text-gray-500" />
							<Text size="xs" c="dimmed" fw={500}>
								Supporting Quote
								{data.relevant_index && (
									<Text component="span" size="xs" c="dimmed" ml="xs">
										({data.relevant_index})
									</Text>
								)}
							</Text>
						</Group>

						{hasTranscript && (
							<Tooltip
								label={
									showTranscript ? "Hide full context" : "Show full context"
								}
							>
								<ActionIcon
									variant="subtle"
									size="sm"
									onClick={() => setShowTranscript(!showTranscript)}
								>
									{showTranscript ? (
										<IconChevronUp size={14} />
									) : (
										<IconChevronDown size={14} />
									)}
								</ActionIcon>
							</Tooltip>
						)}
					</Group>

					<Box
						className={cn(
							"rounded-lg bg-gray-50 p-3 text-sm",
							!showTranscript &&
								hasTranscript &&
								"cursor-pointer transition-colors hover:bg-gray-100",
						)}
						onClick={() =>
							!showTranscript && hasTranscript && setShowTranscript(true)
						}
					>
						{showTranscript ? (
							<div className="space-y-3">
							<Text
								size="sm"
								className="whitespace-pre-wrap italic leading-relaxed"
							>
								<RedactedText>{data.verbatim_transcript ?? ""}</RedactedText>
							</Text>
								{data.relevant_index && (
									<div className="border-t border-gray-300 pt-2 dark:border-gray-600">
										<Text size="xs" c="dimmed">
											<strong>Highlighted portion:</strong> characters{" "}
											{data.relevant_index}
										</Text>
									</div>
								)}
							</div>
						) : (
							<div>
							<Text size="sm" className="italic" lineClamp={2}>
								"<RedactedText>{transcriptExcerpt}</RedactedText>"
							</Text>
								{hasTranscript && (
									<Text size="xs" c="dimmed" mt="xs">
										Click to see full context
									</Text>
								)}
							</div>
						)}
					</Box>
				</div>
			)}

			{/* Conversation link */}
			{conversationId && (
				<Group
					mt="md"
					pt="sm"
					className="border-t border-gray-200 dark:border-gray-700"
				>
					<I18nLink
						to={`/projects/${projectId}/conversation/${conversationId}/transcript`}
					>
						<Pill
							size="sm"
							variant="light"
							className="transition-colors hover:bg-blue-100 dark:hover:bg-blue-900"
						>
							{(
								(data.segment as ConversationSegment)
									.conversation_id as Conversation
							).participant_name ?? "View Conversation"}
						</Pill>
					</I18nLink>
				</Group>
			)}
		</Paper>
	);
};
