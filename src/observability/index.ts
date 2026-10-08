/**
 * OpenTelemetry initialization for harness-dispatch.
 *
 * OFF BY DEFAULT. Traces only exist if the operator opts in — via
 * `telemetry: { enabled: true }` in config.yaml (passed here as
 * `{ enabled }` after config load) or the `HARNESS_DISPATCH_TELEMETRY=1` env
 * var — because they're purely local operator observability that requires a
 * running OTLP collector to be of any use. `OTEL_SDK_DISABLED=true` remains
 * a hard off-switch that beats both opt-ins.
 *
 * The SDK exports OTLP/HTTP to `http://localhost:4318/v1/traces` by default.
 * Override with `OTEL_EXPORTER_OTLP_ENDPOINT` (standard env var) or by passing
 * `otlpUrl` to `initObservability`.
 *
 * Instrumentation is explicit rather than
 * `@opentelemetry/auto-instrumentations-node`: that meta-package bundles
 * instrumentation for MongoDB, MySQL, Postgres, Kafka, Restify, Hapi, Koa and
 * Connect plus AWS/GCP/Azure/Alibaba Cloud resource detectors, none of which
 * harness-dispatch touches and all of which ship on every install whether or
 * not telemetry is ever enabled. Several of those unused branches carry CVEs
 * that `package.json`'s `overrides` cannot fix downstream — overrides apply
 * only to the root project doing the installing. So only `http` and `fs` are
 * instrumented: http covers dispatcher fetch calls and this server's own HTTP
 * surface; fs covers config/job-file reads. Subprocess spawns are covered by
 * our own manual dispatcher/router/MCP spans (see spans.ts) — no
 * `child_process` instrumentation package exists in the OTel JS ecosystem.
 *
 * THE OPENTELEMETRY PACKAGES ARE OPTIONAL (`peerDependenciesMeta` in
 * package.json): a default install does not carry them, and nothing imports
 * one unless telemetry is enabled. Enabled without them, `initObservability`
 * throws a message naming the packages to install.
 */

import type { Span } from "@opentelemetry/api";
import { VERSION } from "../version.js";
import { useOtelApi } from "./spans.js";

const SERVICE_NAME_DEFAULT = "harness-dispatch";
const SERVICE_VERSION = VERSION;

export interface InitObservabilityOpts {
  /**
   * Explicitly enable/disable. Telemetry is OFF unless this is true or the
   * env opt-in `HARNESS_DISPATCH_TELEMETRY=1|true` is set. Config:
   * `telemetry: { enabled: true }`.
   */
  enabled?: boolean;
  /** Override the OTLP endpoint. Defaults to OTEL_EXPORTER_OTLP_ENDPOINT or http://localhost:4318. */
  otlpUrl?: string;
  /** Override the service name attached to spans. Defaults to harness-dispatch. */
  serviceName?: string;
  /** Inject instrumentations for tests; otherwise http + fs are used. */
  instrumentations?: unknown[];
}

/**
 * The packages telemetry needs, which a default install does not have, with the
 * ranges harness-dispatch is built against: the `peerDependencies` in
 * package.json (a test keeps the two equal). The ranges are part of the
 * install command because the 0.x packages are matched to one minor version, so
 * a bare `npm install @opentelemetry/instrumentation` takes a newer one and
 * npm refuses it as a peer conflict.
 */
export const TELEMETRY_PACKAGES = {
  "@opentelemetry/api": "^1.9.1",
  "@opentelemetry/sdk-trace-node": "^2.10.0",
  "@opentelemetry/exporter-trace-otlp-http": "^0.221.0",
  "@opentelemetry/resources": "^2.10.0",
  "@opentelemetry/instrumentation": "^0.221.0",
  "@opentelemetry/instrumentation-http": "^0.221.0",
  "@opentelemetry/instrumentation-fs": "^0.40.0",
} as const;

/** The install command that makes telemetry available. */
export const TELEMETRY_INSTALL_COMMAND = `npm install ${Object.entries(TELEMETRY_PACKAGES)
  .map(([name, range]) => `${name}@${range}`)
  .join(" ")}`;

/** Why telemetry could not start: the message says what to install. */
export class TelemetryUnavailableError extends Error {
  constructor(pkg: string, cause: unknown) {
    const reason = (cause instanceof Error ? cause.message : String(cause)).split("\n")[0];
    super(
      `telemetry is enabled but ${pkg} could not be loaded (${reason}). ` +
        `Install the OpenTelemetry packages next to harness-dispatch to enable telemetry: ` +
        `${TELEMETRY_INSTALL_COMMAND} ` +
        `(into the same node_modules that holds harness-dispatch). ` +
        `Or turn telemetry off: \`telemetry: { enabled: false }\` in config.yaml, and unset HARNESS_DISPATCH_TELEMETRY.`,
      { cause },
    );
    this.name = "TelemetryUnavailableError";
  }
}

/** Import one optional package, turning any failure into a TelemetryUnavailableError. */
async function load<T>(pkg: string, importer: () => Promise<T>): Promise<T> {
  try {
    return await importer();
  } catch (err) {
    throw new TelemetryUnavailableError(pkg, err);
  }
}

let initialized = false;
let sdkRef: { shutdown: () => Promise<void> } | null = null;

function envOptIn(): boolean {
  const v = process.env["HARNESS_DISPATCH_TELEMETRY"];
  return v === "1" || v === "true";
}

