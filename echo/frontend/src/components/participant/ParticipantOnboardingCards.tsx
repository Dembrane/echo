import { Trans } from "@lingui/react/macro";
// Start of Selection
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import "./ParticipantOnboardingCards.css";
import { Button, Stack, Title } from "@mantine/core";
import { IconMicrophone } from "@tabler/icons-react";
import { Play } from "lucide-react";
import { PARTICIPANT_BASE_URL } from "@/config";
import { useLanguage } from "@/hooks/useLanguage";
import { testId } from "@/lib/testUtils";
import { cn } from "@/lib/utils";
import { useOnboardingCards } from "./hooks/useOnboardingCards";
import MicrophoneTest from "./MicrophoneTest";
import { ParticipantInitiateForm } from "./ParticipantInitiateForm";

interface Slide {
	type?: string;
	title: string;
	content?: string;
	icon: React.ElementType;
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

const ParticipantOnboardingCards = ({ project }: { project: Project }) => {
	const [searchParams] = useSearchParams();
	const skipOnboarding = searchParams.get("skipOnboarding");

	const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
	const [checkboxStates, setCheckboxStates] = useState<Record<string, boolean>>(
		{},
	);
	const [animationDirection, setAnimationDirection] = useState("");
	const [micTestSuccess, setMicTestSuccess] = useState(false);

	const { language } = useLanguage();

	const InitiateFormComponent = useMemo(
		() => () => <ParticipantInitiateForm project={project} />,
		[project],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: needs to be looked at
	const MicrophoneTestComponent = useMemo(
		() => () => (
			<MicrophoneTest
				onContinue={(_id: string) => {}}
				onMicTestSuccess={setMicTestSuccess}
			/>
		),
		[setMicTestSuccess],
	);

	const { getSystemCards } = useOnboardingCards();

	const tutorialSlug = project.default_conversation_tutorial_slug ?? "none";

	const cards: LanguageCards = {
		"de-DE": [
			...getSystemCards("de-DE", tutorialSlug),
			{
				section: "Mikrofon-Check",
				slides: [
					{
						component: MicrophoneTestComponent,
						content: "Lass uns sichergehen, dass wir dich hören können.",
						icon: IconMicrophone,
						title: "Mikrofon-Check",
						type: "microphone",
					},
				],
			},
			{
				section: "Bereit zum Start?",
				slides: [
					{
						component: InitiateFormComponent,
						icon: Play,
						title: "Bereit zum Start?",
					},
				],
			},
		],
		"en-US": [
			...getSystemCards("en-US", tutorialSlug),
			{
				section: "Microphone Check",
				slides: [
					{
						component: MicrophoneTestComponent,
						content: "Let's Make Sure We Can Hear You.",
						icon: IconMicrophone,
						title: "Microphone Check",
						type: "microphone",
					},
				],
			},
			{
				section: "Get Started",
				slides: [
					{
						component: InitiateFormComponent,
						icon: Play,
						title: "Ready to Begin?",
					},
				],
			},
		],
		"es-ES": [
			...getSystemCards("es-ES", tutorialSlug),
			{
				section: "Verificación del Micrófono",
				slides: [
					{
						component: MicrophoneTestComponent,
						content: "Verifiquemos que podamos escucharte.",
						icon: IconMicrophone,
						title: "Verificación del Micrófono",
						type: "microphone",
					},
				],
			},
			{
				section: "¿Listo para empezar?",
				slides: [
					{
						component: InitiateFormComponent,
						icon: Play,
						title: "¿Listo para empezar?",
					},
				],
			},
		],
		"fr-FR": [
			...getSystemCards("fr-FR", tutorialSlug),
			{
				section: "Vérification du Microphone",
				slides: [
					{
						component: MicrophoneTestComponent,
						content: "Vérifions que nous puissions vous entendre.",
						icon: IconMicrophone,
						title: "Vérification du Microphone",
						type: "microphone",
					},
				],
			},
			{
				section: "Prêt à commencer?",
				slides: [
					{
						component: InitiateFormComponent,
						icon: Play,
						title: "Prêt à commencer?",
					},
				],
			},
		],
		"it-IT": [
			...getSystemCards("it-IT", tutorialSlug),
			{
				section: "Controllo Microfono",
				slides: [
					{
						component: MicrophoneTestComponent,
						content: "Assicuriamoci di poterti sentire.",
						icon: IconMicrophone,
						title: "Controllo Microfono",
						type: "microphone",
					},
				],
			},
			{
				section: "Pronti a iniziare?",
				slides: [
					{
						component: InitiateFormComponent,
						icon: Play,
						title: "Pronti a iniziare?",
					},
				],
			},
		],
		"nl-NL": [
			...getSystemCards("nl-NL", tutorialSlug),
			{
				section: "Microfoon Controle",
				slides: [
					{
						component: MicrophoneTestComponent,
						content: "Laten we zorgen dat we je kunnen horen.",
						icon: IconMicrophone,
						title: "Microfoon Controle",
						type: "microphone",
					},
				],
			},
			{
				section: "Aan de slag",
				slides: [
					{
						component: InitiateFormComponent,
						icon: Play,
						title: "Klaar om te beginnen?",
					},
				],
			},
		],
	};

	// Add this check to ensure we have valid data
	const languageCards = cards[language as keyof typeof cards] || [];

	// Flatten the slides into a single array
	const allSlides = languageCards.flatMap((section) => section.slides);

	const currentCard = allSlides[currentSlideIndex];

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
		<div className="flex h-full flex-col items-center justify-center p-4 text-center">
			{skipOnboarding === "1" ? (
				<Stack
					className="w-full max-w-[400px] text-left"
					{...testId("portal-onboarding-skip")}
				>
					<Title order={2}>
						<Trans id="participant.ready.to.begin">Ready to Begin?</Trans>
					</Title>
					<ParticipantInitiateForm project={project} />
				</Stack>
			) : (
				<>
					<div
						key={currentSlideIndex}
						className={cn(
							"relative flex w-full max-w-[400px] flex-grow flex-col items-center justify-center gap-4 rounded-xl bg-white p-4 text-center shadow",
							`${animationDirection}`,
						)}
						{...testId(`portal-onboarding-slide-${currentSlideIndex}`)}
					>
						{currentCard?.type === "microphone" && (
							<Button
								onClick={nextSlide}
								variant="subtle"
								color="primary"
								size="md"
								p="sm"
								className="absolute right-4 top-4"
								{...testId("portal-onboarding-mic-skip-button")}
							>
								<Trans id="participant.mic.check.button.skip">Skip</Trans>
							</Button>
						)}
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

						<h2 className={cn("text-3xl text-gray-800")}>
							{currentCard.title}
						</h2>

						{currentCard.content && (
							<p className="text-xl text-gray-600">{currentCard.content}</p>
						)}

						{currentCard.extraHelp && (
							<p className="text-sm text-gray-500">{currentCard.extraHelp}</p>
						)}

						{currentCard.component && (
							<div className="mt-4 w-full text-left">
								<currentCard.component />
							</div>
						)}

						{currentCard.link && (
							<Button
								component="a"
								target={
									currentCard.link.url.startsWith(PARTICIPANT_BASE_URL) ||
									currentCard.link.url.startsWith("/")
										? "_self"
										: "_blank"
								}
								href={currentCard.link.url}
								size={currentCard.cta ? "md" : "lg"}
								variant={currentCard.cta ? "transparent" : "filled"}
								{...testId("portal-onboarding-link-button")}
							>
								{currentCard.link.label}
							</Button>
						)}

						{currentCard.checkbox && (
							<div className="flex items-center justify-center">
								<input
									type="checkbox"
									id={`checkbox-${currentSlideIndex}`}
									checked={checkboxStates[`${currentSlideIndex}`] || false}
									onChange={handleCheckboxChange}
									className="mr-2 h-5 w-5 text-blue-500"
									{...testId("portal-onboarding-checkbox")}
								/>
								<label
									htmlFor={`checkbox-${currentSlideIndex}`}
									className="text-md text-gray-700"
								>
									{currentCard.checkbox.label}
								</label>
							</div>
						)}
					</div>

					<div className="mt-8 flex w-full items-center justify-between gap-4">
						{currentCard?.type === "microphone" ? (
							<>
								<Button
									onClick={prevSlide}
									variant="outline"
									size="md"
									className="basis-1/2"
									{...testId("portal-onboarding-mic-back-button")}
								>
									<Trans id="participant.button.back.microphone">Back</Trans>
								</Button>
								<Button
									onClick={nextSlide}
									size="md"
									disabled={!micTestSuccess}
									className="basis-1/2"
									{...testId("portal-onboarding-mic-continue-button")}
								>
									<Trans id="participant.button.continue">Continue</Trans>
								</Button>
							</>
						) : (
							<>
								<Button
									onClick={prevSlide}
									variant="outline"
									size="md"
									disabled={currentSlideIndex === 0}
									className={!isLastSlide ? "basis-1/2" : "w-full"}
									{...testId("portal-onboarding-back-button")}
								>
									<Trans id="participant.button.back">Back</Trans>
								</Button>
								{!isLastSlide && (
									<Button
										onClick={nextSlide}
										size="md"
										disabled={
											currentCard.checkbox?.required &&
											!checkboxStates[`${currentSlideIndex}`]
										}
										className="basis-1/2"
										{...testId("portal-onboarding-next-button")}
									>
										{currentCard.cta ? (
											currentCard.cta
										) : (
											<Trans id="participant.button.next">Next</Trans>
										)}
									</Button>
								)}
							</>
						)}
					</div>

					<div className="mt-4 flex items-center justify-between">
						<div className="flex space-x-2">
							{allSlides.map((slide, index) => (
								<div
									key={slide.title}
									className={`h-2 w-2 rounded-full transition-all duration-200 ${
										index === currentSlideIndex
											? "w-4 bg-blue-500"
											: "bg-gray-300"
									}`}
								/>
							))}
						</div>
					</div>
				</>
			)}
		</div>
	);
};

export default ParticipantOnboardingCards;
