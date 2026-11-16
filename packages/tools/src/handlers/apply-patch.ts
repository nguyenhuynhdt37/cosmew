import {z} from 'zod';
import {WriteBoundaryError} from '@futryn/workspace';
import type {ToolDispatcherOptions,ToolOutput} from '../context';
import {PatchError,parsePatch} from '../patch/parser';
import {ApplyPatchRuntime} from '../runtimes/apply-patch';
import type {ToolHandler,PreparedTool} from './types';
export const applyPatchDescriptor={name:'apply_patch',description:'Apply a Codex-format patch to UTF-8 workspace files after approval. Provide the entire *** Begin Patch / *** End Patch text in patch. Supports Add File, Update File with @@ contextual hunks, Delete File and Update File with Move to. Protected paths are denied; stale files are not overwritten. Results report actual changes and any partial failure. No shell or native runtime writes.',capability:'fs.write' as const,inputSchema:{type:'object',properties:{patch:{type:'string',description:'The complete Codex patch text.'}},required:['patch'],additionalProperties:false}};
const input=z.strictObject({patch:z.string().min(1).max(65536)});
export class ApplyPatchHandler implements ToolHandler {
 readonly descriptor=applyPatchDescriptor;
 readonly unavailable:ToolOutput={status:'error',code:'WRITE_UNAVAILABLE',content:'Safe directory-relative writes are unavailable on this host.'};
 private readonly runtime:ApplyPatchRuntime;
 constructor(options:ToolDispatcherOptions){this.runtime=new ApplyPatchRuntime(options);}
 available():boolean{return this.runtime.available();}
 prepare(args:unknown):PreparedTool|ToolOutput{
  const parsed=input.safeParse(args);if(!parsed.success)return{status:'error',code:'INVALID_INPUT',content:'apply_patch requires a JSON object with one patch string.'};
  try{
   const plan=this.runtime.verify(parsePatch(parsed.data.patch));
   return{kind:'patch',plan,runtime:this.runtime,execute:signal=>this.runtime.apply(plan,signal)};
  }catch(error){
   if(error instanceof WriteBoundaryError)return{status:'denied',code:'DENIED',content:'Patch rejected by the workspace write boundary ('+error.code+'). No changes were made.'};
   if(error instanceof PatchError)return{status:'error',code:error.code,content:error.message};
   return{status:'error',code:'PATCH_VERIFY_FAILED',content:'The patch could not be verified. No changes were made.'};
  }
 }
}
