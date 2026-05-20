/**
 * HS-8471 — minimal OTLP/Protobuf schema for the three signals
 * Hot Sheet's receiver decodes. The full OTLP spec ships dozens of
 * message types; we only need the subset that Claude Code's bundled
 * exporter actually sends to `POST /v1/{metrics,logs,traces}` and
 * that our writers in `src/db/otelWriters.ts` consume.
 *
 * Schema sourced from the open-telemetry/opentelemetry-proto repo
 * (Apache-2.0). Field numbers + wire types verified against the
 * `@opentelemetry/otlp-transformer` package's own serializer
 * source (which encodes the same wire format), so this schema is
 * round-trip compatible with anything Claude Code's exporter sends.
 *
 * **Compatibility scope.** We decode every field the writers care
 * about (timestamps, attributes, values, names, IDs). Fields the
 * writers ignore (exemplars, severity-number variants on logs,
 * etc.) are present in the schema but never read — protobufjs
 * tolerates extra fields silently. New fields added in future OTLP
 * versions will be unknown and skipped by the wire reader; no
 * breakage from forward-compat OTLP changes.
 *
 * Why inline as a string instead of a `.proto` file alongside? The
 * deploy artifact (`dist/cli.js`) bundles all source via tsup; a
 * standalone `.proto` file would have to be copied + read at
 * runtime. Inline-string keeps everything in the bundle, one
 * import.
 *
 * If a future OTLP wire-format change adds a NEW message type we
 * care about, transcribe the new fields here.
 */
