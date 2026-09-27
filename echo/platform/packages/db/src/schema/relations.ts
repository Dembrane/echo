import { relations } from "drizzle-orm/relations";
import {
  access_request,
  agent_loop,
  agent_loop_run,
  analysis_feedback,
  analysis_last_opened,
  analysis_object,
  analysis_object_revision,
  analysis_outbox,
  analysis_relation,
  analysis_request_key,
  analysis_run,
  analysis_scope,
  analysis_snapshot,
  analysis_step,
  announcement,
  announcement_activity,
  announcement_translations,
  app_user,
  aspect,
  aspect_segment,
  billing_account,
  canvas_config_revision,
  canvas_generation,
  conversation,
  conversation_artifact,
  conversation_chunk,
  conversation_link,
  conversation_project_tag,
  conversation_reply,
  conversation_segment,
  conversation_segment_conversation_chunk,
  directus_access,
  directus_activity,
  directus_collections,
  directus_comments,
  directus_dashboards,
  directus_files,
  directus_flows,
  directus_folders,
  directus_notifications,
  directus_operations,
  directus_panels,
  directus_permissions,
  directus_policies,
  directus_presets,
  directus_revisions,
  directus_roles,
  directus_sessions,
  directus_settings,
  directus_shares,
  directus_users,
  directus_versions,
  directus_webhooks,
  insight,
  languages,
  map_embedding,
  map_fact_check,
  map_result,
  methodology,
  methodology_version,
  model_response_feedback,
  notification,
  org,
  org_invite,
  org_membership,
  processing_status,
  project,
  project_agentic_run,
  project_agentic_run_event,
  project_analysis_run,
  project_chat,
  project_chat_conversation,
  project_chat_message,
  project_chat_message_conversation,
  project_chat_message_conversation_1,
  project_goal_revision,
  project_membership,
  project_report,
  project_report_metric,
  project_report_notification_participants,
  project_tag,
  project_webhook,
  prompt_template,
  recording_overage,
  referral_ledger,
  support_access_event,
  support_access_request,
  training,
  training_license,
  verification_topic,
  verification_topic_translations,
  view,
  workspace,
  workspace_invite,
  workspace_membership,
  workspace_request,
} from "./index";

export const analysis_last_openedRelations = relations(analysis_last_opened, ({ one }) => ({
  project: one(project, {
    fields: [analysis_last_opened.project_id],
    references: [project.id],
  }),
}));

export const projectRelations = relations(project, ({ one, many }) => ({
  analysis_last_openeds: many(analysis_last_opened),
  analysis_object_revisions: many(analysis_object_revision),
  analysis_objects: many(analysis_object),
  analysis_feedbacks: many(analysis_feedback),
  analysis_outboxes: many(analysis_outbox),
  agent_loops: many(agent_loop),
  analysis_runs: many(analysis_run),
  analysis_scopes: many(analysis_scope),
  analysis_snapshots: many(analysis_snapshot),
  analysis_relations: many(analysis_relation),
  analysis_steps: many(analysis_step),
  analysis_request_keys: many(analysis_request_key),
  conversations: many(conversation),
  map_embeddings: many(map_embedding),
  map_fact_checks: many(map_fact_check),
  model_response_feedbacks: many(model_response_feedback),
  notifications: many(notification),
  map_results: many(map_result),
  project_agentic_runs: many(project_agentic_run),
  project_reports: many(project_report),
  processing_statuses: many(processing_status),
  project_memberships: many(project_membership),
  project_analysis_runs: many(project_analysis_run),
  directus_user: one(directus_users, {
    fields: [project.directus_user_id],
    references: [directus_users.id],
  }),
  methodology_version: one(methodology_version, {
    fields: [project.methodology_version_id],
    references: [methodology_version.id],
  }),
  workspace: one(workspace, {
    fields: [project.workspace_id],
    references: [workspace.id],
  }),
  project_chats: many(project_chat),
  project_goal_revisions: many(project_goal_revision),
  project_tags: many(project_tag),
  project_webhooks: many(project_webhook),
  workspace_invites: many(workspace_invite),
  verification_topics: many(verification_topic),
}));

export const agent_loop_runRelations = relations(agent_loop_run, ({ one }) => ({
  canvas_generation: one(canvas_generation, {
    fields: [agent_loop_run.generation_id],
    references: [canvas_generation.id],
  }),
  agent_loop: one(agent_loop, {
    fields: [agent_loop_run.loop_id],
    references: [agent_loop.id],
  }),
}));

export const canvas_generationRelations = relations(canvas_generation, ({ one, many }) => ({
  agent_loop_runs: many(agent_loop_run),
  canvas_config_revision: one(canvas_config_revision, {
    fields: [canvas_generation.config_revision_id],
    references: [canvas_config_revision.id],
  }),
  project_report: one(project_report, {
    fields: [canvas_generation.report_id],
    references: [project_report.id],
  }),
}));

export const agent_loopRelations = relations(agent_loop, ({ one, many }) => ({
  agent_loop_runs: many(agent_loop_run),
  project: one(project, {
    fields: [agent_loop.project_id],
    references: [project.id],
  }),
  project_report: one(project_report, {
    fields: [agent_loop.report_id],
    references: [project_report.id],
  }),
}));

export const analysis_object_revisionRelations = relations(
  analysis_object_revision,
  ({ one, many }) => ({
    analysis_object: one(analysis_object, {
      fields: [analysis_object_revision.object_id],
      references: [analysis_object.id],
      relationName: "analysis_object_revision_object_id_analysis_object_id",
    }),
    analysis_object_revision: one(analysis_object_revision, {
      fields: [analysis_object_revision.parent_revision_id],
      references: [analysis_object_revision.id],
      relationName: "analysis_object_revision_parent_revision_id_analysis_object_revision_id",
    }),
    analysis_object_revisions: many(analysis_object_revision, {
      relationName: "analysis_object_revision_parent_revision_id_analysis_object_revision_id",
    }),
    project: one(project, {
      fields: [analysis_object_revision.project_id],
      references: [project.id],
    }),
    analysis_run: one(analysis_run, {
      fields: [analysis_object_revision.run_id],
      references: [analysis_run.id],
    }),
    analysis_objects: many(analysis_object, {
      relationName: "analysis_object_current_revision_id_analysis_object_revision_id",
    }),
    analysis_feedbacks: many(analysis_feedback),
    analysis_relations_from_revision_id: many(analysis_relation, {
      relationName: "analysis_relation_from_revision_id_analysis_object_revision_id",
    }),
    analysis_relations_to_revision_id: many(analysis_relation, {
      relationName: "analysis_relation_to_revision_id_analysis_object_revision_id",
    }),
  }),
);

