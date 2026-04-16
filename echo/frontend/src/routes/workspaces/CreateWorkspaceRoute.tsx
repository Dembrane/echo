import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
	Button,
	Container,
	Group,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
} from "@mantine/core";
import { useDocumentTitle } from "@mantine/hooks";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "@/components/common/Toaster";
import { API_BASE_URL } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import { useWorkspace } from "@/hooks/useWorkspace";

async function createWorkspace(name: string, tier: string) {
	const res = await fetch(`${API_BASE_URL}/v2/workspaces`, {
		body: JSON.stringify({ name, tier }),
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});
	if (!res.ok) {
		const data = await res.json().catch(() => ({}));
		throw new Error(data.detail || "Failed to create workspace");
	}
	return res.json();
}

export const CreateWorkspaceRoute = () => {
	const navigate = useI18nNavigate();
	const queryClient = useQueryClient();
	const { setWorkspace } = useWorkspace();
	const [name, setName] = useState("");
	const [tier, setTier] = useState("pioneer");

	useDocumentTitle(t`New workspace | dembrane`);

	const mutation = useMutation({
		mutationFn: () => createWorkspace(name.trim(), tier),
		onSuccess: (data) => {
			queryClient.invalidateQueries({ queryKey: ["v2", "workspaces"] });
			setWorkspace(data.id, data.name);
			toast.success(t`Workspace created`);
			navigate("/projects");
		},
		onError: (error: Error) => {
			toast.error(error.message);
		},
	});

	return (
		<div style={{ background: "var(--app-background, #f6f4f1)", minHeight: "100dvh" }}>
			<Container size="xs" py="xl" px="lg">
				<Stack gap={32} mt="10vh">
					<Stack gap={8}>
						<Title order={3} fw={400}>
							<Trans>New workspace</Trans>
						</Title>
						<Text size="sm" c="dimmed">
							<Trans>
								Workspaces hold projects for a specific client or purpose.
								Team admins automatically get access.
							</Trans>
						</Text>
					</Stack>

					<form
						onSubmit={(e) => {
							e.preventDefault();
							if (!name.trim()) return;
							mutation.mutate();
						}}
					>
						<Stack gap={16}>
							<TextInput
								autoFocus
								label={t`Workspace name`}
								placeholder={t`e.g. Client Alpha, Q1 Research`}
								size="sm"
								value={name}
								onChange={(e) => setName(e.currentTarget.value)}
							/>

							<Select
								data={[
									{ label: "Pilot", value: "pilot" },
									{ label: "Pioneer", value: "pioneer" },
									{ label: "Innovator", value: "innovator" },
									{ label: "Changemaker", value: "changemaker" },
									{ label: "Guardian", value: "guardian" },
								]}
								label={t`Plan`}
								size="sm"
								value={tier}
								onChange={(v) => v && setTier(v)}
							/>

							<Group gap={12} mt={8}>
								<Button
									size="sm"
									variant="default"
									onClick={() => navigate("/workspaces")}
								>
									<Trans>Cancel</Trans>
								</Button>
								<Button
									flex={1}
									loading={mutation.isPending}
									size="sm"
									type="submit"
								>
									<Trans>Create workspace</Trans>
								</Button>
							</Group>
						</Stack>
					</form>
				</Stack>
			</Container>
		</div>
	);
};
