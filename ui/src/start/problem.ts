import { ContractError } from './contract-guards';

/** A host call that failed, as the one plain sentence the page shows for it. */
export function problemText(err: unknown): string {
  if (err instanceof ContractError) {
    return `The app and its start screen disagree (${err.message}). Reinstalling FluidCAD fixes this.`;
  }
  return `Something went wrong: ${err instanceof Error ? err.message : String(err)}`;
}

/** What the page says when its host speaks another protocol. */
export const PROTOCOL_MISMATCH = 'This start screen does not match the app. Reinstalling FluidCAD fixes this.';
