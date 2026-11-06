import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startHttp } from "../src/http.js";
import { Store, verifyAuditLog } from "../src/store.js";
import { intent, setup } from "./helpers.js";

function freshStore(auditKey?: string) {
  return new Store(mkdtempSync(join(tmpdir(), "pursestring-audit-")), { auditKey });
}

function writeSome(store: Store, n = 5) {
  for (let i = 1; i <= n; i++) store.audit("test_event", { intent_id: `int_${i}`, amount: i * 10 });
}

const lines = (store: Store) => readFileSync(store.auditPath, "utf8").trim().split("\n");
const save = (store: Store, ls: string[]) => writeFileSync(store.auditPath, ls.join("\n") + "\n");

test("every audit entry is chained to the one before it", async () => {
  const { gov, store } = setup();
  await gov.submitIntent(intent());
  gov.checkCompliance(intent({ amount: 20 }));
  const entries = store.readAudit();
  assert.ok(entries.length >= 2);
  entries.forEach((e, i) => {
    assert.equal(e.seq, i + 1);
    assert.match(String(e.hash), /^sha256:[0-9a-f]{64}$/);
    assert.equal(e.prev, i === 0 ? "0".repeat(64) : entries[i - 1].hash);
  });
  const r = store.verifyAudit();
  assert.equal(r.ok, true);
  assert.equal(r.entries, entries.length);
  assert.equal(r.head, entries.at(-1)!.hash);
});

test("an empty log verifies", () => {
  const r = freshStore().verifyAudit();
  assert.deepEqual(r, { ok: true, entries: 0, legacy_entries: 0, mode: null, head: null });
});

test("editing an entry breaks the chain at that entry", () => {
  const store = freshStore();
  writeSome(store);
  const ls = lines(store);
  ls[2] = ls[2].replace('"amount":30', '"amount":3');
  save(store, ls);
  const r = store.verifyAudit();
  assert.equal(r.ok, false);
  assert.deepEqual(r.broken_at, { line: 3, seq: 3, reason: "hash mismatch: entry was edited" });
});

test("deleting, inserting or reordering entries is caught", () => {
  const store = freshStore();
  writeSome(store);
  const original = lines(store);

  save(store, original.filter((_, i) => i !== 1));
  assert.equal(store.verifyAudit().broken_at?.line, 2, "deleted entry");

  save(store, [original[0], original[2], original[1], ...original.slice(3)]);
  assert.equal(store.verifyAudit().broken_at?.line, 2, "swapped entries");

  save(store, [...original.slice(0, 2), JSON.stringify({ ts: "x", event: "forged" }), ...original.slice(2)]);
  assert.equal(store.verifyAudit().broken_at?.reason, "entry has no hash: added or edited outside PurseString");
});

test("rewriting the whole chain with fresh hashes is caught when a key is set", () => {
  const key = "audit-key-for-tests";
  const store = freshStore(key);
  writeSome(store, 3);
  assert.match(String(store.readAudit()[0].hash), /^hmac:/);
  assert.equal(store.verifyAudit().ok, true);
  assert.equal(store.verifyAudit().mode, "hmac");

  // An attacker without the key rebuilds the chain as plain SHA-256 after changing an amount.
  const forger = freshStore();
  const ls = lines(store).map((l) => JSON.parse(l));
  for (const e of ls) {
    const { ts: _ts, event, seq: _s, prev: _p, hash: _h, ...rest } = e;
    forger.audit(event, { ...rest, amount: 1 });
  }
  // A plain chain is not accepted where a key is expected...
  const plain = verifyAuditLog(readFileSync(forger.auditPath, "utf8"), key);
  assert.equal(plain.ok, false);
  assert.match(plain.broken_at!.reason, /no entry is keyed/);
  // ...and relabelling it as HMAC doesn't make the hashes match.
  const r = verifyAuditLog(readFileSync(forger.auditPath, "utf8").replace(/"sha256:/g, '"hmac:'), key);
  assert.equal(r.ok, false);
  assert.equal(r.broken_at?.line, 1);

  // Without the key a keyed log can't be checked, and says so.
  assert.match(verifyAuditLog(readFileSync(store.auditPath, "utf8")).broken_at!.reason, /PURSESTRING_AUDIT_KEY/);
  // With the wrong key it fails.
  assert.equal(verifyAuditLog(readFileSync(store.auditPath, "utf8"), "wrong").ok, false);
});

test("a key can be turned on for an existing log, but not off", () => {
  const key = "audit-key-for-tests";
  const dir = mkdtempSync(join(tmpdir(), "pursestring-audit-"));
  writeSome(new Store(dir, { auditKey: "" }), 2);
  writeSome(new Store(dir, { auditKey: key }), 2);
  const keyed = new Store(dir, { auditKey: key });
  assert.equal(keyed.verifyAudit().ok, true);
  assert.equal(keyed.verifyAudit().mode, "hmac");
  writeSome(new Store(dir, { auditKey: "" }), 1);
  assert.equal(keyed.verifyAudit().broken_at?.reason, "entry is not keyed but earlier entries are");
});

test("logs from before chaining keep working: old lines count as legacy, new ones chain on", () => {
  const store = freshStore();
  writeFileSync(store.auditPath, ['{"ts":"2026-10-01T00:00:00.000Z","event":"old_one"}', '{"ts":"2026-10-02T00:00:00.000Z","event":"old_two"}'].join("\n") + "\n");
  writeSome(store, 2);
  const r = store.verifyAudit();
  assert.equal(r.ok, true);
  assert.equal(r.legacy_entries, 2);
  assert.equal(r.entries, 4);
  assert.equal(store.readAudit().at(-1)!.seq, 2);
});

test("GET /audit/verify reports the chain to the admin", async () => {
  const prevToken = process.env.PURSESTRING_ADMIN_TOKEN;
  process.env.PURSESTRING_ADMIN_TOKEN = "admin-token-for-tests";
  const { gov, store } = setup();
  await gov.submitIntent(intent());
  const server = startHttp(gov, 0, "127.0.0.1", { quiet: true });
  try {
    await new Promise((r) => server.once("listening", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/audit/verify`;
    assert.equal((await fetch(url)).status, 401);
    const auth = { authorization: "Bearer admin-token-for-tests" };
    const good = await fetch(url, { headers: auth });
    assert.equal(good.status, 200);
    assert.equal(((await good.json()) as { ok: boolean }).ok, true);

    const ls = lines(store);
    ls[0] = ls[0].replace('"event":"', '"event":"x');
    save(store, ls);
    const bad = await fetch(url, { headers: auth });
    assert.equal(bad.status, 409);
    assert.equal(((await bad.json()) as { broken_at: { line: number } }).broken_at.line, 1);
  } finally {
    server.close();
    if (prevToken === undefined) delete process.env.PURSESTRING_ADMIN_TOKEN;
    else process.env.PURSESTRING_ADMIN_TOKEN = prevToken;
  }
});
