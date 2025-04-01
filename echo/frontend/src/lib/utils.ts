import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function capitalize(str: string) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export const scrollToBottom = (
  container: React.RefObject<HTMLDivElement | null>,
) => {
  container.current?.scrollIntoView({ behavior: "smooth" });
};

export const checkPermissionError = async () => {
  try {
    // @ts-ignore
    const result = await navigator.permissions.query({ name: "microphone" });
    if (result.state === "denied") {
      return "denied" as const;
    } else if (result.state === "prompt") {
      return "prompt" as const;
    } else if (result.state === "granted") {
      return "granted" as const;
    } else {
      return "error" as const;
    }
  } catch (error) {
    console.error("Error checking microphone permissions", error);
    return "error" as const;
  }
};

export const sanitizeImageUrl = (url: string) => {
  // interim solution to fix image urls for local development
  if (url.startsWith("http://minio:9000")) {
    return url.replace("http://minio:9000", "http://localhost:9000");
  }
  return url;
};
