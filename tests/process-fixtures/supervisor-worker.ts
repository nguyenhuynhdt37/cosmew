/** Disposable research supervisor; parent test intentionally crashes this process. */
import {SeatbeltRuntime} from '@hannes/tools';
const [root,nonce]=process.argv.slice(2);
if(!root||!nonce||!/^[a-f0-9]{32}$/.test(nonce))process.exit(2);
const runtime=new SeatbeltRuntime({workspaceRoot:root});
if(!runtime.probeIsolation().ok)process.exit(3);
const command=`exec /usr/bin/perl -MPOSIX -e '$p=fork(); if(!$p){POSIX::setsid();sleep 5;exit 0;}sleep 5;' ${nonce}`;
await runtime.run({command,cwd:root,timeoutMs:6000,maxOutputBytes:100});
