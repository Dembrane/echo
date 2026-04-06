import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Card,
	FileButton,
	Group,
	Image,
	Stack,
	Text,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconPhoto, IconTrash, IconUpload } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { ImageCropModal } from "@/components/common/ImageCropModal";
import { API_BASE_URL, DIRECTUS_PUBLIC_URL } from "@/config";
import { toast } from "../common/Toaster";

export const WhitelabelLogoCard = () => {
	const { data: user } = useCurrentUser();
	const queryClient = useQueryClient();

	const logoFileId = user?.whitelabel_logo as string | null;
	const logoUrl = logoFileId
		? `${DIRECTUS_PUBLIC_URL}/assets/${logoFileId}`
		: null;

	const [cropSrc, setCropSrc] = useState<string | null>(null);
	const [cropOpened, { open: openCrop, close: closeCrop }] =
		useDisclosure(false);
	const [
		removeConfirmOpened,
		{ open: openRemoveConfirm, close: closeRemoveConfirm },
	] = useDisclosure(false);

	const uploadMutation = useMutation({
		mutationFn: async (blob: Blob) => {
			const formData = new FormData();
			formData.append("file", blob, "logo.png");

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
		onError: () => {
			toast.error(t`Failed to upload logo`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["users", "me"] });
			toast.success(t`Logo updated`);
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
		onError: () => {
			toast.error(t`Failed to remove logo`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["users", "me"] });
			toast.success(t`Logo removed`);
		},
	});

	const handleFileSelect = (file: File | null) => {
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			setCropSrc(reader.result as string);
			openCrop();
		};
		reader.readAsDataURL(file);
	};

	const handleCropComplete = (blob: Blob) => {
		uploadMutation.mutate(blob);
		setCropSrc(null);
	};

	return (
		<>
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
									onClick={openRemoveConfirm}
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

					<FileButton
						onChange={handleFileSelect}
						accept="image/png,image/jpeg,image/svg+xml,image/webp"
					>
						{(props) => (
							<Button
								variant="light"
								leftSection={<IconUpload size={16} />}
								loading={uploadMutation.isPending}
								{...props}
							>
								<Trans>Choose a logo file</Trans>
							</Button>
						)}
					</FileButton>
				</Stack>
			</Card>

			<ConfirmModal
				opened={removeConfirmOpened}
				onClose={closeRemoveConfirm}
				title={t`Remove logo`}
				data-testid="logo-remove-modal"
				message={t`Are you sure you want to remove your custom logo? The default dembrane logo will be used instead.`}
				confirmLabel={<Trans>Remove</Trans>}
				confirmColor="red"
				loading={removeMutation.isPending}
				onConfirm={() => {
					removeMutation.mutate();
					closeRemoveConfirm();
				}}
			/>

			{cropSrc && (
				<ImageCropModal
					opened={cropOpened}
					onClose={() => {
						closeCrop();
						setCropSrc(null);
					}}
					imageSrc={cropSrc}
					onCropComplete={handleCropComplete}
					aspect={3}
					title={t`Crop Logo`}
				/>
			)}
		</>
	);
};
