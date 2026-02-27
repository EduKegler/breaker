import Database from "better-sqlite3";

interface SignalRow {
  id?: number;
  alert_id: string;
  source: string;
  asset: string;
  side: string;
  entry_price: number | null;
  stop_loss: number | null;
  take_profits: string;
  risk_check_passed: number;
  risk_check_reason: string | null;
  created_at?: string;
}

interface OrderRow {
  id?: number;
  signal_id: number;
  hl_order_id: string | null;
  coin: string;
  side: string;
  size: number;
  price: number | null;
  order_type: string;
  tag: string;
  status: string;
  mode: string;
  created_at?: string;
  filled_at: string | null;
}

interface FillRow {
  id?: number;
  order_id: number;
  price: number;
  size: number;
  fee: number;
  timestamp: string;
}

interface EquitySnapshotRow {
  id?: number;
  timestamp: string;
  equity: number;
  unrealized_pnl: number;
  realized_pnl: number;
  open_positions: number;
}

export class SqliteStore {
  private db: Database.Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY,
        alert_id TEXT UNIQUE NOT NULL,
        source TEXT NOT NULL,
        asset TEXT NOT NULL,
        side TEXT NOT NULL,
        entry_price REAL,
        stop_loss REAL,
        take_profits TEXT,
        risk_check_passed INTEGER,
        risk_check_reason TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY,
        signal_id INTEGER REFERENCES signals(id),
        hl_order_id TEXT,
        coin TEXT NOT NULL,
        side TEXT NOT NULL,
        size REAL NOT NULL,
        price REAL,
        order_type TEXT NOT NULL,
        tag TEXT NOT NULL,
        status TEXT NOT NULL,
        mode TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        filled_at TEXT
      );

      CREATE TABLE IF NOT EXISTS fills (
        id INTEGER PRIMARY KEY,
        order_id INTEGER REFERENCES orders(id),
        price REAL NOT NULL,
        size REAL NOT NULL,
        fee REAL NOT NULL,
        timestamp TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS equity_snapshots (
        id INTEGER PRIMARY KEY,
        timestamp TEXT NOT NULL,
        equity REAL NOT NULL,
        unrealized_pnl REAL NOT NULL,
        realized_pnl REAL NOT NULL,
        open_positions INTEGER NOT NULL
      );
    `);
  }

  insertSignal(row: Omit<SignalRow, "id" | "created_at">): number {
    const stmt = this.db.prepare(`
      INSERT INTO signals (alert_id, source, asset, side, entry_price, stop_loss, take_profits, risk_check_passed, risk_check_reason)
      VALUES (@alert_id, @source, @asset, @side, @entry_price, @stop_loss, @take_profits, @risk_check_passed, @risk_check_reason)
    `);
    const result = stmt.run(row);
    return result.lastInsertRowid as number;
  }

  hasSignal(alertId: string): boolean {
    const row = this.db.prepare("SELECT 1 FROM signals WHERE alert_id = ?").get(alertId);
    return row !== undefined;
  }

  insertOrder(row: Omit<OrderRow, "id" | "created_at">): number {
    const stmt = this.db.prepare(`
      INSERT INTO orders (signal_id, hl_order_id, coin, side, size, price, order_type, tag, status, mode, filled_at)
      VALUES (@signal_id, @hl_order_id, @coin, @side, @size, @price, @order_type, @tag, @status, @mode, @filled_at)
    `);
    const result = stmt.run(row);
    return result.lastInsertRowid as number;
  }

  updateOrderStatus(orderId: number, status: string, filledAt?: string): void {
    this.db.prepare("UPDATE orders SET status = ?, filled_at = ? WHERE id = ?").run(status, filledAt ?? null, orderId);
  }

  updateOrderHlId(orderId: number, hlOrderId: string): void {
    this.db.prepare("UPDATE orders SET hl_order_id = ? WHERE id = ?").run(hlOrderId, orderId);
  }

  insertFill(row: Omit<FillRow, "id">): number {
    const stmt = this.db.prepare(`
      INSERT INTO fills (order_id, price, size, fee, timestamp)
      VALUES (@order_id, @price, @size, @fee, @timestamp)
    `);
    const result = stmt.run(row);
    return result.lastInsertRowid as number;
  }

  insertEquitySnapshot(row: Omit<EquitySnapshotRow, "id">): number {
    const stmt = this.db.prepare(`
      INSERT INTO equity_snapshots (timestamp, equity, unrealized_pnl, realized_pnl, open_positions)
      VALUES (@timestamp, @equity, @unrealized_pnl, @realized_pnl, @open_positions)
    `);
    const result = stmt.run(row);
    return result.lastInsertRowid as number;
  }

  getOrderByHlOid(hlOid: string): OrderRow | null {
    const row = this.db.prepare("SELECT * FROM orders WHERE hl_order_id = ? LIMIT 1").get(hlOid) as OrderRow | undefined;
    return row ?? null;
  }

  getPendingOrders(): OrderRow[] {
    return this.db.prepare("SELECT * FROM orders WHERE status = 'pending'").all() as OrderRow[];
  }

  getRecentOrders(limit: number = 50): OrderRow[] {
    return this.db.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT ?").all(limit) as OrderRow[];
  }

  getRecentSignals(limit: number = 50): SignalRow[] {
    return this.db.prepare("SELECT * FROM signals ORDER BY id DESC LIMIT ?").all(limit) as SignalRow[];
  }

  getEquitySnapshots(limit: number = 500): EquitySnapshotRow[] {
    return this.db.prepare("SELECT * FROM equity_snapshots ORDER BY id DESC LIMIT ?").all(limit) as EquitySnapshotRow[];
  }

  getTodayTradeCount(asset: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM signals
      WHERE asset = ? AND risk_check_passed = 1
      AND created_at >= datetime('now', 'start of day')
    `).get(asset) as { cnt: number } | undefined;
    return row?.cnt ?? 0;
  }

  getTodayRealizedPnl(): number {
    const row = this.db.prepare(`
      SELECT COALESCE(SUM(f.price * f.size - o.price * o.size), 0) as pnl
      FROM fills f
      JOIN orders o ON f.order_id = o.id
      WHERE f.timestamp >= datetime('now', 'start of day')
    `).get() as { pnl: number } | undefined;
    return row?.pnl ?? 0;
  }

  close(): void {
    this.db.close();
  }
}
