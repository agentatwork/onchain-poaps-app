#!/usr/bin/env node
/**
 * End-to-end test against the real deployed contract, on a fork of Base Sepolia.
 *
 * Not a mock. anvil forks Base Sepolia at head, so every call below runs the
 * actual bytecode at 0xC3249356a483fbe17d5355D39105D2eA666d9de6 with the real
 * chain state behind it — it just funds our accounts and throws the block away
 * afterwards. That is what lets this run with no faucet and still be evidence.
 *
 * It exercises the same three files the browser app loads (js/poap.js,
 * js/merkle.js, js/svgopt.js) by evaluating them against a tiny `window` shim,
 * so a regression in the app's encoding is a regression in this test — the
 * alternative, a test that re-implements the encoding, would pass while the app
 * was broken.
 *
 *   node test/e2e.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const NM = process.env.NODE_MODULES ||
  path.join(process.env.HOME || "/home/agent", "work/nftbridge/node_modules");
const ethers = require(path.join(NM, "ethers"));
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FORK_RPC = process.env.FORK_RPC || "https://base-sepolia-rpc.publicnode.com";
const CHAIN_ID = 84532;
const CONTRACT = "0xC3249356a483fbe17d5355D39105D2eA666d9de6";

// ---- load the browser modules in a shim so we test the shipped code ----------
const sandbox = { ethers, console, atob: (b) => Buffer.from(b, "base64").toString("binary"),
                  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
                  escape, unescape, TextEncoder, TextDecoder, Date, Math, JSON, Object, Array,
                  BigInt, Number, String, Boolean, Error, RegExp, parseInt, parseFloat, isNaN };
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
for (const f of ["js/poap.js", "js/merkle.js", "js/svgopt.js"]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), sandbox, { filename: f });
}
const POAP = sandbox.POAP, Merkle = sandbox.Merkle, SvgOpt = sandbox.SvgOpt;

// ---- tiny assertion harness -------------------------------------------------
let pass = 0, fail = 0;
const results = [];
function ok(name, cond, detail) {
  if (cond) { pass++; results.push(["PASS", name, detail || ""]); }
  else { fail++; results.push(["FAIL", name, detail || ""]); }
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${detail ? "  — " + detail : ""}`);
}
// Revert assertions go through staticCall, never a real transaction. A reverting
// send still burns a nonce in the signer's local cache, and after a few of those
// ethers and anvil disagree about the next nonce and later *valid* transactions
// start failing for reasons that have nothing to do with the contract.
async function reverts(name, thunk, expectText) {
  try {
    await thunk();
    ok(name, false, "expected a revert, got success");
  } catch (e) {
    const msg = POAP.explainError(e);
    ok(name, expectText ? msg.includes(expectText) : true, msg.slice(0, 110));
  }
}

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<!-- a comment that should not survive optimisation -->' +
  '<rect width="100" height="100" fill="#101418"/>' +
  '<circle cx="50.000000" cy="50.0" r="30.123456789" fill="#7dd3fc"/></svg>';

(async () => {
  // anvil, not ganache: the contract is compiled for Cancun and its nonReentrant
  // guard uses transient storage, so an EVM without TSTORE/MCOPY reverts with a
  // bare "invalid opcode" on half the surface and looks like a bug in this app.
  console.log(`\nforking ${FORK_RPC} with anvil …`);
  const ANVIL = process.env.ANVIL || `${process.env.HOME}/.foundry/bin/anvil`;
  const server = spawn(ANVIL, ["--fork-url", FORK_RPC, "--port", "8555",
    "--accounts", "6", "--balance", "10", "--hardfork", "cancun", "--silent"],
    { stdio: ["ignore", "ignore", "inherit"] });
  server.close = () => { try { server.kill("SIGKILL"); } catch (e) {} };
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch("http://127.0.0.1:8555", { method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) break;
    } catch (e) { }
    await new Promise(r => setTimeout(r, 1000));
  }
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8555", CHAIN_ID, { staticNetwork: true });

  try {
    // Deliberately NOT anvil's built-in dev accounts. On a public testnet those
    // famous addresses (0xf39Fd…, 0x70997…) carry an EIP-7702 delegation — real
    // code, 0xef0100… — so a fork inherits it, ERC1155's acceptance check fires
    // on what you thought was an EOA, the delegate has no onERC1155Received, and
    // every mint in this file reverts with no revert data. Fresh keys have no
    // code anywhere, which is the only reliable way to test a mint on a fork.
    const mnemonicRoot = ethers.Wallet.createRandom();
    const wallets = [];
    for (let i = 0; i < 5; i++) {
      const w = new ethers.Wallet(ethers.id(mnemonicRoot.privateKey + ":" + i), provider);
      await provider.send("anvil_setBalance", [w.address, "0x56BC75E2D63100000"]); // 100 ETH
      wallets.push(w);
    }
    const A = { creator: wallets[0].address, alice: wallets[1].address, bob: wallets[2].address,
                carol: wallets[3].address, dave: wallets[4].address };
    const dave = A.dave;
    // NonceManager, because JsonRpcProvider caches eth_getTransactionCount for a
    // few hundred milliseconds and back-to-back sends from one wallet then reuse
    // a nonce. That surfaces as "nonce too low" three assertions later, which
    // reads like a contract failure and is not one.
    const [creator, alice, bob, carol, daveWallet] =
      wallets.map((w) => new ethers.NonceManager(w));
    for (const w of wallets) {
      const code = await provider.getCode(w.address);
      if (code !== "0x") throw new Error("test account " + w.address + " unexpectedly has code");
    }

    const code = await provider.getCode(CONTRACT);
    ok("fork has the deployed contract", code.length > 2, `${(code.length - 2) / 2} bytes of runtime code`);

    const c = new ethers.Contract(CONTRACT, POAP.ABI, creator);
    const before = Number(await c.totalEvents());
    ok("totalEvents reads from live state", before >= 10, `totalEvents = ${before}`);

    // ---- SVG optimiser ------------------------------------------------------
    const opt = SvgOpt.optimize(SVG);
    ok("svg optimiser drops comments", !opt.svg.includes("<!--"));
    ok("svg optimiser shortens numbers", opt.svg.includes("30.12") && !opt.svg.includes("30.123456789"));
    ok("svg optimiser reports a real saving", opt.savedBytes > 0,
       `${opt.originalBytes} → ${opt.bytes} bytes (−${opt.savedPct}%)`);
    ok("svg optimiser keeps it parseable", /^<svg[\s\S]*<\/svg>$/.test(opt.svg.trim()));

    // ---- merkle -------------------------------------------------------------
    const list = [A.alice, A.dave, "0x000000000000000000000000000000000000dEaD", A.creator];
    const tree = Merkle.build(list);
    const proofAlice = Merkle.proofFor(tree, A.alice);
    ok("merkle: local verify accepts a member", Merkle.verifyLocal(tree.root, A.alice, proofAlice));
    ok("merkle: local verify rejects a non-member",
       !Merkle.verifyLocal(tree.root, A.carol, proofAlice || []));
    ok("merkle: root is order-independent",
       Merkle.build(list.slice().reverse()).root === tree.root, tree.root);
    const single = Merkle.build([A.alice]);
    ok("merkle: single-leaf tree has root == leaf and an empty proof",
       single.root === Merkle.leafOf(A.alice) && Merkle.proofFor(single, A.alice).length === 0);
    const odd = Merkle.build([A.alice, A.bob, A.carol]);
    ok("merkle: odd leaf count verifies for every member",
       [A.alice, A.bob, A.carol].every(a => Merkle.verifyLocal(odd.root, a, Merkle.proofFor(odd, a))));
    const parsed = Merkle.parseAddresses(
      `${A.alice}\n${A.alice}\n , ${A.bob} ;\nnot-an-address\n"${A.carol}"`);
    ok("merkle: paste parser splits, dedupes and reports invalid",
       parsed.addresses.length === 3 && parsed.duplicates.length === 1 && parsed.invalid.length === 1,
       `${parsed.addresses.length} addrs / ${parsed.duplicates.length} dup / ${parsed.invalid.length} bad`);

    // ---- registerEvent ------------------------------------------------------
    const now = Math.floor(Date.now() / 1000);
    let tx = await c.registerEvent("E2E Allowlist Event", "registered by the frontend test suite",
      now, "a fork of Base Sepolia", tree.root, opt.svg, "https://example.org/e2e",
      POAP.flagsFor(false, false));
    let rc = await tx.wait();
    const evAllow = before + 1;
    ok("registerEvent mines", rc.status === 1, `gas ${rc.gasUsed}`);
    ok("registerEvent increments totalEvents", Number(await c.totalEvents()) === evAllow);

    const stored = POAP.decodeFlags(0);   // sanity on the flag helper itself
    ok("flag helper: 0 = private, transferable", !stored.isPublic && !stored.isSoulbound);
    ok("flag helper round-trips all four", [[false, false], [true, false], [false, true], [true, true]]
      .every(([sb, pub]) => {
        const d = POAP.decodeFlags(POAP.flagsFor(sb, pub));
        return d.isSoulbound === sb && d.isPublic === pub;
      }));

    const raw = await c.events(evAllow);
    ok("stored allowlist root matches the tree", raw.allowlistRoot === tree.root);
    ok("stored creator is the sender", raw.creator.toLowerCase() === A.creator.toLowerCase());
    ok("stored event is private and transferable", raw.isPublic === false && raw.isSoulbound === false);

    // ---- registerEvent validation -------------------------------------------
    await reverts("registerEvent rejects an empty name",
      () => c.registerEvent.staticCall("", "", now, "", POAP.ZERO_ROOT, opt.svg, "", 2), "Name is required");
    await reverts("registerEvent rejects an empty svg",
      () => c.registerEvent.staticCall("x", "", now, "", POAP.ZERO_ROOT, "", "", 2), "SVG image is required");
    await reverts("registerEvent rejects a 513-char description",
      () => c.registerEvent.staticCall("x", "d".repeat(513), now, "", POAP.ZERO_ROOT, opt.svg, "", 2), "512 characters");
    await reverts("registerEvent rejects flags > 3",
      () => c.registerEvent.staticCall("x", "", now, "", POAP.ZERO_ROOT, opt.svg, "", 4), "soulbound/public");

    // ---- allowlistMint ------------------------------------------------------
    const cAlice = c.connect(alice);
    rc = await (await cAlice.allowlistMint(evAllow, proofAlice)).wait();
    ok("allowlistMint succeeds with a generated proof", rc.status === 1, `gas ${rc.gasUsed}`);
    ok("allowlistMint credited the token", Number(await c.balanceOf(A.alice, evAllow)) === 1);
    await reverts("allowlistMint rejects a second claim by the same address",
      () => cAlice.allowlistMint.staticCall(evAllow, proofAlice), "already holds this POAP");
    await reverts("allowlistMint rejects a non-member reusing someone else's proof",
      () => c.connect(carol).allowlistMint.staticCall(evAllow, proofAlice), "not valid for this allowlist");
    await reverts("public mint is refused while the event is private",
      () => c.connect(carol).mint.staticCall(evAllow), "Public minting is not enabled");

    // ---- updateEventPublic --------------------------------------------------
    rc = await (await c.updateEventPublic(evAllow, true)).wait();
    ok("updateEventPublic opens public minting", rc.status === 1);
    ok("event now reads as public", (await c.events(evAllow)).isPublic === true);
    rc = await (await c.connect(carol).mint(evAllow)).wait();
    ok("public mint works once opened", rc.status === 1 && Number(await c.balanceOf(A.carol, evAllow)) === 1);
    await reverts("updateEventPublic is creator-only",
      () => c.connect(carol).updateEventPublic.staticCall(evAllow, false), "Only the address that registered");
    await reverts("updateAllowlistRoot cannot be set twice",
      () => c.updateAllowlistRoot.staticCall(evAllow, ethers.keccak256("0x1234")), "only once");

    // ---- signature mint -----------------------------------------------------
    tx = await c.registerEvent("E2E Signature Event", "signature distribution", now, "", POAP.ZERO_ROOT,
      opt.svg, "", POAP.flagsFor(true, false));
    await tx.wait();
    const evSig = evAllow + 1;
    ok("second registerEvent lands", Number(await c.totalEvents()) === evSig);
    ok("soulbound flag stored", (await c.events(evSig)).isSoulbound === true);

    const sig = await POAP.signFor(creator, evSig, CHAIN_ID, A.bob);
    ok("recoverSigner round-trips the creator's signature",
       POAP.recoverSigner(evSig, CHAIN_ID, A.bob, sig).toLowerCase() === A.creator.toLowerCase());
    ok("a signature for bob does not recover for carol",
       POAP.recoverSigner(evSig, CHAIN_ID, A.carol, sig).toLowerCase() !== A.creator.toLowerCase());
    rc = await (await c.connect(bob).mintWithSignature(evSig, sig)).wait();
    ok("mintWithSignature succeeds for the named address", rc.status === 1, `gas ${rc.gasUsed}`);
    await reverts("mintWithSignature rejects the same signature used by another address",
      () => c.connect(carol).mintWithSignature.staticCall(evSig, sig), "not produced by the event creator");
    const wrongSig = await POAP.signFor(alice, evSig, CHAIN_ID, A.carol);
    await reverts("mintWithSignature rejects a signature from a non-creator",
      () => c.connect(carol).mintWithSignature.staticCall(evSig, wrongSig), "not produced by the event creator");

    // ---- soulbound ----------------------------------------------------------
    await reverts("soulbound token cannot be transferred",
      () => c.connect(bob).safeTransferFrom.staticCall(A.bob, A.carol, evSig, 1, "0x"), "cannot leave the wallet");

    // ---- creatorMint --------------------------------------------------------
    rc = await (await c.creatorMint(evSig, [A.dave, A.bob])).wait();
    ok("creatorMint batch mines and skips an existing holder", rc.status === 1 &&
       Number(await c.balanceOf(A.dave, evSig)) === 1 && Number(await c.balanceOf(A.bob, evSig)) === 1,
       `gas ${rc.gasUsed}`);
    await reverts("creatorMint is creator-only",
      () => c.connect(carol).creatorMint.staticCall(evSig, [A.carol]), "Only the address that registered");
    await reverts("creatorMint rejects 102 recipients",
      () => c.creatorMint.staticCall(evSig, new Array(102).fill(A.dave)), "101 recipients");

    // ---- metadata -----------------------------------------------------------
    const uri = await c.uri(evSig);
    const json = POAP.decodeDataUri(uri);
    const meta = JSON.parse(json);
    ok("uri() is a base64 data URL of JSON", uri.startsWith("data:application/json;base64,"));
    ok("metadata name matches the registered name", meta.name === "E2E Signature Event");
    const svgOut = POAP.decodeDataUri(meta.image);
    ok("metadata image decodes to the SVG we registered",
       svgOut.trim() === opt.svg.trim(), `${svgOut.length} bytes back`);
    ok("metadata carries attributes", Array.isArray(meta.attributes) && meta.attributes.length > 0,
       (meta.attributes || []).map(a => a.trait_type).join(", "));

    // ---- malformed metadata --------------------------------------------------
    // The contract interpolates creator strings into its metadata JSON without
    // escaping them, so a description containing a newline produces a document
    // JSON.parse rejects. Event #6 on live Base Sepolia is already in that state.
    const bad = '{"name":"x","description":"line one\nline two","image":"data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="}';
    ok("raw metadata with a newline in a string does not parse",
       (() => { try { JSON.parse(bad); return false; } catch (e) { return true; } })());
    ok("repairJson recovers it with the text intact",
       JSON.parse(POAP.repairJson(bad)).description === "line one\nline two");
    ok("unsafeChars flags what would break it",
       Object.keys(POAP.unsafeChars("a\nb\"c")).length === 2);
    ok("sanitize produces a string that survives the round trip",
       (() => { const clean = POAP.sanitize("line one\nline two \"q\"");
                try { JSON.parse('{"d":"' + clean + '"}'); return clean.indexOf("\n") < 0; }
                catch (e) { return false; } })(), POAP.sanitize('line one\nline two "q"'));
    tx = await c.registerEvent("E2E Newline Event", "line one\nline two", now, "", POAP.ZERO_ROOT,
      opt.svg, "", POAP.flagsFor(false, true));
    await tx.wait();
    const evBad = evSig + 1;
    const badUri = POAP.decodeDataUri(await c.uri(evBad));
    ok("a newline description really does break the contract's metadata",
       (() => { try { JSON.parse(badUri); return false; } catch (e) { return true; } })());
    ok("the app still reads name and artwork from it",
       JSON.parse(POAP.repairJson(badUri)).name === "E2E Newline Event");

    // ---- timelock -----------------------------------------------------------
    await provider.send("evm_increaseTime", [31 * 24 * 3600]);
    await provider.send("evm_mine", []);
    await reverts("creator functions close after 30 days",
      () => c.updateEventPublic.staticCall(evSig, true), "30-day creator window");
    const sigLate = await POAP.signFor(creator, evSig, CHAIN_ID, A.carol);
    rc = await (await c.connect(carol).mintWithSignature(evSig, sigLate)).wait();
    ok("signature minting still works in the 7-day grace period (day 31)", rc.status === 1);
    await provider.send("evm_increaseTime", [7 * 24 * 3600]);
    await provider.send("evm_mine", []);
    const sigTooLate = await POAP.signFor(creator, evSig, CHAIN_ID, A.dave);
    await reverts("signature minting closes at day 37",
      () => c.connect(daveWallet).mintWithSignature.staticCall(evSig, sigTooLate), "");

    // ---- gallery read path ---------------------------------------------------
    const ids = [], owners = [];
    for (let i = 0; i <= evSig; i++) { ids.push(i); owners.push(A.bob); }
    const bal = await c.balanceOfBatch(owners, ids);
    ok("balanceOfBatch powers the gallery in one call",
       bal.filter(b => Number(b) > 0).length >= 1, `${bal.filter(b => Number(b) > 0).length} held by bob`);

  } finally {
    server.close();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  fs.writeFileSync(path.join(ROOT, "test", "results.txt"),
    results.map(r => `${r[0]}  ${r[1]}${r[2] ? "  — " + r[2] : ""}`).join("\n") +
    `\n\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
