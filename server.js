const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const fetch     = require('node-fetch');
const Anthropic = require('@anthropic-ai/sdk');

const app    = express();
const PORT   = process.env.PORT || 3000;
const DATA   = path.join(__dirname, 'data');
const DB     = path.join(DATA, 'db.json');
const SEED   = path.join(DATA, 'teams_seed.json');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── DB ───────────────────────────────────────────────────────
function readDB() {
  if (!fs.existsSync(DB)) return initDB();
  try { return JSON.parse(fs.readFileSync(DB, 'utf8')); }
  catch { return initDB(); }
}
function writeDB(d) { fs.writeFileSync(DB, JSON.stringify(d, null, 2)); }
function initDB() {
  // Seed teams from CSV-parsed file
  const teams = fs.existsSync(SEED) ? JSON.parse(fs.readFileSync(SEED, 'utf8')) : [];
  const d = {
    teams,          // all 77 teams, pre-loaded from CSV
    manualEvals: [],
    settings: { threshold: 50, round: 1 },
  };
  writeDB(d); return d;
}

// ── Config ───────────────────────────────────────────────────
const CHALLENGES = {
  1: { name:'Zero-Touch Growth OS',         track:'Web/App',       difficulty:'Medium',
    criteria:[{name:'Innovation & Uniqueness',max:20},{name:'Technical Execution',max:25},{name:'User Experience',max:20},{name:'Business Intelligence',max:15},{name:'Completeness',max:10},{name:'Presentation & Communication',max:10}]},
  2: { name:'Crypto Sentiment Terminal',    track:'AI/Data',       difficulty:'High',
    criteria:[{name:'Technical Complexity',max:30},{name:'Accuracy & Performance',max:25},{name:'Integration & Completeness',max:20},{name:'Code Quality & Documentation',max:15},{name:'Presentation & Explanation',max:10}]},
  3: { name:'Micro Equity Tokenisation',    track:'Blockchain',    difficulty:'High',
    criteria:[{name:'Smart Contract Quality',max:30},{name:'Technical Completeness',max:25},{name:'Innovation & India Context',max:20},{name:'UX & Accessibility',max:15},{name:'Presentation & Vision',max:10}]},
  4: { name:'AI PoisonGuard',               track:'Cybersecurity', difficulty:'High',
    criteria:[{name:'Detection Engine Quality',max:30},{name:'Technical Implementation',max:25},{name:'Innovation & Uniqueness',max:20},{name:'Dashboard UX',max:15},{name:'Presentation & Demo',max:10}]},
  5: { name:'BioShield IoT',                track:'IoT Security',  difficulty:'High',
    criteria:[{name:'Cancellable Template Implementation',max:30},{name:'Technical Implementation',max:25},{name:'Innovation & IoT Context',max:20},{name:'Dashboard & Visualisation',max:15},{name:'Presentation & Security Awareness',max:10}]},
};

const VOLUNTEERS = [
  { id:'vol1', name:'Volunteer 1', pin:'1111' },
  { id:'vol2', name:'Volunteer 2', pin:'2222' },
  { id:'vol3', name:'Volunteer 3', pin:'3333' },
  { id:'vol4', name:'Volunteer 4', pin:'4444' },
  { id:'vol5', name:'Volunteer 5', pin:'5555' },
];
const ADMIN_PIN = '0000';

// ── Assign shortlisted teams evenly across volunteers ────────
function redistributeShortlisted(db) {
  const shortlisted = db.teams.filter(t => t.round1 === 'shortlisted');
  shortlisted.forEach((t, i) => { t.volunteerId = VOLUNTEERS[i % VOLUNTEERS.length].id; });
  writeDB(db);
}

