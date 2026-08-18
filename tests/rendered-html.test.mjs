import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("the root route opens the full Rig Editor directly", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Rig Editor/);
  assert.match(html, /Loading rig editor/);
  assert.doesNotMatch(html, /One rig|Every loadout/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("server-renders the interactive Rig Lab route", async () => {
  const response = await render("/rig-lab");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Rig Lab/);
  assert.match(html, /Development runtime/);
  assert.match(html, /Animation/);
  assert.match(html, /Equipment/);
});

test("server-renders the visual Rig Editor route", async () => {
  const response = await render("/rig-editor");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Rig Editor/);
  assert.match(html, /Loading rig editor/);
});

test("server-renders the full character runtime compatibility route", async () => {
  const response = await render("/game-pilot");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Character Runtime/);
  assert.match(html, /Full modular access/);
  assert.match(html, /DEV VISUAL INSPECTOR/);
});

test("server-renders the Create Character pipeline", async () => {
  const response = await render("/create-character");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Create Character/);
  assert.match(html, /Describe the source art you need to rig/);
  assert.match(html, /Generate character/);
});
