package main

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// Prune finds and removes bloat from Claude Code transcript files so a *resumed*
// session (--continue / --resume) replays less context. Today it targets pasted
// images: each screenshot re-costs ~1.5k tokens on every turn after it appears,
// and is almost never needed again. Images live in a `user` message content array,
// so the image block is swapped for a small "[image pruned]" text stub — no
// tool_use/tool_result pairing is touched, and every other line is written back
// byte-for-byte. It only helps on resume; it does not refund tokens already spent.

const imgStub = "[image pruned to save context]"
const openWindowSec = 120 // a session touched this recently may be live in Claude Code

// SessionInfo describes one transcript and what pruning it would recover.
type SessionInfo struct {
	Path          string  `json:"path"`
	Project       string  `json:"project"`
	ID            string  `json:"id"`
	SizeBytes     int64   `json:"sizeBytes"`
	Images        int     `json:"images"`
	EstTokenReads float64 `json:"estTokenReads"` // image tokens × turns re-sent after them
	Turns         int     `json:"turns"`
	ModifiedUnix  int64   `json:"modifiedUnix"`
	Open          bool    `json:"open"`         // modified within openWindowSec — refuse to prune
	HasBackup     bool    `json:"hasBackup"`    // a .bak from a previous prune exists (restorable)
}

// sessionScanner caches per-file scan results keyed by (mod,size) so the 50+ MB
// mega-sessions aren't re-read on every dashboard poll.
type sessionScanner struct {
	mu    sync.Mutex
	root  string
	cache map[string]scanEntry
}

type scanEntry struct {
	mod, size int64
	images    int
	tokReads  float64
	turns     int
}

func newSessionScanner() *sessionScanner {
	home, _ := os.UserHomeDir()
	return &sessionScanner{
		root:  filepath.Join(home, ".claude", "projects"),
		cache: map[string]scanEntry{},
	}
}

// pruneContentBlock is a transcript content item, enough to spot images.
type pruneContentBlock struct {
	Type   string `json:"type"`
	Source struct {
		MediaType string `json:"media_type"`
		Data      string `json:"data"`
	} `json:"source"`
}

type pruneLine struct {
	Message struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

// scanFile counts images, the tokens they cost, and how many turns re-send them.
func scanFile(path string) (images int, tokReads float64, turns int) {
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	// First pass: record, per line, whether it carries a message role (a "turn"
	// that re-sends context) and the image token cost on that line.
	type lineInfo struct {
		isTurn  bool
		imgToks []int
	}
	var infos []lineInfo
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)
	for sc.Scan() {
		line := sc.Bytes()
		li := lineInfo{}
		if len(line) > 0 && line[0] == '{' {
			var pl pruneLine
			if json.Unmarshal(line, &pl) == nil {
				if pl.Message.Role != "" {
					li.isTurn = true
				}
				if len(pl.Message.Content) > 0 && pl.Message.Content[0] == '[' {
					var blocks []pruneContentBlock
					if json.Unmarshal(pl.Message.Content, &blocks) == nil {
						for _, b := range blocks {
							if b.Type == "image" && b.Source.Data != "" {
								li.imgToks = append(li.imgToks, imageTokens(b.Source.MediaType, b.Source.Data))
							}
						}
					}
				}
			}
		}
		infos = append(infos, li)
	}

	// Suffix count of turns after each line = how many times its content re-sends.
	turnsAfter := make([]int, len(infos))
	running := 0
	for i := len(infos) - 1; i >= 0; i-- {
		turnsAfter[i] = running
		if infos[i].isTurn {
			running++
			turns++
		}
	}
	for i, li := range infos {
		for _, t := range li.imgToks {
			images++
			reps := turnsAfter[i]
			if reps < 1 {
				reps = 1
			}
			tokReads += float64(t * reps)
		}
	}
	return
}

func (s *sessionScanner) scan(path string, mod, size int64) scanEntry {
	s.mu.Lock()
	defer s.mu.Unlock()
	if e, ok := s.cache[path]; ok && e.mod == mod && e.size == size {
		return e
	}
	img, tok, turns := scanFile(path)
	e := scanEntry{mod: mod, size: size, images: img, tokReads: tok, turns: turns}
	s.cache[path] = e
	return e
}

