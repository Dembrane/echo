import { Modal, type ModalProps } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import classes from "./StepsModal.module.css";

/**
 * A dialog that walks through steps, ending in a row of steps (`data-steps`: Back on the
 * left, the pill on the right). On a phone it fills the screen, as the Share dialog does,
 * and the row of steps sits at the foot of the screen, kept in view while what is above
 * it scrolls. At a desk it is the plain centred dialog.
 */
export function StepsModal(props: ModalProps) {
	const phone = useMediaQuery("(max-width: 48em)") ?? false;
	return (
		<Modal
			centered
			fullScreen={phone}
			classNames={
				phone ? { body: classes.body, content: classes.sheet } : undefined
			}
			{...props}
		/>
	);
}
