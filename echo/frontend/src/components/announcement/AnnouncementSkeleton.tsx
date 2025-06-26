import { Box } from "@mantine/core";

import { Stack } from "@mantine/core";

export const AnnouncementSkeleton = () => (
  <Stack gap="md" p="md">
    {[1, 2, 3].map((i) => (
      <Box key={i} className="animate-pulse">
        <Box
          className="mb-2 h-4 rounded bg-gray-200"
          style={{ width: "60%" }}
        />
        <Box
          className="mb-1 h-3 rounded bg-gray-200"
          style={{ width: "100%" }}
        />
        <Box className="h-3 rounded bg-gray-200" style={{ width: "80%" }} />
      </Box>
    ))}
  </Stack>
);
