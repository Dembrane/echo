// biome-ignore-all lint: this file does not need linting
type TResource = {
	id: string;
	created_at: Date;
	updated_at: Date;
	project_id: string;
	is_processed: boolean;
	type: string;
	original_filename: string;
	title: string;
	description?: string;
	context?: string;
	processing_error?: string;
};

type TProjectTag = {
	id: string;
	created_at: Date;
	updated_at: Date;
	text: string;
};

type TConversation = {
	id: string;
	created_at: Date;
	updated_at: Date;
	project_id: string;
	title?: string;
	description?: string;
	context?: string;
	participant_email?: string;
	participant_name: string;
	tags: TProjectTag[];
	chunks?: TConversationChunk[];
};

type TProcessingStatus = "PENDING" | "PROCESSING" | "ERROR" | "DONE";

type TQuote = {
	id: string;
	created_at: Date;
	updated_at: Date;
	project_analysis_run_id: string;
	conversation_id: string;
	conversation_chunks: TConversationChunk[];
	text: string;
};

type TInsight = {
	id: string;
	created_at: Date;
	updated_at: Date;
	project_analysis_run_id: string;
	title: string;
	summary: string;
	quotes: TQuote[];
};

type TAspect = {
	id: string;
	created_at: Date;
	updated_at: Date;
	project_analysis_run_id: string;
	name: string;
	description?: string;
	short_summary?: string;
	long_summary?: string;
	image_url?: string;
	view_id?: string;
	quotes?: TQuote[];
};

type TView = {
	id: string;
	created_at: Date;
	updated_at: Date;
	project_analysis_run_id: string;
	name: string;
	summary?: string;
	aspects?: TAspect[];
};

type TConversationChunk = {
	id: string;
	created_at: Date;
	updated_at: Date;
	conversation_id: string;

	transcript?: string;
	timestamp: Date;
	error?: string | null;
};

type TProject = {
	id: string;
	created_at: Date;
	updated_at: Date;
	language: string;
	pin: string;
	name?: string;
	context?: string;
	is_conversation_allowed?: boolean;
	default_conversation_title?: string;
	default_conversation_description?: string;
	default_conversation_context?: string;
	default_conversation_finish_text?: string;
	tags: TProjectTag[];
};

type TProjectAnalysisRun = {
	id: string;
	created_at: Date;
	updated_at: Date;
	project_id: string;
	views: TView[];
	aspects: TAspect[];
	insights: TInsight[];
	quotes: TQuote[];
	processing_status?: TProcessingStatus;
	processing_error?: string;
	processing_started_at?: Date;
};

type TSession = {
	id: number;
	created_at: Date;
	updated_at: Date;
};

type TTaskState =
	| "PENDING"
	| "STARTED"
	| "PROGRESS"
	| "SUCCESS"
	| "FAILURE"
	| "RETRY"
	| "REVOKED"
	| "IGNORED";

type TTaskProgressMeta = {
	current: number;
	total: number;
	percent: number;
	message?: string;
};

type TTask =
	| {
			id: string;
			state: TTaskState;
			meta: any;
	  }
	| {
			id: string;
			state: "PROGRESS";
			meta: TTaskProgressMeta;
	  };

type TProjectChatContext = {
	conversations: Array<{
		optimisticId?: string;
		conversation_id: string;
		conversation_participant_name?: string;
		locked: boolean;
		token_usage: number; // between 0 and 1
	}>;
	messages: Array<{
		role: "user" | "assistant";
		token_usage: number; // between 0 and 1
	}>;
	conversation_id_list: string[];
	locked_conversation_id_list: string[];
	auto_select_bool: boolean;
	chat_mode: "overview" | "deep_dive" | null; // null = not yet selected
};

type ChatHistoryMessage = {
	id: string;
	role: "user" | "assistant" | "system" | "dembrane";
	content: string;
	_original: ProjectChatMessage;
	metadata: ProjectChatMessageMetadata[];
};

type ChatHistory = Array<ChatHistoryMessage>;

type TSuggestion = {
	icon: "sparkles" | "search" | "quote" | "lightbulb" | "list";
	label: string;
	prompt: string;
};

type TSuggestionsResponse = {
	suggestions: TSuggestion[];
};
