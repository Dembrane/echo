import type { KeyboardEvent, Ref } from "react";
import {
	type ChoiceCard,
	cardLine,
	cardTags,
	templateName,
} from "../projectTemplates";
import { TemplateCard } from "./TemplateCard";
import classes from "./TemplateCardButton.module.css";

interface TemplateCardButtonProps {
	/** A format from the list, or Quick start. */
	template: ChoiceCard;
	/** Pressing the card chooses the template: there is no Continue. */
	onChoose: () => void;
	/** The template the project starts from now: the blue box on the action tint. */
	selected?: boolean;
	/** The bar's small card: the room and its name. */
	compact?: boolean;
	tabIndex?: number;
	onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
	ref?: Ref<HTMLButtonElement>;
}

/**
 * One template as something you press (ECHO-1058): the card in the "do" box, drawn chosen
 * (rules.css, .app-do[data-selected]) for the one the project starts from. The button's
 * name is the template's name; the rest is read as its description.
 */
export const TemplateCardButton = ({
	template,
	onChoose,
	selected = false,
	compact = false,
	tabIndex,
	onKeyDown,
	ref,
}: TemplateCardButtonProps) => {
	const key = template.key;
	return (
		<button
			ref={ref}
			type="button"
			className={`app-do ${classes.button}`}
			data-compact={compact || undefined}
			data-selected={selected || undefined}
			aria-pressed={selected}
			// The bar leaves the line out; it is still there on hover and for a screen reader.
			title={compact ? cardLine(key) : undefined}
			onClick={onChoose}
			onKeyDown={onKeyDown}
			tabIndex={tabIndex}
			data-testid={`template-card-${key}`}
		>
			<TemplateCard
				template={key}
				name={templateName(key)}
				greatFor={cardLine(key)}
				tags={cardTags(template)}
				compact={compact}
			/>
		</button>
	);
};
