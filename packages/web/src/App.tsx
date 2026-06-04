import { HashRouter, NavLink, Navigate, Route, Routes } from "react-router-dom";
import { EntityProvider, useEntity } from "./EntityContext";
import { Accounts } from "./pages/Accounts";
import { BankRec } from "./pages/BankRec";
import { ImportPage } from "./pages/Import";
import { JournalEntry } from "./pages/JournalEntry";
import { Reports } from "./pages/Reports";

function EntitySwitcher() {
  const { entities, activeId, setActiveId } = useEntity();
  return (
    <div className="entity-switch">
      <div className="muted">Client</div>
      <select value={activeId ?? ""} onChange={(e) => setActiveId(e.target.value)}>
        {entities.length === 0 && <option value="">(none)</option>}
        {entities.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function Shell() {
  return (
    <div className="app">
      <aside className="sidebar">
        <h1>LedgerPro</h1>
        <div className="muted">Write-up engine</div>
        <EntitySwitcher />
        <nav>
          <NavLink to="/accounts">Accounts</NavLink>
          <NavLink to="/journal">Journal Entry</NavLink>
          <NavLink to="/import">Import</NavLink>
          <NavLink to="/bankrec">Bank Rec</NavLink>
          <NavLink to="/reports">Reports</NavLink>
        </nav>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/" element={<Navigate to="/accounts" replace />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/journal" element={<JournalEntry />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/bankrec" element={<BankRec />} />
          <Route path="/reports" element={<Reports />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  return (
    <EntityProvider>
      <HashRouter>
        <Shell />
      </HashRouter>
    </EntityProvider>
  );
}
