import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Stack, Text } from "@mantine/core";
import type { DocumentSummaryT, TaskT } from "../../contract/contract.gen";
import { DpaHint } from "../../DpaHint";
import {
	documentTitle,
	formatDate,
	taskStatusLabel,
	taskText,
} from "../../format";
import { PageSection, Rows } from "../PageSection";
import { KindIcon, kindOf, TaskLine } from "../TaskLine";

/**
 * The tasks a room member reads: those on the offer and the DPA, with where each stands,
 * the answer given, the name of a file sent and dembrane's review note. Nothing to
 * answer, upload, sign or send: those who run the account do that. A file is its name
 * only, as no customer route serves a task's file.
 */
export function ReadOnlyTasks({
	tasks,
	documents,
}: {
	tasks: TaskT[];
	documents: DocumentSummaryT[];
}) {
	const { i18n } = useLingui();
	return (
		<PageSection
			title={
				<DpaHint>
					<span>
						<Trans>On the offer and the DPA</Trans>
					</span>
				</DpaHint>
			}
			count={tasks.length}
		>
			<div data-testid="room-tasks">
				{tasks.length === 0 ? (
					<Text c="dimmed" py="sm">
						<Trans>Nothing here yet.</Trans>
					</Text>
				) : (
					<Rows>
						{tasks.map((task) => {
							const { title, body } = taskText(task);
							const answer = task.response_text;
							const note = task.review_note;
							const doc = documents.find((d) => d.id === task.document_id);
							const when = formatDate(
								task.reviewed_at ?? task.submitted_at ?? task.due_on,
								i18n.locale,
							);
							return (
								<TaskLine
									key={task.id}
									testId="room-task"
									marker={<KindIcon kind={kindOf(task)} quiet />}
									title={title}
									fact={
										<Stack gap={4} component="span">
											<Text span display="block" size="sm" c="dimmed">
												{[
													taskStatusLabel(task.status),
													doc ? documentTitle(doc) : null,
													when,
												]
													.filter(Boolean)
													.join(" · ")}
											</Text>
											{body && (
												<Text span display="block" size="sm">
													{body}
												</Text>
											)}
											{task.response_text && (
												<Text span display="block" size="sm">
													<Trans>Answer: {answer}</Trans>
												</Text>
											)}
											{task.response_file_name && (
												<Text span display="block" size="sm">
													<Trans>File:</Trans>{" "}
													<span>{task.response_file_name}</span>
												</Text>
											)}
											{task.review_note && (
												<Text span display="block" size="sm">
													<Trans>From dembrane: {note}</Trans>
												</Text>
											)}
										</Stack>
									}
								/>
							);
						})}
					</Rows>
				)}
			</div>
		</PageSection>
	);
}
