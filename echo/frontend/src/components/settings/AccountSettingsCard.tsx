import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Card,
	FileButton,
	Group,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { IconTrash, IconUpload, IconUser } from "@tabler/icons-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useCurrentUser } from "@/components/auth/hooks";
import { ConfirmModal } from "@/components/common/ConfirmModal";
import { ImageCropModal } from "@/components/common/ImageCropModal";
import { UserAvatar } from "@/components/common/UserAvatar";
import { API_BASE_URL } from "@/config";
import { toast } from "../common/Toaster";

export const AccountSettingsCard = () => {
	const { data: user } = useCurrentUser();
	const queryClient = useQueryClient();

	const currentName = (user?.first_name as string) ?? "";
	const [name, setName] = useState(currentName);
	const hasNameChanged = name !== currentName;

	useEffect(() => {
		setName(currentName);
	}, [currentName]);

	const avatarFileId = user?.avatar as string | null;

	const [cropSrc, setCropSrc] = useState<string | null>(null);
	const [cropOpened, { open: openCrop, close: closeCrop }] =
		useDisclosure(false);
	const [
		removeConfirmOpened,
		{ open: openRemoveConfirm, close: closeRemoveConfirm },
	] = useDisclosure(false);

	const updateNameMutation = useMutation({
		mutationFn: async (firstName: string) => {
			const response = await fetch(`${API_BASE_URL}/user-settings/name`, {
				body: JSON.stringify({ first_name: firstName }),
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				method: "PATCH",
			});
			if (!response.ok) throw new Error("Failed to update name");
		},
		onError: () => {
			toast.error(t`Failed to update name`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["users", "me"] });
			toast.success(t`Name updated`);
		},
	});

	const uploadAvatarMutation = useMutation({
		mutationFn: async (blob: Blob) => {
			const formData = new FormData();
			formData.append("file", blob, "avatar.png");

			const response = await fetch(`${API_BASE_URL}/user-settings/avatar`, {
				body: formData,
				credentials: "include",
				method: "POST",
			});
			if (!response.ok) throw new Error("Failed to upload avatar");
			return response.json();
		},
		onError: () => {
			toast.error(t`Failed to upload avatar`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["users", "me"] });
			toast.success(t`Avatar updated`);
		},
	});

	const removeAvatarMutation = useMutation({
		mutationFn: async () => {
			const response = await fetch(`${API_BASE_URL}/user-settings/avatar`, {
				credentials: "include",
				method: "DELETE",
			});
			if (!response.ok) throw new Error("Failed to remove avatar");
		},
		onError: () => {
			toast.error(t`Failed to remove avatar`);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["users", "me"] });
			toast.success(t`Avatar removed`);
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
		uploadAvatarMutation.mutate(blob);
		setCropSrc(null);
	};

	return (
		<>
			<Card withBorder p="lg" radius="md">
				<Stack gap="md">
					<Group gap="sm">
						<IconUser size={24} stroke={1.5} />
						<Title order={3}>
							<Trans>Account</Trans>
						</Title>
					</Group>

					{/* Avatar */}
					<Group gap="lg" align="center">
						<UserAvatar size={80} />
						<Stack gap={4}>
							<Group gap="xs">
								<FileButton
									onChange={handleFileSelect}
									accept="image/png,image/jpeg,image/webp"
								>
									{(props) => (
										<Button
											variant="light"
											size="compact-sm"
											leftSection={<IconUpload size={14} />}
											loading={uploadAvatarMutation.isPending}
											{...props}
										>
											<Trans>Upload avatar</Trans>
										</Button>
									)}
								</FileButton>
								{avatarFileId && (
									<Button
										variant="subtle"
										color="red"
										size="compact-sm"
										leftSection={<IconTrash size={14} />}
										loading={removeAvatarMutation.isPending}
										onClick={openRemoveConfirm}
									>
										<Trans>Remove</Trans>
									</Button>
								)}
							</Group>
							<Text size="xs" c="dimmed">
								<Trans>PNG, JPEG, or WebP. Will be cropped to a circle.</Trans>
							</Text>
						</Stack>
					</Group>

					{/* Name */}
					<TextInput
						label={t`Display name`}
						value={name}
						onChange={(e) => setName(e.currentTarget.value)}
						placeholder={t`Your name`}
					/>

					{/* Email (read-only) */}
					<TextInput label={t`Email`} value={user?.email ?? ""} disabled />

					{hasNameChanged && (
						<Group>
							<Button
								onClick={() => updateNameMutation.mutate(name.trim())}
								loading={updateNameMutation.isPending}
								disabled={!name.trim()}
							>
								<Trans>Save</Trans>
							</Button>
						</Group>
					)}
				</Stack>
			</Card>

			<ConfirmModal
				opened={removeConfirmOpened}
				onClose={closeRemoveConfirm}
				title={t`Remove avatar`}
				data-testid="avatar-remove-modal"
				message={t`Are you sure you want to remove your avatar?`}
				confirmLabel={<Trans>Remove</Trans>}
				confirmColor="red"
				loading={removeAvatarMutation.isPending}
				onConfirm={() => {
					removeAvatarMutation.mutate();
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
					aspect={1}
					cropShape="round"
					title={t`Crop Avatar`}
				/>
			)}
		</>
	);
};
