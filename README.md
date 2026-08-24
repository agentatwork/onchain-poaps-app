# Onchain POAPs — frontend + Farcaster Mini App

A complete, open-source frontend for [Onchain POAPs](https://github.com/jvaleskadevs/onchain-poaps)
by J. Valeska: proof-of-attendance badges whose **artwork and metadata are stored in the contract
itself** via SSTORE2. No IPFS, no metadata server, no gateway.

**Live app:** <https://poaps.agentatwork.xyz>
**Mini App:** the same URL, opened inside any Farcaster client
**Contract:** [`0xC3249356a483fbe17d5355D39105D2eA666d9de6`](https://sepolia.basescan.org/address/0xC3249356a483fbe17d5355D39105D2eA666d9de6#code) on Base Sepolia

Built for [poidh Base bounty #348](https://poidh.xyz/base/bounty/348).

---

## The one design decision everything else follows from

**No build step, no framework, no runtime CDN.**

The contract's whole reason to exist is that a POAP survives without a server. A frontend for it
that dies when a CDN 404s, or that only exists as the output of a toolchain nobody can re-run in
two years, undercuts that. So this is plain HTML, CSS and ES5-compatible JavaScript with every
dependency vendored:

```
git clone https://github.com/agentatwork/onchain-poaps-app
cd onchain-poaps-app
python3 -m http.server 8080          # that is the entire build
```

It runs from a static host, an S3 bucket, an IPFS pin, or a USB stick opened with `file://`.
`vendor/` holds ethers 6.17, Kazuhiko Arase's QR encoder and the Farcaster Mini App SDK — 1.2 MB
total, all MIT, all pinned. The app makes exactly one kind of network request at runtime: JSON-RPC
to a public Base node.

---

## What it does

### Create
Full `registerEvent` coverage — name, description, event date, location, external URL, soulbound
flag, public-mint flag, optional allowlist root. Upload an `.svg` or paste markup and it is
**optimised in the browser before it is priced**: comments, XML prologs, editor metadata and empty
groups stripped, whitespace collapsed, coordinates rounded, hex colours shortened. You see the
before, the after, the byte saving and an estimated gas cost, plus warnings for the three things
that make an onchain SVG a bad idea (embedded rasters, `<script>`, external URLs). The optimiser
bails out and keeps your original if the result would not re-parse — artwork corrupted on its way
to permanent storage is not a recoverable mistake.

### Mint — all three routes
The event page resolves what *this* visitor can actually do and says why for each route:

- **Public mint** — one call, when the creator has it open.
- **Allowlist mint** — load the creator's published allowlist file; the browser finds your address
  and derives the Merkle proof locally.
- **Signature mint** — paste the creator's signature; the app recovers it against your address and
  the creator's, and tells you whether it checks out *before* you spend gas.

Every write is simulated with `staticCall` first, so a failure arrives as
"This address already holds this POAP" rather than a wallet's generic "transaction may fail".
All eight of the contract's custom errors are decoded into sentences.

### Allowlists that a creator can actually operate
Paste addresses in any shape — one per line, commas, quotes, a JSON array, a CSV column. The app
dedupes, reports unparseable lines, builds the tree, shows the root, **verifies a sample proof
against it using the same fold the contract runs**, and produces one distributable JSON file
containing every address and every proof.

Publish that file anywhere. It is not secret — a proof only works from the address it names — so
one public file serves the whole list and the creator never mails anyone anything.

### Signatures, and the truth about QR codes
Batch-sign a pasted list of addresses; download as JSON or a per-person CSV. Generate a QR code and
a printable poster for the event page.

And then the thing most write-ups of this pattern skip:

> A signature names one address, and a printed square of ink cannot know who is about to scan it.
> **A static QR code can never carry a signature.** Anything that promises a universal "signature
> QR" is either running a server holding your signing key, or is broken.

The Docs section spells out the three arrangements that do work for a live event, and the app
recommends allowlists for exactly this reason: they are the only restricted route that survives
being reduced to a static file and a square of ink.

### A contract-level trap, caught at both ends

The contract concatenates creator-supplied strings into its metadata JSON **without escaping them**.
A description containing a line break — which any textarea produces and which `registerEvent`
accepts — lands as a raw newline inside a string literal, so `JSON.parse` rejects the whole
document and the POAP renders **blank** in anything that reads metadata the normal way. It is
onchain, so it cannot be fixed afterwards.

[Event #6 on Base Sepolia](https://poaps.agentatwork.xyz/#/event/6) is already in this state —
1 of the 11 events registered so far.

This app handles it at both ends:

- **Create** flags the characters as you type, explains exactly what they will do, and offers to
  clean them. That is the only moment the problem is still fixable.
- **Reading** repairs the document — escaping control characters inside string literals, falling
  back to extracting the image with a regex — so an already-broken POAP still shows its artwork,
  with a warning explaining why other clients will not.

`test/e2e.js` reproduces the whole thing against the deployed contract: it registers an event with
a newline in the description, confirms the resulting `uri()` does not parse, and confirms the
repair path recovers it.

### Gallery
Every POAP the connected address holds, drawn from the onchain SVG, fetched with a single
`balanceOfBatch` rather than N calls.

### Docs
Eighteen headings covering creation, metadata, SVG economics, soulbound, all four distribution
methods, proof generation (including the three encoding details that produce a tree which is
self-consistent and rejected onchain), the 30/37-day deadlines, independent verification with
`cast`, the full error table, self-hosting and the Mini App.

### Farcaster Mini App
The same files. Inside a Farcaster client it detects the host, connects the user's Farcaster wallet
with no prompt, greets them by username and offers a cast composer after a mint. Outside one it is
an ordinary website and none of that code runs. `/.well-known/farcaster.json` carries a real
account association signed by fid 3346381's custody key.

---

## Tested against the real contract, not a mock

```
$ node test/e2e.js
forking https://base-sepolia-rpc.publicnode.com with anvil …
  ok   fork has the deployed contract  — 24134 bytes of runtime code
  …
58 passed, 0 failed
```

`test/e2e.js` forks Base Sepolia with anvil and drives the **actual deployed bytecode** through
every path the app uses: registration and all four validation reverts, all three mint routes,
double-claim rejection, proof forgery rejection, signature-for-another-address rejection,
non-creator rejection, the soulbound transfer block, batch mint including the 101-recipient cap,
metadata decoding, `balanceOfBatch`, and time-travel over both the 30-day creator lock and the
37-day signature window.

It loads `js/poap.js`, `js/merkle.js` and `js/svgopt.js` **in a `window` shim rather than
re-implementing them**, so a regression in the app's encoding is a regression in the test. And it
needs no faucet, which is why it exists in this form.

Two findings from writing it, both worth knowing if you fork this:

- **Do not use anvil's built-in dev accounts to test mints on a public testnet fork.** On Base
  Sepolia, `0xf39Fd6…`, `0x709979…` and friends carry EIP-7702 delegations — real code,
  `0xef0100…`. A fork inherits it, ERC-1155's acceptance check fires on what you assumed was an
  EOA, the delegate has no `onERC1155Received`, and every mint reverts with *no revert data*. It
  looks exactly like a bug in your app. The suite derives fresh keys and asserts they have no code.
- **Assert reverts with `staticCall`, not by sending.** A reverting send still burns a nonce in the
  signer's local cache; a few of those and ethers and anvil disagree about the next nonce, and a
  later *valid* transaction fails for a reason that has nothing to do with the contract.

---

## Layout

```
index.html                     shell, meta, fc:miniapp embed
css/style.css                  one stylesheet, no preprocessor
js/poap.js                     chains, ABI, reads, eligibility, error decoding
js/merkle.js                   OZ-compatible tree, proofs, paste parser, local verifier
js/svgopt.js                   in-browser SVG optimiser + gas estimate
js/wallet.js                   injected + Farcaster wallet, chain add/switch
js/docs.js                     the documentation
js/app.js                      hash router and every view
vendor/                        ethers, qrcode, farcaster miniapp sdk (all MIT, pinned)
test/e2e.js                    52 assertions against the real contract on a fork
.well-known/farcaster.json     signed Mini App manifest
```

## Adding a chain or a new deployment

One object literal in `js/poap.js`:

```js
8453: { id: 8453, hexId: "0x2105", name: "Base", short: "base",
        contract: "0x…",                       // ← mainnet address when it exists
        rpc: ["https://base-rpc.publicnode.com"], explorer: "https://basescan.org",
        opensea: "https://opensea.io/assets/base", testnet: false }
```

Nothing else in the codebase is chain-aware. Base mainnet is already listed and will light up the
moment an address is filled in.

## Licence

MIT — see [LICENSE](LICENSE). The smart contract is not part of this repository and is unmodified;
it belongs to [jvaleskadevs/onchain-poaps](https://github.com/jvaleskadevs/onchain-poaps).
