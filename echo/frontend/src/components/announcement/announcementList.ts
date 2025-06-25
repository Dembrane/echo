// This will come from an API call later instead of being hardcoded
export type AnnouncementLevel = "info" | "urgent";

export type Announcement = {
  id: number;
  read: boolean;
  title: string;
  message: string;
  created_at: string;
  expires_at?: string;
  level: AnnouncementLevel;
  projectId?: string;
};

export const initialAnnouncements: Announcement[] = [
  {
    id: 1,
    read: false,
    title: "New conversation started",
    projectId: "1",
    message:
      "A participant has joined your project and started a conversation. This is a longer description to test the expand/collapse functionality. It should be truncated to two lines by default.",
    created_at: "6h ago",
    expires_at: "12h ago",
    level: "info",
  },
  {
    id: 22,
    read: false,
    title: "Audio response received",
    projectId: "2",
    message: "New audio response uploaded to your project",
    created_at: "7h ago",
    expires_at: "12h ago",
    level: "info",
  },
  {
    id: 344,
    read: true,
    title: "Report generated",
    projectId: "3",
    message:
      "Your analytics report has been updated with new data ur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new data",
    created_at: "7h ago",
    expires_at: "12h ago",
    level: "urgent",
  },
  {
    id: 433,
    read: true,
    title: "Project shared",
    projectId: "4",
    message: "Your project has been shared with new collaborators",
    created_at: "8h ago",
    expires_at: "12h ago",
    level: "info",
  },
  {
    id: 522,
    read: true,
    title: "Connection status",
    projectId: "5",
    message:
      "Your project connection is healthy and ready for participants ur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new data",
    created_at: "8h ago",
    expires_at: "12h ago",
    level: "urgent",
  },
  {
    id: 511,
    read: true,
    title: "Connection status",
    projectId: "5",
    message: "Your project connection is healthy and ready for participants",
    created_at: "8h ago",
    expires_at: "12h ago",
    level: "urgent",
  },
  {
    id: 500,
    read: true,
    title: "Connection status",
    projectId: "5",
    message:
      "Your project connection is healthy and ready for participants ur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new data",
    created_at: "8h ago",
    expires_at: "12h ago",
    level: "urgent",
  },
  {
    id: 50,
    read: true,
    title: "Connection status",
    projectId: "5",
    message:
      "Your project connection is healthy and ready for participants ur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new data",
    created_at: "8h ago",
    expires_at: "12h ago",
    level: "urgent",
  },
  {
    id: 51,
    read: true,
    title: "Connection status",
    projectId: "5",
    message: "Your project connection is healthy and ready for participants",
    created_at: "8h ago",
    expires_at: "12h ago",
    level: "urgent",
  },
  {
    id: 52,
    read: true,
    title: "Connection status",
    projectId: "5",
    message: "Your project connection is healthy and ready for participants",
    created_at: "8h ago",
    expires_at: "12h ago",
    level: "urgent",
  },
  {
    id: 53,
    read: true,
    title: "Connection status",
    projectId: "5",
    message:
      "Your project connection is healthy and ready for participants ur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new data",
    created_at: "8h ago",
    level: "urgent",
  },
  {
    id: 54,
    read: true,
    title: "Connection status",
    projectId: "5",
    message: "Your project connection is healthy and ready for participants",
    created_at: "8h ago",
    expires_at: "12h ago",
    level: "urgent",
  },
  {
    id: 5,
    read: true,
    title: "Connection status",
    projectId: "5",
    message:
      "Your project connection is healthy and ready for participants ur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new dataur analytics report has been updated with new data",
    created_at: "8h ago",
    level: "urgent",
  },
  {
    id: 55,
    read: true,
    title: "Connection status",
    projectId: "5",
    message: "Your project connection is healthy and ready for participants",
    created_at: "8h ago",
    expires_at: "12h ago",
    level: "urgent",
  },
];
// This will come from an API call later instead of being hardcoded
