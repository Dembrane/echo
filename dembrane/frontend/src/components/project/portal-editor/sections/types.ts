import type { ReactNode } from "react";
import type { VerificationTopicsResponse } from "@/lib/api";
import type { StepperOption } from "../OptionStepper/OptionStepper";
import type { OptionFlags } from "../sections";
import type { PortalPageForm } from "../usePortalPageForm";

export interface SectionProps {
	project: Project;
	page: PortalPageForm;
	readOnly: boolean;
	flags: OptionFlags;
	verificationTopics?: VerificationTopicsResponse;
	isVerificationTopicsLoading?: boolean;
}

/** An option as its page writes it: the stepper's row without its key. */
export type OptionContent = Omit<StepperOption, "key">;

/** A page's options by key, and anything it keeps mounted beside them (its modals). */
export interface SectionContent {
	options: Record<string, OptionContent>;
	extra?: ReactNode;
}

/** A switch or box's value in a summary line. */
export const onOff = (on: boolean, onText: string, offText: string) =>
	on ? onText : offText;

/** Markdown in one line: its words without marks. */
export const plainLine = (markdown: string) =>
	markdown
		.replace(/[#*_>`~[\]()!-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
