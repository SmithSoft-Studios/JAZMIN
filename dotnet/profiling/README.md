# JAZMIN profiling

Tools and captured CPU traces for profiling the .NET library. Created 2026-10-06
while investigating read/write hot paths (findings: issue #70).

## Why this exists separately from `bench/`

`bench/Jazmin.Benchmarks` measures end-to-end timings and sizes for quoting. It is
**not** a good CPU-profiling target: its `Time()` / `AllocatedMb()` helpers call
`GC.Collect()` + `WaitForPendingFinalizers()` between every iteration, so in a CPU
trace ~55% of samples are forced GC/finalization, not library code.

`ProfDrive` instead loops **one path at a time with no inter-iteration GC**, so a CPU
trace attributes self-time to real library work.

## Collecting a trace

Requires the .NET diagnostic CLI tools (one-time):

```
dotnet tool install --global dotnet-trace
```

Build and trace one path (`read` | `readreuse` | `deser` | `write`):

```
dotnet build profiling/ProfDrive/ProfDrive.csproj -c Release -f net10.0
EXE=profiling/ProfDrive/bin/Release/net10.0/ProfDrive.exe
dotnet-trace collect --format speedscope -o profiling/traces/prof-read.nettrace -- "$EXE" read 200000
```

`ProfDrive <mode> [rows] [iters]`:
- `read`      - point lookup by Sorted index, **reader opened per lookup** (real "open file, one lookup" pattern)
- `readreuse` - same lookup, reader opened once and reused (isolates per-open cost)
- `deser`     - full materialization of every row
- `write`     - serialize + build 3 indexes

## Opening the traces

- **Visual Studio**: File -> Open -> File -> pick a `traces/*.nettrace`. Gives the
  flame graph, call tree and hot-path view - the same UI as Alt+F2 Performance Profiler.
- **speedscope.app**: drag a `traces/*.speedscope.json` onto https://www.speedscope.app
- **Quick self-time summary**: `node profiling/analyze.js profiling/traces/prof-read.speedscope.json`
  Attributes native/pseudo leaves to the nearest managed frame and excludes idle
  thread-pool wait, so library hot spots rise to the top.

## Captured traces (2026-10-06, .NET 10.0.12, Win 11)

| file | path | notes |
|------|------|-------|
| `prof-read`      | point lookup, open per lookup | ~60% expression-tree compile on each `Open()` |
| `prof-readreuse` | point lookup, reader reused   | compile cost gone; real decode work on top |
| `prof-deser`     | full deserialize              | `StringPool.Read`, `Columnar.DecodeTyped` dominate |
| `prof-write`     | serialize + 3 indexes         | ~34% GC/ArrayPool churn, index build, memmove |
| `cpu-default`    | whole default benchmark       | shows the harness forced-GC noise described above |

The `.nettrace` / `.speedscope.json` binaries are git-ignored (large, regenerable).
The `ProfDrive` driver and this README are tracked so the setup is reproducible.
