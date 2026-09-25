# Contributing translations to Echo

You can help translate the dembrane dashboard and participant portal without being a developer. Corrections to a few words, translations of one screen, and reviews of existing translations are all welcome. You do not need to translate the whole platform.

The translations live in the public [Dembrane/echo repository](https://github.com/Dembrane/echo). This guide covers interface text such as buttons, instructions, and error messages. Reports, language-model prompts, emails, and documentation have separate sources; ask maintainers where to contribute if those are your focus.

## 1. Choose a language and a small starting point

The interface currently has these translation files:

| Language | File |
| --- | --- |
| English (source text) | [en-US.po](echo/frontend/src/locales/en-US.po) |
| Dutch | [nl-NL.po](echo/frontend/src/locales/nl-NL.po) |
| German | [de-DE.po](echo/frontend/src/locales/de-DE.po) |
| French | [fr-FR.po](echo/frontend/src/locales/fr-FR.po) |
| Spanish | [es-ES.po](echo/frontend/src/locales/es-ES.po) |
| Italian | [it-IT.po](echo/frontend/src/locales/it-IT.po) |
| Ukrainian | [uk-UA.po](echo/frontend/src/locales/uk-UA.po) |
| Czech | [cs-CZ.po](echo/frontend/src/locales/cs-CZ.po) |

The language picker currently marks Italian, Ukrainian, and Czech as partial. Existing languages also benefit from proofreading and missing translations.

For a larger batch or a new language, first [open an issue](https://github.com/Dembrane/echo/issues) with the language, regional variant, and screens you would like to work on. Check existing issues to avoid duplicating someone else's work. A small correction can go straight into a pull request.

## 2. Choose how to contribute

### Suggest wording without editing files

Open an issue with:

- The language and the screen where the text appears.
- The current wording and your suggested replacement.
- A short explanation, especially if the meaning is wrong or ambiguous.
- A screenshot if it helps, with personal or participant information removed.

For example: “Dutch, recording screen: change [current text] to [suggestion], because …”. If GitHub is a barrier, contact the maintainers at [sameer@dembrane.com](mailto:sameer@dembrane.com) for help arranging a contribution.

### Edit in your browser

1. Sign in to GitHub and open the [repository](https://github.com/Dembrane/echo).
2. Fork it to create your own copy. Start from its up-to-date `main` branch and create a branch for your changes, for example `translations/fr-recording`.
3. In your fork, open `echo/frontend/src/locales/` and select your language's `.po` file. Use GitHub's file editor to change the translations using the rules below.
4. Save your changes with a short description, such as “Improve French recording instructions”. Keep subsequent edits on the same branch.
5. For your first contribution, read the [Contributor License Agreement](CLA.md). If you agree, add your GitHub username as a new line in [contributors.yml](contributors.yml) on that same branch, following the existing `- username` format.
6. Open a pull request from your branch to `Dembrane/echo` → `main`. A pull request is a proposal for the maintainers to review and merge your changes.
7. Explain which language and screens you changed. Include any questions and say: “Edited in the browser; please help regenerate and validate the translation catalogs.”

The repository also tracks generated `.ts` translation files. Do not edit those by hand. A browser-only contribution needs help from a maintainer or another contributor to run the local commands below and commit the generated changes before merging. The translation check can fail until this is done; opening the pull request does not generate those files automatically.

### Edit locally with Git

Use Git, Node.js 22, and pnpm 10, matching the translation checks in the repository. Fork the repository on GitHub, then run the following, replacing `YOUR-USERNAME` and the example branch name:

```bash
git clone https://github.com/YOUR-USERNAME/echo.git
cd echo
git switch -c translations/fr-recording
cd echo/frontend
pnpm install --frozen-lockfile
pnpm messages:extract
```

Edit `src/locales/fr-FR.po` or the file for your language. A plain text editor is sufficient. Then run:

```bash
pnpm messages:compile
git diff --stat
git diff -- src/locales/fr-FR.po
```

Extraction synchronizes the catalogs with the current source text; compilation creates the `.ts` files used by the application. Review all changed catalogs. If extraction produces a large unrelated change, ask maintainers before including it. Do not hand-edit generated files or change dependency versions for a translation contribution.

For your first contribution, read [CLA.md](CLA.md) and, if you agree, add your GitHub username to [contributors.yml](contributors.yml). From `echo/frontend`, return to the repository root to commit and push:

```bash
cd ../..
git add echo/frontend/src/locales/
# First contribution only, after reading and agreeing to the CLA:
git add contributors.yml
git diff --cached --stat
git commit -m "Improve French recording instructions"
git push -u origin translations/fr-recording
```

Open a pull request to `Dembrane/echo` → `main`. Include both the edited `.po` files and the generated `.ts` changes. After committing, rerunning extraction and compilation should leave `git diff --exit-code -- src/locales` clean when run from `echo/frontend`. This is what the translation check verifies.

## 3. Translate the wording, preserve the structure

A `.po` file is a list of messages. Usually `msgid` is the English source and `msgstr` is the translation:

```po
msgid "Save"
msgstr "Opslaan"
```

- Edit `msgstr`; leave `msgid`, comments, and source references intact. For English wording changes, open an issue or ask maintainers, since the original text may also need changing in the application code.
- Some `msgid` values are identifiers, such as `participant.verify.selection.title`. Find the same identifier in `en-US.po` and translate its `msgstr`, which in this example is “What do you want to verify?”. Do not translate the identifier itself.
- Keep placeholders exactly as written: `{name}`, `{0}`, and paired tags such as `<0>…</0>`. You may move them to fit the sentence, but do not translate their names, remove them, or break their pairs.
- Preserve escaped characters such as `\n` and `\"`. Save files as UTF-8 so accented characters remain intact.
- Leave the header at the top of the file intact. A `msgstr ""` followed by quoted lines is a multiline translation, not necessarily a missing one.
- Skip obsolete entries whose lines start with `#~`. If an entry is marked `#, fuzzy`, review it against the source and remove the fuzzy flag only once you have checked the translation.
- Leave genuinely untranslated entries empty if you are unsure, and mention them in your pull request. English is the configured fallback.

Plural messages have extra structure. For example:

```po
msgid "{0, plural, one {# conversation} other {# conversations}}"
msgstr "{0, plural, one {# gesprek} other {# gesprekken}}"
```

Translate the wording inside each branch, preserving the variable, braces, `plural`, category names, and `#` count marker. Keep the `other` branch. Some languages need additional plural categories; ask for help if you are unsure rather than copying English grammar into your language.

## 4. Keep the text clear and natural

Follow the [writing and language guidelines](echo/brand/STYLE_GUIDE.md):

- Translate the meaning naturally, with short sentences and familiar words.
- Keep button labels short and terminology consistent across screens.
- Use the equivalents of “participants” and “hosts” where appropriate.
- Keep `dembrane` lowercase and preserve product names and links.
- Dutch uses informal `je/jij`; Italian uses informal `tu`, simple wording, and sentence case. The style guide includes glossaries for both.
- Review every suggested translation yourself, including suggestions from translation software.

The `#:` lines above a message point to its location in the application source and can help explain context. If the meaning remains unclear, ask in the issue or pull request.

## 5. Review and submit

Before requesting review, check that:

- The text reads naturally to someone fluent in the language.
- Variables, links, tags, and plural forms are intact.
- Your pull request describes the scope, uncertainties, and checks performed.
- Generated catalogs are included, or you have explicitly requested help generating them.
- You have completed the first-contribution CLA step if applicable.

If you already have a working local development environment, run `pnpm dev` for the dashboard or `pnpm participant:dev` for the portal from `echo/frontend`. Select your language and check the affected screens for clipped labels, incorrect substitutions, and awkward wording. Full application testing requires backend services and appropriate access; you do not need to set that up just to contribute wording. Ask maintainers to help with an interface review, and state clearly if you have not tested in the application.

Maintainers review the language changes and technical checks, may request revisions, and merge accepted contributions. Merging to `main` makes the changes available through the staging deployment; the public production application updates with a subsequent release.

## Adding a language that is not listed

Start with an issue describing the language and regional variant you can translate and whether someone else can review it. Creating a `.po` file alone does not enable a language. Maintainers also need to update the Lingui configuration, supported-language list, catalog loading, and language picker, then check relevant backend language handling and templates. Agree on the initial scope and any partial-language label before translating a large batch.

## Contribution terms

The repository welcomes community contributions and is currently source available under the [Business Source License 1.1](LICENSE), as described in the [README](README.md#project-status-and-license). Read the [contribution guide](CONTRIBUTING.md) and [Contributor License Agreement](CLA.md) before submitting. The repository's first-pull-request process asks contributors to record their agreement by adding their GitHub username to `contributors.yml`.