// List returns every transcript with prunable bloat, worst first.
func (s *sessionScanner) List(nowUnix int64) []SessionInfo {
	matches, _ := filepath.Glob(filepath.Join(s.root, "*", "*.jsonl"))
	out := []SessionInfo{}
	for _, path := range matches {
		fi, err := os.Stat(path)
		if err != nil {
			continue
		}
		e := s.scan(path, fi.ModTime().Unix(), fi.Size())
		if e.images == 0 {
			continue
		}
		_, bakErr := os.Stat(path + ".bak")
		out = append(out, SessionInfo{
			Path:          path,
			Project:       prettyProject(filepath.Base(filepath.Dir(path))),
			ID:            strings.TrimSuffix(filepath.Base(path), ".jsonl"),
			SizeBytes:     fi.Size(),
			Images:        e.images,
			EstTokenReads: e.tokReads,
			Turns:         e.turns,
			ModifiedUnix:  fi.ModTime().Unix(),
			Open:          nowUnix-fi.ModTime().Unix() < openWindowSec,
			HasBackup:     bakErr == nil,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].EstTokenReads > out[j].EstTokenReads })
	return out
}

// prettyProject turns "-Users-alileza-Projects-skills" into "skills" for display.
func prettyProject(dir string) string {
	parts := strings.Split(strings.Trim(dir, "-"), "-")
	if len(parts) == 0 {
		return dir
	}
	return parts[len(parts)-1]
}

// validSessionPath guards the mutating endpoints: the target must be a .jsonl file
// under ~/.claude/projects, so a crafted request can't rewrite an arbitrary file.
func (s *sessionScanner) validSessionPath(path string) (string, error) {
	clean := filepath.Clean(path)
	if filepath.Ext(clean) != ".jsonl" {
		return "", fmt.Errorf("not a .jsonl transcript")
	}
	rel, err := filepath.Rel(s.root, clean)
	if err != nil || strings.HasPrefix(rel, "..") {
		return "", fmt.Errorf("path is outside the Claude projects directory")
	}
	return clean, nil
}

// PruneResult reports what a prune (or restore) did.
type PruneResult struct {
	OK          bool   `json:"ok"`
	Images      int    `json:"images"`
	BytesBefore int64  `json:"bytesBefore"`
	BytesAfter  int64  `json:"bytesAfter"`
	Backup      string `json:"backup"`
	Message     string `json:"message"`
}

// Prune stubs every image in the transcript, backing the original up to <path>.bak
// first. Refuses a session touched within openWindowSec (likely open in Claude
// Code). The pruned transcript takes effect the next time that session is resumed.
func (s *sessionScanner) Prune(path string) (PruneResult, error) {
	clean, err := s.validSessionPath(path)
	if err != nil {
		return PruneResult{}, err
	}
	fi, err := os.Stat(clean)
	if err != nil {
		return PruneResult{}, err
	}
	if time.Now().Unix()-fi.ModTime().Unix() < openWindowSec {
		return PruneResult{}, fmt.Errorf("session was modified in the last %ds — it may be open in Claude Code; close it and try again", openWindowSec)
	}

	in, err := os.ReadFile(clean)
	if err != nil {
		return PruneResult{}, err
	}
	var out bytes.Buffer
	out.Grow(len(in))
	images := 0
	sc := bufio.NewScanner(bytes.NewReader(in))
	sc.Buffer(make([]byte, 0, 1024*1024), 64*1024*1024)
	first := true
	for sc.Scan() {
		line := sc.Bytes()
		if !first {
			out.WriteByte('\n')
		}
		first = false
		// Only rewrite lines that actually carry an image; everything else is
		// copied verbatim so we never perturb the transcript's other data.
		if bytes.Contains(line, []byte(`"type":"image"`)) {
			n, rewritten := stubImages(line)
			if n > 0 {
				images += n
				out.Write(rewritten)
				continue
			}
		}
		out.Write(line)
	}
	if err := sc.Err(); err != nil {
		return PruneResult{}, err
	}
	if len(in) > 0 && in[len(in)-1] == '\n' {
		out.WriteByte('\n')
	}

	if images == 0 {
		return PruneResult{OK: false, Message: "no images found to prune"}, nil
	}

	backup := clean + ".bak"
	if _, err := os.Stat(backup); err == nil {
		backup = fmt.Sprintf("%s.bak.%d", clean, fi.ModTime().Unix()) // keep the earlier .bak intact
	}
	if err := os.Rename(clean, backup); err != nil {
		return PruneResult{}, fmt.Errorf("backup failed: %w", err)
	}
	if err := os.WriteFile(clean, out.Bytes(), fi.Mode().Perm()); err != nil {
		os.Rename(backup, clean) // best-effort restore on write failure
		return PruneResult{}, fmt.Errorf("write failed (original restored): %w", err)
	}

	return PruneResult{
		OK: true, Images: images,
		BytesBefore: fi.Size(), BytesAfter: int64(out.Len()),
		Backup:  backup,
		Message: fmt.Sprintf("Pruned %d image(s). Original backed up to %s. Takes effect next time you resume this session.", images, filepath.Base(backup)),
	}, nil
}

