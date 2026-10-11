import { untrustedText, type UntrustedText } from '@healer/domain-knowledge';
import {
  byExternalRef,
  compareStrings,
  SHA_SHAPE,
  structuralRef,
  type KnowledgeDocumentCandidate,
} from '../knowledge-candidate.js';

const IID_SHAPE = /^\d{1,12}$/;
const KEY_SHAPE = /^(?:[A-Za-z][A-Za-z0-9_]{0,31}-)?\d{1,12}$/;
const APPROVAL_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Read-only ports for git history, merge requests and issues. No approve / merge / comment / write
 * method exists on any of them: Healer's credential holds no approval permission (R-02), so the
 * port makes approving unrepresentable. `ports-read-only.test.ts` pins the key sets.
 */
export interface RawCommit {
  readonly sha: string;
  readonly authorRef: string;
  readonly committedAt: Date;
  readonly message: string;
}
export interface GitHistoryReader {
  listCommits(signal?: AbortSignal): Promise<readonly RawCommit[]>;
}

export interface MergeRequestApproval {
  readonly approvalId: string;
  /** Plain identity reference. Whether it is Healer's own is decided by T029, not here. */
  readonly approverRef: string;
}
export interface RawMergeRequest {
  readonly iid: string;
  readonly title: string;
  readonly description: string;
  readonly state: 'opened' | 'merged' | 'closed';
  readonly mergeCommitSha: string | null;
  readonly approvals: readonly MergeRequestApproval[];
}
export interface MergeRequestReader {
  listMergeRequests(signal?: AbortSignal): Promise<readonly RawMergeRequest[]>;
}

export interface RawIssue {
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: string;
}
export interface IssueReader {
  listIssues(signal?: AbortSignal): Promise<readonly RawIssue[]>;
}

export interface CommitCandidate extends KnowledgeDocumentCandidate {
  readonly lastCommit: {
    readonly sha: string;
    readonly authorRef: string;
    readonly committedAt: Date;
  };
}
export interface MergeRequestCandidate extends KnowledgeDocumentCandidate {
  readonly state: RawMergeRequest['state'];
  readonly mergeCommitSha: string | null;
  readonly approvals: readonly MergeRequestApproval[];
}
export interface IssueCandidate extends KnowledgeDocumentCandidate {
  readonly acceptanceCriteria: UntrustedText;
}

const firstLine = (s: string): string => s.split('\n', 1)[0] ?? '';

// ponytail: commits map to documentClass 'design_doc' (data-model has no commit class); revisit if 005 adds one.
export function mapCommits(commits: readonly RawCommit[]): CommitCandidate[] {
  return commits
    .map((c) => ({
      sourceKind: 'git_history' as const,
      documentClass: 'design_doc' as const,
      externalRef: structuralRef('commit sha', c.sha, SHA_SHAPE),
      title: untrustedText(firstLine(c.message)),
      body: untrustedText(c.message),
      lastCommit: { sha: c.sha, authorRef: c.authorRef, committedAt: c.committedAt },
    }))
    .sort(byExternalRef);
}

export function mapMergeRequests(mrs: readonly RawMergeRequest[]): MergeRequestCandidate[] {
  return mrs
    .map((m) => ({
      sourceKind: 'merge_request' as const,
      documentClass: 'merge_request' as const,
      externalRef: structuralRef('merge request iid', m.iid, IID_SHAPE),
      title: untrustedText(m.title),
      body: untrustedText(m.description),
      state: m.state,
      mergeCommitSha:
        m.mergeCommitSha === null
          ? null
          : (structuralRef('merge commit sha', m.mergeCommitSha, SHA_SHAPE) as string),
      approvals: m.approvals
        .map((a) => {
          structuralRef('approval id', a.approvalId, APPROVAL_ID_SHAPE);
          return a;
        })
        .sort((a, b) => compareStrings(a.approvalId, b.approvalId)),
    }))
    .sort(byExternalRef);
}

export function mapIssues(issues: readonly RawIssue[]): IssueCandidate[] {
  return issues
    .map((i) => ({
      sourceKind: 'ticket' as const,
      documentClass: 'ticket' as const,
      externalRef: structuralRef('issue key', i.key, KEY_SHAPE),
      title: untrustedText(i.title),
      body: untrustedText(i.description),
      acceptanceCriteria: untrustedText(i.acceptanceCriteria),
    }))
    .sort(byExternalRef);
}