export const analysis_objectRelations = relations(analysis_object, ({ one, many }) => ({
  analysis_object_revisions: many(analysis_object_revision, {
    relationName: "analysis_object_revision_object_id_analysis_object_id",
  }),
  analysis_object_revision: one(analysis_object_revision, {
    fields: [analysis_object.current_revision_id],
    references: [analysis_object_revision.id],
    relationName: "analysis_object_current_revision_id_analysis_object_revision_id",
  }),
  project: one(project, {
    fields: [analysis_object.project_id],
    references: [project.id],
  }),
  analysis_scope: one(analysis_scope, {
    fields: [analysis_object.scope_id],
    references: [analysis_scope.id],
  }),
  analysis_feedbacks: many(analysis_feedback),
  analysis_relations_from_object_id: many(analysis_relation, {
    relationName: "analysis_relation_from_object_id_analysis_object_id",
  }),
  analysis_relations_to_object_id: many(analysis_relation, {
    relationName: "analysis_relation_to_object_id_analysis_object_id",
  }),
}));

export const analysis_runRelations = relations(analysis_run, ({ one, many }) => ({
  analysis_object_revisions: many(analysis_object_revision),
  analysis_outboxes: many(analysis_outbox),
  project: one(project, {
    fields: [analysis_run.project_id],
    references: [project.id],
  }),
  analysis_run: one(analysis_run, {
    fields: [analysis_run.reused_run_id],
    references: [analysis_run.id],
    relationName: "analysis_run_reused_run_id_analysis_run_id",
  }),
  analysis_runs: many(analysis_run, {
    relationName: "analysis_run_reused_run_id_analysis_run_id",
  }),
  analysis_scope: one(analysis_scope, {
    fields: [analysis_run.scope_id],
    references: [analysis_scope.id],
    relationName: "analysis_run_scope_id_analysis_scope_id",
  }),
  analysis_scopes: many(analysis_scope, {
    relationName: "analysis_scope_current_run_id_analysis_run_id",
  }),
  analysis_relations: many(analysis_relation),
  analysis_steps: many(analysis_step),
  analysis_request_keys: many(analysis_request_key),
}));

export const analysis_scopeRelations = relations(analysis_scope, ({ one, many }) => ({
  analysis_objects: many(analysis_object),
  analysis_outboxes: many(analysis_outbox),
  analysis_runs: many(analysis_run, {
    relationName: "analysis_run_scope_id_analysis_scope_id",
  }),
  analysis_run: one(analysis_run, {
    fields: [analysis_scope.current_run_id],
    references: [analysis_run.id],
    relationName: "analysis_scope_current_run_id_analysis_run_id",
  }),
  analysis_snapshot: one(analysis_snapshot, {
    fields: [analysis_scope.current_snapshot_id],
    references: [analysis_snapshot.id],
    relationName: "analysis_scope_current_snapshot_id_analysis_snapshot_id",
  }),
  project: one(project, {
    fields: [analysis_scope.project_id],
    references: [project.id],
  }),
  analysis_snapshots: many(analysis_snapshot, {
    relationName: "analysis_snapshot_scope_id_analysis_scope_id",
  }),
  analysis_request_keys: many(analysis_request_key),
}));

export const analysis_feedbackRelations = relations(analysis_feedback, ({ one }) => ({
  analysis_object: one(analysis_object, {
    fields: [analysis_feedback.object_id],
    references: [analysis_object.id],
  }),
  project: one(project, {
    fields: [analysis_feedback.project_id],
    references: [project.id],
  }),
  analysis_object_revision: one(analysis_object_revision, {
    fields: [analysis_feedback.revision_id],
    references: [analysis_object_revision.id],
  }),
}));

export const analysis_outboxRelations = relations(analysis_outbox, ({ one }) => ({
  project: one(project, {
    fields: [analysis_outbox.project_id],
    references: [project.id],
  }),
  analysis_run: one(analysis_run, {
    fields: [analysis_outbox.run_id],
    references: [analysis_run.id],
  }),
  analysis_scope: one(analysis_scope, {
    fields: [analysis_outbox.scope_id],
    references: [analysis_scope.id],
  }),
  analysis_snapshot: one(analysis_snapshot, {
    fields: [analysis_outbox.snapshot_id],
    references: [analysis_snapshot.id],
  }),
}));

export const analysis_snapshotRelations = relations(analysis_snapshot, ({ one, many }) => ({
  analysis_outboxes: many(analysis_outbox),
  analysis_scopes: many(analysis_scope, {
    relationName: "analysis_scope_current_snapshot_id_analysis_snapshot_id",
  }),
  analysis_snapshot: one(analysis_snapshot, {
    fields: [analysis_snapshot.parent_snapshot_id],
    references: [analysis_snapshot.id],
    relationName: "analysis_snapshot_parent_snapshot_id_analysis_snapshot_id",
  }),
  analysis_snapshots: many(analysis_snapshot, {
    relationName: "analysis_snapshot_parent_snapshot_id_analysis_snapshot_id",
  }),
  project: one(project, {
    fields: [analysis_snapshot.project_id],
    references: [project.id],
  }),
  analysis_scope: one(analysis_scope, {
    fields: [analysis_snapshot.scope_id],
    references: [analysis_scope.id],
    relationName: "analysis_snapshot_scope_id_analysis_scope_id",
  }),
  map_results: many(map_result),
}));

export const access_requestRelations = relations(access_request, ({ one }) => ({
  app_user_actioned_by: one(app_user, {
    fields: [access_request.actioned_by],
    references: [app_user.id],
    relationName: "access_request_actioned_by_app_user_id",
  }),
  app_user_user_id: one(app_user, {
    fields: [access_request.user_id],
    references: [app_user.id],
    relationName: "access_request_user_id_app_user_id",
  }),
  workspace: one(workspace, {
    fields: [access_request.workspace_id],
    references: [workspace.id],
  }),
}));

export const app_userRelations = relations(app_user, ({ many }) => ({
  access_requests_actioned_by: many(access_request, {
    relationName: "access_request_actioned_by_app_user_id",
  }),
  access_requests_user_id: many(access_request, {
    relationName: "access_request_user_id_app_user_id",
  }),
  billing_accounts_account_manager_id: many(billing_account, {
    relationName: "billing_account_account_manager_id_app_user_id",
  }),
  billing_accounts_created_by: many(billing_account, {
    relationName: "billing_account_created_by_app_user_id",
  }),
  orgs: many(org),
  notifications_actor_user_id: many(notification, {
    relationName: "notification_actor_user_id_app_user_id",
  }),
  notifications_audience_user_id: many(notification, {
    relationName: "notification_audience_user_id_app_user_id",
  }),
  org_invites: many(org_invite),
  org_memberships: many(org_membership),
  project_memberships_granted_by: many(project_membership, {
    relationName: "project_membership_granted_by_app_user_id",
  }),
  project_memberships_user_id: many(project_membership, {
    relationName: "project_membership_user_id_app_user_id",
  }),
  support_access_events_actor_user_id: many(support_access_event, {
    relationName: "support_access_event_actor_user_id_app_user_id",
  }),
  support_access_events_staff_user_id: many(support_access_event, {
    relationName: "support_access_event_staff_user_id_app_user_id",
  }),
  support_access_requests_requested_by: many(support_access_request, {
    relationName: "support_access_request_requested_by_app_user_id",
  }),
  support_access_requests_resolved_by: many(support_access_request, {
    relationName: "support_access_request_resolved_by_app_user_id",
  }),
  training_licenses_app_user_id: many(training_license, {
    relationName: "training_license_app_user_id_app_user_id",
  }),
  training_licenses_granted_by: many(training_license, {
    relationName: "training_license_granted_by_app_user_id",
  }),
  referral_ledgers: many(referral_ledger),
  trainings: many(training),
  workspace_memberships: many(workspace_membership),
  workspace_requests_decided_by: many(workspace_request, {
    relationName: "workspace_request_decided_by_app_user_id",
  }),
  workspace_requests_requested_by: many(workspace_request, {
    relationName: "workspace_request_requested_by_app_user_id",
  }),
  workspace_invites: many(workspace_invite),
  workspaces: many(workspace),
}));

