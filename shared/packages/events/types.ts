export interface OrderCreatedEvent {
    orderId: number;
    userId: number;
    items: {
        itemId: number;
        quantity: number;
    }[];
}