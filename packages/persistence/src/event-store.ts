import type { Database } from 'bun:sqlite';
import { FutrynError, activeTaskCheckpointSchema, contextSnapshotSchema, executionEventDataSchema, turnStateSchema,
  type ActiveTaskCheckpoint, type ContextSnapshot, type ConversationEvent, type DurableTurn, type ExecutionEventData,
  type Message, type RecoveredConversation, type StoredMessage, type TurnState } from '@futryn/contracts';
const owner = crypto.randomUUID();
interface Row {id:string;user_revision:number;end_revision:number|null;state:string;owner_pid:number;owner:string}
const alive = (pid:number) => {try {process.kill(pid,0);return true;}catch(error){return (error as {code?:string}).code!=='ESRCH';}};

/** SQLite owns ordered execution evidence. Reading it never invokes a tool or restores a grant. */
export class ExecutionJournal {
  constructor(private readonly db:Database,private readonly redact:(value:string)=>string) {}
  private clean(value:unknown):unknown {
    if(typeof value==='string')return this.redact(value);
    if(Array.isArray(value))return value.map(v=>this.clean(v));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,this.clean(v)]));
    return value;
  }
  private append(id:string,turnId:string,event:ExecutionEventData):number {
    const data=executionEventDataSchema.parse(this.clean(event));
    const seq=(this.db.query('SELECT COALESCE(MAX(seq),0)+1 AS n FROM conversation_events WHERE conversation=?').get(id) as {n:number}).n;
    this.db.query('INSERT INTO conversation_events VALUES(?,?,?,?,?)').run(id,seq,turnId,new Date().toISOString(),JSON.stringify(data));
    return seq;
  }
  /** A live owner cannot be stolen, even by another client in the same process. */
  claim(id:string,turnId:string,revision:number,user:Message):void {
    this.abandonDead(id);
    if(this.db.query("SELECT 1 FROM execution_turns WHERE conversation=? AND state IN ('pending','running')").get(id))throw new FutrynError('POLICY');
    this.db.query("INSERT INTO execution_turns VALUES(?,?,?,NULL,'pending',?,?)").run(id,turnId,revision,process.pid,owner);
    this.append(id,turnId,{type:'user.accepted',message:user});
  }
  record(id:string,turnId:string,event:ExecutionEventData):number {
    try{return this.db.transaction(()=>{
      if(event.type==='user.accepted'||event.type==='turn.finished')throw new FutrynError('STORAGE');
      const row=this.db.query('SELECT * FROM execution_turns WHERE conversation=? AND id=?').get(id,turnId) as Row|null;
      if(!row||row.owner!==owner||!['pending','running'].includes(row.state))throw new FutrynError('STORAGE');
      if(event.type==='model.requested')this.db.query("UPDATE execution_turns SET state='running' WHERE conversation=? AND id=?").run(id,turnId);
      return this.append(id,turnId,event);
    }).immediate();}catch(e){if(e instanceof FutrynError)throw e;throw new FutrynError('STORAGE');}
  }
  finish(id:string,revision:number,state:TurnState,errorCode?:string):void {
    const row=this.db.query('SELECT * FROM execution_turns WHERE conversation=? AND user_revision=?').get(id,revision) as Row|null;
    if(!row)return; // v1-v3 and custom legacy stores remain readable.
    if(!['pending','running'].includes(row.state)||!['completed','failed','cancelled','interrupted'].includes(state))throw new FutrynError('STORAGE');
    const current=(this.db.query('SELECT revision FROM conversations WHERE id=?').get(id) as {revision:number}).revision;
    this.db.query('UPDATE execution_turns SET state=?,end_revision=? WHERE conversation=? AND id=?').run(state,current,id,row.id);
    this.append(id,row.id,{type:'turn.finished',state,...(errorCode?{errorCode}:{})});
  }
  private abandonDead(id:string):void {
    const rows=this.db.query("SELECT * FROM execution_turns WHERE conversation=? AND state IN ('pending','running')").all(id) as Row[];
    for(const row of rows)if(row.owner!==owner&&!alive(row.owner_pid)){
      this.finish(id,row.user_revision,'interrupted','PROCESS_EXIT');
      this.db.query("UPDATE messages SET state='interrupted' WHERE conversation=? AND revision=? AND state='pending'").run(id,row.user_revision);
      const receipt=this.db.query('SELECT data FROM turn_receipts WHERE conversation=? AND revision=?').get(id,row.user_revision) as {data:string}|null;
      if(receipt){const data=JSON.parse(receipt.data);data.outcome='interrupted';data.finishedAt=new Date().toISOString();data.stopReason='failed';this.db.query('UPDATE turn_receipts SET data=? WHERE conversation=? AND revision=?').run(JSON.stringify(data),id,row.user_revision);}
    }
  }
  task(id:string,task:ActiveTaskCheckpoint):void {
    const data=activeTaskCheckpointSchema.parse(this.clean(task));
    this.db.query('INSERT INTO conversation_checkpoints(conversation,task) VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET task=excluded.task').run(id,JSON.stringify(data));
  }
  snapshot(id:string,snapshot:ContextSnapshot):void {
    const data=contextSnapshotSchema.parse(this.clean(snapshot));
    this.db.query('INSERT INTO conversation_checkpoints(conversation,context) VALUES(?,?) ON CONFLICT(conversation) DO UPDATE SET context=excluded.context').run(id,JSON.stringify(data));
  }
  recover(id:string,legacy:StoredMessage[]):RecoveredConversation {
    try{return this.db.transaction(()=>{
      this.abandonDead(id);
      const rows=this.db.query('SELECT * FROM execution_turns WHERE conversation=? ORDER BY user_revision').all(id) as Row[];
      const records=this.db.query('SELECT seq,turn_id,at,data FROM conversation_events WHERE conversation=? ORDER BY seq').all(id) as {seq:number;turn_id:string;at:string;data:string}[];
      const turns:DurableTurn[]=rows.map(row=>({id:row.id,userRevision:row.user_revision,state:turnStateSchema.parse(row.state),events:[]}));
      const byId=new Map(turns.map(t=>[t.id,t]));
      for(const [index,row]of records.entries()){
        const turn=byId.get(row.turn_id);if(row.seq!==index+1||!turn)throw new FutrynError('STORAGE');
        const event:ConversationEvent={seq:row.seq,turnId:row.turn_id,at:row.at,data:executionEventDataSchema.parse(JSON.parse(row.data))};turn.events.push(event);
      }
      const messages:Message[]=[];let cursor=0;
      for(const [index,row]of rows.entries()){
        while(cursor<legacy.length&&legacy[cursor]!.revision<row.user_revision){const {revision:_r,state:_s,...message}=legacy[cursor++]!;messages.push(message);}
        const turn=turns[index]!;if(turn.events[0]?.data.type!=='user.accepted'||row.user_revision<1||(row.end_revision!==null&&row.end_revision<row.user_revision))throw new FutrynError('STORAGE');
        const calls=new Map<string,string>(),intents=new Set<string>(),results=new Set<string>();let finished=false;
        for(const [position,event]of turn.events.entries()){
          const e=event.data;if(finished||!Number.isFinite(Date.parse(event.at)))throw new FutrynError('STORAGE');
          if(e.type==='user.accepted'&&(position!==0||e.message.role!=='user'||e.message.toolCalls?.length||e.message.toolCallId))throw new FutrynError('STORAGE');
          if(e.type==='tool.call'){if(calls.has(e.call.id))throw new FutrynError('STORAGE');calls.set(e.call.id,e.call.name);}
          if(e.type==='tool.intent'){if(!calls.has(e.callId)||intents.has(e.callId)||results.has(e.callId))throw new FutrynError('STORAGE');intents.add(e.callId);}
          if(e.type==='tool.result'){if(calls.get(e.result.callId)!==e.result.name||results.has(e.result.callId))throw new FutrynError('STORAGE');results.add(e.result.callId);}
          if(e.type==='turn.finished'){if(e.state!==turn.state||['pending','running'].includes(e.state))throw new FutrynError('STORAGE');finished=true;}
        }
        if(finished===['pending','running'].includes(turn.state))throw new FutrynError('STORAGE');
        let text='';const flush=()=>{if(text){messages.push({role:'assistant',content:text});text='';}};
        for(const event of turn.events){const e=event.data;
          if(e.type==='assistant.text')text+=e.text;
          else if(e.type==='user.accepted'){flush();messages.push(e.message);}
          else if(e.type==='tool.call'){flush();messages.push({role:'assistant',content:'',toolCalls:[e.call]});}
          else if(e.type==='tool.result'){flush();messages.push({role:'tool',content:e.result.status==='ok'?e.result.content||'(empty)':`[${e.result.status}${e.result.code?': '+e.result.code:''}] ${e.result.content}`,toolCallId:e.result.callId,toolName:e.result.name});}
          else if(e.type==='model.requested')flush();
        }flush();
        if(!['pending','running'].includes(turn.state)){
          const attempted=new Set(turn.events.flatMap(e=>e.data.type==='tool.intent'?[e.data.callId]:[]));
          const results=new Set(turn.events.flatMap(e=>e.data.type==='tool.result'?[e.data.result.callId]:[]));
          for(const event of turn.events)if(event.data.type==='tool.call'&&!results.has(event.data.call.id)){
            const call=event.data.call;
            messages.push({role:'tool',toolCallId:call.id,toolName:call.name,content:attempted.has(call.id)?'[unknown: interrupted execution] Intent was recorded but no result was confirmed. Inspect current filesystem state; do not replay or reuse an old approval.':'[not executed] The turn ended before Futryn dispatched this call. A new call requires current policy and fresh revalidation.'});
          }
        }
        const end=row.end_revision??((rows[index+1]?.user_revision??Infinity)-1);
        while(cursor<legacy.length&&legacy[cursor]!.revision<=end)cursor++;
      }
      while(cursor<legacy.length){const {revision:_r,state:_s,...message}=legacy[cursor++]!;messages.push(message);}
      const saved=this.db.query('SELECT task,context FROM conversation_checkpoints WHERE conversation=?').get(id) as {task:string|null;context:string|null}|null;
      return{messages,turns,...(saved?.task?{task:activeTaskCheckpointSchema.parse(JSON.parse(saved.task))}:{}),...(saved?.context?{compaction:contextSnapshotSchema.parse(JSON.parse(saved.context))}:{})};
    }).immediate();}catch{throw new FutrynError('STORAGE');}
  }
}
