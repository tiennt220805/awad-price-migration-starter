import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { open } from '../src/db.js';
import { createApp } from '../src/app.js';

let server, base, db;
before(async () => {
  db = open(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.up.sql')).sort())
    db.exec(readFileSync(new URL(f, dir), 'utf8'));          // every migration, in order
  // v4 only knows price_vnd. (Written without `price`, so this test also passes
  // after migration 003 has dropped that column.)
  db.exec("INSERT INTO menu_items (name, price_vnd) VALUES ('Phở bò', 45500), ('Trà đá', 5000)");
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const priceVnd = (id) => db.prepare('SELECT price_vnd FROM menu_items WHERE id = ?').get(id).price_vnd;

test('GET /menu/:id returns price in thousands of dong, and priceVnd', async () => {
  assert.deepEqual(await call('GET', '/menu/1'), { status: 200, body: { id: 1, name: 'Phở bò', price: 45.5, priceVnd: 45500 } });
});

test('PATCH with price (old client) stores dong in price_vnd', async () => {
  const r = await call('PATCH', '/menu/2', { price: 6 });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 6);
  assert.equal(r.body.priceVnd, 6000);
  assert.equal(priceVnd(2), 6000);
});

test('PATCH with priceVnd (new client) stores it as is', async () => {
  const r = await call('PATCH', '/menu/2', { priceVnd: 7500 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: 2, name: 'Trà đá', price: 7.5, priceVnd: 7500 });
  assert.equal(priceVnd(2), 7500);
});

test('POST /menu stores price_vnd whichever unit the client sends', async () => {
  const a = await call('POST', '/menu', { name: 'Chè', price: 12.5 });
  assert.equal(a.status, 201);
  assert.deepEqual(a.body, { id: a.body.id, name: 'Chè', price: 12.5, priceVnd: 12500 });
  assert.equal(priceVnd(a.body.id), 12500);
  const b = await call('POST', '/menu', { name: 'Bún', priceVnd: 30000 });
  assert.equal(b.status, 201);
  assert.equal(priceVnd(b.body.id), 30000);
});

test('v4 never touches the price column', async () => {
  const cols = db.prepare('PRAGMA table_info(menu_items)').all().map((c) => c.name);
  if (!cols.includes('price')) return;                        // after migration 003 it is gone
  const a = await call('POST', '/menu', { name: 'Không đụng', price: 9 });
  assert.equal(db.prepare('SELECT price FROM menu_items WHERE id = ?').get(a.body.id).price, null);
});

test('price and priceVnd that disagree are rejected', async () => {
  assert.equal((await call('PATCH', '/menu/1', { price: 45.5, priceVnd: 1 })).status, 400);
  assert.equal((await call('PATCH', '/menu/1', { priceVnd: 45.5 })).status, 400);
});

test('POST /orders totals at the current price', async () => {
  const r = await call('POST', '/orders', { items: [{ menuItemId: 1, qty: 2 }, { menuItemId: 2, qty: 1 }] });
  assert.equal(r.status, 201);
  assert.equal(r.body.total, 98.5);   // 45.5 * 2 + 7.5 (item 2 was re-priced above)
});

test('errors have one shape', async () => {
  assert.deepEqual((await call('GET', '/menu/999')).body.error, 'not_found');
  assert.equal((await call('PATCH', '/menu/1', { price: -1 })).status, 400);
});
