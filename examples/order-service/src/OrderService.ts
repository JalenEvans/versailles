/**
 * OrderService — the minimal reference domain for the Versailles example
 * workspace (VERSAILLES-17). One invariant (`balance >= 0`) and one operation
 * with a pre/postcondition pair (`addItem`). All preconditions are expressed
 * inline — grammar-expressible clauses, no named predicates.
 */

/** An order accumulates a non-negative balance as items are added. */
export class OrderService {
	private balance: number;

	constructor() {
		this.balance = 0;
	}

	/**
	 * Adds an item to the order. Preconditions: sku is non-empty and price is
	 * positive. Postcondition: balance == old(balance) + price.
	 */
	addItem(sku: string, price: number): void {
		if (sku === "") {
			throw new Error("sku must not be empty");
		}
		if (price <= 0) {
			throw new Error("price must be positive");
		}
		this.balance += price;
	}
}
