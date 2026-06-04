import { round2, sumAmounts } from "../money.js";
import type { AccountType } from "../types.js";

/** A posted posting joined to its account, the input to every report. */
export interface ReportPosting {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  amount: number; // + debit / − credit
  date: string; // ISO yyyy-mm-dd
  classId?: string | null;
  transactionId: string;
  payee?: string | null;
  description?: string | null;
}

export interface AccountBalance {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  debit: number; // total debit side
  credit: number; // total credit side
  balance: number; // net (debit − credit), i.e. Σ amount
}

function byAccount(rows: ReportPosting[]): AccountBalance[] {
  const map = new Map<string, AccountBalance>();
  for (const r of rows) {
    let b = map.get(r.accountId);
    if (!b) {
      b = {
        accountId: r.accountId,
        accountCode: r.accountCode,
        accountName: r.accountName,
        accountType: r.accountType,
        debit: 0,
        credit: 0,
        balance: 0,
      };
      map.set(r.accountId, b);
    }
    if (r.amount >= 0) b.debit = round2(b.debit + r.amount);
    else b.credit = round2(b.credit - r.amount);
  }
  for (const b of map.values()) b.balance = round2(b.debit - b.credit);
  return [...map.values()].sort((a, b) => a.accountCode.localeCompare(b.accountCode));
}

export interface TrialBalance {
  accounts: AccountBalance[];
  totalDebit: number;
  totalCredit: number;
  inBalance: boolean;
}

export function trialBalance(rows: ReportPosting[]): TrialBalance {
  const accounts = byAccount(rows);
  // Present each account on its natural side (net debit or net credit).
  let totalDebit = 0;
  let totalCredit = 0;
  for (const a of accounts) {
    if (a.balance >= 0) totalDebit = round2(totalDebit + a.balance);
    else totalCredit = round2(totalCredit - a.balance);
  }
  return { accounts, totalDebit, totalCredit, inBalance: Math.abs(totalDebit - totalCredit) <= 0.005 };
}

export interface ProfitAndLoss {
  income: AccountBalance[];
  expense: AccountBalance[];
  totalIncome: number; // positive = income earned
  totalExpense: number; // positive = expense incurred
  netIncome: number; // income − expense
}

export function profitAndLoss(rows: ReportPosting[]): ProfitAndLoss {
  const accounts = byAccount(rows);
  const income = accounts.filter((a) => a.accountType === "income");
  const expense = accounts.filter((a) => a.accountType === "expense");
  // Income is credit-normal (balance negative); expense is debit-normal (positive).
  const totalIncome = round2(-sumAmounts(income.map((a) => a.balance)));
  const totalExpense = round2(sumAmounts(expense.map((a) => a.balance)));
  return { income, expense, totalIncome, totalExpense, netIncome: round2(totalIncome - totalExpense) };
}

export interface BalanceSheet {
  assets: AccountBalance[];
  liabilities: AccountBalance[];
  equity: AccountBalance[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number; // equity accounts + net income
  netIncome: number;
  inBalance: boolean; // assets = liabilities + equity
}

export function balanceSheet(rows: ReportPosting[]): BalanceSheet {
  const accounts = byAccount(rows);
  const assets = accounts.filter((a) => a.accountType === "asset");
  const liabilities = accounts.filter((a) => a.accountType === "liability");
  const equity = accounts.filter((a) => a.accountType === "equity");

  const totalAssets = round2(sumAmounts(assets.map((a) => a.balance))); // debit-normal
  const totalLiabilities = round2(-sumAmounts(liabilities.map((a) => a.balance))); // credit-normal
  const equityAccounts = round2(-sumAmounts(equity.map((a) => a.balance)));
  const { netIncome } = profitAndLoss(rows);
  const totalEquity = round2(equityAccounts + netIncome);

  return {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    netIncome,
    inBalance: Math.abs(totalAssets - (totalLiabilities + totalEquity)) <= 0.005,
  };
}

export interface GeneralLedgerLine extends ReportPosting {
  runningBalance: number;
}

export function generalLedger(rows: ReportPosting[]): Map<string, GeneralLedgerLine[]> {
  const byAcct = new Map<string, ReportPosting[]>();
  for (const r of rows) {
    const list = byAcct.get(r.accountId) ?? [];
    list.push(r);
    byAcct.set(r.accountId, list);
  }
  const out = new Map<string, GeneralLedgerLine[]>();
  for (const [accountId, list] of byAcct) {
    list.sort((a, b) => a.date.localeCompare(b.date));
    let running = 0;
    out.set(
      accountId,
      list.map((r) => {
        running = round2(running + r.amount);
        return { ...r, runningBalance: running };
      })
    );
  }
  return out;
}
