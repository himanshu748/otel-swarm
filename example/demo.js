import { createSwarm } from '../src/index.js';

// A fake two-agent pipeline that shows every feature: task root span, agent
// spans, LLM spans with token accounting, a failing primary promoting to its
// fallback, and critic catches as span events.
// Run with a local SigNoz: OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run example

const swarm = createSwarm({ service: 'otel-swarm-demo', version: '0.1.0' });

swarm.events.on('event', (e) => console.log('[bus]', e.type, e.role || e.name || ''));

const fakeModel = (name, { fail = false, tokens = 500 } = {}) => async () => {
  await new Promise((r) => setTimeout(r, 150 + Math.random() * 300));
  if (fail) throw new Error(`${name}: simulated 504`);
  return { content: `output from ${name}`, inputTokens: 120, outputTokens: tokens };
};

await swarm.task('generation', { 'demo.prompt': 'build me a thing' }, async (root) => {
  await swarm.agent('planner', () =>
    swarm.llm('planner', { model: 'primary-planner', call: fakeModel('primary-planner') })
  );

  await Promise.all([
    swarm.agent('frontend', () =>
      swarm.llm('frontend', {
        model: 'flaky-primary',
        fallbackModel: 'reliable-fallback',
        call: (m) => (m === 'flaky-primary' ? fakeModel(m, { fail: true })() : fakeModel(m, { tokens: 2000 })())
      })
    ),
    swarm.agent('backend', () =>
      swarm.llm('backend', { model: 'primary-coder', call: fakeModel('primary-coder', { tokens: 1400 }) })
    )
  ]);

  await swarm.agent('critic', async (span) => {
    await swarm.llm('critic', { model: 'primary-critic', call: fakeModel('primary-critic') });
    swarm.reviewEvents(span, [{ target: 'backend', severity: 'high', description: 'demo catch: missing input validation' }]);
  });

  // The bundled dashboards read these off the root span. Set the same three on
  // your own task span and the pack works against your swarm without edits.
  root.setAttributes({
    'swarm.generation.verdict': 'pass',
    'swarm.generation.critic_catches': 1,
    'swarm.generation.regenerations': 0
  });
});

await swarm.shutdown();
console.log('demo complete, spans exported');
