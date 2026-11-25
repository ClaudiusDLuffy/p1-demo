// Opt-in local audit evidence. Never records browser storage, headers, input
// values, credentials or application payloads. Assertions remain authoritative.
import {createHash} from 'node:crypto';
import {appendFileSync,mkdirSync,existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
const pages=new WeakMap(),visited=new Set(),guardedContexts=new WeakSet(),observedPages=new WeakSet();let sequence=0;
let previousStatesLoaded=false;
function directory(){
  const value=process.env.P1_RECURSIVE_AUDIT_DIR;
  if(!value)return null;
  const path=resolve(value);
  if(!path.startsWith('/Users/nxs/p1-stabilization-recovery/recursive-audit-'))throw Error('Audit output must stay in task-owned local recovery storage');
  return path;
}
export async function registerAuditPage(page,info,role='Unauthenticated'){
  if(!directory())return;
  const context=page.context();
  if(!guardedContexts.has(context)){
    await context.route('**/*',route=>{
      const url=new URL(route.request().url());
      return ['127.0.0.1','localhost','[::1]'].includes(url.hostname)||['blob:','data:'].includes(url.protocol)
        ?recordAuditRouteOutcome(route,()=>route.continue()):route.abort('blockedbyclient');
    });
    guardedContexts.add(context);
  }
  pages.set(page,{info,role});
  if(!observedPages.has(page)){
    observedPages.add(page);
    await page.addInitScript(()=>{
      window.__p1AuditPointerEvents=[];
      for(const type of ['pointerdown','mousedown','click','input','change','keydown','focusin'])document.addEventListener(type,event=>{
        const target=event.target;
        if(!(target instanceof Element))return;
        window.__p1AuditPointerEvents.push({type,tag:target.tagName,
          label:target.getAttribute('aria-label')?.slice(0,160)||null,
          checked:target instanceof HTMLInputElement&&target.type==='checkbox'?target.checked:null,
          key:type==='keydown'&&['Escape','Tab','Enter','ArrowDown','ArrowUp','Home','End'].includes(event.key)?event.key:null,
          role:target.getAttribute('role'),
          x:typeof event.clientX==='number'?event.clientX:null,y:typeof event.clientY==='number'?event.clientY:null,
          at:Math.round(performance.now())});
        window.__p1AuditPointerEvents=window.__p1AuditPointerEvents.slice(-30);
      },true);
    });
    page.on('pageerror',error=>{
      const entry=pages.get(page);if(!entry)return;
      appendFileSync(join(directory(),'page-errors.jsonl'),JSON.stringify({test:entry.info.title,role:entry.role,
        browser:entry.info.project.name,message:error.message,stack:error.stack?.replace(/\?[^\s)]+/g,'').slice(0,2500)})+'\n');
    });
    page.on('response',async response=>{
      if(response.status()<400)return;
      const url=new URL(response.url());
      if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return;
      let code=null;try{const body=await response.json();if(typeof body?.code==='string'&&/^[A-Z0-9_]{1,80}$/.test(body.code))code=body.code;}catch{}
      const entry=pages.get(page);if(!entry)return;
      appendFileSync(join(directory(),'http-outcomes.jsonl'),JSON.stringify({test:entry.info.title,role:entry.role,browser:entry.info.project.name,
        pathname:url.pathname,status:response.status(),code})+'\n');
    });
  }
  if(!info.annotations.some(a=>a.type==='audit-role'&&a.description===role))info.annotations.push({type:'audit-role',description:role});
}
export async function auditPointerDiagnostics(page){
  if(!directory()||page.isClosed())return null;
  return page.evaluate(()=>window.__p1AuditPointerEvents||[]).catch(()=>null);
}
// Keep routing failures visible, with enough non-sensitive context to tell a
// canceled browser request from an application failure. Never swallow errors.
export async function recordAuditRouteOutcome(route,action){
  try{return await action();}catch(error){
    const root=directory();
    if(root&&/Route is already handled/.test(String(error))){
      const request=route.request(),url=new URL(request.url());
      appendFileSync(join(root,'route-failures.jsonl'),JSON.stringify({
        pathname:url.pathname,method:request.method(),failure:request.failure()?.errorText||null,
        message:'Route is already handled',at:new Date().toISOString(),
      })+'\n');
      // WebKit can complete an explicitly cancelled export read before the
      // fallback reaches this passive localhost guard. Keep that evidence,
      // but do not fail a test for continuing an already-cancelled read.
      // No writes, live requests or other routing failures are suppressed.
      if(url.pathname==='/rest/v1/rpc/list_work_orders_rows_v1'
        &&request.method()==='POST'&&/^cancelled$/i.test(request.failure()?.errorText||''))return;
    }
    throw error;
  }
}
export async function finishAuditRoutes(page){
  if(directory()&&guardedContexts.has(page.context())){
    // Stop context-level audit routes during teardown, matching the fixture's
    // page-level route cleanup. Canceled native continuations can otherwise
    // hang teardown or report "Route is already handled" after a page closes.
    // This affects removed route callbacks only, never app/page diagnostics.
    await page.context().unrouteAll({behavior:'ignoreErrors'});
  }
}
export function auditedExpect(original){
  if(!directory())return original;
  return new Proxy(original,{
    apply(target,receiver,args){
      const matchers=Reflect.apply(target,receiver,args),subject=args[0];
      const page=typeof subject?.page==='function'?subject.page():typeof subject?.url==='function'?subject:null;
      if(!page||!pages.has(page))return matchers;
      function wrap(value){return new Proxy(value,{get(object,key){
        const member=Reflect.get(object,key);
        if(key==='not')return wrap(member);
        if(typeof member!=='function')return member;
        return async(...parameters)=>{
          const result=await Reflect.apply(member,object,parameters);
          await captureAuditState(page,String(key));return result;
        };
      }});}
      return wrap(matchers);
    },
  });
}
async function captureAuditState(page,assertion){
  const entry=pages.get(page),root=directory();if(!entry||!root||page.isClosed())return;
  if(!previousStatesLoaded){
    const manifest=join(root,'screenshot-manifest.jsonl');
    if(existsSync(manifest))for(const line of readFileSync(manifest,'utf8').trim().split('\n').filter(Boolean))visited.add(JSON.parse(line).key);
    previousStatesLoaded=true;
  }
  const url=new URL(page.url());if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return;
  let shape;
  try{shape=await page.evaluate(()=>{
    const visible=el=>{const r=el.getBoundingClientRect();return Boolean(el.getClientRects().length)&&getComputedStyle(el).visibility!=='hidden'
      &&r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth;};
    // Count changes and fixture identities do not create new visual branches.
    // Off-screen controls are captured when scrolling actually reveals them.
    const clean=value=>(value||'').replace(/(?:E2E|WOTEST|WOT99|SYNTHETIC)[A-Za-z0-9_-]*/gi,'[fixture]').replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g,'[time]').replace(/\b\d+\b/g,'#').replace(/\s+/g,' ').slice(0,180);
    return {
      headings:[...document.querySelectorAll('h1,h2,h3,[role="dialog"],[role="alert"],[role="status"]')].filter(visible)
        .map(el=>[el.getAttribute('role')||el.tagName,clean(el.getAttribute('aria-label')||el.textContent)]),
      controls:[...document.querySelectorAll('button,a,input,select,textarea,summary,[role="tab"],[role="option"]')].filter(visible)
        .map(el=>[el.tagName,el.getAttribute('role'),clean(el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.labels?.[0]?.textContent||el.textContent),
          el.getAttribute('type'),Boolean(el.disabled),Boolean(el.checked),el.getAttribute('aria-expanded'),el.getAttribute('aria-invalid'),el.getAttribute('aria-selected'),
          el.type==='password'?'private':typeof el.value==='string'?(el.value.length===0?'empty':el.value.length<40?'short':el.value.length<100?'long':'very-long'):null,
          el.tagName==='SELECT'?el.selectedIndex:null]),
      viewport:{width:innerWidth,height:innerHeight,touch:navigator.maxTouchPoints>0}
    };
  });}catch{return;}
  const viewportLabel=JSON.stringify(shape.viewport);
  if(!entry.info.annotations.some(a=>a.type==='audit-viewport'&&a.description===viewportLabel))entry.info.annotations.push({type:'audit-viewport',description:viewportLabel});
  const project=entry.info.project.name;
  const key=createHash('sha256').update(JSON.stringify([project,entry.role,shape])).digest('hex');
  if(visited.has(key))return;visited.add(key);
  const folder=join(root,'screenshots',project);mkdirSync(folder,{recursive:true});
  const path=join(folder,`${process.pid}-${++sequence}-${key.slice(0,12)}.png`);
  try{
    await page.screenshot({path,animations:'disabled',fullPage:false,timeout:10_000});
    appendFileSync(join(root,'screenshot-manifest.jsonl'),JSON.stringify({path,key,role:entry.role,browser:project,
      viewport:shape.viewport,source:entry.info.file,test:entry.info.title,action:`Verified ${assertion}`,reviewed:false,removed:false})+'\n');
  }catch{visited.delete(key);appendFileSync(join(root,'screenshot-gaps.jsonl'),JSON.stringify({role:entry.role,browser:project,test:entry.info.title,reason:'State could not be captured before page transition or closure'})+'\n');}
}
