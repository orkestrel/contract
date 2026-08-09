---
paths:
  - 'src/**/*'
  - 'app/**/*'
  - 'tests/**/*'
  - 'guides/**/*'
  - 'package.json'
  - 'vite.config.ts'
  - 'tsconfig.json'
  - '.agents/skills/**/*'
  - '.claude/skills/**/*'
---

# Research, hardening, and completion rules

## Evidence before change

- Research is mandatory when the user requests it, when comparing an upstream/protocol/legacy implementation, or when current external behavior materially affects design.
- Use current primary sources for external capabilities and exact installed declarations/guides for dependencies. Separate verified fact from inference.
- Read authoritative types and named decision-bearing implementation files first-hand. Delegate bulk supporting context, not the owning design decision.
- Treat existing code, tests, `old/`, branches, and copied projects as evidence rather than authority.
- Build a capability/defect matrix before a broad API or production-readiness change. Every row ends as implement, repair, retain, or intentionally exclude with evidence.
- That matrix is fixed when the change starts and is its definition of done. The change closes when every row closes; no row ends as “hardened further”; and a finding outside the matrix is recorded against the row that owns it, for the next matrix, rather than reopening this one.

## Run it, don't argue it

A question that a probe can settle is settled by the probe. Reasoning is how you decide what to run and what the result means; it is not a substitute for running it, and an argument about behaviour never outranks an observation of it. Deliberation that could have been a ten-line test is the most expensive habit in this process, because it produces confident conclusions with nothing underneath them.

- **Write the probe before the argument gets long.** The moment a claim about behaviour is in dispute — between engines, between a report and a rule, or inside your own head — stop and run it. Get the smallest real input through the real code and read the real output. Two competing explanations of what a function does are worth less than one observation of what it did.
- **Bound the search before you start it, and put the bound in the brief.** An investigation with no stated stopping condition does not converge, it just runs until attention runs out. Name the benchmark, the population, or the row that ends it, and stop when the evidence meets it — including when the honest answer is that the limit is inherent and belongs in documentation rather than in code.
- **A negative probe is evidence about the probe until its input is shown to reach the code under test.** A pass proves nothing if the vector never arrived; instrument the path, assert an observable side effect, or drive it through a door you can see. Treating a failed reproduction as a disproof discards real defects, and it is the single most common way a true finding is lost. When a report names a defect and your reproduction comes back clean, the first hypothesis is that your input was weaker than theirs — go get their exact vector before you doubt the finding. A reported defect whose construction you have not run is not yet a finding you can dismiss.
- **A tool's failure to find your probe is not a result.** "No tests found", an empty match, a skipped file, a runner that resolved nothing — these report on the harness, not the subject. Confirm the probe was collected and executed before reading anything into what it did or did not show.
- **An observation beats a derivation, including your own.** When a measurement and an argument disagree, the argument is wrong until the measurement is shown to be broken. Diagnose from the artifact the work actually produces — the file, the count, the exit code, the timestamp on what changed — never from a wrapper or a proxy signal that merely correlates with progress.
- **What a round proves is what it ran.** A conclusion carried from one door to another is a hypothesis at the second door. Re-run it there.

## Falsification

A review that reads a diff finds what the diff shows; a review that tries to break named claims finds what the diff hides. Code that has already passed diff review several times can still carry a defect nobody has yet tried to trigger.

