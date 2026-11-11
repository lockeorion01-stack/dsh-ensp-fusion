# eNSP topology format — verified reference

Every rule below was derived from the **40 sample topologies shipped with eNSP**
(`E:\Huawei\eNSP\examples\**\*.topo`) and confirmed by opening generated files in
eNSP. Nothing here is guessed; where a rule could not be established it is marked
**UNVERIFIED** rather than assumed.

Re-derive with:

```bash
node scripts/survey-topologies.mjs   # prints the tables this document summarises
```

---

## 1. File envelope

| Rule | Value |
|---|---|
| Text encoding | **UTF-8** (no BOM), despite the declaration |
| XML declaration | `<?xml version="1.0" encoding="UNICODE" ?>` — eNSP writes `UNICODE` but saves UTF-8 |
| Root element | `<topo version="1.2.00.390">` (newest samples; `1.3.00.100` also accepted) |
| Child order | `<devices>` → `<lines>` → `<shapes />` → `<txttips />` |
| Empty elements | self-closing (`<shapes />`), not `<shapes></shapes>` |
| Line endings | CRLF in native files; LF is accepted |

> Getting the encoding wrong is a silent failure: eNSP opens an empty canvas.

---

## 2. `<dev>` attributes

Two shapes exist. Use the one matching the model.

### 2a. Router / switch / PC (no `poe`, no `system_mac`)

```xml
<dev id="..." name="R1" model="AR2220" settings="" com_port="2000" bootmode="1"
     cx="250.000000" cy="30.000000" edit_left="277" edit_top="84">
```

Attribute order: `id name model settings com_port bootmode cx cy edit_left edit_top`

### 2b. Wireless / cloud / AP (adds `poe` and `system_mac`)

```xml
<dev id="..." name="AP1" poe="0" model="AP6050" settings="" system_mac=""
     com_port="0" bootmode="1" cx="..." cy="..." edit_left="..." edit_top="...">
```

Attribute order: `id name poe model settings system_mac com_port bootmode cx cy edit_left edit_top`

### Derived fields

| Field | Rule | Verified by |
|---|---|---|
| `edit_left` | `cx + 27` | every sample, no exceptions |
| `edit_top` | `cy + 54` | every sample, no exceptions |
| `id` | UUID; eNSP writes **lowercase** in newer files, mixed case in older | — |
| `com_port` | console TCP port; `0` for models without a console (PC, Server, Cloud) | — |
| `bootmode` | `1` in practice; does **not** auto-start devices | tested: bootmode=1 + open ⇒ no boot |

> `system_mac` is absent from router/switch/PC entries in native files. Writing it
> is tolerated but breaks byte-level diffs.

---

## 3. `<slot>` and `<interface>` — the part that breaks silently

Every device has exactly one slot:

```xml
<slot number="slot17" isMainBoard="1">
    <interface sztype="Ethernet" interfacename="GE" count="24" />
</slot>
```

**The grouping must match eNSP's own exactly.** A single `count="3"` on an AR2220
does not expand to `GE0/0/0 + GE0/0/1..2`; eNSP fails to render the device and
shows an empty canvas with **no error message**.

### Verified interface declarations

| Model | Declarations (in order) | Total | Count seen |
|---|---|---|---|
| `S5700` | `Ethernet/GE×24` | 24 | 58 |
| `S3700` | `Ethernet/Ethernet×22`, `Ethernet/GE×2` | 24 | 6 |
| `AR2220` | `Ethernet/GE×1`, `Ethernet/GE×2` | 3 | 37 (46 with serial cards) |
| `AR1220` | `Ethernet/GE×2`, `Ethernet/Ethernet×8` | 10 | 52 (with serial: 12) |
| `AR201` | `Ethernet/Ethernet×8`, `Ethernet/Ethernet×1` | 9 | 1 |
| `AC6005` | `Ethernet/GE×8` | 8 | 1 |
| `AP6050` | `Ethernet/GE×2` | 2 | 1 |
| `PC` | **`Ethernet/GE×1`** | 1 | 8 |
| `Laptop` | `Ethernet/Ethernet×1` | 1 | 5 |
| `MCS` | `Ethernet/Ethernet×1` | 1 | 1 |
| `Cloud` | `Ethernet/Ethernet×3`, `Ethernet/GE×0`, `Serial/Serial×0` | 3 | 4 |
| `FRSW` | `Serial/Serial×16` | 16 | 1 |

