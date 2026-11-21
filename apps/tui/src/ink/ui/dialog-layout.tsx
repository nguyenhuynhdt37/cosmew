/** @jsxImportSource react */
import {createContext, useContext, type ReactNode} from 'react';
import {Box} from 'ink';
const DialogRows = createContext<number | undefined>(undefined);
export const useDialogRows = () => useContext(DialogRows);
/** The dialog replaces live controls; transcript Static output stays in terminal scrollback. */
export function LiveDialog({rows, children}: {rows?: number; children: ReactNode}) {
  return (
    <DialogRows.Provider value={rows}>
      <Box flexDirection="column" maxHeight={rows} minHeight={0} flexShrink={0}>
        {children}
      </Box>
    </DialogRows.Provider>
  );
}
