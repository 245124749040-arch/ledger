/* ---------------- STATE ---------------- */
let uidCounter = 1;
const uid = (p) => p + (uidCounter++);

const state = {
  viewEdit: true,
  activeTab: 'setup',
  session: null,          // {role:'admin'|'teacher'|'receptionist', teacherId, name}
  teachers: [],
  classes: [],
  days: [
    {id:'Mon', on:true},{id:'Tue', on:true},{id:'Wed', on:true},
    {id:'Thu', on:true},{id:'Fri', on:true},{id:'Sat', on:true}
  ],
  periods: [],
  timetable: {},        // classId -> day -> periodId -> {subject, teacherId}
  absences: {},          // day -> {teacherId: true}
  substitutions: {},      // day -> classId -> periodId -> {subject, originalTeacherId, subTeacherId, status}
  buildClassId: null,
  viewDay: null,
  absenceDay: null,
  absenceTeacherId: null,
  lastSubResults: null,
  leaveRequests: [],      // {id, teacherId, from, to, reason, status:'pending'|'approved'|'rejected'}
  checkins: {},           // dateStr -> teacherId -> {inTime, outTime}
  notifications: [],      // {id, text, date, from}
  attendanceDate: null,
  leaveFilterMine: true,
  users: [],              // {id, username, password, role, teacherId, name}
  screen:'loading', busy:false, locBusy:false, policy:{retentionDays:730},
  workloadLog: {},        // dateStr -> {day, savedAt, data:{teacherId:{name,reg,cov,total}}}
  wlView: 'weekly', wlDate: null, wlMonth: null,
  atView: 'daily', atMonth: null
};
/* "today" always follows the school's time zone and the server's clock, not the device's */
let SCHOOL_TZ = 'Asia/Kolkata', clockSkew = 0;
function todayStr(){ return new Intl.DateTimeFormat('en-CA',{timeZone:SCHOOL_TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(Date.now()+clockSkew)); }
let hydrated = false;
let applyingRemote = false;

function defaultPeriods(){
  return [
    {id:uid('per'), label:'1', start:'09:00', end:'09:40', type:'period'},
    {id:uid('per'), label:'2', start:'09:40', end:'10:20', type:'period'},
    {id:uid('per'), label:'3', start:'10:20', end:'11:00', type:'period'},
    {id:uid('per'), label:'Break', start:'11:00', end:'11:10', type:'break'},
    {id:uid('per'), label:'4', start:'11:10', end:'11:50', type:'period'},
    {id:uid('per'), label:'5', start:'11:50', end:'12:30', type:'period'},
    {id:uid('per'), label:'Lunch', start:'12:30', end:'13:10', type:'lunch'},
    {id:uid('per'), label:'6', start:'13:10', end:'13:50', type:'period'},
    {id:uid('per'), label:'7', start:'13:50', end:'14:30', type:'period'},
    {id:uid('per'), label:'8', start:'14:30', end:'15:10', type:'period'},
    {id:uid('per'), label:'Break', start:'15:10', end:'15:20', type:'break'},
    {id:uid('per'), label:'9', start:'15:20', end:'16:00', type:'period'},
    {id:uid('per'), label:'10', start:'16:00', end:'16:30', type:'period'},
    {id:uid('per'), label:'11', start:'16:30', end:'17:10', type:'period'},   // CLASS X only (school ends 16:30)
  ];
}
state.periods = defaultPeriods();

/* ---------------- HELPERS ---------------- */
/* Subject types: 'core' (main subjects) or 'additional'. A day must always start with a core subject. */
const ADDITIONAL_HINT = /computer|\bart\b|craft|moral|grammar|\bgk\b|general\s*knowledge|d(?:ai|ia)ry|\blab\b|drawing|music|dance|sport|games?\b|yoga|library|value|activity|physical|handwriting|rhymes|story|^pt$|^pe$/i;
function guessSubjectType(name){ return ADDITIONAL_HINT.test(String(name||'')) ? 'additional' : 'core'; }
function subjectType(name){
  const ex = (state.subjectCatalog||[]).find(s=>String(s.name).toLowerCase()===String(name).toLowerCase());
  return ex && ex.type ? ex.type : guessSubjectType(name);
}
function isCoreSubject(name){ return subjectType(name)==='core'; }
function activeDays(){ return state.days.filter(d=>d.on).map(d=>d.id); }
function periodCols(){ return state.periods; }
function teachingPeriods(){ return state.periods.filter(p=>p.type==='period'); }
/* ---- per-class schedules: each class may have its own periods, timings and finishing time ---- */
const toMin = t => { const m=/^(\d{1,2}):(\d{2})/.exec(t||''); return m ? +m[1]*60 + +m[2] : null; };
function schedOf(c){ return (c && c.schedule) || state.periods; }
function slotOf(sched,p){
  const s=toMin(p.start), e=toMin(p.end);
  if(s!=null && e!=null && e>s) return {s,e};
  const i=sched.indexOf(p); return {s:i*100000, e:(i+1)*100000};   // untimed rows: aligned by position
}
const slotsOverlap = (a,b)=> a.s<b.e && b.s<a.e;
function pKey(sched,p){ return (p.start&&p.end) ? p.type+'|'+p.start+'|'+p.end : p.type+'#'+sched.indexOf(p); }
function classEndTime(c){ return c.endTime || (c.schedule ? '' : (isClassX(c.name) ? (state.classXEnd||'17:10') : (state.schoolEnd||'16:30'))); }
function periodForClass(c,p){ const e=classEndTime(c); return !e || !p.end || p.end<=e; }
function classPeriods(c){ return schedOf(c).filter(p=>p.type==='period' && periodForClass(c,p)); }
function classDayEnd(c){ return classEndTime(c) || schedOf(c).filter(p=>p.type==='period').reduce((m,p)=>p.end>m?p.end:m,''); }
/* master columns = every distinct slot used by any class, in time order (used by teacher / all-class views) */
function masterCols(){
  const cols=[], seen={};
  const add = sched => sched.forEach(p=>{
    const k=pKey(sched,p); let col=seen[k];
    if(!col){ col=seen[k]={key:k,type:p.type,label:p.label,start:p.start,end:p.end,slot:slotOf(sched,p),ord:cols.length}; cols.push(col); }
    else if(p.type==='period' && !String(col.label).split('/').includes(String(p.label))) col.label += '/'+p.label;
  });
  add(state.periods); state.classes.forEach(c=>{ if(c.schedule) add(c.schedule); });
  if(cols.length>state.periods.length) cols.sort((a,b)=>(a.slot.s-b.slot.s)||(a.slot.e-b.slot.e)||(a.ord-b.ord));
  return cols;
}
function classPeriodForCol(c,col){ const sc=schedOf(c); return sc.find(p=>pKey(sc,p)===col.key) || null; }
/* once all of a teacher's classes have finished for the day, later columns are not "leisure" */
function teacherOffAt(t,col){
  const ends = state.classes.filter(c=>(t.classIds||[]).includes(c.id)).map(classDayEnd);
  if(!ends.length || ends.some(e=>!e) || !col.start) return false;
  return col.start >= ends.reduce((m,e)=>e>m?e:m,'');
}
function allSubjects(){
  const s = new Set(state.subjectCatalog.map(x=>x.name));
  state.teachers.forEach(t=>t.subjects.forEach(sub=>s.add(sub)));
  return [...s].sort();
}
function getTeacher(id){ return state.teachers.find(t=>t.id===id); }
function getClass(id){ return state.classes.find(c=>c.id===id); }

function ensureCell(classId, day, periodId){
  state.timetable[classId] = state.timetable[classId] || {};
  state.timetable[classId][day] = state.timetable[classId][day] || {};
  state.timetable[classId][day][periodId] = state.timetable[classId][day][periodId] || {subject:'', teacherId:''};
  return state.timetable[classId][day][periodId];
}
function getCell(classId, day, periodId){
  return (state.timetable[classId] && state.timetable[classId][day] && state.timetable[classId][day][periodId]) || {subject:'', teacherId:''};
}
function getSub(day, classId, periodId){
  return state.substitutions[day] && state.substitutions[day][classId] && state.substitutions[day][classId][periodId];
}

/* who's occupied at day/period across all classes, honoring active substitutions */
function occupiedTeachersAt(day, slot, excludeClassId){
  const busy = new Set();
  state.classes.forEach(c=>{
    if(c.id===excludeClassId) return;
    const sc = schedOf(c);
    sc.forEach(p=>{
      if(p.type!=='period' || !slotsOverlap(slotOf(sc,p), slot)) return;
      const cell = getCell(c.id, day, p.id);
      if(!cell.teacherId) return;
      const sub = getSub(day, c.id, p.id);
      busy.add(sub ? sub.subTeacherId : cell.teacherId);
    });
  });
  const absentToday = state.absences[day] || {};
  Object.keys(absentToday).forEach(tid=>busy.add(tid)); // absent teachers can't be picked as subs either
  return busy;
}

function findSubstitute(day, slot, subject, excludeTeacherId, excludeClassId){
  const busy = occupiedTeachersAt(day, slot, excludeClassId);
  const candidates = state.teachers.filter(t=>t.id!==excludeTeacherId && !busy.has(t.id));
  const loadCount = (t)=>{ let n=0;
    state.classes.forEach(c=>schedOf(c).forEach(p=>{
      if(p.type!=='period') return;
      const cell = getCell(c.id, day, p.id), sub = getSub(day, c.id, p.id);
      if((sub ? sub.subTeacherId : cell.teacherId)===t.id) n++;
    }));
    return n; };
  const subjectMatches = candidates.filter(t=>t.subjects.some(s=>s.toLowerCase()===subject.toLowerCase()));
  const pool = subjectMatches.length ? subjectMatches : candidates;
  if(!pool.length) return null;
  pool.sort((a,b)=>loadCount(a)-loadCount(b));
  return {teacher: pool[0], subjectMatch: subjectMatches.length>0};
}

function markAbsent(day, teacherId){
  state.absences[day] = state.absences[day] || {};
  if(state.absences[day][teacherId]) return [];
  state.absences[day][teacherId] = true;
  const results = [];
  state.classes.forEach(c=>{
    const sc = schedOf(c);
    sc.filter(p=>p.type==='period').forEach(p=>{
      const cell = getCell(c.id, day, p.id);
      if(cell.teacherId === teacherId && cell.subject){
        const found = findSubstitute(day, slotOf(sc,p), cell.subject, teacherId, c.id);
        state.substitutions[day] = state.substitutions[day] || {};
        state.substitutions[day][c.id] = state.substitutions[day][c.id] || {};
        if(found){
          state.substitutions[day][c.id][p.id] = {
            subject: cell.subject, originalTeacherId: teacherId, subTeacherId: found.teacher.id, status:'pending'
          };
          results.push({ok:true, className:c.name, period:p.label, subject:cell.subject, sub:found.teacher.name, subjectMatch:found.subjectMatch});
        } else {
          state.substitutions[day][c.id][p.id] = {
            subject: cell.subject, originalTeacherId: teacherId, subTeacherId: null, status:'pending'
          };
          results.push({ok:false, className:c.name, period:p.label, subject:cell.subject});
        }
      }
    });
  });
  return results;
}

function clearAbsence(day, teacherId){
  if(state.absences[day]) delete state.absences[day][teacherId];
  if(state.substitutions[day]){
    Object.keys(state.substitutions[day]).forEach(classId=>{
      Object.keys(state.substitutions[day][classId]).forEach(periodId=>{
        if(state.substitutions[day][classId][periodId].originalTeacherId === teacherId){
          delete state.substitutions[day][classId][periodId];
        }
      });
    });
  }
}

/* ---------------- SUBSTITUTION RESPONSE (accept/reject/override) ---------------- */
function mySubRequests(teacherId){
  const out = [];
  Object.keys(state.substitutions).forEach(day=>{
    Object.keys(state.substitutions[day]).forEach(classId=>{
      Object.keys(state.substitutions[day][classId]).forEach(periodId=>{
        const s = state.substitutions[day][classId][periodId];
        if(s.subTeacherId===teacherId){
          out.push({day, classId, periodId, ...s});
        }
      });
    });
  });
  return out;
}
async function respondToSub(day, classId, periodId, decision){
  try{ await api('POST','/api/subs/respond',{day, classId, periodId, decision}); }
  catch(e){ alert(e.message); }
  await refreshState(true);
}
function overrideSub(day, classId, periodId, newTeacherId){
  const s = state.substitutions[day][classId][periodId];
  if(!s) return;
  s.subTeacherId = newTeacherId || null;
  s.status = 'pending';
  renderAll();
}

/* ---------------- LEAVE MANAGEMENT ---------------- */
async function applyLeave(teacherId, from, to, reason){
  if(!from || !to){ alert('Choose both dates.'); return; }
  try{ await api('POST','/api/leave',{from, to, reason}); await refreshState(true); }
  catch(e){ alert(e.message); }
}
function decideLeave(id, status){
  const lv = state.leaveRequests.find(l=>l.id===id);
  if(lv) lv.status = status;
  renderAll();
}

/* ---------------- CLASS ADVISOR + TEACHER EDIT ---------------- */
function advisorOptions(c){
  return state.teachers
    .filter(t=>(t.classIds||[]).includes(c.id) && !state.classes.some(o=>o.id!==c.id && o.advisorId===t.id))
    .map(t=>`<option value="${t.id}" ${c.advisorId===t.id?'selected':''}>${esc(t.name)}</option>`).join('');
}
function setAdvisor(classId, tid){ getClass(classId).advisorId = tid; renderAll(); }
function startEditTeacher(id){
  const t = getTeacher(id);
  state.tEdit = {id, name:t.name, phone:t.phone||'', assign:t.assignments.map(a=>({...a}))};
  renderAll();
}
function toggleEditAssign(classId, i){
  const s = getClass(classId).subjects[i], a = state.tEdit.assign;
  const k = a.findIndex(x=>x.classId===classId && x.subject===s);
  if(k>=0) a.splice(k,1); else a.push({classId, subject:s});
  renderAll();
}
function saveEditTeacher(){
  const e = state.tEdit, name = e.name.trim();
  if(!name){ alert('Enter the teacher name.'); return; }
  if(!e.assign.length){ alert('Pick at least one class and subject.'); return; }
  const t = getTeacher(e.id);
  t.name = name; t.phone = e.phone.trim(); t.assignments = e.assign.map(a=>({...a}));
  syncTeacher(t);
  state.classes.forEach(c=>{ if(c.advisorId===t.id && !t.classIds.includes(c.id)) c.advisorId=''; });
  state.tEdit = null; renderAll();
}
function cancelEditTeacher(){ state.tEdit = null; renderAll(); }
function teacherEditForm(){
  const e = state.tEdit;
  return `<div class="entry-row" style="display:block;background:var(--paper);padding:14px;">
    <div class="grid-2" style="gap:16px;">
      <div class="field"><label>Name</label><input type="text" value="${esc(e.name)}" oninput="state.tEdit.name=this.value"></div>
      <div class="field"><label>Phone (for SMS)</label><input type="text" value="${esc(e.phone)}" oninput="state.tEdit.phone=this.value"></div>
    </div>
    <div class="field"><label>Class &amp; subject</label>
      ${state.classes.map(c=>`<div style="margin-bottom:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <span class="class-cell" style="padding:4px 10px;font-size:12.5px;position:static;">${esc(c.name)}</span>
        ${c.subjects.map((s,i)=>`<div class="day-toggle ${e.assign.some(a=>a.classId===c.id&&a.subject===s)?'on':''}" onclick="toggleEditAssign('${c.id}',${i})">${esc(s)}</div>`).join('')}
      </div>`).join('')}
    </div>
    <button onclick="saveEditTeacher()">Save changes</button> <button class="ghost" onclick="cancelEditTeacher()">Cancel</button>
  </div>`;
}

/* ---------------- EXPORT: EXCEL + PDF ---------------- */
function exportHead(compact){
  return ['Day', ...masterCols().map(p=> p.type==='period' ? 'P'+p.label+((p.start||p.end)?'\n'+(p.start||'')+(p.end?(compact?'-\n':'–')+p.end:''):'') : (p.type==='break'?'Break':'Lunch'))];
}
/* Days with an identical schedule are merged into one row/page labelled e.g. "Mon–Sat" */
function dayLabel(days){
  if(days.length===1) return days[0];
  const idx = days.map(d=>state.days.findIndex(x=>x.id===d));
  const consecutive = idx.every((v,i)=> i===0 || v===idx[i-1]+1);
  return consecutive ? days[0]+'–'+days[days.length-1] : days.join(', ');
}
function groupDays(rowsFor){
  const groups = [];
  activeDays().forEach(d=>{
    const r = rowsFor(d), sig = JSON.stringify(r);
    let g = groups.find(x=>x.sig===sig);
    if(!g){ g = {sig, days:[], rows:r}; groups.push(g); }
    g.days.push(d);
  });
  return groups.map(g=>({label:dayLabel(g.days), rows:g.rows}));
}
function gridRows(fn){
  return groupDays(day=> masterCols().map(col=> fn(day,col)))
    .map(g=>[g.label, ...g.rows]);
}
function teacherCellText(t, day, col){
  for(const c of state.classes){ const p=classPeriodForCol(c,col); if(!p) continue; const x=getCell(c.id,day,p.id); if(x.subject && x.teacherId===t.id) return x.subject+'\n'+c.name; }
  return teacherOffAt(t,col) ? '—' : 'LEISURE';
}
function exportItems(kind){
  if(kind==='class') return state.classes.map(c=>{
    const adv = c.advisorId && getTeacher(c.advisorId);
    return {title:c.name, sub:'Class timetable'+(adv?' · Class teacher: '+adv.name:''), rows:gridRows((day,col)=>{
      const p = classPeriodForCol(c,col);
      if(!p || !periodForClass(c,p)) return '—';
      if(p.type!=='period') return p.type==='break'?'Break':'Lunch';
      const x = getCell(c.id,day,p.id); if(!x.subject) return 'LEISURE';
      const t = getTeacher(x.teacherId); return x.subject+(t?'\n'+t.name:'');
    })};
  });
  if(kind==='allteachers'){
    const shadeCols = masterCols().map((p,i)=>p.type!=='period'?i+2:-1).filter(i=>i>=0);
    const groups = groupDays(day=> state.teachers.map(t=> masterCols().map(p=> p.type!=='period' ? '' : teacherCellText(t,day,p))));
    return groups.map(g=>({
      title:"Teacher's Time Table — "+g.label,
      sub:"All teachers · "+state.teachers.length+" teachers · applies "+g.label,
      head:['S.No','Teacher',...exportHead(true).slice(1)],
      shadeCols,
      colStyles:{0:{cellWidth:8},1:{halign:'left',fontStyle:'bold',cellWidth:'wrap'}},
      rows:g.rows.map((r,i)=>[i+1, state.teachers[i].name, ...r])
    }));
  }
  const list = state.session.role==='teacher' ? state.teachers.filter(t=>t.id===state.session.teacherId) : state.teachers;
  return list.map(t=>({title:t.name, sub:'Teacher timetable · '+t.subjects.join(', '), rows:gridRows((day,col)=> col.type!=='period' ? (col.type==='break'?'Break':'Lunch') : teacherCellText(t,day,col))}));
}
function sheetName(n,used){
  let s = n.replace(/[\\\/?*\[\]:]/g,'_').slice(0,28)||'Sheet', k=s, i=2;
  while(used.has(k.toLowerCase())) k = s.slice(0,25)+'_'+(i++);
  used.add(k.toLowerCase()); return k;
}
async function saveFile(name, data){
  try{
    const d = await (window.claude && window.claude.use ? window.claude.use('downloads') : null);
    if(d){ await d.save({filename:name, data}); return; }
  }catch(e){ if(e && e.code==='declined') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([data])); a.download = name; a.click();
}
function exportExcel(kind){
  const items = exportItems(kind);
  if(!items.length){ alert('Nothing to export yet.'); return; }
  if(!window.XLSX){ alert('Excel library failed to load — check your connection.'); return; }
  const wb = XLSX.utils.book_new(), used = new Set(), flat = r=>r.map(v=>String(v).replace(/\n/g,' – '));
  items.forEach(it=>{
    const head = flat(it.head||exportHead());
    const ws = XLSX.utils.aoa_to_sheet([[it.title+' — '+it.sub],[],head,...it.rows.map(flat)]);
    ws['!cols'] = head.map((_,i)=>({wch: kind==='allteachers' ? (i===1?24:(i?16:6)) : (i?22:8)}));
    XLSX.utils.book_append_sheet(wb, ws, sheetName(it.title,used));
  });
  saveFile((kind==='allteachers'?'all-teachers':kind+'-wise')+'-timetable.xlsx', XLSX.write(wb,{type:'array',bookType:'xlsx'}));
}
function pdfOrient(){ return state.pdfOrient==='portrait' ? 'portrait' : 'landscape'; }
/* Draws each item on its own A4 page, shrinking the font until the whole table fits on that one page */
function renderPdfItems(doc, items, orient){
  const {jsPDF} = window.jspdf, M = 8;
  const W = doc.internal.pageSize.getWidth(), H = doc.internal.pageSize.getHeight();
  items.forEach((it,i)=>{
    if(i) doc.addPage();
    const draw = (d, fs)=>{
      d.setFontSize(14); d.setTextColor(34,48,89); d.text(it.title, M, M+6);
      d.setFontSize(8.5); d.setTextColor(90,100,95); d.text(it.sub, M, M+11);
      d.setTextColor(0);
      d.autoTable({startY:M+14, margin:{left:M,right:M,top:M,bottom:M}, tableWidth:W-2*M,
        head:[it.head||exportHead()], body:it.rows,
        styles:{fontSize:fs, cellPadding:Math.max(0.4,fs*0.2), valign:'middle', halign:'center', lineWidth:0.1, lineColor:[190,192,175], overflow:'linebreak'},
        headStyles:{fillColor:[34,48,89]},
        columnStyles: it.colStyles || {0:{fontStyle:'bold',halign:'left'}},
        didParseCell:d2=>{
          if(d2.section!=='body') return;
          if(d2.cell.raw==='LEISURE') d2.cell.styles.fillColor=[238,243,234];
          if(d2.cell.raw==='Break'||d2.cell.raw==='Lunch' || (it.shadeCols && it.shadeCols.includes(d2.column.index))) d2.cell.styles.fillColor=[232,230,218];
        }});
    };
    let fs = 10;
    for(; fs>3; fs-=0.5){
      const t = new jsPDF({orientation:orient,unit:'mm',format:'a4'});
      draw(t, fs);
      if(t.internal.getNumberOfPages()===1 && t.lastAutoTable.finalY <= H-M) break;
    }
    draw(doc, fs);
  });
}
function exportPdf(kind){
  const items = exportItems(kind);
  if(!items.length || !items[0].rows.length){ alert('Nothing to export yet.'); return; }
  if(!window.jspdf){ alert('PDF library failed to load — check your connection.'); return; }
  const orient = pdfOrient();
  const doc = new window.jspdf.jsPDF({orientation:orient,unit:'mm',format:'a4'});
  renderPdfItems(doc, items, orient);
  const base = kind==='allteachers' ? 'all-teachers' : kind+'-wise';
  saveFile(base+'-timetable-'+orient+'.pdf', doc.output('arraybuffer'));
}
function orientPick(){
  const o = pdfOrient();
  return `<span class="orient-pick">Page
    <select onchange="state.pdfOrient=this.value; renderAll();">
      <option value="landscape" ${o==='landscape'?'selected':''}>Landscape</option>
      <option value="portrait" ${o==='portrait'?'selected':''}>Portrait</option>
    </select></span>`;
}
function exportPanel(){
  const isT = state.session.role==='teacher';
  return `<div class="panel no-print">
    <h2 class="panel-title">Download timetables</h2>
    <p class="panel-desc">${isT?'Your timetable.':'Whole-school files: one sheet (Excel) or page (PDF) per class or per teacher, or every teacher on a single sheet.'} Days with the same schedule are shown once (e.g. Mon–Sat). Every PDF page fits on a single A4 sheet — choose the page orientation below. Exports show the regular timetable, without today's substitutions.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      ${orientPick()}
      ${isT?'':`<button class="ghost" onclick="exportExcel('class')">⬇ Class-wise · Excel</button><button class="ghost" onclick="exportPdf('class')">⬇ Class-wise · PDF</button>`}
      <button class="ghost" onclick="exportExcel('teacher')">⬇ ${isT?'My timetable':'Teacher-wise'} · Excel</button>
      <button class="ghost" onclick="exportPdf('teacher')">⬇ ${isT?'My timetable':'Teacher-wise'} · PDF</button>
      ${isT?'':`<button class="brass" onclick="exportPdf('allteachers')">⬇ All teachers (one page) · PDF</button><button class="ghost" onclick="exportExcel('allteachers')">⬇ All teachers · Excel</button>`}
    </div></div>`;
}
function allTeachersPanel(){
  const items = exportItems('allteachers');
  if(!items.length) return '';
  return `<div class="panel print-target-allteachers pm-src">
    <div class="print-header">
      <h2>Teacher's Time Table — all teachers</h2>
      <div class="meta">${state.teachers.length} teachers · generated ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</div>
    </div>
    <div class="print-btn-row no-print" style="gap:10px;align-items:center;">
      ${orientPick()}
      <button class="ghost" onclick="printAllTeachers()">⬇ Download PDF</button>
    </div>
    <h2 class="panel-title">All Teachers — one view</h2>
    <p class="panel-desc no-print">Every teacher's day on one sheet. Where the schedule is the same on several days it is shown once (e.g. Mon–Sat).</p>
    ${items.map(it=>`
      <div style="font:600 13px 'IBM Plex Mono',monospace;color:var(--indigo);margin:10px 0 6px;">${esc(it.title)}</div>
      <div class="tt-scroll"><table class="tt compact">
        <thead><tr>${it.head.map(h=>`<th>${esc(h).replace(/\n/g,'<br>')}</th>`).join('')}</tr></thead>
        <tbody>${it.rows.map(r=>`<tr>${r.map((v,ci)=>{
          if(it.shadeCols.includes(ci)) return `<td class="break-col"></td>`;
          if(ci===0) return `<td class="class-cell" style="text-align:center;">${v}</td>`;
          if(ci===1) return `<td class="class-cell"><b>${esc(v)}</b></td>`;
          if(v==='LEISURE') return `<td class="cell-leisure"><div class="cell-wrap"><span class="leisure">LEISURE</span></div></td>`;
          if(v==='—') return `<td class="cell-absent"><div class="cell-wrap"><span class="cell-empty">—</span></div></td>`;
          const [sub,cls] = String(v).split('\n');
          return v ? `<td><div class="cell-wrap"><div class="cell-subject">${esc(sub)}</div><div class="cell-teacher">${esc(cls||'')}</div></div></td>` : `<td><div class="cell-wrap"><span class="cell-empty"></span></div></td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table></div>`).join('')}
  </div>`;
}

/* ---------------- ATTENDANCE LOCATION ----------------
   The browser asks the device for its position; the SERVER checks it against the campus point
   (the app never decides by itself, so a teacher cannot edit the check in the browser).
   Only the distance and accuracy are stored — not the coordinates. */
function locError(code){
  const e = new Error(LOC_MSG[code]()); e.code = code; return e;
}
function permissionHelp(){
  const ua = navigator.userAgent || '';
  if(/iPhone|iPad|iPod/.test(ua)) return 'open Settings → Privacy & Security → Location Services → Safari Websites → choose “While Using”, then come back and reload this page.';
  if(/Android/.test(ua)) return 'tap the padlock (or the ⋮ menu → Site settings) next to the address bar → Permissions → Location → Allow, then reload this page. Also check that Location is switched on in your phone’s quick settings.';
  return 'click the padlock next to the address in your browser → Site settings → Location → Allow, then reload this page.';
}
const LOC_MSG = {
  insecure:    () => 'Location only works on a secure page. Open this site using its https:// address and try again.',
  unsupported: () => 'This browser cannot provide a location. Try the latest Chrome, Safari or Firefox.',
  denied:      () => 'Location is blocked for this site, so attendance cannot be checked. To allow it: ' + permissionHelp(),
  unavailable: () => 'Your device could not work out its position. Switch on Location/GPS with “Precise” or “High accuracy” enabled, move next to a window or outdoors, and try again.',
  timeout:     () => 'Could not get a GPS fix in time. Move next to a window or outdoors, make sure Location is switched on, and try again.'
};
async function locationPermissionState(){
  try{ if(navigator.permissions && navigator.permissions.query) return (await navigator.permissions.query({name:'geolocation'})).state; }catch(e){}
  return 'unknown';
}
/* Listens to the GPS for up to maxWait ms and keeps the most accurate reading; stops early once it is good enough. */
function getPos({targetAcc=20, maxWait=25000, onProgress}={}){
  return new Promise((resolve,reject)=>{
    if(!window.isSecureContext) return reject(locError('insecure'));
    if(!navigator.geolocation) return reject(locError('unsupported'));
    let best = null, lastErr = null, finished = false, watchId = null, timer = null;
    const startedAt = Date.now();
    const finish = (fn, v)=>{ if(finished) return; finished = true; try{ navigator.geolocation.clearWatch(watchId); }catch(e){} clearTimeout(timer); fn(v); };
    timer = setTimeout(()=>{ if(best) finish(resolve,best); else finish(reject, locError(lastErr && lastErr.code===2 ? 'unavailable' : 'timeout')); }, maxWait);
    watchId = navigator.geolocation.watchPosition(pos=>{
      if(pos.timestamp > 1e12 && pos.timestamp < startedAt-60000) return;        // ignore a stale cached fix
      const c = pos.coords, acc = Number.isFinite(c.accuracy) ? c.accuracy : 99999;
      if(!best || acc < best.accuracy) best = {latitude:c.latitude, longitude:c.longitude, accuracy:acc};
      if(onProgress) onProgress(best.accuracy);
      if(best.accuracy <= targetAcc) finish(resolve,best);
    }, err=>{
      lastErr = err;
      if(err.code===1) finish(reject, locError('denied'));
    }, {enableHighAccuracy:true, maximumAge:0, timeout:maxWait});
  });
}
function setLocLive(text){
  state.locMsg = {ok:true, text};
  const el = document.getElementById('locStatus'); if(el) el.textContent = text;
}
/* shared by Check in / Check out / Test: permission → precise fix */
async function captureFix(){
  const maxAcc = (state.campus && state.campus.maxAccuracy) || 100;
  const perm = await locationPermissionState();
  if(perm==='denied') throw locError('denied');
  setLocLive('Getting your location… keep this page open and stay outdoors or near a window.');
  const p = await getPos({targetAcc:Math.min(25,maxAcc), maxWait:25000, onProgress:a=>setLocLive(`Getting a precise fix… currently accurate to ±${Math.round(a)} m`)});
  return {p, maxAcc, perm};
}
async function markAttendance(kind){
  if(state.locBusy) return;
  if(!(await ensureLocationConsent())) return;
  state.locBusy = true; state.locMsg = {ok:true, text:'Checking location permission…'}; renderAll();
  try{
    const {p, maxAcc} = await captureFix();
    if(p.accuracy > maxAcc) throw new Error(`Your GPS is only accurate to ±${Math.round(p.accuracy)} m (needs ±${maxAcc} m or better). Move outdoors or next to a window, make sure Precise / High-accuracy location is on, and try again.`);
    setLocLive('Verifying with the school server…');
    const d = await api('POST','/api/attendance',{kind, lat:p.latitude, lng:p.longitude, accuracy:p.accuracy});
    state.locMsg = {ok:true, text:d.message};
    await loadAttendanceMonth(todayStr().slice(0,7));
  }catch(e){
    if(e.code==='ack_required') state.session.locationAck = false;
    state.locMsg = {ok:false, text:e.message};
  }
  state.locBusy = false; renderAll();
}
/* a dry run that saves nothing — lets a teacher (or the Admin) try the exact same check from any spot on campus */
async function testMyLocation(){
  if(state.locBusy) return;
  if(!(await ensureLocationConsent())) return;
  state.locBusy = true; state.locMsg = {ok:true, text:'Checking location permission…'}; renderAll();
  try{
    const {p, perm} = await captureFix();
    const d = await api('POST','/api/location-test',{lat:p.latitude, lng:p.longitude, accuracy:p.accuracy});
    const parts = [`Secure page (HTTPS): ${window.isSecureContext?'yes':'NO'}`, `Permission: ${perm}`, `GPS accuracy: ±${Math.round(p.accuracy)} m`];
    if(!d.configured) parts.push('The Admin has not set the campus location yet.');
    else parts.push(`${d.dist} m from the campus point (limit ${d.radius} m)`, d.wouldPass ? '→ a check-in from here WOULD BE ACCEPTED.' : '→ a check-in from here would be REFUSED: '+d.reason);
    state.locMsg = {ok:!!(d.configured && d.wouldPass), text:parts.join(' · ')+' (Nothing was saved.)'};
  }catch(e){ state.locMsg = {ok:false, text:e.message}; }
  state.locBusy = false; renderAll();
}
async function useHereAsCampus(){
  if(state.locBusy) return;
  state.locBusy = true; renderAll();
  const say = (ok,t)=>{ state.locMsg = {ok,text:t}; const el = document.getElementById('locStatus'); if(el){ el.textContent = t; el.className = ok ? 'log-item' : 'log-item fail'; } };
  try{
    const perm = await locationPermissionState(); if(perm==='denied') throw locError('denied');
    say(true,'Getting a precise fix… stand in the middle of the campus, outdoors, and wait a few seconds.');
    const p = await getPos({targetAcc:12, maxWait:40000, onProgress:a=>say(true,`Getting a precise fix… currently accurate to ±${Math.round(a)} m`)});
    if(p.accuracy > 50) throw new Error(`GPS accuracy is only ±${Math.round(p.accuracy)} m — too rough to mark the campus point. Go outdoors, wait for a better signal and try again.`);
    state.locBusy = false; renderAll();
    document.getElementById('campLat').value = p.latitude.toFixed(6);
    document.getElementById('campLng').value = p.longitude.toFixed(6);
    say(true,`Your position was filled in (GPS accuracy ±${Math.round(p.accuracy)} m). Press “Save campus location” to apply it.`);
    return;
  }catch(e){ say(false, e.message); }
  state.locBusy = false; renderAll();
}
async function saveCampus(){
  const lat = parseFloat(val('campLat')), lng = parseFloat(val('campLng'));
  const rad = parseFloat(val('campRad')), acc = parseFloat(val('campAcc'));
  if(!isFinite(lat)||!isFinite(lng)||lat<-90||lat>90||lng<-180||lng>180){ alert('Enter a valid latitude (−90 to 90) and longitude (−180 to 180).'); return; }
  if(!isFinite(rad)||rad<20||rad>2000){ alert('The allowed radius must be between 20 and 2000 metres.'); return; }
  if(!isFinite(acc)||acc<10||acc>500){ alert('The maximum GPS error must be between 10 and 500 metres.'); return; }
  state.campus = {lat, lng, radius:Math.round(rad), maxAccuracy:Math.round(acc)};
  state.locMsg = {ok:true, text:'Saving…'}; renderAll();
  const okSave = await persistState();
  state.locMsg = okSave ? {ok:true, text:`Campus location saved — check-in is allowed within ${Math.round(rad)} m, with GPS accurate to ±${Math.round(acc)} m or better.`}
                        : {ok:false, text:'The campus location could not be saved. See the message at the bottom of the page.'};
  renderAll();
}


/* ---------------- DATA IMPORT (Excel / CSV) ---------------- */
const normKey = k => String(k||'').toLowerCase().replace(/[^a-z0-9]/g,'');
const lcEq = (a,b) => String(a).trim().toLowerCase()===String(b).trim().toLowerCase();
const splitList = v => String(v==null?'':v).split(/[,;|\n]+/).map(x=>x.trim()).filter(Boolean);
const pad2 = n => String(n).padStart(2,'0');
function pick(r, keys){ for(const k of keys){ if(r[k]!==undefined && String(r[k]).trim()!=='') return r[k]; } return ''; }
function normTime(v){
  if(v==null || v==='') return '';
  if(v instanceof Date) return pad2(v.getHours())+':'+pad2(v.getMinutes());
  if(typeof v==='number'){ const m = Math.round((v%1)*1440)%1440; return pad2(Math.floor(m/60))+':'+pad2(m%60); }
  const m = String(v).trim().toLowerCase().match(/^(\d{1,2})(?:[:.h](\d{2}))?\s*(am|pm)?$/);
  if(!m) return '';
  let h=+m[1], mi=+(m[2]||0);
  if(m[3]==='pm' && h<12) h+=12; if(m[3]==='am' && h===12) h=0;
  return (h>23||mi>59) ? '' : pad2(h)+':'+pad2(mi);
}
function sheetKind(name, headers){
  const n = String(name).toLowerCase(), h = new Set(headers);
  if(/schedule|period|timing|structure/.test(n) || ((h.has('start')||h.has('starttime')) && (h.has('end')||h.has('endtime')))) return 'schedule';
  if(/teacher|staff/.test(n)) return 'teachers';
  if(/class/.test(n)) return 'classes';
  if(/subject/.test(n)) return 'subjects';
  if(h.has('teacher')||h.has('teachername')||h.has('phone')||h.has('mobile')||h.has('staff')) return 'teachers';
  if((h.has('class')||h.has('classname')||h.has('grade')) && (h.has('subjects')||h.has('subject'))) return 'classes';
  if(h.has('subject')||h.has('subjects')||h.has('subjectname')) return 'subjects';
  return null;
}
function readSheets(wb){
  return wb.SheetNames.map(name=>{
    const raw = XLSX.utils.sheet_to_json(wb.Sheets[name], {defval:'', raw:true, cellDates:false});
    const rows = raw.map(r=>{ const o={}; Object.keys(r).forEach(k=>{ o[normKey(k)] = r[k]; o.__first = o.__first===undefined ? r[k] : o.__first; }); return o; });
    const headers = raw.length ? Object.keys(raw[0]).map(normKey) : [];
    return {name, rows, headers, kind: sheetKind(name, headers)};
  });
}
function importSubjects(rows, st){
  rows.forEach(r=>{
    const n = String(pick(r,['subject','subjects','subjectname','name'])||r.__first||'').trim();
    const typ = pick(r,['type','category','kind','subjecttype']);
    const had = state.subjectCatalog.find(s=>lcEq(s.name,n));
    const canon = addSubj(n, st, typ);
    const nt = normType(typ);
    if(had && nt) had.type = nt;     // re-importing a Subjects sheet updates the type
  });
}
function normType(v){
  const t = String(v||'').trim().toLowerCase();
  if(!t) return '';
  if(/^(core|main|major|primary|c|m)\b/.test(t)) return 'core';
  if(/^(add|additional|extra|minor|secondary|optional|a)\b/.test(t)) return 'additional';
  return '';
}
function addSubj(n, st, typ){
  n = String(n||'').trim(); if(!n) return null;
  const ex = state.subjectCatalog.find(s=>lcEq(s.name,n)); if(ex) return ex.name;
  state.subjectCatalog.push({name:n, type: normType(typ)||guessSubjectType(n)}); st.subjects++; return n;
}
function importClasses(rows, st, advisorReq){
  rows.forEach(r=>{
    const name = String(pick(r,['class','classname','grade','name'])).trim(); if(!name) return;
    let c = state.classes.find(x=>lcEq(x.name,name));
    if(!c){ c = {id:uid('c'), name, subjects:[], advisorId:''}; state.classes.push(c); st.classes++; }
    splitList(pick(r,['subjects','subject'])).forEach(sn=>{
      const canon = addSubj(sn, st);
      if(canon && !c.subjects.some(x=>lcEq(x,canon))) c.subjects.push(canon);
    });
    const adv = String(pick(r,['classteacher','advisor','classadvisor','classteachername'])).trim();
    if(adv) advisorReq.push({classId:c.id, teacher:adv});
  });
}
function importTeachers(rows, st, warn){
  const groups = new Map();
  rows.forEach(r=>{
    const name = String(pick(r,['teacher','teachername','name','staff'])).trim(); if(!name) return;
    const key = name.toLowerCase();
    if(!groups.has(key)) groups.set(key, {name, phone:'', items:[]});
    const g = groups.get(key);
    const ph = String(pick(r,['phone','phonenumber','mobile','contact'])).trim(); if(ph) g.phone = ph;
    const subs = splitList(pick(r,['subjects','subject']));
    if(subs.length) g.items.push({classes:splitList(pick(r,['class','classes','classname'])), subjects:subs});
  });
  groups.forEach(g=>{
    let t = state.teachers.find(x=>lcEq(x.name,g.name)), isNew = !t;
    if(!t){
      t = {id:uid('t'), name:g.name, phone:g.phone, assignments:[], subjects:[], classIds:[]};
      state.teachers.push(t);
      st.teachersNew++;
    } else { if(g.phone) t.phone = g.phone; st.teachersUpd++; }
    let added = 0;
    g.items.forEach(it=>{
      it.subjects.forEach(sn=>{
        const canon = addSubj(sn, st);
        let targets;
        if(it.classes.length){
          targets = [];
          it.classes.forEach(cn=>{ const c = state.classes.find(x=>lcEq(x.name,cn)); if(c) targets.push(c); else warn(`${g.name}: class "${cn}" not found — skipped`); });
        } else {
          targets = state.classes.filter(c=>c.subjects.some(x=>lcEq(x,canon)));
          if(!targets.length) warn(`${g.name}: no class has the subject "${canon}" — skipped`);
        }
        targets.forEach(c=>{
          if(!c.subjects.some(x=>lcEq(x,canon))){ warn(`${g.name}: ${c.name} doesn't have the subject "${canon}" — skipped`); return; }
          if(!t.assignments.some(a=>a.classId===c.id && lcEq(a.subject,canon))){ t.assignments.push({classId:c.id, subject:canon}); added++; }
        });
      });
    });
    syncTeacher(t);
    if(isNew && !t.assignments.length) warn(`${g.name}: added, but not assigned to any class/subject yet`);
  });
}
function applyAdvisors(reqs, warn){
  reqs.forEach(q=>{
    const c = getClass(q.classId), t = state.teachers.find(x=>lcEq(x.name,q.teacher));
    if(!t) return warn(`${c.name}: class teacher "${q.teacher}" not found`);
    if(!(t.classIds||[]).includes(c.id)) return warn(`${c.name}: ${t.name} isn't assigned to this class, so can't be its class teacher`);
    const other = state.classes.find(o=>o.id!==c.id && o.advisorId===t.id);
    if(other) return warn(`${c.name}: ${t.name} is already class teacher of ${other.name}`);
    c.advisorId = t.id;
  });
}
function importSchedule(rows, warn){
  const out = [];
  rows.forEach((r,i)=>{
    const typeRaw = String(pick(r,['type','kind'])).toLowerCase();
    const type = /break|recess/.test(typeRaw) ? 'break' : (/lunch/.test(typeRaw) ? 'lunch' : 'period');
    const start = normTime(pick(r,['start','starttime','from'])), end = normTime(pick(r,['end','endtime','to']));
    if(!start && !end && !String(pick(r,['label','period','name'])).trim()) return;
    if(String(pick(r,['start','starttime','from'])).trim()!=='' && !start) warn(`Row ${i+2}: couldn't read start time "${pick(r,['start','starttime','from'])}"`);
    if(String(pick(r,['end','endtime','to'])).trim()!=='' && !end) warn(`Row ${i+2}: couldn't read end time "${pick(r,['end','endtime','to'])}"`);
    let label = String(pick(r,['label','period','name'])).trim();
    if(!label) label = type==='break' ? 'Break' : (type==='lunch' ? 'Lunch' : String(out.filter(x=>x.type==='period').length+1));
    out.push({id:uid('per'), label, start, end, type});
  });
  return out;
}
async function handleImport(input, scope){
  const f = input.files && input.files[0]; input.value = '';
  if(!f) return;
  if(!window.XLSX){ alert('Import library failed to load — check your connection.'); return; }
  const lines = [], warns = [], st = {subjects:0, classes:0, teachersNew:0, teachersUpd:0};
  const warn = w => warns.push(w);
  let ok = true;
  try{
    const wb = XLSX.read(await f.arrayBuffer(), {type:'array'});
    const sheets = readSheets(wb), find = k => sheets.filter(x=>x.kind===k);
    if(scope==='schedule'){
      const sh = find('schedule');
      if(!sh.length) throw new Error('No schedule found. Expected columns: Label, Start, End, Type.');
      const periods = importSchedule(sh[0].rows, warn);
      if(!periods.length) throw new Error('The schedule sheet has no usable rows.');
      if(Object.keys(state.timetable).length && !confirm(`Replace the current ${state.periods.length} rows with ${periods.length} imported rows? The timetable will need regenerating.`)){ return; }
      state.periods = periods; state.timetable = {}; state.substitutions = {};
      lines.push(`Schedule imported: ${periods.filter(p=>p.type==='period').length} periods, ${periods.filter(p=>p.type!=='period').length} breaks/lunch.`);
      if(state.autoGen) lines.push('Timetable will regenerate automatically.'); else lines.push('Go to "Build Timetable" and press Generate.');
    } else {
      const advisorReq = [];
      find('subjects').forEach(sh=>importSubjects(sh.rows, st));
      find('classes').forEach(sh=>importClasses(sh.rows, st, advisorReq));
      find('teachers').forEach(sh=>importTeachers(sh.rows, st, warn));
      applyAdvisors(advisorReq, warn);
      const skipped = sheets.filter(x=>!x.kind || x.kind==='schedule').map(x=>x.name);
      if(!find('subjects').length && !find('classes').length && !find('teachers').length)
        throw new Error('Nothing recognised. Use sheets named Subjects, Classes and Teachers — download the template for the exact layout.');
      lines.push(`Subjects: ${st.subjects} added · Classes: ${st.classes} added · Teachers: ${st.teachersNew} added, ${st.teachersUpd} updated.`);
      if(st.teachersNew) lines.push('New teachers got logins automatically — see "Login" under each teacher.');
      if(skipped.length) lines.push(`Ignored sheet${skipped.length>1?'s':''}: ${skipped.join(', ')} (schedule timings are imported from the Schedule Structure tab).`);
    }
  }catch(e){ ok = false; lines.push(e.message || 'Could not read that file.'); }
  state.importReport = {scope, ok, lines, warns};
  renderAll();
}
function downloadTemplate(which){
  if(!window.XLSX){ alert('Excel library failed to load — check your connection.'); return; }
  const wb = XLSX.utils.book_new(), add = (n,rows,w)=>{ const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols']=w.map(x=>({wch:x})); XLSX.utils.book_append_sheet(wb, ws, n); };
  if(which==='schedule'){
    add('Schedule', [['Label','Start','End','Type'],['1','09:00','09:40','Period'],['2','09:40','10:20','Period'],['Break','10:20','10:30','Break'],['3','10:30','11:10','Period'],['Lunch','11:10','11:50','Lunch'],['4','11:50','12:30','Period']], [10,10,10,10]);
  } else {
    add('Subjects', [['Subject','Type'],['Mathematics','Core'],['Science','Core'],['English','Core'],['Computer','Additional'],['Art & Craft','Additional']], [24,14]);
    add('Classes', [['Class','Subjects','Class Teacher'],['Class 6','Mathematics, Science, English','Asha Rao'],['Class 7','Mathematics, English','']], [16,40,20]);
    add('Teachers', [['Teacher','Phone','Class','Subjects'],['Asha Rao','9876543210','Class 6','Mathematics, Science'],['Asha Rao','9876543210','Class 7','Mathematics'],['Ravi Kumar','9123456780','','English']], [20,16,16,32]);
  }
  saveFile(which==='schedule' ? 'ledger-schedule-template.xlsx' : 'ledger-data-template.xlsx', XLSX.write(wb,{type:'array',bookType:'xlsx'}));
}
function importReportHtml(scope){
  const r = state.importReport; if(!r || r.scope!==scope) return '';
  return `<div class="${r.ok?'log-item':'log-item fail'}" style="display:block;margin-top:12px;">
    ${r.lines.map(l=>`<div>${esc(l)}</div>`).join('')}
    ${r.warns.length ? `<div style="margin-top:6px;font-weight:600;">${r.warns.length} warning${r.warns.length===1?'':'s'}:</div>${r.warns.slice(0,15).map(w=>`<div>• ${esc(w)}</div>`).join('')}${r.warns.length>15?`<div>…and ${r.warns.length-15} more</div>`:''}` : ''}
  </div>`;
}
function importPanel(){
  return `<div class="panel">
    <h2 class="panel-title">Import from Excel / CSV</h2>
    <p class="panel-desc">Add subjects, classes (with their subjects) and teachers (name, phone, classes and subjects) in one go. Use an .xlsx with sheets named <strong>Subjects</strong>, <strong>Classes</strong>, <strong>Teachers</strong> — or a single .csv with just one of them. Existing names are matched, not duplicated.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <label class="ghost" style="margin:0;display:inline-block;cursor:pointer;border:1px solid var(--indigo);border-radius:2px;padding:9px 16px;font-size:12px;letter-spacing:.04em;color:var(--indigo);">⬆ Choose file to import
        <input type="file" accept=".xlsx,.xls,.csv" style="display:none;" onchange="handleImport(this,'data')">
      </label>
      <button class="ghost" onclick="downloadTemplate('data')">⬇ Download template</button>
    </div>
    <p class="hint"><strong>Teachers</strong> sheet: one row per class — Teacher, Phone, Class, Subjects (comma-separated). Leave Class blank to assign those subjects in every class that has them. <strong>Classes</strong> sheet may include an optional "Class Teacher" column.</p>
    ${importReportHtml('data')}
  </div>`;
}
function schedImportPanel(){
  return `<div class="panel">
    <h2 class="panel-title">Import timings</h2>
    <p class="panel-desc">Replace the period structure from a file with columns <strong>Label, Start, End, Type</strong> (Type = Period, Break or Lunch). Times like 09:00, 9:00 AM or Excel time cells all work.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
      <label class="ghost" style="margin:0;display:inline-block;cursor:pointer;border:1px solid var(--indigo);border-radius:2px;padding:9px 16px;font-size:12px;letter-spacing:.04em;color:var(--indigo);">⬆ Choose file to import
        <input type="file" accept=".xlsx,.xls,.csv" style="display:none;" onchange="handleImport(this,'schedule')">
      </label>
      <button class="ghost" onclick="downloadTemplate('schedule')">⬇ Download template</button>
    </div>
    ${importReportHtml('schedule')}
  </div>`;
}

/* ---------------- NOTIFICATIONS ---------------- */
function addNotification(text, alsoSms){
  if(!text || !text.trim()) return;
  const withPhone = state.teachers.filter(t=>t.phone);
  state.notifications.unshift({
    id:uid('nt'), text:text.trim(),
    date:new Date().toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}),
    sms: !!alsoSms, smsCount: alsoSms ? withPhone.length : 0
  });
  renderAll();
}
function removeNotification(id){
  state.notifications = state.notifications.filter(n=>n.id!==id);
  renderAll();
}

/* ---------------- RENDER: TABS ---------------- */
const TABS = [
  {id:'setup', label:'01 · Staff & Classes', roles:['admin']},
  {id:'schedule', label:'02 · Schedule Structure', roles:['admin']},
  {id:'build', label:'03 · Build Timetable', roles:['admin']},
  {id:'view', label:'04 · Class Timetable', roles:['admin']},
  {id:'teacherview', label:'05 · Teacher Schedule', roles:['admin']},
  {id:'workload', label:'06 · Workload', roles:['admin']},
  {id:'leave', label:'07 · Leave', roles:['admin','teacher']},
  {id:'checkins', label:'08 · Attendance', roles:['admin','teacher','receptionist']},
  {id:'mysubs', label:'09 · My Substitutions', roles:['teacher']},
  {id:'mytimetable', label:'My Timetable', roles:['teacher']},
  {id:'notify', label:'10 · Notifications', roles:['admin','teacher','receptionist']},
  {id:'users', label:'11 · Users & Roles', roles:['admin']}
];
function tabsForRole(role){ return TABS.filter(t=>t.roles.includes(role)); }
function renderTabbar(){
  const bar = document.getElementById('tabbar');
  if(!state.session){ bar.innerHTML=''; return; }
  const visible = tabsForRole(state.session.role);
  bar.innerHTML = visible.map(t=>`<button class="tab ${state.activeTab===t.id?'active':''}" onclick="setTab('${t.id}')">${t.label}</button>`).join('');
}
function setTab(id){ state.activeTab = id; if(id==='users') state.auditLoaded = false; renderAll(); }

/* ---------------- SERVER CONNECTION ---------------- */
const IDLE_LOGOUT_MS = 30*60*1000;      // sign out after 30 minutes without any activity (shared school computers)
const SYNC_MS = 15000;                  // how often to look for changes made by other people
let csrfToken = '';
function apiErr(status, code, message){ const e = new Error(message); e.status = status; e.code = code; return e; }
async function api(method, url, body){
  const opts = {method, credentials:'same-origin', headers:{'Accept':'application/json'}};
  if(body!==undefined){ opts.headers['Content-Type']='application/json'; opts.body = JSON.stringify(body); }
  if(method!=='GET') opts.headers['X-CSRF-Token'] = csrfToken;
  let res;
  try{ res = await fetch(url, opts); }
  catch(e){ throw apiErr(0,'offline','Cannot reach the server. Check your internet connection and try again.'); }
  let data = null; try{ data = await res.json(); }catch(e){}
  if(data && data.now) clockSkew = data.now - Date.now();
  if(data && data.tz) SCHOOL_TZ = data.tz;
  if(!res.ok){
    const err = apiErr(res.status, data && data.error, (data && data.message) || ('Request failed ('+res.status+').'));
    if(data && data.keys) err.keys = data.keys;
    if(res.status===401 && state.session) reloadWithNotice('expired');
    if(res.status===403 && err.code==='password_change_required' && state.session){ state.session.mustChange = true; state.screen='changepw'; renderAll(); }
    throw err;
  }
  return data;
}
const HASH_NOTICES = {expired:'Your session has ended. Please sign in again.', idle:'You were signed out after 30 minutes without activity.'};
function reloadWithNotice(kind){ try{ history.replaceState(null,'','#'+kind); }catch(e){} location.reload(); }
async function logout(kind){
  try{ await api('POST','/api/logout'); }catch(e){}
  try{ history.replaceState(null,'', kind ? '#'+kind : location.pathname); }catch(e){}
  location.reload();          // reloading wipes every school record from this browser's memory
}
let lastActive = Date.now();
['click','keydown','touchstart','mousemove','scroll'].forEach(ev=>document.addEventListener(ev, ()=>{ lastActive = Date.now(); }, {passive:true}));
setInterval(()=>{ if(state.session && Date.now()-lastActive > IDLE_LOGOUT_MS) logout('idle'); }, 30000);
window.addEventListener('beforeunload', e=>{ if(state.tempCreds && state.tempCreds.length){ e.preventDefault(); e.returnValue=''; } });
document.addEventListener('visibilitychange', ()=>{ if(!document.hidden && hydrated) refreshState(false); });

/* ---------------- SCREENS: setup / sign in / change password ---------------- */
let loginError = '', setupError = '', cpError = '', loginUser = '', setupDraft = {code:'', name:'', user:''};
function renderSessionSlot(){
  const slot = document.getElementById('sessionSlot');
  if(!state.session){ slot.innerHTML=''; return; }
  const roleLabel = state.session.role.charAt(0).toUpperCase()+state.session.role.slice(1);
  slot.innerHTML = `<span class="session-badge">${esc(roleLabel)} — ${esc(state.session.name)} &nbsp;<button type="button" onclick="showChangePassword()">Password</button><button type="button" onclick="showPrivacy()">Privacy</button><button type="button" onclick="logout()">⟵ Log out</button></span>`;
}
function renderLogin(){
  return `
  <div class="login-wrap">
    <form class="login-card" onsubmit="doLogin(event)">
      <h2>Sign in</h2>
      <p class="panel-desc">Use the username and password your Admin gave you. Everyone signs in with their own account — please don't share logins.</p>
      <div class="field"><label for="loginUsername">Username</label>
        <input type="text" id="loginUsername" name="username" value="${esc(loginUser)}" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
      <div class="field"><label for="loginPassword">Password</label>
        <input type="password" id="loginPassword" name="password" autocomplete="current-password" required></div>
      ${loginError ? `<div class="login-err" role="alert">${esc(loginError)}</div>` : ''}
      <button class="brass" type="submit" style="width:100%;margin-top:6px;" ${state.busy?'disabled':''}>${state.busy?'Signing in…':'Sign in'}</button>
      <p class="hint">Forgot your password? Ask your Admin to reset it for you.</p>
    </form>
  </div>`;
}
function renderSetupScreen(){
  return `
  <div class="login-wrap">
    <form class="login-card" onsubmit="doSetup(event)">
      <h2>Welcome — create the administrator account</h2>
      <p class="panel-desc">This is a new installation, so there are no accounts yet. Enter the <strong>setup code</strong> shown in the server log, then choose your own username and password. This screen disappears once the account exists.</p>
      <div class="field"><label>Setup code</label><input type="text" id="setupCode" value="${esc(setupDraft.code)}" autocomplete="off" autocapitalize="characters" spellcheck="false" required></div>
      <div class="field"><label>Your name</label><input type="text" id="setupName" value="${esc(setupDraft.name)}" autocomplete="name" required></div>
      <div class="field"><label>Username</label><input type="text" id="setupUser" value="${esc(setupDraft.user)}" autocomplete="username" autocapitalize="none" spellcheck="false" required placeholder="e.g. principal"></div>
      <div class="field"><label>Password</label><input type="password" id="setupPass" autocomplete="new-password" required minlength="10"></div>
      <div class="field"><label>Repeat password</label><input type="password" id="setupPass2" autocomplete="new-password" required></div>
      <p class="hint">At least 10 characters. A few unrelated words works well, for example “violet tractor pencil monsoon”.</p>
      ${setupError ? `<div class="login-err" role="alert">${esc(setupError)}</div>` : ''}
      <button class="brass" type="submit" style="width:100%;margin-top:6px;" ${state.busy?'disabled':''}>Create administrator</button>
    </form>
  </div>`;
}
function renderChangePassword(){
  const forced = !!(state.session && state.session.mustChange);
  return `
  <div class="login-wrap">
    <form class="login-card" onsubmit="doChangePassword(event)">
      <h2>${forced ? 'Choose your own password' : 'Change password'}</h2>
      <p class="panel-desc">${forced ? 'You signed in with a temporary password. Choose a new one that only you know — your Admin will not be able to see it.' : 'Choose a new password. Your other signed-in devices will be signed out.'}</p>
      <div class="field"><label>${forced ? 'Temporary password' : 'Current password'}</label><input type="password" id="cpCurrent" autocomplete="current-password" required></div>
      <div class="field"><label>New password</label><input type="password" id="cpNew" autocomplete="new-password" required minlength="10"></div>
      <div class="field"><label>Repeat new password</label><input type="password" id="cpNew2" autocomplete="new-password" required></div>
      <p class="hint">At least 10 characters, not containing your name or username. A few unrelated words works well, for example “violet tractor pencil monsoon”.</p>
      ${cpError ? `<div class="login-err" role="alert">${esc(cpError)}</div>` : ''}
      <button class="brass" type="submit" style="width:100%;margin-top:6px;" ${state.busy?'disabled':''}>Save password</button>
      <button type="button" class="ghost" style="width:100%;margin-top:8px;" onclick="${forced ? 'logout()' : 'cancelChangePassword()'}">${forced ? 'Sign out' : 'Cancel'}</button>
    </form>
  </div>`;
}
const val = id => { const el = document.getElementById(id); return el ? el.value : ''; };
async function doLogin(ev){
  if(ev) ev.preventDefault();
  if(state.busy) return;
  const username = val('loginUsername').trim(), password = val('loginPassword'); loginUser = username;
  state.busy = true; loginError = ''; renderAll();
  try{
    const d = await api('POST','/api/login',{username, password});
    csrfToken = d.csrf; state.busy = false;
    await startApp(d.user);
  }catch(e){ state.busy = false; loginError = e.message; renderAll(); }
}
async function doSetup(ev){
  if(ev) ev.preventDefault();
  if(state.busy) return;
  const p1 = val('setupPass'), p2 = val('setupPass2');
  setupDraft = {code:val('setupCode'), name:val('setupName'), user:val('setupUser')};
  if(p1!==p2){ setupError = 'The two passwords do not match.'; renderAll(); return; }
  const body = {code:val('setupCode'), name:val('setupName'), username:val('setupUser'), password:p1};
  state.busy = true; setupError = ''; renderAll();
  try{
    const d = await api('POST','/api/setup', body);
    csrfToken = d.csrf; state.busy = false;
    await startApp(d.user);
  }catch(e){ state.busy = false; setupError = e.message; renderAll(); }
}
function showChangePassword(){ cpError=''; state.screen='changepw'; renderAll(); }
function cancelChangePassword(){ state.screen='app'; renderAll(); }
async function doChangePassword(ev){
  if(ev) ev.preventDefault();
  if(state.busy) return;
  const cur = val('cpCurrent'), n1 = val('cpNew'), n2 = val('cpNew2');
  if(n1!==n2){ cpError = 'The two new passwords do not match.'; renderAll(); return; }
  state.busy = true; cpError = ''; renderAll();
  try{
    await api('POST','/api/change-password',{current:cur, next:n1});
    state.busy = false; state.session.mustChange = false;
    if(!hydrated) await loadAll(); else { state.screen='app'; renderAll(); }
  }catch(e){ state.busy = false; cpError = e.message; renderAll(); }
}

/* ---------------- START-UP: who am I, then load my data ---------------- */
async function startApp(user){
  state.session = {role:user.role, teacherId:user.teacherId, name:user.name, userId:user.id, username:user.username, mustChange:!!user.mustChange, locationAck:!!user.locationAck};
  if(user.role!=='admin'){ try{ localStorage.removeItem('ledger_state'); }catch(e){} }   // old versions left the whole school's data here
  if(user.mustChange){ state.screen='changepw'; renderAll(); return; }
  await loadAll();
}
async function loadAll(){
  const d = await api('GET','/api/state');
  applyServerState(d);
  hydrated = true;
  if(state.session.role==='teacher') state.scheduleTeacherId = state.session.teacherId;
  const first = tabsForRole(state.session.role)[0];
  state.activeTab = first ? first.id : 'setup';
  state.screen = 'app';
  renderAll();
  setSaveStamp();
  startSync();
}
async function boot(){
  const m = /^#(\w+)$/.exec(location.hash||'');
  if(m && HASH_NOTICES[m[1]]){ loginError = HASH_NOTICES[m[1]]; try{ history.replaceState(null,'',location.pathname); }catch(e){} }
  state.screen = 'loading'; renderAll();
  try{
    const d = await api('GET','/api/bootstrap');
    csrfToken = d.csrf || '';
    if(d.needsSetup){ state.screen='setup'; renderAll(); return; }
    if(d.user){ await startApp(d.user); return; }
    state.screen = 'app'; renderAll();
  }catch(e){
    document.getElementById('app').innerHTML = `<div class="login-wrap"><div class="login-card"><h2>Can't reach the server</h2><p class="panel-desc">${esc(e.message)}</p><button onclick="boot()">Try again</button></div></div>`;
  }
}

/* ---------------- SYNC WITH THE SERVER (one shared copy for every device) ---------------- */
const PERSIST_KEYS = ['teachers','classes','days','periods','timetable','absences','substitutions','leaveRequests','notifications','subjectCatalog','autoGen','genSig','genReport','workloadLog','campus','schoolEnd','classXEnd','periodsV2'];
let revs = {}, baseline = {}, lastV = 0, saving = false, saveAgain = false, saveTimer = null, syncTimer = null;
function snapshotState(){ const out = {}; PERSIST_KEYS.forEach(k=>{ out[k] = state[k]; }); return out; }
function applySnapshot(data){
  if(!data) return;
  if(data.periodsV2===undefined && data.periods) state.periodsV2 = false;
  PERSIST_KEYS.forEach(k=>{ if(data[k]!==undefined) state[k] = data[k]; });
  normalizeData();
  try{ let m, re=/"[a-z]+(\d+)"/g, js=JSON.stringify(snapshotState()); while((m=re.exec(js))) uidCounter = Math.max(uidCounter, +m[1]+1); }catch(e){}
}
function applyServerState(d){
  applyingRemote = true;
  try{
    lastV = d.v;
    if(d.policy) state.policy = d.policy;
    if(d.me) Object.assign(state.session, {role:d.me.role, teacherId:d.me.teacherId, name:d.me.name, userId:d.me.id, username:d.me.username, mustChange:d.me.mustChange, locationAck:d.me.locationAck});
    if(d.users) state.users = d.users;
    if(d.revs){ revs = d.revs; baseline = {}; PERSIST_KEYS.forEach(k=>{ if(d.data[k]!==undefined) baseline[k] = JSON.stringify(d.data[k]); }); }
    applySnapshot(d.data);
  } finally { applyingRemote = false; }
}
function dirtyChanges(){
  if(!state.session || state.session.role!=='admin' || !hydrated) return {};
  const changes = {}, snap = snapshotState();
  PERSIST_KEYS.forEach(k=>{ const j = JSON.stringify(snap[k]===undefined ? null : snap[k]); if(j!==baseline[k]) changes[k] = {value:snap[k], baseRev:revs[k]||0, _j:j}; });
  return changes;
}
function schedulePersist(){
  if(!state.session || state.session.role!=='admin') return;
  if(!Object.keys(dirtyChanges()).length) return;
  clearTimeout(saveTimer); saveTimer = setTimeout(()=>{ saveTimer = null; persistState(); }, 600);
  setSaveStamp('saving');
}
async function persistState(){
  clearTimeout(saveTimer); saveTimer = null;
  if(saving){ saveAgain = true; return false; }
  const changes = dirtyChanges(), keys = Object.keys(changes);
  if(!keys.length){ setSaveStamp(); return true; }
  const sent = {}; keys.forEach(k=>{ sent[k] = changes[k]._j; delete changes[k]._j; });
  saving = true; setSaveStamp('saving');
  let okSave = false;
  try{
    const d = await api('PUT','/api/state',{changes});
    keys.forEach(k=>{ baseline[k] = sent[k]; });
    revs = d.revs; lastV = d.v; if(d.users) state.users = d.users;
    if(d.creds && d.creds.length){ addTempCreds(d.creds); renderAll(); }
    setSaveStamp(); okSave = true;
  }catch(e){
    if(e.code==='conflict'){
      await refreshState(true);
      alert('Another administrator changed the same information at the same moment, so your last change was not saved. The screen now shows the latest version — please make the change again.');
    } else {
      setSaveStamp('error', e.message);
      if(e.status===0 || e.status>=500){ clearTimeout(saveTimer); saveTimer = setTimeout(()=>{ saveTimer=null; persistState(); }, 10000); }
    }
  } finally {
    saving = false;
    if(saveAgain){ saveAgain = false; schedulePersist(); }
  }
  return okSave;
}
function setSaveStamp(kind, msg){
  const el = document.getElementById('saveStamp'); if(!el) return;
  const t = new Date(Date.now()+clockSkew).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:SCHOOL_TZ});
  if(!state.session){ el.textContent = ''; return; }
  const admin = state.session.role==='admin';
  if(kind==='saving') el.textContent = 'Saving…';
  else if(kind==='error') el.textContent = '⚠ Not saved — '+(msg||'will retry');
  else el.textContent = (admin ? '✓ Saved to server ' : '✓ Up to date ')+t;
}
function startSync(){ stopSync(); syncTimer = setInterval(()=>refreshState(false), SYNC_MS); }
function stopSync(){ if(syncTimer) clearInterval(syncTimer); syncTimer = null; }
function userIsTyping(){
  const a = document.activeElement;
  return !!(a && a.closest && a.closest('#app') && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !['checkbox','radio','button'].includes(a.type));
}
async function refreshState(force){
  if(!hydrated || state.screen!=='app') return;
  if(!force && (saving || saveTimer || userIsTyping() || state.locBusy)) return;
  try{
    const d = await api('GET','/api/state'+(force ? '' : '?v='+lastV));
    if(d.unchanged){ if(state.activeTab==='checkins') await refreshAttendance(); return; }
    if(!force && Object.keys(dirtyChanges()).length) return;      // never overwrite edits that are still waiting to be saved
    applyServerState(d);
    renderAll(); setSaveStamp();
  }catch(e){ /* offline — try again at the next tick */ }
}