export const workspaceRelations = relations(workspace, ({ one, many }) => ({
  access_requests: many(access_request),
  billing_accounts: many(billing_account, {
    relationName: "billing_account_workspace_id_workspace_id",
  }),
  methodologies: many(methodology),
  notifications: many(notification),
  projects: many(project),
  prompt_templates: many(prompt_template),
  support_access_events: many(support_access_event),
  support_access_requests: many(support_access_request),
  referral_ledgers: many(referral_ledger),
  workspace_memberships: many(workspace_membership),
  workspace_requests_resulting_workspace_id: many(workspace_request, {
    relationName: "workspace_request_resulting_workspace_id_workspace_id",
  }),
  workspace_requests_workspace_id: many(workspace_request, {
    relationName: "workspace_request_workspace_id_workspace_id",
  }),
  workspace_invites: many(workspace_invite),
  org_billed_to_team_id: one(org, {
    fields: [workspace.billed_to_team_id],
    references: [org.id],
    relationName: "workspace_billed_to_team_id_org_id",
  }),
  workspace: one(workspace, {
    fields: [workspace.billed_to_workspace_id],
    references: [workspace.id],
    relationName: "workspace_billed_to_workspace_id_workspace_id",
  }),
  workspaces: many(workspace, {
    relationName: "workspace_billed_to_workspace_id_workspace_id",
  }),
  billing_account: one(billing_account, {
    fields: [workspace.billing_account_id],
    references: [billing_account.id],
    relationName: "workspace_billing_account_id_billing_account_id",
  }),
  app_user: one(app_user, {
    fields: [workspace.created_by],
    references: [app_user.id],
  }),
  org_effective_client_team_id: one(org, {
    fields: [workspace.effective_client_team_id],
    references: [org.id],
    relationName: "workspace_effective_client_team_id_org_id",
  }),
  org_handoff_target_team_id: one(org, {
    fields: [workspace.handoff_target_team_id],
    references: [org.id],
    relationName: "workspace_handoff_target_team_id_org_id",
  }),
  org_org_id: one(org, {
    fields: [workspace.org_id],
    references: [org.id],
    relationName: "workspace_org_id_org_id",
  }),
}));

export const project_reportRelations = relations(project_report, ({ one, many }) => ({
  agent_loops: many(agent_loop),
  canvas_generations: many(canvas_generation),
  canvas_config_revisions: many(canvas_config_revision),
  project: one(project, {
    fields: [project_report.project_id],
    references: [project.id],
  }),
  directus_user: one(directus_users, {
    fields: [project_report.user_created],
    references: [directus_users.id],
  }),
  project_report_metrics: many(project_report_metric),
}));

export const analysis_relationRelations = relations(analysis_relation, ({ one }) => ({
  analysis_object_from_object_id: one(analysis_object, {
    fields: [analysis_relation.from_object_id],
    references: [analysis_object.id],
    relationName: "analysis_relation_from_object_id_analysis_object_id",
  }),
  analysis_object_revision_from_revision_id: one(analysis_object_revision, {
    fields: [analysis_relation.from_revision_id],
    references: [analysis_object_revision.id],
    relationName: "analysis_relation_from_revision_id_analysis_object_revision_id",
  }),
  project: one(project, {
    fields: [analysis_relation.project_id],
    references: [project.id],
  }),
  analysis_run: one(analysis_run, {
    fields: [analysis_relation.run_id],
    references: [analysis_run.id],
  }),
  analysis_object_to_object_id: one(analysis_object, {
    fields: [analysis_relation.to_object_id],
    references: [analysis_object.id],
    relationName: "analysis_relation_to_object_id_analysis_object_id",
  }),
  analysis_object_revision_to_revision_id: one(analysis_object_revision, {
    fields: [analysis_relation.to_revision_id],
    references: [analysis_object_revision.id],
    relationName: "analysis_relation_to_revision_id_analysis_object_revision_id",
  }),
}));

export const analysis_stepRelations = relations(analysis_step, ({ one, many }) => ({
  project: one(project, {
    fields: [analysis_step.project_id],
    references: [project.id],
  }),
  analysis_step: one(analysis_step, {
    fields: [analysis_step.reused_step_id],
    references: [analysis_step.id],
    relationName: "analysis_step_reused_step_id_analysis_step_id",
  }),
  analysis_steps: many(analysis_step, {
    relationName: "analysis_step_reused_step_id_analysis_step_id",
  }),
  analysis_run: one(analysis_run, {
    fields: [analysis_step.run_id],
    references: [analysis_run.id],
  }),
}));

export const analysis_request_keyRelations = relations(analysis_request_key, ({ one }) => ({
  project: one(project, {
    fields: [analysis_request_key.project_id],
    references: [project.id],
  }),
  analysis_run: one(analysis_run, {
    fields: [analysis_request_key.run_id],
    references: [analysis_run.id],
  }),
  analysis_scope: one(analysis_scope, {
    fields: [analysis_request_key.scope_id],
    references: [analysis_scope.id],
  }),
}));

export const announcementRelations = relations(announcement, ({ one, many }) => ({
  directus_user_user_created: one(directus_users, {
    fields: [announcement.user_created],
    references: [directus_users.id],
    relationName: "announcement_user_created_directus_users_id",
  }),
  directus_user_user_updated: one(directus_users, {
    fields: [announcement.user_updated],
    references: [directus_users.id],
    relationName: "announcement_user_updated_directus_users_id",
  }),
  announcement_translations: many(announcement_translations),
  announcement_activities: many(announcement_activity),
}));

