import { useLocalStorage } from "@mantine/hooks";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useRefineSelectionCooldown } from "./hooks/useRefineSelectionCooldown";

/**
 * Going to Verify or Explore from the recorder, shared by the button under the recorder and
 * the choice screen: the same locks (AI unavailable, cooling down) and the same start of
 * Explore (its cooldown, and the button held while the reply comes in).
 */
export const useRefineActions = ({
	projectId,
	conversationId,
	aiUnavailable,
}: {
	projectId: string | undefined;
	conversationId: string | undefined;
	aiUnavailable: boolean;
}) => {
	const navigate = useI18nNavigate();
	const cooldown = useRefineSelectionCooldown(conversationId);
	const [, setIsRefineDisabled] = useLocalStorage({
		defaultValue: false,
		key: `refine_disabled_${conversationId}`,
	});
	const verifyLocked = aiUnavailable || cooldown.verify.isActive;
	const exploreLocked = aiUnavailable || cooldown.echo.isActive;

	const goVerify = () => {
		if (verifyLocked) return false;
		navigate(`/${projectId}/conversation/${conversationId}/verify`);
		return true;
	};

	const goExplore = () => {
		if (exploreLocked) return false;
		cooldown.startEchoCooldown();
		// The button stays disabled while the reply is generated.
		setIsRefineDisabled(true);
		navigate(`/${projectId}/conversation/${conversationId}?echo=1`);
		return true;
	};

	return { cooldown, exploreLocked, goExplore, goVerify, verifyLocked };
};
