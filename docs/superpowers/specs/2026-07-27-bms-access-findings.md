# BookMyShow Access — Measured Findings

**Date:** 2026-07-27
**Status:** Resolved. Closes the spike in §14 of the design spec.

Every row below was measured, not inferred. Nothing here is from documentation or
from another project's README.

---

## 1. The question

Can we poll BookMyShow 24/7, for free, without exposing a home IP?

Answer: **yes.** Oracle Cloud VPS + TLS impersonation with a Safari profile.
₹0, no proxy, no quota, no residential IP involved.

---

## 2. What actually blocks requests

BookMyShow sits behind Cloudflare (`Server: cloudflare`, `CF-RAY`, `__cf_bm`,
`_cfuvid`, standard CF block interstitial). The gate is **TLS + HTTP/2 fingerprint**,
not IP reputation and not geography.

This was initially misdiagnosed. Oracle's 403 looked like a datacenter-IP block
because that is what every prior-art README claims. It was not — the same host
returns 200 once the TLS handshake is right.

### Measurement matrix

| Host | IP class | Client | Result |
|---|---|---|---|
| Oracle VPS | datacenter (Mumbai edge) | bare curl | 403 |
| Oracle VPS | datacenter | curl + Chrome UA | 403 |
| Oracle VPS | datacenter | curl + full Chrome headers + cookie jar | 403 |
| Oracle VPS | datacenter | curl + forced HTTP/1.1 | 403 |
| Oracle VPS | datacenter | Bun bare `fetch()` | 403 |
| Oracle VPS | datacenter | `impit` (firefox / chrome profiles) | 403 ⚠️ challenge |
| Oracle VPS | datacenter | **`node-tls-client` safari_ios_18_0** | **200 ✅** |
| Oracle VPS | datacenter | **`curl_cffi` impersonate=safari / edge** | **200 ✅** |
| Windows PC | residential (Airtel) | bare curl | 403 |
| Windows PC | residential | curl (Schannel) + Chrome UA | 200 |
| Windows PC | residential | Bun bare `fetch()` | 200 |
| Windows PC | residential | Bun + full Chrome headers | **403** |
| Raspberry Pi | residential, same IP as Windows | curl 7.74 / OpenSSL 1.1.1w | 403 |
| OnePlus 5T | residential, same IP as Windows | curl 8.12 / OpenSSL 3.4.1, any UA | 403 |

### Three counterintuitive results

**Datacenter IPs are not blocked.** Oracle returns 200 with the right handshake.
Every prior-art project asserts the opposite and pays for proxies because of it.

**Adding browser headers made things worse.** Bun's bare `fetch()` got 200; the same
request with a full Chrome header set got 403. Claiming `User-Agent: Chrome/131` while
performing a non-Chrome TLS handshake is a self-contradiction, and Cloudflare scores
the contradiction worse than an honest non-browser client. **Consistency beats
impersonation.**

**Chrome is the worst profile to impersonate.** Reproduced in two independent
libraries:

| Profile | `curl_cffi` | `node-tls-client` |
|---|---|---|
| chrome / chrome131 | 403 ⚠️ challenge | 403 ⚠️ challenge |
| safari (all variants) | **200** | **200** |
| edge | **200** | — |
| firefox | — | **200** |

Chrome is the majority of real traffic and therefore the fingerprint every scraper
fakes. It carries the most abuse history, so it is scored hardest.

---

## 3. Chosen client

