-- Contract: remove the old column. POINT OF NO RETURN of this migration (see
-- MIGRATION.md §3). Run it only when EVERY instance runs v4 (no version that
-- reads or writes `price` is still serving) and after taking a copy of the
-- database file.
ALTER TABLE menu_items DROP COLUMN price;
