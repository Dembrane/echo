# Template Fixes, Community Removal, Report Colors, Anonymization UX

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix template quick access bugs by simplifying to JSON storage, remove dead community marketplace code, fix report button colors to match brand, and add anonymization UX for participants and hosts.

**Architecture:** Four independent changes. Template preferences move from a separate Directus collection to a JSON field on `directus_users`. Community code is fully deleted. Report buttons change from teal to blue. Anonymization adds a muted notice in the participant recording view and a confirmation modal in the host portal editor.

**Tech Stack:** Python/FastAPI, React/Mantine, Lingui i18n, Directus SDK

---

## File Map

| Change | Files to Modify | Files to Delete |
|--------|----------------|-----------------|
| Template preferences | `server/dembrane/api/template.py`, `frontend/src/lib/api.ts`, `frontend/src/components/chat/TemplatesModal.tsx`, `frontend/src/components/chat/templateKey.ts` | `frontend/src/components/chat/QuickAccessConfigurator.tsx` (if unused elsewhere) |
| Community removal | `server/dembrane/api/template.py`, `frontend/src/lib/api.ts`, `frontend/src/components/chat/TemplatesModal.tsx` | `frontend/src/components/chat/hooks/useCommunityTemplates.ts`, `frontend/src/components/chat/PublishTemplateForm.tsx` |
| Report colors | `frontend/src/components/report/CreateReportForm.tsx`, `frontend/src/components/report/UpdateReportModalButton.tsx`, `frontend/src/routes/project/report/ProjectReportRoute.tsx` | None |
| Anonymization UX | `frontend/src/components/participant/ParticipantBody.tsx`, `frontend/src/components/participant/ParticipantConversationAudio.tsx`, `frontend/src/components/participant/ParticipantConversationText.tsx`, `frontend/src/components/project/ProjectPortalEditor.tsx`, `frontend/src/locales/*.po` | None |

---

### Task 1: Report Buttons -- Teal to Blue

The simplest change. All primary buttons in the report feature use `color="teal"` but should use `color="blue"` per brand guidelines.

**Files:**
- Modify: `frontend/src/components/report/CreateReportForm.tsx:258,295`
- Modify: `frontend/src/components/report/UpdateReportModalButton.tsx:149,274,311`
- Modify: `frontend/src/routes/project/report/ProjectReportRoute.tsx:548,992`

- [ ] **Step 1: Change CreateReportForm.tsx buttons**

In `frontend/src/components/report/CreateReportForm.tsx`, change both instances of `color="teal"` to `color="blue"`:

Line 258 (Schedule Report button):
```tsx
color="blue"
```

Line 295 (Generate now button):
```tsx
color="blue"
```

- [ ] **Step 2: Change UpdateReportModalButton.tsx buttons**

In `frontend/src/components/report/UpdateReportModalButton.tsx`, change all three instances of `color="teal"` to `color="blue"`:

Line 149 (Update Report trigger button):
```tsx
color="blue"
```

Line 274 (Schedule Report button):
```tsx
color="blue"
```

Line 311 (Generate now button):
```tsx
color="blue"
```

- [ ] **Step 3: Change ProjectReportRoute.tsx buttons**

In `frontend/src/routes/project/report/ProjectReportRoute.tsx`, change both instances of `color="teal"` to `color="blue"`:

Line 548 (Confirm reschedule button):
```tsx
color="blue"
```

Line 992 (Publish toggle Switch):
```tsx
color="blue"
```

- [ ] **Step 4: Visual check**

Run `cd frontend && pnpm build` to confirm no build errors.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/report/CreateReportForm.tsx frontend/src/components/report/UpdateReportModalButton.tsx frontend/src/routes/project/report/ProjectReportRoute.tsx
git commit -m "fix: change report buttons from teal to blue per brand guidelines"
```

---

### Task 2: Remove Community Marketplace Code

Full deletion of all community endpoints, schemas, frontend hooks, and API client functions. The `prompt_template_rating` Directus collection stays in the database (no destructive migration).

**Files:**
- Modify: `server/dembrane/api/template.py`
- Delete: `frontend/src/components/chat/hooks/useCommunityTemplates.ts`
- Delete: `frontend/src/components/chat/PublishTemplateForm.tsx`
- Modify: `frontend/src/components/chat/TemplatesModal.tsx`
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Remove community schemas from template.py**

In `server/dembrane/api/template.py`, delete lines 67-102 (the following schemas and constant):

```python
# DELETE these blocks entirely:

