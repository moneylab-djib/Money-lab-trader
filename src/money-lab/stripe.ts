/**
 * Stripe revenue sync (read-only).
 *
 * Reads balance transactions with a restricted, read-only key and writes
 * them to the operator ledger as provider-imported entries, so revenue that
 * keeps the bot alive is confirmed by Stripe, not claimed by the agent.
 * Entries are deduplicated by Stripe transaction id.
 *
 *   charge / payment            -> confirmed_revenue (gross) + fee
 *   refund / payment_refund     -> refund
 *   adjustment (dispute, chargeback): negative -> refund, positive -> confirmed_revenue, + fee
 *   refund_failure              -> confirmed_revenue (the money came back)
 *   stripe_fee, tax_fee...      -> fee
 *   payout                      -> cash_received (money sent to the bank)
 *
 * Amounts are converted to USD cents with the owner's configured rate;
 * transactions in another currency are skipped and reported.
 */

import type Database from "better-sqlite3";
import type { MoneyLabStripe } from "./profile.js";
import { addLedgerEntry, queueOwnerNotification, type LedgerKind } from "./journal.js";

type FetchFn = typeof fetch;

export interface StripeBalanceTransaction {
  id: string;
  type: string;
  amount: number;
  fee: number;
  currency: string;
  created: number;
  description?: string | null;
}

export interface StripeSyncResult {
  imported: number;
  revenueCents: number;
  skippedCurrency: number;
}

function toUsdCents(amountMinor: number, cfg: MoneyLabStripe): number {
  return Math.round(Math.abs(amountMinor) * cfg.usdPerUnit);
}

/** Map one transaction to ledger entries (pure, for tests). */
export function ledgerEntriesFor(
  txn: StripeBalanceTransaction,
  cfg: MoneyLabStripe,
): { kind: LedgerKind; amountCents: number; reference: string; note: string }[] {
  const note = `Stripe ${txn.type} ${(Math.abs(txn.amount) / 100).toFixed(2)} ${txn.currency.toUpperCase()}` +
    (cfg.currency !== "usd" ? ` (× ${cfg.usdPerUnit} USD)` : "");
  switch (txn.type) {
    case "charge":
    case "payment": {
      const entries: { kind: LedgerKind; amountCents: number; reference: string; note: string }[] = [
        { kind: "confirmed_revenue", amountCents: toUsdCents(txn.amount, cfg), reference: `stripe:${txn.id}`, note },
      ];
      if (txn.fee > 0) {
        entries.push({ kind: "fee", amountCents: toUsdCents(txn.fee, cfg), reference: `stripe-fee:${txn.id}`, note: `${note} — frais` });
      }
      return entries;
    }
    case "refund":
    case "payment_refund":
      return [{ kind: "refund", amountCents: toUsdCents(txn.amount, cfg), reference: `stripe:${txn.id}`, note }];
    case "adjustment": {
      // Disputes and chargebacks take money back (and cost a fee); a won
      // dispute returns it. Ignoring them overstated confirmed revenue.
      const entries: { kind: LedgerKind; amountCents: number; reference: string; note: string }[] = txn.amount === 0 ? [] : [
        { kind: txn.amount < 0 ? "refund" : "confirmed_revenue", amountCents: toUsdCents(txn.amount, cfg), reference: `stripe:${txn.id}`, note },
      ];
      if (txn.fee > 0) {
        entries.push({ kind: "fee", amountCents: toUsdCents(txn.fee, cfg), reference: `stripe-fee:${txn.id}`, note: `${note} — frais` });
      }
      return entries;
    }
    case "refund_failure":
      return [{ kind: "confirmed_revenue", amountCents: toUsdCents(txn.amount, cfg), reference: `stripe:${txn.id}`, note }];
    case "stripe_fee":
    case "tax_fee":
    case "network_cost":
    case "stripe_fx_fee":
      return txn.amount === 0 ? [] : [{ kind: "fee", amountCents: toUsdCents(txn.amount, cfg), reference: `stripe:${txn.id}`, note }];
    case "payout":
      return [{ kind: "cash_received", amountCents: toUsdCents(txn.amount, cfg), reference: `stripe:${txn.id}`, note }];
    default:
      return [];
  }
}

/** Import recent balance transactions; safe to run repeatedly. */
export async function syncStripe(
  db: Database.Database,
  cfg: MoneyLabStripe,
  apiKey: string,
  fetchFn: FetchFn = fetch,
): Promise<StripeSyncResult> {
  const result: StripeSyncResult = { imported: 0, revenueCents: 0, skippedCurrency: 0 };
  let startingAfter: string | undefined;
  for (let page = 0; page < 10; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (startingAfter) params.set("starting_after", startingAfter);
    const resp = await fetchFn(`https://api.stripe.com/v1/balance_transactions?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30_000),
    });
    const data = (await resp.json().catch(() => ({}))) as any;
    if (!resp.ok) {
      throw new Error(`Stripe sync failed: ${resp.status} ${data?.error?.message ?? ""}`.trim());
    }
    const txns: StripeBalanceTransaction[] = data.data ?? [];
    let newOnPage = 0;
    for (const txn of txns) {
      if (txn.currency.toLowerCase() !== cfg.currency) {
        result.skippedCurrency++;
        continue;
      }
      for (const entry of ledgerEntriesFor(txn, cfg)) {
        const added = addLedgerEntry(db, { ...entry, source: "provider_import" });
        if (!added) continue;
        newOnPage++;
        result.imported++;
        if (entry.kind === "confirmed_revenue") result.revenueCents += entry.amountCents;
      }
    }
    // Newest first: once a page brings nothing new, older pages are known too.
    if (!data.has_more || txns.length === 0 || newOnPage === 0) break;
    startingAfter = txns[txns.length - 1].id;
  }
  if (result.revenueCents > 0) {
    queueOwnerNotification(db, `🎉 Revenu confirmé par Stripe : ${(result.revenueCents / 100).toFixed(2)} $ (converti). Le bot gagne du temps de vie.`);
  }
  return result;
}
