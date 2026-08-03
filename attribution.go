package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

// Attribution answers "which files and tools are eating the context" by reading
// the Claude Code transcript files (~/.claude/projects/*/*.jsonl) — a different,
// after-the-fact data source than the live OTLP telemetry. Token counts are
// ESTIMATED from result byte length (÷4), good enough to rank the culprits.

type AttrItem struct {
	Key    string  `json:"key"`
	Tokens float64 `json:"tokens"`
	Count  int     `json:"count"`
}

type Attribution struct {
	Files     []AttrItem `json:"files"`
	Tools     []AttrItem `json:"tools"`
	Scanned   int        `json:"scanned"`   // transcripts read
	Estimated bool       `json:"estimated"` // always true; tokens are byte/4 estimates
	Note      string     `json:"note"`
}

type aggV struct {
	Tokens float64
	Count  int
}

type cachedTranscript struct {
	mod   int64
	size  int64
	files map[string]aggV
	tools map[string]aggV
}

type attrCache struct {
	mu       sync.Mutex
	root     string
	perFile  map[string]cachedTranscript
}

func newAttrCache() *attrCache {
	home, _ := os.UserHomeDir()
	return &attrCache{
		root:    filepath.Join(home, ".claude", "projects"),
		perFile: map[string]cachedTranscript{},
	}
}

const tokensPerByte = 0.25 // ~4 bytes/token

// transcriptLine is the minimal shape we parse; message.content is kept raw so
// string-valued content (plain user text) doesn't break array decoding.
type transcriptLine struct {
	Message struct {
		Content json.RawMessage `json:"content"`
	} `json:"message"`
}

type contentItem struct {
	Type      string          `json:"type"`
	Name      string          `json:"name"`
	ID        string          `json:"id"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	Input     struct {
		FilePath string `json:"file_path"`
	} `json:"input"`
}

func parseTranscript(path string) (files, tools map[string]aggV) {
	files, tools = map[string]aggV{}, map[string]aggV{}
	f, err := os.Open(path)
	if err != nil {
		return
	}
	defer f.Close()

	type use struct{ name, fp string }
	uses := map[string]use{}
	r := bufio.NewReader(f)
	for {
		line, err := r.ReadBytes('\n')
		if len(line) > 0 && line[0] == '{' {
			var tl transcriptLine
			if json.Unmarshal(line, &tl) == nil && len(tl.Message.Content) > 0 && tl.Message.Content[0] == '[' {
				var items []contentItem
				if json.Unmarshal(tl.Message.Content, &items) == nil {
					for _, c := range items {
						switch c.Type {
						case "tool_use":
							uses[c.ID] = use{c.Name, c.Input.FilePath}
						case "tool_result":
							u := uses[c.ToolUseID]
							if u.name == "" {
								u.name = "unknown"
							}
							toks := float64(len(c.Content)) * tokensPerByte
							tv := tools[u.name]
							tv.Tokens += toks
							tv.Count++
							tools[u.name] = tv
							if u.fp != "" {
								fv := files[u.fp]
								fv.Tokens += toks
								fv.Count++
								files[u.fp] = fv
							}
						}
					}
				}
			}
		}
		if err != nil {
			break
		}
	}
	return
}

// Compute scans all transcripts (using the per-file cache for unchanged ones)
// and returns the top files and tools by estimated tokens.
func (a *attrCache) Compute(topN int) Attribution {
	a.mu.Lock()
	defer a.mu.Unlock()

	files := map[string]aggV{}
	tools := map[string]aggV{}
	scanned := 0

	matches, _ := filepath.Glob(filepath.Join(a.root, "*", "*.jsonl"))
	for _, path := range matches {
		fi, err := os.Stat(path)
		if err != nil {
			continue
		}
		c, ok := a.perFile[path]
		if !ok || c.mod != fi.ModTime().Unix() || c.size != fi.Size() {
			pf, pt := parseTranscript(path)
			c = cachedTranscript{mod: fi.ModTime().Unix(), size: fi.Size(), files: pf, tools: pt}
			a.perFile[path] = c
		}
		scanned++
		for k, v := range c.files {
			fv := files[k]
			fv.Tokens += v.Tokens
			fv.Count += v.Count
			files[k] = fv
		}
		for k, v := range c.tools {
			tv := tools[k]
			tv.Tokens += v.Tokens
			tv.Count += v.Count
			tools[k] = tv
		}
	}

	return Attribution{
		Files:     topItems(files, topN, true),
		Tools:     topItems(tools, 0, false),
		Scanned:   scanned,
		Estimated: true,
		Note:      "Estimated from transcript result bytes (÷4). Separate from live telemetry; covers all projects' transcripts.",
	}
}

func topItems(m map[string]aggV, n int, shorten bool) []AttrItem {
	out := make([]AttrItem, 0, len(m))
	for k, v := range m {
		key := k
		if shorten {
			key = shortenPath(k)
		}
		out = append(out, AttrItem{Key: key, Tokens: v.Tokens, Count: v.Count})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Tokens > out[j].Tokens })
	if n > 0 && len(out) > n {
		out = out[:n]
	}
	return out
}

// shortenPath keeps the last two path segments so the table stays readable.
func shortenPath(p string) string {
	parts := strings.Split(p, "/")
	if len(parts) <= 2 {
		return p
	}
	return ".../" + strings.Join(parts[len(parts)-2:], "/")
}