export const directus_usersRelations = relations(directus_users, ({ one, many }) => ({
  announcements_user_created: many(announcement, {
    relationName: "announcement_user_created_directus_users_id",
  }),
  announcements_user_updated: many(announcement, {
    relationName: "announcement_user_updated_directus_users_id",
  }),
  conversation_artifacts_user_created: many(conversation_artifact, {
    relationName: "conversation_artifact_user_created_directus_users_id",
  }),
  conversation_artifacts_user_updated: many(conversation_artifact, {
    relationName: "conversation_artifact_user_updated_directus_users_id",
  }),
  directus_comments_user_created: many(directus_comments, {
    relationName: "directus_comments_user_created_directus_users_id",
  }),
  directus_comments_user_updated: many(directus_comments, {
    relationName: "directus_comments_user_updated_directus_users_id",
  }),
  directus_dashboards: many(directus_dashboards),
  directus_accesses: many(directus_access),
  directus_notifications_recipient: many(directus_notifications, {
    relationName: "directus_notifications_recipient_directus_users_id",
  }),
  directus_notifications_sender: many(directus_notifications, {
    relationName: "directus_notifications_sender_directus_users_id",
  }),
  directus_operations: many(directus_operations),
  directus_flows: many(directus_flows),
  directus_presets: many(directus_presets),
  directus_shares: many(directus_shares),
  directus_panels: many(directus_panels),
  directus_role: one(directus_roles, {
    fields: [directus_users.role],
    references: [directus_roles.id],
  }),
  directus_file: one(directus_files, {
    fields: [directus_users.whitelabel_logo],
    references: [directus_files.id],
    relationName: "directus_users_whitelabel_logo_directus_files_id",
  }),
  model_response_feedbacks: many(model_response_feedback),
  directus_versions_user_created: many(directus_versions, {
    relationName: "directus_versions_user_created_directus_users_id",
  }),
  directus_versions_user_updated: many(directus_versions, {
    relationName: "directus_versions_user_updated_directus_users_id",
  }),
  project_reports: many(project_report),
  projects: many(project),
  project_chats_user_created: many(project_chat, {
    relationName: "project_chat_user_created_directus_users_id",
  }),
  project_chats_user_updated: many(project_chat, {
    relationName: "project_chat_user_updated_directus_users_id",
  }),
  prompt_templates: many(prompt_template),
  project_webhooks_user_created: many(project_webhook, {
    relationName: "project_webhook_user_created_directus_users_id",
  }),
  project_webhooks_user_updated: many(project_webhook, {
    relationName: "project_webhook_user_updated_directus_users_id",
  }),
  announcement_activities_user_created: many(announcement_activity, {
    relationName: "announcement_activity_user_created_directus_users_id",
  }),
  announcement_activities_user_updated: many(announcement_activity, {
    relationName: "announcement_activity_user_updated_directus_users_id",
  }),
  directus_files_modified_by: many(directus_files, {
    relationName: "directus_files_modified_by_directus_users_id",
  }),
  directus_files_uploaded_by: many(directus_files, {
    relationName: "directus_files_uploaded_by_directus_users_id",
  }),
  directus_sessions: many(directus_sessions),
  verification_topics_user_created: many(verification_topic, {
    relationName: "verification_topic_user_created_directus_users_id",
  }),
  verification_topics_user_updated: many(verification_topic, {
    relationName: "verification_topic_user_updated_directus_users_id",
  }),
}));

export const announcement_translationsRelations = relations(
  announcement_translations,
  ({ one }) => ({
    announcement: one(announcement, {
      fields: [announcement_translations.announcement_id],
      references: [announcement.id],
    }),
    language: one(languages, {
      fields: [announcement_translations.languages_code],
      references: [languages.code],
    }),
  }),
);

export const languagesRelations = relations(languages, ({ many }) => ({
  announcement_translations: many(announcement_translations),
  verification_topic_translations: many(verification_topic_translations),
}));

export const canvas_config_revisionRelations = relations(
  canvas_config_revision,
  ({ one, many }) => ({
    canvas_generations: many(canvas_generation),
    project_report: one(project_report, {
      fields: [canvas_config_revision.report_id],
      references: [project_report.id],
    }),
  }),
);

export const billing_accountRelations = relations(billing_account, ({ one, many }) => ({
  app_user_account_manager_id: one(app_user, {
    fields: [billing_account.account_manager_id],
    references: [app_user.id],
    relationName: "billing_account_account_manager_id_app_user_id",
  }),
  app_user_created_by: one(app_user, {
    fields: [billing_account.created_by],
    references: [app_user.id],
    relationName: "billing_account_created_by_app_user_id",
  }),
  org: one(org, {
    fields: [billing_account.org_id],
    references: [org.id],
  }),
  workspace: one(workspace, {
    fields: [billing_account.workspace_id],
    references: [workspace.id],
    relationName: "billing_account_workspace_id_workspace_id",
  }),
  recording_overages: many(recording_overage),
  workspaces: many(workspace, {
    relationName: "workspace_billing_account_id_billing_account_id",
  }),
}));

export const orgRelations = relations(org, ({ one, many }) => ({
  billing_accounts: many(billing_account),
  app_user: one(app_user, {
    fields: [org.created_by],
    references: [app_user.id],
  }),
  notifications: many(notification),
  org_invites: many(org_invite),
  org_memberships: many(org_membership),
  training_licenses: many(training_license),
  referral_ledgers: many(referral_ledger),
  trainings: many(training),
  workspace_requests: many(workspace_request),
  workspaces_billed_to_team_id: many(workspace, {
    relationName: "workspace_billed_to_team_id_org_id",
  }),
  workspaces_effective_client_team_id: many(workspace, {
    relationName: "workspace_effective_client_team_id_org_id",
  }),
  workspaces_handoff_target_team_id: many(workspace, {
    relationName: "workspace_handoff_target_team_id_org_id",
  }),
  workspaces_org_id: many(workspace, {
    relationName: "workspace_org_id_org_id",
  }),
}));

export const conversationRelations = relations(conversation, ({ one, many }) => ({
  project: one(project, {
    fields: [conversation.project_id],
    references: [project.id],
  }),
  conversation_artifacts: many(conversation_artifact),
  conversation_chunks: many(conversation_chunk),
  conversation_links_source_conversation_id: many(conversation_link, {
    relationName: "conversation_link_source_conversation_id_conversation_id",
  }),
  conversation_links_target_conversation_id: many(conversation_link, {
    relationName: "conversation_link_target_conversation_id_conversation_id",
  }),
  conversation_project_tags: many(conversation_project_tag),
  conversation_replies: many(conversation_reply),
  conversation_segments: many(conversation_segment),
  notifications: many(notification),
  project_chat_conversations: many(project_chat_conversation),
  project_chat_message_conversation_1s: many(project_chat_message_conversation_1),
  processing_statuses: many(processing_status),
  project_chat_message_conversations: many(project_chat_message_conversation),
  project_report_notification_participants: many(project_report_notification_participants),
}));

export const conversation_artifactRelations = relations(conversation_artifact, ({ one }) => ({
  conversation: one(conversation, {
    fields: [conversation_artifact.conversation_id],
    references: [conversation.id],
  }),
  directus_user_user_created: one(directus_users, {
    fields: [conversation_artifact.user_created],
    references: [directus_users.id],
    relationName: "conversation_artifact_user_created_directus_users_id",
  }),
  directus_user_user_updated: one(directus_users, {
    fields: [conversation_artifact.user_updated],
    references: [directus_users.id],
    relationName: "conversation_artifact_user_updated_directus_users_id",
  }),
}));

export const aspectRelations = relations(aspect, ({ one, many }) => ({
  view: one(view, {
    fields: [aspect.view_id],
    references: [view.id],
  }),
  aspect_segments: many(aspect_segment),
}));

export const viewRelations = relations(view, ({ one, many }) => ({
  aspects: many(aspect),
  project_analysis_run: one(project_analysis_run, {
    fields: [view.project_analysis_run_id],
    references: [project_analysis_run.id],
  }),
}));

