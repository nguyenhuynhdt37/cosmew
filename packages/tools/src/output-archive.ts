import {createHash} from 'node:crypto';
import {sandboxConfig, type ToolDispatcherOptions} from './context';
/** Both revocations and effective policy changes permanently invalidate earlier evidence. */
export function outputPermissionContext(options: ToolDispatcherOptions): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        options.outputArchive?.permissionContext(),
        options.outputArchive?.policy?.(),
        options.grants.scopeId,
        options.grants.generation,
        sandboxConfig(options),
        options.analysisOnly?.() ?? false,
      ]),
    )
    .digest('hex');
}
