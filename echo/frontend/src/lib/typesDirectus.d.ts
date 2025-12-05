// biome-ignore-all lint: doesnt need interference

interface CustomDirectusTypes {
	announcement: Announcement[];
	announcement_activity: AnnouncementActivity[];
	announcement_translations: AnnouncementTranslation[];
	aspect: Aspect[];
	aspect_segment: AspectSegment[];
	conversation: Conversation[];
	conversation_artifact: ConversationArtifact[];
	conversation_chunk: ConversationChunk[];
	conversation_link: ConversationLink[];
	conversation_project_tag: ConversationProjectTag[];
	conversation_reply: ConversationReply[];
	conversation_segment: ConversationSegment[];
	conversation_segment_conversation_chunk: ConversationSegmentConversationChunk[];
	directus_sync_id_map: DirectusSyncIdMap[];
	insight: Insight[];
	languages: Language[];
	processing_status: ProcessingStatus[];
	project: Project[];
	project_analysis_run: ProjectAnalysisRun[];
	project_chat: ProjectChat[];
	project_chat_conversation: ProjectChatConversation[];
	project_chat_message: ProjectChatMessage[];
	project_chat_message_conversation: ProjectChatMessageConversation[];
	project_chat_message_conversation_1: ProjectChatMessageConversation1[];
	project_chat_message_metadata: ProjectChatMessageMetadata[];
	project_report: ProjectReport[];
	project_report_metric: ProjectReportMetric[];
	project_report_notification_participants: ProjectReportNotificationParticipant[];
	project_tag: ProjectTag[];
	verification_topic: VerificationTopic[];
	verification_topic_translations: VerificationTopicTranslation[];
	view: View[];
	directus_users: CustomDirectusUser;
}

interface Announcement {
	created_at: string | null;
	expires_at: string | null;
	id: string;
	level: "info" | "urgent" | null;
	sort: number | null;
	updated_at: string | null;
	user_created: string | DirectusUser<Schema> | null;
	user_updated: string | DirectusUser<Schema> | null;
	activity: string[] | AnnouncementActivity[];
	translations: string[] | AnnouncementTranslation[];
}

interface AnnouncementActivity {
	announcement_activity: string | Announcement | null;
	created_at: string | null;
	id: string;
	read: boolean | null;
	sort: number | null;
	updated_at: string | null;
	user_created: string | DirectusUser<Schema> | null;
	user_id: string | null;
	user_updated: string | DirectusUser<Schema> | null;
}

interface AnnouncementTranslation {
	announcement_id: string | Announcement | null;
	id: number;
	languages_code: string | Language | null;
	message: string | null;
	title: string | null;
}

interface Aspect {
	created_at: string | null;
	description: string | null;
	id: string;
	image_url: string | null;
	long_summary: string | null;
	name: string | null;
	short_summary: string | null;
	updated_at: string | null;
	view_id: string | View | null;
	aspect_segment: string[] | AspectSegment[];
}

interface AspectSegment {
	aspect: string | Aspect | null;
	description: string | null;
	id: string;
	relevant_index: string | null;
	segment: number | ConversationSegment | null;
	verbatim_transcript: string | null;
}

interface Conversation {
	created_at: string | null;
	duration: number | null;
	id: string;
	is_all_chunks_transcribed: boolean | null;
	is_audio_processing_finished: boolean | null;
	is_finished: boolean | null;
	merged_audio_path: string | null;
	merged_transcript: string | null;
	participant_email: string | null;
	participant_name: string | null;
	participant_user_agent: string | null;
	project_id: string | Project;
	source: "DASHBOARD_UPLOAD" | "CLONE" | null;
	summary: string | null;
	updated_at: string | null;
	chunks: string[] | ConversationChunk[];
	conversation_segments: string[] | ConversationSegment[];
	linked_conversations: string[] | ConversationLink[];
	linking_conversations: string[] | ConversationLink[];
	processing_status: string[] | ProcessingStatus[];
	project_chat_messages: string[] | ProjectChatMessageConversation[];
	project_chats: string[] | ProjectChatConversation[];
	replies: string[] | ConversationReply[];
	tags: string[] | ConversationProjectTag[];
	conversation_artifacts: string[] | ConversationArtifact[];
}

interface ConversationArtifact {
	id: string;
	user_created: string | DirectusUser<Schema> | null;
	date_created: string | null;
	user_updated: string | DirectusUser<Schema> | null;
	last_updated_at: string | null;
	content: string | null;
	approved_at: string | null;
	read_aloud_stream_url: string | null;
	key: string | null;
	conversation_id: string | Conversation | null;
}