class PromptTemplateRatingIn(BaseModel):
    prompt_template_id: str
    rating: Literal[1, 2]  # 1 = thumbs down, 2 = thumbs up
    chat_message_id: Optional[str] = None


class PromptTemplateRatingOut(BaseModel):
    id: str
    prompt_template_id: str
    rating: int
    chat_message_id: Optional[str] = None
    date_created: Optional[str] = None


ALLOWED_TAGS = ["Workshop", "Interview", "Focus Group", "Meeting", "Research", "Community", "Education", "Analysis"]


class CommunityTemplateOut(BaseModel):
    id: str
    title: str
    description: Optional[str] = None
    content: str
    tags: Optional[List[str]] = None
    language: Optional[str] = None
    author_display_name: Optional[str] = None
    star_count: int = 0
    use_count: int = 0
    date_created: Optional[str] = None
    is_own: bool = False


class PublishTemplateIn(BaseModel):
    description: Optional[str] = Field(default=None, max_length=500)
    tags: Optional[List[str]] = Field(default=None)
    language: Optional[str] = Field(default=None, max_length=10)
    is_anonymous: bool = False
```

- [ ] **Step 2: Remove community endpoints from template.py**

Delete the entire `# -- Community Marketplace --` section (lines 228-505), which contains these endpoints:
- `GET /community` (list_community_templates)
- `GET /community/my-stars` (get_my_community_stars)
- `POST /{id}/publish` (publish_template)
- `POST /{id}/unpublish` (unpublish_template)
- `POST /{id}/star` (toggle_star)
- `POST /{id}/copy` (copy_template)

- [ ] **Step 3: Remove ratings endpoints from template.py**

Delete the entire `# -- Ratings --` section (lines 584-681), which contains:
- `POST /ratings` (rate_prompt_template)
- `DELETE /ratings/{id}` (delete_rating)
- `GET /ratings` (list_my_ratings)

- [ ] **Step 4: Clean up unused imports in template.py**

After deletions, check if `List`, `Literal`, `Field` are still needed. `List` is used in remaining endpoints. `Literal` is used in `AiSuggestionsToggleIn` and remaining schemas. `Field` is used in remaining schemas. Keep all imports.

- [ ] **Step 5: Delete frontend community hook file**

Delete the entire file `frontend/src/components/chat/hooks/useCommunityTemplates.ts`.

- [ ] **Step 6: Delete PublishTemplateForm component**

Delete the entire file `frontend/src/components/chat/PublishTemplateForm.tsx`.

- [ ] **Step 7: Remove community imports and code from TemplatesModal.tsx**

In `frontend/src/components/chat/TemplatesModal.tsx`:

Remove the community hooks import (lines 54-61):
```tsx
// DELETE:
import {
	useCommunityTemplates,
	useCopyTemplate,
	useMyCommunityStars,
	usePublishTemplate,
	useToggleStar,
	useUnpublishTemplate,
} from "./hooks/useCommunityTemplates";
```

Remove the PublishTemplateForm import (line 62):
```tsx
// DELETE:
import { PublishTemplateForm } from "./PublishTemplateForm";
```

Remove the `showCommunity` variable (lines 228-230):
```tsx
// DELETE:
// Community features disabled until Directus fields are created
// (author_display_name, use_count, star_count, copied_from)
const showCommunity = false;
```

Then search through the component for all references to `showCommunity`, community hooks (`useCommunityTemplates`, `useMyCommunityStars`, `usePublishTemplate`, `useUnpublishTemplate`, `useToggleStar`, `useCopyTemplate`), and community-related UI sections (any JSX gated by `showCommunity` or referencing community templates). Remove them all.

Also remove unused imports from `@phosphor-icons/react` that were only used by community UI (e.g., `Globe`, `ShareNetwork`, `Star`, `Copy` -- check each is not used elsewhere in the file before removing).

