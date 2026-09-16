// Shared types and agent verdict schemas.

export interface LoopState {
  strikes: number;
  decidedAt: string | null;
  reason: string | null;
  mode: 'decision' | 'strikes';
  activity: string | null;
}

export interface Repo {
  owner: string;
  name: string;
  fullName: string;
}

export interface IssueComment {
  by: string;
  at: string;
  body: string;
}

export interface IssueInfo {
  number: number;
  title: string;
  updatedAt: string;
  body: string;
  comments: IssueComment[];
}

export interface PrInfo {
  number: number;
  title: string;
  headRefName: string;
  updatedAt: string;
}

export interface PendingReviewFeedback {
  pr: number;
  reviews: { author: string; comments: { body: string; path: string; line: number | null }[] }[];
}

export interface PlanDoc {
  issue: number;
  file: string;
  content: string;
}

export interface PassSnapshot {
  gatheredAt: string;
  issues: IssueInfo[];
  openPrs: PrInfo[];
  pendingReviewComments: PendingReviewFeedback[];
  planDocs: PlanDoc[];
}

export type TriageVerdict = { kind: 'issue'; issue: number } | { kind: 'none' };
export type LoopDecisionVerdict = { decision: 'CONTINUE' | 'END'; reason?: string };


export const TRIAGE_SCHEMA = '{"kind":"issue","issue":<number>} or {"kind":"none"}';
export const LOOP_DECISION_SCHEMA =
  '{"decision":"CONTINUE"} or {"decision":"END","reason":"<short reason>"}';

export interface TicketPayload {
  number: number;
  title: string;
  state: string;
  body: string;
  updatedAt: string;
  comments: { by: string; at: string; body: string }[];
}
