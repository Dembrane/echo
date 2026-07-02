import { Trans } from "@lingui/react/macro";
import { Card, Checkbox, Group, Stack, Text, Title } from "@mantine/core";
import { IconFlask } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useV2Me } from "@/hooks/useV2Me";
import { API_BASE_URL } from "@/config";
import { toast } from "../common/Toaster";

interface BetaFlag {
	/** Key stored under `app_user.settings`. */
	key: string;
	label: ReactNode;
	description: ReactNode;
}

// Registry of opt-in beta feature flags. Add an entry here and a toggle appears
// automatically under Settings -> Appearance; the whole card (heading included)
// stays hidden while this list is empty.
const BETA_FLAGS: BetaFlag[] = [];

export const BetaFeaturesCard = () => {
	const { data: me } = useV2Me();
	const queryClient = useQueryClient();

	const settings = me?.settings ?? {};

	const updateSettingsMutation = useMutation({
		mutationFn: async (newSettings: Record<string, boolean>) => {
			const response = await fetch(`${API_BASE_URL}/v2/me`, {
				body: JSON.stringify({ settings: newSettings }),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "PATCH",
			});
			if (!response.ok) throw new Error("Failed to update settings");
		},
		onError: () => {
			toast.error(<Trans>Failed to update settings</Trans>);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["v2", "me"] });
			toast.success(<Trans>Settings updated</Trans>);
		},
	});

	// Nothing to opt into yet — render nothing so no empty heading shows.
	if (BETA_FLAGS.length === 0) return null;

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<IconFlask size={24} stroke={1.5} />
					<Title order={3}>
						<Trans>Beta features</Trans>
					</Title>
				</Group>
				<Text size="sm">
					<Trans>Opt-in to experimental features and help shape dembrane. These features might change or be removed at any time.</Trans>
				</Text>

				{BETA_FLAGS.map((flag) => (
					<Checkbox
						key={flag.key}
						checked={!!settings[flag.key]}
						onChange={(event) =>
							updateSettingsMutation.mutate({
								[flag.key]: event.currentTarget.checked,
							})
						}
						label={flag.label}
						description={flag.description}
						disabled={updateSettingsMutation.isPending}
					/>
				))}
			</Stack>
		</Card>
	);
};
