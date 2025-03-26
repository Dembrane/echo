import { Markdown } from "@/components/common/Markdown";
import { Paper, Text } from "@mantine/core";
import clsx from "clsx";
import { ReactNode } from "react";

const SystemMessage = ({
  markdown,
  title,
  className,
}: {
  markdown?: string;
  title?: ReactNode;
  className?: string;
}) => {
  return (
    <div className="flex justify-start">
      <Paper
        bg="transparent"
        className={clsx(
          "w-full rounded-t-xl border border-slate-200 px-4 py-7 md:px-0",
          className,
        )}
      >
        <div className="flex items-start gap-4">
          <div className="flex-shrink-0">{!!title && title}</div>
          <Text className="prose text-sm">
            <Markdown content={markdown ?? ""} />
          </Text>
        </div>
      </Paper>
    </div>
  );
};

export default SystemMessage;
