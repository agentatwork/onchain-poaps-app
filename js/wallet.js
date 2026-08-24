// Wallet layer: one connect button that means three different things.
//
// Inside a Farcaster client the app is a Mini App and the wallet is the user's
// Farcaster wallet, already connected, no prompt. In a browser it is whatever
// EIP-1193 provider is injected. With neither, every read path still works —
// browsing events, viewing artwork, checking whether an address is on an
// allowlist — because nothing about looking at a POAP should require a wallet.

(function (global) {
  "use strict";
  var E = global.ethers;

  var state = {
    provider: null,      // ethers BrowserProvider
    signer: null,
    address: null,
    chainId: null,
    kind: null,          // "farcaster" | "injected"
    miniapp: false,
    context: null        // Farcaster context, when in a Mini App
  };
  var listeners = [];

  function emit() { listeners.forEach(function (f) { try { f(state); } catch (e) { } }); }
  function onChange(f) { listeners.push(f); return function () { listeners = listeners.filter(function (g) { return g !== f; }); }; }

  // The Mini App SDK is vendored, not fetched from a CDN, so this check is a
  // property lookup rather than a network round trip that can fail offline.
  function sdk() {
    return global.miniapp && global.miniapp.sdk ? global.miniapp.sdk : null;
  }

  async function detectMiniApp() {
    var s = sdk();
    if (!s) return false;
    try {
      var inside = await s.isInMiniApp();
      if (!inside) return false;
      state.miniapp = true;
      try { state.context = await s.context; } catch (e) { }
      return true;
    } catch (e) { return false; }
  }

  // Called once the first paint is done. A Mini App that never calls ready()
  // shows the host's splash screen forever, which is the single most common way
  // to ship a Mini App that looks broken.
  async function signalReady() {
    var s = sdk();
    if (!s || !state.miniapp) return;
    try { await s.actions.ready(); } catch (e) { }
  }

  function injected() {
    var eth = global.ethereum;
    if (!eth) return null;
    // Several extensions installed at once: prefer whichever the user set as
    // default rather than whichever loaded last.
    if (eth.providers && eth.providers.length) {
      return eth.providers.find(function (p) { return p.isMetaMask; }) || eth.providers[0];
    }
    return eth;
  }

  async function available() {
    if (await detectMiniApp()) return "farcaster";
    return injected() ? "injected" : null;
  }

  async function connect(preferred) {
    var kind = preferred || (await available());
    var raw;
    if (kind === "farcaster") {
      raw = await sdk().wallet.getEthereumProvider();
      if (!raw) throw new Error("This Farcaster client did not provide a wallet.");
    } else {
      raw = injected();
      if (!raw) throw new Error(
        "No wallet found. Install a browser wallet, or open this app inside Farcaster.");
    }
    await raw.request({ method: "eth_requestAccounts" });
    state.kind = kind;
    state.provider = new E.BrowserProvider(raw, "any");
    state.signer = await state.provider.getSigner();
    state.address = await state.signer.getAddress();
    state.chainId = Number((await state.provider.getNetwork()).chainId);
    wire(raw);
    emit();
    return state;
  }

  var wired = false;
  function wire(raw) {
    if (wired || !raw.on) return;
    wired = true;
    raw.on("accountsChanged", async function (a) {
      if (!a || !a.length) { disconnect(); return; }
      state.signer = await state.provider.getSigner();
      state.address = await state.signer.getAddress();
      emit();
    });
    raw.on("chainChanged", function (id) {
      state.chainId = typeof id === "string" ? parseInt(id, 16) : Number(id);
      emit();
    });
  }

  function disconnect() {
    state.provider = state.signer = state.address = state.chainId = state.kind = null;
    emit();
  }

  // Ask the wallet to move to the chain the app is pointed at, adding it first if
  // the wallet has never heard of it (4902). Base Sepolia is missing from most
  // default wallet chain lists, so without the add branch this fails silently for
  // most first-time users.
  async function switchChain(chainId) {
    var c = global.POAP.CHAINS[chainId];
    if (!c) throw new Error("unknown chain " + chainId);
    var raw = state.provider && state.provider.provider;
    if (!raw) throw new Error("connect a wallet first");
    try {
      await raw.request({ method: "wallet_switchEthereumChain", params: [{ chainId: c.hexId }] });
    } catch (err) {
      if (err && (err.code === 4902 || (err.data && err.data.originalError && err.data.originalError.code === 4902))) {
        await raw.request({
          method: "wallet_addEthereumChain",
          params: [{
            chainId: c.hexId, chainName: c.name, nativeCurrency: c.currency,
            rpcUrls: c.rpc, blockExplorerUrls: [c.explorer]
          }]
        });
      } else throw err;
    }
    state.chainId = chainId;
    emit();
  }

  async function requireChain(chainId) {
    if (!state.signer) await connect();
    if (state.chainId !== chainId) await switchChain(chainId);
    // Re-fetch: some wallets hand back a signer bound to the old network.
    state.signer = await state.provider.getSigner();
    state.address = await state.signer.getAddress();
    return state.signer;
  }

  function short(a) {
    return a ? a.slice(0, 6) + "…" + a.slice(-4) : "";
  }

  global.Wallet = {
    state: state, onChange: onChange, available: available, connect: connect,
    disconnect: disconnect, switchChain: switchChain, requireChain: requireChain,
    detectMiniApp: detectMiniApp, signalReady: signalReady, short: short, sdk: sdk
  };
})(window);
