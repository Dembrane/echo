import { t } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { Trans } from "@lingui/react/macro";
import { Box, Button, Group, Stack, Text } from "@mantine/core";
import { CheckCircleIcon } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import googleCloudMark from "@/assets/google-cloud.svg";
import scalewayMark from "@/assets/scaleway.svg";
import { type AiProvider, providerName } from "./hooks";

// The marks are the official Scaleway and Google Cloud logos from simple-icons (CC0 1.0),
// drawn in their brand colours on a light tile so they read on a dark page too.
const MARKS: Record<AiProvider, string> = {
	google: googleCloudMark,
	scaleway: scalewayMark,
};

// Friendly names for the model ids the deployment's config names; an id not listed shows as itself.
const MODEL_NAMES: [prefix: string, name: string][] = [
	["whisper", "Whisper"],
	["glm-5.3", "GLM 5.3"],
];

export const modelName = (id: string): string =>
	MODEL_NAMES.find(([prefix]) => id.toLowerCase().startsWith(prefix))?.[1] ??
	id;

/** The distinct friendly names of the model ids, in the order the config lists them. */
export const modelNames = (ids: readonly string[] | undefined): string[] => [
	...new Set((ids ?? []).map(modelName)),
];

/** "Whisper and GLM 5.3": the list in the reader's language. */
const joinNames = (names: string[], locale: string): string =>
	new (
		Intl as unknown as {
			ListFormat: new (
				locale: string,
				options: { style: string; type: string },
			) => { format: (list: string[]) => string };
		}
	).ListFormat(locale.startsWith("en") ? "en" : locale, {
		style: "long",
		type: "conjunction",
	}).format(names.map((n) => n.replace(/ /g, "\u00a0")));

export const ProviderLogo = ({
	provider,
	size = 36,
	muted,
}: {
	provider: AiProvider;
	size?: number;
	muted?: boolean;
}) => (
	<Box
		aria-hidden
		data-testid={`provider-logo-${provider}`}
		style={{
			alignItems: "center",
			background: "var(--mantine-color-white)",
			border: "var(--app-stroke) solid var(--app-quiet)",
			display: "flex",
			flexShrink: 0,
			height: size,
			justifyContent: "center",
			opacity: muted ? 0.5 : 1,
			width: size,
		}}
	>
		<img
			src={MARKS[provider]}
			alt=""
			width={size * 0.6}
			height={size * 0.6}
			style={{ display: "block" }}
		/>
	</Box>
);

/** Where the provider runs, as the second line of its card. */
const where = (p: AiProvider) => (p === "google" ? t`EU` : t`Paris`);

const bullets = (p: AiProvider, models: string[], locale: string): string[] => {
	if (p === "google")
		return [
			t`Runs in the EU`,
			t`Slightly better quality`,
			t`Closed models: Gemini`,
			t`Billed per use`,
		];
	const names = joinNames(models, locale);
	return [
		t`Runs in the EU`,
		...(models.length ? [t`Open models: ${names}`] : []),
		t`Good for English and Dutch`,
	];
};

interface ProviderCardProps {
	provider: AiProvider;
	/** The model ids this deployment's setup uses for the provider (the config's, not a copy). */
	models?: readonly string[] | undefined;
	/** One word on the card's state: Default, Enabled, Account default. */
	badge?: ReactNode;
	/** A provider the account does not have: shown quieter. */
	muted?: boolean;
	/**
	 * How a customer asks for a provider they do not have. Nothing passes it yet; the support
	 * ticket flow will, and a muted card then offers the button.
	 */
	onRequest?: () => void;
	/** The chosen card of a choice: a check beside its name. */
	selected?: boolean;
	/** The card sits inside a box that already draws and pads it (a radio card). */
	flush?: boolean;
	/** Controls under the bullets (staff). */
	children?: ReactNode;
	"data-testid"?: string;
}

/**
 * One AI provider as a card: its logo, name, where it runs and what to know about it. The
 * organisation page, the project's choice and the staff editor all draw it, so a provider
 * reads the same everywhere.
 */
export const ProviderCard = ({
	provider,
	models,
	badge,
	muted,
	onRequest,
	selected,
	flush,
	children,
	...rest
}: ProviderCardProps) => {
	const { i18n } = useLingui();
	const lines = bullets(provider, modelNames(models), i18n.locale);
	return (
		<Stack
			gap="md"
			p={flush ? 0 : "md"}
			h="100%"
			data-muted={muted ? "" : undefined}
			style={
				flush
					? undefined
					: { border: "var(--app-stroke) solid var(--app-quiet)" }
			}
			{...rest}
		>
			<Group gap="xs" wrap="wrap" align="center" justify="space-between">
				<Group gap="sm" wrap="nowrap" align="center">
					<ProviderLogo provider={provider} muted={muted} />
					<Stack gap={0}>
						<Group gap="xs" wrap="nowrap">
							<Text
								c={muted ? "dimmed" : undefined}
								style={{ whiteSpace: "nowrap" }}
							>
								{providerName(provider)}
							</Text>
							{selected && (
								<CheckCircleIcon
									size={16}
									color="var(--app-action)"
									aria-hidden
								/>
							)}
						</Group>
						<Text size="sm" c="dimmed">
							{where(provider)}
						</Text>
					</Stack>
				</Group>
				{badge && (
					<Text size="sm" c="dimmed" style={{ marginLeft: "auto" }}>
						{badge}
					</Text>
				)}
			</Group>
			<Box
				component="ul"
				m={0}
				py={0}
				pr={0}
				pl="lg"
				style={{ display: "grid", gap: 4, listStyle: "disc" }}
			>
				{lines.map((line) => (
					<Text
						component="li"
						size="sm"
						c={muted ? "dimmed" : undefined}
						key={line}
						style={{ display: "list-item" }}
					>
						{line}
					</Text>
				))}
			</Box>
			{muted && onRequest && (
				<Group>
					<Button variant="default" size="xs" onClick={onRequest}>
						<Trans>Request</Trans>
					</Button>
				</Group>
			)}
			{children}
		</Stack>
	);
};
