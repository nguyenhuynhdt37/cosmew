import {z} from 'zod';
import type {ToolDispatcherOptions} from '../context';
import {outputPermissionContext} from '../output-archive';
import {clipBytes} from '../limits';
import type {ToolHandler} from './types';
const schema = z.strictObject({
  output_id: z.string().uuid(),
  offset: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024)
    .default(0),
  limit: z.number().int().min(1).max(10000).default(8000),
  query: z.string().min(1).max(500).optional(),
});
export function toolOutputHandler(options: ToolDispatcherOptions): ToolHandler {
  return {
    descriptor: {
      name: 'tool_output',
      capability: 'agent.state',
      parallel: true,
      description:
        'Retrieve redacted captured evidence by output_id without repeating the original tool. Optional literal query searches from offset. Offsets count Unicode code points; limit is UTF-8 bytes (max 10000). Coverage and next_offset describe the captured output only; missing/expired artifacts cannot be recovered.',
      inputSchema: {
        type: 'object',
        properties: {
          output_id: {type: 'string'},
          offset: {type: 'integer', minimum: 0},
          limit: {type: 'integer', minimum: 1, maximum: 10000},
          query: {type: 'string'},
        },
        required: ['output_id'],
        additionalProperties: false,
      },
    },
    available: () => !!options.outputArchive,
    prepare(input) {
      const parsed = schema.safeParse(input);
      if (!parsed.success)
        return {
          status: 'error',
          code: 'INVALID_INPUT',
          content:
            'Expected output_id, non-negative offset, limit 1..10000 and optional literal query (1..500 characters).',
        };
      const config = options.outputArchive!,
        scope = config.scope();
      let artifact;
      try {
        artifact = config.store.get(scope, parsed.data.output_id);
      } catch {
        return {
          status: 'error',
          code: 'OUTPUT_UNAVAILABLE',
          content: 'Archived output storage is unavailable. The original operation was not repeated.',
        };
      }

      if (!artifact)
        return {
          status: 'error',
          code: 'OUTPUT_UNAVAILABLE',
          content: 'Output is missing, expired, evicted or belongs to another session/workspace.',
        };
      const valid = () =>
        artifact.permissionContext === outputPermissionContext(options) &&
        JSON.stringify(config.scope()) === JSON.stringify(scope);
      const source = artifact.source;
      return {
        kind: 'output',
        source,
        valid,
        execute(signal) {
          signal?.throwIfAborted();
          if (!valid())
            return {
              status: 'denied',
              code: 'DENIED',
              content:
                'Output access was invalidated by changed permissions, revoked grants or session/workspace identity.',
            };
          // New secrets may have been registered since capture. Offsets refer to this current redacted view.
          const text = options.redact(artifact.content),
            chars = Array.from(text),
            data = parsed.data;
          let start = Math.min(data.offset, chars.length);
          if (data.query) {
            const prefix = chars.slice(0, start).join('');
            const found = text.indexOf(data.query, prefix.length);
            start = found < 0 ? chars.length : Array.from(text.slice(0, found)).length;
          }
          let page = clipBytes(chars.slice(start).join(''), data.limit).text;
          if (!page && start < chars.length)
            return {
              status: 'error',
              code: 'OUTPUT_PAGE_TOO_SMALL',
              content: 'The byte limit cannot hold the next Unicode character. Retry with limit at least 4.',
            };
          const end = start + Array.from(page).length;
          const metadata = {
            output_id: artifact.outputId,
            source,
            offset_unit: 'unicode_code_points',
            view: 'currently_redacted_capture',
            coverage: {start, end, total: chars.length},
            next_offset: end < chars.length ? end : null,
            ...(data.query ? {query: data.query, search_from: data.offset, found: start < chars.length} : {}),
            source_truncated: artifact.sourceTruncated,
            note: artifact.sourceTruncated
              ? 'Captured output is truncated; omitted producer/process bytes are unavailable.'
              : 'Coverage describes captured output, not a fresh source read.',
          };
          let header = JSON.stringify(metadata);
          // Bound the entire result including escaped metadata, not merely its evidence body.
          while (Buffer.byteLength(header) + 1 + Buffer.byteLength(page) > 12288 && page.length) {
            page = clipBytes(page, Math.max(0, 12288 - Buffer.byteLength(header) - 1)).text;
            metadata.coverage.end = start + Array.from(page).length;
            metadata.next_offset = metadata.coverage.end < chars.length ? metadata.coverage.end : null;
            header = JSON.stringify(metadata);
          }
          return {status: 'ok', content: header + '\n' + page};
        },
      };
    },
  };
}
