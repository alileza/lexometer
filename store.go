package main

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// Store aggregates datapoints into hourly buckets keyed by metric name and a
// coarse label set (model, type). It's fed by the transcript watcher; the .jsonl
// files are the source of truth, so nothing is persisted — a restart rebuilds it.
type Store struct {
	mu sync.Mutex

	// last cumulative value per fine stream key (unused by the transcript source,
	// which emits deltas, but kept so Add stays general).
	Streams map[string]float64
	// hour(unix sec) -> metric -> coarse labels -> summed value
	Buckets map[int64]map[string]map[string]float64

	LastReceived     int64
	LogsLastReceived int64

	// recent reconstructed log events (user_prompt, api_request, …), oldest first
	EventLog []Event
}

// NewMemStore returns an in-memory store with no persistence.
func NewMemStore() *Store {
	return &Store{
		Streams: map[string]float64{},
		Buckets: map[int64]map[string]map[string]float64{},
	}
}

// coarse labels kept on buckets; everything else only distinguishes streams.
var coarseKeys = []string{"model", "type", "skills_enabled"}

func coarseKey(attrs map[string]string) string {
	parts := make([]string, 0, len(coarseKeys))
	for _, k := range coarseKeys {
		if v, ok := attrs[k]; ok && v != "" {
			parts = append(parts, k+"="+v)
		}
	}
	return strings.Join(parts, ",")
}

func fineKey(metric string, attrs map[string]string) string {
	keys := make([]string, 0, len(attrs))
	for k := range attrs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.WriteString(metric)
	for _, k := range keys {
		b.WriteByte('|')
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(attrs[k])
	}
	return b.String()
}

// Add ingests one datapoint. cumulative=true means the value is a running total
// for its stream; false means it is already a delta.
func (s *Store) Add(metric string, attrs map[string]string, tsNano int64, value float64, cumulative bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	delta := value
	if cumulative {
		fk := fineKey(metric, attrs)
		last, seen := s.Streams[fk]
		if seen && value >= last {
			delta = value - last
		}
		s.Streams[fk] = value
	}
	if delta == 0 {
		return
	}

	hour := time.Unix(0, tsNano).UTC().Truncate(time.Hour).Unix()
	if s.Buckets[hour] == nil {
		s.Buckets[hour] = map[string]map[string]float64{}
	}
	if s.Buckets[hour][metric] == nil {
		s.Buckets[hour][metric] = map[string]float64{}
	}
	s.Buckets[hour][metric][coarseKey(attrs)] += delta
}

// AddEvent appends a reconstructed log event, ring-buffered at maxEvents.
func (s *Store) AddEvent(e Event) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.EventLog = append(s.EventLog, e)
	if len(s.EventLog) > maxEvents*12/10 {
		s.EventLog = s.EventLog[len(s.EventLog)-maxEvents:]
	}
}

// SetActivity pins the dashboard's "live" / "last data Ns ago" indicators to the
// newest transcript message time (not wall-clock, which would make week-old data
// look live).
func (s *Store) SetActivity(newestSec int64, haveEvents bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.LastReceived = newestSec
	if haveEvents {
		s.LogsLastReceived = newestSec
	}
}

type Row struct {
	T      int64             `json:"t"` // hour, unix seconds
	Metric string            `json:"metric"`
	Labels map[string]string `json:"labels"`
	Value  float64           `json:"value"`
}

type Summary struct {
	Rows             []Row    `json:"rows"`
	Metrics          []string `json:"metrics"`
	LastReceived     int64    `json:"lastReceived"`
	LogsLastReceived int64    `json:"logsLastReceived"`
	Now              int64    `json:"now"`
}

func parseCoarse(key string) map[string]string {
	m := map[string]string{}
	if key == "" {
		return m
	}
	for _, p := range strings.Split(key, ",") {
		if i := strings.IndexByte(p, '='); i > 0 {
			m[p[:i]] = p[i+1:]
		}
	}
	return m
}

func (s *Store) Summary() Summary {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := Summary{Rows: []Row{}, Metrics: []string{}, LastReceived: s.LastReceived,
		LogsLastReceived: s.LogsLastReceived, Now: time.Now().Unix()}
	seen := map[string]bool{}
	for hour, metrics := range s.Buckets {
		for metric, coarse := range metrics {
			seen[metric] = true
			for ck, v := range coarse {
				out.Rows = append(out.Rows, Row{T: hour, Metric: metric, Labels: parseCoarse(ck), Value: v})
			}
		}
	}
	sort.Slice(out.Rows, func(i, j int) bool { return out.Rows[i].T < out.Rows[j].T })
	for m := range seen {
		out.Metrics = append(out.Metrics, m)
	}
	sort.Strings(out.Metrics)
	return out
}

// Event is one reconstructed Claude Code log record (from the transcript), shaped
// like the OTLP events the dashboard's per-prompt views were built for.
type Event struct {
	T       int64             `json:"t"` // unix millis
	Session string            `json:"session"`
	Name    string            `json:"name"`
	Attrs   map[string]string `json:"attrs"`
}

const maxEvents = 5000

// Events returns a copy of the retained log events, oldest first.
func (s *Store) Events() []Event {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Event, len(s.EventLog))
	copy(out, s.EventLog)
	return out
}