interface ConversationChunk {
	conversation_id: string | Conversation;
	created_at: string | null;
	cross_talk_instances: number | null;
	desired_language: string | null;
	detected_language: string | null;
	detected_language_confidence: number | null;
	diarization: unknown | null;
	error: string | null;
	hallucination_reason: string | null;
	hallucination_score: number | null;
	id: string;
	noise_ratio: number | null;
	path: string | null;
	raw_transcript: string | null;
	runpod_job_status_link: string | null;
	runpod_request_count: number | null;
	silence_ratio: number | null;
	source: "DASHBOARD_UPLOAD" | "PORTAL_AUDIO" | "PORTAL_TEXT" | "SPLIT" | null;
	timestamp: string;
	transcript: string | null;
	translation_error: string | null;
	updated_at: string | null;
	conversation_segments: string[] | ConversationSegmentConversationChunk[];
	processing_status: string[] | ProcessingStatus[];
}

interface ConversationLink {
	date_created: string | null;
	date_updated: string | null;
	id: number;
	link_type: string | null;
	source_conversation_id: string | Conversation | null;
	target_conversation_id: string | Conversation | null;
}

interface ConversationProjectTag {
	conversation_id: string | Conversation | null;
	id: number;
	project_tag_id: string | ProjectTag | null;
}

interface ConversationReply {
	content_text: string | null;
	conversation_id: string | null;
	date_created: string | null;
	id: string;
	reply: string | Conversation | null;
	sort: number | null;
	type: string | null;
}

interface ConversationSegment {
	config_id: string | null;
	contextual_transcript: string | null;
	conversation_id: string | Conversation | null;
	counter: number | null;
	id: number;
	lightrag_flag: boolean | null;
	path: string | null;
	transcript: string | null;
	chunks: number[] | ConversationSegmentConversationChunk[];
}

interface ConversationSegmentConversationChunk {
	conversation_chunk_id: string | ConversationChunk | null;
	conversation_segment_id: number | ConversationSegment | null;
	id: number;
}

interface DirectusSyncIdMap {
	id: number;
	table: string;
	sync_id: string;
	local_id: string;
	created_at: string | null;
}

interface Insight {
	created_at: string | null;
	id: string;
	project_analysis_run_id: string | ProjectAnalysisRun | null;
	summary: string | null;
	title: string | null;
	updated_at: string | null;
}

interface Language {
	code: string;
	direction: "ltr" | "rtl" | null;
	name: string | null;
}

interface ProcessingStatus {
	conversation_chunk_id: string | ConversationChunk | null;
	conversation_id: string | Conversation | null;
	duration_ms: number | null;
	event: string | null;
	id: number;
	message: string | null;
	parent: number | ProcessingStatus | null;
	project_analysis_run_id: string | ProjectAnalysisRun | null;
	project_id: string | Project | null;
	timestamp: string | null;
}

interface Project {
	context: string | null;
	conversation_ask_for_participant_name_label: string | null;
	created_at: string | null;
	default_conversation_ask_for_participant_name: boolean | null;
	default_conversation_description: string | null;
	default_conversation_finish_text: string | null;
	default_conversation_title: string | null;
	default_conversation_transcript_prompt: string | null;
	default_conversation_tutorial_slug: "None" | "basic" | "advanced" | null;
	directus_user_id: string | DirectusUser<Schema> | null;
	get_reply_mode: "summarize" | "brainstorm" | "custom" | null;
	get_reply_prompt: string | null;
	id: string;
	image_generation_model: "MODEST" | "EXTRAVAGANT" | "PLACEHOLDER" | null;
	is_conversation_allowed: boolean;
	is_enhanced_audio_processing_enabled: boolean | null;
	is_get_reply_enabled: boolean | null;
	is_project_notification_subscription_allowed: boolean | null;
	language: "en" | "nl" | "multi" | null;
	name: string | null;
	updated_at: string | null;
	is_verify_enabled: boolean | null;
	selected_verification_key_list: string | null;
	conversations: string[] | Conversation[];
	tags: string[] | ProjectTag[];
	project_analysis_runs: string[] | ProjectAnalysisRun[];
	project_chats: string[] | ProjectChat[];
	project_reports: string[] | ProjectReport[];
	processing_status: string[] | ProcessingStatus[];
	custom_verification_topics: string[] | VerificationTopic[];
	conversations_count?: number | null;
}

interface ProjectAnalysisRun {
	created_at: string | null;
	id: string;
	project_id: string | Project | null;
	updated_at: string | null;
	insights: string[] | Insight[];
	processing_status: string[] | ProcessingStatus[];
	views: string[] | View[];
}

