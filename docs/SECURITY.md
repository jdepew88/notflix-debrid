# Security

Notflix is meant to run on a home computer for a household. This page explains what it protects,
how, and what it deliberately leaves to you.

## Credentials

| Credential | Stored in | Sent to |
|---|---|---|
| TMDB API key / read token | `<data>\secrets\secrets.json` | `api.themoviedb.org` only (v4 tokens as a `Bearer` header, never in URLs) |
| Real-Debrid API token | same | `api.real-debrid.com`; and, **if you enable them**, the release-search addons (Torrentio, Peerflix, a custom addon), whose protocol embeds the token in the request URL |
| Custom addon URL | same | that addon's server |
| Session signing key | same (random, generated on first start) | nobody |
| Engine key | `<data>\secrets\engine-secret` (random) | the local media engine only |

- Credentials are **write-only** in the UI: after saving, the server only reports "configured" and
  the last four characters. They never appear in API responses, browser storage, cookies, logs or
  the configuration files under `config\`.
- They are validated **before** being stored; rejected credentials are never written.
- Browsers, phones and TV apps never receive Real-Debrid or TMDB credentials. The server resolves
  Real-Debrid links itself and hands them only to the local media engine.
- The data folder is restricted to the account running Notflix, `SYSTEM` and `Administrators` on
  first start. Credentials are not additionally encrypted at rest: anyone who can read that folder
  as that user (or as an administrator) can read them — protect the Windows account accordingly and
  keep backups of the data folder private.

## Accounts

- **Owner** — created once during setup; the only account that can view or change system settings
  and credentials (server, storage, metadata, Real-Debrid, hardware, playback defaults).
- **Administrator** — can create accounts and reset members' passwords; cannot change system
  settings or roles.
- **Member** — browses, plays, manages own profiles and preferences.

Authorization is enforced in each API route on the server, not just by hiding UI.

Passwords and profile PINs are hashed with **scrypt** (N=2¹⁷, r=8, p=1, 16-byte salt) on a worker
thread. Hashes from earlier builds are verified and upgraded on the next sign-in. Sign-in is rate
limited per account and per address with generic error messages; changing or resetting a password
signs that account out everywhere. Sessions are HMAC-signed cookies (`HttpOnly`, `SameSite=Lax`,
`Secure` when the request came over HTTPS) bound to the account's session version.

Self-service sign-up is **off** by default; the owner creates accounts or opens sign-up in
Settings → Accounts.

## First-run setup

- Until setup is finished every page redirects to `/setup`.
- Creating the owner requires the one-time **setup code** written to the data folder (and shown by
  the launcher), so someone else on your network cannot claim a freshly started server. Code
  attempts are rate limited per address and globally.
- Owner creation is serialized by a cross-process lock; a second owner can never be created, even by
  simultaneous requests. The code is deleted once the owner exists.
- After completion, the setup endpoints refuse to run again (HTTP 409) and `/setup` redirects away.
  Offline recovery (forgotten owner password) requires access to the server:
  `scripts\notflix.ps1 accounts reset-password <owner>`.

## Network exposure

| Setting | Listens on | Who can connect |
|---|---|---|
| default | `127.0.0.1:8420` | this computer only (also enforced per request) |
| LAN access on | `0.0.0.0:8420` | devices that can reach this PC — normally your local network |
| media engine | `127.0.0.1:8421` always (a non-loopback `bindAddress` / `MEDIA_ENGINE_BIND` is refused at start) | the web server only, with a shared key |

Notflix **never** opens ports on your router (no UPnP) and never configures internet exposure.

With LAN access on, Notflix announces itself on the local network (mDNS/DNS-SD, `_notflix._tcp`)
so TV apps can find it. The announcement and the public `GET /api/health` contain only the name
shown on TVs, the web port, `api`/`scheme` hints and a random instance ID: no credentials, account
names, paths, settings or the media engine's port. It tells devices on your network where Notflix
is, which LAN access already makes reachable; it grants no access (sign-in is still required) and
does not travel beyond the local network. Clients must treat it as untrusted: anything on the LAN
can announce `_notflix._tcp` or answer `/api/health` like Notflix. Turn it off in Settings or with
`notflix-cli advertise off`. Details: [LAN-DISCOVERY.md](LAN-DISCOVERY.md).

The traffic between browsers and Notflix is plain HTTP unless you put an HTTPS reverse proxy in
front. On a home network that is common practice; on any network you do not trust it is not —
passwords and session cookies could be observed.

### Exposing Notflix to the internet (your decision)

If you do, put it behind a reverse proxy that terminates TLS (Caddy, nginx, Traefik, a tunnel
service), turn on **Behind a reverse proxy** and set the public `https://` address so cookies are
marked `Secure` and client addresses are taken from `X-Forwarded-For`. Keep sign-up closed, use
strong passwords, keep the media engine port private, and remember that anyone with an account can
stream through your Real-Debrid subscription. Only enable "behind a reverse proxy" when a proxy is
actually in front — otherwise clients could forge their address in rate limiting.

## Media engine

- Bound to loopback; every request needs the engine key; each playback session additionally needs a
  single-use, 60-second HMAC **ticket** minted by the web server for that account, and every later
  request carries the session token and owner id. The browser never talks to the engine directly:
  all media flows through authenticated `/api/playback/<session>/…` routes that check the signed-in
  account owns the session.
- The engine fetches only HTTPS URLs on the debrid provider's CDN that resolve to public addresses
  (plus explicitly allow-listed private hosts) or files under configured library roots — so it cannot
  be turned into an open proxy or a scanner of your network.
- FFmpeg runs with argument lists (never a shell), inside a Windows Job Object that ends it with the
  engine; source URLs and tokens are redacted from logs and diagnostics.
- Cache cleanup deletes only inside `<cache>\engine`, after checking the cache is not a settings,
  credential or account folder.

## Reporting

This is a community project without a security team. Please report vulnerabilities privately to the
maintainers rather than in a public issue.
