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
          "w-full rounded-t-xl rounded-br-xl border border-slate-200 p-4",
          className,
        )}
      >
        <div className="flex flex-col items-start gap-4 md:flex-row">
          {title && <div className="flex-shrink-0">{title}</div>}
          <Text className="prose text-sm">
            <Markdown content={markdown ?? ""} />
          </Text>
        </div>
      </Paper>
    </div>
  );
};

export default SystemMessage;
