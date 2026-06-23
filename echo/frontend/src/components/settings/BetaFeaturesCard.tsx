import { Trans } from "@lingui/react/macro";
import { Card, Checkbox, Group, Stack, Text, Title } from "@mantine/core";
import { IconFlask } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useV2Me } from "@/hooks/useV2Me";
import { API_BASE_URL } from "@/config";
import { toast } from "../common/Toaster";

export const BetaFeaturesCard = () => {
	const { data: me } = useV2Me();
	const queryClient = useQueryClient();

	const settings = me?.settings ?? {};
	const enableCollapsibleSidebar = !!settings.enable_collapsible_sidebar;

	const updateSettingsMutation = useMutation({
		mutationFn: async (newSettings: Record<string, any>) => {
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

	const handleToggleSidebar = (checked: boolean) => {
		updateSettingsMutation.mutate({
			enable_collapsible_sidebar: checked,
		});
	};

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<IconFlask size={24} stroke={1.5} />
					<Title order={3}>
						<Trans>Beta features</Trans>
					</Title>
				</Group>
				<Text size="sm" c="dimmed">
					<Trans>Opt-in to experimental features and help shape dembrane. These features might change or be removed at any time.</Trans>
				</Text>

				<Checkbox
					checked={enableCollapsibleSidebar}
					onChange={(event) => handleToggleSidebar(event.currentTarget.checked)}
					label={<Trans>Enable collapsible sidebar</Trans>}
					description={<Trans>Allows the sidebar to be collapsed to save screen space, particularly useful on mobile screens.</Trans>}
					disabled={updateSettingsMutation.isPending}
				/>
			</Stack>
		</Card>
	);
};
