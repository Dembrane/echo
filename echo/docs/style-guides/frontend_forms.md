# Frontend Forms Style Guide and Documentation

## Quick Reference
- **Form State Management**: React Hook Form
- **UI Components**: Mantine UI
- **Internationalization**: LinguiJS (@lingui/macro)
- **Auto-save Capability**: Built-in with `useAutoSave` hook
- **Dirty State Tracking**: Automatic via `FormLabel` component
- **Layout Options**: Single-column, Two-column with preview
- **Input Types**: Text, Select, Checkbox, Rich Text, Custom Components

## Key Features

### 1. Auto-save Functionality
- Automatic saving on field changes
- Debounced save operations
- Visual save status indicators
- Manual save triggers available

### 2. Form States
- Dirty state tracking per field
- Immediate validation on change
- Field-level error states
- Loading states
- Save pending states

### 3. Layout Patterns
- Responsive layouts (mobile-first)
- Two-column with preview
- Section-based organization
- Sticky headers/preview

### 4. Input Components
- Basic inputs (Text, Select, Checkbox)
- Rich text editor integration
- Custom complex inputs (Tags, ProperNoun)
- Internationalized labels and help text

### 5. Error Handling
- Form-level errors
- Field-level validation
- Error boundaries
- Network error handling

### 6. Accessibility Features
- ARIA labels
- Keyboard navigation
- Focus management
- Proper contrast states

### 7. Performance Optimizations
- Efficient form state management
- Debounced operations
- Lazy loading
- Memoization patterns

## When to Use What

### Auto-save Forms
Use when:
- Editing existing data (sync to server)
- Long-form content
- Continuous updates needed

### Standard Submit Forms
Use when:
- Creating new entries
- Authentication flows
- Simple data collection

### Preview-enabled Forms
Use when:
- Content editing
- Template creation
- Visual output needed

## Overview
This guide outlines our standard patterns for building forms in React using React Hook Form, Mantine UI components, and our custom form elements.

## Core Technologies
- **React Hook Form** for form state management
- **Mantine UI** for base components
- **Custom `FormLabel` component** for dirty state indication
- **`useAutoSave` hook** for automatic form saving

## Basic Form Structure

### Common Form Imports
```typescript
// Core form libraries
import { useForm, Controller } from "react-hook-form";
import { Trans, t } from "@lingui/macro";

// Mantine UI components
import {
  TextInput,
  Textarea,
  Select,
  NativeSelect,
  Checkbox,
  Button,
  Group,
  Stack,
  Title,
  Divider,
  Text,
} from "@mantine/core";

// Custom form components
import { FormLabel } from "@/components/form/FormLabel";
import { SaveStatus } from "@/components/form/SaveStatus";

// Custom hooks
import { useAutoSave } from "@/lib/hooks/useAutoSave";
```

### Form Setup
```typescript
const { control, handleSubmit, watch, trigger, formState, reset } = useForm<TFormSchema>({
  defaultValues: {
    field1: initialValue1,
    field2: initialValue2,
  },
  resolver: zodResolver(FormSchema),
  mode: "onChange",
  reValidateMode: "onChange",
});
```

### Basic Form Layout
```tsx
<Stack gap="3rem">
  {/* Header with SaveStatus */}
  <Group>
    <Title order={2}>
      <Trans>Form Title</Trans>
    </Title>
    <SaveStatus
      savedAt={lastSavedAt}
      isPendingSave={isPendingSave}
      isSaving={isSaving}
      isError={isError}
    />
  </Group>

  {/* Form Content */}
  <form
    onSubmit={handleSubmit(async (values) => {
      await triggerManualSave(values);
    })}
  >
    <Stack gap="2rem">
      {/* Form fields go here */}
    </Stack>
  </form>

  {/* Bottom SaveStatus */}
  <Text size="sm" color="dimmed">
    <SaveStatus
      savedAt={lastSavedAt}
      isPendingSave={isPendingSave}
      isSaving={isSaving}
      isError={isError}
    />
  </Text>
</Stack>
```

## Form Components

### Text Input
```tsx
<Controller
  name="fieldName"
  control={control}
  render={({ field }) => (
    <TextInput
      label={<FormLabel label={t`Label`} isDirty={dirtyFields.fieldName} />}
      description={t`Help text for the field`}
      {...field}
    />
  )}
/>
```

### Select Input
```tsx
<Controller
  name="language"
  control={control}
  render={({ field }) => (
    <NativeSelect
      label={<FormLabel label={t`Label`} isDirty={dirtyFields.language} />}
      description={t`Help text`}
      data={[
        { label: t`Option 1`, value: "opt1" },
        { label: t`Option 2`, value: "opt2" },
      ]}
      {...field}
    />
  )}
/>
```

