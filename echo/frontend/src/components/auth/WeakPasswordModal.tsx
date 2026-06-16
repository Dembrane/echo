import { Trans } from "@lingui/react/macro";
import { Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { ENABLE_WEAK_PASSWORD_NUDGE } from "@/config";
import { useI18nNavigate } from "@/hooks/useI18nNavigate";
import {
	clearWeakPasswordFlag,
	isWeakPasswordFlagSet,
	WEAK_PASSWORD_EVENT,
} from "@/lib/weakPasswordFlag";

function useWeakPasswordFlag(): boolean {
	const [flag, setFlag] = useState(isWeakPasswordFlagSet);
	useEffect(() => {
		const update = () => setFlag(isWeakPasswordFlagSet());
		window.addEventListener(WEAK_PASSWORD_EVENT, update);
		window.addEventListener("storage", update);
		return () => {
			window.removeEventListener(WEAK_PASSWORD_EVENT, update);
			window.removeEventListener("storage", update);
		};
	}, []);
	return flag;
}

export function WeakPasswordModal() {
	const flag = useWeakPasswordFlag();
	const navigate = useI18nNavigate();

	// Constant gate, evaluated after hooks so hook order stays stable.
	if (!ENABLE_WEAK_PASSWORD_NUDGE) return null;

	const handleClose = () => clearWeakPasswordFlag();
	const handleUpdate = () => {
		clearWeakPasswordFlag();
		navigate("/settings/account");
	};

	return (
		<Modal
			opened={flag}
			onClose={handleClose}
			title={<Trans>Update your password</Trans>}
			centered
		>
			<Stack gap="md">
				<Text size="sm">
					<Trans>
						Your password no longer meets our security requirements. Set a
						stronger one to keep your account secure.
					</Trans>
				</Text>
				<Group justify="flex-end">
					<Button variant="subtle" onClick={handleClose}>
						<Trans>Not now</Trans>
					</Button>
					<Button onClick={handleUpdate}>
						<Trans>Update password</Trans>
					</Button>
				</Group>
			</Stack>
		</Modal>
	);
}
