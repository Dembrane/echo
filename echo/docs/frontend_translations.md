# Frontend: Adding Translations

We use **Lingui** with **React JS** for handling translations. This document outlines the steps to add and manage translations within our project.

## Writing Good Copy

Before writing translatable strings, review the [COPY_GUIDE.md](../frontend/COPY_GUIDE.md) for tone and style guidelines. Key principles:

- **Shortest possible, highest clarity** — say it in fewer words
- **No jargon** — avoid technical terms users won't understand (e.g., "context limit" → "selection too large")
- **No corporate speak** — write like you're explaining to a colleague
- **Never say "successfully"** — just state what happened ("Saved" not "Successfully saved")

### Examples

| Bad | Good |
|-----|------|
| "Context limit reached" | "Selection too large" |
| "File has been successfully uploaded" | "File uploaded" |
| "Please wait while we process your request" | "Processing..." |
| "An error occurred while saving" | "Couldn't save. Try again." |

## Using Translations in JSX

To add translations within JSX, use the `<Trans>` component from Lingui. For example:

```jsx
import { Trans } from '@lingui/react/macro';

function MyComponent() {
  return (
    <div>
      <h1>
        <Trans>Upload in progress</Trans>
      </h1>
      <p>
        <Trans>Please do not close your browser</Trans>
      </p>
    </div>
  );
}
```

### Complex JSX Translations

For JSX containing variables, HTML elements, or components, the `Trans` macro handles them automatically:

```jsx
<p>
  <Trans>
    See all <a href="/unread">unread messages</a>
    {' or '}
    <a onClick={markAsRead}>mark them</a> as read.
  </Trans>
</p>
```

### Pluralization

For messages that need pluralization, use the `Plural` component:

```jsx
import { Plural } from '@lingui/react/macro';

<Plural
  value={messagesCount}
  _0="There are no messages"
  one="There's # message in your inbox"
  other="There are # messages in your inbox"
/>;
```

## Using Translations in Free Text

For free text translations outside of JSX (like alerts or props), use the `t` function with the `useLingui` hook:

```jsx
import { useLingui } from '@lingui/react/macro';

function MyComponent() {
  const { t } = useLingui();

  const handleClick = () => {
    alert(t`Operation completed successfully`);
  };

  return <img src="..." alt={t`Image caption`} />;
}
```

## Adding Translations

### Step 1: Extract Messages

Run the following command to extract messages from your code:

```bash
pnpm messages:extract
```

This will update all `.po` files in the `frontend/src/locales` directory with any new or modified messages.

### Step 2: Update Empty Translations

After extraction, you may find empty translations in the `.po` files. These appear as:

```po
msgid "Some text"
msgstr ""
```

For the English (en-US) file, the `msgstr` should be the same as the `msgid`. This is the default behavior of Lingui as English is our source language.

```po
msgid "Some text"
msgstr "Some text"
```

For other language files (de-DE, es-ES, fr-FR, nl-NL), you should either:

1. Leave the `msgstr` empty for proper translation later by language experts
2. Or provide appropriate translations in the target language

Note: The first empty `msgstr` in each `.po` file is the header and should remain empty.

### Tips for Filling `msgstr` Values

- Use `rg 'msgstr ""' frontend/src/locales/*.po` to quickly spot empty entries, then open the surrounding context to confirm the string is truly empty (multi-line translations look like `msgstr ""` followed by quoted lines, so double-check before editing).
- When a locale entry only shows an identifier (e.g., `participant.verify.selection.title`), copy the UX copy from `frontend/src/locales/en-US.po` to understand the intended wording before translating.
- Keep placeholders exactly as they appear in English (`{variable}`, `<0>`, `#`, etc.) to avoid runtime errors.
- When many strings are missing, you can script the audit with `polib`:

```bash
python3 -m pip install polib  # one-time
# run an inline snippet (example below) to list missing strings
```

Example inline snippet:

```bash
python3 - <<'PY'
import polib, glob
for path in glob.glob("frontend/src/locales/*.po"):
    if path.endswith("en-US.po"):
        continue
    po = polib.pofile(path)
    missing = [e.msgid for e in po if not e.obsolete and not e.msgstr]
    if missing:
        print(path, len(missing))
PY
```

This ensures every non-English catalog stays in sync with the English source before compiling.

### Step 3: Compile Messages

Run the following command to compile the messages:

```bash
pnpm messages:compile
```

### Step 4: Verify Translations

After adding the translations, you can verify them by running your React application and checking the translated messages in the UI.

## Commands Summary

- `cd frontend && pnpm i`
- Extract messages: `pnpm messages:extract`
- Update translations by going to the frontend/src/locales/ folder and editing the .po files

- You can go to all the .po files and search for `msgstr ""` to find all the empty translations.

- Compile messages: `pnpm messages:compile`

By following these steps, you can ensure that your application is properly localized and supports multiple languages.

## Important Notes

1. **Macros vs Runtime Components**: Macros are transformed at compile time for better performance and smaller bundle size. In production, the Trans macro:

```jsx
<Trans>Hello {name}</Trans>

// transforms to:
<Trans id="OVaF9k" values={{ name }} />
```

2. **Date and Number Formatting**: Use the `i18n` object from `useLingui` hook for consistent formatting:

```jsx
const { i18n } = useLingui();

<Trans>Last login on {i18n.date(lastLogin)}</Trans>;
```

3. **Module Level Restrictions**: Core macros (`t`, `plural`, etc.) cannot be used at the module level. They must be used within components or functions.

4. **Exact Forms**: For specific number cases, use `_N` prefix (e.g., `_0`, `_1`) instead of `=N`:

```jsx
<Plural value={count} _0="No messages" one="# message" other="# messages" />
```