export const conversation_chunkRelations = relations(conversation_chunk, ({ one, many }) => ({
  conversation: one(conversation, {
    fields: [conversation_chunk.conversation_id],
    references: [conversation.id],
  }),
  conversation_segment_conversation_chunks: many(conversation_segment_conversation_chunk),
  processing_statuses: many(processing_status),
}));

export const conversation_linkRelations = relations(conversation_link, ({ one }) => ({
  conversation_source_conversation_id: one(conversation, {
    fields: [conversation_link.source_conversation_id],
    references: [conversation.id],
    relationName: "conversation_link_source_conversation_id_conversation_id",
  }),
  conversation_target_conversation_id: one(conversation, {
    fields: [conversation_link.target_conversation_id],
    references: [conversation.id],
    relationName: "conversation_link_target_conversation_id_conversation_id",
  }),
}));

export const conversation_project_tagRelations = relations(conversation_project_tag, ({ one }) => ({
  conversation: one(conversation, {
    fields: [conversation_project_tag.conversation_id],
    references: [conversation.id],
  }),
  project_tag: one(project_tag, {
    fields: [conversation_project_tag.project_tag_id],
    references: [project_tag.id],
  }),
}));

export const project_tagRelations = relations(project_tag, ({ one, many }) => ({
  conversation_project_tags: many(conversation_project_tag),
  project: one(project, {
    fields: [project_tag.project_id],
    references: [project.id],
  }),
}));

export const conversation_replyRelations = relations(conversation_reply, ({ one }) => ({
  conversation: one(conversation, {
    fields: [conversation_reply.reply],
    references: [conversation.id],
  }),
}));

export const directus_commentsRelations = relations(directus_comments, ({ one }) => ({
  directus_user_user_created: one(directus_users, {
    fields: [directus_comments.user_created],
    references: [directus_users.id],
    relationName: "directus_comments_user_created_directus_users_id",
  }),
  directus_user_user_updated: one(directus_users, {
    fields: [directus_comments.user_updated],
    references: [directus_users.id],
    relationName: "directus_comments_user_updated_directus_users_id",
  }),
}));

export const directus_dashboardsRelations = relations(directus_dashboards, ({ one, many }) => ({
  directus_user: one(directus_users, {
    fields: [directus_dashboards.user_created],
    references: [directus_users.id],
  }),
  directus_panels: many(directus_panels),
}));

export const conversation_segmentRelations = relations(conversation_segment, ({ one, many }) => ({
  conversation: one(conversation, {
    fields: [conversation_segment.conversation_id],
    references: [conversation.id],
  }),
  conversation_segment_conversation_chunks: many(conversation_segment_conversation_chunk),
  aspect_segments: many(aspect_segment),
}));

export const conversation_segment_conversation_chunkRelations = relations(
  conversation_segment_conversation_chunk,
  ({ one }) => ({
    conversation_chunk: one(conversation_chunk, {
      fields: [conversation_segment_conversation_chunk.conversation_chunk_id],
      references: [conversation_chunk.id],
    }),
    conversation_segment: one(conversation_segment, {
      fields: [conversation_segment_conversation_chunk.conversation_segment_id],
      references: [conversation_segment.id],
    }),
  }),
);

export const directus_accessRelations = relations(directus_access, ({ one }) => ({
  directus_policy: one(directus_policies, {
    fields: [directus_access.policy],
    references: [directus_policies.id],
  }),
  directus_role: one(directus_roles, {
    fields: [directus_access.role],
    references: [directus_roles.id],
  }),
  directus_user: one(directus_users, {
    fields: [directus_access.user],
    references: [directus_users.id],
  }),
}));

export const directus_policiesRelations = relations(directus_policies, ({ many }) => ({
  directus_accesses: many(directus_access),
  directus_permissions: many(directus_permissions),
}));

export const directus_rolesRelations = relations(directus_roles, ({ one, many }) => ({
  directus_accesses: many(directus_access),
  directus_presets: many(directus_presets),
  directus_role: one(directus_roles, {
    fields: [directus_roles.parent],
    references: [directus_roles.id],
    relationName: "directus_roles_parent_directus_roles_id",
  }),
  directus_roles: many(directus_roles, {
    relationName: "directus_roles_parent_directus_roles_id",
  }),
  directus_shares: many(directus_shares),
  directus_settings: many(directus_settings),
  directus_users: many(directus_users),
}));

export const directus_collectionsRelations = relations(directus_collections, ({ one, many }) => ({
  directus_collection: one(directus_collections, {
    fields: [directus_collections.group],
    references: [directus_collections.collection],
    relationName: "directus_collections_group_directus_collections_collection",
  }),
  directus_collections: many(directus_collections, {
    relationName: "directus_collections_group_directus_collections_collection",
  }),
  directus_shares: many(directus_shares),
  directus_versions: many(directus_versions),
}));

export const directus_notificationsRelations = relations(directus_notifications, ({ one }) => ({
  directus_user_recipient: one(directus_users, {
    fields: [directus_notifications.recipient],
    references: [directus_users.id],
    relationName: "directus_notifications_recipient_directus_users_id",
  }),
  directus_user_sender: one(directus_users, {
    fields: [directus_notifications.sender],
    references: [directus_users.id],
    relationName: "directus_notifications_sender_directus_users_id",
  }),
}));

export const directus_operationsRelations = relations(directus_operations, ({ one, many }) => ({
  directus_flow: one(directus_flows, {
    fields: [directus_operations.flow],
    references: [directus_flows.id],
  }),
  directus_operation_reject: one(directus_operations, {
    fields: [directus_operations.reject],
    references: [directus_operations.id],
    relationName: "directus_operations_reject_directus_operations_id",
  }),
  directus_operations_reject: many(directus_operations, {
    relationName: "directus_operations_reject_directus_operations_id",
  }),
  directus_operation_resolve: one(directus_operations, {
    fields: [directus_operations.resolve],
    references: [directus_operations.id],
    relationName: "directus_operations_resolve_directus_operations_id",
  }),
  directus_operations_resolve: many(directus_operations, {
    relationName: "directus_operations_resolve_directus_operations_id",
  }),
  directus_user: one(directus_users, {
    fields: [directus_operations.user_created],
    references: [directus_users.id],
  }),
}));

export const directus_flowsRelations = relations(directus_flows, ({ one, many }) => ({
  directus_operations: many(directus_operations),
  directus_user: one(directus_users, {
    fields: [directus_flows.user_created],
    references: [directus_users.id],
  }),
  directus_webhooks: many(directus_webhooks),
}));

export const directus_foldersRelations = relations(directus_folders, ({ one, many }) => ({
  directus_folder: one(directus_folders, {
    fields: [directus_folders.parent],
    references: [directus_folders.id],
    relationName: "directus_folders_parent_directus_folders_id",
  }),
  directus_folders: many(directus_folders, {
    relationName: "directus_folders_parent_directus_folders_id",
  }),
  directus_settings: many(directus_settings),
  directus_files: many(directus_files),
}));

export const directus_presetsRelations = relations(directus_presets, ({ one }) => ({
  directus_role: one(directus_roles, {
    fields: [directus_presets.role],
    references: [directus_roles.id],
  }),
  directus_user: one(directus_users, {
    fields: [directus_presets.user],
    references: [directus_users.id],
  }),
}));

