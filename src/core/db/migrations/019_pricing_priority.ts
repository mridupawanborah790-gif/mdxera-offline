/**
 * Migration 019: Add pricing_priority column to SQLite configurations table.
 *
 * The pricing_priority field stores the user's preferred price resolution order
 * (customer_price_master / material_price_master / inventory) as a JSON string.
 * Without this column, adaptRowForSqlite() drops the field on every write and
 * the user's saved priority order is silently discarded.
 */
export const SQL_019_PRICING_PRIORITY = `
ALTER TABLE configurations ADD COLUMN pricing_priority TEXT;
`;
