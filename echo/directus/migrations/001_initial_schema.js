export async function up(knex) {
  if (!(await knex.schema.hasTable('languages'))) {
    await knex.schema.createTable('languages', (table) => {
      table.string('code', 255).notNullable().primary();
      table.string('direction', 255).defaultTo('ltr');
      table.string('name', 255);
    });
  }

  if (!(await knex.schema.hasTable('directus_sync_id_map'))) {
    await knex.schema.createTable('directus_sync_id_map', (table) => {
      table.increments('id');
      table.string('table', 255).notNullable();
      table.string('sync_id', 255).notNullable();
      table.string('local_id', 255).notNullable();
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.unique(['table', 'local_id'], 'directus_sync_id_map_table_local_id_unique');
      table.unique(['table', 'sync_id'], 'directus_sync_id_map_table_sync_id_unique');
      table.index(['created_at'], 'directus_sync_id_map_created_at_index');
    });
  }
  if (!(await knex.schema.hasTable('announcement'))) {
    await knex.schema.createTable('announcement', (table) => {
      table.uuid('id').notNullable().primary();
      table.string('level', 255);
      table.integer('sort');
      table.timestamp('created_at', { useTz: true });
      table.timestamp('updated_at', { useTz: true });
      table.timestamp('expires_at', { useTz: false });
      table.uuid('user_created');
      table.uuid('user_updated');
      table.foreign('user_created').references('id').inTable('directus_users');
      table.foreign('user_updated').references('id').inTable('directus_users');
    });
  }
  if (!(await knex.schema.hasTable('announcement_translations'))) {
    await knex.schema.createTable('announcement_translations', (table) => {
      table.uuid('announcement_id');
      table.increments('id');
      table.string('languages_code', 255);
      table.text('message');
      table.text('title');
      table.foreign('announcement_id').references('id').inTable('announcement').onDelete('SET NULL');
      table.foreign('languages_code').references('code').inTable('languages').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('announcement_activity'))) {
    await knex.schema.createTable('announcement_activity', (table) => {
      table.uuid('announcement_activity');
      table.timestamp('created_at', { useTz: true });
      table.uuid('id').notNullable().primary();
      table.boolean('read').defaultTo(false);
      table.integer('sort');
      table.timestamp('updated_at', { useTz: true });
      table.uuid('user_created');
      table.uuid('user_id');
      table.uuid('user_updated');
      table.foreign('announcement_activity').references('id').inTable('announcement').onDelete('SET NULL');
      table.foreign('user_created').references('id').inTable('directus_users');
      table.foreign('user_updated').references('id').inTable('directus_users');
    });
  }
  if (!(await knex.schema.hasTable('project'))) {
    await knex.schema.createTable('project', (table) => {
      table.text('context');
      table.string('conversation_ask_for_participant_name_label', 255);
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.boolean('default_conversation_ask_for_participant_name').defaultTo(true);
      table.text('default_conversation_description');
      table.text('default_conversation_finish_text');
      table.string('default_conversation_title', 255);
      table.text('default_conversation_transcript_prompt');
      table.string('default_conversation_tutorial_slug', 255).defaultTo('none');
      table.uuid('directus_user_id');
      table.text('get_reply_prompt');
      table.uuid('id').notNullable().primary();
      table.string('image_generation_model', 255).defaultTo('PLACEHOLDER');
      table.boolean('is_conversation_allowed').notNullable();
      table.boolean('is_enhanced_audio_processing_enabled').defaultTo(false);
      table.boolean('is_get_reply_enabled').defaultTo(false);
      table.boolean('is_project_notification_subscription_allowed').defaultTo(false);
      table.string('language', 255);
      table.string('name', 255);
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      table.string('get_reply_mode', 255).defaultTo('summarize');
      table.foreign('directus_user_id').references('id').inTable('directus_users').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('project_tag'))) {
    await knex.schema.createTable('project_tag', (table) => {
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.uuid('id').notNullable().primary();
      table.uuid('project_id').notNullable();
      table.integer('sort');
      table.string('text', 255);
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      table.foreign('project_id').references('id').inTable('project').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('project_analysis_run'))) {
    await knex.schema.createTable('project_analysis_run', (table) => {
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.uuid('id').notNullable().primary();
      table.uuid('project_id');
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      table.foreign('project_id').references('id').inTable('project').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('view'))) {
    await knex.schema.createTable('view', (table) => {
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.uuid('id').notNullable().primary();
      table.string('name', 255);
      table.uuid('project_analysis_run_id');
      table.text('summary');
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      table.text('description');
      table.string('language', 255);
      table.text('user_input');
      table.text('user_input_description');
      table.foreign('project_analysis_run_id').references('id').inTable('project_analysis_run').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('aspect'))) {
    await knex.schema.createTable('aspect', (table) => {
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.text('description');
      table.uuid('id').notNullable().primary();
      table.string('image_url', 255);
      table.text('long_summary');
      table.string('name', 255);
      table.text('short_summary');
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      table.uuid('view_id');
      table.foreign('view_id').references('id').inTable('view').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('conversation'))) {
    await knex.schema.createTable('conversation', (table) => {
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.specificType('duration', 'real');
      table.uuid('id').notNullable().primary();
      table.boolean('is_audio_processing_finished').defaultTo(false);
      table.boolean('is_finished').defaultTo(false);
      table.text('merged_audio_path');
      table.text('merged_transcript');
      table.string('participant_email', 255);
      table.string('participant_name', 255);
      table.string('participant_user_agent', 255);
      table.uuid('project_id').notNullable();
      table.string('source', 255);
      table.text('summary');
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      table.boolean('is_all_chunks_transcribed');
      table.foreign('project_id').references('id').inTable('project').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('conversation_chunk'))) {
    await knex.schema.createTable('conversation_chunk', (table) => {
      table.uuid('conversation_id').notNullable();
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.uuid('id').notNullable().primary();
      table.string('path', 255);
      table.string('source', 255);
      table.timestamp('timestamp', { useTz: true }).notNullable();
      table.text('transcript');
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      table.text('runpod_job_status_link');
      table.integer('runpod_request_count').defaultTo(0);
      table.integer('cross_talk_instances').defaultTo(0);
      table.json('diarization');
      table.specificType('noise_ratio', 'real').defaultTo(0.0);
      table.specificType('silence_ratio', 'real').defaultTo(0.0);
      table.text('error');
      table.text('hallucination_reason');
      table.specificType('hallucination_score', 'real');
      table.string('desired_language', 255);
      table.string('detected_language', 255);
      table.specificType('detected_language_confidence', 'real');
      table.text('raw_transcript');
      table.string('translation_error', 255);
      table.foreign('conversation_id').references('id').inTable('conversation').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('conversation_segment'))) {
    await knex.schema.createTable('conversation_segment', (table) => {
      table.string('config_id', 255);
      table.text('contextual_transcript');
      table.uuid('conversation_id');
      table.specificType('counter', 'real');
      table.increments('id');
      table.boolean('lightrag_flag').defaultTo(false);
      table.text('path');
      table.text('transcript');
      table.foreign('conversation_id').references('id').inTable('conversation').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('conversation_segment_conversation_chunk'))) {
    await knex.schema.createTable('conversation_segment_conversation_chunk', (table) => {
      table.uuid('conversation_chunk_id');
      table.integer('conversation_segment_id');
      table.increments('id');
      table.foreign('conversation_chunk_id').references('id').inTable('conversation_chunk').onDelete('CASCADE');
      table.foreign('conversation_segment_id').references('id').inTable('conversation_segment').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('aspect_segment'))) {
    await knex.schema.createTable('aspect_segment', (table) => {
      table.text('description');
      table.uuid('id').notNullable().primary();
      table.text('relevant_index');
      table.integer('segment');
      table.text('verbatim_transcript');
      table.uuid('aspect');
      table.foreign('aspect').references('id').inTable('aspect').onDelete('CASCADE');
      table.foreign('segment').references('id').inTable('conversation_segment').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('conversation_link'))) {
    await knex.schema.createTable('conversation_link', (table) => {
      table.bigIncrements('id');
      table.timestamp('date_created', { useTz: true });
      table.timestamp('date_updated', { useTz: true });
      table.uuid('source_conversation_id');
      table.uuid('target_conversation_id');
      table.string('link_type', 255);
      table.foreign('source_conversation_id').references('id').inTable('conversation').onDelete('SET NULL');
      table.foreign('target_conversation_id').references('id').inTable('conversation').onDelete('SET NULL');
      table.index(['source_conversation_id'], 'conversation_link_source_conversation_id_index');
      table.index(['target_conversation_id'], 'conversation_link_target_conversation_id_index');
    });
  }
  if (!(await knex.schema.hasTable('conversation_project_tag'))) {
    await knex.schema.createTable('conversation_project_tag', (table) => {
      table.uuid('conversation_id');
      table.increments('id');
      table.uuid('project_tag_id');
      table.foreign('conversation_id').references('id').inTable('conversation').onDelete('SET NULL');
      table.foreign('project_tag_id').references('id').inTable('project_tag').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('conversation_reply'))) {
    await knex.schema.createTable('conversation_reply', (table) => {
      table.text('content_text');
      table.string('conversation_id', 255);
      table.timestamp('date_created', { useTz: true });
      table.uuid('id').notNullable().primary();
      table.uuid('reply');
      table.integer('sort');
      table.string('type', 255);
      table.foreign('reply').references('id').inTable('conversation').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('insight'))) {
    await knex.schema.createTable('insight', (table) => {
      table.timestamp('created_at', { useTz: true }).defaultTo(knex.fn.now());
      table.uuid('id').notNullable().primary();
      table.uuid('project_analysis_run_id');
      table.text('summary');
      table.text('title');
      table.timestamp('updated_at', { useTz: true }).defaultTo(knex.fn.now());
      table.foreign('project_analysis_run_id').references('id').inTable('project_analysis_run').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('project_chat'))) {
    await knex.schema.createTable('project_chat', (table) => {
      table.boolean('auto_select').defaultTo(true);
      table.timestamp('date_created', { useTz: true });
      table.timestamp('date_updated', { useTz: true });
      table.uuid('id').notNullable().primary();
      table.string('name', 255);
      table.uuid('project_id');
      table.uuid('user_created');
      table.uuid('user_updated');
      table.foreign('project_id').references('id').inTable('project').onDelete('CASCADE');
      table.foreign('user_created').references('id').inTable('directus_users');
      table.foreign('user_updated').references('id').inTable('directus_users');
    });
  }
  if (!(await knex.schema.hasTable('project_chat_conversation'))) {
    await knex.schema.createTable('project_chat_conversation', (table) => {
      table.uuid('conversation_id');
      table.increments('id');
      table.uuid('project_chat_id');
      table.foreign('conversation_id').references('id').inTable('conversation').onDelete('CASCADE');
      table.foreign('project_chat_id').references('id').inTable('project_chat').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('project_chat_message'))) {
    await knex.schema.createTable('project_chat_message', (table) => {
      table.timestamp('date_created', { useTz: true });
      table.timestamp('date_updated', { useTz: true });
      table.uuid('id').notNullable().primary();
      table.string('message_from', 255);
      table.uuid('project_chat_id');
      table.string('template_key', 255);
      table.text('text');
      table.integer('tokens_count');
      table.foreign('project_chat_id').references('id').inTable('project_chat').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('project_chat_message_conversation'))) {
    await knex.schema.createTable('project_chat_message_conversation', (table) => {
      table.uuid('conversation_id');
      table.increments('id');
      table.uuid('project_chat_message_id');
      table.foreign('conversation_id').references('id').inTable('conversation').onDelete('SET NULL');
      table.foreign('project_chat_message_id').references('id').inTable('project_chat_message').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('project_chat_message_conversation_1'))) {
    await knex.schema.createTable('project_chat_message_conversation_1', (table) => {
      table.uuid('conversation_id');
      table.increments('id');
      table.uuid('project_chat_message_id');
      table.foreign('conversation_id').references('id').inTable('conversation').onDelete('SET NULL');
      table.foreign('project_chat_message_id').references('id').inTable('project_chat_message').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('project_chat_message_metadata'))) {
    await knex.schema.createTable('project_chat_message_metadata', (table) => {
      table.uuid('conversation');
      table.timestamp('date_created', { useTz: true });
      table.uuid('id').notNullable().primary();
      table.uuid('message_metadata');
      table.specificType('ratio', 'real');
      table.text('reference_text');
      table.string('type', 255);
      table.foreign('conversation').references('id').inTable('conversation').onDelete('SET NULL');
      table.foreign('message_metadata').references('id').inTable('project_chat_message').onDelete('CASCADE');
    });
  }
  if (!(await knex.schema.hasTable('processing_status'))) {
    await knex.schema.createTable('processing_status', (table) => {
      table.integer('duration_ms');
      table.string('event', 255);
      table.bigIncrements('id');
      table.text('message');
      table.timestamp('timestamp', { useTz: true });
      table.uuid('conversation_chunk_id');
      table.uuid('conversation_id');
      table.bigInteger('parent');
      table.uuid('project_id');
      table.uuid('project_analysis_run_id');
      table.foreign('conversation_chunk_id').references('id').inTable('conversation_chunk').onDelete('SET NULL');
      table.foreign('conversation_id').references('id').inTable('conversation').onDelete('SET NULL');
      table.foreign('parent').references('id').inTable('processing_status');
      table.foreign('project_analysis_run_id').references('id').inTable('project_analysis_run').onDelete('SET NULL');
      table.foreign('project_id').references('id').inTable('project').onDelete('SET NULL');
      table.index(['conversation_id'], 'processing_status_conversation_id_index');
    });
  }
  if (!(await knex.schema.hasTable('project_report'))) {
    await knex.schema.createTable('project_report', (table) => {
      table.text('content');
      table.timestamp('date_created', { useTz: true });
      table.timestamp('date_updated', { useTz: true });
      table.string('error_code', 255);
      table.bigIncrements('id');
      table.string('language', 255);
      table.uuid('project_id');
      table.boolean('show_portal_link').defaultTo(false);
      table.string('status', 255).notNullable().defaultTo('published');
      table.foreign('project_id').references('id').inTable('project').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('project_report_metric'))) {
    await knex.schema.createTable('project_report_metric', (table) => {
      table.timestamp('date_created', { useTz: true });
      table.timestamp('date_updated', { useTz: true });
      table.bigIncrements('id');
      table.string('ip', 255);
      table.bigInteger('project_report_id');
      table.string('type', 255);
      table.foreign('project_report_id').references('id').inTable('project_report').onDelete('SET NULL');
    });
  }
  if (!(await knex.schema.hasTable('project_report_notification_participants'))) {
    await knex.schema.createTable('project_report_notification_participants', (table) => {
      table.uuid('conversation_id');
      table.timestamp('date_submitted', { useTz: true });
      table.timestamp('date_updated', { useTz: true });
      table.string('email', 255);
      table.boolean('email_opt_in').defaultTo(true);
      table.uuid('email_opt_out_token');
      table.uuid('id').notNullable().primary();
      table.string('project_id', 255);
      table.integer('sort');
      table.foreign('conversation_id').references('id').inTable('conversation').onDelete('SET NULL');
    });
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('project_report_notification_participants');
  await knex.schema.dropTableIfExists('project_report_metric');
  await knex.schema.dropTableIfExists('project_report');
  await knex.schema.dropTableIfExists('processing_status');
  await knex.schema.dropTableIfExists('project_chat_message_metadata');
  await knex.schema.dropTableIfExists('project_chat_message_conversation_1');
  await knex.schema.dropTableIfExists('project_chat_message_conversation');
  await knex.schema.dropTableIfExists('project_chat_message');
  await knex.schema.dropTableIfExists('project_chat_conversation');
  await knex.schema.dropTableIfExists('project_chat');
  await knex.schema.dropTableIfExists('insight');
  await knex.schema.dropTableIfExists('conversation_reply');
  await knex.schema.dropTableIfExists('conversation_project_tag');
  await knex.schema.dropTableIfExists('conversation_link');
  await knex.schema.dropTableIfExists('aspect_segment');
  await knex.schema.dropTableIfExists('conversation_segment_conversation_chunk');
  await knex.schema.dropTableIfExists('conversation_segment');
  await knex.schema.dropTableIfExists('conversation_chunk');
  await knex.schema.dropTableIfExists('conversation');
  await knex.schema.dropTableIfExists('aspect');
  await knex.schema.dropTableIfExists('view');
  await knex.schema.dropTableIfExists('project_analysis_run');
  await knex.schema.dropTableIfExists('project_tag');
  await knex.schema.dropTableIfExists('project');
  await knex.schema.dropTableIfExists('announcement_activity');
  await knex.schema.dropTableIfExists('announcement_translations');
  await knex.schema.dropTableIfExists('announcement');
  await knex.schema.dropTableIfExists('directus_sync_id_map');
  await knex.schema.dropTableIfExists('languages');
}
