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
import { useEffect, useMemo, useRef, useState } from "react";
import { SaveStatus } from "@/components/form/SaveStatus";
import { ProjectHostGuideLink } from "@/components/project/ProjectHostGuideLink";
import { useProjectLegalQuery } from "@/components/project/ProjectLegalBasisSection";
import { ENABLE_PARTICIPANT_EMAIL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { track } from "@/lib/analytics/events";
import type { VerificationTopicsResponse } from "@/lib/api";
import type { PreviewScreen } from "@/lib/portalPreview/protocol";
import { testId } from "@/lib/testUtils";
import { OptionStepper, type StepVia } from "../OptionStepper/OptionStepper";
import type { SectionKey } from "../portalForm";
import { AnonymiseExample } from "../preview/AnonymiseExample";
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
import { usePortalPageForm } from "../usePortalPageForm";

const OPTIONS: Record<SectionKey, (props: SectionProps) => SectionContent> = {
	about: useAboutOptions,
	explore: useExploreOptions,
	finish: useFinishOptions,
	privacy: usePrivacyOptions,
	verify: useVerifyOptions,
	welcome: useWelcomeOptions,
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
 * One page of the portal editor (ECHO-1060): its options one at a time on the left, the
 * participant screen they change on the right (under the options on a phone, behind a
 * "Preview" button). The open option is in the address, so a reload opens it again.
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
	// One hook per page; the page is keyed by section, so the order never changes.
	const content = OPTIONS[section](props);
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

	// The screen follows the open option until the host picks another one.
	const [pickedScreen, setPickedScreen] = useState<PreviewScreen | null>(null);
	const lastOption = useRef(open?.key);
	useEffect(() => {
		if (lastOption.current !== open?.key) {
			lastOption.current = open?.key;
			setPickedScreen(null);
		}
	}, [open?.key]);
	const screen = pickedScreen ?? open?.screen ?? SECTIONS[section].screens[0];
	const screens = useMemo(() => {
		const list = [...SECTIONS[section].screens];
		if (open && !list.includes(open.screen)) list.unshift(open.screen);
		return list;
	}, [section, open]);

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
				screen,
				tags: tags.map((tag) => ({
					id: tag.id,
					text: tag.text ?? "",
				})),
				topics: verificationTopics,
				values: page.values,
			}),
		[page.values, legal.data, screen, open, tags, verificationTopics],
	);

	const frame = (
		<PortalPreviewFrame
			projectId={project.id}
			message={message}
			screens={screens}
			onScreen={(s) => {
				setPickedScreen(s);
				track("portal_editor_preview_used", {
					action: "screen_changed",
					project_id: project.id,
					screen: s,
					section,
				});
			}}
			aside={
				section === "privacy" && open?.key === "anonymise" ? (
					<AnonymiseExample />
				) : undefined
			}
		/>
	);

	return (
		<Stack gap="xl" {...testId(`portal-editor-page-${section}`)}>
			<Group justify="space-between" align="start" wrap="wrap" gap="sm">
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
				<ProjectHostGuideLink projectId={project.id} />
			</Group>

			<div className="flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(420px,1fr)_auto] lg:items-start">
				{/* Read-only: the fieldset disables native controls, inert blocks the custom ones. */}
				<fieldset
					disabled={readOnly}
					inert={readOnly}
					className="m-0 min-w-0 max-w-[720px] border-0 p-0"
					{...testId("portal-editor-form")}
				>
					<OptionStepper
						options={defs.map((def) => ({
							body: content.options[def.key]?.body,
							key: def.key,
							summary: content.options[def.key]?.summary,
							title: content.options[def.key]?.title ?? def.key,
						}))}
						openKey={open?.key ?? null}
						onOpen={onOpen}
						nextLabel={after ? t`Next: ${sectionTitle(after)}` : undefined}
						onNextPage={after ? () => navigate(`${base}/${after}`) : undefined}
					/>
				</fieldset>

				{wide ? (
					<Box
						className="lg:sticky lg:top-4"
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
		</Stack>
	);
};
