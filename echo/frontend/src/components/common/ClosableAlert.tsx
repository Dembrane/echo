import { Alert, type AlertProps } from "@mantine/core";
import { useCallback, useState } from "react";

interface CloseableAlertProps extends AlertProps {
	/** When provided, dismissal is persisted to localStorage under this key. */
	storageKey?: string;
}

export const CloseableAlert = ({ storageKey, ...props }: CloseableAlertProps) => {
	const [alertOpened, setAlertOpened] = useState(() => {
		if (storageKey) {
			return localStorage.getItem(storageKey) !== "dismissed";
		}
		return true;
	});

	const handleClose = useCallback(() => {
		setAlertOpened(false);
		if (storageKey) {
			localStorage.setItem(storageKey, "dismissed");
		}
	}, [storageKey]);

	return (
		<>
			{alertOpened && (
				<Alert {...props} withCloseButton onClose={handleClose}>
					{props.children}
				</Alert>
			)}
		</>
	);
};