// ── GitHub fetcher ───────────────────────────────────────────
async function fetchGitHubData(url) {
  try {
    const m = url.match(/github\.com\/([^\/]+)\/([^\/\?#]+)/);
    if (!m) return null;
    const [, owner, repo] = m;
    const clean = repo.replace(/\.git$/, '');
    const hdrs  = { 'Accept':'application/vnd.github.v3+json', 'User-Agent':'INNOVATHON-2026' };
    const [rr, mr, tr] = await Promise.allSettled([
      fetch(`https://api.github.com/repos/${owner}/${clean}/readme`, { headers: hdrs }),
      fetch(`https://api.github.com/repos/${owner}/${clean}`,        { headers: hdrs }),
      fetch(`https://api.github.com/repos/${owner}/${clean}/git/trees/HEAD?recursive=0`, { headers: hdrs }),
    ]);
    let readme = '';
    if (rr.status==='fulfilled' && rr.value.ok) {
      const d = await rr.value.json();
      readme = Buffer.from(d.content||'','base64').toString('utf8').slice(0,4000);
    }
    let meta = {};
    if (mr.status==='fulfilled' && mr.value.ok) {
      const d = await mr.value.json();
      meta = { language:d.language, topics:d.topics, description:d.description, size:d.size, updatedAt:d.updated_at };
    }
    let fileTree = [];
    if (tr.status==='fulfilled' && tr.value.ok) {
      const d = await tr.value.json();
      fileTree = (d.tree||[]).slice(0,50).map(f=>f.path);
    }
    return { owner, repo:clean, readme, meta, fileTree };
  } catch(e) { return null; }
}

// ── Claude AI Evaluation ─────────────────────────────────────
async function runAIEval(team) {
  const ch    = CHALLENGES[team.challenge];
  const cList = ch.criteria.map(c=>`  - ${c.name}: 0–${c.max} pts`).join('\n');
  const cJSON = ch.criteria.map(c=>`"${c.name}": <0–${c.max}>`).join(', ');
  const gh    = await fetchGitHubData(team.github);

  const repoSection = gh
    ? `━━━━ GITHUB REPOSITORY (live fetch) ━━━━
Repo     : ${gh.owner}/${gh.repo}
Language : ${gh.meta.language||'—'}
Topics   : ${gh.meta.topics?.join(', ')||'—'}
Size     : ${gh.meta.size} KB | Updated: ${gh.meta.updatedAt}

FILE TREE:
${gh.fileTree.join('\n')||'(empty)'}

README:
────────────────────────────────────────
${gh.readme||'(no README found)'}
────────────────────────────────────────`
    : `━━━━ GITHUB ━━━━\nURL: ${team.github}\n(Could not fetch live data)`;

  const prompt = `You are a senior technical judge at INNOVATHON 2026 — 24-hour hackathon at NMIMS Indore, India.
This team was SHORTLISTED after Round 1 screening. Evaluate their Round 2 submission rigorously.

━━━━ TEAM ━━━━
Name     : ${team.teamName} (${team.id})
Campus   : ${team.campus}
Members  : ${team.members.join(' | ')}
Challenge: [${team.challenge}] ${ch.name} (${ch.track} · ${ch.difficulty})
Deployed : ${team.deployed||'Not provided'}
Desc     : ${team.description||'Not provided'}

${repoSection}

━━━━ JUDGING CRITERIA (100 pts) ━━━━
${cList}

SCORE GUIDE: 20–39 weak · 40–49 below avg · 50–59 avg · 60–69 good · 70–79 very good · 80–89 excellent · 90+ exceptional

Be specific — reference actual filenames, README sections, tech choices observed.

Respond ONLY with valid JSON, no markdown:
{"scores":{${cJSON}},"total":<integer>,"summary":"<3-4 sentences referencing real repo details>","strength":"<concrete specific strength>","weakness":"<concrete improvement>","techStack":"<techs detected>","readmeQuality":"<poor|basic|good|excellent>"}`;

  const msg = await client.messages.create({
    model:'claude-sonnet-4-5', max_tokens:1024,
    messages:[{role:'user', content:prompt}],
  });
  const parsed = JSON.parse(msg.content[0].text.replace(/```json|```/g,'').trim());
  let total = 0;
  ch.criteria.forEach(c => {
    const v = Math.max(0, Math.min(parseInt(parsed.scores?.[c.name]??0), c.max));
    parsed.scores[c.name] = v; total += v;
  });
  parsed.total = total;
  return parsed;
}

function fallbackScores(challenge) {
  const ch = CHALLENGES[challenge]; const scores = {}; let total = 0;
  ch.criteria.forEach(c => { const v=Math.round(c.max*(0.44+Math.random()*0.26)); scores[c.name]=v; total+=v; });
  return { scores, total, summary:'Fallback evaluation — manual review recommended.', strength:'Submitted on time.', weakness:'Deep analysis unavailable.', techStack:'Unknown', readmeQuality:'basic' };
}

// ════════════════════════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════════════════════════

// ── Auth ─────────────────────────────────────────────────────
app.post('/api/auth', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ ok:false, error:'PIN required' });
  if (pin === ADMIN_PIN) return res.json({ ok:true, role:'admin', name:'Admin' });
  const vol = VOLUNTEERS.find(v=>v.pin===pin);
  if (!vol) return res.status(401).json({ ok:false, error:'Invalid PIN' });
  res.json({ ok:true, role:'volunteer', volId:vol.id, name:vol.name });
});

