-- Undo the expand. Safe while only v1 runs: nothing reads or writes price_vnd.
-- After v2 is deployed, redeploy v1 on every instance BEFORE running this.
ALTER TABLE menu_items DROP COLUMN price_vnd;
