import { useEffect, useMemo, useState } from "react";
import { useEntity } from "../EntityContext";
import { supabase } from "../supabase";

interface Row {
  amount: number;
  accounts: { code: string; name: string; type: string };
}
interface AcctAgg {
  code: string;
  name: string;
  type: string;
  balance: number; // Σ amount (+ debit / − credit)
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function Reports() {
  const { activeId } = useEntity();
  const [rows, setRows] = useState<Row[]>([]);
  const [tab, setTab] = useState<"tb" | "pl" | "bs">("tb");

  useEffect(() => {
    if (!activeId) return;
    (async () => {
      // Client read under RLS; posted activity only (Build Doc §7).
      const { data } = await supabase
        .from("postings")
        .select("amount, accounts!inner(code, name, type), transactions!inner(status)")
        .eq("entity_id", activeId)
        .eq("transactions.status", "posted");
      setRows((data ?? []) as unknown as Row[]);
    })();
  }, [activeId]);

  const aggs = useMemo<AcctAgg[]>(() => {
    const m = new Map<string, AcctAgg>();
    for (const r of rows) {
      const key = r.accounts.code;
      const a = m.get(key) ?? { code: r.accounts.code, name: r.accounts.name, type: r.accounts.type, balance: 0 };
      a.balance = round2(a.balance + Number(r.amount));
      m.set(key, a);
    }
    return [...m.values()].sort((a, b) => a.code.localeCompare(b.code));
  }, [rows]);

  const totalDebit = round2(aggs.filter((a) => a.balance >= 0).reduce((s, a) => s + a.balance, 0));
  const totalCredit = round2(aggs.filter((a) => a.balance < 0).reduce((s, a) => s - a.balance, 0));
  const income = round2(-aggs.filter((a) => a.type === "income").reduce((s, a) => s + a.balance, 0));
  const expense = round2(aggs.filter((a) => a.type === "expense").reduce((s, a) => s + a.balance, 0));
  const netIncome = round2(income - expense);
  const assets = round2(aggs.filter((a) => a.type === "asset").reduce((s, a) => s + a.balance, 0));
  const liabilities = round2(-aggs.filter((a) => a.type === "liability").reduce((s, a) => s + a.balance, 0));
  const equityAccts = round2(-aggs.filter((a) => a.type === "equity").reduce((s, a) => s + a.balance, 0));
  const equity = round2(equityAccts + netIncome);

  return (
    <div>
      <h2>Reports</h2>
      <p className="muted">Cash-basis, posted activity only.</p>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className={tab === "tb" ? "" : "secondary"} onClick={() => setTab("tb")}>
          Trial Balance
        </button>
        <button className={tab === "pl" ? "" : "secondary"} onClick={() => setTab("pl")}>
          Profit & Loss
        </button>
        <button className={tab === "bs" ? "" : "secondary"} onClick={() => setTab("bs")}>
          Balance Sheet
        </button>
      </div>

      {tab === "tb" && (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Account</th>
              <th className="num">Debit</th>
              <th className="num">Credit</th>
            </tr>
          </thead>
          <tbody>
            {aggs.map((a) => (
              <tr key={a.code}>
                <td>{a.code}</td>
                <td>{a.name}</td>
                <td className="num">{a.balance >= 0 ? a.balance.toFixed(2) : ""}</td>
                <td className="num">{a.balance < 0 ? (-a.balance).toFixed(2) : ""}</td>
              </tr>
            ))}
            <tr>
              <td />
              <td>
                <strong>Total</strong>
              </td>
              <td className="num">
                <strong>{totalDebit.toFixed(2)}</strong>
              </td>
              <td className="num">
                <strong>{totalCredit.toFixed(2)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {tab === "pl" && (
        <table>
          <tbody>
            <tr>
              <td>Total income</td>
              <td className="num">{income.toFixed(2)}</td>
            </tr>
            <tr>
              <td>Total expense</td>
              <td className="num">{expense.toFixed(2)}</td>
            </tr>
            <tr>
              <td>
                <strong>Net income</strong>
              </td>
              <td className="num">
                <strong>{netIncome.toFixed(2)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      )}

      {tab === "bs" && (
        <table>
          <tbody>
            <tr>
              <td>Total assets</td>
              <td className="num">{assets.toFixed(2)}</td>
            </tr>
            <tr>
              <td>Total liabilities</td>
              <td className="num">{liabilities.toFixed(2)}</td>
            </tr>
            <tr>
              <td>Total equity (incl. net income {netIncome.toFixed(2)})</td>
              <td className="num">{equity.toFixed(2)}</td>
            </tr>
            <tr>
              <td>
                <strong>Assets − (Liabilities + Equity)</strong>
              </td>
              <td className={"num " + (Math.abs(assets - (liabilities + equity)) <= 0.005 ? "ok" : "err")}>
                <strong>{round2(assets - (liabilities + equity)).toFixed(2)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      )}
    </div>
  );
}
