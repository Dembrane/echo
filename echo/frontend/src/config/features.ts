// Feature flag configuration
export const features = {
  // Core Features
  reply: import.meta.env.VITE_ENABLE_REPLY === "1",
  reportGeneration: import.meta.env.VITE_ENABLE_REPORT_GENERATION === "1",
  chatTemplates: import.meta.env.VITE_ENABLE_CHAT_TEMPLATES === "1",

  // Library Features
  libraryViews: import.meta.env.VITE_ENABLE_LIBRARY_VIEWS === "1",
  libraryInsights: import.meta.env.VITE_ENABLE_LIBRARY_INSIGHTS === "1",
  imageGeneration: import.meta.env.VITE_ENABLE_IMAGE_GENERATION === "1",

  // UI/UX Features
  conversationSummary: import.meta.env.VITE_ENABLE_CONVERSATION_SUMMARY === "1",
} as const;

// Type for feature names
export type FeatureName = keyof typeof features;

// Helper function to check if a feature is enabled
export function isFeatureEnabled(feature: FeatureName): boolean {
  return features[feature];
}

// Helper hook for React components
export function useFeature(feature: FeatureName): boolean {
  return isFeatureEnabled(feature);
}
