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
	Pill,
	ScrollArea,
	Stack,
	Tabs,
	Text,
} from "@mantine/core";
import {
	IconAlertTriangle,
	IconCheck,
	IconFileOff,
	IconRosetteDiscountCheckFilled,
	IconScale,
	IconX,
} from "@tabler/icons-react";

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
		<Stack gap="sm" mt="sm" pl="md">
			{searchText && (
				<Group gap="xs" align="center">
					<Text size="sm" fw={700}>
						•
					</Text>
					<Text size="sm" fw={600}>
						<Trans id="select.all.modal.search.text">Search text:</Trans>
					</Text>
					<Text size="sm" className="border px-3 rounded-sm">
						"{searchText}"
					</Text>
				</Group>
			)}
			{filterNames.length > 0 && (
				<Group gap="xs" align="center">
					<Text size="sm" fw={700}>
						•
					</Text>
					<Text size="sm" fw={600}>
						<Trans id="select.all.modal.tags">
							<Plural value={filterNames.length} one="Tag:" other="Tags:" />
						</Trans>
					</Text>
					{filterNames.map((tagName) => (
						<Pill
							key={tagName}
							size="sm"
							classNames={{
								root: "!bg-[var(--mantine-primary-color-light)] !font-medium",
							}}
						>
							{tagName}
						</Pill>
					))}
				</Group>
			)}
			{hasVerifiedOutcomesFilter && (
				<Group gap="xs" align="center">
					<Text size="sm" fw={700}>
						•
					</Text>
					<Badge
						color="blue"
						variant="light"
						size="md"
						leftSection={<IconRosetteDiscountCheckFilled size={14} />}
						style={{ width: "fit-content" }}
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
			return <IconCheck size={14} />;
		case "context_limit_reached":
			return <IconScale size={14} />;
		case "empty":
			return <IconFileOff size={14} />;
		case "too_long":
			return <IconAlertTriangle size={14} />;
		case "error":
			return <IconX size={14} />;
		default:
			return <IconAlertTriangle size={14} />;
	}
};

