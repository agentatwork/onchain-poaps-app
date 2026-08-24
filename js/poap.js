// Onchain POAPs — contract layer.
//
// Everything the app knows about the protocol lives here: addresses, the ABI, the
// flag encoding, and the two decisions the contract makes that the UI has to mirror
// exactly (the 30-day creator lock and the 37-day signature window).
//
// No build step, no framework. This file is loaded as a plain script and hangs one
// object off window.

(function (global) {
  "use strict";

  var E = global.ethers;

  // ---- Chains ------------------------------------------------------------
  // Add a row here and the whole app supports the chain. Nothing else is
  // chain-aware; the deployment address is the only thing that varies.
  var CHAINS = {
    84532: {
      id: 84532,
      hexId: "0x14a34",
      name: "Base Sepolia",
      short: "base-sepolia",
      contract: "0xC3249356a483fbe17d5355D39105D2eA666d9de6",
      rpc: ["https://base-sepolia-rpc.publicnode.com", "https://sepolia.base.org"],
      explorer: "https://sepolia.basescan.org",
      opensea: "https://testnets.opensea.io/assets/base_sepolia",
      currency: { name: "Ether", symbol: "ETH", decimals: 18 },
      testnet: true
    },
    8453: {
      id: 8453,
      hexId: "0x2105",
      name: "Base",
      short: "base",
      // No mainnet deployment exists yet. The bounty says mainnet comes later;
      // when it does, put the address here and nothing else changes.
      contract: null,
      rpc: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
      explorer: "https://basescan.org",
      opensea: "https://opensea.io/assets/base",
      currency: { name: "Ether", symbol: "ETH", decimals: 18 },
      testnet: false
    }
  };
  var DEFAULT_CHAIN = 84532;

  // ---- ABI ---------------------------------------------------------------
  // Hand-written from src/Poap.sol rather than copied from an artifact, so that
  // every entry here is one the app actually calls.
  var ABI = [
    "function totalEvents() view returns (uint256)",
    "function events(uint256) view returns (string name, string description, uint256 eventDate, string location, bytes32 allowlistRoot, address svgImage, address creator, uint256 createdAt, string externalUrl, bool isSoulbound, bool isPublic)",
    "function hasClaimed(uint256, address) view returns (bool)",
    "function uri(uint256) view returns (string)",
    "function balanceOf(address, uint256) view returns (uint256)",
    "function balanceOfBatch(address[], uint256[]) view returns (uint256[])",
    "function getMultichainEventId(uint256) view returns (string)",
    "function CREATOR_TIMELOCK() view returns (uint256)",

    "function registerEvent(string name, string description, uint256 eventDate, string location, bytes32 allowlistRoot, string svgImage, string externalUrl, uint8 flags) returns (uint256)",
    "function mint(uint256 eventId)",
    "function allowlistMint(uint256 eventId, bytes32[] merkleProof)",
    "function mintWithSignature(uint256 eventId, bytes signature)",
    "function creatorMint(uint256 eventId, address[] recipients)",
    "function updateAllowlistRoot(uint256 eventId, bytes32 newRoot)",
    "function updateEventPublic(uint256 eventId, bool isPublic)",
    "function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)",

    "event NewEvent(uint256 indexed eventId, string name, address indexed creator)",
    "event NewMint(uint256 indexed eventId, address indexed minter)",
    "event AllowlistUpdated(uint256 indexed eventId, bytes32 newRoot)",
    "event EventPublicUpdated(uint256 indexed eventId, bool isPublic)",

    // Custom errors, so a revert can be shown as a sentence instead of a hex blob.
    "error POAP__InvalidValue(string field)",
    "error POAP__TimeLockExpired()",
    "error POAP__OnlyCreator()",
    "error POAP__AlreadyClaimed()",
    "error POAP__EventNotPublic()",
    "error POAP__AllowlistNotEnabled()",
    "error POAP__RootAlreadySet()",
    "error POAP__SoulboundNotTransferable()"
  ];

  var IFACE = new E.Interface(ABI);

  // ---- Contract constants, mirrored ---------------------------------------
  var CREATOR_TIMELOCK = 30 * 24 * 3600;   // creator functions: 30 days
  var SIGNATURE_GRACE = 7 * 24 * 3600;    // mintWithSignature: +7 more
  var SIGNATURE_WINDOW = CREATOR_TIMELOCK + SIGNATURE_GRACE;   // 37 days
  var ZERO_ROOT = "0x" + "0".repeat(64);
  var MAX = { name: 128, description: 512, location: 128, externalUrl: 128, recipients: 101 };

  // flags: bit 0 = soulbound, bit 1 = public
  function flagsFor(isSoulbound, isPublic) {
    return (isSoulbound ? 1 : 0) | (isPublic ? 2 : 0);
  }
  function decodeFlags(f) {
    return { isSoulbound: f === 1 || f === 3, isPublic: f === 2 || f === 3 };
  }

  // ---- Providers ---------------------------------------------------------
  // Read paths never need a wallet. That matters: the explorer, an event page and
  // the docs all work with no extension installed and nothing connected, which is
  // most of what a POAP minter arriving from a QR code will see first.
  var _readCache = {};
  function readProvider(chainId) {
    var c = CHAINS[chainId];
    if (!c) throw new Error("unsupported chain " + chainId);
    if (!_readCache[chainId]) {
      _readCache[chainId] = c.rpc.length > 1
        ? new E.FallbackProvider(c.rpc.map(function (u, i) {
            return { provider: new E.JsonRpcProvider(u, chainId, { staticNetwork: true }), priority: i + 1, stallTimeout: 2500, weight: 1 };
          }), chainId, { quorum: 1 })
        : new E.JsonRpcProvider(c.rpc[0], chainId, { staticNetwork: true });
    }
    return _readCache[chainId];
  }

  function readContract(chainId) {
    var c = CHAINS[chainId];
    if (!c.contract) throw new Error(c.name + " has no deployment yet");
    return new E.Contract(c.contract, ABI, readProvider(chainId));
  }

  function writeContract(chainId, signer) {
    var c = CHAINS[chainId];
    if (!c.contract) throw new Error(c.name + " has no deployment yet");
    return new E.Contract(c.contract, ABI, signer);
  }

  // ---- Event reads -------------------------------------------------------

  function normalizeEvent(id, raw) {
    var createdAt = Number(raw.createdAt);
    return {
      id: Number(id),
      name: raw.name,
      description: raw.description,
      eventDate: Number(raw.eventDate),
      location: raw.location,
      allowlistRoot: raw.allowlistRoot,
      svgPointer: raw.svgImage,
      creator: raw.creator,
      createdAt: createdAt,
      externalUrl: raw.externalUrl,
      isSoulbound: raw.isSoulbound,
      isPublic: raw.isPublic,
      hasAllowlist: raw.allowlistRoot !== ZERO_ROOT,
      lockExpiresAt: createdAt + CREATOR_TIMELOCK,
      signatureExpiresAt: createdAt + SIGNATURE_WINDOW
    };
  }

  async function getEvent(chainId, id) {
    var raw = await readContract(chainId).events(id);
    return normalizeEvent(id, raw);
  }

  async function getTotalEvents(chainId) {
    return Number(await readContract(chainId).totalEvents());
  }

  // Event 0 is the genesis POAP the constructor mints, so ids run 0..totalEvents
  // inclusive. Off-by-one here is the difference between showing the genesis POAP
  // and dropping the newest event, and both look like a working app.
  async function listEvents(chainId, opts) {
    opts = opts || {};
    var c = readContract(chainId);
    var total = Number(await c.totalEvents());
    var ids = [];
    for (var i = total; i >= 0; i--) ids.push(i);
    if (opts.limit) ids = ids.slice(0, opts.limit);
    var out = [];
    // Batched so a 50-event contract is a handful of round trips, not 50.
    for (var s = 0; s < ids.length; s += 10) {
      var chunk = ids.slice(s, s + 10);
      var got = await Promise.all(chunk.map(function (id) {
        return c.events(id).then(function (r) { return normalizeEvent(id, r); })
                           .catch(function () { return null; });
      }));
      got.forEach(function (e) { if (e) out.push(e); });
      if (opts.onBatch) opts.onBatch(out.slice());
    }
    return out;
  }

  // ---- Metadata ----------------------------------------------------------
  // uri() returns a data: URL with base64 JSON whose `image` is itself a base64
  // data: URL of the SVG. Everything is onchain; nothing here touches a gateway.
  function decodeDataUri(uri) {
    var comma = uri.indexOf(",");
    if (comma < 0) return null;
    var head = uri.slice(0, comma), body = uri.slice(comma + 1);
    if (/;base64/i.test(head)) {
      try { return decodeURIComponent(escape(atob(body))); } catch (e) { return atob(body); }
    }
    return decodeURIComponent(body);
  }

  // The contract interpolates creator-supplied strings straight into the metadata
  // JSON without escaping them. A description containing a newline — which any
  // textarea produces and which the contract accepts — therefore yields a
  // document that JSON.parse rejects outright, and the POAP shows up blank in
  // every wallet and marketplace that reads it. One of the eleven events on Base
  // Sepolia is already in that state. It is onchain and cannot be fixed, so this
  // repairs the string on read: escape the raw control characters that appear
  // inside string literals and try again, flagging that it had to.
  function repairJson(s) {
    var out = "", inStr = false, esc = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i], code = s.charCodeAt(i);
      if (esc) { out += ch; esc = false; continue; }
      if (ch === "\\" && inStr) { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = !inStr; out += ch; continue; }
      if (inStr && code < 0x20) {
        out += code === 10 ? "\\n" : code === 13 ? "\\r" : code === 9 ? "\\t"
             : "\\u" + ("000" + code.toString(16)).slice(-4);
        continue;
      }
      out += ch;
    }
    return out;
  }

  async function getMetadata(chainId, id) {
    var uri = await readContract(chainId).uri(id);
    var json = decodeDataUri(uri);
    if (!json) return null;
    var meta, repaired = false, parseError = null;
    try {
      meta = JSON.parse(json);
    } catch (e) {
      parseError = e.message;
      try { meta = JSON.parse(repairJson(json)); repaired = true; }
      catch (e2) {
        // Last resort: the artwork is the part people came for. Pull it out with
        // a regex so a malformed document still renders something.
        var m = json.match(/"image"\s*:\s*"(data:[^"]+)"/);
        var n = json.match(/"name"\s*:\s*"([^"]*)"/);
        if (!m) throw e;
        meta = { name: n ? n[1] : "", image: m[1] };
        repaired = true;
      }
    }
    meta._raw = uri;
    meta._repaired = repaired;
    meta._parseError = parseError;
    if (meta.image && meta.image.indexOf("data:") === 0) meta._svg = decodeDataUri(meta.image);
    return meta;
  }

  // Which characters in a creator-supplied string will break the metadata if the
  // contract writes them unescaped. Used by the Create form to prevent the
  // problem rather than repair it afterwards.
  function unsafeChars(s) {
    var found = {};
    for (var i = 0; i < (s || "").length; i++) {
      var c = s.charCodeAt(i);
      if (c < 0x20 || c === 0x7f) found[c] = (found[c] || 0) + 1;
      else if (s[i] === '"' || s[i] === "\\") found[s[i]] = (found[s[i]] || 0) + 1;
    }
    return found;
  }
  function sanitize(s) {
    return String(s || "").replace(/[\u0000-\u001f\u007f]/g, " ")
                          .replace(/[\\"]/g, "'").replace(/ {2,}/g, " ").trim();
  }

  // ---- Eligibility -------------------------------------------------------
  // One function that answers "can this address mint, and by which route" for the
  // whole UI, so the event page, the gallery and the QR landing page can never
  // disagree with each other about what is possible.
  async function mintOptions(chainId, ev, address, opts) {
    opts = opts || {};
    var now = Math.floor(Date.now() / 1000);
    var claimed = false;
    if (address) {
      try { claimed = await readContract(chainId).hasClaimed(ev.id, address); } catch (e) { }
    }
    var sigOpen = now < ev.signatureExpiresAt;
    var lockOpen = now < ev.lockExpiresAt;
    return {
      alreadyClaimed: claimed,
      lockOpen: lockOpen,
      routes: [
        {
          key: "public",
          label: "Public mint",
          available: ev.isPublic,
          usable: ev.isPublic && !claimed,
          why: ev.isPublic
            ? "Anyone with a wallet can mint this, once."
            : "The creator has not enabled public minting."
        },
        {
          key: "allowlist",
          label: "Allowlist mint",
          available: ev.hasAllowlist,
          usable: ev.hasAllowlist && !claimed && !!opts.hasProof,
          why: !ev.hasAllowlist
            ? "This event has no allowlist."
            : (opts.hasProof
                ? "Your address is in the published allowlist."
                : "Open to addresses in the creator's allowlist. Load the allowlist file to check yours.")
        },
        {
          key: "signature",
          label: "Signature mint",
          available: sigOpen,
          usable: sigOpen && !claimed && !!opts.hasSignature,
          why: sigOpen
            ? "Open until " + new Date(ev.signatureExpiresAt * 1000).toUTCString() +
              " — needs a signature from the creator naming your address."
            : "Closed. Signature minting ends 37 days after registration."
        }
      ]
    };
  }

  // ---- Signature mint ----------------------------------------------------
  // The contract recovers from keccak256(abi.encodePacked(uint256 eventId,
  // uint256 chainid, address recipient)) wrapped in the EIP-191 personal_sign
  // prefix. The recipient is INSIDE the signed message, which is the single most
  // consequential fact about this feature: a signature is minted by exactly one
  // address and by no other, so it can be handed out in the clear.
  function signatureDigest(eventId, chainId, recipient) {
    return E.solidityPackedKeccak256(
      ["uint256", "uint256", "address"],
      [BigInt(eventId), BigInt(chainId), recipient]
    );
  }

  async function signFor(signer, eventId, chainId, recipient) {
    // getBytes: sign the 32 raw bytes, not their hex string.
    return signer.signMessage(E.getBytes(signatureDigest(eventId, chainId, recipient)));
  }

  function recoverSigner(eventId, chainId, recipient, signature) {
    try {
      return E.verifyMessage(E.getBytes(signatureDigest(eventId, chainId, recipient)), signature);
    } catch (e) { return null; }
  }

  // ---- Error decoding ----------------------------------------------------
  var ERROR_TEXT = {
    "POAP__TimeLockExpired": "The 30-day creator window for this event has closed. Creator settings are permanent now.",
    "POAP__OnlyCreator": "Only the address that registered this event can do that.",
    "POAP__AlreadyClaimed": "This address already holds this POAP. The contract allows one per wallet.",
    "POAP__EventNotPublic": "Public minting is not enabled for this event.",
    "POAP__AllowlistNotEnabled": "This event has no allowlist, so there is nothing to prove membership of.",
    "POAP__RootAlreadySet": "The allowlist root has already been set, and the contract allows it only once.",
    "POAP__SoulboundNotTransferable": "This POAP is soulbound: it cannot leave the wallet that minted it."
  };
  var FIELD_TEXT = {
    name: "Name is required and must be 1–128 characters.",
    description: "Description must be 512 characters or fewer.",
    svg: "An SVG image is required.",
    location: "Location must be 128 characters or fewer.",
    url: "External URL must be 128 characters or fewer.",
    flags: "Invalid soulbound/public combination.",
    eventId: "That event does not exist.",
    proof: "That Merkle proof is not valid for this allowlist.",
    signer: "That signature was not produced by the event creator (or is for a different address).",
    recipients: "Batch mint is limited to 101 recipients per transaction."
  };

  function explainError(err) {
    var data = err && (err.data || (err.info && err.info.error && err.info.error.data) ||
                       (err.error && err.error.data));
    if (typeof data === "string" && data.length >= 10) {
      try {
        var parsed = IFACE.parseError(data);
        if (parsed) {
          if (parsed.name === "POAP__InvalidValue") {
            var f = parsed.args[0];
            return FIELD_TEXT[f] || ("Invalid value for “" + f + "”.");
          }
          if (ERROR_TEXT[parsed.name]) return ERROR_TEXT[parsed.name];
          return parsed.name;
        }
      } catch (e) { }
    }
    var m = (err && (err.shortMessage || err.message)) || String(err);
    if (/user rejected|ACTION_REJECTED/i.test(m)) return "You rejected the transaction in your wallet.";
    if (/insufficient funds/i.test(m)) return "Not enough ETH in this wallet to pay gas.";
    for (var k in ERROR_TEXT) if (m.indexOf(k) >= 0) return ERROR_TEXT[k];
    for (var f2 in FIELD_TEXT) if (m.indexOf('"' + f2 + '"') >= 0) return FIELD_TEXT[f2];
    return m;
  }

  global.POAP = {
    CHAINS: CHAINS, DEFAULT_CHAIN: DEFAULT_CHAIN, ABI: ABI, IFACE: IFACE,
    CREATOR_TIMELOCK: CREATOR_TIMELOCK, SIGNATURE_WINDOW: SIGNATURE_WINDOW,
    ZERO_ROOT: ZERO_ROOT, MAX: MAX,
    flagsFor: flagsFor, decodeFlags: decodeFlags,
    readProvider: readProvider, readContract: readContract, writeContract: writeContract,
    getEvent: getEvent, getTotalEvents: getTotalEvents, listEvents: listEvents,
    getMetadata: getMetadata, decodeDataUri: decodeDataUri, repairJson: repairJson,
    unsafeChars: unsafeChars, sanitize: sanitize,
    mintOptions: mintOptions,
    signatureDigest: signatureDigest, signFor: signFor, recoverSigner: recoverSigner,
    explainError: explainError
  };
})(window);