### Checkbox
```tsx
<Controller
  name="checkboxField"
  control={control}
  render={({ field }) => (
    <Checkbox
      label={<FormLabel label={t`Label`} isDirty={dirtyFields.checkboxField} />}
      description={t`Help text`}
      checked={field.value}
      onChange={(e) => field.onChange(e.currentTarget.checked)}
    />
  )}
/>
```

## Auto-Save Implementation

### Setup Auto-Save
```tsx
const {
  dispatchAutoSave,
  triggerManualSave,
  isPendingSave,
  isSaving,
  isError,
  lastSavedAt,
} = useAutoSave({
  onSave: async (values: TFormSchema) => {
    await updateMutation.mutateAsync({
      id: entityId,
      payload: values,
    });
    // Reset form state while keeping values
    reset(values, { keepDirty: false, keepValues: true });
  },
  initialLastSavedAt: entity.updated_at,
});

// Watch for changes to trigger auto-save
useEffect(() => {
  const subscription = watch((values, { type }) => {
    if (type === "change" && values) {
      trigger().then((isValid) => {
        if (isValid) {
          dispatchAutoSave(values as TFormSchema);
        }
      });
    }
  });

  return () => subscription.unsubscribe();
}, [watch, dispatchAutoSave, trigger]);
```

### Save Status Display
```tsx
<SaveStatus
  savedAt={lastSavedAt}
  isPendingSave={isPendingSave}
  isSaving={isSaving}
  isError={isError}
/>
```

## Form Sections and Organization

### Section Structure
```tsx
<Stack gap="1.5rem">
  <Title order={3}>
    <Trans>Section Title</Trans>
  </Title>
  <Stack gap="2rem">
    {/* Related form fields */}
  </Stack>
</Stack>

<Divider />  {/* Use dividers between sections */}
```

## Best Practices

1. **Field Organization**
   - Group related fields together in sections.
   - Use consistent spacing (`gap="2rem"` between fields, `gap="1.5rem"` for section headers).
   - Add dividers between major sections.

2. **Labels and Help Text**
   - Always use `FormLabel` component to show dirty state.
   - Provide clear, concise labels.
   - Add helpful description text when needed.

3. **Validation**
   - Avoid setting form mode to `"onBlur"`; let changes be processed immediately.
   - Use React Hook Form's built-in validation when necessary.

4. **Internationalization**
   - Wrap all user-facing strings in `t` or `<Trans>` tags.
   - Include translations for all form content.

5. **Auto-Save**
   - Implement auto-save for better user experience.
   - Show save status clearly to users.
   - Provide manual save option as a backup.

6. **Avoid Unnecessary Buttons**
   - Do not add a cancel button to auto-save forms.
   - Minimize the use of extra buttons unless necessary.

## Implementation Patterns

### Custom Input Components
Create reusable custom input components for complex inputs:

```tsx
const CustomInput = ({
  value,
  onChange,
  isDirty,
}: {
  value: string;
  onChange: (value: string) => void;
  isDirty: boolean;
}) => {
  return (
    <Stack gap="md">
      <TextInput
        label={<FormLabel label={t`Label`} isDirty={isDirty} />}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
      />
    </Stack>
  );
};
```

### Rich Text Editors
For rich text content, use the `MarkdownWYSIWYG` component:

```tsx
<Stack gap="xs">
  <FormLabel
    label={t`Content`}
    isDirty={dirtyFields.content}
  />
  <InputDescription>
    <Trans>Help text</Trans>
  </InputDescription>
  <Controller
    name="content"
    control={control}
    render={({ field }) => (
      <MarkdownWYSIWYG
        markdown={field.value}
        onChange={field.onChange}
      />
    )}
  />
</Stack>
```

## Error Handling

1. **Form-Level Errors**
   - Display at the top of the form.
   - Use error boundaries for unexpected errors.

2. **Field-Level Errors**
   - Show inline with fields.
   - Provide clear error messages.
   - Use validation rules from React Hook Form.

## Accessibility

1. Always include proper ARIA labels.
2. Maintain keyboard navigation.
3. Ensure proper contrast for error states.
4. Use semantic HTML structure.
5. Include proper focus indicators.

## Performance Considerations

1. Use React Hook Form for efficient form state management.
2. Implement debounced auto-save.
3. Lazy load complex components.
4. Optimize re-renders using proper memoization.

## Additional Form Patterns

### Complex Input Components

#### Tag-like Input (`ProperNounInput`)
A specialized input component that handles comma-separated values and displays them as removable pills:

