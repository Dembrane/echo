import { useLingui } from "@lingui/react";
import { Alert, Anchor, Button, Group, Text } from "@mantine/core";
import { WarningCircleIcon } from "@phosphor-icons/react";
import { actionTarget } from "./actions";
import { useErrorPresentation } from "./useErrorPresentation";

/**
 * A failed request, said in the person's language with the one thing they can do. Use it
 * wherever a screen used to print `error.message` or the API's `detail`.
 */
export const ErrorNotice = ({
	error,
	onRetry,
	title,
	className,
}: {
	error: unknown;
	onRetry?: () => void;
	title?: string;
	className?: string;
}) => {
	const { i18n } = useLingui();
	const presented = useErrorPresentation(error);
	if (!presented) return null;
	const target = actionTarget(presented, i18n, onRetry ? { onRetry } : {});
	return (
		<Alert
			color="red"
			icon={<WarningCircleIcon size={20} />}
			title={title}
			className={className}
			data-error-code={presented.code ?? "none"}
		>
			<Group gap="sm" wrap="wrap">
				<Text size="sm">{presented.message}</Text>
				{target?.onClick && (
					<Button size="xs" onClick={target.onClick}>
						{target.label}
					</Button>
				)}
				{target?.href && (
					<Anchor size="sm" href={target.href}>
						{target.label}
					</Anchor>
				)}
			</Group>
		</Alert>
	);
};
