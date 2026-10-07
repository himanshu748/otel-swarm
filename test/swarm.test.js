import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trace } from '@opentelemetry/api';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { createSwarm } from '../src/index.js';

// One provider per process: createSwarm registers it globally.
const exporter = new InMemorySpanExporter();
const swarm = createSwarm({ service: 'otel-swarm-test', exporter });
const bus = [];
swarm.events.on('event', (e) => bus.push(e));

// BatchSpanProcessor buffers spans; flush the registered provider before reading them.
async function flushed() {
  const provider = trace.getTracerProvider();
  await (provider.getDelegate ? provider.getDelegate() : provider).forceFlush();
  const spans = exporter.getFinishedSpans();
  exporter.reset();
  return spans;
}

test('task > agent > llm produce nested spans with GenAI attributes', async () => {
  const out = await swarm.task('generation', { 'my.prompt': 'x' }, () =>
    swarm.agent('planner', () =>
      swarm.llm('planner', { model: 'm1', call: async () => ({ content: 'plan', inputTokens: 3, outputTokens: 5 }) })
    )
  );
  assert.equal(out, 'plan');
  const spans = await flushed();
  const byName = Object.fromEntries(spans.map((s) => [s.name, s]));
  assert.ok(byName.generation && byName['agent.planner'] && byName['llm.planner']);
  const llm = byName['llm.planner'];
  assert.equal(llm.attributes['gen_ai.request.model'], 'm1');
  assert.equal(llm.attributes['gen_ai.response.model'], 'm1');
  assert.equal(llm.attributes['gen_ai.usage.input_tokens'], 3);
  assert.equal(llm.attributes['gen_ai.usage.output_tokens'], 5);
  assert.equal(llm.attributes['swarm.role'], 'planner');
  assert.equal(llm.parentSpanContext?.spanId ?? llm.parentSpanId, byName['agent.planner'].spanContext().spanId);
});

test('primary failure promotes to fallback and keeps request.model as the attempted model', async () => {
  const content = await swarm.llm('coder', {
    model: 'flaky',
    fallbackModel: 'steady',
    call: async (m) => {
      if (m === 'flaky') throw new Error('504');
      return { content: 'ok', inputTokens: 1, outputTokens: 2 };
    }
  });
  assert.equal(content, 'ok');
  const [span] = await flushed();
  assert.equal(span.attributes['gen_ai.request.model'], 'flaky');
  assert.equal(span.attributes['gen_ai.response.model'], 'steady');
  const ev = span.events.find((e) => e.name === 'fallback_promotion');
  assert.deepEqual({ ...ev.attributes }, { from: 'flaky', to: 'steady', reason: '504' });
  assert.ok(bus.some((e) => e.type === 'fallback' && e.to === 'steady' && e.traceId === span.spanContext().traceId));
});

test('a call that resolves without usage is a success, not a fallback trigger', async () => {
  let calls = 0;
  const content = await swarm.llm('quiet', { model: 'a', fallbackModel: 'b', call: async () => { calls++; } });
  assert.equal(content, undefined);
  assert.equal(calls, 1);
  const [span] = await flushed();
  assert.equal(span.events.length, 0);
  assert.equal(span.attributes['gen_ai.usage.input_tokens'], 0);
});

test('errors set ERROR status and record the exception', async () => {
  await assert.rejects(swarm.agent('critic', async () => { throw new Error('boom'); }), /boom/);
  const [span] = await flushed();
  assert.equal(span.status.code, 2);
  assert.ok(span.events.some((e) => e.name === 'exception'));
});

test('reviewEvents adds critic_catch events and mirrors them on the bus', async () => {
  await swarm.agent('critic', async (span) => swarm.reviewEvents(span, [{ target: 'backend', severity: 'high' }]));
  const [span] = await flushed();
  assert.equal(span.events.filter((e) => e.name === 'critic_catch').length, 1);
  assert.ok(bus.some((e) => e.type === 'critic_catch' && e.target === 'backend'));
});

test('createSwarm requires a service name', () => {
  assert.throws(() => createSwarm({}), /service name/);
});
