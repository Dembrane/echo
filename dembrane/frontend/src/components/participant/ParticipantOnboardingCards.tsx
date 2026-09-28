import { Trans } from "@lingui/react/macro";
import posthog from "posthog-js";
// Start of Selection
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import "./ParticipantOnboardingCards.css";
import { Button, Checkbox, Stack, Text, Title } from "@mantine/core";
import { Logo } from "@/components/common/Logo";
import { PARTICIPANT_BASE_URL } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import { testId } from "@/lib/testUtils";
import { cn } from "@/lib/utils";
import { useOnboardingCards } from "./hooks/useOnboardingCards";
import {
	ParticipantInitiateForm,
	portalHasNothingToAsk,
} from "./ParticipantInitiateForm";

interface Slide {
	type?: string;
	title: string;
	content?: string;
	icon?: React.ElementType;
	cta?: string;
	extraHelp?: string;
	checkbox?: {
		label: string;
		required: boolean;
	};
	link?: {
		label: string;
		url: string;
	};
	show?: boolean; // not used
	component?: React.ElementType;
}

interface Section {
	section: string; // not used
	slides: Slide[];
}

export interface LanguageCards {
	[language: string]: Section[];
}

const ParticipantOnboardingCards = ({
	project,
	onFunnelStage,
}: {
	project: ParticipantProject;
	/** Reports this participant's funnel stage up to the visitor beacon owned
	 * by the landing route (so "scanned" can fire before this deck mounts). */
	onFunnelStage?: (report: {
		stage: string;
		tags: string[];
		tagsPreselected: boolean;
	}) => void;
}) => {
	const [searchParams] = useSearchParams();
	const skipOnboarding = searchParams.get("skipOnboarding");

	const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
	const [checkboxStates, setCheckboxStates] = useState<Record<string, boolean>>(
		{},
	);
	const [animationDirection, setAnimationDirection] = useState("");

	const { language } = useLanguage();

	// Tables/tags preselected via the QR URL (?tags= / ?tag_id_list=), resolved
	// to labels so the funnel can show them and mark them as preselected.
	const preselectedTags = useMemo(() => {
		const raw = searchParams.get("tags") ?? searchParams.get("tag_id_list");
		if (!raw) return [] as string[];
		const wanted = raw
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean);
		const projectTags = project.tags ?? [];
		return wanted
			.map((value) => {
				const match = projectTags.find(
					(tag) =>
						typeof tag === "object" &&
						tag !== null &&
						(tag.id === value || tag.text === value),
				);
				return typeof match === "object" && match !== null
					? (match.text ?? value)
					: value;
			})
			.filter(Boolean);
	}, [searchParams, project.tags]);

	const InitiateFormComponent = useMemo(
		() => () => <ParticipantInitiateForm project={project} />,
		[project],
	);

	// With no name and no tags to collect, the last card starts the conversation
	// on its own, so it drops its heading rather than asking a question it is
	// about to answer.
	const nothingToAsk = portalHasNothingToAsk(project);

	const { getSystemCards } = useOnboardingCards();

	const tutorialSlug = project.default_conversation_tutorial_slug ?? "none";
	const legalBasis = project.legal_basis ?? "client-managed";
	const privacyPolicyUrl = project.privacy_policy_url;
	const organiserName = project.organiser_name;

	const cards: LanguageCards = {
		"de-DE": [
			...getSystemCards(
				"de-DE",
				tutorialSlug,
				legalBasis,
				privacyPolicyUrl,
				organiserName,
			),
			{
				section: "Bereit zum Start?",
				slides: [
					{
						component: InitiateFormComponent,
						title: "Bereit zum Start?",
					},
				],
			},
		],
		"en-US": [
			...getSystemCards(
				"en-US",
				tutorialSlug,
				legalBasis,
				privacyPolicyUrl,
				organiserName,
			),
			{
				section: "Get Started",
				slides: [
					{
						component: InitiateFormComponent,
						title: "Ready to Begin?",
					},
				],
			},
		],
		"es-ES": [
			...getSystemCards(
				"es-ES",
				tutorialSlug,
				legalBasis,
				privacyPolicyUrl,
				organiserName,
			),
			{
				section: "¿Listo para empezar?",
				slides: [
					{
						component: InitiateFormComponent,
						title: "¿Listo para empezar?",
					},
				],
			},
		],
		"fr-FR": [
			...getSystemCards(
				"fr-FR",
				tutorialSlug,
				legalBasis,
				privacyPolicyUrl,
				organiserName,
			),
			{
				section: "Prêt à commencer?",
				slides: [
					{
						component: InitiateFormComponent,
						title: "Prêt à commencer?",
					},
				],
			},
		],
		"it-IT": [
			...getSystemCards(
				"it-IT",
				tutorialSlug,
				legalBasis,
				privacyPolicyUrl,
				organiserName,
			),
			{
				section: "Tutto pronto?",
				slides: [
					{
						component: InitiateFormComponent,
						title: "Tutto pronto?",
					},
				],
			},
		],
		"nl-NL": [
			...getSystemCards(
				"nl-NL",
				tutorialSlug,
				legalBasis,
				privacyPolicyUrl,
				organiserName,
			),
			{
				section: "Aan de slag",
				slides: [
					{
						component: InitiateFormComponent,
						title: "Klaar om te beginnen?",
					},
				],
			},
		],
	};

	const languageCards = cards[language as keyof typeof cards] || cards["en-US"];

	// Flatten the slides into a single array
	const allSlides = languageCards.flatMap((section) => section.slides);

	const currentCard = allSlides[currentSlideIndex];

	// The funnel stage this visitor is at, reported to the host monitor.
	// Monotonic-ish: furthest milestone reached wins. There is no microphone
	// stage any more: the deck assumes the microphone works, and the recording
	// screen finds out for real, opening the microphone test only when nothing
	// arrives.
	const funnelStage =
		skipOnboarding === "1" || currentSlideIndex === allSlides.length - 1
			? "profile"
			: currentSlideIndex > 0
				? "terms"
				: "scanned";
	const tagsKey = preselectedTags.join("|");
	// biome-ignore lint/correctness/useExhaustiveDependencies: preselectedTags folded into tagsKey; onFunnelStage identity is stable
	useEffect(() => {
		onFunnelStage?.({
			stage: funnelStage,
			tags: preselectedTags,
			tagsPreselected: preselectedTags.length > 0,
		});
	}, [funnelStage, tagsKey]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be inspected
	useEffect(() => {
		const timer = setTimeout(() => setAnimationDirection(""), 300);
		return () => clearTimeout(timer);
	}, [currentSlideIndex]);

	// If there's no valid card, render a fallback
	if (!currentCard) {
		return <div>No card available for the current language and section.</div>;
	}

	const nextSlide = () => {
		if (
			currentCard.checkbox?.required &&
			!checkboxStates[`${currentSlideIndex}`]
		) {
			return;
		}
		// Advancing past a required checkbox is the participant accepting consent.
		if (currentCard.checkbox?.required) {
			posthog.capture("consent_given", { project_id: project.id });
		}
		if (currentSlideIndex < allSlides.length - 1) {
			setAnimationDirection("slide-left");
			setCurrentSlideIndex((prev) => prev + 1);
		}
	};

	const isLastSlide = currentSlideIndex === allSlides.length - 1;

	const prevSlide = () => {
		if (currentSlideIndex > 0) {
			setAnimationDirection("slide-right");
			setCurrentSlideIndex((prev) => prev - 1);
		}
	};

	const handleCheckboxChange = (event: React.ChangeEvent<HTMLInputElement>) => {
		setCheckboxStates((prev) => ({
			...prev,
			[`${currentSlideIndex}`]: event.target.checked,
		}));
	};

	return (
		<div className="flex h-full flex-col">
			{/* Header with logo and border */}
			<div className="w-full border-b border-gray-800 px-4 py-3">
				<Logo />
			</div>

			{/* Content area */}
			<div className="flex flex-grow flex-col items-center justify-center p-4 text-center">
				{skipOnboarding === "1" ? (
					<Stack
						className="w-full max-w-[400px] text-left"
						{...testId("portal-onboarding-skip")}
					>
						{!nothingToAsk && (
							<Title order={2}>
								<Trans id="participant.ready.to.begin">Ready to Begin?</Trans>
							</Title>
						)}
						<ParticipantInitiateForm project={project} />
					</Stack>
				) : (
					<>
						<div
							key={currentSlideIndex}
							className={cn(
								"relative flex w-full max-w-[400px] flex-grow flex-col items-start justify-center gap-4",
								`${animationDirection}`,
							)}
							{...testId(`portal-onboarding-slide-${currentSlideIndex}`)}
						>
							{currentCard.icon && (
								<div
									className={cn(
										"transform transition-all duration-300 ease-in-out hover:scale-110",
									)}
								>
									{React.createElement(currentCard.icon, {
										className: "text-blue-500",
										size: 64,
									})}
								</div>
							)}

							{!(
								nothingToAsk && currentCard.component === InitiateFormComponent
							) && (
								<Text className={cn("text-4xl")} ta="left">
									{currentCard.title}
								</Text>
							)}

							{currentCard.content && (
								<Text className="text-xl" ta="left">
									{currentCard.content}
								</Text>
							)}

							{currentCard.extraHelp && (
								<Text
									className="text-sm"
									ta="left"
									style={{ whiteSpace: "pre-line" }}
								>
									{currentCard.extraHelp}
								</Text>
							)}

							{currentCard.component && (
								<div className="mt-4 w-full text-left">
									<currentCard.component />
								</div>
							)}

							{currentCard.link && (
								<a
									target={
										currentCard.link.url.startsWith(PARTICIPANT_BASE_URL) ||
										currentCard.link.url.startsWith("/")
											? "_self"
											: "_blank"
									}
									href={currentCard.link.url}
									className="text-blue-600 underline"
									rel={
										currentCard.link.url.startsWith(PARTICIPANT_BASE_URL) ||
										currentCard.link.url.startsWith("/")
											? undefined
											: "noopener noreferrer"
									}
									{...testId("portal-onboarding-link-button")}
								>
									{currentCard.link.label}
								</a>
							)}

							{currentCard.checkbox && (
								<Checkbox
									id={`checkbox-${currentSlideIndex}`}
									checked={checkboxStates[`${currentSlideIndex}`] || false}
									onChange={handleCheckboxChange}
									label={currentCard.checkbox.label}
									classNames={{
										body: "items-center",
										label:
											"text-lg leading-snug pl-4 text-gray-700 text-left pt-0.5",
										root: "items-start",
									}}
									{...testId("portal-onboarding-checkbox")}
								/>
							)}
						</div>

						<div className="mt-8 flex w-full items-center justify-between gap-4">
							{currentSlideIndex > 0 && (
								<Button
									onClick={prevSlide}
									variant="outline"
									size="lg"
									className={!isLastSlide ? "basis-1/2" : "w-full"}
									{...testId("portal-onboarding-back-button")}
								>
									<Trans id="participant.button.back">Back</Trans>
								</Button>
							)}
							{!isLastSlide && (
								<Button
									onClick={nextSlide}
									size="lg"
									disabled={
										currentCard.checkbox?.required &&
										!checkboxStates[`${currentSlideIndex}`]
									}
									className={currentSlideIndex > 0 ? "basis-1/2" : "w-full"}
									{...testId("portal-onboarding-next-button")}
								>
									{currentCard.cta ? (
										currentCard.cta
									) : (
										<Trans id="participant.button.next">Next</Trans>
									)}
								</Button>
							)}
						</div>

						<div className="mt-4 flex items-center justify-between">
							<div className="flex space-x-2">
								{allSlides.map((slide, index) => (
									<div
										key={slide.title}
										className={`h-3 w-3 rounded-full transition-all duration-200 ${
											index === currentSlideIndex
												? "w-6 bg-blue-500"
												: "border border-blue-500 bg-transparent"
										}`}
									/>
								))}
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	);
};

export default ParticipantOnboardingCards;