```tsx
const ProperNounInput = ({
  value,
  onChange,
  isDirty,
}: {
  value: string;
  onChange: (value: string) => void;
  isDirty: boolean;
}) => {
  const [nouns, setNouns] = useState<string[]>([]);
  const [nounInput, setNounInput] = useState("");

  useEffect(() => {
    setNouns(
      value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
    );
  }, [value]);

  const handleAddNoun = () => {
    if (nounInput.trim()) {
      const newNouns = [
        ...nouns,
        ...nounInput
          .split(",")
          .map((noun) => noun.trim())
          .filter(Boolean),
      ];
      const uniqueNouns = Array.from(new Set(newNouns));
      setNouns(uniqueNouns);
      onChange(uniqueNouns.join(", "));
      setNounInput("");
    }
  };

  const handleRemoveNoun = (noun: string) => {
    const newNouns = nouns.filter((n) => n !== noun);
    setNouns(newNouns);
    onChange(newNouns.join(", "));
  };

  return (
    <Stack gap="md">
      <TextInput
        label={<FormLabel label={t`Specific Context`} isDirty={isDirty} />}
        value={nounInput}
        onChange={(e) => setNounInput(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            handleAddNoun();
          }
        }}
      />
      <Group gap="xs">
        {nouns.map((noun, index) => (
          <Pill
            key={index}
            withRemoveButton
            onRemove={() => handleRemoveNoun(noun)}
          >
            {noun}
          </Pill>
        ))}
      </Group>
    </Stack>
  );
};
```

## Layout Patterns

### Form Section Organization
```tsx
<Stack gap="3rem">
  {/* Header with SaveStatus */}
  <Group>
    <Title order={2}>
      <Trans>Section Title</Trans>
    </Title>
    <SaveStatus
      savedAt={lastSavedAt}
      isPendingSave={isPendingSave}
      isSaving={isSaving}
      isError={isError}
    />
  </Group>

  {/* Form Content */}
  <form
    onSubmit={handleSubmit(async (values) => {
      await triggerManualSave(values);
    })}
  >
    <Stack gap="2rem">
      {/* Form fields */}
    </Stack>
  </form>

</Stack>
```

## Best Practices Updates

1. **Avoid 'mode: "onBlur"' in `useForm`**
   - **Do not use** `'mode: "onBlur"'` in `useForm` configuration.
   - Let the form handle validation and state updates on change for immediate feedback and auto-save functionality.

2. **Placement of `SaveStatus`**
   - Always place `SaveStatus` component immediately after form/section titles.
   - Include an additional `SaveStatus` at the bottom of forms wrapped in a `Text` component with `size="sm"` and `color="dimmed"`.

3. **Avoid Cancel Buttons in Auto-Save Forms**
   - Do not include cancel buttons in forms that auto-save.
   - Rely on the auto-save and manual save triggers.

4. **Component Organization**
   - Group related controls together.
   - Maintain consistent spacing patterns.
   - Use dividers to separate logical sections.
   - Include proper section headers with status indicators.

5. **Proper Use of `useEffect`**
   - Ensure `useEffect` dependencies are correctly specified to prevent unintended behavior.
   - Avoid unnecessary dependencies that can lead to performance issues.

6. **Consistent Styling**
   - Maintain consistent styling across all form elements.
   - Use Mantine UI components and theming for uniform appearance.

## What Not to Do

1. **Do Not Use `mode: "onBlur"` in Form Configuration**
   - Using `'mode: "onBlur"'` can delay validation and interfere with auto-save functionality.
   - Stick with the default mode to process changes and validations immediately.

2. **Do Not Add a Cancel Button**
   - Cancel buttons can confuse users in auto-save forms.
   - They might expect changes to be discarded, which conflicts with the auto-save feature.

3. **Do Not Ignore Dirty State Tracking**
   - Always use `FormLabel` to indicate dirty state.
   - Helps users know which fields have unsaved changes.

4. **Avoid Inconsistent `SaveStatus` Placement**
   - Do not place `SaveStatus` in random locations.
   - Ensure it is consistently placed after titles.

5. **Do Not Forget Internationalization**
   - Do not hard-code user-facing strings.
   - Always use `t` or `<Trans>` for strings to support translation.

6. **Do Not Overcomplicate Forms**
   - Keep forms simple and user-friendly.
   - Avoid unnecessary complexity in layout and logic.

7. **Avoid Unnecessary `useEffect` Dependencies**
   - Be cautious with dependencies in `useEffect` hooks to prevent infinite loops or performance issues.
   - Only include necessary dependencies.

8. **Do Not Bypass Auto-Save Logic**
   - Ensure that all form changes trigger auto-save correctly.
   - Do not manually update state in a way that bypasses the form's control.