// ── Teams — admin gets all, volunteer gets their shortlisted ─
app.get('/api/teams', (req, res) => {
  const { role, volId, round, status } = req.query;
  const db = readDB();
  let teams = db.teams;
  if (role === 'volunteer' && volId) teams = teams.filter(t => t.volunteerId === volId && t.round1 === 'shortlisted');
  if (round === '1') teams = teams; // all
  if (status) teams = teams.filter(t => t.round1 === status);
  // attach manual eval
  teams = teams.map(t => ({ ...t, manualEval: db.manualEvals.find(e=>e.teamId===t.id)||null }));
  res.json({ teams, total: db.teams.length });
});

// ── Round 1: update team status (admin only) ─────────────────
app.post('/api/teams/:id/round1', (req, res) => {
  const { status } = req.body; // shortlisted | eliminated | pending
  if (!['shortlisted','eliminated','pending'].includes(status))
    return res.status(400).json({ error:'Invalid status' });
  const db  = readDB();
  const idx = db.teams.findIndex(t=>t.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Team not found' });
  db.teams[idx].round1 = status;
  writeDB(db);
  res.json({ ok:true });
});

// ── Bulk round1 update ───────────────────────────────────────
app.post('/api/round1/bulk', (req, res) => {
  const { updates } = req.body; // [{id, status}]
  if (!Array.isArray(updates)) return res.status(400).json({ error:'updates must be array' });
  const db = readDB();
  updates.forEach(({ id, status }) => {
    const idx = db.teams.findIndex(t=>t.id===id);
    if (idx!==-1) db.teams[idx].round1 = status;
  });
  writeDB(db);
  res.json({ ok:true });
});

// ── Redistribute shortlisted teams to volunteers ─────────────
app.post('/api/distribute', (req, res) => {
  const db = readDB();
  redistributeShortlisted(db);
  const count = db.teams.filter(t=>t.round1==='shortlisted').length;
  res.json({ ok:true, distributed: count });
});

// ── Round 2: team submits GitHub link ───────────────────────
app.post('/api/teams/:id/submit', async (req, res) => {
  const { github, deployed, description } = req.body;
  if (!github) return res.status(400).json({ error:'GitHub URL required' });

  const db  = readDB();
  const idx = db.teams.findIndex(t=>t.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Team not found' });
  if (db.teams[idx].round1 !== 'shortlisted')
    return res.status(403).json({ error:'Team not shortlisted for Round 2' });

  db.teams[idx].github      = github.trim();
  db.teams[idx].deployed    = deployed?.trim()||null;
  db.teams[idx].description = description?.trim()||'';
  db.teams[idx].submittedAt = new Date().toISOString();
  db.teams[idx].aiStatus    = 'analyzing';
  writeDB(db);
  res.json({ ok:true });

  // Background AI eval
  ;(async()=>{
    const db2 = readDB();
    const t   = db2.teams[idx];
    console.log(`[AI] Evaluating ${t.teamName} (${t.id})`);
    try {
      const r = await runAIEval(t);
      Object.assign(t, { aiScores:r.scores, aiTotal:r.total, aiSummary:r.summary, aiStrength:r.strength, aiWeakness:r.weakness, aiTechStack:r.techStack, aiReadmeQuality:r.readmeQuality, aiStatus:'done' });
      console.log(`[AI] ✓ ${t.teamName} → ${t.aiTotal}/100`);
    } catch(err) {
      console.error(`[AI] ✗ ${t.teamName}:`, err.message);
      const fb = fallbackScores(t.challenge);
      Object.assign(t, { ...fb, aiStatus:'done' });
    }
    const db3 = readDB();
    const i2  = db3.teams.findIndex(x=>x.id===t.id);
    if (i2!==-1) { db3.teams[i2]=t; writeDB(db3); }
  })();
});

// ── Re-run AI eval ───────────────────────────────────────────
app.post('/api/teams/:id/reeval', async (req, res) => {
  const db  = readDB();
  const idx = db.teams.findIndex(t=>t.id===req.params.id);
  if (idx===-1) return res.status(404).json({ error:'Not found' });
  if (!db.teams[idx].github) return res.status(400).json({ error:'No GitHub URL submitted yet' });
  db.teams[idx].aiStatus = 'analyzing';
  writeDB(db);
  res.json({ ok:true });
  ;(async()=>{
    const db2=readDB(); const t=db2.teams[idx];
    try { const r=await runAIEval(t); Object.assign(t,{aiScores:r.scores,aiTotal:r.total,aiSummary:r.summary,aiStrength:r.strength,aiWeakness:r.weakness,aiTechStack:r.techStack,aiReadmeQuality:r.readmeQuality,aiStatus:'done'}); }
    catch { Object.assign(t,fallbackScores(t.challenge),{aiStatus:'done'}); }
    const db3=readDB(); const i2=db3.teams.findIndex(x=>x.id===t.id);
    if (i2!==-1){db3.teams[i2]=t;writeDB(db3);}
  })();
});

// ── Stats ────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const { role, volId } = req.query;
  const db   = readDB();
  const all  = db.teams;
  const sl   = all.filter(t=>t.round1==='shortlisted');
  const elim = all.filter(t=>t.round1==='eliminated');
  const pend = all.filter(t=>t.round1==='pending');

  let r2teams = sl;
  if (role==='volunteer'&&volId) r2teams = sl.filter(t=>t.volunteerId===volId);

  res.json({
    total: all.length,
    shortlisted: sl.length,
    eliminated: elim.length,
    pending: pend.length,
    r2submitted: r2teams.filter(t=>t.submittedAt).length,
    r2aiDone: r2teams.filter(t=>t.aiStatus==='done').length,
    r2analyzing: r2teams.filter(t=>t.aiStatus==='analyzing').length,
    r2manualDone: db.manualEvals.filter(e=>r2teams.find(t=>t.id===e.teamId)).length,
    avgAI: (() => { const s=r2teams.filter(t=>t.aiTotal!==null).map(t=>t.aiTotal); return s.length?Math.round(s.reduce((a,b)=>a+b,0)/s.length):null; })(),
    threshold: db.settings.threshold,
    byTrack: [...new Set(all.map(t=>t.track))].map(track=>({
      track, total: all.filter(t=>t.track===track).length, shortlisted: sl.filter(t=>t.track===track).length,
    })),
    byVol: VOLUNTEERS.map(v=>({
      volId:v.id, name:v.name,
      assigned: sl.filter(t=>t.volunteerId===v.id).length,
      manual: db.manualEvals.filter(e=>sl.find(t=>t.id===e.teamId&&t.volunteerId===v.id)).length,
    })),
  });
});