- [ ] **Step 8: Remove community API functions from api.ts**

In `frontend/src/lib/api.ts`, delete the following sections:

The `// -- Community Marketplace --` section (around lines 1849-1923):
```tsx
// DELETE all of:
export type CommunityTemplateResponse = { ... }
export type CommunityTemplateParams = { ... }
export const getCommunityTemplates = async (...)
export const getMyCommunityStars = async (...)
export const publishTemplate = async (...)
export const unpublishTemplate = async (...)
export const toggleTemplateStar = async (...)
export const copyTemplate = async (...)
```

The `// -- Prompt Template Ratings --` section (around lines 1925-1955):
```tsx
// DELETE all of:
export type PromptTemplateRatingResponse = { ... }
export const ratePromptTemplate = async (...)
export const deletePromptTemplateRating = async (...)
export const getMyRatings = async (...)
```

- [ ] **Step 9: Verify build**

```bash
cd frontend && pnpm build
```

Fix any remaining import errors or references to deleted code.

- [ ] **Step 10: Run server lint**

```bash
cd /workspaces/echo && ./check-code.sh
```

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: remove community marketplace code (endpoints, hooks, UI, API client)"
```

---

### Task 3: Simplify Template Quick Access to JSON

Replace the `prompt_template_preference` Directus collection with a JSON field on `directus_users`.

**Files:**
- Modify: `server/dembrane/api/template.py`
- Modify: `frontend/src/lib/api.ts`
- Modify: `frontend/src/components/chat/TemplatesModal.tsx`
- Modify: `frontend/src/components/chat/templateKey.ts`
- Delete: `frontend/src/components/chat/QuickAccessConfigurator.tsx` (if unused)

**Prerequisite:** User must create a JSON field `quick_access_preferences` on `directus_users` in Directus admin. Type: JSON, default: `[]`, nullable: true.

- [ ] **Step 1: Replace backend quick-access endpoints in template.py**

Delete the old `# -- Quick-Access Preferences --` section (lines 508-581 after community removal) and replace with:

```python
# -- Quick-Access Preferences --


class QuickAccessItemIn(BaseModel):
    type: Literal["static", "user"]
    id: str


@TemplateRouter.get("/quick-access")
async def get_quick_access(
    auth: DependencyDirectusSession,
) -> list:
    """Get the user's quick access preferences as a JSON array."""
    try:
        users = directus.get_users(
            {
                "query": {
                    "filter": {"id": {"_eq": auth.user_id}},
                    "fields": ["quick_access_preferences"],
                    "limit": 1,
                }
            }
        )
        if not isinstance(users, list) or len(users) == 0:
            return []
        prefs = users[0].get("quick_access_preferences")
        if not isinstance(prefs, list):
            return []
        return prefs
    except Exception as e:
        logger.error(f"Failed to get quick access preferences: {e}")
        raise HTTPException(status_code=500, detail="Failed to get preferences") from None


@TemplateRouter.put("/quick-access")
async def save_quick_access(
    body: List[QuickAccessItemIn],
    auth: DependencyDirectusSession,
) -> list:
    """Save the user's quick access preferences as a JSON array."""
    if len(body) > 5:
        raise HTTPException(status_code=400, detail="Maximum 5 quick access items")

    # Validate no duplicates
    seen = set()
    for item in body:
        key = (item.type, item.id)
        if key in seen:
            raise HTTPException(status_code=400, detail=f"Duplicate item: {item.type}:{item.id}")
        seen.add(key)

    # Validate user templates exist and belong to user
    for item in body:
        if item.type == "user":
            try:
                template = directus.get_item("prompt_template", item.id)
                if not template or template.get("user_created") != auth.user_id:
                    raise HTTPException(status_code=400, detail=f"Template not found: {item.id}")
            except HTTPException:
                raise
            except Exception:
                raise HTTPException(status_code=400, detail=f"Template not found: {item.id}") from None

    prefs = [{"type": item.type, "id": item.id} for item in body]

    try:
        directus.update_user(auth.user_id, {"quick_access_preferences": prefs})
        return prefs
    except Exception as e:
        logger.error(f"Failed to save quick access preferences: {e}")
        raise HTTPException(status_code=500, detail="Failed to save preferences") from None
```

