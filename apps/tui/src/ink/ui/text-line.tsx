/** @jsxImportSource react */
import {Box, Text, type TextProps} from 'ink';
/** Strip terminal commands and control bytes before they reach Ink. Preserve text newlines. */
export function safeText(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\t/g, '    ');
}
export interface TextLineProps extends Omit<TextProps, 'children'> {
  children: string;
  width?: number;
}
/** Ink owns grapheme/cell measurement and ANSI-aware wrapping (string-width/wrap-ansi). */
export function TextLine({children, width, ...props}: TextLineProps) {
  return (
    <Box width={width === undefined ? undefined : Math.max(1, width)} minWidth={0}>
      <Text {...props} wrap={props.wrap ?? 'wrap'}>
        {safeText(children)}
      </Text>
    </Box>
  );
}
