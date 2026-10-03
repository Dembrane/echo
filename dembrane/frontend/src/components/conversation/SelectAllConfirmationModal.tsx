import { t } from "@lingui/core/macro";
import { Plural, Trans } from "@lingui/react/macro";
import {
	Alert,
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Loader,
	Modal,
	ScrollArea,
	Stack,
	Tabs,
	Text,
} from "@mantine/core";
import {
	CheckIcon,
	FileXIcon,
	ScalesIcon,
	SealCheckIcon,
	WarningIcon,
	XIcon,
} from "@phosphor-icons/react";
import { testId } from "@/lib/testUtils";

// One rule between result rows (the read grammar, a single container).
const RULE = "var(--app-stroke) solid var(--app-rule-color)";

type SelectAllConfirmationModalProps = {
	opened: boolean;
	onClose: () => void;
	onConfirm: () => void;
	onExitTransitionEnd?: () => void;
	totalCount: number;
	hasFilters: boolean;
	isLoading: boolean;
	result: {
		added: SelectAllConversationResult[];
		skipped: SelectAllConversationResult[];
		contextLimitReached: boolean;
	} | null;
	existingContextCount: number;
	filterNames: string[];
	hasVerifiedOutcomesFilter?: boolean;
	searchText?: string;
};

// Component to display active filters (search text, tags, verified badge)
const FilterDisplay = ({
	searchText,
	filterNames,
	hasVerifiedOutcomesFilter,
}: {
	searchText?: string;
	filterNames: string[];
	hasVerifiedOutcomesFilter: boolean;
}) => {
	const hasAnyFilters =
		!!searchText || filterNames.length > 0 || hasVerifiedOutcomesFilter;

	if (!hasAnyFilters) return null;

	return (
		<Stack gap="sm" mt="sm">
			{searchText && (
				<Group gap="xs" align="center">
					<Text size="sm">
						<Trans id="select.all.modal.search.text">Search text:</Trans>
					</Text>
					<Text size="sm">"{searchText}"</Text>
				</Group>
			)}
			{filterNames.length > 0 && (
				<Group gap="xs" align="center">
					<Text size="sm">
						<Trans id="select.all.modal.tags">
							<Plural value={filterNames.length} one="Tag:" other="Tags:" />
						</Trans>
					</Text>
					{filterNames.map((tagName) => (
						<Badge key={tagName} size="sm" color="gray">
							{tagName}
						</Badge>
					))}
				</Group>
			)}
			{hasVerifiedOutcomesFilter && (
				<Group gap="xs" align="center">
					<Badge
						color="gray"
						size="md"
						rightSection={<SealCheckIcon size={16} />}
					>
						<Trans id="select.all.modal.verified">Verified</Trans>
					</Badge>
				</Group>
			)}
		</Stack>
	);
};

const getReasonLabel = (reason: SelectAllConversationResult["reason"]) => {
	switch (reason) {
		case "already_in_context":
			return t`Already in context`;
		case "context_limit_reached":
			return t`Selection too large`;
		case "empty":
			return t`No content`;
		case "too_long":
			return t`Too long`;
		case "error":
			return t`Error occurred`;
		default:
			return t`Unknown reason`;
	}
};

const getReasonIcon = (reason: SelectAllConversationResult["reason"]) => {
	switch (reason) {
		case "already_in_context":
			return <CheckIcon size={16} />;
		case "context_limit_reached":
			return <ScalesIcon size={16} />;
		case "empty":
			return <FileXIcon size={16} />;
		case "too_long":
			return <WarningIcon size={16} />;
		case "error":
			return <XIcon size={16} />;
		default:
			return <WarningIcon size={16} />;
	}
};

const getReasonColor = (reason: SelectAllConversationResult["reason"]) => {
	switch (reason) {
		case "already_in_context":
			return "gray";
		case "context_limit_reached":
			return "yellow";
		case "empty":
			return "gray";
		case "too_long":
			return "red";
		case "error":
			return "red";
		default:
			return "gray";
	}
};

