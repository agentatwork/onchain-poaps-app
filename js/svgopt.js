// A small, conservative SVG optimiser that runs in the browser.
//
// Why this exists at all: registerEvent base64-encodes the SVG and writes it with
// SSTORE2, so every byte is paid for once, forever, at deploy-a-contract prices.
// A 40 KB Illustrator export and a 2 KB hand-trimmed one look identical onchain
// and cost very different amounts of ETH — and unlike almost everything else in
// this app, it cannot be fixed later.
//
// It is deliberately *not* SVGO. SVGO is a Node toolchain with a plugin graph;
// pulling it into a static page would mean a bundler and ~400 KB of JavaScript to
// do the last 10% of the job. This does the transformations that are safe to do
// with a regex on markup that the browser has already parsed once and accepted,
// reports exactly what it changed, and links out to SVGO for anyone who wants the
// rest. Everything here is reversible in the sense that matters: the rendered
// image is unchanged, and the app shows you both before and after.

(function (global) {
  "use strict";

  // Attributes that carry editor bookkeeping and never affect rendering.
  var JUNK_ATTR = /\s(?:id|class)="[^"]*"(?=[\s/>])|\s(?:inkscape|sodipodi|sketch|figma|adobe|illustrator|xmlns:(?:inkscape|sodipodi|sketch|serif|figma|xlink))(?::[\w-]+)?="[^"]*"/gi;
  var JUNK_TAG = /<(metadata|desc|title|sodipodi:namedview|inkscape:[\w-]+)\b[\s\S]*?<\/\1>|<(metadata|desc|title|sodipodi:namedview)\b[^>]*\/>/gi;

  function round(match, digits) {
    var n = parseFloat(match);
    if (!isFinite(n)) return match;
    var r = Number(n.toFixed(digits));
    var s = String(r);
    // 0.5 -> .5 is safe inside attribute values and saves a byte per number
    if (s.indexOf("0.") === 0) s = s.slice(1);
    else if (s.indexOf("-0.") === 0) s = "-" + s.slice(2);
    return s;
  }

  function optimize(input, opts) {
    opts = opts || {};
    var digits = opts.precision === undefined ? 2 : opts.precision;
    var original = String(input || "");
    var s = original;
    var notes = [];
    var n0;

    function step(label, fn) {
      var before = s.length;
      s = fn(s);
      if (s.length !== before) notes.push(label + " (−" + (before - s.length) + " bytes)");
    }

    step("removed XML prolog and doctype", function (t) {
      return t.replace(/<\?xml[\s\S]*?\?>/gi, "").replace(/<!DOCTYPE[\s\S]*?>/gi, "");
    });
    step("removed comments", function (t) { return t.replace(/<!--[\s\S]*?-->/g, ""); });
    step("removed editor metadata", function (t) {
      return t.replace(JUNK_TAG, "");
    });
    step("removed editor attributes", function (t) {
      n0 = t;
      return t.replace(JUNK_ATTR, "");
    });
    step("collapsed whitespace between tags", function (t) {
      return t.replace(/>\s+</g, "><").replace(/\s{2,}/g, " ");
    });
    step("shortened numbers to " + digits + " decimals", function (t) {
      // Only inside attribute values, so text content is never touched.
      return t.replace(/="([^"]*)"/g, function (m, val) {
        if (!/\d/.test(val)) return m;
        return '="' + val.replace(/-?\d*\.\d+(?:e-?\d+)?/gi, function (num) {
          return round(num, digits);
        }) + '"';
      });
    });
    step("shortened 6-digit hex colours", function (t) {
      return t.replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/gi, "#$1$2$3");
    });
    step("removed empty groups", function (t) {
      var prev;
      do { prev = t; t = t.replace(/<g\s*>\s*<\/g>/g, ""); } while (t !== prev);
      return t;
    });

    s = s.trim();

    // Safety net: if anything above produced something that is no longer a single
    // <svg> element, hand back the original. A frontend that silently corrupts
    // artwork on its way to permanent storage is worse than one that saves nothing.
    var looksOk = /^<svg[\s>]/i.test(s) && /<\/svg>$/i.test(s);
    if (!looksOk) {
      return { svg: original.trim(), originalBytes: original.length, bytes: original.trim().length,
               savedBytes: 0, savedPct: 0, notes: [], bailed: true,
               warnings: ["Optimisation was skipped: the result did not parse as a single <svg> element."] };
    }

    var warnings = [];
    if (/<image\b/i.test(s)) warnings.push(
      "This SVG embeds a raster <image>. Those are usually enormous base64 blobs and are the " +
      "single most expensive thing you can store onchain — consider redrawing it as vectors.");
    if (/<script\b/i.test(s)) warnings.push(
      "This SVG contains a <script> tag. Marketplaces and wallets strip or refuse scripted SVGs, " +
      "so it will likely render as nothing.");
    if (/\bhref\s*=\s*"https?:/i.test(s) || /url\(\s*['"]?https?:/i.test(s)) warnings.push(
      "This SVG references an external URL. The point of an onchain POAP is that it survives " +
      "without any server; an external reference reintroduces exactly the dependency you removed.");
    if (!/viewBox=/i.test(s)) warnings.push(
      "No viewBox. Without one the artwork will not scale to fit the frames wallets draw it in.");
    if (s.length > 24000) warnings.push(
      "This is " + Math.round(s.length / 1024) + " KB. SSTORE2 charges roughly 200 gas per byte " +
      "at write time, so expect a noticeably expensive registration.");

    return {
      svg: s,
      originalBytes: original.length,
      bytes: s.length,
      savedBytes: original.length - s.length,
      savedPct: original.length ? Math.round((1 - s.length / original.length) * 1000) / 10 : 0,
      notes: notes,
      warnings: warnings,
      bailed: false
    };
  }

  // Registration cost is dominated by SSTORE2's CREATE of a data contract holding
  // the base64 of the SVG: ~200 gas per byte of code deployed, on 4/3 of the input.
  // Approximate, clearly labelled as approximate, and much better than no estimate.
  function estimateGas(svgBytes) {
    var stored = Math.ceil(svgBytes / 3) * 4;         // base64 expansion
    return { storedBytes: stored, approxGas: 32000 + stored * 200 + 120000 };
  }

  global.SvgOpt = { optimize: optimize, estimateGas: estimateGas };
})(window);
