// biome-ignore-all lint: related to directus doesnt need linting

export type BlockButton = {
	button_group?: string | BlockButtonGroup | null;
	date_created?: string | null;
	date_updated?: string | null;
	external_url?: string | null;
	id: string;
	page?: string | Pages | null;
	post?: string | Posts | null;
	sort?: number | null;
	translations: any[] | BlockButtonTranslations[];
	type?: string | null;
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
	variant?: string | null;
};

export type BlockButtonGroup = {
	buttons: any[] | BlockButton[];
	date_created?: string | null;
	date_updated?: string | null;
	id: string;
	sort?: number | null;
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type BlockButtonTranslations = {
	block_button_id?: string | BlockButton | null;
	id: number;
	label?: string | null;
	languages_code?: string | Languages | null;
};

export type BlockColumns = {
	id: string;
	rows: any[] | BlockColumnsRows[];
	title?: string | null;
	translations: any[] | BlockColumnsTranslations[];
};

export type BlockColumnsRows = {
	block_columns?: string | BlockColumns | null;
	button_group?: string | BlockButtonGroup | null;
	date_created?: string | null;
	date_updated?: string | null;
	id: string;
	image?: string | DirectusFiles | null;
	image_position?: string | null;
	sort?: number | null;
	title?: string | null;
	translations: any[] | BlockColumnsRowsTranslations[];
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type BlockColumnsRowsTranslations = {
	block_columns_rows_id?: string | BlockColumnsRows | null;
	content?: string | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockColumnsTranslations = {
	block_columns_id?: string | BlockColumns | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockCta = {
	button_group?: string | BlockButtonGroup | null;
	id: string;
	title?: string | null;
	translations: any[] | BlockCtaTranslations[];
};

export type BlockCtaTranslations = {
	block_cta_id?: string | BlockCta | null;
	content?: string | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockDivider = {
	id: string;
	title?: string | null;
};

export type BlockFaqs = {
	id: string;
	qanda: any[] | BlockFaqsFaqs[];
	title?: string | null;
	translations: any[] | BlockFaqsTranslations[];
};

export type BlockFaqsFaqs = {
	block_faqs_id?: string | BlockFaqs | null;
	faqs_id?: string | Faqs | null;
	id: number;
};

export type BlockFaqsTranslations = {
	block_faqs_id?: string | BlockFaqs | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockForm = {
	id: string;
	title?: string | null;
	translations: any[] | BlockFormTranslations[];
};

export type BlockFormTranslations = {
	block_form_id?: string | BlockForm | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	tally_embed?: string | null;
	title?: string | null;
};

export type BlockGallery = {
	gallery_items: any[] | BlockGalleryFiles[];
	id: string;
	title?: string | null;
	translations: any[] | BlockGalleryTranslations[];
};

export type BlockGalleryFiles = {
	block_gallery_id?: string | BlockGallery | null;
	date_created?: string | null;
	date_updated?: string | null;
	directus_files_id?: string | DirectusFiles | null;
	id: string;
	sort?: number | null;
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type BlockGalleryTranslations = {
	block_gallery_id?: string | BlockGallery | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockHero = {
	button_group?: string | BlockButtonGroup | null;
	id: string;
	image?: string | DirectusFiles | null;
	image_position?: string | null;
	title?: string | null;
	translations: any[] | BlockHeroTranslations[];
};

export type BlockHeroTranslations = {
	block_hero_id?: string | BlockHero | null;
	content?: string | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockHtml = {
	id: string;
	title?: string | null;
	translations: any[] | BlockHtmlTranslations[];
};

export type BlockHtmlTranslations = {
	block_html_id?: string | BlockHtml | null;
	id: number;
	languages_code?: string | Languages | null;
	raw_html?: string | null;
};

export type BlockLogocloud = {
	id: string;
	logos: any[] | BlockLogocloudLogos[];
	title?: string | null;
	translations: any[] | BlockLogocloudTranslations[];
};

export type BlockLogocloudLogos = {
	block_logocloud_id?: string | BlockLogocloud | null;
	directus_files_id?: string | DirectusFiles | null;
	id: string;
	sort?: number | null;
};

export type BlockLogocloudTranslations = {
	block_logocloud_id?: string | BlockLogocloud | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockPartners = {
	id: string;
	title?: string | null;
	translations: any[] | BlockPartnersTranslations[];
};

export type BlockPartnersTranslations = {
	block_partners_id?: string | BlockPartners | null;
	id: number;
	languages_code?: string | Languages | null;
	subtitle?: string | null;
};

export type BlockProducts = {
	id: number;
	products: any[] | BlockProductsProducts[];
	status: string;
	title?: string | null;
	translations: any[] | BlockProductsTranslations[];
};

export type BlockProductsProducts = {
	block_products_id?: number | BlockProducts | null;
	id: number;
	products_id?: string | Products | null;
};

export type BlockProductsTranslations = {
	block_products_id?: number | BlockProducts | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
};

export type BlockQuote = {
	id: string;
	title?: string | null;
	translations: any[] | BlockQuoteTranslations[];
};

export type BlockQuoteTranslations = {
	block_quote_id?: string | BlockQuote | null;
	content?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	subtitle?: string | null;
	title?: string | null;
};

export type BlockRichtext = {
	alignment?: string | null;
	id: string;
	title?: string | null;
	translations: any[] | BlockRichtextTranslations[];
};

export type BlockRichtextTranslations = {
	block_richtext_id?: string | BlockRichtext | null;
	content?: string | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockStepItems = {
	block_steps?: string | BlockSteps | null;
	button_group?: string | BlockButtonGroup | null;
	id: string;
	image?: string | DirectusFiles | null;
	sort?: number | null;
	title?: string | null;
	translations: any[] | BlockStepItemsTranslations[];
};

export type BlockStepItemsTranslations = {
	block_step_items_id?: string | BlockStepItems | null;
	content?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockSteps = {
	alternate_image_position: boolean;
	id: string;
	show_step_numbers?: boolean | null;
	steps: any[] | BlockStepItems[];
	title?: string | null;
	translations: any[] | BlockStepsTranslations[];
};

export type BlockStepsTranslations = {
	block_steps_id?: string | BlockSteps | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockTeam = {
	id: string;
	title?: string | null;
	translations: any[] | BlockTeamTranslations[];
};

export type BlockTeamTranslations = {
	block_team_id?: string | BlockTeam | null;
	content?: string | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockTestimonialSliderItems = {
	block_testimonial_slider_id?: string | BlockTestimonials | null;
	date_created?: string | null;
	date_updated?: string | null;
	id: string;
	sort?: number | null;
	testimonials_id?: string | Testimonials | null;
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type BlockTestimonials = {
	id: string;
	testimonials: any[] | BlockTestimonialSliderItems[];
	title?: string | null;
	translations: any[] | BlockTestimonialsTranslations[];
};

export type BlockTestimonialsTranslations = {
	block_testimonials_id?: string | BlockTestimonials | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
};

export type BlockVideo = {
	id: string;
	title?: string | null;
	translations: any[] | BlockVideoTranslations[];
};

export type BlockVideoTranslations = {
	block_video_id?: string | BlockVideo | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
	type?: string | null;
	video_file?: string | DirectusFiles | null;
	video_url?: string | null;
};

export type Categories = {
	color?: string | null;
	headline?: string | null;
	id: string;
	seo?: string | Seo | null;
	slug?: string | null;
	sort?: number | null;
	title?: string | null;
	translations: any[] | CategoriesTranslations[];
};

export type CategoriesTranslations = {
	categories_id?: string | Categories | null;
	id: number;
	languages_code?: string | Languages | null;
};

export type DirectusActivity = {
	action: string;
	collection: string;
	comment?: string | null;
	id: number;
	ip?: string | null;
	item: string;
	origin?: string | null;
	revisions: any[] | DirectusRevisions[];
	timestamp: string;
	user?: string | DirectusUsers | null;
	user_agent?: string | null;
};

export type DirectusCollections = {
	accountability?: string | null;
	archive_app_filter: boolean;
	archive_field?: string | null;
	archive_value?: string | null;
	collapse: string;
	collection: string;
	color?: string | null;
	display_template?: string | null;
	group?: string | DirectusCollections | null;
	hidden: boolean;
	icon?: string | null;
	item_duplication_fields?: unknown | null;
	note?: string | null;
	preview_url?: string | null;
	singleton: boolean;
	sort?: number | null;
	sort_field?: string | null;
	translations?: unknown | null;
	unarchive_value?: string | null;
	versioning: boolean;
};

export type DirectusDashboards = {
	color?: string | null;
	date_created?: string | null;
	icon: string;
	id: string;
	name: string;
	note?: string | null;
	panels: any[] | DirectusPanels[];
	user_created?: string | DirectusUsers | null;
};

export type DirectusExtensions = {
	bundle?: string | null;
	enabled: boolean;
	folder: string;
	id: string;
	source: string;
};

export type DirectusFields = {
	collection: string | DirectusCollections;
	conditions?: unknown | null;
	display?: string | null;
	display_options?: unknown | null;
	field: string;
	group?: string | DirectusFields | null;
	hidden: boolean;
	id: number;
	interface?: string | null;
	note?: string | null;
	options?: unknown | null;
	readonly: boolean;
	required?: boolean | null;
	sort?: number | null;
	special?: unknown | null;
	translations?: unknown | null;
	validation?: unknown | null;
	validation_message?: string | null;
	width?: string | null;
};

export type DirectusFiles = {
	charset?: string | null;
	created_on: string;
	description?: string | null;
	duration?: number | null;
	embed?: string | null;
	filename_disk?: string | null;
	filename_download: string;
	filesize?: number | null;
	focal_point_x?: number | null;
	focal_point_y?: number | null;
	folder?: string | DirectusFolders | null;
	height?: number | null;
	id: string;
	location?: string | null;
	metadata?: unknown | null;
	modified_by?: string | DirectusUsers | null;
	modified_on: string;
	storage: string;
	tags?: unknown | null;
	title?: string | null;
	tus_data?: unknown | null;
	tus_id?: string | null;
	type?: string | null;
	uploaded_by?: string | DirectusUsers | null;
	uploaded_on?: string | null;
	width?: number | null;
};

export type DirectusFlows = {
	accountability?: string | null;
	color?: string | null;
	date_created?: string | null;
	description?: string | null;
	icon?: string | null;
	id: string;
	name: string;
	operation?: string | DirectusOperations | null;
	operations: any[] | DirectusOperations[];
	options?: unknown | null;
	status: string;
	trigger?: string | null;
	user_created?: string | DirectusUsers | null;
};

export type DirectusFolders = {
	id: string;
	name: string;
	parent?: string | DirectusFolders | null;
};

export type DirectusMigrations = {
	name: string;
	timestamp?: string | null;
	version: string;
};

export type DirectusNotifications = {
	collection?: string | null;
	id: number;
	item?: string | null;
	message?: string | null;
	recipient: string | DirectusUsers;
	sender?: string | DirectusUsers | null;
	status?: string | null;
	subject: string;
	timestamp?: string | null;
};

export type DirectusOperations = {
	date_created?: string | null;
	flow: string | DirectusFlows;
	id: string;
	key: string;
	name?: string | null;
	options?: unknown | null;
	position_x: number;
	position_y: number;
	reject?: string | DirectusOperations | null;
	resolve?: string | DirectusOperations | null;
	type: string;
	user_created?: string | DirectusUsers | null;
};

export type DirectusPanels = {
	color?: string | null;
	dashboard: string | DirectusDashboards;
	date_created?: string | null;
	height: number;
	icon?: string | null;
	id: string;
	name?: string | null;
	note?: string | null;
	options?: unknown | null;
	position_x: number;
	position_y: number;
	show_header: boolean;
	type: string;
	user_created?: string | DirectusUsers | null;
	width: number;
};

export type DirectusPermissions = {
	action: string;
	collection: string;
	fields?: unknown | null;
	id: number;
	permissions?: unknown | null;
	presets?: unknown | null;
	role?: string | DirectusRoles | null;
	validation?: unknown | null;
};

export type DirectusPresets = {
	bookmark?: string | null;
	collection?: string | null;
	color?: string | null;
	filter?: unknown | null;
	icon?: string | null;
	id: number;
	layout?: string | null;
	layout_options?: unknown | null;
	layout_query?: unknown | null;
	refresh_interval?: number | null;
	role?: string | DirectusRoles | null;
	search?: string | null;
	user?: string | DirectusUsers | null;
};

export type DirectusRelations = {
	id: number;
	junction_field?: string | null;
	many_collection: string;
	many_field: string;
	one_allowed_collections?: unknown | null;
	one_collection?: string | null;
	one_collection_field?: string | null;
	one_deselect_action: string;
	one_field?: string | null;
	sort_field?: string | null;
};

export type DirectusRevisions = {
	activity: number | DirectusActivity;
	collection: string;
	data?: unknown | null;
	delta?: unknown | null;
	id: number;
	item: string;
	parent?: number | DirectusRevisions | null;
	version?: string | DirectusVersions | null;
};

export type DirectusRoles = {
	admin_access: boolean;
	app_access: boolean;
	description?: string | null;
	enforce_tfa: boolean;
	icon: string;
	id: string;
	ip_access?: unknown | null;
	name: string;
	users: any[] | DirectusUsers[];
};

export type DirectusSessions = {
	expires: string;
	ip?: string | null;
	next_token?: string | null;
	origin?: string | null;
	share?: string | DirectusShares | null;
	token: string;
	user?: string | DirectusUsers | null;
	user_agent?: string | null;
};

export type DirectusSettings = {
	auth_login_attempts?: number | null;
	auth_password_policy?: string | null;
	basemaps?: unknown | null;
	custom_aspect_ratios?: unknown | null;
	custom_css?: string | null;
	default_appearance: string;
	default_language: string;
	default_theme_dark?: string | null;
	default_theme_light?: string | null;
	id: number;
	mapbox_key?: string | null;
	module_bar?: unknown | null;
	project_color: string;
	project_descriptor?: string | null;
	project_logo?: string | DirectusFiles | null;
	project_name: string;
	project_url?: string | null;
	public_background?: string | DirectusFiles | null;
	public_favicon?: string | DirectusFiles | null;
	public_foreground?: string | DirectusFiles | null;
	public_note?: string | null;
	public_registration: boolean;
	public_registration_email_filter?: unknown | null;
	public_registration_role?: string | DirectusRoles | null;
	public_registration_verify_email: boolean;
	report_bug_url?: string | null;
	report_error_url?: string | null;
	report_feature_url?: string | null;
	storage_asset_presets?: unknown | null;
	storage_asset_transform?: string | null;
	storage_default_folder?: string | DirectusFolders | null;
	theme_dark_overrides?: unknown | null;
	theme_light_overrides?: unknown | null;
	theming_group: string;
};

export type DirectusShares = {
	collection: string | DirectusCollections;
	date_created?: string | null;
	date_end?: string | null;
	date_start?: string | null;
	id: string;
	item: string;
	max_uses?: number | null;
	name?: string | null;
	password?: string | null;
	role?: string | DirectusRoles | null;
	times_used?: number | null;
	user_created?: string | DirectusUsers | null;
};

export type DirectusTranslations = {
	id: string;
	key: string;
	language: string;
	value: string;
};

export type DirectusUsers = {
	appearance?: string | null;
	auth_data?: unknown | null;
	avatar?: string | DirectusFiles | null;
	description?: string | null;
	email?: string | null;
	email_notifications?: boolean | null;
	external_identifier?: string | null;
	first_name?: string | null;
	id: string;
	language?: string | null;
	last_access?: string | null;
	last_name?: string | null;
	last_page?: string | null;
	location?: string | null;
	password?: string | null;
	provider: string;
	role?: string | DirectusRoles | null;
	status: string;
	tags?: unknown | null;
	tfa_secret?: string | null;
	theme_dark?: string | null;
	theme_dark_overrides?: unknown | null;
	theme_light?: string | null;
	theme_light_overrides?: unknown | null;
	title?: string | null;
	token?: string | null;
};

export type DirectusVersions = {
	collection: string | DirectusCollections;
	date_created?: string | null;
	date_updated?: string | null;
	hash?: string | null;
	id: string;
	item: string;
	key: string;
	name?: string | null;
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type DirectusWebhooks = {
	actions: unknown;
	collections: unknown;
	data: boolean;
	headers?: unknown | null;
	id: number;
	method: string;
	migrated_flow?: string | DirectusFlows | null;
	name: string;
	status: string;
	url: string;
	was_active_before_deprecation: boolean;
};

export type EchoPortalTutorial = {
	cards: any[] | EchoPortalTutorialEchoPortalTutorialCard[];
	date_created?: string | null;
	date_updated?: string | null;
	id: number;
	slug?: string | null;
	sort?: number | null;
	status: string;
	translations: any[] | EchoPortalTutorialTranslations[];
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type EchoPortalTutorialCard = {
	date_created?: string | null;
	date_updated?: string | null;
	icon?: string | null;
	id: number;
	link?: string | null;
	sort?: number | null;
	status: string;
	translations: any[] | EchoPortalTutorialCardTranslations[];
	user_confirmation_required?: boolean | null;
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type EchoPortalTutorialCardTranslations = {
	content?: string | null;
	section?: string | null;
	cta?: string | null;
	echo__portal_tutorial_card_id?: number | EchoPortalTutorialCard | null;
	extra_help?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	link_label?: string | null;
	title?: string | null;
	user_confirmation_label?: string | null;
};

export type EchoPortalTutorialEchoPortalTutorialCard = {
	echo__portal_tutorial_card_id?: number | EchoPortalTutorialCard | null;
	echo__portal_tutorial_id?: number | EchoPortalTutorial | null;
	id: number;
	sort?: number | null;
};

export type EchoPortalTutorialTranslations = {
	description?: string | null;
	echo__portal_tutorial_id?: number | EchoPortalTutorial | null;
	id: number;
	label?: string | null;
	languages_code?: string | Languages | null;
};

export type Faqs = {
	date_created?: string | null;
	date_updated?: string | null;
	id: string;
	sort?: number | null;
	status: string;
	title?: string | null;
	translations: any[] | FaqsTranslations[];
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type FaqsTranslations = {
	answer?: string | null;
	faqs_id?: string | Faqs | null;
	id: number;
	languages_code?: string | Languages | null;
	question?: string | null;
};

export type Globals = {
	address_country?: string | null;
	address_locality?: string | null;
	address_region?: string | null;
	build_hook_url?: string | null;
	contact: string;
	deployment: string;
	email?: string | null;
	id: string;
	main_cta?: string | BlockCta | null;
	og_image?: string | DirectusFiles | null;
	phone?: string | null;
	postal_code?: string | null;
	seo: string;
	social: string;
	social_links?: unknown | null;
	street_address?: string | null;
	title?: string | null;
	translations: any[] | GlobalsTranslations[];
	url?: string | null;
};

export type GlobalsTranslations = {
	description?: string | null;
	globals_id?: string | Globals | null;
	id: number;
	languages_code?: string | Languages | null;
	tagline?: string | null;
};

export type Languages = {
	code: string;
	direction?: string | null;
	name?: string | null;
};

export type Navigation = {
	date_created?: string | null;
	date_updated?: string | null;
	id: string;
	items: any[] | NavigationNavigationItems[];
	status: string;
	title?: string | null;
	translations: any[] | NavigationTranslations[];
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type NavigationItems = {
	children: any[] | NavigationItems[];
	display_details: string;
	has_children?: boolean | null;
	icon?: string | null;
	id: string;
	navigation: any[] | NavigationNavigationItems[];
	open_in_new_tab?: boolean | null;
	page?: string | Pages | null;
	parent?: string | NavigationItems | null;
	sort?: number | null;
	title?: string | null;
	translations: any[] | NavigationItemsTranslations[];
	type?: string | null;
	url?: string | null;
};

export type NavigationItemsTranslations = {
	id: number;
	label?: string | null;
	languages_code?: string | Languages | null;
	navigation_items_id?: string | NavigationItems | null;
};

export type NavigationNavigationItems = {
	id: number;
	navigation_id?: string | Navigation | null;
	navigation_items_id?: string | NavigationItems | null;
};

export type NavigationTranslations = {
	id: number;
	languages_code?: string | Languages | null;
	navigation_id?: string | Navigation | null;
	title?: string | null;
};

export type PageBlocks = {
	collection?: string | null;
	date_created?: string | null;
	date_updated?: string | null;
	hide_block?: boolean | null;
	id: string;
	item?: string | any | null;
	pages_id?: string | Pages | null;
	sort?: number | null;
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type Pages = {
	blocks: any[] | PageBlocks[];
	date_created?: string | null;
	date_updated?: string | null;
	id: string;
	permalink?: string | null;
	seo?: string | Seo | null;
	sort?: number | null;
	status: string;
	translations: any[] | PagesTranslations[];
	user_created?: string | null;
	user_updated?: string | null;
};

export type PagesBlog = {
	featured_post?: string | Posts | null;
	headline?: string | null;
	id: string;
	seo?: string | Seo | null;
	title?: string | null;
};

export type PagesTranslations = {
	id: number;
	languages_code?: string | Languages | null;
	pages_id?: string | Pages | null;
	title?: string | null;
};

export type Partners = {
	date_created?: string | null;
	id: string;
	link?: string | null;
	logo?: string | DirectusFiles | null;
	name?: string | null;
	sort?: number | null;
	status: string;
};

export type PortalTutorialTranslations = {
	id: number;
	label?: string | null;
	languages_code?: string | Languages | null;
};

export type PostGalleryItems = {
	directus_files_id?: string | DirectusFiles | null;
	id: string;
	posts_id?: string | Posts | null;
	sort?: number | null;
};

export type Posts = {
	author?: string | Team | null;
	category?: string | Categories | null;
	content?: string | null;
	cost?: string | null;
	date_created?: string | null;
	date_published?: string | null;
	date_updated?: string | null;
	gallery: any[] | PostGalleryItems[];
	id: string;
	image?: string | DirectusFiles | null;
	project_details: string;
	seo?: string | Seo | null;
	slug?: string | null;
	sort?: number | null;
	status: string;
	summary?: string | null;
	title?: string | null;
	type?: string | null;
	user_created?: string | null;
	user_updated?: string | null;
	video_url?: string | null;
};

export type Products = {
	blocks: any[] | ProductsBlocks[];
	cover?: string | DirectusFiles | null;
	id: string;
	name?: string | null;
	slug: string;
	sort?: number | null;
	status: string;
	translations: any[] | ProductsTranslations[];
};

export type ProductsBlocks = {
	collection?: string | null;
	id: number;
	item?: string | any | null;
	products_id?: string | Products | null;
};

export type ProductsTranslations = {
	description?: string | null;
	headline?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	products_id?: string | Products | null;
	type?: string | null;
};

export type Redirects = {
	date_created?: string | null;
	date_updated?: string | null;
	id: string;
	response_code?: number | null;
	url_new?: string | null;
	url_old?: string | null;
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type Seo = {
	canonical_url?: string | null;
	id: string;
	no_follow?: boolean | null;
	no_index?: boolean | null;
	sitemap_change_frequency?: string | null;
	sitemap_priority?: number | null;
	title?: string | null;
	translations: any[] | SeoTranslations[];
};

export type SeoTranslations = {
	id: number;
	languages_code?: string | Languages | null;
	meta_description?: string | null;
	seo_id?: string | Seo | null;
};

export type Team = {
	bio?: string | null;
	date_created?: string | null;
	date_updated?: string | null;
	id: string;
	image?: string | DirectusFiles | null;
	job_title?: string | null;
	name?: string | null;
	posts: any[] | Posts[];
	social_media?: unknown | null;
	sort?: number | null;
	status: string;
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type Testimonials = {
	company?: string | null;
	company_info: string;
	company_logo?: string | DirectusFiles | null;
	date_created?: string | null;
	date_updated?: string | null;
	id: string;
	image?: string | DirectusFiles | null;
	link?: string | null;
	sort?: number | null;
	status: string;
	title?: string | null;
	translations: any[] | TestimonialsTranslations[];
	user_created?: string | DirectusUsers | null;
	user_updated?: string | DirectusUsers | null;
};

export type TestimonialsTranslations = {
	content?: string | null;
	id: number;
	languages_code?: string | Languages | null;
	subtitle?: string | null;
	testimonials_id?: string | Testimonials | null;
};

export type Announcement = {
	id: string;
	user_created?: string | DirectusUsers | null;
	created_at?: Date | null | undefined;
	expires_at?: Date | null | undefined;
	level?: string | null;
	translations: any[] | AnnouncementTranslations[];
	activity: any[] | AnnouncementActivity[];
};

export type AnnouncementTranslations = {
	id: number;
	languages_code?: string | Languages | null;
	title?: string | null;
	message?: string | null;
};

export type AnnouncementActivity = {
	id: string;
	user_created?: string | DirectusUsers | null;
	created_at?: string | null;
	user_id?: string | null;
	announcement_activity?: string | Announcement | null;
	read: boolean | null;
};

export type CustomDirectusTypes = {
	block_button: BlockButton;
	block_button_group: BlockButtonGroup;
	block_button_translations: BlockButtonTranslations;
	block_columns: BlockColumns;
	block_columns_rows: BlockColumnsRows;
	block_columns_rows_translations: BlockColumnsRowsTranslations;
	block_columns_translations: BlockColumnsTranslations;
	block_cta: BlockCta;
	block_cta_translations: BlockCtaTranslations;
	block_divider: BlockDivider;
	block_faqs: BlockFaqs;
	block_faqs_faqs: BlockFaqsFaqs;
	block_faqs_translations: BlockFaqsTranslations;
	block_form: BlockForm;
	block_form_translations: BlockFormTranslations;
	block_gallery: BlockGallery;
	block_gallery_files: BlockGalleryFiles;
	block_gallery_translations: BlockGalleryTranslations;
	block_hero: BlockHero;
	block_hero_translations: BlockHeroTranslations;
	block_html: BlockHtml;
	block_html_translations: BlockHtmlTranslations;
	block_logocloud: BlockLogocloud;
	block_logocloud_logos: BlockLogocloudLogos;
	block_logocloud_translations: BlockLogocloudTranslations;
	block_partners: BlockPartners;
	block_partners_translations: BlockPartnersTranslations;
	block_products: BlockProducts;
	block_products_products: BlockProductsProducts;
	block_products_translations: BlockProductsTranslations;
	block_quote: BlockQuote;
	block_quote_translations: BlockQuoteTranslations;
	block_richtext: BlockRichtext;
	block_richtext_translations: BlockRichtextTranslations;
	block_step_items: BlockStepItems;
	block_step_items_translations: BlockStepItemsTranslations;
	block_steps: BlockSteps;
	block_steps_translations: BlockStepsTranslations;
	block_team: BlockTeam;
	block_team_translations: BlockTeamTranslations;
	block_testimonial_slider_items: BlockTestimonialSliderItems;
	block_testimonials: BlockTestimonials;
	block_testimonials_translations: BlockTestimonialsTranslations;
	block_video: BlockVideo;
	block_video_translations: BlockVideoTranslations;
	categories: Categories;
	categories_translations: CategoriesTranslations;
	directus_activity: DirectusActivity;
	directus_collections: DirectusCollections;
	directus_dashboards: DirectusDashboards;
	directus_extensions: DirectusExtensions;
	directus_fields: DirectusFields;
	directus_files: DirectusFiles;
	directus_flows: DirectusFlows;
	directus_folders: DirectusFolders;
	directus_migrations: DirectusMigrations;
	directus_notifications: DirectusNotifications;
	directus_operations: DirectusOperations;
	directus_panels: DirectusPanels;
	directus_permissions: DirectusPermissions;
	directus_presets: DirectusPresets;
	directus_relations: DirectusRelations;
	directus_revisions: DirectusRevisions;
	directus_roles: DirectusRoles;
	directus_sessions: DirectusSessions;
	directus_settings: DirectusSettings;
	directus_shares: DirectusShares;
	directus_translations: DirectusTranslations;
	directus_users: DirectusUsers;
	directus_versions: DirectusVersions;
	directus_webhooks: DirectusWebhooks;
	echo__portal_tutorial: EchoPortalTutorial[];
	echo__portal_tutorial_card: EchoPortalTutorialCard[];
	echo__portal_tutorial_card_translations: EchoPortalTutorialCardTranslations[];
	echo__portal_tutorial_echo__portal_tutorial_card: EchoPortalTutorialEchoPortalTutorialCard[];
	echo__portal_tutorial_translations: EchoPortalTutorialTranslations[];
	faqs: Faqs;
	faqs_translations: FaqsTranslations;
	globals: Globals;
	globals_translations: GlobalsTranslations;
	languages: Languages;
	navigation: Navigation;
	navigation_items: NavigationItems;
	navigation_items_translations: NavigationItemsTranslations;
	navigation_navigation_items: NavigationNavigationItems;
	navigation_translations: NavigationTranslations;
	page_blocks: PageBlocks;
	pages: Pages;
	pages_blog: PagesBlog;
	pages_translations: PagesTranslations;
	partners: Partners;
	portal_tutorial_translations: PortalTutorialTranslations;
	post_gallery_items: PostGalleryItems;
	posts: Posts;
	products: Products;
	products_blocks: ProductsBlocks;
	products_translations: ProductsTranslations;
	redirects: Redirects;
	seo: Seo;
	seo_translations: SeoTranslations;
	team: Team;
	testimonials: Testimonials;
	testimonials_translations: TestimonialsTranslations;
	announcement: Announcement;
	announcement_translations: AnnouncementTranslations;
	announcement_activity: AnnouncementActivity;
};
