# Spotify MPRIS

Control the Spotify desktop app from a panel in Obsidian on Linux: see what's playing, play/pause, skip, search tracks and replay your recent tracks. It talks to Spotify over MPRIS (D-Bus), so it works with Spotify Free and needs no Spotify account login or API key.

> The interface is in Brazilian Portuguese.

## Features

- Mini player with the cover, title, artist and play/pause, previous and next.
- Fullscreen cover: click the cover to open it, left-click to play/pause, right-click or Escape to exit.
- Search tracks, or paste a Spotify link (`open.spotify.com/track/…` or `spotify:track:…`) to play it directly.
- Recent tracks: everything that plays while Obsidian is open (last 50), one click to play again.
- Four themes (Default, Editorial, Kindle Color, Kindle Mono), plus an optional e-ink dither filter for the cover.
- Kindle Mono blinks like an e-ink screen refreshing when you enter or leave fullscreen and when you hover the controls. Turn it off with **Efeito piscada** in the settings.
- Commands: open panel, play/pause, next track, previous track. Assign hotkeys in **Settings → Hotkeys**.

## Requirements

- Linux desktop (the plugin is desktop-only and doesn't work on Windows, macOS or mobile).
- The Spotify desktop app, running. Any install works (deb, Snap or Flatpak).
- `dbus-send`, which ships with almost every Linux desktop (package `dbus` or `dbus-bin`).

### Obsidian installed as a Flatpak

A Flatpak Obsidian can't reach Spotify until you allow it. On the first start the plugin shows the command to run; you can also find it under **Settings → Spotify MPRIS → Verificar Spotify**:

```bash
flatpak override --user --talk-name=org.mpris.MediaPlayer2.spotify md.obsidian.Obsidian
```

Then quit Obsidian completely and open it again (reloading isn't enough).

## Usage

1. Open Spotify.
2. Select the music icon in the ribbon, or run **Spotify MPRIS: Abrir painel** from the command palette.
3. Type in the search field and press Enter, or paste a Spotify link.

Search results come from Deezer's public catalog (Spotify's own search API requires a Premium account). Selecting a result opens that search in the Spotify app. Recent tracks and pasted track links play directly. After the chosen track ends, the plugin starts its song radio.

## Privacy and network use

- **Spotify desktop app (local):** the plugin runs `dbus-send` to read the current track and send play/pause, next, previous and "open URI" commands. Nothing leaves your computer for this.
- **Deezer API (`api.deezer.com`):** only when you search, the text you typed is sent to Deezer's public search API to find tracks. No account or key is used.
- **Spotify image CDN:** cover images are loaded from the URLs Spotify reports for the playing track. With the e-ink filter on, they are downloaded so they can be redrawn locally.
- **Files outside the vault:** the plugin reads `/.flatpak-info` (only present inside a Flatpak) to check whether Obsidian has permission to talk to Spotify.

There is no telemetry. The recent tracks list is stored in the plugin's `data.json` inside your vault.

## Installation

- **Community plugins:** search for "Spotify MPRIS" in **Settings → Community plugins → Browse**.
- **Manual:** download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/spotify-mpris/`, then enable the plugin in **Settings → Community plugins**.

## Credits

Spotify is a trademark of Spotify AB. This plugin is not affiliated with or endorsed by Spotify.

The themes embed these fonts, all under the [SIL Open Font License 1.1](https://openfontlicense.org): [Newsreader](https://github.com/productiontype/Newsreader) (Production Type), [IBM Plex Mono](https://github.com/IBM/plex) (IBM), [Noto Sans](https://github.com/notofonts/latin-greek-cyrillic) (Google) and [Literata](https://github.com/googlefonts/literata) (TypeTogether).

## License

[MIT](./LICENSE)
