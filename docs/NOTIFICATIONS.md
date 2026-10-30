# Notifications

The bell in the top bar is each profile's notification center. Notflix tells a profile about:

| Category | What | Default |
|---|---|---|
| New episodes | Series in the profile's My List, series it watched in the last 120 days, and series it follows (bell button in a series' details) | on |
| New seasons | A followed series announces a season (with its premiere date), and when that season starts | on |
| Digital releases & streaming | Films in My List released to buy/rent digitally, or added to a subscription streaming service, in the profile's region; plus a few popular new digital releases that match the profile's taste (at most two per check) | on |
| Blu-ray & DVD | Physical releases of films in My List (and a few popular ones) in the profile's region | off |
| Trending | Popular titles close to what the profile watches | on |
| Recommendations | Based on what the profile watched and saved ("Because you watched …") | on |
| Service announcements | Problems the owner should fix: a rejected TMDB key or Real-Debrid token, background checks that keep failing (owners and administrators only, never on Kids profiles) | on |
| Browser notifications | Pop-ups from the browser, also while Notflix is in the background | **off** |

Everything is per profile: each profile has its own notifications, read/dismissed state, follows and
settings (**Settings → Notifications**, for the profile in use). Kids and teen profiles only get
notifications for titles whose US rating is within their level; titles without a known rating are
left out, as everywhere else in Notflix.

A release notification says what TMDB reports ("released to buy or rent digitally in the US on
…"). It does not mean a copy can be played here: that depends on what Real-Debrid and the release
search find when you press Play.

## In-app and browser notifications

**In-app notifications** always work: the bell shows the number of unread notifications, the
popover the newest ones (mark as read/unread, dismiss, mark all as read, open the title), and
**View all notifications** (`/browse/notifications`) the full history with paging. Notifications are
kept 60 days (episodes, seasons, releases), 45 days (streaming) or 14 days (trending,
recommendations); dismissed ones disappear at once.

**Browser notifications** are optional and off by default. **Settings → Notifications → Enable
browser notifications** asks the browser for permission once, directly from that click:

* **Allow**: Notflix registers a small service worker (`/notflix-sw.js`) and a Web Push
  subscription for this browser and profile. New notifications then pop up even when no Notflix tab
  is open. Clicking one opens the title (or the settings page) in Notflix.
* **Block**, or closing the question: nothing is enabled and Notflix never asks again; the settings
  explain how to allow it in the browser.
* If the browser has no Web Push (or its push service cannot be reached), notifications pop up only
  while a Notflix tab is open; the settings say so ("shown while Notflix is open").

Three different things decide whether a pop-up appears, and Notflix treats them separately:

1. **The profile's setting** (stored on the server, per profile);
2. **the browser's permission for this site** (Chrome, Edge, Firefox: the icon left of the address
   → Site settings → Notifications). If you block or reset it there, Notflix notices when it is
   opened or regains focus, shows "blocked" / "not asked yet", removes this browser's push
   subscription, and keeps the in-app notifications working. It never tries to work around the
   browser. To turn pop-ups on again, allow notifications in the browser and switch the setting on
   once more;
3. **the operating system**: Windows notification settings, Focus / Do Not Disturb (or macOS
   Focus). Websites cannot see these, so Notflix cannot tell you when Windows hides its pop-ups.

**Quiet hours** (default 22:00–08:00 in the profile's time zone, as reported by the browser) hold
browser pop-ups back until they end; they still appear under the bell right away. Pop-ups older than
24 hours are not sent any more, and at most six per hour are sent per profile.

### HTTPS, LAN addresses and reverse proxies

Browsers only allow notifications and service workers on **secure origins**:

| How Notflix is opened | In-app | Browser notifications |
|---|---|---|
| `http://localhost:8420` or `http://127.0.0.1:8420` on the server PC | yes | yes |
| `http://192.168.x.x:8420` from another device (LAN access) | yes | **no** (the browser refuses; the settings explain it) |
| `https://notflix.example` through a reverse proxy with a certificate | yes | yes |

There is no setting that makes plain-HTTP LAN addresses work; that is a browser rule. Notflix needs
no Cloudflare, Firebase account or other push provider: Web Push goes from the Notflix server to
the browser vendor's push service (Google for Chrome/Edge's FCM, Mozilla, Apple, Microsoft), which
only relays encrypted bytes.

## How notifications are generated

Background checks run **inside the Notflix web server** (no extra service or database):

| Check | Every | What it does |
|---|---|---|
| New episodes & seasons | 6 h | asks TMDB about every followed series (up to 300 per run, most recently watched first) |
| Releases & streaming | 12 h | release dates and streaming services of films in My List, per profile region; popular new releases of the past week |
| Trending | 24 h | TMDB's weekly trending list, ranked per profile |
| Recommendations | 24 h | TMDB recommendations for the profile's recent titles |
| Service checks | 6 h | the owner alerts (TMDB/Real-Debrid credentials, release search) |
| Clean-up | 24 h | expired notifications, removed profiles/accounts, stale data, dead browser subscriptions |

* **No duplicates.** Every event has a stable key (for example `ep:<series>:<season>:<episode>` or
  `digital:<film>:<region>`). A profile receives each key once, however often a check runs or TMDB
  corrects its data.