Also delete the old schemas that are no longer needed:
- `PromptTemplatePreferenceOut` (lines 48-53)
- `QuickAccessPreferenceIn` (lines 56-60)

- [ ] **Step 2: Update frontend API client**

In `frontend/src/lib/api.ts`, find the quick-access preference functions (around lines 1818-1836) and replace with:

```typescript
// -- Quick-Access Preferences --

export type QuickAccessPreference = {
	type: "static" | "user";
	id: string;
};

export const getQuickAccessPreferences = async (): Promise<
	QuickAccessPreference[]
> => {
	return api.get<unknown, QuickAccessPreference[]>("/templates/quick-access");
};

export const saveQuickAccessPreferences = async (
	preferences: QuickAccessPreference[],
): Promise<QuickAccessPreference[]> => {
	return api.put<unknown, QuickAccessPreference[]>(
		"/templates/quick-access",
		preferences,
	);
};
```

Also delete the old types that referenced the Directus collection shape (e.g., `QuickAccessPreferenceResponse` with `template_type`, `static_template_id`, `prompt_template_id`, `sort` fields). Search for any type that mentions `template_type` or `static_template_id` in the quick-access context.

- [ ] **Step 3: Update TemplatesModal.tsx to use new preference shape**

The modal currently converts between the old Directus shape (`template_type`, `static_template_id`, `prompt_template_id`) and the internal `QuickAccessItem` format. With the new JSON shape (`type`, `id`), the conversion becomes trivial.

Update the hook/query that fetches preferences to map the new shape. The `QuickAccessItem` type from `QuickAccessConfigurator.tsx` has:
```typescript
type QuickAccessItem = {
    type: "static" | "user";
    id: string;
    title: string;
};
```

The new API returns `{ type, id }` directly -- just add `title` by looking up the template. Update all code that previously transformed `template_type` -> `type` and `static_template_id`/`prompt_template_id` -> `id`.

Also update the save function to send the new shape directly instead of converting to the old format.

- [ ] **Step 4: Move QuickAccessItem type inline**

If `QuickAccessConfigurator.tsx` is only imported for its `QuickAccessItem` type, move the type definition into `TemplatesModal.tsx` or `templateKey.ts` and delete `QuickAccessConfigurator.tsx`.

Check first:
```bash
grep -r "QuickAccessConfigurator" frontend/src/ --include="*.tsx" --include="*.ts"
```

If only imported as a type in TemplatesModal.tsx (line 63), delete the file and inline the type.

- [ ] **Step 5: Verify build and lint**

```bash
cd /workspaces/echo && ./check-code.sh
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: simplify quick access preferences to JSON field on directus_users"
```

---

### Task 4: Anonymization Notice for Participants

Add a muted text notice in the participant recording view when the conversation is anonymized.

**Files:**
- Modify: `frontend/src/components/participant/ParticipantBody.tsx`
- Modify: `frontend/src/components/participant/ParticipantConversationAudio.tsx`
- Modify: `frontend/src/components/participant/ParticipantConversationText.tsx`
- Modify: `frontend/src/locales/en-US.po` (and all other locale files)

- [ ] **Step 1: Add isAnonymized prop to ParticipantBody**

In `frontend/src/components/participant/ParticipantBody.tsx`, add an `isAnonymized` prop:

At line 28-40 (component signature), add the prop:
```tsx
export const ParticipantBody = ({
	projectId,
	conversationId,
	viewResponses = false,
	children,
	interleaveMessages = true,
	isRecording = false,
	isAnonymized = false,
}: PropsWithChildren<{
	projectId: string;
	conversationId: string;
	viewResponses?: boolean;
	interleaveMessages?: boolean;
	isRecording?: boolean;
	isAnonymized?: boolean;
}>) => {
```

- [ ] **Step 2: Add muted anonymization notice in ParticipantBody**

After the existing `SystemMessage` for recording instructions (line 196), add a conditional notice:

