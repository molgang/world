# Web ↔ Roblox sync protocol

The web experience (Moleculia) is the **continuation** of the Roblox teaser, so
it must stay in sync with the game's lines — while the web keeps its extra
realism headroom (IBL/bloom/photoscanned props/WebXR, which Roblox can't match).

## Rule 1 — the Roblox Lua modules are the single source of truth

| Game data | Lua source (game/src/…) | Consumed by |
|---|---|---|
| 118 elements (symbol, colour, facts) | `Data/Elements.lua` | `moleculia_gen.py` → `moleculia.json` |
| 10 fertilizers (NPK + atom recipes) | `Modules/FertilizerTrack.lua` | idem |
| 5 crops (ideal NPK, pH, growth days) | `Modules/FertilizerTrack.lua` | idem |
| 34 factory equipment (+ adjacency, floor) | `Modules/FactoryEquipment.lua` | idem |
| 12-station line, particle sizes, roast boost | `Modules/SteelSlag.lua` | gen + `sim_server.py` / `world.js` constants |
| Process kinetics (Arrhenius/Henry/pH) | `Modules/ProcessEngineering.lua` | `process_sim.py` port + JS client reactor |
| V2O5 price (500 MolCoins) | `Modules/ProductMarket.lua` | `sim_server.V2O5_PRICE`, `world.js` |

**Never hand-edit `moleculia.json`** — it is generated. When the Lua changes,
run `python3 assets/world/moleculia_gen.py` and commit the regenerated file.

## Rule 2 — automated drift guards (run before every PR)

```bash
python3 assets/world/moleculia_gen.py --check   # fails if moleculia.json is stale vs the Lua
python3 assets/world/world_smoke.py             # includes Lua-parity asserts:
                                                #  - SteelSlag leachMultipliers == web LEACH_MULT
                                                #  - SteelSlag roasting boostFactor == web ROAST_BOOST
                                                #  - ProductMarket V2O5 basePrice == web V2O5_PRICE
bash assets/world/build_deploy.sh && python3 assets/world/garden_smoke.py
                                                # browser guard (Playwright): the personal garden
                                                # stays the walkable front end for the REAL
                                                # elements -> Fertilizer Lab -> crop economy
                                                # (crops[]/fertInv/fertById) — fails if it ever
                                                # grows a second, invented crop/fertiliser economy
                                                # instead; also guards world grounding (real
                                                # steelworks terrain, never the old space void)
python3 assets/world/sync_from_knitweb.py --check
                                                # fails if assets/{viscosity,steelworks,rivierlab}
                                                # drifted from the pinned vendor/knitweb submodule
                                                # (molgang/pages) — replaces the old undetectable
                                                # manual "re-copy" step; see the section below
```

All four exit non-zero on drift, so they can gate CI or a pre-commit hook.

## Rule 3 — web keeps its realism surplus

Rendering (HDR pipeline, photoscanned CC0 props, adaptive resolution, WebXR)
and web-only conveniences (client-side reactor for static hosting, ChemSim
console) are **web-side additions** — they must never change the game *data* or
*rules*, only their presentation. New game rules land in the Lua first, then
flow here via Rule 1.

## Rule 4 — PR flow

Web work ships on `web/*` branches with `web(moleculia):` commit prefixes and a
PR against `main`, so Roblox-side agents can review data-contract changes.
Rule-2 guards must pass before merge.

## Generated copies — assets/{viscosity,steelworks,rivierlab}/

These three directories are **generated**, not hand-copied, by
`assets/world/sync_from_knitweb.py` from the `vendor/knitweb` submodule
(molgang/pages, formerly Knitweb/molgang: `web/viscosity-room.html`,
`web/steelworks.html` + `web/steelworks/data` (OSM terrain, ODbL,
attribution shown in the UI), `web/rivierlab.html`, plus the shared
`viscosity-sim.js`/`quest-input.js`). The exact link-rewrite rules (e.g.
`href="index.html"` → `href="../world/"`, steelworks data paths flattened
to `data/`) live as an explicit substitution list at the top of the script
— **never hand-edit the generated files**, change the knitweb source and
regenerate.

The Python physics authority (`viscosity_core.py`, `river_flow.py`) is
`vendor/physics` (molgang/physics, extracted from febuz/molgang-web with
history preserved) — pinned as its own submodule, not routed through
knitweb. `tests/test_*_sim_parity.py` in molgang/pages imports it directly
from there.

Update flow: bump the `vendor/knitweb` submodule pin (or edit `*_SUBS` in
`sync_from_knitweb.py` if knitweb's HTML shape changed), run
`python3 assets/world/sync_from_knitweb.py`, commit the regenerated files
alongside the pin bump, rebuild the bundle with `build_deploy.sh`. Rule 2's
`--check` catches anyone who skips this and hand-edits the generated copy
instead. The world links to viscosity via the `interact: "viscosity"` prop
(moleculia_gen.py) handled in world.js; the game entry redirect starts
players at `steelworks/` (their nearest real steel plant).