- State an audit's subject as a numbered list of the claims the work makes, never as “review this diff”. Each claim is falsifiable: a property some concrete input, state, or interleaving could show false.
- Instruct the auditor to attempt refutation rather than confirmation. A claim it cannot break is reported CONFIRMED with the evidence that convinced it; a claim it breaks is reported BROKEN with the exact failing input, state, or interleaving, plus the smallest correct fix.
- Derive claims from what the change asserts under adverse conditions: cancellation, restart, concurrency, partial failure, hostile input, resource exhaustion, and the orderings a happy path never reaches.
- Read the installed declaration or implementation of every substrate a claim depends on. A claim about `stop()` is unfalsifiable until you know what `stop()` does when the status is not the one the caller assumed.
- An audit returning only confirmations puts the brief on trial rather than the subject. It is a legitimate result, not a presumptive failure: telling an auditor that a clean round means it did not try is an instruction to manufacture a finding, and a manufactured finding costs a fix unit, an argument, and the credibility of the true findings beside it. Instead re-read the claims and ask whether any could have been falsified by evidence the round actually had. If none could, the claims were descriptive and the round proved nothing — sharpen them and re-run. If they could have been and were not, the pass stands. Name the claims you could not break either way, so the next round knows what has already been attacked.
- A repaired claim is a new claim, not a settled one. Re-ask it at every entry point that reaches the same rule, not only the door the defect arrived through. A fix verified where it was found and assumed everywhere else ships the defect at every other door — and the engine that wrote the fix is the least able to see this, because re-verifying where the fix is feels like verifying the fix.
- An instrument is not evidence until it has failed. A probe, comparison, or matrix that has never produced its failing verdict cannot tell a sound subject from a broken tool. Pair it with a negative control that must report failure, run under the same conditions. An identity check whose control reports “same” has measured nothing.
- A negative control drawn from the same population as the subject cannot find a gap in the population boundary. Controls sampled from the constructs an instrument already handles prove it discriminates among those constructs and say nothing about the class it silently cannot reach. Name the instrument's membership rule, draw a control from outside the population that rule defines, and state what the controls established and what they did not. An instrument certified only from the inside is trusted exactly where it has never been tested.
- An instrument that settled a claim is adopted as a test before the work it settled is accepted. The probe that proved a fix, carrying the negative control that proved the probe, is that fix's regression guard; leaving it in a scratch directory discards the most expensive evidence of the round and guarantees the next round re-derives it. A verification that runs once is a rehearsal, not a gate.
- Reachability bounds the fix. A defect reachable through the package's own shipped code or a documented extension seam falsifies its claim and is repaired now. A defect reachable only through a hypothetical foreign implementation of a contract this package publishes is a gap in how that contract is stated: document the obligation on the interface that owns it and prove the documentation, rather than building coordination machinery to defend against a requirement nobody wrote down. Attacks are unlimited; reachable ones are not, and only the reachable set is a work list.
- Repeated rounds against one seam are evidence about the design, not evidence of diligence. When each repair produces the next defect at the same seam, stop repairing and rule on the model: the escalation is a redesign decision, taken with the same adversarial pass a design gets, not another round. **Three rounds at one seam is the budget.** At the third, the next unit is the ruling — on the threat model, the mechanism, or the boundary — not a fourth repair. Write the number down when the seam opens so the count is a fact rather than a feeling; a seam that has consumed more rounds than the rest of the matrix combined has already answered the question.
- An auditor that cannot execute cannot falsify a behavioural claim. A read-only lens dispatched without a way to run the code returns derivations, and a derivation reads exactly like a verdict while being a different thing entirely — it will confirm a claim that one probe would break. Give every behavioural audit the means to run its attacks, and treat a report with no executed evidence as a review of the source, labelled as such.

## Ecosystem reuse

The root laws on inspecting declared `@orkestrel/*` capabilities, reusing a matching primitive, and updating every consumer without shims bind here without restatement. They leave this file the judgment calls:

- Prove the semantic difference before keeping a local variant; similar names are not evidence of different behavior.
- Downstream friction is valid evidence of a reusable upstream defect, not automatic proof. Fix the lowest package that owns the general mechanism and keep product policy downstream.
- Never re-export a dependency's symbol to soften a consumer's import.

## Production hardening

- Translate “enterprise-grade” or “production-ready” into an explicit risk/seam matrix covering applicable inputs, states, failures, cleanup, cancellation, concurrency, resource ownership, hostile boundaries, environment isolation, serialization/restore, and package consumption.
- Grade that matrix on coverage, not optimization: whether every applicable seam exists, works, and stays proven — not how many further interleavings can be invented against the one seam already proven. “Enterprise-grade” is breadth of proven capability, and a surface polished past its row buys less than the next uncovered seam would have.
- Test observable invariants at each applicable seam with real implementations.
- Use dedicated real-service projects for external model/service behavior. Require readiness and tune each request to the smallest robust proof.
- Audit test discovery, counts, skipped/todo tests, cleanup, and assertion adequacy; passing discovered tests alone is insufficient.
- Inspect public exports, declarations, supported runtime targets, and generated outputs.
- A claim that a surface works with an external client stays unproven until one representative real client of that class has driven it end to end. Protocol tests prove the protocol, not the integration.
- Add an independent adversarial review for security, destructive paths, concurrency, protocols, or untrusted external input.

## Completion

The root completion law — finish every in-scope capability now, leave no TODO, deferral, or hidden follow-up, and run the applicable repository skill for comprehensive work — binds here without restatement. It leaves this file three obligations:

- Perform a final centralization/wrapper/test-helper/text-integrity sweep after implementation and before gates.
- Local quality gates and relevant output inspection are required evidence.
- Stop once the enumerated scope is closed and those gates are green. Stopping there is the correct action and the next scope is the deliverable; a further pass over the same surface requires a new instruction from the user, not an auditor's remaining appetite. Depth is owed to what the scope names, not to what an engine can still imagine about it.
