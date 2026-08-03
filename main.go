package main

import (
	"compress/gzip"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

//go:embed web/index.html web/dist/app.js
var webFS embed.FS

func main() {
	addr := flag.String("addr", ":4318", "listen address (OTLP receiver + dashboard)")
	dataPath := flag.String("data", defaultDataPath(), "path to the persistence file")
	flag.Parse()

	store, err := NewStore(*dataPath)
	if err != nil {
		log.Fatalf("loading %s: %v", *dataPath, err)
	}

	mux := http.NewServeMux()
	hub := newWSHub()
	summaryJSON := func() []byte {
		b, _ := json.Marshal(store.Summary())
		return b
	}

	// OTLP/HTTP receivers. Metrics are ingested; logs/traces are accepted and
	// discarded so the exporter never sees errors.
	mux.HandleFunc("POST /v1/metrics", func(w http.ResponseWriter, r *http.Request) {
		body, err := readBody(r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		if err := store.Ingest(body); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		okJSON(w)
		go hub.Broadcast(summaryJSON())
	})

	// live updates: pushes the full summary on connect and after every ingest
	mux.HandleFunc("GET /ws", func(w http.ResponseWriter, r *http.Request) {
		hub.Upgrade(w, r, func(conn net.Conn) { hub.Send(conn, summaryJSON()) })
	})
	mux.HandleFunc("POST /v1/logs", func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); okJSON(w) })
	mux.HandleFunc("POST /v1/traces", func(w http.ResponseWriter, r *http.Request) { io.Copy(io.Discard, r.Body); okJSON(w) })

	mux.HandleFunc("GET /api/summary", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(store.Summary())
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { fmt.Fprintln(w, "ok") })

	mux.HandleFunc("GET /dist/app.js", func(w http.ResponseWriter, r *http.Request) {
		b, _ := webFS.ReadFile("web/dist/app.js")
		w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
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

	// periodic persistence + save on shutdown
	go func() {
		for range time.Tick(30 * time.Second) {
			if err := store.Save(); err != nil {
				log.Printf("save: %v", err)
			}
		}
	}()
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	go func() {
		<-sig
		if err := store.Save(); err != nil {
			log.Printf("save on exit: %v", err)
		}
		os.Exit(0)
	}()

	fmt.Printf(`claudewatch — dashboard on http://localhost%[1]s

Point Claude Code at it (add to your shell profile):

  export CLAUDE_CODE_ENABLE_TELEMETRY=1
  export OTEL_METRICS_EXPORTER=otlp
  export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
  export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost%[1]s
  export OTEL_RESOURCE_ATTRIBUTES="skills_enabled=false"   # flip to true when you enable an intervention

Data file: %[2]s
`, *addr, *dataPath)
	log.Fatal(http.ListenAndServe(*addr, mux))
}

func defaultDataPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "claudewatch.json"
	}
	return filepath.Join(home, ".claudewatch", "data.json")
}

func readBody(r *http.Request) ([]byte, error) {
	var rd io.Reader = r.Body
	if r.Header.Get("Content-Encoding") == "gzip" {
		gz, err := gzip.NewReader(r.Body)
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		rd = gz
	}
	return io.ReadAll(io.LimitReader(rd, 32<<20))
}

func okJSON(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte("{}"))
}