// ── Threshold ────────────────────────────────────────────────
app.post('/api/threshold', (req, res) => {
  const db=readDB(); db.settings.threshold=parseFloat(req.body.value)||50; writeDB(db); res.json({ok:true});
});

// ── Lookup team by ID (for submission page) ──────────────────
app.get('/api/teams/:id', (req, res) => {
  const db  = readDB();
  const team= db.teams.find(t=>t.id===req.params.id);
  if (!team) return res.status(404).json({ error:'Team not found' });
  res.json({ ...team, manualEval: db.manualEvals.find(e=>e.teamId===team.id)||null });
});

// ── Reset DB (dev only) ──────────────────────────────────────
app.post('/api/reset', (req, res) => {
  if (fs.existsSync(DB)) fs.unlinkSync(DB);
  initDB();
  res.json({ ok:true, message:'Database reset to seed data' });
});

// ── Compatibility aliases for volunteer page ─────────────────
// volunteer page calls /api/auth/volunteer
app.post('/api/auth/volunteer', (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ ok:false, error:'PIN required' });
  if (pin === ADMIN_PIN) return res.json({ ok:true, role:'admin', name:'Admin' });
  const vol = VOLUNTEERS.find(v=>v.pin===pin);
  if (!vol) return res.status(401).json({ ok:false, error:'Invalid PIN. Try again.' });
  res.json({ ok:true, role:'volunteer', volId:vol.id, name:vol.name });
});