export const SelectAllConfirmationModal = ({
	opened,
	onClose,
	onConfirm,
	onExitTransitionEnd,
	totalCount,
	hasFilters,
	isLoading,
	result,
	existingContextCount,
	filterNames,
	hasVerifiedOutcomesFilter = false,
	searchText,
}: SelectAllConfirmationModalProps) => {
	// Filter out "already_in_context" from the displayed skipped list since those aren't really failures
	const reallySkipped =
		result?.skipped.filter((c) => c.reason !== "already_in_context") ?? [];

	const skippedDueToLimit = reallySkipped.filter(
		(c) => c.reason === "context_limit_reached",
	);
	const skippedDueToOther = reallySkipped.filter(
		(c) => c.reason !== "context_limit_reached",
	);

	// Determine default tab - first non-empty tab
	const getDefaultTab = () => {
		if (result?.added && result.added.length > 0) return "added";
		if (skippedDueToLimit.length > 0) return "limit";
		if (skippedDueToOther.length > 0) return "other";
		return "added";
	};

	return (
		<Modal
			opened={opened}
			onClose={onClose}
			onExitTransitionEnd={onExitTransitionEnd}
			title={
				result ? (
					<Trans id="select.all.modal.title.results">Select all results</Trans>
				) : (
					<Trans id="select.all.modal.title.add">
						Add conversations to context
					</Trans>
				)
			}
			size="lg"
			centered
			classNames={{
				body: "flex flex-col justify-between min-h-[300px]",
			}}
			{...testId("select-all-confirmation-modal")}
		>
			<Stack flex="1">
				{/* Initial confirmation view */}
				{!result && !isLoading && (
					<Stack gap="md" justify="space-between" flex="1">
						<Box py="md">
							<Stack gap="lg">
								{/* Warning about potential skips - show at top if many conversations or there might be empty ones */}
								{totalCount > 10 && (
									<Alert color="yellow">
										<Trans id="select.all.modal.skip.disclaimer">
											Some may be skipped (no transcript or selection too
											large).
										</Trans>
									</Alert>
								)}

								{/* Show existing context count if any */}
								{existingContextCount > 0 && (
									<Text size="sm">
										<Trans id="select.all.modal.already.added">
											You have already added{" "}
											<Text component="span">
												<Plural
													value={existingContextCount}
													one="# conversation"
													other="# conversations"
												/>
											</Text>{" "}
											to this chat.
										</Trans>
									</Text>
								)}

								{/* Main message about adding conversations */}
								<Box>
									<Text size="sm">
										{existingContextCount === 0 &&
											(hasFilters ? (
												<Trans id="select.all.modal.add.with.filters">
													Adding{" "}
													<Text component="span">
														<Plural
															value={totalCount}
															one="# conversation"
															other="# conversations"
														/>
													</Text>{" "}
													with the following filters:
												</Trans>
											) : (
												<Trans id="select.all.modal.add.without.filters">
													Adding{" "}
													<Text component="span">
														<Plural
															value={totalCount}
															one="# conversation"
															other="# conversations"
														/>
													</Text>{" "}
													to the chat
												</Trans>
											))}

										{existingContextCount > 0 &&
											(hasFilters ? (
												<Trans id="select.all.modal.add.with.filters.more">
													Adding{" "}
													<Text component="span">
														<Plural
															value={totalCount}
															one="# more conversation"
															other="# more conversations"
														/>
													</Text>{" "}
													with the following filters:
												</Trans>
											) : (
												<Trans id="select.all.modal.add.without.filters.more">
													Adding{" "}
													<Text component="span">
														<Plural
															value={totalCount}
															one="# more conversation"
															other="# more conversations"
														/>
													</Text>
												</Trans>
											))}
									</Text>

									{/* Filter display component */}
									<FilterDisplay
										searchText={searchText}
										filterNames={filterNames}
										hasVerifiedOutcomesFilter={hasVerifiedOutcomesFilter}
									/>
								</Box>
							</Stack>
						</Box>
						<Group justify="flex-start" gap="sm">
							<Button
								variant="filled"
								onClick={onConfirm}
								{...testId("select-all-proceed-button")}
							>
								<Trans id="select.all.modal.proceed">Proceed</Trans>
							</Button>
							<Button
								variant="subtle"
								color="gray"
								onClick={onClose}
								{...testId("select-all-cancel-button")}
							>
								<Trans id="select.all.modal.cancel">Cancel</Trans>
							</Button>
						</Group>
					</Stack>
				)}

				{/* Loading view */}
				{isLoading && (
					<Stack
						gap="lg"
						align="flex-start"
						py="lg"
						{...testId("select-all-loading-state")}
					>
						{/* Main message */}
						<Stack gap="sm">
							<Group gap="sm">
								<Loader size="sm" />
								<Text size="lg">
									<Trans id="select.all.modal.loading.title">
										Adding conversations
									</Trans>
								</Text>
							</Group>
							<Text size="sm" c="dimmed" maw={400}>
								<Trans id="select.all.modal.loading.description">
									Processing{" "}
									<Text component="span">
										<Plural
											value={totalCount}
											one="# conversation"
											other="# conversations"
										/>
									</Text>{" "}
									and adding them to your chat
								</Trans>
							</Text>
						</Stack>

						{/* Filter indicator if filters are active */}
						{hasFilters && (
							<Box>
								<Text size="xs" c="dimmed">
									<Trans id="select.all.modal.loading.filters">
										Active filters
									</Trans>
								</Text>
								{(searchText ||
									filterNames.length > 0 ||
									hasVerifiedOutcomesFilter) && (
									<Group gap="xs" mt="xs" wrap="wrap">
										{searchText && (
											<Badge size="sm" color="gray">
												<Trans id="select.all.modal.loading.search">
													Search
												</Trans>
											</Badge>
										)}
										{filterNames.length > 0 && (
											<Badge size="sm" color="gray">
												<Plural
													value={filterNames.length}
													one="# tag"
													other="# tags"
												/>
											</Badge>
										)}
										{hasVerifiedOutcomesFilter && (
											<Badge
												size="sm"
												color="gray"
												rightSection={<SealCheckIcon size={16} />}
											>
												<Trans id="select.all.modal.loading.verified">
													Verified
												</Trans>
											</Badge>
										)}
									</Group>
								)}
							</Box>
						)}
					</Stack>
				)}

				{/* Results view */}
				{result && !isLoading && (
					<>
						{/* Summary badges */}
						<Group gap="md" mt="md">
							<Badge
								color="gray"
								size="lg"
								{...testId("select-all-added-count-badge")}
							>
								<Trans id="select.all.modal.added.count">
									{result.added.length} added
								</Trans>
							</Badge>
							{reallySkipped.length > 0 && (
								<Badge
									color="yellow"
									size="lg"
									{...testId("select-all-skipped-count-badge")}
								>
									<Trans id="select.all.modal.not.added.count">
										{reallySkipped.length} not added
									</Trans>
								</Badge>
							)}
						</Group>

						{result.contextLimitReached && (
							<Alert
								color="yellow"
								icon={<ScalesIcon size={20} />}
								{...testId("select-all-context-limit-warning")}
							>
								<Trans id="select.all.modal.context.limit.reached">
									Selection too large. Some conversations weren't added.
								</Trans>
							</Alert>
						)}

						{/* Tabs for conversation lists */}
						<Tabs
							defaultValue={getDefaultTab()}
							variant="default"
							{...testId("select-all-results-tabs")}
						>
							<Tabs.List grow>
								{result.added.length > 0 && (
									<Tabs.Tab
										value="added"
										rightSection={<CheckIcon size={16} />}
										leftSection={
											<Badge size="sm" color="gray">
												{result.added.length}
											</Badge>
										}
										{...testId("select-all-tab-added")}
									>
										<Trans id="select.all.modal.added">Added</Trans>
									</Tabs.Tab>
								)}
								{skippedDueToOther.length > 0 && (
									<Tabs.Tab
										value="other"
										rightSection={<WarningIcon size={16} />}
										leftSection={
											<Badge size="sm" color="gray">
												{skippedDueToOther.length}
											</Badge>
										}
										{...testId("select-all-tab-not-added")}
									>
										<Trans id="select.all.modal.not.added">Not added</Trans>
									</Tabs.Tab>
								)}
								{skippedDueToLimit.length > 0 && (
									<Tabs.Tab
										value="limit"
										rightSection={<ScalesIcon size={16} />}
										leftSection={
											<Badge size="sm" color="gray">
												{skippedDueToLimit.length}
											</Badge>
										}
										{...testId("select-all-tab-too-large")}
									>
										<Trans id="select.all.modal.context.limit">Too large</Trans>
									</Tabs.Tab>
								)}
							</Tabs.List>

							{/* Added conversations tab */}
							{result.added.length > 0 && (
								<Tabs.Panel value="added" pt="md">
									<ScrollArea.Autosize h={400}>
										<Stack gap={0} style={{ borderTop: RULE }}>
											{result.added.map((conv) => (
												<Group
													key={conv.conversation_id}
													gap="md"
													wrap="nowrap"
													py="xs"
													style={{ borderBottom: RULE }}
												>
													<CheckIcon size={16} className="flex-shrink-0" />
													<Text size="sm" lineClamp={1}>
														{conv.participant_name}
													</Text>
												</Group>
											))}
										</Stack>
									</ScrollArea.Autosize>
								</Tabs.Panel>
							)}

							{/* Skipped because selection too large */}
							{skippedDueToLimit.length > 0 && (
								<Tabs.Panel value="limit" pt="md">
									<Stack gap="sm">
										<Text size="xs" c="dimmed">
											<Trans id="select.all.modal.context.limit.reached.description">
												Skipped because the selection was too large.
											</Trans>
										</Text>
										<ScrollArea.Autosize h={400}>
											<Stack gap={0} style={{ borderTop: RULE }}>
												{skippedDueToLimit.map((conv) => (
													<Group
														key={conv.conversation_id}
														gap="sm"
														wrap="nowrap"
														justify="space-between"
														py="xs"
														style={{ borderBottom: RULE }}
													>
														<Text size="sm" lineClamp={1}>
															{conv.participant_name}
														</Text>
														<Badge
															color={getReasonColor(conv.reason)}
															size="sm"
															rightSection={getReasonIcon(conv.reason)}
															className="flex-shrink-0"
														>
															{getReasonLabel(conv.reason)}
														</Badge>
													</Group>
												))}
											</Stack>
										</ScrollArea.Autosize>
									</Stack>
								</Tabs.Panel>
							)}

							{/* Skipped due to other reasons tab */}
							{skippedDueToOther.length > 0 && (
								<Tabs.Panel value="other" pt="md">
									<Stack gap="sm">
										<Text size="xs" c="dimmed">
											<Trans id="select.all.modal.other.reason.description">
												These conversations were excluded due to missing
												transcripts.
											</Trans>
										</Text>
										<ScrollArea.Autosize h={400}>
											<Stack gap={0} style={{ borderTop: RULE }}>
												{skippedDueToOther.map((conv) => (
													<Group
														key={conv.conversation_id}
														gap="md"
														wrap="nowrap"
														justify="space-between"
														py="xs"
														style={{ borderBottom: RULE }}
													>
														<Text size="sm" lineClamp={1}>
															{conv.participant_name}
														</Text>
														<Badge
															color={getReasonColor(conv.reason)}
															size="sm"
															rightSection={getReasonIcon(conv.reason)}
															className="flex-shrink-0"
														>
															{getReasonLabel(conv.reason)}
														</Badge>
													</Group>
												))}
											</Stack>
										</ScrollArea.Autosize>
									</Stack>
								</Tabs.Panel>
							)}
						</Tabs>
						{/* Empty state - no conversations processed */}
						{result?.added?.length === 0 && reallySkipped.length === 0 && (
							<Text
								size="sm"
								c="dimmed"
								mt="md"
								{...testId("select-all-no-conversations-alert")}
							>
								<Trans id="select.all.modal.no.conversations">
									No conversations were processed. This may happen if all
									conversations are already in context or don't match the
									selected filters.
								</Trans>
							</Text>
						)}
						<Divider />

						<Group justify="flex-start" mt="auto">
							<Button
								variant="subtle"
								color="gray"
								onClick={onClose}
								{...testId("select-all-close-button")}
							>
								<Trans id="select.all.modal.close">Close</Trans>
							</Button>
						</Group>
					</>
				)}
			</Stack>
		</Modal>
	);
};
