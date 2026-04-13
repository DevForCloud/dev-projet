const { NodeSDK, metrics, resources } = require("@opentelemetry/sdk-node");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-http");
const {
  OTLPMetricExporter,
} = require("@opentelemetry/exporter-metrics-otlp-http");
const {
  getNodeAutoInstrumentations,
} = require("@opentelemetry/auto-instrumentations-node");

const serviceName = process.env.OTEL_SERVICE_NAME || "task-service";
const serviceVersion = require("../package.json").version;
const otlpEndpoint = (
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://otel-collector:4318"
).replace(/\/+$/, "");

const sdk = new NodeSDK({
  resource: new resources.Resource({
    "service.name": serviceName,
    "service.version": serviceVersion,
  }),
  traceExporter: new OTLPTraceExporter({
    url:
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      `${otlpEndpoint}/v1/traces`,
  }),
  metricReader: new metrics.PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url:
        process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ||
        `${otlpEndpoint}/v1/metrics`,
    }),
  }),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-express": { enabled: true },
      "@opentelemetry/instrumentation-pg": { enabled: true },
      "@opentelemetry/instrumentation-http": { enabled: true },
    }),
  ],
});

sdk.start();

let isShuttingDown = false;

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  try {
    await sdk.shutdown();
    process.exit(0);
  } catch (error) {
    console.error(`OpenTelemetry shutdown failed after ${signal}`, error);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = sdk;