export const directus_revisionsRelations = relations(directus_revisions, ({ one, many }) => ({
  directus_activity: one(directus_activity, {
    fields: [directus_revisions.activity],
    references: [directus_activity.id],
  }),
  directus_revision: one(directus_revisions, {
    fields: [directus_revisions.parent],
    references: [directus_revisions.id],
    relationName: "directus_revisions_parent_directus_revisions_id",
  }),
  directus_revisions: many(directus_revisions, {
    relationName: "directus_revisions_parent_directus_revisions_id",
  }),
  directus_version: one(directus_versions, {
    fields: [directus_revisions.version],
    references: [directus_versions.id],
  }),
}));

export const directus_activityRelations = relations(directus_activity, ({ many }) => ({
  directus_revisions: many(directus_revisions),
}));

export const directus_versionsRelations = relations(directus_versions, ({ one, many }) => ({
  directus_revisions: many(directus_revisions),
  directus_collection: one(directus_collections, {
    fields: [directus_versions.collection],
    references: [directus_collections.collection],
  }),
  directus_user_user_created: one(directus_users, {
    fields: [directus_versions.user_created],
    references: [directus_users.id],
    relationName: "directus_versions_user_created_directus_users_id",
  }),
  directus_user_user_updated: one(directus_users, {
    fields: [directus_versions.user_updated],
    references: [directus_users.id],
    relationName: "directus_versions_user_updated_directus_users_id",
  }),
}));

export const directus_sharesRelations = relations(directus_shares, ({ one, many }) => ({
  directus_collection: one(directus_collections, {
    fields: [directus_shares.collection],
    references: [directus_collections.collection],
  }),
  directus_role: one(directus_roles, {
    fields: [directus_shares.role],
    references: [directus_roles.id],
  }),
  directus_user: one(directus_users, {
    fields: [directus_shares.user_created],
    references: [directus_users.id],
  }),
  directus_sessions: many(directus_sessions),
}));

export const directus_panelsRelations = relations(directus_panels, ({ one }) => ({
  directus_dashboard: one(directus_dashboards, {
    fields: [directus_panels.dashboard],
    references: [directus_dashboards.id],
  }),
  directus_user: one(directus_users, {
    fields: [directus_panels.user_created],
    references: [directus_users.id],
  }),
}));

export const directus_settingsRelations = relations(directus_settings, ({ one }) => ({
  directus_file_project_logo: one(directus_files, {
    fields: [directus_settings.project_logo],
    references: [directus_files.id],
    relationName: "directus_settings_project_logo_directus_files_id",
  }),
  directus_file_public_background: one(directus_files, {
    fields: [directus_settings.public_background],
    references: [directus_files.id],
    relationName: "directus_settings_public_background_directus_files_id",
  }),
  directus_file_public_favicon: one(directus_files, {
    fields: [directus_settings.public_favicon],
    references: [directus_files.id],
    relationName: "directus_settings_public_favicon_directus_files_id",
  }),
  directus_file_public_foreground: one(directus_files, {
    fields: [directus_settings.public_foreground],
    references: [directus_files.id],
    relationName: "directus_settings_public_foreground_directus_files_id",
  }),
  directus_role: one(directus_roles, {
    fields: [directus_settings.public_registration_role],
    references: [directus_roles.id],
  }),
  directus_folder: one(directus_folders, {
    fields: [directus_settings.storage_default_folder],
    references: [directus_folders.id],
  }),
}));

export const directus_filesRelations = relations(directus_files, ({ one, many }) => ({
  directus_settings_project_logo: many(directus_settings, {
    relationName: "directus_settings_project_logo_directus_files_id",
  }),
  directus_settings_public_background: many(directus_settings, {
    relationName: "directus_settings_public_background_directus_files_id",
  }),
  directus_settings_public_favicon: many(directus_settings, {
    relationName: "directus_settings_public_favicon_directus_files_id",
  }),
  directus_settings_public_foreground: many(directus_settings, {
    relationName: "directus_settings_public_foreground_directus_files_id",
  }),
  directus_users: many(directus_users, {
    relationName: "directus_users_whitelabel_logo_directus_files_id",
  }),
  directus_folder: one(directus_folders, {
    fields: [directus_files.folder],
    references: [directus_folders.id],
  }),
  directus_user_modified_by: one(directus_users, {
    fields: [directus_files.modified_by],
    references: [directus_users.id],
    relationName: "directus_files_modified_by_directus_users_id",
  }),
  directus_user_uploaded_by: one(directus_users, {
    fields: [directus_files.uploaded_by],
    references: [directus_users.id],
    relationName: "directus_files_uploaded_by_directus_users_id",
  }),
}));

export const directus_permissionsRelations = relations(directus_permissions, ({ one }) => ({
  directus_policy: one(directus_policies, {
    fields: [directus_permissions.policy],
    references: [directus_policies.id],
  }),
}));

export const insightRelations = relations(insight, ({ one }) => ({
  project_analysis_run: one(project_analysis_run, {
    fields: [insight.project_analysis_run_id],
    references: [project_analysis_run.id],
  }),
}));

export const project_analysis_runRelations = relations(project_analysis_run, ({ one, many }) => ({
  insights: many(insight),
  processing_statuses: many(processing_status),
  project: one(project, {
    fields: [project_analysis_run.project_id],
    references: [project.id],
  }),
  views: many(view),
}));

export const map_embeddingRelations = relations(map_embedding, ({ one }) => ({
  project: one(project, {
    fields: [map_embedding.project_id],
    references: [project.id],
  }),
}));

export const map_fact_checkRelations = relations(map_fact_check, ({ one }) => ({
  project: one(project, {
    fields: [map_fact_check.project_id],
    references: [project.id],
  }),
}));

export const methodologyRelations = relations(methodology, ({ one, many }) => ({
  workspace: one(workspace, {
    fields: [methodology.workspace_id],
    references: [workspace.id],
  }),
  methodology_versions: many(methodology_version),
}));

export const model_response_feedbackRelations = relations(model_response_feedback, ({ one }) => ({
  project: one(project, {
    fields: [model_response_feedback.project_id],
    references: [project.id],
  }),
  directus_user: one(directus_users, {
    fields: [model_response_feedback.user_id],
    references: [directus_users.id],
  }),
}));

export const notificationRelations = relations(notification, ({ one }) => ({
  app_user_actor_user_id: one(app_user, {
    fields: [notification.actor_user_id],
    references: [app_user.id],
    relationName: "notification_actor_user_id_app_user_id",
  }),
  app_user_audience_user_id: one(app_user, {
    fields: [notification.audience_user_id],
    references: [app_user.id],
    relationName: "notification_audience_user_id_app_user_id",
  }),
  project_chat: one(project_chat, {
    fields: [notification.ref_chat_id],
    references: [project_chat.id],
  }),
  conversation: one(conversation, {
    fields: [notification.ref_conversation_id],
    references: [conversation.id],
  }),
  workspace_invite: one(workspace_invite, {
    fields: [notification.ref_invite_id],
    references: [workspace_invite.id],
  }),
  org: one(org, {
    fields: [notification.ref_org_id],
    references: [org.id],
  }),
  project: one(project, {
    fields: [notification.ref_project_id],
    references: [project.id],
  }),
  workspace: one(workspace, {
    fields: [notification.ref_workspace_id],
    references: [workspace.id],
  }),
}));

