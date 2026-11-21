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

// The bare root starts a newcomer on Create; the rig editor is the same route with a step (/?mode=setup|animate|export).
test("the root route starts on Create, and with a step opens the Rig Editor", async () => {
  const root = await render();
  assert.equal(root.status, 307);
  assert.match(root.headers.get("location") ?? "", /\/create-character$/);
  const response = await render("/?mode=setup");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Rig Editor/);
  // Loading renders inside the step frame (its project menu reopens the remembered project).
  assert.match(html, /Loading the rig/);
  assert.match(html, /class="step-shell/);
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
  const response = await render("/?mode=animate");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>Rig Editor/);
  assert.match(html, /Loading the rig/);
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
  // The guided Create step: the description, your own art instead, the models on the Mac Studio, and facing.
  assert.match(html, /Describe your character/);
  assert.match(html, /upload your own art/);
  assert.match(html, /Model · on the Mac Studio/);
  assert.match(html, /Facing/);
});
