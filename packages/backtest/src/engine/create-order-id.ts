let nextOrderId = 0;

export function createOrderId(): string {
  return `ord_${++nextOrderId}`;
}

export function resetOrderIdCounter(): void {
  nextOrderId = 0;
}
