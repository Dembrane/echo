import { Trans } from "@lingui/react/macro";
import { Button } from "@mantine/core";
import { IconSparkles } from "@tabler/icons-react";
import { motion } from "motion/react";
import "./wrapped-button.css";

interface WrappedButtonProps {
	onClick: () => void;
}

export const WrappedButton = ({ onClick }: WrappedButtonProps) => {
	return (
		<motion.div
			whileHover={{ scale: 1.05 }}
			whileTap={{ scale: 0.95 }}
			className="wrapped-button-container"
		>
			<Button
				onClick={onClick}
				className="wrapped-button"
				variant="gradient"
				gradient={{ deg: 135, from: "#4169E1", to: "#00FFFF" }}
				leftSection={
					<motion.div
						animate={{ rotate: [0, 15, -15, 0] }}
						transition={{
							duration: 2,
							ease: "easeInOut",
							repeat: Number.POSITIVE_INFINITY,
						}}
					>
						<IconSparkles size={18} />
					</motion.div>
				}
				size="sm"
			>
				<Trans>Wrapped</Trans>
			</Button>
		</motion.div>
	);
};
