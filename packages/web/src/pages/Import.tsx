import { useEffect, useState } from "react";
import { api } from "../api";
import { useEntity } from "../EntityContext";
import { supabase } from "../supabase";

interface BankAccount {
  id: string;
  name: string;
}
interface ValidationIssue {
  tab: string;
  row: number | null;
  message: string;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export function ImportPage() {
  const { activeId, userId } = useEntity();
  const [banks, setBanks] = useState<BankAccount[]>([]);
  const [bankId, setBankId] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [result, setResult] = useState<Record<string, number> | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId) return;
    (async () => {
      const { data } = await supabase
        .from("bank_accounts")
        .select("id, name")
        .eq("entity_id", activeId)
        .eq("active", true);
      const list = (data ?? []) as BankAccount[];
      setBanks(list);
      setBankId((cur) => cur || list[0]?.id || "");
    })();
  }, [activeId]);

  async function upload() {
    if (!activeId || !bankId || !file) return;
    setBusy(true);
    setErrors([]);
    setResult(null);
    setErr(null);
    try {
      const fileBase64 = await fileToBase64(file);
      const res = await api.uploadImport({ entityId: activeId, bankAccountId: bankId, userId: userId ?? undefined, fileBase64 });
      setResult(res.result);
    } catch (e) {
      // The service returns 422 with the accumulated validator battery on bad sheets.
      const message = (e as Error).message;
      try {
        const parsed = JSON.parse(message);
        if (parsed.errors) setErrors(parsed.errors as ValidationIssue[]);
        else setErr(message);
      } catch {
        setErr(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Import Workbook</h2>
      <p className="muted">
        Upload the filled LedgerPro v1 template (one workbook = one bank account = one period). The
        service validates, de-duplicates, and matches book ↔ statement, then you reconcile on Bank Rec.
      </p>
      <div className="card">
        <div className="row">
          <label>
            Bank account{" "}
            <select value={bankId} onChange={(e) => setBankId(e.target.value)}>
              {banks.length === 0 && <option value="">(none)</option>}
              {banks.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <button disabled={busy || !bankId || !file} onClick={upload}>
            {busy ? "Processing…" : "Upload & process"}
          </button>
        </div>
      </div>

      {err && <p className="err">{err}</p>}

      {errors.length > 0 && (
        <div className="card">
          <h3 className="err">Validation errors ({errors.length}) — fix the sheet and re-upload</h3>
          <table>
            <thead>
              <tr>
                <th>Tab</th>
                <th>Row</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e, i) => (
                <tr key={i}>
                  <td>{e.tab}</td>
                  <td>{e.row ?? "—"}</td>
                  <td>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {result && (
        <div className="card">
          <h3 className="ok">Imported</h3>
          <ul>
            <li>Book transactions committed: {result.bookCommitted}</li>
            <li>Deduped (already present): {result.bookDeduped}</li>
            <li>Statement lines matched: {result.matched}</li>
            <li>Unmatched (need manual pick): {result.unmatched}</li>
            <li>Bank-only items booked: {result.bankOnlyBooked}</li>
          </ul>
          <p className="muted">Head to Bank Rec to tie out and lock the period.</p>
        </div>
      )}
    </div>
  );
}
