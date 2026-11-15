export type ReportKind = 'status' | 'usage' | 'context';

export interface ReportState {
  /** First visible wrapped row. */
  offset: number;
  /** Show the full breakdown instead of the summary. */
  details: boolean;
}

export const REPORT_TITLES: Record<ReportKind, string> = {
  usage: 'Session usage',
  context: 'Context window',
  status: 'Session status',
};
