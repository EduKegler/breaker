import { useState, useCallback } from "react";
import type { AccountResponse, LivePosition } from "../types/api.js";

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsd(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 10_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

function formatPnl(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${formatUsd(value)}`;
}

function marginPct(used: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min((used / total) * 100, 100);
}

interface AccountPanelProps {
  account: AccountResponse | null;
  positions: LivePosition[];
}

export function AccountPanel({ account, positions }: AccountPanelProps) {
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
      <section className="account-bar bg-terminal-surface border border-terminal-border rounded-sm px-5 py-2.5">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded-full border-2 border-txt-secondary/30 border-t-txt-secondary animate-spin" />
          <span className="text-xs text-txt-secondary font-mono">Loading account…</span>
        </div>
      </section>
    );
  }

  const unrealizedPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
  const pnlColor = unrealizedPnl >= 0 ? "text-profit" : "text-loss";
  const pnlGlow = unrealizedPnl >= 0 ? "shadow-[0_0_8px_rgba(0,255,136,0.15)]" : "shadow-[0_0_8px_rgba(255,51,102,0.15)]";

  const pct = marginPct(account.totalMarginUsed, account.accountValue);
  const meterColor = pct > 80 ? "bg-loss" : pct > 50 ? "bg-amber" : "bg-profit";
  const meterGlow = pct > 80 ? "shadow-[0_0_4px_rgba(255,51,102,0.4)]" : pct > 50 ? "shadow-[0_0_4px_rgba(255,170,0,0.3)]" : "shadow-[0_0_4px_rgba(0,255,136,0.2)]";

  return (
    <section className="account-bar bg-terminal-surface border border-terminal-border rounded-sm px-5 py-2.5">
      <div className="flex items-center gap-4 flex-wrap">

        {/* Wallet address */}
        <button
          type="button"
          onClick={handleCopy}
          title={account.walletAddress}
          className="flex items-center gap-1.5 font-mono text-xs text-txt-secondary hover:text-profit transition-colors cursor-pointer group shrink-0"
        >
          <svg
            className="w-3.5 h-3.5 text-txt-secondary/40 group-hover:text-profit/60 transition-colors"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 013 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 013 6v3" />
          </svg>
          <span className="text-txt-primary/70 group-hover:text-profit transition-colors">
            {truncateAddress(account.walletAddress)}
          </span>
          {copied && (
            <span className="text-[9px] text-profit font-semibold uppercase tracking-wider animate-pulse">
              copied
            </span>
          )}
        </button>

        <div className="w-px h-7 bg-terminal-border" />

        {/* ── Hero: Total Equity ── */}
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            Equity
          </span>
          <span className="font-mono text-base font-semibold text-txt-primary leading-none">
            {formatUsd(account.accountValue)}
          </span>
        </div>

        <div className="w-px h-7 bg-terminal-border" />

        {/* ── Unrealized PnL ── */}
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            uPnL
          </span>
          <span className={`font-mono text-sm font-medium leading-none rounded-sm px-1.5 py-0.5 ${pnlColor} ${pnlGlow} ${
            unrealizedPnl >= 0 ? "bg-profit/[0.06]" : "bg-loss/[0.06]"
          }`}>
            {formatPnl(unrealizedPnl)}
          </span>
        </div>

        <div className="w-px h-7 bg-terminal-border hidden sm:block" />

        {/* ── Available ── */}
        <div className="flex items-baseline gap-2 hidden sm:flex">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            Free
          </span>
          <span className="font-mono text-sm text-profit/80 leading-none">
            {formatUsd(account.withdrawable)}
          </span>
        </div>

        <div className="w-px h-7 bg-terminal-border hidden md:block" />

        {/* ── Margin meter ── */}
        <div className="flex items-center gap-2.5 hidden md:flex">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            Margin
          </span>
          <span className="font-mono text-sm text-amber leading-none">
            {formatUsd(account.totalMarginUsed)}
          </span>
          {account.accountValue > 0 && (
            <div className="flex items-center gap-1.5">
              <div className={`w-20 h-1.5 bg-terminal-border rounded-full overflow-hidden ${meterGlow}`}>
                <div
                  className={`h-full rounded-full transition-all duration-700 ease-out ${meterColor}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="font-mono text-[10px] text-txt-secondary/60 leading-none w-8 text-right">
                {pct.toFixed(0)}%
              </span>
            </div>
          )}
        </div>

        <div className="w-px h-7 bg-terminal-border hidden lg:block" />

        {/* ── Notional ── */}
        <div className="flex items-baseline gap-2 hidden lg:flex">
          <span className="text-[10px] uppercase tracking-wider text-txt-secondary font-semibold">
            Ntl
          </span>
          <span className="font-mono text-sm text-txt-primary/60 leading-none">
            {formatUsd(account.totalNtlPos)}
          </span>
        </div>

        {/* ── Positions count (right side) ── */}
        {positions.length > 0 && (
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-amber animate-pulse" />
            <span className="font-mono text-[10px] text-amber/80">
              {positions.length} open
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
