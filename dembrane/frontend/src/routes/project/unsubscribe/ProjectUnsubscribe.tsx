import { Trans } from "@lingui/react/macro";
import { Button, Group, Skeleton, Stack, Text, Title } from "@mantine/core";
import { CheckIcon } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { ErrorNotice } from "@/components/error/ErrorNotice";
import { useCheckUnsubscribeStatus } from "@/components/unsubscribe/hooks";
import { unsubscribeParticipant } from "@/lib/api";

export const ProjectUnsubscribe = () => {
	const [searchParams] = useSearchParams();
	const token = searchParams.get("token") ?? "";
	const project_id = searchParams.get("project_id") ?? "";

	const { data, isLoading, error } = useCheckUnsubscribeStatus(
		token,
		project_id,
	);

	const [success, setSuccess] = useState(false);

	const { mutate, isPending } = useMutation({
		mutationFn: ({
			project_id,
			token,
			email_opt_in,
		}: {
			project_id: string;
			token: string;
			email_opt_in: boolean;
		}) => unsubscribeParticipant(project_id, token, email_opt_in),
		onSuccess: () => setSuccess(true),
	});

	const handleUnsubscribe = () => {
		mutate(
			{ email_opt_in: false, project_id, token },
			{
				onSuccess: () => setSuccess(true),
			},
		);
	};

	return (
		<div className="relative flex !h-dvh flex-col overflow-y-auto">
			<main className="container mx-auto h-full max-w-2xl">
				<Stack mt="xl" px="md" py="xl" align="flex-start">
					<Title order={2}>
						<Trans>Unsubscribe from notifications</Trans>
					</Title>

					{isLoading && <Skeleton height={36} width={160} />}
					{error && <ErrorNotice error={error} />}
					{success && (
						<Group gap="xs" wrap="nowrap">
							<CheckIcon size={16} color="var(--mantine-color-green-7)" />
							<Text size="md">
								<Trans>You have successfully unsubscribed.</Trans>
							</Text>
						</Group>
					)}

					{!isLoading &&
						!error &&
						!success &&
						(data?.eligible ? (
							<Button
								variant="filled"
								onClick={handleUnsubscribe}
								disabled={isPending}
								loading={isPending}
							>
								<Trans>Unsubscribe</Trans>
							</Button>
						) : (
							<Text c="dimmed" size="md">
								<Trans>
									You are already unsubscribed or your link is invalid.
								</Trans>
							</Text>
						))}
				</Stack>
			</main>
		</div>
	);
};
