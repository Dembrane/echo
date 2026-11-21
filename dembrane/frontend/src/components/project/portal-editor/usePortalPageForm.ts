import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useForm, useWatch } from "react-hook-form";
import { useAutoSave } from "@/hooks/useAutoSave";
import { changedFields, track } from "@/lib/analytics/events";
import type { VerificationTopicsResponse } from "@/lib/api";
import { useUpdateProjectByIdMutation } from "../hooks";
import { projectLanguageForUpdate } from "../projectLanguage";
import {
	normalizeTopicList,
	PortalFormSchema,
	type PortalFormValues,
	pick,
	portalDefaults,
	SECTION_FIELDS,
	type SectionKey,
} from "./portalForm";

interface Options {
	project: Project;
	section: SectionKey;
	readOnly: boolean;
	/** Only the Verify page reads the topics. */
	verificationTopics?: VerificationTopicsResponse;
	isVerificationTopicsLoading?: boolean;
}

/**
 * One portal editor page's form (ECHO-1060), with the one-page editor's save model kept:
 * every change saves itself a second later (useAutoSave, which also saves an edit still
 * waiting when the page closes), the save status says so, and observers never save. A page
 * sends only its own values; the call, the fields and the validation are the editor's.
 */
export function usePortalPageForm({
	project,
	section,
	readOnly,
	verificationTopics,
	isVerificationTopicsLoading = false,
}: Options) {
	const queryClient = useQueryClient();
	const updateProjectMutation = useUpdateProjectByIdMutation();
	const fields = SECTION_FIELDS[section];
	const selectedTopicDefaults = useMemo(
		() => verificationTopics?.selected_topics ?? [],
		[verificationTopics],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: read once per project and page, as the one-page editor did, so a refetch after a save does not reset what the host is typing
	const defaultValues = useMemo(
		() => portalDefaults(project, selectedTopicDefaults),
		[project.id, section, selectedTopicDefaults],
	);
	const resolver = useMemo(() => zodResolver(PortalFormSchema), []);
	// The values as last saved, to name the fields a save changed (names only).
	const savedValuesRef = useRef<Record<string, unknown>>(
		pick(defaultValues, fields),
	);
	const savedTopicsRef = useRef<string | null>(null);

	const form = useForm<PortalFormValues>({
		defaultValues,
		mode: "onChange",
		resolver,
		reValidateMode: "onChange",
	});
	const { formState, reset, watch, getValues, setValue } = form;
	const values = useWatch({ control: form.control }) as PortalFormValues;

	const onSave = useCallback(
		async (all: PortalFormValues) => {
			const own = pick(all, fields) as Partial<PortalFormValues>;
			const {
				verification_topics: topics,
				language,
				...projectPayload
			} = own as PortalFormValues;
			const payload: Partial<Project> & Record<string, unknown> = {
				...(projectPayload as Partial<Project>),
			};
			if (fields.includes("language")) {
				const languageUpdate = projectLanguageForUpdate(
					language,
					!!formState.dirtyFields.language,
				);
				if (languageUpdate) payload.language = languageUpdate;
			}
			let normalizedTopics: string[] | null = null;
			if (fields.includes("verification_topics")) {
				normalizedTopics = normalizeTopicList(topics ?? []);
				payload.selected_verification_key_list =
					normalizedTopics.length > 0 ? normalizedTopics.join(",") : null;
			}
			// Report notifications need the email box: with it off they are off, as the
			// one-page editor's form made them.
			if (
				(section === "about" || section === "finish") &&
				!all.default_conversation_ask_for_participant_email &&
				(project.is_project_notification_subscription_allowed ||
					all.is_project_notification_subscription_allowed)
			)
				payload.is_project_notification_subscription_allowed = false;

			await updateProjectMutation.mutateAsync({ id: project.id, payload });

			if (normalizedTopics) {
				await queryClient.invalidateQueries({
					queryKey: ["verify", "topics", project.id],
				});
				// Store what we saved to detect when the query refetches.
				savedTopicsRef.current = normalizedTopics.join(",");
			}

			const saved = {
				...pick(all, fields),
				...(normalizedTopics ? { verification_topics: normalizedTopics } : {}),
			};
			const fieldsChanged = changedFields(savedValuesRef.current, saved);
			savedValuesRef.current = saved;
			if (fieldsChanged.length > 0)
				track("portal_settings_saved", {
					fields_changed: fieldsChanged,
					project_id: project.id,
				});

			reset(
				{
					...all,
					...(normalizedTopics
						? { verification_topics: normalizedTopics }
						: {}),
				},
				{ keepDirty: false, keepValues: true },
			);
		},
		[
			fields,
			section,
			project.id,
			project.is_project_notification_subscription_allowed,
			updateProjectMutation,
			queryClient,
			reset,
			formState.dirtyFields.language,
		],
	);

	const autoSave = useAutoSave({
		initialLastSavedAt: project.updated_at ?? new Date(),
		onSave,
	});
	const dispatchRef = useRef(autoSave.dispatchAutoSave);
	useEffect(() => {
		dispatchRef.current = autoSave.dispatchAutoSave;
	}, [autoSave.dispatchAutoSave]);

	useEffect(() => {
		if (readOnly) return;
		const subscription = watch((next, { type }) => {
			if (type === "change" && next)
				dispatchRef.current(next as PortalFormValues);
		});
		return () => subscription.unsubscribe();
	}, [watch, readOnly]);

	// The topics as the server has them, unless the host changed them here (the
	// one-page editor's sync, unchanged).
	useEffect(() => {
		if (!fields.includes("verification_topics")) return;
		if (!verificationTopics || isVerificationTopicsLoading) return;
		const normalizedSelected = normalizeTopicList(
			verificationTopics.selected_topics ?? [],
		);
		if (savedTopicsRef.current) {
			if (normalizedSelected.join(",") === savedTopicsRef.current)
				savedTopicsRef.current = null;
			else return;
		}
		if (formState.dirtyFields.verification_topics) return;
		const current = normalizeTopicList(getValues("verification_topics") ?? []);
		const differs =
			normalizedSelected.length !== current.length ||
			normalizedSelected.some((topic, i) => topic !== current[i]);
		if (differs)
			setValue("verification_topics", normalizedSelected, {
				shouldDirty: false,
				shouldTouch: false,
			});
	}, [
		fields,
		formState.dirtyFields.verification_topics,
		getValues,
		setValue,
		verificationTopics,
		isVerificationTopicsLoading,
	]);

	/** Saves now, for a change made outside a field's own onChange (a confirm modal). */
	const saveNow = useCallback(
		(next: PortalFormValues) => dispatchRef.current(next),
		[],
	);

	return { autoSave, form, saveNow, values };
}

export type PortalPageForm = ReturnType<typeof usePortalPageForm>;