interface ProjectChat {
	auto_select: boolean | null;
	chat_mode: "overview" | "deep_dive" | null;
	date_created: string | null;
	date_updated: string | null;
	id: string;
	name: string | null;
	project_id: string | Project | null;
	user_created: string | DirectusUser<Schema> | null;
	user_updated: string | DirectusUser<Schema> | null;
	project_chat_messages: string[] | ProjectChatMessage[];
	used_conversations: string[] | ProjectChatConversation[];
}

interface ProjectChatConversation {
	conversation_id: string | Conversation | null;
	id: number;
	project_chat_id: string | ProjectChat | null;
}

interface ProjectChatMessage {
	date_created: string | null;
	date_updated: string | null;
	id: string;
	message_from: "User" | "assistant" | "dembrane" | null;
	project_chat_id: string | ProjectChat | null;
	template_key: string | null;
	text: string | null;
	tokens_count: number | null;
	added_conversations: string[] | ProjectChatMessageConversation1[];
	chat_message_metadata: string[] | ProjectChatMessageMetadata[];
	used_conversations: string[] | ProjectChatMessageConversation[];
}

interface ProjectChatMessageConversation {
	conversation_id: string | Conversation | null;
	id: number;
	project_chat_message_id: string | ProjectChatMessage | null;
}

interface ProjectChatMessageConversation1 {
	conversation_id: string | Conversation | null;
	id: number;
	project_chat_message_id: string | ProjectChatMessage | null;
}

interface ProjectChatMessageMetadata {
	conversation: string | Conversation | null;
	date_created: string | null;
	id: string;
	message_metadata: string | ProjectChatMessage | null;
	ratio: number | null;
	reference_text: string | null;
	type: "reference" | "citation" | null;
}

interface ProjectReport {
	content: string | null;
	date_created: string | null;
	date_updated: string | null;
	error_code: string | null;
	id: number;
	language: string | null;
	project_id: string | Project | null;
	show_portal_link: boolean | null;
	status: "error" | "archived" | "published";
}

interface ProjectReportMetric {
	date_created: string | null;
	date_updated: string | null;
	id: number;
	ip: string | null;
	project_report_id: number | ProjectReport | null;
	type: "view" | null;
}

interface ProjectReportNotificationParticipant {
	conversation_id: string | Conversation | null;
	date_submitted: string | null;
	date_updated: string | null;
	email: string | null;
	email_opt_in: boolean | null;
	email_opt_out_token: string | null;
	id: string;
	project_id: string | null;
	sort: number | null;
}

interface ProjectTag {
	created_at: string | null;
	id: string;
	project_id: string | Project;
	sort: number | null;
	text: string | null;
	updated_at: string | null;
	conversations: string[] | ConversationProjectTag[];
}

interface VerificationTopic {
	key: string;
	sort: number | null;
	user_created: string | DirectusUser<Schema> | null;
	date_created: string | null;
	user_updated: string | DirectusUser<Schema> | null;
	date_updated: string | null;
	project_id: string | Project | null;
	prompt: string | null;
	icon: string | null;
	translations: string[] | VerificationTopicTranslation[];
}

interface VerificationTopicTranslation {
	id: number;
	verification_topic_key: string | VerificationTopic | null;
	languages_code: string | Language | null;
	label: string | null;
}

interface View {
	created_at: string | null;
	description: string | null;
	id: string;
	language: string | null;
	name: string | null;
	project_analysis_run_id: string | ProjectAnalysisRun | null;
	summary: string | null;
	updated_at: string | null;
	user_input: string | null;
	user_input_description: string | null;
	aspects: string[] | Aspect[];
}

interface CustomDirectusUser {
	disable_create_project: boolean | null;
	projects: string[] | Project[];
}

// GeoJSON Types

interface GeoJSONPoint {
	type: "Point";
	coordinates: [number, number];
}

interface GeoJSONLineString {
	type: "LineString";
	coordinates: Array<[number, number]>;
}

interface GeoJSONPolygon {
	type: "Polygon";
	coordinates: Array<Array<[number, number]>>;
}

interface GeoJSONMultiPoint {
	type: "MultiPoint";
	coordinates: Array<[number, number]>;
}

interface GeoJSONMultiLineString {
	type: "MultiLineString";
	coordinates: Array<Array<[number, number]>>;
}

interface GeoJSONMultiPolygon {
	type: "MultiPolygon";
	coordinates: Array<Array<Array<[number, number]>>>;
}

interface GeoJSONGeometryCollection {
	type: "GeometryCollection";
	geometries: Array<
		| GeoJSONPoint
		| GeoJSONLineString
		| GeoJSONPolygon
		| GeoJSONMultiPoint
		| GeoJSONMultiLineString
		| GeoJSONMultiPolygon
	>;
}
