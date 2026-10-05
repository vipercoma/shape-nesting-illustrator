# True-Shape Nesting — Adobe Illustrator CEP Extension

Packs the selected shapes tightly onto a sheet (default **30 × 30 cm**) using a real
**No-Fit-Polygon (NFP)** engine. It works with the actual outline of each shape, not its
bounding box, so concave parts (L, T, stars, etc.) can interlock.

## 1. Folder structure

```
NestingExtension/
├── CSXS/
│   └── manifest.xml        ← CEP manifest (Illustrator CC 2013+ / v17+, CSXS 7)
├── css/
│   └── style.css           ← dark Illustrator-style panel theme
├── js/
│   ├── CSInterface.js      ← Adobe CEP bridge library
│   ├── nfp.js              ← NFP nesting engine (pure JS)
│   └── main.js             ← panel UI controller
├── jsx/
│   └── hostscript.jsx      ← ExtendScript: reads paths / moves & rotates items
├── index.html              ← panel markup
└── README.md
```

## 2. Install

Copy the whole `NestingExtension` folder into the CEP extensions folder:

| OS      | Folder (per user) |
|---------|-------------------|
| Windows | `%APPDATA%\Adobe\CEP\extensions\` (e.g. `C:\Users\<you>\AppData\Roaming\Adobe\CEP\extensions\NestingExtension`) |
| macOS   | `~/Library/Application Support/Adobe/CEP/extensions/` (e.g. `~/Library/Application Support/Adobe/CEP/extensions/NestingExtension`) |

Create the `extensions` folder if it does not exist. To install it for all users, use
`C:\Program Files (x86)\Common Files\Adobe\CEP\extensions\` on Windows or
`/Library/Application Support/Adobe/CEP/extensions/` on macOS.

## 3. Enable debug mode (needed for unsigned extensions)

The extension is not signed, so Illustrator only loads it when **PlayerDebugMode** is on.
Set it for each CSXS version your Illustrator might use (11 and 12 cover Illustrator 2022–2025+;
add 9 and 10 for older versions).

**Windows** — open Command Prompt and run:

```bat
reg add HKEY_CURRENT_USER\Software\Adobe\CSXS.9  /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKEY_CURRENT_USER\Software\Adobe\CSXS.10 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKEY_CURRENT_USER\Software\Adobe\CSXS.11 /v PlayerDebugMode /t REG_SZ /d 1 /f
reg add HKEY_CURRENT_USER\Software\Adobe\CSXS.12 /v PlayerDebugMode /t REG_SZ /d 1 /f
```

(Or use `regedit`: go to `HKEY_CURRENT_USER\Software\Adobe\CSXS.11` and add a **String** value
named `PlayerDebugMode` with data `1`.)

**macOS** — open Terminal and run:

```bash
defaults write com.adobe.CSXS.9  PlayerDebugMode 1
defaults write com.adobe.CSXS.10 PlayerDebugMode 1
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
defaults write com.adobe.CSXS.12 PlayerDebugMode 1
killall cfprefsd
```

Then **restart Illustrator** completely.

## 4. Open the panel

In Illustrator, go to **Window → Extensions → True-Shape Nesting**
(on newer versions it may be under **Window → Extensions (Legacy) → True-Shape Nesting**).

## 5. How to use

1. Open your document. Make the artboard you want to fill active by clicking on it.
2. Select every object you want to nest. Supported objects are paths, compound paths and groups.
   Other objects are handled as rectangles.
3. In the panel:
   - **Width / Height (cm)**: set the sheet size (default 30 × 30), or click **Get Artboard Size**
     to use the size of the active artboard.
   - **Spacing (mm)**: the minimum gap between shapes.
   - **Curve tol. (mm)**: how closely curves are approximated. Smaller values are more precise but slower.
   - **Rotations**: the angles to try (0°, 90°, 180°, 270° by default). **Extra step** adds more
     angles, for example `45` adds 45°, 135°, 225° and 315°.
4. Click **Nest Shapes**. The panel reads the outlines, runs the NFP nesting, draws a preview,
   and then moves and rotates the shapes onto the active artboard. The artboard's top-left corner is the sheet origin.
   - Or click **Preview Only** to see the layout first, then **Apply Last Result** to move the shapes.
5. Shapes that don't fit on the sheet are reported in the log and left where they are.
6. Use **Edit → Undo** in Illustrator to revert if needed.

## How the algorithm works (nfp.js)

1. Bézier outlines are flattened in ExtendScript, then simplified with Ramer–Douglas–Peucker.
2. Concave polygons are split into convex pieces (ear-clipping triangulation + Hertel–Mehlhorn merge).
3. The NFP of a placed part A and a new part B is `A ⊕ (−B)`. For each convex pair it is computed
   exactly with the rotating-calipers edge merge. The NFP of concave shapes is the exact union of these pieces.
4. Spacing is applied by Minkowski-adding a small octagon to the placed parts.
5. The Inner-Fit Rectangle keeps every part inside the sheet.
6. The candidate positions are the IFR corners, the NFP vertices, and all NFP×NFP and NFP×IFR edge
   intersections. The engine takes the lowest feasible position, then the leftmost one. Parts are placed
   largest area first, and every allowed rotation is tried.

Holes inside shapes are not used for placing other parts. Each compound path is nested by its outer
boundary.

## Debugging

With debug mode on, add a `.debug` file to the extension root to enable Chrome DevTools:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ExtensionList>
  <Extension Id="com.truenest.illustrator.panel">
    <HostList><Host Name="ILST" Port="8088"/></HostList>
  </Extension>
</ExtensionList>
```

Then open `http://localhost:8088` in Chrome while the panel is open. This is localhost on the
machine running Illustrator.

You can also open `index.html` in a normal browser to test the engine with built-in demo shapes.

## Vipercoma design edition

Close Illustrator and double-click Install.bat on Windows. It checks all required files, backs up an existing NestingExtension installation and verifies copied files with SHA-256. It does not change security settings or enable debug mode. Restart Illustrator and open Window > Extensions > True-Shape Nesting.

See DESIGN.md for the monochrome design foundation. The new visual layer has not yet been verified live in Illustrator.

