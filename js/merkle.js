// Merkle tooling that matches OpenZeppelin's MerkleProof.verify exactly.
//
// Three details decide whether a proof this file generates will be accepted by
// Poap.allowlistMint, and getting any of them wrong produces a tree that is
// perfectly self-consistent and rejected onchain:
//
//   1. leaf = keccak256(abi.encodePacked(address)) — the 20 raw address bytes,
//      hashed ONCE. Not abi.encode (32 padded bytes), and not the double-hash
//      that @openzeppelin/merkle-tree uses by default for its standard trees.
//   2. internal nodes hash the pair in ascending byte order (OZ's _hashPair
//      sorts), so the proof carries no left/right flags.
//   3. an odd node at any level is promoted to the next level unchanged, rather
//      than hashed against itself.
//
// verifyLocal() below re-implements the contract's checker so the UI can prove a
// proof works before anyone spends gas finding out that it doesn't.

(function (global) {
  "use strict";
  var E = global.ethers;

  function leafOf(address) {
    return E.keccak256(E.getBytes(E.getAddress(address)));
  }

  function hashPair(a, b) {
    return a.toLowerCase() <= b.toLowerCase()
      ? E.keccak256(E.concat([a, b]))
      : E.keccak256(E.concat([b, a]));
  }

  // Accepts anything a human might paste: one per line, commas, quotes, JSON
  // array, or a CSV whose first column is the address. Returns {addresses,
  // duplicates, invalid} rather than throwing, because a 400-address paste with
  // one typo should tell you which line, not refuse the whole list.
  function parseAddresses(text) {
    var raw = String(text || "");
    var tokens;
    var trimmed = raw.trim();
    if (trimmed.charAt(0) === "[") {
      try {
        var arr = JSON.parse(trimmed);
        tokens = arr.map(function (x) {
          return typeof x === "string" ? x : (x && (x.address || x.addr)) || "";
        });
      } catch (e) { tokens = null; }
    }
    if (!tokens) tokens = raw.split(/[\s,;"']+/);

    var seen = {}, addresses = [], duplicates = [], invalid = [];
    tokens.forEach(function (t) {
      t = String(t).trim();
      if (!t) return;
      var addr;
      try { addr = E.getAddress(t); } catch (e) { invalid.push(t); return; }
      var k = addr.toLowerCase();
      if (seen[k]) { duplicates.push(addr); return; }
      seen[k] = true;
      addresses.push(addr);
    });
    return { addresses: addresses, duplicates: duplicates, invalid: invalid };
  }

  // Leaves are sorted so the same address set always produces the same root,
  // whatever order it was pasted in. Two people building the same allowlist
  // should be able to compare one hash and be done.
  function build(addresses) {
    var parsed = Array.isArray(addresses) ? { addresses: addresses } : parseAddresses(addresses);
    var addrs = parsed.addresses.slice();
    if (!addrs.length) throw new Error("allowlist is empty");

    var leaves = addrs.map(function (a) { return { addr: a, hash: leafOf(a) }; });
    leaves.sort(function (x, y) { return x.hash < y.hash ? -1 : x.hash > y.hash ? 1 : 0; });

    var layers = [leaves.map(function (l) { return l.hash; })];
    while (layers[layers.length - 1].length > 1) {
      var prev = layers[layers.length - 1], next = [];
      for (var i = 0; i < prev.length; i += 2) {
        next.push(i + 1 < prev.length ? hashPair(prev[i], prev[i + 1]) : prev[i]);
      }
      layers.push(next);
    }

    var index = {};
    layers[0].forEach(function (h, i) { index[h] = i; });

    return {
      root: layers[layers.length - 1][0],
      layers: layers,
      leaves: leaves,
      count: leaves.length,
      indexOfLeaf: index
    };
  }

  function proofFor(tree, address) {
    var leaf = leafOf(address);
    var idx = tree.indexOfLeaf[leaf];
    if (idx === undefined) return null;
    var proof = [];
    for (var l = 0; l < tree.layers.length - 1; l++) {
      var layer = tree.layers[l];
      var pair = idx ^ 1;
      if (pair < layer.length) proof.push(layer[pair]);
      idx = Math.floor(idx / 2);
    }
    return proof;
  }

  // The contract's check, re-run locally. Same sorted-pair fold, same leaf.
  function verifyLocal(root, address, proof) {
    var computed = leafOf(address);
    for (var i = 0; i < proof.length; i++) computed = hashPair(computed, proof[i]);
    return computed.toLowerCase() === String(root).toLowerCase();
  }

  // The whole allowlist as one distributable file. Publishing this — rather than
  // mailing each recipient their own proof — is what makes a static QR code work for
  // an allowlist event: the page loads the file, finds the connected address, and
  // derives the proof in the browser with no server anywhere.
  function bundle(tree, meta) {
    var proofs = {};
    tree.leaves.forEach(function (l) { proofs[l.addr] = proofFor(tree, l.addr); });
    return Object.assign({
      format: "onchain-poaps-allowlist@1",
      root: tree.root,
      count: tree.count,
      leafEncoding: "keccak256(abi.encodePacked(address))",
      pairHashing: "sorted (OpenZeppelin MerkleProof)",
      addresses: tree.leaves.map(function (l) { return l.addr; }),
      proofs: proofs
    }, meta || {});
  }

  global.Merkle = {
    leafOf: leafOf, hashPair: hashPair, parseAddresses: parseAddresses,
    build: build, proofFor: proofFor, verifyLocal: verifyLocal, bundle: bundle
  };
})(window);
