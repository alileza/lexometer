package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// a real 1x1 PNG so imageDims parses it
const onePxPNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

func writeSession(t *testing.T) (root, path string) {
	t.Helper()
	root = t.TempDir()
	proj := filepath.Join(root, "-Users-me-Projects-demo")
	if err := os.MkdirAll(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(proj, "sess-abc.jsonl")
	lines := []string{
		`{"type":"user","message":{"role":"user","content":[{"type":"text","text":"here"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"` + onePxPNG + `"}}]},"ts":1700000000}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/a.txt"}}]}}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file contents"}]}}`,
		`{"type":"file-history-snapshot","note":"no message here"}`,
		`{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}`,
	}
	if err := os.WriteFile(path, []byte(strings.Join(lines, "\n")+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// make it look old so Prune doesn't treat it as possibly-open
	old := time.Now().Add(-time.Hour)
	os.Chtimes(path, old, old)
	return root, path
}

func TestScanCountsImages(t *testing.T) {
	root, _ := writeSession(t)
	s := &sessionScanner{root: root, cache: map[string]scanEntry{}}
	list := s.List(time.Now().Unix())
	if len(list) != 1 {
		t.Fatalf("want 1 prunable session, got %d", len(list))
	}
	si := list[0]
	if si.Images != 1 {
		t.Errorf("images = %d, want 1", si.Images)
	}
	if si.Project != "demo" {
		t.Errorf("project = %q, want demo", si.Project)
	}
	if si.EstTokenReads <= 0 {
		t.Errorf("estTokenReads = %v, want > 0 (image re-sent across later turns)", si.EstTokenReads)
	}
}

func TestPrunePreservesStructure(t *testing.T) {
	root, path := writeSession(t)
	s := &sessionScanner{root: root, cache: map[string]scanEntry{}}

	res, err := s.Prune(path)
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK || res.Images != 1 {
		t.Fatalf("prune result: %+v", res)
	}
	if _, err := os.Stat(path + ".bak"); err != nil {
		t.Errorf("backup not created: %v", err)
	}

	out, _ := os.ReadFile(path)
	lines := strings.Split(strings.TrimRight(string(out), "\n"), "\n")

	uses, results := map[string]bool{}, map[string]bool{}
	sawImage := false
	sawStub := false
	for i, ln := range lines {
		var obj map[string]any
		if err := json.Unmarshal([]byte(ln), &obj); err != nil {
			t.Fatalf("line %d no longer valid JSON: %v", i, err)
		}
		msg, _ := obj["message"].(map[string]any)
		if msg == nil {
			continue
		}
		content, _ := msg["content"].([]any)
		for _, raw := range content {
			b, _ := raw.(map[string]any)
			switch b["type"] {
			case "image":
				sawImage = true
			case "tool_use":
				uses[b["id"].(string)] = true
			case "tool_result":
				results[b["tool_use_id"].(string)] = true
			case "text":
				if b["text"] == imgStub {
					sawStub = true
				}
			}
		}
	}
	if sawImage {
		t.Error("image block still present after prune")
	}
	if !sawStub {
		t.Error("image was not replaced with the text stub")
	}
	for id := range results {
		if !uses[id] {
			t.Errorf("tool_result references missing tool_use %q — pairing broken", id)
		}
	}
	// the ts field on the image line must survive re-marshaling
	if !strings.Contains(string(out), `"ts":1700000000`) {
		t.Error("numeric ts field was altered by re-marshaling")
	}
}

func TestRestore(t *testing.T) {
	root, path := writeSession(t)
	s := &sessionScanner{root: root, cache: map[string]scanEntry{}}
	orig, _ := os.ReadFile(path)
	if _, err := s.Prune(path); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Restore(path); err != nil {
		t.Fatal(err)
	}
	back, _ := os.ReadFile(path)
	if string(back) != string(orig) {
		t.Error("restore did not reproduce the original transcript")
	}
}

func TestRefusesOpenSession(t *testing.T) {
	root, path := writeSession(t)
	now := time.Now()
	os.Chtimes(path, now, now) // touched just now
	s := &sessionScanner{root: root, cache: map[string]scanEntry{}}
	if _, err := s.Prune(path); err == nil {
		t.Error("expected Prune to refuse a recently-modified session")
	}
}

func TestRejectsPathOutsideRoot(t *testing.T) {
	root := t.TempDir()
	s := &sessionScanner{root: root, cache: map[string]scanEntry{}}
	if _, err := s.Prune("/etc/passwd"); err == nil {
		t.Error("expected rejection of a path outside the projects root")
	}
	if _, err := s.Prune(filepath.Join(root, "..", "escape.jsonl")); err == nil {
		t.Error("expected rejection of a path escaping the projects root")
	}
}