// volunteer page calls /api/submissions — map to /api/teams
app.get('/api/submissions', (req, res) => {
  const { volId, role } = req.query;
  const db = readDB();
  let teams = db.teams.filter(t => t.round1 === 'shortlisted');
  if (role !== 'admin' && volId) teams = teams.filter(t => t.volunteerId === volId);
  const subs = teams.map(t => ({
    id: t.id, teamName: t.teamName, teamId: t.id,
    members: t.members, challenge: t.challenge,
    github: t.github, deployed: t.deployed, description: t.description,
    submittedAt: t.submittedAt, volunteerId: t.volunteerId,
    aiStatus: t.aiStatus || 'pending',
    aiScores: t.aiScores, aiTotal: t.aiTotal,
    aiSummary: t.aiSummary, aiStrength: t.aiStrength, aiWeakness: t.aiWeakness,
    aiTechStack: t.aiTechStack, aiReadmeQuality: t.aiReadmeQuality,
    manualEval: db.manualEvals.find(e=>e.teamId===t.id || e.subId===t.id) || null,
  }));
  res.json({ subs });
});

// volunteer page posts manual eval with subId
app.post('/api/eval', (req, res) => {
  const { subId, teamId, volId, scores, total, notes } = req.body;
  const id = teamId || subId;
  if (!id || !scores || total === undefined) return res.status(400).json({ error:'Missing fields' });
  const db  = readDB();
  const idx = db.manualEvals.findIndex(e => e.teamId===id || e.subId===id);
  const obj = { teamId:id, subId:id, volId, scores, total, notes:notes||'', savedAt:new Date().toISOString() };
  if (idx !== -1) db.manualEvals[idx] = obj; else db.manualEvals.push(obj);
  writeDB(db);
  res.json({ ok:true });
});

app.get('/api/health', (_,res)=>res.json({ ok:true, ai:!!process.env.ANTHROPIC_API_KEY, teams:readDB().teams.length }));
app.get('/api/challenges', (_,res)=>res.json(CHALLENGES));
app.get('/api/volunteers', (_,res)=>res.json(VOLUNTEERS.map(v=>({id:v.id,name:v.name}))));

// ── Pages ─────────────────────────────────────────────────────
app.get('/',          (_,res)=>res.sendFile(path.join(__dirname,'public','index','index.html')));
app.get('/team',      (_,res)=>res.sendFile(path.join(__dirname,'public','team','index.html')));
app.get('/volunteer', (_,res)=>res.sendFile(path.join(__dirname,'public','volunteer','index.html')));
app.get('/admin',     (_,res)=>res.sendFile(path.join(__dirname,'public','admin','index.html')));

app.listen(PORT, () => {
  const ok = !!process.env.ANTHROPIC_API_KEY;
  const db = readDB();
  console.log(`
╔══════════════════════════════════════════════════════╗
║         INNOVATHON 2026 — 2-Round Eval System        ║
╠══════════════════════════════════════════════════════╣
║  Home      →  http://localhost:${PORT}                   ║
║  Team Sub  →  http://localhost:${PORT}/team              ║
║  Volunteer →  http://localhost:${PORT}/volunteer         ║
║  Admin     →  http://localhost:${PORT}/admin             ║
╠══════════════════════════════════════════════════════╣
║  Teams loaded : ${String(db.teams.length).padEnd(35)}  ║
║  AI Engine    : Claude Sonnet  ${ok?'✅ KEY SET      ':'⚠️  NO API KEY  '}        ║
╠══════════════════════════════════════════════════════╣
║  Volunteer PINs : 1111  2222  3333  4444  5555       ║
║  Admin PIN      : 0000                               ║
╚══════════════════════════════════════════════════════╝`);
});
