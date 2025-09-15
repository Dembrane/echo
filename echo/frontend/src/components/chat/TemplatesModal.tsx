import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  ActionIcon,
  Anchor,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { IconSearch, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { Template, Templates } from "./templates";

type TemplatesModalProps = {
  opened: boolean;
  onClose: () => void;
  onTemplateSelect: (template: { content: string; key: string }) => void;
  selectedTemplateKey?: string | null;
};

export const TemplatesModal = ({
  opened,
  onClose,
  onTemplateSelect,
  selectedTemplateKey,
}: TemplatesModalProps) => {
  const [searchQuery, setSearchQuery] = useState("");

  const filteredTemplates = Templates.filter((template) =>
    template.title.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleTemplateClick = (template: Template) => {
    onTemplateSelect({ content: template.content, key: template.title });
    onClose();
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      onExitTransitionEnd={() => setSearchQuery("")}
      title={
        <Text fw={600} size="lg">
          <Trans>Templates</Trans>
        </Text>
      }
      size="md"
      withinPortal
      classNames={{
        content: "h-[500px] flex flex-col overflow-hidden",
        body: "flex-1 flex flex-col overflow-hidden",
      }}
    >
      <div className="flex h-full flex-col">
        <TextInput
          placeholder={t`Search templates...`}
          leftSection={<IconSearch size={16} />}
          rightSection={
            searchQuery ? (
              <ActionIcon
                size="sm"
                variant="default"
                aria-label="Clear search"
                className="border-0"
                onClick={() => setSearchQuery("")}
              >
                <IconX size={16} />
              </ActionIcon>
            ) : null
          }
          rightSectionPointerEvents="all"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.currentTarget.value)}
          className="mb-3"
        />

        <ScrollArea
          className="flex-1"
          type="auto"
          scrollbarSize={10}
          offsetScrollbars
        >
          <Stack gap="md">
            {filteredTemplates.map((template) => {
              const isSelected = selectedTemplateKey === template.title;

              return (
                <UnstyledButton
                  key={template.id}
                  onClick={() => handleTemplateClick(template)}
                  className="w-full"
                >
                  <Paper
                    p="md"
                    withBorder
                    className={`cursor-pointer transition-all ${
                      isSelected
                        ? "border-blue-500 bg-blue-50"
                        : "hover:border-gray-300 hover:bg-gray-50"
                    }`}
                  >
                    <Text size="md">{template.title}</Text>
                  </Paper>
                </UnstyledButton>
              );
            })}
          </Stack>
        </ScrollArea>

        <Group className="mt-3 border-t pt-3">
          <Text size="sm" c="dimmed">
            <Trans>Want to add a template to ECHO?</Trans>{" "}
            <Anchor
              href="https://dembrane.notion.site/Prompt-Bibliotheek-2249cd84270580138d45f0be7a4b4899?source=copy_link "
              target="_blank"
              size="sm"
              fw={500}
              underline="always"
              ml="sm"
            >
              <Trans>Let us know!</Trans>
            </Anchor>
          </Text>
        </Group>
      </div>
    </Modal>
  );
};
