import { Box, Group, Stack, ThemeIcon } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";

export const AnnouncementSkeleton = () => (
	<Stack gap="0" p="0">
		{[1, 2, 3, 4, 5, 6].map((i) => (
			<Box
				key={i}
				className="group animate-pulse border-b border-l-4 border-gray-100 border-l-gray-50/50 bg-gray-50/50 p-4 transition-all duration-200 hover:bg-blue-50"
			>
				<Stack gap="md">
					<Group gap="sm" align="flex-start">
						<ThemeIcon size={25} variant="light" color="gray" radius="xl">
							{/* Use a generic icon skeleton */}
							<IconInfoCircle size={20} color="#e5e7eb" />
						</ThemeIcon>
						<Stack gap="md" style={{ flex: 1 }}>
							<Group justify="space-between" align="center" mt="sm">
								<Box style={{ flex: 1 }}>
									<Box
										className="h-4 rounded bg-gray-200"
										style={{ width: "60%" }}
									/>
								</Box>
								<Group gap="sm" align="center">
									<Box
										className="h-3 rounded bg-gray-200"
										style={{ height: 12, width: 40 }}
									/>
									<Box
										style={{
											backgroundColor: "#e0e7ef",
											borderRadius: "50%",
											height: 8,
											width: 8,
										}}
									/>
								</Group>
							</Group>
							<Stack gap="xs">
								<Box
									className="h-3 rounded bg-gray-200"
									style={{ width: "100%" }}
								/>
								<Box
									className="h-3 rounded bg-gray-200"
									style={{ width: "80%" }}
								/>
							</Stack>
							<Group justify="space-between" align="center">
								<Box
									className="h-3 rounded bg-gray-200"
									style={{ height: 16, width: 80 }}
								/>
								<Box
									ml="auto"
									className="h-3 rounded bg-gray-200"
									style={{ height: 16, width: 60 }}
								/>
							</Group>
						</Stack>
					</Group>
				</Stack>
			</Box>
		))}
	</Stack>
);