const getReasonColor = (reason: SelectAllConversationResult["reason"]) => {
	switch (reason) {
		case "already_in_context":
			return "blue";
		case "context_limit_reached":
			return "orange";
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
				<Text fw={600} size="lg" style={{ color: "var(--app-text)" }}>
					{result ? (
						<Trans id="select.all.modal.title.results">
							Select All Results
						</Trans>
					) : (
						<Trans id="select.all.modal.title.add">
							Add Conversations to Context
						</Trans>
					)}
				</Text>
			}
			size="lg"
			centered
			classNames={{
				body: "flex flex-col justify-between min-h-[300px]",
				header: "border-b",
			}}
		>
			<Stack flex="1">
				{/* Initial confirmation view */}
				{!result && !isLoading && (
					<Stack gap="md" justify="space-between" flex="1">
						<Box className="py-4">
							<Stack gap="lg">
								{/* Warning about potential skips - show at top if many conversations or there might be empty ones */}
								{totalCount > 10 && (
									<Alert variant="light" color="orange">
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
											<Text component="span" fw={600}>
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
									<Text size="sm" style={{ color: "var(--app-text)" }}>
										{existingContextCount === 0 &&
											(hasFilters ? (
												<Trans id="select.all.modal.add.with.filters">
													Adding{" "}
													<Text component="span" fw={700}>
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
													<Text component="span" fw={700}>
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
													<Text component="span" fw={700}>
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
													<Text component="span" fw={700}>
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
						<Group justify="flex-end" gap="sm">
							<Button variant="subtle" onClick={onClose}>
								<Trans id="select.all.modal.cancel">Cancel</Trans>
							</Button>
							<Button onClick={onConfirm} radius={100}>
								<Trans id="select.all.modal.proceed">Proceed</Trans>
							</Button>
						</Group>
					</Stack>
				)}

				{/* Loading view */}
				{isLoading && (
					<Stack
						gap="xl"
						align="center"
						justify="center"
						className="py-12"
						style={{ minHeight: 300 }}
					>
						{/* Animated loader section */}
						<Box className="relative">
							<Loader size={60} type="dots" />
							<Box
								className="absolute inset-0 flex items-center justify-center"
								style={{
									animation: "pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite",
								}}
							>
								<IconCheck
									size={28}
									className="opacity-20"
									style={{ color: "var(--mantine-primary-color-6)" }}
								/>
							</Box>
						</Box>

						{/* Main message */}
						<Stack gap="sm" align="center">
							<Text size="lg" fw={600} style={{ color: "var(--app-text)" }}>
								<Trans id="select.all.modal.loading.title">
									Adding Conversations
								</Trans>
							</Text>
							<Text
								size="sm"
								c="dimmed"
								ta="center"
								maw={400}
								className="leading-relaxed"
							>
								<Trans id="select.all.modal.loading.description">
									Processing{" "}
									<Text component="span" fw={600} c="primary">
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
							<Box
								className="rounded-lg border px-4 py-3"
								style={{
									backgroundColor: "var(--mantine-color-gray-0)",
									borderColor: "var(--mantine-color-gray-3)",
									maxWidth: 400,
								}}
							>
								<Text size="xs" c="dimmed" ta="center">
									<Trans id="select.all.modal.loading.filters">
										Active filters
									</Trans>
								</Text>
								{(searchText ||
									filterNames.length > 0 ||
									hasVerifiedOutcomesFilter) && (
									<Group justify="center" gap="xs" mt="xs" wrap="wrap">
										{searchText && (
											<Badge size="sm" variant="light" color="gray">
												<Trans id="select.all.modal.loading.search">
													Search
												</Trans>
											</Badge>
										)}
										{filterNames.length > 0 && (
											<Badge size="sm" variant="light" color="primary">
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
												variant="light"
												color="blue"
												leftSection={
													<IconRosetteDiscountCheckFilled size={12} />
												}
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
							<Badge color="primary" size="lg" variant="light">
								<Trans id="select.all.modal.added.count">
									{result.added.length} added
								</Trans>
							</Badge>
							{reallySkipped.length > 0 && (
								<Badge color="orange" size="lg" variant="light">
									<Trans id="select.all.modal.not.added.count">
										{reallySkipped.length} not added
									</Trans>
								</Badge>
							)}
						</Group>

						{result.contextLimitReached && (
							<Box className="rounded-md border border-orange-200 bg-orange-50 p-3">
								<Group gap="xs">
									<IconScale size={18} className="text-orange-600" />
									<Text size="sm" fw={500} c="orange.7">
										<Trans id="select.all.modal.context.limit.reached">
											Selection too large. Some conversations weren't added.
										</Trans>
									</Text>
								</Group>
							</Box>
						)}

						{/* Tabs for conversation lists */}
						<Tabs defaultValue={getDefaultTab()} variant="default">
							<Tabs.List grow>
								{result.added.length > 0 && (
									<Tabs.Tab
										value="added"
										leftSection={<IconCheck size={16} />}
										rightSection={
											<Badge
												size="md"
												miw={30}
												variant="light"
												color="primary"
												circle
											>
												{result.added.length}
											</Badge>
										}
									>
										<Trans id="select.all.modal.added">Added</Trans>
									</Tabs.Tab>
								)}
								{skippedDueToOther.length > 0 && (
									<Tabs.Tab
										value="other"
										leftSection={<IconAlertTriangle size={16} />}
										rightSection={
											<Badge
												size="md"
												miw={30}
												variant="light"
												color="gray"
												circle
											>
												{skippedDueToOther.length}
											</Badge>
										}
									>
										<Trans id="select.all.modal.not.added">Not Added</Trans>
									</Tabs.Tab>
								)}
								{skippedDueToLimit.length > 0 && (
									<Tabs.Tab
										value="limit"
										leftSection={<IconScale size={16} />}
										rightSection={
											<Badge
												size="md"
												miw={30}
												variant="light"
												color="orange"
												circle
											>
												{skippedDueToLimit.length}
											</Badge>
										}
									>
										<Trans id="select.all.modal.context.limit">Too large</Trans>
									</Tabs.Tab>
								)}
							</Tabs.List>

							{/* Added conversations tab */}
							{result.added.length > 0 && (
								<Tabs.Panel value="added" pt="md">
									<ScrollArea.Autosize h={400}>
										<Stack gap="xs">
											{result.added.map((conv) => (
												<Group
													key={conv.conversation_id}
													gap="md"
													wrap="nowrap"
													className="rounded-md border border-primary-100 bg-primary-50 px-3 py-2"
												>
													<IconCheck
														size={16}
														className="flex-shrink-0 text-primary-600"
													/>
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
											<Stack gap="xs">
												{skippedDueToLimit.map((conv) => (
													<Group
														key={conv.conversation_id}
														gap="sm"
														wrap="nowrap"
														justify="space-between"
														className="rounded-md border border-orange-100 bg-orange-50 px-3 py-2"
													>
														<Text size="sm" lineClamp={1}>
															{conv.participant_name}
														</Text>
														<Badge
															color={getReasonColor(conv.reason)}
															size="sm"
															variant="light"
															leftSection={getReasonIcon(conv.reason)}
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
											<Stack gap="xs">
												{skippedDueToOther.map((conv) => (
													<Group
														key={conv.conversation_id}
														gap="md"
														wrap="nowrap"
														justify="space-between"
														className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2"
													>
														<Text size="sm" lineClamp={1}>
															{conv.participant_name}
														</Text>
														<Badge
															color={getReasonColor(conv.reason)}
															size="sm"
															variant="light"
															leftSection={getReasonIcon(conv.reason)}
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
							<Alert variant="light" color="blue" mt="md">
								<Trans id="select.all.modal.no.conversations">
									No conversations were processed. This may happen if all
									conversations are already in context or don't match the
									selected filters.
								</Trans>
							</Alert>
						)}
						<Divider />

						<Group justify="flex-end" mt="auto">
							<Button variant="subtle" onClick={onClose}>
								<Trans id="select.all.modal.close">Close</Trans>
							</Button>
						</Group>
					</>
				)}
			</Stack>
		</Modal>
	);
};
