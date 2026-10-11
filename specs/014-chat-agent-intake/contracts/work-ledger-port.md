# Contract: `WorkLedger` port

Where a work item of kind `fix`, `task` or `finding` is recorded for humans (FR-022, research R-02).
GitHub Issues first; a Healer issue on Healer's own tenant mirrors it later (012 T101) behind the
same port. Declared in `packages/domain/intake/src/domain/work-ledger.ts`; adapter in
`packages/integrations/src/github/`.

## Port

```ts
interface WorkLedger {
  readonly name: string;                                    // prefix of work_item.ledger_ref
  findIssue(number: number): Promise<LedgerIssue | null>;
  createIssue(input: { label: LedgerLabel; title: string; body: string }): Promise<LedgerIssue>;
  comment(ref: string, body: string): Promise<void>;        // report overflow (FR-024)
  readTask(taskId: string): Promise<TaskLine | null>;       // default branch, read only
  resolveRef(ref: EvidenceRef): Promise<boolean>;           // research R-10: exists, not "supports"
}

type LedgerLabel = 'bug' | 'agent-task' | 'finding';
interface LedgerIssue { ref: string; number: number; url: string; open: boolean }
interface TaskLine    { taskId: string; specDir: string; ticked: boolean }
```

`EvidenceRef` is the `ref` union of the investigation report ([executor-port.md](executor-port.md)).

## Rules

- **Never writes a task line.** `readTask` reads `specs/*/tasks.md` on the default branch; there is
  no method that edits a file. Specifications are protected paths (ADR 0011), and a task identifier
  that does not exist on the default branch is `task_not_found`.
- **Titles and bodies are built by the intake**, from the work item's typed fields and the post as a
  quoted data block, length-capped and secret-scanned like a report (research R-10). The post's text
  never chooses the label.
- **Labels are a closed list** — the type above. `needs-decision` is applied by the change workflow
  to its own draft pull request (012 R-16), not by the ledger.
- The ledger's credential is the control plane's dispatcher credential (`issues: write`,
  `contents: read`; research R-06). It holds no `contents: write`, no merge and no administration
  right (FR-011).

## Contract suite

Against a fake and the GitHub adapter (recorded fixture server): `findIssue` of a missing number is
`null`; `createIssue` applies exactly one label from the closed list; `readTask` reports a ticked
line as `ticked` and a missing one as `null`; `resolveRef` is `false` for a file absent at the cited
commit and for a run, issue or pull request of another repository.
