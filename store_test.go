package main

import (
	"path/filepath"
	"testing"
	"time"
)

func TestCumulativeDeltas(t *testing.T) {
	s, _ := NewStore(filepath.Join(t.TempDir(), "d.json"))
	attrs := map[string]string{"session.id": "a", "type": "cacheRead", "model": "opus"}
	ts := time.Now().UnixNano()

	s.Add("claude_code.token.usage", attrs, ts, 100, true)
	s.Add("claude_code.token.usage", attrs, ts, 250, true) // cumulative -> +150
	s.Add("claude_code.token.usage", attrs, ts, 250, true) // no change -> +0

	// second session, same coarse labels: full value counts
	attrs2 := map[string]string{"session.id": "b", "type": "cacheRead", "model": "opus"}
	s.Add("claude_code.token.usage", attrs2, ts, 40, true)

	sum := s.Summary()
	if len(sum.Rows) != 1 {
		t.Fatalf("want 1 coarse row, got %d: %+v", len(sum.Rows), sum.Rows)
	}
	if got := sum.Rows[0].Value; got != 290 {
		t.Fatalf("want 290 tokens, got %v", got)
	}
	if sum.Rows[0].Labels["type"] != "cacheRead" || sum.Rows[0].Labels["model"] != "opus" {
		t.Fatalf("coarse labels wrong: %+v", sum.Rows[0].Labels)
	}
}

func TestCounterReset(t *testing.T) {
	s, _ := NewStore(filepath.Join(t.TempDir(), "d.json"))
	attrs := map[string]string{"session.id": "a"}
	ts := time.Now().UnixNano()
	s.Add("m", attrs, ts, 100, true)
	s.Add("m", attrs, ts, 20, true) // reset: counts full 20
	if got := s.Summary().Rows[0].Value; got != 120 {
		t.Fatalf("want 120, got %v", got)
	}
}

func TestIngestOTLPJSON(t *testing.T) {
	s, _ := NewStore(filepath.Join(t.TempDir(), "d.json"))
	payload := `{"resourceMetrics":[{"resource":{"attributes":[
		{"key":"service.name","value":{"stringValue":"claude-code"}},
		{"key":"skills_enabled","value":{"stringValue":"true"}}]},
	  "scopeMetrics":[{"metrics":[
		{"name":"claude_code.cost.usage","sum":{"aggregationTemporality":2,"dataPoints":[
		  {"attributes":[{"key":"model","value":{"stringValue":"claude-fable-5"}}],
		   "timeUnixNano":"1754300000000000000","asDouble":1.25}]}},
		{"name":"claude_code.token.usage","sum":{"aggregationTemporality":2,"dataPoints":[
		  {"attributes":[{"key":"type","value":{"stringValue":"cacheRead"}}],
		   "timeUnixNano":"1754300000000000000","asInt":"5000"}]}}]}]}]}`
	if err := s.Ingest([]byte(payload)); err != nil {
		t.Fatal(err)
	}
	sum := s.Summary()
	if len(sum.Metrics) != 2 {
		t.Fatalf("want 2 metrics, got %v", sum.Metrics)
	}
	var cost, tokens float64
	for _, r := range sum.Rows {
		switch r.Metric {
		case "claude_code.cost.usage":
			cost = r.Value
			if r.Labels["skills_enabled"] != "true" || r.Labels["model"] != "claude-fable-5" {
				t.Fatalf("labels: %+v", r.Labels)
			}
		case "claude_code.token.usage":
			tokens = r.Value
		}
	}
	if cost != 1.25 || tokens != 5000 {
		t.Fatalf("cost=%v tokens=%v", cost, tokens)
	}
}
