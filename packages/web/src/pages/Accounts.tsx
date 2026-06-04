import { useEffect, useState } from "react";
import { useEntity } from "../EntityContext";
import { supabase } from "../supabase";

interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  is_bank: boolean;
  active: boolean;
}
interface Klass {
  id: string;
  name: string;
  active: boolean;
}

export function Accounts() {
  const { activeId } = useEntity();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [classes, setClasses] = useState<Klass[]>([]);

  useEffect(() => {
    if (!activeId) return;
    (async () => {
      const { data: a } = await supabase
        .from("accounts")
        .select("id, code, name, type, is_bank, active")
        .eq("entity_id", activeId)
        .order("code");
      setAccounts((a ?? []) as Account[]);
      const { data: c } = await supabase
        .from("classes")
        .select("id, name, active")
        .eq("entity_id", activeId)
        .order("name");
      setClasses((c ?? []) as Klass[]);
    })();
  }, [activeId]);

  return (
    <div>
      <h2>Chart of Accounts</h2>
      <p className="muted">
        The ledger's accounts for the selected client. Categorization maps imported activity onto
        these accounts (Phase 2 rules engine). CoA is seeded; CRUD via the service is a follow-up.
      </p>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Type</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td>{a.code}</td>
              <td>{a.name}</td>
              <td>{a.type}</td>
              <td>
                {a.is_bank && <span className="badge">bank</span>} {!a.active && <span className="badge">inactive</span>}
              </td>
            </tr>
          ))}
          {accounts.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No accounts yet — run the seed (scripts/seed_demo).
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 style={{ marginTop: 24 }}>Classes (fund / department)</h3>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {classes.map((c) => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td>{c.active ? "yes" : "no"}</td>
            </tr>
          ))}
          {classes.length === 0 && (
            <tr>
              <td colSpan={2} className="muted">
                No classes.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
