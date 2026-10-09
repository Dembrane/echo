import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Box,
	Button,
	Divider,
	Group,
	Paper,
	Stack,
	Text,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { CheckIcon } from "@phosphor-icons/react";
import posthog from "posthog-js";
// Reuse the billing plan-card styling so Training and Change-plan read as one
// system (bordered card, divider, check-mark specs, price pinned to the footer).
import cardClasses from "@/components/workspace/tier-pricing-cards.module.css";
import type { CatalogProduct } from "./hooks";

interface TrainingCatalogProps {
	products: CatalogProduct[];
	canManage: boolean;
	onRequest: (type: "online" | "in_person") => void;
}

/**
 * Catalog cards for the org Training view. Pricing comes from the API
 * (training_service.CATALOG), never hardcoded here. Coming-soon products
 * (Flex) render without a request CTA. Mirrors the Change-plan modal's
 * The old tier price cards layout, which this catalog still shares: a
 * left-aligned row of equal-width cards on wide
 * screens, stacked on narrow ones.
 */
export const TrainingCatalog = ({
	products,
	canManage,
	onRequest,
}: TrainingCatalogProps) => {
	const isWide = useMediaQuery("(min-width: 768px)");

	// Flex leads the row; the rest keep their API order.
	const ordered = [
		...products.filter((p) => p.type === "flex"),
		...products.filter((p) => p.type !== "flex"),
	];

	return (
		<div className={isWide ? cardClasses.groupWide : cardClasses.group}>
			{ordered.map((p) => {
				const specs = [
					p.level,
					p.format,
					t`Up to ${p.included_participants} participants`,
					p.extra_price_eur != null
						? t`€${p.extra_price_eur} per extra participant`
						: null,
				].filter((s): s is string => Boolean(s));

				return (
					<Paper
						key={p.type}
						withBorder
						className={isWide ? cardClasses.wideWrap : cardClasses.wrap}
					>
						<Stack
							gap={0}
							className={
								isWide ? cardClasses.wideInner : cardClasses.mobileInner
							}
						>
							<Group gap="sm" wrap="nowrap" justify="space-between">
								<Text size="lg" className={cardClasses.tierName}>
									{p.name}
								</Text>
								{p.coming_soon && (
									<Badge size="xs" variant="light" color="parchment">
										<Trans>Coming soon</Trans>
									</Badge>
								)}
							</Group>

							<Divider my="md" />

							<Stack gap={0}>
								{specs.map((spec) => (
									<Group
										key={spec}
										gap="xs"
										wrap="nowrap"
										className={cardClasses.specRow}
									>
										<CheckIcon size={16} />
										<Text size="xs">{spec}</Text>
									</Group>
								))}
							</Stack>

							<Box className={cardClasses.priceFooter}>
								<Group gap="xs" align="baseline">
									<Text size="xl" c="var(--app-text)">
										{`€${p.price_eur}`}
									</Text>
								</Group>
								<Box mt="sm">
									{p.coming_soon ? (
										<Button variant="subtle" disabled fullWidth>
											<Trans>Coming soon</Trans>
										</Button>
									) : canManage ? (
										<Button
											fullWidth
											onClick={() => {
												// Funnel pair: training_request_started -> _submitted.
												posthog.capture("training_request_started", {
													training_type: p.type,
												});
												onRequest(p.type as "online" | "in_person");
											}}
										>
											<Trans>Request a training</Trans>
										</Button>
									) : null}
								</Box>
							</Box>
						</Stack>
					</Paper>
				);
			})}
		</div>
	);
};
