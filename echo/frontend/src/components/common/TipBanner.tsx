import { Badge } from "@mantine/core";
import { Icon } from "@tabler/icons-react";

interface TipBannerProps {
  icon?: Icon;
  message?: string;
  tipLabel?: string;
  color?: string; // Tailwind-compatible color name, default = 'blue'
}

export function TipBanner({
  icon: Icon,
  message,
  tipLabel,
  color = "blue",
}: TipBannerProps) {
  return (
    <div
      className={`flex items-start gap-3 rounded-md border border-${color}-200 bg-${color}-50 p-3`}
    >
      {Icon && <Icon className={`h-4 w-4 text-${color}-600 shrink-0 mt-0.5`} />}
      {message && <span className={`text-sm text-${color}-800 flex-1`}>{message}</span>}
      {tipLabel && (
        <Badge
          variant="outline"
          className={`ml-auto border-${color}-300 text-xs text-${color}-700 shrink-0`}
        >
          {tipLabel}
        </Badge>
      )}
    </div>
  );
}
