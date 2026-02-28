import { useState, useCallback } from "react";
import type { AccountResponse } from "../types/api.js";

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsd(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 10_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

function marginPct(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min((used / total) * 100, 100);
}

interface AccountPanelProps {
  account: AccountResponse | null;
}

export function AccountPanel({ account }: AccountPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    if (!account) return;
    navigator.clipboard.writeText(account.walletAddress).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  }, [account]);

  if (!account) {
    return (
      <section className="bg-terminal-surface border border-terminal-border rounded-sm px-5 py-3">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full border-2 border-txt-secondary/30 border-t-txt-secondary animate-spin" />
          <span className="text-xs text-txt-secondary font-mono">Loading account…</span>
        </div>
      </section>
    );
  }

  const pct = marginPct(account.totalMarginUsed, account.accountValue);
  const meterColor = pct > 80 ? "bg-loss" : pct > 50 ? "bg-amber" : "bg-profit";
  const spotUsdc = account.spotBalances.find((b: { coin: string; total: number }) => b.coin === "USDC" || b.coin === "USDC-SPOT")?.total ?? 0;
  const perpEquity = account.accountValue - spotUsdc;

  return (
    <section className="bg-terminal-surface border border-terminal-border rounded-sm px-5 py-3">
      <div className="flex items-center gap-5 flex-wrap">
        {/* Wallet address */}
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold shrink-0">
            Wallet
          </span>
          <button
            type="button"
            onClick={handleCopy}
            title={account.walletAddress}
            className="flex items-center gap-1.5 font-mono text-xs text-txt-primary/80 hover:text-profit transition-colors cursor-pointer group"
          >
            <span>{truncateAddress(account.walletAddress)}</span>
            <svg
              className={`w-3 h-3 transition-all ${copied ? "text-profit scale-110" : "text-txt-secondary/50 group-hover:text-profit/70"}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              {copied ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              )}
            </svg>
          </button>
        </div>

        <div className="w-px h-8 bg-terminal-border" />

        {/* Total Equity — hero metric */}
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            Total Equity
          </span>
          <span className="font-mono text-lg font-medium text-txt-primary leading-tight">
            {formatUsd(account.accountValue)}
          </span>
        </div>

        <div className="w-px h-8 bg-terminal-border" />

        {/* Spot balance */}
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            Spot
          </span>
          <span className="font-mono text-sm text-profit leading-tight">
            {formatUsd(spotUsdc)}
          </span>
        </div>

        {/* Perps equity */}
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            Perps
          </span>
          <span className="font-mono text-sm text-txt-primary/80 leading-tight">
            {formatUsd(perpEquity)}
          </span>
        </div>

        <div className="w-px h-8 bg-terminal-border hidden sm:block" />

        {/* Available */}
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            Available
          </span>
          <span className="font-mono text-sm text-profit/80 leading-tight">
            {formatUsd(account.withdrawable)}
          </span>
        </div>

        <div className="w-px h-8 bg-terminal-border hidden sm:block" />

        {/* Margin Used with visual meter */}
        <div className="flex flex-col items-start gap-1">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
              Margin Used
            </span>
            {account.accountValue > 0 && (
              <span className="font-mono text-[10px] text-txt-secondary/70">
                {pct.toFixed(1)}%
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-sm text-amber leading-tight">
              {formatUsd(account.totalMarginUsed)}
            </span>
            {account.accountValue > 0 && (
              <div className="w-16 h-1.5 bg-terminal-border rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${meterColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </div>
        </div>

        <div className="w-px h-8 bg-terminal-border hidden md:block" />

        {/* Notional */}
        <div className="flex flex-col items-start">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            Notional
          </span>
          <span className="font-mono text-sm text-txt-primary/70 leading-tight">
            {formatUsd(account.totalNtlPos)}
          </span>
        </div>
      </div>
    </section>
  );
}
