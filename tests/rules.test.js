/* Test des règles du serveur avec horloge simulée (Node seul) : node tests/rules.test.js */
const fs=require('fs'),cp=require('child_process');
const os=require('os'),path=require('path');const D=path.join(os.tmpdir(),'um6ss-test-data'),B='http://127.0.0.1:8793',PW='test-password-123',DIR=path.join(__dirname,'..');
let proc=null;const start=()=>new Promise((ok,ko)=>{proc=cp.spawn('node',['server.js'],{cwd:DIR,env:{...process.env,PORT:'8793',ADMIN_PASSWORD:PW,DATA_DIR:D,ALLOW_TEST_CLOCK:'1',ALERT_INTERVAL_MS:'200'}});let o='';proc.stdout.on('data',d=>{o+=d;if(/démarré/.test(o))ok()});proc.stderr.on('data',d=>o+=d);setTimeout(()=>ko(new Error('timeout '+o)),8000)});
const stop=()=>new Promise(r=>{proc.on('exit',r);proc.kill()});const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let fails=0;const ok=(n,c,x)=>{if(!c)fails++;console.log((c?'PASS ':'FAIL ')+n+(x!==undefined?'  -> '+x:''))};
let cookie='';const H=async(m,p,b,raw)=>{const r=await fetch(B+p,{method:m,headers:{...(b?{'Content-Type':'application/json'}:{}),...(cookie&&!raw?{Cookie:cookie}:{})},body:b?JSON.stringify(b):undefined});let j=null;try{j=await r.json()}catch(e){}return{s:r.status,j,h:r.headers}};
const clock=iso=>H('POST','/api/_test/clock',{iso});
const stu=n=>Array.from({length:n},(_,i)=>({m:'M'+(i+1),n:'ETUDIANT'+(i+1)}));
const mkForm=async(o)=>{const r=await H('POST','/api/forms',{session:{sessionId:o.id,teacherId:o.t||'T1',subject:o.subject||'Matière '+o.id,teacher:o.teacher||'Dr. Test',date:o.date,start:o.start||'08:30',end:o.end||'10:30',program:'IP',year:'1',group:'G1',room:'A1',students:stu(5)},expiresInHours:24*14});if(r.s!==200)throw new Error('form '+JSON.stringify(r));return{token:r.j.url.split('/f/')[1],id:r.j.id}};
const sub=(tok,body)=>H('POST','/api/form/'+tok+'/submit',{signatureType:'electronic',signedBy:'Dr. Test',confirm:true,none:false,absent:[],...body},true);
(async()=>{fs.rmSync(D,{recursive:true,force:true});await start();
 const lg=await fetch(B+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PW})});cookie=lg.headers.get('set-cookie').split(';')[0];
 // ---- A. declaration window (server time, Africa/Casablanca)
 const f1=await mkForm({id:'S1',date:'2026-10-26'});
 await clock('2026-10-26T07:29:59Z');let g=await H('GET','/api/form/'+f1.token,null,true);
 ok('before the start (08:29:59 Casablanca, GMT+1) the form says it cannot be filled',g.j.canDeclare===false&&g.j.startsAt==='2026-10-26 08:30');
 let r=await sub(f1.token,{absent:['M1']});ok('server refuses a declaration for a session that has not started (403)',r.s===403&&/pas encore commencé/.test(r.j.error),r.s);
 await clock('2026-10-26T07:30:00Z');g=await H('GET','/api/form/'+f1.token,null,true);ok('at 08:30 (07:30 UTC in GMT+1) declaring becomes possible',g.j.canDeclare===true);
 const f2=await mkForm({id:'S2',date:'2026-03-01'});await clock('2026-03-01T08:29:59Z');ok('Ramadan (GMT+0): 08:29:59 UTC is still before 08:30 local',(await sub(f2.token,{absent:['M1']})).s===403);
 await clock('2026-03-01T08:30:00Z');ok('Ramadan (GMT+0): 08:30 UTC = 08:30 local -> allowed (a fixed +1 offset would have allowed it an hour earlier)',(await sub(f2.token,{absent:['M1']})).s===200);
 // ---- B. 24h modification window, exceptions, block
 await clock('2026-10-26T08:00:00Z');r=await sub(f1.token,{absent:['M1','M2']});ok('declaration accepted: 2 absent -> status soumise',r.s===200&&r.j.total===2);
 const first=Date.parse('2026-10-26T08:00:00Z');
 await clock(new Date(first+23*3600e3+59*60e3).toISOString());r=await sub(f1.token,{absent:['M3'],amend:true,reason:'correction'});ok('modification at +23h59 is accepted',r.s===200&&r.j.amended===true);
 const f3=await mkForm({id:'S3',date:'2026-10-26',t:'T3'});await clock('2026-10-26T08:00:00Z');await sub(f3.token,{absent:['M1']});
 await clock(new Date(first+24*3600e3+60e3).toISOString());r=await sub(f3.token,{absent:['M2'],amend:true,reason:'trop tard'});ok('modification at +24h01 is refused by the server (403)',r.s===403&&/24 heures/.test(r.j.error),r.s+' '+(r.j.error||''));
 g=await H('GET','/api/form/'+f3.token,null,true);ok('the form shows the refusal message and offers no edit',g.j.submitted.canAmend===false&&/24 heures/.test(g.j.submitted.amendMsg));
 let pr=await H('PUT','/api/policies/T3',{mode:'exception',until:new Date(first+30*3600e3).toISOString(),reason:'maladie'});ok('admin grants an exception with an expiry date',pr.s===200);
 r=await sub(f3.token,{absent:['M2'],amend:true,reason:'exception'});ok('with the exception the modification is accepted beyond 24h',r.s===200);
 await clock(new Date(first+31*3600e3).toISOString());r=await sub(f3.token,{absent:['M4'],amend:true,reason:'après expiration'});ok('after the exception expires, modification is refused',r.s===403);
 await clock(new Date(first+25*3600e3).toISOString());await H('PUT','/api/policies/T3',{mode:'exception',until:new Date(first+40*3600e3).toISOString(),reason:'2e'});ok('(exception active again: allowed)',(await sub(f3.token,{absent:['M5'],amend:true,reason:'exception 2'})).s===200);
 await H('PUT','/api/policies/T3',{mode:'24h',reason:'révoquée'});ok('revoking the exception blocks immediately (403)',(await sub(f3.token,{absent:['M1'],amend:true,reason:'x'})).s===403);
 const f4=await mkForm({id:'S4',date:'2026-10-26',t:'T4'});await clock('2026-10-26T08:00:00Z');await sub(f4.token,{absent:['M1']});await H('PUT','/api/policies/T4',{mode:'block',reason:'blocage'});await clock('2026-10-26T08:05:00Z');
 ok('"block from confirmation" refuses even 5 minutes later',(await sub(f4.token,{absent:['M2'],amend:true,reason:'x'})).s===403);
 ok('exception without a future expiry date is rejected (400)',(await H('PUT','/api/policies/T4',{mode:'exception',until:'2020-01-01T00:00:00Z'})).s===400);
 const ab=(await H('GET','/api/absences')).j.items.find(a=>a.sessionId==='S3');ok('every modification keeps old values + reason in the history',ab.versions.length>=2&&ab.versions.every(v=>v.reason&&Array.isArray(v.absent)));
 // ---- C. double submission
 const f5=await mkForm({id:'S5',date:'2026-10-26',t:'T5'});await clock('2026-10-26T08:00:00Z');
 const rs=await Promise.all([sub(f5.token,{absent:['M1']}),sub(f5.token,{absent:['M1']}),sub(f5.token,{absent:['M1']})]);
 ok('three simultaneous submissions create exactly ONE declaration',rs.filter(x=>x.s===200).length===1&&rs.filter(x=>x.s===409).length===2&&(await H('GET','/api/absences')).j.items.filter(a=>a.sessionId==='S5').length===1,rs.map(x=>x.s).join());
 // ---- D. scheduler alerts (no browser, no API polling needed)
 const sess=(id,date,start,end,status,t)=>({id,date,start,end,status,teacherId:t||'T9',teacher:'Dr. '+id,subject:'Cours '+id,program:'IP',year:'1',group:'G1',room:'A1'});
 const list=[sess('A1','2026-10-26','08:30','10:30','programmee'),sess('A2','2026-03-01','08:00','10:00','programmee'),sess('A3','2026-10-26','08:30','10:30','annulee'),sess('A4','2026-10-26','08:30','10:30','reportee'),sess('A5','2026-10-26','08:30','10:30','programmee'),sess('A6','2026-10-28','14:00','16:00','programmee')];
 await clock('2026-03-01T08:59:00Z');
 ok('session sync accepted (6 sessions)',(await H('POST','/api/sessions/sync',{sessions:list})).j.count===6);
 const alerts=async()=>(await H('GET','/api/alerts')).j.items;const open=async(ign)=>(await alerts()).filter(a=>!a.resolvedAt&&!(ign||[]).includes(a.sessionId)).map(a=>a.sessionId).sort().join();
 await clock('2026-03-01T09:00:00Z');await sleep(800);ok('Ramadan (GMT+0): at 09:00 UTC the 10:00-local session is NOT yet late (a fixed GMT+1 would alert here)',(await open())==='');
 await clock('2026-03-01T09:59:59Z');await sleep(800);ok('Ramadan: still no alert at 09:59:59',(await open())==='');
 await clock('2026-03-01T10:00:00Z');await sleep(800);ok('Ramadan: alert at 10:00 UTC = 10:00 local',(await open())==='A2');
 await clock('2026-10-26T09:29:59Z');await sleep(800);ok('GMT+1: 10:29:59 local -> no alert yet for the October sessions',(await open(['A2']))==='');
 await clock('2026-10-26T09:30:00Z');await sleep(800);const o1=await open(['A2']);ok('at the planned end (10:30 local = 09:30 UTC) the scheduler raises the alerts within a second, with no user action',o1==='A1,A5',o1);
 ok('cancelled (A3) and postponed (A4) sessions never raise an alert',!o1.includes('A3')&&!o1.includes('A4'));
 await sleep(800);ok('one alert per session (no duplicates after several scheduler runs)',(await alerts()).filter(a=>a.sessionId==='A1').length===1);
 const fa=await mkForm({id:'A5',date:'2026-10-26',subject:'Cours A5'});await clock('2026-10-26T09:31:00Z');ok('(A5 declared at 10:31, after its end)',(await sub(fa.token,{absent:['M1']})).s===200);
 await sleep(800);ok('a declaration resolves the alert (A5 resolved, A1 still open)',(await open(['A2']))==='A1');
 const fb=await mkForm({id:'A1',date:'2026-10-26'});await clock('2026-10-26T09:50:00Z');await sub(fb.token,{none:true});await sleep(800);
 const a1=(await alerts()).find(a=>a.sessionId==='A1');ok('a "Aucun absent" declaration resolves A1; the alert stays in the history with resolution time and reason',a1&&a1.resolvedAt&&a1.resolvedBy==='déclaration reçue'&&(await open(['A2']))==='');
 await clock('2026-10-28T14:30:00Z');await sleep(800);ok('(A6 replacement slot 14:00–16:00 local: no alert at 15:30 local)',!(await open(['A2'])).includes('A6'));
 await clock('2026-10-28T15:00:00Z');await sleep(800);ok('(A6: alert from its own end, 16:00 local = 15:00 UTC)',(await open(['A2'])).includes('A6'));
 // ---- E. notifications
 const nt=(await H('GET','/api/notifications')).j.items;const kinds=[...new Set(nt.map(n=>n.kind))].sort().join();
 ok('admin notifications for: declaration, aucun absent, modification, exception',['aucun_absent','declaration','exception','modification'].every(k=>kinds.includes(k)),kinds);
 ok('no duplicate notification for the same event',new Set(nt.map(n=>n.kind+'|'+n.formId+'|'+n.desc+'|'+n.at)).size===nt.length);
 await H('POST','/api/notifications/read',{ids:[nt[0].id]});ok('read / unread state works',(await H('GET','/api/notifications')).j.items.find(n=>n.id===nt[0].id).read===true&&(await H('GET','/api/notifications')).j.items.some(n=>!n.read));
 // ---- F. audit chain + access control
 const au=await H('GET','/api/audit');ok('audit log is hash-chained and valid; contains old/new values for corrections',au.j.valid===true&&au.j.items.some(e=>e.event==='déclaration corrigée'&&e.ancien!==undefined&&e.nouveau!==undefined&&e.motif));
 cookie='';ok('rules / audit / alerts / notifications / sync refuse unauthenticated calls (401)',(await Promise.all([H('GET','/api/audit'),H('GET','/api/policies'),H('PUT','/api/policies/T1',{mode:'block'}),H('GET','/api/alerts'),H('GET','/api/notifications'),H('POST','/api/sessions/sync',{sessions:[]}),H('POST','/api/_test/clock',{iso:null})])).every(x=>x.s===401));
 ok('there is no endpoint to modify or delete audit entries',(await Promise.all([H('DELETE','/api/audit'),H('PUT','/api/audit',{}),H('POST','/api/audit',{})])).every(x=>x.s===401||x.s===404));
 await stop();const st=JSON.parse(fs.readFileSync(D+'/store.json','utf8'));st.audit[3].event='falsifié';fs.writeFileSync(D+'/store.json',JSON.stringify(st));await start();
 const lg2=await fetch(B+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:PW})});cookie=lg2.headers.get('set-cookie').split(';')[0];
 ok('tampering with an audit entry in the data file is detected (chain invalid)',(await H('GET','/api/audit')).j.valid===false);
 await stop();console.log(fails?'FAILURES: '+fails:'ALL PASSED')})().catch(async e=>{console.log('ERROR',e);try{await stop()}catch(x){}process.exit(1)});
