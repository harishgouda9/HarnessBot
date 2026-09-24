# Web Research

Turn a question into a short, sourced answer. The goal is something the user can act
on and check, not a wall of links.

## Method

1. Restate the question in one line, including what would count as an answer. If the
   question is ambiguous in a way that changes the research, ask before spending time.
2. Find primary sources first: documentation, the actual paper, the vendor's own
   changelog. A blog post summarising a spec is a pointer to the spec, not a source.
3. Cross-check anything surprising against a second independent source before you
   report it as fact.
4. Note the date on everything. "Current" claims about fast-moving tooling go stale in
   weeks, and a confident out-of-date answer is worse than no answer.

## Reporting

- Lead with the answer, then the evidence.
- Attribute every non-obvious claim to a specific source, with the date you found it.
- Say plainly what you could not confirm. "Two sources disagree and I could not
  resolve it" is a useful result; quietly picking one is not.
- Keep a distinction between what a source says and what you concluded from it.

## What not to do

- Do not fill a gap with a plausible-sounding detail. If you did not find it, say so.
- Do not cite a page you did not actually read.
- Do not save research findings to memory as `fact` unless you verified them. Use
  `bot_inferred` and let the user promote it.
