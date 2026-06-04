import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// The service-role client BYPASSES RLS. Every query made through it MUST scope
// entity_id explicitly — that is the only thing standing between two clients' books.

let _client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

/**
 * Guard helper: throws if a caller forgot to pass an entity id into a query path.
 * Use at the top of every mutation so a missing scope fails loudly rather than
 * silently reading/writing across tenants.
 */
export function requireEntity(entityId: string | undefined | null): string {
  if (!entityId) throw new Error("entity_id is required and was not provided");
  return entityId;
}

/** Whether the given date falls inside a locked period for the entity. */
export async function isPeriodLocked(entityId: string, isoDate: string): Promise<boolean> {
  requireEntity(entityId);
  const { data, error } = await db()
    .from("period_locks")
    .select("locked_through")
    .eq("entity_id", entityId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.locked_through) return false;
  return isoDate <= data.locked_through;
}

export async function writeAudit(entry: {
  entityId: string;
  actor?: string | null;
  action: string;
  tableName?: string;
  rowId?: string;
  before?: unknown;
  after?: unknown;
}): Promise<void> {
  requireEntity(entry.entityId);
  const { error } = await db().from("audit_log").insert({
    entity_id: entry.entityId,
    actor: entry.actor ?? null,
    action: entry.action,
    table_name: entry.tableName ?? null,
    row_id: entry.rowId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
  });
  if (error) throw error;
}