/* attendance rows are loaded a month at a time (not part of the main state) */
const attLoaded = {}, attReady = {};
async function loadAttendanceMonth(ym){
  attLoaded[ym] = Date.now();
  const [y,m] = ym.split('-').map(Number), last = new Date(y,m,0).getDate();
  const d = await api('GET', `/api/attendance?from=${ym}-01&to=${ym}-${String(last).padStart(2,'0')}`);
  Object.keys(state.checkins).forEach(k=>{ if(k.startsWith(ym)) delete state.checkins[k]; });
  Object.assign(state.checkins, d.checkins);
  attReady[ym] = true;
}
function attendanceMonths(){
  const ms = new Set([todayStr().slice(0,7)]);
  if(state.attendanceDate) ms.add(state.attendanceDate.slice(0,7));
  if(state.atMonth) ms.add(state.atMonth);
  return [...ms];
}
function ensureAttendance(){
  attendanceMonths().forEach(ym=>{
    if(attLoaded[ym]) return;
    attLoaded[ym] = Date.now();
    loadAttendanceMonth(ym).then(()=>renderAll()).catch(()=>{ delete attLoaded[ym]; });
  });
}
async function refreshAttendance(){
  const before = JSON.stringify(state.checkins);
  for(const ym of attendanceMonths()) await loadAttendanceMonth(ym);
  if(JSON.stringify(state.checkins)!==before && !userIsTyping()) renderAll();
}

