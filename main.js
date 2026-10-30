const { Plugin, ItemView, Modal, Notice, PluginSettingTab, Setting, requestUrl, setIcon } = require("obsidian");
const { execFile } = require("child_process");
const { readFileSync } = require("fs");

const VIEW_TYPE = "spotify-mpris-view";
const BUS_NAME = "org.mpris.MediaPlayer2.spotify";
const PLAYER = "org.mpris.MediaPlayer2.Player";
const POLL_MS = 2000;
const HISTORY_MAX = 50;
// Matches open.spotify.com/track/ID links and spotify:track:ID URIs (also album/playlist/artist).
const SPOTIFY_LINK = /(?:open\.spotify\.com\/(?:intl-[a-z]+\/)?|spotify:)(track|album|playlist|artist)[/:]([A-Za-z0-9]+)/;
// Per machine (not in data.json), so a vault restored on a fresh install offers the setup again.
const SETUP_KEY = "spotify-mpris-setup-offered";
// Plugin animations (pane resize, fullscreen zoom) are the same for every theme. Keep in sync with styles.css.
const RESIZE_MS = 380;
const HYPHEN_GAIN = 1.2; // A title breaks into syllables only if that makes its font ≥ 20% bigger.
const FULL_GRID = 280; // Grid of the big cover, the same in the compact and tall panes.
const THUMB_GRID = 40; // Grid of the list thumbnails (30–34px on screen).
const THUMB_GRID_COVERS = 100; // Kindle Mono's tall recents are covers ~120px wide, so they need a finer grid.
const DITHER_CACHE_MAX = 80; // Covers of the open view plus the 50 recents' thumbnails.
let viewCount = 0;

// Built-in themes. Each theme's look lives in styles.css under .theme-<id>; the extra DOM some themes use
// (labels, album, cover handle) is always built and hidden by default. `tall`: the theme has a layout for
// tall panes (.is-tall). `fitTitle`: see fitTitle. Their fonts are embedded in styles.css.
const THEMES = {
  default: { name: "Default" },
  editorial: {
    name: "Editorial",
    tall: true,
    // Tall fullscreen: title + artist grow to fill the text block (see fitTitle).
    fitTitle: true,
    filter: "spectra6",
  },
  // Always light, warm paper. Same tall layout as Editorial (cover on top, fitTitle, hover controls row).
  kindle: {
    name: "Blurry Color",
    tall: true,
    fitTitle: true,
    filter: "kaleido",
  },
  // Greyscale e-ink reader. Same tall layout; recents become a grid of covers there.
  mono: {
    name: "Kindle Mono",
    tall: true,
    fitTitle: true,
    filter: "gray4",
    flash: true, // hover states switch with the E-Ink theme's refresh (negative, ink, paper); frames live in styles.css, targeted via .is-kindle-hover; off with the `blink` setting
  },
};

// E-ink filters for the fullscreen cover; each theme picks one with `filter` (default: spectra6).
// Each pixel is matched against `ideal` and painted with the matching `shown` tone.
// Spectra 6: the ideal inks, painted with the panel's soft tones.
// Kaleido: 4 levels per channel (64 colors), painted through the panel's warm paper.
// Gray 4: four greys.
const KALEIDO_LEVELS = [40, 110, 175, 232];
const KALEIDO_PAPER = [236, 226, 200];
const kaleidoIdeal = KALEIDO_LEVELS.flatMap((r) => KALEIDO_LEVELS.flatMap((g) => KALEIDO_LEVELS.map((b) => [r, g, b])));
const FILTERS = {
  spectra6: {
    saturation: 1.3,
    ideal: [[0, 0, 0], [255, 255, 255], [255, 0, 0], [255, 255, 0], [0, 0, 255], [0, 255, 0]],
    shown: [[30, 30, 38], [226, 224, 214], [160, 52, 48], [222, 196, 72], [52, 78, 140], [66, 108, 76]],
  },
  kaleido: {
    saturation: 0.75,
    ideal: kaleidoIdeal,
    shown: kaleidoIdeal.map((c) => c.map((v, k) => Math.round((v * KALEIDO_PAPER[k]) / 255))),
  },
  // 4 greys, painted with the panel's soft tones.
  gray4: {
    saturation: 0,
    ideal: [[0, 0, 0], [85, 85, 85], [170, 170, 170], [255, 255, 255]],
    shown: [[34, 34, 34], [102, 102, 100], [170, 170, 166], [232, 230, 224]],
  },
};

// Floyd–Steinberg dither on an n-pixel-wide grid; returns a blob URL. The cover is downloaded with requestUrl
// because a canvas can't read the pixels of a cross-origin <img>.
async function dither(url, n, filter) {
  const res = await requestUrl({ url });
  const bitmap = await createImageBitmap(new Blob([res.arrayBuffer]));
  const h = Math.max(1, Math.round((n * bitmap.height) / bitmap.width));
  const canvas = document.createElement("canvas");
  canvas.width = n;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, n, h);
  bitmap.close();
  const img = ctx.getImageData(0, 0, n, h);
  const d = img.data;
  const f = new Float32Array(n * h * 3);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 3) {
    const gray = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    for (let k = 0; k < 3; k++) f[j + k] = gray + (d[i + k] - gray) * filter.saturation;
  }
  const push = (x, y, e, w) => {
    if (x < 0 || x >= n || y >= h) return;
    const j = (y * n + x) * 3;
    for (let k = 0; k < 3; k++) f[j + k] += e[k] * w;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < n; x++) {
      const j = (y * n + x) * 3;
      let best = 0;
      let bestDist = Infinity;
      filter.ideal.forEach((p, k) => {
        const dist = (f[j] - p[0]) ** 2 + (f[j + 1] - p[1]) ** 2 + (f[j + 2] - p[2]) ** 2;
        if (dist < bestDist) [best, bestDist] = [k, dist];
      });
      const p = filter.ideal[best];
      const e = [f[j] - p[0], f[j + 1] - p[1], f[j + 2] - p[2]];
      push(x + 1, y, e, 7 / 16);
      push(x - 1, y + 1, e, 3 / 16);
      push(x, y + 1, e, 5 / 16);
      push(x + 1, y + 1, e, 1 / 16);
      const o = (y * n + x) * 4;
      [d[o], d[o + 1], d[o + 2]] = filter.shown[best];
      d[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve));
  return URL.createObjectURL(blob);
}

