# Incident taxonomy

The single number that sizes this product is: **what share of real production incidents can be
reproduced in a sandbox?** Everything downstream of reproduction depends on it, and we do not yet
know it for our own systems (stage 0, S0-1).

## Classes

| Class | Reproducible? | Is it a code bug? | Healer's useful output |
|---|---|---|---|
| Unhandled exception, deterministic input | Yes | Yes | Full loop — this is the beachhead |
| Contract violation (API shape, null where non-null promised) | Yes | Yes | Full loop |
| Regression from a known deploy | Often | Yes | Diagnosis + rollback, often before a fix is needed |
| Data-specific (one malformed row) | Only with that data | Usually | Diagnosis; reproduction needs PII handling |
| Race condition / concurrency | Rarely, flakily | Yes | Diagnosis + hypothesis; reproduction usually `INCONCLUSIVE` |
| Load-dependent (pool exhaustion, thread starvation) | Needs load simulation | Sometimes — often config | Diagnosis + remediation (scale, restart) |
| Third-party outage or degradation | No | **No** | Diagnosis + feature-flag disable; **never a patch** |
| Config / infrastructure drift | No | **No** | Diagnosis + rollback; **never a patch** |
| Capacity | No | **No** | Diagnosis + scale |
| Data corruption | No | Sometimes | Diagnosis only; mutation of customer data is out of scope |

## The most dangerous row is "is it a code bug"

Four classes above are not code problems at all. Patching code to compensate for a Redis outage,
a misconfigured environment variable or an upstream API returning 503 produces defensive code that:

- makes the alert stop firing, so it looks like success
- outlives the incident by years
- hides the same failure the next time it happens

This is why the classifier runs **before** diagnosis proceeds toward a patch, and why reversible
remediation (rollback, flag, scale, restart) is a first-class outcome rather than a lesser one.

## Where the symptom is observable decides the instrument

Orthogonal to the class table above, and it decides which ladder applies (C-24). Who reported the
issue tells you nothing about it.

| Observable in | Instrument | Notes |
|---------------|-----------|-------|
| A server response, an exception, server state | Call the function in the stack frame, then a request to the handler | A log gives you endpoint, method, signature, frames and a trace id — everything a request needs. A browser here is orders of magnitude of cost for identical evidence |
| A rendered state, a request never sent, a mishandled response, a browser exception | A component test first, then a replay of the recorded request, then a browser | No server log shows any of these. `unit` and `request` cannot produce a `FAIL` in principle |

The common case is cheaper than it looks: most client-observable reports name the failing request
somewhere — a trace identifier, a HAR, a console log — which drops reproduction to a request replay and
skips the browser entirely. **Asking the reporting system for a trace identifier is the cheapest cost
control in reproduction** (C-27).

And a large share of "the spinner never stops" is a state machine that never leaves `loading`:
reproducible in milliseconds against the store, with no browser and no build.

## Reproduction is a spectrum, not a boolean

```text
deterministic unit-level        cheap, seconds          ← aim here
deterministic HTTP request      needs app boot
needs specific data             needs data, needs PII handling
needs concurrency               flaky, may never reproduce
needs load                      expensive
needs external state            usually impossible
```

The engine should climb this ladder and stop at the cheapest rung that reproduces. If no rung
reproduces, the result is `INCONCLUSIVE` — which is a real answer routed to a human with the
evidence, not a failure.

## Consequence for scope

If the reproducible share is high, v1 as decided (D-11) holds. If it is low, the honest move is to
narrow v1 to diagnosis plus reversible remediation and let the fix engine follow the data.
This is precisely what S0-1 is for.

**And most of that audit is mechanical.** Of the six facts needed per incident, four come out of version
control with no incident tracker involved: whether a fix commit or merge request exists, whether the repo
state is recoverable (the parent SHA of that commit), whether logs still exist, and the error signature
where a tracker has one. Only the class and the "was it a code bug at all" judgement need a human reading
the diagnosis — two columns over an already-filtered set. The version-control half alone answers whether
twenty incidents with recoverable state exist, and if that number is absent no log retention rescues it.
