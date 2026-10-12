import subprocess, time, os, json, shutil, sys, re
from playwright.sync_api import sync_playwright
ROOT=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA='/tmp/e2e-data'; shutil.rmtree(DATA,ignore_errors=True)
PORT=3443
env=dict(os.environ, NODE_ENV='production', PORT=str(PORT), DATA_DIR=DATA, SETUP_CODE='SETUP-1234', TLS_KEY='/tmp/tls/k.pem', TLS_CERT='/tmp/tls/c.pem')
srv=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
time.sleep(1.8)
BASE=f'https://localhost:{PORT}'
res=[]; 
def ok(c,m): res.append(bool(c)); print(('  ✓ ' if c else '  ✗ FAIL: ')+m)
CAMPUS=(17.385, 78.4867)
try:
  with sync_playwright() as p:
    b=p.chromium.launch(args=['--host-resolver-rules=MAP insecure.test 127.0.0.1'])
    def ctx(**kw):
        kw.setdefault('viewport',{'width':1100,'height':900}); return b.new_context(ignore_https_errors=True, **kw)
    errors=[]; hosts=set()
    def watch(page):
        page.on('console', lambda m: errors.append(m.text) if m.type=='error' else None)
        page.on('pageerror', lambda e: errors.append('PAGEERR '+str(e)))
        page.on('request', lambda r: hosts.add(re.sub(r'^(\w+://[^/]+).*',r'\1',r.url)))
    # ---------- admin
    ac=ctx(); a=ac.new_page(); watch(a)
    r=a.goto(BASE); 
    ok(r.headers.get('strict-transport-security'),'HSTS header sent over HTTPS')
    a.wait_for_selector('text=create the administrator account')
    ok(True,'fresh install shows first-run setup screen (no default login)')
    a.fill('#setupCode','wrong'); a.fill('#setupName','Head Teacher'); a.fill('#setupUser','principal'); a.fill('#setupPass','correct horse battery'); a.fill('#setupPass2','correct horse battery')
    a.click('text=Create administrator'); a.wait_for_selector('.login-err')
    ok('setup code' in a.inner_text('.login-err').lower(),'wrong setup code is refused with a clear message')
    a.fill('#setupCode','setup-1234'); a.fill('#setupPass','correct horse battery'); a.fill('#setupPass2','correct horse battery')
    ok(a.input_value('#setupName')=='Head Teacher','form keeps name/username after an error (passwords are cleared)')
    a.click('text=Create administrator')
    a.wait_for_selector('.tabbar .tab'); ok(True,'admin created and signed in')
    cookies=ac.cookies(); sid=[c for c in cookies if 'ledger_sid' in c['name']][0]
    ok(sid['name'].startswith('__Host-') and sid['secure'] and sid['httpOnly'] and sid['sameSite']=='Strict','session cookie: __Host- prefix, Secure, HttpOnly, SameSite=Strict')
    ok(a.evaluate('window.isSecureContext'),'page is a secure context (geolocation allowed)')
    ok(a.evaluate("Object.keys(localStorage).length")==0,'nothing stored in localStorage')
    # add a class + teacher through the app's own state, then let autosave run
    a.evaluate("""()=>{ state.classes.push({id:'c1',name:'Class 5',subjects:['Maths']});
      state.teachers.push({id:'t1',name:'Priya Sharma',phone:'9999900001',assignments:[{classId:'c1',subject:'Maths'}],subjects:['Maths'],classIds:['c1']}); renderAll(); }""")
    a.wait_for_selector('.creds-panel', timeout=8000)
    creds=a.evaluate("state.tempCreds")
    ok(len(creds)==1 and creds[0]['username']=='priyasharma','teacher login auto-created, temp password shown once to admin')
    tmp=creds[0]['tempPassword']
    a.screenshot(path='/tmp/shot_admin_setup.png')
    # campus via Attendance tab
    a.click('text=08 · Attendance'); a.wait_for_selector('#campLat')
    a.fill('#campLat',str(CAMPUS[0])); a.fill('#campLng',str(CAMPUS[1])); a.fill('#campRad','120'); a.fill('#campAcc','60')
    a.click('text=Save campus location'); a.wait_for_selector('text=Campus location saved')
    ok(True,'admin saved campus (server-validated)')
    a.screenshot(path='/tmp/shot_admin_attendance.png', full_page=True)
    # ---------- teacher on a phone-sized screen
    tc=ctx(viewport={'width':390,'height':800}, permissions=['geolocation'], geolocation={'latitude':CAMPUS[0],'longitude':CAMPUS[1],'accuracy':12}); t=tc.new_page(); watch(t)
    t.goto(BASE); t.wait_for_selector('#loginUsername')
    t.fill('#loginUsername','priyasharma'); t.fill('#loginPassword','wrong-password'); t.click('button[type=submit]'); t.wait_for_selector('.login-err')
    ok('Incorrect' in t.inner_text('.login-err'),'wrong password shows a generic error')
    t.fill('#loginPassword',tmp); t.click('button[type=submit]'); t.wait_for_selector('#cpNew')
    ok('Choose your own password' in t.inner_text('h2'),'temporary password forces a change before anything else')
    t.fill('#cpCurrent',tmp); t.fill('#cpNew','priya123456'); t.fill('#cpNew2','priya123456'); t.click('text=Save password'); t.wait_for_selector('.login-err')
    ok('name' in t.inner_text('.login-err'),'weak password containing the name is refused')
    t.fill('#cpCurrent',tmp); t.fill('#cpNew','violet tractor monsoon'); t.fill('#cpNew2','violet tractor monsoon'); t.click('text=Save password')
    t.wait_for_selector('.tabbar .tab'); ok(True,'teacher chose own password and is in')
    st=t.evaluate("JSON.stringify(state)")
    ok('9999900001' not in st and 'scrypt' not in st,"teacher's browser memory holds no phone numbers or hashes")
    t.click('text=08 · Attendance'); t.wait_for_selector('text=Location is requested only when')
    t.click('text=Check in')
    t.wait_for_selector('text=Before your browser asks for your location')
    ok('Who can see it' in t.inner_text('.modal') or 'who can see it' in t.inner_text('.modal').lower(),'plain-language location explanation shown BEFORE the permission prompt')
    t.screenshot(path='/tmp/shot_consent.png')
    t.click('text=I understand — continue'); t.wait_for_selector('text=Checked in at', timeout=15000)
    msg=t.inner_text('#locStatus'); ok('m from the campus point' in msg,'check-in on campus accepted: '+msg)
    t.screenshot(path='/tmp/shot_teacher_checkin.png', full_page=True)
    # outside
    tc.set_geolocation({'latitude':CAMPUS[0]+0.02,'longitude':CAMPUS[1],'accuracy':10})
    t.click('text=Check out'); t.wait_for_selector('#locStatus.fail', timeout=15000)
    ok('must be within' in t.inner_text('#locStatus'),'check-out from ~2 km away refused: '+t.inner_text('#locStatus')[:70])
    # poor accuracy: best reading never gets good enough
    tc.set_geolocation({'latitude':CAMPUS[0],'longitude':CAMPUS[1],'accuracy':300})
    t.click('text=Check out'); t.wait_for_selector('#locStatus.fail', timeout=30000)
    ok('accurate to' in t.inner_text('#locStatus'),'GPS ±300 m refused with advice: '+t.inner_text('#locStatus')[:60])
    # dry run
    tc.set_geolocation({'latitude':CAMPUS[0],'longitude':CAMPUS[1],'accuracy':8})
    t.click('text=Test my location'); t.wait_for_selector('text=Nothing was saved', timeout=15000)
    ok('WOULD BE ACCEPTED' in t.inner_text('#locStatus'),'"Test my location" diagnostic works: '+t.inner_text('#locStatus')[:110])
    # tampering from the browser console must not work
    r=t.evaluate("""async()=>{ const x=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({changes:{teachers:{value:[],baseRev:0}}})}); return x.status; }""")
    ok(r==403,'teacher cannot overwrite school data from the console (HTTP %s)'%r)
    # permission denied path
    dc=ctx(viewport={'width':390,'height':800}); d=dc.new_page(); watch(d)  # no geolocation permission granted -> prompt auto-denied in headless
    # admin sees the check-in with distance
    a.reload(); a.wait_for_selector('.tabbar .tab'); a.click('text=08 · Attendance'); a.wait_for_selector('.entry-row:has-text("Priya Sharma") >> text=Present')
    row=a.inner_text('.entry-row:has-text("Priya Sharma")'); ok('In:' in row and re.search(r'\(\d+ m\)',row),'admin sees time + distance: '+row.replace('\n',' | ')[:90])
    errors=[e for e in errors if 'Failed to load resource' not in e]   # expected 4xx from the negative tests above
    ok(len(errors)==0,'no console/page errors: '+('; '.join(errors)[:300] if errors else 'clean'))
    ext=[h for h in hosts if 'localhost' not in h and not h.startswith('data')]
    ok(not ext,'no requests to third-party hosts: '+str(sorted(hosts)))
    b.close()
finally:
  srv.terminate()
  print('\n%d passed, %d failed'%(sum(res),len(res)-sum(res)))
  if not all(res): print(srv.stdout.read()[-1500:])
