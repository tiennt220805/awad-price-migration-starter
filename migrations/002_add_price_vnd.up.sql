-- Expand: add the new column next to `price`. Nullable and without a default,
-- so SQLite only changes the schema and does not rewrite 20,000 rows; v1 never
-- selects it, so v1 keeps working on this schema.
ALTER TABLE menu_items ADD COLUMN price_vnd INTEGER CHECK (price_vnd > 0);   -- dong
