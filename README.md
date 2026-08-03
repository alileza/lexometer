# claudewatch

A single binary that watches your Claude Code usage. It speaks OTLP natively —
no Prometheus, no Grafana, no Docker, no collector. One process, one port, one
dashboard.

```
Claude Code ──OTLP/HTTP──▶ claudewatch ──▶ http://localhost:4318
```

## Install

```bash
go install github.com/alileza/claudewatch@latest
claudewatch
```

Then enable Claude Code's built-in telemetry (add to your shell profile):

```bash
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_METRICS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
export OTEL_RESOURCE_ATTRIBUTES="skills_enabled=false"
```

Open **http://localhost:4318** — cost per day, tokens per day by type
(cacheRead / cacheCreation / output / input), session count, and a table of every
metric received.

## Before/after comparison

`skills_enabled` in `OTEL_RESOURCE_ATTRIBUTES` is an experiment flag. Leave it
`false` while collecting your baseline; flip it to `true` the day you enable an
intervention (token-reduction skills, hooks, a new tool). Once both phases have
data, the dashboard shows average cost per active day in each phase and the
percent change — your own measured number, not a vendor claim.

## Details

- Data is stored in `~/.claudewatch/data.json` (override with `-data`), bucketed
  hourly. Cumulative OTLP sums are converted to deltas per session stream, so
  session restarts don't double-count.
- Listens on `:4318` (the OTLP/HTTP default; override with `-addr`). `/v1/logs`
  and `/v1/traces` are accepted and discarded so exporters see no errors.
- Zero Go dependencies; the dashboard is TypeScript compiled to a single embedded
  JS file. `make build` rebuilds both.

## Why not Prometheus + Grafana?

[claude-otlp-example](https://github.com/alileza/claude-otlp-example) does the
same job with the full stack — collector, Prometheus, Grafana, three containers.
It works, but it's a lot of machinery for one person's usage metrics. claudewatch
is the same telemetry with none of the operational surface.

## License

MIT
