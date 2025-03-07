"""Feature flag configuration module."""
import os
from typing import Literal, get_args

# Feature names type
FeatureName = Literal[
    # Core Features
    "reply",
    "report_generation",
    "chat_templates",
    # Library Features
    "library_views",
    "library_insights",
    "image_generation",
    # UI/UX Features
    "conversation_summary",
]

# Feature flag mapping
FEATURES = {
    # Core Features
    "reply": os.getenv("ENABLE_REPLY", "1") == "1",
    "report_generation": os.getenv("ENABLE_REPORT_GENERATION", "1") == "1",
    "chat_templates": os.getenv("ENABLE_CHAT_TEMPLATES", "1") == "1",
    # Library Features
    "library_views": os.getenv("ENABLE_LIBRARY_VIEWS", "1") == "1",
    "library_insights": os.getenv("ENABLE_LIBRARY_INSIGHTS", "1") == "1",
    "image_generation": os.getenv("ENABLE_IMAGE_GENERATION", "1") == "1",
    # UI/UX Features
    "conversation_summary": os.getenv("ENABLE_CONVERSATION_SUMMARY", "1") == "1",
}

def is_feature_enabled(feature: FeatureName) -> bool:
    """Check if a feature is enabled.
    
    Args:
        feature: The name of the feature to check
        
    Returns:
        bool: True if the feature is enabled, False otherwise
    """
    return FEATURES[feature]

# List of all available features
FEATURE_NAMES = list(get_args(FeatureName)) 