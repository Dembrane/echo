import { t } from "@lingui/core/macro";
import {
  useParticipantProjectById,
  useParticipantTutorialCardBySlug,
} from "@/components/participant/hooks";
import { useParams } from "react-router";
import { useEffect } from "react";
import useSessionStorageState from "use-session-storage-state";
import DembraneLoadingSpinner from "@/components/common/DembraneLoadingSpinner";
import { Alert } from "@mantine/core";
import ParticipantOnboardingCards, {
  LanguageCards,
} from "@/components/participant/ParticipantOnboardingCards";
import {
  EchoPortalTutorial,
  EchoPortalTutorialCard,
  EchoPortalTutorialCardTranslations,
} from "@/lib/typesDirectusContent";
import { DynamicLucideIcon } from "@/components/common/DynamicLucideIcon";

// FIXME: use a subset of lucide icons for onboarding cards instead
import * as LucideIcons from "lucide-react";

const getLucideIcon = (icon: string) => {
  const IconComponent = (
    LucideIcons as unknown as Record<string, React.ComponentType>
  )[icon];
  return IconComponent;
};

const transformCard = (card?: EchoPortalTutorial): LanguageCards => {
  const languageCards: LanguageCards = {
    "en-US": [],
    "nl-NL": [],
    "de-DE": [],
    "fr-FR": [],
    "es-ES": [],
  };

  if (!card || !Array.isArray(card.cards)) {
    return languageCards;
  }

  card.cards.forEach((innerCard) => {
    const cardData =
      innerCard.echo__portal_tutorial_card_id as EchoPortalTutorialCard;

    if (!cardData || !Array.isArray(cardData.translations)) {
      return; // Skip this iteration if cardData or translations is not valid
    }

    cardData.translations.forEach(
      (translation: EchoPortalTutorialCardTranslations) => {
        const language = translation.languages_code;

        if (!language) {
          return; // Skip this iteration if language is not defined
        }

        // Initialize the language array if it doesn't exist
        if (!languageCards[language as string]) {
          languageCards[language as string] = [];
        }

        // Find or create the section
        let section = languageCards[language as string].find(
          (s) => s.section === translation.section,
        );
        if (!section) {
          section = { section: translation.section || "", slides: [] };
          languageCards[language as string].push(section);
        }

        const slide: LanguageCards[string][number]["slides"][number] = {
          title: translation.title ?? "",
          content: translation.content ?? "",
          icon: getLucideIcon(cardData.icon ?? "PartyPopper"),
          cta: translation.cta ?? "",
          extraHelp: translation.extra_help ?? "",
          link:
            translation.link_label && cardData.link
              ? {
                  label: translation.link_label ?? "",
                  url: cardData.link ?? "",
                }
              : undefined,
        };

        if (
          cardData.user_confirmation_required &&
          translation.user_confirmation_label
        ) {
          slide.checkbox = {
            label: translation.user_confirmation_label,
            required: true,
          };
        }

        section.slides.push(slide);
      },
    );
  });

  return languageCards;
};

export const ParticipantStartRoute = () => {
  const { projectId } = useParams<{ projectId: string }>();

  const {
    data: project,
    isLoading: isLoadingProject,
    error: projectError,
  } = useParticipantProjectById(projectId ?? "");

  const {
    data: tutorialCard,
    isLoading: isLoadingTutorialCard,
    error: tutorialCardError,
  } = useParticipantTutorialCardBySlug(
    project?.default_conversation_tutorial_slug ?? "",
  );

  const [loadingFinished, setLoadingFinished] = useSessionStorageState(
    "loadingFinished",
    {
      defaultValue: false,
    },
  );

  useEffect(() => {
    if (!isLoadingProject && !isLoadingTutorialCard) {
      setLoadingFinished(true);
    }
  }, [isLoadingProject, isLoadingTutorialCard, setLoadingFinished]);

  if (loadingFinished && (projectError || tutorialCardError)) {
    return (
      <div className="flex flex-col items-center justify-center">
        <Alert color="info">
          {t`An error occurred while loading the Portal. Please contact the support team.`}
        </Alert>
      </div>
    );
  }

  return (
    <div className="h-full grow">
      {isLoadingProject || isLoadingTutorialCard ? (
        <DembraneLoadingSpinner isLoading />
      ) : (
        <ParticipantOnboardingCards
          initialCards={transformCard(tutorialCard as EchoPortalTutorial)}
          project={project as Project}
        />
      )}
    </div>
  );
};
