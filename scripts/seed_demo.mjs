// Seed a demo client for local verification. Requires a running Supabase with the
// migrations applied, and the service-role key (it creates auth users + entity data).
//
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/seed_demo.mjs
//
// Creates: two users (reviewer + preparer) in different roles, the "Acme LLC" entity,
// a small chart of accounts (incl. a Suspense account, code 9999), and one bank account.

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}
const db = createClient(url, key, { auth: { persistSession: false } });

async function ensureUser(email, password) {
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true });
  if (error && !/already/i.test(error.message)) throw error;
  if (data?.user) return data.user.id;
  // Already exists — look it up.
  const { data: list } = await db.auth.admin.listUsers();
  return list.users.find((u) => u.email === email)?.id;
}

async function main() {
  const reviewer = await ensureUser("reviewer@demo.test", "password123");
  const preparer = await ensureUser("preparer@demo.test", "password123");

  const { data: entity, error: eErr } = await db
    .from("entities")
    .insert({ name: "Acme LLC", basis: "cash" })
    .select("id")
    .single();
  if (eErr) throw eErr;
  const entityId = entity.id;

  await db.from("memberships").insert([
    { user_id: reviewer, entity_id: entityId, role: "reviewer" },
    { user_id: preparer, entity_id: entityId, role: "preparer" },
  ]);

  const coa = [
    { code: "1000", name: "Operating Checking", type: "asset", is_bank: true },
    { code: "3000", name: "Opening Balance Equity", type: "equity" },
    { code: "4000", name: "Sales", type: "income" },
    { code: "6000", name: "Rent", type: "expense" },
    { code: "6100", name: "Bank Fees", type: "expense" },
    { code: "9999", name: "Suspense", type: "expense" },
  ].map((a) => ({ ...a, entity_id: entityId }));
  const { data: accounts, error: aErr } = await db.from("accounts").insert(coa).select("id, code");
  if (aErr) throw aErr;

  const checking = accounts.find((a) => a.code === "1000");
  await db.from("bank_accounts").insert({
    entity_id: entityId,
    account_id: checking.id,
    name: "Operating Checking",
    last4: "1234",
  });

  await db.from("classes").insert({ entity_id: entityId, name: "General" });

  console.log("Seeded entity", entityId);
  console.log("Users: reviewer@demo.test / preparer@demo.test (password123)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
