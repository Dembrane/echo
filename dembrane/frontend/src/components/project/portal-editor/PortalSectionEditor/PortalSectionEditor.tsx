import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Box,
	Button,
	Collapse,
	Group,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDisclosure, useMediaQuery } from "@mantine/hooks";
import { DeviceMobileIcon } from "@phosphor-icons/react";
import {
	type ComponentType,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useState,
} from "react";
import { SaveStatus } from "@/components/form/SaveStatus";
import { useProjectLegalQuery } from "@/components/project/ProjectLegalBasisSection";
import { ENABLE_PARTICIPANT_EMAIL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { track } from "@/lib/analytics/events";
import type { VerificationTopicsResponse } from "@/lib/api";
import type { PreviewScreen } from "@/lib/portalPreview/protocol";
import { testId } from "@/lib/testUtils";
import { OptionStepper, type StepVia } from "../OptionStepper/OptionStepper";
import type { SectionKey } from "../portalForm";
import { buildPreviewMessage } from "../preview/buildPreviewMessage";
import { PortalPreviewFrame } from "../preview/PortalPreviewFrame";
import { sectionDescription, sectionTitle } from "../sectionLabels";
import {
	applicableOptions,
	nextSection,
	type OptionFlags,
	resolveOption,
	SECTIONS,
} from "../sections";
import { useAboutOptions } from "../sections/about";
import { useExploreOptions } from "../sections/explore";
import { useFinishOptions } from "../sections/finish";
import { usePrivacyOptions } from "../sections/privacy";
import type { SectionContent, SectionProps } from "../sections/types";
import { useVerifyOptions } from "../sections/verify";
import { useWelcomeOptions } from "../sections/welcome";
import { TryItAction } from "../try-it/TryItAction";
import { previewResultOf, type TrySection, tryRequest } from "../try-it/tryIt";
import { useTryIt } from "../try-it/useTryIt";
import { usePortalPageForm } from "../usePortalPageForm";

interface SectionOptionsProps {
	props: SectionProps;
	children: (content: SectionContent) => ReactNode;
}

/**
 * A page's options hook as a component of its own: each page's hook runs in its own
 * component, so moving to another page mounts another component and never calls a
 * different hook in the same place.
 */
const sectionOptions = (
	useOptions: (props: SectionProps) => SectionContent,
) => {
	const SectionOptions = ({ props, children }: SectionOptionsProps) => (
		<>{children(useOptions(props))}</>
	);
	return SectionOptions;
};

const OPTIONS: Record<SectionKey, ComponentType<SectionOptionsProps>> = {
	about: sectionOptions(useAboutOptions),
	explore: sectionOptions(useExploreOptions),
	finish: sectionOptions(useFinishOptions),
	privacy: sectionOptions(usePrivacyOptions),
	verify: sectionOptions(useVerifyOptions),
	welcome: sectionOptions(useWelcomeOptions),
};

interface PortalSectionEditorProps {
	project: Project;
	section: SectionKey;
	option: string | undefined;
	readOnly: boolean;
	/** The project's tags as they are now (they save themselves). */
	tags: readonly ProjectTag[];
	verificationTopics?: VerificationTopicsResponse;
	isVerificationTopicsLoading?: boolean;
}

/**
 * One page of the portal editor (ECHO-1060): its title and options one at a time on the
 * left, the participant screen they change on the right, level with the title and kept in
 * view while the options scroll (ECHO-1062); under the options on a phone, behind a
 * "Preview" button. The open option is in the address, so a reload opens it again.
 */
export const PortalSectionEditor = ({
	project,
	section,
	option,
	readOnly,
	tags,
	verificationTopics,
	isVerificationTopicsLoading,
}: PortalSectionEditorProps) => {
	const navigate = useI18nNavigate();
	const wide = useMediaQuery("(min-width: 62em)", true);
	const [previewOpen, preview] = useDisclosure(false);
	const page = usePortalPageForm({
		isVerificationTopicsLoading,
		project,
		readOnly,
		section,
		verificationTopics,
	});
	// Asking for email sits behind ENABLE_PARTICIPANT_EMAIL (ECHO-1052). Off, the settings
	// show only where a project already has them on, so its host can switch them off.
	const flags: OptionFlags = {
		showAskForEmail:
			ENABLE_PARTICIPANT_EMAIL ||
			!!project.default_conversation_ask_for_participant_email,
		showReportNotifications:
			ENABLE_PARTICIPANT_EMAIL ||
			!!project.is_project_notification_subscription_allowed,
	};
	const props: SectionProps = {
		flags,
		isVerificationTopicsLoading,
		page,
		project,
		readOnly,
		verificationTopics,
	};
	const Options = OPTIONS[section];
	const defs = applicableOptions(section, page.values, flags);
	const open = resolveOption(section, option, page.values, flags);
	const base = `/w/${project.workspace_id}/projects/${project.id}/portal`;

	// The address names the open option; one that does not apply (any more) gives way.
	useEffect(() => {
		if (open && option !== open.key)
			navigate(`${base}/${section}/${open.key}`, { replace: true });
	}, [open, option, base, section, navigate]);

	useEffect(() => {
		track("portal_editor_section_viewed", {
			project_id: project.id,
			section,
		});
	}, [project.id, section]);

	const onOpen = (key: string, via: StepVia) => {
		track("portal_editor_option_stepped", {
			option: key,
			project_id: project.id,
			section,
			via,
		});
		navigate(`${base}/${section}/${key}`, { replace: true });
	};

	const after = nextSection(section);

	// The screen follows the open option until the host picks another one. Each time the
	// host opens an option, edits one, picks a screen or tries a setting, the phone goes back
	// to that screen, even after clicking onward inside it (ECHO-1062): "reset" counts those
	// moments, and the portal starts the screen again on a new one.
	const [pickedScreen, setPickedScreen] = useState<PreviewScreen | null>(null);
	const [reset, setReset] = useState(0);
	const showScreen = useCallback((s: PreviewScreen | null) => {
		setPickedScreen(s);
		setReset((v) => v + 1);
	}, []);
	// An edit is a change in what the page holds: a save that keeps the values is not one.
	const edited = useMemo(
		() => JSON.stringify([page.values, tags]),
		[page.values, tags],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: the open option and an edit are the moments, not their values
	useEffect(() => showScreen(null), [open?.key, edited, showScreen]);
	const screen = pickedScreen ?? open?.screen ?? SECTIONS[section].screens[0];
	const screens = useMemo(() => {
		const list = [...SECTIONS[section].screens];
		if (open && !list.includes(open.screen)) list.unshift(open.screen);
		return list;
	}, [section, open]);

	// "Try it" on Explore and Verify (ECHO-1061): the real result replaces the example.
	const trySection: TrySection | null =
		section === "explore" || section === "verify" ? section : null;
	const { language, get_reply_mode, get_reply_prompt, verification_topics } =
		page.values;
	const tryBody = useMemo(
		() =>
			trySection
				? tryRequest(trySection, {
						get_reply_mode,
						get_reply_prompt,
						language,
						verification_topics,
					})
				: null,
		[
			trySection,
			language,
			get_reply_mode,
			get_reply_prompt,
			verification_topics,
		],
	);
	const tryTopic = verificationTopics?.available_topics.find(
		(topic) => topic.key === tryBody?.topic_key,
	);
	const tryIt = useTryIt({
		eventKey:
			trySection === "explore"
				? get_reply_mode
				: tryTopic?.is_custom
					? "custom"
					: (tryBody?.topic_key ?? ""),
		projectId: project.id,
		request: tryBody,
		section: trySection ?? "explore",
	});
	const tried = tryIt.result;
	// A new result is shown on the screen it belongs to.
	useEffect(() => {
		if (tried)
			showScreen(tried.kind === "explore" ? "explore" : "verify-summary");
	}, [tried, showScreen]);

	const legal = useProjectLegalQuery(project.id);
	const message = useMemo(
		() =>
			buildPreviewMessage({
				highlight: open?.screen === screen ? (open?.highlight ?? null) : null,
				legal: legal.data?._legal
					? {
							legal_basis: legal.data._legal.effective?.legal_basis,
							organiser_name: legal.data._legal.organiser_name,
							privacy_policy_url:
								legal.data._legal.effective?.privacy_policy_url,
						}
					: null,
				reset,
				screen,
				tags: tags.map((tag) => ({
					id: tag.id,
					text: tag.text ?? "",
				})),
				topics: verificationTopics,
				tried: tried
					? { kind: tried.kind, result: previewResultOf(tried) }
					: null,
				// Only the Verify page holds the chosen topics; the others show the saved ones.
				values:
					section === "verify"
						? page.values
						: {
								...page.values,
								verification_topics: verificationTopics?.selected_topics ?? [],
							},
			}),
		[
			section,
			page.values,
			legal.data,
			screen,
			open,
			tags,
			verificationTopics,
			tried,
			reset,
		],
	);

	const frame = (
		<PortalPreviewFrame
			projectId={project.id}
			message={message}
			screens={screens}
			onScreen={(s) => {
				showScreen(s);
				track("portal_editor_preview_used", {
					action: "screen_changed",
					project_id: project.id,
					screen: s,
					section,
				});
			}}
			action={
				trySection && !readOnly ? (
					<TryItAction
						section={trySection}
						status={tryIt.status}
						hasResult={!!tried}
						stale={tryIt.stale}
						error={tryIt.error}
						unavailable={!tryBody}
						crossPollination={
							page.values.is_get_reply_cross_pollination_enabled
						}
						onTry={tryIt.run}
					/>
				) : undefined
			}
		/>
	);

	return (
		<Options props={props}>
			{(content) => (
				<>
					<div
						className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(420px,1fr)_auto] lg:items-start"
						{...testId(`portal-editor-page-${section}`)}
					>
						<Stack gap="xl" className="min-w-0 max-w-[720px]">
							<Stack gap="xs">
								<Group gap="sm">
									<Title order={2}>{sectionTitle(section)}</Title>
									{!readOnly && (
										<SaveStatus
											formErrors={page.form.formState.errors}
											savedAt={page.autoSave.lastSavedAt}
											isPendingSave={page.autoSave.isPendingSave}
											isSaving={page.autoSave.isSaving}
											isError={page.autoSave.isError}
										/>
									)}
								</Group>
								<Text size="sm">{sectionDescription(section)}</Text>
							</Stack>
							{/* Read-only: the fieldset disables native controls, inert blocks the custom ones. */}
							<fieldset
								disabled={readOnly}
								inert={readOnly}
								className="m-0 min-w-0 border-0 p-0"
								{...testId("portal-editor-form")}
							>
								<OptionStepper
									options={defs.map((def) => ({
										beta: content.options[def.key]?.beta,
										body: content.options[def.key]?.body,
										key: def.key,
										summary: content.options[def.key]?.summary,
										title: content.options[def.key]?.title ?? def.key,
									}))}
									openKey={open?.key ?? null}
									onOpen={onOpen}
									nextLabel={
										after ? t`Next: ${sectionTitle(after)}` : undefined
									}
									onNextPage={
										after ? () => navigate(`${base}/${after}`) : undefined
									}
								/>
							</fieldset>
						</Stack>

						{wide ? (
							<Box
								className="sticky top-5 flex flex-col"
								// The view under the 57px breadcrumb bar, less the sticky gap above and
								// below: the whole phone stays in sight while the options scroll.
								mah="calc(100dvh - 57px - 2 * var(--mantine-spacing-lg))"
								{...testId("portal-preview-side")}
							>
								{frame}
							</Box>
						) : (
							<Stack gap="sm">
								<Box>
									<Button
										variant="outline"
										leftSection={<DeviceMobileIcon size={20} />}
										aria-expanded={previewOpen}
										onClick={() => {
											if (!previewOpen)
												track("portal_editor_preview_used", {
													action: "opened",
													project_id: project.id,
													screen,
													section,
												});
											preview.toggle();
										}}
										{...testId("portal-preview-toggle")}
									>
										{previewOpen ? (
											<Trans>Hide preview</Trans>
										) : (
											<Trans>Preview</Trans>
										)}
									</Button>
								</Box>
								<Collapse in={previewOpen}>{previewOpen && frame}</Collapse>
							</Stack>
						)}
					</div>
					{content.extra}
				</>
			)}
		</Options>
	);
};
