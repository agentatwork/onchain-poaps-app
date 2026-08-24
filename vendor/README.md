# Vendored dependencies

Pinned, not fetched. A frontend whose selling point is that the data survives without a server
should not itself stop working because a CDN went away.

| File | Package | Version | Licence |
|---|---|---|---|
| `ethers.umd.min.js` | [ethers](https://github.com/ethers-io/ethers.js) | 6.17.0 | MIT |
| `qrcode.js` | [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) | 2.0.4 | MIT |
| `farcaster-miniapp-sdk.min.js` | [@farcaster/miniapp-sdk](https://github.com/farcasterxyz/miniapps) | 0.3.0 | MIT |

Each is the package's own published browser build, unmodified. Reproduce with
`npm pack <package>` and copy the file out of `dist/`.