export const OTLP_PROTO_DEFINITION = `
syntax = "proto3";

package opentelemetry.proto;

// =====================================================================
// Common / shared messages (opentelemetry/proto/common/v1/common.proto)
// =====================================================================

message AnyValue {
  oneof value {
    string string_value  = 1;
    bool   bool_value    = 2;
    int64  int_value     = 3;
    double double_value  = 4;
    ArrayValue    array_value  = 5;
    KeyValueList  kvlist_value = 6;
    bytes  bytes_value   = 7;
  }
}

message ArrayValue {
  repeated AnyValue values = 1;
}

message KeyValueList {
  repeated KeyValue values = 1;
}

message KeyValue {
  string key = 1;
  AnyValue value = 2;
}

message InstrumentationScope {
  string name = 1;
  string version = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

// (opentelemetry/proto/resource/v1/resource.proto)
message Resource {
  repeated KeyValue attributes = 1;
  uint32 dropped_attributes_count = 2;
}

// =====================================================================
// Metrics signal (opentelemetry/proto/metrics/v1/metrics.proto)
// =====================================================================

message ExportMetricsServiceRequest {
  repeated ResourceMetrics resource_metrics = 1;
}

message ResourceMetrics {
  Resource resource = 1;
  repeated ScopeMetrics scope_metrics = 2;
  string schema_url = 3;
}

message ScopeMetrics {
  InstrumentationScope scope = 1;
  repeated Metric metrics = 2;
  string schema_url = 3;
}

message Metric {
  string name = 1;
  string description = 2;
  string unit = 3;
  oneof data {
    Gauge      gauge     = 5;
    Sum        sum       = 7;
    Histogram  histogram = 9;
    ExponentialHistogram exponential_histogram = 10;
    Summary    summary   = 11;
  }
  repeated KeyValue metadata = 12;
}

message Gauge {
  repeated NumberDataPoint data_points = 1;
}

message Sum {
  repeated NumberDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
  bool is_monotonic = 3;
}

message Histogram {
  repeated HistogramDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
}

message ExponentialHistogram {
  repeated ExponentialHistogramDataPoint data_points = 1;
  AggregationTemporality aggregation_temporality = 2;
}

message Summary {
  repeated SummaryDataPoint data_points = 1;
}

enum AggregationTemporality {
  AGGREGATION_TEMPORALITY_UNSPECIFIED = 0;
  AGGREGATION_TEMPORALITY_DELTA = 1;
  AGGREGATION_TEMPORALITY_CUMULATIVE = 2;
}

message NumberDataPoint {
  repeated KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  oneof value {
    double as_double = 4;
    sfixed64 as_int = 6;
  }
  repeated Exemplar exemplars = 5;
  uint32 flags = 8;
}

message HistogramDataPoint {
  repeated KeyValue attributes = 9;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  repeated fixed64 bucket_counts = 6;
  repeated double explicit_bounds = 7;
  repeated Exemplar exemplars = 8;
  uint32 flags = 10;
  double min = 11;
  double max = 12;
}

message ExponentialHistogramDataPoint {
  repeated KeyValue attributes = 1;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  sint32 scale = 6;
  fixed64 zero_count = 7;
  ExponentialHistogramDataPointBuckets positive = 8;
  ExponentialHistogramDataPointBuckets negative = 9;
  uint32 flags = 10;
  repeated Exemplar exemplars = 11;
  double min = 12;
  double max = 13;
  double zero_threshold = 14;
}

message ExponentialHistogramDataPointBuckets {
  sint32 offset = 1;
  repeated uint64 bucket_counts = 2;
}

message SummaryDataPoint {
  repeated KeyValue attributes = 7;
  fixed64 start_time_unix_nano = 2;
  fixed64 time_unix_nano = 3;
  fixed64 count = 4;
  double sum = 5;
  repeated SummaryDataPointValueAtQuantile quantile_values = 6;
  uint32 flags = 8;
}

message SummaryDataPointValueAtQuantile {
  double quantile = 1;
  double value = 2;
}

message Exemplar {
  repeated KeyValue filtered_attributes = 7;
  fixed64 time_unix_nano = 2;
  oneof value {
    double as_double = 3;
    sfixed64 as_int = 6;
  }
  bytes span_id = 4;
  bytes trace_id = 5;
}

// =====================================================================
// Logs signal (opentelemetry/proto/logs/v1/logs.proto)
// =====================================================================

message ExportLogsServiceRequest {
  repeated ResourceLogs resource_logs = 1;
}

message ResourceLogs {
  Resource resource = 1;
  repeated ScopeLogs scope_logs = 2;
  string schema_url = 3;
}

message ScopeLogs {
  InstrumentationScope scope = 1;
  repeated LogRecord log_records = 2;
  string schema_url = 3;
}

message LogRecord {
  fixed64 time_unix_nano = 1;
  fixed64 observed_time_unix_nano = 11;
  SeverityNumber severity_number = 2;
  string severity_text = 3;
  AnyValue body = 5;
  repeated KeyValue attributes = 6;
  uint32 dropped_attributes_count = 7;
  uint32 flags = 8;
  bytes trace_id = 9;
  bytes span_id = 10;
  string event_name = 12;
}

enum SeverityNumber {
  SEVERITY_NUMBER_UNSPECIFIED = 0;
  SEVERITY_NUMBER_TRACE = 1;
  SEVERITY_NUMBER_TRACE2 = 2;
  SEVERITY_NUMBER_TRACE3 = 3;
  SEVERITY_NUMBER_TRACE4 = 4;
  SEVERITY_NUMBER_DEBUG = 5;
  SEVERITY_NUMBER_DEBUG2 = 6;
  SEVERITY_NUMBER_DEBUG3 = 7;
  SEVERITY_NUMBER_DEBUG4 = 8;
  SEVERITY_NUMBER_INFO = 9;
  SEVERITY_NUMBER_INFO2 = 10;
  SEVERITY_NUMBER_INFO3 = 11;
  SEVERITY_NUMBER_INFO4 = 12;
  SEVERITY_NUMBER_WARN = 13;
  SEVERITY_NUMBER_WARN2 = 14;
  SEVERITY_NUMBER_WARN3 = 15;
  SEVERITY_NUMBER_WARN4 = 16;
  SEVERITY_NUMBER_ERROR = 17;
  SEVERITY_NUMBER_ERROR2 = 18;
  SEVERITY_NUMBER_ERROR3 = 19;
  SEVERITY_NUMBER_ERROR4 = 20;
  SEVERITY_NUMBER_FATAL = 21;
  SEVERITY_NUMBER_FATAL2 = 22;
  SEVERITY_NUMBER_FATAL3 = 23;
  SEVERITY_NUMBER_FATAL4 = 24;
}

// =====================================================================
// Trace signal (opentelemetry/proto/trace/v1/trace.proto)
// =====================================================================

message ExportTraceServiceRequest {
  repeated ResourceSpans resource_spans = 1;
}

message ResourceSpans {
  Resource resource = 1;
  repeated ScopeSpans scope_spans = 2;
  string schema_url = 3;
}

message ScopeSpans {
  InstrumentationScope scope = 1;
  repeated Span spans = 2;
  string schema_url = 3;
}

message Span {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  bytes parent_span_id = 4;
  string name = 5;
  SpanKind kind = 6;
  fixed64 start_time_unix_nano = 7;
  fixed64 end_time_unix_nano = 8;
  repeated KeyValue attributes = 9;
  uint32 dropped_attributes_count = 10;
  repeated SpanEvent events = 11;
  uint32 dropped_events_count = 12;
  repeated SpanLink links = 13;
  uint32 dropped_links_count = 14;
  SpanStatus status = 15;
  bytes trace_state_bytes = 16;
  uint32 flags = 17;
}

enum SpanKind {
  SPAN_KIND_UNSPECIFIED = 0;
  SPAN_KIND_INTERNAL = 1;
  SPAN_KIND_SERVER = 2;
  SPAN_KIND_CLIENT = 3;
  SPAN_KIND_PRODUCER = 4;
  SPAN_KIND_CONSUMER = 5;
}

message SpanEvent {
  fixed64 time_unix_nano = 1;
  string name = 2;
  repeated KeyValue attributes = 3;
  uint32 dropped_attributes_count = 4;
}

message SpanLink {
  bytes trace_id = 1;
  bytes span_id = 2;
  string trace_state = 3;
  repeated KeyValue attributes = 4;
  uint32 dropped_attributes_count = 5;
  uint32 flags = 6;
}

message SpanStatus {
  string message = 2;
  StatusCode code = 3;
}

enum StatusCode {
  STATUS_CODE_UNSET = 0;
  STATUS_CODE_OK = 1;
  STATUS_CODE_ERROR = 2;
}
`;