// Soft hyphens at syllable breaks (vowel groups; good enough for en/pt/it/es), so a long title can be set huge
// and wrap like a magazine headline ("NOVEM-/BER"). Each piece keeps ≥ 2 letters, the last ≥ 3, so a silent
// final "e" never dangles. The hyphens only show when the title has `.is-hyphenated`.
const VOWELS = "aeiouyáàâãäåéèêëíìîïóòôõöúùûüæœ";
const ONSET = /^(?:[bcdfgkpt][lr]|ch|sh|th|ph|gh|lh|nh|gn)$/;

function syllabify(word) {
  const lower = word.toLowerCase();
  const isVowel = (i) => VOWELS.includes(lower[i]);
  const cuts = [];
  let i = 0;
  while (i < word.length) {
    while (i < word.length && !isVowel(i)) i++;
    while (i < word.length && isVowel(i)) i++;
    let j = i;
    while (j < word.length && !isVowel(j)) j++;
    if (j >= word.length) break;
    // One consonant starts the next syllable; of several, only a pair that can start a word does.
    const cut = j - (j - i > 1 && ONSET.test(lower.slice(j - 2, j)) ? 2 : 1);
    if (cut - (cuts[cuts.length - 1] || 0) >= 2 && word.length - cut >= 3) cuts.push(cut);
    i = j;
  }
  return [0, ...cuts, word.length].map((c, k, all) => word.slice(all[k - 1], c)).slice(1).join("\u00AD");
}

const hyphenate = (text) => text.replace(/\p{L}{6,}/gu, syllabify);

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function dbus(args) {
  return new Promise((resolve, reject) => {
    execFile("dbus-send", ["--session", "--print-reply", `--dest=${BUS_NAME}`, "/org/mpris/MediaPlayer2", ...args], (err, stdout) =>
      err ? reject(err) : resolve(stdout)
    );
  });
}

const call = (method, ...params) => dbus([`${PLAYER}.${method}`, ...params]);
const getProp = (name) => dbus(["org.freedesktop.DBus.Properties.Get", `string:${PLAYER}`, `string:${name}`]);

function field(metadata, key) {
  const m = metadata.match(new RegExp(`string "${key}"\\s+variant\\s+(?:array \\[\\s+)?string "(.*)"`));
  return m ? m[1] : "";
}

// A Flatpak Obsidian only reaches the D-Bus names it was granted, and /.flatpak-info lists the
// effective grants (overrides included). Returns the command that grants Spotify, or null if not needed.
function flatpakCommand() {
  let info;
  try {
    info = readFileSync("/.flatpak-info", "utf8");
  } catch {
    return null; // Not sandboxed.
  }
  if (/^sockets=.*\bsession-bus\b/m.test(info) || /^org\.mpris\.MediaPlayer2\.(?:spotify|\*)=(?:talk|own)$/m.test(info)) return null;
  return `flatpak override --user --talk-name=${BUS_NAME} ${process.env.FLATPAK_ID || "md.obsidian.Obsidian"}`;
}

async function diagnose() {
  if (process.platform !== "linux") return { text: "This plugin only works on Linux (it uses MPRIS)." };
  const command = flatpakCommand();
  if (command) {
    return { text: "Obsidian (Flatpak) isn't allowed to talk to Spotify. Run this command in a terminal, then quit Obsidian completely and open it again (reloading isn't enough):", command };
  }
  try {
    await getProp("PlaybackStatus");
    return { text: "All good: Spotify responded." };
  } catch (err) {
    if (err.code === "ENOENT") return { text: "The dbus-send command wasn't found. Install the dbus package." };
    return { text: "The permission is fine, but Spotify didn't respond. Open the Spotify desktop app and check again." };
  }
}

function renderDiagnosis(el, { text, command }) {
  el.empty();
  el.createEl("p", { text });
  if (!command) return;
  el.createEl("pre").createEl("code", { text: command });
  el.createEl("button", { text: "Copy command" }).addEventListener("click", async () => {
    await navigator.clipboard.writeText(command);
    new Notice("Command copied.");
  });
}

