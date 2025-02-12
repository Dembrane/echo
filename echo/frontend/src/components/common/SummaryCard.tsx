import { Group, Text, LoadingOverlay, Paper, Stack } from "@mantine/core";
import React from "react";

type SummaryCardProps = {
  icon: React.ReactNode;
  label: string | React.ReactNode;
  value: string | React.ReactNode;
  loading?: boolean;
};

export const SummaryCard = (props: SummaryCardProps) => {
  return (
    <Paper px="md" py="md" shadow="0" className="relative h-full basis-1/4">
      <LoadingOverlay visible={props.loading} />
      <Stack align="start" justify="center" h="100%" gap="md">
        <Group gap="md" align="center">
          <div>{props.icon}</div>
          <div className="text-lg">{props.label}</div>
        </Group>
        {props.value}
      </Stack>
    </Paper>
  );
};
