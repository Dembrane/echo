# What dembrane sends: the design system off-screen

Offers, invoices, the account page and the emails around them are where an organisation
decides to pay us. They should feel like the same dembrane as the dashboard: calm, warm,
plain, and sure of itself. This file carries the app's design system (October 2026,
`frontend/src/styles/rules.css`) into the places its CSS cannot reach: PDFs, email, and
the documents other systems render for us (sam's emails, Exact's invoices).

The values live in code once, in `platform/packages/mail/src/brand.ts` (`brand` from
`@dembrane/mail`). The app's own files stay the source; change a value there first.

## Principles

1. **One dembrane.** A customer moves from an email to the account page to a signed PDF.
   Each step uses the same type, the same colours and the same lines, so nothing feels
   like a different company's paperwork.
2. **The money is the clearest thing on the page.** Amounts are right-aligned, VAT is
   shown, and the total a customer pays is the largest number. No one should have to add
   anything up or wonder whether a figure includes VAT.
3. **Say what happens next.** Every document and email ends with one next step: sign,
   fill in, pay. One primary action, as a pill; everything else is a link.
4. **Hierarchy from size and space, never weight.** One weight (320). A title is a step up
   the ladder with room above it. Bold is not emphasis; blue or a sentence is.
5. **Lines mean something.** Top and bottom: something to read (a table, a summary,
   an email's card). Sides or an underline: somewhere to write. A full box: something to
   press. Square corners everywhere except the primary pill.
6. **Accents are decoration.** Cyan, spring green, mauve and lime never mean success,
   warning or anything else. Status has its own colours and appears only when something
   is wrong, late or done.
7. **Plain words.** Warm, direct, short sentences; the reader's language, never mixed on
   one page. "dembrane" is always lowercase. Legal text keeps its words; only its setting
   changes. Each language keeps the register the server catalogue already uses: informal
   in Dutch (je, jullie), Spanish and Italian; formal in German (Sie) and French (vous).
   Legal text keeps its own register (the Dutch clause says u).

## Tokens

| Role | Value | Use |
|---|---|---|
| parchment | `#f6f4f1` | behind a card (email, account page) |
| surface | `#ffffff` | the card, the printed page |
| text | `#2d2d2c` | all text, never pure black |
| muted | `#5f646f` | labels, captions, secondary facts |
| quiet | `#e6e3df` | faint rules, around something to read |
| control | `#878785` | rules around a place to write |
| action | `#2957df` | links and the primary pill (royal blue `#4169e1` fails AA as text) |
| action tint | `#e9f1ff` | a selected or highlighted row |
| danger / warning / success | `#c0434e` / `#7a5200` / `#0e6e47` | status only |
| accents | cyan, spring green, mauve, lime | decorative only |

**Type.** DM Sans at 320, with stylistic sets ss01 to ss06 (the single-storey a, g, u,
y) wherever DM Sans itself is loaded: the app, and the PDFs, whose cuts have the sets
frozen in (`packages/accounts/assets/fonts/build.py`). Email names DM Sans at 400, loads
no web font and turns no stylistic set on: most readers see a fallback, whose 300 is a
Light cut and far too thin, and in some fallbacks (Inter) ss01 to ss06 draw circled
letters and digits.

| Step | Screen and email (px) | Print (pt) | Use |
|---|---|---|---|
| caption | 14 | 7.5 | labels, footers, table heads |
| body | 16 | 10 | running text |
| lead | 18.66 | 13.33 | totals, an email's opening line |
| title | 24.88 | 17.77 | section titles, email headings |
| display | 33.17 | 23.69 | a document's title |

Running text at 1.55 line height, titles at 1.2. Space in steps of 4 (px or pt).

**Lines.** One stroke: 1px on screen, 0.5pt in print. Square corners; the pill
(`9999px`) only on the one primary action.

## Per surface

- **Offer PDF.** The wordmark top left; dembrane's company details in the footer of every
  page with the page number. The title, then the facts in a ruled row (reference, date,
  valid until). The lines table ruled above and below, numbers right-aligned, then
  subtotal, VAT and the total. A custom offer's amendments follow the total, each numbered
  under its title, in body size: they change the standard documents, so they are read, not
  buried. Acceptance on its own page as labelled lines to write on, with the e-signing
  clause in its first lines, then the clause naming only the documents that apply (an event
  has no SLA) and the amendments. The DPA is its own document, signed separately.
- **Invoices.** Exact draws the PDF; its layout should follow the offer's (same wordmark,
  same footer, same table). On the account page an open invoice shows its amount, due date
  and how to pay before anything else.
- **Account page.** The app's system as it is, applied without local exceptions.
- **Emails.** One frame for every email: parchment behind a white card ruled top and
  bottom, the wordmark, a title, the body, one pill, and a quiet footer. It is built once,
  as `emailFrame` in `platform/packages/mail/src/email.ts` with its helpers (`facts`,
  `code`, `money`, `day`), and every email uses it, sam's included. Email loads no web
  font: only Apple Mail honours an `@import`, and it would send each reader's address to
  Google. The font stack falls back to the system sans where DM Sans is not installed.
