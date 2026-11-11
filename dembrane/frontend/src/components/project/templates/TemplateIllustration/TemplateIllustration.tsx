import type { CardKey } from "../projectTemplates";
import { DRAWINGS } from "./drawings";

interface TemplateIllustrationProps {
	template: CardKey;
	className?: string;
}

/**
 * A template's room, seen from above (ECHO-1058). Decoration only: the card's name says the
 * same in words, so it is hidden from screen readers. Lines take the text colour, the phone
 * the action colour; both follow the theme.
 */
export const TemplateIllustration = ({
	template,
	className,
}: TemplateIllustrationProps) => {
	const Drawing = DRAWINGS[template];
	return (
		<svg
			viewBox="0 0 160 80"
			width="100%"
			className={className}
			fill="none"
			stroke="currentColor"
			strokeWidth={1}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			data-testid={`template-illustration-${template}`}
			style={{ aspectRatio: "2 / 1", display: "block" }}
		>
			<Drawing />
		</svg>
	);
};
