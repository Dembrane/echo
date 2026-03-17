import { t } from "@lingui/core/macro";
import { Text, Tooltip } from "@mantine/core";
import { type ReactNode, useMemo } from "react";

export const REDACTED_PATTERN = /<redacted_([a-z_]+)>/g;
export const REDACTED_CODE_PREFIX = "redacted:";

const SAFE_REDACTED_PATTERN = /`redacted:([a-z_]+)`/g;

/**
 * Converts `<redacted_*>` tokens to backtick-wrapped inline code
 * (`` `redacted:type` ``) that MDX/Markdown editors preserve verbatim.
 */
export const escapeRedactedTokens = (text: string): string => {
	if (!text || !text.includes("<redacted_")) {
		return text;
	}
	return text.replace(
		REDACTED_PATTERN,
		(_match, type: string) => `\`${REDACTED_CODE_PREFIX}${type}\``,
	);
};

/**
 * Reverses `escapeRedactedTokens`, restoring `` `redacted:type` ``
 * back to `<redacted_type>` for downstream rendering.
 */
export const unescapeRedactedTokens = (text: string): string => {
	if (!text || !text.includes("`redacted:")) {
		return text;
	}
	return text.replace(SAFE_REDACTED_PATTERN, "<redacted_$1>");
};

export const getRedactedLabels = (): Record<string, string> => ({
	address: t`Address`,
	card: t`Card`,
	email: t`Email`,
	iban: t`IBAN`,
	id: t`ID`,
	license_plate: t`License Plate`,
	name: t`Name`,
	phone: t`Phone`,
	username: t`Username`,
});

export const formatLabel = (key: string): string => {
	const labels = getRedactedLabels();
	if (key in labels) {
		return labels[key];
	}
	return key
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
};

export const RedactedBadge = ({ type }: { type: string }) => {
	const label = formatLabel(type);
	return (
		<Tooltip label={t`This information is anonymized`} withArrow>
			<Text component="span" size="sm" bg="primary.2" px={6} py={1}>
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
		parts.push(
			<RedactedBadge key={`${match.index}-${match[1]}`} type={match[1]} />,
		);
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
