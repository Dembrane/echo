# prefilling and initial state for dembrane portal conversations

to help groups have better conversations, we want the entrance to the conversation to be as seamless and unpretentious as possible. when partners invite participants to share their voices, they often already know who those participants are. by prefilling details and bypassing onboarding screens, we can respect people's time and get them straight to recording or writing their thoughts.

this guide explains how to prefill fields and modify the initial state of the portal using URL query parameters.

---

## URL parameters

you can append the following query parameters to any portal start URL (like `https://portal.dembrane.com/en-US/:projectId/start`):

| parameter | description | example |
|---|---|---|
| `skipOnboarding` | when set to `1`, skips the introductory tutorial slides and goes directly to the conversation start screen. | `skipOnboarding=1` |
| `participant_name` or `name` | prefills the participant's name on the initiation page. if onboarding is skipped and the name is prefilled (or name is not required), the conversation will initiate *automatically*. | `participant_name=Alice` |
| `participant_email` or `email` | prefills the participant's e-mail address. this is automatically passed to the language model and database to associate the conversation with their e-mail. | `participant_email=alice@work.com` |
| `tags` or `tag_id_list` | a comma-separated list of tag IDs or tag names to apply to the conversation. names are matched *case-insensitively* against the project's tags. | `tags=Bug,Feature` |
| `general_feedback` or `feedback` | prefills the text input box for the conversation. if this parameter is present, the portal starts the participant *directly in text input mode* and presets this feedback. | `general_feedback=the+platform+is+very+easy+to+use` |
| `mode` | forces the portal to open in a specific mode. can be `text` to start in text input mode or `audio` to start in audio recording mode. | `mode=text` |

---

## skipping onboarding

by default, dembrane guides participants through a brief, friendly tutorial to introduce them to the conversation process. for recurring engagements or when participants have already been briefed, you can bypass this tutorial.

appending `skipOnboarding=1` lands the participant directly on the start screen.

---

## auto-initiation and prefilling

when you prefill the required start details and skip onboarding, dembrane goes a step further: it *automatically initiates the conversation*.

if the project requires a name and `participant_name` is present in the URL, or if the project does not require a name:
1. the portal skips the onboarding tutorial.
2. the portal automatically calls the initiation API in the background.
3. the participant is redirected *immediately* to the conversation page without having to click *Next*.

this creates a zero-click transition from your dashboard or platform into an active dembrane session.

---

## the feedback portal example

our own product feedback portal is a prime example of this feature in action. when hosts click *Feedback* inside their dashboard, we can redirect them to the portal with their name, e-mail, and context already set.

### a sample feedback link

here is what an automated feedback link looks like:

`https://portal.dembrane.com/en-US/a2b7fbeb-af8d-41c8-b70b-9ff1f3c6d51a/start?skipOnboarding=1&participant_name=Alice+Doe&participant_email=alice@work.com&general_feedback=the+platform+feels+approachable+and+grounded&tags=VALUE`

### what happens when clicked

1. the participant skips all tutorial slides.
2. dembrane automatically starts a new conversation under the name *Alice Doe* and associates it with *alice@work.com*.
3. the portal detects `general_feedback` in the URL, so it starts the conversation *directly in text input mode*.
4. the text box is prefilled with *the platform feels approachable and grounded*, ready for Alice to review, edit, or submit immediately.
5. the tag *VALUE* is automatically applied to this feedback conversation.

using these simple parameters, the feedback experience becomes incredibly direct and human.