/* ---------------- RENDER ROOT ---------------- */
function renderAll(){
  renderSessionSlot();
  const bar = document.getElementById('tabbar');
  const app = document.getElementById('app');
  if(state.screen==='loading'){ bar.innerHTML=''; app.innerHTML = '<div class="login-wrap"><div class="login-card"><p class="panel-desc">Loading…</p></div></div>'; return; }
  if(state.screen==='setup'){ bar.innerHTML=''; app.innerHTML = renderSetupScreen(); return; }
  if(!state.session){ bar.innerHTML=''; app.innerHTML = renderLogin(); focusLoginField(); return; }
  if(state.screen==='changepw'){ bar.innerHTML=''; app.innerHTML = renderChangePassword(); return; }
  renderTabbar();
  if(hydrated && !applyingRemote && state.autoGen && state.session.role==='admin' && inputSignature()!==state.genSig) runGenerate(false);
  const allowed = tabsForRole(state.session.role).map(t=>t.id);
  if(!allowed.includes(state.activeTab)) state.activeTab = allowed[0];
  if(state.activeTab==='setup') app.innerHTML = renderSetupTab();
  else if(state.activeTab==='schedule') app.innerHTML = renderScheduleTab();
  else if(state.activeTab==='build') app.innerHTML = renderBuildTab();
  else if(state.activeTab==='view') app.innerHTML = renderViewTab();
  else if(state.activeTab==='teacherview') app.innerHTML = renderTeacherScheduleTab();
  else if(state.activeTab==='mytimetable') app.innerHTML = renderTeacherScheduleTab();
  else if(state.activeTab==='workload') app.innerHTML = renderWorkloadTab();
  else if(state.activeTab==='leave') app.innerHTML = renderLeaveTab();
  else if(state.activeTab==='checkins') app.innerHTML = renderAttendanceTab();
  else if(state.activeTab==='mysubs') app.innerHTML = renderMySubsTab();
  else if(state.activeTab==='notify') app.innerHTML = renderNotifyTab();
  else if(state.activeTab==='users') app.innerHTML = renderUsersTab();
  attachDynamicHandlers();
  if(hydrated && !applyingRemote && state.session.role==='admin'){ autoRecordToday(); schedulePersist(); }
}
function focusLoginField(){
  const u = document.getElementById('loginUsername'), p = document.getElementById('loginPassword');
  if(u && !u.value) u.focus(); else if(p) p.focus();
}

