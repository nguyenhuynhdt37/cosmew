import type {AgentTypesReport, SubagentSummaryView} from '@futryn/contracts';

export interface AgentsState {
  report: AgentTypesReport;
  children: SubagentSummaryView[];
  /** Selected child (rows of agent types are informational). */
  index: number;
  /** Transcript of the opened child, one display line per entry; empty when the list is shown. */
  detail: string[];
  detailTitle: string;
  offset: number;
  message: string;
}
