# lexometer

A single binary that shows you where your Claude Code tokens go. It reads Claude
Code's own session transcripts directly — no telemetry exporter, no env vars, no
Prometheus, no Grafana, no Docker, no collector. One process, one port, one
dashboard.

```
~/.claude/projects/*.jsonl ──watch──▶ lexometer ──▶ http://localhost:4318
```

## Install

```bash
go install github.com/alileza/lexometer@latest
lexometer
```

That's the whole setup. Open **http://localhost:4318**. lexometer reads your
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

## Why not Prometheus + Grafana?

[claude-otlp-example](https://github.com/alileza/claude-otlp-example) does a
related job with the full OTLP stack — collector, Prometheus, Grafana, three
containers, and the same exporter env vars. It works, but it's a lot of machinery,
and it only sees usage from the moment you wire it up. lexometer needs none of
that and reads what Claude Code already wrote.

## License

MIT
