export interface Order {
  id: string;
  amount: number; // cents
  note?: string;
}

const orders: Order[] = [];

export function listOrders(): Order[] {
  return orders;
}

export function addOrder(order: Order): void {
  orders.push(order);
}