/* ---------------- MODAL + PRIVACY NOTICE ---------------- */
function closeModal(){ const m = document.getElementById('modalRoot'); if(m) m.remove(); }
function openModal({title, html, actions, onCancel}){
  closeModal();
  const ov = document.createElement('div'); ov.className = 'modal-backdrop'; ov.id = 'modalRoot';
  ov.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><h2 id="modalTitle">${esc(title)}</h2><div class="modal-body">${html}</div><div class="modal-actions"></div></div>`;
  const box = ov.querySelector('.modal-actions');
  (actions||[]).forEach(a=>{
    const b = document.createElement('button'); b.type = 'button'; b.textContent = a.label; if(a.cls) b.className = a.cls;
    b.addEventListener('click', async ()=>{ closeModal(); if(a.onClick) await a.onClick(); });
    box.appendChild(b);
  });
  ov.addEventListener('keydown', e=>{ if(e.key==='Escape'){ closeModal(); if(onCancel) onCancel(); } });
  document.body.appendChild(ov);
  const first = box.querySelector('button.brass') || box.querySelector('button'); if(first) first.focus({preventScroll:true});
}
function privacyHtml(){
  const days = (state.policy && state.policy.retentionDays) || 730;
  return `
  <p><strong>Why location is used.</strong> Staff attendance only counts when you are on campus. When you tap <em>Check in</em> or <em>Check out</em>, this page asks your phone or computer for its position once, and the school's server compares it with the campus point set by the Admin.</p>
  <ul>
    <li><strong>When:</strong> only at the moment you tap Check in / Check out (or “Test my location”). Never in the background, and never while you are simply looking at timetables.</li>
    <li><strong>What is saved:</strong> the date, the time, how many metres you were from the campus point, and the GPS accuracy. Your exact coordinates are <em>not</em> saved or logged.</li>
    <li><strong>Who can see it:</strong> you (your own record), the Admin (times and distances) and the front desk (times only).</li>
    <li><strong>How long:</strong> attendance records are deleted automatically after ${days} days.</li>
    <li><strong>Your choice:</strong> your browser will ask for permission and you may say no. You then can't use location check-in — tell the Admin, who can record your attendance manually.</li>
  </ul>
  <p class="hint">Other data: your name, phone number (Admin only), timetable, leave requests and sign-in times are stored on the school's server. Passwords are stored only as irreversible hashes.</p>`;
}
function showPrivacy(){
  openModal({title:'Privacy & location', html:privacyHtml(), actions:[{label:'Close', cls:'brass'}]});
}
/* shown once before the browser's own permission pop-up, so teachers know why it is about to appear */
function ensureLocationConsent(){
  if(state.session.role!=='teacher' || state.session.locationAck) return Promise.resolve(true);
  return new Promise(resolve=>{
    openModal({
      title:'Before your browser asks for your location',
      html:`<p>Next, your browser will show a pop-up asking to use this device's location. Please choose <strong>Allow</strong> (on some phones: “While using the app” or “Allow once”).</p>${privacyHtml()}`,
      onCancel:()=>resolve(false),
      actions:[
        {label:'Not now', cls:'ghost', onClick:()=>resolve(false)},
        {label:'I understand — continue', cls:'brass', onClick:async ()=>{
          try{ await api('POST','/api/location-ack'); state.session.locationAck = true; resolve(true); }
          catch(e){ alert(e.message); resolve(false); }
        }}
      ]
    });
  });
}

