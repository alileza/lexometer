package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// The transcript watcher is lexometer's data source: it reads Claude Code's own
// session files (~/.claude/projects/*/*.jsonl) and derives every metric the
// dashboard shows. No OTLP, no env setup — the files already contain the real
// per-request token accounting (message.usage), the model, timestamps, and the
// full prompt/tool content.
//
// On start it reads every transcript once; after that it *tails* each file,
// parsing only newly appended lines, so ongoing cost is tiny. Because the files
// are the source of truth, nothing is persisted — a restart rebuilds from disk.

const (
	tokenMetric   = "claude_code.token.usage"
	sessionMetric = "claude_code.session.count"
	activeMetric  = "claude_code.active_time.total"
	// gap between consecutive messages counted as "active" work; larger gaps are
	// idle time (stepped away) and don't count.
	activeGapCap = 300 * time.Second
)

type fileState struct {
	size    int64
	offset  int64 // byte offset up to the last complete line consumed
	lastTS  int64 // unix nano of the previous message in this file (for active-time gaps)
	counted bool  // session.count already emitted for this file
}

type Watcher struct {
	root  string
	store *Store

	mu        sync.Mutex
	files     map[string]*fileState
	toolNames map[string]string // tool_use id -> tool name, to label tool_result events
	newest    int64             // newest message time seen, unix seconds
	haveEv    bool
}

func NewWatcher(root string, store *Store) *Watcher {
	return &Watcher{
		root:      root,
		store:     store,
		files:     map[string]*fileState{},
		toolNames: map[string]string{},
	}
}

// ---- transcript line shapes (only the fields we use) ----

type tUsage struct {
	Input       float64 `json:"input_tokens"`
	Output      float64 `json:"output_tokens"`
	CacheRead   float64 `json:"cache_read_input_tokens"`
	CacheCreate float64 `json:"cache_creation_input_tokens"`
}

type tMessage struct {
	Role    string          `json:"role"`
	Model   string          `json:"model"`
	Content json.RawMessage `json:"content"`
	Usage   *tUsage         `json:"usage"`
}

type tLine struct {
	Type        string   `json:"type"`
	Timestamp   string   `json:"timestamp"`
	SessionID   string   `json:"sessionId"`
	IsSidechain bool     `json:"isSidechain"`
	IsMeta      bool     `json:"isMeta"`
	Message     tMessage `json:"message"`
}

type tBlock struct {
	Type      string `json:"type"`
	Text      string `json:"text"`
	ID        string `json:"id"`
	Name      string `json:"name"`
	ToolUseID string `json:"tool_use_id"`
}

// Scan tails every transcript and feeds new lines into the store. Returns true if
// anything new was ingested (so the caller can push a fresh summary to clients).
func (w *Watcher) Scan() bool {
	matches, _ := filepath.Glob(filepath.Join(w.root, "*", "*.jsonl"))
	changed := false
	for _, path := range matches {
		fi, err := os.Stat(path)
		if err != nil {
			continue
		}
		w.mu.Lock()
		fs := w.files[path]
		if fs == nil {
			fs = &fileState{}
			w.files[path] = fs
		}
		w.mu.Unlock()

		if fi.Size() == fs.size {
			continue // untouched since last tick
		}
		if fi.Size() < fs.size { // truncated/rotated — start over
			fs.offset, fs.size, fs.lastTS, fs.counted = 0, 0, 0, false
		}
		if w.readFrom(path, fs) {
			changed = true
		}
		fs.size = fi.Size()
	}
	if changed && w.newest > 0 {
		w.store.SetActivity(w.newest, w.haveEv)
	}
	return changed
}

// readFrom reads a file from fs.offset, processing only complete (newline-
// terminated) lines and advancing the offset past them.
func (w *Watcher) readFrom(path string, fs *fileState) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	if _, err := f.Seek(fs.offset, 0); err != nil {
		return false
	}
	r := bufio.NewReaderSize(f, 1<<20)
	consumed := int64(0)
	any := false
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 && line[len(line)-1] == '\n' {
			consumed += int64(len(line))
			if w.process(bytes.TrimRight(line, "\n"), fs) {
				any = true
			}
		}
		if err != nil { // EOF or partial trailing line — leave it for next tick
			break
		}
	}
	fs.offset += consumed
	return any
}

