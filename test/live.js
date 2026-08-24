#!/usr/bin/env node
/**
 * Live end-to-end on Base Sepolia itself — real transactions, real gas, no fork.
 *
 * The fork suite (test/e2e.js) proves the contract logic and the app's encoding.
 * This proves the same encoding lands on the public chain and that the resulting
 * event is readable by the deployed frontend. It registers one allowlist+public
 * event with a real SVG, sets nothing it cannot afford to set permanently, mints
 * it three ways from throwaway keys funded out of the main wallet, and prints
 * every transaction hash so a reviewer can check them on BaseScan.
 *
 *   node test/live.js            # dry run: encodes, simulates, prices, sends nothing
 *   node test/live.js --send
 */
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const NM = process.env.NODE_MODULES ||
  path.join(process.env.HOME || "/home/agent", "work/nftbridge/node_modules");
const ethers = require(path.join(NM, "ethers"));

const ROOT = path.join(__dirname, "..");
const RPC = process.env.RPC || "https://base-sepolia-rpc.publicnode.com";
const CHAIN_ID = 84532;
const CONTRACT = "0xC3249356a483fbe17d5355D39105D2eA666d9de6";
const KEYS = process.env.KEYS || "/home/agent/work/wallet/keys.json";

// Load the app's own modules, so this exercises the shipped encoding.
const sandbox = { ethers, console, atob: (b) => Buffer.from(b, "base64").toString("binary"),
                  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
                  escape, unescape, TextEncoder, TextDecoder, Date, Math, JSON, Object, Array,
                  BigInt, Number, String, Boolean, Error, RegExp, parseInt, parseFloat, isNaN };
sandbox.window = sandbox; sandbox.global = sandbox;
vm.createContext(sandbox);
for (const f of ["js/poap.js", "js/merkle.js", "js/svgopt.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}
const POAP = sandbox.POAP, Merkle = sandbox.Merkle, SvgOpt = sandbox.SvgOpt;

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <!-- registered by test/live.js against the live Base Sepolia deployment -->
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#a78bfa"/>
  </linearGradient></defs>
  <rect width="200" height="200" fill="#0a0c10"/>
  <circle cx="100" cy="88" r="52.000000" fill="none" stroke="url(#g)" stroke-width="6"/>
  <circle cx="100" cy="88" r="19.500000" fill="url(#g)"/>
  <text x="100" y="162" fill="#8b98ab" font-family="monospace" font-size="14"
        text-anchor="middle">poidh base #348</text>
</svg>`;

const send = process.argv.includes("--send");
const log = [];
function note(k, v) { log.push([k, v]); console.log(`  ${k.padEnd(26)} ${v}`); }

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true });
  const key = JSON.parse(fs.readFileSync(KEYS, "utf8")).privateKey;
  const main = new ethers.NonceManager(new ethers.Wallet(key, provider));
  const mainAddr = await main.getAddress();
  const bal = await provider.getBalance(mainAddr);
  console.log(`creator ${mainAddr}  ${ethers.formatEther(bal)} ETH on Base Sepolia\n`);
  if (bal === 0n) throw new Error("no Base Sepolia ETH at " + mainAddr);

  const c = new ethers.Contract(CONTRACT, POAP.ABI, main);
  const opt = SvgOpt.optimize(SVG);
  note("svg optimised", `${opt.originalBytes} -> ${opt.bytes} bytes (-${opt.savedPct}%)`);

  // Throwaway minters, derived deterministically from the creator key so the run
  // is reproducible and no key is ever written to disk.
  const seed = ethers.keccak256(ethers.toUtf8Bytes(key + ":poidh348:live"));
  const minters = [0, 1].map((i) => new ethers.NonceManager(
    new ethers.Wallet(ethers.keccak256(ethers.concat([seed, ethers.toBeHex(i, 1)])), provider)));
  const mAddr = await Promise.all(minters.map((m) => m.getAddress()));
  for (const a of mAddr) {
    if ((await provider.getCode(a)) !== "0x") throw new Error("minter has code: " + a);
  }
  note("minters", mAddr.join(" "));

  const tree = Merkle.build([mAddr[0], mainAddr, "0x000000000000000000000000000000000000dEaD"]);
  const proof = Merkle.proofFor(tree, mAddr[0]);
  note("allowlist root", tree.root);
  note("proof verifies locally", String(Merkle.verifyLocal(tree.root, mAddr[0], proof)));

  const now = Math.floor(Date.now() / 1000);
  const args = ["Onchain POAPs frontend — live test",
                "Registered by test/live.js through the shipped app encoding, for poidh Base #348.",
                now, "Base Sepolia", tree.root, opt.svg,
                "https://poaps.agentatwork.xyz", POAP.flagsFor(false, true)];

  await c.registerEvent.staticCall(...args);
  const gas = await c.registerEvent.estimateGas(...args);
  const fee = await provider.getFeeData();
  note("registerEvent gas", `${gas} @ ${ethers.formatUnits(fee.maxFeePerGas ?? fee.gasPrice, "gwei")} gwei ` +
       `= ${ethers.formatEther(gas * (fee.maxFeePerGas ?? fee.gasPrice))} ETH`);

  if (!send) { console.log("\ndry run — nothing sent. Re-run with --send.\n"); return; }

  let rc = await (await c.registerEvent(...args)).wait();
  const id = rc.logs.map((l) => { try { return POAP.IFACE.parseLog(l); } catch { return null; } })
                    .filter((p) => p && p.name === "NewEvent").map((p) => Number(p.args[0]))[0];
  note("registerEvent tx", rc.hash);
  note("event id", String(id));

  // Fund the minters out of the creator wallet: a few thousand gwei each.
  for (const a of mAddr) {
    const t = await main.sendTransaction({ to: a, value: ethers.parseEther("0.0004") });
    await t.wait();
  }
  note("minters funded", "0.0004 ETH each");

  rc = await (await c.connect(minters[0]).allowlistMint(id, proof)).wait();
  note("allowlistMint tx", rc.hash);
  rc = await (await c.connect(minters[1]).mint(id)).wait();
  note("public mint tx", rc.hash);

  const sig = await POAP.signFor(main, id, CHAIN_ID, "0x000000000000000000000000000000000000dEaD");
  note("signature for 0x…dEaD", sig.slice(0, 26) + "…");
  note("recovers to creator",
       String(POAP.recoverSigner(id, CHAIN_ID, "0x000000000000000000000000000000000000dEaD", sig)
              .toLowerCase() === mainAddr.toLowerCase()));

  const uri = await c.uri(id);
  const meta = JSON.parse(POAP.decodeDataUri(uri));
  note("uri() parses", `name="${meta.name}", ${uri.length} chars`);
  note("balances", `${await c.balanceOf(mAddr[0], id)} / ${await c.balanceOf(mAddr[1], id)}`);
  note("view it", `https://poaps.agentatwork.xyz/#/event/${id}`);
  note("basescan", `https://sepolia.basescan.org/token/${CONTRACT}?a=${id}`);

  fs.writeFileSync(path.join(ROOT, "test", "live-results.txt"),
    log.map(([k, v]) => `${k.padEnd(26)} ${v}`).join("\n") + "\n");
  console.log("\nwrote test/live-results.txt\n");
})().catch((e) => { console.error("FAILED:", e.shortMessage || e.message); process.exit(1); });
