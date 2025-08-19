import { createTheme } from "@mantine/core";
import { IconChevronRight, IconInfoCircle } from "@tabler/icons-react";
import accordionClasses from "./styles/accordion.module.css";
import DembraneLoadingSpinner from "./components/common/DembraneLoadingSpinner";

export const theme = createTheme({
  fontFamily: "'Space Grotesk Variable', sans-serif",
  headings: {
    fontFamily: "'Space Grotesk Variable', sans-serif",
    fontWeight: "500",
    sizes: {
      h1: {
        fontSize: "calc(2.125rem * var(--mantine-scale))",
        lineHeight: "1.3",
      },
      h2: {
        fontSize: "calc(1.875rem * var(--mantine-scale))",
        lineHeight: "1.35",
      },
      h3: {
        fontSize: "calc(1.5rem * var(--mantine-scale))",
        lineHeight: "1.4",
      },
      h4: {
        fontSize: "calc(1.25rem * var(--mantine-scale))",
        lineHeight: "1.45",
      },
      h5: {
        fontSize: "calc(1rem * var(--mantine-scale))",
        lineHeight: "1.5",
      },
      h6: {
        fontSize: "calc(0.875rem * var(--mantine-scale))",
        lineHeight: "1.5",
      },
    },
  },

  // Updated to match Tailwind shadows
  shadows: {
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.05)",
    DEFAULT: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
    md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
    lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
    xl: "0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)",
    "2xl": "0 25px 50px -12px rgb(0 0 0 / 0.25)",
    inner: "inset 0 2px 4px 0 rgb(0 0 0 / 0.05)",
    none: "none",
  },
  // Updated to match Tailwind radius
  radius: {
    none: "0px",
    sm: "0.125rem",
    DEFAULT: "0.25rem",
    md: "0.375rem",
    lg: "0.5rem",
    xl: "0.75rem",
    "2xl": "1rem",
    "3xl": "1.5rem",
    full: "9999px",
  },
  // Updated to match Tailwind breakpoints
  breakpoints: {
    xs: "320px",
    sm: "640px",
    md: "768px",
    lg: "1024px",
    xl: "1280px",
    "2xl": "1536px",
  },
  // Updated to match Tailwind spacing
  spacing: {
    // Fallback Mantine items
    xs: "0.25rem",
    sm: "0.5rem",
    md: "0.75rem",
    lg: "1rem",
    xl: "1.25rem",
    "2xl": "1.5rem",
    // Default Tailwind items
    px: "1px",
    0: "0",
    0.5: "0.125rem",
    1: "0.25rem",
    1.5: "0.375rem",
    2: "0.5rem",
    2.5: "0.625rem",
    3: "0.75rem",
    3.5: "0.875rem",
    4: "1rem",
    5: "1.25rem",
    6: "1.5rem",
    7: "1.75rem",
    8: "2rem",
    9: "2.25rem",
    10: "2.5rem",
    11: "2.75rem",
    12: "3rem",
    14: "3.5rem",
    16: "4rem",
    20: "5rem",
    24: "6rem",
    28: "7rem",
    32: "8rem",
    36: "9rem",
    40: "10rem",
    44: "11rem",
    48: "12rem",
    52: "13rem",
    56: "14rem",
    60: "15rem",
    64: "16rem",
    72: "18rem",
    80: "20rem",
    96: "24rem",
  },
  colors: {
    primary: [
      "#e2f6ff",
      "#cbe9ff",
      "#99cfff",
      "#62b5ff",
      "#369eff",
      "#1890ff",
      "#0089ff",
      "#0076e5",
      "#0069ce",
      "#005ab7",
    ],
    dark: [
      "#f9fafb",
      "#f3f4f6",
      "#e5e7eb",
      "#d1d5db",
      "#9ca3af",
      "#6b7280",
      "#4b5563",
      "#1f2937",
      "#111827",
      "#030712",
    ],
  },
  primaryColor: "primary",
  components: {
    Tabs: {
      defaultProps: {
        classNames: {
          tabLabel: "py-1",
        },
      },
    },
    ActionIcon: {
      defaultProps: {
        size: 36,
      },
    },
    Tooltip: {
      defaultProps: {
        withArrow: true,
      },
    },
    Title: {
      defaultProps: {
        color: {
          dark: "white",
          light: "black",
        },
      },
    },
    Alert: {
      defaultProps: {
        variant: "light",
        icon: <IconInfoCircle />,
      },
    },
    LoadingOverlay: {},
    Breadcrumbs: {
      defaultProps: {
        separator: <IconChevronRight />,
      },
    },
    Container: {
      defaultProps: {
        py: "lg",
      },
    },
    Paper: {
      defaultProps: {
        bg: { dark: "dark.8", light: "white" },
        border: { dark: "dark.8", light: "gray.1" },
        withBorder: true,
      },
    },
    Menu: {
      defaultProps: {
        shadow: "md",
        withArrow: true,
      },
    },
    Button: {
      defaultProps: {
        color: "primary",
        variant: "filled",
      },
    },
    Textarea: {
      defaultProps: {
        resize: "vertical",
      },
    },
    Pill: {
      defaultProps: {
        bg: "primary.1",
        color: "primary.8",
      },
    },
    SimpleGrid: {
      defaultProps: {
        spacing: "sm",
      },
    },
    Accordion: {
      defaultProps: {
        variant: "filled",
        chevronPosition: "left",
        chevron: <IconChevronRight />,
        classNames: {
          // to provide right rotation and reduce padding
          chevron: accordionClasses.chevron,
        },
        styles: {
          control: {
            backgroundColor: "transparent",
            padding: 0,
          },
          content: {
            padding: 0,
            paddingBottom: "24px",
          },
          item: {
            backgroundColor: "transparent",
            padding: 0,
          },
          panel: {
            backgroundColor: "transparent",
            paddingLeft: "24px",
          },
        },
      },
    },
  },
});
