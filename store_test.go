package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestAddDeltasAndSummary(t *testing.T) {
	s := NewMemStore()
	ts := time.Now().UnixNano()
	a := map[string]string{"type": "cacheRead", "model": "opus"}
	s.Add("claude_code.token.usage", a, ts, 100, false)
	s.Add("claude_code.token.usage", a, ts, 40, false) // deltas accumulate -> 140

	sum := s.Summary()
	if len(sum.Rows) != 1 {
		t.Fatalf("want 1 coarse row, got %d: %+v", len(sum.Rows), sum.Rows)
	}
	if sum.Rows[0].Value != 140 {
		t.Fatalf("want 140, got %v", sum.Rows[0].Value)
	}
	if sum.Rows[0].Labels["type"] != "cacheRead" || sum.Rows[0].Labels["model"] != "opus" {
		t.Fatalf("labels: %+v", sum.Rows[0].Labels)
	}
}

// writeTranscript drops a synthetic session file under a project dir.
func writeTranscript(t *testing.T, lines []string) (root, path string) {
	t.Helper()
	root = t.TempDir()
	proj := filepath.Join(root, "-Users-me-demo")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(proj, "s1.jsonl")
	body := ""
	for _, l := range lines {
		body += l + "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root, path
}

const (
	lnPrompt = `{"type":"user","timestamp":"2026-08-03T19:10:50.000Z","sessionId":"s1","message":{"role":"user","content":"hello there"}}`
	lnAsst   = `{"type":"assistant","timestamp":"2026-08-03T19:10:54.000Z","sessionId":"s1","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{}}],"usage":{"input_tokens":100,"output_tokens":20,"cache_read_input_tokens":5000,"cache_creation_input_tokens":200}}}`
	lnResult = `{"type":"user","timestamp":"2026-08-03T19:10:55.000Z","sessionId":"s1","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu1","content":"file data"}]}}`
)

func tokenValue(s *Store, typ string) float64 {
	for _, r := range s.Summary().Rows {
		if r.Metric == tokenMetric && r.Labels["type"] == typ {
			return r.Value
		}
	}
	return -1
}

func metricTotal(s *Store, metric string) float64 {
	var total float64
	for _, r := range s.Summary().Rows {
		if r.Metric == metric {
			total += r.Value
		}
	}
	return total
}

func TestWatcherParsesUsageAndEvents(t *testing.T) {
	root, _ := writeTranscript(t, []string{lnPrompt, lnAsst, lnResult})
	s := NewMemStore()
	w := NewWatcher(root, s)
	if !w.Scan() {
		t.Fatal("Scan reported no change on a fresh transcript")
	}

	if got := tokenValue(s, "cacheRead"); got != 5000 {
		t.Errorf("cacheRead = %v, want 5000", got)
	}
	if got := tokenValue(s, "cacheCreation"); got != 200 {
		t.Errorf("cacheCreation = %v, want 200", got)
	}
	if got := tokenValue(s, "input"); got != 100 {
		t.Errorf("input = %v, want 100", got)
	}
	if got := tokenValue(s, "output"); got != 20 {
		t.Errorf("output = %v, want 20", got)
	}
	if got := metricTotal(s, sessionMetric); got != 1 {
		t.Errorf("session.count = %v, want 1", got)
	}
	if got := metricTotal(s, activeMetric); got <= 0 {
		t.Errorf("active_time = %v, want > 0 (gaps under the cap)", got)
	}

	// model label carried through
	var sawModel bool
	for _, r := range s.Summary().Rows {
		if r.Metric == tokenMetric && r.Labels["model"] == "claude-opus-4-8" {
			sawModel = true
		}
	}
	if !sawModel {
		t.Error("model label missing on token rows")
	}

	// reconstructed events for the Prompts tab
	var prompt, apiReq, toolRes int
	for _, e := range s.Events() {
		switch {
		case e.Name == "user_prompt" && e.Attrs["prompt"] == "hello there":
			prompt++
		case e.Name == "api_request" && e.Attrs["cache_read_tokens"] == "5000":
			apiReq++
		case e.Name == "tool_result" && e.Attrs["tool_name"] == "Read":
			toolRes++
		}
	}
	if prompt != 1 || apiReq != 1 || toolRes != 1 {
		t.Errorf("events: prompt=%d api_request=%d tool_result=%d, want 1/1/1", prompt, apiReq, toolRes)
	}
}

func TestWatcherTailsIncrementally(t *testing.T) {
	root, path := writeTranscript(t, []string{lnPrompt, lnAsst})
	s := NewMemStore()
	w := NewWatcher(root, s)
	w.Scan()
	firstOutput := tokenValue(s, "output")

	// append a second assistant turn
	extra := `{"type":"assistant","timestamp":"2026-08-03T19:11:20.000Z","sessionId":"s1","message":{"role":"assistant","model":"claude-opus-4-8","content":[{"type":"text","text":"ok"}],"usage":{"input_tokens":0,"output_tokens":30,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}`
	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(extra + "\n")
	f.Close()

	if !w.Scan() {
		t.Fatal("Scan reported no change after append")
	}
	if got := tokenValue(s, "output"); got != firstOutput+30 {
		t.Errorf("output after append = %v, want %v", got, firstOutput+30)
	}
	// session counted exactly once despite the second scan
	if got := metricTotal(s, sessionMetric); got != 1 {
		t.Errorf("session.count = %v, want 1 (not re-counted on tail)", got)
	}
}