func (w *Watcher) process(line []byte, fs *fileState) bool {
	if len(line) == 0 || line[0] != '{' {
		return false
	}
	var tl tLine
	if json.Unmarshal(line, &tl) != nil {
		return false
	}
	ts := parseTS(tl.Timestamp)
	if ts == 0 {
		return false
	}
	sec := ts / 1e9
	if sec > w.newest {
		w.newest = sec
	}

	// one session.count per file, at its first dated line
	if !fs.counted {
		fs.counted = true
		w.store.Add(sessionMetric, map[string]string{}, ts, 1, false)
	}
	// active time = summed gaps between consecutive messages, capped
	if fs.lastTS > 0 {
		if gap := ts - fs.lastTS; gap > 0 && gap <= int64(activeGapCap) {
			w.store.Add(activeMetric, map[string]string{}, ts, float64(gap)/1e9, false)
		}
	}
	fs.lastTS = ts

	switch tl.Type {
	case "assistant":
		w.assistant(&tl, ts)
		return true
	case "user":
		if !tl.IsSidechain && !tl.IsMeta {
			w.user(&tl, ts)
		}
		return true
	}
	return false
}

func (w *Watcher) assistant(tl *tLine, ts int64) {
	u := tl.Message.Usage
	if u == nil {
		return
	}
	model := tl.Message.Model
	// token buckets, one per type — matches the dashboard's TOKEN_TYPES
	for _, p := range []struct {
		typ string
		val float64
	}{
		{"input", u.Input}, {"output", u.Output},
		{"cacheRead", u.CacheRead}, {"cacheCreation", u.CacheCreate},
	} {
		if p.val != 0 {
			w.store.Add(tokenMetric, map[string]string{"type": p.typ, "model": model}, ts, p.val, false)
		}
	}
	// track tool_use names so the following tool_result events can be labelled
	for _, b := range contentBlocks(tl.Message.Content) {
		if b.Type == "tool_use" && b.ID != "" {
			w.mu.Lock()
			w.toolNames[b.ID] = b.Name
			w.mu.Unlock()
		}
	}
	// api_request event drives the per-prompt breakdown in the Prompts tab
	w.haveEv = true
	w.store.AddEvent(Event{
		T: ts / 1e6, Session: tl.SessionID, Name: "api_request",
		Attrs: map[string]string{
			"input_tokens":          ftoa(u.Input),
			"output_tokens":         ftoa(u.Output),
			"cache_read_tokens":     ftoa(u.CacheRead),
			"cache_creation_tokens": ftoa(u.CacheCreate),
			"model":                 model,
		},
	})
}

func (w *Watcher) user(tl *tLine, ts int64) {
	content := tl.Message.Content
	if len(content) == 0 {
		return
	}
	// A plain typed prompt is either a JSON string or an array of text blocks.
	// An array carrying tool_result blocks is tool output, not a prompt.
	if content[0] == '"' {
		var s string
		if json.Unmarshal(content, &s) == nil && s != "" {
			w.emitPrompt(tl.SessionID, ts, s)
		}
		return
	}
	blocks := contentBlocks(content)
	text, isToolResult := "", false
	for _, b := range blocks {
		switch b.Type {
		case "tool_result":
			isToolResult = true
			w.mu.Lock()
			name := w.toolNames[b.ToolUseID]
			w.mu.Unlock()
			if name == "" {
				name = "tool"
			}
			w.haveEv = true
			w.store.AddEvent(Event{
				T: ts / 1e6, Session: tl.SessionID, Name: "tool_result",
				Attrs: map[string]string{"tool_name": name},
			})
		case "text":
			if text != "" {
				text += " "
			}
			text += b.Text
		}
	}
	if !isToolResult && text != "" {
		w.emitPrompt(tl.SessionID, ts, text)
	}
}

func (w *Watcher) emitPrompt(session string, ts int64, text string) {
	if len(text) > 300 {
		text = text[:300]
	}
	w.haveEv = true
	w.store.AddEvent(Event{
		T: ts / 1e6, Session: session, Name: "user_prompt",
		Attrs: map[string]string{"prompt": text, "prompt_length": strconv.Itoa(len(text))},
	})
}

func contentBlocks(raw json.RawMessage) []tBlock {
	if len(raw) == 0 || raw[0] != '[' {
		return nil
	}
	var bs []tBlock
	json.Unmarshal(raw, &bs)
	return bs
}

func parseTS(s string) int64 {
	if s == "" {
		return 0
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return 0
	}
	return t.UnixNano()
}

func ftoa(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }
