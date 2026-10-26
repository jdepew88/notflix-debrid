# Finding Notflix on the local network (mDNS / DNS-SD)

With **LAN access** on, Notflix announces itself on the local network so the Notflix Android TV app
(and any DNS-SD browser) finds it without typing an address. TVs still verify every server they find
and still ask for a username and password; the announcement only says *where* a Notflix server is.

## What is announced

Service type `_notflix._tcp.local.`, one instance per running installation:

| Record | Value |
|---|---|
| Instance name | **Name shown on TVs** (Settings → Server & storage; empty = this computer's name). If another server on the network already uses it, ` (2)`, ` (3)`… is added. |
| SRV | the port the web app/API **actually listens on** (8420 by default) and the host `notflix-<computer>.local` |
| A | the IPv4 address of the network the question came from (see *Several network adapters*) |
| TXT | `app=notflix`, `api=1`, `scheme=http`, `id=<random instance ID>` |

Never announced: the media engine or its port (8421), Real-Debrid/TMDB/TVDB/Plex credentials,
account names, passwords, setup codes, paths or any other setting. The same name, instance ID and
API version are returned by `GET /api/health`, which apps call (without cookies) to verify a server
before using it.

The instance ID is a random UUID created once in `<data>\config\instance-id`; it moves with
`move-data` and lets a TV notice when a different installation answers at a saved address.

## When it is active

| Situation | Announced? |
|---|---|
| LAN access on, setup finished, *Let TVs find this server automatically* on (default) | yes |
| LAN access off (Notflix listens on 127.0.0.1 only) | no — nothing outside this PC could connect anyway |
| First-run setup not finished | no |
| Turned off in Settings, with `notflix-cli advertise off`, or `NOTFLIX_ADVERTISE=0` | no |

It starts with the web server (`server.mjs`) and stops with it: a normal stop
(`Stop-Notflix.cmd`, `scripts\notflix.ps1 stop`, Ctrl+C, `restart`) sends goodbye packets so TVs drop
the entry at once. After a crash or a forced kill the records expire on their own within **two
minutes** (TTL 120 s). The responder runs inside the web server process: there is no separate
advertiser process to orphan or duplicate, and the launcher already refuses to start a second web
server for the same data folder.

Changing the port, the name, LAN access or the setting in Settings takes effect within a few
seconds, without a restart: the old announcement is withdrawn (goodbye) and the new one probed and
announced. The announced port is always the one the server is listening on, so if a new port can't
be used (*port already in use*), the old one stays announced.

If multicast can't be used (no network, UDP 5353 unavailable) Notflix logs it, reports it in
`status` and in Settings, and keeps working normally; TVs connect by address instead.

## Checking it

```powershell
scripts\notflix.ps1 status      # "LAN discovery  announced as …" plus a live test query
scripts\notflix.ps1 discover    # every Notflix server answering on this computer's networks
```

`status` asks the network the way a TV does and checks that this installation answers with the
right port. Settings → Server & storage shows the same state.

From other systems: `dns-sd -B _notflix._tcp` (macOS, Bonjour SDK) or `avahi-browse -rt _notflix._tcp`
(Linux) should list the server, its port and TXT record.

## Network requirements

* **Windows Firewall** must let Node.js receive **UDP 5353** (mDNS questions from TVs) and
  **TCP 8420** (or your port) on the network profile you use. Windows asks the first time Notflix
  listens on the network; answering *Allow* for **private networks** covers both. The built-in
  Windows rule "mDNS (UDP-In)" only applies to Windows' own DNS service, not to Node.js. Notflix
  never changes firewall rules itself.
* The PC's network must be set to **Private**. On a *Public* profile Windows normally blocks both.
* TV and PC must be on the **same network segment** (or one whose router forwards mDNS). Guest
  Wi-Fi, "AP/client isolation", separate VLANs and some mesh systems block multicast between
  devices; the TV app then finds nothing but the address still works.
* A **VPN** on the PC or the TV can hide local devices; pause it to test.

### Several network adapters

PCs often have extra adapters (VPN, Hyper-V/WSL, VMware/VirtualBox, a mobile hotspot). Notflix
answers on each IPv4 adapter separately and only with that adapter's own address, and only to
questions coming from that adapter's subnet. A TV on the home network therefore always receives the
PC's home-network address, never a virtual adapter's. If the server is bound to one address
(`server.bindAddress`), only that adapter announces.

## Two installations on one network

Each announces its own name and port. When both use the same name, the one that starts second
announces `Name (2)`; TVs list both and show each one's address and port. Set different names in
Settings to tell them apart permanently.

## Behind a reverse proxy or on the internet

The announcement only covers the local, plain-HTTP address. It is not a way to publish Notflix
outside your network and does not change who can connect: that is decided by LAN access, the
firewall and your router (Notflix never opens router ports).

## Implementation

`src/lib/install/lan-advertise.mjs` (responder, using the
[`multicast-dns`](https://github.com/mafintosh/multicast-dns) package; RFC 6762/6763 probing,
announcements, goodbyes, known-answer suppression, legacy unicast answers), started from
`server.mjs`; identity in `src/lib/install/identity.mjs`; tests in
`src/lib/install/lan-advertise.test.ts`.
