-- Rebuild `price` (thousands of dong) from price_vnd. This RECOMPUTES the
-- column; it does not restore the values that were stored before the drop. The
-- backup taken before 003 is the only copy of those. v3 and v4 work after this
-- (neither reads `price`); v2 and v1 read the recomputed values, which match
-- price_vnd at this moment but are not kept in step by v4 afterwards.
ALTER TABLE menu_items ADD COLUMN price REAL CHECK (price > 0);
UPDATE menu_items SET price = price_vnd / 1000.0 WHERE price_vnd IS NOT NULL;
