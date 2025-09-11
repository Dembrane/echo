import { Trans } from "@lingui/react/macro";
// Start of Selection
import React, { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import "./ParticipantOnboardingCards.css";
import { useLanguage } from "@/hooks/useLanguage";
import { Button, Stack, Title } from "@mantine/core";
import { PARTICIPANT_BASE_URL } from "@/config";
import { cn } from "@/lib/utils";
import { IconMicrophone } from "@tabler/icons-react";
import { Play } from "lucide-react";
import { ParticipantInitiateForm } from "./ParticipantInitiateForm";
import MicrophoneTest from "./MicrophoneTest";

interface Slide {
  type?: string;
  title: string;
  content?: string;
  icon: any;
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
  initialCards,
}: {
  project: Project;
  initialCards: LanguageCards;
}) => {
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

  const MicrophoneTestComponent = useMemo(
    () => () => (
      <MicrophoneTest
        onContinue={(_id: string) => {}}
        onMicTestSuccess={setMicTestSuccess}
      />
    ),
    [setMicTestSuccess],
  );

  const cards: LanguageCards = {
    ...initialCards,
    "en-US": [
      ...initialCards["en-US"],
      {
        section: "Microphone Check",
        slides: [
          {
            type: "microphone",
            title: "Microphone Check",
            content: "Let's Make Sure We Can Hear You.",
            icon: IconMicrophone,
            component: MicrophoneTestComponent,
          },
        ],
      },
      {
        section: "Get Started",
        slides: [
          {
            title: "Ready to Begin?",
            icon: Play,
            component: InitiateFormComponent,
          },
        ],
      },
    ],
    "nl-NL": [
      ...initialCards["nl-NL"],
      {
        section: "Microfoon Controle",
        slides: [
          {
            type: "microphone",
            title: "Microfoon Controle",
            content: "Laten we zorgen dat we je kunnen horen.",
            icon: IconMicrophone,
            component: MicrophoneTestComponent,
          },
        ],
      },
      {
        section: "Aan de slag",
        slides: [
          {
            title: "Klaar om te beginnen?",
            icon: Play,
            component: InitiateFormComponent,
          },
        ],
      },
    ],
    "de-DE": [
      ...initialCards["de-DE"],
      {
        section: "Mikrofon-Check",
        slides: [
          {
            type: "microphone",
            title: "Mikrofon-Check",
            content: "Lass uns sichergehen, dass wir dich hören können.",
            icon: IconMicrophone,
            component: MicrophoneTestComponent,
          },
        ],
      },
      {
        section: "Bereit zum Start?",
        slides: [
          {
            title: "Bereit zum Start?",
            icon: Play,
            component: InitiateFormComponent,
          },
        ],
      },
    ],
    "fr-FR": [
      ...initialCards["fr-FR"],
      {
        section: "Vérification du Microphone",
        slides: [
          {
            type: "microphone",
            title: "Vérification du Microphone",
            content: "Vérifions que nous puissions vous entendre.",
            icon: IconMicrophone,
            component: MicrophoneTestComponent,
          },
        ],
      },
      {
        section: "Prêt à commencer?",
        slides: [
          {
            title: "Prêt à commencer?",
            icon: Play,
            component: InitiateFormComponent,
          },
        ],
      },
    ],
    "es-ES": [
      ...initialCards["es-ES"],
      {
        section: "Verificación del Micrófono",
        slides: [
          {
            type: "microphone",
            title: "Verificación del Micrófono",
            content: "Verifiquemos que podamos escucharte.",
            icon: IconMicrophone,
            component: MicrophoneTestComponent,
          },
        ],
      },
      {
        section: "¿Listo para empezar?",
        slides: [
          {
            title: "¿Listo para empezar?",
            icon: Play,
            component: InitiateFormComponent,
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
        <Stack className="w-full max-w-[400px] text-left">
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
              `relative flex w-full max-w-[400px] flex-grow flex-col items-center justify-center gap-4 rounded-xl bg-white p-4 text-center shadow`,
              `${animationDirection}`,
            )}
          >
            {currentCard?.type === "microphone" && (
              <Button
                onClick={nextSlide}
                variant="subtle"
                color="blue"
                size="md"
                p="sm"
                className="absolute right-4 top-4"
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
                size: 64,
                className: "text-blue-500",
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
                className=""
                size={currentCard.cta ? "md" : "lg"}
                variant={currentCard.cta ? "transparent" : "filled"}
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
                  color="gray"
                  size="md"
                  className="basis-1/2"
                >
                  <Trans id="participant.button.back.microphone">Back</Trans>
                </Button>
                <Button
                  onClick={nextSlide}
                  size="md"
                  disabled={!micTestSuccess}
                  className="basis-1/2"
                >
                  <Trans id="participant.button.continue">Continue</Trans>
                </Button>
              </>
            ) : (
              <>
                <Button
                  onClick={prevSlide}
                  variant="outline"
                  color="gray"
                  size="md"
                  disabled={currentSlideIndex === 0}
                  className={!isLastSlide ? "basis-1/2" : "w-full"}
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
              {allSlides.map((_, index) => (
                <div
                  key={index}
                  className={`h-2 w-2 rounded-full transition-all duration-200 ${
                    index === currentSlideIndex
                      ? "w-4 bg-blue-500"
                      : "bg-gray-300"
                  }`}
                ></div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ParticipantOnboardingCards;