/**
 * Initialize the OpenTelemetry SDK. Idempotent once actually initialized;
 * a disabled call does NOT latch, so an early env-gated call (CLI startup)
 * followed by a config-gated call (`telemetry: { enabled: true }`, known
 * only after config load) still works.
 *
 * Returns true if the SDK was initialized by this call, false otherwise.
 */
export async function initObservability(opts: InitObservabilityOpts = {}): Promise<boolean> {
  if (initialized) return false;
  if (process.env["OTEL_SDK_DISABLED"] === "true") return false;
  if (!(opts.enabled ?? envOptIn())) return false;

  // Lazily import so consumers who never call initObservability don't pay the
  // load cost or pick up auto-instrumentations they didn't ask for.
  //
  // Trace-only packages, not `@opentelemetry/sdk-node`: that meta-SDK ships the
  // gRPC/protobuf/Prometheus/Zipkin exporters and the metrics and logs SDKs,
  // none of which this code path loads — about half of what every install
  // downloaded, for a feature that is off by default.
  //
  // Optional packages: a missing one stops here with the install instruction
  // rather than being swallowed, because the operator asked for telemetry.
  const [api, { NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }, resources] =
    await Promise.all([
      load("@opentelemetry/api", () => import("@opentelemetry/api")),
      load("@opentelemetry/sdk-trace-node", () => import("@opentelemetry/sdk-trace-node")),
      load("@opentelemetry/exporter-trace-otlp-http", () => import("@opentelemetry/exporter-trace-otlp-http")),
      load("@opentelemetry/resources", () => import("@opentelemetry/resources")),
    ]);
  const { registerInstrumentations } = await load("@opentelemetry/instrumentation", () =>
    import("@opentelemetry/instrumentation"),
  );

  const otlpEndpoint =
    opts.otlpUrl ??
    process.env["OTEL_EXPORTER_OTLP_ENDPOINT"] ??
    "http://localhost:4318";

  const exporter = new OTLPTraceExporter({
    url: `${otlpEndpoint.replace(/\/+$/, "")}/v1/traces`,
  });

  // Lazily imported for the same reason as the SDK/exporter above — keeps
  // cold-start cheap when tests bring their own (empty) instrumentation set.
  let instrumentations = opts.instrumentations;
  if (instrumentations === undefined) {
    const [{ HttpInstrumentation }, { FsInstrumentation }] = await Promise.all([
      load("@opentelemetry/instrumentation-http", () => import("@opentelemetry/instrumentation-http")),
      load("@opentelemetry/instrumentation-fs", () => import("@opentelemetry/instrumentation-fs")),
    ]);
    instrumentations = [new HttpInstrumentation(), new FsInstrumentation()];
  }

  const serviceName = opts.serviceName ?? SERVICE_NAME_DEFAULT;

  // The default resource detectors include the process detector, whose
  // `process.command_args` is the full argv — and for `harness-dispatch
  // dispatch "<prompt>"` the prompt IS an argv element, so every span carried
  // it to the collector. Measured: a canary prompt appeared in the export.
  // The same defaults minus that one; an explicit setting is the user's.
  const detectors = resourceDetectors(resources);

  try {
    registerInstrumentations({ instrumentations: instrumentations as never });
    const resource = resources
      .defaultResource()
      .merge(resources.detectResources({ detectors }))
      .merge(
        resources.resourceFromAttributes({
          "service.name": serviceName,
          "service.version": SERVICE_VERSION,
        }),
      );
    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    // Also installs the async-local-storage context manager and the W3C
    // propagators, which is what makes spans nest.
    provider.register();
    useOtelApi(api);
    sdkRef = { shutdown: () => provider.shutdown() };
    initialized = true;
    return true;
  } catch {
    // SDK failed to start — don't crash the host.
    return false;
  }
}

/**
 * The resource detectors to run: `env,host` unless `OTEL_NODE_RESOURCE_DETECTORS`
 * names others (comma-separated `env`, `host`, `os`, `process`,
 * `serviceinstance`; `all`; `none`). Empty counts as unset.
 */
function resourceDetectors(r: typeof import("@opentelemetry/resources")) {
  const known = {
    env: r.envDetector,
    host: r.hostDetector,
    os: r.osDetector,
    process: r.processDetector,
    serviceinstance: r.serviceInstanceIdDetector,
  };
  const names = (process.env["OTEL_NODE_RESOURCE_DETECTORS"] ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 0) return [known.env, known.host];
  if (names.includes("all")) return Object.values(known);
  if (names.includes("none")) return [];
  return names.flatMap((n) => known[n as keyof typeof known] ?? []);
}

/** Shut down the observability SDK (drains pending spans). Idempotent. */
export async function shutdownObservability(): Promise<void> {
  if (!sdkRef) return;
  try {
    await sdkRef.shutdown();
  } catch {
    // best-effort drain
  }
  sdkRef = null;
  initialized = false;
  useOtelApi(undefined);
}

/** Reset internal state — tests only. */
export function _resetObservabilityForTests(): void {
  initialized = false;
  sdkRef = null;
  useOtelApi(undefined);
}

export { withDispatcherSpan, withRouterSpan, withMcpToolSpan } from "./spans.js";
export type { SpanAttrs } from "./spans.js";
export type { Span };
