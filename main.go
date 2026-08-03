package main

import (
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

//go:embed web/index.html web/dist
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":4318", "listen address (dashboard)")
	projects := flag.String("projects", defaultProjectsPath(), "Claude Code projects directory to watch")
	poll := flag.Duration("poll", 2*time.Second, "how often to re-scan transcripts for new activity")
	flag.Parse()

	// Data source: Claude Code's own transcript files. No OTLP, no config — the
	// .jsonl sessions already carry the real per-request token usage.
	store := NewMemStore()
	watcher := NewWatcher(*projects, store)
	watcher.Scan() // full read of existing history before serving

	mux := http.NewServeMux()
	hub := newWSHub()
	summaryJSON := func() []byte {
		b, _ := json.Marshal(store.Summary())
		return b
	}

	// live updates: pushes the full summary on connect and whenever a transcript changes
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		hub.Upgrade(w, r, func(conn net.Conn) { hub.Send(conn, summaryJSON()) })
	})

	mux.HandleFunc("GET /api/summary", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(store.Summary())
	})
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(store.Events())
	})
	attr := newAttrCache()
	mux.HandleFunc("GET /api/attribution", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(attr.Compute(20))
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintln(w, "ok") })

	mux.HandleFunc("GET /dist/", func(w http.ResponseWriter, r *http.Request) {
		b, err := webFS.ReadFile("web" + r.URL.Path)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		switch filepath.Ext(r.URL.Path) {
		case ".js":
			w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
		case ".css":
			w.Header().Set("Content-Type", "text/css; charset=utf-8")
		}
		w.Write(b)
	})
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		b, _ := webFS.ReadFile("web/index.html")
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Write(b)
	})

	// tail transcripts on an interval; push a fresh summary to clients on change
	go func() {
		for range time.Tick(*poll) {
			if watcher.Scan() {
				hub.Broadcast(summaryJSON())
			}
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() { <-sig; os.Exit(0) }()

	fmt.Printf(`lexometer — dashboard on http://localhost%[1]s

Reading Claude Code sessions from %[2]s
No setup, no telemetry exporter — metrics come straight from the transcript files.
`, *addr, *projects)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func defaultProjectsPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".claude", "projects")
	}
	return filepath.Join(home, ".claude", "projects")
}
