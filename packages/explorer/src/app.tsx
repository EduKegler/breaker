import { useState } from "react";
import { Dashboard } from "./pages/dashboard.js";
import { Orders } from "./pages/orders.js";
import { Equity } from "./pages/equity.js";

type Page = "dashboard" | "orders" | "equity";

const navItems: { key: Page; label: string }[] = [
  { key: "dashboard", label: "Dashboard" },
  { key: "orders", label: "Orders" },
  { key: "equity", label: "Equity" },
];

export function App() {
  const [page, setPage] = useState<Page>("dashboard");

  return (
    <div className="min-h-screen bg-gray-950">
      {/* Nav */}
      <nav className="border-b border-gray-800 px-6 py-3">
        <div className="max-w-6xl mx-auto flex items-center gap-6">
          <span className="text-lg font-bold text-green-400">BREAKER</span>
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => setPage(item.key)}
              className={`text-sm px-3 py-1 rounded transition ${
                page === item.key
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:text-white"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="max-w-6xl mx-auto px-6 py-6">
        {page === "dashboard" && <Dashboard />}
        {page === "orders" && <Orders />}
        {page === "equity" && <Equity />}
      </main>
    </div>
  );
}
