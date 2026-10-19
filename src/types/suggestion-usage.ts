/** Safe renderer/main-process read model for project-scoped suggestion feedback. */

export const UNATTRIBUTED_SCOPE_ID = 'unattributed-legacy';

export interface SuggestionUsagePartition {
  /** item key (type/id) → term → co-occurrence count */
  weights: Record<string, Record<string, number>>;
  /** Bounded log of learning events, for inspection. IDs and times only. */
  recent: Array<{ at: number; key: string }>;
}

export interface SuggestionUsageState {
  version: 2;
  /** New feedback is isolated by the project's stable id. */
  projects: Record<string, SuggestionUsagePartition>;
  /** Version-1 global feedback remains inspectable and is never scored. */
  legacy: SuggestionUsagePartition;
}

export interface SuggestionUsageItemSummary {
  id: string;
  key: string;
  type: string;
  itemId: string;
  name: string;
  projectId: string;
  projectName: string;
  weight: number;
  topTerms: Array<{ term: string; count: number }>;
  recent: number[];
}

export interface SuggestionUsageSummary {
  /** All learned items across projects and the visible legacy partition. */
  items: SuggestionUsageItemSummary[];
  /** Known projects plus any project IDs retained after project deletion. */
  projects: Array<{ id: string; name: string; items: number; totalWeight: number }>;
  /** Σ of all co-occurrence counts across items. */
  totalWeight: number;
}
