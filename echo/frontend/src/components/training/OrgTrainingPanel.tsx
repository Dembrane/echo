import { Trans } from "@lingui/react/macro";
import { Alert, Loader, Stack, Text } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useMemo, useState } from "react";
import {
	type CatalogProduct,
	useOrgTrainingRoster,
	useRequestTraining,
	useTrainingCatalog,
} from "./hooks";
import { RequestTrainingModal } from "./RequestTrainingModal";
import { TrainingCatalog } from "./TrainingCatalog";
import { TrainingRoster } from "./TrainingRoster";

interface OrgTrainingPanelProps {
	orgId: string;
}

/**
 * Org-scoped Training view (ISSUE-020). Catalog + members-style roster with a
 * trained/not-trained column + the org's license-pool usage. Training is its
 * own product; no billing plan includes it.
 */
export const OrgTrainingPanel = ({ orgId }: OrgTrainingPanelProps) => {
	const { data: catalog = [], isLoading: catalogLoading } =
		useTrainingCatalog();
	const { data: roster, isLoading: rosterLoading } =
		useOrgTrainingRoster(orgId);
	const requestMutation = useRequestTraining(orgId);

	const [modalOpened, modal] = useDisclosure(false);
	const [selectedType, setSelectedType] = useState<
		"online" | "in_person" | null
	>(null);

	const selectedProduct: CatalogProduct | null = useMemo(
		() => catalog.find((p) => p.type === selectedType) ?? null,
		[catalog, selectedType],
	);

	const canManage = roster?.can_manage ?? false;

	const handleRequest = (type: "online" | "in_person") => {
		setSelectedType(type);
		modal.open();
	};

	const handleSubmit = (extraParticipants: number, notes: string) => {
		if (!selectedType) return;
		requestMutation.mutate(
			{
				extra_participants: extraParticipants,
				notes: notes || undefined,
				type: selectedType,
			},
			{ onSuccess: () => modal.close() },
		);
	};

	if (catalogLoading || rosterLoading) {
		return <Loader size="sm" />;
	}

	return (
		<Stack gap="lg">
			<div>
				<Text size="sm" fw={500}>
					<Trans>Training</Trans>
				</Text>
				<Text size="xs">
					<Trans>
						Certified training for teams using dembrane in high-risk settings. A
						separate product, billed per session.
					</Trans>
				</Text>
			</div>

			<TrainingCatalog
				products={catalog}
				canManage={canManage}
				onRequest={handleRequest}
			/>

			{roster && (
				<Stack gap="sm">
					<Alert color="primary" variant="light">
						<Trans>
							{roster.trained_count} of {roster.total_count} members are
							trained.
						</Trans>
					</Alert>
					<TrainingRoster
						members={roster.members}
						showEmails={roster.can_manage}
					/>
				</Stack>
			)}

			<RequestTrainingModal
				opened={modalOpened}
				product={selectedProduct}
				submitting={requestMutation.isPending}
				onClose={modal.close}
				onSubmit={handleSubmit}
			/>
		</Stack>
	);
};
