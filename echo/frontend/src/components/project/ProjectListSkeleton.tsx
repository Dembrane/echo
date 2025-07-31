import { Box, Skeleton, Stack } from "@mantine/core";

interface ProjectListSkeletonProps {
  view: "grid" | "list";
  searchValue: string;
  count?: number;
  wrapper?: boolean;
}

export function ProjectListSkeleton({
  view,
  searchValue,
  count = 6,
  wrapper = true,
}: ProjectListSkeletonProps) {
  const isGrid = view === "grid";

  const GridItems = () =>
    Array.from({ length: count }).map((_, i) => (
      <Box key={i} className="col-span-full h-full md:col-span-4">
        <Skeleton height={120} radius="sm" />
      </Box>
    ));

  const ListItems = () =>
    Array.from({ length: count }).map((_, i) => (
      <Skeleton key={i} height={67} radius="sm" />
    ));

  // for pagination, render bare items (no layout wrapper)
  if (!wrapper) {
    return isGrid ? <GridItems /> : <ListItems />;
  }

  return (
    <Stack gap="md">
      {searchValue === "" && (
        <Skeleton height={42} radius="sm" className="w-full" />
      )}

      <Box className="relative">
        {isGrid && (
          <Box className="grid grid-cols-12 place-content-stretch gap-4">
            <GridItems />
          </Box>
        )}
        {!isGrid && (
          <Stack gap="sm">
            <ListItems />
          </Stack>
        )}
      </Box>
    </Stack>
  );
}
