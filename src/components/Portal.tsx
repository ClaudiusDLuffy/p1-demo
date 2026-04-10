"use client";
// @ts-nocheck
import { useState, useEffect } from "react";

const USERS = [
  { id: "clay", name: "Clay Lawrence", role: "manager", initials: "CL", email: "clay@p1services.com", color: "#2563eb" },
  { id: "derek", name: "Derek Morrison", role: "contractor", initials: "DM", email: "derek@dmrepairs.com", company: "DM Repair Services", territory: "Orlando / Kissimmee", color: "#0ea5e9" },
  { id: "ray", name: "Ray Torres", role: "contractor", initials: "RT", email: "ray@raytechservices.com", company: "Ray's Technical Services", territory: "Melbourne / Daytona", color: "#8b5cf6" },
  { id: "andy", name: "Andy Kim", role: "contractor", initials: "AK", email: "andy@akmaintenance.com", company: "AK Maintenance Co.", territory: "Tampa / Lakeland", color: "#0891b2" },
];

const WORK_ORDERS = [
  { id: "WOT0012847", store: "36190", city: "Orlando, FL", addr: "4801 S Orange Ave", issue: "HVAC unit not cooling — store temp above 80°F, customers complaining", priority: "emergency", status: "unassigned", nte: 2500, age: "2h", category: "HVAC", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012852", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Walk-in cooler compressor failure — product temp rising, potential loss", priority: "emergency", status: "unassigned", nte: 3000, age: "45m", category: "Refrigeration", afm: "Robert Chen", afmPhone: "(321) 555-0198" },
  { id: "WOT0012860", store: "41005", city: "Tampa, FL", addr: "3402 W Hillsborough Ave", issue: "Front door automatic closer broken — security risk, door staying open", priority: "routine", status: "unassigned", nte: 500, age: "1d", category: "General", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012801", store: "36190", city: "Orlando, FL", addr: "4801 S Orange Ave", issue: "Beverage dispenser leaking at base — floor hazard near registers", priority: "critical", status: "assigned", contractor: "derek", nte: 1200, age: "1d", category: "Equipment", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", eta: "Apr 10, 2:00 PM" },
  { id: "WOT0012815", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Electrical panel cover missing in back room — code violation", priority: "critical", status: "assigned", contractor: "ray", nte: 800, age: "3d", category: "Electrical", afm: "Robert Chen", afmPhone: "(321) 555-0198", eta: "Apr 10, 10:00 AM" },
  { id: "WOT0012822", store: "41005", city: "Tampa, FL", addr: "3402 W Hillsborough Ave", issue: "Parking lot pothole near fuel pumps — liability concern", priority: "critical", status: "assigned", contractor: "andy", nte: 1500, age: "2d", category: "General", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", eta: "Apr 11, 9:00 AM" },
  { id: "WOT0012779", store: "41022", city: "Lakeland, FL", addr: "2210 S Florida Ave", issue: "Slurpee machine motor replacement — unit offline 3 days", priority: "critical", status: "wip", contractor: "andy", nte: 1800, age: "2d", category: "Equipment", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", startTime: "Apr 7, 9:15 AM", assetModel: "Taylor 428", assetSerial: "TY-2019-44821" },
  { id: "WOT0012788", store: "36501", city: "Daytona Beach, FL", addr: "801 N Atlantic Ave", issue: "Grease trap overflow in kitchen — health department risk", priority: "emergency", status: "wip", contractor: "derek", nte: 2200, age: "1d", category: "Plumbing", afm: "Robert Chen", afmPhone: "(321) 555-0198", startTime: "Apr 7, 2:00 PM", assetModel: "N/A — Plumbing", assetSerial: "N/A" },
  { id: "WOT0012756", store: "32100", city: "Melbourne, FL", addr: "1455 N Harbor City Blvd", issue: "Walk-in freezer evaporator coil — needs full replacement", priority: "critical", status: "capital", contractor: "ray", nte: 4500, age: "5d", category: "Refrigeration", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", partNeeded: "Heatcraft BHL136BE evaporator coil", partEta: "Apr 22", assetModel: "Heatcraft PRO26", assetSerial: "HC-2021-99102", capitalStatus: "Equipment ordered" },
  { id: "WOT0012771", store: "36190", city: "Orlando, FL", addr: "4801 S Orange Ave", issue: "POS terminal #3 power supply unit failure — register offline", priority: "routine", status: "parts", contractor: "andy", nte: 350, age: "4d", category: "Electrical", afm: "Robert Chen", afmPhone: "(321) 555-0198", partNeeded: "Epson PS-180 power supply", partEta: "Apr 10", assetModel: "Epson TM-T88V", assetSerial: "EP-2020-31455" },
  { id: "WOT0012745", store: "41005", city: "Tampa, FL", addr: "3402 W Hillsborough Ave", issue: "Parking lot light pole repair — 3 fixtures out, dark corner", priority: "routine", status: "completed", contractor: "derek", nte: 900, age: "6d", category: "Electrical", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", assetModel: "Lithonia KAD", assetSerial: "LI-2018-76321" },
  { id: "WOT0012730", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Emergency plumbing — burst pipe in utility room, water damage", priority: "emergency", status: "pending_invoice", contractor: "ray", nte: 3200, age: "8d", category: "Plumbing", afm: "Robert Chen", afmPhone: "(321) 555-0198" },
  { id: "WOT0012718", store: "36501", city: "Daytona Beach, FL", addr: "801 N Atlantic Ave", issue: "Roof leak repair above walk-in cooler — water dripping on product", priority: "critical", status: "pending_invoice", contractor: "derek", nte: 5000, age: "10d", category: "General", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012702", store: "32100", city: "Melbourne, FL", addr: "1455 N Harbor City Blvd", issue: "Complete HVAC system overhaul — both rooftop units failing", priority: "critical", status: "pending_approval", contractor: "andy", nte: 8500, age: "12d", category: "HVAC", afm: "Robert Chen", afmPhone: "(321) 555-0198", invoiceTotal: 7840 },
  { id: "WOT0012740", store: "41022", city: "Lakeland, FL", addr: "2210 S Florida Ave", issue: "RTU #2 compressor replacement — unit completely failed", priority: "critical", status: "capital", contractor: "andy", nte: 12000, age: "3w", category: "HVAC", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", assetModel: "Carrier 48HCEE06", assetSerial: "CR-2017-55891", capitalStatus: "Pending approval", partNeeded: "Carrier 48HCEE06 compressor assembly" },
  { id: "WOT0012735", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Walk-in cooler condenser replacement — beyond repair", priority: "critical", status: "capital", contractor: "derek", nte: 8500, age: "6w", category: "Refrigeration", afm: "Robert Chen", afmPhone: "(321) 555-0198", assetModel: "Bohn BHL4B6", assetSerial: "BN-2016-41023", capitalStatus: "Equipment received", partNeeded: "Bohn BHL4B6 condenser unit", partEta: "Apr 11" },
];

const INVOICES = [
  { num: "INV05000142", wot: "WOT0012702", state: "submitted", date: "Apr 6", store: "32100", total: 7840, contractor: "andy" },
  { num: "INV05000138", wot: "WOT0012698", state: "approved", date: "Apr 4", store: "36190", total: 2150, contractor: "derek" },
  { num: "INV05000135", wot: "WOT0012685", state: "rejected", date: "Apr 3", store: "41022", total: 4600, contractor: "ray", reason: "Lack of invoice detail" },
  { num: "INV05000131", wot: "WOT0012670", state: "approved", date: "Apr 1", store: "32236", total: 1280, contractor: "derek" },
  { num: "INV05000128", wot: "WOT0012660", state: "revised", date: "Mar 30", store: "36501", total: 3100, contractor: "ray" },
  { num: "INV05000125", wot: "WOT0012655", state: "approved", date: "Mar 28", store: "41005", total: 890, contractor: "andy" },
];

const STATUS = { unassigned:{label:"Unassigned",color:"#3b82f6",bg:"#eff6ff",ring:"#bfdbfe"}, assigned:{label:"Assigned",color:"#f59e0b",bg:"#fffbeb",ring:"#fde68a"}, wip:{label:"In progress",color:"#8b5cf6",bg:"#f5f3ff",ring:"#c4b5fd"}, parts:{label:"Parts on order",color:"#ef4444",bg:"#fef2f2",ring:"#fecaca"}, capital:{label:"Capital replacement",color:"#7c3aed",bg:"#f5f3ff",ring:"#c4b5fd"}, completed:{label:"Completed",color:"#22c55e",bg:"#f0fdf4",ring:"#bbf7d0"}, pending_invoice:{label:"Pending invoice",color:"#ec4899",bg:"#fdf2f8",ring:"#fbcfe8"}, pending_approval:{label:"Pending approval",color:"#64748b",bg:"#f1f5f9",ring:"#cbd5e1"} };
const PRIORITY = { emergency:{label:"Emergency",color:"#dc2626",bg:"#fef2f2",icon:"⚡",ring:"#fecaca"}, critical:{label:"Critical",color:"#f59e0b",bg:"#fffbeb",icon:"⚠",ring:"#fde68a"}, routine:{label:"Routine",color:"#22c55e",bg:"#f0fdf4",icon:"●",ring:"#bbf7d0"} };
const INV_STATE = { submitted:{label:"Submitted",color:"#3b82f6",bg:"#eff6ff"}, approved:{label:"Approved",color:"#22c55e",bg:"#f0fdf4"}, rejected:{label:"Rejected",color:"#ef4444",bg:"#fef2f2"}, revised:{label:"Revised",color:"#f59e0b",bg:"#fffbeb"} };
const CAP_STATUS = { "Pending approval":{color:"#f59e0b",bg:"#fffbeb"}, "Equipment ordered":{color:"#3b82f6",bg:"#eff6ff"}, "Equipment received":{color:"#22c55e",bg:"#f0fdf4"}, "Installation scheduled":{color:"#8b5cf6",bg:"#f5f3ff"} };

const fmt = n => "$" + n.toLocaleString();
const activeStatuses = ["unassigned","assigned","wip","parts"];
const closingStatuses = ["completed","pending_invoice","pending_approval"];

const Badge = ({conf}) => conf ? <span style={{fontSize:10,fontWeight:600,padding:"3px 10px",borderRadius:20,background:conf.bg,color:conf.color,whiteSpace:"nowrap",letterSpacing:.3,border:`1px solid ${conf.ring||conf.bg}`}}>{conf.label}</span> : null;
const Ico = ({d,size=18,color="currentColor"}) => <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d={d}/></svg>;
const Avatar = ({initials,color,size=36}) => <div style={{width:size,height:size,borderRadius:"50%",background:`linear-gradient(135deg,${color},${color}dd)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:size*.33,fontWeight:700,color:"#fff",letterSpacing:-.5,flexShrink:0}}>{initials}</div>;

// Reusable form field
const Field = ({label,children}) => <div><label style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#94a3b8",marginBottom:5,display:"block"}}>{label}</label>{children}</div>;
const Input = (props) => <input {...props} style={{width:"100%",padding:"9px 12px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:13,fontFamily:"inherit",boxSizing:"border-box",...(props.style||{})}} />;
const Select = ({children,...props}) => <select {...props} style={{width:"100%",padding:"9px 12px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:13,fontFamily:"inherit",background:"#fff",boxSizing:"border-box",...(props.style||{})}}>{children}</select>;
const TextArea = (props) => <textarea {...props} style={{width:"100%",padding:"9px 12px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:13,fontFamily:"inherit",resize:"vertical",boxSizing:"border-box",...(props.style||{})}} />;

const CSS = `
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:768px){
.desktop-sidebar{display:none!important}.mobile-bottom-nav{display:flex!important}.main-wrap{margin-left:0!important}
.stats-grid{grid-template-columns:1fr 1fr!important}.kanban-active{grid-template-columns:1fr 1fr!important}
.kanban-closing{grid-template-columns:1fr!important}.detail-two-col{grid-template-columns:1fr!important}
.detail-fields{grid-template-columns:1fr 1fr!important}.contractors-grid{grid-template-columns:1fr!important}
.capital-grid{grid-template-columns:1fr!important}.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.table-scroll table{min-width:600px}.filter-row-wrap{flex-direction:column}
.filter-row-wrap input,.filter-row-wrap select{width:100%!important;min-width:0!important}
.topbar-title{font-size:15px!important}.content-pad{padding:14px!important}
.modal-inner{width:95%!important;padding:20px!important;max-height:85vh!important}
.modal-form-row{grid-template-columns:1fr!important}
.emergency-banner{flex-direction:column;text-align:center}
.emergency-banner button{margin-left:0!important;margin-top:8px}
.stat-value{font-size:24px!important}
}
@media(min-width:769px){.mobile-bottom-nav{display:none!important}}
`;

// Modal wrapper
const Modal = ({onClose,title,children,width=480}) => (
  <div onClick={e=>{if(e.target===e.currentTarget)onClose()}} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:50,padding:16}}>
    <div className="modal-inner" style={{background:"#fff",borderRadius:18,width:"90%",maxWidth:width,padding:28,animation:"fadeUp 0.25s",boxShadow:"0 20px 60px rgba(0,0,0,0.15)",maxHeight:"90vh",overflowY:"auto"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
        <div style={{fontSize:18,fontWeight:700,color:"#0f172a"}}>{title}</div>
        <button onClick={onClose} style={{width:32,height:32,borderRadius:"50%",border:"1px solid #e2e8f0",background:"#f8fafc",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",fontSize:16,color:"#64748b"}}>×</button>
      </div>
      {children}
    </div>
  </div>
);

const BtnPrimary = ({onClick,children}) => <button onClick={onClick} style={{padding:"10px 24px",borderRadius:10,background:"linear-gradient(135deg,#2563eb,#3b82f6)",color:"#fff",border:"none",cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit"}}>{children}</button>;
const BtnSecondary = ({onClick,children}) => <button onClick={onClick} style={{padding:"10px 20px",borderRadius:10,background:"#fff",color:"#64748b",border:"1px solid #e2e8f0",cursor:"pointer",fontWeight:500,fontSize:12,fontFamily:"inherit"}}>{children}</button>;

export default function P1Portal() {
  const [currentUser,setCurrentUser] = useState(null);
  const [page,setPage] = useState("dashboard");
  const [selectedWO,setSelectedWO] = useState(null);
  const [search,setSearch] = useState("");
  const [filterC,setFilterC] = useState("all");
  const [filterP,setFilterP] = useState("all");
  const [invTab,setInvTab] = useState("all");
  const [toast,setToast] = useState(null);
  const [loginEmail,setLoginEmail] = useState("");
  const [loginLoading,setLoginLoading] = useState(false);
  const [fadeIn,setFadeIn] = useState(false);
  const [aiEnhancing,setAiEnhancing] = useState(false);
  const [aiNote,setAiNote] = useState(null);
  // Modal states
  const [showNewWO,setShowNewWO] = useState(false);
  const [showStartWork,setShowStartWork] = useState(false);
  const [showPauseWork,setShowPauseWork] = useState(false);
  const [showCloseComplete,setShowCloseComplete] = useState(false);
  const [showCreateInvoice,setShowCreateInvoice] = useState(false);
  const [showSetEta,setShowSetEta] = useState(false);

  useEffect(()=>{setTimeout(()=>setFadeIn(true),50)},[]);
  const fire = (msg) => {setToast(msg);setTimeout(()=>setToast(null),2800)};
  const doLogin = (userId) => {setLoginLoading(true);setTimeout(()=>{setCurrentUser(USERS.find(u=>u.id===userId));setPage(userId==="clay"?"dashboard":"my_jobs");setLoginLoading(false)},600)};
  const logout = () => {setCurrentUser(null);setPage("dashboard");setSelectedWO(null);setLoginEmail("");setAiNote(null)};
  const nav = (p) => {setPage(p);setSelectedWO(null);setAiNote(null)};
  const closeAllModals = () => {setShowNewWO(false);setShowStartWork(false);setShowPauseWork(false);setShowCloseComplete(false);setShowCreateInvoice(false);setShowSetEta(false)};

  const isManager = currentUser?.role === "manager";
  const getUser = id => USERS.find(u=>u.id===id);
  const myWOs = currentUser?.role === "contractor" ? WORK_ORDERS.filter(w=>w.contractor===currentUser.id) : WORK_ORDERS;
  const filteredWOs = myWOs.filter(w=>{
    if(search && !w.id.toLowerCase().includes(search.toLowerCase()) && !w.store.includes(search) && !w.issue.toLowerCase().includes(search.toLowerCase())) return false;
    if(filterC!=="all" && w.contractor!==filterC) return false;
    if(filterP!=="all" && w.priority!==filterP) return false;
    return true;
  });

  const openCount = WORK_ORDERS.filter(w=>activeStatuses.includes(w.status)).length;
  const openValue = WORK_ORDERS.filter(w=>activeStatuses.includes(w.status)).reduce((s,w)=>s+w.nte,0);
  const emergCount = WORK_ORDERS.filter(w=>w.priority==="emergency"&&activeStatuses.includes(w.status)).length;
  const pendInv = WORK_ORDERS.filter(w=>w.status==="pending_invoice").length;
  const pendAppr = WORK_ORDERS.filter(w=>w.status==="pending_approval").length;
  const capitalCount = WORK_ORDERS.filter(w=>w.status==="capital").length;
  const completedCount = WORK_ORDERS.filter(w=>w.status==="completed").length;
  const woData = selectedWO ? WORK_ORDERS.find(w=>w.id===selectedWO) : null;

  const doAiEnhance = () => {
    setAiEnhancing(true);
    setTimeout(()=>{
      setAiNote("Arrived on site at approximately 14:00. Conducted initial diagnostic assessment of the grease trap system. Identified overflow condition caused by accumulated grease buildup exceeding trap capacity. Performed full cleanout of the trap basin, cleared the outflow line using a mechanical snake, and verified proper drainage flow rate. Tested system post-service — operating within normal parameters. Recommended quarterly maintenance schedule to prevent recurrence. Area cleaned and sanitized per health department guidelines.");
      setAiEnhancing(false);
    },1800);
  };

  const now = () => {const d=new Date();const h=d.getHours();const m=d.getMinutes();const ampm=h>=12?"PM":"AM";return `${h>12?h-12:h}:${m<10?"0"+m:m} ${ampm}`};

  // ── LOGIN ──
  if(!currentUser){
    return(
      <div style={{minHeight:"100vh",background:"linear-gradient(160deg,#0f172a 0%,#1e293b 40%,#0f172a 100%)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'DM Sans',system-ui,sans-serif",position:"relative",opacity:fadeIn?1:0,transition:"opacity 0.6s",padding:16}}>
        <style>{CSS}</style>
        <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>
        <div style={{position:"absolute",inset:0,backgroundImage:"radial-gradient(circle at 1px 1px,rgba(148,163,184,0.08) 1px,transparent 0)",backgroundSize:"32px 32px"}}/>
        <div style={{position:"relative",zIndex:1,width:"100%",maxWidth:420}}>
          <div style={{textAlign:"center",marginBottom:32}}>
            <div style={{display:"inline-flex",alignItems:"center",justifyContent:"center",width:56,height:56,borderRadius:14,background:"linear-gradient(135deg,#2563eb,#3b82f6)",marginBottom:14,boxShadow:"0 8px 32px rgba(37,99,235,0.3)"}}>
              <span style={{fontSize:22,fontWeight:800,color:"#fff",fontFamily:"'DM Mono',monospace",letterSpacing:-1}}>P1</span>
            </div>
            <div style={{fontSize:22,fontWeight:700,color:"#f1f5f9",letterSpacing:-.5}}>P1 Service Portal</div>
            <div style={{fontSize:13,color:"#64748b",marginTop:4}}>Operations management for 7-Eleven facility services</div>
            <div style={{fontSize:10,color:"#475569",marginTop:8,padding:"4px 12px",background:"rgba(37,99,235,0.1)",borderRadius:20,display:"inline-block"}}>v3 — contractor input flows, ETA, asset capture, AI notes</div>
          </div>
          <div style={{background:"rgba(30,41,59,0.7)",backdropFilter:"blur(20px)",borderRadius:16,border:"1px solid rgba(148,163,184,0.1)",padding:"24px 22px"}}>
            <div style={{fontSize:14,fontWeight:600,color:"#e2e8f0",marginBottom:16}}>Sign in to your account</div>
            <div style={{marginBottom:12}}><label style={{fontSize:11,fontWeight:500,color:"#94a3b8",marginBottom:6,display:"block",textTransform:"uppercase",letterSpacing:.6}}>Email address</label><input value={loginEmail} onChange={e=>setLoginEmail(e.target.value)} placeholder="you@company.com" style={{width:"100%",padding:"11px 14px",borderRadius:10,border:"1px solid rgba(148,163,184,0.15)",background:"rgba(15,23,42,0.5)",color:"#f1f5f9",fontSize:14,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/></div>
            <div style={{marginBottom:20}}><label style={{fontSize:11,fontWeight:500,color:"#94a3b8",marginBottom:6,display:"block",textTransform:"uppercase",letterSpacing:.6}}>Password</label><input type="password" defaultValue="••••••••" style={{width:"100%",padding:"11px 14px",borderRadius:10,border:"1px solid rgba(148,163,184,0.15)",background:"rgba(15,23,42,0.5)",color:"#f1f5f9",fontSize:14,fontFamily:"inherit",outline:"none",boxSizing:"border-box"}}/></div>
            {loginLoading ? <div style={{textAlign:"center",padding:"12px 0"}}><div style={{width:24,height:24,border:"3px solid rgba(37,99,235,0.2)",borderTopColor:"#3b82f6",borderRadius:"50%",animation:"spin 0.7s linear infinite",margin:"0 auto"}}/></div>
            : <button onClick={()=>doLogin("clay")} style={{width:"100%",padding:"12px",borderRadius:10,background:"linear-gradient(135deg,#2563eb,#3b82f6)",color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:14,fontFamily:"inherit",boxShadow:"0 4px 16px rgba(37,99,235,0.3)"}}>Sign in as manager</button>}
          </div>
          <div style={{marginTop:24}}>
            <div style={{fontSize:11,fontWeight:500,color:"#475569",textAlign:"center",marginBottom:12,textTransform:"uppercase",letterSpacing:1}}>Demo — quick access</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
              {USERS.map(u=><button key={u.id} onClick={()=>{setLoginEmail(u.email);doLogin(u.id)}} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:10,border:"1px solid rgba(148,163,184,0.1)",background:"rgba(30,41,59,0.5)",cursor:"pointer",fontFamily:"inherit",textAlign:"left"}}><Avatar initials={u.initials} color={u.color} size={32}/><div><div style={{fontSize:12,fontWeight:600,color:"#e2e8f0"}}>{u.name}</div><div style={{fontSize:10,color:"#64748b"}}>{u.role==="manager"?"Manager":u.company}</div></div></button>)}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── NAV ──
  const sideItems = isManager
    ? [{id:"dashboard",label:"Dashboard",icon:"M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"},
       {id:"work_orders",label:"Work orders",icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",badge:openCount},
       {id:"capital",label:"Capital projects",icon:"M2 20h20M5 20V8l7-5 7 5v12M9 20v-4h6v4",badge:capitalCount},
       {id:"invoices",label:"Invoices",icon:"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8",badge:pendAppr>0?pendAppr:null},
       {id:"contractors",label:"Contractors",icon:"M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"}]
    : [{id:"my_jobs",label:"My jobs",icon:"M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",badge:myWOs.filter(w=>activeStatuses.includes(w.status)).length},
       {id:"invoices",label:"Invoices",icon:"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8"}];

  const renderCard = (wo) => (
    <div key={wo.id} onClick={()=>{setSelectedWO(wo.id);setAiNote(null);if(!isManager)setPage("wo_detail");else setPage("work_orders")}} style={{padding:"12px 14px",borderRadius:10,border:"1px solid #f1f5f9",marginBottom:6,cursor:"pointer",transition:"all 0.2s",background:"#fff"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
        <span style={{fontSize:10,fontWeight:600,color:"#94a3b8",fontFamily:"'DM Mono',monospace"}}>{wo.id}</span>
        <span style={{fontSize:10}}>{PRIORITY[wo.priority]?.icon}</span>
      </div>
      <div style={{fontSize:12,fontWeight:600,color:"#1e293b",marginBottom:3}}>Store #{wo.store}</div>
      <div style={{fontSize:11,color:"#64748b",lineHeight:1.45,display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden"}}>{wo.issue}</div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8,fontSize:10,color:"#94a3b8"}}>
        <span style={{fontWeight:500}}>{wo.contractor?getUser(wo.contractor)?.name.split(" ")[0]:"—"}</span>
        <div style={{display:"flex",gap:6,alignItems:"center"}}>
          {wo.eta && <span style={{color:"#f59e0b",fontWeight:600}}>ETA {wo.eta.split(", ")[1]}</span>}
          <span>{wo.age}</span>
        </div>
      </div>
    </div>
  );

  const renderKanbanCol = (statusKey) => {
    const c = STATUS[statusKey]; const cards = filteredWOs.filter(w=>w.status===statusKey);
    return <div key={statusKey} style={{background:"#fff",borderRadius:12,border:"1px solid #e2e8f0",overflow:"hidden"}}>
      <div style={{padding:"10px 14px",borderBottom:`2px solid ${c.color}20`,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:7}}><div style={{width:8,height:8,borderRadius:"50%",background:c.color,boxShadow:`0 0 8px ${c.color}40`}}/><span style={{fontSize:12,fontWeight:600,color:"#334155"}}>{c.label}</span></div>
        <span style={{fontSize:11,fontWeight:700,color:c.color,background:c.bg,borderRadius:20,padding:"2px 9px",minWidth:22,textAlign:"center"}}>{cards.length}</span>
      </div>
      <div style={{padding:8,minHeight:60}}>{cards.map(renderCard)}{cards.length===0&&<div style={{textAlign:"center",padding:"20px 0",fontSize:11,color:"#cbd5e1"}}>No items</div>}</div>
    </div>;
  };

  const pageTitle = {dashboard:"Dashboard",work_orders:selectedWO?woData?.id:"Work orders",invoices:"Invoices",contractors:"Contractors",my_jobs:"My jobs",wo_detail:woData?.id||"Work order",capital:"Capital projects"};

  return(
    <div style={{display:"flex",minHeight:"100vh",fontFamily:"'DM Sans',system-ui,sans-serif",fontSize:13,color:"#1e293b",background:"#f8fafc",position:"relative"}}>
      <style>{CSS}</style>
      <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet"/>

      {/* Desktop Sidebar */}
      <div className="desktop-sidebar" style={{width:230,background:"#0f172a",color:"#94a3b8",display:"flex",flexDirection:"column",flexShrink:0,position:"fixed",top:0,left:0,bottom:0,zIndex:30}}>
        <div style={{padding:"20px 18px 18px",borderBottom:"1px solid rgba(148,163,184,0.08)"}}>
          <div style={{display:"flex",alignItems:"center",gap:11}}>
            <div style={{width:36,height:36,borderRadius:10,background:"linear-gradient(135deg,#2563eb,#3b82f6)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:14,color:"#fff",fontFamily:"'DM Mono',monospace",letterSpacing:-.5}}>P1</div>
            <div><div style={{fontSize:14,fontWeight:700,color:"#f1f5f9",letterSpacing:-.3}}>P1 Service</div><div style={{fontSize:10,color:"#475569",letterSpacing:.5,textTransform:"uppercase"}}>{isManager?"Operations":"Contractor"}</div></div>
          </div>
        </div>
        <div style={{padding:"14px 12px",flex:1}}>
          {sideItems.map(item=><button key={item.id} onClick={()=>nav(item.id)} style={{display:"flex",alignItems:"center",gap:10,width:"100%",padding:"10px 12px",borderRadius:10,border:"none",background:page===item.id?"rgba(37,99,235,0.12)":"transparent",color:page===item.id?"#e2e8f0":"#64748b",cursor:"pointer",fontSize:13,fontWeight:page===item.id?600:400,fontFamily:"inherit",marginBottom:2}}><Ico d={item.icon} size={16} color={page===item.id?"#60a5fa":"#64748b"}/>{item.label}{item.badge&&<span style={{marginLeft:"auto",fontSize:10,background:item.id==="capital"?"#7c3aed":"#ef4444",color:"#fff",borderRadius:10,padding:"2px 8px",fontWeight:700}}>{item.badge}</span>}</button>)}
        </div>
        <div style={{padding:"16px",borderTop:"1px solid rgba(148,163,184,0.08)"}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}><Avatar initials={currentUser.initials} color={currentUser.color} size={32}/><div style={{flex:1,minWidth:0}}><div style={{fontSize:12,color:"#e2e8f0",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{currentUser.name}</div><div style={{fontSize:10,color:"#475569"}}>{isManager?"Manager":currentUser.company}</div></div></div>
          <button onClick={logout} style={{width:"100%",padding:"7px",borderRadius:8,border:"1px solid rgba(148,163,184,0.1)",background:"transparent",color:"#64748b",fontSize:11,fontWeight:500,cursor:"pointer",fontFamily:"inherit"}}>Sign out</button>
        </div>
      </div>

      {/* Mobile Bottom Nav */}
      <div className="mobile-bottom-nav" style={{display:"none",position:"fixed",bottom:0,left:0,right:0,background:"#0f172a",zIndex:40,borderTop:"1px solid #1e293b",justifyContent:"space-around",padding:"6px 0 env(safe-area-inset-bottom,6px)"}}>
        {sideItems.slice(0,4).map(item=><button key={item.id} onClick={()=>nav(item.id)} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,background:"none",border:"none",cursor:"pointer",padding:"6px 8px",position:"relative",fontFamily:"inherit"}}><Ico d={item.icon} size={20} color={page===item.id?"#60a5fa":"#64748b"}/><span style={{fontSize:8,fontWeight:page===item.id?600:400,color:page===item.id?"#e2e8f0":"#64748b"}}>{item.label.split(" ")[0]}</span>{item.badge&&<span style={{position:"absolute",top:0,right:0,fontSize:7,background:"#ef4444",color:"#fff",borderRadius:10,padding:"1px 4px",fontWeight:700}}>{item.badge}</span>}</button>)}
        <button onClick={logout} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:2,background:"none",border:"none",cursor:"pointer",padding:"6px 8px",fontFamily:"inherit"}}><Ico d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" size={20} color="#64748b"/><span style={{fontSize:8,color:"#64748b"}}>Out</span></button>
      </div>

      {/* Main */}
      <div className="main-wrap" style={{flex:1,marginLeft:230,display:"flex",flexDirection:"column",minHeight:"100vh"}}>
        <div style={{padding:"14px 24px",borderBottom:"1px solid #e2e8f0",background:"#fff",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:20}}>
          <div><div className="topbar-title" style={{fontSize:18,fontWeight:700,color:"#0f172a",letterSpacing:-.4}}>{pageTitle[page]}</div><div style={{fontSize:11,color:"#94a3b8",marginTop:1}}>{isManager?"Thursday, April 10, 2026":currentUser.company}</div></div>
          <div style={{display:"flex",gap:8}}>
            {isManager&&<><button onClick={()=>fire("Auto-assign would match unassigned calls to contractors by territory")} style={{padding:"9px 16px",borderRadius:10,background:"#fff",color:"#475569",border:"1px solid #e2e8f0",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit",whiteSpace:"nowrap"}}>Auto-assign</button><button onClick={()=>setShowNewWO(true)} style={{padding:"9px 16px",borderRadius:10,background:"linear-gradient(135deg,#2563eb,#3b82f6)",color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit",whiteSpace:"nowrap"}}>+ New</button></>}
          </div>
        </div>

        <div className="content-pad" style={{flex:1,overflow:"auto",padding:24,paddingBottom:80}}>

          {/* DASHBOARD */}
          {page==="dashboard"&&isManager&&(
            <div style={{animation:"fadeUp 0.35s"}}>
              {emergCount>0&&<div className="emergency-banner" style={{background:"linear-gradient(135deg,#fef2f2,#fff1f2)",border:"1px solid #fecaca",borderRadius:12,padding:"14px 20px",marginBottom:20,display:"flex",alignItems:"center",gap:12}}><div style={{width:40,height:40,borderRadius:10,background:"#fee2e2",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>🚨</div><div style={{flex:1}}><div style={{fontWeight:700,color:"#dc2626",fontSize:13}}>{emergCount} emergency call{emergCount>1?"s":""} need immediate dispatch</div><div style={{fontSize:11,color:"#991b1b",marginTop:2}}>Open emergency work orders waiting for contractor assignment</div></div><button onClick={()=>{nav("work_orders");setFilterP("emergency")}} style={{padding:"8px 16px",borderRadius:8,border:"1px solid #fecaca",background:"#fff",color:"#dc2626",fontWeight:600,fontSize:11,cursor:"pointer",fontFamily:"inherit",whiteSpace:"nowrap",marginLeft:"auto"}}>View emergencies →</button></div>}
              <div className="stats-grid" style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:14,marginBottom:28}}>
                {[{label:"Open service calls",value:openCount,color:"#3b82f6",sub:`${emergCount} emergency`,gradient:"linear-gradient(135deg,#eff6ff,#f0f9ff)"},{label:"Revenue at risk",value:fmt(openValue),color:"#ef4444",sub:"Active pipeline",gradient:"linear-gradient(135deg,#fef2f2,#fff1f2)"},{label:"Completed (clear out)",value:completedCount,color:"#22c55e",sub:"Update 7-Eleven portal",gradient:"linear-gradient(135deg,#f0fdf4,#ecfdf5)"},{label:"Capital projects",value:capitalCount,color:"#7c3aed",sub:"Pending equipment",gradient:"linear-gradient(135deg,#f5f3ff,#ede9fe)"}].map((s,i)=><div key={i} style={{background:s.gradient,borderRadius:14,padding:"20px 22px",border:"1px solid #e2e8f0",animation:`fadeUp 0.4s ${i*0.06}s both`,cursor:"pointer"}} onClick={()=>{if(i===2)nav("work_orders");if(i===3)nav("capital")}}><div style={{fontSize:10,color:"#64748b",fontWeight:600,textTransform:"uppercase",letterSpacing:1,marginBottom:10}}>{s.label}</div><div className="stat-value" style={{fontSize:30,fontWeight:800,color:s.color,letterSpacing:-1.5,fontFamily:"'DM Mono',monospace",lineHeight:1}}>{s.value}</div><div style={{fontSize:11,color:"#94a3b8",marginTop:6,fontWeight:500}}>{s.sub}</div></div>)}
              </div>
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1.2,color:"#94a3b8",marginBottom:10}}>Active pipeline</div>
              <div className="kanban-active" style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:10,marginBottom:28}}>{activeStatuses.map(renderKanbanCol)}</div>
              <div style={{fontSize:11,fontWeight:700,textTransform:"uppercase",letterSpacing:1.2,color:"#94a3b8",marginBottom:10}}>Closing pipeline</div>
              <div className="kanban-closing" style={{display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:10}}>{closingStatuses.map(renderKanbanCol)}</div>
            </div>
          )}

          {/* CAPITAL PROJECTS */}
          {page==="capital"&&isManager&&(
            <div style={{animation:"fadeUp 0.3s"}}>
              <div style={{background:"linear-gradient(135deg,#f5f3ff,#ede9fe)",border:"1px solid #c4b5fd",borderRadius:12,padding:"14px 20px",marginBottom:20,display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:40,height:40,borderRadius:10,background:"#ede9fe",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ico d="M2 20h20M5 20V8l7-5 7 5v12M9 20v-4h6v4" size={20} color="#7c3aed"/></div>
                <div><div style={{fontWeight:700,color:"#5b21b6",fontSize:13}}>{capitalCount} capital replacement{capitalCount!==1?"s":""} in progress</div><div style={{fontSize:11,color:"#6d28d9",marginTop:2}}>Equipment orders pending delivery — separate from regular pipeline</div></div>
              </div>
              <div className="capital-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
                {WORK_ORDERS.filter(w=>w.status==="capital").map((wo,i)=><div key={wo.id} onClick={()=>{setSelectedWO(wo.id);setPage("work_orders");setAiNote(null)}} style={{background:"#fff",borderRadius:14,border:"1px solid #e2e8f0",padding:20,cursor:"pointer",animation:`fadeUp 0.3s ${i*0.06}s both`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}><span style={{fontSize:11,fontFamily:"'DM Mono',monospace",fontWeight:600,color:"#7c3aed"}}>{wo.id}</span>{wo.capitalStatus&&<span style={{fontSize:10,fontWeight:600,padding:"3px 10px",borderRadius:20,background:CAP_STATUS[wo.capitalStatus]?.bg||"#f1f5f9",color:CAP_STATUS[wo.capitalStatus]?.color||"#64748b"}}>{wo.capitalStatus}</span>}</div>
                  <div style={{fontSize:14,fontWeight:600,color:"#0f172a",marginBottom:4}}>Store #{wo.store} · {wo.city}</div>
                  <div style={{fontSize:12,color:"#64748b",marginBottom:10}}>{wo.issue}</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,padding:"10px 0",borderTop:"1px solid #f1f5f9"}}>
                    <div><div style={{fontSize:9,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#94a3b8",marginBottom:2}}>Equipment</div><div style={{fontSize:11,fontWeight:500}}>{wo.partNeeded||"TBD"}</div></div>
                    <div><div style={{fontSize:9,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#94a3b8",marginBottom:2}}>Delivery ETA</div><div style={{fontSize:11,fontWeight:500,color:"#f59e0b"}}>{wo.partEta||"Pending"}</div></div>
                    <div><div style={{fontSize:9,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#94a3b8",marginBottom:2}}>Asset</div><div style={{fontSize:11,fontWeight:500}}>{wo.assetModel||"—"}</div></div>
                    <div><div style={{fontSize:9,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#94a3b8",marginBottom:2}}>NTE</div><div style={{fontSize:11,fontWeight:600,fontFamily:"'DM Mono',monospace"}}>{fmt(wo.nte)}</div></div>
                  </div>
                  <div style={{fontSize:10,color:"#94a3b8",marginTop:6}}>Contractor: {getUser(wo.contractor)?.name} · Age: {wo.age}</div>
                </div>)}
              </div>
            </div>
          )}

          {/* WORK ORDERS TABLE */}
          {page==="work_orders"&&!selectedWO&&(
            <div style={{animation:"fadeUp 0.3s"}}>
              <div className="filter-row-wrap" style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
                <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search WOT #, store, or keyword..." style={{padding:"9px 14px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:12,width:260,fontFamily:"inherit",background:"#fff"}}/>
                <select value={filterC} onChange={e=>setFilterC(e.target.value)} style={{padding:"9px 14px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:12,fontFamily:"inherit",background:"#fff"}}><option value="all">All contractors</option>{USERS.filter(u=>u.role==="contractor").map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select>
                <select value={filterP} onChange={e=>setFilterP(e.target.value)} style={{padding:"9px 14px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:12,fontFamily:"inherit",background:"#fff"}}><option value="all">All priorities</option><option value="emergency">Emergency</option><option value="critical">Critical</option><option value="routine">Routine</option></select>
                {(filterC!=="all"||filterP!=="all"||search)&&<button onClick={()=>{setFilterC("all");setFilterP("all");setSearch("")}} style={{fontSize:11,color:"#64748b",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",textDecoration:"underline"}}>Clear</button>}
              </div>
              <div className="table-scroll" style={{background:"#fff",borderRadius:14,border:"1px solid #e2e8f0",overflow:"hidden"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}><thead><tr style={{background:"#f8fafc"}}>{["WOT #","Store","Issue","Priority","Status","Contractor","ETA","NTE"].map(h=><th key={h} style={{textAlign:h==="NTE"?"right":"left",padding:"11px 14px",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.6,color:"#94a3b8",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                <tbody>{filteredWOs.filter(w=>w.status!=="capital").map((wo,i)=><tr key={wo.id} onClick={()=>{setSelectedWO(wo.id);setAiNote(null)}} style={{cursor:"pointer",borderBottom:"1px solid #f1f5f9",animation:`fadeUp 0.3s ${i*0.02}s both`}}><td style={{padding:"11px 14px",fontFamily:"'DM Mono',monospace",fontWeight:600,fontSize:11,color:"#2563eb",whiteSpace:"nowrap"}}>{wo.id}</td><td style={{padding:"11px 14px",fontWeight:600,whiteSpace:"nowrap"}}>#{wo.store}</td><td style={{padding:"11px 14px",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",color:"#475569"}}>{wo.issue}</td><td style={{padding:"11px 14px"}}><Badge conf={PRIORITY[wo.priority]}/></td><td style={{padding:"11px 14px"}}><Badge conf={STATUS[wo.status]}/></td><td style={{padding:"11px 14px",color:"#64748b",whiteSpace:"nowrap"}}>{wo.contractor?getUser(wo.contractor)?.name:"—"}</td><td style={{padding:"11px 14px",color:wo.eta?"#f59e0b":"#cbd5e1",whiteSpace:"nowrap",fontWeight:wo.eta?600:400,fontSize:11}}>{wo.eta?wo.eta.split(", ")[1]:"—"}</td><td style={{padding:"11px 14px",textAlign:"right",fontFamily:"'DM Mono',monospace",fontWeight:600,whiteSpace:"nowrap"}}>{fmt(wo.nte)}</td></tr>)}</tbody></table>
              </div>
            </div>
          )}

          {/* WORK ORDER DETAIL */}
          {(page==="work_orders"||page==="wo_detail")&&selectedWO&&woData&&(
            <div style={{animation:"fadeUp 0.25s"}}>
              <button onClick={()=>{setSelectedWO(null);setAiNote(null);if(!isManager)setPage("my_jobs")}} style={{display:"flex",alignItems:"center",gap:4,fontSize:12,color:"#64748b",background:"none",border:"none",cursor:"pointer",fontFamily:"inherit",marginBottom:16,padding:0}}><Ico d="M15 18l-6-6 6-6" size={14}/> Back</button>
              <div className="detail-two-col" style={{display:"grid",gridTemplateColumns:"1fr 300px",gap:20}}>
                <div>
                  {/* Header */}
                  <div style={{background:"#fff",borderRadius:14,border:"1px solid #e2e8f0",padding:20,marginBottom:16}}>
                    <div style={{marginBottom:14}}>
                      <div style={{fontFamily:"'DM Mono',monospace",fontSize:12,fontWeight:600,color:"#94a3b8",marginBottom:4}}>{woData.id}</div>
                      <div style={{fontSize:18,fontWeight:700,color:"#0f172a",letterSpacing:-.4}}>Store #{woData.store} · {woData.city}</div>
                      <div style={{fontSize:12,color:"#94a3b8",marginTop:2}}>{woData.addr}</div>
                      <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}><Badge conf={STATUS[woData.status]}/><Badge conf={PRIORITY[woData.priority]}/>{woData.capitalStatus&&<Badge conf={{label:woData.capitalStatus,color:CAP_STATUS[woData.capitalStatus]?.color||"#64748b",bg:CAP_STATUS[woData.capitalStatus]?.bg||"#f1f5f9"}}/>}</div>
                    </div>
                    <div style={{fontSize:14,color:"#475569",lineHeight:1.65,marginBottom:20,padding:"12px 16px",background:"#f8fafc",borderRadius:10,border:"1px solid #f1f5f9"}}>{woData.issue}</div>
                    <div className="detail-fields" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:18}}>
                      {[{l:"Category",v:woData.category},{l:"NTE limit",v:fmt(woData.nte)},{l:"ETA",v:woData.eta||"Not set"},{l:"Assigned to",v:woData.contractor?getUser(woData.contractor)?.name:"Unassigned"},{l:"Start time",v:woData.startTime||"Not started"},{l:"AFM contact",v:woData.afm},{l:"Asset model",v:woData.assetModel||"Not captured"},{l:"Serial number",v:woData.assetSerial||"Not captured"},{l:"AFM phone",v:woData.afmPhone}].map((d,i)=><div key={i}><div style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:.6,color:"#94a3b8",marginBottom:3}}>{d.l}</div><div style={{fontSize:13,fontWeight:500,color:d.v==="Not captured"||d.v==="Not set"||d.v==="Not started"?"#ef4444":"#1e293b"}}>{d.v}</div></div>)}
                    </div>
                  </div>

                  {/* Action buttons — DIFFERENT per role and status */}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:16}}>
                    {/* Manager actions */}
                    {woData.status==="unassigned"&&isManager&&<button onClick={()=>fire("Dispatch dialog — or use Auto-assign")} style={{padding:"9px 18px",borderRadius:10,background:"linear-gradient(135deg,#2563eb,#3b82f6)",color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Assign contractor</button>}
                    {woData.status==="completed"&&isManager&&<button onClick={()=>fire("Moved to Pending Invoice — 7-Eleven portal updated")} style={{padding:"9px 18px",borderRadius:10,background:"linear-gradient(135deg,#ec4899,#f472b6)",color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Portal updated → pending invoice</button>}

                    {/* Contractor actions — interactive modals */}
                    {woData.status==="assigned"&&!isManager&&<>
                      <button onClick={()=>setShowSetEta(true)} style={{padding:"9px 18px",borderRadius:10,background:"#fffbeb",color:"#d97706",border:"1px solid #fde68a",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Set / update ETA</button>
                      <button onClick={()=>setShowStartWork(true)} style={{padding:"9px 18px",borderRadius:10,background:"linear-gradient(135deg,#8b5cf6,#a78bfa)",color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Start work</button>
                    </>}
                    {woData.status==="wip"&&<>
                      <button onClick={()=>setShowPauseWork(true)} style={{padding:"9px 18px",borderRadius:10,background:"#fffbeb",color:"#d97706",border:"1px solid #fde68a",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Pause work</button>
                      {isManager&&<button onClick={()=>fire("Flagged for capital replacement")} style={{padding:"9px 18px",borderRadius:10,background:"#f5f3ff",color:"#7c3aed",border:"1px solid #c4b5fd",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Capital replacement</button>}
                      <button onClick={()=>setShowCloseComplete(true)} style={{padding:"9px 18px",borderRadius:10,background:"#f0fdf4",color:"#16a34a",border:"1px solid #bbf7d0",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Close complete</button>
                    </>}
                    {woData.status==="parts"&&!isManager&&<button onClick={()=>setShowStartWork(true)} style={{padding:"9px 18px",borderRadius:10,background:"linear-gradient(135deg,#8b5cf6,#a78bfa)",color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Resume work</button>}
                    {(woData.status==="completed"||woData.status==="pending_invoice")&&!isManager&&<button onClick={()=>setShowCreateInvoice(true)} style={{padding:"9px 18px",borderRadius:10,background:"linear-gradient(135deg,#ec4899,#f472b6)",color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Create invoice</button>}
                    <button onClick={()=>fire("NTE increase request")} style={{padding:"9px 18px",borderRadius:10,background:"#fff",color:"#475569",border:"1px solid #e2e8f0",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Exceed NTE</button>
                  </div>

                  {/* Activity feed */}
                  <div style={{background:"#fff",borderRadius:14,border:"1px solid #e2e8f0",padding:20}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                      <div style={{fontSize:14,fontWeight:700,color:"#0f172a"}}>Activity</div>
                      {isManager&&<button onClick={doAiEnhance} disabled={aiEnhancing} style={{padding:"6px 14px",borderRadius:8,background:aiEnhancing?"#f1f5f9":"linear-gradient(135deg,#7c3aed,#a78bfa)",color:aiEnhancing?"#94a3b8":"#fff",border:"none",cursor:aiEnhancing?"default":"pointer",fontWeight:600,fontSize:10,fontFamily:"inherit",display:"flex",alignItems:"center",gap:5}}>{aiEnhancing?<><span style={{display:"inline-block",width:12,height:12,border:"2px solid #c4b5fd",borderTopColor:"#7c3aed",borderRadius:"50%",animation:"spin 0.7s linear infinite"}}/> Enhancing...</>:"✨ AI enhance notes"}</button>}
                    </div>
                    <div style={{display:"flex",gap:8,marginBottom:18}}>
                      <input placeholder="Add a note..." style={{flex:1,padding:"9px 14px",borderRadius:10,border:"1px solid #e2e8f0",fontSize:12,fontFamily:"inherit"}}/>
                      <button onClick={()=>fire("Note posted")} style={{padding:"9px 16px",borderRadius:10,background:"#0f172a",color:"#fff",border:"none",cursor:"pointer",fontWeight:600,fontSize:12,fontFamily:"inherit"}}>Post</button>
                    </div>
                    {aiNote&&<div style={{background:"linear-gradient(135deg,#f5f3ff,#ede9fe)",border:"1px solid #c4b5fd",borderRadius:10,padding:14,marginBottom:16,animation:"fadeUp 0.3s"}}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}><span style={{fontSize:10,fontWeight:700,color:"#7c3aed",textTransform:"uppercase",letterSpacing:.5}}>✨ AI-enhanced version</span><button onClick={()=>{navigator.clipboard?.writeText(aiNote);fire("Copied")}} style={{fontSize:10,color:"#7c3aed",background:"#fff",border:"1px solid #c4b5fd",borderRadius:6,padding:"3px 10px",cursor:"pointer",fontFamily:"inherit",fontWeight:600}}>Copy</button></div><div style={{fontSize:12,color:"#3c3489",lineHeight:1.6}}>{aiNote}</div></div>}
                    {[{author:woData.contractor?getUser(woData.contractor)?.name:"System",time:"Apr 7, 9:15 AM",text:"Arrived on site. checked grease trap — overflowing bad. cleaned it out, snaked the line. running good now.",type:"note"},{author:"System",time:"Apr 6, 2:30 PM",text:`Work order assigned to ${woData.contractor?getUser(woData.contractor)?.name:"contractor"}. ETA: ${woData.eta||"not set"}.`,type:"system"},{author:woData.afm,time:"Apr 6, 2:15 PM",text:"AFM approved assignment.",type:"note"},{author:"System",time:"Apr 6, 10:00 AM",text:`Service call created. NTE: ${fmt(woData.nte)}.`,type:"system"}].map((e,i)=><div key={i} style={{display:"flex",gap:12,marginBottom:16,animation:`fadeUp 0.3s ${i*0.05}s both`}}><div style={{width:8,height:8,borderRadius:"50%",background:e.type==="system"?"#e2e8f0":"#3b82f6",marginTop:5,flexShrink:0}}/><div><div style={{fontSize:12}}><span style={{fontWeight:600,color:"#1e293b"}}>{e.author}</span><span style={{color:"#94a3b8",marginLeft:8,fontSize:10}}>{e.time}</span></div><div style={{fontSize:12,color:"#64748b",lineHeight:1.5,marginTop:2}}>{e.text}</div></div></div>)}
                  </div>
                </div>

                {/* Right sidebar */}
                <div>
                  {woData.contractor&&<div style={{background:"#fff",borderRadius:14,border:"1px solid #e2e8f0",padding:18,marginBottom:14}}><div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.6,color:"#94a3b8",marginBottom:10}}>Contractor</div><div style={{display:"flex",alignItems:"center",gap:10}}><Avatar initials={getUser(woData.contractor)?.initials} color={getUser(woData.contractor)?.color} size={38}/><div><div style={{fontSize:13,fontWeight:700}}>{getUser(woData.contractor)?.name}</div><div style={{fontSize:11,color:"#64748b"}}>{getUser(woData.contractor)?.company}</div></div></div></div>}
                  {woData.eta&&<div style={{background:"#fffbeb",borderRadius:14,border:"1px solid #fde68a",padding:18,marginBottom:14}}><div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.6,color:"#92400e",marginBottom:6}}>Contractor ETA</div><div style={{fontSize:15,fontWeight:700,color:"#78350f"}}>{woData.eta}</div><div style={{fontSize:10,color:"#a16207",marginTop:4}}>Auto-notify if not checked in by this time</div></div>}
                  <div style={{background:"#fff",borderRadius:14,border:"1px solid #e2e8f0",padding:18,marginBottom:14}}>
                    <div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.6,color:"#94a3b8",marginBottom:12}}>Progress</div>
                    {[{label:"Created",done:true},{label:"Assigned + ETA",done:["assigned","wip","parts","capital","completed","pending_invoice","pending_approval"].includes(woData.status)},{label:"Work started",done:["wip","parts","capital","completed","pending_invoice","pending_approval"].includes(woData.status)},{label:"Asset captured",done:!!woData.assetModel},{label:"Completed",done:["completed","pending_invoice","pending_approval"].includes(woData.status)},{label:"Portal updated",done:["pending_invoice","pending_approval"].includes(woData.status)},{label:"Invoiced",done:["pending_approval"].includes(woData.status)}].map((step,i,arr)=><div key={i} style={{display:"flex",gap:12,position:"relative"}}>{i<arr.length-1&&<div style={{position:"absolute",left:9,top:20,width:2,height:20,background:step.done&&arr[i+1]?.done?"#22c55e":"#e2e8f0"}}/>}<div style={{width:20,height:20,borderRadius:"50%",border:step.done?"none":"2px solid #e2e8f0",background:step.done?"#22c55e":"#fff",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{step.done&&<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3"><path d="M20 6L9 17l-5-5"/></svg>}</div><div style={{paddingBottom:16}}><div style={{fontSize:12,fontWeight:step.done?600:400,color:step.done?"#1e293b":"#94a3b8"}}>{step.label}</div></div></div>)}
                  </div>
                  {woData.partNeeded&&<div style={{background:"linear-gradient(135deg,#fffbeb,#fef9c3)",borderRadius:14,border:"1px solid #fde68a",padding:18}}><div style={{fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.6,color:"#92400e",marginBottom:6}}>{woData.status==="capital"?"Equipment on order":"Part on order"}</div><div style={{fontSize:13,fontWeight:600,color:"#78350f"}}>{woData.partNeeded}</div>{woData.partEta&&<div style={{fontSize:11,color:"#a16207",marginTop:4}}>ETA: {woData.partEta}</div>}</div>}
                </div>
              </div>
            </div>
          )}

          {/* CONTRACTOR MY JOBS */}
          {page==="my_jobs"&&!isManager&&(
            <div style={{animation:"fadeUp 0.3s"}}>
              <div className="stats-grid" style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,marginBottom:24}}>
                {[{label:"Active jobs",value:myWOs.filter(w=>activeStatuses.includes(w.status)).length,color:"#3b82f6",bg:"linear-gradient(135deg,#eff6ff,#f0f9ff)"},{label:"Pending invoices",value:myWOs.filter(w=>w.status==="pending_invoice").length,color:"#ec4899",bg:"linear-gradient(135deg,#fdf2f8,#fff1f3)"},{label:"Capital projects",value:myWOs.filter(w=>w.status==="capital").length,color:"#7c3aed",bg:"linear-gradient(135deg,#f5f3ff,#ede9fe)"}].map((s,i)=><div key={i} style={{background:s.bg,borderRadius:14,padding:"18px 22px",border:"1px solid #e2e8f0"}}><div style={{fontSize:10,color:"#64748b",fontWeight:600,textTransform:"uppercase",letterSpacing:1,marginBottom:8}}>{s.label}</div><div className="stat-value" style={{fontSize:28,fontWeight:800,color:s.color,fontFamily:"'DM Mono',monospace",letterSpacing:-1.5}}>{s.value}</div></div>)}
              </div>
              {myWOs.map((wo,i)=><div key={wo.id} onClick={()=>{setSelectedWO(wo.id);setPage("wo_detail");setAiNote(null)}} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"16px 20px",background:"#fff",borderRadius:12,border:"1px solid #e2e8f0",marginBottom:8,cursor:"pointer",animation:`fadeUp 0.3s ${i*0.04}s both`,gap:12}}><div style={{flex:1,minWidth:0}}><div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4,flexWrap:"wrap"}}><span style={{fontSize:11,fontFamily:"'DM Mono',monospace",fontWeight:600,color:"#3b82f6"}}>{wo.id}</span><Badge conf={PRIORITY[wo.priority]}/>{wo.eta&&<span style={{fontSize:10,fontWeight:600,color:"#f59e0b"}}>ETA {wo.eta.split(", ")[1]}</span>}</div><div style={{fontSize:14,fontWeight:600,color:"#0f172a",marginBottom:2}}>Store #{wo.store} · {wo.city}</div><div style={{fontSize:12,color:"#64748b",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{wo.issue}</div></div><div style={{textAlign:"right",flexShrink:0}}><Badge conf={STATUS[wo.status]}/><div style={{fontSize:10,color:"#94a3b8",marginTop:4}}>{wo.age}</div></div></div>)}
            </div>
          )}

          {/* INVOICES */}
          {page==="invoices"&&(
            <div style={{animation:"fadeUp 0.3s"}}>
              <div style={{display:"flex",gap:0,marginBottom:16,borderBottom:"2px solid #e2e8f0",overflowX:"auto"}}>{[{id:"all",l:"All"},{id:"submitted",l:"Submitted"},{id:"rejected",l:"Rejected"},{id:"approved",l:"Approved"}].map(t=><button key={t.id} onClick={()=>setInvTab(t.id)} style={{padding:"10px 18px",fontSize:12,fontWeight:invTab===t.id?700:400,color:invTab===t.id?"#0f172a":"#94a3b8",background:"none",border:"none",borderBottom:invTab===t.id?"2px solid #0f172a":"2px solid transparent",cursor:"pointer",fontFamily:"inherit",marginBottom:-2,whiteSpace:"nowrap"}}>{t.l}</button>)}</div>
              <div className="table-scroll" style={{background:"#fff",borderRadius:14,border:"1px solid #e2e8f0",overflow:"hidden"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}><thead><tr style={{background:"#f8fafc"}}>{["Invoice #","Work order","Contractor","State","Date","Store","Total"].map(h=><th key={h} style={{textAlign:h==="Total"?"right":"left",padding:"11px 14px",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:.6,color:"#94a3b8",borderBottom:"1px solid #e2e8f0",whiteSpace:"nowrap"}}>{h}</th>)}</tr></thead>
                <tbody>{(isManager?INVOICES:INVOICES.filter(i=>i.contractor===currentUser.id)).filter(i=>invTab==="all"||i.state===invTab).map((inv,i)=><tr key={inv.num} style={{borderBottom:"1px solid #f1f5f9",animation:`fadeUp 0.3s ${i*0.03}s both`}}><td style={{padding:"12px 14px",fontFamily:"'DM Mono',monospace",fontWeight:600,fontSize:11,color:"#3b82f6",whiteSpace:"nowrap"}}>{inv.num}</td><td style={{padding:"12px 14px",fontFamily:"'DM Mono',monospace",fontSize:11,color:"#64748b",whiteSpace:"nowrap"}}>{inv.wot}</td><td style={{padding:"12px 14px",color:"#475569",whiteSpace:"nowrap"}}>{getUser(inv.contractor)?.name}</td><td style={{padding:"12px 14px"}}><Badge conf={INV_STATE[inv.state]}/></td><td style={{padding:"12px 14px",color:"#94a3b8",whiteSpace:"nowrap"}}>{inv.date}</td><td style={{padding:"12px 14px",whiteSpace:"nowrap"}}>#{inv.store}</td><td style={{padding:"12px 14px",textAlign:"right",fontFamily:"'DM Mono',monospace",fontWeight:700,whiteSpace:"nowrap"}}>{fmt(inv.total)}</td></tr>)}</tbody></table>
              </div>
            </div>
          )}

          {/* CONTRACTORS */}
          {page==="contractors"&&(
            <div className="contractors-grid" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:16,animation:"fadeUp 0.3s"}}>
              {USERS.filter(u=>u.role==="contractor").map((c,i)=>{const cWOs=WORK_ORDERS.filter(w=>w.contractor===c.id);const ac=cWOs.filter(w=>activeStatuses.includes(w.status)).length;const cc=cWOs.filter(w=>w.status==="capital").length;return <div key={c.id} style={{background:"#fff",borderRadius:14,border:"1px solid #e2e8f0",overflow:"hidden",animation:`fadeUp 0.35s ${i*0.08}s both`}}><div style={{padding:"22px 22px 16px",borderBottom:"1px solid #f1f5f9"}}><div style={{display:"flex",alignItems:"center",gap:12}}><Avatar initials={c.initials} color={c.color} size={46}/><div><div style={{fontSize:16,fontWeight:700,color:"#0f172a"}}>{c.name}</div><div style={{fontSize:12,color:"#64748b"}}>{c.company}</div></div></div></div><div style={{padding:"16px 22px",display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}><div><div style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#94a3b8",marginBottom:3}}>Territory</div><div style={{fontSize:12,fontWeight:500}}>{c.territory}</div></div><div><div style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#94a3b8",marginBottom:3}}>Active</div><div style={{fontSize:12,fontWeight:700,color:"#3b82f6"}}>{ac}</div></div><div><div style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#94a3b8",marginBottom:3}}>Capital</div><div style={{fontSize:12,fontWeight:700,color:"#7c3aed"}}>{cc}</div></div><div><div style={{fontSize:10,fontWeight:600,textTransform:"uppercase",letterSpacing:.5,color:"#94a3b8",marginBottom:3}}>Status</div><Badge conf={{label:"Active",color:"#22c55e",bg:"#f0fdf4",ring:"#bbf7d0"}}/></div></div><div style={{padding:"0 22px 18px"}}><button onClick={()=>{nav("work_orders");setFilterC(c.id)}} style={{width:"100%",padding:"9px",borderRadius:10,border:"1px solid #e2e8f0",background:"#f8fafc",color:"#475569",fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:"inherit"}}>View work orders →</button></div></div>})}
            </div>
          )}
        </div>
      </div>

      {/* ═══════════ MODALS ═══════════ */}

      {/* NEW WORK ORDER */}
      {showNewWO&&<Modal onClose={()=>setShowNewWO(false)} title="New work order"><div style={{display:"grid",gap:14}}><div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}><Field label="Store number"><Input placeholder="e.g. 36190"/></Field><Field label="Priority"><Select><option>Routine</option><option>Critical</option><option>Emergency</option></Select></Field></div><Field label="Description"><TextArea rows={3} placeholder="Describe the repair needed..."/></Field><div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}><Field label="NTE amount"><Input placeholder="$1,000"/></Field><Field label="Assign to"><Select><option>Auto-assign by territory</option><option>Unassigned</option>{USERS.filter(u=>u.role==="contractor").map(u=><option key={u.id}>{u.name}</option>)}</Select></Field></div></div><div style={{display:"flex",gap:8,marginTop:22,justifyContent:"flex-end"}}><BtnSecondary onClick={()=>setShowNewWO(false)}>Cancel</BtnSecondary><BtnPrimary onClick={()=>{setShowNewWO(false);fire("Work order created")}}>Create work order</BtnPrimary></div></Modal>}

      {/* SET ETA */}
      {showSetEta&&woData&&<Modal onClose={()=>setShowSetEta(false)} title="Set ETA" width={400}>
        <div style={{fontSize:12,color:"#64748b",marginBottom:16}}>When will you arrive at Store #{woData.store}? P1 will be notified if you don't check in by this time.</div>
        <div style={{display:"grid",gap:14}}>
          <div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <Field label="Date"><Input type="date" defaultValue="2026-04-10"/></Field>
            <Field label="Time"><Input type="time" defaultValue="14:00"/></Field>
          </div>
          <Field label="Notes (optional)"><Input placeholder="e.g. Coming from another job, might be 15 min late"/></Field>
        </div>
        <div style={{display:"flex",gap:8,marginTop:22,justifyContent:"flex-end"}}><BtnSecondary onClick={()=>setShowSetEta(false)}>Cancel</BtnSecondary><BtnPrimary onClick={()=>{setShowSetEta(false);fire("ETA set — P1 team notified")}}>Set ETA</BtnPrimary></div>
      </Modal>}

      {/* START WORK */}
      {showStartWork&&woData&&<Modal onClose={()=>setShowStartWork(false)} title={woData.status==="parts"?"Resume work":"Start work"} width={420}>
        <div style={{fontSize:12,color:"#64748b",marginBottom:16}}>You're checking in at Store #{woData.store}. Enter your actual arrival time.</div>
        <div style={{display:"grid",gap:14}}>
          <div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <Field label="Arrival date"><Input type="date" defaultValue="2026-04-10"/></Field>
            <Field label="Arrival time"><Input type="time" defaultValue={new Date().toTimeString().slice(0,5)}/></Field>
          </div>
          <Field label="Initial notes"><TextArea rows={2} placeholder="What are you seeing on site? Any initial observations..."/></Field>
        </div>
        <div style={{display:"flex",gap:8,marginTop:22,justifyContent:"flex-end"}}><BtnSecondary onClick={()=>setShowStartWork(false)}>Cancel</BtnSecondary><button onClick={()=>{setShowStartWork(false);fire(`Work started at ${now()} — timestamp recorded`)}} style={{padding:"10px 24px",borderRadius:10,background:"linear-gradient(135deg,#8b5cf6,#a78bfa)",color:"#fff",border:"none",cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit"}}>{woData.status==="parts"?"Resume work":"Start work"}</button></div>
      </Modal>}

      {/* PAUSE WORK */}
      {showPauseWork&&woData&&<Modal onClose={()=>setShowPauseWork(false)} title="Pause work" width={480}>
        <div style={{fontSize:12,color:"#64748b",marginBottom:16}}>Why can't the job be completed in this trip?</div>
        <div style={{display:"grid",gap:14}}>
          <Field label="Reason for pausing"><Select><option value="">Select a reason...</option><option>Temporary fix — equipment partially working</option><option>Awaiting parts — equipment completely down</option></Select></Field>
          <Field label="End time for this visit"><div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}><Input type="date" defaultValue="2026-04-10"/><Input type="time" defaultValue={new Date().toTimeString().slice(0,5)}/></div></Field>
          <div style={{padding:"14px 16px",background:"#fef2f2",borderRadius:10,border:"1px solid #fecaca"}}>
            <div style={{fontSize:11,fontWeight:700,color:"#991b1b",marginBottom:8,textTransform:"uppercase",letterSpacing:.5}}>Parts information (required if awaiting parts)</div>
            <div style={{display:"grid",gap:10}}>
              <Field label="Part description (generic)"><Input placeholder="e.g. Evaporator coil, blower motor, compressor..."/></Field>
              <Field label="Specific part number"><Input placeholder="e.g. Heatcraft BHL136BE"/></Field>
              <Field label="Expected return date"><Input type="date"/></Field>
            </div>
          </div>
          <Field label="Notes"><TextArea rows={2} placeholder="Explain what was done so far and what's needed..."/></Field>
        </div>
        <div style={{display:"flex",gap:8,marginTop:22,justifyContent:"flex-end"}}><BtnSecondary onClick={()=>setShowPauseWork(false)}>Cancel</BtnSecondary><button onClick={()=>{setShowPauseWork(false);fire("Work paused — status updated, P1 notified")}} style={{padding:"10px 24px",borderRadius:10,background:"#d97706",color:"#fff",border:"none",cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit"}}>Pause work</button></div>
      </Modal>}

      {/* CLOSE COMPLETE */}
      {showCloseComplete&&woData&&<Modal onClose={()=>setShowCloseComplete(false)} title="Close complete" width={520}>
        <div style={{fontSize:12,color:"#64748b",marginBottom:16}}>Complete the job for Store #{woData.store}. All fields are required.</div>
        <div style={{display:"grid",gap:14}}>
          <div style={{padding:"14px 16px",background:"#eff6ff",borderRadius:10,border:"1px solid #bfdbfe"}}>
            <div style={{fontSize:11,fontWeight:700,color:"#1e40af",marginBottom:8,textTransform:"uppercase",letterSpacing:.5}}>Asset information (required)</div>
            <div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <Field label="Asset model"><Input placeholder="e.g. Taylor 428, Carrier 48HCEE06" defaultValue={woData.assetModel||""}/></Field>
              <Field label="Serial number"><Input placeholder="e.g. TY-2019-44821" defaultValue={woData.assetSerial||""}/></Field>
            </div>
          </div>
          <div style={{padding:"14px 16px",background:"#f0fdf4",borderRadius:10,border:"1px solid #bbf7d0"}}>
            <div style={{fontSize:11,fontWeight:700,color:"#14532d",marginBottom:8,textTransform:"uppercase",letterSpacing:.5}}>DSP closure questionnaire</div>
            <Field label="Resolution code"><Select><option value="">Select...</option><option>Current asset evaluated</option><option>Current asset repaired</option><option>Current asset replaced</option><option>OEM warranty related</option><option>Other</option></Select></Field>
          </div>
          <Field label="Resolution details"><TextArea rows={3} placeholder="Brief summary of what was found and what was done to correct it..."/></Field>
          <div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <Field label="End date"><Input type="date" defaultValue="2026-04-10"/></Field>
            <Field label="End time"><Input type="time" defaultValue={new Date().toTimeString().slice(0,5)}/></Field>
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:22,justifyContent:"flex-end"}}><BtnSecondary onClick={()=>setShowCloseComplete(false)}>Cancel</BtnSecondary><button onClick={()=>{setShowCloseComplete(false);fire("Job completed — moved to Completed status")}} style={{padding:"10px 24px",borderRadius:10,background:"#16a34a",color:"#fff",border:"none",cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit"}}>Close complete</button></div>
      </Modal>}

      {/* CREATE INVOICE */}
      {showCreateInvoice&&woData&&<Modal onClose={()=>setShowCreateInvoice(false)} title="Create invoice" width={540}>
        <div style={{fontSize:12,color:"#64748b",marginBottom:16}}>Invoice for {woData.id} — Store #{woData.store}. Work order details are pre-filled.</div>
        <div style={{display:"grid",gap:14}}>
          <div style={{padding:"12px 16px",background:"#f8fafc",borderRadius:10,border:"1px solid #e2e8f0",display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
            <div><div style={{fontSize:9,fontWeight:600,textTransform:"uppercase",color:"#94a3b8"}}>WOT</div><div style={{fontSize:12,fontWeight:600,fontFamily:"'DM Mono',monospace"}}>{woData.id}</div></div>
            <div><div style={{fontSize:9,fontWeight:600,textTransform:"uppercase",color:"#94a3b8"}}>Store</div><div style={{fontSize:12,fontWeight:600}}>#{woData.store}</div></div>
            <div><div style={{fontSize:9,fontWeight:600,textTransform:"uppercase",color:"#94a3b8"}}>NTE</div><div style={{fontSize:12,fontWeight:600,fontFamily:"'DM Mono',monospace"}}>{fmt(woData.nte)}</div></div>
          </div>
          <div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <Field label="Your invoice number"><Input placeholder="e.g. INV-2026-0142"/></Field>
            <Field label="CME number"><Select><option value="">Select CME...</option><option>CME-001 HVAC repair</option><option>CME-002 Plumbing</option><option>CME-003 Electrical</option><option>CME-004 Refrigeration</option><option>CME-005 General maintenance</option></Select></Field>
          </div>
          <Field label="Work description"><TextArea rows={2} placeholder="Brief description of the work that explains the cost..." defaultValue={woData.issue}/></Field>
          <div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
            <Field label="Hourly rate"><Input placeholder="$0.00" type="number"/></Field>
            <Field label="Hours"><Input placeholder="0" type="number"/></Field>
            <Field label="OT hours"><Input placeholder="0" type="number"/></Field>
          </div>
          <div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
            <Field label="Materials"><Input placeholder="$0.00" type="number"/></Field>
            <Field label="Trip / freight"><Input placeholder="$25.00" defaultValue="25"/></Field>
            <Field label="Tax"><Input placeholder="$0.00" type="number"/></Field>
          </div>
          <div className="modal-form-row" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
            <Field label="Misc. costs (permits, etc.)"><Input placeholder="$0.00" type="number"/></Field>
            <Field label="Misc. description"><Input placeholder="e.g. Inspection fee, permit..."/></Field>
          </div>
          <div style={{padding:"12px 16px",background:"#fdf2f8",borderRadius:10,border:"1px solid #fbcfe8"}}>
            <Field label="Attach PDF invoice"><div style={{border:"2px dashed #fbcfe8",borderRadius:8,padding:"20px",textAlign:"center",cursor:"pointer"}}><div style={{fontSize:12,color:"#db2777",fontWeight:600}}>Click to upload or drag PDF here</div><div style={{fontSize:10,color:"#94a3b8",marginTop:4}}>Must match your invoice number above</div></div></Field>
          </div>
        </div>
        <div style={{display:"flex",gap:8,marginTop:22,justifyContent:"flex-end"}}><BtnSecondary onClick={()=>setShowCreateInvoice(false)}>Cancel</BtnSecondary><button onClick={()=>{setShowCreateInvoice(false);fire("Invoice submitted — pending approval")}} style={{padding:"10px 24px",borderRadius:10,background:"linear-gradient(135deg,#ec4899,#f472b6)",color:"#fff",border:"none",cursor:"pointer",fontWeight:700,fontSize:12,fontFamily:"inherit"}}>Submit invoice</button></div>
      </Modal>}

      {/* Toast */}
      {toast&&<div style={{position:"fixed",bottom:80,left:"50%",transform:"translateX(-50%)",background:"#0f172a",color:"#f1f5f9",padding:"11px 24px",borderRadius:12,fontSize:13,fontWeight:600,animation:"fadeUp 0.25s",zIndex:50,boxShadow:"0 8px 32px rgba(0,0,0,0.2)",whiteSpace:"nowrap"}}>{toast}</div>}
    </div>
  );
}
