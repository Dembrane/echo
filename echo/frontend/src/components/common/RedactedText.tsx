import { Text, Tooltip } from "@mantine/core";
import { type ReactNode, useMemo } from "react";

const REDACTED_PATTERN = /<redacted_([a-z_]+)>/g;

const REDACTED_LABELS: Record<string, string> = {
	address: "Address",
	card: "Card",
	email: "Email",
	iban: "IBAN",
	id: "ID",
	license_plate: "License Plate",
	name: "Name",
	phone: "Phone",
	username: "Username",
};

const formatLabel = (key: string): string => {
	if (key in REDACTED_LABELS) {
		return REDACTED_LABELS[key];
	}
	return key
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
};

const RedactedBadge = ({ type }: { type: string }) => {
	const label = formatLabel(type);
	return (
		<Tooltip label={`Redacted ${label.toLowerCase()}`} withArrow>
			<Text
				component="span"
				size="sm"
				bg="primary.2"
				px={6}
				py={1}
			>
				{label}
			</Text>
		</Tooltip>
	);
};

/**
 * Parses a text string and replaces `<redacted_*>` placeholders with
 * styled inline badges that show a human-readable label and tooltip.
 *
 * Returns the original string unchanged if no placeholders are found.
 */
export const parseRedactedText = (text: string): ReactNode[] | string => {
	if (!text || !text.includes("<redacted_")) {
		return text;
	}

	const parts: ReactNode[] = [];
	let lastIndex = 0;

	const regex = new RegExp(REDACTED_PATTERN);
	for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
		if (match.index > lastIndex) {
			parts.push(text.slice(lastIndex, match.index));
		}
		parts.push(<RedactedBadge key={`${match.index}-${match[1]}`} type={match[1]} />);
		lastIndex = regex.lastIndex;
	}

	if (lastIndex < text.length) {
		parts.push(text.slice(lastIndex));
	}

	return parts;
};

/**
 * Component that renders text with `<redacted_*>` placeholders replaced
 * by subtle inline badges with tooltips.
 */
export const RedactedText = ({
	children,
	className,
}: {
	children: string;
	className?: string;
}) => {
	const rendered = useMemo(() => parseRedactedText(children), [children]);

	if (typeof rendered === "string") {
		return <span className={className}>{rendered}</span>;
	}

	return <span className={className}>{rendered}</span>;
};
