import { Badge } from "@mantine/core";
import { Icon } from "@tabler/icons-react";
import clsx from "clsx";

interface TipBannerProps {
  icon?: Icon;
  message?: string;
  tipLabel?: string;
  color?: "blue" | "green" | "yellow" | "red" | "gray";
}

export function TipBanner({
  icon: Icon,
  message,
  tipLabel,
  color = "blue",
}: TipBannerProps) {
  const colorClasses = {
    blue: {
      border: "border-blue-200",
      bg: "bg-blue-50",
      text: "text-blue-800",
      icon: "text-blue-600",
      badgeBorder: "border-blue-300",
      badgeText: "text-blue-700",
    },
    green: {
      border: "border-green-200",
      bg: "bg-green-50",
      text: "text-green-800",
      icon: "text-green-600",
      badgeBorder: "border-green-300",
      badgeText: "text-green-700",
    },
    yellow: {
      border: "border-yellow-200",
      bg: "bg-yellow-50",
      text: "text-yellow-800",
      icon: "text-yellow-600",
      badgeBorder: "border-yellow-300",
      badgeText: "text-yellow-700",
    },
    red: {
      border: "border-red-200",
      bg: "bg-red-50",
      text: "text-red-800",
      icon: "text-red-600",
      badgeBorder: "border-red-300",
      badgeText: "text-red-700",
    },
    gray: {
      border: "border-gray-200",
      bg: "bg-gray-50",
      text: "text-gray-800",
      icon: "text-gray-600",
      badgeBorder: "border-gray-300",
      badgeText: "text-gray-700",
    },
  }[color];

  return (
    <div
      className={clsx(
        "flex items-start gap-3 rounded-md border p-3",
        colorClasses.border,
        colorClasses.bg,
      )}
    >
      {Icon && (
        <Icon className={clsx("mt-0.5 h-4 w-4 shrink-0", colorClasses.icon)} />
      )}
      {message && (
        <span className={clsx("flex-1 text-sm", colorClasses.text)}>
          {message}
        </span>
      )}
      {tipLabel && (
        <Badge
          variant="outline"
          className={clsx(
            "ml-auto shrink-0",
            colorClasses.badgeBorder,
            colorClasses.badgeText,
          )}
        >
          {tipLabel}
        </Badge>
      )}
    </div>
  );
}
