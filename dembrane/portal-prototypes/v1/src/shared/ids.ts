const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Echo's project IDs are UUIDs. */
export const isProjectId = (id: string | undefined): id is string => !!id && UUID.test(id);