export const project_chatRelations = relations(project_chat, ({ one, many }) => ({
  notifications: many(notification),
  project_agentic_runs: many(project_agentic_run),
  project_chat_conversations: many(project_chat_conversation),
  project: one(project, {
    fields: [project_chat.project_id],
    references: [project.id],
  }),
  directus_user_user_created: one(directus_users, {
    fields: [project_chat.user_created],
    references: [directus_users.id],
    relationName: "project_chat_user_created_directus_users_id",
  }),
  directus_user_user_updated: one(directus_users, {
    fields: [project_chat.user_updated],
    references: [directus_users.id],
    relationName: "project_chat_user_updated_directus_users_id",
  }),
  project_chat_messages: many(project_chat_message),
}));

export const workspace_inviteRelations = relations(workspace_invite, ({ one, many }) => ({
  notifications: many(notification),
  app_user: one(app_user, {
    fields: [workspace_invite.invited_by],
    references: [app_user.id],
  }),
  project: one(project, {
    fields: [workspace_invite.project_id],
    references: [project.id],
  }),
  workspace: one(workspace, {
    fields: [workspace_invite.workspace_id],
    references: [workspace.id],
  }),
}));

export const org_inviteRelations = relations(org_invite, ({ one }) => ({
  app_user: one(app_user, {
    fields: [org_invite.invited_by],
    references: [app_user.id],
  }),
  org: one(org, {
    fields: [org_invite.org_id],
    references: [org.id],
  }),
}));

export const org_membershipRelations = relations(org_membership, ({ one }) => ({
  org: one(org, {
    fields: [org_membership.org_id],
    references: [org.id],
  }),
  app_user: one(app_user, {
    fields: [org_membership.user_id],
    references: [app_user.id],
  }),
}));

export const map_resultRelations = relations(map_result, ({ one }) => ({
  project: one(project, {
    fields: [map_result.project_id],
    references: [project.id],
  }),
  analysis_snapshot: one(analysis_snapshot, {
    fields: [map_result.snapshot_id],
    references: [analysis_snapshot.id],
  }),
}));

export const directus_webhooksRelations = relations(directus_webhooks, ({ one }) => ({
  directus_flow: one(directus_flows, {
    fields: [directus_webhooks.migrated_flow],
    references: [directus_flows.id],
  }),
}));

export const project_agentic_runRelations = relations(project_agentic_run, ({ one, many }) => ({
  project_chat: one(project_chat, {
    fields: [project_agentic_run.project_chat_id],
    references: [project_chat.id],
  }),
  project: one(project, {
    fields: [project_agentic_run.project_id],
    references: [project.id],
  }),
  project_agentic_run_events: many(project_agentic_run_event),
}));

export const project_chat_conversationRelations = relations(
  project_chat_conversation,
  ({ one }) => ({
    conversation: one(conversation, {
      fields: [project_chat_conversation.conversation_id],
      references: [conversation.id],
    }),
    project_chat: one(project_chat, {
      fields: [project_chat_conversation.project_chat_id],
      references: [project_chat.id],
    }),
  }),
);

export const project_chat_message_conversation_1Relations = relations(
  project_chat_message_conversation_1,
  ({ one }) => ({
    conversation: one(conversation, {
      fields: [project_chat_message_conversation_1.conversation_id],
      references: [conversation.id],
    }),
    project_chat_message: one(project_chat_message, {
      fields: [project_chat_message_conversation_1.project_chat_message_id],
      references: [project_chat_message.id],
    }),
  }),
);

export const project_chat_messageRelations = relations(project_chat_message, ({ one, many }) => ({
  project_chat_message_conversation_1s: many(project_chat_message_conversation_1),
  project_chat_message_conversations: many(project_chat_message_conversation),
  project_chat: one(project_chat, {
    fields: [project_chat_message.project_chat_id],
    references: [project_chat.id],
  }),
}));

export const processing_statusRelations = relations(processing_status, ({ one, many }) => ({
  conversation_chunk: one(conversation_chunk, {
    fields: [processing_status.conversation_chunk_id],
    references: [conversation_chunk.id],
  }),
  conversation: one(conversation, {
    fields: [processing_status.conversation_id],
    references: [conversation.id],
  }),
  processing_status: one(processing_status, {
    fields: [processing_status.parent],
    references: [processing_status.id],
    relationName: "processing_status_parent_processing_status_id",
  }),
  processing_statuses: many(processing_status, {
    relationName: "processing_status_parent_processing_status_id",
  }),
  project_analysis_run: one(project_analysis_run, {
    fields: [processing_status.project_analysis_run_id],
    references: [project_analysis_run.id],
  }),
  project: one(project, {
    fields: [processing_status.project_id],
    references: [project.id],
  }),
}));

export const project_chat_message_conversationRelations = relations(
  project_chat_message_conversation,
  ({ one }) => ({
    conversation: one(conversation, {
      fields: [project_chat_message_conversation.conversation_id],
      references: [conversation.id],
    }),
    project_chat_message: one(project_chat_message, {
      fields: [project_chat_message_conversation.project_chat_message_id],
      references: [project_chat_message.id],
    }),
  }),
);

export const project_membershipRelations = relations(project_membership, ({ one }) => ({
  app_user_granted_by: one(app_user, {
    fields: [project_membership.granted_by],
    references: [app_user.id],
    relationName: "project_membership_granted_by_app_user_id",
  }),
  project: one(project, {
    fields: [project_membership.project_id],
    references: [project.id],
  }),
  app_user_user_id: one(app_user, {
    fields: [project_membership.user_id],
    references: [app_user.id],
    relationName: "project_membership_user_id_app_user_id",
  }),
}));

export const project_report_metricRelations = relations(project_report_metric, ({ one }) => ({
  project_report: one(project_report, {
    fields: [project_report_metric.project_report_id],
    references: [project_report.id],
  }),
}));

export const methodology_versionRelations = relations(methodology_version, ({ one, many }) => ({
  projects: many(project),
  methodology: one(methodology, {
    fields: [methodology_version.methodology_id],
    references: [methodology.id],
  }),
}));

export const project_goal_revisionRelations = relations(project_goal_revision, ({ one }) => ({
  project: one(project, {
    fields: [project_goal_revision.project_id],
    references: [project.id],
  }),
}));

export const prompt_templateRelations = relations(prompt_template, ({ one }) => ({
  directus_user: one(directus_users, {
    fields: [prompt_template.user_created],
    references: [directus_users.id],
  }),
  workspace: one(workspace, {
    fields: [prompt_template.workspace_id],
    references: [workspace.id],
  }),
}));

export const recording_overageRelations = relations(recording_overage, ({ one }) => ({
  billing_account: one(billing_account, {
    fields: [recording_overage.billing_account_id],
    references: [billing_account.id],
  }),
}));

