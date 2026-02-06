import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Card,
	FileInput,
	Group,
	Image,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { IconPhoto, IconTrash, IconUpload } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { API_BASE_URL, DIRECTUS_PUBLIC_URL } from "@/config";
import { toast } from "../common/Toaster";

export const WhitelabelLogoCard = () => {
	const { data: user } = useCurrentUser();
	const queryClient = useQueryClient();
	const [file, setFile] = useState<File | null>(null);

	const logoFileId = user?.whitelabel_logo as string | null;
	const logoUrl = logoFileId
		? `${DIRECTUS_PUBLIC_URL}/assets/${logoFileId}`
		: null;

	const uploadMutation = useMutation({
		mutationFn: async (logoFile: File) => {
			const formData = new FormData();
			formData.append("file", logoFile);

			const response = await fetch(
				`${API_BASE_URL}/user-settings/whitelabel-logo`,
				{
					body: formData,
					credentials: "include",
					method: "POST",
				},
			);

			if (!response.ok) {
				throw new Error("Failed to upload logo");
			}

			const data = await response.json();
			return data.file_id;
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["users", "me"] });
			setFile(null);
			toast.success(t`Logo updated successfully`);
		},
		onError: () => {
			toast.error(t`Failed to upload logo`);
		},
	});

	const removeMutation = useMutation({
		mutationFn: async () => {
			const response = await fetch(
				`${API_BASE_URL}/user-settings/whitelabel-logo`,
				{
					credentials: "include",
					method: "DELETE",
				},
			);

			if (!response.ok) {
				throw new Error("Failed to remove logo");
			}
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["users", "me"] });
			toast.success(t`Logo removed`);
		},
		onError: () => {
			toast.error(t`Failed to remove logo`);
		},
	});

	const handleUpload = () => {
		if (file) {
			uploadMutation.mutate(file);
		}
	};

	return (
		<Card withBorder p="lg" radius="md">
			<Stack gap="md">
				<Group gap="sm">
					<IconPhoto size={24} stroke={1.5} />
					<Title order={3}>
						<Trans>Custom Logo</Trans>
					</Title>
				</Group>
				<Text size="sm" c="dimmed">
					<Trans>
						Upload a custom logo to replace the Dembrane logo across the
						portal, dashboard, reports, and host guide.
					</Trans>
				</Text>

				{logoUrl ? (
					<Stack gap="sm">
						<Text size="sm" fw={500}>
							<Trans>Current logo</Trans>
						</Text>
						<Image
							src={logoUrl}
							alt="Custom logo"
							h={48}
							w="auto"
							fit="contain"
							style={{ maxWidth: 200 }}
						/>
						<Group>
							<Button
								variant="subtle"
								color="red"
								size="compact-sm"
								leftSection={<IconTrash size={14} />}
								loading={removeMutation.isPending}
								onClick={() => removeMutation.mutate()}
							>
								<Trans>Remove</Trans>
							</Button>
						</Group>
					</Stack>
				) : (
					<Text size="sm" c="dimmed" fs="italic">
						<Trans>Using default Dembrane logo</Trans>
					</Text>
				)}

				<Stack gap="xs">
					<FileInput
						accept="image/png,image/jpeg,image/svg+xml,image/webp"
						placeholder={t`Choose a logo file`}
						value={file}
						onChange={setFile}
						leftSection={<IconUpload size={16} />}
					/>
					<Button
						size="compact-sm"
						disabled={!file}
						loading={uploadMutation.isPending}
						onClick={handleUpload}
					>
						<Trans>Upload</Trans>
					</Button>
				</Stack>
			</Stack>
		</Card>
	);
};
