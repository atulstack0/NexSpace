# Using the Renderpeople "Eric" character in the 3D office

The 3D view can render a real character model for avatars. The web renderer (Three.js) only loads
**glTF/GLB**, but the Renderpeople pack ships **Cinema 4D (`.c4d`)** and **FBX (`.fbx`)** files — so the
model needs a one-time **FBX → GLB** conversion. Until `apps/web/models/eric.glb` exists, avatars use the
built-in styled businessman avatar automatically (no errors).

Source folder you provided: `66-rp_eric_rigged_001_c4d/` — use **`rp_eric_rigged_001_yup_a.fbx`**
(Y-up, **A-pose** — Y-up matches Three.js, and the A-pose stands more naturally than the T-pose for a
static avatar). The `tex/` subfolder has the textures it references.

---

## Convert FBX → GLB (pick one)

### A) Blender (free, recommended — also lets you shrink the file)
1. Install Blender (https://www.blender.org), open it, delete the default cube.
2. **File → Import → FBX (.fbx)** → choose `rp_eric_rigged_001_yup_a.fbx`.
   (Keep the `tex/` folder next to the FBX so textures resolve.)
3. *(Recommended — the raw model is high-poly for the web)* Select the body mesh →
   **Modifier ▸ Add Modifier ▸ Decimate ▸ Ratio ≈ 0.25** to cut the polygon count ~4×.
4. **File → Export → glTF 2.0 (.glb/.gltf)**:
   - Format: **glTF Binary (.glb)**
   - Include: **Selected Objects** off (export all), **Materials** on, **Images: Automatic** (embeds textures)
   - **Transform ▸ +Y Up** on
   - Do **not** enable Draco compression (the loader here isn't set up for Draco).
5. Save as **`eric.glb`**.

### B) FBX2glTF (command line, fastest)
```bash
# https://github.com/facebookincubator/FBX2glTF  (download the binary for your OS)
FBX2glTF -b -i rp_eric_rigged_001_yup_a.fbx -o eric.glb
```
`-b` = binary GLB. Textures from `tex/` are embedded.

---

## Install it
1. Put the file at **`apps/web/models/eric.glb`**.
2. Keep it reasonably small so Git/Render can serve it — aim for **under ~5 MB**
   (decimate the mesh and/or downscale the diffuse texture to 1–2K). Then:
   ```powershell
   cd C:\Users\chat360it1\Claude\Projects\NexSpace\nexspace-scaffold
   git add apps/web/models/eric.glb; git commit -m "assets: add eric.glb character"; git push
   ```
3. Hard-refresh the site (Ctrl+Shift+R) and switch to 3D — avatars become the Eric model,
   tinted slightly per person, with name tags.

---

## Tweaks (in `apps/web/index.html`, search `ERIC_`)
- `ERIC_FOR = "all"` → everyone uses the model. Set to `"me"` for just your avatar (much lighter).
- `ERIC_FACE = Math.PI` → base facing. If the character faces **away** from its walk direction,
  change this to `0` (or `-Math.PI/2` / `Math.PI/2`) and redeploy.
- The model auto-scales to the avatar height and drops its feet to the floor, so size should "just work."

## Notes
- **Licensing:** Renderpeople assets are licensed to you; this just loads your own file. Don't commit it to a
  public repo if your license forbids redistribution — host it on a private URL and point `loadEric()` at it instead.
- **Performance:** one high-poly human per avatar is heavy. If the room feels slow, set `ERIC_FOR = "me"`,
  or decimate the mesh further.
- The same model is shared by everyone (Renderpeople is a single person), differentiated by the per-person
  colour tint + floating name tag.
