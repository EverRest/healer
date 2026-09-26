# Failure modes of automated fixing systems

Ordered by how hard they are to notice. The dangerous ones are silent.

## 1. Circular verification (silent)

The system verifies its own conclusion. A regression test written from a diagnosis tests whatever
that diagnosis claimed — so a wrong diagnosis produces a wrong test that fails on the old code and
passes on the new one. Every gate reports PASS.

Appears in three disguises:

| Disguise | The circle |
|---|---|
| Regression test from diagnosis | Test asserts what the diagnosis assumed |
| Answer citations chosen by the answer | Citation supports the claim because it was picked to |
| Reviewer asked "does this fix the reported root cause?" | Inherits the first model's premise |

**Countermeasure:** verification anchors only on artifacts that existed before the chain started —
adopted expectations, raw evidence, human-written tests, production signal. Constitution II.

## 2. Symptom masking (silent)

A try/catch, a retry, a default value, a widened type. The alert stops. The metric recovers. The
cause remains and is now harder to find because the evidence path is swallowed.

**Countermeasure:** the expectation must describe the *behaviour*, not the absence of an error.
"Order is created exactly once" cannot be satisfied by suppressing an exception.

## 3. Correlated review (silent)

Two models are not two judges. Shared training data, shared conditioning, shared blind spots. A
second model reviewing the first is weak independence — better than nothing, far weaker than a
human-written test or a production metric.

**Countermeasure:** rank verifiers by genuine independence and never treat model diversity as
sufficient on its own.

## 4. Post-hoc rationalisation (silent)

Asking a model to explain why it did something produces a plausible explanation, not the actual
reason. An evidence graph generated after the fact manufactures trust.

**Countermeasure:** evidence links are emitted by the step that produced them, as it runs.

## 5. Wrong-problem patching (loud, but late)

Patching code for an infrastructure, capacity or third-party failure. Caught eventually, usually
by a human wondering why there is a null check around a Redis call.

**Countermeasure:** classify whether it is a code problem before the patch path opens.

## 6. Anchoring on a stale precedent (silent)

Regression memory primes the diagnosis with a previous similar incident. If the match is wrong, or
the code has changed three refactors since, the anchor is worse than no memory.

**Countermeasure:** precedents enter as candidates with their evidence, never as conclusions, and
decay with age and with whether the referenced code still exists.

## 7. Knowledge self-reference (slow, silent)

The system writes documentation, then later reads its own documentation as authority, then writes
more from that. Over a year, a growing share of "knowledge" is the model quoting itself with
compounding confidence.

**Countermeasure:** provenance on every document; machine-generated content can never become a
verification anchor without human adoption.

## 8. Prompt injection through evidence (loud if exploited, silent if not)

Logs, support tickets, PR descriptions and commit messages are attacker-influenceable and flow
into an agent that can write to a repository.

**Countermeasure:** retrieved content is data, never instructions; the agent proposes, a separate
privileged step commits.

## 9. Cost runaway (loud, expensive)

Escalate-on-failure with no cap, plus a noisy alert source, plus frontier models.

**Countermeasure:** per-incident and per-tenant budgets with a declared degradation order, and a
stop rule where repeated failure becomes a human handoff carrying what was ruled out.

## 10. Measuring on the data you tuned on (silent)

The benchmark and the tuning set are the same incidents. Prompts are iterated until the dataset looks
good, then the dataset produces the false-fix rate, and the rate is optimistic by exactly the amount of
iteration. Nothing in the pipeline is wrong; every number is computed correctly from data that has already
seen the answer.

This one is worse than ordinary overfitting because of what the number is *for*: it gates autonomy. An
optimistic false-fix rate does not merely flatter a report — it raises the level at which an agent writes
to a customer's repository.

**Countermeasure:** a sealed measurement set. Where incidents are scarce, seal the scarce part for
measurement rather than for iteration, and make the tuning exposure visible: every run records which split
it drew from, and only a sealed-split run can back a threshold (011 R-19, C-29).

## 11. A gate with no reader (silent)

A guarantee is built carefully and nothing consumes it. This is not a missing feature — the mechanism
exists, is correct, and is even impossible to circumvent. It simply is not on the path of the decision it
was built for, so the decision proceeds without it and every artifact looks complete.

Three instances found in this project, all in specs that had already been reviewed:

| Mechanism | Who was supposed to read it |
|---|---|
| `fix_eligibility`, `change_eligibility` | the patch path — read by nobody |
| The four autonomy thresholds | the change that raises the permission ceiling — an edit no data check can see |
| A reproduction state in the fix loop | the document designated to prove "reproduce before modify" had none |

**Countermeasure:** for every guarantee, name the mechanism that *refuses to proceed* without it. If the
answer is "a reviewer would notice", it has no reader. The question is cheap and it is not asked by
looking at the component that produces the guarantee — only by looking at the one that ought to consume it.

## 12. A crossing nobody specified (silent)

Two documents each state something true about a boundary, and together they imply a path that neither
describes. "File contents never cross" and "source is in the agent's prompt" were both correct; with the
agent on the wrong side, the only way to satisfy both was an unshaped channel carrying the most sensitive
thing the customer owns. No gate fails, because no gate knows the path exists.

**Countermeasure:** for every model call, ask where its inputs live and where it runs. If those differ,
either the inputs have a declared shape that is allowed to cross, or the call moves. In this project the
call moved (ADR 0010).

## 13. A regression suite that mirrors the code (silent)

Tests generated by reading the code describe what the code does, including its bugs. The suite goes green,
coverage rises, and every existing defect is now protected by a test that fails the day someone fixes it.
It is circular verification (§1) applied to a whole suite at once, and it looks like diligence.

**Countermeasure:** a test may exist only for an expectation a human adopted, and must assert that
expectation's constraint rather than a value observed from the code (013 FR-007, FR-008). A generated
test that fails against the current code is not discarded as wrong — it is the most valuable output the
generator has, and it becomes an issue (013 FR-010).

## 14. An implementer that can edit its judge (silent)

A coding agent under a failing gate has three moves: fix the code, weaken the test, or edit the gate. The
last two are shorter. An agent is not dishonest for taking them; it follows the gradient it is given, and
a rule in its prompt is advice, not a boundary.

**Countermeasure:** make the judge unreachable, not forbidden. Agent-authored change sets cannot touch
the gates, the lint configuration, the specifications or a pre-existing test's assertions; identity comes
from the host's bot flag rather than anything the author writes; merge rights live in a ruleset the agent
cannot bypass and that is itself read on a schedule for drift (012 US10, ADR 0011).

## 15. Test selection that narrows (silent)

Selecting only the tests a change can affect is what makes per-change regression runs affordable, and
every selection heuristic eventually misses an edge. If the miss narrows the selection, a regression merges
green and is found a day later by the nightly run — or not at all, if the nightly run uses the same
selection.

**Countermeasure:** a selection may widen and never narrow. Unknown paths, an uncomputable graph and an
unreachable selector all mean the full suite (013 contracts/selection.md). Being wrong costs CI minutes,
never coverage.

