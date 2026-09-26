import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  type ReadableSpan,
  type Span,
  type SpanProcessor,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { currentCorrelationId } from './index.js';

/**
 * Tracing (012 FR-032). The one thing this adds over a default SDK setup: every span carries
 * `healer.correlation_id`, so a trace and a log line about the same investigation join on the
 * same key. Without it the two are separate systems telling separate stories.
 *
 * Auto-instrumentation is deliberately not installed here. It pulls in a large dependency set
 * and its most useful members (HTTP, Postgres, Redis) arrive with the code that uses them.
 */
class CorrelationSpanProcessor implements SpanProcessor {
  onStart(span: Span): void {
    const correlationId = currentCorrelationId();
    if (correlationId) span.setAttribute('healer.correlation_id', correlationId);
  }
  onEnd(_span: ReadableSpan): void {}
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

export interface TracingHandle {
  shutdown(): Promise<void>;
}

/**
 * Starts tracing. With no endpoint configured it still runs, adding the correlation attribute
 * and exporting nowhere — so local development and tests behave like production minus the
 * export, rather than taking a different code path.
 */
export function startTracing(options: {
  serviceName: string;
  serviceVersion: string;
  otlpEndpoint?: string;
}): TracingHandle {
  const processors: SpanProcessor[] = [new CorrelationSpanProcessor()];
  if (options.otlpEndpoint) {
    processors.push(new SimpleSpanProcessor(new OTLPTraceExporter({ url: options.otlpEndpoint })));
  }

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
    }),
    spanProcessors: processors,
  });
  sdk.start();
  return { shutdown: () => sdk.shutdown() };
}
