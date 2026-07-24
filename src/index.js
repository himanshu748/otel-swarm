import { trace, SpanStatusCode } from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor, ConsoleSpanExporter } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import { EventEmitter } from 'node:events';

/**
 * Create an instrumented swarm context for a multi-agent LLM system.
 * One provider, one tracer, GenAI semantic conventions on every LLM span,
 * plus a local event bus mirroring everything the spans record, so a UI can
 * stream the same data SigNoz stores (one pipeline, two consumers).
 */
export function createSwarm({ service, version = '0.0.0', otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT } = {}) {
  if (!service) throw new Error('createSwarm requires a service name');
  const provider = new NodeTracerProvider({
    resource: new Resource({ 'service.name': service, 'service.version': version }),
    spanProcessors: [
      new BatchSpanProcessor(
        otlpEndpoint
          ? new OTLPTraceExporter({ url: `${otlpEndpoint.replace(/\/$/, '')}/v1/traces` })
          : new ConsoleSpanExporter()
      )
    ]
  });
  provider.register();
  const tracer = trace.getTracer(service);
  const events = new EventEmitter();
  const emit = (type, data) => events.emit('event', { type, at: Date.now(), ...data });

  /** Root span for one end-to-end task (a generation, a pipeline run). */
  async function task(name, attrs, fn) {
    return tracer.startActiveSpan(name, async (span) => {
      span.setAttributes(attrs || {});
      emit('task_start', { name });
      try {
        const result = await fn(span);
        emit('task_end', { name });
        span.end();
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        emit('task_error', { name, reason: String(err.message || err) });
        span.end();
        throw err;
      }
    });
  }

  /** Child span for one agent's unit of work. */
  async function agent(role, fn, attributes) {
    return tracer.startActiveSpan(`agent.${role}`, async (span) => {
      span.setAttribute('swarm.role', role);
      if (attributes) span.setAttributes(attributes);
      emit('agent_start', { role });
      try {
        const result = await fn(span);
        emit('agent_end', { role });
        span.end();
        return result;
      } catch (err) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
        emit('agent_error', { role, reason: String(err.message || err) });
        span.end();
        throw err;
      }
    });
  }

  /**
   * Span one LLM call with GenAI semconv attributes and automatic
   * fallback promotion: call(model) is retried once with fallbackModel on
   * failure, recorded as a span event so "why did the model switch" is
   * answerable from the trace.
   * call(model) must resolve to { content, inputTokens, outputTokens }.
   * Extra span attributes (host-specific role keys, run ids) go in attributes.
   */
  async function llm(role, { model, fallbackModel, call, attributes }) {
    return tracer.startActiveSpan(`llm.${role}`, async (span) => {
      span.setAttributes({ 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': model, 'swarm.role': role, ...(attributes || {}) });
      const traceId = span.spanContext().traceId;
      const started = Date.now();
      emit('llm_start', { role, model, traceId });
      const finish = (usedModel, r) => {
        span.setAttributes({
          'gen_ai.usage.input_tokens': r.inputTokens ?? 0,
          'gen_ai.usage.output_tokens': r.outputTokens ?? 0
        });
        emit('llm_end', { role, model: usedModel, ms: Date.now() - started, in: r.inputTokens ?? 0, out: r.outputTokens ?? 0, traceId });
        span.end();
        return r.content;
      };
      try {
        return finish(model, await call(model));
      } catch (err) {
        if (!fallbackModel) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err) });
          emit('llm_error', { role, model, reason: String(err.message || err), traceId });
          span.end();
          throw err;
        }
        span.addEvent('fallback_promotion', { from: model, to: fallbackModel, reason: String(err.message || err) });
        span.setAttribute('gen_ai.request.model', fallbackModel);
        emit('fallback', { role, from: model, to: fallbackModel, reason: String(err.message || err), traceId });
        try {
          return finish(fallbackModel, await call(fallbackModel));
        } catch (err2) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: String(err2) });
          emit('llm_error', { role, model: fallbackModel, reason: String(err2.message || err2), traceId });
          span.end();
          throw err2;
        }
      }
    });
  }

  /** Record a review/critic verdict as span events on the active span. */
  function reviewEvents(span, issues) {
    for (const issue of issues || []) {
      span.addEvent('critic_catch', issue);
      emit('critic_catch', issue);
    }
  }

  /** Flush pending spans and shut the provider down. Call before process exit. */
  async function shutdown() {
    await provider.forceFlush();
    await provider.shutdown();
  }

  return { tracer, events, emit, task, agent, llm, reviewEvents, shutdown };
}