class SetupModal extends Modal {
  onOpen() {
    this.titleEl.setText("Spotify MPRIS: a permission is missing");
    diagnose().then((result) => renderDiagnosis(this.contentEl.createDiv("spotify-mpris-diagnosis"), result));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class SpotifySettingTab extends PluginSettingTab {
  display() {
    const { containerEl, plugin } = this;
    containerEl.empty();
    const save = async () => {
      await plugin.saveData(plugin.data);
      plugin.applySettings();
    };
    new Setting(containerEl)
      .setName("Theme")
      .setDesc("Changes the layout and colors of the panel.")
      .addDropdown((dropdown) => {
        for (const [id, theme] of Object.entries(THEMES)) dropdown.addOption(id, theme.name);
        dropdown.setValue(plugin.data.theme).onChange((value) => {
          plugin.data.theme = value;
          save();
        });
      });
    new Setting(containerEl)
      .setName("Blink effect")
      .setDesc("Kindle Mono: an e-ink screen refresh blink when entering or leaving fullscreen and when hovering the controls.")
      .addToggle((toggle) =>
        toggle.setValue(plugin.data.blink).onChange((value) => {
          plugin.data.blink = value;
          save();
        })
      );
    new Setting(containerEl)
      .setName("E-ink filter")
      .setDesc("Color e-ink screen dithering on the fullscreen cover, in any theme. Each theme has its own palette (Editorial: Spectra 6; Blurry Color: Kaleido; Kindle Mono: 4 grays).")
      .addToggle((toggle) =>
        toggle.setValue(plugin.data.ditherFilter).onChange(async (value) => {
          plugin.data.ditherFilter = value;
          await save();
          this.display(); // Enables/disables the sub-option.
        })
      );
    new Setting(containerEl)
      .setName("Outside fullscreen too")
      .setDesc("Also applies the filter to the cover in normal mode and to the recent tracks' covers.")
      .setClass("spotify-mpris-setting-sub")
      .addToggle((toggle) =>
        toggle.setValue(plugin.data.ditherOutside).onChange((value) => {
          plugin.data.ditherOutside = value;
          save();
        })
      )
      .setDisabled(!plugin.data.ditherFilter);
    new Setting(containerEl)
      .setName("Fit height to cover")
      .setDesc("When the track or theme changes, or when you drag the pane's width, fits the cover automatically (like double-clicking the divider). In the tall layout the cover is always proportional, regardless of this.")
      .addToggle((toggle) =>
        toggle.setValue(plugin.data.autoFit).onChange((value) => {
          plugin.data.autoFit = value;
          save();
        })
      );
    let result;
    new Setting(containerEl)
      .setName("Check Spotify")
      .setDesc("Use this if the plugin stops working: shows what's missing and the command to fix it.")
      .addButton((btn) => btn.setButtonText("Check").onClick(async () => renderDiagnosis(result, await diagnose())));
    result = containerEl.createDiv("spotify-mpris-diagnosis");
  }
}

function formatTime(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function ago(timestamp) {
  const minutes = Math.floor((Date.now() - timestamp) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

class SpotifyView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.playBtns = [];
    this.titleEls = [];
    this.artistEls = [];
    this.artEls = [];
    this.labelEls = [];
    this.albumEls = [];
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Spotify";
  }

  getIcon() {
    return "music";
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("spotify-mpris");
    // Unique per view, so the fullscreen zoom (a view transition) can tell two Spotify panes apart.
    root.style.setProperty("--spotify-mpris-vt", `spotify-mpris-cover-${++viewCount}`);
    root.style.setProperty("--spotify-mpris-vt-text", `spotify-mpris-text-${viewCount}`);

    // Normal mode: mini player, search, then recent tracks or search results.
    const mini = root.createDiv("spotify-mpris-mini");
    this.miniEl = mini;
    const miniArt = mini.createEl("img", { cls: "spotify-mpris-art", attr: { "aria-label": "Fullscreen" } });
    // Opens on press, not on release: the right-click that closes fullscreen fires on press too (Linux), so both
    // ways start their e-ink refresh at the same moment after the finger moves.
    miniArt.addEventListener("pointerdown", (event) => event.button === 0 && this.setFull(true));
    // Its src is set by refreshArt (it may be the dithered copy).
    this.miniArt = miniArt;
    const miniInfo = mini.createDiv("spotify-mpris-info");
    this.label(miniInfo, false);
    this.trackInfo(miniInfo);
    this.controls(mini);

    // Always-visible search: a borderless field with a hairline under it, so it reads as part of the list.
    const form = root.createEl("form", { cls: "spotify-mpris-search" });
    setIcon(form.createSpan("spotify-mpris-search-icon"), "search");
    const input = form.createEl("input", { type: "search", placeholder: "Search or paste a Spotify link" });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      input.value = "";
      input.blur();
      this.showRecents();
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.search(input.value.trim());
    });
    input.addEventListener("input", () => {
      if (!input.value) this.showRecents();
    });
    this.listLabelEl = root.createDiv("spotify-mpris-list-label");
    this.listEl = root.createDiv("spotify-mpris-list");
    // One wheel step scrolls exactly one row instead of ~100px.
    this.listEl.addEventListener("wheel", (event) => {
      const row = this.listEl.querySelector(".spotify-mpris-row");
      if (!row || !event.deltaY) return;
      event.preventDefault();
      this.listEl.scrollBy({ top: Math.sign(event.deltaY) * row.offsetHeight, behavior: "smooth" });
    }, { passive: false });

    // Fullscreen mode: covers only this pane.
    const full = root.createDiv("spotify-mpris-full");
    this.fullEl = full;
    // frame > mat > stage: themes can draw a passe-partout around the cover; the stage is what fits the cover.
    const frame = full.createDiv("spotify-mpris-frame");
    this.stageEl = frame.createDiv("spotify-mpris-mat").createDiv("spotify-mpris-stage");
    // The cover is shown whole (contain); a blurred copy fills the leftover space.
    this.artEls.push(this.stageEl.createEl("img", { cls: "spotify-mpris-full-bg" }));
    // Its src is set by refreshArt (it may be the dithered copy).
    this.fullArt = this.stageEl.createEl("img", { cls: "spotify-mpris-full-art" });
    this.fullArt.addEventListener("load", () => {
      this.onResize();
      this.autoFit();
    });
    frame.createDiv("spotify-mpris-cover-handle");
    // Double-click on the drag line above this pane fits the height; on the sidebar edge, the width.
    // Only while the cover is on screen (fitHeight/fitWidth check that).
    this.registerDomEvent(document, "dblclick", (event) => {
      const tabs = this.leaf.parent;
      const items = (tabs && tabs.parent && tabs.parent.children) || [];
      const above = items[items.indexOf(tabs) - 1];
      if (above && event.target === above.resizeHandleEl) this.fitHeight();
      else if (event.target === this.leaf.getRoot().resizeHandleEl) this.fitWidth();
    });
    // Left-click anywhere on the cover toggles play/pause (buttons keep their own action).
    // Themes with a tall layout show the cover in normal mode too: there a press opens fullscreen (see miniArt), and
    // the click its release then fires inside fullscreen must not play/pause.
    let opened = false;
    full.addEventListener("pointerdown", (event) => {
      opened = event.button === 0 && !this.plugin.data.fullscreen && !event.target.closest("button, .spotify-mpris-cover-handle") && !!event.target.closest(".spotify-mpris-stage");
      if (opened) this.setFull(true);
    });
    full.addEventListener("click", (event) => {
      if (opened) {
        opened = false;
        return;
      }
      if (!this.plugin.data.fullscreen || event.target.closest("button, .spotify-mpris-cover-handle")) return;
      call("PlayPause").catch(() => {}).then(() => this.plugin.poll());
    });
    // Right-click anywhere exits fullscreen, so a stray left-click can't close it.
    full.addEventListener("contextmenu", (event) => {
      if (!this.plugin.data.fullscreen) return;
      event.preventDefault();
      this.setFull(false);
    });
    const shade = full.createDiv("spotify-mpris-shade");
    this.shadeEl = shade;
    this.label(shade, true);
    this.bigInfo = shade.createDiv("spotify-mpris-info");
    this.trackInfo(this.bigInfo);
    this.controls(shade);
    this.albumEls.push(shade.createDiv("spotify-mpris-album"));
    // Progressive blur over the bottom edge, for themes that push the text block down on hover.
    const glass = shade.createDiv("spotify-mpris-glass");
    for (let k = 0; k < 6; k++) glass.createDiv();

    // Some themes switch layout by pane shape, which Obsidian's onResize doesn't always report (e.g. mid-animation).
    const observer = new ResizeObserver(() => this.onResize());
    observer.observe(root);
    observer.observe(shade); // The cover handle resizes the shade without resizing the pane.
    this.register(() => observer.disconnect());

    // E-ink refresh: when the hover state of the controls (fullscreen) or of the band (tall, normal) toggles, blink.
    // Also: .is-leaving for 450ms after the pointer leaves, so themes can animate the hover content out (a :hover rule can't).
    let hovered = false;
    let inside = false;
    let leaveTimer;
    const checkHover = () =>
      window.requestAnimationFrame(() => {
        const zone = ".spotify-mpris-full:is(:hover, .is-hot, :has(:focus-visible))";
        const bandZone = ".spotify-mpris-mini:is(:hover, .is-hot), .spotify-mpris-mini:focus-within";
        const full = root.hasClass("is-full");
        // Kindle Mono keeps the tall band open, so outside fullscreen there is no hover state to blink for.
        const fixedBand = this.theme().flash && !full;
        const within = !fixedBand && (full || root.hasClass("is-tall")) && root.matches(`:has(${full ? zone : `${zone}, ${bandZone}`})`);
        if (within !== inside) {
          inside = within;
          window.clearTimeout(leaveTimer);
          root.toggleClass("is-leaving", !within);
          if (!within) leaveTimer = window.setTimeout(() => root.removeClass("is-leaving"), 450);
        }
        const on = this.theme().flash && this.plugin.data.blink && within;
        if (on !== hovered) {
          hovered = on;
          if (root.hasClass("efeito-kindle")) return; // the whole pane is refreshing already (setFull)
          root.removeClass("is-kindle-hover");
          void root.offsetWidth; // restart the animation if it is still running
          root.addClass("is-kindle-hover");
        }
      });
    for (const type of ["pointerover", "pointerout", "focusin", "focusout"]) this.registerDomEvent(root, type, checkHover);
    this.checkHover = checkHover;
    // Last pointer position inside the pane. Toggling the cover under a still pointer doesn't update :hover until the
    // browser's delayed fake mouse move, so setFull marks the zones under it itself (.is-hot) until the pointer moves.
    this.registerDomEvent(root, "pointermove", (event) => {
      this.pointer = [event.clientX, event.clientY];
      this.cool(); // a real move makes :hover accurate again
    });
    // The zoom (a view transition) makes the browser fire a bogus leave at its start, since the snapshot overlay takes
    // over hit-testing; the real :hover only returns at its end. So ignore leaves meanwhile (see setFull).
    this.registerDomEvent(root, "pointerleave", () => {
      if (!root.hasClass("is-zooming")) this.cool(true);
    });
    root.addEventListener("animationstart", (event) => {
      if (event.target === root && event.animationName === "kindle-tinta") this.swap(); // ink frame covers the pane
    });
    root.addEventListener("animationend", (event) => {
      if (event.animationName !== "kindle-papel") return; // last frame of the e-ink refresh (styles.css)
      if (event.target === root) {
        this.swap();
        root.removeClass("efeito-kindle");
      } else root.removeClass("is-kindle-hover");
    });

    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Escape" && this.plugin.data.fullscreen && this.app.workspace.getActiveViewOfType(SpotifyView) === this) {
        this.setFull(false);
      }
    });

    this.applyTheme();
    this.setFull(this.plugin.data.fullscreen);
    this.showRecents();
    this.plugin.views.add(this);
    this.plugin.poll();
  }

  async onClose() {
    this.plugin.views.delete(this);
  }

  // "Now playing" / "Paused" tag; hidden unless the theme shows it.
  label(parent, long) {
    this.labelEls.push([parent.createDiv("spotify-mpris-label"), long]);
  }

  // Tall layout: the cover height is never a setting. It is always width / aspect ratio, so the blurred copy never shows
  // above or below the cover (any width, normal mode or fullscreen, any track).
  fitCover() {
    const width = this.stageEl.getBoundingClientRect().width; // fractional: no sliver of blur under rounding
    if (width) this.contentEl.style.setProperty("--spotify-mpris-cover-h", `${width / this.artRatio()}px`);
  }

  theme() {
    return THEMES[this.plugin.data.theme] || THEMES.default;
  }

  applyTheme() {
    const current = this.theme();
    for (const [id, theme] of Object.entries(THEMES)) this.contentEl.toggleClass(`theme-${id}`, theme === current);
    this.onResize();
    this.refreshArt();
    this.autoFit();
  }

  // Keeps the pane height in step with the cover (new track, new aspect ratio) and the theme's chrome around it.
  // Debounced so the theme's layout (classes, fonts) has settled before measuring; fitHeight ignores tall layouts
  // and a hidden cover, and an already fitted cover is left alone so a user's drag isn't animated for nothing.
  autoFit() {
    window.clearTimeout(this.autoFitTimer);
    this.autoFitTimer = window.setTimeout(() => {
      if (!this.plugin.data.autoFit || !this.stageEl || !this.stageEl.clientWidth || this.fullEl.hasClass("is-fitted")) return;
      this.onResize();
      if (this.fullEl.hasClass("is-fitted")) return;
      if (!this.contentEl.hasClass("is-tall")) this.fitHeight();
    }, 80);
  }

  // The covers, dithered when the e-ink filter is on: in fullscreen, and also in normal mode with
  // "ditherOutside".
  async refreshArt() {
    const src = this.art;
    if (!src || !this.fullArt) return;
    const { ditherFilter, ditherOutside, fullscreen } = this.plugin.data;
    let url = src;
    if (ditherFilter) {
      // Also computed in normal mode, so entering fullscreen finds it ready.
      const pending = this.plugin.dithered(src, FULL_GRID).catch(() => src);
      if (fullscreen || ditherOutside) {
        url = await pending;
        if (src !== this.art) return; // The track changed meanwhile.
      }
    }
    const set = (img, value) => {
      img.toggleClass("is-dithered", value !== src);
      if (img.getAttr("src") !== value) img.setAttr("src", value);
    };
    set(this.fullArt, url);
    set(this.miniArt, ditherOutside ? url : src);
  }

  // Tall fullscreen of themes with `fitTitle`: the biggest font where title + artist fill the text block.
  // Measured with the controls row closed; the block height is then fixed, so opening the row pushes
  // label, text and album down together instead of refitting.
  fitTitle() {
    const root = this.contentEl;
    const shade = this.shadeEl;
    if (!shade || !this.theme().fitTitle || !root.hasClass("is-tall") || !root.hasClass("is-full") || !shade.clientHeight) return;
    const info = this.bigInfo;
    const title = this.titleEls[this.titleEls.length - 1];
    root.addClass("is-fitting");
    shade.style.removeProperty("--spotify-mpris-big-h");
    const fits = (size) => {
      shade.style.setProperty("--spotify-mpris-big-fs", `${size}px`);
      return info.scrollHeight <= info.clientHeight && info.scrollWidth <= info.clientWidth && title.scrollWidth <= info.clientWidth;
    };
    const biggest = (hyphens) => {
      title.toggleClass("is-hyphenated", hyphens);
      let lo = 18;
      let hi = 160;
      while (hi - lo > 0.5) {
        const mid = (lo + hi) / 2;
        if (fits(mid)) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    // Syllable breaks only when they make the title clearly bigger (long words); short titles stay whole.
    const whole = biggest(false);
    const broken = biggest(true);
    const hyphens = broken >= whole * HYPHEN_GAIN;
    title.toggleClass("is-hyphenated", hyphens);
    fits(hyphens ? broken : whole);
    shade.style.setProperty("--spotify-mpris-big-h", `${info.offsetHeight}px`);
    root.removeClass("is-fitting");
  }

  trackInfo(parent) {
    this.titleEls.push(parent.createDiv({ cls: "spotify-mpris-title" }));
    this.artistEls.push(parent.createDiv({ cls: "spotify-mpris-artist" }));
  }

  controls(parent) {
    const el = parent.createDiv("spotify-mpris-controls");
    this.button(el, "skip-back", "Previous", () => call("Previous"));
    const play = this.button(el, "play", "Play/Pause", () => call("PlayPause"));
    play.addClass("spotify-mpris-play");
    this.playBtns.push(play);
    this.button(el, "skip-forward", "Next", () => call("Next"));
  }

  button(parent, icon, label, action) {
    const btn = parent.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
    setIcon(btn, icon);
    btn.addEventListener("click", () => action().catch(() => {}).then(() => this.plugin.poll()));
    return btn;
  }

  setFull(on) {
    if (this.plugin.data.fullscreen !== on) {
      this.plugin.data.fullscreen = on;
      this.plugin.saveData(this.plugin.data);
    }
    const apply = async () => {
      this.contentEl.toggleClass("is-full", on);
      this.onResize();
      this.markHot(true);
      await this.refreshArt();
      this.markHot(false);
    };
    // Themes with `flash`: e-ink refresh of the whole pane instead of the zoom (compact and tall layouts alike).
    if (this.theme().flash && this.plugin.data.blink && this.zoomReady && !reducedMotion() && this.contentEl.isShown()) {
      this.flashFull(apply);
      return;
    }
    // Zoom in/out from the cover: a view transition morphs the small cover into the fullscreen one.
    // A `flash` theme with the blink off switches at once, like an e-ink screen.
    if (!this.zoomReady || (this.theme().flash && !this.plugin.data.blink) || !document.startViewTransition || reducedMotion() || !this.contentEl.isShown() || this.contentEl.hasClass("is-tall") /* TEMP: teste sem view transition no alto */) {
      this.zoomReady = true;
      apply();
      return;
    }
    this.contentEl.addClass("is-zooming");
    document.startViewTransition(apply).finished.finally(() => {
      this.contentEl.removeClass("is-zooming");
      if (!this.pointer) return;
      // :hover is back; keep the hover content calm while it catches up, and drop the pointer if it left meanwhile.
      this.settle();
      window.setTimeout(() => {
        if (this.pointer && !this.contentEl.matches(":hover")) this.cool(true);
      }, 150);
    });
  }

  // Full-pane e-ink refresh (.efeito-kindle on the pane, frames in styles.css). The layout swaps when the ink frame starts, so
  // the negative frame still shows the old state and the paper frame the new one.
  flashFull(apply) {
    const root = this.contentEl;
    window.clearTimeout(this.flushTimer);
    root.removeClass("efeito-kindle");
    void root.offsetWidth; // restart if a refresh is still running
    root.addClass("efeito-kindle");
    if (getComputedStyle(root, "::after").animationName === "none") {
      // No frames (e.g. a theme or snippet turned them off), so swap at once.
      root.removeClass("efeito-kindle");
      apply();
      return;
    }
    this.pendingSwap = apply;
    this.flushTimer = window.setTimeout(() => this.swap(), 400); // in case animationstart never fires (pane hidden)
  }

  swap() {
    const apply = this.pendingSwap;
    this.pendingSwap = null;
    if (apply) apply();
  }

  // Drops the forced hover (.is-hot); leaving: the pointer is gone too, so the next toggle won't assume it is inside.
  cool(leaving) {
    for (const el of [this.fullEl, this.miniEl]) el.removeClass("is-hot");
    if (!leaving) return;
    this.pointer = null;
    window.clearTimeout(this.settleTimer);
    this.contentEl.removeClass("is-settling");
  }

  settle() {
    this.contentEl.addClass("is-settling");
    window.clearTimeout(this.settleTimer);
    this.settleTimer = window.setTimeout(() => this.contentEl.removeClass("is-settling"), 700);
  }

  // Marks the zones under the last known pointer position as hovered (.is-hot), from layout rather than :hover.
  // settle: the toggle just happened, so the hover content shows without its entrance animation (.is-settling).
  markHot(settle) {
    const p = this.pointer;
    if (!p || !this.checkHover) return;
    for (const el of [this.fullEl, this.miniEl]) {
      const r = el.getBoundingClientRect();
      el.toggleClass("is-hot", p[0] >= r.left && p[0] < r.right && p[1] >= r.top && p[1] < r.bottom);
    }
    if (settle) this.settle();
    this.checkHover();
  }

  // Not every Spotify cover is square (e.g. 640×561), so fit to the real aspect ratio.
  artRatio() {
    const { naturalWidth: w, naturalHeight: h } = this.fullArt;
    return w && h ? w / h : 1;
  }

  onResize() {
    if (!this.stageEl) return;
    const root = this.contentEl;
    // Tall pane (e.g. a whole sidebar) vs. low/square pane, for themes that have a tall layout.
    const tall = !!this.theme().tall && root.clientHeight >= 560 && root.clientHeight >= root.clientWidth * 1.3;
    if (tall !== root.hasClass("is-tall")) {
      root.toggleClass("is-tall", tall);
      this.refreshArt();
      if (this.showingRecents && this.theme() === THEMES.mono) this.showRecents(); // thumbnails change size with the layout
    }
    if (tall) this.fitCover();
    const art = this.stageEl.getBoundingClientRect();
    this.fullEl.toggleClass("is-fitted", Math.abs(art.width / this.artRatio() - art.height) <= 1);
    this.fitTitle();
  }

  // Smooth resize: the fit needs real layout, so the final size is applied and measured first, then the
  // start size is restored and the change replays as a CSS transition on the given containers.
  animateSizes(els, fit) {
    const before = els.map((el) => el.getAttr("style") || "");
    fit();
    const done = () => {
      els.forEach((el) => el.removeClass("spotify-mpris-resizing"));
      this.onResize();
      this.app.workspace.requestSaveLayout();
      this.app.workspace.requestResize();
    };
    if (reducedMotion()) return done();
    const after = els.map((el) => el.getAttr("style") || "");
    els.forEach((el, k) => el.setAttr("style", before[k]));
    void document.body.offsetHeight; // Commit the start size before turning the transition on.
    els.forEach((el, k) => {
      el.addClass("spotify-mpris-resizing");
      el.setAttr("style", after[k]);
    });
    window.setTimeout(done, RESIZE_MS);
  }

  // The fit helpers use undocumented workspace internals (split children, setDimension,
  // sidebar setSize), mirroring what Obsidian does when a drag ends. They may break on updates.
  // They measure the stage, so whatever a theme puts around the cover (frame, text) is discounted.
  fitHeight() {
    const tabs = this.leaf.parent;
    const split = tabs && tabs.parent;
    // In a tall layout the cover height doesn't follow the pane (it has its own handle).
    if (!this.stageEl.clientWidth || this.contentEl.hasClass("is-tall") || !split || split.direction !== "horizontal") return;
    const items = split.children;
    const i = items.indexOf(tabs);
    const d = items[i - 1] ? i - 1 : i + 1;
    if (!items[d]) return;
    this.animateSizes(items.map((item) => item.containerEl), () => {
      // Flex-grow ratios don't map 1:1 to pixels (headers, borders, rounding), so measure and correct a few times.
      for (let pass = 0; pass < 4; pass++) {
        const art = this.stageEl.getBoundingClientRect();
        const sizes = items.map((item) => item.containerEl.getBoundingClientRect().height);
        // Same 200px floor Obsidian uses when dragging.
        const delta = Math.min(art.width / this.artRatio() - art.height, Math.max(sizes[d] - 200, 0));
        if (Math.abs(delta) < 0.5) break;
        sizes[i] += delta;
        sizes[d] -= delta;
        const total = sizes.reduce((a, b) => a + b, 0);
        items.forEach((item, k) => item.setDimension((sizes[k] / total) * 100));
      }
    });
  }

  fitWidth() {
    const side = this.leaf.getRoot();
    const { workspace } = this.app;
    if (!this.stageEl.clientWidth || (side !== workspace.leftSplit && side !== workspace.rightSplit)) return;
    this.animateSizes([side.containerEl], () => {
      const art = this.stageEl.getBoundingClientRect();
      side.setSize(side.containerEl.getBoundingClientRect().width + art.height * this.artRatio() - art.width);
    });
  }

  update(state) {
    const offline = this.plugin.missingPermission ? "No permission: see Settings → Check Spotify" : "Spotify isn't open";
    const text = state ? `${state.title}\n${state.artist}` : offline;
    const title = state ? state.title || "—" : offline;
    this.titleEls.forEach((el, i) => el.setText(i === this.titleEls.length - 1 ? hyphenate(title) : title));
    this.artistEls.forEach((el) => el.setText(state ? state.artist : ""));
    if (text !== this.text) {
      this.text = text;
      this.fitTitle();
    }
    this.albumEls.forEach((el) => el.setText(state ? state.album : ""));
    const playing = !!(state && state.playing);
    this.labelEls.forEach(([el, long]) => el.setText(playing ? (long ? "Now playing" : "Now") : "Paused"));
    for (const img of this.artEls) {
      if (state && state.art) {
        if (img.getAttr("src") !== state.art) img.setAttr("src", state.art);
        img.show();
      } else {
        img.hide();
      }
    }
    this.fullArt.toggle(!!(state && state.art));
    this.miniArt.toggle(!!(state && state.art));
    if (state && state.art && state.art !== this.art) {
      this.art = state.art;
      this.refreshArt();
    }
    this.playBtns.forEach((btn) => setIcon(btn, playing ? "pause" : "play"));

    // Re-render recents when the track changes, and once a minute for the "X min ago" labels.
    const history = this.plugin.data.history;
    const key = `${history[0] && history[0].id}-${Math.floor(Date.now() / 60000)}`;
    if (this.showingRecents && key !== this.recentsKey) this.showRecents();
  }

  row(cover, title, subtitle, right, label, onClick, dithered = false) {
    const row = this.listEl.createDiv({ cls: "spotify-mpris-row", attr: { "aria-label": label } });
    const img = row.createEl("img");
    const { ditherFilter, ditherOutside } = this.plugin.data;
    if (dithered && ditherFilter && ditherOutside) {
      // No src until the dithered copy is ready, so the original doesn't flash on each re-render.
      const covers = this.listEl.hasClass("is-grid") && this.theme() === THEMES.mono && this.contentEl.hasClass("is-tall");
      this.plugin.dithered(cover, covers ? THUMB_GRID_COVERS : THUMB_GRID).then(
        (url) => img.isConnected && (img.addClass("is-dithered"), img.setAttr("src", url)),
        () => img.setAttr("src", cover)
      );
    } else {
      img.setAttr("src", cover);
    }
    const text = row.createDiv("spotify-mpris-info");
    text.createDiv({ cls: "spotify-mpris-title", text: title });
    text.createDiv({ cls: "spotify-mpris-artist", text: subtitle });
    if (right) row.createDiv({ cls: "spotify-mpris-when", text: right });
    row.addEventListener("click", () => onClick().catch(() => {}));
  }

  showRecents() {
    const history = this.plugin.data.history;
    this.showingRecents = true;
    this.recentsKey = `${history[0] && history[0].id}-${Math.floor(Date.now() / 60000)}`;
    this.listEl.empty();
    this.listEl.addClass("is-grid"); // Themes may lay the recents out as a grid of covers.
    this.listLabelEl.setText("Recent");
    if (!history.length) {
      this.listEl.createDiv({ cls: "spotify-mpris-empty", text: "Tracks that play while Obsidian is open show up here." });
      return;
    }
    // MPRIS gives the exact Spotify track ID, so recent tracks play directly (then their song radio, see playTrack).
    for (const track of history) {
      this.row(track.art, track.title, track.artist, ago(track.at), "Play", () => this.plugin.playTrack(track.id), true);
    }
  }

  async search(query) {
    if (!query) return this.showRecents();
    this.showingRecents = false;
    this.listEl.empty();
    this.listEl.removeClass("is-grid");
    this.listLabelEl.setText("Results");

    // A pasted Spotify link has an exact ID, so it can be played directly (tracks then their song radio, see playTrack).
    const link = query.match(SPOTIFY_LINK);
    if (link) {
      if (link[1] === "track") await this.plugin.playTrack(link[2]);
      else await call("OpenUri", `string:spotify:${link[1]}:${link[2]}`).catch(() => {});
      return;
    }

    // Spotify's Web API needs Premium, so results come from Deezer's free public API.
    let tracks;
    try {
      const res = await requestUrl(`https://api.deezer.com/search?limit=25&q=${encodeURIComponent(query)}`);
      tracks = res.json.data || [];
    } catch {
      this.listEl.createDiv({ cls: "spotify-mpris-empty", text: "Search failed." });
      return;
    }
    if (!tracks.length) {
      this.listEl.createDiv({ cls: "spotify-mpris-empty", text: "Nothing found." });
      return;
    }

    for (const track of tracks) {
      // Without the Web API there is no Spotify track ID, so this opens the search in the app.
      this.row(track.album.cover_small, track.title, `${track.artist.name} · ${formatTime(track.duration)}`, "", "Open in Spotify", () =>
        call("OpenUri", `string:spotify:search:${encodeURIComponent(`${track.artist.name} ${track.title}`)}`)
      );
    }
  }
}

module.exports = class SpotifyMprisPlugin extends Plugin {
  async onload() {
    this.data = Object.assign(
      { history: [], fullscreen: false, theme: "default", ditherFilter: false, ditherOutside: false, autoFit: true, blink: true },
      await this.loadData()
    );
    this.views = new Set();
    this.ditherCache = new Map(); // `${url}@${grid}` → Promise of a blob URL
    // The fit depends on the font's metrics, and a theme's font loads the first time the theme is drawn.
    this.registerDomEvent(document.fonts, "loadingdone", () => this.views.forEach((view) => view.fitTitle()));
    // Flatpak grants are fixed for the life of the process, so checking once is enough.
    this.missingPermission = !!flatpakCommand();

    this.registerView(VIEW_TYPE, (leaf) => new SpotifyView(leaf, this));
    this.addRibbonIcon("music", "Open Spotify", () => this.openView());
    this.addCommand({ id: "open", name: "Open panel", callback: () => this.openView() });
    this.addCommand({ id: "play-pause", name: "Play/pause", callback: () => call("PlayPause").catch(() => {}) });
    this.addCommand({ id: "next", name: "Next track", callback: () => call("Next").catch(() => {}) });
    this.addCommand({ id: "previous", name: "Previous track", callback: () => call("Previous").catch(() => {}) });
    this.addSettingTab(new SpotifySettingTab(this.app, this));

    // Offered once per machine; afterwards the "Verificar Spotify" setting covers it.
    this.app.workspace.onLayoutReady(() => {
      if (!flatpakCommand() || window.localStorage.getItem(SETUP_KEY)) return;
      window.localStorage.setItem(SETUP_KEY, "1");
      new SetupModal(this.app).open();
    });

    // Polls even with the panel closed, so the history covers everything played while Obsidian is open.
    this.poll();
    this.registerInterval(window.setInterval(() => this.poll(), POLL_MS));
  }

  async poll() {
    let state = null;
    try {
      const [metadata, status] = await Promise.all([getProp("Metadata"), getProp("PlaybackStatus")]);
      state = {
        // Ads and podcasts have other trackid paths; only songs go into the history.
        id: field(metadata, "mpris:trackid").split("/track/")[1] || "",
        title: field(metadata, "xesam:title"),
        artist: field(metadata, "xesam:artist"),
        album: field(metadata, "xesam:album"),
        art: field(metadata, "mpris:artUrl"),
        playing: status.includes('"Playing"'),
      };
    } catch {
      // Spotify is not running.
    }

    // After the chosen track has played, the next one is from its album: switch to the song radio instead.
    const radio = this.radioAfter;
    if (radio && state && state.id) {
      if (state.id === radio.id) radio.seen = true;
      else if (radio.seen) {
        this.radioAfter = null;
        call("OpenUri", `string:spotify:station:track:${radio.id}`).catch(() => {});
        return;
      }
    }

    const history = this.data.history;
    if (state && state.id && state.id !== (history[0] && history[0].id)) {
      const { id, title, artist, album, art } = state;
      this.data.history = [{ id, title, artist, album, art, at: Date.now() }, ...history.filter((t) => t.id !== id)].slice(0, HISTORY_MAX);
      this.saveData(this.data);
    }

    this.views.forEach((view) => view.update(state));
  }

  // A track URI plays inside its album, and the song radio (station URI) skips the track itself, so play the
  // track and let poll() open its radio once it changes.
  playTrack(id) {
    this.radioAfter = { id, seen: false };
    return call("OpenUri", `string:spotify:track:${id}`).catch(() => {});
  }

  onunload() {
    this.ditherCache.forEach((pending) => pending.then((url) => URL.revokeObjectURL(url), () => {}));
  }

  // Called after a setting changes.
  applySettings() {
    this.views.forEach((view) => {
      view.applyTheme();
      if (view.showingRecents) view.showRecents();
    });
  }

  dithered(url, grid) {
    const filter = (THEMES[this.data.theme] || THEMES.default).filter || "spectra6";
    if (filter !== this.ditherFilterId) {
      // Another palette (theme switch): the cache is stale. Revoke late, the old images stay on screen until replaced.
      const stale = [...this.ditherCache.values()];
      this.ditherCache.clear();
      this.ditherFilterId = filter;
      window.setTimeout(() => stale.forEach((pending) => pending.then((blobUrl) => URL.revokeObjectURL(blobUrl), () => {})), 10000);
    }
    const key = `${url}@${grid}`;
    if (!this.ditherCache.has(key)) {
      this.ditherCache.set(key, dither(url, grid, FILTERS[filter]));
      // Drop the oldest covers so blob URLs don't pile up over a long session.
      for (const [old, pending] of this.ditherCache) {
        if (this.ditherCache.size <= DITHER_CACHE_MAX) break;
        this.ditherCache.delete(old);
        pending.then((blobUrl) => URL.revokeObjectURL(blobUrl), () => {});
      }
    }
    return this.ditherCache.get(key);
  }

  async openView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
  }
};
