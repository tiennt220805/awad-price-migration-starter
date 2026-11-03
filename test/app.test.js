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
  // as in production while v2 runs: rows from before the backfill have no price_vnd yet
  db.exec("INSERT INTO menu_items (name, price) VALUES ('Phở bò', 45.5), ('Trà đá', 5)");
  server = createApp(db).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const call = async (method, path, body) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};
const columns = (id) => db.prepare('SELECT price, price_vnd FROM menu_items WHERE id = ?').get(id);

test('GET /menu/:id returns price in thousands of dong, and priceVnd', async () => {
  assert.deepEqual(await call('GET', '/menu/1'), { status: 200, body: { id: 1, name: 'Phở bò', price: 45.5, priceVnd: 45500 } });
});

test('PATCH with price (old client) writes both columns', async () => {
  const r = await call('PATCH', '/menu/2', { price: 6 });
  assert.equal(r.status, 200);
  assert.equal(r.body.price, 6);
  assert.equal(r.body.priceVnd, 6000);
  assert.deepEqual({ ...columns(2) }, { price: 6, price_vnd: 6000 });
});

test('PATCH with priceVnd (new client) writes both columns', async () => {
  const r = await call('PATCH', '/menu/2', { priceVnd: 7500 });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { id: 2, name: 'Trà đá', price: 7.5, priceVnd: 7500 });
  assert.deepEqual({ ...columns(2) }, { price: 7.5, price_vnd: 7500 });
});

test('POST /menu writes both columns whichever unit the client sends', async () => {
  const a = await call('POST', '/menu', { name: 'Chè', price: 12.5 });
  assert.equal(a.status, 201);
  assert.deepEqual({ ...columns(a.body.id) }, { price: 12.5, price_vnd: 12500 });
  const b = await call('POST', '/menu', { name: 'Bún', priceVnd: 30000 });
  assert.equal(b.status, 201);
  assert.deepEqual({ ...columns(b.body.id) }, { price: 30, price_vnd: 30000 });
});

test('a row from before the backfill still answers with priceVnd, derived from price', async () => {
  db.exec("INSERT INTO menu_items (name, price) VALUES ('Cũ', 20)");   // price_vnd stays NULL
  const id = db.prepare('SELECT max(id) id FROM menu_items').get().id;
  assert.equal(columns(id).price_vnd, null);
  assert.deepEqual((await call('GET', `/menu/${id}`)).body, { id, name: 'Cũ', price: 20, priceVnd: 20000 });
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
