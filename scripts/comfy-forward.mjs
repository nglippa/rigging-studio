#!/usr/bin/env node
/**
 * Forwards 127.0.0.1:<port> to a ComfyUI that listens on another local interface (on the Mac Studio, ComfyUI listens on
 * its private 10.77.77.2 address). The app only talks to ComfyUI on localhost (validateComfyBaseUrl), so on the machine
 * that runs ComfyUI this does what the SSH tunnel does on any other machine: COMFYUI_BASE_URL stays http://127.0.0.1:8188.
 *
 *   COMFYUI_FORWARD_TARGET=10.77.77.2:8192 node scripts/comfy-forward.mjs   (listen port: COMFYUI_FORWARD_PORT, default 8188)
 *
 * No dependencies; binds to loopback only.
 */
import net from "node:net";

const target = process.env.COMFYUI_FORWARD_TARGET;
if (!target || !/^[\w.-]+:\d+$/.test(target)) {
  console.error("Set COMFYUI_FORWARD_TARGET to host:port of the ComfyUI server, e.g. 10.77.77.2:8192");
  process.exit(1);
}
const [host, port] = [target.slice(0, target.lastIndexOf(":")), Number(target.slice(target.lastIndexOf(":") + 1))];
const listenPort = Number(process.env.COMFYUI_FORWARD_PORT ?? 8188);

const server = net.createServer((client) => {
  const upstream = net.connect({ host, port });
  client.pipe(upstream); upstream.pipe(client);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("error", close); upstream.on("error", close); client.on("close", close); upstream.on("close", close);
});
server.on("error", (error) => { console.error(`ComfyUI forward failed: ${error.message}`); process.exit(1); });
server.listen(listenPort, "127.0.0.1", () => console.log(`ComfyUI forward ready: 127.0.0.1:${listenPort} -> ${host}:${port}`));