```tsx
					<SystemMessage
						markdown={t`Please record your response by clicking the "Record" button below. You may also choose to respond in text by clicking the text icon.
**Please keep this screen lit up**
(black screen = not recording)`}
						className="mb-4"
					/>

					{isAnonymized && (
						<Text size="sm" c="dimmed">
							<Trans id="participant.anonymization.notice">
								Your transcription will be anonymized and your host will not be able to listen to your recording.
							</Trans>
						</Text>
					)}
```

Add `Text` to the Mantine imports at line 4 if not already imported (it's not currently in the import list -- `Title` is imported but not `Text`).

- [ ] **Step 3: Pass isAnonymized from ParticipantConversationAudio**

In `frontend/src/components/participant/ParticipantConversationAudio.tsx`, the `conversationQuery` is already available (line 76). Find where `ParticipantBody` is rendered via `ParticipantConversationAudioContent.tsx` and pass the prop.

Check the chain: `ParticipantConversationAudio` -> renders `ParticipantConversationAudioContent` -> renders `ParticipantBody`.

In `frontend/src/components/participant/ParticipantConversationAudioContent.tsx` (line 136), add the prop:
```tsx
<ParticipantBody
    projectId={projectId}
    conversationId={conversationId}
    isRecording={isRecording}
    isAnonymized={isAnonymized}
>
```

The `isAnonymized` value needs to be passed down from `ParticipantConversationAudio.tsx`. Add it to the props of `ParticipantConversationAudioContent` and derive it from:
```tsx
const isAnonymized = conversationQuery.data?.is_anonymized ?? false;
```

- [ ] **Step 4: Pass isAnonymized from ParticipantConversationText**

In `frontend/src/components/participant/ParticipantConversationText.tsx` (line 189), the component also renders `ParticipantBody`. Add the same pattern:

```tsx
const conversationQuery = useConversationQuery(projectId, conversationId);
const isAnonymized = conversationQuery.data?.is_anonymized ?? false;
```

Then pass to `ParticipantBody`:
```tsx
<ParticipantBody
    projectId={projectId}
    conversationId={conversationId}
    isAnonymized={isAnonymized}
>
```

Check if `useConversationQuery` is already imported and used in this file. If not, add the import from `./hooks`.

- [ ] **Step 5: Extract and compile translations**

```bash
cd frontend
pnpm messages:extract
```

Edit each locale file to add the translation for `participant.anonymization.notice`:

- `en-US.po`: "Your transcription will be anonymized and your host will not be able to listen to your recording."
- `nl-NL.po`: "Je transcriptie wordt geanonimiseerd en je host kan niet naar je opname luisteren."
- `de-DE.po`: "Ihre Transkription wird anonymisiert und Ihr Host kann Ihre Aufnahme nicht anhoren."
- `fr-FR.po`: "Votre transcription sera anonymisee et votre hote ne pourra pas ecouter votre enregistrement."
- `es-ES.po`: "Tu transcripcion sera anonimizada y tu anfitrion no podra escuchar tu grabacion."
- `it-IT.po`: "La tua trascrizione sara anonimizzata e il tuo host non potra ascoltare la tua registrazione."

```bash
pnpm messages:compile
```

- [ ] **Step 6: Verify build**

```bash
cd frontend && pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add anonymization notice for participants on recording page"
```

---

### Task 5: Host Confirmation Modal for Disabling Anonymization

Add a confirmation modal when the project owner toggles anonymization from ON to OFF.

**Files:**
- Modify: `frontend/src/components/project/ProjectPortalEditor.tsx`
- Modify: `frontend/src/locales/en-US.po` (and all other locale files)

- [ ] **Step 1: Add modal state and imports**

In `frontend/src/components/project/ProjectPortalEditor.tsx`, add `useDisclosure` from `@mantine/hooks` (if not already imported) and `Modal` from `@mantine/core` (if not already imported).

Add modal state near the top of the component:
```tsx
const [anonymizeModalOpened, { open: openAnonymizeModal, close: closeAnonymizeModal }] = useDisclosure(false);
```

- [ ] **Step 2: Modify the anonymize toggle onChange handler**

Replace the current simple toggle (lines 1496-1498):
```tsx
onChange={(e) =>
    field.onChange(e.currentTarget.checked)
}
```

With a handler that intercepts turning OFF:
```tsx
onChange={(e) => {
    const newValue = e.currentTarget.checked;
    if (!newValue && field.value) {
        // Turning OFF -- show confirmation
        openAnonymizeModal();
    } else {
        field.onChange(newValue);
    }
}}
```

- [ ] **Step 3: Add the confirmation modal**

Right after the `</Controller>` for anonymize_transcripts (after line 1502), add:

```tsx
<Modal
    opened={anonymizeModalOpened}
    onClose={closeAnonymizeModal}
    title={t`Turn off anonymization?`}
    centered
    size="sm"
>
    <Stack gap="md">
        <Text size="sm">
            <Trans id="portal.anonymization.disable.warning">
                Turning off anonymization while recordings are ongoing may
                have unintended consequences. Active conversations will also
                be affected mid-recording. Please use this with caution.
            </Trans>
        </Text>
        <Group justify="flex-end" gap="sm">
            <Button variant="default" onClick={closeAnonymizeModal}>
                <Trans>Cancel</Trans>
            </Button>
            <Button
                color="red"
                onClick={() => {
                    control._formValues.anonymize_transcripts = false;
                    // Use setValue from react-hook-form to properly update and mark dirty
                    setValue("anonymize_transcripts", false, { shouldDirty: true });
                    closeAnonymizeModal();
                }}
            >
                <Trans id="portal.anonymization.disable.confirm">Turn off</Trans>
            </Button>
        </Group>
    </Stack>
</Modal>
```

Note: Check how `setValue` is obtained from `useForm` in this component. It should already be destructured alongside `control` and `formState`. If not, add it to the destructuring.

- [ ] **Step 4: Extract and compile translations**

```bash
cd frontend
pnpm messages:extract
```

Add translations for `portal.anonymization.disable.warning` and `portal.anonymization.disable.confirm` in all locale files:

- `en-US.po`: (as written above)
- `nl-NL.po`: Warning: "Het uitschakelen van anonimisering terwijl opnames gaande zijn kan onbedoelde gevolgen hebben. Actieve gesprekken worden ook beinvloed tijdens de opname. Gebruik dit met voorzichtigheid." / Confirm: "Uitschakelen"
- `de-DE.po`: Warning: "Das Deaktivieren der Anonymisierung wahrend laufender Aufnahmen kann unbeabsichtigte Folgen haben. Aktive Gesprache werden auch wahrend der Aufnahme betroffen. Bitte verwenden Sie dies mit Vorsicht." / Confirm: "Ausschalten"
- `fr-FR.po`: Warning: "La desactivation de l'anonymisation pendant les enregistrements en cours peut avoir des consequences inattendues. Les conversations actives seront egalement affectees en cours d'enregistrement. Veuillez utiliser cette option avec prudence." / Confirm: "Desactiver"
- `es-ES.po`: Warning: "Desactivar la anonimizacion mientras hay grabaciones en curso puede tener consecuencias no deseadas. Las conversaciones activas tambien se veran afectadas durante la grabacion. Por favor, use esto con precaucion." / Confirm: "Desactivar"
- `it-IT.po`: Warning: "Disattivare l'anonimizzazione durante le registrazioni in corso puo avere conseguenze indesiderate. Anche le conversazioni attive saranno interessate durante la registrazione. Si prega di usare questa opzione con cautela." / Confirm: "Disattiva"

```bash
pnpm messages:compile
```

- [ ] **Step 5: Verify build**

```bash
cd frontend && pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add confirmation modal when disabling transcript anonymization"
```

---

### Task 6: Final Verification

- [ ] **Step 1: Run full check**

```bash
cd /workspaces/echo && ./check-code.sh
```

- [ ] **Step 2: Commit any remaining fixes**

If check-code.sh reveals issues, fix and commit.

- [ ] **Step 3: Tell user about Directus changes needed**

Remind user to:
1. Create `quick_access_preferences` JSON field on `directus_users` (default: `[]`, nullable: true)
2. Delete the `prompt_template_preference` collection from Directus