* **No floods.** The first time a series or film is checked, everything already out is recorded and
  announced to nobody, so adding a show (or TMDB adding old episodes) does not produce alerts about
  the past. Afterwards only events from the last 14 days (30 for film releases) are announced.
  Several episodes out at once become one notification; a whole season out at once is one "Season
  N is here". Per profile and day at most 25 episode, 10 season, 5 digital, 3 physical, 3 trending,
  3 recommendation and 5 service notifications are created; trending and recommendations default to
  one daily summary.
* **Time zones.** TMDB dates are calendar dates without a time. An episode or release counts as out
  from 08:00 UTC on the day after its date, so nobody is told before the date has arrived where they
  live (it can arrive up to a day after the US broadcast). Missing dates produce no notification
  until TMDB has one. Release dates and streaming services are always those of the profile's region
  (**Release region**, default: the browser's region); theatrical, digital, physical and streaming
  availability are separate facts and never mixed.
* **Announcements vs. releases.** A new season listed with a future date (within 18 months) is an
  announcement; its start is a separate notification. Placeholder seasons years away are ignored.
* **Recommendations** are deterministic and explainable: titles TMDB recommends for several of the
  profile's recent titles rank first, weighted by genre affinity and rating. Anything the profile
  saved, watched, was already told about or dismissed is never suggested again.
* **TMDB limits.** Requests are spaced out (at most ~10 per second, far below TMDB's limit), answers
  are cached in memory, temporary errors (network, HTTP 429/5xx) are retried up to three times with
  backoff and `Retry-After`. A rejected key stops the check at once and notifies the owner.
* **One process at a time.** A lease (`<data>\db\notifications\lease.json`) makes sure only one
  Notflix process runs the checks, even if two are started on the same data folder; if it stops,
  another takes over within 5 minutes. Checks never overlap.
* **Restarts.** When each check last ran and is due next is stored; after a restart, checks that
  became due while Notflix was off run once (missed runs are not replayed). The first check starts
  two minutes after Notflix starts, so a slow or unreachable TMDB never delays startup.
* **Failures** back off (15 min, 30 min, 1 h … up to the normal interval). After three failures in a
  row the owner gets a service notification, which stops once the check succeeds again.

Owners and administrators see the state of each check under **Settings → Notifications → Background
checks** and can run one at once with **Check now**.

## Where the data lives

```
<data>\db\notifications\inbox\<account id>.json   notifications, read/dismissed state, follows,
                                                  dismissed suggestions, per profile
<data>\db\notifications\state.json                check schedule and the series/film snapshots
<data>\db\notifications\lease.json                which process runs the checks
<data>\db\notifications\push.json                 browser push subscriptions (per account and profile)
<data>\secrets\secrets.json                       + the Web Push (VAPID) key pair, encrypted with the
                                                  other credentials (created on first use)
```

The notification preferences are stored with each profile's other preferences
(`<data>\db\users\<account id>.json`). Nothing needs migrating: existing installations simply gain
these files and the defaults above; accounts, profiles, history and credentials are untouched.

## Turning it off

* Per profile: switch categories off in **Settings → Notifications**.
* For the whole server: start Notflix with the environment variable `NOTFLIX_NOTIFICATIONS=0` (no
  background checks; the bell still shows existing notifications).

Other environment variables: `NOTFLIX_NOTIFY_START_DELAY_MS` (delay before the first check, default
120000), `NOTFLIX_PUSH_CONTACT` (`mailto:` or `https://` contact sent to push services, RFC 8292),
`NOTFLIX_PUSH_HOSTS` (additional push service host names, comma-separated; only needed for unusual
browsers).

## Troubleshooting

| Problem | What to check |
|---|---|
| No notifications at all | **Settings → Notifications → Background checks** (owner): is TMDB set and are the checks "ok"? New series are recorded on their first check and announce only *later* episodes. Is the category on for this profile? |
| A series I watch is not announced | It must be in My List, watched in the last 120 days, or followed with the bell button in its details; the bell button can also turn it off. Kids profiles only see rated titles within their level. |
| Wrong country's release dates | **Settings → Notifications → Release region**. |
| "Enable browser notifications" says it needs HTTPS or localhost | Open Notflix as `http://localhost:<port>` on the server PC, or through HTTPS. Plain `http://192.168…` addresses cannot have browser notifications. |
| The switch turns itself off | The browser's permission for this site was withdrawn or blocked. Allow notifications in the site settings, then switch it on again. |
| Allowed, but no pop-ups | Windows Settings → System → Notifications (the browser must be allowed), Focus / Do Not Disturb, quiet hours in Notflix. "Shown while Notflix is open" means this browser has no background push. |
| Pop-ups stopped after reinstalling the browser | Switch browser notifications off and on again in this browser to register it again. |

## Not included (yet)

* **Android TV app:** the TV app does not show the notification center yet. The API it would use
  exists (`GET /api/notifications`, `POST /api/notifications` with `read`/`dismiss`/`read-all`),
  with the same per-profile rules; TV-side UI is a separate change in the TV app's repository.
* **E-mail, SMS or mobile push apps.** Only in-app and browser (Web Push) notifications.
* **Real-Debrid availability:** release notifications do not check whether a release can be found
  and played; Notflix does that when you press Play.
* **Theatrical releases** are classified but not announced (there is no category for them).
* Do-Not-Disturb / Focus detection: not possible for websites.
