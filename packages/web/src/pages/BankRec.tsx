import { useEffect, useState } from "react";
import { api } from "../api";
import { useEntity } from "../EntityContext";
import { supabase } from "../supabase";

interface Batch {
  id: string;
  bank_account_id: string;
  statement_period_end: string;
  statement_ending_balance: number;
  status: string;
  bank_accounts: { account_id: string; name: string } | null;
}
type TieOut = Record<string, number | boolean>;

export function BankRec() {
  const { activeId, userId } = useEntity();
  const [batches, setBatches] = useState<Batch[]>([]);
  const [batchId, setBatchId] = useState("");
  const [tie, setTie] = useState<TieOut | null>(null);
  const [reconId, setReconId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    if (!activeId) return;
    (async () => {
      const { data } = await supabase
        .from("import_batches")
        .select("id, bank_account_id, statement_period_end, statement_ending_balance, status, bank_accounts!inner(account_id, name)")
        .eq("entity_id", activeId)
        .order("statement_period_end", { ascending: false });
      const list = (data ?? []) as unknown as Batch[];
      setBatches(list);
      setBatchId((cur) => cur || list[0]?.id || "");
    })();
  }, [activeId]);

  const selected = batches.find((b) => b.id === batchId);

  async function compute() {
    if (!activeId || !selected || !selected.bank_accounts) return;
    setMsg(null);
    try {
      const res = await api.computeReconciliation({
        entityId: activeId,
        bankAccountId: selected.bank_account_id,
        glAccountId: selected.bank_accounts.account_id,
        importBatchId: selected.id,
      });
      setTie(res.tieOut);
      setReconId(res.reconciliationId);
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }

  async function finalize() {
    if (!activeId || !reconId || !userId) return;
    setMsg(null);
    try {
      await api.finalizeReconciliation(reconId, { entityId: activeId, userId });
      setMsg({ kind: "ok", text: "Reconciled — period locked through " + selected?.statement_period_end });
    } catch (e) {
      setMsg({ kind: "err", text: (e as Error).message });
    }
  }

  const n = (k: string) => Number(tie?.[k] ?? 0).toFixed(2);
  const reconciled = tie?.isReconciled === true;

  return (
    <div>
      <h2>Bank Reconciliation</h2>
      <p className="muted">
        Tie-out from the cleared flag + the statement balance assertion. Difference must be zero to
        reconcile and lock the period.
      </p>
      <div className="card">
        <div className="row">
          <label>
            Statement (batch){" "}
            <select value={batchId} onChange={(e) => setBatchId(e.target.value)}>
              {batches.length === 0 && <option value="">(none)</option>}
              {batches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.bank_accounts?.name} · period end {b.statement_period_end} · {b.status}
                </option>
              ))}
            </select>
          </label>
          <button onClick={compute} disabled={!selected}>
            Compute tie-out
          </button>
        </div>
      </div>

      {tie && (
        <div className="card">
          <table>
            <tbody>
              <tr>
                <td>Statement ending balance</td>
                <td className="num">{n("statementEndingBalance")}</td>
              </tr>
              <tr>
                <td>+ Deposits in transit</td>
                <td className="num">{n("depositsInTransit")}</td>
              </tr>
              <tr>
                <td>+ Outstanding checks (negative)</td>
                <td className="num">{n("outstandingChecks")}</td>
              </tr>
              <tr>
                <td>
                  <strong>= Adjusted bank balance</strong>
                </td>
                <td className="num">
                  <strong>{n("adjustedBank")}</strong>
                </td>
              </tr>
              <tr>
                <td>Book cash balance (posted)</td>
                <td className="num">{n("bookBalance")}</td>
              </tr>
              <tr>
                <td>
                  <strong>Difference</strong>
                </td>
                <td className={"num " + (reconciled ? "ok" : "err")}>
                  <strong>{n("difference")}</strong>
                </td>
              </tr>
            </tbody>
          </table>
          <div className="row" style={{ marginTop: 12 }}>
            <button onClick={finalize} disabled={!reconciled}>
              Reconcile & lock period
            </button>
            {!reconciled && <span className="muted">Resolve the difference to enable.</span>}
            {msg && <span className={msg.kind === "ok" ? "ok" : "err"}>{msg.text}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
