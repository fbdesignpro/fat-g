# Application icon

A black circle, transparent outside, with a white lowercase **f** from the bundled Inter 4.1
SemiBold font. The glyph's visible bounds are centered. A small transparent margin keeps the circle
inside the icon area. Inter is licensed under OFL-1.1; its unchanged font and license are in
`src/renderer/public/fonts/inter/` and credited in the packaged third-party notices.

The glyph keeps its original proportions and centering at every size. Below 128 px, separate
Gaussian filters smooth the main circle (0.8 output pixels), letter (0.5) and attention badge (0.65)
before downsampling. They are applied to layers at 1024 px: canvas can round a fractional blur away
at the final size. The circle's transparent edge gets more smoothing without softening the letter
further. This preserves gradual edge coverage when Windows scales the window icon again for its taskbar.
Do not fit the letter to a single pixel grid: the previous 24 px fit narrowed and shifted it, making
the small icon look harsher. Representations of 128 px and above keep the unfiltered master.

The attention badge's black rim is 64 px wide in the master: one pixel at 16 px, or 1.5 pixels at
24 px. The yellow centre is slightly smaller and inset to make room for this rim; the former 24 px
rim became a broken-looking hairline at taskbar sizes.

`scripts/generate-app-icons.mjs` is the editable source. Run `do-generate-icons.bat` after changing
the design, and check in its five outputs. Small representations are prefiltered offline with Skia's
best-quality resampler, including intermediate Windows DPI sizes; they are stored inside the ICOs:

- `icon.png`: 1024 px, used by the running Main window and Linux packaging.
- `icon-attention.png`: 1024 px, with a top-right yellow circle and black rim, used while any active
  session has unacknowledged attention. macOS replaces its Dock image; Windows/Linux replace the
  Main window icon. Updates happen only when that aggregate boolean changes. Launcher/pinned-icon
  behavior depends on the operating system; the packaged/installed icon remains the normal one.
- `icon.ico`: 16–256 px representations, used by Windows executables, shortcuts and the running window.
- `icon-attention.ico`: the same prefiltered sizes with the yellow dot, for the running Windows window.
- `icon.icns`: 16–1024 px representations, used by the macOS bundle.

Ordinary development and packaging use the checked-in files. No additional dependencies are needed.
Windows uses the ICO-backed NativeImage path to select a small representation rather than asking the
shell to shrink the full 1024px PNG. macOS and Linux retain their PNG runtime images.
