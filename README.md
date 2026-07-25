# otel-swarm

OpenTelemetry instrumentation for multi-agent LLM systems. One `createSwarm()` call gives you GenAI-semconv spans for every agent and every model call, fallback promotions recorded as span events, critic catches as span events, and a mirrored local event bus so a live UI can stream exactly what your tracing backend stores (one pipeline, two consumers, and they can never disagree).

Built during the Agents of SigNoz hackathon to instrument [DevSwarm](https://github.com/himanshu748/devswarm), extracted because any multi-agent system has the same observability problem: parallel agents, model fallbacks and review loops are opaque without traces, and nobody wants to hand-wire OTel for every role.

## Install

```sh
npm install github:himanshu748/otel-swarm
```

## Run the example

```sh
git clone https://github.com/himanshu748/otel-swarm && cd otel-swarm
npm install
npm run example                                              # spans to console
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run example   # spans to SigNoz
```

The example runs a fake four-agent pipeline: a task root span, parallel agent spans, an LLM call whose primary fails and promotes to its fallback (visible as a `fallback_promotion` span event), and a critic catch. Open SigNoz and the whole story is one trace.

## API

```js
import { createSwarm } from 'otel-swarm';

const swarm = createSwarm({ service: 'my-swarm', otlpEndpoint: 'http://localhost:4318' });

await swarm.task('generation', { 'my.prompt': prompt }, async (root) => {
  const plan = await swarm.agent('planner', () =>
    swarm.llm('planner', {
      model: 'primary-model-id',
      fallbackModel: 'fallback-model-id',
      call: async (model) => {
        const res = await yourProviderCall(model);
        return { content: res.text, inputTokens: res.usage.in, outputTokens: res.usage.out };
      }
    })
  );

  await swarm.agent('critic', async (span) => {
    swarm.reviewEvents(span, issues);   // each issue becomes a critic_catch span event
  });
});

swarm.events.on('event', (e) => { /* stream llm_start/llm_end/fallback/critic_catch to your UI */ });
```

- `task(name, attrs, fn)`: root span per end-to-end run.
- `agent(role, fn)`: child span per agent unit of work.
- `llm(role, {model, fallbackModel, call})`: GenAI semconv span per model call; `call(model)` is invoked again with `fallbackModel` if the primary throws, and the switch is a span event, so "why did the model change" is answerable from the trace.
- `reviewEvents(span, issues)`: review findings as span events.
- `events`: an EventEmitter mirroring every span lifecycle, with `traceId` on LLM events for deep-linking your UI to the exact trace.

## SigNoz pack

- `dashboards/`: three importable dashboards (POST each to `/api/v1/dashboards`): Generation Overview, LLM Economics (tokens and latency per role and model, fallback pressure), Review-Gate Funnel.
- `alerts/`: two alert rules in v2alpha1 schema (POST to `/api/v2/rules`): fallback-promotion spike, and review catch-rate flatline (if your reviewer suddenly catches nothing, the reviewer broke, not the code).

Dashboard queries assume `service.name` filters you adjust to your service, and span names `llm.*`, `agent.*` and a root `generation` span, which is exactly what this library emits.

## License

MIT, see [LICENSE](LICENSE).
