# tokometer

A single binary that shows you where your Claude Code tokens go. It reads Claude
Code's own session transcripts directly — no telemetry exporter, no env vars, no
Prometheus, no Grafana, no Docker, no collector. One process, one port, one
dashboard.

```
~/.claude/projects/*.jsonl ──watch──▶ tokometer ──▶ http://localhost:4318
```

## Install

**One-line install** (macOS / Linux, prebuilt binary — no Go needed):

```bash
curl -fsSL https://tokometer.apps.alileza.me/install.sh | sh
```

**Homebrew** (macOS / Linux):

```bash
brew install alileza/tap/tokometer
```

**With Go:**

```bash
go install github.com/alileza/tokometer@latest
```

Or grab a binary for your platform from the
[Releases page](https://github.com/alileza/tokometer/releases). Then just run:

```bash
tokometer
```

That's the whole setup. Open **http://localhost:4318**. tokometer reads your
existing transcripts, so your full history is there immediately — total tokens by
type (cacheRead / cacheCreation / output / input), tokens per hour, sessions,
active time, a per-prompt cost breakdown (with the real prompt text), and which
files and tools fill the context.

It tails the transcript files, so new activity shows up within a couple of
seconds while you work — the dashboard pushes updates live over WebSocket.

## Why read the transcripts instead of OTLP?

Claude Code writes every session to a JSONL transcript under `~/.claude/projects`,
and every assistant message already carries the API response's real `usage`
(input / cache-read / cache-creation / output tokens), the model, and a timestamp.
So the files contain exactly the accounting OTLP would emit — plus the full prompt
and tool content — and reading them means:

- **No setup.** No `OTEL_*` exporter config, no restarting your session.
- **Full history, retroactively.** Every past session counts, not just the ones
  after you turned telemetry on.
- **Real numbers.** Token counts come straight from each request's `usage`, not
  estimates; per-prompt views and prompt text need no opt-in flag.

## Flags

```
-addr      listen address for the dashboard (default :4318)
-projects  Claude Code projects dir to watch (default ~/.claude/projects)
-poll      how often to re-scan transcripts for new activity (default 2s)
```

## Details

- Nothing is persisted — the transcript files are the source of truth, so a
  restart just rebuilds from disk. On start it reads all history once, then tails
  each file, parsing only newly appended lines.
- The dashboard updates live over WebSocket (`/ws`, hand-rolled RFC 6455,
  server-push only): a snapshot on connect, a push whenever a transcript changes,
  automatic fallback to polling if the socket drops.
- Zero Go dependencies; the dashboard is TypeScript rendered with
  [uPlot](https://github.com/leeoniya/uPlot) — the same charting library Grafana's
  Time series panel uses — bundled and embedded in the binary. `make build`
  rebuilds both.

## Releasing (maintainers)

Releases are cut by pushing a semver tag; a GitHub Actions workflow runs
[GoReleaser](https://goreleaser.com), which cross-compiles every platform, uploads
the archives + `checksums.txt` to the GitHub Release, and updates the Homebrew tap.

```bash
make build && git add -A && git commit -m "…"   # refresh the embedded dashboard first
git tag v0.1.0
git push origin main --tags
```

One-time setup for the Homebrew formula:

1. Create an empty repo `alileza/homebrew-tap`.
2. Create a fine-grained PAT with **contents: read & write** on that repo.
3. Add it to this repo's Actions secrets as `HOMEBREW_TAP_TOKEN`.

(Skip all three and delete the `brews:` block in `.goreleaser.yaml` to publish
binaries only.)

## Why not Prometheus + Grafana?

[claude-otlp-example](https://github.com/alileza/claude-otlp-example) does a
related job with the full OTLP stack — collector, Prometheus, Grafana, three
containers, and the same exporter env vars. It works, but it's a lot of machinery,
and it only sees usage from the moment you wire it up. tokometer needs none of
that and reads what Claude Code already wrote.

## License

MIT
