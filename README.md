# MD Forge

MD Forge is a Markdown editor for Windows. It shows your raw Markdown text on
the left and a live, editable preview of how it will look on the right --
edit either side, and the other one updates automatically to match. It's
built for people who write Markdown day to day and need it to land cleanly
in places like Confluence or Word, where a plain `.md` file usually looks
wrong once you paste it in.

## Download & Install (Windows)

1. Go to the [Releases page](https://github.com/Cboybebop/MDForge-ElectronApp/releases)
   and download the latest `MD Forge Setup <version>.exe`.
2. Run the installer. Because it is **unsigned** -- there's no paid
   code-signing certificate behind this project -- Windows SmartScreen will
   show a warning the first time you run it, titled *"Windows protected your
   PC"*. This is expected for every unsigned installer. Click **"More info"**,
   then **"Run anyway"**. It only appears on this first install, never on
   later automatic updates.
3. Every release also publishes a `checksums.txt` file alongside the
   installer. If you'd like to verify your download, open PowerShell in the
   folder you downloaded it to and run:
   ```powershell
   Get-FileHash -Algorithm SHA256 ".\MD Forge Setup <version>.exe"
   ```
   and compare the result against the matching line in `checksums.txt`.
4. MD Forge checks for updates automatically and installs them quietly the
   next time you quit the app -- it never interrupts you mid-edit.

## What it does

- Open and save `.md` files, with multiple tabs open at once and a
  folder-based sidebar for working across a whole project of files
- Edit the raw Markdown on the left, or edit the rendered preview directly on
  the right -- both stay in sync automatically
- Syntax highlighting in the raw pane, so headings, links, code and emphasis
  are easy to pick out at a glance, in both light and dark themes
- Find and replace, including whole-word and regular-expression search
- Format text in the preview with a toolbar (headings, bold, italic, lists,
  quotes, code blocks, links) without needing to remember Markdown syntax
- Copy content formatted specifically for pasting into Confluence or Word, so
  tables and headings survive the paste instead of turning into plain text
- Autosave and crash recovery -- if the app or your computer crashes,
  unsaved work is there when you reopen it
- Automatic background updates, with a manual "Check for Updates..." option
  in the Help menu

## Build it yourself

If you'd rather compile MD Forge from source than run the installer:

**Requirements:** [Node.js](https://nodejs.org/) 20.19 or later (22.12+
recommended), on Windows.

```bash
npm install
npm run build       # production build
npm run build:win   # packages a Windows installer into dist/
```

The installer will be written to `dist/`. It is unsigned, so the same
SmartScreen warning described above will appear the first time you run it.

For day-to-day development instead of a packaged build:

```bash
npm run dev   # runs the app with hot reload
```

---

*This is a release-only snapshot. Source history, tests, and planning docs
live in the private development repository this project is built from.*
