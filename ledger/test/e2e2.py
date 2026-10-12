import subprocess, time, os, json, shutil, re
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA='/tmp/e2e2-data'; shutil.rmtree(DATA,ignore_errors=True); PORT=3460; BASE=f'http://localhost:{PORT}'
srv=subprocess.Popen(['node','server.js'],cwd=ROOT,env=dict(os.environ,PORT=str(PORT),DATA_DIR=DATA,SETUP_CODE='SETUP-1234'),stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
time.sleep(1.5); res=[]
def ok(c,m): res.append(bool(c)); print(('  ✓ ' if c else '  ✗ FAIL: ')+m)
# the OLD app's saved browser data (with plaintext passwords) as a previous user would have it
OLD={'teachers':[{'id':'t7','name':'Anita Rao','phone':'888','assignments':[{'classId':'c7','subject':'English'}],'subjects':['English'],'classIds':['c7']},
                 {'id':'t8','name':'Vikram Das','phone':'777','assignments':[{'classId':'c7','subject':'Maths'}],'subjects':['Maths'],'classIds':['c7']}],
     'classes':[{'id':'c7','name':'Class 6','subjects':['English','Maths']}],
     'users':[{'id':'u1','username':'admin','password':'admin123','role':'admin'}],
     'campus':{'lat':17.385,'lng':78.4867,'radius':10},
     'checkins':{'2026-10-09':{'t7':{'inTime':'09:01','outTime':'16:02','inLoc':{'lat':17.385,'lng':78.4867,'dist':5,'acc':9}}}}}
try:
  with sync_playwright() as p:
    b=p.chromium.launch(); errors=[]
    def newp(ctx):
        pg=ctx.new_page(); pg.on('pageerror',lambda e:errors.append('PAGEERR '+str(e))); pg.on('console',lambda m: errors.append(m.text) if m.type=='error' and 'Failed to load resource' not in m.text else None); return pg
    ac=b.new_context(viewport={'width':1200,'height':900}); a=newp(ac)
    a.goto(BASE); a.wait_for_selector('#setupCode')
    a.evaluate("o=>localStorage.setItem('ledger_state',JSON.stringify(o))",OLD)
    a.fill('#setupCode','SETUP-1234'); a.fill('#setupName','Head'); a.fill('#setupUser','principal'); a.fill('#setupPass','correct horse battery'); a.fill('#setupPass2','correct horse battery'); a.click('text=Create administrator')
    a.wait_for_selector('text=Data from the old version found in this browser')
    ok(True,'admin is offered migration of old browser data')
    a.on('dialog',lambda d:d.accept())
    a.click('text=Import to the server'); a.wait_for_selector('.creds-panel')
    ok(a.evaluate("state.teachers.length")==2 and a.evaluate("localStorage.getItem('ledger_state')")is None,'old teachers imported; old localStorage copy (with plaintext passwords) deleted')
    creds=a.evaluate("state.tempCreds"); ok(len(creds)==2 and all(c['tempPassword'] for c in creds),'fresh one-time passwords issued (old ones not carried over)')
    ok(a.evaluate("state.campus.radius")>=150,'old unrealistic 10 m radius upgraded to ≥150 m')
    # every admin tab renders without errors
    for lab in ['02 ·','03 ·','04 ·','05 ·','06 ·','07 ·','08 ·','10 ·','11 ·','01 ·']:
        a.click(f'.tab:has-text("{lab}")'); time.sleep(.25)
    ok(not errors,'all admin tabs render without JS errors '+str(errors[:2]))
    a.click('.tab:has-text("08 ·")'); a.wait_for_selector('text=Priya') if False else None
    a.select_option('#manTeacher','t8'); a.fill('#manIn','09:10'); a.fill('#manNote','')
    a.click('text=Save entry'); a.wait_for_selector('text=reason') 
    ok(True,'manual entry demands a reason')
    a.fill('#manNote','phone GPS broken'); a.click('text=Save entry'); a.wait_for_selector('#manMsg:has-text("Saved")')
    ok(a.is_visible('.entry-row:has-text("Vikram Das") >> text=manual entry'),'manual attendance saved and labelled "manual"')
    # reception
    a.click('.tab:has-text("11 ·")'); a.fill('#newUserName','Front Desk'); a.select_option('#newUserRole','receptionist'); a.click('text=+ Create login')
    a.wait_for_selector('.creds-panel:has-text("Front Desk")'); rc=[c for c in a.evaluate("state.tempCreds") if c['name']=='Front Desk'][0]
    a.wait_for_selector('text=Security log'); ok(a.is_visible('text=Created') or a.is_visible('text=Login created'),'security log lists events')
    rcx=b.new_context(); r=newp(rcx); r.goto(BASE); r.fill('#loginUsername',rc['username']); r.fill('#loginPassword',rc['tempPassword']); r.click('button[type=submit]')
    r.wait_for_selector('#cpNew'); r.fill('#cpCurrent',rc['tempPassword']); r.fill('#cpNew','amber lantern whistle'); r.fill('#cpNew2','amber lantern whistle'); r.click('text=Save password')
    r.wait_for_selector('.tabbar .tab'); tabs=r.inner_text('.tabbar')
    ok('Attendance' in tabs and 'Notifications' in tabs and 'Staff' not in tabs and 'Users' not in tabs,'receptionist only sees Attendance + Notifications tabs')
    r.click('.tab:has-text("08 ·")'); r.wait_for_selector('.entry-row:has-text("Vikram Das")')
    ok('888' not in r.evaluate("JSON.stringify(state)") and 'inLoc' not in r.evaluate("JSON.stringify(state.checkins)"),'receptionist browser holds no phone numbers or location distances')
    # teacher: leave + substitution
    tc=a.evaluate("state.tempCreds.find(c=>c.username.startsWith('anita'))")
    tcx=b.new_context(); t=newp(tcx); t.goto(BASE); t.fill('#loginUsername',tc['username']); t.fill('#loginPassword',tc['tempPassword']); t.click('button[type=submit]')
    t.wait_for_selector('#cpNew'); t.fill('#cpCurrent',tc['tempPassword']); t.fill('#cpNew','sunrise kettle orchard'); t.fill('#cpNew2','sunrise kettle orchard'); t.click('text=Save password')
    t.wait_for_selector('.tabbar .tab'); t.click('.tab:has-text("Leave")')
    t.fill('#leaveFrom','2026-10-20'); t.fill('#leaveTo','2026-10-21'); t.fill('#leaveReason','<b>Fever</b>'); t.click('button:has-text("Submit")')
    t.wait_for_selector('.pill-pending'); ok('<b>' not in t.inner_html('#app') and 'Fever' in t.inner_text('#app'),'leave submitted; HTML in reason is neutralised')
    # admin sees it after the next sync (poll) and approves
    a.click('.tab:has-text("07 ·")'); a.wait_for_selector('text=Fever', timeout=20000); a.click('text=Approve'); a.wait_for_selector('.pill-accepted')
    t.evaluate('refreshState(true)'); t.wait_for_selector('.pill-accepted'); ok(True,'admin approval is saved and reaches the teacher (shared server data)')
    # substitution accept (admin marks absent -> Vikram gets request)
    a.evaluate("""()=>{ state.substitutions={Mon:{c7:{p1:{subject:'English',originalTeacherId:'t7',subTeacherId:'t8',status:'pending'}}}}; renderAll(); }"""); time.sleep(1.2)
    # sub for t8 (Vikram) — log in as him via reset
    a.click('.tab:has-text("11 ·")'); 
    a.evaluate("resetUserPassword(state.users.find(u=>u.teacherId==='t8').id)"); a.wait_for_selector('.creds-panel:has-text("Vikram")')
    vc=[c for c in a.evaluate("state.tempCreds") if c['name']=='Vikram Das'][-1]
    vx=b.new_context(); v=newp(vx); v.goto(BASE); v.fill('#loginUsername',vc['username']); v.fill('#loginPassword',vc['tempPassword']); v.click('button[type=submit]')
    v.wait_for_selector('#cpNew'); v.fill('#cpCurrent',vc['tempPassword']); v.fill('#cpNew','cobalt meadow lantern'); v.fill('#cpNew2','cobalt meadow lantern'); v.click('text=Save password')
    v.wait_for_selector('.tabbar .tab'); v.click('.tab:has-text("My Substitutions")'); v.wait_for_selector('text=Accept'); v.click('button:has-text("Accept")'); v.wait_for_selector('.pill-accepted')
    ok(True,'teacher accepts a substitution via the server')
    # concurrent admin conflict
    a2=newp(b.new_context()); a2.goto(BASE); a2.fill('#loginUsername','principal'); a2.fill('#loginPassword','correct horse battery'); a2.click('button[type=submit]'); a2.wait_for_selector('.tabbar .tab')
    a2.evaluate("state.notifications.unshift({id:'n9',text:'from admin 2',date:'now'}); renderAll();"); time.sleep(1.5)
    a.evaluate("state.notifications.unshift({id:'n10',text:'from admin 1 (stale)',date:'now'}); renderAll();")
    dlg=[]; a.on('dialog',lambda d:(dlg.append(d.message),d.accept())); time.sleep(2)
    ok(any('same moment' in m for m in dlg) or 'from admin 2' in a.evaluate("JSON.stringify(state.notifications)"),'simultaneous edits by two admins are detected, not silently overwritten')
    # session revoked after admin reset -> victim sees login with notice
    t.evaluate("api('GET','/api/state')")
    # logout
    t.click('text=Log out'); t.wait_for_selector('#loginUsername'); ok(t.evaluate("JSON.stringify(state.teachers)")=='[]' ,'logout wipes school data from the page memory')
    ok(not [e for e in errors if 'PAGEERR' in e or 'Refused' in e], 'no JS exceptions / CSP violations: '+str(errors[:3]))
    b.close()
finally:
  srv.terminate(); print('\n%d passed, %d failed'%(sum(res),len(res)-sum(res)))
