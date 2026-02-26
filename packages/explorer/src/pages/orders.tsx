import { useCallback } from "react";
import { api } from "../lib/api.js";
import { usePoll } from "../lib/use-poll.js";
import { OrderTable } from "../components/order-table.js";

export function Orders() {
  const { data, loading } = usePoll(useCallback(() => api.orders(), []), 5000);

  return (
    <div>
      <h2 className="text-lg font-semibold mb-3">Orders</h2>
      <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
        {loading ? (
          <p className="text-gray-500 text-sm">Loading...</p>
        ) : (
          <OrderTable orders={data?.orders ?? []} />
        )}
      </div>
    </div>
  );
}