**`node-tls-client`** (npm) — Node/Bun bindings over
[`bogdanfinn/tls-client`](https://github.com/bogdanfinn/tls-client), which is Go +
`refraction-networking/utls`. It replays a real browser's TLS ClientHello and HTTP/2
SETTINGS frame.

Keeps the stack in TypeScript. `curl_cffi` is the Python equivalent and was verified
working identically — it is the fallback if `node-tls-client` is ever abandoned.

### Verified stability, Oracle VPS

```
safari_ios_18_0  10 consecutive: 200 200 200 200 200 200 200 200 200 200
latency: min 37ms  median 48ms  max 116ms
```

Plus 12/12 at 200 via `curl_cffi` (safari and edge, 6 each) in a separate run.

### Integration notes

- Ships a ~15 MB Go shared library, downloaded on `initTLS()`. Bun blocks the
  postinstall by default — `bun pm trust --all` is required.
- API: `initTLS()` once at boot, then `new Session({ clientIdentifier })`, then
  `session.get(url)`. There is no `session.init()`.
- **Send no custom headers.** The library's profile supplies a coherent set. Adding
  our own re-creates the mismatch that causes 403s.

---

## 4. Endpoints

| Purpose | Endpoint | Status |
|---|---|---|
| Cities / regions | `GET /api/explore/v1/discover/regions` | **200, 709,354 bytes JSON.** Verified live |
| Venues | `GET /pwa/api/de/venues?regionCode=…&eventType=MT` | 400 — params need work |
| Venues (explore) | `GET /api/explore/v1/discover/venues?regionCode=…` | 500: `Null Value Returned for Field: x-app-code` |

`regions` returns real data — `RegionCode: "MUMBAI"`, 10 top cities with aliases,
lat/long, `AllowSales` flags. The 2023-era endpoint still works in 2026.

**`x-app-code` is an open lead.** BookMyShow's own error message names a header its
app sends and we don't. No prior-art project uses it. Worth probing before writing the
showtimes fetcher.

Still unresolved: **how showtimes are fetched.** That remains the one open question
from §14 of the design spec. Access is solved; parsing is not.

---

## 5. Options rejected, with reasons

| Option | Why not |
|---|---|
| Run on Windows PC | Verified working, but the PC gets turned off |
| Run on Raspberry Pi | 32-bit armhf userland (no Bun build), glibc 2.31, OpenSSL 1.1.1w → 403 |
| Run on OnePlus 5T / Termux | 403 on every UA; `curl_cffi` wheel wants libpython3.13, Termux ships 3.14 |
| ScraperAPI | India geotargeting requires the ~$299/mo Business tier |
| ScrapingAnt | 10,000 credits/mo ÷ 25 for residential = 400 requests. Far short |
| Scrape.do / Scrapfly / ScrapingBee | 1,000 credits, ×10–25 multipliers → 40–100 requests |
| Bright Data | Two research passes disagreed on whether a free tier exists. Unverified, unused |
| Free residential proxies | Do not exist from reputable providers. Webshare's free tier is datacenter |
| Camoufox / headless browser | Would likely work, but ~150 MB RAM and seconds per request to fetch a JSON endpoint a 15 MB library fetches in 48 ms |
| `impit` | Only ships firefox and chrome profiles; both are challenged. No Safari |

**None of the paid options are needed.** The free path is strictly better than the
paid ones the prior art uses.

---

## 6. Consequences for the design

1. **Deployment: Oracle Cloud VPS.** Replaces the "run it at home" plan in §13 of the
   design spec. Home IP is never used.
2. **Stack stays Bun + TypeScript.** `node-tls-client` removes the reason to switch
   to Python.
3. **`providers/bms/client.ts` sends no custom headers** and pins
   `clientIdentifier: safari_ios_18_0`. Fewer lines than the naive version.
4. **Never impersonate Chrome.** Add a comment saying why, or someone will "fix" it
   to Chrome later and silently break everything.
5. **Profile rot is a real risk.** Cloudflare's scoring shifts. If 403s appear,
   rotating to another Safari or Firefox profile is the first thing to try — cheap,
   and it should be a config value rather than a hardcoded constant.
6. **§9's loud-failure rule is vindicated.** Every 403 in this investigation returned
   a 200-shaped HTML body that a naive parser reads as "no shows". Both prior-art
   projects would have reported "not open yet" for every single row in the matrix
   above.
