# Button Design System

This document describes the button design system implemented in the ECHO frontend.

## Quick Reference

| Button Type | Mantine Variant | Example Usage |
|-------------|-----------------|---------------|
| **Primary** | `filled` (default) | `<Button>Submit</Button>` |
| **Secondary** | `outline` | `<Button variant="outline">Cancel</Button>` |
| **Tertiary** | `subtle` | `<Button variant="subtle">Learn More</Button>` |
| **Disabled** | Any + `disabled` | `<Button disabled>Save</Button>` |

## Design Spec

### Primary Button (filled)
- **Default**: Institution Blue (`#4169E1`) background, white text, **pill-shaped (fully rounded)**
- **Hover**: Graphite (`#2D2D2C`) background
- **Click/Active**: Graphite (`#2D2D2C`) background
- **Loading**: Graphite (`#2D2D2C`) background with white spinner

### Secondary Button (outline)
- **Default**: Institution Blue border, Institution Blue text, transparent background, **standard corners**
- **Hover**: 10% Institution Blue background
- **Click/Active**: 20% Institution Blue background

### Tertiary Button (subtle)
- **Default**: No border, Institution Blue text, transparent background, **standard corners**
- **Hover**: 10% Institution Blue background
- **Click/Active**: 20% Institution Blue background

### Disabled Button
- **Default**: Gray background, Graphite text
- **Hover**: Gray background + 1px Peach (`#FFD166`) border
- **Click/Active**: Gray background + 1px Salmon (`#FF9AA2`) border
- **Note**: Loading buttons are technically disabled but use their own styling (see Primary/Loading above)

## Usage Examples

```tsx
// Primary button (default)
<Button onClick={handleSubmit}>
  Submit
</Button>

// Secondary button
<Button variant="outline" onClick={handleCancel}>
  Cancel
</Button>

// Tertiary button
<Button variant="subtle" onClick={handleLearnMore}>
  Learn More
</Button>

// Disabled button (shows interactive borders)
<Button disabled onClick={handleSave}>
  Save
</Button>

// Loading button (graphite background with spinner)
<Button loading onClick={handleSubmit}>
  Submit
</Button>

// Custom color (overrides primary)
<Button color="red">
  Delete
</Button>
```

## Brand Colors

All brand colors are defined in [`src/colors.ts`](../src/colors.ts) as the single source of truth.

### Available Colors

| Name | Base Color | Mantine Usage | Tailwind Usage | Purpose |
|------|------------|---------------|----------------|---------|
| **Primary** | `#4169E1` | `color="primary.6"` | `bg-primary-500` | Buttons, links, accents |
| **Cyan** | `#00FFFF` | `color="cyan.6"` | `bg-cyan-500` | Deep Dive mode accent |
| **Graphite** | `#2D2D2C` | `color="graphite.6"` | `bg-graphite` | Text (DM Sans theme) |
| **Lime Yellow** | `#F4FF81` | `color="limeYellow.6"` | `bg-limeYellow-500` | Highlights |
| **Mauve** | `#FFC2FF` | `color="mauve.6"` | `bg-mauve-500` | Accent color |
| **Parchment** | `#F6F4F1` | `color="parchment.6"` | `bg-parchment` | Background (DM Sans theme) |
| **Peach** | `#FFD166` | `color="peach.6"` | `bg-peach-500` | Warnings, alerts |
| **Salmon** | `#FF9AA2` | `color="salmon.6"` | `bg-salmon-500` | Error states |
| **Spring Green** | `#1EFFA1` | `color="springGreen.6"` | `bg-springGreen-500` | Success, Overview mode |

### Using Brand Colors

**In Mantine Components:**
```tsx
<Button color="peach">Warning</Button>
<Badge bg="salmon.3" c="salmon.8">Error</Badge>
<Text c="springGreen.6">Success!</Text>
```

**In Tailwind Classes:**
```tsx
<div className="bg-peach-200 text-salmon-600 border-springGreen-400">
  Content
</div>
```

**In Inline Styles:**
```tsx
import { baseColors } from "@/colors";

<div style={{ backgroundColor: baseColors.peach }}>
  Content
</div>
```

## Implementation Details

### File Structure

- **[`src/colors.ts`](../src/colors.ts)**: Single source of truth for all brand colors
- **[`src/theme.tsx`](../src/theme.tsx)**: Mantine theme configuration with button defaults
- **[`src/styles/button.module.css`](../src/styles/button.module.css)**: Custom button variant styles
- **[`tailwind.config.js`](../../tailwind.config.js)**: Tailwind configuration with brand colors

### How It Works

1. **Colors are defined once** in `colors.ts` with 10 shades per color
2. **Mantine imports** `mantineColors` (array format, 0-9 indices)
3. **Tailwind imports** `tailwindColors` (object format, 50-900 keys)
4. **Button styles** are applied via CSS modules attached to the Button component in the theme

### Default Button Behavior

All buttons automatically get:
- `color="primary"` (Institution Blue)
- `variant="filled"` (Primary style)

**Only primary (filled) buttons are pill-shaped.** Secondary and tertiary buttons use standard rounded corners.

Override these by passing props:
```tsx
<Button variant="outline" color="red">
  Custom Button (standard corners)
</Button>

<Button variant="filled" radius="sm">
  Primary Button (override pill shape with small radius)
</Button>
```

## Exceptions

The following buttons are exempt from the design system and use custom CSS:
- **Refine button** (custom animated loading state)
- Other buttons with explicit custom `className` or `classNames` props

## Migration Guide

### Updating from Old Button Styles

**Before:**
```tsx
<Button color="blue">Submit</Button>
```

**After:**
```tsx
<Button>Submit</Button>  // Uses primary (Institution Blue) by default
```

### Reviewing `variant="default"` Usage

The `default` variant is not part of the design system. Consider replacing with:
- `variant="outline"` for secondary actions
- `variant="subtle"` for low-emphasis actions

### Adding New Colors

To add a new brand color:

1. Add the 10-shade array to `brandColors` in `src/colors.ts`
2. Add to `toTailwindPalette()` conversion in `tailwindColors`
3. Add base color to `baseColors` export
4. Colors will automatically be available in both Mantine and Tailwind

## Testing

Test button states in development:
- Hover over buttons to see hover states
- Click buttons to see active states
- Try disabled buttons to see interactive border feedback (Peach on hover, Salmon on click)

## Questions?

For questions about the design system, refer to:
- [Frontend Style Guides](../../docs/style-guides/)
- [AGENTS.md](../AGENTS.md) for general frontend patterns
- [COPY_GUIDE.md](../COPY_GUIDE.md) for button text guidelines
