import { supabase } from "./supabase";

// All mutations flow through the Node service. We attach the user's access token so the
// service can verify identity and resolve membership before scoping entity_id.
const SERVER = import.meta.env.VITE_SERVER_URL as string;

async function post<T>(path: string, body: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const res = await fetch(`${SERVER}/api${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error ?? `Request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export interface PostingInput {
  account_id: string;
  amount?: number | null;
  check_number?: string | null;
}

export const api = {
  createJournalEntry: (input: {
    entityId: string;
    date: string;
    payee?: string;
    description?: string;
    postings: PostingInput[];
    userId?: string;
  }) => post<{ transactionId: string | null; deduped: boolean }>("/journal-entries", input),

  validateImport: (parsed: unknown) =>
    post<{ errors: { tab: string; row: number | null; message: string }[] }>("/imports/validate", { parsed }),

  uploadImport: (input: { entityId: string; bankAccountId: string; userId?: string; fileBase64: string }) =>
    post<{ batchId: string; glAccountId: string; result: Record<string, number> }>("/imports", input),

  computeReconciliation: (input: { entityId: string; bankAccountId: string; glAccountId: string; importBatchId: string }) =>
    post<{ reconciliationId: string; tieOut: Record<string, number | boolean> }>("/reconciliations/compute", input),

  finalizeReconciliation: (id: string, input: { entityId: string; userId: string }) =>
    post<{ ok: true }>(`/reconciliations/${id}/finalize`, input),
};
