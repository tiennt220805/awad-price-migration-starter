import { createServer } from 'node:http';

// v4 of the menu service: neither READS nor WRITES the `price` column. Only
// price_vnd (dong, INTEGER) is touched. Responses still carry `price` (thousands,
// price_vnd / 1000) for old clients, and `priceVnd`, so no client notices.
// From the moment an instance runs v4, rows it writes leave `price` behind: a
// rollback to v2 (reads `price`) is no longer safe, a rollback to v3 still is.
// Once every instance runs v4, migration 003 can drop the column.

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const error = (res, status, code, message) => json(res, status, { error: code, message });

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return null; }
}

const isPrice = (p) => typeof p === 'number' && Number.isFinite(p) && p > 0 && p <= 100000;
const isVnd = (p) => Number.isInteger(p) && p > 0 && p <= 100000 * 1000;

// -> { price } (thousands) | { vnd } (dong) | null when invalid or both given and they disagree
function parsePrice(body) {
  const hasPrice = body.price !== undefined;
  const hasVnd = body.priceVnd !== undefined;
  if (hasPrice && !isPrice(body.price)) return null;
  if (hasVnd && !isVnd(body.priceVnd)) return null;
  if (hasPrice && hasVnd && Math.round(body.price * 1000) !== body.priceVnd) return null;
  if (hasVnd) return { vnd: body.priceVnd };
  if (hasPrice) return { price: body.price };
  return null;
}

export function createApp(db) {
  // For an old client's `price` the value is computed by SQLite with exactly the
  // formula scripts/check.js and the backfill use, so none of them can disagree
  // on rounding.
  const q = {
    list: db.prepare('SELECT id, name, price_vnd FROM menu_items ORDER BY id LIMIT ? OFFSET ?'),
    get: db.prepare('SELECT id, name, price_vnd FROM menu_items WHERE id = ?'),
    insertPrice: db.prepare('INSERT INTO menu_items (name, price_vnd) VALUES (?, CAST(round(? * 1000) AS INTEGER))'),
    insertVnd: db.prepare('INSERT INTO menu_items (name, price_vnd) VALUES (?, ?)'),
    setPrice: db.prepare('UPDATE menu_items SET price_vnd = CAST(round(? * 1000) AS INTEGER) WHERE id = ?'),
    setVnd: db.prepare('UPDATE menu_items SET price_vnd = ? WHERE id = ?'),
    insertOrder: db.prepare("INSERT INTO orders (created_at) VALUES (datetime('now'))"),
    insertLine: db.prepare('INSERT INTO order_items (order_id, menu_item_id, qty, unit_price) VALUES (?, ?, ?, ?)'),
  };

  // price in thousands, as old clients and order_items.unit_price expect
  const thousands = (row) => (row.price_vnd == null ? null : row.price_vnd / 1000);
  const view = (row) => ({ id: row.id, name: row.name, price: thousands(row), priceVnd: row.price_vnd });

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });

    if (parts[0] === 'menu' && parts.length === 1) {
      if (req.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
        const offset = Number(url.searchParams.get('offset') ?? 0);
        return json(res, 200, q.list.all(limit, offset).map(view));
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        const p = body && typeof body.name === 'string' && body.name ? parsePrice(body) : null;
        if (!p)
          return error(res, 400, 'invalid_body', 'name (string) and price (thousands of dong) or priceVnd (dong) are required');
        const { lastInsertRowid } = p.vnd !== undefined
          ? q.insertVnd.run(body.name, p.vnd)
          : q.insertPrice.run(body.name, p.price);
        return json(res, 201, view(q.get.get(lastInsertRowid)));
      }
    }

    if (parts[0] === 'menu' && parts.length === 2) {
      const id = Number(parts[1]);
      const row = Number.isInteger(id) ? q.get.get(id) : undefined;
      if (!row) return error(res, 404, 'not_found', `menu item ${parts[1]} not found`);
      if (req.method === 'GET') return json(res, 200, view(row));
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        const p = body ? parsePrice(body) : null;
        if (!p)
          return error(res, 400, 'invalid_body', 'price (thousands of dong) or priceVnd (dong) is required');
        if (p.vnd !== undefined) q.setVnd.run(p.vnd, id);
        else q.setPrice.run(p.price, id);
        return json(res, 200, view(q.get.get(id)));
      }
    }

    if (req.method === 'POST' && url.pathname === '/orders') {
      const body = await readBody(req);
      if (!body || !Array.isArray(body.items) || body.items.length === 0)
        return error(res, 400, 'invalid_body', 'items: [{menuItemId, qty}] is required');
      db.exec('BEGIN IMMEDIATE');
      try {
        const { lastInsertRowid: orderId } = q.insertOrder.run();
        let total = 0;
        for (const { menuItemId, qty } of body.items) {
          const item = q.get.get(menuItemId);
          if (!item || !Number.isInteger(qty) || qty < 1) throw Object.assign(new Error(), { status: 400 });
          const unit = thousands(item);
          q.insertLine.run(orderId, item.id, qty, unit);
          total += unit * qty;
        }
        db.exec('COMMIT');
        return json(res, 201, { id: Number(orderId), total: Math.round(total * 1000) / 1000 });
      } catch (e) {
        db.exec('ROLLBACK');
        if (e.status === 400) return error(res, 400, 'invalid_item', 'unknown menuItemId or bad qty');
        throw e;
      }
    }

    return error(res, 404, 'not_found', 'no such route');
  }

  return createServer((req, res) => {
    handle(req, res).catch((e) => {
      console.error(e);
      if (!res.headersSent) error(res, 500, 'internal', e.message);
    });
  });
}
