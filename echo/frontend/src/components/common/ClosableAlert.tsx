import { Alert, type AlertProps } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";

export const CloseableAlert = (props: AlertProps) => {
	const [alertOpened, alertHandlers] = useDisclosure(true);
	return (
		<>
			{alertOpened && (
				<Alert {...props} withCloseButton onClose={alertHandlers.close}>
					{props.children}
				</Alert>
			)}
		</>
	);
};
