// API-level security + behaviour tests. Run: node test/api.test.js  (starts its own server)
const { spawn } = require('child_process');
const path = require('path'), fs = require('fs'), os = require('os');
const PORT = 3200 + Math.floor(Math.random() * 500), BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗ FAIL:', m); } };

class Client {
  constructor(){ this.cookie = ''; this.csrf = ''; }
  async req(method, url, body, opts = {}){
    const headers = { 'Content-Type': 'application/json' };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrf && !opts.noCsrf) headers['X-CSRF-Token'] = this.csrf;
    if (opts.origin) headers.Origin = opts.origin;
    const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = r.headers.get('set-cookie'); if (sc) this.cookie = sc.split(';')[0];
    let j = null; try { j = await r.json(); } catch (e) {}
    if (j && j.csrf) this.csrf = j.csrf;
    return { status: r.status, body: j, headers: r.headers };
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const srv = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT, DATA_DIR: DATA, SETUP_CODE: 'ABCD-1234', SCHOOL_TZ: 'Asia/Kolkata' } });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  await sleep(1500);
  try {
    const admin = new Client();
    console.log('Setup & default credentials');
    let r = await admin.req('POST', '/api/login', { username: 'admin', password: 'admin123' });
    ok(r.status === 401, 'admin/admin123 does NOT work');
    r = await admin.req('POST', '/api/login', { username: 'reception', password: 'reception123' });
    ok(r.status === 401, 'reception/reception123 does NOT work');
    r = await admin.req('GET', '/api/bootstrap'); ok(r.body.needsSetup === true, 'fresh install needs setup');
    r = await admin.req('POST', '/api/setup', { code: 'WRONG-CODE', name: 'Head', username: 'head', password: 'a-long-good-pass' });
    ok(r.status === 403, 'setup refuses a wrong setup code');
    r = await admin.req('POST', '/api/setup', { code: 'ABCD-1234', name: 'Head', username: 'head', password: 'admin12345' });
    ok(r.status === 400, 'setup rejects a weak/common password');
    r = await admin.req('POST', '/api/setup', { code: 'abcd-1234', name: 'Head', username: 'head', password: 'correct horse battery' });
    ok(r.status === 200 && r.body.user.role === 'admin', 'setup with correct code creates admin');
    r = await new Client().req('POST', '/api/setup', { code: 'ABCD-1234', name: 'X', username: 'evil', password: 'correct horse battery' });
    ok(r.status === 409, 'setup cannot be run a second time');

    console.log('Passwords are hashed, never stored/sent in clear');
    const Database = require('better-sqlite3'); const peek = new Database(path.join(DATA, 'ledger.db'), { readonly: true });
    const row = peek.prepare('SELECT pw_hash FROM users WHERE username=?').get('head');
    ok(/^scrypt\$/.test(row.pw_hash) && !row.pw_hash.includes('correct horse'), 'stored as salted scrypt hash');
    r = await admin.req('GET', '/api/state'); ok(!JSON.stringify(r.body).includes('scrypt$') && !/"password"/.test(JSON.stringify(r.body)), 'state payload has no hashes/passwords');

    console.log('Cookie flags / headers');
    r = await new Client().req('POST', '/api/login', { username: 'head', password: 'correct horse battery' });
    const rawCookie = r.headers.get('set-cookie');
    ok(/HttpOnly/i.test(rawCookie) && /SameSite=Strict/i.test(rawCookie), 'session cookie is HttpOnly + SameSite=Strict');
    ok(/geolocation=\(self\)/.test(r.headers.get('permissions-policy')), 'Permissions-Policy limits geolocation to this site');

    console.log('CSRF / origin');
    r = await admin.req('PUT', '/api/state', { changes: { days: { value: [], baseRev: 0 } } }, { noCsrf: true });
    ok(r.status === 403, 'state-changing call without CSRF token is refused');
    r = await admin.req('PUT', '/api/state', { changes: {} }, { origin: 'https://evil.example' });
    ok(r.status === 403, 'cross-origin request is refused');

    console.log('Campus + teacher provisioning');
    r = await admin.req('PUT', '/api/state', { changes: { campus: { value: { lat: 17.385, lng: 78.4867, radius: 100, maxAccuracy: 50 }, baseRev: 0 } } });
    ok(r.status === 200, 'admin sets campus');
    r = await admin.req('PUT', '/api/state', { changes: { campus: { value: { lat: 95, lng: 0, radius: 100, maxAccuracy: 50 }, baseRev: 1 } } });
    ok(r.status === 400, 'invalid latitude rejected');
    const teachers = [{ id: 't1', name: 'Priya Sharma', phone: '9999900001', assignments: [], subjects: ['Maths'], classIds: [] },
                      { id: 't2', name: 'Ravi Kumar', phone: '9999900002', assignments: [], subjects: [], classIds: [] }];
    r = await admin.req('PUT', '/api/state', { changes: { teachers: { value: teachers, baseRev: 0 }, notifications: { value: [{ id: 'n1', text: 'Hello', date: 'today' }], baseRev: 0 } } });
    ok(r.status === 200 && r.body.creds.length === 2, 'adding teachers creates logins with one-time passwords');
    const c1 = r.body.creds.find(c => c.teacherId === 't1'), c2 = r.body.creds.find(c => c.teacherId === 't2');
    ok(/^[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/.test(c1.tempPassword), 'temp password is random 12-char');
    r = await admin.req('PUT', '/api/state', { changes: { teachers: { value: teachers, baseRev: 0 } } });
    ok(r.status === 409, 'stale baseRev is rejected (no silent overwrite)');

    console.log('Forced password change');
    const t1 = new Client();
    r = await t1.req('POST', '/api/login', { username: c1.username, password: c1.tempPassword });
    ok(r.status === 200 && r.body.user.mustChange === true, 'teacher can sign in with temp password and must change it');
    r = await t1.req('GET', '/api/state'); ok(r.status === 403 && r.body.error === 'password_change_required', 'nothing else works until password is changed');
    r = await t1.req('POST', '/api/change-password', { current: c1.tempPassword, next: 'priya123456' });
    ok(r.status === 400, 'weak new password refused');
    r = await t1.req('POST', '/api/change-password', { current: 'wrong-current', next: 'a much better pass' });
    ok(r.status === 400, 'wrong current password refused');
    r = await t1.req('POST', '/api/change-password', { current: c1.tempPassword, next: 'a much better pass' });
    ok(r.status === 200 && !r.body.user.mustChange, 'password changed');

    console.log('Role isolation (privacy)');
    r = await t1.req('GET', '/api/state'); const ts = r.body;
    ok(r.status === 200 && ts.data.teachers.every(t => !('phone' in t)), 'teacher payload has no phone numbers');
    ok(!('users' in ts) && !('revs' in ts), 'teacher payload has no user list');
    ok(ts.data.campus.configured === true && !('lat' in ts.data.campus), 'teacher does not receive exact campus coordinates');
    r = await t1.req('PUT', '/api/state', { changes: { teachers: { value: [], baseRev: 2 } } }); ok(r.status === 403, 'teacher cannot write school data');
    r = await t1.req('GET', '/api/audit'); ok(r.status === 403, 'teacher cannot read the security log');
    r = await t1.req('POST', '/api/users', { name: 'Sneaky', role: 'admin' }); ok(r.status === 403, 'teacher cannot create users');
    r = await t1.req('POST', '/api/attendance/manual', { teacherId: 't1', date: '2026-10-01', inTime: '09:00', note: 'x' }); ok(r.status === 403, 'teacher cannot forge attendance entries');

    console.log('Leave: teacher sees only own');
    r = await t1.req('POST', '/api/leave', { from: '2026-10-20', to: '2026-10-21', reason: 'Fever <script>alert(1)</script>' });
    ok(r.status === 200, 'teacher applies for leave');
    const t2 = new Client();
    await t2.req('POST', '/api/login', { username: c2.username, password: c2.tempPassword });
    await t2.req('POST', '/api/change-password', { current: c2.tempPassword, next: 'violet tractor monsoon' });
    await t2.req('POST', '/api/leave', { from: '2026-10-25', to: '2026-10-25', reason: 'Private matter' });
    r = await t2.req('GET', '/api/state'); ok(r.body.data.leaveRequests.length === 1 && r.body.data.leaveRequests[0].reason === 'Private matter', 'teacher 2 sees only their own leave');
    r = await admin.req('GET', '/api/state'); const lv = r.body.data.leaveRequests;
    ok(lv.length === 2 && !JSON.stringify(lv).includes('<script>'), 'admin sees both; angle brackets stripped from reason');

    console.log('Receptionist sees minimum');
    r = await admin.req('POST', '/api/users', { name: 'Front Desk', role: 'receptionist' });
    ok(r.status === 200, 'admin creates receptionist'); const rc = r.body.cred;
    const rec = new Client(); await rec.req('POST', '/api/login', { username: rc.username, password: rc.tempPassword });
    await rec.req('POST', '/api/change-password', { current: rc.tempPassword, next: 'amber lantern whistle' });
    r = await rec.req('GET', '/api/state'); const rs = r.body.data;
    ok(rs.teachers.every(t => Object.keys(t).sort().join() === 'id,name'), 'receptionist gets teacher names only');
    ok(rs.leaveRequests.every(l => l.status === 'approved' && !('reason' in l)) && !('timetable' in rs), 'receptionist gets no leave reasons / timetable');

    console.log('Attendance — server-side location checks');
    const here = { lat: 17.385, lng: 78.4867 };
    r = await t1.req('POST', '/api/attendance', { kind: 'in', ...here, accuracy: 10 }); ok(r.status === 428, 'must accept the location notice first');
    r = await t1.req('POST', '/api/location-ack'); ok(r.status === 200, 'teacher accepts location notice');
    r = await t1.req('POST', '/api/attendance', { kind: 'in', lat: 17.40, lng: 78.4867, accuracy: 10 });
    ok(r.status === 422 && r.body.error === 'outside', 'check-in ~1.7 km away is rejected: ' + (r.body.message || ''));
    r = await t1.req('POST', '/api/attendance', { kind: 'in', ...here, accuracy: 400 });
    ok(r.status === 422 && r.body.error === 'poor_accuracy', 'very imprecise GPS (±400 m) is rejected');
    r = await t1.req('POST', '/api/attendance', { kind: 'in', lat: 17.38595, lng: 78.4867, accuracy: 45 });
    ok(r.status === 422 && r.body.error === 'uncertain', 'just outside radius within GPS error → "move closer" (not a hard fail): ' + (r.body.message || '').slice(0, 60));
    r = await t1.req('POST', '/api/attendance', { kind: 'in', lat: 'abc', lng: 1, accuracy: 5 }); ok(r.status === 400, 'garbage coordinates rejected');
    r = await t1.req('POST', '/api/attendance', { kind: 'in', lat: 17.38505, lng: 78.48675, accuracy: 12 });
    ok(r.status === 200 && r.body.ok, 'check-in inside radius accepted: ' + r.body.message);
    r = await t1.req('POST', '/api/attendance', { kind: 'in', lat: 17.38505, lng: 78.48675, accuracy: 12 }); ok(r.body.already === true, 'second check-in does not overwrite the first');
    r = await t1.req('POST', '/api/attendance', { kind: 'out', lat: 17.38505, lng: 78.48675, accuracy: 12 }); ok(r.status === 200, 'check-out accepted');
    const att = peek.prepare('SELECT * FROM attendance').all();
    ok(att.length === 1 && att[0].in_dist != null && !Object.keys(att[0]).some(k => /lat|lng|coord/i.test(k)), 'DB stores distance/accuracy only — no raw coordinates');
    ok(!/17\.385|78\.486/.test(peek.prepare("SELECT group_concat(detail) d FROM audit").get().d || ''), 'audit log contains no coordinates');
    const today = r.body.today || (await admin.req('GET', '/api/bootstrap')).body.today;
    r = await rec.req('GET', `/api/attendance?from=${today}&to=${today}`);
    ok(r.body.checkins[today].t1.inTime && !('inLoc' in r.body.checkins[today].t1), 'receptionist sees times but not distances');
    r = await t2.req('GET', `/api/attendance?from=${today}&to=${today}`); ok(!r.body.checkins[today], 'teacher 2 cannot see teacher 1 attendance');
    r = await admin.req('GET', `/api/attendance?from=${today}&to=${today}`); ok(r.body.checkins[today].t1.inLoc.dist >= 0, 'admin sees times + distance');

    console.log('Sub responses are limited to your own assignments');
    r = await admin.req('GET', '/api/state'); const rv = r.body.revs.substitutions;
    await admin.req('PUT', '/api/state', { changes: { substitutions: { value: { Mon: { c1: { p1: { subject: 'Maths', originalTeacherId: 't2', subTeacherId: 't1', status: 'pending' } } } }, baseRev: rv } } });
    r = await t2.req('POST', '/api/subs/respond', { day: 'Mon', classId: 'c1', periodId: 'p1', decision: 'accepted' }); ok(r.status === 403, "teacher 2 cannot answer teacher 1's substitution");
    r = await t1.req('POST', '/api/subs/respond', { day: 'Mon', classId: 'c1', periodId: 'p1', decision: 'accepted' }); ok(r.status === 200, 'teacher 1 can accept their own');

    console.log('Brute-force protection');
    const bf = new Client(); let last;
    for (let i = 0; i < 6; i++) last = await bf.req('POST', '/api/login', { username: c2.username, password: 'wrong' + i });
    ok(last.status === 429 && last.body.error === 'locked', 'account locks after repeated wrong passwords');
    r = await bf.req('POST', '/api/login', { username: c2.username, password: 'violet tractor monsoon' }); ok(r.status === 429, 'even the right password is refused while locked');
    r = await admin.req('GET', '/api/state'); const ravi = r.body.users.find(u => u.teacherId === 't2');
    r = await admin.req('POST', `/api/users/${ravi.id}/reset`); ok(r.status === 200 && r.body.cred.tempPassword, 'admin reset issues a new one-time password and unlocks');
    r = await new Client().req('POST', '/api/login', { username: ravi.username, password: r.body.cred.tempPassword }); ok(r.status === 200 && r.body.user.mustChange, 'reset password works once and forces change');
    r = await t2.req('GET', '/api/state'); ok(r.status === 401, 'reset signs the user out everywhere');

    console.log('Admin safety');
    r = await admin.req('GET', '/api/state'); const me = r.body.me;
    r = await admin.req('DELETE', `/api/users/${me.id}`); ok(r.status === 400, 'admin cannot delete themselves / last admin');
    r = await admin.req('GET', '/api/audit'); const acts = r.body.rows.map(x => x.action);
    ok(['login.fail', 'login.locked', 'password.reset', 'attendance.in', 'attendance.reject', 'setup.admin_created'].every(a => acts.includes(a)), 'security log recorded key events');
    r = await admin.req('PUT', '/api/state', { changes: { teachers: { value: [teachers[0]], baseRev: (await admin.req('GET','/api/state')).body.revs.teachers } } });
    r = await admin.req('GET', '/api/state'); ok(!r.body.users.some(u => u.teacherId === 't2'), "removing a teacher removes their login");

    console.log('Sign-out');
    r = await t1.req('POST', '/api/logout'); r = await t1.req('GET', '/api/state'); ok(r.status === 401, 'session is invalid after logout');
  } catch (e) { fail++; console.log('TEST CRASH', e); }
  srv.kill(); await sleep(200);
  if (fail) console.log('\nserver log:\n' + log);
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})();
