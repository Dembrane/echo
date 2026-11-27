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
	/** Pressing the card chooses the template and moves on: there is no Continue. */
	onChoose: () => void;
	tabIndex?: number;
	onKeyDown?: (e: KeyboardEvent<HTMLButtonElement>) => void;
	ref?: Ref<HTMLButtonElement>;
}

/**
 * One template as something you press (ECHO-1058): the card in the "do" box. The button's
 * name is the template's name; the rest is read as its description.
 */
export const TemplateCardButton = ({
	template,
	onChoose,
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
			/>
		</button>
	);
};
