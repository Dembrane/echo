import { useProjectReport } from "./hooks";
import {
  Button,
  Center,
  Group,
  Paper,
  Skeleton,
  Stack,
  Text,
} from "@mantine/core";
import { Markdown } from "../common/Markdown";
import { Logo } from "../common/Logo";
import { Trans } from "@lingui/react/macro";
import { cn } from "@/lib/utils";
import { QRCode } from "../common/QRCode";

const ContributeToReportCTA = ({ href }: { href: string }) => {
  return (
    <Paper p="xl" className="bg-gray-100">
      <Stack className="text-center text-2xl font-semibold" align="center">
        <Trans>Do you want to contribute to this project?</Trans>

        <Button
          component="a"
          href={href}
          target="_blank"
          className="rounded-3xl print:hidden"
        >
          <Trans>Share your voice</Trans>
        </Button>

        <div className="hidden print:block">
          <Trans>Share your voice by scanning the QR code below.</Trans>
        </div>

        <div className="hidden h-[200px] w-[200px] print:block">
          <QRCode value={href} />
        </div>
      </Stack>
    </Paper>
  );
};

type ReportLayoutOpts = {
  contributeLink?: string;
  readingNow?: number;
  showBorder?: boolean;
};

const ReportLayout = ({
  children,
  contributeLink,
  readingNow,
  showBorder,
}: {
  children: React.ReactNode;
} & ReportLayoutOpts) => {
  return (
    <Stack
      gap="2rem"
      px={{ base: "1rem", md: "2rem" }}
      py={{ base: "2rem", md: "4rem" }}
      className={cn({
        "border-gray-200 md:border print:border-none": showBorder,
        "mx-auto max-w-2xl": true,
      })}
    >
      <Group justify="space-between" align="center">
        <Group align="center">
          <Logo />
          <Text>
            <Trans>Report</Trans>
          </Text>
        </Group>
        {readingNow && readingNow > 0 && (
          <Group className="print:hidden">
            <div className="h-[10px] w-[10px] animate-pulse rounded-full bg-green-500"></div>
            <Trans>{readingNow} reading now</Trans>
          </Group>
        )}
      </Group>

      {children}

      {!!contributeLink && <ContributeToReportCTA href={contributeLink} />}
    </Stack>
  );
};

export const ReportRenderer = ({
  reportId,
  opts,
}: {
  reportId: number;
  opts?: ReportLayoutOpts;
}) => {
  const { data, isLoading } = useProjectReport(reportId);

  if (isLoading) {
    return (
      <ReportLayout {...opts}>
        <Skeleton height="100px" />
        <Skeleton height="200px" />
      </ReportLayout>
    );
  }

  if (!data) {
    return (
      <ReportLayout {...opts}>
        <Text>
          <Trans>No report found</Trans>
        </Text>
      </ReportLayout>
    );
  }

  return (
    <div className="py-8">
      <ReportLayout {...opts} showBorder={true}>
        <Markdown content={data?.content ?? ""} />
      </ReportLayout>
    </div>
  );
};