// Restore moves a .bak produced by Prune back over the transcript.
func (s *sessionScanner) Restore(path string) (PruneResult, error) {
	clean, err := s.validSessionPath(path)
	if err != nil {
		return PruneResult{}, err
	}
	backup := clean + ".bak"
	if _, err := os.Stat(backup); err != nil {
		return PruneResult{}, fmt.Errorf("no backup (%s) to restore", filepath.Base(backup))
	}
	if err := os.Rename(backup, clean); err != nil {
		return PruneResult{}, err
	}
	return PruneResult{OK: true, Message: "Restored original transcript from backup."}, nil
}

// stubImages replaces each image block in a single JSON line with a text stub,
// preserving all other fields and numeric formatting (json.Number). Returns the
// number of images stubbed and the rewritten line.
func stubImages(line []byte) (int, []byte) {
	dec := json.NewDecoder(bytes.NewReader(line))
	dec.UseNumber()
	var obj map[string]any
	if err := dec.Decode(&obj); err != nil {
		return 0, nil
	}
	msg, ok := obj["message"].(map[string]any)
	if !ok {
		return 0, nil
	}
	content, ok := msg["content"].([]any)
	if !ok {
		return 0, nil
	}
	n := 0
	for i, raw := range content {
		block, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if block["type"] == "image" {
			content[i] = map[string]any{"type": "text", "text": imgStub}
			n++
		}
	}
	if n == 0 {
		return 0, nil
	}
	msg["content"] = content
	b, err := json.Marshal(obj)
	if err != nil {
		return 0, nil
	}
	return n, b
}

// imageTokens approximates Anthropic's image token cost (~width*height/750, with
// the long edge capped at 1568 as the API downscales). Falls back to a typical
// screenshot cost when dimensions can't be read.
func imageTokens(mediaType, dataB64 string) int {
	w, h, ok := imageDims(mediaType, dataB64)
	if !ok {
		return 1400
	}
	fw, fh := float64(w), float64(h)
	long := w
	if h > long {
		long = h
	}
	if long > 1568 {
		scale := 1568.0 / float64(long)
		fw *= scale
		fh *= scale
	}
	t := int(fw * fh / 750)
	if t < 1 {
		t = 1
	}
	return t
}

func imageDims(mediaType, b64 string) (int, int, bool) {
	n := len(b64)
	if n > 8192 {
		n = 8192
	}
	n -= n % 4
	if n <= 0 {
		return 0, 0, false
	}
	raw, err := base64.StdEncoding.DecodeString(b64[:n])
	if err != nil || len(raw) < 24 {
		return 0, 0, false
	}
	if strings.Contains(mediaType, "png") && bytes.HasPrefix(raw, []byte("\x89PNG\r\n\x1a\n")) {
		w := binary.BigEndian.Uint32(raw[16:20])
		h := binary.BigEndian.Uint32(raw[20:24])
		return int(w), int(h), true
	}
	if strings.Contains(mediaType, "jpeg") || strings.Contains(mediaType, "jpg") {
		for i := 2; i < len(raw)-9; {
			if raw[i] != 0xFF {
				i++
				continue
			}
			m := raw[i+1]
			if m == 0xC0 || m == 0xC1 || m == 0xC2 || m == 0xC3 {
				h := binary.BigEndian.Uint16(raw[i+5 : i+7])
				w := binary.BigEndian.Uint16(raw[i+7 : i+9])
				return int(w), int(h), true
			}
			seg := binary.BigEndian.Uint16(raw[i+2 : i+4])
			i += 2 + int(seg)
		}
	}
	return 0, 0, false
}
