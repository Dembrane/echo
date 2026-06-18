import { Trans } from "@lingui/react/macro";
import {
	Badge,
	Button,
	Card,
	Group,
	SimpleGrid,
	Stack,
	Text,
} from "@mantine/core";
import posthog from "posthog-js";
import type { CatalogProduct } from "./hooks";

interface TrainingCatalogProps {
	products: CatalogProduct[];
	canManage: boolean;
	onRequest: (type: "online" | "in_person") => void;
}

/**
 * Catalog cards for the org Training view. Pricing comes from the API
 * (training_service.CATALOG), never hardcoded here. Coming-soon products
 * (Flex) render without a request CTA.
 */
export const TrainingCatalog = ({
	products,
	canManage,
	onRequest,
}: TrainingCatalogProps) => {
	return (
		<SimpleGrid cols={{ base: 1, md: 3, sm: 2 }} spacing="md">
			{products.map((p) => (
				<Card key={p.type} withBorder radius="md" padding="md">
					<Stack gap="xs" h="100%">
						<Group justify="space-between" align="flex-start">
							<Text fw={500}>{p.name}</Text>
							{p.coming_soon && (
								<Badge size="xs" variant="light" color="parchment">
									<Trans>Coming soon</Trans>
								</Badge>
							)}
						</Group>

						<Text size="xl" fw={600}>
							{`€${p.price_eur}`}
						</Text>

						<Text size="sm">{p.level}</Text>
						<Text size="sm">{p.format}</Text>

						<Text size="xs">
							<Trans>Up to {p.included_participants} participants</Trans>
						</Text>
						{p.extra_price_eur != null && (
							<Text size="xs">
								<Trans>€{p.extra_price_eur} per extra participant</Trans>
							</Text>
						)}

						<div style={{ flex: 1 }} />

						{p.coming_soon ? (
							<Button variant="subtle" disabled>
								<Trans>Coming soon</Trans>
							</Button>
						) : canManage ? (
							<Button
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
					</Stack>
				</Card>
			))}
		</SimpleGrid>
	);
};
