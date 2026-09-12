/** Which terminal registration a record is written under. */
export interface TerminalContext {
  readonly terminalCode: string;
  readonly epoch: number;
}
