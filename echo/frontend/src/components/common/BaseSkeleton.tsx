import { Skeleton, Stack } from "@mantine/core";

interface BaseSkeletonProps {
	count?: number;
	height?: string;
	width?: string;
	radius?: string;
	className?: string;
}

export const BaseSkeleton = ({
	count = 1,
	height = "20px",
	width = "100%",
	radius = "xs",
	className = "",
}: BaseSkeletonProps) => {
	return (
		<Stack gap="xs" className={className}>
			{Array.from({ length: count }).map((_, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: needs to be fixed
				<Skeleton key={index} height={height} width={width} radius={radius} />
			))}
		</Stack>
	);
};
