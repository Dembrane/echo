import { useDisclosure } from "@mantine/hooks";
import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useParams } from "react-router";
import { ReportIssueModal } from "@/components/feedback/ReportIssueModal";
import { useSidebarView } from "./useSidebarView";

type HelpModals = {
	/** "Leave feedback": the one way to give dembrane a heads-up, issues included. */
	openFeedback: () => void;
};

const HelpModalsContext = createContext<HelpModals | null>(null);

/** Mounts the Help modals once so HelpBlock and HelpView share them. */
export const HelpModalsProvider = ({ children }: { children: ReactNode }) => {
	const { language } = useParams();
	// The sidebar mounts above the scope routes, so useParams never sees the ids.
	const { params } = useSidebarView();
	const [feedbackOpen, feedback] = useDisclosure(false);
	const value = useMemo(
		() => ({ openFeedback: feedback.open }),
		[feedback.open],
	);

	return (
		<HelpModalsContext.Provider value={value}>
			{children}
			<ReportIssueModal
				opened={feedbackOpen}
				onClose={feedback.close}
				locale={language}
				workspaceId={params.workspaceId}
				projectId={params.projectId}
			/>
		</HelpModalsContext.Provider>
	);
};

export const useHelpModals = (): HelpModals => {
	const ctx = useContext(HelpModalsContext);
	if (!ctx) {
		throw new Error("useHelpModals must be used within HelpModalsProvider");
	}
	return ctx;
};
