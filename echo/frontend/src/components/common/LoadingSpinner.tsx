import { Loader } from "@mantine/core";

interface LoadingSpinnerProps {
	size?: string | number;
	color?: string;
}

export function LoadingSpinner({ size = "md", color }: LoadingSpinnerProps) {
	return <Loader size={size} color={color} />;
}
