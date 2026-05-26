// Per-series voucher number cursor (cursor-allocation model).
//
// Replaces the chunk-reservation flow from migration 006. Instead of pre-
// reserving a block of numbers, each device keeps a single running cursor per
// (organization_id, document_type, fy) and hands out numbers one at a time.
//
// On reconnect, locally-issued numbers are pushed via the server RPC
// `commit_voucher_batch`. If the server's counter has moved ahead (another
// device billed online while we were offline), the server renumbers our batch
// to the tail and returns the mapping. The client then rewrites the affected
// rows + soft-copy references (sales_returns.original_invoice_number,
// purchase_returns.original_invoice_number, journal_entry_*.document_reference).
//
// `last_known_server_number` is what we last observed the server's counter to
// be at the moment we synced — used by warmupVoucherSeries() to snap the local
// cursor forward when a fresh online session begins on a device that has been
// idle.
//
// `local_next_number` is the next number to be handed out by
// reserveVoucherNumber(). It is monotonic per row and only ever decreases via
// the explicit "rewind on cancel" path in markVoucherCancelled().
//
// The old voucher_reservations table is intentionally left in place; the new
// voucherService.ts simply stops reading it. A later migration can drop it.
export const SQL_014_VOUCHER_SERIES_STATE = `
CREATE TABLE IF NOT EXISTS voucher_series_state (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  document_type TEXT NOT NULL,
  fy TEXT NOT NULL,
  last_known_server_number INTEGER NOT NULL DEFAULT 0,
  local_next_number INTEGER NOT NULL,
  last_synced_at INTEGER NOT NULL,
  UNIQUE(organization_id, document_type, fy)
);
CREATE INDEX IF NOT EXISTS idx_vss_lookup
  ON voucher_series_state(organization_id, document_type, fy);
`;
