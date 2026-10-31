# Chrome Web Store listing text

Copy and paste each block into the matching field of the [developer dashboard](https://chrome.google.com/webstore/devconsole).

---

## "Store listing" tab

**Name:** comes from `manifest.json` (Page Sentinel).

**Summary (up to 132 characters):** comes from `manifest.json`:
> Checks websites on a schedule and plays a sound when their content changes.

**Description:**

```
Page Sentinel plays a soft retro synth alert when a web page changes.

Great for following exam or job announcements, results, prices, or any page you don't want to keep refreshing by hand.

HOW IT WORKS
1. Click the icon and enter the site address (the current tab is filled in for you).
2. Choose how often to check (from 1 minute).
3. That's it. When the page text changes, you hear a short synth arpeggio, get a notification and see exactly what was added and removed.

FEATURES
• Checks in the background without opening tabs.
• Works on modern sites that load their content with JavaScript.
• Shows the added and removed lines.
• Sound alert, system notification and a counter on the icon.
• Pause, resume, check now and change the interval at any time.
• Checks overdue sites right away when the computer wakes up or Chrome starts.
• Ignores invisible changes (scripts, layout); only the text is compared.
• Waits for "Loading..." screens and confirms each change with a second read, so a page that loads halfway doesn't cause a false alarm.
• Downloadable log of recent checks.
• Lightweight: memory is only used for the few seconds of each check.

PRIVACY
• No account, no server, no ads and no tracking.
• Everything is stored only in your browser.
• Open source: https://github.com/gustavolgcr/page-sentinel

NOTES
• Chrome must be running for checks to happen.
• Pages with clocks, counters or rotating ads will trigger an alert on every check.
```

**Category:** Productivity → Tools

**Language:** English

**Images:**
| Field | File |
|---|---|
| Store icon (128×128) | `icons/icon128.png` |
| Screenshot (1280×800) | `store/screenshot-1-1280x800.png` |
| Small promo tile (440×280) | `store/promo-small-440x280.png` |

**Official URL / homepage:** `https://github.com/gustavolgcr/page-sentinel`

**Support URL:** `https://github.com/gustavolgcr/page-sentinel/issues`

---

## "Privacy practices" tab

**Single purpose:**

```
Watch web pages chosen by the user at intervals set by the user and alert them, with a sound and a notification, when the page text changes.
```

**Permission justifications:**

| Permission | Justification (copy) |
|---|---|
| `alarms` | Schedules the periodic check of each site at the interval chosen by the user. |
| `storage` | Stores locally the list of watched sites, their intervals and the text from the last check, used to detect changes. |
| `unlimitedStorage` | The baseline text of large pages can exceed the default local storage quota when the user watches several sites. |
| `tabs` | Fills the address field with the current tab, opens the site when the user clicks the notification and, as a fallback, loads the page in a background tab when the site can't be read any other way. |
| `scripting` | Used only in the tab fallback: injects the text reader into the temporary tab to get the watched page's text. |
| `notifications` | Shows a system notification when a change is detected. |
| `offscreen` | Creates a hidden document that loads the watched site (to read its text without opening tabs) and plays the alert sound. It is closed shortly after each check. |
| `idle` | Detects when the computer is unlocked so sites whose check was delayed while it slept can be checked right away. |
| `declarativeNetRequestWithHostAccess` | Removes the X-Frame-Options and Content-Security-Policy headers only from responses loaded in the extension's hidden document (frames outside tabs, tabId -1), so the site chosen by the user can be read. The user's normal browsing is not affected. |
| Host permission `<all_urls>` | The user can choose any site to watch, so the extension must be able to load and read whatever address they enter. It only accesses the sites the user added. |
| Content script on all pages | The text reader (frame-reader.js) must be available on the watched site, which can be any site. It checks whether it is running inside the extension's hidden document and, on any other page, exits without doing anything. |

**Remote code:** choose **"No, I am not using remote code"**. All code ships inside the package.

**Data usage:** check **"Website content"**, because the extension reads the text of the pages the user asked it to watch. Check nothing else. Then tick the three statements:
- I do not sell or transfer user data to third parties, outside of the approved use cases.
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:**
```
https://github.com/gustavolgcr/page-sentinel/blob/main/PRIVACY.md
```

---

## "Distribution" tab

- **Payments:** Free.
- **Visibility:** "Public" (shows up in search) or "Unlisted" (only people with the link can install it).
- **Regions:** all.

---

## Publishing a new version

1. Bump `version` in `manifest.json` (e.g. 1.2.0 → 1.3.0).
2. Run `./scripts/build-zip.sh`.
3. In the dashboard, open the item → **Package** → **Upload new package** → upload the .zip from `dist/` → **Submit for review**.
