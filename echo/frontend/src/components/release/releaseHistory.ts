import { t } from "@lingui/core/macro";
import type { Release } from "./releases";

/** Curated customer-facing releases. See README.md for sources and selection. */
export const getReleaseHistory = (): Release[] => [
	{
		changes: [
			{
				text: t`Report issues from the dashboard with images and voice recordings.`,
				type: "feature",
			},
			{
				text: t`Give chat responses a thumbs up or thumbs down.`,
				type: "feature",
			},
			{
				text: t`Request a plan through the needs form and book a follow-up call.`,
				type: "improvement",
			},
			{
				text: t`Set a workspace's default legal basis and override it for individual projects.`,
				type: "feature",
			},
			{
				text: t`The feedback portal explains how to report security issues.`,
				type: "improvement",
			},
			{
				text: t`Sign-in links check your access before opening an organisation or project.`,
				type: "fix",
			},
			{
				text: t`Saved appearance settings apply when the page first loads.`,
				type: "fix",
			},
		],
		publication: { date: "2026-08-31", tag: "v2.3.0" },
		summary: t`Report issues with images or voice, rate chat responses, and request a plan that fits your needs. Set a default legal basis for your workspace.`,
		title: t`Better feedback, easier follow-up`,
		version: "v2.3.0",
	},
	{
		changes: [
			{
				text: t`Tapping Record twice no longer creates duplicate conversations.`,
				type: "fix",
			},
			{
				text: t`Stopping during the microphone prompt releases the microphone so you can retry.`,
				type: "fix",
			},
			{
				text: t`Conversation dates show when recording began, rather than when the page opened.`,
				type: "fix",
			},
			{
				text: t`Updates appear in the sidebar with an unread count.`,
				type: "improvement",
			},
			{
				text: t`Announcements without an expiry date are visible again.`,
				type: "fix",
			},
			{
				text: t`Use pinned and saved question templates, including the / shortcut, from Ask.`,
				type: "improvement",
			},
			{
				text: t`Applying a template shows a confirmation with Undo.`,
				type: "improvement",
			},
			{
				text: t`Generated conversation titles contain one title instead of a list of suggestions.`,
				type: "fix",
			},
			{
				text: t`Workspace access options explain which settings need a paid plan.`,
				type: "improvement",
			},
			{
				text: t`Dutch-speaking hosts see the Dutch What's new walkthrough.`,
				type: "improvement",
			},
		],
		publication: { date: "2026-08-18", tag: "v2.2.2" },
		summary: t`Start recording without duplicate conversations, see the actual recording time, and use saved question templates from Ask. Sidebar updates now show an unread count.`,
		title: t`Smoother recording and quicker questions`,
		version: "v2.2.2",
	},
	{
		changes: [
			{
				text: t`Conversation citations appear together under one Sources heading.`,
				type: "fix",
			},
			{
				text: t`The feedback form can prefill your email address.`,
				type: "improvement",
			},
		],
		publication: { date: "2026-08-10", tag: "v2.2.1" },
		summary: t`Conversation citations now appear together under one Sources heading. The feedback form can prefill your email address.`,
		title: t`Clearer sources in chat`,
		version: "v2.2.1",
	},
	{
		changes: [
			{
				text: t`Open What's new from the sidebar and watch the organisation, workspace and project walkthrough.`,
				type: "feature",
			},
			{
				text: t`Speak a question and review the text before sending it.`,
				type: "feature",
			},
			{ text: t`Read assistant answers as they arrive.`, type: "improvement" },
			{
				text: t`Compact footnotes keep conversation sources within reach.`,
				type: "improvement",
			},
			{
				text: t`Start recording without an extra ready-to-record confirmation.`,
				type: "improvement",
			},
			{
				text: t`Recording links can prefill a title, tags and participant name.`,
				type: "improvement",
			},
			{
				text: t`Select all is available in Ask and new Specific Details chats.`,
				type: "fix",
			},
			{
				text: t`The sidebar scrolls on short screens while keeping its header and footer available.`,
				type: "fix",
			},
			{
				text: t`Open tabs recover after a new deployment instead of getting stuck on an old page.`,
				type: "fix",
			},
			{
				text: t`Chat warns before sending a message over the character limit.`,
				type: "improvement",
			},
			{
				text: t`Voice input respects the free plan's recording limit.`,
				type: "fix",
			},
		],
		highlight: true,
		note: t`Watch the walkthrough for an introduction to organisations, workspaces and projects.`,
		publication: { date: "2026-08-10", tag: "v2.2.0" },
		summary: t`Organise your work in organisations, workspaces and projects, with clearer control over who has access.`,
		title: t`Organization`,
		version: "2026-08",
		videoUrl: t`https://www.youtube.com/watch?v=XSFAF3uSvMg`,
	},
	{
		changes: [
			{
				text: t`Chats set to Czech answer in Czech instead of English.`,
				type: "fix",
			},
		],
		publication: { date: "2026-08-04", tag: "v2.1.1" },
		summary: t`Chats set to Czech now answer in Czech instead of English.`,
		title: t`Czech conversations, Czech answers`,
		version: "v2.1.1",
	},
	{
		changes: [
			{ text: t`Work with the new conversational assistant.`, type: "feature" },
			{
				text: t`Follow ongoing sessions in the live monitor.`,
				type: "feature",
			},
			{
				text: t`Conversations use the updated Dembrane-26-07 transcription pipeline.`,
				type: "improvement",
			},
		],
		highlight: true,
		publication: { date: "2026-08-03", source: "tag", tag: "v2.1.0" },
		summary: t`Work with the new conversational assistant, follow sessions in the live monitor, and use the updated transcription pipeline.`,
		title: t`A new assistant and a live monitor`,
		version: "v2.1.0",
	},
	{
		changes: [
			{
				text: t`Conversation summaries no longer hang in the affected processing cases.`,
				type: "fix",
			},
			{
				text: t`Conversations paused by free-plan limits are summarised after an upgrade.`,
				type: "fix",
			},
		],
		publication: { date: "2026-06-23", tag: "v2.0.4" },
		summary: t`Conversation summaries no longer get stuck in the affected processing cases. Conversations paused by free-plan limits are picked up after an upgrade.`,
		title: t`More reliable conversation summaries`,
		version: "v2.0.4",
	},
	{
		changes: [
			{
				text: t`Choose discoverable, invite-only or private workspaces.`,
				type: "feature",
			},
			{ text: t`Organisation members load faster.`, type: "improvement" },
			{
				text: t`Audio uploads return you to the conversation list.`,
				type: "improvement",
			},
			{
				text: t`Automatic summaries, conversation merging and durations work more reliably.`,
				type: "fix",
			},
			{ text: t`Conversation tags are easier to read.`, type: "fix" },
			{
				text: t`Free-plan limits and upgrade options are clearer.`,
				type: "improvement",
			},
		],
		publication: { date: "2026-06-23", tag: "v2.0.3" },
		summary: t`Choose discoverable, invite-only or private workspaces. Organisation members load faster, uploads return you to your conversations, and automatic summaries and merging are more reliable.`,
		title: t`Find workspaces and keep conversations moving`,
		version: "v2.0.3",
	},
	{
		changes: [
			{
				text: t`Organisation admins can join private workspaces from the members page.`,
				type: "fix",
			},
			{
				text: t`Your own member card stays at the top of the list.`,
				type: "improvement",
			},
			{
				text: t`The members page shows a loading state instead of briefly claiming there are no members.`,
				type: "fix",
			},
			{
				text: t`Access controls explain when you need to join a workspace first.`,
				type: "improvement",
			},
		],
		publication: { date: "2026-06-22", tag: "v2.0.2" },
		summary: t`Organisation admins can join private workspaces from the members page. Access controls now explain when you need to join a workspace first.`,
		title: t`Clearer workspace access for admins`,
		version: "v2.0.2",
	},
	{
		changes: [
			{
				text: t`Organise projects into workspaces within your organisation.`,
				type: "feature",
			},
			{
				text: t`Invite external collaborators and observers with their own access roles.`,
				type: "feature",
			},
			{
				text: t`Move conversations between projects and projects between workspaces in bulk.`,
				type: "feature",
			},
			{
				text: t`Manage workspace ownership, including internal and external data owners.`,
				type: "feature",
			},
			{
				text: t`The new sidebar brings organisations, workspaces, members and settings together.`,
				type: "improvement",
			},
			{
				text: t`Share invite links as an alternative to email invitations.`,
				type: "feature",
			},
			{
				text: t`Manage billing accounts, payments and workspace upgrade requests.`,
				type: "feature",
			},
			{ text: t`Use dembrane in Czech.`, type: "feature" },
			{ text: t`Search matches your words in any order.`, type: "improvement" },
			{
				text: t`Host guides are saved with the project and print with a white background.`,
				type: "improvement",
			},
			{
				text: t`Verification prompts allow 10,000 characters, and verified outcomes have a copy button.`,
				type: "improvement",
			},
			{
				text: t`Custom chat templates save and share correctly again.`,
				type: "fix",
			},
			{
				text: t`Clipboard buttons work in Safari, and your chosen interface language is remembered.`,
				type: "fix",
			},
			{
				text: t`Workspace permissions, member counts and account-specific data loading are corrected.`,
				type: "fix",
			},
		],
		highlight: true,
		publication: { date: "2026-06-22", tag: "v2.0.0" },
		summary: t`Organise work in workspaces, invite external collaborators and observers, and manage access from the new sidebar. Move conversations between projects and projects between workspaces.`,
		title: t`Organisations, workspaces and projects`,
		version: "v2.0.0",
	},
	{
		changes: [
			{
				text: t`Create and manage multiple reports in one project.`,
				type: "feature",
			},
			{
				text: t`Guide report writing with your own instructions.`,
				type: "feature",
			},
			{
				text: t`Schedule reports (beta) to include all conversations recorded before the chosen time.`,
				type: "feature",
			},
			{
				text: t`Report generation continues in the background with a visible status.`,
				type: "improvement",
			},
			{
				text: t`Create custom chat templates (beta), or duplicate and edit a built-in template.`,
				type: "feature",
			},
			{
				text: t`Pin your most-used templates directly in chat.`,
				type: "feature",
			},
			{
				text: t`Pin up to three projects to the top of your project list.`,
				type: "feature",
			},
			{
				text: t`Project cards show the project's language.`,
				type: "improvement",
			},
			{
				text: t`Edit your display name and upload, crop or remove your profile picture.`,
				type: "feature",
			},
			{
				text: t`Change your password from settings without contacting support.`,
				type: "feature",
			},
			{
				text: t`Settings are grouped into Account & Security, Appearance and Project Defaults.`,
				type: "improvement",
			},
			{
				text: t`Use Ukrainian for chat and participant replies.`,
				type: "feature",
			},
			{
				text: t`Audio uploads handle VPN connections more reliably.`,
				type: "fix",
			},
			{
				text: t`Anonymised transcripts have clearer labels.`,
				type: "improvement",
			},
		],
		highlight: true,
		publication: { date: "2026-04-14", tag: "v1.17.0" },
		summary: t`Create multiple reports per project and guide their writing with your own instructions. Scheduled reports (beta) include all conversations recorded before the scheduled time. Create, save and pin custom chat templates (beta). This release also adds project pinning, profile settings and Ukrainian chat support.`,
		title: t`Scheduled reports and custom templates`,
		version: "v1.17.0",
	},
	{
		changes: [
			{
				text: t`Transcript anonymisation and retranscription use consistent privacy settings.`,
				type: "fix",
			},
			{
				text: t`Recording duration stays accurate after pausing and resuming.`,
				type: "fix",
			},
			{
				text: t`New projects no longer add dembrane as a default transcription term.`,
				type: "fix",
			},
			{
				text: t`Recording checks the audio upload connection.`,
				type: "improvement",
			},
		],
		publication: { date: "2026-03-20", tag: "v1.16.1" },
		summary: t`Transcript anonymisation and retranscription settings now work more consistently. Recording duration stays accurate after pausing and resuming.`,
		title: t`More dependable anonymisation and recording`,
		version: "v1.16.1",
	},
	{
		changes: [
			{
				text: t`Write custom host prompts for participant verification.`,
				type: "feature",
			},
			{ text: t`Configure settings for each legal basis.`, type: "feature" },
			{
				text: t`Verification outcomes use the project's language.`,
				type: "improvement",
			},
			{
				text: t`Participants receive a reminder to verify before ending a conversation.`,
				type: "improvement",
			},
			{
				text: t`Automatic conversation titles remain visible when a name is removed.`,
				type: "fix",
			},
		],
		publication: { date: "2026-03-13", tag: "v1.16.0" },
		summary: t`Write custom verification prompts, generate outcomes in your project language, and remind participants to verify before finishing. Configure settings for each legal basis.`,
		title: t`Shape how participants verify outcomes`,
		version: "v1.16.0",
	},
	{
		changes: [
			{
				text: t`Prepare sessions with an editable host guide next to the QR code.`,
				type: "feature",
			},
			{
				text: t`Ask for participant email addresses after a conversation ends.`,
				type: "feature",
			},
			{
				text: t`Anonymise personal information in transcripts. Anonymised conversations disable audio playback and download.`,
				type: "feature",
			},
			{
				text: t`Show your own logo to participants, available on request.`,
				type: "feature",
			},
			{
				text: t`Generate conversation titles automatically, with an option to turn this off.`,
				type: "feature",
			},
			{
				text: t`Updated colours, fonts, icons and logo give dembrane a fresh look.`,
				type: "improvement",
			},
			{
				text: t`Recording and keeping devices awake work more reliably.`,
				type: "fix",
			},
		],
		highlight: true,
		publication: { date: "2026-02-19", tag: "v1.15.0" },
		summary: t`Prepare sessions with an editable host guide, collect participant emails, and anonymise transcripts. This update also introduces custom logos and automatic conversation titles.`,
		title: t`New look, new features`,
		version: "v1.15.0",
	},
	{
		changes: [
			{
				text: t`Select all conversations, or only the filtered conversations, for chat.`,
				type: "feature",
			},
			{
				text: t`Click a conversation tag to add it to your filters.`,
				type: "improvement",
			},
			{
				text: t`High-demand messages explain longer waits for responses.`,
				type: "improvement",
			},
			{
				text: t`Recording waits for audio uploads before finishing, preventing missing transcripts on affected browsers.`,
				type: "fix",
			},
		],
		publication: { date: "2026-01-30", tag: "v1.14.0" },
		summary: t`Select all or filtered conversations for chat and filter by clicking a tag. Recording uploads are more reliable, with clearer messages during high demand.`,
		title: t`Select multiple conversations`,
		version: "v1.14.0",
	},
	{
		changes: [
			{
				text: t`Use Italian for chat, reports, transcription and participant onboarding cards.`,
				type: "feature",
			},
			{
				text: t`A Help us translate link invites community translations. Full Italian interface translation is not included.`,
				type: "improvement",
			},
		],
		publication: { date: "2025-12-11", tag: "v1.13.2" },
		summary: t`Use Italian for chat, reports, transcription and participant onboarding cards. Full interface translation was not included in this release.`,
		title: t`Italian for your core workflows`,
		version: "v1.13.2",
	},
	{
		changes: [
			{ text: t`Recording devices stay awake more reliably.`, type: "fix" },
			{
				text: t`Refine shows the correct label and cannot run while another reply is being generated.`,
				type: "fix",
			},
			{
				text: t`Participant onboarding cards have clearer wording and corrected translations.`,
				type: "improvement",
			},
			{
				text: t`Specific Details chat respects manual conversation selection.`,
				type: "fix",
			},
		],
		publication: { date: "2025-12-10", tag: "v1.13.1" },
		summary: t`Recording devices stay awake more reliably. Participant onboarding, reply refinement and conversation selection in Specific Details chat receive fixes.`,
		title: t`Keep recordings awake`,
		version: "v1.13.1",
	},
	{
		changes: [
			{
				text: t`Participants can verify outcomes and refine replies.`,
				type: "feature",
			},
			{
				text: t`New chat modes and question suggestions support analysis.`,
				type: "feature",
			},
			{
				text: t`Protect sign-in with two-factor authentication.`,
				type: "feature",
			},
			{ text: t`Edit reports before publishing them.`, type: "improvement" },
			{
				text: t`Report generation, retranscription, project cloning and chat history receive reliability fixes.`,
				type: "fix",
			},
			{
				text: t`Tags update correctly for ongoing conversations.`,
				type: "fix",
			},
		],
		highlight: true,
		publication: { date: "2025-12-05", tag: "v1.13.0" },
		summary: t`Participants can verify outcomes and refine replies. New chat modes and suggestions support analysis, and two-factor authentication adds another sign-in option.`,
		title: t`Verify outcomes and refine replies`,
		version: "v1.13.0",
	},
	{
		changes: [
			{
				text: t`Automatic conversation selection leaves more room for chat answers.`,
				type: "improvement",
			},
			{
				text: t`Conversation pages and data loading are streamlined.`,
				type: "improvement",
			},
			{
				text: t`Announcements no longer create repeated notification popups.`,
				type: "fix",
			},
			{
				text: t`Transcript retrieval and conversation summaries finish before dependent work continues.`,
				type: "fix",
			},
		],
		publication: { date: "2025-11-05", tag: "v1.12.0" },
		summary: t`Conversation pages and data loading are streamlined. Automatic conversation selection leaves more room for answers, and announcements generate fewer repeated notifications.`,
		title: t`A smoother conversation workspace`,
		version: "v1.12.0",
	},
	{
		changes: [
			{
				text: t`Search tags and clear conversation filters in one click.`,
				type: "feature",
			},
			{
				text: t`Keep working while audio uploads in the background.`,
				type: "improvement",
			},
			{ text: t`See when transcription is in progress.`, type: "improvement" },
			{
				text: t`Audio playback, transcription and automatic conversation selection are improved.`,
				type: "improvement",
			},
			{
				text: t`Conversation durations and project cloning are more reliable.`,
				type: "fix",
			},
		],
		publication: { date: "2025-10-12", tag: "v1.11.0" },
		summary: t`Keep working while audio uploads, search your tags, and see transcription progress. Improved audio playback and smarter conversation selection make analysis easier.`,
		title: t`Better uploads, transcripts and discovery`,
		version: "v1.11.0",
	},
	{
		changes: [
			{
				text: t`Add a conversation directly to chat context.`,
				type: "feature",
			},
			{
				text: t`Use improved question templates and updated transcription options.`,
				type: "improvement",
			},
			{ text: t`Supporting quotes display correctly.`, type: "fix" },
			{
				text: t`Reply buttons, chat templates and the Library have corrected translations.`,
				type: "fix",
			},
		],
		publication: { date: "2025-09-19", tag: "v1.10.0" },
		summary: t`Add conversations to chat context, use improved question templates, and work with updated transcription options. Supporting quotes and translations receive fixes.`,
		title: t`More useful chat context`,
		version: "v1.10.0",
	},
	{
		changes: [
			{ text: t`Chats receive automatic titles.`, type: "feature" },
			{
				text: t`Chat context includes conversation dates and durations.`,
				type: "improvement",
			},
			{
				text: t`Jump to the latest chat message on tablet and desktop.`,
				type: "feature",
			},
			{
				text: t`Audio upload buttons and dialogs respond correctly to clicks.`,
				type: "fix",
			},
			{
				text: t`Conversation names appear in the Library and the portal's end screen works correctly.`,
				type: "fix",
			},
		],
		publication: { date: "2025-08-29", tag: "v1.9.0" },
		summary: t`Chats get automatic titles, and conversation context includes dates and durations. Jump to the latest message and use a clearer audio upload flow.`,
		title: t`Find your place in chat`,
		version: "v1.9.0",
	},
	{
		changes: [
			{ text: t`Edit reports directly in dembrane.`, type: "feature" },
			{
				text: t`The participant flow has clearer microphone checks.`,
				type: "improvement",
			},
			{
				text: t`Loading indicators and error messages give clearer feedback.`,
				type: "improvement",
			},
		],
		publication: { date: "2025-08-11", tag: "v1.8.0" },
		summary: t`Edit reports yourself, check microphones more clearly in the portal, and see better loading states and error messages.`,
		title: t`Edit reports directly`,
		version: "v1.8.0",
	},
	{
		changes: [
			{
				text: t`The Library gains clearer views of recurring themes, available on request.`,
				type: "improvement",
			},
			{ text: t`Open conversations through direct links.`, type: "feature" },
			{
				text: t`Read product announcements in the dashboard.`,
				type: "feature",
			},
			{
				text: t`Chat templates stay visible while you work.`,
				type: "improvement",
			},
			{
				text: t`Conversation status includes upload progress.`,
				type: "improvement",
			},
			{
				text: t`Report subscriptions, Library generation and live indicators receive fixes.`,
				type: "fix",
			},
		],
		highlight: true,
		publication: { date: "2025-07-25", tag: "v1.7.0" },
		summary: t`The Library gains clearer views of recurring themes. Chat templates stay within reach, conversations have direct links, and upload status is easier to follow.`,
		title: t`Explore recurring themes in the Library`,
		version: "v1.7.0",
	},
	{
		changes: [
			{
				text: t`Test and select your microphone before recording.`,
				type: "feature",
			},
			{
				text: t`See audio quality indicators for noise, silence and overlapping speech.`,
				type: "feature",
			},
			{
				text: t`Choose Summarize, Brainstorm Ideas or Custom reply modes.`,
				type: "feature",
			},
			{
				text: t`Multilingual transcription and longer conversation replies are improved.`,
				type: "improvement",
			},
			{
				text: t`Project lists show accurate conversation totals.`,
				type: "fix",
			},
		],
		publication: { date: "2025-06-06", tag: "v1.6.0" },
		summary: t`Check and select your microphone before recording, see audio quality indicators, and use improved multilingual transcription. Choose summary, brainstorming or custom reply modes.`,
		title: t`Better recordings, more ways to reply`,
		version: "v1.6.0",
	},
	{
		changes: [
			{
				text: t`Automatically select relevant conversations for your question.`,
				type: "feature",
			},
			{ text: t`Follow source citations from chat answers.`, type: "feature" },
			{ text: t`Subscribe to report notifications.`, type: "feature" },
			{
				text: t`Audio and text uploads feed into conversation analysis.`,
				type: "improvement",
			},
			{
				text: t`Empty or deleted conversations no longer break chat context.`,
				type: "fix",
			},
			{
				text: t`Chat no longer sends duplicate messages accidentally.`,
				type: "fix",
			},
			{
				text: t`Sources and references no longer appear empty in the affected cases.`,
				type: "fix",
			},
		],
		highlight: true,
		publication: { date: "2025-05-15", tag: "v1.5" },
		summary: t`Automatically select relevant conversations for chat and follow source citations. Subscribe to report notifications and work with improved audio and text uploads.`,
		title: t`Find the right conversations for your question`,
		version: "v1.5",
	},
	{
		changes: [
			{
				text: t`Audio processing and uploads are more robust.`,
				type: "improvement",
			},
			{
				text: t`The conversation list shows clearer totals.`,
				type: "improvement",
			},
		],
		publication: { date: "2025-04-14", tag: "v1.4.0" },
		summary: t`Audio processing and uploads are more robust, and the conversation list shows clearer totals.`,
		title: t`A more reliable audio upload experience`,
		version: "v1.4.0",
	},
	{
		changes: [
			{
				text: t`Run transcription again for an existing conversation.`,
				type: "feature",
			},
			{ text: t`Dutch documentation is updated.`, type: "improvement" },
		],
		publication: { date: "2025-04-02", tag: "v1.3.0" },
		summary: t`Run transcription again for an existing conversation. Dutch documentation is also updated.`,
		title: t`Transcribe a conversation again`,
		version: "v1.3.0",
	},
	{
		changes: [
			{ text: t`Download audio from conversations.`, type: "feature" },
			{ text: t`Add conversation tags from the dashboard.`, type: "feature" },
			{
				text: t`Summaries adapt to the complexity of the conversation.`,
				type: "improvement",
			},
			{
				text: t`Editing a conversation no longer triggers the affected save error.`,
				type: "fix",
			},
			{
				text: t`Portal previews and supporting images display correctly.`,
				type: "fix",
			},
		],
		publication: { date: "2025-04-01", tag: "v1.2.0" },
		summary: t`Download conversation audio, add tags from the dashboard, and use summaries that adapt to the conversation. Editing and portal preview fixes are included.`,
		title: t`Download audio and organise conversations`,
		version: "v1.2.0",
	},
	{
		changes: [
			{
				text: t`Participants can request a reply during a recording.`,
				type: "feature",
			},
			{ text: t`Read replies as they arrive.`, type: "improvement" },
			{
				text: t`Hosts can enable replies and customise their prompt in portal settings.`,
				type: "feature",
			},
		],
		highlight: true,
		publication: { date: "2025-03-27", tag: "v1.1.0" },
		summary: t`Participants can request a reply while recording and read it as it arrives. Hosts can enable replies and customise the prompt in portal settings.`,
		title: t`Get a reply during a conversation`,
		version: "v1.1.0",
	},
	{
		changes: [
			{
				text: t`The project adopts the Business Source License 1.1.`,
				type: "improvement",
			},
		],
		publication: { date: "2025-03-26", tag: "v1.0.0" },
		summary: t`The first major release establishes the project under the Business Source License 1.1.`,
		title: t`Our first major release`,
		version: "v1.0.0",
	},
];
