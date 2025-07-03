import { t } from "@lingui/core/macro";

// TODO: need to improve this function in future according to requirements
export const formatDate = (date: string | Date | null | undefined): string => {
    if (!date) return "";
  
    // Convert string to Date object if needed
    const dateObj = typeof date === "string" ? new Date(date) : date;
  
    // Check if the date is valid
    if (isNaN(dateObj.getTime())) return "";
  
    const now = new Date();
    const diffInHours = Math.floor(
      (now.getTime() - dateObj.getTime()) / (1000 * 60 * 60),
    );
  
    if (diffInHours < 1) return t`Just now`;
    if (diffInHours < 24) return t`${diffInHours}h ago`;
  
    const diffInDays = Math.floor(diffInHours / 24);
    if (diffInDays < 7) return t`${diffInDays}d ago`;
  
    return dateObj.toLocaleDateString();
  };