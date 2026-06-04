import { useEffect, useMemo, useState } from "react";
import { api, type PostingInput } from "../api";
import { useEntity } from "../EntityContext";
import { supabase } from "../supabase";

interface Account {
  id: string;
  code: string;
  name: string;
}
interface Line {
  account_id: string;
  amount: string; // raw input; "" = elided
}

const blank = (): Line => ({ account_id: "", amount: "" });

export function JournalEntry() {
  const { activeId, userId } = useEntity();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [payee, setPayee] = useState("");
  const [description, setDescription] = useState("");
  const [lines, setLines] = useState<Line[]>([blank(), blank()]);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!activeId) return;
    (async () => {
      const { data } = await supabase
        .from("accounts")
        .select("id, code, name")
        .eq("entity_id", activeId)
        .eq("active", true)
        .order("code");
      setAccounts((data ?? []) as Account[]);
    })();
  }, [activeId]);

  const residual = useMemo(
    () => lines.reduce((acc, l) => acc + (l.amount === "" ? 0 : Number(l.amount) || 0), 0),
    [lines]
  );
  const elidedCount = lines.filter((l) => l.amount === "" && l.account_id).length;
  const balanced = elidedCount === 1 || (elidedCount === 0 && Math.abs(residual) <= 0.005);

  const setLine = (i: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));

  async function submit() {
    setMsg(null);
    if (!activeId) return;
    try {
      const postings: PostingInput[] = lines
        .filter((l) => l.account_id)
        .map((l) => ({ account_id: l.account_id, amount: l.amount === "" ? null : Number(l.amount) }));
      const res = await api.createJournalEntry({
        entityId: activeId,
        date,
        payee,
        description,
        postings,
        userId: userId ?? undefined,
      });
      setMsg({ kind: "ok", text: res.deduped ? "Duplicate — skipped." : "Posted." });
      setLines([blank(), blank()]);
      setPayee("");
      setDescription("");
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }

  return (
    <div>
      <h2>Manual Journal Entry</h2>
      <p className="muted">
        Depreciation, payroll allocations, reclasses. Leave exactly one amount blank to auto-balance it.
        Saves as a posted, balanced transaction.
      </p>
      <div className="card">
        <div className="row">
          <label>
            Date <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label>
            Payee <input value={payee} onChange={(e) => setPayee(e.target.value)} />
          </label>
          <label style={{ flex: 1 }}>
            Description{" "}
            <input style={{ width: "60%" }} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </div>

        <table style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th>Account</th>
              <th className="num">Amount (+ debit / − credit)</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select value={l.account_id} onChange={(e) => setLine(i, { account_id: e.target.value })}>
                    <option value="">— select —</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.code} · {a.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="num">
                  <input
                    style={{ textAlign: "right", width: 140 }}
                    placeholder="(blank = balance)"
                    value={l.amount}
                    onChange={(e) => setLine(i, { amount: e.target.value })}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="row" style={{ marginTop: 12 }}>
          <button className="secondary" onClick={() => setLines((ls) => [...ls, blank()])}>
            + line
          </button>
          <span className={Math.abs(residual) <= 0.005 ? "ok" : "muted"}>
            residual: {residual.toFixed(2)} {elidedCount === 1 && "(one line will auto-balance)"}
          </span>
          <button disabled={!balanced || lines.filter((l) => l.account_id).length < 2} onClick={submit}>
            Post entry
          </button>
          {msg && <span className={msg.kind === "ok" ? "ok" : "err"}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}
