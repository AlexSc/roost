// A linked issue closure — `closingIssuesReferences` can cross repos, so each
// entry carries its own repo. Routing slugs the channel per linked issue's
// repo, not the PR's repo.
export interface LinkedIssue {
  repo: string
  number: number
}

export interface PrSnap {
  repo: string
  number: number
  title: string | null
  url: string | null
  head_ref: string | null
  head_oid: string | null
  is_draft: boolean
  merged: boolean
  state: string | null
  labels: string[]
  ci_state: string | null
  linked_issues: LinkedIssue[]
  seen_review_comment_ids: number[]
  seen_conversation_comment_ids: number[]
  seen_review_ids: number[]
  // Mute flag: set after pr_no_linked_issues warning, cleared when
  // linked_issues becomes non-empty so a subsequent loss re-warns.
  // Absent in old snapshots (pre-upgrade) — !undefined is true, so upgrade
  // path warns on first tick without any special handling.
  warned_no_linked?: boolean
  // Mute key for cross-repo drop stderr warnings: the head_oid we last
  // warned about. Mirrors `warned_no_linked` but keyed on head_oid because
  // closing references are re-fetched on head_oid change (see scraper.ts),
  // so a force-push that changes closures should re-trigger the warning.
  warned_drops_for_oid?: string | null
}

export interface IssueSnap {
  repo: string
  number: number
  title: string | null
  url: string | null
  state: string | null
  labels: string[]
  seen_comment_ids: number[]
}

export interface PrPluginState {
  prs: Record<string, PrSnap>
}

export interface IssuePluginState {
  issues: Record<string, IssueSnap>
}