/* ---------------- LOGINS (credentials are one-time; nothing readable is stored) ---------------- */
state.tempCreds = [];
function addTempCreds(list){
  list.forEach(c=>{
    const i = state.tempCreds.findIndex(x=>x.username===c.username);
    if(i>=0) state.tempCreds.splice(i,1);
    state.tempCreds.push(c);
  });
}
function credsText(){ return state.tempCreds.map(c=>`${c.name} — username: ${c.username} — temporary password: ${c.tempPassword}`).join('\n'); }
async function copyCreds(){
  try{ await navigator.clipboard.writeText(credsText()); alert('Copied. Paste it somewhere private, then hide this list.'); }
  catch(e){ alert('Could not copy automatically — select the text on screen instead.'); }
}
function downloadCreds(){
  const q = v => { v = String(v); if(/^[=+\-@]/.test(v)) v = "'"+v; return '"'+v.replace(/"/g,'""')+'"'; };
  const csv = 'Name,Username,Temporary password\n' + state.tempCreds.map(c=>[c.name,c.username,c.tempPassword].map(q).join(',')).join('\n') + '\n';
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download = 'new-logins.csv'; a.click();
}
function dismissCreds(){ if(confirm('Hide these passwords? They cannot be shown again (you can always reset a password).')){ state.tempCreds = []; renderAll(); } }
function credsPanel(){
  if(!state.tempCreds.length) return '';
  return `<div class="panel creds-panel no-print">
    <h2 class="panel-title">New logins — shown only once</h2>
    <p class="panel-desc">Give each person their temporary password privately (in person or a direct message, not a group chat). They must choose their own password the first time they sign in. Passwords are not stored in readable form, so <strong>copy or download them now</strong> — if one is lost, use “Reset password”.</p>
    ${state.tempCreds.map(c=>`<div class="entry-row"><div><div class="entry-name">${esc(c.name)}</div>
      <div class="cred-line">Username: <strong>${esc(c.username)}</strong> · Temporary password: <strong class="temp-pw">${esc(c.tempPassword)}</strong></div></div></div>`).join('')}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;">
      <button class="ghost" onclick="copyCreds()">Copy all</button>
      <button class="ghost" onclick="downloadCreds()">⬇ Download CSV</button>
      <button class="danger" onclick="dismissCreds()">I've saved them — hide</button>
    </div></div>`;
}
async function resetUserPassword(id){
  if(!confirm('Reset this password? The person will be signed out everywhere and must choose a new password at their next sign-in.')) return;
  try{ const d = await api('POST',`/api/users/${id}/reset`); addTempCreds([d.cred]); state.users = d.users; renderAll(); window.scrollTo({top:0,behavior:'smooth'}); }
  catch(e){ alert(e.message); }
}

/* ---------------- OLD BROWSER-ONLY DATA (from the previous version of this app) ---------------- */
function legacyData(){
  try{ const raw = localStorage.getItem('ledger_state'); return raw ? JSON.parse(raw) : null; }catch(e){ return null; }
}
function legacyPanel(){
  if(!state.session || state.session.role!=='admin') return '';
  const old = legacyData(); if(!old) return '';
  const serverEmpty = state.teachers.length===0 && state.classes.length===0;
  return `<div class="panel no-print" style="border-color:var(--brass);">
    <h2 class="panel-title">Data from the old version found in this browser</h2>
    <p class="panel-desc">${serverEmpty
      ? 'The previous version kept everything inside this one browser. You can copy your timetable, staff, classes and attendance to the server now, so every device sees the same information. Logins are not copied (the old ones had readable passwords); new one-time passwords are created for every teacher.'
      : 'The server already has timetable data. This browser still holds an old copy that includes readable passwords — delete it.'}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      ${serverEmpty ? `<button class="brass" onclick="importLegacy()">Import to the server</button>` : ''}
      <button class="danger" onclick="discardLegacy()">Delete the old copy from this browser</button>
    </div></div>`;
}
async function importLegacy(){
  const old = legacyData(); if(!old) return;
  const body = {}; PERSIST_KEYS.forEach(k=>{ if(old[k]!==undefined) body[k] = old[k]; }); body.checkins = old.checkins || {};
  clearTimeout(saveTimer); saveTimer = null;
  try{
    const d = await api('POST','/api/import-legacy',{state:body});
    try{ localStorage.removeItem('ledger_state'); }catch(e){}
    if(d.creds) addTempCreds(d.creds);
    await refreshState(true);
    alert(`Imported. ${d.creds.length} teacher login(s) were created — their one-time passwords are shown at the top of this page.`);
  }catch(e){ alert(e.message); }
}
function discardLegacy(){
  if(!confirm('Delete the old copy stored in this browser? If you have not imported it, it cannot be recovered.')) return;
  try{ localStorage.removeItem('ledger_state'); }catch(e){}
  renderAll();
}

/* ---------------- TAB: USERS & ROLES (admin only) ---------------- */
state.audit = []; state.auditLoaded = false;
async function loadAudit(){
  state.auditLoaded = true;
  try{ const d = await api('GET','/api/audit'); state.audit = d.rows; renderAll(); }catch(e){ state.auditLoaded = false; }
}
const AUDIT_LABEL = {'login.ok':'Signed in','login.fail':'Wrong password','login.locked':'Sign-in blocked (locked)','password.change':'Changed own password','password.reset':'Password reset','user.create':'Login created','user.delete':'Login removed',
  'attendance.in':'Checked in','attendance.out':'Checked out','attendance.reject':'Check-in refused','attendance.manual':'Manual attendance entry','campus.change':'Campus settings changed','location.ack':'Accepted location notice',
  'leave.apply':'Applied for leave','sub.accepted':'Accepted substitution','sub.rejected':'Rejected substitution','setup.admin_created':'First administrator created','legacy.import':'Imported old data'};
function renderUsersTab(){
  if(!state.auditLoaded) loadAudit();
  const when = ts => ts ? new Date(ts).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',timeZone:SCHOOL_TZ}) : '—';
  return `
  ${credsPanel()}
  <div class="panel">
    <h2 class="panel-title">Add a login</h2>
    <p class="panel-desc">Teacher logins are created automatically when you add a teacher in “Staff & Classes”. Use this for extra Admin or Receptionist logins. A one-time password is generated — the person must change it when they first sign in.</p>
    <div class="row-inline" style="flex-wrap:wrap;">
      <div class="field"><label>Name</label><input type="text" id="newUserName" placeholder="e.g. Front Desk 2" maxlength="60"></div>
      <div class="field"><label>Role</label>
        <select id="newUserRole">
          <option value="receptionist">Receptionist (attendance times and announcements only)</option>
          <option value="admin">Admin (full access)</option>
        </select>
      </div>
      <button onclick="addNonTeacherUser()" style="margin-bottom:12px;">+ Create login</button>
    </div>
  </div>
  <div class="panel">
    <h2 class="panel-title">All logins</h2>
    ${state.users.map(u=>`
      <div class="entry-row">
        <div>
          <div class="entry-name">${esc(u.name)} <span class="chip">${esc(u.role)}</span></div>
          <div class="cred-line">Username: <strong>${esc(u.username)}</strong> · ${u.mustChange ? '<span style="color:var(--brick)">has not chosen a password yet</span>' : 'last sign-in '+when(u.lastLogin)}${u.locked ? ' · <strong style="color:var(--brick)">temporarily locked</strong>' : ''}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="ghost" onclick="resetUserPassword('${esc(u.id)}')">Reset password</button>
          ${u.role!=='teacher' && u.id!==state.session.userId ? `<button class="iconbtn" title="Remove this login" onclick="removeUser('${esc(u.id)}')">✕</button>` : ''}
        </div>
      </div>`).join('')}
  </div>
  <div class="panel">
    <h2 class="panel-title">Security log</h2>
    <p class="panel-desc">The most recent sign-ins, password changes, attendance check-ins and admin actions. Exact locations are never recorded here. Entries are deleted automatically after a while.
      <button class="ghost" style="margin-left:8px;" onclick="state.auditLoaded=false; renderAll();">↻ Refresh</button></p>
    ${state.audit.length===0 ? '<div class="empty-state">Nothing to show yet.</div>' : state.audit.map(r=>`
      <div class="entry-row" style="padding:6px 4px;"><div>
        <div class="entry-meta"><strong>${esc(AUDIT_LABEL[r.action]||r.action)}</strong> · ${esc(r.username||'—')} · ${when(r.ts)}</div>
        ${r.detail ? `<div class="entry-meta" style="opacity:.8;">${esc(r.detail)}</div>` : ''}
      </div></div>`).join('')}
  </div>`;
}
async function addNonTeacherUser(){
  const name = val('newUserName').trim(), role = val('newUserRole');
  if(!name) return;
  try{ const d = await api('POST','/api/users',{name, role}); addTempCreds([d.cred]); state.users = d.users; renderAll(); }
  catch(e){ alert(e.message); }
}
async function removeUser(id){
  if(!confirm('Remove this login? They will be signed out immediately.')) return;
  try{ const d = await api('DELETE',`/api/users/${id}`); state.users = d.users; renderAll(); }
  catch(e){ alert(e.message); }
}


/* ---------------- TAB 1: SETUP ---------------- */
const esc = s => String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
state.subjectCatalog = [];   // [{name, type:'core'|'additional'}]
state.autoGen = true;
state.schoolEnd = '16:30';
state.classXEnd = '17:10';
state.periodsV2 = true;
state.genSig = '';
state.genReport = null;
state.campus = {lat:null, lng:null, radius:150, maxAccuracy:100};
state.tEdit = null;
state.importReport = null;
state.locMsg = null;
state.draft = {name:'', phone:'', assign:[]};       // assign: [{classId, subject}]
state.classDraft = {name:'', subjects:[]};

function normalizeData(){
  if(!state.schoolEnd) state.schoolEnd = '16:30';
  if(!state.classXEnd) state.classXEnd = '17:10';
  if(!state.periodsV2){   // older saved schedules stop at 16:00 — add the 16:00–16:30 and 16:30–17:10 periods once
    const tp = teachingPeriods(), last = tp[tp.length-1];
    if(last && last.end==='16:00'){
      state.periods.push({id:uid('per'), label:String(tp.length+1), start:'16:00', end:'16:30', type:'period'});
      state.periods.push({id:uid('per'), label:String(tp.length+2), start:'16:30', end:'17:10', type:'period'});
    }
    state.periodsV2 = true;
  }
  state.subjectCatalog = (state.subjectCatalog||[]).map(s=>({name:s.name, type: s.type==='additional'||s.type==='core' ? s.type : guessSubjectType(s.name)}));
  state.classes.forEach(c=>{ if(!c.subjects) c.subjects=[]; });
  state.teachers.forEach(t=>{
    if(!t.assignments) t.assignments = (t.classIds||[]).flatMap(cid=>(t.subjects||[]).map(s=>({classId:cid, subject:s})));
  });
}
function syncTeacher(t){
  t.subjects = [...new Set(t.assignments.map(a=>a.subject))];
  t.classIds = [...new Set(t.assignments.map(a=>a.classId))];
}
function teachersFor(classId, subject){
  return state.teachers.filter(t=>(t.assignments||[]).some(a=>a.classId===classId && a.subject.toLowerCase()===subject.toLowerCase()));
}

function renderSetupTab(){
  const d = state.draft, cd = state.classDraft;
  return `
  ${credsPanel()}
  ${legacyPanel()}
  ${importPanel()}

  <div class="panel">
    <h2 class="panel-title">1 · Subjects</h2>
    <p class="panel-desc">First list every subject taught in your school and mark each as a <strong>Core</strong> (main) or <strong>Additional</strong> subject. The timetable generator makes sure every day <strong>starts with a core subject</strong> — additional subjects (Computer, Art &amp; Craft, Grammar/Moral…) are placed after it. You'll choose which subjects each class has in the next step.</p>
    <div class="row-inline">
      <div class="field" style="flex:1;"><label>Subject</label><input type="text" id="newSubjectName" placeholder="Subject name" oninput="guessTypeInput(this)" onkeydown="if(event.key==='Enter') addSubject();"></div>
      <div class="field" style="flex:0 0 150px;"><label>Type</label><select id="newSubjectType"><option value="core">Core (main)</option><option value="additional">Additional</option></select></div>
      <button onclick="addSubject()" style="margin-bottom:12px;">+ Add subject</button>
    </div>
    ${state.subjectCatalog.length===0 ? '<div class="empty-state">No subjects yet.</div>' :
      ['core','additional'].map(ty=>{
        const list = state.subjectCatalog.map((s,i)=>({s,i})).filter(x=>(x.s.type||'core')===ty);
        return `<div style="margin-top:10px;"><label>${ty==='core'?'Core / main subjects':'Additional subjects'} (${list.length})</label>
          ${list.length ? `<div class="chip-list">${list.map(({s,i})=>`<span class="chip" style="${ty==='additional'?'background:var(--brass-soft);color:#5a4210;':''}">${esc(s.name)} <a href="#" title="Move to ${ty==='core'?'additional':'core'}" style="color:var(--indigo);text-decoration:none;" onclick="toggleSubjectType(${i});return false;">${ty==='core'?'→ additional':'→ core'}</a> <a href="#" style="color:var(--brick);text-decoration:none;" onclick="removeSubject(${i});return false;">✕</a></span>`).join('')}</div>` : '<div class="hint">None</div>'}</div>`;
      }).join('')}
  </div>

  <div class="panel">
    <h2 class="panel-title">2 · Classes &amp; their subjects</h2>
    <p class="panel-desc">Add each class and tick the subjects <em>that class</em> studies. Every class can have a different set. You can change a class's subjects later by tapping the chips under it.</p>
    <div class="field" style="max-width:320px;"><label>Class name</label><input type="text" id="newClassName" placeholder="Class name" value="${esc(cd.name)}" oninput="state.classDraft.name=this.value"></div>
    <div class="field"><label>Subjects for this class — pick one or more</label>
      ${state.subjectCatalog.length===0 ? '<div class="hint">Add subjects above first.</div>' :
        `<div class="day-toggles">${state.subjectCatalog.map((s,i)=>`<div class="day-toggle ${cd.subjects.includes(s.name)?'on':''}" onclick="toggleClassDraftSubject(${i})">${esc(s.name)}</div>`).join('')}</div>`}
    </div>
    <button onclick="addClass()">+ Add class</button>
    <div style="margin-top:14px;">
      ${state.classes.length===0 ? '<div class="empty-state">No classes yet.</div>' :
        state.classes.map(c=>`
          <div class="entry-row" style="align-items:flex-start;">
            <div>
              <div class="entry-name">${esc(c.name)}</div>
              <div class="day-toggles" style="margin-top:6px;gap:5px;">${state.subjectCatalog.map((s,i)=>`<div class="day-toggle ${c.subjects.includes(s.name)?'on':''}" style="padding:3px 10px;font-size:11px;" onclick="toggleClassSubject('${c.id}',${i})">${esc(s.name)}</div>`).join('')}</div>
              <div class="field" style="max-width:280px;margin:12px 0 0;"><label>Class teacher / advisor</label>
                <select onchange="setAdvisor('${c.id}',this.value)"><option value="">— none —</option>${advisorOptions(c)}</select>
                <div class="hint">Takes Period ${teachingPeriods()[0]?teachingPeriods()[0].label:'1'} of this class every day. Pick from teachers assigned to this class.</div>
              </div>
            </div>
            <button class="iconbtn" title="Remove" onclick="removeClass('${c.id}')">✕</button>
          </div>`).join('')}
    </div>
  </div>

  <div class="panel">
    <h2 class="panel-title">3 · Teachers</h2>
    <p class="panel-desc">Enter name and phone, then under each class pick the subjects this teacher takes <em>in that class</em>. A teacher can take different subjects in different classes. A login is created automatically.</p>
    <div class="grid-2" style="gap:16px;">
      <div class="field"><label>Name</label><input type="text" id="newTeacherName" placeholder="Teacher name" value="${esc(d.name)}" oninput="state.draft.name=this.value"></div>
      <div class="field"><label>Phone (for SMS)</label><input type="tel" id="newTeacherPhone" placeholder="Phone number" value="${esc(d.phone)}" oninput="state.draft.phone=this.value"></div>
    </div>
    <div class="field"><label>Class &amp; subject — pick one or more</label>
      ${state.classes.length===0 ? '<div class="hint">Add classes above first.</div>' :
        state.classes.map(c=>`
          <div style="margin-bottom:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <span class="class-cell" style="padding:4px 10px;font-size:12.5px;position:static;">${esc(c.name)}</span>
            ${c.subjects.length===0 ? '<span class="warn-text">No subjects set for this class</span>' :
              c.subjects.map((s,i)=>`<div class="day-toggle ${d.assign.some(a=>a.classId===c.id&&a.subject===s)?'on':''}" onclick="toggleDraftAssign('${c.id}',${i})">${esc(s)}</div>`).join('')}
          </div>`).join('')}
    </div>
    <button onclick="addTeacher()">+ Add teacher</button>
    <div style="margin-top:14px;">
      ${state.teachers.length===0 ? '<div class="empty-state">No teachers yet.</div>' :
        state.teachers.map(t=>{
          if(state.tEdit && state.tEdit.id===t.id) return teacherEditForm();
          const u = state.users.find(u=>u.teacherId===t.id);
          const byClass = state.classes.map(c=>({c, subs:t.assignments.filter(a=>a.classId===c.id).map(a=>a.subject)})).filter(x=>x.subs.length);
          return `
          <div class="entry-row">
            <div>
              <div class="entry-name">${esc(t.name)}</div>
              <div class="chip-list">${byClass.map(x=>`<span class="chip" style="background:var(--brass-soft);color:#5a4210;">${esc(x.c.name)}: ${x.subs.map(esc).join(', ')}</span>`).join('') || '<span class="warn-text">No class assigned</span>'}</div>
              <div class="entry-meta">${t.phone ? '📱 '+esc(t.phone) : 'No phone on file'}</div>
              ${u ? `<div class="cred-line">Login: <strong>${esc(u.username)}</strong> · ${(()=>{ const tc = state.tempCreds.find(c=>c.username===u.username); return tc ? 'temporary password: <strong class="temp-pw">'+esc(tc.tempPassword)+'</strong> (shown once)' : (u.mustChange ? 'has not chosen a password yet' : 'password set by the teacher'); })()} <button type="button" class="linkbtn" onclick="resetUserPassword('${esc(u.id)}')">Reset password</button></div>` : '<div class="cred-line">Creating login…</div>'}
            </div>
            <div style="display:flex;gap:6px;align-items:center;"><button class="ghost" onclick="startEditTeacher('${t.id}')">Edit</button><button class="iconbtn" title="Remove" onclick="removeTeacher('${t.id}')">✕</button></div>
          </div>`;}).join('')}
    </div>
  </div>

  <div class="panel">
    <h2 class="panel-title">Reset</h2>
    <p class="panel-desc">Remove all teachers, classes, subjects and timetables.</p>
    <button class="ghost" onclick="if(confirm('Clear everything?')) resetAll()">Clear everything</button>
  </div>`;
}
function addSubject(){
  const name = document.getElementById('newSubjectName').value.trim();
  if(!name || state.subjectCatalog.some(s=>s.name.toLowerCase()===name.toLowerCase())) return;
  const sel = document.getElementById('newSubjectType');
  state.subjectCatalog.push({name, type: sel && sel.value==='additional' ? 'additional' : 'core'});
  renderAll();
}
function toggleSubjectType(i){
  const s = state.subjectCatalog[i];
  s.type = s.type==='additional' ? 'core' : 'additional';
  renderAll();
}
function guessTypeInput(inp){
  const sel = document.getElementById('newSubjectType');
  if(sel && inp.value.trim()) sel.value = guessSubjectType(inp.value);
}
function removeSubject(i){
  const name = state.subjectCatalog[i].name;
  state.subjectCatalog.splice(i,1);
  state.classes.forEach(c=>{ c.subjects = c.subjects.filter(s=>s!==name); });
  state.teachers.forEach(t=>{ t.assignments = t.assignments.filter(a=>a.subject!==name); syncTeacher(t); });
  state.classDraft.subjects = state.classDraft.subjects.filter(s=>s!==name);
  state.draft.assign = state.draft.assign.filter(a=>a.subject!==name);
  renderAll();
}
function toggleClassDraftSubject(i){
  const n = state.subjectCatalog[i].name, a = state.classDraft.subjects, k = a.indexOf(n);
  if(k>=0) a.splice(k,1); else a.push(n);
  renderAll();
}
function toggleClassSubject(classId, i){
  const c = getClass(classId), n = state.subjectCatalog[i].name, k = c.subjects.indexOf(n);
  if(k>=0){
    c.subjects.splice(k,1);
    state.teachers.forEach(t=>{ t.assignments = t.assignments.filter(a=>!(a.classId===classId && a.subject===n)); syncTeacher(t); });
    state.draft.assign = state.draft.assign.filter(a=>!(a.classId===classId && a.subject===n));
  } else c.subjects.push(n);
  renderAll();
}
function addClass(){
  const cd = state.classDraft, name = cd.name.trim();
  if(!name){ alert('Enter the class name.'); return; }
  if(!cd.subjects.length){ alert('Pick at least one subject for this class.'); return; }
  state.classes.push({id:uid('c'), name, subjects:[...cd.subjects], advisorId:''});
  state.classDraft = {name:'', subjects:[]};
  renderAll();
}
function removeClass(id){
  state.classes = state.classes.filter(c=>c.id!==id);
  state.teachers.forEach(t=>{ t.assignments = t.assignments.filter(a=>a.classId!==id); syncTeacher(t); });
  state.draft.assign = state.draft.assign.filter(a=>a.classId!==id);
  delete state.timetable[id];
  if(state.buildClassId===id) state.buildClassId=null;
  renderAll();
}
function toggleDraftAssign(classId, i){
  const subject = getClass(classId).subjects[i], a = state.draft.assign;
  const k = a.findIndex(x=>x.classId===classId && x.subject===subject);
  if(k>=0) a.splice(k,1); else a.push({classId, subject});
  renderAll();
}
function addTeacher(){
  const d = state.draft, name = d.name.trim();
  if(!name){ alert('Enter the teacher name.'); return; }
  if(!d.assign.length){ alert('Pick at least one class and subject.'); return; }
  const t = {id:uid('t'), name, phone:d.phone.trim(), assignments:d.assign.map(a=>({...a})), subjects:[], classIds:[]};
  syncTeacher(t);
  state.teachers.push(t);
  state.draft = {name:'', phone:'', assign:[]};
  renderAll();
}
function removeTeacher(id){
  state.teachers = state.teachers.filter(t=>t.id!==id);
  state.classes.forEach(c=>{
    activeDays().forEach(day=>{
      schedOf(c).filter(p=>p.type==='period').forEach(p=>{
        const cell = getCell(c.id, day, p.id);
        if(cell.teacherId===id){ cell.teacherId=''; }
      });
    });
  });
  renderAll();
}
function resetAll(){
  state.teachers=[]; state.classes=[]; state.subjectCatalog=[]; state.timetable={}; state.absences={}; state.substitutions={};
  state.buildClassId=null; state.viewDay=null; state.genReport=null;
  state.draft = {name:'', phone:'', assign:[]}; state.classDraft = {name:'', subjects:[]};
  state.leaveRequests=[]; state.notifications=[];
  renderAll();
}

/* ---------------- AUTO-GENERATOR ---------------- */
function inputSignature(){
  const sig = [
    activeDays(),
    state.periods.map(p=>[p.id,p.type,p.end]), state.schoolEnd, state.classXEnd,
    state.classes.map(c=>[c.id,c.subjects,c.advisorId||'']),
    state.subjectCatalog.map(x=>[x.name,x.type]),
    state.teachers.map(t=>[t.id,t.assignments])
  ];
  const own = state.classes.filter(c=>c.schedule||c.endTime).map(c=>[c.id,c.endTime||'',c.schedule?c.schedule.map(p=>[p.id,p.type,p.start,p.end]):null]);
  if(own.length) sig.push(own);
  return JSON.stringify(sig);
}
function shuffle(a){
  for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; }
  return a;
}
function isClassOneTwo(name){
  return /^\s*(?:class|grade|std|standard)?\s*[-.:]?\s*(?:i{1,2}|1|2|1st|2nd)(?:[-\s]+[a-z])?\s*$/i.test(String(name||''));
}
/* Builds the "units" a class schedules each day. For CLASS I & II, subjects named like
   Maths1 + Maths2 / English1 + English2 become one 2-period block that must sit in two
   consecutive periods. Every other subject is a single period. */
function buildUnits(c, warnings){
  const subs = [...new Set(c.subjects)].filter(sn=>{
    if(teachersFor(c.id, sn).length) return true;
    warnings.push(`${c.name}: no teacher assigned for ${sn}`); return false;
  });
  const units = [], used = new Set();
  if(isClassOneTwo(c.name)){
    const bases = {};
    subs.forEach(sn=>{
      const m = sn.trim().match(/^(.*?)[\s_-]*([12])$/);
      if(m && m[1].trim()) (bases[m[1].trim().toLowerCase()] = bases[m[1].trim().toLowerCase()] || {})[m[2]] = sn;
    });
    Object.values(bases).forEach(p=>{
      if(p['1'] && p['2']){ units.push({parts:[p['1'],p['2']], cost:2}); used.add(p['1']); used.add(p['2']); }
    });
  }
  subs.forEach(sn=>{ if(!used.has(sn)) units.push({parts:[sn], cost:1}); });
  units.forEach(u=>{ u.core = u.parts.every(isCoreSubject); });
  return units;
}
function isClassX(name){
  return /^\s*(?:class|grade|std|standard)?\s*[-.:]?\s*(?:x|10|10th)(?:[-\s]+[a-z])?\s*$/i.test(String(name||''));
}
/* each class has its own finishing time: CLASS X runs later than the rest of the school */

function runGenerate(manual){
  if(manual && Object.keys(state.timetable).length && !confirm('Regenerate the timetable? Manual edits will be replaced.')) return;
  const days = activeDays(), D = days.length, tps = masterCols().filter(x=>x.type==='period'), P = tps.length;
  const ov = tps.map(a=>tps.map((b,j)=>slotsOverlap(a.slot,b.slot)?j:-1).filter(j=>j>=0));   // columns that overlap in time
  const warnings = [], tLoad = {}, info = {};
  state.teachers.forEach(t=>tLoad[t.id]=0);
  const sameT = (a,b)=> String(a).toLowerCase()===String(b).toLowerCase();
  const teachesIn = (t,cid,sn)=> (t.assignments||[]).some(a=>a.classId===cid && sameT(a.subject,sn));

  state.classes.forEach(c=>{
    if(!c.subjects.length){ warnings.push(`${c.name}: no subjects set`); return; }
    const units = buildUnits(c, warnings);
    const sc = schedOf(c), pid = {}, pos = {};   // this class's own periods -> master column index
    sc.forEach((p,i)=>{ if(p.type==='period' && periodForClass(c,p)){ const mi = tps.findIndex(x=>x.key===pKey(sc,p)); if(mi>=0){ pid[mi]=p.id; pos[mi]=i; } } });
    const availIdx = Object.keys(pid).map(Number).sort((a,b)=>a-b), Pc = availIdx.length;
    const nx = {}, pv = {};   // consecutive periods of THIS class (nothing, e.g. break/lunch, in between)
    availIdx.forEach((mi,k)=>{ const n=availIdx[k+1]; if(n!=null && pos[n]-pos[mi]===1){ nx[mi]=n; pv[n]=mi; } });
    if(!units.length) return;
    if(!Pc){ warnings.push(`${c.name}: no periods fall before its finishing time (${classEndTime(c)})`); return; }
    const adv = c.advisorId && getTeacher(c.advisorId);
    if(!adv) warnings.push(`${c.name}: no class advisor set — period 1 is not reserved`);
    let advUnit = null;                     // advisor's subject for period 1 (same every day)
    if(adv){
      const opts = units.filter(u=>u.core && u.parts.some(sn=>teachesIn(adv,c.id,sn)));
      if(!opts.length) warnings.push(`${c.name}: advisor ${adv.name} teaches no core subject in this class, so period 1 is not reserved for the advisor (the day still starts with a core subject)`);
      else { const singles = opts.filter(u=>u.cost===1); advUnit = (singles.length?singles:opts)[0]; }
    }
    if(!units.some(u=>u.core)) warnings.push(`${c.name}: has no core subject, so period 1 can't start with a core subject — mark at least one of its subjects as Core`);
    const blocks = units.filter(u=>u.cost===2 && u!==advUnit), singles = units.filter(u=>u.cost===1 && u!==advUnit);
    let A = Pc - (advUnit?advUnit.cost:0) - blocks.length*2;
    while(A<0 && blocks.length){ const b = blocks.pop(); A += 2; warnings.push(`${c.name}: no room for the double period ${b.parts.join(' + ')}`); }
    let fixedSingles = singles, pool = [], R = 0;
    if(singles.length > A){
      const o = singles.length - A;
      if(D<2 || A<1){
        fixedSingles = singles.slice(0, Math.max(A,0));
        singles.slice(Math.max(A,0)).forEach(u=>warnings.push(`${c.name}: no room for ${u.parts[0]}`));
      } else {
        // more subjects than periods: the last R periods of the day rotate through a pool of subjects,
        // so every subject still runs at least once a week (and never twice in one day)
        R = Math.min(A, Math.ceil(o/(D-1)));
        fixedSingles = singles.slice(0, A-R); pool = singles.slice(A-R);
        if(R*D < pool.length){ pool.splice(R*D).forEach(u=>warnings.push(`${c.name}: no room for ${u.parts[0]}`)); }
        warnings.push(`${c.name}: ${singles.length+(advUnit?advUnit.cost:0)+blocks.length*2} subject periods for ${Pc} periods a day — the last ${R===1?'period rotates':R+' periods rotate'} through ${pool.map(u=>u.parts[0]).join(', ')} so every subject is still covered.`);
      }
    }
    const fixed = [...(advUnit?[advUnit]:[]), ...blocks, ...fixedSingles];
    const used = fixed.reduce((n,u)=>n+u.cost,0);
    if(!R && used<Pc) warnings.push(`${c.name}: ${used} subject period${used===1?'':'s'} a day (up to ${classEndTime(c)}), so the last ${Pc-used} period${Pc-used===1?'':'s'} of every day stay free — a subject never repeats in a day. Add more subjects to fill them.`);
    if(blocks.length && !Object.keys(nx).length) warnings.push(`${c.name}: double-period subjects need two back-to-back periods, but none exist in the schedule`);
    info[c.id] = {c, adv, advUnit, units: fixed, pool, R, pid, nx, pv, avail: new Set(availIdx), first: availIdx[0],
      limit: availIdx[Pc-R-1], rotIdx: availIdx.slice(Pc-R)};
  });
  const cids = Object.keys(info);

  // One fixed pattern per class (same subject, same period, every day), filled from period 1 onwards.
  let best = null;
  for(let attempt=0; attempt<600; attempt++){
    const busyF = tps.map(()=>new Set()), busyD = days.map(()=>tps.map(()=>new Set())), load = {}, grid = {}, rot = {}, left = {};
    let gaps = 0, rotMiss = 0, startGaps = 0;
    // free at (pi, day di): the teacher just must not already be teaching at that time (back-to-back periods are allowed)
    const free = (t,pi,di,cid)=> !(busyF[pi].has(t.id) || (di!=null && busyD[di][pi].has(t.id)));
    const pickTeacher = (cid, sn, pi, di)=>{
      const c = teachersFor(cid, sn).filter(t=>free(t,pi,di,cid));
      if(!c.length) return null;
      return c.map(t=>({t, s:tLoad[t.id]+(load[t.id]||0)+Math.random()})).sort((a,b)=>a.s-b.s)[0].t;
    };
    const putF = (cid, pi, sn, t)=>{ grid[cid][pi] = {subject:sn, teacherId:t.id}; ov[pi].forEach(q=>{ busyF[q].add(t.id); }); load[t.id] = (load[t.id]||0)+1; };
    cids.forEach(cid=>{ grid[cid] = new Array(P).fill(null); rot[cid] = days.map(()=>({})); left[cid] = info[cid].units.filter(u=>u!==info[cid].advUnit); });
    // 1) period 1 = class advisor (a double-period advisor subject also takes period 2)
    cids.forEach(cid=>{
      const I = info[cid], u = I.advUnit; if(!u) return;
      if(u.cost===1){
        if(!free(I.adv,I.first,null,cid)){ left[cid].unshift(u); return; }
        putF(cid, I.first, u.parts[0], I.adv);
      } else {
        const mine = u.parts.findIndex(sn=>teachesIn(I.adv,cid,sn)), order = mine===0?[0,1]:[1,0];
        const n1 = I.nx[I.first], other = n1!=null && free(I.adv,I.first,null,cid) ? pickTeacher(cid, u.parts[order[1]], n1) : null;
        if(!other){ left[cid].unshift(u); return; }
        putF(cid, I.first, u.parts[order[0]], I.adv); putF(cid, n1, u.parts[order[1]], other);
      }
    });
    // 2) fill the remaining periods in order, earliest first, so free periods fall at the end of the day
    for(let pi=0; pi<P; pi++){
      shuffle(cids.slice()).forEach(cid=>{
        const I = info[cid];
        if(grid[cid][pi] || !left[cid].length || !I.avail.has(pi) || pi>I.limit) return;
        const feas = left[cid].filter(u=> (pi!==I.first || u.core) && (u.cost===1
          ? teachersFor(cid,u.parts[0]).some(t=>free(t,pi,null,cid))
          : I.nx[pi]!=null && I.nx[pi]<=I.limit && !grid[cid][I.nx[pi]]
            && teachersFor(cid,u.parts[0]).some(t=>free(t,pi,null,cid)) && teachersFor(cid,u.parts[1]).some(t=>free(t,I.nx[pi],null,cid))));
        if(!feas.length){ gaps++; if(pi===I.first) startGaps++; return; }
        const blocks = feas.filter(u=>u.cost===2);
        const pool = (blocks.length && Math.random()<0.5) ? blocks : feas;
        const u = pool[Math.floor(Math.random()*pool.length)];
        u.parts.forEach((sn,j)=>{ const q = j ? I.nx[pi] : pi; putF(cid, q, sn, pickTeacher(cid, sn, q)); });
        left[cid].splice(left[cid].indexOf(u),1);
      });
    }
    // 3) rotating periods (only for classes with more subjects than periods): a different subject each day
    shuffle(cids.slice()).forEach(cid=>{
      const I = info[cid]; if(!I.R) return;
      const cnt = {}; I.pool.forEach(u=>cnt[u.parts[0]]=0);
      days.forEach((day,di)=>{
        const usedToday = new Set();
        I.rotIdx.forEach(pi=>{
          const c = I.pool.map(u=>u.parts[0]).filter(sn=>(pi!==I.first || isCoreSubject(sn)) && !usedToday.has(sn) && teachersFor(cid,sn).some(t=>free(t,pi,di,cid)));
          if(!c.length){ rotMiss++; return; }
          const m = Math.min(...c.map(sn=>cnt[sn])), pick = shuffle(c.filter(sn=>cnt[sn]===m))[0];
          const t = pickTeacher(cid, pick, pi, di);
          rot[cid][di][pi] = {subject:pick, teacherId:t.id}; ov[pi].forEach(q=>{ busyD[di][q].add(t.id); });
          cnt[pick]++; usedToday.add(pick);
        });
      });
      I.pool.forEach(u=>{ if(!cnt[u.parts[0]]) rotMiss++; });
    });
    const miss = cids.reduce((n,cid)=>n+left[cid].length,0) + rotMiss;
    const score = -miss*100000 - startGaps*5000 - gaps*10;
    if(!best || score>best.score) best = {grid, rot, score, left:Object.fromEntries(cids.map(cid=>[cid,left[cid].slice()]))};
    if(!miss && !gaps && !startGaps) break;
  }

  const tt = {};
  cids.forEach(cid=>{
    tt[cid] = {};
    days.forEach((day,di)=>{
      tt[cid][day] = {};
      best.grid[cid].forEach((cell,pi)=>{ if(cell) tt[cid][day][info[cid].pid[pi]] = {subject:cell.subject, teacherId:cell.teacherId}; });
      Object.entries(best.rot[cid][di]).forEach(([pi,cell])=>{ tt[cid][day][info[cid].pid[pi]] = {subject:cell.subject, teacherId:cell.teacherId}; });
    });
    best.left[cid].forEach(u=>warnings.push(`${info[cid].c.name}: couldn't fit ${u.parts.join(' + ')} (teacher busy in every free slot — add another teacher for this subject or reduce that teacher's load)`));
    days.forEach(day=>Object.values(tt[cid][day]).forEach(cell=>tLoad[cell.teacherId]++));
  });
  const oldAbs = state.absences;
  state.timetable = tt; state.substitutions = {}; state.absences = {};
  Object.keys(oldAbs).forEach(day=>Object.keys(oldAbs[day]).forEach(tid=>{ if(getTeacher(tid) && days.includes(day)) markAbsent(day, tid); }));
  let placedTotal = 0;
  Object.values(tt).forEach(d=>Object.values(d).forEach(p=>placedTotal += Object.keys(p).length));
  state.genReport = {placed: placedTotal, warnings,
    time: new Date().toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit'})};
  state.genSig = inputSignature();
  if(manual) renderAll();
}

/* ---------------- TAB 2: SCHEDULE STRUCTURE ---------------- */
function periodRowsHtml(sched){
  return `<div class="period-row header-row"><div>Label</div><div>Start</div><div>End</div><div>Type</div><div></div></div>`
  + sched.map(p=>`
    <div class="period-row">
      <input type="text" value="${esc(p.label)}" onchange="updatePeriod('${p.id}','label',this.value)">
      <input type="time" value="${p.start}" onchange="updatePeriod('${p.id}','start',this.value)">
      <input type="time" value="${p.end}" onchange="updatePeriod('${p.id}','end',this.value)">
      <select onchange="updatePeriod('${p.id}','type',this.value)">${['period','break','lunch'].map(t=>`<option value="${t}" ${p.type===t?'selected':''}>${t[0].toUpperCase()+t.slice(1)}</option>`).join('')}</select>
      <button class="iconbtn" onclick="removePeriod('${p.id}')">✕</button>
    </div>`).join('');
}
function renderScheduleTab(){
  const c = getClass(state.schedTarget), tgt = c ? c.id : 'default';
  const dEnd = k => k.endTime || (k.schedule ? '' : classEndTime(k));
  return `
  ${schedImportPanel()}

  <div class="panel">
    <h2 class="panel-title">Teaching days</h2>
    <p class="panel-desc">Toggle which days of the week get a timetable.</p>
    <div class="day-toggles">
      ${state.days.map(d=>`<div class="day-toggle ${d.on?'on':''}" onclick="toggleDay('${d.id}')">${d.id}</div>`).join('')}
    </div>
  </div>

  <div class="panel">
    <h2 class="panel-title">Timings by class</h2>
    <p class="panel-desc">Every class can have its own periods, period timings and finishing time. Classes without their own setting follow the school default. Teachers are never double-booked, even when classes run on different timings.</p>
    <div class="field" style="max-width:320px;"><label>Edit timings for</label>
      <select onchange="state.schedTarget=this.value; renderAll();">
        <option value="default" ${tgt==='default'?'selected':''}>School default</option>
        ${state.classes.map(k=>`<option value="${k.id}" ${tgt===k.id?'selected':''}>${esc(k.name)}${k.schedule||k.endTime?' ★':''}</option>`).join('')}
      </select></div>
    ${state.classes.length ? `<div class="tt-scroll"><table class="load-table"><thead><tr><th>Class</th><th>Periods</th><th>Finishes</th><th>Periods / day</th><th></th></tr></thead><tbody>
      ${state.classes.map(k=>`<tr><td class="load-name">${esc(k.name)}</td><td>${k.schedule?'Own timings':'School default'}</td><td>${classDayEnd(k)||'—'}${k.endTime?' (set)':''}</td><td>${classPeriods(k).length}</td><td><button class="ghost" onclick="state.schedTarget='${k.id}'; renderAll();">Edit</button></td></tr>`).join('')}
    </tbody></table></div>` : ''}
  </div>

  ${c ? `
  <div class="panel">
    <h2 class="panel-title">${esc(c.name)} — timings</h2>
    <div class="day-toggles" style="margin-bottom:14px;">
      <div class="day-toggle ${!c.schedule?'on':''}" onclick="setClassCustom('${c.id}',false)">Same periods as school default</div>
      <div class="day-toggle ${c.schedule?'on':''}" onclick="setClassCustom('${c.id}',true)">Own periods &amp; timings</div>
    </div>
    <div class="field" style="max-width:260px;"><label>Finishing time for ${esc(c.name)}</label>
      <input type="time" value="${c.endTime||''}" onchange="setClassEnd('${c.id}',this.value)">
      <div class="hint">${c.endTime ? 'Custom finishing time.' : (c.schedule ? 'Blank = classes run through all of its own periods.' : 'Blank = school default ('+classEndTime(c)+').')}</div></div>
    ${c.endTime ? `<button class="ghost" onclick="setClassEnd('${c.id}','')">Use default finishing time</button>` : ''}
    ${c.schedule ? `
      <p class="panel-desc" style="margin-top:16px;">Periods for this class only. Periods ending after its finishing time are not used.</p>
      ${periodRowsHtml(c.schedule)}
      <div style="margin-top:14px;"><button class="ghost" onclick="addPeriodRow()">+ Add row</button></div>` : '<p class="hint">This class uses the school default period grid. Choose “Own periods &amp; timings” to change its period count and times.</p>'}
  </div>` : `
  <div class="panel">
    <h2 class="panel-title">Default finishing time</h2>
    <p class="panel-desc">Used by every class that has no finishing time of its own (set one per class above). A class only gets periods that end by its finishing time.</p>
    <div class="grid-2" style="gap:16px;max-width:520px;">
      <div class="field"><label>Default for all classes</label><input type="time" value="${state.schoolEnd}" onchange="state.schoolEnd=this.value; renderAll();"></div>
      <div class="field"><label>Default for CLASS X</label><input type="time" value="${state.classXEnd}" onchange="state.classXEnd=this.value; renderAll();"></div>
    </div>
  </div>

  <div class="panel">
    <h2 class="panel-title">Default periods</h2>
    <p class="panel-desc">Define each slot in the day — regular periods, breaks, and lunch. Break/lunch rows don't get subjects or teachers assigned.</p>
    ${periodRowsHtml(state.periods)}
    <div style="margin-top:14px;display:flex;gap:8px;">
      <button class="ghost" onclick="addPeriodRow()">+ Add row</button>
      <button class="ghost" onclick="resetPeriods()">Reset to default</button>
    </div>
  </div>`}
  `;
}
function toggleDay(id){ const d = state.days.find(x=>x.id===id); d.on = !d.on; renderAll(); }
function allSchedArrays(){ return [state.periods, ...state.classes.filter(c=>c.schedule).map(c=>c.schedule)]; }
function editSched(){ const c = getClass(state.schedTarget); return c && c.schedule ? c.schedule : state.periods; }
function updatePeriod(id, field, value){
  for(const sc of allSchedArrays()){ const p = sc.find(x=>x.id===id); if(p){ p[field]=value; break; } }
  renderAll();
}
function removePeriod(id){
  for(const sc of allSchedArrays()){ const i = sc.findIndex(x=>x.id===id); if(i>=0){ sc.splice(i,1); break; } }
  renderAll();
}
function addPeriodRow(){
  const sc = editSched();
  sc.push({id:uid('per'), label:String(sc.filter(p=>p.type==='period').length+1), start:'', end:'', type:'period'});
  renderAll();
}
function resetPeriods(){ state.periods = defaultPeriods(); renderAll(); }
function setClassEnd(cid, v){ getClass(cid).endTime = v || ''; renderAll(); }
function setClassCustom(cid, on){
  const c = getClass(cid);
  if(on){
    if(c.schedule) return;
    const map = {};
    c.schedule = state.periods.map(p=>{ const q = {...p, id:uid('per')}; map[p.id]=q.id; return q; });
    const old = state.timetable[cid];       // keep existing cells, re-keyed to the class's own periods
    if(old) Object.keys(old).forEach(d=>{ const nd = {}; Object.keys(old[d]).forEach(k=>{ if(map[k]) nd[map[k]] = old[d][k]; }); old[d] = nd; });
  } else if(c.schedule){ delete c.schedule; delete state.timetable[cid]; }
  renderAll();
}

/* ---------------- TAB 3: BUILD TIMETABLE ---------------- */
function renderBuildTab(){
  if(state.classes.length===0){
    return `<div class="panel"><div class="empty-state">Add at least one class in "Staff & Classes" first.</div></div>`;
  }
  if(!state.buildClassId || !getClass(state.buildClassId)) state.buildClassId = state.classes[0].id;
  const days = activeDays();
  const subjects = (getClass(state.buildClassId).subjects||[]);
  const bc = getClass(state.buildClassId), bsch = schedOf(bc), cps = classPeriods(bc);

  const rep = state.genReport;
  return `
  <div class="panel">
    <h2 class="panel-title">Auto-generate</h2>
    <p class="panel-desc">Fills every class's week using each teacher's subjects and classes. Rules: all classes finish at the school end time (CLASS X later); every subject of a class is covered; teachers may teach back-to-back periods; period 1 always goes to the class advisor (when the advisor teaches a core subject there), and every day starts with a core subject, never an additional one; periods are filled from period 1 onwards and any free periods fall at the end of the day; every day (Mon–Sat) has the same subject at the same time; for CLASS I &amp; II, paired subjects (Maths1 + Maths2, English1 + English2…) sit in two back-to-back periods; a subject never repeats within a day; no teacher is double-booked.</p>
    <button class="brass" onclick="runGenerate(true)">⟳ Generate timetable</button>
    <label style="display:flex;align-items:center;gap:6px;margin-top:12px;text-transform:none;font-family:'Inter',sans-serif;font-size:12.5px;letter-spacing:0;">
      <input type="checkbox" style="width:auto;" ${state.autoGen?'checked':''} onchange="state.autoGen=this.checked; renderAll();"> Regenerate automatically when classes, subjects, teachers or periods change (replaces manual edits)
    </label>
    ${rep ? `<p class="sync-note">Last generated ${rep.time} · ${rep.placed} periods placed</p>
      ${rep.warnings.map(w=>`<div class="log-item fail">${esc(w)}</div>`).join('')}` : ''}
  </div>

  <div class="panel">
    <h2 class="panel-title">Build Timetable</h2>
    <p class="panel-desc">The timetable is generated automatically from your classes, subjects and teachers. Pick a class below to review it or fine-tune any period; teachers shown are only those free at that slot.</p>
    <div class="field" style="max-width:280px;">
      <label>Class</label>
      <select onchange="state.buildClassId=this.value; renderAll();">
        ${state.classes.map(c=>`<option value="${c.id}" ${c.id===state.buildClassId?'selected':''}>${c.name}</option>`).join('')}
      </select>
    </div>
  </div>

  <div class="panel">
    <div class="tt-scroll">
    <table class="tt">
      <thead><tr><th style="text-align:left;">Day</th>${cps.map(p=>`<th>P${p.label}<span class="ptime">${p.start||''}${p.end?'–'+p.end:''}</span></th>`).join('')}</tr></thead>
      <tbody>
        ${days.map(day=>`
          <tr>
            <td class="class-cell">${day}</td>
            ${cps.map(p=>{
              const cell = ensureCell(state.buildClassId, day, p.id);
              const busy = occupiedTeachersAt(day, slotOf(bsch,p), state.buildClassId);
              const matching = subjects.length ? state.teachers.filter(t=>!cell.subject || t.subjects.some(s=>s.toLowerCase()===cell.subject.toLowerCase())) : state.teachers;
              const availableTeachers = state.teachers.filter(t=> !busy.has(t.id) || t.id===cell.teacherId);
              const teacherOptions = (cell.subject ? teachersFor(state.buildClassId, cell.subject) : state.teachers)
                .filter(t=>availableTeachers.includes(t));
              const noneAvailable = cell.subject && teacherOptions.length===0;
              return `
              <td class="build-cell">
                <input type="text" list="subjectList" placeholder="Subject" value="${cell.subject}"
                  onchange="setCellSubject('${state.buildClassId}','${day}','${p.id}',this.value)">
                <select onchange="setCellTeacher('${state.buildClassId}','${day}','${p.id}',this.value)">
                  <option value="">— none —</option>
                  ${teacherOptions.map(t=>`<option value="${t.id}" ${t.id===cell.teacherId?'selected':''}>${t.name}</option>`).join('')}
                </select>
                ${noneAvailable ? '<div class="warn-text">No free teacher for this subject here</div>':''}
              </td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
    <datalist id="subjectList">${subjects.map(s=>`<option value="${s}">`).join('')}</datalist>
    <p class="hint">Tip: type a subject, tab out, then choose from the teachers who teach it and are free that period. Leave a cell blank and it shows as LEISURE (free period) in the class and teacher timetables.</p>
  </div>
  `;
}
function setCellSubject(classId, day, periodId, value){
  const cell = ensureCell(classId, day, periodId);
  cell.subject = value.trim();
  if(cell.teacherId){
    const t = getTeacher(cell.teacherId);
    if(!t || !teachersFor(classId, cell.subject).some(x=>x.id===t.id)) cell.teacherId='';
  }
  renderAll();
}
function setCellTeacher(classId, day, periodId, teacherId){
  const cell = ensureCell(classId, day, periodId);
  cell.teacherId = teacherId;
  renderAll();
}

/* ---------------- TAB 4: VIEW & SUBSTITUTE ---------------- */
function renderViewTab(){
  if(state.classes.length===0 || activeDays().length===0){
    return `<div class="panel"><div class="empty-state">Add classes and at least one teaching day first.</div></div>`;
  }
  const days = activeDays();
  if(!state.viewDay || !days.includes(state.viewDay)) state.viewDay = days[0];
  const day = state.viewDay;

  const teachersActiveOnDay = state.teachers.filter(t=>
    state.classes.some(c=> teachingPeriods().some(p=> getCell(c.id,day,p.id).teacherId===t.id ))
  );
  const currentAbsences = Object.keys(state.absences[day]||{});
  const mc = masterCols();

  return `
  <div class="panel">
    <h2 class="panel-title">Mark a teacher absent</h2>
    <p class="panel-desc">Choosing a day and teacher below finds a substitute for every period that teacher was scheduled — preferring another teacher of the same subject, otherwise whoever's free.</p>
    <div class="absence-row">
      <div class="field" style="max-width:160px;">
        <label>Day</label>
        <select onchange="state.absenceDay=this.value; renderAll();">
          ${days.map(d=>`<option value="${d}" ${d===day?'selected':''}>${d}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="max-width:220px;">
        <label>Teacher</label>
        <select id="absenceTeacherSelect">
          <option value="">Select teacher…</option>
          ${teachersActiveOnDay.map(t=>`<option value="${t.id}">${t.name}</option>`).join('')}
        </select>
      </div>
      <button class="brass" onclick="doMarkAbsent()">Mark absent & substitute</button>
    </div>

    ${currentAbsences.length ? `
      <div style="margin-bottom:10px;">
        ${currentAbsences.map(tid=>`
          <div class="active-absence">
            <span><strong>${getTeacher(tid)?getTeacher(tid).name:'(removed)'}</strong> is absent on ${day}</span>
            <button class="ghost" onclick="doClearAbsence('${tid}')">Undo</button>
          </div>
        `).join('')}
      </div>` : ''}

    ${state.lastSubResults ? `
      <div>
        ${state.lastSubResults.map(r=> r.ok
          ? `<div class="log-item">${r.className} · P${r.period} (${r.subject}) → <strong>${r.sub}</strong>${r.subjectMatch?'':' <span style="color:var(--brick)">(different subject)</span>'}</div>`
          : `<div class="log-item fail">${r.className} · P${r.period} (${r.subject}) → <strong>no free substitute found</strong></div>`
        ).join('')}
      </div>` : ''}
  </div>

  ${exportPanel()}
  <div class="panel print-target-class">
    <div class="print-header">
      <h2>Regular Timetable — all classes · ${day}</h2>
      <div class="meta">${state.classes.length} classes · generated ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</div>
    </div>
    <div class="print-btn-row no-print" style="gap:10px;align-items:center;">
      ${orientPick()}
      <button class="ghost" onclick="printClassTimetable()">⬇ Download PDF</button>
    </div>
    <h2 class="panel-title">Regular Timetable — all classes, ${day}</h2>
    <label class="no-print" style="display:flex;align-items:center;gap:6px;margin-bottom:10px;text-transform:none;font-family:'Inter',sans-serif;font-size:12.5px;letter-spacing:0;">
      <input type="checkbox" style="width:auto;" ${state.viewEdit?'checked':''} onchange="state.viewEdit=this.checked; renderAll();"> Edit mode — change the subject and teacher of any period (uses each class's subject list; only free teachers are offered)
    </label>
    <div class="day-tabs no-print">
      ${days.map(d=>`<button class="day-tab ${d===day?'active':''}" onclick="state.viewDay='${d}'; renderAll();">${d}</button>`).join('')}
    </div>
    <div class="tt-scroll">
    <table class="tt">
      <thead><tr>
        <th style="text-align:left;">Class</th>
        ${masterCols().map(p=> p.type==='period'
          ? `<th>P${p.label}<span class="ptime">${p.start||''}${p.end?'–'+p.end:''}</span></th>`
          : `<th style="min-width:26px;">${p.type==='break'?'Brk':'Lunch'}</th>`
        ).join('')}
      </tr></thead>
      <tbody>
        ${state.classes.map(c=>`
          <tr>
            <td class="class-cell">${c.name}${c.advisorId&&getTeacher(c.advisorId)?`<div style="font:400 10px 'IBM Plex Mono',monospace;color:var(--ink-soft);margin-top:3px;">CT: ${esc(getTeacher(c.advisorId).name)}</div>`:''}</td>
            ${mc.map(col=>{
              const p = classPeriodForCol(c, col);
              if(!p || !periodForClass(c,p)) return `<td class="cell-absent"><div class="cell-wrap"><span class="cell-empty">—</span></div></td>`;
              if(p.type!=='period') return `<td class="break-col"><span>${p.type==='break'?'BREAK':'LUNCH'}</span></td>`;
              const cell = getCell(c.id, day, p.id);
              const sub = getSub(day, c.id, p.id);
              if(state.viewEdit) return viewEditCell(c, day, p, cell, sub);
              if(!cell.subject) return `<td class="cell-leisure"><div class="cell-wrap"><span class="leisure">LEISURE</span></div></td>`;
              if(sub && sub.subTeacherId){
                return `<td class="cell-sub-active"><div class="cell-wrap">
                  <span class="stamp">SUB</span>
                  <div class="cell-subject">${cell.subject}</div>
                  <div class="cell-teacher-orig">${getTeacher(sub.originalTeacherId)?getTeacher(sub.originalTeacherId).name:''}</div>
                  <div class="cell-teacher-new">${getTeacher(sub.subTeacherId)?getTeacher(sub.subTeacherId).name:''}</div>
                </div></td>`;
              }
              if(sub && !sub.subTeacherId){
                return `<td class="cell-nosub"><div class="cell-wrap">
                  <div class="cell-subject">${cell.subject}</div>
                  <div class="cell-teacher">No substitute available</div>
                </div></td>`;
              }
              return `<td><div class="cell-wrap">
                <div class="cell-subject">${cell.subject}</div>
                <div class="cell-teacher">${getTeacher(cell.teacherId)?getTeacher(cell.teacherId).name:''}</div>
              </div></td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
  </div>
  `;
}
function viewEditCell(c, day, p, cell, sub){
  const sc = schedOf(c), busy = occupiedTeachersAt(day, slotOf(sc,p), c.id);
  const subs = c.subjects || [];
  const opts = (cell.subject ? teachersFor(c.id, cell.subject) : state.teachers).filter(t=>!busy.has(t.id) || t.id===cell.teacherId);
  const none = cell.subject && opts.length===0;
  const listId = 'subj_'+c.id;
  return `<td class="build-cell ${sub?'cell-sub-active':''}">
    <input type="text" list="${listId}" placeholder="Subject" value="${esc(cell.subject)}"
      onchange="setCellSubject('${c.id}','${day}','${p.id}',this.value)">
    <select onchange="setCellTeacher('${c.id}','${day}','${p.id}',this.value)">
      <option value="">— none —</option>
      ${opts.map(t=>`<option value="${t.id}" ${t.id===cell.teacherId?'selected':''}>${esc(t.name)}</option>`).join('')}
    </select>
    ${none ? '<div class="warn-text">No free teacher</div>' : ''}
    ${sub && sub.subTeacherId && getTeacher(sub.subTeacherId) ? `<div class="warn-text">SUB: ${esc(getTeacher(sub.subTeacherId).name)}</div>` : ''}
    <datalist id="${listId}">${subs.map(x=>`<option value="${esc(x)}">`).join('')}</datalist>
  </td>`;
}
function doMarkAbsent(){
  const day = state.absenceDay || state.viewDay;
  const sel = document.getElementById('absenceTeacherSelect');
  const teacherId = sel.value;
  if(!teacherId) return;
  const results = markAbsent(day, teacherId);
  state.lastSubResults = results;
  state.viewDay = day;
  renderAll();
}
function doClearAbsence(teacherId){
  clearAbsence(state.viewDay, teacherId);
  state.lastSubResults = null;
  renderAll();
}

/* ---------------- TAB 5: TEACHER SCHEDULE ---------------- */
/* What is this teacher actually doing at a given day/period:
   teaching their own class, covering someone else's as a substitute,
   marked absent, or free. */
function teacherStatusAt(teacherId, day, col){
  if(state.absences[day] && state.absences[day][teacherId]){
    return {status:'absent'};
  }
  for(const c of state.classes){
    const p = classPeriodForCol(c, col); if(!p) continue;
    const cell = getCell(c.id, day, p.id);
    if(!cell.subject) continue;
    const sub = getSub(day, c.id, p.id);
    if(sub && sub.subTeacherId === teacherId){
      return {status:'covering', className:c.name, subject:sub.subject, originalTeacherId:sub.originalTeacherId};
    }
    if(cell.teacherId === teacherId && !(sub && sub.subTeacherId)){
      if(!(sub && sub.originalTeacherId===teacherId)){
        return {status:'teaching', className:c.name, subject:cell.subject};
      }
    }
  }
  const t = getTeacher(teacherId);
  return {status: t && teacherOffAt(t,col) ? 'off' : 'free'};   // 'free' is shown as LEISURE
}

function renderTeacherScheduleTab(){
  if(state.teachers.length===0){
    return `<div class="panel"><div class="empty-state">Add teachers in "Staff & Classes" first.</div></div>`;
  }
  const days = activeDays();
  if(days.length===0){
    return `<div class="panel"><div class="empty-state">Turn on at least one teaching day in "Schedule Structure".</div></div>`;
  }
  const isTeacherRole = state.session && state.session.role==='teacher';
  if(isTeacherRole) state.scheduleTeacherId = state.session.teacherId;
  if(!state.scheduleTeacherId || !getTeacher(state.scheduleTeacherId)) state.scheduleTeacherId = state.teachers[0].id;
  const teacher = getTeacher(state.scheduleTeacherId);

  const loadCount = masterCols().filter(x=>x.type==='period').reduce((n,p)=> n + days.filter(day=>{
    const st = teacherStatusAt(teacher.id, day, p);
    return st.status==='teaching' || st.status==='covering';
  }).length, 0);

  return `
  ${exportPanel()}
  ${isTeacherRole ? '' : allTeachersPanel()}
  <div class="panel print-target-teacher">
    <div class="print-header">
      <h2>${teacher.name} — Weekly Schedule</h2>
      <div class="meta">${teacher.subjects.join(', ')} · ${loadCount} period${loadCount===1?'':'s'}/week · generated ${new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})}</div>
    </div>
    <div class="print-btn-row no-print" style="gap:10px;align-items:center;">
      ${orientPick()}
      <button class="ghost" onclick="printTeacherSchedule()">⬇ Download PDF</button>
    </div>
    <h2 class="panel-title">Teacher Schedule</h2>
    <p class="panel-desc no-print">A single teacher's week at a glance — their own classes, any periods they're currently covering as a substitute, and any days they're marked absent.</p>
    <div class="teacher-picker-row no-print">
      ${isTeacherRole ? '' : `
      <div class="field" style="max-width:240px;margin-bottom:0;">
        <label>Teacher</label>
        <select onchange="state.scheduleTeacherId=this.value; renderAll();">
          ${state.teachers.map(t=>`<option value="${t.id}" ${t.id===teacher.id?'selected':''}>${t.name}</option>`).join('')}
        </select>
      </div>`}
      <div class="entry-meta" style="padding-bottom:9px;">${teacher.subjects.join(', ')} · ${loadCount} period${loadCount===1?'':'s'}/week</div>
    </div>

    <div class="tt-scroll">
    <table class="tt">
      <thead><tr>
        <th style="text-align:left;">Day</th>
        ${masterCols().map(p=> p.type==='period'
          ? `<th>P${p.label}<span class="ptime">${p.start||''}${p.end?'–'+p.end:''}</span></th>`
          : `<th style="min-width:26px;">${p.type==='break'?'Brk':'Lunch'}</th>`
        ).join('')}
      </tr></thead>
      <tbody>
        ${days.map(day=>`
          <tr>
            <td class="class-cell">${day}</td>
            ${masterCols().map(p=>{
              if(p.type!=='period') return `<td class="break-col"><span>${p.type==='break'?'BREAK':'LUNCH'}</span></td>`;
              const st = teacherStatusAt(teacher.id, day, p);
              if(st.status==='absent'){
                return `<td class="cell-absent"><div class="cell-wrap"><span class="cell-empty">ABSENT</span></div></td>`;
              }
              if(st.status==='teaching'){
                return `<td><div class="cell-wrap">
                  <div class="cell-subject">${st.subject}</div>
                  <div class="cell-teacher">${st.className}</div>
                </div></td>`;
              }
              if(st.status==='covering'){
                return `<td class="cell-covering"><div class="cell-wrap">
                  <span class="stamp">COVER</span>
                  <div class="cell-subject">${st.subject}</div>
                  <div class="cell-teacher">${st.className}</div>
                </div></td>`;
              }
              if(st.status==='off') return `<td class="cell-absent"><div class="cell-wrap"><span class="cell-empty">—</span></div></td>`;
              return `<td class="cell-leisure"><div class="cell-wrap"><span class="leisure">LEISURE</span></div></td>`;
            }).join('')}
          </tr>
        `).join('')}
      </tbody>
    </table>
    </div>
    <div class="legend no-print">
      <span><i style="background:var(--paper-raised);border:1px solid var(--rule);"></i> Regular class</span>
      <span><i style="background:var(--sage-soft);"></i> Covering a substitution</span>
      <span><i style="background:#eceae0;"></i> Marked absent / day over</span>
      <span><i style="background:#eef3ea;"></i> LEISURE (free period)</span>
    </div>
  </div>
  `;
}

/* ---------------- TAB 6: WORKLOAD ---------------- */
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function dayNameOf(ds){ const [y,m,d]=ds.split('-').map(Number); return DOW[new Date(y,m-1,d).getDay()]; }
function monthDates(ym){ const [y,m]=ym.split('-').map(Number), n=new Date(y,m,0).getDate(), out=[]; for(let i=1;i<=n;i++) out.push(y+'-'+pad2(m)+'-'+pad2(i)); return out; }
function monthLabel(ym){ const [y,m]=ym.split('-').map(Number); return MONTHS[m-1]+' '+y; }
function fmtDate(ds){ const [y,m,d]=ds.split('-'); return d+'-'+m+'-'+y; }

function computeWorkload(teacherId){
  const days = activeDays();
  const perDay = {};
  let total = 0, regular = 0, covering = 0;
  days.forEach(day=>{
    const l = dayLoad(teacherId, day);
    perDay[day] = l.total; total += l.total; regular += l.reg; covering += l.cov;
  });
  return {perDay, total, regular, covering};
}
function dayLoad(teacherId, day){
  let reg=0, cov=0;
  masterCols().filter(x=>x.type==='period').forEach(p=>{
    const st = teacherStatusAt(teacherId, day, p).status;
    if(st==='teaching') reg++; else if(st==='covering') cov++;
  });
  return {reg, cov, total:reg+cov};
}

/* ---- recording ---- */
function buildRecord(date){
  const day = dayNameOf(date), data = {};
  state.teachers.forEach(t=>{ const l = dayLoad(t.id, day); data[t.id] = {name:t.name, reg:l.reg, cov:l.cov, total:l.total}; });
  return {day, savedAt:Date.now(), data};
}
function recordWorkload(date, force){
  if(!activeDays().includes(dayNameOf(date))) return false;
  if(state.workloadLog[date] && !force) return false;
  state.workloadLog[date] = buildRecord(date); return true;
}
/* today's record is kept up to date automatically; past days stay frozen once recorded */
function autoRecordToday(){
  try{
    if(!state.teachers.length) return;
    const d = todayStr(); if(!activeDays().includes(dayNameOf(d))) return;
    const rec = buildRecord(d), old = state.workloadLog[d];
    if(!old || JSON.stringify(old.data)!==JSON.stringify(rec.data)) state.workloadLog[d] = rec;
  }catch(e){}
}
function recordThisDate(){ recordWorkload(state.wlDate, true); renderAll(); }
function backfillMonth(){
  const ym = state.wlMonth, today = todayStr(); let n = 0;
  monthDates(ym).forEach(d=>{ if(d<=today && recordWorkload(d,false)) n++; });
  alert(n ? n+' day(s) recorded from the current timetable.' : 'Nothing new to record — every school day up to today is already stored.');
  renderAll();
}

/* ---- bars ---- */
function barTier(total, avg){
  if(avg>0 && total > avg*1.25) return {col:'#a63d2f', name:'Above average'};
  if(avg>0 && total < avg*0.75) return {col:'#b8862e', name:'Below average'};
  return {col:'#5c7a5e', name:'Balanced'};
}
function loadBar(total, avg, max){
  const pct = max>0 ? Math.round(total/max*100) : 0, t = barTier(total, avg);
  return `<div class="load-bar-track" title="${t.name}"><div class="load-bar-fill" style="width:${pct}%;background:${t.col};"></div></div>`;
}
function barLegend(){
  return `<div class="legend"><span><i style="background:#a63d2f"></i>Above average (&gt;125%)</span><span><i style="background:#5c7a5e"></i>Balanced</span><span><i style="background:#b8862e"></i>Below average (&lt;75%)</span></div>`;
}

/* ---- aggregation ---- */
function dailyRows(date){
  const rec = state.workloadLog[date]; if(!rec) return null;
  return Object.keys(rec.data).map(id=>({id, ...rec.data[id]})).sort((a,b)=>a.name.localeCompare(b.name));
}
function monthlyAgg(ym){
  const dates = monthDates(ym).filter(d=>state.workloadLog[d]);
  const by = {};
  dates.forEach(d=>{ const rec = state.workloadLog[d];
    Object.keys(rec.data).forEach(id=>{ const r = rec.data[id];
      const o = by[id] = by[id] || {id, name:r.name, reg:0, cov:0, total:0, days:0, perDate:{}};
      o.name = r.name; o.reg += r.reg; o.cov += r.cov; o.total += r.total; if(r.total>0) o.days++; o.perDate[d] = r.total; });
  });
  return {dates, rows:Object.values(by).sort((a,b)=>a.name.localeCompare(b.name))};
}

/* ---- downloads ---- */
function xlsxDownload(filename, sheets){
  if(!window.XLSX){ alert('Excel library failed to load — check your connection.'); return; }
  const wb = XLSX.utils.book_new(), used = new Set();
  sheets.forEach(s=>{ const ws = XLSX.utils.aoa_to_sheet(s.aoa); if(s.cols) ws['!cols'] = s.cols.map(w=>({wch:w})); XLSX.utils.book_append_sheet(wb, ws, sheetName(s.name, used)); });
  saveFile(filename, XLSX.write(wb,{type:'array',bookType:'xlsx'}));
}
function pdfDownload(filename, title, sub, head, rows, landscape){
  if(!window.jspdf){ alert('PDF library failed to load — check your connection.'); return; }
  const doc = new window.jspdf.jsPDF({orientation: landscape?'landscape':'portrait', unit:'mm', format:'a4'});
  const wide = head.length > 14;
  doc.setFontSize(14); doc.text(title, 14, 14); doc.setFontSize(9); doc.text(sub, 14, 20);
  doc.autoTable({head:[head], body:rows, startY:24, margin:{left:8,right:8},
    styles:{fontSize: wide?6:9, cellPadding: wide?1:2, halign:'center'},
    headStyles:{fillColor:[34,48,89]}, columnStyles:{0:{halign:'left', cellWidth: wide?30:'auto'}},
    didParseCell:(h)=>{ if(h.section==='body'){ const v=h.cell.raw; if(v==='P') h.cell.styles.fillColor=[221,232,220]; else if(v==='A') h.cell.styles.fillColor=[243,221,214]; else if(v==='L') h.cell.styles.fillColor=[232,213,168]; } }});
  saveFile(filename, doc.output('arraybuffer'));
}
function dlWorkloadDaily(fmt){
  const date = state.wlDate, rows = dailyRows(date);
  if(!rows){ alert('No workload is recorded for this date yet.'); return; }
  const avg = rows.reduce((a,r)=>a+r.total,0)/(rows.length||1);
  const head = ['Teacher','Own periods','Covering','Total','Level'];
  const body = rows.map(r=>[r.name, r.reg, r.cov, r.total, barTier(r.total,avg).name]);
  const sub = dayNameOf(date)+' '+fmtDate(date)+' · '+rows.length+' teachers';
  if(fmt==='xlsx') xlsxDownload('workload-daily-'+date+'.xlsx',[{name:'Daily workload', aoa:[['Daily workload — '+sub],[],head,...body], cols:[26,12,10,8,16]}]);
  else pdfDownload('workload-daily-'+date+'.pdf','Daily workload', sub, head, body, false);
}
function dlWorkloadMonthly(fmt){
  const ym = state.wlMonth, agg = monthlyAgg(ym);
  if(!agg.rows.length){ alert('No workload is recorded for this month yet.'); return; }
  const avg = agg.rows.reduce((a,r)=>a+r.total,0)/agg.rows.length;
  const head = ['Teacher','Days worked','Own periods','Covering','Total','Avg / day','Level'];
  const body = agg.rows.map(r=>[r.name, r.days, r.reg, r.cov, r.total, r.days?(r.total/r.days).toFixed(1):'0.0', barTier(r.total,avg).name]);
  const sub = monthLabel(ym)+' · '+agg.dates.length+' recorded day(s)';
  if(fmt==='xlsx'){
    const dHead = ['Teacher',...agg.dates.map(d=>d.slice(8)+' '+dayNameOf(d)),'Total'];
    const dBody = agg.rows.map(r=>[r.name, ...agg.dates.map(d=>r.perDate[d]==null?'':r.perDate[d]), r.total]);
    xlsxDownload('workload-monthly-'+ym+'.xlsx',[
      {name:'Monthly summary', aoa:[['Monthly workload — '+sub],[],head,...body], cols:[26,12,12,10,8,10,16]},
      {name:'Day by day', aoa:[['Workload by day — '+monthLabel(ym)],[],dHead,...dBody], cols:[26,...agg.dates.map(()=>7),8]}
    ]);
  } else pdfDownload('workload-monthly-'+ym+'.pdf','Monthly workload', sub, head, body, false);
}

/* ---- tab ---- */
function wlSubtabs(){
  const v = state.wlView, b = (id,l)=>`<button class="subtab ${v===id?'on':''}" onclick="state.wlView='${id}'; renderAll();">${l}</button>`;
  return `<div class="subtabs">${b('weekly','Weekly view')}${b('daily','Daily record')}${b('monthly','Monthly record')}</div>`;
}
function renderWorkloadTab(){
  if(state.teachers.length===0){
    return `<div class="panel"><div class="empty-state">Add teachers in "Staff & Classes" first.</div></div>`;
  }
  if(!state.wlDate) state.wlDate = todayStr();
  if(!state.wlMonth) state.wlMonth = todayStr().slice(0,7);
  if(state.wlView==='daily') return renderWorkloadDaily();
  if(state.wlView==='monthly') return renderWorkloadMonthly();
  return renderWorkloadWeekly();
}
function renderWorkloadWeekly(){
  const days = activeDays();
  const rows = state.teachers.map(t=>({t, load: computeWorkload(t.id)}));
  const totals = rows.map(r=>r.load.total);
  const maxLoad = Math.max(1, ...totals);
  const avg = totals.length ? (totals.reduce((a,b)=>a+b,0)/totals.length) : 0;
  const idle = rows.filter(r=>r.load.total===0).length;
  const busiest = rows.slice().sort((a,b)=>b.load.total-a.load.total)[0];
  return `
  <div class="panel">
    <h2 class="panel-title">Workload</h2>
    ${wlSubtabs()}
    <p class="panel-desc">How periods are spread across staff in the weekly timetable, including any substitute cover. Bars are relative to the busiest teacher. Every day's workload is also stored automatically — see the Daily and Monthly records.</p>
    <div class="load-summary">
      <div class="load-stat"><span class="num">${avg.toFixed(1)}</span><span class="lbl">Avg periods / week</span></div>
      <div class="load-stat"><span class="num">${busiest ? busiest.load.total : 0}</span><span class="lbl">${busiest ? esc(busiest.t.name) : '—'} (highest)</span></div>
      <div class="load-stat"><span class="num">${idle}</span><span class="lbl">Teacher${idle===1?'':'s'} with zero periods</span></div>
    </div>
    <div class="tt-scroll">
    <table class="load-table">
      <thead><tr><th>Teacher</th>${days.map(d=>`<th style="text-align:center;">${d}</th>`).join('')}<th style="min-width:140px;">Load</th><th style="text-align:right;">Total</th></tr></thead>
      <tbody>
        ${rows.map(r=>`<tr>
            <td><div class="load-name">${esc(r.t.name)}</div>
              <div class="load-sub">${esc((r.t.subjects||[]).join(', '))}${r.load.covering ? ` · ${r.load.covering} covering` : ''}</div></td>
            ${days.map(d=>`<td class="load-daycount ${r.load.perDay[d]===0?'zero':''}">${r.load.perDay[d]}</td>`).join('')}
            <td>${loadBar(r.load.total, avg, maxLoad)}</td>
            <td style="text-align:right;" class="load-total">${r.load.total}</td>
          </tr>`).join('')}
      </tbody>
    </table></div>
    ${barLegend()}
  </div>`;
}
function renderWorkloadDaily(){
  const date = state.wlDate, rows = dailyRows(date), day = dayNameOf(date);
  const isSchoolDay = activeDays().includes(day);
  let body;
  if(!rows){
    body = `<div class="empty-state">${isSchoolDay ? 'No workload recorded for this date.' : day+' is not a school day.'}</div>
      ${isSchoolDay && date<=todayStr() ? `<button class="brass" onclick="recordThisDate()">Record this date from the current timetable</button>` : ''}`;
  } else {
    const tot = rows.map(r=>r.total), avg = tot.reduce((a,b)=>a+b,0)/(tot.length||1), max = Math.max(1,...tot);
    body = `
    <div class="load-summary">
      <div class="load-stat"><span class="num">${tot.reduce((a,b)=>a+b,0)}</span><span class="lbl">Periods taken</span></div>
      <div class="load-stat"><span class="num">${avg.toFixed(1)}</span><span class="lbl">Avg / teacher</span></div>
      <div class="load-stat"><span class="num">${rows.reduce((a,r)=>a+r.cov,0)}</span><span class="lbl">Covering periods</span></div>
    </div>
    <div class="tt-scroll"><table class="load-table"><thead><tr><th>Teacher</th><th style="text-align:center;">Own</th><th style="text-align:center;">Covering</th><th style="min-width:140px;">Load</th><th style="text-align:right;">Total</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><td class="load-name">${esc(r.name)}</td><td class="load-daycount">${r.reg}</td><td class="load-daycount ${r.cov?'':'zero'}">${r.cov}</td><td>${loadBar(r.total,avg,max)}</td><td style="text-align:right;" class="load-total">${r.total}</td></tr>`).join('')}
    </tbody></table></div>${barLegend()}
    <div class="dl-row"><button class="ghost" onclick="dlWorkloadDaily('xlsx')">⬇ Daily · Excel</button><button class="ghost" onclick="dlWorkloadDaily('pdf')">⬇ Daily · PDF</button>
    ${date<=todayStr()?`<button class="ghost" onclick="recordThisDate()" title="Overwrite this date with the current timetable">↻ Re-record</button>`:''}</div>`;
  }
  return `<div class="panel"><h2 class="panel-title">Workload — daily record</h2>${wlSubtabs()}
    <div class="field" style="max-width:200px;"><label>Date (${day})</label><input type="date" value="${date}" onchange="state.wlDate=this.value||todayStr(); renderAll();"></div>
    ${body}
    <p class="sync-note">Today's record updates automatically as substitutions change; earlier days stay as stored.</p></div>`;
}
function renderWorkloadMonthly(){
  const ym = state.wlMonth, agg = monthlyAgg(ym);
  let body;
  if(!agg.rows.length){
    body = `<div class="empty-state">No workload recorded for ${monthLabel(ym)} yet.</div>`;
  } else {
    const avg = agg.rows.reduce((a,r)=>a+r.total,0)/agg.rows.length, max = Math.max(1,...agg.rows.map(r=>r.total));
    body = `
    <div class="load-summary">
      <div class="load-stat"><span class="num">${agg.dates.length}</span><span class="lbl">Days recorded</span></div>
      <div class="load-stat"><span class="num">${avg.toFixed(1)}</span><span class="lbl">Avg periods / teacher</span></div>
      <div class="load-stat"><span class="num">${agg.rows.reduce((a,r)=>a+r.cov,0)}</span><span class="lbl">Covering periods</span></div>
    </div>
    <div class="tt-scroll"><table class="load-table"><thead><tr><th>Teacher</th><th style="text-align:center;">Days</th><th style="text-align:center;">Own</th><th style="text-align:center;">Covering</th><th style="min-width:140px;">Load</th><th style="text-align:right;">Total</th><th style="text-align:right;">Avg/day</th></tr></thead><tbody>
    ${agg.rows.map(r=>`<tr><td class="load-name">${esc(r.name)}</td><td class="load-daycount">${r.days}</td><td class="load-daycount">${r.reg}</td><td class="load-daycount ${r.cov?'':'zero'}">${r.cov}</td><td>${loadBar(r.total,avg,max)}</td><td style="text-align:right;" class="load-total">${r.total}</td><td style="text-align:right;" class="load-daycount">${r.days?(r.total/r.days).toFixed(1):'0.0'}</td></tr>`).join('')}
    </tbody></table></div>${barLegend()}
    <div class="dl-row"><button class="ghost" onclick="dlWorkloadMonthly('xlsx')">⬇ Monthly · Excel (summary + day-by-day)</button><button class="ghost" onclick="dlWorkloadMonthly('pdf')">⬇ Monthly · PDF</button></div>`;
  }
  return `<div class="panel"><h2 class="panel-title">Workload — monthly record</h2>${wlSubtabs()}
    <div class="row-inline" style="max-width:520px;align-items:flex-end;">
      <div class="field" style="margin:0;"><label>Month</label><input type="month" value="${ym}" onchange="state.wlMonth=this.value||todayStr().slice(0,7); renderAll();"></div>
      <button class="ghost" style="flex:none;" onclick="backfillMonth()" title="Fills any school day up to today that has no stored record">Record missing days</button>
    </div>
    <div style="height:14px"></div>${body}</div>`;
}

/* ---------------- TAB: LEAVE MANAGEMENT ---------------- */
function renderLeaveTab(){
  const isAdmin = state.session.role==='admin';
  const mine = isAdmin ? state.leaveRequests : state.leaveRequests.filter(l=>l.teacherId===state.session.teacherId);
  const pillClass = s => s==='approved'?'pill-accepted':(s==='rejected'?'pill-rejected':'pill-pending');

  return `
  ${!isAdmin ? `
  <div class="panel">
    <h2 class="panel-title">Apply for leave</h2>
    <p class="panel-desc">Submit a leave request — the Admin will approve or reject it. You can never approve your own leave.</p>
    <div class="row-inline" style="align-items:flex-end;flex-wrap:wrap;">
      <div class="field"><label>From</label><input type="date" id="leaveFrom"></div>
      <div class="field"><label>To</label><input type="date" id="leaveTo"></div>
      <div class="field" style="flex:1.4;"><label>Reason</label><input type="text" id="leaveReason" placeholder="Brief reason"></div>
      <button onclick="applyLeave('${state.session.teacherId}', document.getElementById('leaveFrom').value, document.getElementById('leaveTo').value, document.getElementById('leaveReason').value)" style="margin-bottom:12px;">Submit</button>
    </div>
  </div>` : ''}

  <div class="panel">
    <h2 class="panel-title">${isAdmin?'All leave requests':'My leave requests'}</h2>
    ${mine.length===0 ? '<div class="empty-state">No leave requests yet.</div>' :
      mine.slice().reverse().map(l=>`
        <div class="entry-row">
          <div>
            <div class="entry-name">${isAdmin ? (getTeacher(l.teacherId)?getTeacher(l.teacherId).name:'(removed)') : ''} ${l.from} → ${l.to}</div>
            <div class="entry-meta">${esc(l.reason)||'—'}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="pill ${pillClass(l.status)}">${l.status}</span>
            ${isAdmin && l.status==='pending' ? `
              <button class="ghost" onclick="decideLeave('${l.id}','approved')">Approve</button>
              <button class="danger" onclick="decideLeave('${l.id}','rejected')">Reject</button>` : ''}
          </div>
        </div>`).join('')}
  </div>`;
}

/* ---------------- TAB: ATTENDANCE / CHECK-IN ---------------- */
function renderAttendanceTab(){
  if(!state.attendanceDate) state.attendanceDate = todayStr();
  if(!state.atMonth) state.atMonth = state.attendanceDate.slice(0,7);
  ensureAttendance();
  const role = state.session.role, c = state.campus || {}, busy = state.locBusy ? 'disabled' : '';
  const campusSet = c.configured!==undefined ? c.configured : (c.lat!=null && c.lng!=null);
  const msgHtml = `<div id="locStatus" class="${state.locMsg ? (state.locMsg.ok?'log-item':'log-item fail') : ''}" style="${state.locMsg?'margin-top:10px;':''}" role="status" aria-live="polite">${state.locMsg ? esc(state.locMsg.text) : ''}</div>`;
  const insecure = window.isSecureContext ? '' : `<div class="log-item fail" style="margin-bottom:10px;"><strong>This page is not using HTTPS.</strong> Browsers block location on non-secure pages, so check-in will not work. Open the site using its <strong>https://</strong> address.</div>`;
  const campusPanel = role==='admin' ? `
  <div class="panel">
    <h2 class="panel-title">Campus location &amp; radius</h2>
    <p class="panel-desc">Teachers can only check in or out when their phone reports a position inside this radius <em>and</em> is accurate enough. Stand in the middle of the campus, outdoors, and press “Use my current location”, or type coordinates. ${campusSet?'':'<strong style="color:var(--brick)">Not set yet — check-in is blocked until you save a location.</strong>'}</p>
    ${insecure}
    <div class="grid-2" style="gap:16px;">
      <div class="field"><label>Latitude</label><input type="number" step="any" id="campLat" value="${c.lat==null?'':c.lat}"></div>
      <div class="field"><label>Longitude</label><input type="number" step="any" id="campLng" value="${c.lng==null?'':c.lng}"></div>
    </div>
    <div class="grid-2" style="gap:16px;">
      <div class="field"><label>Allowed radius (metres)</label><input type="number" min="20" max="2000" step="1" id="campRad" value="${c.radius==null?150:c.radius}"></div>
      <div class="field"><label>Reject GPS worse than (± metres)</label><input type="number" min="10" max="500" step="1" id="campAcc" value="${c.maxAccuracy==null?100:c.maxAccuracy}"></div>
    </div>
    <button class="ghost" onclick="useHereAsCampus()" ${busy}>⌖ Use my current location</button>
    <button onclick="saveCampus()" style="margin-left:8px;" ${busy}>Save campus location</button>
    <button class="ghost" onclick="testMyLocation()" style="margin-left:8px;" ${busy}>Test this device (saves nothing)</button>
    <div class="hint">Your browser will ask to use this device's location. It is only used for the button you pressed.</div>
    ${msgHtml}
    <p class="sync-note">Phone GPS is typically accurate to 5–20 m outdoors and worse indoors. Choose a radius that covers the whole campus plus about 50 m of margin (150 m is a sensible start). A radius under ~50 m will reject teachers who really are on campus.</p>
  </div>` : '';
  const todayD = todayStr(), mine = ((state.checkins[todayD]||{})[state.session.teacherId]) || {};
  const selfCard = role==='teacher' ? `
  <div class="panel">
    <h2 class="panel-title">My attendance — today, ${todayD}</h2>
    ${insecure}
    <p class="entry-meta">${campusSet ? `You must be within ${c.radius} m of the campus point, with GPS accurate to ±${c.maxAccuracy} m or better.` : 'The Admin has not set the campus location yet.'}</p>
    <p class="entry-meta">In: ${esc(mine.inTime || '—')} &nbsp;·&nbsp; Out: ${esc(mine.outTime || '—')}${mine.manual ? ' &nbsp;·&nbsp; (entered by Admin)' : ''}</p>
    <div class="privacy-note">📍 <strong>Location is requested only when you tap one of these buttons.</strong> It is used once to confirm you are on campus; only the distance is saved, not your exact position. <button type="button" class="linkbtn" onclick="showPrivacy()">What is stored?</button></div>
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">
      <button onclick="markAttendance('in')" ${busy}>Check in</button>
      <button class="ghost" onclick="markAttendance('out')" ${busy}>Check out</button>
      <button class="ghost" onclick="testMyLocation()" ${busy}>Test my location (saves nothing)</button>
    </div>
    ${msgHtml}
    <p class="sync-note">Trouble checking in? Use “Test my location” to see why, or ask the Admin to record your attendance manually.</p>
  </div>` : '';
  const manual = role==='admin' ? `
  <div class="panel">
    <h2 class="panel-title">Record attendance manually</h2>
    <p class="panel-desc">For a teacher whose phone can't give a location (GPS off, flat battery, old phone). A reason is required; the entry is marked “manual” and written to the security log.</p>
    <div class="grid-2" style="gap:16px;">
      <div class="field"><label>Teacher</label><select id="manTeacher">${state.teachers.map(t=>`<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}</select></div>
      <div class="field"><label>Date</label><input type="date" id="manDate" value="${todayStr()}" max="${todayStr()}"></div>
    </div>
    <div class="grid-2" style="gap:16px;">
      <div class="field"><label>Check-in time</label><input type="time" id="manIn"></div>
      <div class="field"><label>Check-out time</label><input type="time" id="manOut"></div>
    </div>
    <div class="field"><label>Reason</label><input type="text" id="manNote" maxlength="200" placeholder="e.g. phone GPS not working"></div>
    <button onclick="saveManualAttendance()">Save entry</button>
    <div class="hint" id="manMsg"></div>
  </div>` : '';
  return campusPanel + selfCard + renderAttendanceRecords(role) + manual;
}
async function saveManualAttendance(){
  const body = {teacherId:val('manTeacher'), date:val('manDate'), inTime:val('manIn'), outTime:val('manOut'), note:val('manNote')};
  const msg = document.getElementById('manMsg');
  try{
    await api('POST','/api/attendance/manual', body);
    await loadAttendanceMonth(body.date.slice(0,7));
    renderAll();
    const m2 = document.getElementById('manMsg'); if(m2) m2.textContent = 'Saved.';
  }catch(e){ if(msg) msg.textContent = e.message; }
}

/* ---- attendance records (daily / monthly) ---- */
function atStatus(tid, date){
  const rec = (state.checkins[date]||{})[tid];
  if(rec && (rec.inTime || rec.outTime)) return 'P';
  const onLeave = (state.leaveRequests||[]).some(l=>l.teacherId===tid && l.status==='approved' && l.from<=date && date<=l.to);
  if(onLeave) return 'L';
  if(!activeDays().includes(dayNameOf(date))) return 'H';
  if(date>todayStr()) return '';
  return 'A';
}
function hoursBetween(a,b){
  if(!a||!b) return '';
  const [h1,m1]=a.split(':').map(Number), [h2,m2]=b.split(':').map(Number), d=(h2*60+m2)-(h1*60+m1);
  return d>0 ? (d/60).toFixed(1) : '';
}
function atTeachers(role){
  return role==='teacher' ? state.teachers.filter(t=>t.id===state.session.teacherId) : state.teachers;
}
const ST_NAME = {P:'Present', A:'Absent', L:'On leave', H:'Holiday / off', '':'—'};
function atDailyData(date, role){
  return atTeachers(role).map(t=>{ const r=(state.checkins[date]||{})[t.id]||{};
    return {name:t.name, status:atStatus(t.id,date), inTime:r.inTime||'', outTime:r.outTime||'', hours:hoursBetween(r.inTime,r.outTime), dist:r.inLoc?r.inLoc.dist:'', manual:!!r.manual}; });
}
function atMonthlyData(ym, role){
  const dates = monthDates(ym);
  return {dates, rows: atTeachers(role).map(t=>{
    const cells = dates.map(d=>atStatus(t.id,d));
    const P = cells.filter(c=>c==='P').length, A = cells.filter(c=>c==='A').length, L = cells.filter(c=>c==='L').length;
    let hrs = 0; dates.forEach(d=>{ const r=(state.checkins[d]||{})[t.id]; const h=r?parseFloat(hoursBetween(r.inTime,r.outTime)):NaN; if(!isNaN(h)) hrs+=h; });
    const work = P+A; // school days that count
    return {name:t.name, cells, P, A, L, hrs:hrs.toFixed(1), pct: work? Math.round(P/work*100):0};
  })};
}
function dlAttDaily(fmt){
  const date = state.attendanceDate, rows = atDailyData(date, state.session.role);
  if(!rows.length){ alert('No staff to export.'); return; }
  const head = ['Teacher','Status','Check-in','Check-out','Hours','Distance (m)'];
  const body = rows.map(r=>[r.name, ST_NAME[r.status], r.inTime, r.outTime, r.hours, r.dist]);
  const sub = dayNameOf(date)+' '+fmtDate(date);
  if(fmt==='xlsx') xlsxDownload('attendance-daily-'+date+'.xlsx',[{name:'Daily attendance', aoa:[['Staff attendance — '+sub],[],head,...body], cols:[26,14,10,10,8,12]}]);
  else pdfDownload('attendance-daily-'+date+'.pdf','Staff attendance', sub, head, body, false);
}
function dlAttMonthly(fmt){
  const ym = state.atMonth, m = atMonthlyData(ym, state.session.role);
  if(!m.rows.length){ alert('No staff to export.'); return; }
  const head = ['Teacher',...m.dates.map(d=>String(+d.slice(8))),'P','A','L','%'];
  const body = m.rows.map(r=>[r.name, ...r.cells.map(c=>c==='H'?'-':c), r.P, r.A, r.L, r.pct+'%']);
  const sub = monthLabel(ym)+'  ·  P = present, A = absent, L = leave, - = off';
  if(fmt==='xlsx'){
    const sumHead = ['Teacher','Present','Absent','Leave','Hours worked','Attendance %'];
    const sumBody = m.rows.map(r=>[r.name, r.P, r.A, r.L, r.hrs, r.pct+'%']);
    xlsxDownload('attendance-monthly-'+ym+'.xlsx',[
      {name:'Summary', aoa:[['Monthly attendance — '+monthLabel(ym)],[],sumHead,...sumBody], cols:[26,10,10,10,14,14]},
      {name:'Day by day', aoa:[['Attendance by day — '+sub],[],head,...body], cols:[26,...m.dates.map(()=>4),5,5,5,7]}
    ]);
  } else pdfDownload('attendance-monthly-'+ym+'.pdf','Monthly staff attendance', sub, head, body, true);
}
function renderAttendanceRecords(role){
  if(role==='teacher' && !state.session.teacherId) return '';
  if(!attendanceMonths().every(ym=>attReady[ym])) return `<div class="panel"><h2 class="panel-title">${role==='teacher'?'My attendance record':'Staff attendance record'}</h2><div class="empty-state">Loading attendance…</div></div>`;
  if(!state.atMonth) state.atMonth = (state.attendanceDate||todayStr()).slice(0,7);
  const date = state.attendanceDate, v = state.atView;
  const b = (id,l)=>`<button class="subtab ${v===id?'on':''}" onclick="state.atView='${id}'; renderAll();">${l}</button>`;
  let body = '';
  if(state.teachers.length===0) body = '<div class="empty-state">No teachers added yet.</div>';
  else if(v==='daily'){
    const rows = atDailyData(date, role);
    const pill = s=>`<span class="entry-meta st-${s||'H'}" style="padding:2px 8px;border-radius:10px;">${ST_NAME[s]}</span>`;
    body = `<div class="field" style="max-width:200px;"><label>Date (${dayNameOf(date)})</label>
      <input type="date" value="${date}" onchange="state.attendanceDate=this.value||todayStr(); state.atMonth=state.attendanceDate.slice(0,7); renderAll();"></div>
      ${rows.map(r=>`<div class="entry-row"><div class="entry-name">${esc(r.name)}</div>
        <div class="entry-meta">${pill(r.status)} &nbsp; In: ${r.inTime||'—'}${r.dist!==''?' ('+r.dist+' m)':''} · Out: ${r.outTime||'—'}${r.hours?' · '+r.hours+' h':''}${r.manual?' · manual entry':''}</div></div>`).join('')}
      <div class="dl-row"><button class="ghost" onclick="dlAttDaily('xlsx')">⬇ Daily · Excel</button><button class="ghost" onclick="dlAttDaily('pdf')">⬇ Daily · PDF</button></div>`;
  } else {
    const ym = state.atMonth, m = atMonthlyData(ym, role);
    body = `<div class="field" style="max-width:200px;"><label>Month</label>
      <input type="month" value="${ym}" onchange="state.atMonth=this.value||todayStr().slice(0,7); renderAll();"></div>
      <div class="mx-scroll"><table class="mx"><thead><tr><th class="nm">Teacher</th>
        ${m.dates.map(d=>`<th title="${dayNameOf(d)}">${+d.slice(8)}<br><span style="font-weight:400;color:#8a8f84">${dayNameOf(d)[0]}</span></th>`).join('')}
        <th>P</th><th>A</th><th>L</th><th>%</th></tr></thead><tbody>
        ${m.rows.map(r=>`<tr><td class="nm">${esc(r.name)}</td>${r.cells.map(c=>`<td class="st-${c||'H'}">${c==='H'?'·':c}</td>`).join('')}<td><b>${r.P}</b></td><td>${r.A}</td><td>${r.L}</td><td><b>${r.pct}%</b></td></tr>`).join('')}
      </tbody></table></div>
      <div class="legend"><span><i style="background:#dde8dc"></i>P present</span><span><i style="background:#f3ddd6"></i>A absent (no check-in)</span><span><i style="background:#e8d5a8"></i>L approved leave</span><span>· non-school day</span></div>
      <div class="dl-row"><button class="ghost" onclick="dlAttMonthly('xlsx')">⬇ Monthly · Excel (summary + day-by-day)</button><button class="ghost" onclick="dlAttMonthly('pdf')">⬇ Monthly · PDF</button></div>`;
  }
  return `<div class="panel"><h2 class="panel-title">${role==='teacher'?'My attendance record':'Staff attendance record'}</h2>
    <div class="subtabs">${b('daily','Daily')}${b('monthly','Monthly')}</div>${body}
    <p class="sync-note">Records are kept for ${state.policy.retentionDays} days and then deleted automatically.</p></div>`;
}

/* ---------------- TAB: MY SUBSTITUTIONS (teacher accept/reject) ---------------- */
function renderMySubsTab(){
  const reqs = mySubRequests(state.session.teacherId);
  const pillClass = s => s==='accepted'?'pill-accepted':(s==='rejected'?'pill-rejected':'pill-pending');
  return `
  <div class="panel">
    <h2 class="panel-title">My substitution requests</h2>
    <p class="panel-desc">These are classes you've been assigned to cover because another teacher is absent. Accept or reject — the Admin can still reassign if needed.</p>
    ${reqs.length===0 ? '<div class="empty-state">No substitution requests right now.</div>' :
      reqs.map(r=>`
        <div class="entry-row">
          <div>
            <div class="entry-name">${getClass(r.classId)?getClass(r.classId).name:'(class)'} · ${r.day} · ${r.subject}</div>
            <div class="entry-meta">Covering for ${getTeacher(r.originalTeacherId)?getTeacher(r.originalTeacherId).name:'—'}</div>
          </div>
          <div style="display:flex;gap:8px;align-items:center;">
            <span class="pill ${pillClass(r.status)}">${r.status}</span>
            ${r.status==='pending' ? `
              <button onclick="respondToSub('${r.day}','${r.classId}','${r.periodId}','accepted')">Accept</button>
              <button class="danger" onclick="respondToSub('${r.day}','${r.classId}','${r.periodId}','rejected')">Reject</button>` : ''}
          </div>
        </div>`).join('')}
  </div>`;
}

/* ---------------- TAB: NOTIFICATIONS ---------------- */
function renderNotifyTab(){
  const isAdmin = state.session.role==='admin';
  const withPhone = state.teachers.filter(t=>t.phone).length;
  return `
  ${isAdmin ? `
  <div class="panel">
    <h2 class="panel-title">Send an announcement</h2>
    <div class="row-inline" style="flex-wrap:wrap;">
      <div class="field" style="flex:1;min-width:220px;"><input type="text" id="notifyText" placeholder="e.g. PTM rescheduled to Friday"></div>
      <button onclick="const t=document.getElementById('notifyText').value; const s=document.getElementById('notifySms').checked; addNotification(t, s); document.getElementById('notifyText').value='';" style="margin-bottom:12px;">Send</button>
    </div>
    <label style="display:flex;align-items:center;gap:6px;text-transform:none;font-family:'Inter',sans-serif;font-size:12.5px;font-weight:400;letter-spacing:0;">
      <input type="checkbox" id="notifySms" style="width:auto;"> Also send as SMS to the ${withPhone} teacher${withPhone===1?'':'s'} with a phone number on file
    </label>
    <p class="sync-note">SMS delivery needs a connected SMS provider (e.g. Twilio) — until one's connected, SMS sends are queued here rather than actually delivered.</p>
  </div>` : ''}
  <div class="panel">
    <h2 class="panel-title">Announcements</h2>
    ${state.notifications.length===0 ? '<div class="empty-state">No announcements yet.</div>' :
      state.notifications.map(n=>`
        <div class="notif-item">
          <div class="notif-date">${n.date}</div>
          <div>${esc(n.text)}</div>
          ${n.sms ? `<div class="cred-line">📱 Queued for SMS to ${n.smsCount} teacher${n.smsCount===1?'':'s'}</div>` : ''}
          ${isAdmin ? `<button class="iconbtn" style="float:right;margin-top:-22px;" onclick="removeNotification('${n.id}')">✕</button>` : ''}
        </div>`).join('')}
  </div>`;
}

/* ---------------- PDF DOWNLOAD (print-to-PDF) ---------------- */
function fitAndPrint(cls, sel){
  const el = document.querySelector(sel); if(!el) return;
  const o = pdfOrient(), m = 8, k = 96/25.4;
  const aw = ((o==='portrait'?210:297)-2*m)*k*0.98, ah = ((o==='portrait'?297:210)-2*m)*k*0.96;
  let st = document.getElementById('dynPage');
  if(!st){ st = document.createElement('style'); st.id='dynPage'; document.head.appendChild(st); }
  st.textContent = `@page{size:A4 ${o};margin:${m}mm}`;
  document.body.classList.add(cls,'print-measure'); el.classList.add('pm');
  el.style.zoom = 1; el.style.width = aw+'px';
  const h = el.scrollHeight, z = Math.min(1, ah/h);
  el.style.zoom = z; el.style.width = (aw/z)+'px';
  document.body.classList.remove('print-measure');
  window.print();
}
function printClassTimetable(){
  if(state.viewEdit){ state.viewEdit=false; state._restoreEdit=true; renderAll(); }   // print the plain timetable, not the edit boxes
  fitAndPrint('print-class','.print-target-class');
}
function printTeacherSchedule(){ fitAndPrint('print-teacher','.print-target-teacher'); }
function printAllTeachers(){ fitAndPrint('print-all','.print-target-allteachers'); }
window.onafterprint = function(){
  if(state._restoreEdit){ state._restoreEdit=false; state.viewEdit=true; renderAll(); }
  document.body.classList.remove('print-class','print-teacher','print-all','print-measure');
  document.querySelectorAll('.pm').forEach(e=>{ e.classList.remove('pm'); e.style.zoom=''; e.style.width=''; });
};

function attachDynamicHandlers(){ /* reserved for future delegated listeners */ }

boot();
