// Onchain POAPs — views and routing.
//
// Hash routing on purpose: the whole app is static files, so it can be served
// from IPFS, a USB stick or `python3 -m http.server` with no rewrite rules, and
// a deep link into an event still works. That matters more than pretty URLs for
// something whose selling point is that it has no server.

(function (global) {
  "use strict";
  var E = global.ethers, P = global.POAP, W = global.Wallet, M = global.Merkle, S = global.SvgOpt;

  var chainId = Number(localStorage.getItem("poap.chain") || P.DEFAULT_CHAIN);
  if (!P.CHAINS[chainId]) chainId = P.DEFAULT_CHAIN;

  // ---- tiny DOM helpers --------------------------------------------------
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") e.className = attrs[k];
      else if (k === "html") e.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on") e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) e.setAttribute(k, attrs[k]);
    }
    (Array.isArray(kids) ? kids : kids === undefined ? [] : [kids]).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      e.appendChild(typeof c === "string" || typeof c === "number" ? document.createTextNode(String(c)) : c);
    });
    return e;
  }
  function $(sel, root) { return (root || document).querySelector(sel); }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); return n; }
  function esc(s) { return String(s === null || s === undefined ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function fmtDate(ts) { return ts ? new Date(ts * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—"; }
  function fmtDateTime(ts) { return ts ? new Date(ts * 1000).toLocaleString() : "—"; }
  function relative(ts) {
    var d = ts - Math.floor(Date.now() / 1000);
    var past = d < 0; d = Math.abs(d);
    var u = d < 3600 ? [Math.round(d / 60), "min"] : d < 86400 ? [Math.round(d / 3600), "hr"]
          : [Math.round(d / 86400), "day"];
    return u[0] + " " + u[1] + (u[0] === 1 ? "" : "s") + (past ? " ago" : " from now");
  }
  function copyBtn(text, label) {
    return h("button", { class: "sm ghost", onclick: function (ev) {
      navigator.clipboard.writeText(text);
      var b = ev.currentTarget, old = b.textContent;
      b.textContent = "copied"; setTimeout(function () { b.textContent = old; }, 1200);
    } }, label || "copy");
  }
  function download(name, text, mime) {
    var b = new Blob([text], { type: mime || "application/json" });
    var u = URL.createObjectURL(b);
    var a = h("a", { href: u, download: name }); document.body.appendChild(a); a.click();
    a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1500);
  }
  function note(kind, title, body) {
    return h("div", { class: "note " + kind }, [title ? h("b", null, title) : null,
      typeof body === "string" ? document.createTextNode(body) : body]);
  }
  function spinner(label) { return h("p", { class: "muted" }, [h("span", { class: "spin" }), " " + (label || "loading…")]); }
  function chain() { return P.CHAINS[chainId]; }

  // ---- shared bits -------------------------------------------------------
  function tagsFor(ev) {
    var now = Math.floor(Date.now() / 1000);
    var t = [];
    if (ev.isPublic) t.push(h("span", { class: "tag pub" }, "public"));
    if (ev.hasAllowlist) t.push(h("span", { class: "tag al" }, "allowlist"));
    if (now < ev.signatureExpiresAt) t.push(h("span", { class: "tag sig" }, "signature"));
    if (ev.isSoulbound) t.push(h("span", { class: "tag sb" }, "soulbound"));
    if (!ev.isPublic && !ev.hasAllowlist && now >= ev.signatureExpiresAt)
      t.push(h("span", { class: "tag closed" }, "closed"));
    return h("div", { class: "tags" }, t);
  }

  var artCache = {};
  function artFor(ev, el) {
    var key = chainId + ":" + ev.id;
    if (artCache[key]) { el.className = "art"; el.innerHTML = ""; el.appendChild(imgOf(artCache[key])); return; }
    P.getMetadata(chainId, ev.id).then(function (m) {
      if (!m || !m.image) { el.className = "art"; el.textContent = "no art"; return; }
      artCache[key] = m.image;
      el.className = "art"; el.innerHTML = ""; el.appendChild(imgOf(m.image));
    }).catch(function () { el.className = "art"; el.textContent = "—"; });
  }
  function imgOf(src) { return h("img", { src: src, alt: "", loading: "lazy" }); }

  function eventTile(ev) {
    var art = h("div", { class: "art sk" });
    artFor(ev, art);
    return h("a", { class: "tile", href: "#/event/" + ev.id }, [
      art,
      h("div", { class: "body" }, [
        h("div", { class: "nm" }, ev.name || "Untitled"),
        h("div", { class: "meta" }, "#" + ev.id + " · " + fmtDate(ev.createdAt)),
        tagsFor(ev)
      ])
    ]);
  }

  // =========================================================================
  // Explore
  // =========================================================================
  async function viewExplore(root) {
    root.appendChild(h("div", { class: "flexrow", style: "justify-content:space-between;margin-bottom:18px" }, [
      h("div", null, [
        h("h1", null, "Onchain POAPs"),
        h("p", { class: "muted", style: "margin:0" },
          "Proof of attendance with the artwork and the metadata stored in the contract itself. " +
          "No IPFS, no gateway, no server — including this one.")
      ]),
      h("a", { class: "btn", href: "#/create" }, "Create a POAP")
    ]));

    var status = h("div"); root.appendChild(status);
    var grid = h("div", { class: "grid" }); root.appendChild(grid);
    status.appendChild(spinner("reading events from " + chain().name + "…"));

    if (!chain().contract) {
      clear(status).appendChild(note("warn", "No deployment on " + chain().name + " yet",
        "The Onchain POAPs contract is live on Base Sepolia. Switch networks in the header to browse it."));
      return;
    }
    try {
      var seen = 0;
      var evs = await P.listEvents(chainId, { onBatch: function (all) {
        clear(status);
        for (; seen < all.length; seen++) grid.appendChild(eventTile(all[seen]));
      } });
      clear(status);
      if (!evs.length) status.appendChild(h("div", { class: "empty" }, "No events registered yet."));
      else status.appendChild(h("p", { class: "small" },
        evs.length + " event" + (evs.length === 1 ? "" : "s") + " on " + chain().name +
        " · contract " + chain().contract));
    } catch (e) {
      clear(status).appendChild(note("err", "Could not read the contract", P.explainError(e)));
    }
  }

  // =========================================================================
  // Create
  // =========================================================================
  function viewCreate(root) {
    root.className = "narrow";
    root.appendChild(h("h1", null, "Create a POAP"));
    root.appendChild(h("p", { class: "muted" },
      "Everything below is written into the contract permanently. The name, the artwork and the " +
      "soulbound setting can never be changed; public minting and the allowlist can be adjusted for " +
      "30 days and then freeze too."));

    var svgState = null;

    var fName = h("input", { maxlength: P.MAX.name, placeholder: "ETHGlobal Brussels 2026" });
    var fDesc = h("textarea", { maxlength: P.MAX.description, placeholder: "What was this? Who was there? (optional)" });
    var fLoc = h("input", { maxlength: P.MAX.location, placeholder: "Brussels, Belgium (optional)" });
    var fDate = h("input", { type: "date" });
    var fUrl = h("input", { maxlength: P.MAX.externalUrl, placeholder: "https://… (optional)" });
    var fFile = h("input", { type: "file", accept: ".svg,image/svg+xml" });
    var fSvg = h("textarea", { placeholder: "…or paste SVG markup here", style: "min-height:120px" });
    var cSoul = h("input", { type: "checkbox" });
    var cPub = h("input", { type: "checkbox", checked: true });
    var preview = h("div", { class: "bigart", style: "max-width:220px" },
      h("span", { class: "muted small" }, "no artwork yet"));
    var svgReport = h("div", { class: "stack", style: "margin-top:11px" });
    var out = h("div", { style: "margin-top:16px" });

    function countdown(el, input, max) {
      function upd() {
        el.textContent = input.value.length + " / " + max;
        el.style.color = input.value.length > max * 0.9 ? "var(--warn)" : "var(--dim)";
      }
      input.addEventListener("input", upd); upd();
    }

    // The contract drops these strings into its metadata JSON without escaping
    // them, so a newline or a double quote produces a document that JSON.parse
    // rejects — and a POAP that renders blank in every wallet that reads it.
    // Event #6 on Base Sepolia is already in that state, permanently. Catching it
    // here is the only place it can still be fixed.
    var textFields = [["Name", fName], ["Description", fDesc], ["Location", fLoc], ["External URL", fUrl]];
    var safety = h("div", { style: "margin-top:4px" });
    function checkSafety() {
      clear(safety);
      var hits = textFields.filter(function (f) { return Object.keys(P.unsafeChars(f[1].value)).length; });
      if (!hits.length) return;
      safety.appendChild(note("warn", "These characters will break the onchain metadata",
        h("div", { class: "stack" }, [
          h("div", null, hits.map(function (f) { return f[0]; }).join(", ") +
            " contain line breaks or quotes. The contract writes them into its metadata JSON " +
            "unescaped, so the result will not parse and wallets and marketplaces will show this " +
            "POAP as blank. It cannot be repaired after registration."),
          h("button", { class: "sm", onclick: function () {
            hits.forEach(function (f) { f[1].value = P.sanitize(f[1].value); f[1].dispatchEvent(new Event("input")); });
          } }, "Clean them up")
        ])));
    }
    textFields.forEach(function (f) { f[1].addEventListener("input", checkSafety); });

    function handleSvg(text) {
      clear(svgReport);
      if (!text || !text.trim()) { svgState = null; clear(preview).appendChild(h("span", { class: "muted small" }, "no artwork yet")); return; }
      var r = S.optimize(text);
      svgState = r;
      clear(preview).appendChild(imgOf("data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(r.svg)))));
      var est = S.estimateGas(r.bytes);
      svgReport.appendChild(note(r.bailed ? "warn" : "ok",
        r.bailed ? "Kept your SVG unchanged" : "Optimised: " + r.originalBytes + " → " + r.bytes + " bytes (−" + r.savedPct + "%)",
        h("div", null, [
          h("div", { class: "small" }, r.notes.length ? r.notes.join(" · ") : "Nothing to strip — this SVG was already tight."),
          h("div", { class: "small", style: "margin-top:6px" },
            "Stored onchain as " + est.storedBytes.toLocaleString() + " bytes of base64 · registration will cost roughly " +
            est.approxGas.toLocaleString() + " gas.")
        ])));
      r.warnings.forEach(function (w) { svgReport.appendChild(note("warn", null, w)); });
      svgReport.appendChild(h("p", { class: "hint" }, [
        "This optimiser is deliberately conservative. For maximum savings run it through ",
        h("a", { href: "https://jakearchibald.github.io/svgomg/", target: "_blank", rel: "noopener" }, "SVGOMG"),
        " (SVGO in the browser) first and paste the result here."
      ]));
    }

    fFile.addEventListener("change", function () {
      var f = fFile.files && fFile.files[0]; if (!f) return;
      var rd = new FileReader();
      rd.onload = function () { fSvg.value = rd.result; handleSvg(rd.result); };
      rd.readAsText(f);
    });
    fSvg.addEventListener("input", function () { handleSvg(fSvg.value); });

    var nameCount = h("span", { class: "hint" }), descCount = h("span", { class: "hint" });
    countdown(nameCount, fName, P.MAX.name); countdown(descCount, fDesc, P.MAX.description);

    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "1. What is it"),
      h("div", { class: "field" }, [h("label", null, "Name (required)"), fName, nameCount]),
      h("div", { class: "field" }, [h("label", null, "Description"), fDesc, descCount]),
      h("div", { class: "row" }, [
        h("div", { class: "field" }, [h("label", null, "Location"), fLoc]),
        h("div", { class: "field" }, [h("label", null, "Event date"), fDate])
      ]),
      h("div", { class: "field" }, [h("label", null, "External URL"), fUrl,
        h("p", { class: "hint" }, "Shown on the POAP and in marketplace metadata. 128 characters max.")]),
      safety
    ]));

    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "2. Artwork"),
      h("p", { class: "hint", style: "margin-top:0" },
        "SVG only, and every byte is stored in the contract forever — so this is the one field where " +
        "size is money. A flat vector badge is a few hundred bytes; an Illustrator export of the same " +
        "thing is often forty thousand."),
      h("div", { class: "row", style: "align-items:flex-start" }, [
        h("div", { style: "flex:1 1 300px" }, [
          h("div", { class: "field" }, [h("label", null, "Upload an .svg file"), fFile]),
          h("div", { class: "field" }, [h("label", null, "Or paste markup"), fSvg])
        ]),
        h("div", { style: "flex:0 0 220px" }, [h("label", null, "Preview"), preview])
      ]),
      svgReport
    ]));

    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "3. How people get it"),
      h("div", { class: "row" }, [
        h("label", { class: "check" }, [cPub, h("div", null, [
          h("b", null, "Open public minting now"),
          h("span", null, "Anyone with the link can mint one. You can turn this on and off for 30 days.")])]),
        h("label", { class: "check" }, [cSoul, h("div", null, [
          h("b", null, "Soulbound"),
          h("span", null, "The POAP can never be transferred or sold. Permanent — decide now.")])])
      ]),
      h("p", { class: "hint" }, [
        "Allowlists and signature minting are set up after registration, on the event's Manage tab. ",
        h("a", { href: "#/docs#distribution" }, "Which distribution method should I use?")
      ])
    ]));

    var btn = h("button", { class: "primary", onclick: submit }, "Register POAP onchain");
    root.appendChild(h("div", { class: "flexrow", style: "margin-top:18px" }, [btn,
      h("span", { class: "small" }, "One transaction on " + chain().name + ".")]));
    root.appendChild(out);

    async function submit() {
      clear(out);
      var name = fName.value.trim();
      if (!name) { out.appendChild(note("err", null, "A name is required.")); return; }
      if (!svgState || !svgState.svg) { out.appendChild(note("err", null, "An SVG image is required.")); return; }
      if (!chain().contract) { out.appendChild(note("err", null, "No deployment on " + chain().name + ".")); return; }
      btn.disabled = true; out.appendChild(spinner("waiting for your wallet…"));
      try {
        var signer = await W.requireChain(chainId);
        var c = P.writeContract(chainId, signer);
        var eventDate = fDate.value ? Math.floor(new Date(fDate.value + "T00:00:00Z").getTime() / 1000) : 0;
        var flags = P.flagsFor(cSoul.checked, cPub.checked);
        var tx = await c.registerEvent(name, fDesc.value.trim(), eventDate, fLoc.value.trim(),
          P.ZERO_ROOT, svgState.svg, fUrl.value.trim(), flags);
        clear(out).appendChild(note("info", "Submitted", h("span", null, [
          "Transaction ", h("a", { href: chain().explorer + "/tx/" + tx.hash, target: "_blank", rel: "noopener" }, tx.hash.slice(0, 18) + "…"),
          " — waiting for it to be mined."])));
        var rc = await tx.wait();
        var id = null;
        for (var i = 0; i < rc.logs.length; i++) {
          try {
            var pl = P.IFACE.parseLog(rc.logs[i]);
            if (pl && pl.name === "NewEvent") { id = Number(pl.args[0]); break; }
          } catch (e) { }
        }
        clear(out).appendChild(note("ok", "POAP #" + (id === null ? "?" : id) + " registered",
          h("div", { class: "stack" }, [
            h("div", null, "It is onchain and permanent."),
            h("div", { class: "flexrow" }, [
              id !== null ? h("a", { class: "btn", href: "#/event/" + id }, "Open it") : null,
              id !== null ? h("a", { class: "btn", href: "#/manage/" + id }, "Set up distribution") : null,
              h("a", { class: "btn", href: chain().explorer + "/tx/" + rc.hash, target: "_blank", rel: "noopener" }, "BaseScan")
            ])
          ])));
      } catch (e) {
        clear(out).appendChild(note("err", "Registration failed", P.explainError(e)));
      } finally { btn.disabled = false; }
    }
  }

  // =========================================================================
  // Event detail + minting
  // =========================================================================
  async function viewEvent(root, id) {
    root.appendChild(spinner());
    var ev, meta;
    try {
      ev = await P.getEvent(chainId, id);
      if (!ev.name && Number(id) !== 0) throw new Error("Event #" + id + " does not exist on " + chain().name + ".");
      meta = await P.getMetadata(chainId, id).catch(function () { return null; });
    } catch (e) {
      clear(root).appendChild(note("err", "Not found", P.explainError(e)));
      return;
    }
    clear(root);

    var art = h("div", { class: "bigart" }, meta && meta.image ? imgOf(meta.image) : h("span", { class: "muted" }, "no art"));
    var left = h("div", { class: "stack" }, [art, tagsFor(ev),
      meta && meta._repaired
        ? note("warn", "This POAP's onchain metadata is not valid JSON",
            "The contract writes creator-supplied text into its metadata without escaping it, and this " +
            "event's text contains a character that breaks the document (" +
            (meta._parseError || "parse error") + "). This app repaired it to show you the artwork. " +
            "Wallets and marketplaces that call JSON.parse and give up will show this POAP as blank, " +
            "and because the strings are onchain that cannot be fixed.")
        : null]);

    var right = h("div");
    right.appendChild(h("h1", null, ev.name || "Untitled"));
    right.appendChild(h("p", { class: "muted", style: "margin-top:0" },
      "POAP #" + ev.id + " on " + chain().name + " · registered " + fmtDate(ev.createdAt)));
    if (ev.description) right.appendChild(h("p", null, ev.description));

    var mintBox = h("div", { style: "margin:20px 0" });
    right.appendChild(mintBox);

    var kv = h("table", { class: "kv" });
    function kvRow(k, v) { kv.appendChild(h("tr", null, [h("td", null, k), h("td", null, v)])); }
    kvRow("Event ID", String(ev.id));
    if (ev.location) kvRow("Location", ev.location);
    if (ev.eventDate) kvRow("Event date", fmtDate(ev.eventDate));
    kvRow("Creator", h("a", { href: chain().explorer + "/address/" + ev.creator, target: "_blank", rel: "noopener" }, ev.creator));
    kvRow("Transferable", ev.isSoulbound ? "No — soulbound" : "Yes");
    kvRow("Public minting", ev.isPublic ? "Open" : "Closed");
    kvRow("Allowlist", ev.hasAllowlist ? ev.allowlistRoot : "None set");
    kvRow("Creator controls", Math.floor(Date.now() / 1000) < ev.lockExpiresAt
      ? "Open until " + fmtDateTime(ev.lockExpiresAt) + " (" + relative(ev.lockExpiresAt) + ")"
      : "Closed since " + fmtDateTime(ev.lockExpiresAt));
    kvRow("Signature minting", Math.floor(Date.now() / 1000) < ev.signatureExpiresAt
      ? "Open until " + fmtDateTime(ev.signatureExpiresAt) + " (" + relative(ev.signatureExpiresAt) + ")"
      : "Closed since " + fmtDateTime(ev.signatureExpiresAt));
    if (ev.externalUrl) kvRow("External URL", h("a", { href: ev.externalUrl, target: "_blank", rel: "noopener noreferrer" }, ev.externalUrl));
    right.appendChild(h("h3", null, "Onchain facts")); right.appendChild(kv);

    right.appendChild(h("div", { class: "flexrow", style: "margin-top:16px" }, [
      h("a", { class: "btn", href: chain().explorer + "/token/" + chain().contract + "?a=" + ev.id, target: "_blank", rel: "noopener" }, "BaseScan"),
      h("a", { class: "btn", href: chain().opensea + "/" + chain().contract + "/" + ev.id, target: "_blank", rel: "noopener" }, "OpenSea"),
      h("a", { class: "btn", href: "#/manage/" + ev.id }, "Manage (creator)"),
      copyBtn(location.origin + location.pathname + "#/event/" + ev.id, "copy mint link")
    ]));

    root.appendChild(h("div", { class: "detail" }, [left, right]));
    renderMint(mintBox, ev);
  }

  // Allowlist bundles the visitor has loaded, kept in memory by event id.
  var proofStore = {};
  var sigStore = {};

  async function renderMint(box, ev) {
    clear(box);
    var addr = W.state.address;
    var proof = addr && proofStore[ev.id] && proofStore[ev.id][addr.toLowerCase()];
    var sig = sigStore[ev.id];
    var opts = await P.mintOptions(chainId, ev, addr, { hasProof: !!proof, hasSignature: !!sig });

    if (opts.alreadyClaimed) {
      box.appendChild(note("ok", "You already have this POAP",
        "The contract allows one per wallet, so there is nothing left to do."));
    }

    opts.routes.forEach(function (r) {
      var el = h("div", { class: "route " + (r.usable ? "usable" : r.available ? "" : "off") });
      el.appendChild(h("h4", null, [h("span", { class: "dot" + (r.usable ? " on" : "") }), r.label]));
      el.appendChild(h("p", null, r.why));
      var act = h("div", { class: "act" });
      el.appendChild(act);

      if (r.key === "public" && r.available) {
        act.appendChild(h("button", { class: "primary", disabled: opts.alreadyClaimed,
          onclick: function (e) { doMint(e.currentTarget, box, ev, "mint", [ev.id]); } }, "Mint"));
      }
      if (r.key === "allowlist" && r.available) {
        var file = h("input", { type: "file", accept: ".json", style: "max-width:270px" });
        file.addEventListener("change", function () {
          var f = file.files && file.files[0]; if (!f) return;
          var rd = new FileReader();
          rd.onload = function () {
            try {
              var b = JSON.parse(rd.result);
              var map = {};
              Object.keys(b.proofs || {}).forEach(function (a) { map[a.toLowerCase()] = b.proofs[a]; });
              proofStore[ev.id] = map;
              if (b.root && b.root.toLowerCase() !== ev.allowlistRoot.toLowerCase()) {
                box.insertBefore(note("warn", "That allowlist is for a different event",
                  "Its root is " + b.root + " but this event's root is " + ev.allowlistRoot + "."), box.firstChild);
              }
              renderMint(box, ev);
            } catch (err) {
              box.insertBefore(note("err", "Could not read that file", String(err)), box.firstChild);
            }
          };
          rd.readAsText(f);
        });
        act.appendChild(h("div", { class: "stack" }, [
          h("div", { class: "small" }, "Load the allowlist file the creator published:"),
          file,
          proof ? h("button", { class: "primary", disabled: opts.alreadyClaimed,
            onclick: function (e) { doMint(e.currentTarget, box, ev, "allowlistMint", [ev.id, proof]); } },
            "Mint with proof") : null,
          addr && proofStore[ev.id] && !proof
            ? note("warn", null, "Loaded — but " + W.short(addr) + " is not in that list.") : null
        ]));
      }
      if (r.key === "signature" && r.available) {
        var inp = h("input", { placeholder: "0x… signature from the creator", value: sig || "" });
        inp.addEventListener("input", function () {
          var v = inp.value.trim();
          if (v.length > 100) { sigStore[ev.id] = v; renderMint(box, ev); }
        });
        act.appendChild(h("div", { class: "stack" }, [
          inp,
          sig && addr ? (function () {
            var who = P.recoverSigner(ev.id, chainId, addr, sig);
            var good = who && who.toLowerCase() === ev.creator.toLowerCase();
            return note(good ? "ok" : "err", null, good
              ? "Valid: signed by the creator, for " + W.short(addr) + "."
              : "This signature does not check out for " + W.short(addr) +
                (who ? " (it recovers to " + W.short(who) + ")." : "."));
          })() : null,
          sig ? h("button", { class: "primary", disabled: opts.alreadyClaimed,
            onclick: function (e) { doMint(e.currentTarget, box, ev, "mintWithSignature", [ev.id, sig]); } },
            "Mint with signature") : null
        ]));
      }
      box.appendChild(el);
    });

    if (!addr) {
      box.appendChild(h("p", { class: "hint" },
        "Connect a wallet to see which of these you can actually use."));
    }
  }

  async function doMint(btn, box, ev, fn, args) {
    var old = btn.textContent; btn.disabled = true; btn.textContent = "confirming…";
    var status = h("div", { style: "margin-top:11px" });
    btn.parentNode.appendChild(status);
    try {
      var signer = await W.requireChain(chainId);
      var c = P.writeContract(chainId, signer);
      // Simulate first: a clean, decoded reason beats a wallet's "transaction may fail".
      await c[fn].staticCall.apply(c[fn], args);
      var tx = await c[fn].apply(c, args);
      status.appendChild(note("info", "Submitted", h("a",
        { href: chain().explorer + "/tx/" + tx.hash, target: "_blank", rel: "noopener" }, tx.hash.slice(0, 20) + "…")));
      var rc = await tx.wait();
      clear(box).appendChild(note("ok", "Minted",
        h("div", { class: "stack" }, [
          h("div", null, "You now hold " + (ev.name || "POAP #" + ev.id) + "."),
          h("div", { class: "flexrow" }, [
            h("a", { class: "btn", href: "#/gallery" }, "See it in your gallery"),
            h("a", { class: "btn", href: chain().explorer + "/tx/" + rc.hash, target: "_blank", rel: "noopener" }, "Verify onchain"),
            h("a", { class: "btn", href: chain().opensea + "/" + chain().contract + "/" + ev.id, target: "_blank", rel: "noopener" }, "OpenSea")
          ])
        ])));
      shareMinted(box, ev);
    } catch (e) {
      status.appendChild(note("err", "Mint failed", P.explainError(e)));
      btn.disabled = false; btn.textContent = old;
    }
  }

  function shareMinted(box, ev) {
    var s = W.sdk();
    if (!s || !W.state.miniapp) return;
    box.appendChild(h("div", { style: "margin-top:11px" },
      h("button", { onclick: function () {
        try {
          s.actions.composeCast({ text: "Just minted “" + (ev.name || "POAP #" + ev.id) + "” — an Onchain POAP.",
            embeds: [location.origin + location.pathname + "#/event/" + ev.id] });
        } catch (e) { }
      } }, "Share on Farcaster")));
  }

  // =========================================================================
  // Manage (creator)
  // =========================================================================
  async function viewManage(root, id) {
    root.appendChild(spinner());
    var ev;
    try { ev = await P.getEvent(chainId, id); }
    catch (e) { clear(root).appendChild(note("err", "Not found", P.explainError(e))); return; }
    clear(root);

    var now = Math.floor(Date.now() / 1000);
    var isCreator = W.state.address && W.state.address.toLowerCase() === ev.creator.toLowerCase();

    root.appendChild(h("h1", null, "Manage: " + (ev.name || "POAP #" + ev.id)));
    root.appendChild(h("p", { class: "muted", style: "margin-top:0" }, [
      h("a", { href: "#/event/" + ev.id }, "← back to the POAP"), " · creator ",
      h("span", { class: "addr" }, ev.creator)]));

    if (!W.state.address) root.appendChild(note("info", "Not connected",
      "Connect the creator wallet to use anything on this page. You can still read it."));
    else if (!isCreator) root.appendChild(note("warn", "This is not the creator wallet",
      W.short(W.state.address) + " did not register this event, so the contract will reject every action here."));

    root.appendChild(now < ev.lockExpiresAt
      ? note("info", "Creator window closes " + fmtDateTime(ev.lockExpiresAt),
        "That is " + relative(ev.lockExpiresAt) + ". After it, public minting and the allowlist root are " +
        "frozen forever. Signature minting keeps working for a further 7 days, until " + fmtDateTime(ev.signatureExpiresAt) + ".")
      : note("warn", "The 30-day creator window has closed",
        "Public minting and the allowlist can no longer be changed. " +
        (now < ev.signatureExpiresAt
          ? "Signature minting is still open until " + fmtDateTime(ev.signatureExpiresAt) + "."
          : "Signature minting has also closed. This event is now exactly as it will be forever.")));

    var body = h("div");
    var tabs = h("div", { class: "tabs" });
    var panes = {
      "Public minting": function (p) { panePublic(p, ev, isCreator, now); },
      "Allowlist": function (p) { paneAllowlist(p, ev, isCreator, now); },
      "Signatures & QR": function (p) { paneSignatures(p, ev, isCreator, now); },
      "Direct mint": function (p) { paneDirect(p, ev, isCreator, now); }
    };
    Object.keys(panes).forEach(function (k, i) {
      var b = h("button", { class: i === 0 ? "on" : "", onclick: function () {
        Array.prototype.forEach.call(tabs.children, function (x) { x.className = ""; });
        b.className = "on"; clear(body); panes[k](body);
      } }, k);
      tabs.appendChild(b);
    });
    root.appendChild(tabs); root.appendChild(body);
    panes[Object.keys(panes)[0]](body);
  }

  function txRunner(root) {
    var out = h("div", { style: "margin-top:12px" });
    root.appendChild(out);
    return async function run(btn, fn, args, okText) {
      var old = btn.textContent; btn.disabled = true; btn.textContent = "confirming…";
      clear(out).appendChild(spinner("waiting for your wallet…"));
      try {
        var signer = await W.requireChain(chainId);
        var c = P.writeContract(chainId, signer);
        await c[fn].staticCall.apply(c[fn], args);
        var tx = await c[fn].apply(c, args);
        clear(out).appendChild(note("info", "Submitted", h("a",
          { href: chain().explorer + "/tx/" + tx.hash, target: "_blank", rel: "noopener" }, tx.hash.slice(0, 20) + "…")));
        var rc = await tx.wait();
        clear(out).appendChild(note("ok", okText, h("a",
          { href: chain().explorer + "/tx/" + rc.hash, target: "_blank", rel: "noopener" }, "View the transaction")));
      } catch (e) {
        clear(out).appendChild(note("err", "Failed", P.explainError(e)));
      } finally { btn.disabled = false; btn.textContent = old; }
    };
  }

  function panePublic(root, ev, isCreator, now) {
    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "Public minting is " + (ev.isPublic ? "OPEN" : "CLOSED")),
      h("p", { class: "muted" }, ev.isPublic
        ? "Anyone who can reach the event page can mint one. Close it to stop new mints; already-minted POAPs are unaffected."
        : "Nobody can mint this except through an allowlist proof or a creator signature.")
    ]));
    var run = txRunner(root);
    var locked = now >= ev.lockExpiresAt;
    var btn = h("button", { class: ev.isPublic ? "danger" : "primary", disabled: locked || !isCreator,
      onclick: function () { run(btn, "updateEventPublic", [ev.id, !ev.isPublic],
        ev.isPublic ? "Public minting closed." : "Public minting is open."); } },
      ev.isPublic ? "Close public minting" : "Open public minting");
    root.insertBefore(h("div", { style: "margin-top:12px" }, btn), root.lastChild);
    if (locked) root.appendChild(note("warn", null, "The 30-day window has closed; this setting is permanent."));
  }

  function paneAllowlist(root, ev, isCreator, now) {
    var locked = now >= ev.lockExpiresAt;
    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "How allowlists work here"),
      h("p", { class: "muted" },
        "You publish nothing onchain except a single 32-byte hash — the Merkle root of your address " +
        "list. Recipients prove membership in the browser. The list itself never touches the chain, so " +
        "a 5,000-address allowlist costs exactly the same as a 5-address one."),
      h("p", { class: "muted" }, "Two hard limits, both from the contract: the root can be set " +
        "exactly once, and only within 30 days of registration."),
      ev.hasAllowlist
        ? note("warn", "This event already has a root", "It is " + ev.allowlistRoot +
          " and the contract will not let it be replaced. Everything below is still useful for " +
          "regenerating the distributable file from the same address list.")
        : locked ? note("warn", "Too late", "The 30-day window closed; no allowlist can be set now.") : null
    ]));

    var ta = h("textarea", { placeholder: "0xabc…\n0xdef…\n\nOne address per line, or comma-separated, or a JSON array.", style: "min-height:150px" });
    var report = h("div", { class: "stack", style: "margin-top:12px" });
    var tree = null;

    function rebuild() {
      clear(report); tree = null;
      var parsed = M.parseAddresses(ta.value);
      if (!parsed.addresses.length) return;
      try { tree = M.build(parsed.addresses); } catch (e) { report.appendChild(note("err", null, String(e))); return; }
      report.appendChild(note("ok", parsed.addresses.length + " addresses → root " + tree.root.slice(0, 18) + "…",
        h("div", { class: "stack" }, [
          h("div", { class: "mono" }, tree.root),
          h("div", { class: "flexrow" }, [copyBtn(tree.root, "copy root"),
            h("button", { class: "sm", onclick: function () {
              download("allowlist-event-" + ev.id + ".json",
                JSON.stringify(M.bundle(tree, { chainId: chainId, contract: chain().contract, eventId: ev.id }), null, 1));
            } }, "download allowlist file")])
        ])));
      if (parsed.duplicates.length) report.appendChild(note("warn", null,
        parsed.duplicates.length + " duplicate address" + (parsed.duplicates.length === 1 ? "" : "es") +
        " ignored — the contract allows one mint per wallet anyway."));
      if (parsed.invalid.length) report.appendChild(note("err", "Not valid addresses",
        parsed.invalid.slice(0, 6).join(", ") + (parsed.invalid.length > 6 ? " …and " + (parsed.invalid.length - 6) + " more" : "")));
      var sample = parsed.addresses[0];
      report.appendChild(note("info", "Self-check",
        M.verifyLocal(tree.root, sample, M.proofFor(tree, sample))
          ? "A proof for " + W.short(sample) + " verifies against this root using the same fold the " +
            "contract runs. Generation and verification agree."
          : "Proof generation and verification disagree — do not use this root."));
    }
    ta.addEventListener("input", rebuild);

    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "1. Paste your address list"),
      ta, report
    ]));

    var setCard = h("div", { class: "card" }, [h("h3", { style: "margin-top:0" }, "2. Write the root onchain")]);
    root.appendChild(setCard);
    var run = txRunner(setCard);
    var setBtn = h("button", { class: "primary", disabled: locked || ev.hasAllowlist || !isCreator,
      onclick: function () {
        if (!tree) { alert("Paste an address list first."); return; }
        if (!confirm("Set the allowlist root to\n\n" + tree.root + "\n\nThis can only ever be done once for this event.")) return;
        run(setBtn, "updateAllowlistRoot", [ev.id, tree.root], "Allowlist root set. Distribute the file now.");
      } }, "Set allowlist root (one time only)");
    setCard.insertBefore(setBtn, setCard.lastChild);

    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "3. Give people what they need"),
      h("p", { class: "muted" },
        "Download the allowlist file above and publish it anywhere — your site, a gist, IPFS, an " +
        "attachment in the confirmation email. It contains every address and every proof, which is " +
        "safe: a proof only works from the address it names, so one file serves everybody."),
      h("ol", { class: "steps" }, [
        h("li", null, [h("b", null, "Host the file"), "Anywhere public. It is a few KB per hundred addresses."]),
        h("li", null, [h("b", null, "Send people the event link"), h("span", { class: "mono" }, location.origin + location.pathname + "#/event/" + ev.id)]),
        h("li", null, [h("b", null, "They load it and mint"),
          "On the event page they pick “Allowlist mint”, choose the file, and the browser finds their " +
          "address and derives the proof. No server, no per-person emails, nothing for you to run."])
      ]),
      note("info", "Why this and not signatures?",
        "An allowlist works from a plain static file and a QR code, because proofs can be derived by the " +
        "visitor. Signature minting cannot: only the creator's key can produce a signature, so somebody " +
        "or something has to be online to sign. If you know the addresses in advance, use an allowlist.")
    ]));
  }

  function paneSignatures(root, ev, isCreator, now) {
    var open = now < ev.signatureExpiresAt;
    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "Signature minting"),
      h("p", { class: "muted" },
        "You sign a message naming one event, one chain and one recipient address. That signature lets " +
        "that address — and only that address — mint. It costs you no gas, needs no onchain setup, and " +
        "works for people you did not know about when you registered the event."),
      open ? note("info", null, "Open until " + fmtDateTime(ev.signatureExpiresAt) + " (" + relative(ev.signatureExpiresAt) + "). " +
        "That is 37 days after registration and it cannot be extended.")
           : note("warn", null, "Closed since " + fmtDateTime(ev.signatureExpiresAt) + ". The contract will reject any signature now.")
    ]));

    var ta = h("textarea", { placeholder: "0xabc…\n0xdef…\nOne recipient address per line.", style: "min-height:110px" });
    var out = h("div", { class: "stack", style: "margin-top:12px" });
    var btn = h("button", { class: "primary", disabled: !open || !isCreator, onclick: sign }, "Sign for these addresses");

    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "Batch-sign"),
      ta, h("div", { style: "margin-top:11px" }, btn), out,
      h("p", { class: "hint" }, "Your wallet will ask you to sign once per address. Nothing is broadcast; " +
        "these are offchain signatures.")
    ]));

    async function sign() {
      var parsed = M.parseAddresses(ta.value);
      clear(out);
      if (!parsed.addresses.length) { out.appendChild(note("err", null, "No valid addresses.")); return; }
      if (parsed.invalid.length) out.appendChild(note("warn", null, "Skipping " + parsed.invalid.length + " unparseable entries."));
      btn.disabled = true;
      var prog = h("div"); out.appendChild(prog);
      var sigs = {};
      try {
        var signer = await W.requireChain(chainId);
        for (var i = 0; i < parsed.addresses.length; i++) {
          clear(prog).appendChild(spinner("signing " + (i + 1) + " of " + parsed.addresses.length + " — " + W.short(parsed.addresses[i])));
          sigs[parsed.addresses[i]] = await P.signFor(signer, ev.id, chainId, parsed.addresses[i]);
        }
        clear(prog);
        var bundle = { format: "onchain-poaps-signatures@1", chainId: chainId, contract: chain().contract,
          eventId: ev.id, expiresAt: ev.signatureExpiresAt, signer: await signer.getAddress(), signatures: sigs };
        out.appendChild(note("ok", parsed.addresses.length + " signatures ready",
          h("div", { class: "flexrow" }, [
            h("button", { class: "sm", onclick: function () {
              download("signatures-event-" + ev.id + ".json", JSON.stringify(bundle, null, 1)); } }, "download JSON"),
            h("button", { class: "sm", onclick: function () {
              var rows = ["address,signature,mint_url"].concat(parsed.addresses.map(function (a) {
                return [a, sigs[a], location.origin + location.pathname + "#/event/" + ev.id].join(","); }));
              download("signatures-event-" + ev.id + ".csv", rows.join("\n"), "text/csv"); } }, "download CSV")
          ])));
        out.appendChild(note("info", "Handing these out",
          "Send each person their own row. A signature is not a secret — it is worthless to anyone " +
          "else, because the contract recovers the address it was signed for and refuses everybody else."));
      } catch (e) {
        clear(prog).appendChild(note("err", "Signing stopped", P.explainError(e)));
      } finally { btn.disabled = false; }
    }

    // ---- QR ----------------------------------------------------------------
    var url = location.origin + location.pathname + "#/event/" + ev.id;
    var qrWrap = h("div", { class: "center" });
    var qrCard = h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "QR code for the door"),
      h("p", { class: "muted" },
        "Put this on a screen, a poster, a badge or a sticker. It opens the event page, where the " +
        "attendee connects a wallet and mints by whichever route you left open."),
      qrWrap,
      h("p", { class: "mono center small" }, url),
      h("div", { class: "flexrow", style: "justify-content:center" }, [
        copyBtn(url, "copy link"),
        h("button", { class: "sm", onclick: function () { printQR(ev, url); } }, "print poster")
      ]),
      note("warn", "The honest caveat about QR codes and signatures",
        "A signature names one address, and a printed QR code cannot know who is about to scan it. So a " +
        "static QR can never carry a signature. For a live event you have three real options: open " +
        "public minting for the duration and close it afterwards; publish an allowlist if you know the " +
        "guest list in advance; or stand at the door and sign per-address on the spot from this page. " +
        "Anything that promises a universal signature QR is either running a signing server with your " +
        "key in it, or wrong.")
    ]);
    root.appendChild(qrCard);
    renderQR(qrWrap, url);
  }

  function qrDataUrl(text, scale) {
    var q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createDataURL(scale || 8, 8);
  }
  function renderQR(wrap, url) {
    clear(wrap);
    try {
      wrap.appendChild(h("div", { class: "qr" }, h("img", { src: qrDataUrl(url, 8), alt: "QR code" })));
    } catch (e) {
      wrap.appendChild(note("err", null, "Could not build a QR code for that URL: " + e));
    }
  }
  function printQR(ev, url) {
    var w = window.open("", "_blank");
    if (!w) return;
    w.document.write('<!doctype html><meta charset="utf-8"><title>' + esc(ev.name) + '</title>' +
      '<style>body{font:16px -apple-system,Segoe UI,Roboto,sans-serif;text-align:center;padding:8vh 6vw;color:#111}' +
      'h1{font-size:38px;margin:0 0 6px}p{color:#555;margin:4px 0}img{width:min(62vw,420px);margin:26px 0}' +
      'code{font-size:13px;color:#666;word-break:break-all}</style>' +
      "<h1>" + esc(ev.name || "Onchain POAP") + "</h1>" +
      (ev.description ? "<p>" + esc(ev.description) + "</p>" : "") +
      '<img src="' + qrDataUrl(url, 10) + '" alt="">' +
      "<p><b>Scan to mint your POAP</b></p><p><code>" + esc(url) + "</code></p>");
    w.document.close();
    setTimeout(function () { try { w.print(); } catch (e) { } }, 400);
  }

  function paneDirect(root, ev, isCreator, now) {
    var locked = now >= ev.lockExpiresAt;
    root.appendChild(h("div", { class: "card" }, [
      h("h3", { style: "margin-top:0" }, "Mint straight to a list of addresses"),
      h("p", { class: "muted" },
        "You pay the gas and the recipients do nothing at all. Up to 101 addresses per transaction; " +
        "anyone already holding the POAP is skipped rather than reverting the batch. Only within the " +
        "30-day window."),
      locked ? note("warn", null, "The 30-day window has closed, so this is no longer available.") : null
    ]));
    var ta = h("textarea", { placeholder: "0xabc…\n0xdef…", style: "min-height:130px" });
    var info = h("div", { style: "margin-top:9px" });
    ta.addEventListener("input", function () {
      var p = M.parseAddresses(ta.value);
      clear(info);
      if (!p.addresses.length) return;
      var batches = Math.ceil(p.addresses.length / P.MAX.recipients);
      info.appendChild(h("p", { class: "small" }, p.addresses.length + " recipients" +
        (p.duplicates.length ? ", " + p.duplicates.length + " duplicates dropped" : "") +
        (p.invalid.length ? ", " + p.invalid.length + " unparseable" : "") +
        " → " + batches + " transaction" + (batches === 1 ? "" : "s")));
    });
    var card = h("div", { class: "card" }, [h("h3", { style: "margin-top:0" }, "Recipients"), ta, info]);
    root.appendChild(card);
    var run = txRunner(card);
    var btn = h("button", { class: "primary", disabled: locked || !isCreator, onclick: function () {
      var p = M.parseAddresses(ta.value);
      if (!p.addresses.length) { alert("No valid addresses."); return; }
      if (p.addresses.length > P.MAX.recipients) {
        alert("The contract takes at most " + P.MAX.recipients + " per transaction. Send the first " +
              P.MAX.recipients + " now and the rest after.");
        p.addresses = p.addresses.slice(0, P.MAX.recipients);
      }
      run(btn, "creatorMint", [ev.id, p.addresses], "Minted to " + p.addresses.length + " addresses.");
    } }, "Mint to these addresses");
    card.insertBefore(h("div", { style: "margin-top:11px" }, btn), card.lastChild);
  }

  // =========================================================================
  // Gallery
  // =========================================================================
  async function viewGallery(root) {
    root.appendChild(h("h1", null, "My POAPs"));
    var addr = W.state.address;
    if (!addr) {
      root.appendChild(h("div", { class: "empty" }, [
        h("p", null, "Connect a wallet to see the POAPs it holds."),
        h("button", { class: "primary", onclick: function () { W.connect().then(render); } }, "Connect wallet")
      ]));
      return;
    }
    root.appendChild(h("p", { class: "muted", style: "margin-top:0" }, [
      "Held by ", h("span", { class: "addr" }, addr), " on " + chain().name + "."]));
    var status = h("div"); root.appendChild(status);
    var grid = h("div", { class: "grid" }); root.appendChild(grid);
    status.appendChild(spinner("checking every event…"));
    try {
      var c = P.readContract(chainId);
      var total = Number(await c.totalEvents());
      var ids = [], owners = [];
      for (var i = 0; i <= total; i++) { ids.push(i); owners.push(addr); }
      // One balanceOfBatch instead of N balanceOf calls: a 500-event contract is
      // still a single round trip.
      var bal = await c.balanceOfBatch(owners, ids);
      var mine = ids.filter(function (id, k) { return Number(bal[k]) > 0; });
      clear(status);
      if (!mine.length) {
        status.appendChild(h("div", { class: "empty" }, [
          h("p", null, "Nothing here yet."),
          h("a", { class: "btn", href: "#/" }, "Browse events to mint")]));
        return;
      }
      status.appendChild(h("p", { class: "small" }, mine.length + " POAP" + (mine.length === 1 ? "" : "s") + " held."));
      for (var j = 0; j < mine.length; j++) {
        var ev = await P.getEvent(chainId, mine[j]);
        var tile = eventTile(ev);
        $(".tags", tile).appendChild(h("span", { class: "tag mine" }, "held"));
        grid.appendChild(tile);
      }
    } catch (e) {
      clear(status).appendChild(note("err", "Could not read balances", P.explainError(e)));
    }
  }

  // =========================================================================
  // Router / shell
  // =========================================================================
  function setChain(id) {
    chainId = id; localStorage.setItem("poap.chain", String(id));
    artCache = {}; render();
  }

  function header() {
    var el = $("#hdr"); clear(el);
    el.appendChild(h("a", { class: "brand", href: "#/" }, [
      h("span", { html: '<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="9" stroke="#7dd3fc" stroke-width="1.6"/><circle cx="11" cy="11" r="3.4" fill="#a78bfa"/></svg>' }),
      "Onchain POAPs"
    ]));
    var route = (location.hash || "#/").split("/")[1] || "";
    var nav = h("nav", { class: "main" }, [
      h("a", { href: "#/", class: route === "" ? "on" : "" }, "Explore"),
      h("a", { href: "#/create", class: route === "create" ? "on" : "" }, "Create"),
      h("a", { href: "#/gallery", class: route === "gallery" ? "on" : "" }, "My POAPs"),
      h("a", { href: "#/docs", class: route === "docs" ? "on" : "" }, "Docs")
    ]);
    el.appendChild(nav);
    el.appendChild(h("div", { class: "spacer" }));

    var sel = h("select", { style: "width:auto;padding:6px 9px;font-size:13px", onchange: function (e) { setChain(Number(e.target.value)); } },
      Object.keys(P.CHAINS).map(function (k) {
        return h("option", { value: k, selected: Number(k) === chainId }, P.CHAINS[k].name + (P.CHAINS[k].contract ? "" : " (no deploy)"));
      }));
    el.appendChild(sel);

    if (W.state.address) {
      el.appendChild(h("span", { class: "pill" }, [
        h("span", { class: "dot on" }),
        W.state.miniapp && W.state.context && W.state.context.user && W.state.context.user.username
          ? "@" + W.state.context.user.username : W.short(W.state.address)
      ]));
    } else {
      el.appendChild(h("button", { class: "primary", onclick: function (e) {
        var b = e.currentTarget; b.disabled = true; b.textContent = "connecting…";
        W.connect().then(function () { header(); render(); }).catch(function (err) {
          b.disabled = false; b.textContent = "Connect";
          alert(P.explainError(err));
        });
      } }, "Connect"));
    }
  }

  async function render() {
    var root = clear($("#app"));
    root.className = "";
    var hash = location.hash || "#/";
    var parts = hash.replace(/^#\/?/, "").split("/");
    header();
    try {
      if (parts[0] === "" ) await viewExplore(root);
      else if (parts[0] === "create") viewCreate(root);
      else if (parts[0] === "event") await viewEvent(root, parts[1]);
      else if (parts[0] === "manage") await viewManage(root, parts[1]);
      else if (parts[0] === "gallery") await viewGallery(root);
      else if (parts[0] === "docs") { root.className = "narrow docs"; global.renderDocs(root, { chain: chain, h: h, note: note }); }
      else root.appendChild(note("err", "No such page", hash));
    } catch (e) {
      root.appendChild(note("err", "Something broke", P.explainError(e)));
      console.error(e);
    }
    if (parts[0] === "docs" && location.hash.indexOf("#", 1) > 0) {
      var id = location.hash.split("#")[2];
      var t = id && document.getElementById(id);
      if (t) t.scrollIntoView();
    } else window.scrollTo(0, 0);
    W.signalReady();
  }

  window.addEventListener("hashchange", render);
  W.onChange(function () { header(); });

  (async function boot() {
    await W.detectMiniApp();
    if (W.state.miniapp) { try { await W.connect("farcaster"); } catch (e) { } }
    await render();
    W.signalReady();
  })();

  global.App = { render: render, h: h, note: note, chain: chain };
})(window);
