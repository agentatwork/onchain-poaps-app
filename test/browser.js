#!/usr/bin/env node
/**
 * Browser smoke test: load the deployed app in headless Chromium and check that
 * the views actually render against the live contract.
 *
 * The e2e suite proves the encoding is right. This proves the page runs — a
 * frontend can have a perfect contract layer and still ship a blank screen
 * because one script tag 404s or one view throws on first paint.
 *
 *   node test/browser.js [baseUrl]        default https://poaps.agentatwork.xyz
 */
"use strict";
const path = require("path");
const puppeteer = require(process.env.PUPPETEER || "/tmp/node_modules/puppeteer-core");

const BASE = process.argv[2] || "https://poaps.agentatwork.xyz";
const CHROME = process.env.CHROME || "/usr/bin/chromium";
const SHOT = path.join(__dirname, "..", "screenshots");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  cond ? pass++ : fail++;
  console.log(`${cond ? "  ok  " : "  FAIL"} ${name}${detail ? "  — " + detail : ""}`);
}

(async () => {
  require("fs").mkdirSync(SHOT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  const errors = [], failedReqs = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("requestfailed", (r) => failedReqs.push(r.url() + " " + (r.failure() || {}).errorText));

  async function go(hash, waitFor, name) {
    await page.goto(BASE + "/" + hash, { waitUntil: "networkidle2", timeout: 60000 });
    if (waitFor) {
      try { await page.waitForSelector(waitFor, { timeout: 45000 }); }
      catch (e) { ok(name + ": " + waitFor, false, "never appeared"); return false; }
    }
    return true;
  }

  // ---- Explore ------------------------------------------------------------
  await go("", ".tile", "explore");
  const tiles = await page.$$eval(".tile", (n) => n.length);
  ok("explore renders event tiles from the live contract", tiles > 0, tiles + " tiles");
  const names = await page.$$eval(".tile .nm", (n) => n.map((x) => x.textContent).slice(0, 4));
  ok("tiles carry real event names", names.some((n) => /POAP|Onchain|Poidh/i.test(n)), names.join(" | "));
  const arts = await page.$$eval(".tile .art img", (n) => n.filter((i) => i.src.startsWith("data:image/svg")).length);
  ok("artwork decodes from onchain metadata", arts > 0, arts + " SVGs rendered from data: URLs");
  await page.screenshot({ path: path.join(SHOT, "01-explore.png") });

  // ---- Event detail -------------------------------------------------------
  await go("#/event/2", ".detail", "event");
  const routes = await page.$$eval(".route h4", (n) => n.map((x) => x.textContent.trim()));
  ok("event page lists all three mint routes", routes.length === 3, routes.join(" · "));
  const kv = await page.$$eval(".kv tr", (n) => n.length);
  ok("event page shows onchain facts", kv >= 8, kv + " rows");
  const hasAllow = await page.$eval("body", (b) => /allowlist/i.test(b.innerText));
  ok("allowlist state is surfaced", hasAllow);
  await page.screenshot({ path: path.join(SHOT, "02-event.png") });

  // ---- Create + SVG optimiser --------------------------------------------
  await go("#/create", "textarea", "create");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
    '<!-- comment --><rect width="100" height="100" fill="#112233"/>' +
    '<circle cx="50.00000" cy="50.0" r="30.123456789" fill="#7dd3fc"/></svg>';
  await page.evaluate((s) => {
    const ta = document.querySelectorAll("textarea")[1];
    ta.value = s; ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, svg);
  await page.waitForSelector(".note.ok", { timeout: 15000 });
  const optText = await page.$eval(".note.ok b", (e) => e.textContent);
  ok("create page optimises a pasted SVG", /Optimised:.*bytes/.test(optText), optText);
  const previewed = await page.$$eval(".bigart img", (n) => n.length);
  ok("create page previews the optimised artwork", previewed === 1);
  const gasLine = await page.$eval("body", (b) => (b.innerText.match(/roughly [\d,]+ gas/) || [""])[0]);
  ok("create page estimates registration gas", /gas/.test(gasLine), gasLine);
  await page.screenshot({ path: path.join(SHOT, "03-create.png") });

  // ---- Manage: merkle in the browser --------------------------------------
  await go("#/manage/2", ".tabs", "manage");
  await page.evaluate(() => {
    [...document.querySelectorAll(".tabs button")].find((b) => /Allowlist/.test(b.textContent)).click();
  });
  await page.waitForSelector("textarea", { timeout: 10000 });
  const list = ["0x1C7afa67130ee637765a8281E83342E307409D57",
                "0x000000000000000000000000000000000000dEaD",
                "0x8C2b307fD0C037561eb2958873258eFc932ADa24",
                "not-an-address"].join("\n");
  await page.evaluate((v) => {
    const ta = document.querySelector("textarea");
    ta.value = v; ta.dispatchEvent(new Event("input", { bubbles: true }));
  }, list);
  await page.waitForSelector(".note.ok .mono", { timeout: 10000 });
  const root = await page.$eval(".note.ok .mono", (e) => e.textContent.trim());
  ok("allowlist builder produces a 32-byte root in the browser", /^0x[0-9a-f]{64}$/i.test(root), root);
  const selfcheck = await page.$eval("body", (b) => /Generation and verification agree/.test(b.innerText));
  ok("allowlist builder verifies its own proof against the root", selfcheck);
  const badAddr = await page.$eval("body", (b) => /Not valid addresses/.test(b.innerText));
  ok("allowlist builder reports the unparseable line", badAddr);
  await page.screenshot({ path: path.join(SHOT, "04-allowlist.png") });

  // ---- Manage: QR ---------------------------------------------------------
  await page.evaluate(() => {
    [...document.querySelectorAll(".tabs button")].find((b) => /Signatures/.test(b.textContent)).click();
  });
  await page.waitForSelector(".qr img", { timeout: 10000 });
  const qr = await page.$eval(".qr img", (i) => ({ src: i.src.slice(0, 22), w: i.naturalWidth }));
  ok("QR code renders for the event link", qr.src.startsWith("data:image/gif") || qr.src.startsWith("data:image/png"),
     qr.src + " " + qr.w + "px");
  const caveat = await page.$eval("body", (b) => /static QR|cannot know who is about to scan/i.test(b.innerText));
  ok("the signature/QR limitation is stated on the page", caveat);
  await page.screenshot({ path: path.join(SHOT, "05-signatures-qr.png") });

  // ---- Gallery + Docs -----------------------------------------------------
  await go("#/gallery", ".empty", "gallery");
  ok("gallery prompts for a wallet when none is connected", true);
  await page.screenshot({ path: path.join(SHOT, "06-gallery.png") });

  await go("#/docs", ".docs h2", "docs");
  const secs = await page.$$eval(".docs h2", (n) => n.length);
  ok("docs render every section", secs >= 15, secs + " sections");
  const tocLinks = await page.$$eval(".toc a", (n) => n.length);
  ok("docs table of contents is complete", tocLinks === secs, tocLinks + " toc links");
  await page.screenshot({ path: path.join(SHOT, "07-docs.png"), fullPage: false });

  // ---- Mobile / Mini App viewport -----------------------------------------
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true });
  await go("", ".tile", "mobile");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  ok("no horizontal overflow at 390px (Mini App width)", !overflow);
  await page.screenshot({ path: path.join(SHOT, "08-miniapp-mobile.png") });

  // ---- Manifest -----------------------------------------------------------
  const man = await page.evaluate(async (b) => {
    const r = await fetch(b + "/.well-known/farcaster.json");
    return { status: r.status, type: r.headers.get("content-type"), body: await r.json() };
  }, BASE);
  ok("farcaster manifest is served as JSON", man.status === 200 && /json/.test(man.type || ""), man.type);
  ok("manifest has a signed account association",
     !!(man.body.accountAssociation && man.body.accountAssociation.signature));
  ok("manifest declares the miniapp", man.body.miniapp && man.body.miniapp.version === "1",
     man.body.miniapp && man.body.miniapp.name);

  // ---- Hygiene ------------------------------------------------------------
  ok("no failed network requests", failedReqs.length === 0, failedReqs.slice(0, 3).join(" | "));
  ok("no uncaught page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

  await browser.close();
  console.log(`\n${pass} passed, ${fail} failed  (screenshots in screenshots/)\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
