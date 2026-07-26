---
title: "Tracing a multi-agent LLM system: otel-swarm and a SigNoz dashboard pack"
published: false
description: "OpenTelemetry instrumentation for multi-agent LLM systems, plus three importable SigNoz dashboards and two alert rules. Includes the span-event mistake that made me blame the wrong model for an afternoon."
tags: opentelemetry, observability, ai, showdev
---

## The problem

A single LLM call is easy to reason about. You send a prompt, you get tokens back, you log the latency and you move on.

A swarm is not that. Four or five agents run, some in parallel, each with its own model. One of them times out and quietly falls back to a cheaper model. A critic agent reads the output and sends work back for another round. When the whole thing takes 40 seconds instead of 12, or costs three times what you budgeted, you have no idea which agent did it. Your logs are a flat stream of interleaved lines from concurrent tasks, with no parent-child structure and no way to ask "which role burned the tokens".

Traces solve this exactly. The catch is that hand-wiring OpenTelemetry across every role, every provider call and every retry path is boring work that nobody wants to do twice, and if you skip a level the trace tree lies to you.

So I extracted the instrumentation out of DevSwarm (a multi-agent code generator I built for this hackathon) into a standalone MIT library: [otel-swarm](https://github.com/himanshu748/otel-swarm).

## The API

One `createSwarm()` call, then three verbs.

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

swarm.events.on('event', (e) => { /* llm_start, llm_end, fallback, critic_catch */ });
```

`task()` opens the root span, `agent()` opens a child span per role and `llm()` opens a GenAI-semconv span per model call. `call(model)` is invoked again with `fallbackModel` if the primary throws, and the switch is recorded as a `fallback_promotion` span event carrying `from`, `to` and the verbatim provider error.

The last line matters more than it looks. `swarm.events` is an EventEmitter that mirrors the span lifecycle, and LLM events carry the `traceId`. A live UI reads the emitter, the tracing backend reads the OTLP exporter and both are fed from the same code path, so the dashboard and the UI can never disagree about what happened. The `traceId` means a row in your UI deep-links to the exact trace in SigNoz.

Running `npm run example` against a local SigNoz produced 9 spans under service `otel-swarm-demo`: a root `generation` span of 1325ms, then `agent.planner`/`llm.planner`, `agent.frontend`/`llm.frontend`, `agent.backend`/`llm.backend` and `agent.critic`/`llm.critic`. `llm.frontend` carried a `fallback_promotion` event and `agent.critic` carried a `critic_catch` event. The whole story is one trace.

In production use inside DevSwarm the same library has traced 29 generations, 243 model calls across 8 models, 3.78 million tokens and 257 review catches.

## Lesson 1: put the fallback in a span event, never on the attribute you group by

This one cost me an afternoon.

An earlier version of the library did the obvious thing when a primary model failed: it overwrote `gen_ai.request.model` with the fallback's name, so the span would "tell the truth" about which model actually answered.

That is wrong, and it is wrong in a way that is hard to see. Every dashboard panel that groups by model then attributes the primary's failure, its timeout and all of its wasted latency to the fallback that cleaned up after it. My "tokens and latency by model" table showed a cheap fallback model with terrible p95 latency and my expensive primary looking flawless, because every time the primary blew up its cost was silently reassigned to whoever picked up the pieces. I spent an afternoon convinced the wrong model was slow.

The rule that comes out of it: **the attribute you group by must record the model you attempted, not the model that ended up answering.** The promotion is a discrete thing that happened during the span, and a discrete thing that happened during a span is what span events are for:

```js
span.addEvent('fallback_promotion', { from: model, to: fallbackModel, reason: String(err.message || err) });
```

Now the grouped panel keeps attributing failure to whoever caused it, and "how often does this role get promoted" is a separate query over events. Two different questions, two different storage locations, no cross-contamination.

The general form: if a value can change mid-span, it does not belong on an attribute you aggregate over.

## Lesson 2: reading inside span events in ClickHouse is not obvious

The consequence of putting things in events is that you now have to query events, and SigNoz stores them as an array of JSON strings on the span row. There is no autocomplete that will lead you here. The pattern is `ARRAY JOIN` to flatten the array into one row per event, then `JSONExtractString` to reach into the event's `attributeMap`:

```sql
SELECT JSONExtractString(e, 'attributeMap', 'severity') AS severity,
       JSONExtractString(e, 'attributeMap', 'target') AS target,
       count() AS catches
FROM signoz_traces.distributed_signoz_index_v3
ARRAY JOIN events AS e
WHERE serviceName = '{{.service}}' AND name = 'agent.critic'
  AND JSONExtractString(e, 'name') = 'critic_catch'
GROUP BY severity, target ORDER BY catches DESC
```

That gives you review findings broken down by severity and by what they were aimed at, straight out of span events, with no separate metrics pipeline.

When you only need to know whether an event fired at all, do not pay for the `ARRAY JOIN`. `arrayExists` with a substring test over the raw array is enough and it keeps one row per span, which is what you want for a time series:

```sql
SELECT toStartOfInterval(timestamp, INTERVAL 15 MINUTE) AS ts,
       attributes_string['swarm.role'] AS role,
       count() AS value
FROM signoz_traces.distributed_signoz_index_v3
WHERE serviceName = '{{.service}}'
  AND arrayExists(e -> e LIKE '%fallback_promotion%', events)
  AND timestamp BETWEEN {{.start_datetime}} AND {{.end_datetime}}
GROUP BY ts, role ORDER BY ts
```

## The dashboard pack

The repo ships 3 importable SigNoz dashboards (POST each JSON to `/api/v1/dashboards`). Every query uses a `{{.service}}` dashboard variable that defaults to `otel-swarm-demo`, so you point the pack at your own service by editing one dropdown instead of doing find-and-replace across query strings.

- **Generation Overview** answers "is the swarm healthy right now": generation count, review-gate pass rate, seconds per generation over time and a per-role table of calls, average latency, p95 and errors.
- **LLM Economics** answers "where did the tokens go": total tokens, tokens over time by role, a tokens-and-latency table by model and fallback promotions by role (the `arrayExists` query above).
- **Review-Gate Funnel** answers "is the reviewer doing its job": total catches, regeneration rounds, catches per generation over time and a table of recent generations with verdict, catches and regenerations.

## The alert rules

Two rules ship in the v2alpha1 schema (POST to `/api/v2/rules`).

The first is a fallback-promotion spike. If promotions jump, a provider is degrading and you are silently paying a different bill than you planned.

The second is the one I care about more: a **review catch-rate flatline**. If your critic agent suddenly stops finding anything, the tempting read is that the generators got better. In practice the reviewer broke: a prompt change made it answer in a shape the parser drops, or its model started returning empty content and the failure is being swallowed as "no issues found". A quality gate that passes everything is indistinguishable from no quality gate, and it fails silently by construction. Alert on the absence.

The repo also includes `casting.yaml` and `casting.yaml.lock`, the Foundry config the SigNoz instance behind these dashboards was installed from, so the backend the pack targets is reproducible rather than assumed.

## Install and run

```sh
npm install github:himanshu748/otel-swarm
```

To see the example trace end to end against a local SigNoz:

```sh
git clone https://github.com/himanshu748/otel-swarm && cd otel-swarm
npm install
npm run example                                                     # spans to console
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run example   # spans to SigNoz
```

With no endpoint set it exports to the console, so you can check the span tree before wiring a backend.

## Closing

The library is about 130 lines. Most of the value is not code, it is the two decisions above: keep mutable facts in span events, and treat "the reviewer found nothing" as a symptom rather than a result. Both were learned by getting them wrong first.

I built otel-swarm with Claude Code, including the dashboard JSON and the ClickHouse queries in this post.

Repo: [github.com/himanshu748/otel-swarm](https://github.com/himanshu748/otel-swarm), MIT.
