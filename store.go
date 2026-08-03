package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Store aggregates OTLP datapoints into hourly buckets keyed by metric name and
// a coarse label set (model, type, skills_enabled). Cumulative sums are converted
// to deltas per fine-grained stream (all attributes incl. session.id), so restarts
// of Claude Code sessions don't double-count.
type Store struct {
	mu sync.Mutex

	// last cumulative value per fine stream key
	Streams map[string]float64 `json:"streams"`
	// hour(unix sec) -> metric -> coarse labels -> summed value
	Buckets map[int64]map[string]map[string]float64 `json:"buckets"`

	LastReceived int64 `json:"lastReceived"`

	path  string
	dirty bool
}

func NewStore(path string) (*Store, error) {
	s := &Store{
		Streams: map[string]float64{},
		Buckets: map[int64]map[string]map[string]float64{},
		path:    path,
	}
	b, err := os.ReadFile(path)
	if err == nil {
		if err := json.Unmarshal(b, s); err != nil {
			return nil, err
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}
	return s, nil
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
		// new stream, or counter reset (value < last): take the full value
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
	s.LastReceived = time.Now().Unix()
	s.dirty = true
}

type Row struct {
	T      int64             `json:"t"` // hour, unix seconds
	Metric string            `json:"metric"`
	Labels map[string]string `json:"labels"`
	Value  float64           `json:"value"`
}

type Summary struct {
	Rows         []Row   `json:"rows"`
	Metrics      []string `json:"metrics"`
	LastReceived int64   `json:"lastReceived"`
	Now          int64   `json:"now"`
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

	out := Summary{LastReceived: s.LastReceived, Now: time.Now().Unix()}
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

func (s *Store) Save() error {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return nil
	}
	b, err := json.Marshal(s)
	s.dirty = false
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// ---- OTLP/HTTP JSON payload (the subset we need) ----

type otlpAnyValue struct {
	StringValue *string  `json:"stringValue"`
	IntValue    *string  `json:"intValue"`
	DoubleValue *float64 `json:"doubleValue"`
	BoolValue   *bool    `json:"boolValue"`
}

func (v otlpAnyValue) String() string {
	switch {
	case v.StringValue != nil:
		return *v.StringValue
	case v.IntValue != nil:
		return *v.IntValue
	case v.DoubleValue != nil:
		return strconv.FormatFloat(*v.DoubleValue, 'f', -1, 64)
	case v.BoolValue != nil:
		return strconv.FormatBool(*v.BoolValue)
	}
	return ""
}

type otlpKV struct {
	Key   string       `json:"key"`
	Value otlpAnyValue `json:"value"`
}

type otlpDataPoint struct {
	Attributes   []otlpKV `json:"attributes"`
	TimeUnixNano string   `json:"timeUnixNano"`
	AsDouble     *float64 `json:"asDouble"`
	AsInt        *string  `json:"asInt"`
}

func (d otlpDataPoint) value() (float64, bool) {
	if d.AsDouble != nil {
		return *d.AsDouble, true
	}
	if d.AsInt != nil {
		v, err := strconv.ParseFloat(*d.AsInt, 64)
		return v, err == nil
	}
	return 0, false
}

type otlpMetric struct {
	Name string `json:"name"`
	Sum  *struct {
		DataPoints             []otlpDataPoint `json:"dataPoints"`
		AggregationTemporality int             `json:"aggregationTemporality"`
	} `json:"sum"`
	Gauge *struct {
		DataPoints []otlpDataPoint `json:"dataPoints"`
	} `json:"gauge"`
}

type otlpExport struct {
	ResourceMetrics []struct {
		Resource struct {
			Attributes []otlpKV `json:"attributes"`
		} `json:"resource"`
		ScopeMetrics []struct {
			Metrics []otlpMetric `json:"metrics"`
		} `json:"scopeMetrics"`
	} `json:"resourceMetrics"`
}

const aggregationTemporalityCumulative = 2

// Ingest parses an OTLP/HTTP JSON metrics export and adds every datapoint.
func (s *Store) Ingest(body []byte) error {
	var ex otlpExport
	if err := json.Unmarshal(body, &ex); err != nil {
		return err
	}
	for _, rm := range ex.ResourceMetrics {
		res := map[string]string{}
		for _, kv := range rm.Resource.Attributes {
			res[kv.Key] = kv.Value.String()
		}
		for _, sm := range rm.ScopeMetrics {
			for _, m := range sm.Metrics {
				var points []otlpDataPoint
				cumulative := false
				switch {
				case m.Sum != nil:
					points = m.Sum.DataPoints
					cumulative = m.Sum.AggregationTemporality == aggregationTemporalityCumulative
				case m.Gauge != nil:
					points = m.Gauge.DataPoints
				}
				for _, dp := range points {
					v, ok := dp.value()
					if !ok {
						continue
					}
					attrs := map[string]string{}
					for k, val := range res {
						attrs[k] = val
					}
					for _, kv := range dp.Attributes {
						attrs[kv.Key] = kv.Value.String()
					}
					ts, _ := strconv.ParseInt(dp.TimeUnixNano, 10, 64)
					if ts == 0 {
						ts = time.Now().UnixNano()
					}
					s.Add(m.Name, attrs, ts, v, cumulative)
				}
			}
		}
	}
	return nil
}