> **`PC` declares `interfacename="GE"`, not `"Ethernet"`.** An earlier version of
> this project wrote `Ethernet` for PCs on the theory that a PC has one Ethernet
> port; that produced an empty canvas. The CLI name of that single port is still
> `Ethernet0/0/1` — the file's `interfacename` and the CLI name are different
> vocabularies.

### Models not present in the samples

`AR2240`, `USG5500`, `USG6000V`, `Server`, `STA`, `Cellphone` — **UNVERIFIED**.
`AR2240` is believed to be `Ethernet/GE×4` (its predecessor AR2220 style), but no
bundled file proves it. Generate one by hand in eNSP and diff before relying on it.

---

## 4. Cable indices

`srcIndex` / `tarIndex` are a **flat index across the device's declared interfaces**,
walking the `<interface>` groups in order from 0.

| Model | Index → CLI port |
|---|---|
| `S5700` | `0 → GE0/0/1`, `1 → GE0/0/2`, … `23 → GE0/0/24` |
| `S3700` | `0..21 → Ethernet0/0/1..22`, `22..23 → GE0/0/1..2` |
| `AR2220` | `0 → GE0/0/0`, `1 → GE0/0/1`, `2 → GE0/0/2` |
| `AR1220` | `0..1 → GE0/0/0..1`, `2..9 → Ethernet0/0/0..7` |
| `PC` | `0 → Ethernet0/0/1` |
| `Cloud` | `0..2 → Ethernet0/0/0..2` |

Verified against the samples: every S5700 link uses indices `0..23` contiguously,
and AR1220 links use `0,1` for GE and `4,5,10,11` for the serial card slots.

> **Index base differs by model.** S5700/S3700/AC6005 number CLI ports from 1;
> routers number from 0. That is why the same index `0` means `GE0/0/1` on a switch
> and `GE0/0/0` on a router.

---

## 5. `<line>` and anchors

```xml
<line srcDeviceID="A" destDeviceID="B">
    <interfacePair lineName="Copper" srcIndex="0" srcBoundRectIsMoved="0"
        srcBoundRect_X="250.200000" srcBoundRect_Y="363.000000"
        srcOffset_X="0.000000" srcOffset_Y="0.000000"
        tarIndex="1" tarBoundRectIsMoved="0"
        tarBoundRect_X="283.800000" tarBoundRect_Y="163.000000"
        tarOffset_X="0.000000" tarOffset_Y="0.000000" />
</line>
```

| Field | Rule |
|---|---|
| `lineName` | `Copper` (RJ45), `Serial`, or `Fiber` |
| anchor offsets | icon bounding box: `x − 16.2` (left), `x + 70.2` (right), `y − 16.2` (top), `y + 70.2` (bottom) |
| anchor position | eNSP **recomputes** these on open, so approximate values are safe |
| `*IsMoved` / `*Offset_*` | always `0` in practice |

---

## 6. Things that fail silently

| Symptom | Cause |
|---|---|
| Empty canvas, no error | `<interface>` grouping does not match the model |
| Device missing | malformed `<dev>` attribute list or bad UUID |
| Cable missing / wrong port | flat index out of range or computed from the wrong base |
| Nothing boots on open | `bootmode="1"` does **not** auto-start; the client must be clicked |
| Coordinates land wrong | mixing DPI-scaled and physical pixels (see `UI-ANCHORS.md`) |

## 7. Frame coordinates recap

Everything in this project uses the **window-rect frame** (physical pixels), and
`SetProcessDPIAware()` must be called before any `GetWindowRect` /
`CopyFromScreen` / `SetCursorPos`. On a 150 % display the scaled and physical
rects differ by 1.5×, which is exactly the bug that hid for several rounds.