export const support_access_eventRelations = relations(support_access_event, ({ one }) => ({
  app_user_actor_user_id: one(app_user, {
    fields: [support_access_event.actor_user_id],
    references: [app_user.id],
    relationName: "support_access_event_actor_user_id_app_user_id",
  }),
  app_user_staff_user_id: one(app_user, {
    fields: [support_access_event.staff_user_id],
    references: [app_user.id],
    relationName: "support_access_event_staff_user_id_app_user_id",
  }),
  workspace: one(workspace, {
    fields: [support_access_event.workspace_id],
    references: [workspace.id],
  }),
}));

export const support_access_requestRelations = relations(support_access_request, ({ one }) => ({
  workspace_membership: one(workspace_membership, {
    fields: [support_access_request.membership_id],
    references: [workspace_membership.id],
  }),
  app_user_requested_by: one(app_user, {
    fields: [support_access_request.requested_by],
    references: [app_user.id],
    relationName: "support_access_request_requested_by_app_user_id",
  }),
  app_user_resolved_by: one(app_user, {
    fields: [support_access_request.resolved_by],
    references: [app_user.id],
    relationName: "support_access_request_resolved_by_app_user_id",
  }),
  workspace: one(workspace, {
    fields: [support_access_request.workspace_id],
    references: [workspace.id],
  }),
}));

export const workspace_membershipRelations = relations(workspace_membership, ({ one, many }) => ({
  support_access_requests: many(support_access_request),
  app_user: one(app_user, {
    fields: [workspace_membership.user_id],
    references: [app_user.id],
  }),
  workspace: one(workspace, {
    fields: [workspace_membership.workspace_id],
    references: [workspace.id],
  }),
}));

export const training_licenseRelations = relations(training_license, ({ one }) => ({
  app_user_app_user_id: one(app_user, {
    fields: [training_license.app_user_id],
    references: [app_user.id],
    relationName: "training_license_app_user_id_app_user_id",
  }),
  app_user_granted_by: one(app_user, {
    fields: [training_license.granted_by],
    references: [app_user.id],
    relationName: "training_license_granted_by_app_user_id",
  }),
  org: one(org, {
    fields: [training_license.org_id],
    references: [org.id],
  }),
  training: one(training, {
    fields: [training_license.training_id],
    references: [training.id],
  }),
}));

export const trainingRelations = relations(training, ({ one, many }) => ({
  training_licenses: many(training_license),
  org: one(org, {
    fields: [training.org_id],
    references: [org.id],
  }),
  app_user: one(app_user, {
    fields: [training.requested_by],
    references: [app_user.id],
  }),
}));

export const verification_topic_translationsRelations = relations(
  verification_topic_translations,
  ({ one }) => ({
    language: one(languages, {
      fields: [verification_topic_translations.languages_code],
      references: [languages.code],
    }),
    verification_topic: one(verification_topic, {
      fields: [verification_topic_translations.verification_topic_key],
      references: [verification_topic.key],
    }),
  }),
);

export const verification_topicRelations = relations(verification_topic, ({ one, many }) => ({
  verification_topic_translations: many(verification_topic_translations),
  project: one(project, {
    fields: [verification_topic.project_id],
    references: [project.id],
  }),
  directus_user_user_created: one(directus_users, {
    fields: [verification_topic.user_created],
    references: [directus_users.id],
    relationName: "verification_topic_user_created_directus_users_id",
  }),
  directus_user_user_updated: one(directus_users, {
    fields: [verification_topic.user_updated],
    references: [directus_users.id],
    relationName: "verification_topic_user_updated_directus_users_id",
  }),
}));

export const project_report_notification_participantsRelations = relations(
  project_report_notification_participants,
  ({ one }) => ({
    conversation: one(conversation, {
      fields: [project_report_notification_participants.conversation_id],
      references: [conversation.id],
    }),
  }),
);

export const project_webhookRelations = relations(project_webhook, ({ one }) => ({
  project: one(project, {
    fields: [project_webhook.project_id],
    references: [project.id],
  }),
  directus_user_user_created: one(directus_users, {
    fields: [project_webhook.user_created],
    references: [directus_users.id],
    relationName: "project_webhook_user_created_directus_users_id",
  }),
  directus_user_user_updated: one(directus_users, {
    fields: [project_webhook.user_updated],
    references: [directus_users.id],
    relationName: "project_webhook_user_updated_directus_users_id",
  }),
}));

export const referral_ledgerRelations = relations(referral_ledger, ({ one }) => ({
  app_user: one(app_user, {
    fields: [referral_ledger.created_by_staff_id],
    references: [app_user.id],
  }),
  org: one(org, {
    fields: [referral_ledger.partner_team_id],
    references: [org.id],
  }),
  workspace: one(workspace, {
    fields: [referral_ledger.workspace_id],
    references: [workspace.id],
  }),
}));

export const workspace_requestRelations = relations(workspace_request, ({ one }) => ({
  app_user_decided_by: one(app_user, {
    fields: [workspace_request.decided_by],
    references: [app_user.id],
    relationName: "workspace_request_decided_by_app_user_id",
  }),
  org: one(org, {
    fields: [workspace_request.org_id],
    references: [org.id],
  }),
  app_user_requested_by: one(app_user, {
    fields: [workspace_request.requested_by],
    references: [app_user.id],
    relationName: "workspace_request_requested_by_app_user_id",
  }),
  workspace_resulting_workspace_id: one(workspace, {
    fields: [workspace_request.resulting_workspace_id],
    references: [workspace.id],
    relationName: "workspace_request_resulting_workspace_id_workspace_id",
  }),
  workspace_workspace_id: one(workspace, {
    fields: [workspace_request.workspace_id],
    references: [workspace.id],
    relationName: "workspace_request_workspace_id_workspace_id",
  }),
}));

export const announcement_activityRelations = relations(announcement_activity, ({ one }) => ({
  announcement: one(announcement, {
    fields: [announcement_activity.announcement_activity],
    references: [announcement.id],
  }),
  directus_user_user_created: one(directus_users, {
    fields: [announcement_activity.user_created],
    references: [directus_users.id],
    relationName: "announcement_activity_user_created_directus_users_id",
  }),
  directus_user_user_updated: one(directus_users, {
    fields: [announcement_activity.user_updated],
    references: [directus_users.id],
    relationName: "announcement_activity_user_updated_directus_users_id",
  }),
}));

export const aspect_segmentRelations = relations(aspect_segment, ({ one }) => ({
  aspect: one(aspect, {
    fields: [aspect_segment.aspect],
    references: [aspect.id],
  }),
  conversation_segment: one(conversation_segment, {
    fields: [aspect_segment.segment],
    references: [conversation_segment.id],
  }),
}));

export const directus_sessionsRelations = relations(directus_sessions, ({ one }) => ({
  directus_share: one(directus_shares, {
    fields: [directus_sessions.share],
    references: [directus_shares.id],
  }),
  directus_user: one(directus_users, {
    fields: [directus_sessions.user],
    references: [directus_users.id],
  }),
}));

export const project_agentic_run_eventRelations = relations(
  project_agentic_run_event,
  ({ one }) => ({
    project_agentic_run: one(project_agentic_run, {
      fields: [project_agentic_run_event.project_agentic_run_id],
      references: [project_agentic_run.id],
    }),
  }),
);
