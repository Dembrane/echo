-- Makes a copy of parity_template fit to publish: the seeded rows from seed.ts stay as they
-- are, and everything the local stack added around them goes. Run by dump.sh.

-- What Directus logged while the stack was built and seeded, and its own description of
-- the data model (collections, fields, permissions, flows, dashboards). The platform reads
-- neither; the tables stay, empty.
truncate directus_activity, directus_revisions, directus_sessions, directus_notifications,
  directus_presets, directus_shares, directus_versions, directus_comments,
  directus_collections, directus_fields, directus_relations, directus_permissions,
  directus_flows, directus_operations, directus_dashboards, directus_panels,
  directus_translations, directus_webhooks, directus_extensions, directus_migrations,
  directus_sync_id_map
  restart identity;

-- One password for every user, published in README.md. The hash keeps Directus's argon2id
-- memory and time cost.
update directus_users set
  password = '$argon2id$v=19$m=65536,t=3,p=1$3mmASmRrJhSOmvgAN3zcPd+xae0/mVYj8LdcuUwpVBg$APIMw7u9mmAED1OiiuxdyhJkkdQJpwSFINuGeyaFRz4',
  token = null,
  tfa_secret = null,
  auth_data = null,
  external_identifier = null,
  last_access = null,
  last_page = null;

-- The account Directus creates at bootstrap. The seeded users are already on example.com.
update directus_users set email = 'directus-admin@example.com'
  where email not like '%@example.com';

-- Agent tokens: the hashes of two fixed strings nobody holds a grant for.
update agent_token set token_hash = encode(sha256(convert_to('parity-fixture-' || kind, 'utf8')), 'hex');
update agent_client set client_secret_encrypted = null;
update project_webhook set secret = null;
update project_report set public_token = null;

-- Settings: the platform reads the registration role only.
update directus_settings set project_id = null, project_name = 'parity', module_bar = null;
