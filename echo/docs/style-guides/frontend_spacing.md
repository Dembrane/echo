# Page Layout Style Guide

## Stack & Spacing Hierarchy

1. Major Sections (between components/sections):

   - gap="3rem"
   - Typically separated by Dividers

2. Section Header to Content:

   - gap="1.5rem"
   - Used between a Title and its related content

3. Form Inputs/Elements:

   - gap="2rem"
   - Used between individual form fields/inputs

4. Related Elements (tight coupling):
   - gap="xs" (0.5rem)
   - Used for label-description pairs
   - Used for closely related content

## Page Padding (Responsive)

Standard page padding should be responsive:

### Desktop (md and above):

- Left/Right padding (px): "2rem"
- Top/Bottom padding (py): "4rem" (if not inside container)
- Top/Bottom padding (py): "2rem" (if inside container)

### Mobile (below md):

- Left/Right padding (px): "1rem"
- Top/Bottom padding (py): "2rem" (if not inside container)
- Top/Bottom padding (py): "1.5rem" (if inside container)

## Implementation Example

```tsx
<Stack
  gap="3rem"
  px={{ base: '1rem', md: '2rem' }}
  py={{ base: '2rem', md: '4rem' }}
>
  {/* Major Section */}
  <Stack gap="1.5rem">
    <Title order={2}>Section Title</Title>
    <Stack gap="2rem">
      {/* Form inputs or content */}
      <TextInput {...props} />
      <Select {...props} />

      {/* Tightly coupled content */}
      <Stack gap="xs">
        <Text>Label</Text>
        <InputDescription>Description</InputDescription>
      </Stack>
    </Stack>
  </Stack>

  <Divider />

  {/* Next Major Section */}
  <Stack gap="1.5rem">
    <Title order={2}>Next Section</Title>
    <Stack gap="2rem">{/* Content */}</Stack>
  </Stack>
</Stack>
```

## Common Patterns

1. Page Structure:

   ```tsx
   <Stack
     gap="3rem"
     px={{ base: '1rem', md: '2rem' }}
     py={{ base: '2rem', md: '4rem' }}
   >
     <PageContent />
   </Stack>
   ```

2. Section Structure:

   ```tsx
   <Stack gap="1.5rem">
     <Title order={2}>Section Title</Title>
     <ContentArea />
   </Stack>
   ```

3. Form Structure:

   ```tsx
   <Stack gap="2rem">
     <Input1 />
     <Input2 />
     <Input3 />
   </Stack>
   ```

4. Related Content:
   ```tsx
   <Stack gap="xs">
     <Label />
     <Description />
   </Stack>
   ```

## Notes

- Use fixed gap values as they don't support responsive parameters
- Use responsive padding with Mantine's breakpoint syntax: `{ base: "mobile-value", md: "desktop-value" }`
- The `md` breakpoint is set to 768px as defined in the theme configuration
- Maintain consistent Title hierarchy across breakpoints
- Keep padding responsive using the breakpoint syntax
- Use Mantine Stack components for consistent spacing
- Check for any parent container padding/margin that could affect spacing
- Add responsive bottom padding to the outermost Stack component
- For very tight layouts on mobile, consider using the `xs` breakpoint (320px) for additional adjustments
